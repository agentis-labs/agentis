# Agent Logic in Workflows — Capability & Integration 10x

> **Thesis.** An agent in Agentis should be a **full-power runtime brain that is
> also a full Agentis citizen** — it keeps the *entire* native power of its harness
> (Claude Code / Codex / Antigravity: filesystem, terminal, native browser/web,
> MCP, sub-agents, planning) AND gains the *entire* Agentis platform surface (all
> three brain tiers, inter-agent cooperation, App data + surfaces, channels,
> workflows, platform creation) bridged in **additively**. Perfect integration,
> **zero restriction**. Today an `agent_task` is the opposite: capability-*starved*
> and *down-cast* to a fixed tool enum the moment a full-power harness isn't the one
> executing it. The 10x is not "wire one more tool" — it is making the agent the
> brain on the HAL with both worlds always present.

Status: REVIEW + PLAN · 2026‑06‑29 · P0 + P1 SHIPPED (the floor); empowerment phases E1–E4 PLANNED.

---

## Part 0 — The diagnosis (code-grounded)

### 0.1 Three execution paths, three different (incomplete) surfaces

An `agent_task` resolves down one of three paths, each granting a *different* set
of capabilities — so the same agent is powerful on one and inert on another:

| Path | When | Surface today |
|---|---|---|
| **In-engine session** (`#runAgentSession`) | session runtime wired + not harness-bound | role manifest (+ memory/delegation) |
| **In-engine tool loop** (`#maybeRunAgentToolLoop`) | evaluator model + tool runtime wired | `effectiveSpecialistTools(def)` — a **fixed `AgentTool` enum** |
| **Adapter dispatch** (`#dispatchAgentTask`) | agent bound to a CLI harness | the **harness's own** native tools; in *workflow* dispatch the Agentis tools are **awareness-only, no execution loop** ([markerToolProtocol.ts:211](apps/api/src/adapters/markerToolProtocol.ts)) |

### 0.2 The platform already declares the right philosophy

This is not a foreign idea to graft on — Agentis says it in code and under-realizes
it. [markerToolProtocol.ts:147–178](apps/api/src/adapters/markerToolProtocol.ts):
*"these harnesses run locally and DO have their own tools and filesystem… Agentis
is a neutral platform: it offers its platform tools as an ADDITIONAL capability and
lets the agent be whatever the operator configured; it does not lie about, or fight,
the runtime's native environment."* And the HAL's `mcp_native` forwarding mode is
defined as *"the harness runs its OWN agentic loop… the harness stays the brain."*
The empowerment is realizing this everywhere, not silently down-casting.

### 0.3 The concrete defects

1. **`web_search` advertised everywhere but never wired** → every call threw
   "provider is not configured". (FIXED, P0.)
2. **`capabilityTags` / `requires` don't grant tools** — decorative metadata.
   (FIXED in the in-engine path, P1.)
3. **Harness-bound workflow agents get *awareness*, not a loop** — they cannot
   actually call Agentis tools mid-task, so they're cut off from the platform.
4. **The HAL models only 6 affordances** (`browser, codebaseIndex, fileSystem,
   terminal, computerUse, nativeMcp`) — **web/search is not one**, so Agentis can't
   negotiate, guarantee, advertise, or transparently *fill* it.
5. **Self-heal misreads a capability/operational failure as structural** (`claude_code
   exited 1` → blind sonnet→hermes rewrite → loop, no clean resume).

---

## Part 1 — The floor (SHIPPED): make the fallback non-broken

These do not empower; they stop the *fallback* path from being actively broken.

- **P0 — zero-config `web_search`** (`services/webSearch.ts`, DuckDuckGo HTML, env
  override `WEB_SEARCH_API_URL`/`WEB_SEARCH_API_KEY`) wired into `AgentToolRuntime`.
- **P1 — `resolveAgentTaskTools`** unions the role manifest + universal floor +
  tag/`requires`-implied tools in the in-engine tool-loop path.

---

## Part 2 — HAL-first empowerment (the real 10x)

