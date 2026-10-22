# Reviewing the markup list

The markup list supports combined text, page, tool, status, layer and edit-lock filters. Text search is literal and case insensitive, with Unicode normalization. It searches reviewer names, contents, tool/stamp names, status, group IDs, markup IDs, layer names, comment authors/bodies/IDs and displayed page numbers. It does not execute regular expressions or document text.

Choose **Current page** to follow page navigation, or **All pages** to review the document. A hidden annotation layer remains available in the list. **Edit locked** includes annotations locked individually or by their owning layer; **Editable** excludes both.

Sort by document order, page, author, status, tool, creation time, modification time or layer. Ascending statuses are Open, Accepted, Rejected. Author/tool/layer text uses English natural-number collation, so Reviewer 2 precedes Reviewer 10. Equal values retain document order in either direction. Document order ignores the direction setting. Unlayered annotations sort as an empty layer name.

The count shows matching annotations and the total. List controls affect only the view: they do not reorder stored annotations, edit the PDF, add undo commands or limit CSV/PDF reports. Reports continue to include every authored annotation in document order. **Reset markup list controls** clears all filters and restores document order without clearing the selection.

Selection survives sorting and filtering. Group actions include complete selected groups, even members excluded by the current filters. The selection summary explicitly counts selected annotations outside the filtered list. **Clear markup selection** clears this selection independently of the filters. Layer and annotation locks continue to apply.

Controls are session-only and shared by open tabs. The current-page filter follows the active document; a layer filter resets to All layers if that layer no longer exists in the active workspace. Controls are not saved to PDFs, presets or recovery. Saved filter views, filtered-report exports, editable foreign annotation/comment import, authenticated collaboration, broad browser/screen-reader acceptance and large-list benchmarks remain open.

Validation evidence is in TEST_RESULTS.md. Query model tests cover combined filters, literal/Unicode text, effective locks, malformed options, stable ordering and immutable input. Browser tests verify navigation, real PDF byte preservation, full-report scope, group selections outside results and effective layer locks.
