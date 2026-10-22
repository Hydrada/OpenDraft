# OpenDraft Project 1 completion gate — acceptance package

Prepared 2026-10-21 for owner review. Gate text (MASTER_ROADMAP): *All committed features pass end-to-end tests; annotations/rendering verified in independent viewers; measurements meet defined tolerances; concurrent editing/reconnect/offline tests pass; large-format performance targets pass; security/license/regression checks pass; Windows installation and self-host deployment tested; documentation and reproducible package exist. Unsupported features require explicit owner approval. Partial parity is never complete.*

Status: **every technical clause has passing evidence; the gate is NOT closed** until the owner decisions in the last section are made. Projects 2–4 remain unstarted.

| Gate clause | Evidence (all executed 2026-10-21 on this machine) | Status |
|---|---|---|
| All committed features pass end-to-end tests | Final run on one code state (2026-10-22): unit/integration **263/263**; browser + hidden desktop **115/115** (4.0 min); Cua runs in the packaged desktop app (navigation, search, calibration, measurement incl. snapped 300 ft², markups incl. mouse-drawn cloud, saves through native dialogs, redaction, signature verification, annotation import). | Pass |
| Annotations/rendering verified in independent viewers | Independent pypdf 6.21.1 / PDFium 5.14.0 / Pillow checkers across increments (render 154/154, slip 45/45, insertion 114/114, difference clouds 16/16, measurement annotations); PDF.js re-read of exported bookmarks/measurements in unit tests. Synthetic and authorized fixtures only. | Pass (scoped corpus) |
| Measurements meet defined tolerances | MEASUREMENT_ACCEPTANCE (≤0.1 % relative error target with independent geometry); exported /Measure factor reproduces 20 ft exactly in pypdf. | Pass (synthetic references) |
| Concurrent editing / reconnect / offline | COLLABORATION.md. Server integration 3/3 (merge, same-item conflict, idempotent retry, RBAC, invalid-state rejection, SSE, presence, audit tamper detection, backup/restore, rate limit); client-vs-real-server 2/2 (live convergence, offline queue, reconnect conflict + explicit resolution, reload/rejoin rebase), stable over 5 repeated runs; browser e2e 2/2 with three users and network-offline emulation. | Pass |
| Large-format performance targets | PERFORMANCE_ACCEPTANCE.md: 20 runs, 36×48 in sheets with 2,000 vectors: first page p95 ≈ 281 ms (≤3 s); warmed navigation p95 ≈ 173 ms (≤500 ms); 200-sheet set traversed, 0 errors; peak browser working set 0.87 GiB (≤1 GiB), two consecutive passing runs. Two memory leaks fixed to get there (thumbnail re-rendering, unreleased canvases: 8.7 → 0.87 GiB). | Pass — on a 64 GB / Ryzen 7800X3D host, not the proposed 16 GB baseline machine |
| Security checks | npm audit (runtime) 0 vulnerabilities; hostile-PDF e2e (JavaScript OpenAction/name tree, Launch, SubmitForm, javascript: URI, 100 MB Flate bomb, 100k-deep nesting) — no dialogs, requests, popups or navigation, app recovers; existing unsafe-action, encrypted/XFA/signed-rewrite refusal tests; strict CSP on every host; scrypt auth, bearer tokens, RBAC, rate limiting, audit hash chain. | Pass (no third-party penetration test) |
| License checks | `node scripts/licenses.mjs`: 11 runtime packages, 0 unknown licenses; notices shipped in installer (11 files verified installed). **Project license not selected** (owner). | Pass except owner item |
| Regression checks | Same final full run as row 1. | Pass |
| Accessibility (Phase 1 plan) | Cross-browser e2e Chromium/Firefox/WebKit 3/3: no unnamed controls (empty and populated states), keyboard activation, tab order, visible focus, status/alert/main landmarks, lang. Real Windows UI Automation tree of the desktop app read with Cua Driver (background, never activated): 148 elements, 0 unnamed buttons/edits/combos/checkboxes/spinners. A WebKit rendering failure was found and fixed (ReadableStream iteration polyfill). | Pass — no manual NVDA/JAWS/VoiceOver session |
| Windows installation tested | `scripts/installer-lifecycle.ps1` **16/16 PASS** on the 2026-10-22 build (SHA-256 5AA40030…6D5B): silent per-user install, licenses, registry, Start Menu, hidden smoke, upgrade 0.1.0→0.1.1 with user data preserved, smoke again, silent uninstall removing exe/registry/shortcut (user data retained by design). Installer is **NotSigned**. | Pass except signing (owner) |
| Self-host deployment tested | Release archive extracted to a clean folder, `npm ci --omit=dev` (0 vulnerabilities), users created by CLI, server started, collaboration e2e **2/2** against the extracted copy. SELF_HOSTING.md. | Pass |
| Documentation and reproducible package | `node scripts/release.mjs`: web + self-host archives byte-identical across a clean rebuild (SHA256SUMS, release-manifest.json). README, SELF_HOSTING, COLLABORATION, STATIC_HOSTING, DESKTOP_PACKAGING, KNOWN_LIMITATIONS. Desktop installer bytes are not reproducible (NSIS timestamps); its hashes are recorded instead. | Pass (archives); installer reproducibility not claimed |
| Optional reviewable AI, CPU default, never silently change measurements (M6) | Sheet-index assistant: deterministic CPU engine default, optional Ollama-compatible model only via the self-host server (auth required, output schema-validated, 502 on bad output); proposals never auto-applied; exports are copies; e2e asserts saved document bytes unchanged. 4/4 unit + 1/1 e2e. | Pass |