### 2.1 The principle

> The agent runs **on its full-power harness, as the brain** (mcp_native loop), with
> its complete native toolset, AND the **entire Agentis surface bridged in over the
> same MCP/marker channel**. Native power is never removed; Agentis power is always
> added. The fixed in-engine loop becomes an explicit, labeled *last resort* — never
> a silent down-cast.

Five moves:

1. **Agent-as-brain on the HAL is the PRIMARY runtime** for every `agent_task` that
   can run on a capable harness. The in-engine fixed-tool loop is a labeled fallback.
2. **Both worlds, always.** Give harness *workflow* agents the real Agentis
   tool-execution loop (today awareness-only) so the agent calls platform tools
   mid-task — native power **∪** Agentis power.
3. **HAL models the full capability surface; Agentis fills gaps.** Add generic powers
   (web/search…) as affordances. Runtime has it natively → use it; doesn't → Agentis's
   own provider satisfies it transparently. The agent *never* "can't search".
4. **Capabilities are requested, never restricting.** `requires`/`capabilityTags`
   grant power additively; a real gap surfaces as "this runtime can't X — enable Y /
   bind a runtime that can", not a crippled run.
5. **Capability-aware self-heal.** Diagnose capability/operational failures as such and
   fix THEM (enable the capability, route to a runtime that has it) — never a blind
   model swap + loop; fix resume-after-heal + the Stop-loop.

### 2.2 The integration surface — what "fully integrated" MUST include

Empowerment is meaningless if the agent has raw native power but is a stranger to the
platform. Every `agent_task` agent — **on any runtime** — must reach the *complete*
Agentis surface, bridged additively. This is the non-negotiable integration contract:

| Agentis system | The agent must be able to… | Backing tools |
|---|---|---|
| **Workspace Brain** | search shared knowledge bases; read/append the shared memory every agent sees | `knowledge_search`, `memory_append` (scope:workspace) |
| **App Brain** | use & grow the owning App's institutional memory; promote durable facts from App data into it | `data_promote_memory`, App-scoped knowledge |
| **Agent Brain** | recall & write its *own* private memory across runs | `agent_memory_search`, `memory_append` (scope:agent) |
| **Workflow memory** | read/write per-workflow durable state (cursors, dedup, accumulated findings) | `workflow_memory_read` / `workflow_memory_write` |
| **Inter-agent cooperation** | recruit & delegate to sub-agents; join swarms; cooperate on the run **blackboard** (facts/claims/broadcast/converge signals); know its peers | delegation/yield, `dynamic_swarm`, `scratchpad_write`/`broadcast`/`claim`/`converge_signal` |
| **App Datastore** | read & write the App's real typed records — the agent *operates the product* | `data_define_collection`, `data_insert`/`update`/`upsert`/`delete`/`query` |
| **App Surfaces (AG-UI)** | author & patch the App's living interface the operator sees | `ui_render`, `ui_patch`, `ui_action_schema` |
| **Channels** | message humans (Slack/WhatsApp/Telegram/email) and act on inbound | `agentis.channel.send` + inbound dispatch |
| **Workflows** | invoke another workflow as a subroutine; author/patch workflows (full power for capable agents) | `call_workflow`, `agentis.build_workflow` / patch |
| **Platform creation** | create agents, extensions, abilities, listeners when a capability is genuinely missing | the `agentis.*` creation tools |
| **Native runtime (untouched)** | use its harness's filesystem, terminal, native browser/web, MCP servers, sub-agents, planning | the harness itself |

The agent is simultaneously a full Claude Code/Codex/Antigravity agent **and** a full
Agentis citizen: it remembers (4 memory tiers), cooperates (other agents + blackboard),
operates the App (data + surfaces), talks (channels), and composes (workflows) — while
keeping every native power its runtime gives it.

### 2.3 Why this is integration, not a bag of tools

