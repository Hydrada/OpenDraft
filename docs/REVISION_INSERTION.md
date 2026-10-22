# Reviewed revision insertion

Choose Replace revised sheets, then Revision operation → Insert revision before old sheet and stamp old sheet superseded. Select the revision PDF and label/order pairing, review manual one-to-one pairs, enter a reason and approve the impact. Each selected revision is inserted immediately before its matched old page. Other donor pages are omitted.

Old sheets retain their annotations and receive an editable red SUPERSEDED stamp with an independently generated appearance. The PDF standard stamp name is Draft, with explicit SUPERSEDED contents and appearance; this is a visual revision marker, not a digital signature or engineering approval. The stamp is centered in the old CropBox, bounded to 240×60 PDF units, with a minimum readable box of 90×28; smaller pages reject before commit. It may cover drawing content and must be visually reviewed. Existing locked notes remain unchanged. No annotation copy to the new drawing is performed.

Selected old-page calibrations and measurements are removed after explicit impact approval. Unaffected takeoff and all existing authored annotation page indices are remapped. New sheets receive no old engineering values. Recalibrate and independently verify every new drawing before takeoff. Undo restores the whole prior workspace, including takeoff and journal; redo reapplies it. Opt-in local recovery restores current editable state, not undo history.

## PDF preservation contract

Inserted PageRefs are tagged inserted:true with an optional explicit label. The engine retains the primary catalog and original page objects when all noninserted references cover every primary source page exactly once. This includes repeated revision insertion and donor-content replacement. Existing page-reference links remain bound to old sheets; numeric local destinations are remapped to their new indices. Bookmarks and links are not redirected to newer sheets. Original labels retain their numbering; inserted labels use the donor label or Revision page N. Labels are limited to 1000 characters and encoded as Unicode PDF strings.

Donor content, resources, geometry and transparency groups are copied; donor annotations, forms, actions and navigation are excluded. Donor optional-content configurations and unrelated-page resource dependencies reject. Signed/certified-looking, encrypted and XFA rewrites reject under the existing structural guard. This is not cryptographic verification. Partial extraction and multi-base merges retain documented weaker catalog/label preservation. Tagged-PDF semantics and broad real-world interoperability remain unverified.

Both source inspection limits remain 64 MiB and 200 pages; select at most 100 pairs per operation. An insertion may create more than 200 pages, but a subsequent slip-sheet review will then reject at the inspection limit. Recovery supports up to 20000 modeled pages with existing source/byte limits; that capacity is not a rendering performance claim.

## Operation evidence and validation

Revision journal operation is insert-before; legacy entries without operation mean replace. Historical target/revision page numbers, source SHA-256, reason and cleared counts survive undo/redo and recovery and export to JSON. The journal is mutable local evidence, exported separately from a saved PDF; it is not server audit history or a cryptographic record.

Unit tests validate insertion order, immutability, Unicode labels, navigation, donor exclusion, repeated materialization, schema, takeoff remapping and history. Browser tests cover differing donor geometry, old markup placement, superseded annotation, explicit takeoff removal, journal export, undo/redo and IndexedDB recovery. Independent pypdf/PDFium/Pillow checks compare full content rasters with annotations suppressed and separately verify stamp structure and visible red appearance. Exact execution counts are in TEST_RESULTS.md.

Multi-file/folder sets, saved revision plans, region matching, automatic annotation transfer/alignment, archival revision browsing, shared history and production-scale performance remain open. This milestone does not satisfy the full Project 1 gate.

Reference: [Bluebeam Batch Slip Sheet manual](https://support.bluebeam.com/no/dk/user-manual/menus/batch/slip-sheet.html), reviewed 2026-10-21, documents insertion before current pages and superseded stamping. Code, UI and stamp appearance are independently created.
