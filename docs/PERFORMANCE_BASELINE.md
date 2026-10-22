# OpenDraft modest performance baseline

Measured 2026-10-21T15:30:29.960Z using `node scripts/benchmark.mjs` after `npm run build`.

## Environment and method
- OS: Windows_NT 10.0.26300 x64; CPU: AMD Ryzen 7 7800X3D 8-Core Processor           ; 16 logical processors; total RAM: 63.15 GiB.
- Node: v24.18.0; browser: headless Chromium 145.0.7632.6.
- Browser launched with --disable-gpu and --enable-precise-memory-info; CPU raster path requested. This is not proof that every OS graphics operation avoids GPU use.
- Viewport 1440x900, device scale 1, app default 100% zoom. Each sample uses a fresh browser context; application assets load before the open timer starts.
- Synthetic fixture: 2 portrait 36x48 inch pages (2592x3456 PDF points), 100 vector lines and one text title per page; 3082 bytes. No scanned images, engineering data, complex fonts, annotations or external content.
- First-render timer: just before file selection to #status reporting Page 1 of 2 (after canvas rendering). Includes file input/parse/worker/render and Playwright scheduling overhead; excludes initial app asset loading.
- Warmed-navigation timer: after visiting both pages, click next from page 1 to page 2 until the render-complete status. Includes input scheduling overhead. Thumbnails may still run concurrently.
- Memory: main-page usedJSHeapSize after warmed navigation, if exposed. This excludes PDF worker heap, canvas/native allocations and process working set; not a peak-memory measurement.

## Actual observations — five sequential samples

| Sample | First render ms | Warmed navigation ms | Main page JS heap bytes |
|---|---:|---:|---:|
| 1 | 210.48 | 82.59 | 7291647 |
| 2 | 212.5 | 81.01 | 7327443 |
| 3 | 106.21 | 97.8 | 5994779 |
| 4 | 104.59 | 80.68 | 7262915 |
| 5 | 211.86 | 77.36 | 7289507 |

Nearest-rank p50 / p95: first render **210.48 / 212.5 ms**; warmed navigation **81.01 / 97.8 ms**. With five samples, p95 is the maximum observed sample and is not a stable tail-latency estimate.

## Limits and acceptance status
This is a small diagnostic baseline, not a release benchmark pass. The proposed acceptance corpus requires 20 runs, a 200-sheet construction set, a defined 16GB Windows baseline, fit-page memory/working-set measurements and independent drawing fidelity checks. None of those are established by these five samples. CPU contention/background activity is uncontrolled. Default 100% large-format canvases are ~8.96M pixels at device scale 1; this does not exercise the 32M pixel cap or high-DPI devices. The browser contexts and loopback host are closed on completion/failure; the PDF exists only in memory.
