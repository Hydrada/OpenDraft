# REA findings

Each finding lists the REA evidence, independent confirmation and outcome. REA output is static inference; nothing below relies on REA alone.

## R1 — PDF.js runtime data not bundled (compatibility bug) — FIXED
- **REA evidence:** `analyze-javascript-application` on the packaged `app.asar` (sha256 root recorded in the evidence) listed route endpoints `LiberationSans-{Regular,Bold,Italic,BoldItalic}.ttf` referenced by `pdf.worker.min-*.mjs`, with no corresponding files in the inventoried artifact.
- **Independent confirmation:** no `cMapUrl`, `standardFontDataUrl`, `wasmUrl` or `iccUrl` was passed to any of the 7 `getDocument` calls; `dist/` contained none of `cmaps/`, `standard_fonts/`, `wasm/`, `iccs/`. PDF.js itself warned "Ensure that the `standardFontDataUrl` API parameter is provided" during unit tests.
- **Impact:** non-embedded standard fonts (common in CAD exports) rendered with substitutes; predefined-CMap CJK text could be lost; JPEG 2000 images rendered blank.
- **Fix:** `scripts/copy-pdfjs-resources.mjs` copies the data (with licenses; `quickjs-eval` excluded because PDF scripts are never executed) into the app; `apps/opendraft/src/pdf-resources.ts` is spread into every `getDocument`.
- **Regression test:** `tests/e2e/production.spec.ts` "built app renders JPEG 2000 images and non-embedded standard fonts under the strict CSP". Verified to **fail without the fix** (blank image, red channel 255 where blue expected) and pass with it.

## R2 — Electron security posture (confirmation, no change)
- REA summary: 1 BrowserWindow, 11 explicit webPreferences, 0 preload entrypoints, 0 contextBridge APIs, 0 IPC channels/handlers, 0 utility processes, 0 native add-on bindings, 0 integrity contradictions.
- Matches the design in desktop/main.cjs and the desktop e2e security assertions.

## R3 — Network and storage surface (confirmation, no change)
- Only same-origin endpoints: `/api/health`, `/api/ai/status`, `/api/ai/sheet-index` (collaboration/assistant; blocked by the desktop host, which serves static files only). No third-party URLs, telemetry or update endpoints.
- Storage: `localStorage` (presets, collaboration queue) and one IndexedDB store (opt-in recovery) — matches KNOWN_LIMITATIONS.

## R4 — WebAssembly decoders blocked by CSP (accepted trade-off)
- The strict CSP has no `'wasm-unsafe-eval'`, so PDF.js uses its bundled pure-JS JPEG 2000/JBIG2 fallbacks (verified working by R1's test). Allowing WASM would speed up large scanned sheets; it is a deliberate CSP relaxation left for owner decision.

## R5 — Re-audit of the 2026-10-22 build (confirmation, no change)
- Full-application run hit REA's 25-minute analysis limit on the large PDF.js worker; its partial evidence (7 of 9 JavaScript files, 0 parse failures, 0 integrity contradictions) covers the app bundle and the new lazily loaded `pdf-signature` chunk. That chunk exports only `readPkcs12`, `signPdf`, `verifyPdfSignatures` and has **no network endpoints**.
- New same-origin endpoint `/__launch/list` (command-line "Open with" files, desktop host only) is the only addition to R3's list; storage unchanged (localStorage, one IndexedDB store).
- Targeted run on `desktop/main.cjs` + `desktop/host.cjs`: 1 BrowserWindow, 11 explicit webPreferences, 0 preload, 0 contextBridge, 0 IPC, 0 native add-ons — the added interface zoom, launch-file serving and Save-dialog title did not widen the Electron surface.
- Evidence: `%LOCALAPPDATA%\opendraft-build\rea-evidence\app-asar-2.json` (partial) and `desktop-main.json`.

## R6 — Re-audit after `--server` desktop collaboration (confirmation, no change)
- Targeted run on the rebuilt `desktop/main.cjs` + `desktop/host.cjs`: 1 BrowserWindow, 11 explicit webPreferences, 0 preload, 0 contextBridge, 0 IPC, 0 native add-ons, no hard-coded endpoints. The server origin comes only from the validated `--server` argument (https, or http for loopback), and the existing single-origin request filter applies to it. Evidence: `desktop-main-3.json`.
- R4 closed: the owner asked to finish the remaining features; `'wasm-unsafe-eval'` (WebAssembly compilation only, not JavaScript eval) is now in every CSP for OCR and PDF.js decoders. Tests assert `'unsafe-eval'` is still absent.

## R7 — Desktop vector printing changes the Electron surface (reviewed, accepted)
- New: a hidden, sandboxed `BrowserWindow` (separate `opendraft-print` partition, `plugins: true` for Chromium's PDF viewer, navigation and pop-ups blocked) that loads a temporary copy of the PDF and prints it; and a host endpoint `POST /__print` that accepts only `application/pdf` starting with `%PDF-`, at most 250 MB, and only with `Origin` equal to the app's own loopback origin (other local web pages cannot trigger it; unit-tested). The main window's webPreferences, request filter and the absence of preload/IPC are unchanged.
- REA confirmation (`desktop-main-4.json`): 2 BrowserWindows (main + hidden print window), 17 explicit webPreferences, 0 preload, 0 contextBridge, 0 IPC, 0 native add-ons, 0 integrity contradictions.
