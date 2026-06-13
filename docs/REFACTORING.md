# Agentis V2 — Structural Refactoring Plan

**Date:** 2026-04-30
**Status:** Plan, not yet implementation
**Audience:** Engineering, future contributors
**Scope:** Address every structural critique surfaced in the V1 post-mortem with engineered (not patched) solutions.

This document is the response to the V1 critique. Each section names the problem, the constraint that makes the obvious fix wrong, and the engineered solution. No makeshift fixes, no "we'll revisit later" hedges, no monkey-patches over architectural seams. If a fix requires breaking V1 contracts, it breaks them — V2 is a deliberate cut.

---

## Operating Constraints (non-negotiable inputs)

1. **OpenClaw-first stays.** It is a deliberate go-to-market bet on OpenClaw's virality, not an architectural commitment. The refactor must preserve OpenClaw as the canonical first adapter while removing the architecture's *coupling* to it — so opening to LangGraph, AutoGen, CrewAI, or a raw HTTP-agent shape later is configuration, not a rewrite.
2. **AgentisHub is out of scope here.** No design lines spent on it. It is a separate document when its time comes.
3. **ClawHub must be deeply integrated.** Skill discovery against `clawhub.ai` is a first-class in-app experience: search-first, low friction, embedded everywhere a skill is selected. The current "drawer behind a button on `/skills`" is below the bar.

Everything else is on the table.

---

## Section A — The Agent Runtime Abstraction (kills the OpenClaw lock-in without abandoning the bet)

### A.1 The problem
The V1 spec hard-codes OpenClaw as "the reason Agentis exists." The presence event schema, gateway protocol, agent identity model, and canvas semantics all assume OpenClaw shapes. Adding a second runtime today means parallel code paths in every layer.

### A.2 The constraint
We *want* OpenClaw to feel native — better than native, in fact — because that is the GTM wedge. A generic `IAgentRuntime` lowest-common-denominator interface would erase the thing that makes V1 differentiated. The abstraction must let OpenClaw expose its full shape while letting weaker runtimes degrade gracefully.

### A.3 The design — Capability-declared adapters
Replace the implicit "OpenClaw is special" coupling with an explicit **capability manifest** model.

```ts
// packages/core/src/runtime/AgentRuntime.ts
export interface AgentRuntimeAdapter {
  readonly id: string;                          // 'openclaw' | 'langgraph' | 'http-agent' | ...
  readonly displayName: string;
  readonly capabilities: RuntimeCapabilities;   // declared, machine-readable
  connect(config: RuntimeConnectionConfig): Promise<RuntimeConnection>;
  dispatch(task: NormalizedTask): Promise<DispatchHandle>;
}

export interface RuntimeCapabilities {
  presence:        'live' | 'polled' | 'none';     // OpenClaw=live, HTTP=polled, basic LLM=none
  events:          PresenceEventChannel[];          // typed list of streams the runtime emits
  approvals:       'native' | 'shimmed' | 'none';
  conversations:   'streaming' | 'final-only';
  skillExecution:  'remote' | 'host';
  cancellation:    'cooperative' | 'forced' | 'none';
  authModel:       'token' | 'oauth' | 'mTLS' | 'none';
}
```

Every UI surface that today asks "is this OpenClaw?" must instead ask the capability:

- Living canvas presence overlays render only when `capabilities.presence !== 'none'`.
- Approval inbox shows the native flow when `capabilities.approvals === 'native'`, a polite shim ("requested via webhook") when `'shimmed'`, and is hidden when `'none'`.
- Run inspector chooses streaming-token rendering vs. final-message-only based on `capabilities.conversations`.

OpenClaw ships with the maximum capability set on day one. Other adapters slot in when their time comes — they don't add code paths to UI components, they just light up fewer affordances.

### A.4 Migration
- New package `packages/runtime/` extracted from `apps/api/src/adapters/openclaw/`.
- The OpenClaw adapter moves into `packages/runtime-openclaw/` as a published-but-internal-for-V2 module that depends on `packages/runtime/`.
- `apps/api/src/services/runtimeRegistry.ts` becomes the SSoT — adapters self-register via `import './adapters/openclaw'` side effect, no central switch statement.
- Every existing OpenClaw code path is moved behind the adapter boundary; no `if (gateway.kind === 'openclaw')` survives in `apps/api` or `apps/web`.

