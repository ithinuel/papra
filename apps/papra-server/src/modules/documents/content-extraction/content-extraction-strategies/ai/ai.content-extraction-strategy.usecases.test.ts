import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractTextWithAiContentExtraction,
  METADATA_INPUT_MAX_CHARS,
  METADATA_INPUT_TRUNCATION_MARKER,
} from './ai.content-extraction-strategy.usecases';
import type { ChatDependencies } from '../../../../ai/ai.chat.usecases';
import type { PdfRenderPolicy } from './ai.content-extraction-strategy.types';
import type { PromptContext } from './prompts/prompt-context.types';
import { createLogger } from '../../../../shared/logger/logger';

// The pipeline tests assert *which* chat calls the orchestration makes and
// with what inputs, so the model boundary is fully mocked. (vi.mock is hoisted
// above the imports by vitest.)
const generateChatMock = vi.fn();

vi.mock('../../../../ai/ai.chat.usecases', () => ({
  generateChat: (args: Record<string, unknown>) => generateChatMock(args),
}));

const twoPagePdf = Buffer.from(`%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
4 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 5
0000000000 65535 f
0000000009 0000000 n
0000000042 0000000 n
0000000085 0000000 n
0000000128 0000000 n
trailer<</Size 5/Root 1 0 R>>
startxref
190
%%EOF`);

const renderPolicy: PdfRenderPolicy = {
  maxLongEdge: 1600,
  maxPixels: 2_000_000,
  imageFormat: 'jpeg',
  jpegQuality: 87,
  renderTimeoutMs: 60_000,
};

function buildPromptContext(): PromptContext {
  return {
    file: { name: 'two-page.pdf', mimeType: 'application/pdf', size: twoPagePdf.length },
    document: { id: 'doc-1', name: 'Two page document' },
    tags: [],
    customProperties: [],
    pageCount: 1,
    batch: { pageCount: 1, firstPageNumber: 1 },
    ai: { canCreateNewTags: false, maxTags: 5 },
  };
}

type ChatCall = {
  systemPrompt: string;
  // Chunk calls carry multimodal content parts; the reconciling call sends
  // the joined transcription as a plain string.
  userContent: string | Array<{ type: string; content?: string; source?: { value: string } }>;
};

function chatCalls(): ChatCall[] {
  return generateChatMock.mock.calls.map((call) => {
    const args = call[0] as {
      systemPrompt: string;
      messages: Array<{ content: ChatCall['userContent'] }>;
    };
    return { systemPrompt: args.systemPrompt, userContent: args.messages[0]!.content };
  });
}

function userTextOf(content: ChatCall['userContent']): string {
  if (typeof content === 'string') {
    return content;
  }
  const textPart = content.find((part) => part.type === 'text');
  return textPart?.content ?? '';
}

function chunkResponse(index: number) {
  return {
    title: `Chunk title ${index}`,
    date: null,
    text: `Chunk text ${index}`,
    tags: [],
    fields: {},
  };
}

const reconciledResponse = {
  title: 'Reconciled title',
  date: '2024-01-01',
  tags: ['finance'],
  fields: { vendor: 'ACME' },
};

/** Default model behavior: chunk calls answer in order, the reconciling call
 * (plain-string user content) returns document-wide metadata. */
function mockChunkAndReconcile() {
  let chunkIndex = 0;
  generateChatMock.mockImplementation(async (args: { messages: Array<{ content: unknown }> }) => {
    if (typeof args.messages[0]?.content === 'string') {
      return reconciledResponse;
    }
    return chunkResponse(chunkIndex++);
  });
}

async function extract({
  file = new File([twoPagePdf], 'two-page.pdf', { type: 'application/pdf' }),
  ...overrides
}: {
  file?: File;
  pagesPerBatch?: number;
  systemPrompt?: string;
  userPrompt?: string;
} = {}) {
  return extractTextWithAiContentExtraction({
    file,
    modelId: 'openai://gpt-test',
    systemPrompt: overrides.systemPrompt ?? 'system prompt',
    userPrompt: overrides.userPrompt ?? 'user prompt',
    metadataPrompt: 'metadata system prompt',
    temperature: 0,
    maxTokens: undefined,
    timeoutMs: 1_000,
    pagesPerBatch: overrides.pagesPerBatch ?? 5,
    batchConcurrency: 1,
    maxPages: 0,
    renderPolicy,
    documentContext: buildPromptContext(),
    organizationId: 'organization-1',
    logger: createLogger({ namespace: 'test' }),
    ...({} as unknown as ChatDependencies),
  });
}

