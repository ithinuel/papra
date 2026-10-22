import type { Config } from '../../../../config/config.types';
import type { Logger } from '../../../../shared/logger/logger';
import type {
  ContentExtractionRunContext,
  ContentExtractionStrategy,
  CustomPropertyDefinitionWithOptions,
} from '../content-extraction-strategies.types';
import type { Tag } from '../../../../tags/tags.types';
import { extractTextWithAiContentExtraction } from './ai.content-extraction-strategy.usecases';
import {
  isAiContentExtractionAbleToExtractTextFromDocument,
  PDF_RENDER_JPEG_QUALITY,
} from './ai.content-extraction-strategy.models';
import type { PdfRenderPolicy } from './ai.content-extraction-strategy.types';
import { isNilOrEmptyString } from '../../../../shared/utils';
import { createLogger } from '../../../../shared/logger/logger';
import { parseModelId, ensureModelId } from '../../../../ai/ai.models';
import { createAiModelCapabilitiesRegistry } from '../../../../ai/ai-model-capabilities';
import { computeMetadataInputBudget } from '../../../../ai/ai-model-capabilities.models';
import { validatePromptTemplates } from './prompts/prompts';
import type { PromptContext } from './prompts/prompt-context.types';
import type { ChatDependencies } from '../../../../ai/ai.chat.usecases';

