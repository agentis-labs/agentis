# Agentis Orchestrator V1

This document is the developer contract for the Agentis orchestrator experience in V1. It describes the real implementation in this repository: chat turns run through the adapter `chat()` loop, platform actions execute through `AgentisToolRegistry`, canvas builds stream realtime events, and critical platform events can surface proactive cards in the operator thread.

## Goals

- Make the Agentis chat thread an operational surface, not a passive relay.
- Let the orchestrator inspect, build, run, patch, diagnose, and coordinate Agentis resources through registered tools.
- Stream tool calls, tool results, assistant text, and live canvas build events to the web UI.
- Give the orchestrator enough platform, architecture, gateway, budget, viewport, and memory context to act safely.
- Surface failure, timeout, budget, and approval events proactively.

## Runtime Flow

1. The web thread posts to `POST /v1/conversations/:agentId/send` with `Accept: text/event-stream`.
2. The API appends the operator message through `ConversationStore.appendOutbound()`.
3. If the agent adapter exposes `chat()`, the route streams `ChatSessionExecutor.turn()` as SSE `delta` events.
4. `ChatSessionExecutor` builds the system prompt from `orchestratorPrompt.ts`, passes `CHAT_TOOL_CATALOG` to the adapter, and executes requested tools in parallel batches.
5. `ChatToolExecutor` routes each model tool call to `AgentisToolRegistry.execute()` with `caller: 'chat'`.
6. Registered handlers return structured results. The executor emits `tool_result` deltas and feeds summarized tool results back into the next model turn.
7. Final assistant text is persisted as an agent message and emitted as an SSE `message` event.
8. If the adapter has no `chat()` path, OpenClaw agents still relay legacy session messages; other harnesses return a clear chat-harness message.

## Composition Root

The bootstrap wires the orchestrator plane in `apps/api/src/bootstrap.ts`:

- `AgentisToolRegistry` is created once.
- `registerAllTools()` registers all tool families under `apps/api/src/services/agentisToolHandlers/`.
- `ChatToolExecutor.configure({ registry })` connects chat tool calls to the registry.
- `ChatSessionExecutor.configure({ db, logger, bus, adapters })` enables prompt context loading.
- `ViewportStore` captures the latest operator viewport from the realtime socket.
- `OrchestratorEventBridge` subscribes to critical bus events and publishes proactive cards.

## Tool Surface

`CHAT_TOOL_CATALOG` is the model-facing schema list. Every V1 catalog entry maps to a registered `AgentisToolRegistry` handler.

### Workflow and Runs

- `agentis.workflow.run` starts a workflow run and accepts `inputs` or JSON string `input`.
- `agentis.workflow.status` returns status, progress, active node, completed count, and failed nodes.
- `agentis.workflow.list` lists recent runs.
- `agentis.workflow.cancel` cancels a run.
- `agentis.workflow.patch` replaces an at-rest graph or applies a live `WorkflowGraphPatch` to a run.
- `agentis.run.query` queries run history.
- `agentis.run.diagnose` reads run state plus recent ledger events and suggests recovery actions.
- `agentis.audit_trail` reads ordered ledger events.

### Agents and Teams

- `agentis.agents.list` lists workspace agents and whether their adapter is currently registered.
- `agentis.agents.create` creates an agent row. If no harness config is supplied, the agent is offline until configured.
- `agentis.agent.spawn` is the create-agent alias used for role-based specialist creation.
- `agentis.agent.dispatch` sends work to an existing agent. It uses adapter `chat()` when available, otherwise dispatches a normalized task.
- `agentis.team.design` returns a team blueprint with proposed roles, capability tags, and coordination rules.

### Memory and Knowledge

- `agentis.memory.read` searches persistent workspace memory when called with `query`; it still reads scratchpad memory when called with `runId` and `key`.
- `agentis.memory.write` writes persistent workspace memory when called with `title` and `content`; it still writes scratchpad memory when called with `runId`, `key`, and `value`.
- `agentis.knowledge.search` searches a specific knowledge base, app knowledge, or workspace knowledge depending on supplied IDs.
- `agentis.knowledge.write` indexes text into the workspace knowledge base, app knowledge plane, or fallback knowledge chunk storage.
- Memory architecture tools under `agentis.memory.*` remain registered for episodes, working memory, promotion, and baselines.

### Environment, Canvas, and HTTP

