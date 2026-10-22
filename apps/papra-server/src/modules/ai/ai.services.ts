import type { Logger } from '@crowlog/logger';
import type { GenericSchema, InferOutput } from 'valibot';
import { createLogger } from '../shared/logger/logger';
import type { AiCreditsUsageSource } from '../ai-credits/ai-credits.types';
import { generateChat } from './ai.chat.usecases';
import type { ChatDependencies } from './ai.chat.usecases';

export type AiServices = ReturnType<typeof createAiServices>;

// When no schema is provided, the model output is not constrained and the raw text is returned.
type GenerateStructuredDataResult<Schema extends GenericSchema | undefined> =
  Schema extends GenericSchema ? InferOutput<Schema> : string;

export function createAiServices({
  chatDependencies,
  logger = createLogger({ namespace: 'ai.services' }),
}: {
  chatDependencies: ChatDependencies;
  logger?: Logger;
}) {
  // Not using injectArguments here: it relies on Parameters/ReturnType, which collapse the
  // `Schema` type parameter to its constraint, making the result `unknown`. A thin generic
  // wrapper preserves inference so callers get back InferOutput<Schema>.
  return {
    generateStructuredData: async <Schema extends GenericSchema | undefined = undefined>(args: {
      modelId: string;
      schema?: Schema;
      userPrompt: string;
      systemPrompt?: string;
      source: AiCreditsUsageSource;
      organizationId: string;
    }): Promise<GenerateStructuredDataResult<Schema>> =>
      generateStructuredData({ ...args, ...chatDependencies, logger }),
  };
}

async function generateStructuredData<Schema extends GenericSchema | undefined>({
  modelId,
  schema,
  userPrompt,
  systemPrompt,
  source,
  organizationId,
  logger,
  ...chatDependencies
}: {
  modelId: string;
  schema?: Schema;
  userPrompt: string;
  systemPrompt?: string;
  source: AiCreditsUsageSource;
  organizationId: string;
  logger: Logger;
} & ChatDependencies): Promise<GenerateStructuredDataResult<Schema>> {
  const data = await generateChat({
    modelId,
    messages: userPrompt ? [{ role: 'user', content: userPrompt }] : [],
    systemPrompt,
    schema,
    source,
    organizationId,
    logger,
    ...chatDependencies,
  });

  return data as GenerateStructuredDataResult<Schema>;
}