function compareStrings(a: string, b: string): number {
  // Plain code-point compare: locale-free, so the ordering is the same on every
  // deployment and stable across restarts.
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function toPromptContext({
  file,
  document,
  tags,
  customProperties,
  ai,
}: {
  file: { name: string; mimeType: string; size: number };
  document: { id: string; name: string };
  tags: Tag[];
  customProperties: CustomPropertyDefinitionWithOptions[];
  ai: { canCreateNewTags: boolean; maxTags: number };
}): PromptContext {
  return {
    file,
    document: {
      id: document.id,
      name: document.name,
    },
    // The catalogue renders sorted so the system prompt stays byte-identical
    // across every document and chunk of an organization: providers key their
    // prompt caches on the shared request prefix (static instructions + the
    // org's tags/custom-properties catalogue).
    tags: [...tags]
      .sort((a, b) => compareStrings(a.normalizedName ?? a.name, b.normalizedName ?? b.name))
      .map((tag) => ({
        name: tag.name,
        slug: tag.normalizedName ?? tag.name.toLowerCase().replace(/\s+/g, '-'),
        color: tag.color,
        description: tag.description,
      })),
    customProperties: [...customProperties]
      .sort((a, b) => compareStrings(a.key, b.key))
      .map((cp) => ({
        key: cp.key,
        label: cp.name,
        description: cp.description,
        type: cp.type,
        options: [...cp.options]
          .sort((a, b) => compareStrings(a.name, b.name))
          .map((opt) => ({
            label: opt.name,
            value: opt.name,
          })),
      })),
    pageCount: 1,
    batch: {
      pageCount: 1,
      firstPageNumber: 1,
    },
    ai,
  };
}

export function buildAiContentExtractionStrategy({
  config,
  chatDeps,
}: {
  config: Config;
  chatDeps: ChatDependencies;
}): ContentExtractionStrategy {
  const {
    adapterName: adapterNameOverride,
    modelName: modelNameOverride,
    systemPrompt,
    userPrompt,
    metadataPrompt,
    temperature,
    maxTokens,
    mimeTypesAllowList,
    timeoutMs,
    pagesPerBatch,
    maxImageBytes,
    batchConcurrency,
    maxPages,
    renderImageFormat,
    renderTimeoutMs,
    allowNewTags,
    maxTags,
  } = config.documentContentExtraction.strategy.ai;

  // Derive the default adapter/model from the shared AI config so the strategy
  // can be enabled simply by configuring `ai.defaultModelId`.
  const defaultModelId = config.ai.defaultModelId;
  let defaultAdapterId = 'openai';
  let defaultModelName = '';

  if (defaultModelId) {
    try {
      const parsed = parseModelId(defaultModelId);
      defaultAdapterId = parsed.adapterId;
      defaultModelName = parsed.modelName;
    } catch {
      // Invalid model ID; handled below when the model is still unresolved.
    }
  }

  // Strategy-level overrides win over the default.
  const effectiveAdapterId = adapterNameOverride ?? defaultAdapterId;
  const effectiveModelName = modelNameOverride ?? defaultModelName;

  const logger = createLogger({ namespace: 'ai-content-extraction' });

  // Validate the prompt templates at factory construction time (server start).
  // The raw templates are passed to the extraction usecase, which renders them
  // once per chunk with the real batch context; pre-rendering here would pin
  // the per-batch variables to placeholder values.
  validatePromptTemplates(systemPrompt, userPrompt, metadataPrompt);

  // Probe cache scoped to this strategy instance: the extraction usecase
  // memoizes strategies per server, so endpoint metadata is probed once per
  // model and amortized across every extraction.
  const modelCapabilities = createAiModelCapabilitiesRegistry({ config });

  return {
    canExtractTextFromDocument: async ({ file }) => {
      if (isNilOrEmptyString(effectiveModelName)) {
        return false;
      }

      return isAiContentExtractionAbleToExtractTextFromDocument({
        file,
        mimeTypesAllowList,
        maxImageBytes,
      });
    },

    extractTextFromDocument: async ({
      file,
      runContext,
      logger: strategyLogger,
    }: {
      file: File;
      runContext?: ContentExtractionRunContext;
      logger?: Logger;
    }) => {
      const effectiveLogger = strategyLogger ?? logger;

      if (isNilOrEmptyString(effectiveModelName)) {
        throw new Error(
          'AI content extraction model is not configured. Set ai.defaultModelId or CONTENT_EXTRACTION_AI_MODEL_NAME.',
        );
      }

      const modelId =
        modelNameOverride !== undefined
          ? `${effectiveAdapterId}://${modelNameOverride}`
          : ensureModelId(defaultModelId);

      // Resolve the render clamps and the metadata-call budget from explicit
      // config, the cached endpoint probe, and the known-family table. Cached
      // per model, so only the first extraction pays the probe.
      const capabilities = await modelCapabilities.resolveModelCapabilities({
        adapterName: effectiveAdapterId,
        modelName: effectiveModelName,
        logger: effectiveLogger,
      });

      const renderPolicy: PdfRenderPolicy = {
        maxLongEdge: capabilities.maxLongEdge,
        maxPixels: capabilities.maxPixels,
        imageFormat: renderImageFormat,
        jpegQuality: PDF_RENDER_JPEG_QUALITY,
        renderTimeoutMs,
      };

      const metadataInputMaxChars = computeMetadataInputBudget({
        contextLength: capabilities.contextLength,
      });

      // The extraction task always resolves the document before running the
      // strategies. Without it there is no organization to attribute AI-credit
      // usage to, so fail loudly rather than bill an 'unknown' organization.
      const document = runContext?.document;

      if (!document) {
        throw new Error(
          'AI content extraction requires the document run context (document, tags, custom properties).',
        );
      }

      const promptContext = toPromptContext({
        file: {
          name: document.originalName,
          mimeType: document.mimeType,
          size: document.originalSize,
        },
        document: {
          id: document.id,
          name: document.name,
        },
        tags: runContext.tags,
        customProperties: runContext.customProperties,
        ai: {
          canCreateNewTags: allowNewTags,
          maxTags,
        },
      });

      const result = await extractTextWithAiContentExtraction({
        file,
        modelId,
        systemPrompt,
        userPrompt,
        metadataPrompt,
        temperature,
        maxTokens,
        timeoutMs,
        pagesPerBatch,
        batchConcurrency,
        maxPages,
        renderPolicy,
        metadataInputMaxChars,
        documentContext: promptContext,
        organizationId: document.organizationId,
        logger: effectiveLogger,
        ...chatDeps,
      });

      const extractionContext: Record<string, unknown> = {
        processedPagesCount: result.pageCount,
      };

      if (result.metadata) {
        extractionContext.hasMetadata = true;
      }

      return { text: result.text, extractionContext, metadata: result.metadata };
    },
  };
}