- `agentis.apps.status` returns OpenClaw gateway rows plus live adapter health registrations.
- `agentis.canvas.context` reads the latest viewport and loads selected workflow, run, agent, or team details.
- `agentis.approval.list` and `agentis.approval.resolve` operate the approval inbox.
- `agentis.space.summary` summarizes workspace or space runs, success rate, output labels, and approvals.
- `http_fetch` uses the existing SSRF-guarded builtin HTTP fetcher.

### Planning Helpers

- `agentis.plan` returns ordered execution steps.
- `agentis.evaluate` scores an artifact against criteria.
- `agentis.reflect` returns critique plus a recommended next action.

## Live Canvas Builder

`agentis.build_workflow` is implemented in `agentisToolHandlers/build.ts`.

Behavior:

1. Builds a V1 `WorkflowGraph` from the natural language description.
2. Creates a new workflow shell or empties an existing workflow while building.
3. Emits `agent.work.step` when the build starts.
4. Emits `canvas.node.placed` for each generated node.
5. Emits `agent.work.step` after each node placement.
6. Emits `canvas.edge.connected` for each edge.
7. Persists the completed graph.
8. Emits `canvas.build.complete`.

Events are published to workspace, workflow, run/build, and conversation rooms when available. Chat builds use a synthetic `runId` of `build_<workflowId>` so `ThreadView` and `CanvasEmbed` can correlate the mini canvas even outside a workflow engine run.

## Realtime and Viewport

The web app emits `viewport_context` through the shared socket. `createRealtimeServer()` validates workspace ownership and stores the latest context in `ViewportStore` keyed by user/socket.

The conversation SSE route passes viewport context to `ChatSessionExecutor` when `useViewportContext` is true. The prompt and `agentis.canvas.context` tool can then answer references like "this workflow", "the selected run", or "the canvas" without guessing.

## Prompt Contract

`orchestratorPrompt.ts` includes:

- `PLATFORM_KNOWLEDGE`: platform entities, states, API surfaces, and safety constraints.
- `PLATFORM_ARCHITECTURE_KNOWLEDGE`: tool plane, builder, subagent, reliability, and cost-awareness rules.
- `ORCHESTRATOR_BEHAVIOR_RULES`: clarification rules, data-ingestion offer rules, and action style.
- Current context: workspace, ambient, current agent, inventory, active runs, pending approvals, gateway health, registered adapters, budget snapshot, viewport, mentions, and resource references.

Clarification rules:

- Ask before building when the goal/output or primary agent/skill choice is unclear.
- Ask before spawning an agent when an existing agent may fit or the new role lacks instructions.
- Ask at most two questions per response.
- For research, analysis, or writing workflows, ask once whether the user has documents, URLs, or data to index first.

## Proactive Bridge

`OrchestratorEventBridge` subscribes to the in-process event bus and reacts to:

- `run.failed`
- `watchdog.timeout`
- `budget.event.created`
- `approval.requested`

For each event, it finds the workspace orchestrator agent by `role = 'orchestrator'`, then by name match (`Agentis` or `orchestrator`), then falls back to the first workspace agent. It publishes `agent.proactive.push` to the workspace room and the orchestrator conversation room.

The web `ThreadView` renders these payloads through `ProactiveCard`.

## Frontend Contracts

- `ThreadView` uses `streamSse()` and consumes `delta`, `message`, and realtime canvas/proactive events.
- `ToolCallPill` renders live `tool_call` and `tool_result` states.
- `CanvasEmbed` listens for `canvas.node.placed`, `canvas.edge.connected`, and `canvas.build.complete` by `runId`.
- `CanvasNarration` listens for `agent.work.step` and canvas events.
- `ProactiveCard` renders `agent.proactive.push` cards with action buttons.
- `streamSse()` in `apps/web/src/lib/api.ts` applies auth/workspace headers and parses SSE frames.

## Verification

Required focused validation for this surface:

```powershell
pnpm --filter @agentis/core typecheck
pnpm --filter @agentis/api typecheck
pnpm --filter @agentis/web typecheck
pnpm --filter @agentis/api test -- tests/services/chatSessionExecutor.test.ts tests/routes/conversationsSse.test.ts tests/routes/conversations.test.ts tests/services/orchestratorEventBridge.test.ts
```

Current validated state:

- Core typecheck passes.
- API typecheck passes.
- Web typecheck passes.
- Focused chat, SSE conversation, conversation route, and proactive bridge tests pass.