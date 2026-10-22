# OpenDraft performance acceptance

Measured 2026-10-21T21:10:16.716Z with `node scripts/benchmark-acceptance.mjs` after `npm run build`.

## Environment
- Windows_NT 10.0.26300 x64; AMD Ryzen 7 7800X3D 8-Core Processor; 16 logical processors; 63.2 GiB RAM. **Not the proposed 16 GB baseline machine**; RAM above 1 GiB is not used by the targets below, but CPU is faster than a typical 16 GB laptop.
- Node v24.18.0; headless Chromium 145.0.7632.6 with --disable-gpu; viewport 1440x900, device scale 1, app default 100% zoom (larger canvas than fit-page, so a conservative memory case).
- Fixture: synthetic 36x48 in sheets, each 2000 vector lines, 60 text labels and a title block. Pair file 54903 bytes; 200-sheet set 5417364 bytes. No scans, images or complex fonts.

## Results
| Target | Threshold | Measured | Result |
|---|---|---|---|
| First page render, 20 fresh runs | p95 <= 3000 ms | p50 267.8 / p95 286.3 ms | PASS |
| Warmed navigation, 20 runs | p95 <= 500 ms | p50 153.3 / p95 173.6 ms | PASS |
| 200-sheet set traversal | no crash or error | opened in 665.8 ms; 199 page steps p50 143.1 / p95 169.1 / max 203.1 ms; errors: 0 | PASS |
| Working memory | <= 1 GiB | peak browser-process working set 0.872 GiB (sampled every 2 pages) | PASS |

Timers include Playwright input scheduling. Working set sums every Playwright Chromium process (browser, renderer, GPU/utility) sampled by PowerShell; it is a sampled peak, not a continuous maximum. Peak breakdown: browser 57 MiB, gpu-process 80 MiB, utility 35 MiB, renderer 721 MiB.
