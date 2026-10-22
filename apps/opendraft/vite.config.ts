import {defineConfig} from 'vite';

export default defineConfig({
  // Discover worker/batch dependencies at startup so the first operation cannot
  // trigger a development reload that discards open PDFs.
  optimizeDeps: {include: ['jsfeat', 'fflate']},
});
