import { buildAzureDiContentExtractionStrategy } from './azure-di/azure-di.content-extraction-strategy';
import type { ContentExtractionStrategyName } from './content-extraction-strategies.constants';
import type {
  ContentExtractionStrategy,
  ContentExtractionStrategyFactory,
} from './content-extraction-strategies.types';
import type { Config } from '../../../config/config.types';
import type { ChatDependencies } from '../../../ai/ai.chat.usecases';
import { buildCustomHttpContentExtractionStrategy } from './custom-http/custom-http.content-extraction-strategy';
import { buildDoclingContentExtractionStrategy } from './docling/docling.content-extraction-strategy';
import { buildLectureContentExtractionStrategy } from './lecture/lecture.content-extraction-strategy';
import { buildMistralOcrContentExtractionStrategy } from './mistral-ocr/mistral-ocr.content-extraction-strategy';
import { buildAiContentExtractionStrategy } from './ai/ai.content-extraction-strategy';

export const strategiesRegistry = {
  'internal': buildLectureContentExtractionStrategy,
  'mistral-ocr': buildMistralOcrContentExtractionStrategy,
  'docling': buildDoclingContentExtractionStrategy,
  'azure-di': buildAzureDiContentExtractionStrategy,
  'custom-http': buildCustomHttpContentExtractionStrategy,
  'ai': buildAiContentExtractionStrategy,
} satisfies Record<ContentExtractionStrategyName, ContentExtractionStrategyFactory>;

export function buildContentExtractionStrategy({
  strategyName,
  config,
  chatDeps,
}: {
  strategyName: string;
  config: Config;
  chatDeps: ChatDependencies;
}): ContentExtractionStrategy {
  const strategyBuilder = strategiesRegistry[strategyName as keyof typeof strategiesRegistry];

  if (!strategyBuilder) {
    throw new Error(`Content extraction strategy "${strategyName}" is not registered.`);
  }

  return strategyBuilder({ config, chatDeps });
}
