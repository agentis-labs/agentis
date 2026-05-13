# Agentis Platform Gaps - n8n Parity Completion Record
## Based on OpenClaw/Hermes + n8n Community Research (May 2026)

> **Status:** Complete for the Agentis V1 architecture - May 2026
> **Context:** Research identified 8 practical parity gaps that forced operators to pair Agentis/OpenClaw/Hermes with n8n. This record documents the completed implementation and the places where Agentis intentionally solves the same product need differently from n8n.
> **Not in scope:** broad UI redesign, agent memory model changes, full hosted marketplace operations, or a commitment to maintain hundreds of hand-written native API clients.

---

## Executive Summary

The original 8 gaps are closed for V1. Operators can now build deterministic, inspectable workflow plumbing on the same canvas as agentic work:

1. First-class `integration` nodes, a built-in integration catalog, native Tier 1 connectors, and generic HTTP fallback execution for manifest-only services.
2. Existing visual workflows preserved and extended rather than rebuilt.
3. Deterministic `filter`, `transform`, `code`, `batch`, router/If-Else, and architecture-compatible `llm_route` execution.
4. Node I/O inspection with latest history payloads, live run payloads, and pinned input display/actions.
5. Workflow test mode, pinned test data, and run-from-node APIs surfaced in canvas and inspector UX.
6. Webhook trigger operations: event log, replay, activate/pause, copy URL, and secret regeneration.
7. Loop/batch item progress contracts and live node progress overlays.
8. Integration package/catalog surface through the packages system.

Agentis does not copy n8n's internal per-item execution model byte-for-byte. The platform keeps workflow execution explicit and agent-aware: loops and batches expose item progress and aggregate results in run state; long-tail integrations execute through a generic HTTP connector unless a native module is worth maintaining.

---

## Final Capability Matrix

| Original gap | V1 status | Completed implementation |
|---|---|---|
| 50 integration nodes | Complete | `integration` node type, `@agentis/integrations`, native high-leverage connectors, built-in manifests for the long tail, generic HTTP fallback for manifest-only services. |
| Operator-built workflows | Complete | Existing ReactFlow canvas, palette, inspector, templates, draft-from-prompt, run overlays, and context-menu execution are the operator surface. |
| Deterministic logic without LLM | Complete | `filter`, `transform`, `code`, `batch`, router If/Else alias, SafeConditionParser, and `llm_route` fallback. |
| Node I/O data inspector | Complete | Run history payloads, latest I/O, live I/O from realtime node events, and pinned input view/actions in the inspector. |
| Workflow test mode | Complete | `testMode`, workflow test-data APIs, `runs/from-node`, pinned inputs in settings, canvas run-from-node action, and inspector run/pin/clear controls. |
| Production webhook management | Complete | Webhook events table/APIs, replay, trigger activate/pause, copy URL, secret regeneration, and operations panel in trigger inspector. |
| Batch/item processing | Complete for V1 | Loop/batch item progress state, `continueOnItemFailure`/failure caps, realtime `LOOP_PROGRESS`/`BATCH_PROGRESS`, and canvas progress display. |
| Integration package registry | Complete | Integration manifests exposed through package routes and Packages/Library integration catalog. |

---

## Codebase Reality Check

Audited and updated areas:

| Area | Current state |
|---|---|
| Workflow contracts | `packages/core/src/types/workflow.ts` and `packages/core/src/schemas/workflow.ts` include deterministic node configs, integration config, batch config, and loop/batch item progress fields. |
| Realtime contracts | `packages/core/src/events.ts` includes node lifecycle events plus `LOOP_PROGRESS` and `BATCH_PROGRESS`. |
| Runtime engine | `apps/api/src/engine/WorkflowEngine.ts` dispatches deterministic nodes, integration nodes, `llm_route`, live `NODE_STARTED` input payloads, router branch gating via `sourceHandle`, and item progress publishing. |
| Integration registry | `packages/integrations/src/registry.ts` maps native connectors and manifest-only connectors through a generic HTTP connector fallback. |
| Webhook routes | `apps/api/src/routes/triggers.ts` exposes trigger CRUD, events, replay, status changes, and webhook secret regeneration. |
| Workflow APIs | `apps/api/src/routes/workflows.ts` exposes test data, run-from-node, normal runs, test runs, and node run history. |
| Canvas UX | `apps/web/src/pages/WorkflowCanvasPage.tsx` loads/saves pinned test data, runs from a selected node, handles live I/O/progress events, and renders node progress. |
| Inspector UX | `apps/web/src/components/canvas/ContextInspector.tsx` displays live/latest I/O, pinned data, run/pin/clear actions, and webhook operations for trigger nodes. |
| Package catalog | `apps/api/src/routes/packages.ts`, `packages/core/src/types/package.ts`, and `apps/web/src/pages/PackagesPage.tsx` support built-in integration catalog surfaces. |

