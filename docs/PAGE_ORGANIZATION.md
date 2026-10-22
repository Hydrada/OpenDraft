# Preservation-aware page organization

Full single-source permutations reuse the original document and page references. Inherited Resources, MediaBox, CropBox and Rotate values are materialized before page reparenting. Page-label ranges and tested numeric local destinations are remapped to the new order; reference destinations continue pointing at the same pages. Remote GoToR destinations remain unchanged. Form appearances are not regenerated during save.

Extraction, deletion, duplicate-page assembly and multi-source merging copy pages into a new document. They preserve Info and XMP from the first used source in the caller's source-map insertion order, even when the first output page belongs to another source. Absent metadata remains absent. Bookmarks, forms, attachments, source layer configuration and other catalog structures are not promised for these assemblies.

Source bytes remain immutable. Source Producer, dates and custom metadata are retained; these dates do not constitute an OpenDraft edit audit. Direct assembly rejects apparent signed/certified, encrypted and XFA documents through the structural editing guard. This is not cryptographic signature validation.

The implementation follows pdf-lib's documented [page operations](https://pdf-lib.js.org/docs/api/classes/pdfdocument) and disables automatic metadata updates using [updateMetadata](https://pdf-lib.js.org/docs/api/interfaces/createoptions). No dependency was added.

## Acceptance evidence and limits

Synthetic fixtures cover bookmarks, named/reference/numeric local destinations, remote destinations, attachments, form values/widgets, optional-content defaults, nested inherited page attributes, page labels, Unicode custom Info and XMP. Independent pypdf/PDFium validation passed 63 checks, including 11 exact raster comparisons. Browser tests exercise navigation, downloads, layers, undo/redo and metadata after extraction/insertion.

This is not general PDF conformance certification. Arbitrary catalog semantics, opaque JavaScript destinations, malformed structures, tagged-PDF structure trees, article threads and a broad professional document corpus remain acceptance work. JavaScript is not executed to infer destination behavior. Unsupported remapping structures may fail explicitly. Partial and multi-source catalog remapping remains open.

Reproduce with npm test, npx playwright test tests/e2e/organization-preservation.spec.ts, scripts/generate-organization-validation.mjs and scripts/independent-organization-check.py. Independent scripts require separately installed pypdf and pypdfium2; consult TEST_RESULTS for recorded versions and results.
