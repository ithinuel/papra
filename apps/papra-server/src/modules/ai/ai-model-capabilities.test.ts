import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../shared/logger/logger';
import type { Config } from '../config/config.types';
import {
  createAiModelCapabilitiesRegistry,
  DEFAULT_RENDER_MAX_LONG_EDGE,
  DEFAULT_RENDER_MAX_PIXELS,
} from './ai-model-capabilities';
import type { ProbedModelMetadata } from './ai-model-capabilities.models';

const HOUR_MS = 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;

function buildConfig({
  renderMaxLongEdge,
  renderMaxPixels,
  probeModelMetadata,
}: {
  renderMaxLongEdge?: number;
  renderMaxPixels?: number;
  probeModelMetadata?: boolean;
} = {}): Config {
  return {
    documentContentExtraction: { strategy: { ai: { renderMaxLongEdge, renderMaxPixels } } },
    ai: {
      probeModelMetadata,
      adapters: {
        openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' },
        ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
      },
    },
  } as unknown as Config;
}

async function noopProbe(): Promise<ProbedModelMetadata | undefined> {
  return undefined;
}

describe('createAiModelCapabilitiesRegistry', () => {
  it('an explicit config value wins over the family table and the probe', async () => {
    const probe = vi.fn(async () => ({ contextLength: 128_000 }));
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig({ renderMaxLongEdge: 1024, renderMaxPixels: 900_000 }),
      probe,
    });

    const resolved = await resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });

    expect(resolved.maxLongEdge).toBe(1024);
    expect(resolved.maxLongEdgeSource).toBe('config');
    expect(resolved.maxPixels).toBe(900_000);
  });

  it('falls back to the known family table when config leaves the cap unset', async () => {
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe: noopProbe,
    });

    const resolved = await resolveModelCapabilities({
      adapterName: 'anthropic',
      modelName: 'claude-sonnet-4-20250514',
    });

    expect(resolved.maxLongEdge).toBe(1568);
    expect(resolved.maxLongEdgeSource).toBe('family-table');
    // The pixel backstop is independent of the family long-edge cap.
    expect(resolved.maxPixels).toBe(DEFAULT_RENDER_MAX_PIXELS);
  });

  it('falls back to the defaults for unknown families with nothing advertised', async () => {
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe: noopProbe,
    });

    const resolved = await resolveModelCapabilities({
      adapterName: 'openai',
      modelName: 'some-unknown-model',
    });

    expect(resolved.maxLongEdge).toBe(DEFAULT_RENDER_MAX_LONG_EDGE);
    expect(resolved.maxLongEdgeSource).toBe('default');
    expect(resolved.contextLength).toBeUndefined();
    expect(resolved.visionCapable).toBeUndefined();
    expect(resolved.probeOutcome).toBe('miss');
  });

  it('does not probe when probeModelMetadata is disabled', async () => {
    const probe = vi.fn(noopProbe);
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig({ probeModelMetadata: false }),
      probe,
    });

    const resolved = await resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });

    expect(probe).not.toHaveBeenCalled();
    expect(resolved.probeOutcome).toBe('disabled');
  });

  it('does not probe adapters without a metadata endpoint', async () => {
    const probe = vi.fn(noopProbe);
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe,
    });

    const resolved = await resolveModelCapabilities({
      adapterName: 'some-future-adapter',
      modelName: 'whatever',
    });

    expect(probe).not.toHaveBeenCalled();
    expect(resolved.probeOutcome).toBe('unsupported');
  });

  it('passes the adapter credentials from config to the probe', async () => {
    const probe = vi.fn(noopProbe);
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe,
    });

    await resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });

    expect(probe).toHaveBeenCalledWith({
      adapterName: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
  });

  it('carries advertised metadata through to the resolution', async () => {
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe: async () => ({ contextLength: 200_000, visionCapable: true }),
    });

    const resolved = await resolveModelCapabilities({
      adapterName: 'openrouter',
      modelName: 'anthropic/claude-sonnet-4',
    });

    expect(resolved.contextLength).toBe(200_000);
    expect(resolved.visionCapable).toBe(true);
    expect(resolved.probeOutcome).toBe('hit');
  });

  it('warns when the endpoint reports no image support', async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn } as unknown as Logger;
    const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
      config: buildConfig(),
      probe: async () => ({ visionCapable: false }),
    });

    await resolveModelCapabilities({ adapterName: 'openai', modelName: 'o3', logger });

    expect(warn).toHaveBeenCalled();
  });

  describe('probe cache', () => {
    it('serves repeat resolutions from the cache', async () => {
      const probe = vi.fn(async () => ({ contextLength: 32_000 }));
      let nowMs = 0;
      const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
        config: buildConfig(),
        probe,
        now: () => nowMs,
      });

      await resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });
      nowMs += 1_000;
      const second = await resolveModelCapabilities({
        adapterName: 'openai',
        modelName: 'gpt-4o',
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(second.contextLength).toBe(32_000);

      // Successes expire after the success TTL
      nowMs += HOUR_MS + 1;
      await resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('caches misses for a shorter time than hits', async () => {
      const probe = vi.fn(noopProbe);
      let nowMs = 0;
      const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
        config: buildConfig(),
        probe,
        now: () => nowMs,
      });

      await resolveModelCapabilities({
        adapterName: 'openai',
        modelName: 'text-only-model',
      });

      nowMs += MISS_TTL_MS - 1_000;
      await resolveModelCapabilities({
        adapterName: 'openai',
        modelName: 'text-only-model',
      });
      expect(probe).toHaveBeenCalledTimes(1);

      nowMs += 2_000;
      await resolveModelCapabilities({
        adapterName: 'openai',
        modelName: 'text-only-model',
      });
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('keys the cache per adapter and model', async () => {
      const probe = vi.fn(noopProbe);
      const { resolveModelCapabilities } = createAiModelCapabilitiesRegistry({
        config: buildConfig(),
        probe,
      });

      await resolveModelCapabilities({ adapterName: 'openai', modelName: 'shared-name' });
      await resolveModelCapabilities({ adapterName: 'ollama', modelName: 'shared-name' });

      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('is scoped per registry instance', async () => {
      const probe = vi.fn(noopProbe);

      const first = createAiModelCapabilitiesRegistry({ config: buildConfig(), probe });
      await first.resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });

      // A new instance has an empty cache, so the probe fires again.
      const second = createAiModelCapabilitiesRegistry({ config: buildConfig(), probe });
      await second.resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });

      expect(probe).toHaveBeenCalledTimes(2);

      // Within an instance resolutions are still cached.
      await second.resolveModelCapabilities({ adapterName: 'openai', modelName: 'gpt-4o' });
      expect(probe).toHaveBeenCalledTimes(2);
    });
  });
});
