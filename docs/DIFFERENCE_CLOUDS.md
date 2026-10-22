# Reviewed difference cloud annotations

Open two drawings and choose **Compare revisions**. Review pages, resolution, alignment, layer defaults and threshold. The comparison remains read-only until you explicitly add clouds.

1. Under **Difference cloud annotations**, choose a minimum changed-pixel count (1–1,000,000) and physical margin (0–36 points).
2. Choose **Propose difference clouds**. Eight-connected changed pixels form separate bounding-box candidates. The separate preview shows the difference image and numbered candidate boxes. Neither the proposal nor preview changes workspace state or comparison PNG/PDF exports.
3. Select each desired region. No region is selected automatically. Inspect the original drawing and alignment; pixel differences may reflect rasterization, source annotation appearances or unrelated edits.
4. Select **Approve selected difference clouds**, then **Add selected clouds to base drawing**. This adds standard authored clouds to the selected base document as one undoable edit, even if the revision tab is active. The revision document and stored takeoff/calibration are unchanged.

Selection changes revoke approval. Cloud-setting changes clear the proposal. Comparison source/page/resolution/threshold/manual alignment changes, closing, cancellation or starting/applying estimated alignment discard proposals. Before committing, both source documents must still be open with the same captured PDF snapshot and page count, and neither may be busy. Changed or closed sources require a new comparison. A successful commit makes the base snapshot stale, so another addition also requires a new comparison. Once the explicitly approved atomic workspace edit starts, closing the dialog does not cancel that edit.

## Coordinates and exports

Connected regions use the comparison union's output pixel coordinates. The engine applies the union origin, clips actual change bounds to the base viewport, adds the physical margin at the comparison resolution, and inverts the captured base PDF.js viewport transform. This handles the tested quarter-turn rotations, nonzero CropBox origins, UserUnit and union offsets. Completely off-base changes are excluded before margin expansion. Partly off-base regions are marked clipped. Candidate PDF rectangles are clipped to the base view box. Cloud lobes/stroke appearance can extend beyond the candidate rectangle; page edges can clip that appearance.

Clouds are ordinary editable red cloud annotations with an open review status. Each annotation's contents contain versioned JSON with exact pre-application base/revision hashes and pages, renderer/resolution, threshold, alignment, union origin, proposal settings, selected region geometry/pixel count and review time. The author is a local display label, not an authenticated identity. Retained evidence is editable and is not an immutable audit or engineering acceptance.

Existing markup properties, reports, PDF save/flatten, undo/redo and opt-in editable recovery apply. Cloud contents use ASCII metadata; names and document paths are not copied into cloud evidence. Comparison exports continue to describe their original snapshots and omit proposal boxes; save the base drawing to export clouds. PDF flattening removes authored annotation objects while retaining their visible appearance.

## Bounds and remaining acceptance

The existing comparison budget remains 4,000,000 output pixels and 8192 pixels per side. Proposal extraction allocates a one-byte mask and four-byte queue per pixel, plus a separate preview canvas; these limits are not peak-RAM guarantees. Extraction is synchronous and not interruptible mid-call. At most 200 eligible on-base regions are proposed. More regions reject the entire proposal; increase the minimum size or review threshold/alignment. Small and entirely off-base components are counted separately. A connected component's pixel count includes its original off-base portion even when its annotation bounds are clipped.

Regions use pixel connectivity, not object or semantic grouping. Nearby disconnected lines can produce many candidates; different components can have overlapping rectangles. Resolution/threshold/resampling change region detection. There is no automatic region merge, contour-shaped cloud, difference acceptance classification, batch cloud creation or quantity transfer. Large/noisy professional drawings, independent viewer corpus and aggregate performance remain open. No automatic engineering interpretation or completed full-product gate is claimed.

Current evidence is in TEST_RESULTS. Reproduce independent synthetic PDF checks with `scripts/independent-difference-cloud-check.py --check DIRECTORY` after the browser comparison test generates `TEMP/opendraft-difference-cloud-validation`. Python validation dependencies are isolated outside the application runtime.
