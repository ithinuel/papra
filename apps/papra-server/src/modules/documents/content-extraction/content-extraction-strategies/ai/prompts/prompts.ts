import nunjucks from 'nunjucks';
import type { Template } from 'nunjucks';
import type { PromptContext } from './prompt-context.types';

// Configure nunjucks with a safe environment (no filesystem access).
// autoescape must stay off: these are plain-text LLM prompts, not HTML, and
// escaping would corrupt interpolated values (a document named "A & B" would
// render as "A &amp; B" in the prompt).
const env = nunjucks.configure({
  autoescape: false,
  throwOnUndefined: false,
});

// Register a custom `map` filter so templates like `{{ tags | map('name') | join(', ') }}` work
env.addFilter('map', (collection: unknown[], key: string) => {
  if (!Array.isArray(collection)) {
    return collection;
  }
  return collection
    .map((item) => {
      if (item && typeof item === 'object' && key in item) {
        return (item as Record<string, unknown>)[key];
      }
      return undefined;
    })
    .filter((v) => v !== undefined);
});

// Cache for compiled templates to avoid recompiling on every render
const compiledTemplateCache = new Map<string, Template>();

/**
 * Compiles a Nunjucks template string and caches the result.
 */
export function compilePrompt(template: string): Template {
  const cached = compiledTemplateCache.get(template);
  if (cached) {
    return cached;
  }

  const compiled = nunjucks.compile(template, env);
  compiledTemplateCache.set(template, compiled);
  return compiled;
}

/**
 * Renders a compiled Nunjucks template with the given context.
 */
export function renderPrompt(compiled: Template, context: Record<string, unknown>): string {
  return compiled.render(context).toString();
}

/**
 * Renders both system and user prompts from the config with the given context.
 */
export function renderPrompts(
  systemPrompt: string,
  userPrompt: string,
  context: PromptContext,
): {
  systemPrompt: string;
  userPrompt: string;
} {
  const compiledSystem = compilePrompt(systemPrompt);
  const compiledUser = compilePrompt(userPrompt);

  return {
    systemPrompt: renderPrompt(compiledSystem, context),
    userPrompt: renderPrompt(compiledUser, context),
  };
}

/**
 * Validates templates at server start by rendering them with a minimal context
 * object. Throws on failure.
 */
export function validatePromptTemplates(
  systemPrompt: string,
  userPrompt: string,
  metadataPrompt?: string,
): void {
  const minimalContext: Partial<PromptContext> = {
    file: {
      name: 'test-file.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    },
    document: {
      id: 'test-doc-id',
      name: 'Test Document',
    },
    tags: [
      { name: 'invoice', slug: 'invoice', color: '#5B8DEF', description: 'Invoice documents' },
    ],
    customProperties: [
      {
        key: 'amount',
        label: 'Amount',
        description: 'The monetary amount',
        type: 'number',
        options: [],
      },
    ],
    pageCount: 1,
    batch: {
      pageCount: 1,
      firstPageNumber: 1,
    },
    ai: {
      canCreateNewTags: true,
      maxTags: 5,
    },
  };

  // Try rendering both templates — if either throws, the template is invalid
  try {
    renderPrompt(compilePrompt(systemPrompt), minimalContext);
  } catch (error) {
    throw new Error(
      `Invalid AI content extraction system prompt template: ${(error as Error).message}`,
      { cause: error },
    );
  }

  try {
    renderPrompt(compilePrompt(userPrompt), minimalContext);
  } catch (error) {
    throw new Error(
      `Invalid AI content extraction user prompt template: ${(error as Error).message}`,
      { cause: error },
    );
  }

  if (metadataPrompt !== undefined) {
    try {
      renderPrompt(compilePrompt(metadataPrompt), minimalContext);
    } catch (error) {
      throw new Error(
        `Invalid AI content extraction metadata prompt template: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}
