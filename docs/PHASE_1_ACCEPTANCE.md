# Phase 1 acceptance plan

Targets below are **planned**, not benchmark results. Test synthetic and authorized PDFs only. Retain independent expected fixture metadata/text/render references.

| Workflow | Acceptance evidence |
|---|---|
| Open/render | Two-page text/vector fixture shows nonblank canvases; invalid inputs show recoverable error; original bytes unchanged |
| Tabs/thumbnails | Two documents retain independent active page/rotation; thumbnail click changes correct page; close during render is safe |
| Navigation | Zoom/rotation/page controls update canvas; keyboard reachable; pan works in overflow; bounds enforced |
| Search/text | Known text found on correct page; absent text reported; extraction preserves known strings; selection verified separately |
| Save/edit | Rotate selected page, export, reopen in independent engine; expected page dimensions/count/text and rotations; unchanged other page |
| Organization | Insert, extract, reorder and merge produce expected page identity/order in independent parser/viewer |
| Undo/recovery | Undo/redo round trip across edits; forced reload recovers pending edits; storage quota failure leaves original safe |
| Print/export | Independent viewer print preview, all pages/orientations; export annotations round trip when implemented |
| Metadata | Bookmarks/links/optional content/attachments tested with dedicated fixtures; unsafe actions never auto-execute |
| Performance | Proposed Windows 16GB CPU baseline: 36x48 inch vector first page <=3s, warmed navigation <=500ms, 200-sheet set no crash, <=1GB working memory at fit-page; document hardware, browser, corpus, p50/p95 over 20 runs |
| Security | No uploads/scripts/automatic external links; corrupted/encrypted inputs handled; dependency audit; static host CSP and hostile PDF review |

M0 only exercises the implemented viewer and rotation/export subset. Full Phase 1 also requires every remaining row plus regression and accessibility review. Later measurement gate: independent reference geometry <=0.1% relative error with defined absolute epsilon and unit/calibration fixtures; refine with owner before engineering use.
