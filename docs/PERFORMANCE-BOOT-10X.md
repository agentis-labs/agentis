# PERFORMANCE-BOOT-10X — the instant-load blueprint

**Status:** quick wins shipped + verified; roadmap open. 2026-07-20.
**Trigger:** "global loading time and initialization latency are completely unacceptable."

Everything in this document is **measured**, not estimated — three parallel audits
(API boot critical path CPU-profiled against a copy of the real 732 MB workspace;
frontend dist built and byte-attributed via sourcemap; CLI/dependency require-costs
timed individually), anchored by a timestamped production-shaped boot captured in
session.

---

## 0. What "slow" actually was

One real boot, warm workspace, ~40 agents:

| t+ | phase | truth |
|---|---|---|
| −7…−10s | tsx module-graph load | invisible to every log |
| 0.0s | `bootstrap.start` | first log line |
| +8.0s | **GAP A** | `repairOrphanedDocumentLinks` — full kb scan, sync, EVERY boot (`bootstrap.ts:871`) |
| +7.7s | **GAP B** | `channelSupervisor.startAll()` prelude — channel scan + baileys graph compiled sync under tsx (`:1584`) |
| ~18s | **port actually bound** | but nothing said so |
| +28.5s | "hydrator window" | intrinsic hydrator = **5.2s** (of which `detectHarnesses` --version spawns = 5.1s); the other ~23s = event-loop contention: WhatsApp bring-up + embedding warm + probe spawns all landing at once |
| 49.2s | `agentis.listening` | **a lie — logged ~31s after the bind** |

Meanwhile the web app: **all 15 routes already lazy** (route-splitting was never the
problem), but the shell shipped 387 KB gz to first paint — a hidden-but-mounted
ChatPanel dragging the whole @xyflow graph library, the SettingsModal + 10 panels
riding the entry chunk, zod pulled in through the `@agentis/core` barrel, and a
render-blocking Google Fonts `@import` as the built CSS's first statement. Worst of
all: when the API was unreachable (i.e. during that whole 18s+ window), the app
**logged the operator out, destroying valid tokens**, because network-unreachable
and auth-rejected shared one catch block.

Two systemic findings behind the numbers:

- **The port bound last-ish and nobody knew.** No boot phase had a duration;
  the one meaningful milestone log was misplaced by half a minute.
- **The data dir lives in a OneDrive-synced folder** — the identical code ran
  **2.5–8× faster** on a local-NVMe copy. Zero-code-change multiplier.

---

## 1. Shipped (this session, all verified)

### Backend — bind fast, tell the truth

- **`services/bootProfile.ts`** — phase marks relative to *process start* (so the
  tsx module-graph cost is finally visible), served on **`/healthz`** as
  `boot: { ready, phases[] }`. One curl answers "why is boot slow" on any install.
- **`agentis.listening` now logs at the actual bind**; the end-of-start milestone
  became `agentis.ready` and includes the phase profile.
- **GAP A deferred** — `setAutoLinker(…, false)` + public
  `repairOrphanedLinks()` scheduled 15s post-listen, unref'd
  (idempotent housekeeping; never a first-request dependency).
- **GAP B deferred + staggered** — `startAll()` moved into `start()` *after*
  agent hydration, so baileys/WhatsApp no longer race the hydrator for the loop.

**Measured after (scratch dir, dev/tsx):**

```
modules_loaded   7116ms   ← tsx, dev-only (prod bundle parse: 0.75s measured)
foundation_wired  +747ms   ← env, secrets, DB open + migrations (69ms)
services_wired    +594ms
port_bound         +25ms   ← was: +GAP A + GAP B ≈ 16s in front of this
agents_hydrated     +1ms   (scratch; 5.2s intrinsic on the 40-agent workspace)
ready             +609ms
```

Projection, real workspace, production runtime: **bind ≈ 2–3s** (was ~18s + 7–10s
invisible), with hydration/channels/warm continuing behind a truthful `/healthz`.

