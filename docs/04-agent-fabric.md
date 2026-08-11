# 04 · The Agent Fabric (RAL)

Agentis drives many agent runtimes through one normalized contract, and matches work to
runtimes by **capability** rather than by hardcoded name. The capability layer is the
**Runtime Abstraction Layer (RAL)**.

> Naming note: this was formerly "HAL"; it is a *runtime* abstraction, not a hardware one, so
> the codebase and docs use **RAL** (`packages/core/src/ralAffordances.ts`,
> `RAL_AFFORDANCES`, `RalMatchState`, …).

## Adapters — one contract, many runtimes

Each runtime is an adapter (`apps/api/src/adapters/`) normalized behind `AdapterManager` and
protected by a per-runtime `CircuitBreaker`. Every task is a `NormalizedTask`.

| Adapter | Runtime | Notes |
|---------|---------|-------|
| `ClaudeCodeAdapter` | Claude Code CLI | native or hermetic profile; native MCP when a server is mounted |
| `CodexAdapter` | OpenAI Codex CLI | native profile preserves user/project config, skills, plugins, browser, and named permissions |
| `CursorAdapter` | Cursor | semantic code index |
| `AntigravityAdapter` | Google Antigravity (agy) | structured `stream-json` stdout; canonical CLI model ids |
| `HermesAgentAdapter` | Hermes Agent (ACP) | dual-transport ACP client |
| `HermesAdapter` / `LocalLlmAdapter` | OpenAI-compatible streaming | Nous / LM Studio / llama.cpp |
| `OpenClawAdapter` | OpenClaw gateway | unified LLM gateway, session persistence |
| `HttpAdapter` | Custom HTTP callback | any endpoint, HMAC auth |

All six CLI/streaming harnesses share a common chat runtime (`adapters/cliChatRuntime.ts`).

## Runtime Profile and the execution envelope

An adapter name is not enough to explain what a turn could actually do. Each commissioned
agent therefore carries a `RuntimeProfile` (`packages/core/src/types/adapter.ts`) with an
explicit execution mode (`native | hermetic | containerized`), project root, optional native
profile name, named permission profile (`read_only | workspace_write | trusted_local |
externally_sandboxed`), inheritance switches for user config/project instructions/plugins/skills,
browser posture, and persistent-or-ephemeral session policy.

`native` is the parity path: Agentis preserves the selected CLI harness's useful environment
instead of silently stripping the configuration that makes the same model capable in its desktop
app. `hermetic` is the repeatable isolated path. Permission profiles are enforced by adapter
arguments and MCP execution mode; they are not prompt-only suggestions and are never silently
widened.

Before every concrete chat turn, `RuntimeProfileService.captureExecution()` writes a non-secret
`AgentExecutionEnvelope` to `agent_execution_envelopes`. The envelope records the adapter,
effective profile, binary and CLI version, cwd, model/reasoning/tier, browser state, loaded source
classes (`user | project | agentis`), MCP server count, and capability warnings. The Runtime panel
shows this same record, so a weak answer can be diagnosed against the launch that produced it
rather than against an assumed configuration.

Session identity is conversation-scoped. Codex resume ids and equivalent native state are reused
only for the same Agentis conversation; unrelated conversations never share one global native
thread.

## Affordances — what a runtime can do

An affordance is a native power a runtime advertises (`packages/core/src/types/adapter.ts`,
`AGENT_AFFORDANCES`). Metadata lives in `RAL_AFFORDANCE_METADATA`:

| Affordance | Category | Meaning |
|-----------|----------|---------|
| `browser` | runtime | controls a live Chromium/browser runtime |
| `computerUse` | runtime | controls desktop apps on the host |
| `fileSystem` | workspace | reads/writes workspace files |
| `codebaseIndex` | workspace | uses a harness semantic code index |
| `terminal` | control | runs shell commands |
| `nativeMcp` | protocol | uses Agentis MCP tools directly from the harness |

A runtime's **supply** is computed two ways (`ralAffordances.ts`):
- `configuredAffordances(adapterType, config)` — what it provides right now, given its stored
  config (e.g. `claude_code` always provides filesystem/terminal access and provides native MCP
  only when an MCP server is mounted).
- `potentialAffordances(adapterType)` — the ceiling it *could* provide with a config change.
  Codex has latent browser/computer-use; Codex, Claude Code, and Hermes Agent can gain native MCP
  by mounting an Agentis MCP server.

## Requirement matching

A workflow agent node declares a **requirement** via `requires` (an `AgentRequirements`
subset). The fabric matches every workspace agent against it and returns a `RalMatchState`:

- `ready` — connected and its live runtime advertises everything required;
- `offline_capable` — configured to satisfy it, but not currently connected;
- `enablable` — a config change could satisfy it (e.g. enable Codex native browser);
- `incapable` — this runtime can never provide a required affordance.

`agentRequirementMatches()` ranks all agents `ready → offline_capable → enablable → incapable`,
so the canvas shows a concrete path to a satisfiable node instead of a dead end. Node readiness
uses this in `services/workflow/workflowReadiness.ts`; `requires` is treated as **hard
routing** (`agentis.build_workflow` normalizes generated requirements via
`normalizeGeneratedRalRequirements`). For ordinary web automation, prefer a `browser` node over
requiring native browser control on an agent.

MCP servers can also *grant* an affordance when tagged (e.g. a desktop server granting
`computerUse`), bridged in `services/mcp/mcpToolBridge.ts`.

