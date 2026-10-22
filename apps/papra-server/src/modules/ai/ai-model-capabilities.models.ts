// Pure pieces of model-capability resolution: the known-family image caps,
// the reconciling-metadata-call input budget, and tolerant parsers for the
// model-metadata endpoints of the supported adapters. Everything here is
// side-effect free so it can be unit-tested without fetch or config.

export type ProbedModelMetadata = {
  /** Context window in tokens, when advertised. */
  contextLength?: number;
  /** Whether the model advertises image/vision input, when advertised. */
  visionCapable?: boolean;
};

/**
 * Raster long-edge caps (px) for known model families, from providers' image
 * handling documentation. Values above the cap cost tokens without adding
 * detail the model will look at; small pages are never upscaled to the cap.
 */
const familyImageCaps: Array<{ pattern: RegExp; maxLongEdge: number }> = [
  // Anthropic resizes images above ~1568px long edge before tokenizing
  { pattern: /claude/, maxLongEdge: 1568 },
  // OpenAI "high" detail tiles images at 2048px long edge
  { pattern: /^gpt-4/, maxLongEdge: 2048 },
  { pattern: /^o\d/, maxLongEdge: 2048 },
  // Gemma 3 uses fixed 768px vision patches
  { pattern: /gemma[-_]?3/, maxLongEdge: 768 },
  // Qwen-VL models use up to ~1600px effective resolution ("qwen2.5-vl-7b",
  // Ollama's "qwen2.5vl:7b", ...)
  { pattern: /qwen[^/]*vl/, maxLongEdge: 1600 },
];

/**
 * Looks up the long-edge raster cap for a well-known model family, or
 * undefined when the family is unknown.
 */
export function resolveFamilyMaxLongEdge({ modelName }: { modelName: string }): number | undefined {
  const name = modelName.toLowerCase();

  return familyImageCaps.find(({ pattern }) => pattern.test(name))?.maxLongEdge;
}

/** Budget for the reconciling metadata call when the context length is unknown. */
export const METADATA_INPUT_DEFAULT_MAX_CHARS = 60_000;

/**
 * Hard ceiling regardless of how large the advertised context is: metadata
 * lives near the top of documents, so past this point extra input is pure cost.
 */
export const METADATA_INPUT_CEILING_MAX_CHARS = 200_000;

/** Below this, tiny-context models would receive less than a page of text. */
export const METADATA_INPUT_MIN_CHARS = 8_000;

// Rough rule-of-thumb: ~4 characters per token for Latin-script documents.
const approxCharsPerToken = 4;

/** Share of the context window the metadata call may spend on the joined text. */
const metadataContextShare = 0.4;

/**
 * Character budget for the joined transcription sent to the reconciling
 * metadata call: ~40% of the advertised context window converted to
 * characters (leaving room for the prompt and the response), clamped to a
 * sane band; the conservative default applies when nothing is advertised.
 */
export function computeMetadataInputBudget({ contextLength }: { contextLength?: number }): number {
  if (contextLength === undefined || contextLength <= 0) {
    return METADATA_INPUT_DEFAULT_MAX_CHARS;
  }

  const budget = Math.round(contextLength * approxCharsPerToken * metadataContextShare);

  return Math.min(METADATA_INPUT_CEILING_MAX_CHARS, Math.max(METADATA_INPUT_MIN_CHARS, budget));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

function readVisionFromModalities(record: Record<string, unknown>): boolean | undefined {
  // OpenRouter: architecture.input_modalities: ['text', 'image', ...]
  const architecture = asRecord(record.architecture);
  const inputModalities = architecture?.input_modalities;
  if (Array.isArray(inputModalities)) {
    return inputModalities.some((modality) => modality === 'image' || modality === 'video');
  }

  // OpenRouter (legacy): modality: 'text+image=>text'
  if (typeof architecture?.modality === 'string') {
    return architecture.modality.includes('image');
  }

  // Newer OpenAI-style listings: supported_modalities / input_modalities at top level
  const topLevel = record.supported_modalities ?? record.input_modalities;
  if (Array.isArray(topLevel)) {
    return topLevel.some((modality) => modality === 'image' || modality === 'video');
  }

  return undefined;
}

/**
 * Parses a `GET {baseUrl}/models/{id}` response (OpenAI, OpenRouter, vLLM,
 * LM Studio, …). Providers omit fields freely; anything unrecognized is
 * simply absent.
 */
export function parseOpenAiCompatibleModelMetadata(body: unknown): ProbedModelMetadata {
  const record = asRecord(body);
  if (!record) {
    return {};
  }

  const metadata: ProbedModelMetadata = {};

  const contextLength = pickNumber(record, ['context_length', 'max_model_len', 'context_window']);
  if (contextLength !== undefined) {
    metadata.contextLength = contextLength;
  }

  const visionCapable = readVisionFromModalities(record);
  if (visionCapable !== undefined) {
    metadata.visionCapable = visionCapable;
  }

  return metadata;
}

/**
 * Parses Ollama's `POST /api/show` response: `capabilities` lists "vision"
 * and `model_info` carries architecture-prefixed keys such as
 * `qwen2.5vl.context_length`.
 */
export function parseOllamaShowResponse(body: unknown): ProbedModelMetadata {
  const record = asRecord(body);
  if (!record) {
    return {};
  }

  const metadata: ProbedModelMetadata = {};

  const modelInfo = asRecord(record.model_info);
  if (modelInfo) {
    const contextKey = Object.keys(modelInfo).find((key) => key.endsWith('.context_length'));
    const contextLength = contextKey ? modelInfo[contextKey] : undefined;
    if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) {
      metadata.contextLength = contextLength;
    }
  }

  if (Array.isArray(record.capabilities)) {
    metadata.visionCapable = record.capabilities.includes('vision');
  }

  return metadata;
}

/**
 * Parses Anthropic's `GET /v1/models/{id}` response. Today it carries little
 * model metadata, so this mainly future-proofs the fields if/when they show
 * up; the family table covers what the endpoint does not.
 */
export function parseAnthropicModelMetadata(body: unknown): ProbedModelMetadata {
  const record = asRecord(body);
  if (!record) {
    return {};
  }

  const metadata = parseOpenAiCompatibleModelMetadata(record);

  const maxInputTokens = pickNumber(record, ['max_input_tokens']);
  if (maxInputTokens !== undefined) {
    metadata.contextLength = maxInputTokens;
  }

  return metadata;
}