---

## Architectural Decisions

### 1. Integration Nodes Are Deterministic Workflow Steps

The decision-maker determines the dispatch path:

| Scenario | Decision-maker | Correct path |
|---|---|---|
| An agent decides mid-task to call Slack | LLM/agent runtime | `skill_task` -> agent -> skill execution |
| Operator configures a Slack step on the canvas | Operator at build time | `integration` -> `ConnectorRegistry` -> connector execution |

Routing operator-configured integrations through the agent stack would add latency, token cost, and ambiguity to steps that are already fully specified. The `integration` node keeps deterministic API calls cheap and observable while preserving the existing retry, cache, credential, and ledger behavior.

### 2. Native Connectors Are Reserved For High-Value Services

The catalog can list many integrations without pretending every service deserves a full native client on day one.

V1 connector model:

- Native modules for the high-value services already implemented in `packages/integrations/src/connectors/apiConnectors.ts`: `http_request`, `webhook_send`, `slack`, `gmail`, `github`, and `google_sheets`.
- Manifest-only services are executable through `genericHttpConnector(...)` when their operation params provide HTTP request details.
- `http_request` remains the universal escape hatch for rare endpoints and low-frequency automations.
- Native connectors can be added progressively when a service has enough repeated, distinct operations to justify maintenance.

This closes the platform gap without starting an unwinnable connector-count race against n8n/Make/Zapier.

### 3. `llm_route` Is Implemented Without A Hard LLM Dependency

`RouterNodeConfig.routingMode` includes `llm_route`; the engine no longer rejects or silently skips it. V1 implements an architecture-compatible classifier/fallback that can choose a branch deterministically from branch labels/conditions and input data. This keeps workflows runnable in local/self-hosted environments that do not have a configured hosted LLM route service.

### 4. Test Data Lives With Workflow Editor State

Pinned inputs are stored under workflow settings via the existing test-data API instead of a separate table. That keeps editor-only test fixtures close to the graph, easy to export with the workflow, and simple to use from the canvas.

### 5. Webhook Operations Are Trigger Inspector Features

Webhook management lives beside the webhook trigger node because that is where operators already configure the trigger. The trigger inspector exposes URL, create/update status controls, event logs, replay, and secret regeneration.

### 6. Batch/Loop Processing Is Explicit And Observable

n8n hides much of its item fan-out behind node internals. Agentis keeps V1 semantics explicit:

- `loop` and `batch` nodes record item-level progress metadata.
- The engine emits `LOOP_PROGRESS` and `BATCH_PROGRESS` during execution.
- Canvas nodes show progress counts and failures inline.
- Aggregate results flow downstream as normal node outputs.

This gives operators the operational visibility they need while preserving Agentis' run-state model. Per-item branch replay can be added later on top of the recorded progress model if product usage proves it is necessary.

---

## Item 1 - Integration Nodes

### Status: Complete

Implemented capabilities:

- `WorkflowNodeType` includes `integration`.
- `IntegrationNodeConfig` supports `service`, `operation`, `credentialId`, `params`, retry/cache, and timeout settings.
- `WorkflowEngine` resolves credentials through the existing vault and dispatches through the default connector registry.
- Connector execution is stateless and typed around operation, params, input data, and credential payload.
- Native connectors cover the universal/high-leverage V1 services.
- Manifest-only connectors no longer throw unavailable errors by default; they map to a generic HTTP connector fallback.
- Built-in manifests are exposed through package/catalog APIs and the integrations catalog UI.

Native connector policy:

| Tier | V1 treatment |
|---|---|
| Universal foundation | Native modules or direct generic support. |
| High-leverage SaaS | Native modules where already implemented, then progressive hardening. |
| Long-tail APIs | Built-in manifests plus generic HTTP fallback. |
| Community/custom | Package import and custom manifests remain future extensibility, not required for V1 parity. |

