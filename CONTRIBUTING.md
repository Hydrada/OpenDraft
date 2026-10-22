# Contributing

Bug reports from real drawings are the most valuable contribution right now — see the [issue forms](https://github.com/Hydrada/OpenDraft/issues/new/choose).

For code changes:
1. Use Node.js 24; run `npm ci`.
2. Keep changes focused, and add or update tests (`tests/*.test.mjs` for logic, `tests/e2e/*.spec.ts` for the interface).
3. Before opening a pull request, run `npm run build`, `npm test` and `npm run test:e2e`.
4. New dependencies must have permissive licenses; run `npm run audit:licenses`.

By contributing you agree your work is released under the [MIT license](LICENSE).
