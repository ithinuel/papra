# @papra/pdfjs-node

Internal (private) package that makes [pdf.js](https://github.com/mozilla/pdf.js), as consumed through [unpdf](https://www.npmjs.com/package/unpdf), decode JBIG2/CCITT images properly in Node.js.

Two problems it solves:

- unpdf's bundled pdf.js ships **without the JBIG2/CCITT wasm decoders**, so scanned PDFs render as blank pages (or OCR yields no text) unless the full `pdfjs-dist` build is injected via `definePDFJSModule`.
- pdf.js loads those wasm decoders through `fetch()`, which cannot read the `file://` URLs used in Node (its `NodeBinaryDataFactory` even references the browser `document` global). Without help, every JBIG2/CCITT image logs a warning and silently falls back to the much slower pure-JS decoder. The `FsBinaryDataFactory` exported here reads the data from the filesystem instead.

Background: the rendered-page fallback used to be independently broken — unpdf < 1.7 bundled PDF.js with a canvas factory whose `@napi-rs/canvas` import sat behind a catch-all that never resolved it (`NodeCanvasFactory._createCanvas` throwing `@napi-rs/canvas module is not resolved`). Upstream fixed canvas resolution in [unpdf v1.7.0](https://github.com/unjs/unpdf/pull/54), so the version bump is what restores rendering; this package is what restores decoding.

## Usage

```ts
import { getDocumentProxy } from 'unpdf';
import { configureNodePdfjs } from '@papra/pdfjs-node';

const pdfjsOptions = await configureNodePdfjs();
const pdf = await getDocumentProxy(data, pdfjsOptions);
```

Call it once per context that opens PDFs (main thread, each worker thread, …). It is idempotent.

Used by `@papra/app-server` (AI content extraction: main thread + Piscina worker) and `@papra/lecture` (PDF extraction/OCR).

Like `@papra/std`, this package is **source-only**: it has no build step and points its `exports` straight at `src/index.ts`. Consumers must **bundle it** into their output — Node refuses to type-strip `.ts` files under `node_modules`, so a bare runtime import resolves to the source and fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. `@papra/lecture`'s tsdown build bundles it via `alwaysBundle`, and `@papra/app-server`'s esbuild build inlines it with `--alias:@papra/pdfjs-node=…/src/index.ts` (both the main entry and the PDF renderer worker). In dev (`tsx`), it is run directly from source.
