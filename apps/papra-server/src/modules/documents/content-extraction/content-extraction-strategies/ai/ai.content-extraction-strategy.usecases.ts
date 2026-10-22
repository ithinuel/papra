import type { Logger } from '../../../../shared/logger/logger';
import { generateChat } from '../../../../ai/ai.chat.usecases';
import type { ChatDependencies } from '../../../../ai/ai.chat.usecases';
import { METADATA_INPUT_DEFAULT_MAX_CHARS } from '../../../../ai/ai-model-capabilities.models';
import type { ExtractedDocumentMetadata, TagInput } from '../content-extraction-strategies.types';
import { buildPdfPageReader, mapWithConcurrency } from './ai.content-extraction-strategy.models';
import type { DocumentPage, PdfRenderPolicy } from './ai.content-extraction-strategy.types';
import { compilePrompt, renderPrompt, renderPrompts } from './prompts/prompts';
import type { PromptContext } from './prompts/prompt-context.types';
import {
  aiContentExtractionOutputSchema,
  aiMetadataOutputSchema,
} from './ai.content-extraction-strategy.schemas';
import type { AiContentExtractionOutput } from './ai.content-extraction-strategy.schemas';
import {
  createEmptyExtractedTextError,
  createTooManyPagesForStrategyError,
} from '../../content-extraction.errors';

export type AiContentExtractionResult = {
  text: string;
  pageCount: number;
  metadata?: ExtractedDocumentMetadata;
};

/** Which call produced the document metadata: the (only) chunk call, or the
 * reconciling metadata-only call over the joined transcription. */
export type MetadataPath = 'chunk' | 'reconciled';

/**
 * Character cap on the joined transcription re-sent to the reconciling
 * metadata call. Document metadata is overwhelmingly front-loaded, so the
 * head of the text is kept. Callers pass a budget derived from the model's
 * resolved context length (see computeMetadataInputBudget); this default is
 * the conservative fallback for unprobed models.
 */
export const METADATA_INPUT_MAX_CHARS = METADATA_INPUT_DEFAULT_MAX_CHARS;

export const METADATA_INPUT_TRUNCATION_MARKER = '\n\n[...truncated for metadata pass...]';

/** Fixed lead-in for the reconciling call's user message (the transcription
 * follows it verbatim). */
const METADATA_TEXT_PREAMBLE =
  'The following is the text extracted from the document, page by page:\n\n';

/**
 * Head-truncates the joined transcription fed to the reconciling metadata
 * call, appending an explicit marker so the model knows it is seeing a prefix
 * of a longer document.
 */
