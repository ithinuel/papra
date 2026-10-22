import { afterEach, describe, expect, it } from 'vitest';
import type { PdfPageReader } from './ai.content-extraction-strategy.models';
import {
  buildPdfPageReader,
  computeRenderScale,
  isAiContentExtractionAbleToExtractTextFromDocument,
  mapWithConcurrency,
  runWithDeadline,
} from './ai.content-extraction-strategy.models';
import type { PdfRenderPolicy } from './ai.content-extraction-strategy.types';
import { splitPageNumbersIntoChunks } from './ai.content-extraction-strategy.worker';
import {
  assertExtractedTextNotEmpty,
  extractTextWithAiContentExtraction,
  METADATA_INPUT_MAX_CHARS,
  METADATA_INPUT_TRUNCATION_MARKER,
  truncateMetadataInput,
} from './ai.content-extraction-strategy.usecases';
import type { ChatDependencies } from '../../../../ai/ai.chat.usecases';
import { createLogger } from '../../../../shared/logger/logger';
import { IN_BYTES } from '../../../../shared/units';

describe('ai.content-extraction-strategy', () => {
  let reader: PdfPageReader | null = null;

  const renderPolicy: PdfRenderPolicy = {
    maxLongEdge: 1600,
    maxPixels: 2_000_000,
    imageFormat: 'jpeg',
    jpegQuality: 87,
    renderTimeoutMs: 60_000,
  };

  afterEach(async () => {
    if (reader) {
      await reader.close();
      reader = null;
    }
  });

  describe('isAiContentExtractionAbleToExtractTextFromDocument', () => {
    const maxImageBytes = 40 * IN_BYTES.MEGABYTE;
    const mimeTypesAllowList = new Set(['application/pdf', 'image/*']);

    it('returns true for allowed mime types below size limit', () => {
      const file = { type: 'application/pdf', size: 1024 * 1024 }; // 1MB

      const result = isAiContentExtractionAbleToExtractTextFromDocument({
        file,
        mimeTypesAllowList,
        maxImageBytes,
      });
      expect(result).toBe(true);
    });

    it('returns false for disallowed mime types', () => {
      const file = { type: 'application/msword', size: 1024 * 1024 };

      const result = isAiContentExtractionAbleToExtractTextFromDocument({
        file,
        mimeTypesAllowList,
        maxImageBytes,
      });
      expect(result).toBe(false);
    });

    it('allows PDFs above the size limit since they are rendered in chunks', () => {
      const file = { type: 'application/pdf', size: 60 * IN_BYTES.MEGABYTE };

      const result = isAiContentExtractionAbleToExtractTextFromDocument({
        file,
        mimeTypesAllowList,
        maxImageBytes,
      });
      expect(result).toBe(true);
    });

    it('returns false for single-payload files (images) above the estimated base64 payload limit', () => {
      // 60MB of raw image inflates to ~82MB base64, well over the 40MB gate
      const file = { type: 'image/png', size: 60 * IN_BYTES.MEGABYTE };

      const result = isAiContentExtractionAbleToExtractTextFromDocument({
        file,
        mimeTypesAllowList,
        maxImageBytes,
      });
      expect(result).toBe(false);
    });

    it('accepts images whose base64 inflation still fits under the limit', () => {
      // 25MB raw -> 34.25MB base64 estimate, under the 40MB gate
      const allowed = { type: 'image/png', size: 25 * IN_BYTES.MEGABYTE };
      // 30MB raw -> 41.1MB base64 estimate, over it
      const rejected = { type: 'image/png', size: 30 * IN_BYTES.MEGABYTE };

      expect(
        isAiContentExtractionAbleToExtractTextFromDocument({
          file: allowed,
          mimeTypesAllowList,
          maxImageBytes,
        }),
      ).toBe(true);
      expect(
        isAiContentExtractionAbleToExtractTextFromDocument({
          file: rejected,
          mimeTypesAllowList,
          maxImageBytes,
        }),
      ).toBe(false);
    });
  });

  describe('computeRenderScale', () => {
    it('keeps the base scale for pages under both caps', () => {
      // Letter portrait at the base 2x: 1224x1584 -> 1584 <= 1600 and 1.94MP <= 2MP
      expect(
        computeRenderScale({
          nativeWidth: 612,
          nativeHeight: 792,
          maxLongEdge: 1600,
          maxPixels: 2_000_000,
        }),
      ).toBe(2);
    });

    it('clamps the long edge when the base scale would exceed it', () => {
      // A4 portrait at 2x would render a 1684px long edge
      const scale = computeRenderScale({
        nativeWidth: 595,
        nativeHeight: 842,
        maxLongEdge: 1600,
        maxPixels: 2_000_000,
      });

      expect(scale).toBeCloseTo(1600 / 842, 6);
    });

    it('never scales above the base, even when the caps allow more', () => {
      expect(
        computeRenderScale({
          nativeWidth: 100,
          nativeHeight: 100,
          maxLongEdge: 4000,
          maxPixels: 10_000_000,
        }),
      ).toBe(2);
    });

    it('applies the pixel-area cap when the long-edge clamp still exceeds it', () => {
      // 3000x3000 at the long-edge scale would still be 1600x1600 = 2.56MP
      const scale = computeRenderScale({
        nativeWidth: 3000,
        nativeHeight: 3000,
        maxLongEdge: 1600,
        maxPixels: 2_000_000,
      });

      expect(scale).toBeCloseTo(Math.sqrt(2_000_000 / 9_000_000), 6);
      expect(scale * 3000 * (scale * 3000)).toBeLessThanOrEqual(2_000_000 + 1);
    });

    it('treats a zero cap as disabled', () => {
      expect(
        computeRenderScale({ nativeWidth: 5000, nativeHeight: 5000, maxLongEdge: 0, maxPixels: 0 }),
      ).toBe(2);
    });

    it('tolerates zero-valued native dimensions', () => {
      expect(
        computeRenderScale({
          nativeWidth: 0,
          nativeHeight: 0,
          maxLongEdge: 1600,
          maxPixels: 2_000_000,
        }),
      ).toBe(2);
    });
  });

  describe('runWithDeadline', () => {
    it('resolves with the operation result when it finishes in time', async () => {
      const result = await runWithDeadline({
        timeoutMs: 1_000,
        onTimeout: () => new Error('too slow'),
        run: async () => 'done',
      });

      expect(result).toBe('done');
    });

    it('rejects with the timeout error and aborts the signal when it does not', async () => {
      let seenSignal: AbortSignal | undefined;

      await expect(
        runWithDeadline({
          timeoutMs: 10,
          onTimeout: () => new Error('render deadline exceeded'),
          run: async ({ signal }) => {
            seenSignal = signal;
            // Never settles, like a pdf.js page that hangs mid-render.
            return new Promise<string>(() => {});
          },
        }),
      ).rejects.toThrowError('render deadline exceeded');

      expect(seenSignal?.aborted).toBe(true);
    });

    it('propagates operation errors before the deadline', async () => {
      await expect(
        runWithDeadline({
          timeoutMs: 1_000,
          onTimeout: () => new Error('too slow'),
          run: async () => {
            throw new Error('worker boom');
          },
        }),
      ).rejects.toThrowError('worker boom');
    });
  });

  describe('mapWithConcurrency', () => {
    function createDeferred() {
      return Promise.withResolvers<void>();
    }

    async function tick() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('caps the number of tasks in flight and preserves input order', async () => {
      const gate0 = createDeferred();
      const gate1 = createDeferred();
      const gate2 = createDeferred();
      const gates = [gate0, gate1, gate2];
      let inFlight = 0;
      let maxInFlight = 0;

      const mapped = mapWithConcurrency({
        items: [0, 1, 2],
        concurrency: 2,
        mapFn: async (index) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gates[index]?.promise;
          inFlight -= 1;
          return index;
        },
      });

      await tick();
      // Exactly two tasks started; the third waits for a free slot
      expect(maxInFlight).toBe(2);

      // Complete tasks out of order (0, then 2, then 1)
      gate0.resolve();
      await tick();
      gate2.resolve();
      await tick();
      expect(maxInFlight).toBe(2);
      gate1.resolve();

      expect(await mapped).to.eql([0, 1, 2]);
    });

    it('runs every task at once when concurrency exceeds the item count', async () => {
      const results = await mapWithConcurrency({
        items: [1, 2, 3],
        concurrency: 10,
        mapFn: async (item) => item * 2,
      });

      expect(results).to.eql([2, 4, 6]);
    });

    it('resolves an empty list without invoking the mapper', async () => {
      let calls = 0;

      const results = await mapWithConcurrency({
        items: [],
        concurrency: 3,
        mapFn: async () => {
          calls += 1;
          return 1;
        },
      });

      expect(results).to.eql([]);
      expect(calls).toBe(0);
    });

    it('rejects when a task rejects', async () => {
      await expect(
        mapWithConcurrency({
          items: [1, 2, 3],
          concurrency: 2,
          mapFn: async (item) => {
            if (item === 2) {
              throw new Error('batch failed');
            }
            return item;
          },
        }),
      ).rejects.toThrowError('batch failed');
    });
  });

  describe('buildPdfPageReader', () => {
    // Create a minimal valid PDF (1 page)
    const pdfContent = Buffer.from(`%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 4
0000000000 65535 f
0000000009 0000000 n
0000000058 0000000 n
0000000115 0000000 n
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF`);

    const twoPagePdfContent = Buffer.from(`%PDF-1.0
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

    const twoPageFile = () =>
      new File([twoPagePdfContent], 'two-page.pdf', { type: 'application/pdf' });

    it('returns a reader with correct page count for a simple PDF', async () => {
      const file = new File([pdfContent], 'test.pdf', { type: 'application/pdf' });
      reader = await buildPdfPageReader({ file, pagesPerBatch: 5, renderPolicy });

      expect(reader.pageCount).toBe(1);
    });

    it('throws for invalid PDF content', async () => {
      const file = new File([Buffer.from('not a pdf')], 'test.pdf', { type: 'application/pdf' });

      await expect(buildPdfPageReader({ file, pagesPerBatch: 5, renderPolicy })).rejects.toThrow();
    });

    it('exposes one chunk job per pagesPerBatch pages, with first-page numbers', async () => {
      reader = await buildPdfPageReader({
        file: twoPageFile(),
        pagesPerBatch: 1,
        renderPolicy,
      });

      expect(reader.chunkJobs.map(({ firstPageNumber }) => firstPageNumber)).to.eql([1, 2]);

      const rendered = await Promise.all(reader.chunkJobs.map(async ({ render }) => render()));

      expect(rendered.map((pages) => pages.length)).to.eql([1, 1]);
    });

    it('renders the whole document in one job when pagesPerBatch covers it', async () => {
      reader = await buildPdfPageReader({
        file: twoPageFile(),
        pagesPerBatch: 5,
        renderPolicy,
      });

      expect(reader.chunkJobs.map(({ firstPageNumber }) => firstPageNumber)).to.eql([1]);

      const pages = await reader.chunkJobs[0]!.render();

      expect(pages).toHaveLength(2);
      for (const page of pages) {
        expect(page.mimeType).toBe('image/jpeg');
        expect(page.base64DataUrl).toMatch(/^data:image\/jpeg;base64,/);
      }
    });

    it('renders consecutive jobs without detaching the shared buffer', async () => {
      // Rendering several pool.run() calls off the same underlying ArrayBuffer
      // used to detach it after the first transfer, throwing DataCloneError on
      // the second chunk. Each job must still get an independent copy.
      reader = await buildPdfPageReader({
        file: twoPageFile(),
        pagesPerBatch: 1,
        renderPolicy,
      });

      for (const { render } of reader.chunkJobs) {
        const pages = await render();
        expect(pages).toHaveLength(1);
      }
    });

    it('renders png data urls when the policy requests png', async () => {
      reader = await buildPdfPageReader({
        file: twoPageFile(),
        pagesPerBatch: 5,
        renderPolicy: { ...renderPolicy, imageFormat: 'png' },
      });

      const pages = await reader.chunkJobs[0]!.render();

      expect(pages).toHaveLength(2);
      for (const page of pages) {
        expect(page.mimeType).toBe('image/png');
        expect(page.base64DataUrl).toMatch(/^data:image\/png;base64,/);
      }
    });
  });

  describe('extractTextWithAiContentExtraction page limit', () => {
    const twoPagePdf = Buffer.from(`%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
4 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj
xref
0 5
0000000000 65535 f
0000000009 65535 f
0000000042 65535 f
0000000085 65535 f
0000000128 65535 f
trailer<</Size 5/Root 1 0 R>>
startxref
190
%%EOF`);

    it('rejects PDFs over maxPages before rendering or calling the model', async () => {
      const file = new File([twoPagePdf], 'two-page.pdf', { type: 'application/pdf' });

      // The chat dependencies are never used: the guard fires before any
      // rendering or model call, so the stub only needs to satisfy the type.
      const stubChatDeps = {} as unknown as ChatDependencies;

      await expect(
        extractTextWithAiContentExtraction({
          file,
          modelId: 'openai://gpt-test',
          systemPrompt: 'system',
          userPrompt: 'user',
          metadataPrompt: 'metadata',
          temperature: 0,
          maxTokens: undefined,
          timeoutMs: 1_000,
          pagesPerBatch: 5,
          batchConcurrency: 1,
          maxPages: 1,
          renderPolicy,
          documentContext: {} as never,
          organizationId: 'organization-1',
          logger: createLogger({ namespace: 'test' }),
          ...stubChatDeps,
        }),
      ).rejects.toThrowError(/exceeds the AI content extraction page limit/);
    });
  });

  describe('splitPageNumbersIntoChunks', () => {
    it('splits pages into consecutive chunks preserving order', () => {
      expect(splitPageNumbersIntoChunks({ pageCount: 7, chunkSize: 3 })).to.eql([
        [1, 2, 3],
        [4, 5, 6],
        [7],
      ]);
    });

    it('returns a single chunk when the chunk size covers all pages', () => {
      expect(splitPageNumbersIntoChunks({ pageCount: 4, chunkSize: 10 })).to.eql([[1, 2, 3, 4]]);
    });

    it('returns no chunks for zero pages', () => {
      expect(splitPageNumbersIntoChunks({ pageCount: 0, chunkSize: 3 })).to.eql([]);
    });
  });

  describe('truncateMetadataInput', () => {
    it('leaves text within the budget untouched', () => {
      expect(truncateMetadataInput({ text: 'hello', maxChars: 10 })).to.eql({
        text: 'hello',
        truncated: false,
      });
    });

    it('keeps the head and appends the marker when over budget', () => {
      const { text, truncated } = truncateMetadataInput({ text: 'a'.repeat(25), maxChars: 10 });

      expect(truncated).toBe(true);
      expect(text.startsWith('a'.repeat(10))).toBe(true);
      expect(text.endsWith(METADATA_INPUT_TRUNCATION_MARKER)).toBe(true);
    });

    it('applies the default budget at its boundary', () => {
      expect(truncateMetadataInput({ text: 'x'.repeat(METADATA_INPUT_MAX_CHARS) }).truncated).toBe(
        false,
      );
      expect(
        truncateMetadataInput({ text: 'x'.repeat(METADATA_INPUT_MAX_CHARS + 1) }).truncated,
      ).toBe(true);
    });
  });

  describe('assertExtractedTextNotEmpty', () => {
    it('does not throw when text has content', () => {
      expect(() => assertExtractedTextNotEmpty('some extracted text')).not.toThrow();
    });

    it('throws when text is empty or whitespace-only', () => {
      expect(() => assertExtractedTextNotEmpty('')).toThrow();
      expect(() => assertExtractedTextNotEmpty('  \n\n \t ')).toThrow();
    });
  });
});
