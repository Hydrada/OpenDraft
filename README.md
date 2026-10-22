# OpenDraft · open-source software suite

OpenDraft is the first project in a sequential program for construction PDF workflows. **Release candidate 0.1.0 awaiting owner acceptance** — see [completion gate](docs/COMPLETION_GATE.md); no license has been selected, so nothing is published. Later GIS, document and construction-management products remain planning only.

## Run locally
Use Node 24 (verified: 24.18.0) and npm; tests use native TypeScript stripping.

```powershell
npm ci
npm run dev
```

Open the printed localhost URL. PDFs stay in the browser. Select an authorized PDF, navigate/search, rotate a page and download a new PDF. Keep the source document. Static assets can be built with `npm run build` and served from apps/opendraft/dist using an ordinary static server; deployment hardening remains pending. Development server binds loopback.

Current Phase 1 tools include page move/delete/insert/extract, undo/redo, selectable text, bookmarks, safe links, attachment downloads and view-only layer toggles. Recovery is off by default; opt in to retain unencrypted PDF bytes on this browser, restore after reload, or delete the retained session. Recovery does not restore undo history. Full single-source reordering retains the source catalog; other assemblies retain primary-source Info/XMP but may omit bookmarks, forms, attachments and layers. See docs/PAGE_ORGANIZATION.md; keep originals. Printing is a bounded 108dpi raster workflow, not professional vector printing. Built-asset reference hosting: docs/STATIC_HOSTING.md.

Initial markup tools include rectangles, ellipses, lines, arrows, highlights, ink, text, callouts, revision clouds and text-based review stamps, with editable properties, sorting/structured filtering, locking and authored-markup flattening. Authored same-page [markup groups](docs/MARKUP_GROUPS.md) support atomic property, move, lock/unlock, delete and ungroup actions. Source annotations are displayed but not imported into the editable list. Signed/certified, encrypted and XFA rewrites are refused; this is not cryptographic signature validation. Rotation/markup-only exports preserve the original catalog in tested fixtures.

Authored [annotation layers](docs/MARKUP_LAYERS.md) support visibility defaults and edit locks. The [markup review list](docs/MARKUP_REVIEW.md) provides combined filters, stable sorting and explicit counts for selections outside filtered results. List controls do not change PDF bytes or report scope.

Local [comment threads](docs/MARKUP_COMMENTS.md) support replies, editing, subtree deletion, standard PDF reply export, reports and editable recovery; they are not authenticated collaboration.

Text-based [review stamps](docs/STAMPS.md) support standard names and custom labels; they do not create verified digital signatures.

Reusable markup presets can be saved locally and transferred using versioned JSON; see [preset instructions](docs/MARKUP_PRESETS.md). Preset contents are retained unencrypted separately from PDF recovery.

Windows desktop development packaging: run `npm run desktop:runtime`, then `npm run desktop:package`. Unsigned installer/ZIP files appear under desktop/artifacts. Read docs/DESKTOP_PACKAGING.md for tested evidence and pending installer acceptance. Automated desktop tests launch only hidden, unfocusable windows; they do not execute the installer.

## Verify
```powershell
npm run build
npm test
npm run desktop:runtime
npm run test:e2e
npm audit
npm run audit:licenses
```

npx playwright install chromium firefox webkit
node scripts/benchmark-acceptance.mjs      # performance gate, writes docs/PERFORMANCE_ACCEPTANCE.md
node scripts/release.mjs                   # reproducible web + self-host archives in release/<version>
./scripts/installer-lifecycle.ps1 -Installer <old.exe> -Upgrade <new.exe> -UpgradeVersion <v>
```

Read MASTER_ROADMAP.md, DECISIONS.md, TASKS.md, TEST_RESULTS.md, DEPENDENCIES.md and KNOWN_LIMITATIONS.md before resuming work. Research is in docs/research; phase acceptance criteria in docs/PHASE_1_ACCEPTANCE.md. No external publication/license selection has occurred.

Drawing revision review: choose two open pages for a read-only color overlay or pixel difference view with manual translation/scale/rotation, reviewed local automatic alignment, sensitivity and resolution controls. Export PNG, raster PDF with attached JSON evidence, or JSON with exact source hashes. See [revision comparison](docs/REVISION_COMPARISON.md) for limits; broad alignment acceptance, perspective registration and shared revision history remain open. Reviewed multi-sheet comparison reports are described in [batch revision review](docs/BATCH_REVISION_REVIEW.md).

Reviewed slip sheets support drawing replacement and [revision insertion with superseded stamps](docs/REVISION_INSERTION.md), local operation journals, undo/redo and editable recovery. [Saved revision plans](docs/REVISION_PLANS.md) export/import exact-source sheet mappings as bounded JSON and require fresh impact approval. These workflows do not provide shared project history or server collaboration.


Standalone [drawing revision sets](docs/REVISION_SETS.md) accept current/revision PDF files or folders without opening tabs, prepare reviewed file/sheet mappings, and download sequential replacement/insertion results with per-job ZIP evidence. Source files and open workspaces are unchanged. Retained PDF measurement labels may be stale; independently review/calibrate new sheets. Encoded-byte limits are not RAM guarantees, and cancellation is checked between processing stages. See TEST_RESULTS for actual acceptance evidence; the full product remains in development.

Use **Save drawing set plan** to transfer selected mappings as JSON. Reselect and prepare the exact PDFs, then **Import drawing set plan** to resume; file order/names may change, but PDF hashes/page counts must match uniquely. Every import requires fresh review and approval. Execution progress and PDFs are not saved in plans.

After comparing revisions, [propose difference clouds](docs/DIFFERENCE_CLOUDS.md), select individual visual change regions and approve them to add clouds to the base drawing as one undoable edit. Clouds retain source/alignment evidence and preserve takeoff; they do not verify engineering changes.

## Measurements and takeoff
Picked points snap to existing measurement points and to painted drawing line endpoints, segment midpoints and line intersections (opt-out), Shift constrains horizontally/vertically. Measurements may carry a derived quantity (multiplier × waste) and reusable presets. **Export PDF with measurement annotations** writes standard Line/PolyLine/Polygon dimension annotations with a /Measure scale to a copy.

## Collaboration and self-hosting
Run the self-hosted server (`node server/collab-server.mjs serve`, see [SELF_HOSTING](docs/SELF_HOSTING.md)) to share markups, layers and takeoff between users with roles, presence, conflict review, offline queueing, a tamper-evident audit log and backups. Details and limits: [COLLABORATION](docs/COLLABORATION.md).

## Optional assistant
The sheet-index assistant proposes sheet numbers/titles locally on the CPU; an optional local model can be configured on the server (`OPENDRAFT_AI_URL`, `OPENDRAFT_AI_MODEL`). Suggestions are reviewed row by row and exported as CSV or bookmarks in a copy; they never change drawings, markups or measurements.
