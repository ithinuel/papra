import type { Config } from '../../../config/config.types';
import type { Logger } from '../../../shared/logger/logger';
import type { ChatDependencies } from '../../../ai/ai.chat.usecases';
import type { Document } from '../../documents.types';
import type { Tag } from '../../../tags/tags.types';
import type { CustomPropertyDefinition } from '../../../custom-properties/custom-properties.types';

export type TagInput = string | { name: string; description?: string | null };

/**
 * A custom property definition as returned by
 * `getOrganizationPropertyDefinitions`, which attaches its options.
 */
export type CustomPropertyDefinitionWithOptions = CustomPropertyDefinition & {
  options: Array<{ id: string; name: string; key: string }>;
};

/**
 * Everything a strategy may need about the document beyond the file itself:
 * the document record, the organization's tags, and its custom-property
 * definitions. Resolved once per document by the extraction task and consumed
 * by strategies that support metadata extraction (currently only `ai`).
 */
export type ContentExtractionRunContext = {
  document: Document;
  tags: Tag[];
  customProperties: CustomPropertyDefinitionWithOptions[];
};

/**
 * Structured metadata a strategy can extract alongside the document text.
 * This is the single canonical shape: strategies, the extraction usecase, and
 * the AI schema all reference it (fields with no value are `null`).
 */
export type ExtractedDocumentMetadata = {
  title: string | null;
  tags: TagInput[];
  date: string | null;
  fields: Record<string, string>;
};

export type ContentExtractionStrategy = {
  canExtractTextFromDocument: (args: { file: File }) => Promise<boolean>;
  extractTextFromDocument: (args: {
    file: File;
    ocrLanguages?: string[];
    runContext?: ContentExtractionRunContext;
    logger?: Logger;
  }) => Promise<{
    text: string;
    extractionContext?: Record<string, unknown>;
    metadata?: ExtractedDocumentMetadata;
  }>;
};

export type ContentExtractionStrategyFactory = (args: {
  config: Config;
  chatDeps: ChatDependencies;
}) => ContentExtractionStrategy;