**Definition of done:** A regression test asserts that grepping `apps/api` and `apps/web` for the literal string `openclaw` outside of `runtimeRegistry`, `routes/gateways.ts`, and copy/i18n files returns zero hits. The wedge stays; the lock-in dies.

---

## Section B — Data Layer: the Postgres-first cut

### B.1 The problem
65+ files, the engine, and every route assume synchronous `better-sqlite3`. SQLite cannot be deployed on Railway (or any auto-scaling platform) without data corruption. The "promote later" plan compounds debt every working day. Concurrency under any real traffic is unsafe.

### B.2 The constraint
SQLite remains the right answer for `pnpm dlx @agentis-ai/cli up` — single-binary local install must keep working without a database server. The cut cannot remove SQLite, only demote it from "production target" to "local-only mode."

### B.3 The design — Async-first dialect-agnostic persistence

**Step 1 — Persistence interface.** Define `packages/db/src/Persistence.ts` as the only allowed contract that touches storage:

```ts
export interface Persistence {
  read<T>(query: PreparedQuery<T>): Promise<T[]>;
  one<T>(query: PreparedQuery<T>): Promise<T | null>;
  write(stmt: PreparedStatement): Promise<WriteResult>;
  tx<T>(fn: (tx: PersistenceTx) => Promise<T>): Promise<T>;
}
```

No service, route, or engine module imports `better-sqlite3` or `pg` directly. Ever. Linted by the restricted-imports ESLint rule.

**Step 2 — Two implementations.**
- `packages/db-sqlite/` — wraps `better-sqlite3`, fakes async (resolved promises). Local-only.
- `packages/db-postgres/` — `pg` + `node-postgres`, real async, real pool, real concurrency.

**Step 3 — Engine async migration.** `WorkflowEngine`, `LedgerService`, `ScratchpadService`, `ConversationStore`, `ActivityFeedService`, `ApprovalInboxService` all become async-everywhere. The fan-out `inflightDispatches` counter generalizes to a `PendingPersistenceWrites` counter — settle predicate now waits for the queue *and* the durable-write in-flight set.

**Step 4 — Schema drift killed.** D40 surfaced the real bug: `schema.ts`, `embedded-sql.ts`, and `migrations/0000_init.sql` are three SSoTs for the same schema, easy to desync. Replace with single Drizzle source → generate both runtime DDL and migration files. Embedded SQL deleted.

**Step 5 — Default flips.** `AGENTIS_MODE` default becomes `postgres`. SQLite is opt-in via `--mode=local` on the CLI and is documented as "single-process local development only — not safe for shared deployments." `railway.toml` provisions Postgres + Redis; the Railway README explicitly warns against SQLite mode.

### B.4 Migration risk control
- Engine async refactor lands behind an off-by-default flag for one release cycle.
- Test suite duplicated: every engine/service test runs once against `db-sqlite` and once against a Postgres testcontainer. CI fails if either tier diverges.
- The ~65 test files migrate via codemod (`jscodeshift`) — not by hand. The codemod is committed alongside the change.

---

## Section C — Engine correctness: end the mock theater

### C.1 The problem
`WorkflowEngine`, `TriggerRuntime`, and `PartialReplayService` — the highest-risk components — are mocked in most route tests. The latent fan-out bug survived multiple batches because nothing exercised real fan-out under contention. Test count is inflated; test confidence is not.

### C.2 The design — Three test tiers, enforced separately