### Frontend — measured entry-chunk delta

| | before | after |
|---|---|---|
| entry chunk | 660 KB / **188 KB gz** | 446 KB / **137.6 KB gz** (−27%) |
| ChatPanel + @xyflow + shared (~140 KB gz) | fetched on EVERY cold boot, hidden | not fetched until first open — **verified live via network log** |
| SettingsModal + 10 panels (~100 KB raw) | in entry | lazy on first open |
| zod + core barrel (~106 KB raw) | in entry via `export * as schemas` side effects | subpath imports (`@agentis/core/events`) in all 6 eager shell files |
| Google Fonts `@import` | render-blocking, CSS-chained, stalls offline | non-blocking `<link media="print" onload>` + preconnect in index.html |

- **ChatPanel defers only its FIRST mount** — once opened it stays mounted, so
  hiding the panel mid-reply still keeps the stream alive (behavior preserved).
- **False-logout fixed** (`App.tsx` both effects): failures now probe `/healthz`;
  unreachable → "Waiting for the Agentis server…" BootScreen + 1.5s polling,
  tokens survive. Two traps found *by testing the fix live*:
  - `/healthz` wasn't in the vite proxy → SPA fallback answered it with
    index.html 200 → the probe blessed a downed API. Added to proxy.
  - Therefore the probe requires the API's JSON body (`ok === true`) — a bare
    200 is not proof of life behind ANY SPA-fallback proxy.

---

## 2. The Profiling & Instrumentation Playbook

**Always-on (shipped):** `curl -s localhost:3737/healthz | jq .boot` — phase
durations since process start, on every install, no tooling.

**When a phase number looks wrong:**

| Target | Command |
|---|---|
| API CPU profile | `node --cpu-prof --cpu-prof-dir=prof node_modules/tsx/dist/cli.mjs src/index.ts` → open in Chrome DevTools › Performance |
| Module require cost | `node -e "const t=performance.now();require('<dep>');console.log(performance.now()-t)"` |
| tsx baseline vs graph | `time npx tsx -e 0` (2.95s measured) vs `time node -e 0` (0.10s) |
| Frontend payload | `node scripts/build.mjs` → chunk listing; add `--sourcemap` + a treemap only when attributing bytes |
| Frontend runtime | Chrome DevTools › Performance + Lighthouse (TTI/TBT); Network tab filtered to `assets/` for the boot fetch set |
| Boot fetch waterfall | DevTools Network, `Doc`+`Fetch/XHR`, disable cache — count serial hops before first data paint (today: 4) |
| Brain write cost | `intelligence.embedLatency` on the brain-health snapshot (p50/p95/max/cold-start, shipped earlier this session) |

**Known baselines** (this hardware): drizzle 941ms, jose 849ms (both static, boot
path), baileys 1,049ms, discord.js 2,095–3,089ms, exceljs 1.5–2s, transformers
482ms–1.6s (all dynamic ✓); better-sqlite3 open+migrations 69ms; e5 warm embed 21ms.

---

## 3. Critical Path Architecture

The rule the boot now follows, and every future service must:

```
MUST precede listen (~2.5s of app time, total):
  env → secrets → SQLite open + migrations → route construction → realtime attach
        ↓ bind port, log agentis.listening, /healthz says ready:false
CONCURRENT after listen (readiness-flagged, staggered — not simultaneous):
  agent hydration → channel re-link (after hydration) → trigger hydrate
  → service .start()s → embedding warm → deferred repairs (15s+)
        ↓ markBootReady(), log agentis.ready + phase profile
LAZY on first use (already correct — keep it that way):
  baileys/telegram/discord/slack, exceljs/pdf/mammoth, transformers/onnx,
  playwright, per-route UI chunks
```

