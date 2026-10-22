# Authored annotation layers

Use **Annotation layer** to choose the layer for new annotations. Create named layers, change their default visibility or edit lock, assign a selected annotation/group, or remove a layer while keeping its annotations. Removing a layer moves its annotations to the unlayered collection. Names are unique after normalization; the workspace supports at most 256 layers.

Layer assignments expand complete groups. Groups cannot span layers. A locked layer blocks annotation creation, changes, movement, assignment, deletion and individual/group unlocking. Unlock the layer first. Visibility can change while the layer is edit locked. This is a local editing control, not encryption or an authorization boundary.

Layer metadata and membership participate in atomic undo/redo and opt-in local recovery. Recovery remains unencrypted and undo history is session-only. Presets do not retain layer membership. Measurements are separate and are not assigned to annotation layers.

PDF export appends named optional-content groups, annotation `/OC` membership and default ON/OFF settings. Existing source optional-content configuration is retained during layout-preserving edits. Flattening removes the authored annotation objects but retains toggleable optional content in page drawing operations. Hidden content remains present: hiding and flattening are not redaction. The navigation panel's source-layer visibility controls affect only the current view; use authored-layer controls to save defaults.

An edit lock sets annotation lock flags. It does not set the PDF default configuration's `Locked` array, which governs visibility changes. See Adobe's [optional-content groups](https://opensource.adobe.com/dc-acrobat-sdk-docs/acrobatsdk/apireference/PD_Layer/PDOCG.html) and [optional-content configuration](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdflsdk/apireference/PD_Layer/PDOCConfig.html) references.

Markup CSV reports retain the first 19 columns and append Layer ID, Layer name, Layer visible and Layer edit locked as columns 20–23. PDF reports include the same metadata. Foreign source annotations/layers are not imported into this editable layer model. Structural page assembly, broad viewer interoperability, concurrent collaboration, managed permissions and production release acceptance remain open. Consult TEST_RESULTS.md for executed checks and limitations.

Verified compatibility limitation: PDFium 5.14.0 ignores authored annotation visibility in this fixture, even with /OC on the annotation and its appearance Form. Hidden flattened content works. PDF.js passes hidden/toggle tests. A saved hidden annotation can appear in another viewer; independent interoperability acceptance remains open and the validation script reports failure.

Update: appearance-stream optional-content wrapping resolved the tested PDFium visibility failure. The unchanged independent checker now passes14/14 on rotations0/90, including both hidden output paths. Broad viewer acceptance remains open; the preceding failure describes the intermediate implementation.

Comment reports append count/complete JSON as columns24–25 after layer columns20–23. Authored thread export follows its owning annotation's layer and locks; see MARKUP_COMMENTS.md.
