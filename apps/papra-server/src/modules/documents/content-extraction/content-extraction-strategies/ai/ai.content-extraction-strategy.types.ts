export type DocumentPage = {
  mimeType: string;
  base64DataUrl: string;
};

export type RenderImageFormat = 'jpeg' | 'png';

/**
 * How PDF pages are rasterized before being sent to the model. Assembled from
 * config today; the Stage 2 capability resolver will source the same fields
 * from probed/known model capabilities.
 */
export type PdfRenderPolicy = {
  /** Cap on the rendered page's long edge in pixels; 0 disables the clamp. */
  maxLongEdge: number;
  /** Cap on the rendered page's total pixel count; 0 disables the clamp. */
  maxPixels: number;
  imageFormat: RenderImageFormat;
  /** JPEG encoder quality on the 0-100 scale; unused for png. */
  jpegQuality: number;
  /** Deadline applied to each worker-thread render task. */
  renderTimeoutMs: number;
};

/** A page to rasterize together with the scale precomputed on the main thread. */
export type PdfRenderPageSpec = {
  pageNumber: number;
  scale: number;
};

/**
 * A lazily-rendered chunk of consecutive pages (at most `pagesPerBatch`),
 * ordered by page. Rendering a chunk starts only when `render()` is awaited,
 * so the pipeline holds at most `batchConcurrency` chunks of rasterized pages
 * in memory at any time.
 */
export type PdfPageChunkJob = {
  /** 1-based number of the chunk's first page. */
  firstPageNumber: number;
  render(): Promise<DocumentPage[]>;
};

export type PdfPageReader = {
  pageCount: number;
  /** One lazy render job per chunk, in page order. */
  chunkJobs: PdfPageChunkJob[];
  close(): Promise<void>;
};
