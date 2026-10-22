import * as v from 'valibot';
import type { AppConfigDefinition } from '../../../../config/config.types';
import {
  coercedPositiveIntegerSchema,
  coercedStrictlyPositiveIntegerSchema,
} from '../../../../shared/schemas/number.schemas';
import { IN_BYTES, IN_MS } from '../../../../shared/units';

export const aiContentExtractionConfig = {
  adapterName: {
    doc: 'Optional override for the adapter name to use for AI content extraction. If not set, the adapter from the default model ID (ai.defaultModelId) will be used.',
    env: 'CONTENT_EXTRACTION_AI_ADAPTER_NAME',
    schema: v.optional(v.string()),
    default: undefined,
  },
  modelName: {
    doc: 'Optional override for the model name to use for AI content extraction. If not set, the model from the default model ID (ai.defaultModelId) will be used.',
    env: 'CONTENT_EXTRACTION_AI_MODEL_NAME',
    schema: v.optional(v.string()),
    default: undefined,
  },
  systemPrompt: {
    doc: 'The system prompt to send to the model. Uses Nunjucks template syntax with access to file, document, tags, customProperties, batch, pageCount, and ai context variables.',
    env: 'CONTENT_EXTRACTION_AI_SYSTEM_PROMPT',
    schema: v.string(),
    default: `You are a document analysis assistant processing documents for an archival facility. Your job is to extract text content and structured metadata from document images.

## Extraction Rules

1. **Text extraction**:
   Extract all visible text faithfully.
   Preserve the original structure — especially tables, lists, headers, and key-value pairs.
   When a table is present, reproduce it in markdown format (pipe-delimited). For multi-page documents, separate pages with ---PAGE BREAK---
2. **Do not invent**:
   Only extract information that is visibly present in the document.
   If a field cannot be determined, omit it or use null.
3. **Title**:
   Derive a concise, descriptive title from the document content (e.g., document type, recipient, sender, subject line).
   Do not use the filename.
4. **Date**:
   Extract the most relevant document date (invoice date, issue date, etc.), not the scan/print date. Format as YYYY-MM-DD.
5. **Tags**: Use the tag list below. Pick up to {{ ai.maxTags }} tags that best describe this document.
   - For **existing tags**, return just the tag name as a plain string
{% if ai.canCreateNewTags -%}
   - You may suggest new tags when the document's category doesn't match any existing tag. Always provide a \`name\` in Title Case and a brief \`description\` explaining when to use it.
{% endif -%}
{%- if customProperties.length > 0 -%}
6. **Custom properties**: Populate the fields below using values extracted from the document. Only set a field if you can confidently extract its value from the document.
{%- endif %}

## Available Tags
{% if tags.length == 0 %}
No existing tags.
{% else %}
{% for tag in tags -%}
- **{{ tag.name }}**{% if tag.description %}: {{ tag.description }}{% endif %}
{% endfor %}
{% endif %}

{% if customProperties.length > 0 -%}
## Custom Properties to Extract
{% for prop in customProperties -%}
- **{{ prop.key }}** ({{ prop.label }}): {{ prop.description }}{% if prop.options %} — Options: {{ prop.options | map('label') | join(', ') }}{% endif %}
{% endfor %}
{% endif %}`,
  },
  userPrompt: {
    doc: 'The user prompt to send to the model. Uses Nunjucks template syntax with access to file, document, tags, customProperties, batch, pageCount, and ai context variables.',
    env: 'CONTENT_EXTRACTION_AI_USER_PROMPT',
    schema: v.string(),
    default: `Analyze the document image{{ ' (pages {{ batch.firstPageNumber }}-{{ batch.firstPageNumber + batch.pageCount - 1 }})' if batch.pageCount > 1 else '' }} and extract all content and metadata as described.

Document name: {{ document.name }}
File: {{ file.name }} ({{ file.mimeType }}, {{ file.size }} bytes)`,
  },
  metadataPrompt: {
    doc: "The system prompt for the document-wide metadata call, run only when a PDF is split into multiple chunks: the chunk responses' text is joined and re-sent (head-truncated if huge) to obtain final metadata, overriding the per-chunk metadata. Uses the same Nunjucks template syntax and context variables as the system prompt.",
    env: 'CONTENT_EXTRACTION_AI_METADATA_PROMPT',
    schema: v.string(),
    default: `You are a document analysis assistant processing documents for an archival facility. You are given the text extracted from a multi-page document. Derive structured metadata for the document as a whole.

## Rules

1. **Do not invent**:
   Only use information that is present in the extracted text.
   If a field cannot be determined, omit it or use null.
2. **Title**:
   Derive a concise, descriptive title for the document as a whole (e.g., document type, recipient, sender, subject line).
   Do not use the filename.
3. **Date**:
   Extract the most relevant document date (invoice date, issue date, etc.), not the scan/print date. Format as YYYY-MM-DD.
4. **Tags**: Use the tag list below. Pick up to {{ ai.maxTags }} tags that best describe this document.
   - For **existing tags**, return just the tag name as a plain string
{% if ai.canCreateNewTags -%}
   - You may suggest new tags when the document's category doesn't match any existing tag. Always provide a \`name\` in Title Case and a brief \`description\` explaining when to use it.
{% endif -%}
{%- if customProperties.length > 0 -%}
5. **Custom properties**: Populate the fields below using values present in the extracted text. Only set a field if you can confidently extract its value.
{%- endif %}

## Available Tags
{% if tags.length == 0 %}
No existing tags.
{% else %}
{% for tag in tags -%}
- **{{ tag.name }}**{% if tag.description %}: {{ tag.description }}{% endif %}
{% endfor %}
{% endif %}

{% if customProperties.length > 0 -%}
## Custom Properties to Extract
{% for prop in customProperties -%}
- **{{ prop.key }}** ({{ prop.label }}): {{ prop.description }}{% if prop.options %} — Options: {{ prop.options | map('label') | join(', ') }}{% endif %}
{% endfor %}
{% endif %}`,
  },
  temperature: {
    doc: 'The temperature to use for the model. Lower values produce more deterministic results.',
    env: 'CONTENT_EXTRACTION_AI_TEMPERATURE',
    schema: v.pipe(v.number(), v.minValue(0), v.maxValue(2)),
    default: 0,
  },
  maxTokens: {
    doc: 'The maximum number of tokens to generate in the response. When not set (the default), the option is not sent and the model/server decides its own maximum. Set it explicitly only to constrain costs or when your endpoint defaults to a very small completion size (e.g. vLLM).',
    env: 'CONTENT_EXTRACTION_AI_MAX_TOKENS',
    schema: v.optional(coercedStrictlyPositiveIntegerSchema),
    default: undefined,
  },
  mimeTypesAllowList: {
    doc: 'The list of mime types that the AI content extraction strategy will be used for. If the document mime type is not in this list, the strategy will be skipped. Comma separated list. Supports wildcards, e.g. "image/*" matches all image mime types, and "*" matches all formats. Prefix an entry with "!" to negate it, e.g. "*,!image/png" allows everything except PNG.',
    env: 'CONTENT_EXTRACTION_AI_MIME_TYPES_ALLOW_LIST',
    schema: v.pipe(
      v.string(),
      v.transform(
        (value) =>
          new Set(
            value
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          ),
      ),
    ),
    default: 'application/pdf,image/*',
  },
  timeoutMs: {
    doc: 'The timeout in milliseconds for requests to the AI model API.',
    env: 'CONTENT_EXTRACTION_AI_TIMEOUT_MS',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 10 * IN_MS.MINUTE,
  },
  renderImageFormat: {
    doc: 'Image format used to rasterize PDF pages before sending them to the model. JPEG (the default) is far smaller than PNG for scanned and rendered pages, which cuts request size and vision tokens; switch to "png" for lossless rendering.',
    env: 'CONTENT_EXTRACTION_AI_RENDER_IMAGE_FORMAT',
    schema: v.picklist(['jpeg', 'png']),
    default: 'jpeg',
  },
  renderMaxLongEdge: {
    doc: 'Maximum long edge in pixels for each rasterized PDF page. Small pages are never upscaled; larger pages are scaled down, which saves tokens when the model downsamples bigger images anyway. Leave unset (the default) to resolve it automatically: explicit value > known model family (Claude 1568, GPT-4/o-series 2048, Gemma 3 768, Qwen-VL 1600) > fallback 1600. Set 0 to disable the clamp entirely (the baseline 2x render scale still applies).',
    env: 'CONTENT_EXTRACTION_AI_RENDER_MAX_LONG_EDGE',
    schema: v.optional(coercedPositiveIntegerSchema),
    default: undefined,
  },
  renderMaxPixels: {
    doc: 'Maximum total pixel count for each rasterized PDF page. A backstop for pages with an extreme MediaBox (e.g. long plots) whose long edge alone does not capture how big the raster would be. Leave unset (the default) for the 2,000,000 px fallback; set 0 to disable.',
    env: 'CONTENT_EXTRACTION_AI_RENDER_MAX_PIXELS',
    schema: v.optional(coercedPositiveIntegerSchema),
    default: undefined,
  },
  renderTimeoutMs: {
    doc: 'Deadline in milliseconds for a single PDF render task (one page range on a worker thread). A hung pdf.js page then fails the extraction instead of hanging it forever, and the document falls through to the next strategy. The default is generous; lower it on responsive endpoints to fail fast.',
    env: 'CONTENT_EXTRACTION_AI_RENDER_TIMEOUT_MS',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 5 * IN_MS.MINUTE,
  },
  pagesPerBatch: {
    doc: 'Number of PDF pages rendered and sent to the model per request. Lower values shrink each request and limit which pages a truncated response can affect; higher values reduce the request count and per-request prompt overhead for large PDFs. Applies to PDFs only; images are always a single request.',
    env: 'CONTENT_EXTRACTION_AI_PAGES_PER_BATCH',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 5,
  },
  maxImageBytes: {
    doc: 'Maximum request payload size in bytes for documents sent to the model as a single payload (images). Images travel base64-encoded, so the raw file size is estimated at 1.37x before being checked; files whose estimated payload exceeds this limit are skipped and fall through to the next strategy. PDFs are unaffected: they are always rendered in chunks (see pagesPerBatch) at clamped resolution.',
    env: 'CONTENT_EXTRACTION_AI_MAX_IMAGE_BYTES',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 40 * IN_BYTES.MEGABYTE,
  },
  batchConcurrency: {
    doc: 'Number of page-chunks to send to the model in parallel when a PDF is split into multiple chunks (see pagesPerBatch). Set to 1 to process chunks one at a time. Higher values speed up large PDFs proportionally but increase load on the model endpoint and may hit provider rate limits.',
    env: 'CONTENT_EXTRACTION_AI_BATCH_CONCURRENCY',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 1,
  },
  maxPages: {
    doc: 'Maximum number of pages the AI strategy will accept for a single PDF. PDFs with more pages are skipped by the strategy and fall through to the next one in the list (e.g. "internal"). Set to 0 (the default) for no limit. Rendered pages are held in memory per chunk rather than per document, so this is a policy guard rather than the memory bound.',
    env: 'CONTENT_EXTRACTION_AI_MAX_PAGES',
    schema: coercedPositiveIntegerSchema,
    default: 0,
  },
  allowNewTags: {
    doc: 'Whether the AI model is allowed to create new tags during extraction. When false, the model can only use existing tags from the organization.',
    env: 'CONTENT_EXTRACTION_AI_ALLOW_NEW_TAGS',
    schema: v.boolean(),
    default: false,
  },
  maxTags: {
    doc: 'The maximum number of tags the AI model can assign to a document during extraction.',
    env: 'CONTENT_EXTRACTION_AI_MAX_TAGS',
    schema: coercedStrictlyPositiveIntegerSchema,
    default: 5,
  },
} as const satisfies AppConfigDefinition;
