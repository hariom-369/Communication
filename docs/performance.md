# Web performance — budgets and how they are enforced

Status: **as built in Phase 14.** Budgets are enforced on every build and in the end-to-end
suite; numbers below are from 2026-10-10 on the CI-equivalent container (one Chromium,
production build, all services local).

## 1. Budgets

| What | Budget | Measured | Enforced by |
|---|---|---|---|
| Scripts the first page load runs (entry + its `modulepreload`s), gzip | 170 KB | 152.7 KB | `apps/web/scripts/budgets.mjs` (part of `pnpm build`; the build fails over budget) |
| Stylesheets in `index.html`, gzip | 10 KB | 6.1 KB | same |
| Any chunk loaded later, gzip | 150 KB | 130.5 KB (group calls) | same |
| Each web worker, gzip | 20 KB | 8.7 KB (crypto worker) | same |
| Service worker, gzip | 60 KB | 50.3 KB | same |
| Encryption engine (WebAssembly), gzip | 850 KB | 733 KB | same |
| `index.html`, gzip | 2 KB | 0.6 KB | same |
| Everything the service worker pins (uncompressed, no source maps) | 4.8 MB | 4.1 MB | same |
| Largest Contentful Paint | ≤ 2.5 s | 0.3–1.0 s (CPU slowed 4×) | `e2e/performance.spec.ts` |
| Cumulative Layout Shift | ≤ 0.1 | ≤ 0.001 | same |
| Interaction to Next Paint | ≤ 200 ms | 32 ms (typing, navigation) | same |
| Lighthouse performance (mobile profile, simulated slow 4G) | ≥ 0.90 | 0.95 `/login`, 0.94–0.96 `/signup` (3 runs) | `e2e/lighthouse.spec.ts` (Lighthouse 13.5.0, pinned) |
| Lighthouse accessibility | 1.00 | 1.00 | same |
| Lighthouse best practices | ≥ 0.90 | 0.96 | same |

The Web Vitals budgets are the "good" thresholds of the Web Vitals programme. They are measured
with the browser's own performance entries (`largest-contentful-paint`, `layout-shift` without
recent input, `event` timing with interaction ids), on the first visit and again from the pinned
copy, and on the signed-in app after sign-up (chat list, typing, moving between sections).

## 2. What was changed to meet them

- **Route-level code splitting** (`apps/web/src/app.tsx`, `signed-in.tsx`): every signed-in page
  is its own chunk, and the signed-in frame (navigation, messaging provider, encryption-engine
  client) loads only after sign-in. The entry went from 238 KB to 153 KB gzip, Lighthouse
  performance on `/signup` from 0.88 to 0.96 (TBT 320 → 160 ms). The build keeps modules in
  source execution order across chunks (`strictExecutionOrder`, about 4 KB): without it the
  shared chunk created Zod schemas before `zod-config.ts` switched off Zod's JIT, and Zod's
  `Function` probe broke the Trusted Types / CSP guarantee (caught by the E2E CSP checks).
- **Pinned shell** (ADR-052): repeat visits are answered by the service worker from its verified
  copy (LCP on `/login` 308 ms vs 752 ms on the first visit in the same run).
- **Reduced motion**: motion tokens drop to 0 ms and a global rule stops any animation or
  transition when the system asks for less motion (accessibility.md).

## 3. Known gaps (stated, not hidden)

- Lighthouse best practices loses points for `errors-in-console` (the browser logs the expected
  401 of the signed-out session check) and `bf-cache` (the page uses
  `Cache-Control: no-store` and keeps a WebSocket open — both deliberate). Not worth trading.
- The crypto engine is 733 KB gzip; it downloads once per release and is cached by the service
  worker, but a first visit on a slow connection pays for it when the signed-in app starts.
  Shrinking it (feature-gating OpenMLS ciphersuites, `wasm-opt` levels) is a crypto-core change
  and goes with review S-01.
- Measurements here are on one machine with localhost latency; real-network field data (RUM)
  arrives with observability in Phase 16. Lighthouse covers only the public pages; signed-in
  pages are covered by the Web Vitals measurements.
- Large-group and long-history performance (thousands of messages in view) is covered by the
  Phase 15 load tests, not by these budgets.
