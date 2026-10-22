import { createPrefixedIdRegex } from '../shared/random/ids.constants.models';

export const TagColorRegex = /^#[0-9A-F]{6}$/;

// Color used for tags created by AI features (auto-tagging, AI content
// extraction), so they are visually distinguishable from user-created tags.
export const AI_CREATED_TAG_COLOR = '#CCCCCC';

export const tagIdPrefix = 'tag';
export const tagIdRegex = createPrefixedIdRegex({ prefix: tagIdPrefix });
