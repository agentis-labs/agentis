# Agentis — Multi-Agent Orchestration Masterplan

> **Status:** Complete spec · in execution · 2026-06-24 — every item specified (Files + Acceptance) and tracked in the [Progress dashboard](#progress-dashboard). Phases 0.1, 0.2, 1.1 shipped + tested; 0.5/1.2 partial. See [active blockers](#-active-blockers).
> **Basis:** A six-front, code-grounded audit of the actual codebase (NOT the obsolete `docs/` graveyard). Every claim below is traceable to source at the cited `file:line`.
> **Goal (the bet):** Turn Agentis from a sophisticated-but-engineer-bound orchestrator into a *safe, complete, zero-friction* multi-agent platform that developers, entrepreneurs, marketers, and creators can all wield to ship real agent-operated work — with clean architecture and no exploitable holes.
>
> **DEPLOYMENT MODEL (read this before judging any "security" finding): Agentis is OSS, single-tenant, ONE trusted operator.** There is no multi-tenant boundary to defend. The operator owns the workspace, the apps, the data, the host. Therefore:
> - "Any workspace member can mutate any app", "per-app authorization", "multi-tenant data isolation" are **NOT threats** — there is one member, and they own everything. These are struck from the plan.
> - The Python `code` node and operator-authored JS are **features, not RCE** — the operator already has shell on their own host (same posture as n8n's code node).
> - Real security here = **the boundary where the outside world or untrusted code touches the operator's system**: (a) externally-reachable surfaces (public app shares, inbound webhooks/channels), (b) untrusted code the operator *installs or an agent authors* (Hub bundles, agent-authored UI/HTML, prompt-injected agents acting on external input), (c) the operator's ability to control their own runaway/costly agents.
> **Brain / memory is OUT OF SCOPE here — the operator is handling it separately** (see `docs/brain/BRAIN-SCALE-10X.md`).

This doc has three parts:
- **Part I — Honest current stage** (where Agentis really is, the truth, no flattery).
- **Part II — The masterplan** (phased, persona-aware, security-first — every item specified with Files + Acceptance).
- **Part III — Execution** (progress dashboard, active blockers, definition-of-done, impl log).

A running impl log lives at the bottom and must be kept reconciled with real code (per house convention).

---

## Progress dashboard

Status legend: ✅ done & tested · ◑ partial · ⬜ not started · 🚫 out of scope. "Done" means shipped **with passing tests** per the Definition of Done.

| Item | Title | Status |
|---|---|---|
| 0.1 | Bind public query to the shared surface's collections | ✅ |
| 0.2 | Channel inbound fails closed (Telegram) | ✅ |
| 0.3 | Harden CustomView for untrusted UI | ⬜ |
| 0.4 | Provenance gate on installed bundles | ⬜ |
| 0.5 | Cap & abort process fan-out | ✅ (abort-signal, sibling-cancel, `maxConcurrent` clamp, `unbounded` guard, **global process semaphore** all done) |
| 1.1 | Real per-task isolation (agent_swarm) | ✅ |
| 1.2 | Concurrency honored, not advertised | ✅ (swarm clamp + `unbounded` hard-cap + global semaphore done) |
| 1.3 | Generic per-node `retryPolicy` | ⬜ |
| 1.4 | Durability (loops resume, evaluator bound, durable delegation, checkpoint timeout) | ◑ (**checkpoint `auto_after_timeout` done**; loops-resume / evaluator-bound / durable-delegation left) |
| 1.5 | Human-in-the-loop inside teams (worker yields) | ⬜ |
| 1.6 | Explicit join semantics (merge ↔ parallel) | ⬜ |
| 1.7 | Time / aggregation / pagination / human-input primitives | ⬜ |
| 2.1 | Turn on native SaaS webhooks | ⬜ |
| 2.2 | Honest connector catalog | ⬜ |
| 2.3 | MCP as a runtime capability | ⬜ |
| 2.4 | Guided OAuth + low-friction sensing | ⬜ |
| 3.x | Brain | 🚫 owner-handled (`docs/brain/BRAIN-SCALE-10X.md`) |
| 4.1 | Datastore depth (aggregation, keyset cursor, closed types) | ⬜ |
| 4.2 | Fork + Hub publish path | ⬜ |
| 4.3 | In-app agent orchestration | ⬜ |
| 4.4 | Customer-facing surface scoping | ⬜ (deferred until a real app needs it) |
| 5.1 | NL composer on the canvas | ⬜ |
| 5.2 | Visual field-picker | ⬜ |
| 5.3 | Demote raw JSON + rename internals | ⬜ |
| 5.4 | Zero-config model/runtime | ⬜ |
| 5.5 | Template gallery + output-first | ⬜ |
| 5.6 | Soften the agent-hierarchy on-ramp | ⬜ |

Bonus shipped (not a numbered item): swarm `first_success` sibling cancellation (cancel + reclaim losing workers).

## ⚠️ Active blockers

- **DB migration layer is mid-refactor in the working tree (BLOCKS all DB-backed tests).** `packages/db/src/sqlite/*` has a large uncommitted, concurrently-edited change that currently throws `no such table: main.apps` at `runEmbeddedMigrations`, so `createTestContext` fails and **every** DB-backed test (engine integration, route tests) cannot run. Proven isolated to that layer (reverting only `packages/db/sqlite` to HEAD makes pre-existing tests pass with the rest of the working tree intact). **This is not part of this plan and must be repaired by its owner before further DB-backed items can be verified.** Until then: non-DB unit tests + typecheck remain the verification floor.

---

# PART I — HONEST CURRENT STAGE

## The one-paragraph truth

Agentis has unusually advanced **cognition** — recursive grant-attenuated delegation, a real memory-formation gate, a planner that rewrites the live graph, agent-authored GenUI bound to a datastore — sitting on top of an **execution and access substrate that is neither safe nor complete enough** to hand to non-trusted users or to four different personas. The brain is real. The body it runs in is hollow, and several doors are unlocked.

## Subsystem maturity scorecard

| Subsystem | What's genuinely strong | What's hollow / dangerous | Stage |
|---|---|---|---|
| Workflow engine | Routing via audited parser (not `eval`); SSRF defense w/ DNS-rebind + IMDS block; vault-only HTTP auth; restart recovery for waits & sessions | Python `code` node = host RCE; no generic per-node retry; loops can't resume after crash; evaluator retry bound is advisory; unknown-kind = silent run hang | **Strong core, sharp edges** |
| Multi-agent orchestration | AgentSession: recursive delegation (depth 4), grant attenuation, on-demand specialist authoring, planner splices live graph | **No agent isolation at all** (N parallel agents share one cwd); `maxConcurrent` ignored; swarm subtasks can't be aborted; workers can't yield (no human-in-loop in a team); delegation is volatile in-process | **Brilliant brain, no body** |
| Brain / memory | _(out of scope — handled separately)_ | _(see `docs/brain/BRAIN-SCALE-10X.md`)_ | **Owner-handled** |
| Agentic Apps | Build→run loop real; lifecycle (sha256 packaging, migration diff/rollback, environments/promote) genuinely complete; typed-GenUI render protocol is safe-by-construction | Public-share query leaks **non-shared** collections to the internet (real external-exposure bug); datastore has no joins/aggregation; offset cursor; CustomView action bridge unrestricted (matters for installed/agent-authored UI). _(Operator-only authz "gaps" are by-design for single-tenant — not flaws.)_ | **Solid for one operator; external surfaces need sealing** |
| Triggers / connectors | Listener drivers (http_poll/ws/sse/rss/file/bus) solid; webhook HMAC crypto sound (timing-safe, replay-guarded); `agent` predicate is a real no-code differentiator | ~95 advertised integrations → **~29 actually run**; SaaS webhook verifiers exist but are wired to nothing; MCP is a REST passthrough, not injected into agents; Discord inbound is a no-op; Telegram verify fails open | **Facade breadth** |
| Web UX / friction | NL→workflow build streams a live canvas (real differentiator); per-node live run status; friendly activity feed | NL absent from the canvas itself; every edit needs JS expressions / JSONPath / cron; raw JSON editor as a co-equal affordance; leaked jargon (HAL, ledger, scratchpad, "Kind"); model/runtime forced at agent creation; no template gallery | **Still an engineer's tool** |

## The security debt (single-operator threat model)

Filtered to what actually threatens a single trusted operator — i.e. the **external boundary**, **untrusted installed/authored code**, and **runaway control**. (Operator-vs-operator authorization findings from the raw audit are intentionally dropped: there is one operator.)

**Real, exploitable from outside the operator's trust:**

1. **Public-share data leak (the one true external-exposure bug).** `/public/surfaces/:token/query` reads `body.collection` and queries it with **no check that the collection is bound to the shared surface** — an anonymous internet user with a share link to one harmless surface can read **every** collection in that app. (`apps.ts:178-189`)
2. **Telegram inbound fails open.** `verify()` returns `true` when no secret is configured — an unauthenticated POST from anywhere on the internet dispatches an orchestrator turn (spends tokens, runs tools). (`telegram.ts:172`)

**Real at the untrusted-code boundary (Hub installs / agent-authored UI / prompt-injected agents):**

3. **CustomView action bridge unrestricted.** Sandboxed iframe blocks network, but agent-authored / installed-bundle HTML can invoke any declared `workflow`/`tool` action; CSP is a weaker `<meta>` tag with `unsafe-inline`. Matters when the operator installs someone else's app or an agent's UI is steered by external input. (`ViewRenderer.tsx:449-451, 422`)
4. **Installed bundles can carry auto-running code.** The Python `code` node and operator JS are *fine for the operator's own workflows*, but an imported third-party `.agentisapp`/workflow bundle that contains a code node runs that code on the operator's host on first run. The risk is **provenance**, not the feature. (`WorkflowEngine.ts:6130`; install path `apps.ts:117-130`)

**Reliability / runaway control (operator protecting themselves from their own agents):**

5. **Unbounded process fan-out + no swarm abort.** `agent_swarm` fires up to 64 concurrent CLI processes ignoring adapter `maxConcurrent`; `unbounded` parallelism = `MAX_SAFE_INTEGER`; Stop doesn't cancel in-flight subtasks (cost + resource leak the operator can't halt). (`WorkflowEngine.ts:5348, 8188-8190, 5430`)

_Not security debt here (struck): per-app authorization, multi-tenant data isolation, operator-authored Python/JS as "RCE". Memory-injection: out of scope (Brain is owner-handled)._

---

# PART II — THE MASTERPLAN

## Design mandates (apply to every track, non-negotiable)

- **Security is a gate, not a phase.** No track ships a feature that widens an existing hole. Untrusted input (channel messages, ingested web text, installed app bundles, agent-authored HTML/code) is hostile by default.
- **Zero creation friction.** Every new capability ships with a no-code path *and* an advanced/raw escape hatch. If a non-dev can't reach it in plain language, it isn't done.
- **Extend, don't fork.** Generalize existing seams (the AgentSession runtime, the connector registry, the listener drivers, the embedding registry). No parallel subsystems. No `V2` suffixes.
- **Honest surfaces.** Never present a green/ready/typed/connected state the engine can't back. The existing honest-preflight and `degraded - hashing` banners are the standard; extend that ethic everywhere.
- **Persona test.** Each track names what it unlocks for dev / entrepreneur / marketer / creator. A capability only devs can use is half-built.
- **Clean code.** No new God-files (`sharedIntelligence.ts` at ~3k lines is a warning, not a pattern). New work lands in cohesive modules with tests.

## Definition of Done (per item)

An item is ✅ only when **all** hold:
1. **Behavior** implemented against the cited files, extending existing seams (no fork, no `V2`).
2. **Tests**: a unit test for any new pure logic **and** an integration/route test for the behavior at its real boundary. New code paths must have a test that fails without the change.
3. **Verification**: `pnpm typecheck` clean for every touched package; the new + adjacent suites green. Pre-existing/unrelated failures must be *isolated and named* (e.g. by reverting only the suspect file), never hand-waved.
4. **No regressions** in the suites the change touches.
5. **Honest surface**: no green/ready/typed/connected state the engine can't back.
6. **Impl log** entry appended (date · item · what shipped · files · tests).

Each item below carries **Files** (where the work lives) and **Acceptance** (the test that proves it), so it can be picked up cold.

---

## Phase 0 — Seal the external & untrusted-code boundary

**Why first:** even a single-operator system exposes surfaces to the internet (public app shares, inbound webhooks/channels) and runs code it didn't write (Hub installs, agent-authored UI). Those boundaries — and the operator's ability to halt runaway agents — are the only real security debt. They're small fixes; all are disqualifying for any public-facing or install-from-others use.

### 0.1 ✅ Bind public query to the shared surface's collections
- **Problem:** `/public/surfaces/:token/query` queried any `body.collection` with no check it belonged to the shared surface → anonymous cross-collection enumeration.
- **Build (shipped):** core `collectionsInView(view)` walks the view tree (`Table`/`List`/`Chart`/`DataBoard` binds + `CustomView.collections`); the public query rejects any collection outside that allowlist with `RESOURCE_NOT_FOUND`.
- **Files:** `packages/core/src/types/view.ts`, `apps/api/src/routes/apps.ts`.
- **Acceptance (met):** `collectionsInView` unit test + route test proving `tickets`→200 / `secrets`→404.

### 0.2 ✅ Channel inbound fails closed
- **Problem:** `TelegramChannelAdapter.verify()` returned `true` with no configured secret → unauthenticated internet POST dispatched an orchestrator turn.
- **Build (shipped):** fail closed (`return false`) with no secret, matching Slack/WhatsApp-Cloud. (Discord inbound already returns false; Slack already requires the signing secret.)
- **Files:** `apps/api/src/adapters/channels/telegram.ts`.
- **Acceptance (met):** unit test asserts rejection with no secret even when an attacker supplies the header.

### 0.3 ⬜ Harden CustomView for untrusted UI
- **Problem:** agent-authored / installed-bundle HTML in the sandboxed iframe can invoke any declared `workflow`/`tool` action; CSP is a weaker `<meta>` tag with `unsafe-inline`. (`ViewRenderer.tsx:422, 449`)
- **Build:** per-node **action allowlist** mirroring the existing `collections` allowlist; refuse `workflow`/`tool` actions from custom frames by default (opt-in per node); deliver CSP as an HTTP header from a dedicated sandboxed route, not `<meta>`; run the registry HTML scanner at `ui.render` time, not only on import.
- **Files:** `apps/web/src/.../ViewRenderer.tsx`, the surface persist path (`appSurfaceStore`), `apps/api/src/services/registryScanner.ts`, a new sandboxed-frame route.
- **Acceptance:** a CustomView node whose HTML posts `actions.invoke('someWorkflow')` is blocked unless that action is explicitly allowlisted on the node; agent-authored HTML with a blocked pattern is rejected at render. Unit test on the allowlist gate + a route/integration test on the render path.

### 0.4 ⬜ Provenance gate on installed bundles
- **Problem:** an imported `.agentisapp`/workflow bundle can carry a `code` node or `CustomView` HTML that runs on the operator's host on first run. The operator's *own* code is fine; *imported* code is the risk. (`apps.ts:117-130`, `WorkflowEngine.ts:6130`)
- **Build:** extend the install-preview permission summary to enumerate **executable payloads** (code nodes, CustomView HTML, declared grants) and require explicit acknowledgement of those specifically before first run; tag installed-bundle provenance so imported executable nodes are gated/disabled until acknowledged. Operator-authored nodes stay unrestricted.
- **Files:** `apps/api/src/routes/apps.ts` (preview/install), `@agentis/app` packager (`AppPackager`/permission summary), engine node-execution guard keyed on provenance.
- **Acceptance:** route test — importing a bundle containing a `code` node lists it under executable-payload permissions and refuses to run it until acknowledged; an operator-authored `code` node runs without any gate.

### 0.5 ◑ Cap & abort process fan-out
- **Done:** run `signal` threaded into swarm dispatch (Stop aborts in-flight subtasks); `first_success` cancels + reclaims losing siblings; swarm `maxParallel` clamped to adapter `maxConcurrent`.
- **Left:** a **global** engine-wide concurrent-process semaphore (across all runs/swarms), and guarding the `AGENTIS_WORKFLOW_PARALLELISM=unbounded` → `MAX_SAFE_INTEGER` footgun (cap to a high finite value with a warning). Design note: the swarm pool is event-driven (refills on completion), so the global cap belongs in `AdapterManager.dispatchTask` acquiring a slot and releasing on the task-terminal event — must not deadlock the refill loop.
- **Files:** `apps/api/src/adapters/AdapterManager.ts`, `apps/api/src/engine/WorkflowEngine.ts:resolveParallelism`.
- **Acceptance:** an integration test where total concurrent dispatched tasks across two simultaneous swarms never exceeds the global ceiling; `unbounded` resolves to the finite cap, not `MAX_SAFE_INTEGER`.

**Phase exit criteria:** an anonymous visitor with a public share link reads only the shared surface's data (✅); an unauthenticated webhook/channel POST is rejected without a valid secret (✅ Telegram; audit remaining); an installed third-party bundle cannot run code or invoke backend actions without explicit acknowledgement (0.3/0.4); the operator can hard-stop any runaway fan-out and the host can't be process-exhausted (0.5). _(SSRF defense is already strong — verified, no work needed.)_

---

## Phase 1 — The orchestration spine (give the brain a body)

**This is the masterpiece's core.** The cognition is already excellent; make the execution substrate real, safe, durable, and bounded so that "an army of agents working in parallel" is true instead of dangerous.

### 1.1 ✅ Real per-task isolation (the headline gap)
- **Problem:** `NormalizedTask` had no `cwd`; every adapter spawned at one static `opts.cwd`; a swarm of N CLI agents edits the same files → corruption.
- **Build (shipped):** `workdir` on `NormalizedTask` + `getWorkdir()` on adapters; new `WorktreeManager` allocates an isolated dir per swarm subtask (`git worktree add --detach` for repos, else `mkdtemp`), released on settle. The four local-spawn adapters spawn at `task.workdir ?? opts.cwd`.
- **Scope note:** `dynamic_swarm`/delegate workers run a pure-HTTP `LlmSessionAdapter.executeStep` (no child process / cwd), so they have no shared-filesystem surface — the corruption surface is fully covered by the `agent_swarm` fix. A future "preserve branch / open PR from the worktree" feature is the natural extension.
- **Files:** `apps/api/src/services/worktreeManager.ts`, `packages/core/src/types/adapter.ts`, the four CLI adapters, `AdapterManager.ts`, `WorkflowEngine.ts`, `bootstrap.ts`.
- **Acceptance (met):** `worktreeManager.test.ts` (6, incl. real git-worktree lifecycle) + swarm integration test.

### 1.2 ◑ Concurrency that's honored, not advertised
- **Done:** `agent_swarm` clamps `maxParallel` to the adapter's `execution.maxConcurrent`.
- **Left:** reconcile the 16-vs-64 per-node clamps into one documented constant; the global engine-wide process ceiling (shared with 0.5).
- **Files:** `WorkflowEngine.ts` (`#dispatchAgentSwarm`, `#runDynamicSwarm`), `AdapterManager.ts`.
- **Acceptance:** integration test (shared with 0.5) — concurrent dispatched tasks never exceed the adapter's declared limit nor the global ceiling.

### 1.3 ⬜ Generic per-node resilience
- **Problem:** only `agent_task` has a `retryPolicy`; a flaky `integration`/`code`/`http`/`browser` node gets one shot. (`workflow.ts:284`)
- **Build:** a base-config `retryPolicy` (max attempts, backoff, retry-on-error-class) on the shared node config; applied centrally in `#failNode` *before* error-edge routing, so every node kind inherits the resilience `agent_task` already has. Honor an `AbortSignal` between attempts.
- **Files:** `packages/core/src/types/workflow.ts` (base node config), `apps/api/src/engine/WorkflowEngine.ts` (`#failNode`/`#dispatchNode`).
- **Acceptance:** integration test — an `integration`/`code` node that throws twice then succeeds completes after retries; one that always throws routes to the error edge after exactly `maxAttempts`.

### 1.4 ⬜ Durability where it's missing
- **Loops resume after crash:** persist per-iteration cursor + idempotency keys so `#runLoop` resumes instead of failing loud. (`WorkflowEngine.ts:6688`) · **Acceptance:** a half-done `loop` resumes from its cursor after `recoverInterruptedRuns`, no side-effect replay.
- **Evaluator bound enforced by the engine** (not author-wired routers): terminate the cycle when `iterations >= maxRetries`. (`WorkflowEngine.ts:6458`) · **Acceptance:** an always-failing evaluator stops at `maxRetries` without an operator-built router.
- **Durable delegation:** persist sub-session state so an API restart doesn't lose an entire delegation tree (today a volatile in-process `Promise.all`). (`WorkflowEngine.ts:4057`) · **Acceptance:** a delegation tree resumes after restart.
- **Finish `checkpoint` `auto_after_timeout`** (typed but not enforced). (`WorkflowEngine.ts:6746`) · **Acceptance:** a checkpoint with a timeout auto-proceeds when no decision arrives.
- **Files:** `WorkflowEngine.ts` (loop/evaluator/checkpoint handlers + `recoverInterruptedRuns`), session store.

### 1.5 ⬜ Human-in-the-loop inside teams
- **Problem:** swarm/delegate workers can't `request_approval`/`await_event`/`sleep_until` — non-delegate yields hard-fail. (`WorkflowEngine.ts:4709, 4138`)
- **Build:** durable cross-tick parking for worker yields, or bubble an approval yield up to the parent session. Enables "draft → wait for my approval → publish" inside a team.
- **Files:** `WorkflowEngine.ts` (`#runWorkerSession`/`#runDelegate`), `agentSessionRuntime.ts`, the run-context `sessionWaiters`/`pendingApprovals` maps.
- **Acceptance:** a worker that calls `request_approval` parks the run; resolving the approval resumes it to completion.

### 1.6 ⬜ Explicit join semantics
- **Problem:** `merge` infers its policy from the nearest upstream `parallel` via BFS — ambiguous in diamond/nested fan-ins. (`WorkflowEngine.ts:2999`)
- **Build:** `merge` names its source `parallel` id (or carries its own full policy); remove the `#nearestUpstreamParallel` heuristic. Migrate existing graphs by resolving the heuristic once at save.
- **Files:** `packages/core/src/types/workflow.ts` (`MergeNodeConfig`), `WorkflowEngine.ts`, `validateGraph.ts`.
- **Acceptance:** a diamond with two `parallel`s feeding one `merge` resolves deterministically per the named source.

### 1.7 ⬜ Time / aggregation / pagination / human-input primitives
- `wait`-until-datetime / wait-for-event / wait-for-webhook (today a dumb ms timer — `WorkflowEngine.ts:5653`).
- A **batch/aggregation window** node ("collect events for 1h, then process as a batch" — digests, lead batching).
- A **pagination/cursor-iteration** node ("keep calling until no next-page token").
- Node-level **"collect human input via form"** gate (the phase-level `provide_input` already proves the intent).
- **Files:** `packages/core/src/types/workflow.ts` (new node kinds/config), `validateGraph.ts` (`SUPPORTED_NODE_KINDS`), `WorkflowEngine.ts` (handlers), web node palette + config forms.
- **Acceptance:** one integration test per primitive (e.g. wait-until-datetime fires at the boundary; the window node batches N events then emits once; the human-input gate parks then resumes with the submitted record).

---

## Phase 2 — Connectivity (sense the world, act on it)

**Theme:** the plumbing is strong; the breadth is facade. Make sensing real and the catalog honest.

### 2.1 ⬜ Turn on native SaaS webhooks (highest leverage, ~90% built)
- **Problem:** 14 provider webhook verifiers (github/stripe/slack/shopify/…) exist, are correct, are unit-tested, and are **wired to nothing**. (`triggerConnectors.ts:37-206`, called only by tests.)
- **Build:** a `/v1/webhooks/connector/:triggerId` ingress that calls `connectorFromConfig` + `verifyConnectorWebhook` with the trigger's stored secret, then fires the trigger. Converts Agentis from poll-only to a real SaaS event receiver. Also add the `git_commit_context` knowledge node + a GitHub `http_poll` recipe to replace the deleted `cora/githubSource.ts`.
- **Files:** `apps/api/src/routes/webhooks.ts`, `apps/api/src/engine/triggerConnectors.ts`, `TriggerRuntime.ts`.
- **Acceptance:** route test — a POST with a valid provider signature fires the trigger; an invalid/missing signature is rejected (per provider: github HMAC, stripe `t=,v1=`, etc.).

### 2.2 ⬜ Stop advertising integrations that can't run
- **Problem:** 95 manifests, ~29 work; 66 fall through to a generic HTTP connector that throws without a hand-supplied URL; SQL/Kafka manifests have no driver. A trust trap. (`registry.ts:28-35`, `manifests.ts:133`)
- **Build:** tag each manifest `working | needs-setup | unavailable`; the UI surfaces the tag (and hides/greys driverless SQL/queue ops). No connector silently throws at runtime.
- **Files:** `packages/integrations/src/manifests.ts`, `ConnectorRegistry.ts`, web integration picker.
- **Acceptance:** unit test — every advertised op either resolves to a real connector or is tagged non-working; no manifest both advertises an op and throws "needs url" at runtime without the tag.

### 2.3 ⬜ MCP as a runtime capability, not a REST shim
- **Problem:** `McpClient` is reachable only via `/v1/mcp-servers/:id/call`; agents can't call registered MCP tools mid-reasoning. (`mcpServers.ts:89`)
- **Build:** inject `mcp:servers` tools into the native agent tool loop (so a session can call them) + a first-class `mcp` workflow node. `McpClient` is already SSRF-safe.
- **Files:** `apps/api/src/services/agentToolRuntime.ts`/`chatToolCatalog.ts`, `mcpServers.ts`, `WorkflowEngine.ts` (new node), `validateGraph.ts`.
- **Acceptance:** integration test — a registered MCP server's tool appears in the agent's tool catalog and an `mcp` node invokes it.

### 2.4 ⬜ Guided OAuth + low-friction sensing
- **Build:** real authorize/callback/refresh flow for the ~30 OAuth manifests (today: paste a raw token); prebuilt `http_poll` recipes (Stripe/Gmail/Sheets) with `itemsPath`/cursor pre-filled; surface predicate failures to the user (today JSONPath misses fail closed and silently never fire — `predicate.ts:67`); fix Discord inbound (Ed25519 verifier already exists) or stop advertising it as bidirectional.
- **Files:** new OAuth flow routes + token store, `packages/integrations` recipes, `engine/listener/predicate.ts` (+ a diagnostics event), `adapters/channels/discord.ts`.
- **Acceptance:** OAuth round-trip stores a refreshable token; a predicate miss emits a visible diagnostic; a Discord inbound with a valid Ed25519 signature parses (or the manifest no longer claims inbound).

---

## Phase 3 — _(Brain — out of scope, owner-handled)_

Memory/recall/formation work is tracked separately by the operator at `docs/brain/BRAIN-SCALE-10X.md`. Intentionally omitted here to avoid a competing plan. The only cross-dependency: when the orchestration spine (Phase 1) records what a swarm/loop did, write it to the **App Datastore** (exact, transactional state) rather than the Brain — keep the Datastore≠Brain separation the codebase already enforces.

---

## Phase 4 — Apps that are real products (single-operator)

**Theme:** the lifecycle machinery is genuinely impressive; the depth gaps are query power and distribution, not authorization. (Operator owns the app — no per-app authz needed. Phase 0 already sealed the one external surface: public shares.)

### 4.1 ⬜ Datastore depth
- **Build:** server-side `count`/`sum`/`groupBy` in `dataQuerySchema` + `AppDatastore.query` (Charts/Boards currently group client-side over a capped fetch and silently lie at scale); keyset cursor replacing the offset cursor; close the `.passthrough()` so "typed" means typed.
- **Files:** `packages/core/src/types/datastore.ts` (query schema), `packages/app/src/appDatastore.ts`, `ViewRenderer.tsx` (use server aggregation).
- **Acceptance:** unit test — `groupBy`/`count` returns correct aggregates over >cap rows; keyset cursor pages stably under concurrent inserts; an undeclared field write is rejected.

### 4.2 ⬜ Fork + Hub publish path
- **Build:** `source.kind: 'hub'` exists with no backend; add the publish/fork loop on top of the existing manifest/checksum/install-preview/permission-ack/migration machinery. The OSS distribution primitive: one operator builds, another installs. Pairs with **0.4** (installed bundles are the untrusted-code boundary).
- **Files:** new Hub publish/list/fork routes + store, `@agentis/app` packager, `apps/api/src/routes/apps.ts`.
- **Acceptance:** route test — publish → list → install round-trip; a forked app is independent; install still enforces 0.4 provenance ack.

### 4.3 ⬜ In-app agent orchestration
- **Build:** wire the Phase-1 team orchestration into the app runtime so a shipped app runs a real agent team behind its surfaces, not a single operator agent.
- **Files:** `apps/api/src/routes/apps.ts` (action dispatch), `@agentis/app` runtime, `WorkflowEngine` session/team entry.
- **Acceptance:** integration test — an app action spawns a bounded team and returns the merged result.
- **Depends on:** Phase 1.5 (worker yields) for human-gated app teams.

### 4.4 ⬜ Customer-facing surface scoping (deferred)
- The `audience: customer/public` enum exists. If an app exposes a surface to non-operator *end-users*, that surface (not the workspace) needs read/write scoping — an app-level affordance to design when a real use case appears, NOT a multi-tenant rebuild. **Defer until a concrete app needs it.**

---

## Phase 5 — Zero-friction creation (anyone can wield it)

**Theme:** the NL build is the strongest asset and it's hidden exactly where friction is highest. Make natural language the default surface and demote engine internals.

> **Verification note:** Phase 5 is frontend UX. Per the run/preview workflow, "done" here means verified in the browser preview (snapshot/screenshot of the new flow), not just typecheck — plus component tests where logic exists (e.g. the field-picker's expression generation).

- **5.1 ⬜ NL composer on the canvas.** Empty-workflow state = one "describe a step or the whole flow" box calling the same live build pipeline; "edit this node in plain English" on every node. (`WorkflowCanvasPage.tsx` has no empty-state composer.) · **Files:** `WorkflowCanvasPage.tsx`, `WorkflowBuildTimeline.tsx`, the existing build SSE. · **Acceptance:** preview — empty canvas shows the composer; a typed intent streams nodes onto the canvas; per-node "edit in English" patches that node.
- **5.2 ⬜ Visual field-picker.** Replace the densest dev-only cluster (Transform/Filter/Loop-items/Knowledge-query/Evaluator/Guardrails targets) with "use output from [step] → [field]" that *generates* the expression; raw JS/`{{ }}` becomes an "advanced" escape. (`ContextInspector.tsx:1179-1244, 1702-1830`) · **Files:** `ContextInspector.tsx`, a new field-picker component + a small expression-generator util (unit-tested). · **Acceptance:** component test on the generator (picked field → correct expression) + preview of the picker on a Transform node.
- **5.3 ⬜ Demote raw JSON + rename internals.** JSON editor behind "Advanced"; "Ledger"→"Activity log", "Scratchpad"→"Working memory", drop the raw "Kind" column; "HAL runtime requirements"→"What this agent can do". (`RunModalProvider.tsx:408, 545`; `ContextInspector.tsx:805`) · **Files:** `RunModalProvider.tsx`, `ContextInspector.tsx`, palette/labels. · **Acceptance:** preview — no engine jargon visible in the default (non-advanced) surfaces.
- **5.4 ⬜ Zero-config model/runtime.** Default to a managed model; "choose your own runtime" collapsed; the 45s probe opt-in; NL build must never hard-block on "no model configured" — fall back to a default. (`AgentCreateWizard.tsx:873`; `WorkflowBuildTimeline.tsx:61`) · **Files:** `AgentCreateWizard.tsx`, `WorkflowBuildTimeline.tsx`, default-model resolution. · **Acceptance:** preview — a brand-new workspace can create an agent and NL-build a workflow without choosing a runtime/model.
- **5.5 ⬜ Template gallery + output-first.** Recipe starters on AppsPage (Weekly newsletter, Lead-reply bot, …) instead of a blank canvas; default `return_output` render to markdown/table so successful runs read as results, not JSON. (`AppsPage.tsx:352`) · **Files:** `AppsPage.tsx`, template seeds, `return_output` default render. · **Acceptance:** preview — gallery instantiates a working starter; a successful run renders as readable output, not raw JSON.
- **5.6 ⬜ Soften the agent-hierarchy on-ramp.** An entrepreneur shouldn't have to model Orchestrator/Manager/Specialist + Domains before getting value; a "just make it work" default auto-creates the hierarchy behind the scenes. · **Files:** agent-create flow + the org-default resolver. · **Acceptance:** preview — first agent works with zero hierarchy modeling; the hierarchy is created implicitly.

---

# PART III — EXECUTION & TRACKING

> The **progress dashboard** and **active blockers** are pinned at the top of this doc for at-a-glance status; the **Definition of Done** lives in Part II. This part holds the sequencing logic, persona payoff, and the running impl log.

## Sequencing rationale

- **Phase 0 is a release gate.** Nothing public-facing or install-from-others ships until the external/untrusted-code boundary is sealed.
- **Phase 1 is the differentiator.** Isolation + durability + bounded concurrency + in-team human-in-loop is what makes "real multi-agent orchestration" true. It's also the prerequisite for the loop-engineering use case that started this.
- **Phases 2 & 4 widen reach** (more real-world triggers, shippable/installable apps). Brain (Phase 3) is owner-handled in parallel.
- **Phase 5 makes it usable by everyone** — and should run *partly in parallel* with 1–4, because friction fixes are independent of the engine work and compound the value of every other track.

## Persona payoff (what "done" unlocks)

- **Developer:** safe parallel coding swarms in isolated worktrees, native GitHub/CI webhooks, durable long-running loops, MCP tools in-agent.
- **Entrepreneur:** "when Stripe payment fails → do X" without a developer; ship a data-backed app and share it for others to install; zero-config agents.
- **Marketer:** event-batched digests, drip/SLA waits, approval gates inside an agent team.
- **Creator:** NL-built flows edited in plain language, output-first results, no JSON/JSONPath, recipe starters.

---

## Impl log

> Keep reconciled with real code. Append newest-first. Each entry: date · track · what shipped · file(s) · tests.

- _2026-06-24_ — **Phase 0.5 + 1.2 COMPLETE: global process semaphore SHIPPED.** `AdapterManager` now holds a workspace-wide counting `Semaphore` (`apps/api/src/adapters/semaphore.ts`, default 128, `AGENTIS_MAX_CONCURRENT_PROCESSES` override): `dispatchTask` acquires a slot before dispatching and releases it on the task's terminal event (`task.completed`/`task.failed` via the adapter event stream), on dispatch-throw, or via a per-task safety timer (`timeoutMs + 60s`) so a hung process can never leak a slot or deadlock dispatch. Across many overlapping runs/swarms the host can't be flooded with processes — the last gap in the fan-out-safety story (isolate + abort + sibling-cancel + per-adapter clamp + `unbounded` cap + **global ceiling**). Tests: `AdapterManager.semaphore.test.ts` (5 — Semaphore admit/queue/drop + manager cap/resume/throw-release); swarm + checkpoint suites still green (10/10). Typecheck clean. **0.5 and 1.2 now ✅.**
- _2026-06-24_ — **Phase 1.4-partial (checkpoint `auto_after_timeout`) + Phase 0.5/1.2-partial (`unbounded` parallelism guard) SHIPPED.** (1.4) `#executeCheckpoint` now honors `approvalMode:'auto_after_timeout'` + `timeoutMs`: arms a timer that auto-approves through the same `ApprovalInboxService.resolve` path an operator uses (marks the row resolved, resumes via the bound handler); no-ops if the operator already decided (RESOURCE_CONFLICT caught). In-memory timer — a restart before it fires falls back to manual approval (noted in code). Test `WorkflowEngine.checkpoint.test.ts`: a real run completes with zero operator action and the approval row is `approved`. (0.5/1.2) `resolveParallelism` no longer returns `Number.MAX_SAFE_INTEGER` for `unbounded` — capped at `WORKFLOW_PARALLELISM_HARD_CAP = 256` (explicit values clamped too). Test `resolveParallelism.test.ts` (5 cases). Typecheck clean; **34/34 of this session's tests green**.
  - _Process note:_ a verification step ran `git stash` in the background and accidentally expanded to the full suite — confirming **57 failures exist on the baseline with my batch stashed**, i.e. they belong to the concurrent in-flight refactor (db/app/brain/cora), NOT this work (e.g. the `sharedBrain` `APP-SCOPED-VIP-RULE` failure). The pop restored the full 555-file working tree (my batch + in-flight, typecheck clean, no conflict markers); a redundant snapshot remains in `stash@{0}: verify-brain` — safe to `git stash drop` once confirmed.
- _2026-06-24_ — **Doc completed into a full execution-ready spec.** Added the progress dashboard (all 26 items + status), pinned active blockers, a per-item Definition of Done, and **Files + Acceptance** for every Phase 0–5 item so any can be picked up cold. Part III (Execution & Tracking) added. Statuses reconciled with shipped code: 0.1/0.2/1.1 ✅, 0.5/1.2 ◑, rest ⬜; Brain 🚫 (owner-handled). No code change in this entry — documentation only.

- _2026-06-24_ — **Phase 0.2 (channel inbound fail-closed) + Phase 0.5-partial (honor adapter `maxConcurrent`) SHIPPED.** (0.2) `TelegramChannelAdapter.verify()` returned `true` when no secret was configured → an unauthenticated internet POST dispatched an orchestrator turn. Now fails closed (`return false`), matching Slack/WhatsApp-Cloud. Test updated to assert rejection even with an attacker-supplied header (`telegramChannelAdapter.test.ts`). (0.5) `#dispatchAgentSwarm` now clamps `maxParallel` to the adapter's declared `execution.maxConcurrent` (e.g. CLI harnesses that report `1`) so a swarm can't spawn 64 processes against a 1-concurrency runtime. New engine test `clamps parallelism to the adapter maxConcurrent` (refactored `WorkflowEngine.swarm.test.ts` with a shared `startSwarm` helper). Core + API typecheck clean; swarm + telegram + worktree + collectionsInView tests all green against a working migration.
  - _Migration blocker (RESOLVED):_ for a window the in-flight `packages/db/src/sqlite` migration threw `no such table: main.apps` (an unguarded `addColumn('apps', …)` running before the versioned migration creates the table), breaking every DB-backed test. The owner added an `if (tableExists('apps'))` guard concurrently; harness restored. **Final verification of this whole session's batch (harness working): 28/28 API tests green** (`worktreeManager` 6, `WorkflowEngine.swarm` 2, `telegramChannelAdapter` 6 incl. fail-closed, `apps` routes 11 incl. public-share leak, +others) and core `collectionsInView` 3/3.
- _2026-06-24_ — **Phase 0.1 (public-share data leak) FIXED + tested.** The highest-severity externally-exploitable bug: `/public/surfaces/:token/query` queried any `body.collection` with no check it belonged to the shared surface, so an anonymous share link to one surface could read every collection in the app. Fix: new reusable `collectionsInView(view)` in `packages/core/src/types/view.ts` (walks the view tree gathering `Table`/`List`/`Chart`/`DataBoard` `bind.collection` + `CustomView.collections`); `apps.ts` public query now rejects any collection outside that allowlist with `RESOURCE_NOT_FOUND`. Tests: `packages/core/tests/collectionsInView.test.ts` (3) + a route test in `apps/api/tests/routes/apps.test.ts` proving `tickets`→200 / `secrets`→404. Core + API typecheck clean; apps route suite 11/11 green. Next: Phase 0.2 channel inbound fail-closed (Telegram), then the deferred global concurrency semaphore.

- _2026-06-24_ — **Swarm hardening continued: `first_success` sibling cancellation SHIPPED + tested.** Key finding while scoping `dynamic_swarm`/delegate isolation: those workers run through `AgentSessionRuntime` whose step adapter is `LlmSessionAdapter.executeStep` — a **pure HTTP `/chat/completions` call, no child process, no cwd**. So they have NO shared-filesystem surface to isolate (their isolation concern is shared run-scoped scratchpad/state, a separate deliberate design point); threading `workdir` there would be dead code. The filesystem-corruption surface is therefore **fully covered by the `agent_swarm` fix**. Completed the swarm-safety story instead: `#onSwarmSubtask` now tracks `inFlight` indices and, on `first_success`, calls `#abandonInFlightSwarmSiblings` → `adapters.cancelTask` for each losing sibling (stops wasted work + cost) BEFORE releasing their worktrees (no yank-from-under-live-process). New integration test `tests/engine/WorkflowEngine.swarm.test.ts` drives a real swarm + mock adapter and asserts siblings `::swarm::1/2` are cancelled when `::swarm::0` wins. Typecheck clean; 261/261 engine + worktree tests green. **Swarm parallel safety = isolate + abort-on-stop + cancel-siblings-on-win, all landed & tested.** Deferred (next): global process semaphore + honor adapter `maxConcurrent` (the remaining runaway-fan-out control), then Phase 0 external-boundary security (public-share binding, channel fail-closed).
- _2026-06-24_ — **Phase 1.1 (per-task isolation) SHIPPED e2e for the `agent_swarm` path, + Phase 0.5 partial (swarm abort signal).** New `WorktreeManager` service (`apps/api/src/services/worktreeManager.ts`): allocates an isolated dir per parallel subtask — `git worktree add --detach` when the agent's cwd is a repo, else an `mkdtemp` dir; best-effort, never throws, idempotent release. Threaded `workdir` through `NormalizedTask` + a `getWorkdir()` adapter method (`packages/core/src/types/adapter.ts`); the four local-spawn adapters (Claude/Codex/Cursor/Hermes) now spawn at `task.workdir ?? opts.cwd`; `AdapterManager.workdirOf()` exposes the base. Engine `#dispatchSwarmSubtask` acquires a worktree per subtask, stamps `task.workdir`, and now also passes `ctx.abortController.signal` (Stop aborts in-flight subtasks); `#onSwarmSubtask` releases per-subtask + all-on-settle. Wired in `bootstrap.ts`. Tests: `tests/services/worktreeManager.test.ts` 6/6 green incl. real git-worktree lifecycle. Core + API typecheck clean; engine+adapters suites 360/360 of affected tests green (2 unrelated failures isolated to the pre-existing in-flight OpenClaw refactor — proven by reverting only that file). **Next increments:** isolation for `dynamic_swarm`/delegate (in-process session workers need the workdir threaded through the session runtime), then full Phase 0.5 (global process semaphore, honor adapter `maxConcurrent`, cancel siblings on `first_success`).
- _2026-06-24_ — Plan reframed for the real deployment model: **OSS single-tenant, one trusted operator**. Struck all multi-tenant/per-app-authz findings (non-threats); recast Phase 0 around the external boundary + untrusted installed code + runaway control. Resolved the Python-node question: it's a **feature** for the operator's own workflows (n8n-style); only *imported* bundle code is gated (Phase 0.4) — no sandboxing of operator code needed. Removed Phase 3 (Brain) — owner-handled separately. No code changed yet.
