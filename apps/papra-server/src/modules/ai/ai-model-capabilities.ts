// Resolution chain for the model capabilities the content-extraction pipeline
// consumes (highest precedence first):
//
//   explicit config ▸ cached endpoint probe ▸ known-family table ▸ defaults
//
// An explicitly configured value is never overridden, so the absence of
// advertised model metadata can never silently change rendered pixels versus
// what the configuration states. Probing (ai.probeModelMetadata, on by
// default) is cached per model and best-effort; disable it with
// AI_PROBE_MODEL_METADATA=false to rely purely on config + family table.

import type { Logger } from '../shared/logger/logger';
import type { Config } from '../config/config.types';
import { AI_ADAPTERS_NAMES } from './adapters/ai-adapters.constants';
import type { AiAdapterName } from './adapters/ai-adapters.constants';
import { resolveFamilyMaxLongEdge } from './ai-model-capabilities.models';
import type { ProbedModelMetadata } from './ai-model-capabilities.models';
import { probeModelMetadata } from './ai-model-capabilities.probe';

export const DEFAULT_RENDER_MAX_LONG_EDGE = 1600;
export const DEFAULT_RENDER_MAX_PIXELS = 2_000_000;

export type MaxLongEdgeSource = 'config' | 'family-table' | 'default';
export type ProbeOutcome = 'disabled' | 'unsupported' | 'hit' | 'miss';

export type ResolvedModelCapabilities = {
  maxLongEdge: number;
  maxPixels: number;
  contextLength: number | undefined;
  visionCapable: boolean | undefined;
  maxLongEdgeSource: MaxLongEdgeSource;
  probeOutcome: ProbeOutcome;
};

const probeSuccessTtlMs = 60 * 60_000;
const probeFailureTtlMs = 10 * 60_000;

type ProbeFn = (args: {
  adapterName: AiAdapterName;
  modelName: string;
  baseUrl: string | undefined;
  apiKey: string | undefined;
}) => Promise<ProbedModelMetadata | undefined>;

export type AiModelCapabilitiesRegistry = {
  resolveModelCapabilities: (args: {
    adapterName: string;
    modelName: string;
    logger?: Logger;
  }) => Promise<ResolvedModelCapabilities>;
  clearCache: () => void;
};

/**
 * Builds the model-capabilities resolver for a server instance. The probe
 * cache is scoped to the instance (no module-level state), so a factory that
 * lives as long as the server amortizes one probe per model across all
 * extractions, while tests get isolation for free by building their own.
 */
export function createAiModelCapabilitiesRegistry({
  config,
  probe = probeModelMetadata,
  now = Date.now,
}: {
  config: Config;
  probe?: ProbeFn;
  now?: () => number;
}): AiModelCapabilitiesRegistry {
  const probeCache = new Map<
    string,
    { metadata: ProbedModelMetadata | undefined; expiresAtMs: number }
  >();

  async function probeCached({
    adapterName,
    modelName,
  }: {
    adapterName: AiAdapterName;
    modelName: string;
  }): Promise<ProbedModelMetadata | undefined> {
    const key = `${adapterName}://${modelName}`;
    const cached = probeCache.get(key);
    if (cached && cached.expiresAtMs > now()) {
      return cached.metadata;
    }

    // Adapter credentials live under config.ai.adapters, keyed by adapter name
    // (openai-compatible adapters and anthropic all expose baseUrl + apiKey).
    const adapterConfig = (
      config.ai.adapters as unknown as Record<
        string,
        { baseUrl?: string; apiKey?: string } | undefined
      >
    )[adapterName];

    const metadata = await probe({
      adapterName,
      modelName,
      baseUrl: adapterConfig?.baseUrl,
      apiKey: adapterConfig?.apiKey,
    });

    probeCache.set(key, {
      metadata,
      expiresAtMs: now() + (metadata ? probeSuccessTtlMs : probeFailureTtlMs),
    });

    return metadata;
  }

  async function resolveModelCapabilities({
    adapterName,
    modelName,
    logger,
  }: {
    adapterName: string;
    modelName: string;
    logger?: Logger;
  }): Promise<ResolvedModelCapabilities> {
    const renderConfig = config.documentContentExtraction.strategy.ai;

    const familyMaxLongEdge = resolveFamilyMaxLongEdge({ modelName });
    const maxLongEdge =
      renderConfig.renderMaxLongEdge ?? familyMaxLongEdge ?? DEFAULT_RENDER_MAX_LONG_EDGE;
    const maxPixels = renderConfig.renderMaxPixels ?? DEFAULT_RENDER_MAX_PIXELS;
    const maxLongEdgeSource: MaxLongEdgeSource =
      renderConfig.renderMaxLongEdge !== undefined
        ? 'config'
        : familyMaxLongEdge !== undefined
          ? 'family-table'
          : 'default';

    const probeEnabled = config.ai.probeModelMetadata ?? true;
    const isProbeableAdapter = (AI_ADAPTERS_NAMES as readonly string[]).includes(adapterName);

    let probeOutcome: ProbeOutcome;
    let probed: ProbedModelMetadata | undefined;

    if (!probeEnabled) {
      probeOutcome = 'disabled';
    } else if (!isProbeableAdapter) {
      probeOutcome = 'unsupported';
    } else {
      probed = await probeCached({
        adapterName: adapterName as AiAdapterName,
        modelName,
      });
      probeOutcome = probed ? 'hit' : 'miss';
    }

    const resolved: ResolvedModelCapabilities = {
      maxLongEdge,
      maxPixels,
      contextLength: probed?.contextLength,
      visionCapable: probed?.visionCapable,
      maxLongEdgeSource,
      probeOutcome,
    };

    logger?.debug(
      {
        adapterName,
        modelName,
        maxLongEdge,
        maxLongEdgeSource,
        maxPixels,
        contextLength: resolved.contextLength,
        visionCapable: resolved.visionCapable,
        probeOutcome,
      },
      'Resolved AI model capabilities',
    );

    if (resolved.visionCapable === false) {
      logger?.warn(
        { adapterName, modelName },
        'The model endpoint reports no image input support; AI content extraction may fail for rendered pages',
      );
    }

    return resolved;
  }

  function clearCache(): void {
    probeCache.clear();
  }

  return { resolveModelCapabilities, clearCache };
}
