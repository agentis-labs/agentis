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
| `ClaudeCodeAdapter` | Claude Code CLI | marker tools; native MCP when a server is mounted |
| `CodexAdapter` | OpenAI Codex CLI | optional native browser/computer-use |
| `CursorAdapter` | Cursor | semantic code index |
| `AntigravityAdapter` | Google Antigravity (agy) | native MCP; reads transcript for output |
| `HermesAgentAdapter` | Hermes Agent (ACP) | dual-transport ACP client |
| `HermesAdapter` / `LocalLlmAdapter` | OpenAI-compatible streaming | Nous / LM Studio / llama.cpp |
| `OpenClawAdapter` | OpenClaw gateway | unified LLM gateway, session persistence |
| `HttpAdapter` | Custom HTTP callback | any endpoint, HMAC auth |

All six CLI/streaming harnesses share a common chat runtime (`adapters/cliChatRuntime.ts`).

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

## Sessions, specialists, chat

- **Sessions** (`agent_sessions`, `agent_session_messages`) persist across LLM calls;
  memory blocks (persona/task/plan/observations) are reconstructed per call so tool loops
  spend no tokens re-sending context. Streaming + abort are supported where the runtime allows.
- **Specialists** (`services/specialist/`, `/v1/specialists`) — an open role registry
  (platform/custom/generated/community) with demand routing + scoring; a specialist runs a full
  agent session by default.
- **Chat** exposes sticky **Ask / Plan / Auto** permission modes shared across web and every
  channel.

## API surface

- HTTP: `/v1/agents`, `/v1/specialists`, `/v1/adapters`, `/v1/harness`, `/v1/command`,
  `/v1/conversations`, `/v1/terminal`.
- Tools: `agentis.agents.{list,create}`, `agentis.agent.{spawn,dispatch}`,
  `agentis.specialist.{create,request}`, `agentis.routing.preview`.

---

**Next:** [05 · Sovereignty →](./05-sovereignty.md)