1. **Unit tests** (existing). Mocks allowed. Coverage of branches inside one module.
2. **Integration tests** (new). Real `WorkflowEngine` + real `Persistence` (sqlite in-memory or Postgres testcontainer) + real `LedgerService`. No engine mocks. Required for: every workflow shape primitive (linear, fan-out, merge, router, subflow, replay-from-failed, replay-from-checkpoint).
3. **Property-based tests** (new). `fast-check` generators emit random valid DAGs (bounded depth, bounded width, mixed kinds) and assert invariants:
   - Every started run reaches a terminal status (no orphans).
   - Ledger event sequence is monotonic and gap-free per run.
   - Settle predicate fires exactly once per run.
   - Cancellation always reaches all in-flight nodes within `RUN_CANCEL_GRACE_MS`.
   - Replay-from-failed produces a strict subset of the original ledger up to the failure point.

### C.3 CI gates
- A workflow run cannot ship without integration coverage at every shape tier.
- A property-based suite of ≥1000 random DAGs runs nightly; any counterexample is committed as a regression test.
- The "fan-out settle race" class of bug becomes structurally detectable, not luck-detectable.

---

## Section D — Skill execution: real isolation, not memory-only isolation

### D.1 The problem
ADR-007 calls `isolated-vm` "a real security boundary." It is a *heap* boundary, not a *resource* boundary. A skill with a tight loop pins a CPU, starves WebSocket flushes, and degrades every other run on the host. The regex-based registry scanner stops accidents, not adversaries.

### D.2 The design — Tiered execution with declared capabilities

Each skill manifest declares what it needs; the runtime grants exactly that and enforces it at the OS level.

```ts
export interface SkillManifest {
  // ...existing...
  capabilities: SkillCapabilities;
}

export interface SkillCapabilities {
  cpu:        { maxMs: number; maxCores?: number };
  memory:     { maxMb: number };
  wallTime:   { maxMs: number };
  network:    { allowedDomains: string[] } | 'none';
  filesystem: { paths: { path: string; mode: 'ro' | 'rw' }[] } | 'none';
  env:        string[]; // exact var names
}
```

**Enforcement matrix:**

| Tier | Use case | Boundary | CPU enforcement | Network | Filesystem |
|---|---|---|---|---|---|
| `builtin` | Trusted in-process | None (host) | N/A | host | host |
| `node_worker` | First-party authored | `worker_threads` + `isolated-vm` | `vm.Isolate` cpu time limit + `wallTime` watchdog | proxied `fetch` enforcing `allowedDomains` | none |
| `docker_sandbox` | ClawHub installs | Docker container, read-only rootfs, dropped caps | `--cpus=`, `--cpu-quota`, `--memory=`, OOM-killer | network namespace + egress firewall (`allowedDomains` resolved at start) | tmpfs only, declared mounts |
| `firecracker` | (V3) hosted untrusted | microVM | full kernel boundary | full netns | full FS isolation |

Network enforcement is real: DNS-resolved `allowedDomains` become an iptables/`nftables` allow-list inside the sandbox. The proxied `fetch` in `node_worker` mode validates against the same list (SSRF guard already exists in `safeUrl.ts` — it gets promoted from "best-effort" to "structurally enforced").

### D.3 Registry security beyond SHA-256
SHA-256 verifies transit integrity, not authorship. The regex scanner catches accidents. Neither addresses malicious code.

Add three layers:

1. **Publisher signing.** Every ClawHub artifact carries a Sigstore/cosign signature. Install pipeline verifies signature against ClawHub's published key set. Unsigned artifacts are install-refused (never silently downgraded).
2. **Capability diffing.** On install, the requested `SkillCapabilities` are presented to the operator with a diff against any prior version. Adding `filesystem.rw` to a previously read-only skill triggers a fresh consent prompt — no silent privilege escalation across upgrades.
3. **Static analysis pass.** Replace the regex scanner with a real lint/AST pass (ESLint-based for JS skills, equivalent for other runtimes) that flags: dynamic `eval`, `Function` constructor, `child_process` spawn, raw socket use, prototype pollution patterns. Block-severity findings refuse install. Warn-severity findings surface in the install drawer with line numbers.

These three layers are additive to SHA-256 and the existing scanner — not replacements.

---

## Section E — The Shell, the Canvas, and the Persistent Assistant (UIUX.md, formalized)

### E.1 The problem
UIUX.md (2026-04-29) documents the actual shipped UX as cryptic-glyph navigation, chat-as-a-page, and inspect-by-leaving-the-page. The engineering quality and the UX quality are separated by a chasm.

