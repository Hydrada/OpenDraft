# Dependencies and distribution obligations

Exact resolved graph: package-lock.json. Runtime package inventory generated with `npm run audit:licenses` in docs/generated/DEPENDENCY_LICENSES.json. Preserve all shipped license/copyright notices and investigate missing/custom expressions before release. This inventory does not replace review of bundled fonts/codecs/native optional dependencies.

| Component | Version | License | Use / obligation |
|---|---|---|---|
| pdfjs-dist | 6.4.299 | Apache-2.0 | Renderer/worker; retain license/notices, review bundled third-party assets |
| pdf-lib | 1.17.1 | MIT | Page edits/export; retain copyright/license; maintenance and encrypted-document limitations |
| write-excel-file | 4.1.1 | MIT | On-demand browser takeoff XLSX writer; retain LICENSE; typed literal strings, no untrusted formula API |
| fflate | 0.8.3 | MIT | XLSX and batch ZIP generation; direct exact version; retain LICENSE |
| pkijs | 3.4.3 | BSD-3-Clause | PKCS#12 reading and CMS signing/verification for digital signatures; lazily loaded chunk; transitive asn1js/pvtsutils/pvutils/bytestreamjs (BSD-3/MIT), @noble/hashes (MIT), tslib (0BSD); no install scripts; retain notices |
| tesseract.js | 7.0.0 | Apache-2.0 | Offline OCR (lazily loaded); its opencollective postinstall script is not run (`--ignore-scripts`) |
| tesseract.js-core | 7.0.0 | Apache-2.0 | Tesseract OCR engine compiled to WebAssembly; LSTM builds served from `ocr/core` |
| @tesseract.js-data/eng | 1.0.0 | MIT (package) / Apache-2.0 (Tesseract model) | English `best_int` model served from `ocr/lang` |
| asn1js | 3.0.6 | BSD-3-Clause | ASN.1 encoding for signatures (direct import, exact version) |
| Vite | 8.3.5 | MIT | Build/dev tooling; inspect bundled output/transitive obligations |
| TypeScript | 5.9.3 | Apache-2.0 | Development typechecking |
| Playwright Test | 1.58.2 | Apache-2.0 | Development headless tests; browser distribution separately licensed |
| Electron | 45.0.0 | MIT plus bundled Chromium notices | Windows desktop runtime; retain runtime notices and audit bundled components |
| electron-builder | 26.15.3 | MIT | Development packaging tool; NSIS/ZIP output tested, installer acceptance pending |

Development dependency override: global-agent 4.1.3 removes the vulnerable roarr/sprintf-js chain introduced by the builder's older downloader dependency. Packaging and hidden packaged smoke tests exercised this override. npm audit currently reports zero vulnerabilities; this does not certify the runtime or packaging supply chain. npm 12 blocked the unused electron-winstaller install script; NSIS packaging succeeded without enabling it. Electron runtime installation is explicit via `npm run desktop:runtime`.

Research alternatives and authoritative links: docs/research/PDF_FOUNDATIONS.md. Do not ship AGPL/commercial libraries without deliberate licensing decision. Project source license pending owner decision before publication.

Text-layer CSS is adapted from the pinned PDF.js viewer CSS; retain its Apache-2.0 license and attribution. Optional external validation tools used locally: pypdf 6.21.1 and pypdfium2 5.14.0, installed in OS temporary directories and not shipped with the app. Their package/binary licenses must be reviewed if later distributed in a test/release toolkit.

2026-10-21 distribution follow-up: pinned PDF.js npm tree contains no separately named NOTICE file; retain its LICENSE and modified CSS attribution (Copyright 2014 Mozilla Foundation). Electron's installed ffmpeg.dll and LICENSES.chromium.html ffmpeg entry were inspected: the notice identifies LGPL-2.1-or-later plus other file notices, but exact build/source-offer obligations remain a release blocker. Do not treat the Electron MIT wrapper as clearance for the runtime. Optional @napi-rs/canvas is installed for PDF.js Node workflows; verify absence from each distribution, rather than inferring this solely from npm metadata.

Asset review finding: pdfjs-dist's standard_fonts/LICENSE_LIBERATION identifies GPL-2.0 with font/document exceptions; do not treat every asset under this Apache-2.0 npm package as permissively licensed. These external font assets are not currently copied into the app bundle. Any future bundled fonts/CMaps/WASM/ICC data requires its own notices and distribution review. Default/system-font fallback remains a compatibility limitation.