### Dispatch-bound capability contract

Affordances are projected into a versioned `RuntimeCapabilityManifest`
(`packages/core/src/runtimeCapabilities.ts`). Tasks may declare `allOf` and `anyOf`
requirements, including namespaced third-party capabilities. `AdapterManager` evaluates the
manifest immediately before dispatch, before acquiring execution capacity. An incompatible
task fails with `ADAPTER_CAPABILITY_MISMATCH`, structured missing-capability evidence, and a
repair instruction; it is never sent to a runtime and allowed to fabricate work it cannot do.

The agent HTTP surface exposes the effective manifest, and workflow agent/swarm nodes propagate
their requirements to this final boundary. Tasks without explicit requirements retain backward
compatibility.

Every built-in adapter publishes a complete adapter-authored manifest: unavailable built-ins are
declared explicitly instead of guessed from the transport. Browser/computer-use and native MCP
claims therefore follow the live adapter configuration. Custom HTTP runtimes can persist a
validated `capabilityManifest`, including namespaced capabilities such as `vendor.video-render`;
anything they omit remains unavailable. Legacy projection remains only as the compatibility path
for third-party adapters that have not adopted native declarations yet.

## Model routing

`services/modelRoutingPolicy.ts` classifies a task and selects the **minimum-sufficient** tier
(fast / balanced / flagship). Per-agent hard pins and per-turn overrides take precedence.
`agentis.routing.preview` explains which runtime + model a task would select.

The paired black-box gate in `scripts/runtime-parity-eval.ts` runs one fixture corpus through the
native CLI and the Agentis conversation surface, scores both outputs, and fails when Agentis
regresses by more than the configured tolerance. Configure the two surfaces with
`AGENTIS_PARITY_NATIVE_JSON` and `AGENTIS_PARITY_{URL,API_KEY,WORKSPACE_ID,AGENT_ID}`, then run
`pnpm eval:runtime-parity`. An unpaired run is rejected unless `--allow-unpaired` is supplied
explicitly for harness smoke testing.

## Sessions, specialists, chat

- **Sessions** (`agent_sessions`, `agent_session_messages`) persist across LLM calls;
  memory blocks (persona/task/plan/observations) are reconstructed per call so tool loops
  spend no tokens re-sending context. Streaming + abort are supported where the runtime allows.
- **Specialists** (`services/specialist/`, `/v1/specialists`) — an open role registry
  (platform/custom/generated/community) with demand routing + scoring; a specialist runs a full
  agent session by default.
- **Chat** exposes sticky **Ask / Plan / Full access** permission modes shared across web and
  every channel (`auto` remains the API and slash-command identifier for Full access). The web
  always requests automatic task routing; explicit Quick/Deep/Mission overrides remain API
  compatibility inputs rather than permanent composer controls. Model, reasoning effort, and
  speed live in one runtime menu.

### Execution truth and operator progress

Every turn terminates as `completed`, `failed`, `interrupted`, or `blocked`. An operator Stop
revokes its execution lease, aborts the adapter and child runs, and fences late results; it is
recorded as **Response interrupted**, never as a provider failure. CLI adapters share this rule,
including non-zero child-process exits produced while their process tree is being cancelled.

The conversation renders safe commentary and a small factual activity set in chronological order
while a turn runs. Commentary accepts provider-designated reasoning summaries in both nested
`item.completed` and flat `item.reasoning` Codex envelopes, plus assistant preambles and
host-authored progress; raw chain-of-thought remains private. Stable event ids update an existing
row in place, internal discovery calls are suppressed, and recovered retries collapse to their
latest successful state. Both commentary and tool activity persist in message metadata so a
reconnect reconstructs the same timeline. Completed work collapses to a quiet duration row by
default. The transcript intentionally does not mount build-session, durable-plan, architecture,
proactive-status, or run-control cards: plans remain readable reply text, while operational state
belongs to its dedicated App/Run surface. Confirmation actions and requested file artifacts remain
inline because they are part of the conversation itself.

Codex model-catalogue parse failures (including a missing `base_instructions` field) are treated
as recoverable runtime state. Agentis only quarantines an identified `models-cache.json` or
`models_cache.json` file, then retries once; it never deletes Codex credentials or configuration.

## Workflow authoring contract

`agentis.build_workflow` accepts a natural-language `description` with an optional authored
`graphDraft`. When a synthesis runtime is unavailable, Agentis creates a deterministic,
editable baseline through the same validation and enrichment gates rather than asking a runtime
to guess a private graph format. `agentis.workflow.draft_contract` exposes the public request
shape, a minimal valid graph, and graph identity repair rules. Draft validation returns
`WORKFLOW_DRAFT_INVALID` with the affected field, accepted shape, and repair action.

Agent positions are durable workspace data. `/v1/agents/reconcile-layout` backfills only
missing or invalid legacy coordinates, preserves manual layouts, and emits an agent update so
Home and Agents canvases converge immediately.

## API surface

- HTTP: `/v1/agents`, `/v1/specialists`, `/v1/adapters`, `/v1/harness`, `/v1/command`,
  `/v1/conversations`, `/v1/terminal`.
- Tools: `agentis.agents.{list,create}`, `agentis.agent.{spawn,dispatch}`,
  `agentis.specialist.{create,request}`, `agentis.routing.preview`.

---

**Next:** [05 · Sovereignty →](./05-sovereignty.md)