### E.2 The design — Adopt UIUX.md as a binding spec, not a wishlist
Every P0 in [UIUX.md](UIUX.md) becomes a tracked V2 item. Specifically:

- **Three-zone shell** with labeled left-rail navigation (lucide icons + labels), context bar, and persistent right-side assistant. Live badges on nav items (pending approvals, degraded gateways, unread chat).
- **Chat as a persistent object**: collapsed orb → compact input bar → expanded panel → optional full route. Page-aware placeholder + page-aware quick prompts. The current `/conversations` route stays only for history management.
- **Inspect-in-place** everywhere: drawers and side panels for run detail, agent detail, skill detail, gateway detail, approval detail. The user does not leave the page they were on to read context.
- **Living canvas** stays — direct DOM mutation at 20Hz, FLIP transitions — but is gated by `capabilities.presence`. Adapters that can't stream presence get a respectful static layout, not a broken one.

### E.3 Component test floor
RTL coverage extends to: the new shell, the assistant in all four states, every drawer's open/close/escape/focus-trap behavior. Playwright UI specs cover the page-aware-prompt matrix end-to-end.

---

## Section F — ClawHub deep integration (the search-first skill experience)

### F.1 The problem
ClawHub today lives behind a button on `/skills`, opens a drawer, requires a search, returns results, demands an explicit "install with permissions ack" confirm. This is the right flow for the *install* moment. It is the wrong floor for *discovery*.

The user constraint: ClawHub must be extremely accessible and searchable from inside Agentis everywhere a skill is relevant.

### F.2 The design — ClawHub as ambient skill surface

**F.2.1 Embedded search at every skill-selection point.**
Anywhere the user picks a skill (workflow node config panel, agent capability assignment, command palette, skill page), the picker queries the *union* of installed skills and ClawHub results in a single typeahead. Results are visually distinguished (installed vs. installable) but live in the same list. A keystroke installs and selects in one motion (subject to capability ack).

```
[ Search skills...                          ⌘ ]
─────────────────────────────────────────────────
INSTALLED
  ▸ http_fetch                       (builtin)
  ▸ slack_post                       (v1.2.0)
INSTALL FROM CLAWHUB
  ⤓ openai_chat                      (★ 1.2k, signed)
  ⤓ pdf_extract                      (★ 340)
```

**F.2.2 Command palette is ClawHub-aware.**
`Cmd+K → "install <name>"` queries ClawHub directly, supports prefix and fuzzy match, shows top results inline, and routes the install to the same capability-ack flow.

**F.2.3 ClawHub side-panel.**
A persistent secondary surface (next to the assistant orb) gives the user an always-available "browse skills" affordance: trending, recently published, by capability tag, by author. Clicking opens the install drawer in place.

**F.2.4 In-canvas skill suggestions.**
When a user adds a `skill_task` node and types into the skill field, ClawHub suggestions surface inline — no drawer trip. The recommendation engine is local for V2 (just a typeahead against the cached registry index); ranking improvements come later.

**F.2.5 Caching and offline behavior.**
The `RegistryClient` gains an indexed local cache (LRU, `SKILL_REGISTRY_CACHE_TTL_SECONDS=300` stays for individual entries; the *index* refreshes hourly). Search works against the cache when ClawHub is unreachable; install requires connectivity. The user never sees a dead search box just because ClawHub is slow.

**F.2.6 No regressions to security.**
All installs — palette, inline picker, side-panel, drawer — flow through the same `requirePermissionsAck → fetch → SHA-256 → signature verify → AST scan → capability-diff prompt → record activity` pipeline from Section D. There is no shortcut path.

---

## Section G — The deployment story (so the engineering investment isn't wasted on no users)

### G.1 The problem
Self-hosted infra is losing to managed services. The current install paths (Railway with corrupting SQLite, `pnpm` quickstart) target a vanishing developer profile.

### G.2 The design — Two real paths, each truly supported

