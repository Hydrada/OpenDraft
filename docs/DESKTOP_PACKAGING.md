# Windows desktop packaging proof

Research checked 2026-10-21. Selected proof runtime: Electron 45.0.0; packager: electron-builder 26.15.3 (npm metadata reports MIT for each; Node >=22.12.0 for the Electron npm installer). Electron embeds Chromium/Node and requires ongoing runtime security updates; the MIT wrapper license does not replace bundled Chromium, Node and third-party distribution notices. Official [security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [sandbox guidance](https://www.electronjs.org/docs/latest/tutorial/sandbox), [platform/support pointer](https://www.electronjs.org/docs/latest/tutorial/support), [distribution guidance](https://www.electronjs.org/docs/latest/tutorial/distribution-overview) and [packaging tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging) informed the proof. Electron's tutorial uses Forge; this project uses [electron-builder](https://www.electron.build/) for explicit NSIS/ZIP build configuration.

## Isolation and local hosting

desktop/main.cjs creates one sandboxed BrowserWindow with contextIsolation, webSecurity and no renderer/worker/subframe Node integration. No preload, IPC API, remote shell launcher, telemetry or updater is provided. Permissions, new windows, webviews, remote navigations and remote runtime requests are denied. desktop/host.cjs adapts the repository reference static host: loopback binding, same-origin CSP without websocket access, MIME/nosniff/referrer headers, GET/HEAD only, path/realpath checks and no upload endpoint. The renderer uses its ordinary file input and browser download workflow.

Normal user launches show the application. A stable 127.0.0.1:4180 origin and persistent Electron partition preserve opt-in recovery storage across launches. If the port is occupied, startup fails instead of silently switching origin. A local loopback listener is still reachable by local processes; it serves packaged assets only. Future release work should evaluate a secure custom protocol and Electron fuses, multiple-instance handling, update strategy and production threat review.

The --smoke-test flag always creates a hidden, unfocusable window, disables dialogs/downloads, uses an ephemeral loopback port and separate test profile, and destroys windows during test quit. The smoke test never opens the native file picker, Save or Print. It sends browser input through Playwright to the isolated hidden window; it does not move the physical pointer or focus an app.

## Build and verify

Root dependencies and package main are maintained by the integration owner. Build renderer first, then run:

```powershell
npm run build
npx playwright test tests/e2e/desktop.spec.ts
npx electron-builder --config desktop/electron-builder.yml --win --x64
```

The config targets a per-user NSIS installer and ZIP under desktop/artifacts. It does not run the installer or launch the installed app. NSIS runAfterFinish is disabled, elevation is disabled, and no desktop shortcut is created automatically. Files are packed in ASAR; runtime modules use only Node built-ins and bundled renderer assets. Code signing/editing is disabled for this development proof; unsigned binaries may trigger Windows warnings. No claim of trusted publisher, production release or successful installation follows from producing an artifact.

For a hidden test of an unpacked or extracted packaged executable, set OPENDRAFT_EXECUTABLE to its absolute path and run the same desktop test. The test supplies --smoke-test and cleans its temporary profile after shutdown.

## Verification status

2026-10-21: `node --check desktop/main.cjs` and `node --check desktop/host.cjs` passed. Source-app smoke passed 1/1 with Electron 45.0.0 (4.2s test, 5.9s suite). `electron-builder --config desktop/electron-builder.yml --win --x64 --dir` succeeded; its hidden packaged executable smoke passed 1/1. The full NSIS+ZIP build then succeeded. A repeat hidden smoke against the final win-unpacked/OpenDraft.exe passed 1/1 (3.9s test, 6.5s suite). The smoke asserted no visible/focused window, sandbox/isolation/no Node bridge, PDF rendering/rotation, denied external popup/fetch and clean shutdown. No visible application launch or native dialog occurred; no installer was executed.

| Development artifact | Bytes | SHA256 |
|---|---:|---|
| OpenDraft-0.1.0-win-x64-setup.exe | 112742814 | E17855DF56F769BA0029BE981F1B88F870DCC07FF9DC92B56CBE5C77CD22FA38 |
| OpenDraft-0.1.0-win.zip | 153825553 | 3974D35F5A94089B640B442C718E4D06E7B3D8208253BC2B0CA598C26B3D0914 |
| OpenDraft-0.1.0-win-x64-setup.exe.blockmap | 119144 | D4073DE7C82C46417363B6B1A8E077BE317D5EC7D21BC2F76B97DBB83D1D05FB |

Final app.asar SHA256: 3E4A9C3CF380B50A0C5EA8B8050D3D83CE5701D9E591B0481E943A4E7F4BD211. Artifact hashes identify this development snapshot; they are not reproducible-build proof. PowerShell Get-AuthenticodeSignature reports the installer is **NotSigned** despite generic builder signtool stage messages. Build warnings: no package description/author provided, duplicate workspace dependency references, default Electron icon, executable metadata/signing editing disabled. No owner/publisher/license metadata was fabricated.

ASAR inspected: 12 entries, desktop main/host, renderer index/assets and package.json; no node_modules. Electron LICENSE.electron.txt and LICENSES.chromium.html exist beside the executable. The config copies PDF.js, pdf-lib and four transitive renderer dependency license files plus desktop/THIRD_PARTY_NOTICES.md to a licenses directory beside the executable. All seven were verified in the unpacked package and final ZIP directory; NSIS and ZIP regenerated successfully with notices. Hidden packaged smoke including the seven notice-presence checks passed 1/1 again (3.9s test, 6.5s suite). The table records these final regenerated artifacts. Project source license, full distribution review and publisher/icon decisions remain pending.

Desktop E2E is explicitly Windows-only; Linux CI skips it because no desktop display is provided. Windows CI runs desktop:runtime after npm ci so the installed Electron runtime exists before hidden smoke testing. These CI changes are configured locally; remote CI execution has not been observed.

This smoke does not test native dialogs, print, download destinations, install/uninstall, signing, update, screen readers, cross-platform packaging or hostile PDF safety. Packaging is proven for this development snapshot; installation and the Windows release completion gate remain open until those checks and all product requirements pass.

## Distribution follow-up (2026-10-21)
The earlier app.asar was enumerated with @electron/asar 3.4.1: 12 entries, no node_modules, canvas, standard_fonts, cmaps, iccs or wasm path matches. This is evidence for that artifact only; repeat after every package change. Current renderer now adds XLSX dependencies and remains unpackaged. Added write-excel-file/fflate license-copy rules require validation in the next package build.

The installed Electron ffmpeg.dll exists; LICENSES.chromium.html includes the ffmpeg LGPL-2.1-or-later and source-file notice entry. Exact matching source/build and redistribution requirements are unresolved release work. The pinned PDF.js npm tree contains no separately named NOTICE file; CSS source attribution/modification notice was made explicit. None of these checks is full legal clearance.
