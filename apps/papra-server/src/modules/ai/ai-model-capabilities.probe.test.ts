import { describe, expect, it, vi } from 'vitest';
import { probeModelMetadata } from './ai-model-capabilities.probe';

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

function jsonFetch(body: unknown, { ok = true, status = 200 } = {}) {
  return vi.fn(async (_url: string, _init?: FetchInit) => ({
    ok,
    status,
    json: async () => body,
  }));
}

describe('probeModelMetadata', () => {
  it('queries the OpenAI-compatible model endpoint with a bearer token', async () => {
    const fetchImpl = jsonFetch({ context_length: 128_000, supported_modalities: ['image'] });

    const metadata = await probeModelMetadata({
      adapterName: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(metadata).to.eql({ contextLength: 128_000, visionCapable: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/models/gpt-4o');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('encodes namespaced model ids (openrouter) into the path', async () => {
    const fetchImpl = jsonFetch({});

    await probeModelMetadata({
      adapterName: 'openrouter',
      modelName: 'anthropic/claude-sonnet-4',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'or-key',
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://openrouter.ai/api/v1/models/anthropic%2Fclaude-sonnet-4',
    );
  });

  it('probes Ollama native /api/show rooted above the /v1 base url', async () => {
    const fetchImpl = jsonFetch({
      model_info: { 'llama.context_length': 131_072 },
      capabilities: ['completion'],
    });

    const metadata = await probeModelMetadata({
      adapterName: 'ollama',
      modelName: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      fetchImpl,
    });

    expect(metadata).to.eql({ contextLength: 131_072, visionCapable: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/show');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ model: 'llama3.1:8b' }));
  });

  it('probes Anthropic /v1/models with its api headers', async () => {
    const fetchImpl = jsonFetch({ max_input_tokens: 200_000 });

    const metadata = await probeModelMetadata({
      adapterName: 'anthropic',
      modelName: 'claude-sonnet-4',
      baseUrl: undefined,
      apiKey: 'sk-ant',
      fetchImpl,
    });

    expect(metadata).to.eql({ contextLength: 200_000 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models/claude-sonnet-4');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('returns undefined on non-2xx responses', async () => {
    const metadata = await probeModelMetadata({
      adapterName: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetchImpl: jsonFetch({ error: 'nope' }, { ok: false, status: 404 }),
    });

    expect(metadata).toBeUndefined();
  });

  it('returns undefined when the body is not JSON', async () => {
    const metadata = await probeModelMetadata({
      adapterName: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('not json');
        },
      })),
    });

    expect(metadata).toBeUndefined();
  });

  it('returns undefined when the fetch itself fails (endpoint unreachable)', async () => {
    const metadata = await probeModelMetadata({
      adapterName: 'ollama',
      modelName: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });

    expect(metadata).toBeUndefined();
  });

  it('returns undefined when the response carries no usable metadata', async () => {
    const metadata = await probeModelMetadata({
      adapterName: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetchImpl: jsonFetch({ id: 'gpt-4o', owned_by: 'openai' }),
    });

    expect(metadata).toBeUndefined();
  });

  it('skips the request when an OpenAI-compatible adapter has no base url', async () => {
    const fetchImpl = jsonFetch({});

    const metadata = await probeModelMetadata({
      adapterName: 'vllm',
      modelName: 'some-model',
      baseUrl: undefined,
      apiKey: undefined,
      fetchImpl,
    });

    expect(metadata).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