The tiers compose. A resident App agent should: pull a contact's history from the
**App Datastore**, recall what it learned last time from its **Agent Brain** and the
**App Brain**, search the live web with its **native** browser, write the new findings
back as **records** AND promote the durable ones to the **App Brain**, update the App's
**surface** so the operator sees it live, and message the human on a **channel** — in
one autonomous loop, choosing each capability itself. That is "highly driven by
Agentis capacities" *and* "not restricting the full power of the agent."

---

## Part 3 — Empowerment phases

- **E1 — Harness is the brain, with a real loop.** Make `agent_task` prefer a capable
  HAL runtime and run it as a genuine agentic loop (mcp_native / a wired marker loop in
  workflow dispatch), not fire-and-forget awareness. The fixed in-engine loop becomes a
  labeled fallback. *(Recommended first — the highest-leverage move.)*
- **E2 — Full integration bridge.** Expose the *entire* §2.2 surface to the agent on
  every runtime over the MCP/marker channel — one capability catalog, bridged
  additively, executed through `AgentToolRuntime` + the App/Brain/channel services.
- **E3 — HAL capability model + gap-fill.** Extend the affordance set beyond the 6 to
  the generic powers; negotiate native-vs-Agentis-provided per runtime; surface real
  gaps as actionable setup, never a silent degrade. `requires` grants, never restricts.
- **E4 — Capability-aware self-heal.** Classify capability/provider/operational failures
  distinctly; fix the capability, don't swap the model; fix resume-after-heal + Stop-loop.

## Non-goals / guardrails

- **Never restrict native power.** Agentis is additive — it must not remove, sandbox
  away, or "lie about" the runtime's own filesystem/terminal/browser/MCP.
- Don't fork a fourth execution path — *unify* and make the harness path primary.
- One capability catalog across all runtimes; bridged, not reimplemented per harness.
- Capabilities broaden by default; narrowing is an explicit, visible opt-out.
- Web/search stays zero-config by default; premium engines are opt-in via env.

## Implementation Log

- 2026‑06‑29 — Code-grounded review (`specialist.ts` / `agentToolRuntime.ts` /
  `bootstrap.ts` / `WorkflowEngine.ts` agent_task paths / `halAffordances.ts` /
  `markerToolProtocol.ts`). **P0 SHIPPED**: zero-config `web_search`. **P1 SHIPPED**:
  `resolveAgentTaskTools` (role ∪ floor ∪ tag-implied) in the tool-loop path. Reframed
  to **HAL-first empowerment** (Part 2): the agent is a full-power harness brain *and* a
  fully-integrated Agentis citizen (4 brain tiers + inter-agent + App data/surfaces +
  channels + workflows), bridged additively with zero restriction of native power.
  **Planned**: E1 (harness brain + real loop), E2 (full integration bridge), E3 (HAL
  capability model + gap-fill), E4 (capability-aware self-heal).
- 2026‑06‑29 (cont.) — **E4 SHIPPED**: `capabilityGapReason` classifier +
  short-circuit in `WorkflowEngine.#runSelfHeal`. A missing capability/provider/
  tool/binary ("not configured / not wired / not available / requires <binary>")
  now escalates honestly ("enable X — swapping the agent cannot add it") instead of
  firing the LLM replan that pointlessly reroutes the agent (the sonnet→hermes loop).
  High-precision: genuine structural/data/contract/operational failures (incl.
  `claude_code exited 1`) still reach the existing ladder. Unit-tested
  (`capabilityGapReason.test.ts`) + self-heal regression (10) green.
