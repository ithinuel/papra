import { createLogger } from '../../shared/logger/logger';
import type { Logger } from '../../shared/logger/logger';
import type { Config } from '../../config/config.types';
import { buildContentExtractionStrategy } from './content-extraction-strategies/content-extraction.strategies';
import { castError } from '@corentinth/chisels';
import { createNoStrategyAbleToExtractTextError } from './content-extraction.errors';
import type {
  ContentExtractionRunContext,
  ExtractedDocumentMetadata,
} from './content-extraction-strategies/content-extraction-strategies.types';
import type { ChatDependencies } from '../../ai/ai.chat.usecases';

// Note: the run context is bound when the usecase is built (see the builder
// argument), not per call, so the call signature only takes the file.
export type ExtractDocumentTextUsecase = (args: { file: File }) => Promise<{
  text: string;
  metadata?: ExtractedDocumentMetadata;
}>;

export function buildExtractDocumentTextUsecase({
  ocrLanguages,
  config,
  runContext,
  chatDeps,
  logger = createLogger({ namespace: 'extract-document-text-usecase' }),
}: {
  ocrLanguages?: string[];
  config: Config;
  runContext?: ContentExtractionRunContext;
  chatDeps: ChatDependencies;
  logger?: Logger;
}) {
  // Strategies are cheap to describe but not free to build (the AI strategy
  // validates and compiles its prompt templates, creates its logger). Since
  // config and chatDeps are fixed for this usecase, build each strategy at most
  // once instead of on every attempt of every document.
  const strategies = new Map<string, ReturnType<typeof buildContentExtractionStrategy>>();
  const getStrategy = (strategyName: string) => {
    let strategy = strategies.get(strategyName);

    if (!strategy) {
      strategy = buildContentExtractionStrategy({ strategyName, config, chatDeps });
      strategies.set(strategyName, strategy);
    }

    return strategy;
  };

  return async ({ file }: { file: File }) => {
    const { extractionStrategies } = config.documentContentExtraction;
    const errors: Error[] = [];

    for (const strategyName of extractionStrategies) {
      const strategy = getStrategy(strategyName);

      try {
        const canExtract = await strategy.canExtractTextFromDocument({ file });

        if (!canExtract) {
          logger.debug(`Strategy ${strategyName} cannot extract text from document, skipping.`);
          continue;
        }

        logger.debug(`Using strategy ${strategyName} to extract text from document`);

        const startingTime = Date.now();
        const { text, extractionContext, metadata } = await strategy.extractTextFromDocument({
          file,
          ocrLanguages,
          runContext,
          logger,
        });
        const durationMs = Date.now() - startingTime;

        logger.info(
          {
            durationMs,
            strategyName,
            fileSize: file.size,
            fileType: file.type,
            ...extractionContext,
          },
          'Extracted text from document',
        );

        return { text, metadata };
      } catch (error) {
        logger.error(
          {
            strategyName,
            fileSize: file.size,
            fileType: file.type,
            error,
          },
          'Error extracting text from document',
        );
        errors.push(castError(error));
      }
    }

    if (errors.length === 0) {
      throw createNoStrategyAbleToExtractTextError();
    }

    throw new AggregateError(
      errors,
      'All content extraction strategies failed to extract text from document',
    );
  };
}