export function truncateMetadataInput({
  text,
  maxChars = METADATA_INPUT_MAX_CHARS,
}: {
  text: string;
  maxChars?: number;
}): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}${METADATA_INPUT_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export async function extractTextWithAiContentExtraction({
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
  documentContext,
  organizationId,
  logger,
  ...chatDeps
}: {
  file: File;
  modelId: string;
  /** Raw nunjucks templates; rendered per chunk with the batch context. */
  systemPrompt: string;
  userPrompt: string;
  /** System prompt for the multi-chunk reconciling metadata call. */
  metadataPrompt: string;
  temperature: number;
  /** When undefined the option is not sent and the server applies its own maximum. */
  maxTokens: number | undefined;
  timeoutMs: number;
  /** Maximum pages rendered and sent per model request. */
  pagesPerBatch: number;
  /** Maximum number of chunks sent to the model in parallel. */
  batchConcurrency: number;
  /** Maximum pages accepted per PDF; 0 means no limit. */
  maxPages: number;
  /** How PDF pages are rasterized (clamps, image format, render deadline). */
  renderPolicy: PdfRenderPolicy;
  /** Character budget for the reconciling metadata call's joined text. */
  metadataInputMaxChars?: number;
  documentContext: PromptContext;
  organizationId: string;
  logger: Logger;
} & ChatDependencies): Promise<AiContentExtractionResult> {
  // Omit maxTokens entirely when unset so the request carries no cap and the
  // model/server applies its own maximum.
  const modelOptions: { temperature: number; maxTokens?: number } = {
    temperature,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };

  // Handle non-PDF files (images): a single chunk whose combined call is both
  // the content extraction and the final metadata call.
  if (file.type !== 'application/pdf') {
    const result = await extractFromSingleFile({
      file,
      modelId,
      systemPrompt,
      userPrompt,
      modelOptions,
      timeoutMs,
      documentContext,
      organizationId,
      logger,
      chatDeps,
    });

    assertExtractedTextNotEmpty(result.text);

    return result;
  }

  const pdf = await buildPdfPageReader({ file, pagesPerBatch, renderPolicy });
  logger?.info({ pageCount: pdf.pageCount, pagesPerBatch }, 'Starting AI content extraction');

  try {
    const pageCount = pdf.pageCount;

    // Policy guard against pathologically large PDFs. Failing here lets the
    // next strategy in the list (e.g. "internal") take over.
    if (maxPages > 0 && pageCount > maxPages) {
      throw createTooManyPagesForStrategyError({
        message: `The document has ${pageCount} pages, which exceeds the AI content extraction page limit (${maxPages})`,
      });
    }

    // The {{ pageCount }} prompt variable must expose the total page count of
    // the document, not the current chunk (chunks override `batch.*` only).
    const documentContextWithPageCount = { ...documentContext, pageCount };

    // Chunk == batch: every job renders its <= pagesPerBatch pages and runs
    // one combined {text, metadata} call with the same prompt shape. Render
    // lives inside the slot, so in-flight rasters stay bounded by
    // pagesPerBatch x batchConcurrency, and render pipelines with inference
    // across slots.
    const chunkResults = await mapWithConcurrency({
      items: pdf.chunkJobs,
      concurrency: batchConcurrency,
      // Note: unlike a sequential loop, chunks already in flight when one
      // fails are not cancelled (generateChat has no abort support yet);
      // their results are simply dropped when the strategy fails over.
      mapFn: async ({ render, firstPageNumber }) => {
        const pages = await render();

        return extractFromSingleBatch({
          modelId,
          pages,
          systemPrompt,
          userPrompt,
          modelOptions,
          timeoutMs,
          organizationId,
          pageCount: pages.length,
          firstPageNumber,
          documentContext: documentContextWithPageCount,
          logger,
          chatDeps,
        });
      },
    });

    const text = chunkResults.map((r) => r.text).join('\n\n');

    // Single chunk: its metadata is final. Multiple chunks: the chunk
    // metadata is discarded and one metadata-only call reconciles the
    // document from the joined transcription.
    const { metadata, metadataPath, truncated } = await resolveDocumentMetadata({
      chunkResults,
      joinedText: text,
      modelId,
      metadataPrompt,
      modelOptions,
      timeoutMs,
      metadataInputMaxChars,
      organizationId,
      documentContext: documentContextWithPageCount,
      logger,
      chatDeps,
    });

    logger?.info(
      {
        pageCount,
        chunkCount: chunkResults.length,
        metadataPath,
        metadataInputTruncated: truncated,
        hasMetadata: !!metadata,
      },
      'AI content extraction completed',
    );

    assertExtractedTextNotEmpty(text);

    return { text, pageCount, metadata };
  } finally {
    await pdf.close().catch(() => {});
  }
}

/**
 * Raises a typed error when the aggregated extraction yielded no text, so the
 * extraction usecase can fall through to the next strategy instead of storing
 * an empty document content. Individual chunks may be empty (blank pages);
 * only the aggregate is checked.
 */
export function assertExtractedTextNotEmpty(text: string): void {
  if (text.trim().length === 0) {
    throw createEmptyExtractedTextError();
  }
}

async function resolveDocumentMetadata({
  chunkResults,
  joinedText,
  modelId,
  metadataPrompt,
  modelOptions,
  timeoutMs,
  metadataInputMaxChars,
  organizationId,
  documentContext,
  logger,
  chatDeps,
}: {
  chunkResults: AiContentExtractionResult[];
  joinedText: string;
  modelId: string;
  metadataPrompt: string;
  modelOptions: { temperature: number; maxTokens?: number };
  timeoutMs: number;
  metadataInputMaxChars?: number;
  organizationId: string;
  documentContext: PromptContext;
  logger: Logger;
  chatDeps: ChatDependencies;
}): Promise<{
  metadata: ExtractedDocumentMetadata | undefined;
  metadataPath: MetadataPath;
  truncated: boolean;
}> {
  if (chunkResults.length <= 1) {
    return { metadata: chunkResults[0]?.metadata, metadataPath: 'chunk', truncated: false };
  }

  // The per-chunk metadata is discarded, but keep it in the debug log: a free
  // observability signal for what each chunk looked like in isolation.
  chunkResults.forEach((result, chunkIndex) => {
    if (result.metadata) {
      logger?.debug(
        { chunkIndex, chunkMetadata: result.metadata },
        'Discarded per-chunk metadata (multi-chunk document)',
      );
    }
  });

  const { text: metadataInput, truncated } = truncateMetadataInput({
    text: joinedText,
    ...(metadataInputMaxChars !== undefined ? { maxChars: metadataInputMaxChars } : {}),
  });

  try {
    const output = await generateChat({
      modelId,
      messages: [
        {
          role: 'user' as const,
          content: `${METADATA_TEXT_PREAMBLE}${metadataInput}`,
        },
      ],
      systemPrompt: renderPrompt(compilePrompt(metadataPrompt), documentContext),
      modelOptions,
      timeoutMs,
      organizationId,
      source: 'content-extraction',
      schema: aiMetadataOutputSchema,
      logger,
      ...chatDeps,
    });

    return {
      metadata: outputToMetadata(output),
      metadataPath: 'reconciled',
      truncated,
    };
  } catch (error) {
    // Metadata is best-effort: a failed reconciling call must never discard
    // the extracted text.
    logger?.warn(
      { err: error },
      'Document metadata reconciliation failed; continuing without metadata',
    );

    return { metadata: undefined, metadataPath: 'reconciled', truncated };
  }
}

async function extractFromSingleFile({
  file,
  modelId,
  systemPrompt,
  userPrompt,
  modelOptions,
  timeoutMs,
  documentContext,
  organizationId,
  logger,
  chatDeps,
}: {
  file: File;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  modelOptions: { temperature: number; maxTokens?: number };
  timeoutMs: number;
  documentContext: PromptContext;
  organizationId: string;
  logger: Logger;
  chatDeps: ChatDependencies;
}): Promise<AiContentExtractionResult> {
  // For non-PDF files, convert to base64 data URL
  const base64DataUrl = await file.arrayBuffer().then((ab) => {
    const base64 = Buffer.from(ab).toString('base64');
    return `data:${file.type};base64,${base64}`;
  });

  const page: DocumentPage = { mimeType: file.type, base64DataUrl };

  return extractFromSingleBatch({
    modelId,
    pages: [page],
    systemPrompt,
    userPrompt,
    modelOptions,
    timeoutMs,
    organizationId,
    pageCount: 1,
    firstPageNumber: 1,
    documentContext,
    logger,
    chatDeps,
  });
}

async function extractFromSingleBatch({
  modelId,
  pages,
  systemPrompt,
  userPrompt,
  modelOptions,
  timeoutMs,
  organizationId,
  pageCount,
  firstPageNumber,
  documentContext,
  logger,
  chatDeps,
}: {
  modelId: string;
  pages: DocumentPage[];
  systemPrompt: string;
  userPrompt: string;
  modelOptions: { temperature: number; maxTokens?: number };
  timeoutMs: number;
  organizationId: string;
  pageCount: number;
  firstPageNumber: number;
  documentContext: PromptContext;
  logger: Logger;
  chatDeps: ChatDependencies;
}): Promise<AiContentExtractionResult> {
  // Merge batch-level context into the document context for rendering
  const batchContext: PromptContext = {
    ...documentContext,
    batch: {
      pageCount,
      firstPageNumber,
    },
  };

  const rendered = renderPrompts(systemPrompt, userPrompt, batchContext);

  logger?.debug(
    { pageStart: firstPageNumber, pageEnd: firstPageNumber + pageCount - 1 },
    'Extracting batch',
  );

  const output = await callChatWithPages({
    modelId,
    pages,
    systemPrompt: rendered.systemPrompt,
    userPrompt: rendered.userPrompt,
    modelOptions,
    timeoutMs,
    organizationId,
    logger,
    chatDeps,
  });

  return { text: output.text, pageCount, metadata: outputToMetadata(output) };
}

async function callChatWithPages({
  modelId,
  pages,
  systemPrompt,
  userPrompt,
  modelOptions,
  timeoutMs,
  organizationId,
  logger,
  chatDeps,
}: {
  modelId: string;
  pages: DocumentPage[];
  systemPrompt: string;
  userPrompt: string;
  modelOptions: { temperature: number; maxTokens?: number };
  timeoutMs: number;
  organizationId: string;
  logger: Logger;
  chatDeps: ChatDependencies;
}): Promise<AiContentExtractionOutput> {
  const contentParts: Array<
    { type: 'image'; source: { type: 'url'; value: string } } | { type: 'text'; content: string }
  > = [];
  contentParts.push({ type: 'text', content: userPrompt });
  for (const page of pages) {
    contentParts.push({ type: 'image', source: { type: 'url', value: page.base64DataUrl } });
  }

  return generateChat({
    modelId,
    messages: [{ role: 'user' as const, content: contentParts }],
    systemPrompt,
    modelOptions,
    timeoutMs,
    organizationId,
    source: 'content-extraction',
    schema: aiContentExtractionOutputSchema,
    logger,
    ...chatDeps,
  });
}

/**
 * Coerce the model's `fields` payload into the canonical string map: keep
 * strings, stringify numbers/booleans (models love unquoted amounts), and
 * drop null ("could not extract"), empty strings, and anything non-scalar.
 * The schema already constrains values to string|null; this is the
 * defense-in-depth backstop (see the `fields` note in the schemas).
 */
function normalizeExtractedFields(fields: unknown): Record<string, string> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      if (value.length > 0) {
        normalized[key] = value;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = String(value);
    }
    // null, objects, and arrays carry no extractable value: drop them.
  }

  return normalized;
}

function outputToMetadata(
  output: Pick<AiContentExtractionOutput, 'title' | 'date' | 'tags' | 'fields'>,
): ExtractedDocumentMetadata {
  // Filter out any invalid tag entries the model may have returned. The schema
  // output type is structurally assignable to TagInput, no predicate needed.
  const tags: TagInput[] = output.tags.filter((tag) => {
    if (typeof tag === 'string') return tag.length > 0;
    return tag && typeof tag.name === 'string' && tag.name.length > 0;
  });

  return {
    title: output.title,
    tags,
    date: output.date ?? null,
    fields: normalizeExtractedFields(output.fields),
  };
}