- 2026‑06‑29 — **E3 found largely moot**: web/search is a *platform* tool (already
  universal via P0's `AgentToolRuntime.webSearch`), not a runtime-native HAL
  affordance — so it should NOT be added to `AGENT_AFFORDANCES` (those stay
  runtime-native: browser/files/terminal/mcp/computer). And `requires` already
  *gates/selects* (an agent must PROVIDE an affordance to be eligible) — it does
  not strip native power. So "model web in HAL" / "requires restricts" were not
  real defects; the affordance model is correct as-is.
- 2026‑06‑29 (cont.) — **E2 SHIPPED**: the in-engine agent loop is now a full
  Agentis citizen. `AgentToolRuntime` gained a `PlatformToolBridge`
  (`listPlatformTools` + `executeBridged` routing by id); `AgentToolLoop` offers the
  platform catalog alongside the AgentTool enum + MCP tools and routes platform ids
  with the agent's run context (`{ userId, agentId, workflowId }` → resolved
  `appId`); `WorkflowEngine.#maybeRunAgentToolLoop` merges them into `extraTools` and
  threads `userId`; `bootstrap.ts` wires the bridge as the **mcp-exposed catalog
  (already vetted for autonomous harness agents) MINUS a recursion/run-control
  blocklist** (`build_workflow`, `workflow.patch`/`run`, `ephemeral.run`,
  `run.cancel`, `approval.resolve`). So a workflow agent can talk on channels,
  cooperate, and operate the App mid-task — the same trust boundary an mcp_native
  harness already gets over MCP, now unified for the in-engine path. Routing
  unit-tested (`agentToolRuntime.platformBridge.test.ts`); agent tool-loop /
  capability-routing / self-heal regression (27) green; api typecheck clean.
- 2026‑06‑29 (cont.) — **E1 SHIPPED. The plan is COMPLETE.** A marker_protocol CLI
  harness (Codex / Claude Code) bound to an `agent_task` now runs through a REAL
  Agentis chat tool loop instead of awareness-only dispatch:
  `WorkflowEngine.#runHarnessChatToolLoop` binds the runtime (idempotent), runs
  `ChatSessionExecutor.turn` with **`permissionMode: 'auto'`** (autonomous — no
  confirmation stalls) and the `agentis.*` catalog (`#agentChatTools`, same safe set
  as E2 — mcp-exposed minus the recursion blocklist), streams live reasoning via the
  shared `#relaySelfHealChatDelta`, and completes the node through the **same
  `#completeNode` chokepoint** the in-engine loop uses (so declared-output contracts
  + self-heal apply identically). The hook in `#maybeRunAgentToolLoop` only fires for
  a harness that actually implements `chat`; anything else falls back to dispatch
  (the existing "defers to an agentic adapter" test still passes — its mock has no
  `chat`). So: native runtime power UNTOUCHED + the full Agentis surface mid-task,
  agent as the brain. E2e tested (`WorkflowEngine.harnessLoop.test.ts` — harness runs
  the loop, is offered `agentis.channel.send` but NOT blocklisted `build_workflow`,
  node completes with its output); agent tool-loop / session / self-heal regression
  (31) green; api typecheck clean.

**Coverage now: every execution path is a full Agentis citizen** — in-engine loop
(E2), mcp_native harness (MCP, pre-existing), marker_protocol harness (E1) — each
with its native power intact and the complete Agentis surface bridged in additively.

- 2026‑06‑29 — **Orchestrator never executes a task (casting fix).** Operator: "the
  orchestrator chose itself in a workflow it created." Root cause was the BUILD
  casting: `materializeCast` *respected* a self-pin (`if (cfg.agentId) return n`) and
  took a literal `agentRole` at face value — so the orchestrator/manager could be the
  authored executor. Fixed: `materializeCast` now (a) respects a pin ONLY if it
  targets a real specialist (`isSpecialistRole`), never the orchestrator/manager;
  (b) re-casts a real specialist when a node pinned/was-authored-as a non-executor —
  the declared role if it's a worker role, else one derived from the node's
  capability tags/title; (c) **chooses between agents** — reuses the best
  capability-matched existing specialist before minting a new role. Doctrine updated:
  "YOU ARE THE BUILDER/MANAGER, NEVER THE WORKER… pick the agent by what the task
  NEEDS, not who is connected." The runtime orchestrator-as-last-resort-RUNTIME borrow
  is intentionally KEPT (single-runtime workspaces need it) — but its *identity* is
  never authored onto a node. Tested (`materializeCast.test.ts`: self-pin → specialist,
  role:orchestrator → specialist, capability reuse); capability-routing + build
  regression green; typecheck clean.