describe('ai content extraction pipeline (combined chunks + reconciliation)', () => {
  beforeEach(() => {
    generateChatMock.mockReset();
  });

  it('single-chunk PDF: one combined call, its metadata is final', async () => {
    mockChunkAndReconcile();

    const result = await extract({ pagesPerBatch: 5 });

    expect(generateChatMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Chunk text 0');
    expect(result.metadata?.title).toBe('Chunk title 0');
  });

  it('non-PDF image: one combined call, its metadata is final', async () => {
    mockChunkAndReconcile();

    const file = new File([Buffer.from('fake-png-bytes')], 'scan.png', { type: 'image/png' });
    const result = await extract({ file });

    expect(generateChatMock).toHaveBeenCalledTimes(1);
    expect(result.metadata?.title).toBe('Chunk title 0');
  });

  it('normalizes free-form fields payloads into the canonical string map', async () => {
    // The mock bypasses schema validation, so this exercises the code-side
    // backstop: strings kept, scalars stringified, null/empty/nested dropped.
    generateChatMock.mockImplementation(async () => ({
      title: 'Invoice ACME',
      date: null,
      text: 'body',
      tags: [],
      fields: {
        vendor: 'ACME',
        amount: 120.5,
        paid: true,
        missing: null,
        nested: { a: 1 },
        list: [1, 2],
        blank: '',
      },
    }));

    const result = await extract({ pagesPerBatch: 5 });

    expect(result.metadata?.fields).to.eql({ vendor: 'ACME', amount: '120.5', paid: 'true' });
  });

  it('multi-chunk PDF: per-chunk combined calls plus one reconciling metadata-only call', async () => {
    mockChunkAndReconcile();

    const result = await extract({ pagesPerBatch: 1 });

    const calls = chatCalls();
    // 2 chunk calls + 1 reconcile call
    expect(calls).toHaveLength(3);
    expect(typeof calls[0]?.userContent).not.toBe('string');
    expect(typeof calls[1]?.userContent).not.toBe('string');
    expect(typeof calls[2]?.userContent).toBe('string');

    // Text is joined in page order
    expect(result.text).toBe('Chunk text 0\n\nChunk text 1');

    // The reconciled metadata wins over the per-chunk metadata
    expect(result.metadata?.title).toBe('Reconciled title');
    expect(result.metadata?.date).toBe('2024-01-01');
  });

  it('the reconciling call receives the joined transcription', async () => {
    mockChunkAndReconcile();

    await extract({ pagesPerBatch: 1 });

    const reconcile = chatCalls().find((call) => typeof call.userContent === 'string');
    expect(reconcile?.userContent).toContain('Chunk text 0');
    expect(reconcile?.userContent).toContain('Chunk text 1');
    // No catalogue leakage: the reconcile call uses the metadata prompt
    expect(reconcile?.systemPrompt).toBe('metadata system prompt');
  });

  it('a failing reconciling call degrades to no metadata, text survives', async () => {
    let chunkIndex = 0;
    generateChatMock.mockImplementation(async (args: { messages: Array<{ content: unknown }> }) => {
      if (typeof args.messages[0]?.content === 'string') {
        throw new Error('metadata call exploded');
      }
      return chunkResponse(chunkIndex++);
    });

    const result = await extract({ pagesPerBatch: 1 });

    expect(result.text).toBe('Chunk text 0\n\nChunk text 1');
    expect(result.metadata).toBeUndefined();
  });

  it('head-truncates an oversized joined transcription for the reconciling call', async () => {
    generateChatMock.mockImplementation(async (args: { messages: Array<{ content: unknown }> }) => {
      if (typeof args.messages[0]?.content === 'string') {
        return reconciledResponse;
      }
      // Each chunk contributes a large slab so the join busts the budget
      return { ...chunkResponse(0), text: 'x'.repeat(METADATA_INPUT_MAX_CHARS) };
    });

    await extract({ pagesPerBatch: 1 });

    const reconcile = chatCalls().find((call) => typeof call.userContent === 'string');
    const content = reconcile?.userContent as string;

    expect(content).toContain(METADATA_INPUT_TRUNCATION_MARKER);
    // The head of the first chunk's text is kept
    expect(content).toContain('x'.repeat(METADATA_INPUT_MAX_CHARS));
    // And the input is capped: budget + marker, not the full join (~120k)
    expect(content.length).toBeLessThan(METADATA_INPUT_MAX_CHARS * 2);
  });

  it('renders chunk prompts once with the real batch context', async () => {
    mockChunkAndReconcile();

    await extract({
      pagesPerBatch: 1,
      userPrompt:
        'pages {{ batch.firstPageNumber }}-{{ batch.firstPageNumber + batch.pageCount - 1 }} of {{ pageCount }}',
    });

    const chunkTexts = chatCalls()
      .filter((call) => typeof call.userContent !== 'string')
      .map((call) => userTextOf(call.userContent));

    // The document has 2 pages rendered one-per-chunk: each chunk sees its own
    // range but the document-wide page count (guards the double-render bug).
    expect(chunkTexts).to.eql(['pages 1-1 of 2', 'pages 2-2 of 2']);
  });
});
