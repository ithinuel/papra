// Live probes for model metadata: OpenAI-compatible `GET /models/{id}`,
// Ollama `POST /api/show`, Anthropic `GET /v1/models/{id}`. Every probe is
// best-effort with a short timeout — an endpoint that does not answer (or
// answers with junk) must never affect extraction.

import type { AiAdapterName } from './adapters/ai-adapters.constants';
import {
  parseAnthropicModelMetadata,
  parseOllamaShowResponse,
  parseOpenAiCompatibleModelMetadata,
} from './ai-model-capabilities.models';
import type { ProbedModelMetadata } from './ai-model-capabilities.models';

export const MODEL_PROBE_TIMEOUT_MS = 2_000;

const anthropicDefaultBaseUrl = 'https://api.anthropic.com';
const anthropicApiVersion = '2023-06-01';

type ProbeFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchJson({
  fetchImpl,
  timeoutMs,
  url,
  init,
}: {
  fetchImpl: ProbeFetch;
  timeoutMs: number;
  url: string;
  init?: Parameters<ProbeFetch>[1];
}): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  if (!response.ok) {
    return undefined;
  }

  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
export async function probeModelMetadata({
  adapterName,
  modelName,
  baseUrl,
  apiKey,
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}: {
  adapterName: AiAdapterName;
  modelName: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: ProbeFetch;
}): Promise<ProbedModelMetadata | undefined> {
  try {
    if (adapterName === 'ollama') {
      return await probeOllama({ baseUrl, apiKey, timeoutMs, fetchImpl, modelName });
    }

    if (adapterName === 'anthropic') {
      return await probeAnthropic({ baseUrl, apiKey, timeoutMs, fetchImpl, modelName });
    }

    return await probeOpenAiCompatible({ baseUrl, apiKey, timeoutMs, fetchImpl, modelName });
  } catch {
    // Unreachable endpoints, timeouts, and broken payloads all land here:
    // probing is strictly advisory, so the caller just sees "no metadata".
    return undefined;
  }
}

async function probeOpenAiCompatible({
  modelName,
  baseUrl,
  apiKey,
  timeoutMs,
  fetchImpl,
}: {
  modelName: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl: ProbeFetch;
}): Promise<ProbedModelMetadata | undefined> {
  if (!baseUrl) {
    return undefined;
  }

  const url = `${trimTrailingSlash(baseUrl)}/models/${encodeURIComponent(modelName)}`;
  const body = await fetchJson({
    fetchImpl,
    timeoutMs,
    url,
    init: { headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } },
  });

  return definedMetadata(parseOpenAiCompatibleModelMetadata(body));
}

async function probeOllama({
  baseUrl,
  apiKey,
  timeoutMs,
  fetchImpl,
  modelName,
}: {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl: ProbeFetch;
  modelName: string;
}): Promise<ProbedModelMetadata | undefined> {
  // The adapter targets Ollama's OpenAI-compatible surface (.../v1); the
  // metadata lives on Ollama's native API, rooted one level above it.
  const root = trimTrailingSlash(baseUrl ?? 'http://localhost:11434').replace(/\/v1$/, '');
  const body = await fetchJson({
    fetchImpl,
    timeoutMs,
    url: `${root}/api/show`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: modelName }),
    },
  });

  return definedMetadata(parseOllamaShowResponse(body));
}

async function probeAnthropic({
  baseUrl,
  apiKey,
  timeoutMs,
  fetchImpl,
  modelName,
}: {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl: ProbeFetch;
  modelName: string;
}): Promise<ProbedModelMetadata | undefined> {
  const body = await fetchJson({
    fetchImpl,
    timeoutMs,
    url: `${trimTrailingSlash(baseUrl ?? anthropicDefaultBaseUrl)}/v1/models/${encodeURIComponent(modelName)}`,
    init: {
      headers: {
        'anthropic-version': anthropicApiVersion,
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    },
  });

  return definedMetadata(parseAnthropicModelMetadata(body));
}

function definedMetadata(metadata: ProbedModelMetadata): ProbedModelMetadata | undefined {
  return metadata.contextLength === undefined && metadata.visionCapable === undefined
    ? undefined
    : metadata;
}
