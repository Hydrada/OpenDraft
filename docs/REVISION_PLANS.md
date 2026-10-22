# Saved revision plans

In Replace revised sheets, prepare a plan, choose reviewed sheet mappings and operation, and enter a reason. Save revision plan JSON downloads an OpenDraft version 1 plan. Approval is never saved. To reuse it, open the exact current and revision PDF snapshots, activate the current document, select the revision PDF and use Import revision plan JSON. Import restores the selected mapping and operation, inspects both PDFs again and recalculates the current impact. Review and approve before Apply reviewed replacements. A successful import does not edit either PDF or create an undo entry.

## Format and validation

Schema opendraft.revision-plan, version 1 contains canonical creation time, base/revision SHA-256 and page counts, operation replace or insert-before, authored-markup policy retain/remove, a 1–1000-character reason and 1–100 positive one-to-one sheet pairs. Each source must have 1–200 pages. Omitted current pages remain unchanged. Insertion requires retain because old annotations stay on old pages. Unknown fields are stripped; document bytes, paths, names, approval flags and current markup/takeoff state are not part of the format.

Import checks the file size before reading and the actual UTF-8 text size before JSON parsing, capped at 256 KiB. Invalid schema/version, malformed JSON, invalid timestamp/hash/count/pair values and duplicate mappings reject. Exact source hashes and counts must match the current snapshots. Even a visually identical PDF saved with different bytes requires a newly prepared plan. This protects page mappings from silently applying to different revisions; it does not establish trust in the plan author or cryptographic authenticity.

A rejected import preserves existing documents, mappings and settings and revokes prior approval. Imports/inspection cannot reuse approval; settings edits or dialog closure invalidate pending imports. Applying is blocked while file decoding or source inspection is pending. Current locks, authored state, geometry requirements, affected calibration/takeoff removal and source-snapshot checks still run before commit. The saved plan contains instructions, not permission to edit.

Plans may disclose their reason and document fingerprints; share them according to the source project's requirements. They do not embed the PDFs. No plan upload, automatic path resolution, cloud account or new dependency is involved.

## Scope and acceptance

This is independently defined OpenDraft JSON, with no BCX interoperability claim. The two-open-PDF slip-sheet workflow is supported; folder sets, multi-document execution, batch-comparison plan reuse, plan libraries, fuzzy source rebinding, migrations beyond version 1 and shared approval/history remain open. Source inspection and rewrite limitations in SLIP_SHEET_REVIEW and REVISION_INSERTION continue to apply.

Unit tests cover canonical round trips, Unicode, known-field isolation, source binding, schema/page/pair bounds, prototype baggage and the exact UTF-8 limit. Browser tests exercise actual exported JSON, rejected imports preserving prior plans/PDFs, fresh approvals, real replacement/insertion output and delayed file-read cancellation. TEST_RESULTS records the exact executed results.

Feature research: [Bluebeam Batch Slip Sheet manual](https://support.bluebeam.com/no/dk/user-manual/menus/batch/slip-sheet.html), reviewed 2026-10-21, documents saved batches in its own BCX format. OpenDraft uses its own bounded JSON contract and independently implemented UI.
