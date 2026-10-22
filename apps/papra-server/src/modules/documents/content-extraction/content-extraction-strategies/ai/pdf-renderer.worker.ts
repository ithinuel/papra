// pdf-renderer.worker.ts
// Piscina worker — runs in a separate OS thread to avoid blocking
// the main event loop during CPU-intensive PDF page rendering.
// Piscina calls the exported function with the task data passed to pool.run().
//
// This file is loaded in three contexts: tsx in dev, plain worker_threads in
// tests (where Node's native type stripping is the only transpiler — piscina
// workers get no bundler pipeline), and the esbuild-bundled
// `pdf-renderer.worker.js` sibling in dist (see the build script in
// apps/papra-server/package.json). Keep it erasable-syntax-only TypeScript
// with no relative runtime imports; only bare package specifiers resolve at
// runtime. Type-only relative imports are fine — they are fully erased.
//
// Each task receives a consecutive range of pages with per-page render scales
// already computed on the main thread (the pixel clamp lives in models, where
// it is unit-tested), and parses the PDF once for the whole range instead of
// one parse per page.

import canvas from '@napi-rs/canvas';
import { getDocumentProxy } from 'unpdf';
import { configureNodePdfjs } from '@papra/pdfjs-node';
import type { RenderImageFormat } from './ai.content-extraction-strategy.types';

// Inject the full pdfjs-dist build (with its JBIG2/CCITT wasm decoders) into
// unpdf, and make pdf.js load the wasm from the filesystem.
// See @papra/pdfjs-node for the details.
const pdfjsOptions = await configureNodePdfjs();

export type PdfRenderPageTask = {
  /** Detached copy of the document; piscina moves it into this thread. */
  pdfBuffer: Uint8Array;
  /** Pages to rasterize with the scale to render them at, in task order. */
  pages: Array<{ pageNumber: number; scale: number }>;
  imageFormat: RenderImageFormat;
  /** JPEG encoder quality on the 0-100 scale; unused for png. */
  jpegQuality: number;
};

export default async function renderPages({
  pdfBuffer,
  pages,
  imageFormat,
  jpegQuality,
}: PdfRenderPageTask): Promise<string[]> {
  const pdf = await getDocumentProxy(pdfBuffer, pdfjsOptions);

  try {
    const dataUrls: string[] = [];

    for (const { pageNumber, scale } of pages) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const target = canvas.createCanvas(
        Math.max(1, Math.round(viewport.width)),
        Math.max(1, Math.round(viewport.height)),
      );
      const context = target.getContext('2d');

      // pdf.js renders on a transparent background and JPEG carries no alpha
      // channel: an unfilled canvas would encode the page background as black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, target.width, target.height);

      await page.render({ canvas: target, canvasContext: context, viewport }).promise;

      dataUrls.push(
        imageFormat === 'jpeg'
          ? target.toDataURL('image/jpeg', jpegQuality)
          : target.toDataURL('image/png'),
      );
    }

    return dataUrls;
  } finally {
    // The pool (and its threads) outlives a single document: always release the
    // pdf.js document opened for this task.
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
