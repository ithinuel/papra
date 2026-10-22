import { isMimeTypeAllowed } from '../../../../shared/mime-types/mime-types.models';
import pLimit from 'p-limit';
import type { PdfPageReader, PdfRenderPolicy } from './ai.content-extraction-strategy.types';

export {
  type DocumentPage,
  type PdfPageChunkJob,
  type PdfPageReader,
} from './ai.content-extraction-strategy.types';

/**
 * Baseline rasterization scale. Vision models work best around 1-2x native
 * PDF resolution; the pixel clamps in `computeRenderScale` can only lower it,
 * never raise it.
 */
export const PDF_RENDER_BASE_SCALE = 2;

/** JPEG quality (0-100 scale) for rendered pages. High enough for text and
 * tables, low enough that scanned pages cost a fraction of their PNG size. */
export const PDF_RENDER_JPEG_QUALITY = 87;

/**
 * Computes the rasterization scale for a page of native (scale-1) size
 * `nativeWidth x nativeHeight` PDF units: starts from the baseline scale and
 * only ever shrinks it to satisfy the `maxLongEdge` and `maxPixels` caps
 * (a cap of 0 disables it). Rendering never upscales beyond the baseline, and
 * the clamps save tokens whenever the model downsamples larger images anyway.
 */
export function computeRenderScale({
  nativeWidth,
  nativeHeight,
  maxLongEdge,
  maxPixels,
}: {
  nativeWidth: number;
  nativeHeight: number;
  maxLongEdge: number;
  maxPixels: number;
}): number {
  let scale = PDF_RENDER_BASE_SCALE;

  const longEdge = Math.max(nativeWidth, nativeHeight);
  if (maxLongEdge > 0 && longEdge > 0) {
    scale = Math.min(scale, maxLongEdge / longEdge);
  }

  if (maxPixels > 0 && nativeWidth > 0 && nativeHeight > 0) {
    scale = Math.min(scale, Math.sqrt(maxPixels / (nativeWidth * nativeHeight)));
  }

  return scale;
}

/**
 * Runs an async operation under a deadline. When the deadline elapses the
 * returned promise rejects with `onTimeout()` and the operation's abort signal
 * fires, letting queue-based executors (piscina) skip tasks that have not
 * started yet. A task already in flight cannot be interrupted — its result is
 * simply discarded.
 */
export async function runWithDeadline<R>({
  run,
  timeoutMs,
  onTimeout,
}: {
  run: (options: { signal: AbortSignal }) => Promise<R>;
  timeoutMs: number;
  onTimeout: () => Error;
}): Promise<R> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run({ signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(onTimeout()), timeoutMs);
        // The deadline must not keep the process (or a test runner) alive.
        timeoutHandle.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
    controller.abort();
  }
}

/**
 * Maps items with at most `concurrency` mappers in flight at a time. The
 * returned array preserves the input order regardless of completion order, so
 * callers can batch in parallel and still aggregate deterministically.
 */
export async function mapWithConcurrency<T, R>({
  items,
  concurrency,
  mapFn,
}: {
  items: T[];
  concurrency: number;
  mapFn: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const limit = pLimit(Math.max(1, concurrency));

  return Promise.all(items.map(async (item, index) => limit(async () => mapFn(item, index))));
}

/**
 * Base64 encoding inflates image bytes in the request payload by up to 4/3;
 * 1.37 is that ratio rounded up, used as a conservative estimator for the
 * single-payload (non-PDF) size gate.
 */
export const BASE64_PAYLOAD_INFLATION = 1.37;

/**
 * Estimates the request payload size (in bytes) of sending a raw file of
 * `size` bytes as a base64 data URL.
 */
export function estimateBase64PayloadBytes(size: number): number {
  return Math.ceil(size * BASE64_PAYLOAD_INFLATION);
}

/**
 * Whether the AI content extraction strategy can handle the given file.
 *
 * The size limit applies only to files sent as a single payload (images):
 * a file whose estimated base64 payload would exceed `maxImageBytes` cannot
 * be split, so the strategy skips it and lets the next strategy in the list
 * try.
 *
 * PDFs are exempt: they are rendered into chunks of at most `pagesPerBatch`
 * clamped-resolution pages, so a PDF larger than the limit can still be
 * extracted.
 */
export function isAiContentExtractionAbleToExtractTextFromDocument({
  file,
  mimeTypesAllowList,
  maxImageBytes,
}: {
  file: { type: string; size: number };
  mimeTypesAllowList: Set<string>;
  maxImageBytes: number;
}) {
  const isFormatSupported = isMimeTypeAllowed({
    mimeType: file.type,
    allowList: mimeTypesAllowList,
  });

  const isBatched = file.type === 'application/pdf';
  const isBelowSizeLimit = isBatched || estimateBase64PayloadBytes(file.size) <= maxImageBytes;

  return isBelowSizeLimit && isFormatSupported;
}

/**
 * Creates a PDF page reader for the given file.
 *
 * Loads the worker module (and with it pdf.js, piscina, and the wasm decoder
 * setup, which run at module scope) only when a PDF is actually rendered, so
 * merely importing the strategy — or running a different content extraction
 * strategy — does not pay the startup cost. The import is cached by the ESM
 * loader, so only the first render pays it.
 */
export async function buildPdfPageReader({
  file,
  pagesPerBatch,
  renderPolicy,
}: {
  file: File;
  pagesPerBatch: number;
  renderPolicy: PdfRenderPolicy;
}): Promise<PdfPageReader> {
  const { createPdfPageReader } = await import('./ai.content-extraction-strategy.worker');

  return createPdfPageReader({ file, pagesPerBatch, renderPolicy });
}
