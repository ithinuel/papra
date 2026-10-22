import * as v from 'valibot';

/**
 * A tag can be:
 * - A plain string (existing tag name)
 * - An object with name + optional description (new tag suggestion)
 */
export const tagSchema = v.union([
  v.string(),
  v.object({
    name: v.string(),
    description: v.optional(v.string()),
  }),
]);

/**
 * Schema for the AI model's structured output during content extraction.
 * Mirrors the JSON format described in the system prompt.
 *
 * `text` has no minLength: a batch of blank pages legitimately yields no text.
 * Emptiness of the *aggregated* text is checked by the caller, which raises a
 * typed error so the next extraction strategy gets a chance.
 *
 * `fields` must stay a `v.record`, not `v.objectWithRest({}, …)`: the rest
 * form converts to an object with an explicit `properties: {}`, which
 * grammar-based structured-output backends (Ollama/llama.cpp, vLLM, …) read
 * as "closed object, zero keys allowed" and force the model to emit `{}`
 * even when the prompt lists the properties to extract (observed in the
 * field). A record converts to an open map (`propertyNames` +
 * `additionalProperties`); strict schema validators that reject
 * `propertyNames` should learn it rather than the other way around.
 * `normalizeExtractedFields` in the usecases is the code-side backstop.
 */
export const aiContentExtractionOutputSchema = v.object({
  title: v.string(),
  date: v.optional(v.string()),
  text: v.string(),
  tags: v.array(tagSchema),
  fields: v.record(v.string(), v.nullable(v.string())),
});

/**
 * Schema for the document-wide metadata call (multi-chunk PDFs): identical to
 * the extraction schema minus `text`, since the joined transcription is the
 * input and only metadata is expected back.
 */
export const aiMetadataOutputSchema = v.object({
  title: v.string(),
  date: v.optional(v.string()),
  tags: v.array(tagSchema),
  fields: v.record(v.string(), v.nullable(v.string())),
});

/**
 * Inferred output type from the schema.
 */
export type AiContentExtractionOutput = v.InferOutput<typeof aiContentExtractionOutputSchema>;
export type AiMetadataOutput = v.InferOutput<typeof aiMetadataOutputSchema>;