## 2026-10-22 Revu-parity additions
Annotation import (editable), true redaction, automatic sheet links, radius/diameter/arc and area cutouts, image stamps, digital signatures (PKCS#12, pyHanko-verified), form filling, takeoff legends, PDF.js runtime data (REA finding R1). Details and remaining gaps: research/FEATURE_GAP_MATRIX.md; REA evidence: rea/FINDINGS.md.

## Release artifacts (final build)

| Artifact | SHA-256 |
|---|---|
| opendraft-web-0.1.0.zip | c4bf19f255033a6f3529375f8ddc6980cf05fabb55314b8338feb8bebb637b95 |
| opendraft-selfhost-0.1.0.zip | ae3c5aa38d81b4a62156b7e8d8f7e8f6af77c7130294bd9f93831e382b422157 |
| OpenDraft-0.1.0-win-x64-setup.exe (unsigned, 124,558,775 B, 2026-10-22) | 6FF1395BC0C148281C43053605A6A0A532F9C9D1B3EB162E9BA747605F4BFD34 |
| OpenDraft-0.1.0-win.zip (167,203,528 B) | 7446AAEA9C146DFF32F0F3CD32449AB07710B87DA6E904EAFABE1E2B9450C54A |

Archives are in `release/0.1.0/`; installers were built outside OneDrive (`%LOCALAPPDATA%\opendraft-build\artifacts`) because OneDrive locks the electron-builder output rename.

## Owner decisions required before the gate can close

1. **Project license** (README/TASKS release blocker). Nothing is published until chosen.
2. **Code-signing identity, publisher name and icon** for the Windows installer (currently unsigned, default Electron icon).
3. **Approve or reject these unsupported/limited features** (gate: "unsupported features require explicit owner approval"):
   - Desktop collaboration requires launching with `--server=<url>`. Single server process, no SSO/password reset, sessions reset on restart.
   - Page organization, revision journal and comparison workflows are local-only (not shared).
   - Not implemented: 3D PDF, perspective/semantic comparison, batch clouds, editing existing PDF text.
   - web printing is rasterized (200 dpi target, at least 100 dpi; up to 300 pages); the desktop app prints vectors.
   - Independent-viewer and measurement evidence uses synthetic/authorized fixtures, not a broad professional drawing corpus.
4. **Performance baseline hardware**: accept results from this host, or provide a 16 GB Windows machine for a rerun (`node scripts/benchmark-acceptance.mjs`).
5. **Accessibility**: accept automated + UIA evidence, or require a manual screen-reader session.
6. Approval to start Project 2 (OpenUtility GIS) after the above.
