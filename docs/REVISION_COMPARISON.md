# Drawing revision comparison

Comparison snapshots remain read-only. The separate [reviewed difference-cloud workflow](DIFFERENCE_CLOUDS.md) can now propose connected visual regions and, after individual selection and fresh approval, add standard clouds to the exact base drawing as one undoable workspace edit. This supersedes earlier statements that comparison annotations are wholly unimplemented. It does not add semantic/engineering classification or batch clouds.

Open two PDF files (or compare two pages from one file), then choose **Compare revisions**. Select a base page and revision page, choose a resolution, and compare. The result is an isolated read-only snapshot: no source PDF, annotation, measurement, undo history or recovery model is changed.

Review the color overlay and difference view. Overlay linework is red for the base, blue for the revision and black where black linework coincides. The difference view marks darker base content red, darker revision content blue and other color changes magenta; unchanged pixels are light gray. Color indicates relative pixel darkness, not a semantic classification of engineering additions/removals. The count, percentage and bounds describe raster pixels only.

## Alignment and rendering

Pages render using PDF.js display appearances and PDF default optional-content visibility. Current viewer layer toggles are not included. Rotation, CropBox and UserUnit are handled by the renderer. The output includes the whole transformed union of both page rectangles, with white outside each page; extra white page margins do not count as changed ink.

Alignment supports manual translation, uniform scale and clockwise rotation, plus reviewable automatic similarity estimates. See [alignment acceptance](ALIGNMENT_ACCEPTANCE.md). Translation uses physical points (1/72 inch), relative to the displayed base page's top-left origin. Positive horizontal/vertical offsets move the revision right/down. Requested offsets round to output pixels at the selected 36, 72, 108 or 144 dpi; evidence records both requested points and applied pixels/points. Automatic estimates propose scale/rotation/translation but require explicit review/apply; perspective/nonuniform registration and automatic page matching remain open. Lower resolution can obscure small differences; antialiasing, font/render differences and misalignment can produce differences that are not design changes.

An RGB change is counted when the maximum absolute channel difference is strictly greater than the chosen integer threshold (0–255), after transparency is composited over white. Threshold equality is unchanged; 255 suppresses every difference. Grayscale is round((299R + 587G + 114B)/1000). Overlay RGB is [revisionGray, round(baseGray*revisionGray/255), baseGray]. Differences use [220,35,45], [25,80,220] or [180,40,180]; unchanged intensity is round(224 + min(baseGray,revisionGray)*31/255). Alpha is opaque.

## Evidence and exports

- PNG exports the selected view at the computed raster size.
- PDF exports that view as a raster image on a page at the selected physical scale; it is not a vector drawing or editable revision annotation. The PDF embeds revision-comparison.json as an attachment.
- JSON records SHA-256 of the exact compared PDF snapshots, page numbers, renderer version, CropBox/view/rotation/UserUnit, dpi, alignment, threshold, counts, bounds, palette and selected export view. It contains filenames and metadata, but not the source PDF bytes.

Changed bounds are zero-based output pixels. The reported union origin locates that output canvas relative to the base viewport. Evidence is not authenticated authorship, a signature or an immutable audit record. Save source drawings with exported evidence when retaining a review; hashes alone do not retain the drawings.

Changing settings discards stale results. Cancel, close and Escape cancel asynchronous loading/rendering and suppress late publication; each run uses separate PDF loading tasks so it cannot destroy the viewer's document. Cancellation cannot interrupt the bounded synchronous raster loop. Sources are copied before asynchronous work, so the result describes the captured snapshots even if another operation completes later.

## Resource limits and remaining acceptance

Each input and translated output is limited to 4,000,000 pixels and 8192 pixels per side; geometry is checked before comparison canvas allocation. Each selected source snapshot is limited to 64 MiB. These are per-run safety bounds, not a measured aggregate RAM guarantee. Source copies, PDF workers, canvases and raster arrays contribute additional memory; cancellation cleanup can overlap. Large sheets may need 36 dpi or smaller source documents.

Synthetic engine and browser tests cover known additions/removals, alpha, thresholds, signed alignment, changed bounds, input immutability, rotation/cropping/UserUnit, resource errors, cancellation, PNG/PDF/JSON downloads and undo-state preservation. Independent Python/PDFium fixtures check raster behavior; independent exported-PDF checks cover raster parity and attached evidence. See TEST_RESULTS for actual results, versions and any failures.

Automatic similarity estimation is implemented with explicit review and synthetic acceptance evidence. Perspective/nonuniform registration, batch page pairing, vector comparison, difference-cloud annotations, persisted revision history, slip-sheet replacement and a broad authorized professional drawing corpus remain open. This increment does not satisfy the complete Phase 4 or OpenDraft completion gate.

## Sources and reproduction

Research used Bluebeam's public [compare and overlay workflow](https://support.bluebeam.com/revu/features/compare-documents-vs-overlay-pages.html) to identify workflow requirements. Implementation uses existing PDF.js rendering following its public [canvas examples](https://github.com/mozilla/pdf.js/blob/master/docs/contents/examples/index.md) and existing pdf-lib for raster PDF packaging. No proprietary code or interface resources were reused. The later alignment increment adds pinned JSFeat0.0.8 under MIT; see ALIGNMENT_ACCEPTANCE for maintenance and license-text review.

Run npm test and npx playwright test tests/e2e/revision-comparison.spec.ts. For independent fixtures:

1. node scripts/generate-revision-validation.mjs <folder>
2. python scripts/independent-revision-check.py <folder> --render
3. node scripts/generate-revision-validation.mjs <folder> --compare
4. python scripts/independent-revision-check.py <folder> --check

The Python steps require independently installed pypdfium2; --check-export also uses pypdf and Pillow. The browser test saves authorized exports under the OS temporary folder opendraft-revision-export-validation; run the independent checker on that folder with --check-export. These test exports are separate from opt-in application recovery.
