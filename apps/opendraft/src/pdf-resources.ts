/**
 * Same-origin PDF.js runtime data copied by scripts/copy-pdfjs-resources.mjs. Without these,
 * non-embedded standard fonts fall back to substitutes, predefined-CMap (CJK) text can be lost
 * and JPEG 2000/JBIG2 images may fail to decode.
 */
const base = `${import.meta.env?.BASE_URL ?? '/'}pdfjs/`;
// Node unit tests load the same modules without a web server; PDF.js uses its built-in fallbacks there.
export const pdfResources = typeof document === 'undefined' ? Object.freeze({}) : Object.freeze({
  cMapUrl: `${base}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}standard_fonts/`,
  wasmUrl: `${base}wasm/`,
  iccUrl: `${base}iccs/`,
});
