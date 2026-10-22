# Decisions

## ADR-001 â€” 2026-10-21: local browser foundation
Use TypeScript, Vite, PDF.js 6.4.299 for rendering/text extraction and pdf-lib 1.17.1 behind a narrow page-edit adapter. Reasons: browser/Windows reach, CPU operation, local document handling, permissive runtime licenses and smallest testable vertical slice. See docs/research/PDF_FOUNDATIONS.md. This is provisional for advanced editing, not an assertion that pdf-lib can deliver full parity.

No uploaded documents, accounts, telemetry or remote document fetching. Workers/assets bundle locally. Do not execute PDF scripts or automatically follow embedded links. Bound rendering resources. Export a new file instead of overwriting originals. Encrypted inputs must fail clearly; never bypass encryption with ignoreEncryption.

Electron desktop proof selected in ADR-006 below. Self-host initially means static browser assets; collaboration backend remains unimplemented. Browser memory is not crash recovery or offline installation.

## ADR-002 â€” staged licensing
Prefer permissive dependencies; do not integrate AGPL/commercial components implicitly. MuPDF/PyMuPDF remain research candidates only. Keep dependency/license inventory and distribution notices. Owner product license choice remains pending before external publication; no license is silently assigned to owner-authored code.

## ADR-003 â€” evidence and sequencing
Use synthetic PDF fixtures, headless browsers, independent PDF engines for export checks where available. Record exact commands/results; planned targets are not measured benchmarks. Only OpenDraft implementation begins. No GitHub remote exists and CLI authentication is absent; local work proceeds without publishing.

## ADR-004 â€” Phase 1 organization and session recovery
Represent page organization as immutable source/page references and quarter-turn deltas; export through a replaceable assembly adapter. Bound undo history to 100 commands. Insertion, deletion, extraction and reorder rebuild page trees; warn that document-level bookmarks/forms/attachments/signatures are not guaranteed preserved. Preserve original source bytes.

