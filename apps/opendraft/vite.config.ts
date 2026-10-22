import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';

const {version} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: {__OPENDRAFT_VERSION__: JSON.stringify(version)},
  // Discover worker/batch dependencies at startup so the first operation cannot
  // trigger a development reload that discards open PDFs.
  optimizeDeps: {include: ['jsfeat', 'fflate']},
});
