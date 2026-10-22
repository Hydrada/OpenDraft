# OpenDraft development distribution notices

Automatic comparison alignment additionally bundles JSFeat 0.0.8 (MIT, Copyright (c) 2012 Eugene Zatepyakin) in a local worker. Preserve licenses/jsfeat-LICENSE.txt. The published package omits license metadata; the bundled LICENSE was inspected and its exact SHA-256 is recorded in docs/research/LICENSE_OVERRIDES.json. This old package has no established current security-maintenance commitment; bounded raster input and tested isolation do not constitute full release security clearance. OpenCV.js was researched but is not bundled.

JSFeat's unminified source additionally credits Regents of the University of California (1992, 1993; BSD qsort derivative), Edward Rosten (FAST), Computer Vision Lab, EPFL, Switzerland (2007; Vincent Lepetit; YAPE), and OpenCV ORB authors Ethan Rublee, Vincent Rabaud and Gary Bradski. Preserve licenses/jsfeat-upstream-source.txt with these original embedded notices. Exact inherited license/provenance obligations require separate release review; package-level MIT inventory alone is not full clearance. Browser assets retain both files under /licenses/.

Takeoff XLSX generation additionally bundles write-excel-file 4.1.1 (MIT) and fflate 0.8.3 (MIT). Their license texts are copied alongside the other renderer licenses. XLSX generation is loaded on demand; no workbook importer or macro runner is included.

The renderer bundles PDF.js (pdfjs-dist 6.4.299, Apache-2.0) and pdf-lib 1.17.1 (MIT). Copied license texts are included in this directory, together with license texts for renderer dependencies @pdf-lib/standard-fonts 1.0.0 (MIT), @pdf-lib/upng 1.0.1 (MIT), pako 1.0.11 (MIT AND Zlib), and tslib 1.14.1 (0BSD). Preserve these files when redistributing this development package. Exact installed inventory is recorded in the repository package-lock.json and docs/generated/DEPENDENCY_LICENSES.json.

Electron 45.0.0 and its Chromium/Node dependencies have separate notices shipped alongside the application executable: LICENSE.electron.txt and LICENSES.chromium.html. Retain them as well.

The Electron runtime also includes ffmpeg.dll. The ffmpeg entry in its shipped LICENSES.chromium.html identifies LGPL-2.1-or-later and other source-file notices. Exact build configuration, matching source availability and all redistribution obligations require release review; the Electron wrapper's MIT license alone does not clear this binary. This development notice is not a source offer or a claim that LGPL obligations are complete.

This notice records third-party components; it does not assign a license to owner-authored OpenDraft code. The project source license and publication approval remain pending. This inventory is not a completed legal clearance of every asset, codec or optional future component. Fonts, CMaps, ICC profiles, WASM decoders and other assets added in later builds require their own distribution review. No municipal/proprietary PDF data or commercial software assets are included in the synthetic test corpus.

Batch revision ZIP export directly bundles fflate0.8.3 MIT, already retained in the renderer dependency/license set for XLSX. Existing fflate LICENSE copy remains required.

## PDF.js runtime data (bundled under `pdfjs/`)
CMaps (Adobe, BSD-3-Clause), standard fonts (Foxit/Liberation, BSD/SIL OFL), OpenJPEG (BSD-2-Clause), JBIG2 and QCMS decoders (see `pdfjs/wasm/LICENSE_*`), and the CGATS ICC profile (`pdfjs/iccs/LICENSE`). Each folder ships with its original license files from `pdfjs-dist`.

## Digital signature support (lazily loaded `pdf-signature` chunk)
PKI.js 3.4.3 and ASN1.js 3.0.6 (Peculiar Ventures, BSD-3-Clause), pvtsutils and pvutils (MIT), bytestreamjs (BSD-3-Clause), @noble/hashes (MIT). License texts are in `licenses/`.

## OCR (lazily loaded; files under `ocr/`)
tesseract.js 7.0.0 and tesseract.js-core 7.0.0 (Apache-2.0; Tesseract OCR by Google and contributors, Apache-2.0) and the English `best_int` LSTM model from tessdata via @tesseract.js-data/eng (Apache-2.0 model data). License texts are in `licenses/` and `ocr/`.

## Content Security Policy
`script-src` includes `'wasm-unsafe-eval'`, which permits compiling WebAssembly (OCR and PDF.js image decoders) but not JavaScript `eval`.