Store opt-in session recovery in IndexedDB with an atomic latest snapshot, after an explicit user choice to retain documents on this browser. Include a clear retained-data deletion control. Recovery is best-effort: browser quota/eviction/private-mode failures must be visible; never claim durable backup. Initial recovery restores current document state rather than the undo stack. Derived from [pdf-lib copyPages API](https://pdf-lib.js.org/docs/api/classes/pdfdocument#copypages) and [IndexedDB transaction guidance](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB), checked 2026-10-21.

## ADR-005 â€” authored annotation model and preservation
Store authored markup geometry in unrotated PDF user space. Materialize from immutable original sources; never append the same authored set to a previously materialized export. Use standard PDF annotation subtypes with explicit appearance streams; flatten only newly authored OpenDraft marks through those same appearances. Atomic bounded history includes pages and markups. Recovery retains originals and the editable model, without undo history. Preserve the existing catalog for unchanged page layout; structural organization still warns about metadata loss. Refuse apparent signed/certified, encrypted and XFA edits rather than implying signature preservation. This detection is structural, not cryptographic verification.

## ADR-006 â€” Windows desktop proof
Use Electron 45.0.0 and electron-builder 26.15.3 for the initial Windows packaging proof. Renderer sandbox, context isolation and web security stay enabled; Node integration, preload, remote navigation and permissions are unavailable. Serve bundled assets from loopback. Automated smoke runs are hidden, unfocusable and isolated; they never run the interactive installer. Unsigned development artifacts are not publication approval. Publisher metadata, source license, notices and installer acceptance remain release work.

## ADR-007 â€” evidence-based numeric takeoff and external review
Retain calibration reference points, known dimensional distance and unit; validate derived scale ratios rather than trusting cached quantities. Measurements remain a separate editable model in unrotated PDF coordinates, included atomically in history/recovery and remapped with page identity. Require explicit reference review and reject ambiguous viewport calibration. Numeric controls are an initial slice; standard PDF measurement interoperability and professional accuracy acceptance remain open.

Use separate read-only external review chats within the repository project. Owner requires Claude Opus 5.5 Light; T3 currently exposes Low. Do not silently substitute models or bypass provider permissions. Verified setup/failures are tracked in docs/EXTERNAL_AGENT_COORDINATION.md.

## ADR-008 â€” XLSX quantity export
Reuse MIT write-excel-file 4.1.1 and fflate 0.8.3, lazy-loaded for browser-only generation, rather than build an OOXML serializer. Share validated quantity/evidence rows with CSV. Quantities use numeric cells; all text uses explicit string cells, never formula cells. Fail clearly on Excel/XML text limits. This is a snapshot report, not a spreadsheet geometry calculator. Native Excel and large-workbook acceptance remain open; preserve both dependency licenses in distributions.

## ADR-009 â€” explicit recalibration impact review
Validate proposed scales against the full existing takeoff before review. Compare both computed quantities and resolved calibration evidence; changing evidence requires review even when values match. Bind approval to the exact candidate and existing state; discard it after input/context changes or commit. Preserve current quantities until approval and commit atomically with history. This transient review does not represent persisted engineering acceptance or identity/audit evidence.

## ADR-010 â€” retain source metadata during layout-preserving edits
Pass updateMetadata:false when loading original documents for rotation, markups and workspace inspection. Retain source Info/XMP without silently replacing Producer/Creator/dates with SDK defaults. Existing source dates are preserved provenance fields, not a record of OpenDraft edits; authored annotations retain explicit timestamps. Structural page assembly creates a new document and retains its separate metadata-loss warning. Future audit/collaboration history must not infer edit events from retained source dates.

## ADR-011 — interoperable callout and cloud appearances
Use FreeText /IT FreeTextCallout with absolute /CL points and /RD textbox offsets; use Square /BE cloud border data with explicit cubic scallop appearances. Retain separate textbox corners and leader geometry in the editable model. Reject invalid anchors, duplicate leader points and outside-page coordinates. Coordinate entry supports two/three-point leaders; dragging creates a textbox with the entered tip connected directly to its nearest edge. Fixed Helvetica/WinAnsi and text-fit rejection remain explicit constraints. No imported annotation editing is implied.

Sources consulted: [PDF Association ISO 32000-2 clause 12 errata](https://pdf-issues.pdfa.org/32000-2-2020/clause12.html) and [Adobe Acrobat SDK annotation properties](https://opensource.adobe.com/dc-acrobat-sdk-docs/library/jsapiref/JS_API_AcroJS.html). The surfaced ISO 32000-1 download returned 404; no full-spec download is claimed.

## ADR-012 — local reusable markup presets
Keep reusable tool/style/content definitions separate from document annotations and their geometry/reviewer/lock state. Validate via the existing annotation style schema using synthetic geometry. Use versioned bounded JSON with canonical whitelisted fields and unique IDs/names. Persist only on explicit save/import/replace/delete, with read/validation/quota errors preserving prior data. Compare the stored baseline before writes to reject stale-tab overwrites; no distributed concurrency guarantee is implied. Applying fills drawing controls and deselects existing annotations. localStorage is a small local library, separate from opt-in PDF IndexedDB recovery; no credentials or mandatory cloud service. See docs/MARKUP_PRESETS.md.

## ADR-013 — visual review stamps
Use standard /Stamp annotations with one of the 14 PDF stamp /Name values and independently authored normal appearances. Add a stampName discriminator required only for stamp annotations, preserved by annotation/recovery/preset canonicalization. Blank contents displays the standard name; custom text uses Helvetica-Bold with bounded 8–36pt fitting and explicit failure rather than clipping. Flatten draws the same appearance. Preserve immutable source content and unrelated annotations. Reports include the stamp appearance (CSV appends column 18). Do not create AcroForm signature fields or imply verified identity/engineering approval. Image assets, dynamic fields and cryptographic signatures remain separate open requirements. Source and limits: docs/STAMPS.md.

## ADR-014 — flat same-page authored annotation groups
Represent membership with optional validated groupId on each markup; a group contains at least two members on one page. Keep geometry, text, authorship and status per member. Pure validated selection operations expand complete groups, reject locked members except explicit unlock and return immutable candidates for the existing materialize-before-commit flow. Group movement translates callout leaders along with shape geometry. Preserve memberships through existing history/recovery/page remapping. Export input-order first member as primary (no IRT/RT); subordinates link directly via IRT and RT Group. Flatten retains appearances, not editable grouping. Add group IDs to reports. Presets remain geometry/group independent. Nested groups, layers, canvas transforms and concurrent collaboration are later work; no interactive independent viewer certification implied. See docs/MARKUP_GROUPS.md.

## ADR-015 â€” authored optional-content layers
Represent authored layers as bounded workspace metadata and optional annotation layerId references. Keep complete groups on one layer; validated group-expanded assignment/removal is atomic. Layer edit locks block member edits, including annotation unlocking, while visibility stays independently adjustable. Persist metadata in history/recovery and report columns 20â€“23. Export real PDF OCG memberships/defaults while preserving source configurations; flatten using optional marked content. Do not conflate edit locks with the PDF configuration Locked visibility array. Hidden content remains retrievable and is not redacted. See docs/MARKUP_LAYERS.md and executed validation in TEST_RESULTS.

## ADR-016 â€” non-destructive markup review queries
Use a pure query over canonical workspace state for combined text/page/tool/status/layer/effective-lock filters and stable sorting. Preserve underlying order and mark references; source/export/history data is never rewritten by a view query. Status ordering is Open, Accepted, Rejected; natural string sorting uses explicit English collation and stable ties in either direction. Excluded selections remain selected and group actions include complete groups; the UI explicitly counts excluded selected members. Reports retain full-document scope and order. Session-only filters are not stored in PDF/recovery/presets; a missing active layer resets its filter. See docs/MARKUP_REVIEW.md and actual validation in TEST_RESULTS.

## ADR-017 â€” bounded annotation-local discussion trees
Store optional comment arrays on each authored markup; each reply references an earlier comment in that same thread. Canonicalize Unicode metadata defensively, cap per-thread/global counts and text, reject dangling/cyclic/forward parents and preserve legacy absent fields. Pure validated CRUD targets one annotation even inside a group, respects annotation/layer locks and updates atomic history/recovery. Export Text annotations with IRT/RT R distinct from group RT Group, NoView and no Print bit; preserve source annotations and avoid visible note icons. Flatten removes authored reply objects, with explicit user-facing retention guidance. Reports append count/complete JSON as columns24/25 and paginate PDF evidence; existing PDF report font limitations remain explicit. Local display names are not authenticated identities or immutable audit records. See MARKUP_COMMENTS and TEST_RESULTS.


## ADR-018 - preservation-aware page assembly
Reuse original catalog/page references for complete single-source permutations; materialize inherited attributes before reparenting and remap page labels/local numeric destinations. Do not regenerate form appearances. Other assemblies retain Info/XMP from the first used source in source-map order with automatic metadata updates disabled. Source dates are provenance, not an edit audit. Direct structural protection guards apply. Arbitrary catalog semantics and partial/multi-source catalog remapping remain open. See docs/PAGE_ORGANIZATION.md.


## ADR-019 - read-only raster revision review
Use existing PDF.js display rendering of isolated immutable snapshots and a deterministic bounded pixel comparator. Compare all translated page extents over white; preserve source bytes, markup/measurement/history state. Require explicit physical-point translation and record nearest-pixel application, dpi, threshold, source SHA-256, page geometry and renderer version. Default source PDF layer settings apply, not viewport toggles. Suppress cancelled/stale publication and export races. Provide PNG, physically sized raster PDF with attached evidence JSON and standalone JSON. No automatic engineering interpretation or silent measurement changes. Full automatic registration, batch matching, semantic changes, clouds, slip sheets and revision history remain separate work. No new dependency. See REVISION_COMPARISON and TEST_RESULTS.


## ADR-020 - reviewable local similarity alignment
Use pinned JSFeat0.0.8 MIT corners/ORB in a cancellable CPU worker, deterministic robust positive-similarity fit and explicit review/apply against immutable captured rasters. Do not silently transform source geometry or engineering calibration/measurements. Retain exact matrix/quality/source-hash evidence; manual editing invalidates proposal and acceptance. Full transformed union uses bounded inverse bilinear white sampling. OpenCV prebuilt runtime was rejected for dynamic Function/CSP incompatibility; no unsafe-eval or WASM permission added. Record old JSFeat maintenance risk, verified license-text hash override and copied distribution notice. Pre-optimize deferred JSFeat at development startup to avoid first-use page reload/data loss. See ALIGNMENT_ACCEPTANCE and TEST_RESULTS.

## ADR-021 — reviewed batch sheet comparison
Use unique normalized PDF labels or explicit page order, editable one-to-one pairs and transient candidate-bound approval of exact source snapshots. Sequential bounded raster results preserve per-sheet failures and unmatched pages. Export safe numeric PNG paths, attached-manifest raster PDF, formula-safe CSV and JSON ZIP using pinned fflate0.8.3 MIT. No automatic bulk registration or silent engineering edits. See docs/BATCH_REVISION_REVIEW.md; full original gate remains open.

## ADR-022 — content-only slip sheets and local revision journal
Retain base PageRef identity with optional immutable donor content reference, preserving full-base catalog/page references. Explicitly review authored-markup policy, require matching geometry for retention, clear replaced-page scale/takeoff and commit journal atomically. Hash exact pre-operation/current revision bytes; retain originals for undo/recovery. Donor optional-content/cross-page resource dependencies reject until merge acceptance exists. Journal is local evidence, not a tamper-proof audit. See SLIP_SHEET_REVIEW.


## ADR-023 — revision insertion with retained historical navigation
Tag donor-only pages as inserted, preserve full-primary page/catalog identity, remap numeric destinations and labels, retain all old annotations on old pages and visibly stamp superseded. Existing navigation continues to target old sheets. Clear selected old takeoff with explicit review; never transfer engineering values. Journal operation is backward compatible. See docs/REVISION_INSERTION.md. No new dependency.


## ADR-024 — source-bound saved revision plans
Use bounded versioned canonical JSON with exact current/revision SHA-256/page counts, operation/policy/reason and one-to-one selected mapping. No saved approval, workspace state, paths or document bytes. Reinspect sources, recalculate current impact and require fresh approval. Reject malformed/mismatched imports without replacing the prior plan. In-flight imports/settings changes cannot authorize stale edits. No new dependency. See docs/REVISION_PLANS.md.


## ADR-025 — isolated reviewed multi-file revision sets
Use browser-selected files/folders and metadata byte limits before PDF reads. Keep successful sequential inspections with explicit failures, unique normalized basename suggestions and editable one-to-one file/sheet mapping. Build fresh exact-source plans with transient approval; keep open workspaces and source files untouched. Process independent output copies sequentially, retain explicit per-job failure evidence and use numeric PDF ZIP paths plus formula-safe CSV/JSON. Cancellation invalidates publication at stage boundaries; encoded-byte caps are not peak-memory guarantees. Source PDF annotations/measurement labels may remain stale even with equal geometry; do not claim engineering-state clearing or transfer. No new dependency. See REVISION_SETS.

## ADR-026 — portable multi-file revision instructions

Canonical version 1 set plans compose existing source-bound single-document plans. Require a common operation/reason and retain policy, unique snapshots per side, 1–20 jobs and a 1 MiB UTF-8 import budget. Exclude approval, bytes, names, paths, results and execution state. Resolve every selected source uniquely by exact hash/page count before changing mappings; filenames/order are hints only during preparation. Import explicitly excludes unsaved drawings and revokes approval/output. Generation guards prevent delayed imports from overwriting later edits or authorizing execution. Resume mappings after reinspection, not execution progress. No runtime dependency added. See docs/REVISION_SETS.md.

## ADR-027 — reviewed raster difference clouds

Derive bounded eight-connected changed-pixel regions from the existing deterministic difference-color contract. Clip actual bounds to the base viewport before padding and invert its captured PDF.js transform, including comparison union origin. Offer at most 200 candidates; reject noisy overflow without partial proposals. Keep region preview separate from comparison export. Require individual selection, fresh approval and exact live source snapshot checks; commit ordinary cloud markups to the chosen base document atomically through existing preservation/history/recovery. Retain exact source/alignment/region evidence in annotation contents, with editable local provenance rather than engineering approval. Preserve calibration/takeoff unchanged. No new dependency. See DIFFERENCE_CLOUDS.
