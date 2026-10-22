# OpenDraft feature-gap matrix

Baseline researched 2026-10-21. Bluebeam capabilities below describe upstream documentation, not functionality tested in a licensed Revu installation. Subscription tiers and web/mobile differences must be checked for each comparison. OpenDraft entries are **planned acceptance scope**, not claims of delivered features; actual status belongs in TASKS.md and TEST_RESULTS.md.

Sources: [Revu 21 subscription feature matrix](https://support.bluebeam.com/revu/subscription/subscription-features.html), [current official plan comparison](https://www.bluebeam.com/pricing/), [Revu 21 manual](https://support.bluebeam.com/dk/online-help/revu21/Content/RevuHelp/Dashboard.htm), [web/mobile and Studio comparison](https://www.bluebeam.com/subscription-upgrade/). Product names identify comparison targets only; no proprietary assets or interface resources are reused.

| Workflow | Commercial baseline documented by Bluebeam | OpenDraft milestone / remaining gap | Verification needed |
| --- | --- | --- | --- |
| PDF navigation | Desktop drawing review; browser/mobile access also documented | Phase 1: local open/render, multiple documents, thumbnails, zoom/pan/rotation, search | Mixed page sizes, crop boxes, rotated text, malformed files, keyboard navigation |
| PDF organization | Merge, insert/extract/delete/rotate pages; document navigation aids | Phase 1: serialized page edits plus bookmarks, links, layers and attachments | Independent viewer and structural round trips; avoid silently dropping metadata |
| Content workflows | Document creation, content manipulation and OCR appear in the comparison | Phase 1 extraction; supported text editing explicitly scoped; advanced OCR/editing reserved for Project 3 | Distinguish added content from editing existing text; encrypted and signed cases |
| Markups | Text, highlights, shapes, stamps, pen tools and reusable toolsets | Phase 2: annotations, callouts/clouds, presets, properties, locking/grouping | Standard annotation dictionary/appearance round trips and undo/redo |
| Markup management | Filter/sort lists, comments, statuses and reports | Phase 2: list, filtering, statuses, CSV/PDF reports | Report totals, escaping, authorship and export completeness |
| Measurement | Per-page/viewport scale; length, area and advanced takeoff tools | Phase 3: calibrated geometry, units, formulas, count/volume and quantity exports | Known reference drawings, explicit numeric tolerance, rotation/crop/zoom invariance |
| Revision review | Overlay/comparison and batch revision workflows | Phase 4: alignment, comparison, revision history and slip-sheet operations | Synthetic revisions, alignment error bounds, retained annotations |
| Construction automation | Batch linking/processing and specialized fill/legend workflows | Phase 4: sheet links, custom hatches, region selection and legends | Deterministic batch results, cancel/recovery, no invented takeoff accuracy |
| Shared review | Studio real-time markup and project/document workflows | Phase 5: self-hosted permissions, shared projects, presence, history and offline synchronization | Concurrent edits, reconnect/conflicts, tenant isolation, audit and backup restore |
| Optional AI | Official comparison now includes AI-assisted drawing review/comparison | Phase 6: optional local/service adapters with human review | No silent measurement changes; quality datasets, opt-in data handling and provenance |
| Platform and ownership | Revu Windows desktop plus web/mobile offerings | Browser first, Windows installer later; no mandatory account or subscription | Installer smoke tests, offline reopen, self-hosted deployment and license inventory |

## Scope distinctions for release communication

- A page-content rectangle or text drawn into an export is **flattened content**, not a fully editable/importable PDF annotation implementation.
- A handwritten or image signature is not a cryptographically verified digital signature.
- Text extraction/search does not prove existing-text editing, OCR, accessibility remediation or secure redaction.
- A local browser viewer does not fulfill Windows installer, self-hosted collaboration, crash recovery or large-drawing performance gates.
- Completion remains blocked until every committed feature has end-to-end evidence and the owner approves any unsupported scope. Projects 2–4 remain unimplemented until the required sequential approval.

Revision review implementation checkpoint: selected-page read-only raster overlay/difference with explicit translation, thresholds and source-hash evidence is implemented and tested. [Public compare/overlay workflow](https://support.bluebeam.com/revu/features/compare-documents-vs-overlay-pages.html) informed scope only. Automatic registration, batch matching, persisted revision history and slip-sheet workflows remain open; no feature-parity claim. See REVISION_COMPARISON and TEST_RESULTS.

Alignment checkpoint: reviewable CPU similarity estimation and manual scale/rotation implemented with synthetic independent/browser evidence. Broad professional drawing registration, perspective/nonuniform transforms and full revision-workflow parity remain open. See ALIGNMENT_ACCEPTANCE and TEST_RESULTS.

Batch checkpoint: unique normalized PDF labels/order/manual one-to-one review and per-sheet PNG/PDF/CSV/JSON exports implemented. [Batch compare manual](https://support.bluebeam.com/no/user-manual/menus/batch/batch-compare-documents.html) provides independent feature scope reference. Multi-file sets, filename/region matching, saved batches, comparison markups, persisted history/slip sheets remain gaps; no full parity claim.

Slip-sheet checkpoint: reviewed content replacement and a local hash-bearing revision journal now have scoped tests. [Slip-sheet manual](https://support.bluebeam.com/no/dk/user-manual/menus/batch/slip-sheet.html) identifies additional insertion/markup-transfer/multi-file gaps. Donor layers/forms, archival revision browsing, superseded stamping and full construction revision management remain unsupported.


## Revision insertion update — 2026-10-21
Reviewed insert-before and superseded stamping now exist for two open PDFs with manual/label/order pairing. Original links stay on retained old sheets; selected old takeoff is explicitly cleared. Multi-file/folder sets, saved plans, region matching, archival/server history and automatic markup transfer remain gaps. See REVISION_INSERTION.md and TEST_RESULTS.md.


## Saved plans update — 2026-10-21
OpenDraft version1 source-bound JSON slip-sheet plans now export/import with fresh impact approval. Commercial saved-batch reference remains sourced in REVISION_PLANS; BCX compatibility, multi-file/folder plans and shared history remain gaps.

## Multi-file saved-plan implementation update — 2026-10-21

Standalone file/folder revision sets and portable multi-file mapping plans are implemented. Saved plans bind exact PDF hashes/page counts, restore mappings independently of filenames/order and require fresh approval. This supersedes the earlier file/folder and saved-set implementation gaps above. Resumable execution, region matching, shared/immutable server history, broad interoperability/resource acceptance and full parity remain open. See REVISION_SETS and TEST_RESULTS.

## Difference-cloud implementation update — 2026-10-21

Individual two-page raster comparisons now propose connected-pixel bounding regions and add explicitly selected/approved standard cloud annotations to the exact base snapshot, with editable source/alignment provenance and preserved takeoff. This supersedes the earlier individual comparison-cloud gap. Semantic changes, contour clouds, batch clouds, automatic region merging and broad corpus/resource acceptance remain open. See DIFFERENCE_CLOUDS and TEST_RESULTS.

## Delivered status against documented Revu capabilities (2026-10-21)

Evidence: unit 218/218, browser + desktop e2e (see TEST_RESULTS), Cua desktop runs, independent pypdf/openpyxl checks. Revu column = public documentation only.

| Revu capability | OpenDraft status | Evidence / gap |
| --- | --- | --- |
| View, search, thumbnails, tabs, rotate | Done | e2e viewer/navigation; Cua run |
| Page insert/extract/delete/reorder, bookmarks, links | Done | organization/navigation/hyperlinks e2e |
| Markups: shapes, text, callout, cloud, ink, highlight, stamps | Done | markups/stamps e2e; Cua foreground run; pypdf annotation check |
| Image, PDF-page and dynamic stamps | Done | image-stamps unit + e2e (PNG/JPEG/page 1 of a PDF as vector artwork); {date} {time} {datetime} {author} {page} resolve at placement (dynamic-stamps unit, parity-extras e2e) |
| Markups list, status, author, reports CSV/PDF | Done | markup reports e2e |
| Tool Chest / shared tool sets | Done | local preset library; team tool set published by administrators to the self-hosted server and loaded by any signed-in user (collab-server unit, collaboration e2e) |
| Import/edit foreign annotations and comment threads | Done (standard types) | foreign-annotations unit + e2e; Cua in packaged app. Square/Circle/Line/Ink/Highlight/FreeText/callout/Text notes/Stamps/cloudy Polygon and /IRT replies become editable markups in a new tab; measurement, non-WinAnsi and other types left in place and reported; custom stamp artwork not preserved |
| Calibration (page/viewport), length, polyline, perimeter, area, angle, count, volume | Done | measurement e2e; Cua: 60 ft, 300 ft² exact |
| Radius, diameter, arc length, area/volume cutouts, dynamic fill | Done | measurements + dynamic-fill unit; measurement-shapes e2e (clicked room within 2 % of 585 ft²; door gaps bridged by a gap tolerance) |
| Snapping: endpoints, midpoints, intersections (lines and curves), layer-aware | Done | drawing-geometry unit: curve/line crossing within 1.5 pt of the true point; hidden optional-content layers skipped |
| Quantity formulas, presets, CSV/XLSX, PDF /Measure export | Done | takeoff e2e; pypdf /Measure check |
| Takeoff legends, Spaces, Quantity Link to Excel | Done | takeoff-legend + quantity-link unit, e2e; openpyxl: own sheets/formulas/names untouched, linked sheets refreshed in place, recalculation on open. Spaces are named takeoff records; reports and legends attribute measurements to them |
| Overlay/compare, batch compare, slip sheet, revision sets, difference clouds | Done | comparison/slip/revision e2e |
| Batch Link (auto sheet hyperlinks) | Done | sheet-links unit + e2e: references to reviewed sheet numbers (A-102/A102/A.102, detail 3/M201) become GoTo links in a copy |
| Studio Sessions (real-time shared markups) | Done (self-hosted; web and desktop) | collaboration e2e; desktop `--server` e2e (sign-in, single origin) |
| OCR | Done (English, Spanish, French, German; offline) | ocr-text unit; production-CSP e2e: scanned sheet becomes searchable, no external requests or CSP violations. Tesseract 7 best_int models; Spanish accents verified in a production-CSP e2e |
| Redaction | Done | redaction unit + e2e; Cua in packaged app; pypdf: no text/"VALVE" left. Areas or search matches; affected pages rebuilt as 200 dpi images; their other text is re-added as invisible searchable text (runs touching a box are always dropped) |
| Digital signatures | Done | pdf-signature unit + e2e; pyHanko: intact, valid, entire-file coverage. PKCS#12 RSA/EC, adbe.pkcs7.detached SHA-256, visible or invisible, verify panel. Incremental multiple signatures (pyHanko: later revision = form filling), DocMDP certification recognised, RFC 3161 timestamps intact/valid, chain trusted against a supplied root; signing tested in the installed app. Revocation via supplied CRLs or live OCSP (through the self-hosted server to allow-listed responders; tested against OpenSSL's responder); long-term validation data (DSS: chains, CRLs, OCSP responses) embedded incrementally and used offline — pyHanko validates from the DSS alone; archival document timestamps (PAdES-LTA) — pyHanko: intact/valid over the entire file |
| Forms filling and creation | Done | pdf-forms unit + e2e: fill text/checkbox/radio/dropdown/list (read-only respected, optional flatten); add text, multi-line, checkbox, dropdown and signature fields. XFA refused by design |
| Flatten markups | Done | |
| Print | Done | Desktop: original PDF printed as vectors through the system dialog (desktop e2e: text preserved, exact sheet size; endpoint accepts only the app's own origin). Web: 200 dpi images (≥100 dpi, up to 300 pages), or Save PDF and print from a PDF reader. Changed layer visibility uses the image path so it is honoured |
| Punch lists | Done | punch-list unit + e2e: open markups numbered P-001… by page and position, with latest reply |
| Sketch to scale | Done | measurements unit + e2e: line of an exact real length and angle from a start point (12 ft at 30° measures 12.000000 ft) |
| 3D PDF (U3D/PRC models) | Missing | PDF.js has no 3D renderer; out of scope for 2D drawing review |
| PDF compatibility: non-embedded fonts, CJK CMaps, JPEG 2000 | Done (fixed via REA R1) | production e2e JPEG 2000/standard-font test |