Front of house mirrors it: paint shell immediately → probe `/healthz` when /v1
fails → honest "server starting" state → hydrate data progressively. Never treat
unreachable as unauthorized; never gate first paint on a third-party fetch.

---

## 4. Second wave — SHIPPED (2026-07-20, same day)

| Win | Status |
|---|---|
| **OneDrive data dir warning** | ✅ boot warn `agentis.data_dir_in_sync_folder` with remedy (bootstrap, after foundation) |
| gpt-tokenizer (52 MB, zero imports) | ✅ removed from `apps/api` + `packages/core` package.json — **takes effect at the next `pnpm install`** (not run in-session: a live dev instance was serving from this `node_modules`) |
| onnxruntime-web (129 MB, never executes in Node) | ✅ root `pnpm.overrides` → `packages/stubs/onnxruntime-web` (throws loud if ever actually imported). Effective at next install. **Published-CLI variant deferred**: npm `overrides` behavior on global installs needs a publish-pipeline test before shipping |
| q8 default for FRESH installs (450→~115 MB) | ✅ `ensureDtypeDefault()` — persisted `.dtype` marker in the models dir; fresh = no vectors AND no downloaded fp32 weights. Invariant: fp32 lock maps to `undefined`, never the string `'fp32'` — existing vectors carry a modelId with no dtype suffix, and making it explicit would re-embed the whole brain |
| `prepareChromium` at `agentis up` (~250 MB forced) | ✅ `up` warms embeddings only (`includeChromium: false`); `agentis setup` still prepares everything; browserPool self-installs on first browser action |
| model download progress | ✅ transformers `progress_callback` → settable sink (stdout for CLI, structured logger via bootstrap), throttled to 25% steps per file, files <5 MB ignored — observed live in the test run |
| HomePage static modal code (89 KB) | ✅ `AgentCreateWizard` lazy + mounted only when the wizard opens |
| **Entry-chunk hard gate** | ✅ `build.mjs` fails the build if any entry chunk exceeds **150 KB gz** (current: 134.1 KB) |
| **Boot-budget test** | ✅ `tests/bootBudget.test.ts` — boots the real entry on a scratch dir, asserts `services_wired→port_bound < 3s` from the /healthz profile (measured 25ms) and that the profile phases exist. Green in 8.5s |

## 5. Still open (deliberate)

- **`pnpm install`** to apply the dep removals/override — run at next restart of
  the dev instance; verify `node_modules` shrinks by ~180 MB.
- **Published-CLI onnxruntime-web override** — needs an `npm i -g` test from a
  packed tarball before trusting npm's overrides semantics for global installs.
- **`detectHarnesses` disk cache** (5.1s of the post-bind hydration window) —
  persist probe results with TTL; currently 60s in-memory only.
- **Boot fetch waterfall** — dedupe `/v1/auth/me` (App.tsx:148 +
  workspaceData.ts:410, parallel so latency win is small); optimistic shell on
  the persisted workspace id.
- **Self-host Inter woff2** — removes the (now non-blocking) Google Fonts
  dependency for air-gapped installs; needs the font assets vendored.
- **Import-hygiene lint** in `check-boundaries.mjs` (barrel + heavy-dep rules for
  eager shell files) — the budgets above catch the symptom; the lint would name
  the culprit.

---

## Implementation log

- **2026-07-20** — Three audits (boot path CPU-profiled on a 732 MB workspace
  copy; frontend dist byte-attributed; CLI/deps timed). Shipped: bootProfile +
  /healthz phases + honest listening log; GAP A/B deferred off the pre-bind path
  (bind: services_wired +25ms on scratch, was +~16s of sync work on real data);
  frontend F1–F5 (entry 188→137.6 KB gz, ChatPanel/xyflow no longer fetched at
  boot — verified via network log; fonts non-blocking; false-logout fixed with
  /healthz probe + JSON-body check after the SPA-fallback trap was caught live).
  api+web typecheck green. Remaining wins + anti-regression gates documented above.
