import Piscina from 'piscina';
import { availableParallelism } from 'node:os';
import { configureNodePdfjs } from '@papra/pdfjs-node';
import { getDocumentProxy } from 'unpdf';
import { computeRenderScale, runWithDeadline } from './ai.content-extraction-strategy.models';
import type {
  DocumentPage,
  PdfPageChunkJob,
  PdfPageReader,
  PdfRenderPageSpec,
  PdfRenderPolicy,
} from './ai.content-extraction-strategy.types';

// Inject the full pdfjs-dist build (with its JBIG2/CCITT wasm decoders) into
// unpdf, and make pdf.js load the wasm from the filesystem.
// See @papra/pdfjs-node for the details.
const pdfjsOptions = await configureNodePdfjs();

// One render pool for the whole process. pdf.js worker threads are expensive to
// boot, so a per-document pool pays the startup cost on every extraction and,
// worse, lets concurrent extractions multiply thread count (each pool sizing
// itself to the full machine). A single shared pool bounds total renderer
// threads to the machine's parallelism and amortizes boot cost across
// documents. Idle threads exit after `idleTimeout`, and piscina unrefs idle
// workers, so a shared pool never keeps the process (or a test runner) alive.
let rendererPool: Piscina | undefined;

function getRendererPool() {
  rendererPool ??= new Piscina({
    // From source (tsx dev, vitest) the pool loads the .ts worker directly:
    // piscina spawns plain worker_threads and Node strips the types natively.
    // Production bundles the sibling `pdf-renderer.worker.js` next to
    // dist/index.js (see the build script in apps/papra-server/package.json).
    filename: new URL(
      import.meta.url.endsWith('.ts') ? './pdf-renderer.worker.ts' : './pdf-renderer.worker.js',
      import.meta.url,
    ).href,
    maxThreads: Math.max(2, availableParallelism()),
    idleTimeout: 30_000,
  });

  return rendererPool;
}

/**
 * Splits the page numbers `1..pageCount` into consecutive chunks of at most
 * `chunkSize` pages, preserving order.
 */
export function splitPageNumbersIntoChunks({
  pageCount,
  chunkSize,
}: {
  pageCount: number;
  chunkSize: number;
}): number[][] {
  const chunks: number[][] = [];

  for (let start = 1; start <= pageCount; start += chunkSize) {
    const length = Math.min(chunkSize, pageCount - start + 1);
    chunks.push(Array.from({ length }, (_, index) => start + index));
  }

  return chunks;
}

/**
 * Opens the PDF and returns a reader exposing one lazy render job per
 * `pagesPerBatch` consecutive pages. Jobs rasterize in worker threads, so the
 * CPU-intensive pdf.js work never blocks the task handler's event loop, and
 * chunking per-job (instead of rendering the whole document up front) bounds
 * in-flight memory to the chunks the pipeline is actively processing.
 */
export async function createPdfPageReader({
  file,
  pagesPerBatch,
  renderPolicy,
}: {
  file: File;
  pagesPerBatch: number;
  renderPolicy: PdfRenderPolicy;
}): Promise<PdfPageReader> {
  // Read the bytes once into a stable copy. `file.arrayBuffer()` returns the
  // file's sole ArrayBuffer, and both pdf.js (its parser worker) and the render
  // pool (via structured-clone transfer) will *detach* any buffer they receive,
  // so a single shared buffer cannot survive being handed to both. Every
  // consumer below gets its own independent copy.
  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(Uint8Array.from(sourceBytes), pdfjsOptions);
  const pageCount = pdf.numPages;
  const mimeType = renderPolicy.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';

  const chunkJobs: PdfPageChunkJob[] = splitPageNumbersIntoChunks({
    pageCount,
    chunkSize: pagesPerBatch,
  }).map((pageNumbers) => ({
    firstPageNumber: pageNumbers[0]!,

    render: async (): Promise<DocumentPage[]> => {
      // Resolve each page's clamped scale on the main thread: reading the
      // native viewport is parse-only work, and the clamp itself is
      // unit-tested in models rather than inside the renderer worker.
      const pages: PdfRenderPageSpec[] = [];
      for (const pageNumber of pageNumbers) {
        const page = await pdf.getPage(pageNumber);
        const { width, height } = page.getViewport({ scale: 1 });
        pages.push({
          pageNumber,
          scale: computeRenderScale({
            nativeWidth: width,
            nativeHeight: height,
            maxLongEdge: renderPolicy.maxLongEdge,
            maxPixels: renderPolicy.maxPixels,
          }),
        });
      }

      // The pool task parses the PDF once for the whole chunk. Rendering
      // page-by-page made each task re-parse the entire document, an
      // O(pages^2) parse cost that dominates for large PDFs.
      const dataUrls: string[] = await runWithDeadline({
        timeoutMs: renderPolicy.renderTimeoutMs,
        onTimeout: () =>
          new Error(
            `Rendering PDF pages ${pageNumbers[0]}-${pageNumbers.at(-1)} exceeded the ` +
              `${renderPolicy.renderTimeoutMs}ms render deadline (CONTENT_EXTRACTION_AI_RENDER_TIMEOUT_MS)`,
          ),
        // Piscina moves the task to a worker thread via structured clone,
        // which *transfers* a Uint8Array's underlying ArrayBuffer. Each task
        // gets a fresh copy so the transfer only moves that copy, never the
        // source.
        run: async ({ signal }) =>
          getRendererPool().run(
            {
              pdfBuffer: Uint8Array.from(sourceBytes),
              pages,
              imageFormat: renderPolicy.imageFormat,
              jpegQuality: renderPolicy.jpegQuality,
            },
            { signal },
          ),
      });

      return dataUrls.map((base64DataUrl): DocumentPage => ({ mimeType, base64DataUrl }));
    },
  }));

  return {
    pageCount,
    chunkJobs,

    close: async () => {
      // Release the main-thread pdf.js document (parser transport and its
      // worker). The render pool is shared process-wide and outlives the reader.
      await pdf.loadingTask.destroy();
    },
  };
}
