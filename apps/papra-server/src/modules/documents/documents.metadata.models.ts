import type { TagInput } from './content-extraction/content-extraction-strategies/content-extraction-strategies.types';
import type { CustomPropertyType } from '../custom-properties/custom-properties.constants';
import { CUSTOM_PROPERTY_TYPES } from '../custom-properties/custom-properties.constants';
import { normalizeTagName } from '../tags/tags.repository.models';
import { isNilOrEmptyString } from '../shared/utils';

/**
 * A tag-matched action set derived from AI-extracted tag suggestions, in the
 * same shape the shared tags usecase consumes: ids of existing tags to attach
 * and names of tags that still need to be created.
 */
export type ExtractionTagActions = {
  tagIdsToAdd: string[];
  tagsToCreate: { name: string; description?: string | null }[];
};

/**
 * Resolves tag suggestions returned by a model against the organization's
 * existing tags:
 * - the suggestion list is capped at `maxTags`
 * - suggestions are matched by normalized name (same normalization the tag
 *   table stores) and deduplicated
 * - unknown tags are only created when `allowNewTags` is set; otherwise they
 *   are skipped
 */
export function buildExtractionTagActions({
  tags,
  existingTags,
  allowNewTags,
  maxTags,
}: {
  tags: TagInput[];
  existingTags: { id: string; name: string }[];
  allowNewTags: boolean;
  maxTags: number;
}): ExtractionTagActions {
  const limitedTags = tags.slice(0, maxTags);

  const existingByNormalized = new Map(
    existingTags.map((tag) => [normalizeTagName({ name: tag.name }), tag]),
  );

  const tagIdsToAdd: string[] = [];
  const tagsToCreate: { name: string; description?: string | null }[] = [];
  const seen = new Set<string>();

  for (const tagInput of limitedTags) {
    const name = typeof tagInput === 'string' ? tagInput : tagInput.name;
    // Whitespace-only names would create unusable tags.
    if (isNilOrEmptyString(name?.trim())) {
      continue;
    }

    const normalized = normalizeTagName({ name });
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const existing = existingByNormalized.get(normalized);
    if (existing) {
      tagIdsToAdd.push(existing.id);
      continue;
    }

    // Only create new tags when the AI is allowed to; otherwise skip unknowns.
    if (allowNewTags) {
      tagsToCreate.push({
        name,
        description: typeof tagInput === 'object' ? (tagInput.description ?? null) : null,
      });
    }
  }

  return { tagIdsToAdd, tagsToCreate };
}

export type ParsedCustomPropertyValue = string | number | boolean;

/**
 * Converts a model-extracted string value into the plain input shape accepted
 * by the matching custom-property type definition (the same value the API
 * route feeds to the setDocumentCustomPropertyValue usecase, which owns input
 * validation and the db conversion):
 * - number: parsed float
 * - date: the original string, kept only if parseable as a date (the type's
 *   input schema converts it with v.toDate())
 * - boolean: true/false from common truthy/falsy words
 * - select: the id of the option matched by name or key (case-insensitive)
 * - text (and default): the value as-is
 *
 * Returns `null` when the value cannot be parsed or the property type is not
 * supported by extraction (multi_select, user_relation, document_relation:
 * the model returns a single string value).
 */
export function parseValueForPropertyType(
  value: string,
  property: {
    type: CustomPropertyType;
    options: Array<{ id: string; name: string; key: string }>;
  },
): ParsedCustomPropertyValue | null {
  switch (property.type) {
    case CUSTOM_PROPERTY_TYPES.NUMBER: {
      const num = Number.parseFloat(value);
      return isNaN(num) ? null : num;
    }
    case CUSTOM_PROPERTY_TYPES.DATE: {
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : value;
    }
    case CUSTOM_PROPERTY_TYPES.BOOLEAN: {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'false' || lower === 'no' || lower === '0') return false;
      return null;
    }
    case CUSTOM_PROPERTY_TYPES.SELECT: {
      // Match value to an option by name or key (case-insensitive); the value
      // the usecase expects is the option id.
      const option = property.options.find(
        (o) =>
          o.name.toLowerCase() === value.toLowerCase() ||
          o.key.toLowerCase() === value.toLowerCase(),
      );
      return option?.id ?? null;
    }
    // multi_select, user_relation and document_relation are not supported by
    // extraction (the model returns a single string value).
    case CUSTOM_PROPERTY_TYPES.MULTI_SELECT:
    case CUSTOM_PROPERTY_TYPES.USER_RELATION:
    case CUSTOM_PROPERTY_TYPES.DOCUMENT_RELATION:
      return null;
    case CUSTOM_PROPERTY_TYPES.TEXT:
    default:
      return value;
  }
}
