import { createErrorFactory } from '../../shared/errors/errors';

export const createNoStrategyAbleToExtractTextError = createErrorFactory({
  code: 'content-extraction.noStrategyAbleToExtractText',
  message: 'No strategy was able to extract text from the document',
  statusCode: 500,
  isInternal: true,
});

export const createEmptyExtractedTextError = createErrorFactory({
  code: 'content-extraction.emptyExtractedText',
  message: 'The extraction strategy returned no text content for this document',
  statusCode: 500,
  isInternal: true,
});

export const createTooManyPagesForStrategyError = createErrorFactory({
  code: 'content-extraction.tooManyPages',
  message:
    'The document has more pages than the strategy page limit, it was skipped in favor of the next strategy',
  statusCode: 500,
  isInternal: true,
});