This means the platform can run deterministic API steps today, while the connector maintenance surface stays realistic.

---

## Item 2 - Operator-Built Workflows

### Status: Complete

The visual workflow builder already existed and was kept as the foundation:

- ReactFlow canvas editor.
- Node palette.
- Context inspector tabs: Configure, I/O, Run history, Notes.
- Workflow templates and prompt-generated draft workflows.
- Run/test execution overlays.
- Context menu actions.

The parity work extended this surface instead of replacing it. Operators now configure deterministic nodes, integrations, pinned input, run-from-node, live I/O, and webhook operations inside the same canvas they already use for agents.

---

## Item 3 - Deterministic Logic Nodes Without LLM

### Status: Complete

Implemented deterministic primitives:

| Node/mode | Purpose | Runtime behavior |
|---|---|---|
| `router` / If-Else alias | Branch on boolean expressions | Uses SafeConditionParser; branch fan-out respects `sourceHandle`. |
| `filter` | Filter arrays by condition | Evaluates per item without LLM. |
| `transform` | Map, template, or extract data | Uses safe path/template resolution. |
| `code` | Operator-authored JavaScript expression/function | Runs in a constrained VM context with timeout. |
| `batch` | Bulk item processing | Produces aggregate results and item progress metadata. |
| `integration` | Deterministic API call | Dispatches through connector registry. |
| `llm_route` | Semantic branch choice | Uses V1 classifier/fallback instead of throwing unsupported. |

Result: common automation tasks such as filtering, extracting, mapping, branching, and API calls no longer require `agent_task` prompts or token spend.

---

## Item 4 - Node I/O Data Inspector

### Status: Complete

Implemented capabilities:

- Run history includes input/output/error payloads.
- The inspector I/O tab shows the selected node's latest persisted history entry.
- During an active run, realtime node lifecycle events update the inspector with live input/output/error.
- `NODE_STARTED` carries `inputData`, so the exact resolved input can be shown before the node completes.
- Pinned input is visible beside live/latest I/O.
- Operators can run the selected node from the I/O tab and manage pinned data from the same place.

The inspector now answers the n8n-style operational question: "what went into this node, what came out, and what sample data am I testing with?"

---

## Item 5 - Workflow Test Mode

### Status: Complete

Implemented backend APIs:

- `GET /v1/workflows/:id/test-data`
- `PUT /v1/workflows/:id/test-data`
- `POST /v1/workflows/:id/runs/from-node`
- `POST /v1/workflows/:id/run` with `testMode`
- `GET /v1/workflows/:id/nodes/:nodeId/run-history`

Implemented UX:

- Canvas loads and stores `pinnedInputs` for each workflow.
- Context menu includes "Run this node".
- Inspector I/O tab exposes run-from-node.
- Inspector can pin live/latest input and clear pinned input.
- Run-from-node uses pinned input when present.
- Test runs stay scoped to the canvas/run overlay instead of noisy workspace-wide notifications.

Storage decision:

- Pinned data is editor/test state, so it lives in `workflows.settings.testData` rather than a new first-class domain table.

---

## Item 6 - Production Webhook Management

### Status: Complete

Implemented backend capabilities:

- Webhook triggers still generate secrets at creation.
- Webhook events are persisted with sanitized request details and dispatch status.
- Operators can list recent events.
- Operators can replay a stored event as a fresh run.
- Webhook secrets can be regenerated, with the new secret returned once.
- Trigger status can be activated or paused from operational controls.

Implemented UX:

- Trigger inspector includes webhook operations.
- Operators can create/list webhook trigger records for the workflow.
- Operators can copy the webhook URL.
- Operators can activate/pause a trigger.
- Operators can regenerate the secret.
- Operators can inspect recent webhook events and replay them.

Agentis adaptation:

- Agentis uses a single webhook endpoint authenticated by the trigger secret and controlled by trigger status/test settings. This is simpler than n8n's separate editor-only test URL while still covering production operations for self-hosted V1.

---

## Item 7 - Batch / Item-Level Processing

### Status: Complete for V1

Implemented capabilities:

- `batch` is a first-class node type with schema, config, palette/inspector support, and engine execution.
- `LoopNodeConfig` supports item failure continuation controls.
- Loop and batch state track totals, completed/failed counts, item metadata, and outputs/errors where available.
- The engine emits realtime item progress through:
  - `LOOP_PROGRESS`
  - `BATCH_PROGRESS`
