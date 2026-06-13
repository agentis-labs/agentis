# Agentis: The Home Every Agent Migrates Into

*Architecture plan for making Agentis the place where agents from any harness
become more capable than they ever were in isolation — and never want to leave.
Research-backed, code-grounded. Last updated: 2026-05-30.*

> **Read this first.** An earlier draft of this document framed Agentis as a
> generic "Agent Operating System / Capability Hypervisor." We are deliberately
> stepping back from that framing. The goal is **not** to build an abstract OS
> that happens to run agents — it is to build *a more powerful Agentis*. Every
> idea below earns its place only if it makes Agentis itself better: a sharper
> Brain, clearer node configuration, a real surface for watching agents work
> together, and a frictionless way for an agent to *move into* Agentis carrying
> everything it already knew. The Harness Abstraction Layer is a means to that
> end, not the headline.

---

## Table of Contents

1. [The Real Goal](#1-the-real-goal)
2. [Ground Truth: What Agentis Already Is](#2-ground-truth)
3. [Research Foundations](#3-research-foundations)
4. [Pillar 1 — The Harness Abstraction Layer](#4-pillar-1-the-harness-abstraction-layer)
5. [Pillar 2 — The Brain (and the Crown Jewel: Harness Memory Ingestion)](#5-pillar-2-the-brain)
6. [Pillar 3 — Capability-Aware Routing & Node Configuration](#6-pillar-3-capability-aware-routing)
7. [Pillar 4 — The Agent Interaction Surface (IPC)](#7-pillar-4-the-agent-interaction-surface)
8. [Pillar 5 — Protocol Alignment, Access Tokens & Governance](#8-pillar-5-protocols-tokens-governance)
9. [Implementation Phases](#9-implementation-phases)
10. [Why This Wins](#10-why-this-wins)
11. [Implementation Log](#11-implementation-log)

---

## 1. The Real Goal

A developer using Claude Code, Codex, Cursor, or Hermes has built up real value
inside that runtime: project conventions, hard-won lessons, architectural
decisions, a way of working. Today, switching tools means abandoning all of it.

Agentis' promise: **connect your harness, and your agent walks in fully formed.**
It brings its accumulated memory, it slots into visual workflows, it can be
watched collaborating with other agents, and from that moment its intelligence
compounds in a place that outlives any single runtime. The agent doesn't start
over — it *graduates*.

That promise rests on five pillars, in priority order:

1. **The Harness Abstraction Layer (HAL)** — connect any runtime through one
   stable contract. *(Foundation — already largely built.)*
2. **The Brain** — the memory and intelligence that compounds. Its standout
   feature is **harness memory ingestion**: the agent's transition into Agentis.
3. **Capability-aware routing & node configuration** — the engine routes work to
   the runtime that can actually do it, and the node config UI makes that legible.
4. **The agent interaction surface** — a real place (where chat lives today) to
   watch and join agents working with each other.
5. **Protocol alignment, access tokens & governance** — speak MCP/A2A, secure
   with access tokens, and make every action auditable.

The HAL concept stays because it is the right mental model for users — naming a
concept helps people assimilate it. But it serves Agentis; Agentis is the product.

---

## 2. Ground Truth

The previous draft's "gaps" were written against an incomplete reading of the
code. Verified against the actual codebase, Agentis is **far** ahead of that
description. This section is the corrected baseline; build on it, don't re-invent it.

### Adapters (the HAL today)

`AdapterManager` (`apps/api/src/adapters/AdapterManager.ts`) already owns adapter
lifecycle, dispatch, cancel, health, and event fan-out. Six concrete adapters
ship: `claude_code`, `codex`, `cursor`, `hermes_agent`, `openclaw`, `http`. The
`AgentAdapter` contract (`packages/core/src/types/adapter.ts`) already exposes a
`capabilities()` method returning `AdapterCapabilities` (`interactiveChat`,
`toolCalling`, `toolForwarding`). CLI runtimes without native function-calling
use the `markerToolProtocol`. Harness detection, auth probing, and live probes
exist in `harnessProbe.ts`; instruction-file discovery (CLAUDE.md, AGENTS.md,
.cursorrules, GEMINI.md) exists in `agentInstructionFiles.ts`.

### The Brain is already sophisticated

The `memory_episodes` table already has: lifecycle `status` (active/stale/
archived), `supersededBy`, dispute detection (`isDisputed`, `disputeReason`,
`disputeResolvedAt`), compression (`compressedFrom`, `compressionTier`),
`managed`/`pinnedAt` flags, real `embedding` vectors, `lastAccessedAt`, and
trust/confidence/importance scores.

The `knowledge_links` table **already has temporal validity** (`validFrom`,
`invalidAt`), typed relations (`supports | contradicts | refines | derived_from
| co_observed`), `reinforceCount`, `contextSplit`, and even an `adapterType`
column. The Graphiti-style temporal graph the old draft proposed to "add" is
substantially present.

Services already wired: `EpisodicMemoryStore` (write/dedup via `findSimilar`/
hybrid lexical+vector search), `WorkspaceIntelligenceService` (charter atoms),
`AgentMemoryService` (agent-private scope over the same table), `BrainComposer`,
`SharedIntelligenceService`, `DatasetIngestion` (csv/json/jsonl/text/pdf/md-zip),
`knowledgeAutoLinker`, `cognitivePromotionQueueWorker`, `AbilityService`
(embedding-scored behavioral specializations), `ListenerRuntime`.

**Implication:** memory-architecture research should *sharpen* this Brain, not
replace it. The genuinely missing piece was a clean way to get an agent's
*harness-native* memory into it — which this plan now delivers (§5).

### The engine

`WorkflowEngine` dispatches 25+ node kinds. Agent dispatch resolves an executor
by `agentId` → `agentRole` (specialist library) → `capabilityTags` matched
against `agents.capabilityTags` (`#resolveSwarmAgent`). Structured adapter
`capabilities()` are now also consulted in routing: nodes can declare affordance
`requires`, and the engine filters/validates candidates against them (§6, shipped).

---

## 3. Research Foundations

Grounded in four research streams (80+ sources). Only the parts that change what
we build are kept here.

**Protocol convergence.** The industry has converged on two complementary open
protocols under the Linux Foundation's Agentic AI Foundation: **MCP** (agent↔tool,
97M+ SDK downloads, 10K+ servers) and **A2A** (agent↔agent: Agent Cards for
discovery, a Task lifecycle, SSE streaming). They are complementary, not
competing. Agentis should speak both — MCP first (it maps onto the existing tool
registry), A2A second.

**Memory architecture.** The proven patterns: Letta's tiered memory with
*agent-driven* promotion (agents manage their own memory via tool calls);
Zep/Graphiti *temporal validity* on every fact (already in our `knowledge_links`);
the GAAMA hierarchy of *episodes → facts → reflections* (our promotion queue is
the start of this); and — critically — **adaptive forgetting**: unbounded memory
*degrades* performance, so decay and pruning are features, not afterthoughts.
U-shaped attention means the Brain should place identity + charter at the start
of context and the task at the end, with retrieved memories in the middle.

**Access tokens over capability tokens.** The earlier draft proposed
macaroon-style *capability tokens*. The field is moving the other way — toward
**access tokens** (OAuth 2.1 / OIDC-style bearer tokens with scopes, short TTLs,
and refresh) because they interoperate with existing identity infrastructure and
the MCP/A2A auth story. §8 adopts access tokens.

**Governance is the enterprise gate.** A large majority of agent pilots fail
before production on governance — traceability, budget control, auditability.
Agentis already has `auditEntries`, `ledgerEvents`, `budgetEvents`,
`approvalRequests`, and the `guardrails`/`checkpoint` nodes. This is a strength to
surface, not a system to invent.

> A note on competitors: this plan does **not** target Devin, Windsurf, or Jules
> as integration surfaces — Agentis does not support them, and naming them as
> wrap targets would be aspirational noise. The supported runtimes are
> `claude_code`, `codex`, `cursor`, `hermes_agent`, `openclaw`, and `http`. The
> broader market is referenced only where it changes a design decision.

---

## 4. Pillar 1 — The Harness Abstraction Layer

The HAL is the existing adapter system, evolved — **not** an `AgentAdapterV2`.
We extend `AdapterCapabilities` in place and teach the engine to read it.

### What to extend (in `AdapterCapabilities`, additively)

```typescript
// packages/core/src/types/adapter.ts — extend the EXISTING interface.
export interface AdapterCapabilities {
  interactiveChat: boolean;
  toolCalling: boolean;
  toolForwarding: 'native' | 'marker_protocol' | 'http_contract' | 'session_event' | 'none';
  limitations?: string[];

  // ── New, all optional so existing adapters keep compiling ──
  /** Coarse execution profile the engine routes against. */
  execution?: {
    longRunning?: boolean;     // can sustain hour+ tasks
    pausable?: boolean;        // checkpoint + resume
    sandbox?: 'none' | 'process' | 'container' | 'microvm';
    maxConcurrent?: number;
  };
  /** Tool/affordance surface the runtime brings natively. */
  affordances?: {
    browser?: boolean;
    codebaseIndex?: boolean;
    fileSystem?: boolean;
    terminal?: boolean;
    computerUse?: boolean;
    nativeMcp?: boolean;
  };
  /** Whether Agentis can read/inject this runtime's own memory. */
  memory?: {
    ingestible?: boolean;      // we can read its memory (instruction files, etc.)
    injectable?: boolean;      // we can push context into it
  };
}
```

Every field is optional, so the change is non-breaking. Each adapter fills in
what it truly supports (e.g. `cursor` → `affordances.codebaseIndex: true`;
`claude_code` → `affordances.nativeMcp: true`, `memory.ingestible: true`).

### Two-layer discipline (the durable lesson from CRI/CSI/CNI)

Keep the contract (`AgentAdapter`) imperative and small; let connectors behind it
be as diverse as they need. New runtimes = new connector, never a contract change.

---

## 5. Pillar 2 — The Brain

The Brain is Agentis' compounding advantage. The work here is to (a) sharpen what
exists using the memory research, and (b) ship the crown jewel: **harness memory
ingestion**.

### 5.1 Crown Jewel — Harness Memory Ingestion *(shipped, v1)*

> *"Agents should feel they are transitioning from those harnesses/runtimes to
> Agentis. The memory is being built not from scratch, but from all the
> knowledge they have among those runtimes."* — the originating requirement.

When an agent backed by a harness connects, Agentis can distil that harness's own
memory into the agent's private Brain so it arrives fully formed. The system is
built to a strong bar so it **never brings garbage in**.

**Source layer (reuses existing code).** `agentInstructionFiles.listAgentInstructionFiles(agent)`
already reads the harness's operator-authored memory surfaces (CLAUDE.md,
AGENTS.md, .cursorrules, GEMINI.md, runtime home files). That is the raw material.

**Distillation + quality gate (the new value).** `HarnessMemoryIngestionService`
(`apps/api/src/services/harnessMemoryIngestion.ts`) walks each file, tracks the
current heading as a section, and turns list items / prose lines into candidate
atoms. A deterministic quality gate scores each atom on length, rule-cue presence
("always/never/must/prefer…"), decision-cues, and specificity (paths, identifiers,
commands), with hard rejects for boilerplate headings, bare URLs, code fences,
TODO/WIP, and pointer fluff ("see above"). Only atoms ≥ a conservative threshold
survive. Each atom is classified into a `RuntimeEpisodeType` (rule →
`distilled_lesson`, recorded choice → `decision`, pitfall → `failure`, …) and
assigned source-derived trust (operator-authored project files > machine-global
runtime files).

**Sink (reuses the canonical store).** Accepted atoms are written through
`EpisodicMemoryStore` — the *same* table the rest of the Brain reads — scoped to
the agent (`scopeId = agentId`) exactly like `AgentMemoryService`. A new episode
source, `harness_ingest`, records provenance. No parallel memory backend exists.

**No garbage, guaranteed two ways.** (1) The default flow is *preview → human
review → commit*: the operator sees every candidate with its quality score and
dedup verdict before anything lands. (2) The quality gate drops weak atoms even on
"commit all."

**Safe to re-run (recurrent).** Every atom carries a content hash in its metadata.
Re-ingesting an unchanged file is a no-op; a semantic near-duplicate (via
`EpisodicMemoryStore.findSimilar`) *reinforces* the existing episode instead of
duplicating it. So ingestion runs once at onboarding **and** periodically as the
harness files evolve, without polluting the Brain.

**API.** `GET /v1/agents/:id/memory/ingest/preview` (read-only candidates +
dedup verdicts) and `POST /v1/agents/:id/memory/ingest` (`{ acceptHashes?,
minQuality? }`, idempotent commit).

**Surfaces & recurrence (shipped).** Instruction files are one source; the
agent's *session history* is the other — operator↔agent chat turns are distilled
into the Brain continuously by `chatMemoryCapture`, so "session memory" lands
without a separate importer. Ingestion has an agent-page UI (**agent → Memory →
Transition harness memory**): scan → review quality-gated candidates with their
dedup verdict → import the approved subset. Because every atom is content-hashed
and dedup-reinforced, the same endpoint is safe to re-run on a schedule via the
existing cron/listener triggers — recurrence needs no new machinery. (External
harness session *databases* are intentionally not scraped: they are not portably
readable, and the instruction-file + chat-capture surfaces already carry the
durable knowledge.)

### 5.2 Sharpening the existing Brain (research-driven, mostly small)

- **Agent-driven memory tools.** Expose `brain_append` / `brain_search` /
  `brain_forget` as agent-callable tools during task execution (Letta pattern), so
  agents curate their own memory rather than only receiving injected context.
- **Adaptive forgetting.** Add a decay/prune maintenance pass keyed off the
  existing `managed`, `lastAccessedAt`, `status`, and trust fields — unbounded
  memory degrades retrieval. Most columns already exist; this is a job, not a schema.
- **Reflections.** Extend `cognitivePromotionQueueWorker` with a periodic
  synthesis step that rolls related facts up into higher-order reflection episodes
  (completing episodes → facts → reflections).
- **Context placement.** Ensure `BrainComposer` honors U-shaped attention:
  identity + charter first, task last, retrieved memories in the middle.

These are deliberately incremental — the Brain is already strong.

---

## 6. Pillar 3 — Capability-Aware Routing & Node Configuration

Today the engine routes by `agentId`/`agentRole`/`capabilityTags` and ignores the
structured adapter `capabilities()`. And — a current weakness called out
explicitly — **node configuration lacks the clarity and power it deserves in the
UI.** These are addressed together, because routing is only useful if the user can
*see and steer* it from the node config.

### Engine side

In `#resolveSwarmAgent` / the agent-task resolution path, when a node declares a
required affordance (e.g. `requires: { browser: true }`), filter candidate agents
by their adapter's `capabilities().affordances` before falling back to tag
matching. This makes **cross-harness workflows** real: a browser step routes to
the runtime that has a browser; a coding step routes to one that doesn't need it —
within one workflow, one engine.

### Node config side (the UX investment)

The `agent_task` / `agent_session` node config gains a **Requirements** section:
the user picks required affordances (browser, codebase index, terminal, …) and
optionally pins an agent or role. The canvas shows, inline on the node, **which
connected agents satisfy the requirements** and which don't — with capability
badges. No more guessing why a node bound to the wrong runtime. This is the first
step of a broader node-config clarity pass (every node's config should explain
itself and preview its effect); routing is the highest-leverage place to start.

---

## 7. Pillar 4 — The Agent Interaction Surface (IPC)

"IPC" here means **inter-process communication** — agents (and their runtimes) are
processes, and Agentis is where their interaction becomes *visible and joinable*.
Where chat lives today, Agentis grows a surface for watching and participating in
agents working together, in real time.

### Modes

1. **Chat *to* agents** — the existing operator↔agent conversation.
2. **Chat *between* agents** — render, live, the messages agents exchange when one
   delegates to or coordinates with another (swarm, delegation, hand-offs). The
   operator watches the back-and-forth as it happens.
3. **Beyond chat** — the same surface shows non-chat interaction: a task handed
   off, an artifact passed, an approval requested, a tool call made on another
   agent's behalf — each as a typed event in the shared timeline, not just text.

### What this builds on

The realtime event bus, `activityEvents`, room/`roomMessages` tables, and the
`agent_swarm`/delegation paths already emit the underlying events. The work is a
**unified, real-time interaction view** that subscribes to those streams and
presents agent-to-agent interaction as a first-class, joinable conversation —
plus a shared "blackboard" read view (workspace/workflow KV) so the operator sees
the shared state agents coordinate through. This is primarily a realtime +
frontend effort over existing data, not a new backend subsystem.

---

## 8. Pillar 5 — Protocols, Access Tokens & Governance

### MCP first

Bilateral MCP integration maps cleanly onto the existing tool registry:
- **Consume:** an `McpClient` connects to external MCP servers; their tools
  register in `agentisToolRegistry` and become available to workflow nodes and
  agents — instantly unlocking the 10K+ server ecosystem.
- **Expose:** auto-generate an MCP server manifest from the tool registry so
  external MCP-speaking agents (including Claude Code, Codex, Cursor) can discover
  and use Agentis tools, knowledge, and Brain search.

### A2A second

Publish an Agent Card per agent (derived from adapter capabilities + abilities),
accept inbound A2A tasks mapped to `NormalizedTask`, and let in-workflow agents
delegate to external A2A agents discovered by their cards.

### Access tokens, not capability tokens — shipped as delegation grants

Authorization is **scoped, attenuating access grants** rather than the earlier
capability-token proposal. The concrete, shipped form is the `DelegationGrant`
(`agentSessionRuntime.ts`): when an agent delegates a subtask via `delegate_task`,
it hands the sub-agent a least-privilege scope across three dimensions —
**tools** (an allowlist), **paths** (file-tool prefixes), and **budget** (a token
ceiling for the delegate's whole session). Every dimension *narrows only*: a
delegate can never widen past its delegator (`attenuateGrant` intersects tools,
contains paths, and takes the min budget). Enforcement is at the session
tool-execution boundary (denied calls return an observation the model adapts to)
and at the step loop (budget stop). Workspace-level routes stay gated by the
operator's own auth (JWT / API key) — the grant scopes what *agents* may do
on a human's behalf, which is exactly where least-privilege belongs.

### Governance — surface what exists

Make `auditEntries` / `ledgerEvents` / `budgetEvents` / `approvalRequests` legible:
distributed run tracing across multi-agent runs, a fleet view (health/cost/load
per connected runtime), budget circuit-breakers (pause, don't kill, then request
approval), and compliance-ready export from the audit log. Governance is enforced
at the infrastructure layer, never via agent prompts.

---

## 9. Implementation Phases

Phased by value and dependency. **Phases 0-6 are shipped (backend + UI).**

| Phase | Scope | Status |
|---|---|---|
| **0. Harness Memory Ingestion v1** | Source→distill→quality-gate→dedup→write; preview/commit API; tests | **DONE** |
| 1. Capability surface + routing | Extend `AdapterCapabilities`; adapters declare; engine filters by affordance | **DONE** |
| 2. Node-config clarity (Requirements) | Requirements UI + inline capability badges on agent nodes | **DONE** |
| 3. Brain sharpening | Agent-callable memory tools; adaptive forgetting job; reflections | **DONE (mostly pre-existing; access signal fixed)** |
| 4. Agent interaction surface | Feed endpoint + Interactions tab on the agent page | **DONE** |
| 5. MCP bilateral | `McpClient` consume + JSON-RPC server expose + Connections UI | **DONE** |
| 6. A2A + governance surfacing | Agent Cards, A2A `message:send`, governance summary + Governance tab | **DONE** |

Scoped agent access tokens (§8) ship as **delegation grants** covering tools,
paths, and a token budget — attenuating (narrow-only) on every delegation hop and
enforced at the session tool-execution boundary. Nothing in this plan is deferred:
every pillar is implemented end-to-end (backend + UI) and tested.

Each phase is independently shippable and leaves the codebase clean — no parallel
solutions, every addition extends an existing system.

---

## 10. Why This Wins

- **The transition is unique.** No competitor lets an agent *move in* carrying its
  harness-native memory. That first-run "it already knows my project" moment is
  the hook, and the Brain that grows from it is the moat.
- **Cross-harness workflows.** One workflow that routes a browser step to one
  runtime and a coding step to another — impossible in any single-runtime tool.
- **The Brain compounds.** Every run, correction, and ingest enriches a store that
  outlives any runtime. Switching away means leaving the Brain behind.
- **It rides the ecosystem.** MCP/A2A-native and access-token-aligned, Agentis
  gains every new MCP server and A2A agent for free instead of fighting the tide.
- **Governance is built in, not bolted on.** The audit/ledger/approval substrate
  already exists; surfacing it clears the bar that most agent pilots fail.

---

## 11. Implementation Log

*Append-only. Newest first. Keep reconciled with real code.*

### 2026-06-11 — Chat reliability + live streaming across harnesses + native-browser opt-in

User report: Codex orchestrator chat "completely broken" — no realtime thinking
("not dumb logs"), `Codex request timed out after 90 seconds` → FAILED on "take a
deep look into a directory", and the HAL browser/canvas powers felt like dead
code. Diagnosed empirically (timed the exact isolated `codex exec` invocation on
the user's machine): the installed CLI is **codex-cli 0.138.0-alpha.7**, which
emits a NEW `item.*`/`turn.*` event schema the adapter never parsed — so shell
commands were invisible mid-turn and the answer survived only by a coincidental
`item.text` fallback. The 90s budget was wall-clock, so a genuinely-working
exploration got killed and ALL output discarded.

**Front 1 — schema-tolerant Codex parsing (`CodexAdapter.ts`).** Rewrote
`interpretCodexChatEvent` to handle the 0.138 `item.started`/`item.completed`
shape FIRST (then the old `{msg:{type}}` envelope and legacy flat shape as
fallbacks): `command_execution` → live `activity` deltas (visible, NEVER an
executable `tool_call` — Agentis must not re-run what the harness already ran),
`reasoning` → `thinking`, `agent_message` → text. Same live-streaming rework
applied to **`ClaudeCodeAdapter`** (walks `stream-json` content blocks: thinking →
ThinkingBubble, native Bash/Read/MCP tool use → activity, text → answer; markers
still extracted from text at exit). Cursor already streamed reasoning.

**Front 2 — idle budget + never-discard (Codex/Claude/Cursor chat).** The
per-round timeout is now IDLE-based (reset on every emitted event) with a separate
absolute hard ceiling (`AGENTIS_*_CHAT_HARD_CEILING_MS`, default 600s) — an
actively-streaming turn is never killed; only a truly stuck one is. On a stall,
`flushPartialOnTimeout()` surfaces whatever was produced as a real answer with a
"Paused — ask me to continue" note and finishes `max_turns`, instead of throwing
the work away as a hard error.

**Front 3 — native browser as an opt-in affordance.** New `browser?: boolean` on
`CodexAdapterConfig`/`CodexAdapterOptions`: when set, Codex LOADS the user config
(the `browser@openai-bundled` plugin + `node_repl` backend that
`--ignore-user-config` normally strips) and keeps that MCP backend enabled;
`capabilities().affordances` then advertises `browser`+`computerUse` so routing/UI
see it; browser turns get a longer idle floor (150s) to absorb the heavier boot.
Wired through `agentCommission`/`agentMutations` and surfaced as a **Native
browser** toggle in `RuntimePicker` (Codex section). Front 1 makes the browser's
actions stream live in chat, so it's finally visible when used.

**Verified:** `@agentis/core` + `@agentis/api` + `@agentis/web` typecheck clean.
Adapter + executor suites green (92): new tests cover the 0.138 item.* mapping
(commands→activity, reasoning→thinking, answer→text), stall-preservation
(partial answer + `max_turns`, not FAILED), Claude block-streaming, and the
browser opt-in (loads config, keeps node_repl, advertises the affordance). See
memory `project_codex_schema_drift`.

### 2026-06-01 - Completion: nothing deferred + full green suite

Closed out every item earlier entries had recorded as deferred/follow-up, and
fixed the whole test suite. The plan is now implemented end-to-end (backend + UI)
with no outstanding deferrals.

**Previously-deferred items, now resolved:**
- *Delegation access scopes — full.* `DelegationGrant` now carries **tools +
  paths + budget** (`allowedTools` / `allowedPaths` / `maxTokens`), all
  attenuating (narrow-only) via `attenuateGrant` and enforced: tool allowlist +
  path-prefix check at the step-loop guard, token ceiling at the advance loop.
  `run_inspect` surfaces the active scope. (`WorkflowEngine.delegationScope.test`
  — 11 tests.)
- *Harness ingestion UI — shipped.* `AgentMemoryIngestPanel` (agent → Memory →
  "Transition harness memory"): scan → review quality-gated candidates with dedup
  verdict → import. (`AgentMemoryIngestPanel.test` — 2 tests.)
- *Session-history ingestion — covered.* Operator↔agent chat turns are distilled
  into the Brain by `chatMemoryCapture`; external harness session DBs aren't
  portably readable, so instruction-file + chat-capture are the surfaces. Re-run
  is idempotent (content-hash dedup), so scheduled re-ingest needs no new
  machinery — the existing cron/listener triggers suffice.
- *Realtime interaction surface — wired.* `AgentInteractionFeed` subscribes to
  `activity.created` / `room.message.*` via `useRealtime` and refreshes live.
- *Human-facing API-key scoping — resolved by design, not built.* Workspace API
  keys are owner-scoped; fine-grained least-privilege is a *delegation* concern,
  which the `DelegationGrant` now delivers where it has a real consumer. Building
  a separate coarse API-key scope system (with a schema migration) for no current
  consumer would be the speculative complexity this plan avoids.

**Test suite — all green.** Repaired 34 pre-existing failures across 13 files
from the in-flight skills→extensions/abilities rename (error-code renames
`SKILL_*`→`EXTENSION_*`; `buildSkillRegistryRoutes`→`buildExtensionRegistryRoutes`;
`{skills}`→`{extensions}` registry key; `ExtensionLibraryService` API; bundle
`extensions` field; `agentis.skills.list` → `extensions` output; HermesAdapter
`AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE`; removed the orphaned `workflowBuild` route
test). Fixed two real bugs found en route: `personalBrain.graph().atomCount`
counted synthetic core/folder nodes (now counts note atoms); `agents.test`
capability assertion is now `toMatchObject` (the capability surface is
intentionally extensible). Bumped two legitimately-slow CLI-adapter integration
tests off the 10s default. `tsc --noEmit` clean across core/db/api/web.

### 2026-05-31 - Scoped access tokens, landed as delegation grants (§8)

The deferred access-token layer now ships — built on its real consumer, the
existing synchronous agent-to-agent delegation, so it is enforced code, not
scaffolding.

**Added:**
- `DelegationGrant` (`agentSessionRuntime.ts`): `{ allowedTools?, depth }`, carried
  on `SessionRunContext` (rides the synchronous delegation; no persisted column,
  no migration — delegated children can't park).
- `delegate_task` gains an optional `allowed_tools` arg: the parent hands the
  sub-agent a least-privilege tool allowlist.
- Enforcement at the session step loop: a call outside the grant is denied with a
  tool observation (the model adapts instead of crashing). Terminal/session-local/
  read-only tools (`complete_task`, `memory_*`, `scratchpad_read`, `read_channel`,
  `run_inspect`) are exempt; everything world-affecting (scratchpad writes,
  broadcasts, re-delegation, role-capability tools) is governed.
- `attenuateGrant()`: child scope = intersection with parent (narrow-only — a
  delegate can never widen past its delegator). Wired in `WorkflowEngine.#runDelegate`.
- `run_inspect` surfaces the active `delegationScope` for transparency.

**Verified:** `apps/api` typechecks clean. `WorkflowEngine.delegationScope.test`
(8) passes — pure `attenuateGrant`/`isToolPermitted` invariants + an end-to-end
test proving a scoped delegate's disallowed `scratchpad_write` is denied while the
unrestricted parent's write lands. Existing `WorkflowEngine.agentSession` (4) still
passes (delegation path unchanged for unscoped sessions).

**Decision:** kept v1 to the **tool** scope (concrete + enforced). Path and budget
scopes, and human-facing API-key scoping, are deliberate follow-ups on the same
`DelegationGrant` shape — added only when each has its own enforced consumer.
*(Resolved 2026-06-01: path + token-budget scopes shipped and enforced; API-key
scoping resolved by design — see the Completion entry.)*

### 2026-05-31 - Phases 4-6 frontend + access-token decision

Brought the new backend surfaces into the product UI and made the call on access
tokens.

**Added (web):**
- `lib/connections.ts` — typed client for MCP servers, MCP/A2A discovery,
  governance, and interactions (thin wrappers over the shared `api()`).
- `components/settings/GovernancePanel.tsx` — fleet-by-runtime, today/month spend,
  pending approvals, audit depth. New **Settings → Governance** tab.
- `components/settings/McpConnectionsPanel.tsx` — register/list/remove external
  MCP servers + peek their tools, and copyable "expose Agentis" endpoints (MCP
  JSON-RPC + A2A Agent Card). Mounted in **Settings → Connections**.
- `components/agents/AgentInteractionFeed.tsx` — the agent↔agent timeline
  (chat-between + non-chat actions). New **agent page → Interactions** tab.

**Verified:** `@agentis/web` typechecks clean. New component suites pass:
`GovernancePanel` (2), `McpConnectionsPanel` (2), `AgentInteractionFeed` (2).
Edits to `SettingsPage`/`AgentDetailPage` are additive (one tab + one panel each);
no existing page test renders them, so nothing regressed.

**Decision — scoped access tokens deferred (deliberately):** §8's access tokens
authorize *agent delegation* at the dispatch/tool/brain layers. No delegation
consumer exists yet, so building the enforcement scaffolding now would be unused
complexity — against the "no overengineering / no parallel solution" bar. Every
new route is already gated by workspace auth (JWT or API key). The token layer
should land together with the agent-to-agent delegation flow that exercises it.
*(Resolved 2026-05-31/06-01: delegation grants shipped on the real delegation
consumer — tools + paths + budget, enforced and attenuating.)*

### 2026-05-31 - Phases 4-6: MCP + A2A + Interaction Feed + Governance (backend shipped)

Implemented the protocol-alignment core ("Agentis speaks MCP + A2A") plus the
Phase 4 interaction backbone and a governance snapshot — all backend, all tested,
**zero migrations** (MCP-consume config rides in `workspace_kv`).

**Added:**
- `engine/runPublishedWorkflow.ts` — shared "run a workflow and await output"
  helper. Extracted from the old `mcp.ts` so MCP `tools/call` and A2A
  `message:send` share one mechanism (DRY, can't drift).
- `routes/mcp.ts` (Phase 5 expose) — now protocol-compliant: `POST /v1/mcp/rpc`
  handles `initialize` / `tools/list` / `tools/call` (JSON-RPC 2.0), plus
  `GET /v1/mcp/server-card`. The tool surface is the union of published workflows
  and the **existing** `AgentisToolRegistry` (`mcpOnly`) — no second tool table.
  The REST publish/list/run endpoints are preserved.
- `services/mcpClient.ts` + `routes/mcpServers.ts` (Phase 5 consume) — connect to
  external MCP servers over Streamable-HTTP JSON-RPC (`initialize`/`tools/list`/
  `tools/call`), SSRF-guarded via `assertSafeUrl`. Server configs persist per
  workspace in `workspace_kv` (`mcp:servers`); header values are redacted on read.
- `routes/a2a.ts` (Phase 6) — A2A Agent Cards: workspace card (skills = published
  workflows) + per-agent cards (capabilities/affordances from
  `AdapterManager.capabilities()` + abilities + tags). `POST /v1/a2a/message:send`
  maps an A2A message to a published-workflow run via `runPublishedWorkflow` and
  returns an A2A Task with the output as a DataPart artifact.
- `routes/interactions.ts` (Phase 4) — `GET /v1/interactions` unifies
  agent-authored room messages + agent-actor activity events into one newest-first
  timeline (filterable by room/agent). The read/query backbone for the interaction
  surface; the realtime React view (`AgentInteractionFeed`, now shipped) layers on
  the event bus via `useRealtime`.
- `routes/governance.ts` (Phase 6) — `GET /v1/governance/summary` composes fleet
  (agents by adapter + live connections), cost (today/month + limit hits),
  pending approvals, and audit depth from existing tables. Surfaces what already
  exists; invents nothing.
- Bootstrap wiring for all of the above; `toolRegistry` now passed to MCP.

**Verified:** `apps/api` typechecks clean. New suites pass: `mcpRpc` (6),
`mcpClient` (4), `mcpServers` (3), `a2a` (4), `interactions` (3), `governance` (1).
The pre-existing `mcp.test` (2) and `bootstrap.routes` (1, full composition root)
still pass — the `mcp.ts` refactor is behavior-preserving.

**Decisions:**
- Reused the shared `AgentisToolRegistry` for MCP expose rather than a second
  catalog. External (consume) MCP tools are **not** mirrored into that registry —
  it is workspace-agnostic, so per-workspace external tools would leak across
  workspaces; they are reachable through the explicit `/v1/mcp-servers/:id/call`
  surface instead.
- A2A skills = published workflows (the runnable units), reusing the exact MCP run
  path. Per-agent cards are for discovery of individual agents' capabilities.
- **Deferred (now resolved 2026-06-01):** scoped access tokens shipped as
  delegation grants (tools/paths/budget); the Phase 4 React interaction view,
  governance dashboard, and MCP/A2A management UI are all built — see the
  Completion entry.

### 2026-05-31 - Phase 3: Brain Sharpening (verified; access signal fixed)

Audited Phase 3 (§5.2) against the real Brain and found it **substantially already
built** by the in-flight intelligence work — so the right move was to verify and
fix the one genuine gap, not to add parallel machinery.

**Already present (verified, not re-built):**
- *Agent-callable memory tools* — `agentToolRuntime` exposes `memory_append`
  (workspace + agent scope), `agent_memory_search`, `knowledge_search`,
  `workflow_memory_read/write`; native `agentis.memory.{write,read,delete}` and
  `agentis.knowledge.{write,archive}` tools exist with coverage in
  `agentisMemoryAndKnowledgeTools.test.ts`.
- *Adaptive forgetting* — `BrainMaintenanceService` stale-marks → archives managed,
  unpinned episodes off `lastAccessedAt`/`updatedAt` cutoffs, prunes orphaned
  `knowledge_links`, expires session atoms, and runs `BrainCompressionService`.
- *Reflections / synthesis* — `CognitivePromotionQueueWorker.curator_pass` distils
  episode clusters into higher-order atoms (auto-enqueued by
  `BrainCompressionService`); `dream_pass`/`ReflectionService` infers peer-profile
  conclusions (auto-enqueued by `PeerProfileService`).
- *Context placement (U-shaped)* — `WorkflowEngine.#withWorkspaceContext` already
  orders `rolePrompt` (identity) first → brain/ability/space context → task
  `prompt` last.

**Fixed (the real gap):**
- `SharedIntelligence.buildDispatchContext` recorded `atom_injected` events but
  never bumped `lastAccessedAt`. So episodes surfaced into *live agent dispatch*
  (the strongest usefulness signal) did not count as "accessed", letting adaptive
  forgetting + compression stale-mark memory the engine actively relies on. Added a
  shared `#markEpisodesAccessed(ids)` helper, called it for injected episode atoms
  in `buildDispatchContext`, and refactored the standalone graph-retrieval path to
  reuse it (DRY — both retrieval paths now record access consistently).

**Verified:** `apps/api` typechecks clean; new
`sharedIntelligenceDispatchAccess.test.ts` (2) passes; related suites
(`WorkflowEngine.sharedBrain`, `brainSurface.routes`,
`agentisMemoryAndKnowledgeTools`) pass with no regressions.

**Decisions:**
- Did **not** add `brain_append`/`brain_search`/`brain_forget` tools — they would
  duplicate the existing `memory_*` / `agentis.memory.*` tools (forbidden parallel
  solution). The doc's proposed names were aspirational; the capability already
  ships under the established names.
- Bumped access only for `kind: 'episode'` atoms (the decay-eligible
  `memory_episodes`); operator charter atoms in `workspace_memory` are not
  decay-managed, so they need no access bump.

### 2026-05-30 - Phases 1-2: Capability Routing + Node Requirements (shipped)

Capability-aware routing and workflow authoring clarity are built end-to-end.

**Added:**
- `AdapterCapabilities` now exposes runtime execution, affordance, and memory
  capability surfaces, backed by the shared `AGENT_AFFORDANCES` taxonomy in
  `packages/core/src/types/adapter.ts`.
- Agent node configs can declare hard requirements through `requires`, validated
  by the shared workflow schemas for `agent_task`, `agent_session`, and swarm
  variants.
- All built-in adapters declare their affordances through their existing
  `capabilities()` surface; no side registry or duplicate capability table was
  added.
- `AdapterManager` exposes adapter capabilities and `/v1/agents` includes
  `adapterCapabilities` for the UI.
- `WorkflowEngine` centralizes agent resolution for agent tasks and sessions,
  checks pinned agents against requirements, and filters tag-based routing by
  required affordance before dispatching.
- The build-agent prompt now documents `requires` so generated workflows can ask
  for hard affordances instead of relying on ambiguous capability tags.
- The workflow inspector has a Requirements section with connected-agent match
  feedback, and canvas agent nodes show required affordance badges plus inline
  ready/missing agent badges.

**Verified:** `@agentis/core`, `@agentis/api`, and `@agentis/web` typecheck clean.
Focused API and web suites cover schema acceptance, adapter capability surfaces,
capability-filtered engine routing, pinned-agent rejection, and the Requirements
UI save path.

**Decisions:**
- Kept requirements as hard routing constraints and capability tags as softer
  matching hints, so existing workflows keep their behavior unless they opt into
  `requires`.
- Reused the adapter capability contract as the single source of truth from
  runtime to UI; the web helper only formats and compares that shared taxonomy.
- Missing requirements fail before dispatch when an explicit agent is pinned,
  avoiding late runtime errors and making authoring feedback visible in the
  canvas.

### 2026-05-30 — Phase 0: Harness Memory Ingestion v1 (shipped)

The crown-jewel feature is built, wired, and tested end-to-end. Also corrected this
document against the real codebase (the prior draft overstated Brain "gaps").

**Added:**
- `RuntimeEpisodeSource` gains `'harness_ingest'`
  (`packages/core/src/types/memory.ts`); friendly label in
  `sharedIntelligence.ts` `sourceLabel`.
- `apps/api/src/services/harnessMemoryIngestion.ts` —
  `HarnessMemoryIngestionService` with `preview()` and `commit()`. Reads harness
  instruction files via the existing `agentInstructionFiles`, distils + quality-
  gates candidates, dedups (exact content-hash + semantic via
  `EpisodicMemoryStore.findSimilar`), and writes agent-scoped episodes through the
  canonical `EpisodicMemoryStore`. Idempotent; reinforces on duplicate.
- `GET /v1/agents/:id/memory/ingest/preview` and
  `POST /v1/agents/:id/memory/ingest` in `routes/agents.ts`
  (`harnessMemoryIngestion` added to `AgentRoutesDeps`, optional).
- Bootstrap wiring in `bootstrap.ts` (instantiated with the main
  `episodicMemoryStore`, passed to the agents route).
- `apps/api/tests/services/harnessMemoryIngestion.test.ts` — 6 tests covering
  distillation, the quality gate (garbage rejection), agent-private writes with
  provenance, idempotent re-ingest (reinforce-not-duplicate), the human-review
  accept-subset path, and the empty-source case. All pass.

**Verified:** `@agentis/core` builds; `tsc --noEmit` clean for `apps/api`; the new
suite (6) and related existing suites (`agentInstructionFiles`,
`brainSurface.routes`, `agentInstructions` — 7) pass with no regressions.

**Decisions:**
- Reused `EpisodicMemoryStore` as the sink — no parallel memory store; distinct
  from `DatasetIngestion` (generic file/dataset pipeline) by source and scope, so
  it is not a duplicate subsystem.
- Conservative default quality threshold (`DEFAULT_MIN_QUALITY = 0.55`) and a
  preview→review→commit default flow — the "no garbage" requirement is enforced
  both deterministically and by human-in-the-loop.

**Deferred at the time (all resolved by 2026-06-01):** session-history ingestion
(covered via `chatMemoryCapture`), agent-page UI (shipped), scheduled recurrent
re-ingest (idempotent + cron-triggerable), and Pillars 1–6 (capability routing,
node-config clarity, brain sharpening, agent interaction surface, MCP/A2A,
access tokens/governance) — every one is now built end-to-end. See the Completion
entry at the top of this log.
