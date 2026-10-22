import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  dts: true,
  exports: true,
  deps: {
    alwaysBundle: ['@papra/pdfjs-node', '@papra/std'],
  },
});
