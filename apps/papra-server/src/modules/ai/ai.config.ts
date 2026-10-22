import { aiModelIdSchema } from './ai.schemas';
import { booleanishSchema } from '../config/config.schemas';
import type { AppConfigDefinition } from '../config/config.types';
import * as v from 'valibot';
import { AI_DEFAULT_MODEL_ENV_KEY } from './ai.constants';
import { openAiAdaptersConfig } from './adapters/openai-compatible/openai-compatible.config';
import { anthropicAdaptersConfig } from './adapters/anthropic/anthropic.ai-adapters.config';

export const aiConfig = {
  isEnabled: {
    doc: 'Whether AI features are enabled',
    schema: booleanishSchema,
    env: 'AI_IS_ENABLED',
    default: false,
  },
  credits: {
    isEnabled: {
      doc: 'Whether to enforce AI credit limits and track credit usage. Enable for metered instances; leave disabled for self-hosting.',
      schema: booleanishSchema,
      env: 'AI_CREDITS_IS_ENABLED',
      default: false,
    },
  },
  adapters: {
    anthropic: anthropicAdaptersConfig,
    ...openAiAdaptersConfig,
  },
  defaultModelId: {
    doc: 'Default AI model to use when no specific model is specified, the format is <adapterId>://<modelName>, e.g. "ollama://llama3.1:8b".',
    schema: v.optional(aiModelIdSchema),
    env: AI_DEFAULT_MODEL_ENV_KEY,
    default: undefined,
  },
  probeModelMetadata: {
    doc: 'Whether papra may query the configured model endpoint (GET /models/<id> on OpenAI-compatible APIs, POST /api/show on Ollama) for advertised model metadata such as context length and vision support. On by default; results are cached per model. Set to false to rely only on explicit configuration and the built-in family table. This switch never overrides values set explicitly elsewhere.',
    schema: v.optional(booleanishSchema),
    env: 'AI_PROBE_MODEL_METADATA',
    default: undefined,
  },
} as const satisfies AppConfigDefinition;