- Canvas nodes render progress overlays such as completed/failed/total counts.

Explicit V1 boundary:

- Agentis V1 does not hide downstream per-item fan-out behind every node the way n8n does.
- The implemented model records item progress and aggregate results explicitly at loop/batch nodes.
- This satisfies V1 operator visibility and failure-tolerance needs without destabilizing the workflow engine's run-state model.

Future extension, if needed:

- Per-item branch replay can reuse the recorded item progress metadata and run-from-node machinery.
- Native per-item downstream replay should be designed as a deliberate engine feature rather than an implicit side effect of every array-producing node.

---

## Item 8 - Integration Package Registry

### Status: Complete

Implemented capabilities:

- `integration` is represented in package/catalog typing.
- Built-in integration manifests are served through package APIs.
- The Packages/Library UI includes an integrations catalog surface.
- The catalog describes service, category, operations, credential expectations, and node config defaults.
- Integration catalog entries create deterministic `integration` workflow nodes instead of agent tasks.

V1 boundary:

- Built-in catalog entries are available now.
- Custom package import and a public hosted community marketplace are extension points, not blockers for this parity milestone.

---

## What This Unlocks

| Community workflow | Before | After |
|---|---|---|
| If score > 80, send Slack, else email | Multiple prompts and LLM calls | Trigger -> router/If -> Slack/Gmail integration, zero LLM calls for routing/API plumbing. |
| Filter list to active items | Agent prompt | `filter` node. |
| Extract fields from API response | Agent prompt | `transform` node. |
| Run a small data expression | Agent prompt or external script | `code` node with timeout. |
| On webhook, inspect payload and retry | Manual debugging | Webhook event log + replay. |
| Test one broken node | Run whole workflow repeatedly | Run-from-node with pinned input. |
| Process many records | External n8n loop | `batch`/`loop` with progress and failure counts. |
| Call long-tail API | External n8n connector | Built-in manifest + generic HTTP connector or `http_request`. |

---

## Competitive Framing

This is not a connector-count competition. n8n and Make will always have more hand-written connectors.

Agentis' V1 position is stronger and narrower:

> Agentis is where deterministic workflow plumbing and agentic reasoning live in the same canvas. The platform handles data transforms, filtering, routing, API calls, test fixtures, webhooks, approvals, and agents that can reason or replan when intelligence is actually needed.

The LLM is no longer used as glue for simple logic. It is reserved for the work that needs judgment.

---

## Verification Record

Final validation after this completion pass:

| Command | Result |
|---|---|
| `pnpm --filter @agentis/core typecheck` | Passed |
| `pnpm --filter @agentis/integrations typecheck` | Passed |
| `pnpm --filter @agentis/db typecheck` | Passed |
| `pnpm --filter @agentis/api typecheck` | Passed |
| `pnpm --filter @agentis/web typecheck` | Passed |
| `pnpm --filter @agentis/api test -- tests/core/events.test.ts tests/core/schemas.workflow.test.ts tests/routes/packages.test.ts tests/routes/workflows.test.ts tests/routes/triggers.test.ts tests/services/triggerRuntime.test.ts` | Passed: 6 files, 50 tests. |
| `pnpm --filter @agentis/web test -- tests/components/WorkflowCanvas.test.tsx tests/components/WorkflowNode.test.tsx` | Passed: 2 files, 8 tests. |

Verification follow-up handled during this pass:

- A web type narrowing issue in live failure payload handling was fixed before the final web typecheck.
- A duplicate React key warning in the node palette exposed router alias ambiguity. The palette now uses a stable `paletteId` for If / Else while still creating a router node with the correct default config.

---

## Completion Definition

This doc is considered 100% complete for V1 when all of the following are true:

- Deterministic workflow nodes exist and run without LLM dependency.
- Integration nodes execute through the connector registry.
- Manifest-only integrations have a working generic HTTP fallback.
- Operators can inspect live/latest node I/O.
- Operators can pin input and run from a selected node.
- Webhook triggers have event logs, replay, activation controls, and secret rotation.
- Loop/batch progress is observable through realtime events and canvas overlays.
- The integration catalog is visible through the package/library surface.
- Typechecks pass for core, integrations, API, and web.

All completion criteria above are met by the current implementation.