1. **Local mode** (`agentis up`). Single-process, SQLite, zero infra. Documented as "for one developer on one machine." The current happy path stays.
2. **Production mode**. Postgres + Redis required. Supplied as:
   - A working `docker-compose.yml` that spins API + web + Postgres + Redis with sane defaults and health-checked dependencies.
   - A Railway template that provisions Postgres + Redis and *refuses* to deploy without them (probe at boot; exit non-zero with a clear message if `AGENTIS_MODE=postgres` is set without `DATABASE_URL`).
   - A documented backup/restore story that uses `pg_dump`/`pg_restore` for production and the existing CLI backup for local mode.

There is no third "Railway with SQLite" path. It is removed because it cannot be made safe.

### G.3 Operational baseline
- Health endpoint splits into `/healthz` (process up) and `/readyz` (DB reachable, Redis reachable, migrations applied).
- OTel hooks already in place (D38) become the default-on instrumentation in production mode (no-op when no exporter configured — already true).
- Audit log middleware already covers `/v1/*` (D38). Extend coverage assertion test to fail if a new route bypasses it.

---

## Section H — Sequencing

This is not a "do everything in parallel and hope" plan. The order is load-bearing.

| Phase | Lands | Unblocks |
|---|---|---|
| **0** | Section C (test tiering, property-based engine tests) | Confidence to refactor anything else |
| **1** | Section B Steps 1–3 (`Persistence` interface, async engine, dual SQLite/Postgres impls) | Section G; removes the corruption time-bomb |
| **2** | Section A (runtime adapter extraction) | Future agent-framework support without rewrite |
| **3** | Section D (skill execution boundaries, signing, capability diffing) | Safe expansion of ClawHub usage |
| **4** | Section F (ClawHub deep integration) | The product becomes obviously useful day one |
| **5** | Section E (shell, persistent assistant, inspect-in-place) | The product becomes usable by non-builders |
| **6** | Section G (deployment story, defaults flip) | The engineering investment reaches users |

Phase 0 must complete before Phase 1 starts — refactoring an engine without integration tests is malpractice. Phases 4 and 5 can run partially in parallel (different teams, minimal file overlap). Phase 6 is a copy/config/marketing pass once 1–5 are real.

---

## Section I — What this plan is *not*

- It is not a rewrite. The engine, services, schema, and adapters from V1 mostly survive — they get re-fronted by interfaces, re-backed by Postgres, and re-fenced by capability declarations.
- It is not a feature list. No new product surfaces are proposed beyond UIUX.md and ClawHub depth. The cost of V2 is paid in correctness, not in surface area.
- It is not a guess at the business model. That is a separate document. This plan ensures that whichever model the company picks (managed cloud, paid runtime, enterprise self-host, hybrid), the *technical foundation* doesn't have to be rebuilt to support it.

---

## Definition of Done for V2

A claim of V2-complete requires all of the following to be true simultaneously:

1. `grep -r 'better-sqlite3' apps/api/src apps/web/src packages/*/src` returns zero hits outside `packages/db-sqlite/`.
2. `grep -ri 'openclaw' apps/api/src apps/web/src packages/*/src` returns zero hits outside `packages/runtime-openclaw/`, the runtime registry, and the i18n/copy bundles.
3. Property-based engine suite runs ≥1000 random DAGs nightly with zero counterexamples for two consecutive weeks.
4. Every skill execution path enforces `SkillCapabilities` at the OS boundary (verified by an integration test that asserts a deliberately misbehaving skill is killed by the sandbox, not by the host).
5. Every ClawHub install passes signature verification, capability-diff acknowledgement, and AST-based static analysis. An unsigned artifact cannot be installed by any code path.
6. The new shell, persistent assistant, and inspect-in-place drawers are the default UX; legacy glyph navigation and `/conversations`-as-primary-chat are removed.
7. ClawHub search appears at every skill-selection surface (workflow node, agent capability, command palette, side panel) and works against a local cache when ClawHub is unreachable.
8. Production deployment requires Postgres + Redis. SQLite mode is structurally local-only and documented as such. CI runs the full test suite against both backends on every PR.

When all eight are true, V2 is done. Until they are, it is not.
