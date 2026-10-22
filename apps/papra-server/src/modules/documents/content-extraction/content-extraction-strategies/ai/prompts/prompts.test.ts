import { describe, expect, it } from 'vitest';
import { compilePrompt, renderPrompt, renderPrompts, validatePromptTemplates } from './prompts';
import type { PromptContext } from './prompt-context.types';

const defaultContext: PromptContext = {
  file: {
    name: 'invoice-2024.pdf',
    mimeType: 'application/pdf',
    size: 123456,
  },
  document: {
    id: 'doc-123',
    name: 'Invoice 2024',
  },
  tags: [
    { name: 'invoice', slug: 'invoice', color: '#5B8DEF', description: 'Invoice documents' },
    { name: 'paid', slug: 'paid', color: '#4CAF50', description: 'Paid documents' },
  ],
  customProperties: [
    {
      key: 'amount',
      label: 'Amount',
      description: 'The monetary amount',
      type: 'number',
      options: [],
    },
    {
      key: 'currency',
      label: 'Currency',
      description: 'Currency code',
      type: 'select',
      options: [
        { label: 'USD', value: 'USD' },
        { label: 'EUR', value: 'EUR' },
      ],
    },
  ],
  pageCount: 3,
  batch: {
    pageCount: 2,
    firstPageNumber: 1,
  },
  ai: {
    canCreateNewTags: true,
    maxTags: 5,
  },
};

describe('ai.content-extraction.prompts', () => {
  describe('compilePrompt', () => {
    it('should compile a template string', () => {
      const template = compilePrompt('Hello {{ file.name }}');
      expect(template).toBeDefined();
    });

    it('should cache compiled templates', () => {
      const template1 = compilePrompt('Hello {{ file.name }}');
      const template2 = compilePrompt('Hello {{ file.name }}');
      expect(template1).toBe(template2);
    });
  });

  describe('renderPrompt', () => {
    it('should render a template with context', () => {
      const compiled = compilePrompt('Hello {{ file.name }}');
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Hello invoice-2024.pdf');
    });

    it('should handle nested properties', () => {
      const compiled = compilePrompt('{{ document.id }}: {{ document.name }}');
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('doc-123: Invoice 2024');
    });

    it('should handle the map filter', () => {
      const compiled = compilePrompt('{{ tags | map("name") | join(", ") }}');
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('invoice, paid');
    });

    it('should handle conditionals', () => {
      const compiled = compilePrompt(
        'Pages: {% if pageCount > 1 %}{{ pageCount }}{% else %}1{% endif %}',
      );
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Pages: 3');
    });

    it('should handle arithmetic', () => {
      const compiled = compilePrompt(
        'Pages {{ batch.firstPageNumber }}-{{ batch.firstPageNumber + batch.pageCount - 1 }}',
      );
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Pages 1-2');
    });

    it('should handle empty context for optional variables', () => {
      const compiled = compilePrompt('Hello {{ file.name | default("unknown") }}');
      const result = renderPrompt(compiled, {});
      expect(result).toBe('Hello unknown');
    });

    it('should not html-escape interpolated values (plain-text prompts)', () => {
      const compiled = compilePrompt('{{ document.name }} / {{ file.name }}');
      const result = renderPrompt(compiled, {
        ...defaultContext,
        document: { id: 'doc-1', name: 'Tom & Jerry <invoice> "2024"' },
        file: { name: "bill's-o'reilly.pdf", mimeType: 'application/pdf', size: 1 },
      });
      expect(result).toBe('Tom & Jerry <invoice> "2024" / bill\'s-o\'reilly.pdf');
    });
  });

  describe('renderPrompts', () => {
    it('should render both system and user prompts', () => {
      const result = renderPrompts(
        'System: {{ file.name }}',
        'User: {{ document.name }}',
        defaultContext,
      );
      expect(result.systemPrompt).toBe('System: invoice-2024.pdf');
      expect(result.userPrompt).toBe('User: Invoice 2024');
    });
  });

  describe('validatePromptTemplates', () => {
    it('should not throw for valid templates', () => {
      expect(() => validatePromptTemplates('Hello {{ file.name }}', 'World')).not.toThrow();
    });

    it('should throw for invalid template syntax', () => {
      expect(() => validatePromptTemplates('Hello {{ file.name', 'World')).toThrow(
        /Invalid AI content extraction system prompt template/,
      );
    });

    it('should throw for user prompt with invalid syntax', () => {
      expect(() => validatePromptTemplates('Hello', 'World {{ unclosed')).toThrow(
        /Invalid AI content extraction user prompt template/,
      );
    });

    it('should work with complex nunjucks syntax', () => {
      expect(() =>
        validatePromptTemplates(
          'You are a document assistant. Extract from {{ file.name }}.\n{% if pageCount > 1 %}{{ pageCount }} pages.{% else %}1 page.{% endif %}',
          'Analyze the document and return metadata.',
        ),
      ).not.toThrow();
    });
  });

  describe('context variables', () => {
    it('should render file metadata', () => {
      const compiled = compilePrompt(
        'Name: {{ file.name }}, Type: {{ file.mimeType }}, Size: {{ file.size }}',
      );
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Name: invoice-2024.pdf, Type: application/pdf, Size: 123456');
    });

    it('should render tags with map filter', () => {
      const compiled = compilePrompt('{{ tags | map("name") | join(", ") }}');
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('invoice, paid');
    });

    it('should render custom properties with map filter', () => {
      const compiled = compilePrompt('{{ customProperties | map("label") | join(", ") }}');
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Amount, Currency');
    });

    it('should render batch info', () => {
      const compiled = compilePrompt(
        'Batch: pages {{ batch.firstPageNumber }}-{{ batch.firstPageNumber + batch.pageCount - 1 }} ({{ batch.pageCount }} pages)',
      );
      const result = renderPrompt(compiled, defaultContext);
      expect(result).toBe('Batch: pages 1-2 (2 pages)');
    });
  });
});
