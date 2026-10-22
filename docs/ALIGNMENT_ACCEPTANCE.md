# Reviewable drawing alignment

After comparing two pages, choose **Estimate alignment**. The local worker looks for shared drawing features and proposes a uniform scale, clockwise rotation and translation from revision pixels to base pixels. The current comparison remains unchanged until **Apply alignment to comparison**. Discarding a proposal leaves the current comparison and evidence unchanged.

Proposals are bound to the exact captured rasters. Changing document/page, resolution, threshold or alignment inputs invalidates the result and proposal. Apply operates on those captured snapshots, not a fresh document load. Cancel/close/input changes terminate the worker and suppress late messages. A 15-second timeout terminates estimation. No source PDF, calibration, takeoff quantity, markup, history or recovery model is modified. Review timestamps describe a local visual action, not authenticated engineering acceptance.

## Coordinates, resampling and evidence

The six-number matrix [a,b,c,d,e,f] maps displayed revision coordinates to base coordinates: x'=a*x+c*y+e, y'=b*x+d*y+f. Coordinates refer to outer page rectangles; pixel centers are x+0.5,y+0.5. Uniform scale/clockwise rotation use the displayed top-left origin, then translation. PDF.js supplies each page's rotation/CropBox/UserUnit before alignment.

Manual scale supports0.1–10 and rotation within±3600degrees. Manual offsets round to the nearest raster pixel, as recorded in evidence. Automatic candidates retain fractional translations and use bilinear resampling. After applying an estimate, controls show its values; editing a control or explicitly running Compare again starts manual review, rounds manual offsets and removes automatic-review evidence. It may therefore produce slightly different edge pixels.

The output union includes all four transformed revision corners and the base rectangle, rounded outward to integer pixel bounds. Bilinear sampling uses the inverse transform and white-composited source pixel centers; taps outside the revision are white. Identity/integer translation retains exact existing comparison behavior. The general transform API rejects reflection/collapse, principal scales outside0.1–10, excessive offsets, invalid storage and input/output budgets before output allocation. Output comparison bounds remain output pixels; the union origin locates them relative to the base.

Exports include the applied matrix, resampling rule, scale/rotation, point/pixel translation, proposal method/consensus/residual/coverage and local review timestamp/scope. Source hashes and page/render metadata remain tied to the captured PDFs. Evidence JSON is also attached to the raster PDF. Resampling can generate visible edge differences even when source linework matches.

## Estimator and quality gates

JSFeat0.0.8 supplies YAPE06 corners, image resampling, Gaussian blur and ORB descriptors. Six pyramid levels use at most600features on previews with maximum640pixels per side. Mutual Hamming matching uses a0.8ratio test and distance below72; near-duplicate pyramid points do not count as independent support. A deterministic robust fit estimates positive-orientation similarity, followed by least-squares refinement.

A candidate needs at least8inliers,45%inlier ratio,8%bounding-box coverage in both drawings, support in at least4cells of the base3×3grid, and residual at most2.5/previewScale full-resolution pixels. Candidate scale is restricted to0.25–4. Support tolerance is3/previewScale pixels. These gates reject tested blank, unrelated, sparse/localized or inconsistent inputs; they are not a probability of correctness. Repeated symbols, scan artifacts, cropped/occluded content or substantial revisions may produce wrong suggestions or rejection. Review the overlay against original drawings.

Input/union limits remain4,000,000pixels and8192per side; each PDF snapshot is capped at64MiB. Resource caps are per run, not an aggregate RAM guarantee. Estimation runs on CPU in a terminable local worker. Applying/warping/comparing is bounded synchronous work and cannot be interrupted mid-loop. Perspective, shear/nonuniform automatic registration, automatic batch pairing and a broad professional drawing corpus remain open.

## Dependency decision

The [JSFeat repository](https://github.com/inspirit/jsfeat) and its installed0.0.8LICENSE identify the MIT grant, Copyright(c)2012EugeneZatepyakin. This old release has no established present-day security-maintenance commitment. The dependency is pinned; raster dimensions/features/worker lifetime are bounded, and current npm audit is recorded separately. These mitigations do not replace release security review.

Published package.json omits license metadata. docs/research/LICENSE_OVERRIDES.json records the inspected license text's exact SHA-256 and source. The inventory accepts that exact reviewed version/text only; a hash mismatch fails. Desktop packaging copies the license. Preserve the notice/license text in distributions.

The source also contains upstream credits for BSD qsort (Regents of the University of California,1992/1993), FAST (Edward Rosten), YAPE (Computer Vision Lab,EPFL,2007;Vincent Lepetit) and OpenCV ORB authors. Browser/desktop assets retain the full unminified source as a text notice so minification does not discard those credits. Exact inherited licensing/provenance obligations remain a release-review blocker; the package-level MIT inventory is not complete clearance.

The researched [OpenCV.js package](https://github.com/TechStark/opencv-js) uses dynamic Function construction in its prebuilt runtime. It was not selected or bundled because that build conflicts with the existing strict CSP. [OpenCV's license](https://opencv.org/license/) is Apache2 for current versions; licensing was not the rejection reason. No unsafe-eval, WASM permission, remote service, cloud account or GPU requirement was introduced.

## Acceptance and reproduction

Synthetic tests cover known translation, rotation, scale, combined transformations with actual local changes, orientation/pixel-center conventions, immutable inputs, rejected geometry/storage/budgets, blank/unrelated rejection and deterministic estimation. Independent validation checks transformed output against a Python bilinear oracle (at most1channel-value rounding tolerance) and known transform landmarks. The browser suite checks proposals remain unapplied until explicit action, discard, stale/cancel paths, manual transforms, physical PDF output, source preservation and the built worker under strict CSP. Actual counts and any intermediate failures belong in TEST_RESULTS.

Run npm test and npx playwright test tests/e2e/alignment.spec.ts tests/e2e/revision-comparison.spec.ts tests/e2e/production.spec.ts. Independent fixtures:

1. node scripts/generate-alignment-validation.mjs <folder>
2. python scripts/independent-alignment-check.py <folder> --render
3. node scripts/generate-alignment-validation.mjs <folder> --run
4. python scripts/independent-alignment-check.py <folder> --check

Python requires separately installed pypdfium2 and Pillow. Only authorized synthetic drawing data is generated. These fixtures do not establish arbitrary drawing accuracy, perspective registration, semantic change detection or the full OpenDraft gate.
