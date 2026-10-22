# REA (Reverse Engineer Anything) integration

Status 2026-10-21. REA is a **development-time investigation tool only**. It is not a dependency of OpenDraft, is not bundled, and no OpenDraft code calls it.

## Source and verification
- The handoff linked `github.com/ChristopherLarsen/ReverseEngineerAnything`, a 0-star fork of `morluto/rea`. Its own README warns that look-alike repositories are not official. **The fork was not used.**
- Installed the official npm package `rea-agents@6.7.0` (MIT; repository `github.com/morluto/rea`; maintainer `morluto`; ~550k downloads/month; integrity `sha512-yhIx2ioJ…OhFw==`). Registry metadata shows no `preinstall`/`install`/`postinstall` hooks; it was installed with `--ignore-scripts` anyway.
- Location: `%LOCALAPPDATA%\opendraft-build\tools\rea` (outside the repository and OneDrive). Run: `node %LOCALAPPDATA%\opendraft-build\tools\rea\node_modules\rea-agents\scripts\rea.mjs <command>`.
- `rea setup` (which registers an MCP server and writes agent instructions into Codex/Claude configuration) was **not run**: it changes global agent configuration for every project on the machine, and REA's MCP tools include unrestricted debugger/process capture. Run it only if the owner wants REA available to all agents: `npx rea-agents@6.7.0 setup` (it backs up existing config).
- `rea doctor`: Node 24.18 healthy; Hopper/Ghidra/IDA absent. Only JavaScript/Electron/web/PDF-adjacent commands are usable, which is all OpenDraft needs.

## Scope and legal boundary
- Bluebeam Revu is **not installed** here, and its license terms restrict reverse engineering. REA was not and should not be pointed at Bluebeam binaries. Bluebeam comparisons use public documentation and black-box behaviour of PDFs only (see research/FEATURE_GAP_MATRIX.md).
- REA was used on OpenDraft's **own** build artifacts (authorized).
- Raw evidence stays outside the repo: `%LOCALAPPDATA%\opendraft-build\rea-evidence\app-asar.json` (151 MB, canonical REA Evidence JSON).

## Reproduce
```
rea analyze-javascript-application %LOCALAPPDATA%\opendraft-build\artifacts\win-unpacked\resources\app.asar --format json --full-output > app-asar.json
```