Callout/cloud milestone introduces no runtime dependencies. Independent PDFium validation remains temporary developer tooling, not a shipped library. Source license and Electron/FFmpeg distribution obligations remain open release blockers.

Reusable markup presets use existing annotation validation and browser JSON/localStorage APIs; no runtime dependency added. Runtime audit and license evidence are recorded in TEST_RESULTS.

Visual text stamps add no dependency or copied commercial artwork/font assets. They use the existing pdf-lib standard-font metrics/encoding and independently authored vector appearance commands. Existing source-license/Electron distribution blockers remain.

Markup grouping reuses existing annotation/PDF APIs and introduces no runtime dependencies. Optional independent structure check uses previously installed developer-only pypdf 6.21.1, not a shipped component.

Authored-layer increment adds no runtime dependency. Uses the existing PDF.js/pdf-lib adapters and PDF optional-content structures. Existing source-license, Electron/FFmpeg redistribution and full distribution-clearance questions remain open; successful tests are not license clearance.

Markup review sorting/filtering uses no new dependency. Explicit built-in English Intl.Collator handles natural numeric string sorting; browser/locale corpus acceptance remains separate from unit/Chromium evidence. Existing distribution-license obligations remain open.

Local comment threads add no dependency; use existing PDF metadata/reply dictionaries and JSON/CSV/report adapters. Existing source-license and distribution obligations remain open. Independent pypdf/PDFium packages remain isolated validation tools, not shipped runtime dependencies.

Organization preservation adds no dependencies. Independent validation uses existing isolated pypdf 6.21.1 and pypdfium2 5.14.0 tooling. Runtime licensing/release clearance remains incomplete.

Revision comparison uses existing PDF.js and pdf-lib plus independently authored CPU raster logic; no dependency added. Independent export checks use isolated pypdf/PDFium/Pillow tooling and do not bundle them into the application. Source-license/distribution acceptance remains open.

Alignment adds jsfeat0.0.8 (MIT) pinned in package-lock; old release has no established current maintenance commitment. Package metadata omits license: exact reviewed LICENSE hash/source is recorded in docs/research/LICENSE_OVERRIDES.json and verified by scripts/licenses.mjs. Desktop packaging copies its license. Pure JS CPU worker; no CSP relaxation or external service. OpenCV.js was probed separately and not installed/bundled. Release security/distribution clearance remains open.

JSFeat source additionally credits BSD qsort/UC Regents, FAST/Edward Rosten, EPFL YAPE/Vincent Lepetit and OpenCV ORB authors. Preserve the unminified upstream text notice in browser/desktop assets; exact inherited license/provenance obligations remain unresolved for release. Package-level MIT inventory is not complete clearance.

Batch checkpoint: fflate0.8.3 MIT is now a direct pinned dependency for ZIP output (already installed transitively for XLSX). Existing desktop license copy retained. PDF.js deferred import for preflight tests does not code-split because viewer imports it statically; build warns accordingly. No CSP weakening. Existing distribution/source-license and JSFeat inherited-provenance gates remain.

Slip-sheet checkpoint adds no runtime dependencies. PDF.js inspects geometry; pdf-lib copies drawing resources into stable target page objects; independent pypdf/PDFium/Pillow validate synthetic preservation/appearance. Existing license/source-provenance/installer clearance remains open.


## Revision insertion — 2026-10-21
No new runtime dependency. Uses existing pinned PDF.js/pdf-lib and independent pypdf/PDFium/Pillow validation environment. License inventory and runtime security checks are recorded in TEST_RESULTS; distribution obligations and source-license owner decision remain open.


## Saved revision plans — 2026-10-21
No new runtime package. JSON/TextEncoder/WebCrypto/File APIs and existing PDF inspection/editing adapters implement local plan exchange. Existing dependency/license/distribution obligations remain open; exact check results in TEST_RESULTS.


## Revision-set dependency checkpoint — 2026-10-21
No new package: standalone multi-file execution reuses existing PDF.js inspection, pdf-lib preservation/editing, source-bound plan validators and fflate ZIP packaging. UTF-8/CSV/crypto hashing and browser file APIs remain local. Fresh runtime audit for this increment reports zero known vulnerabilities; license inventory lists 11 installed runtime packages, zero unknown licenses. These checks do not establish full security or distribution clearance. Source-license choice, JSFeat inherited-provenance and Electron distribution obligations remain open. Build size does not establish peak-memory acceptance.
| @tesseract.js-data/spa, fra, deu | 1.0.0 | MIT (package) / Apache-2.0 (Tesseract models) | Spanish, French and German `best_int` OCR models served from `ocr/lang` |
