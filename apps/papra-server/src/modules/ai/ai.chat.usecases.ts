import { chat as tanstackChat, EventType } from '@tanstack/ai';
import type { ChatMiddleware } from '@tanstack/ai';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import type { GenericSchema, InferOutput } from 'valibot';
import type { Config } from '../config/config.types';
import type { Logger } from '../shared/logger/logger';
import { parseModelId } from './ai.models';
import { resolveTextAdapter } from './adapters/ai-adapters.usecases';
import { createAiCreditsMiddleware } from '../ai-credits/ai-credits.middlewares';
import type { AiCreditsUsageSource } from '../ai-credits/ai-credits.types';
import type { AiCreditsRepository } from '../ai-credits/ai-credits.repository';
import { checkOrganizationHasSufficientAiCredits } from '../ai-credits/ai-credits.usecases';
import type { PlansRepository } from '../plans/plans.repository';
import { createGetOrganizationPlanUsecase } from '../plans/plans.usecases';
import type { PlanEntitlementDefinitionRegistry } from '../plan-entitlements/plan-entitlements.registry';
import type { PlanEntitlementsRepository } from '../plan-entitlements/plan-entitlements.repository';
import type { SubscriptionsRepository } from '../subscriptions/subscriptions.repository';

type GenerateChatResult<Schema extends GenericSchema | undefined> = Schema extends GenericSchema
  ? InferOutput<Schema>
  : string;

/**
 * Dependencies required to run a chat completion with the shared AI concerns.
 * These are the same repositories `ai.services` uses, so they can be threaded
 * straight through from the global dependencies.
 */
export type ChatDependencies = {
  config: Config;
  aiCreditsRepository: AiCreditsRepository;
  plansRepository: PlansRepository;
  planEntitlementDefinitionRegistry: PlanEntitlementDefinitionRegistry;
  planEntitlementsRepository: PlanEntitlementsRepository;
  subscriptionsRepository: SubscriptionsRepository;
};

/**
 * Runs a single non-streaming chat completion, applying the shared AI concerns:
 * model resolution, the AI-credits sufficiency check, usage tracking, and error
 * logging.
 *
 * Shared by `ai.services` (auto-tagging, etc.) and the AI content extraction
 * strategy so that every model call is billed and logged consistently.
 */
export async function generateChat<Schema extends GenericSchema | undefined = undefined>({
  modelId,
  messages,
  systemPrompt,
  schema,
  modelOptions,
  timeoutMs,
  source,
  organizationId,
  logger,
  ...deps
}: {
  modelId: string;
  messages: unknown[];
  systemPrompt?: string;
  schema?: Schema;
  modelOptions?: { temperature?: number; maxTokens?: number };
  timeoutMs?: number;
  source: AiCreditsUsageSource;
  organizationId: string;
  logger: Logger;
} & ChatDependencies): Promise<GenerateChatResult<Schema>> {
  const adapter = resolveTextAdapter({ modelId, config: deps.config });

  if (deps.config.ai.credits.isEnabled) {
    await checkOrganizationHasSufficientAiCredits({
      organizationId,
      aiCreditsRepository: deps.aiCreditsRepository,
      getOrganizationPlan: createGetOrganizationPlanUsecase({
        plansRepository: deps.plansRepository,
        planEntitlementDefinitionRegistry: deps.planEntitlementDefinitionRegistry,
        planEntitlementsRepository: deps.planEntitlementsRepository,
        subscriptionsRepository: deps.subscriptionsRepository,
      }),
    });
  }

  const { modelName } = parseModelId(modelId);

  const middleware: ChatMiddleware[] = [
    createChatLogMiddleware({ logger, context: { modelId, model: modelName } }),
  ];

  if (deps.config.ai.credits.isEnabled) {
    middleware.push(
      createAiCreditsMiddleware({
        modelId,
        organizationId,
        source,
        logger,
        aiCreditsRepository: deps.aiCreditsRepository,
      }),
    );
  }

  const controller = new AbortController();
  const timeoutId =
    timeoutMs !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  try {
    const data = await tanstackChat({
      adapter,
      messages: messages as never,
      outputSchema: schema ? toStandardJsonSchema(schema) : undefined,
      stream: false,
      systemPrompts: systemPrompt ? [systemPrompt] : undefined,
      modelOptions,
      abortController: controller,
      middleware,
    });

    return data as GenerateChatResult<Schema>;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function createChatLogMiddleware({
  logger,
  context,
}: {
  logger: Logger;
  context: Record<string, unknown>;
}): ChatMiddleware {
  return {
    name: 'ai-chat-log',
    onChunk: (_ctx, chunk) => {
      if (chunk.type === EventType.RUN_ERROR) {
        logger.error(
          {
            error: {
              message: chunk.message,
              code: chunk.code,
            },
            ...context,
          },
          'Error generating chat response',
        );
      }
    },
    onUsage: (_ctx, usage) => {
      // Makes the token cost of every call observable on self-hosted installs
      // where the credits middleware is not enabled.
      logger.debug(
        {
          ...context,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
        'AI chat token usage',
      );
    },
    onFinish: (_ctx, info) => {
      if (info.finishReason === 'length' || info.finishReason === 'max_tokens') {
        // Truncated output is silent data loss for consumers like content
        // extraction (mid-sentence text, half-filled metadata).
        logger.warn(
          { ...context, finishReason: info.finishReason, durationMs: info.duration },
          'Model response was cut off at the output token limit; raise the model output cap or send smaller requests (e.g. lower pagesPerBatch)',
        );
      } else {
        logger.debug(
          { ...context, finishReason: info.finishReason, durationMs: info.duration },
          'AI chat run finished',
        );
      }
    },
  };
}
