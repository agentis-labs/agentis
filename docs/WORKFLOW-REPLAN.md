# Agentis — Workflow System Replan
## Complete Automation Platform: Ground-Truth Rewrite with Brain-Apps Forward Compatibility

> **Status:** Architecture plan — second full rewrite, ground-truth after line-by-line codebase audit
> **Date:** May 2026 (rev 2)
> **Scope:** Workflow engine, node taxonomy, execution model, UX architecture, reliability layer, persistent state, NL synthesis, long-running workflow architecture
> **Branch context:** Implementation target is **`main`** — standalone workflows, no apps concept, no brain concept visible to users. The **`brain-apps`** branch is a future release that builds on top of main. This plan is written to serve both: close the gaps for main, but lay every foundation that brain-apps will land on.
> **Auditor's note:** Rev 1 was based on a speculative codebase state — several "planned" features it described (evaluator, guardrails, loop, context_compress as engine cases) do not exist at all. Rev 2 is based on a line-by-line audit of `WorkflowEngine.ts`, `packages/core/src/types/workflow.ts`, `NodePalette.tsx`, `ContextInspector.tsx`, `scratchpad.ts`, `buildWorkflowDraft()`, `validateGraph.ts`, `workflowGraphStore.ts`, `workflowDeployments.ts`, `evaluatorRuntime.ts`, `jobQueue.ts`, `connectorRegistry.ts`, `liveNodeTail.ts`, and the DB schema. If it is not confirmed in those files, it is not described as real here.

---

## Part I — Ground-Truth State Audit

Before writing a single line of plan, here is what the codebase actually contains — not what was hoped or assumed, but what is present when you read the files.

### What Is Genuinely Implemented

The **WorkflowEngine** is production-grade. DAG execution, run state persistence, partial replay (4 modes), ledger, adapter dispatch, subflow delegation, concurrency overflow queue, watchdog recovery — all solid. The realtime bus, socket.io rooms, and the telemetry/OTel span wiring are well-designed. The canvas infrastructure (CanvasEngine, ContextInspector, RunDrawer, AgentisEdge, CanvasMotionLayer) is a coherent system.

**Node types with working engine handlers today:**

| Kind | Engine handler | Notes |
|------|---------------|-------|
| `trigger` | Pass-through | ✓ |
| `merge` | Pass-through | ✓ |
| `scratchpad` | read/write/append/delete | ✓ (run-scoped only) |
| `router` | first_match, all_matching | `llm_route` mode in config schema — no engine handler |
| `checkpoint` | manual + auto_after_timeout | ✓ |
| `skill_task` | All runtimes (builtin/node_worker/docker) | ✓ |
| `knowledge` | Contextual/strict/exploratory | ✓ |
| `agent_task` | Async adapter dispatch + self-heal | Self-heal shipped; Brain context injection degrades gracefully |
| `agent_swarm` | Parallel fan-out over array with merge strategies | Engine complete; **no palette entry, no inspector form — user-unreachable** |
| `artifact_collect` | Artifact store write + optional approval gate | Engine complete; **no palette entry, no inspector form — user-unreachable** |
| `data_write` | Write to app-scoped structured data layer | Engine complete; requires `appId` — **not usable on main branch** |
| `data_read` | Query app-scoped structured data layer | Engine complete; requires `appId` — **not usable on main branch** |
| `brain_lookup` | Query Collective Brain graph | Engine complete; requires `collectiveBrain` dep — **not usable on main branch** |
| `subflow` | SubflowExecutor delegation | ✓ |

**The scheduler backend** (`schedule_runs`, `workflow_event_subscriptions`, `workflow_run_queue`, SchedulerService, `/v1/scheduler/*` routes) is fully implemented. Event chains (cross-workflow triggers) are wired. The gap is purely UI.

**The packages/integrations package** exists with a `ConnectorRegistry`, built-in manifests (Slack, Gmail, GitHub, Google Sheets, HTTP), native connector modules, and `IntegrationManifest` typed as `nodeConfig: { kind: 'integration' }`. This infrastructure is **completely disconnected** from the workflow canvas — `'integration'` is not in `WorkflowNodeType`, the ConnectorRegistry is not injected into the WorkflowEngine.

**The EvaluatorRuntime service** (`evaluatorRuntime.ts`) is a fully implemented LLM-as-judge with `EvaluatorVerdict: 'pass' | 'fail' | 'partial'`, rubric-based scoring, and JSON shape similarity. It is used by `AppContractRuntime` but **never imported or wired into WorkflowEngine**. There is no `evaluator` case in `#dispatchNode()`.

**The DurableJobQueue** (`jobQueue.ts`) is a SQLite-backed queue with `low|normal|high` priority and a swappable backend interface (`JobQueueBackend`) designed for future BullMQ/Redis. It is used for brain queue draining and `enqueueWorkflowRun()`. This is the correct substrate for workflow-level persistent job scheduling.

**workflowGraphStore** has `replaceGraph()` and `listGraphRevisions()` — full version history with hashes and reasons, per-workflow. This is **not exposed via any API route**. Users cannot see or restore revisions.

**workflowDeployments.ts** implements a full deployment system with versioning, sync/async modes, token-auth (constant-time hash comparison), and `DeploymentRecord`. This is **not surfaced on any canvas page** — users don't know they can deploy workflows as API endpoints.

**workflowCostCompiler.ts** (`WorkflowCostCompiler`) performs pre-run node cost classification and estimates upper-bound LLM spend. It produces `GraphCostShape`. Whether this is surfaced anywhere in the UI should be verified.

**liveNodeTailService.ts** is an in-memory ring buffer (last 32 entries per node per run) for per-node activity. **Not wired to any realtime event stream or API response visible to the canvas.**

### What the Previous Plan Got Wrong

The previous version of this document stated that `evaluator`, `guardrails`, `context_compress`, `loop`, and `parallel` "exist in the schema but are not wired." **This is false.** None of these node types appear in `WorkflowNodeType`, none have a `case` in `#dispatchNode()`, and none have Zod schemas in the workflow schema file. They have not been started in any form.

The previous plan treated `agent_swarm` and `artifact_collect` as future "brain-apps" items. Both have complete engine handlers — but neither has a palette entry nor an inspector form. They are invisible to every user. That is engine code with no front door, not an implemented feature.

The previous plan said "Sections that referenced brain-apps compatibility have been removed." This plan reverses that decision. The brain-apps branch is a future release, but the architecture decisions made on main will either accelerate or block it. **Brain-apps compatibility is a hard constraint, not an optional note.**

---

### The 13 Real Gaps

**Gap 1 — Missing deterministic node types.** The five most-requested automation primitives (`transform`, `filter`, `loop`, `http_request`, `wait`) either have no engine handler or no schema. Users are forced to put agent tasks in workflows for things like "extract the first item from this array" or "call a REST endpoint." That is a cost leak and a conceptual mismatch — not every step requires an LLM.
- `wait`: ContextInspector has a `WaitForm`, but the palette has no entry and the engine has no handler.
- `loop`, `transform`, `filter`, `http_request`: nothing anywhere — no type, no schema, no UI, no handler.

**Gap 2 — No integration node.** The Slack/Gmail/GitHub/HTTP connectors are built and working in `packages/integrations` but inaccessible from the canvas. The `IntegrationManifest` type already declares `nodeConfig: { kind: 'integration' }`. Unlocking the ConnectorRegistry from the canvas is the single change with the highest user-visible impact.

**Gap 3 — No reliability primitive.** When an agent task produces mediocre output, the run completes with `COMPLETED` status regardless. The `EvaluatorRuntime` service exists but is never wired as a node type. There is no structural way to say "check this output; if it fails criteria, ask the agent to try again with the critique."

**Gap 4 — No error edge routing.** A failed node always terminates the run via `#failNode()`. `WorkflowEdge` has no `type` field. Error edges are architecturally impossible in the current type system. Production workflows require catch branches.

**Gap 5 — No variable interpolation.** The `agent_task` prompt is dispatched as the literal string in `config.prompt` — there is no `resolveTemplate()` call anywhere in the engine. `{{trigger.input.text}}` is sent verbatim to the model. No template resolver file exists anywhere in the codebase.

**Gap 6 — Scheduler UI is 100% missing.** The backend (`schedule_runs`, `workflow_event_subscriptions`, SchedulerService, `/v1/scheduler/*` routes) is complete. The UI is zero. Users cannot create scheduled workflows through the product.

**Gap 7 — Variable picker does not exist.** Users must memorize or guess variable paths to reference upstream node output. This kills authoring velocity for any workflow beyond 3 nodes.

**Gap 8 — No persistent cross-run workflow state.** `ScratchpadService` is a pure in-memory `Map<runId, Map<key, value>>` — it calls `dispose(runId)` on run completion and all state is lost. There is no `workflow_kv` table, no `workflow_store` service, no cross-run accumulation mechanism. A workflow that runs daily for a month cannot remember anything from the previous run without being engineered externally. This is the foundational gap for any genuinely long-running automation.

**Gap 9 — NL workflow synthesis is a regex skeleton.** `buildWorkflowDraft()` in `agentisToolHandlers/build.ts` is pure regex pattern matching (`/research|search|analy[sz]e/.test(lower)` etc.). It does not call an LLM. It always produces a rigid 3–4 node linear chain: trigger → (optional knowledge) → agent_task → (optional checkpoint) → scratchpad. It cannot produce loops, parallel branches, integration nodes, or any complex structure. The `agentis.build_workflow` tool is already registered and callable from chat — it just calls a regex function.

**Gap 10 — No workflow-level input/output contracts.** `WorkflowGraph` has no `inputContract` or `outputContract` fields. `validateGraph.ts` only checks structural integrity (cycles, dangling edge refs, trigger count) — no per-kind config validation. An `agent_task` node with no `agentId` passes validation and fails only at run time with `WORKFLOW_GRAPH_INVALID`. Subflow callers cannot declare what they expect from the callee. The canvas has no type-awareness for `{{step.output.field}}` references.

**Gap 11 — Graph revision history and workflow deployments are hidden.** `workflowGraphStore.ts` has full per-workflow version history (hashes, reasons, timestamps) with zero API exposure. `workflowDeployments.ts` has a complete publish-as-API-endpoint system with token auth — zero canvas surface. Users don't know either capability exists.

**Gap 12 — Palette naming confusion creates broken nodes.** The `webhook` palette entry creates nodes with `type: 'webhook'`. `'webhook'` is not in `WorkflowNodeType`. There is no `case 'webhook'` in `#dispatchNode()`. Any workflow containing a "Webhook" palette node will hang or fail silently at runtime. The `approval` entry maps to `checkpoint` (fine). The `branch` entry maps to `router` (fine). The `skill` entry maps to `skill_task` (fine). Only `webhook` is structurally broken.

**Gap 13 — Long-running workflow architecture is unaddressed.** For workflows that run for weeks or months with hundreds of nodes, the current architecture has three hard limits: (a) there is no per-phase snapshot — the `eventsSinceSnapshot` mechanism snapshots the entire run state but was designed for crash recovery, not long-term structured checkpointing; (b) the `workflow_runs` table accumulates `blockData` JSON indefinitely with no compaction or archival policy; (c) the canvas has no phase-based grouping for large graphs — a 150-node workflow is navigable only by scrolling.

---

## Part II — Architecture Principles

These principles govern every decision in this plan.

### Principle 1 — Real-World Impact Before Technical Elegance

The integration node ships before the evaluator node. The scheduler UI ships before context compression. The variable picker ships before the command palette. Every sequencing decision prioritizes what makes workflows useful in the real world over what is technically interesting.

### Principle 2 — Deterministic-First Execution

If the output of a node is fully determined by its inputs — no reasoning required, no natural language interpretation — it must run without touching an LLM. The vocabulary gap that forces users to put agent tasks in their workflows for array iteration, HTTP calls, and data reshaping is the primary cost driver and the primary conceptual confusion. Every deterministic primitive added shrinks the LLM surface to where it genuinely belongs: reasoning, generation, and interpretation.

### Principle 3 — Variable Interpolation Is a First-Class Primitive

Context variables are the glue of any multi-step workflow. The engine must resolve `{{node.id.outputKey}}` expressions in every text field before dispatch — not just in prompts, but in HTTP URLs, body templates, and transform expressions. Without this, every node beyond the first requires copy-paste of previous outputs and manual agent task reformatting. The variable resolver is infrastructure, not a UX enhancement.

### Principle 4 — Reliability Through Structure, Not Model Quality

The answer to "how do I guarantee this workflow produces the right output?" is structural, not a better model. The evaluator-retry loop is the answer:

```
agent_task ──> evaluator ──[PASS]──> next node
                        └──[FAIL]──> agent_task  (critique injected into prompt)
```

This pattern works with any model. The platform does not promise smart agents. It promises smart orchestration.

### Principle 5 — Error Edges Are Not Optional

A workflow without error edges cannot be deployed to production. Every node that can fail must be able to express what happens when it does. Error edges route to catch branches the same way success edges route to the next step. This is not a reliability feature — it is the minimum contract for a workflow that runs unattended.

### Principle 6 — The Canvas Reflects Reality

During a live run, the canvas is the primary debugging interface. Node status, retry state, cache hits, and data flow must be visible on the canvas in real time — not only in the RunDrawer timeline. The `NODE_STARTED`, `NODE_COMPLETED`, `NODE_FAILED`, and `NODE_RETRY_SCHEDULED` events are already firing. The canvas just needs to consume them for all node types.

### Principle 7 — Main Branch Lays Foundations, Not Walls

Every architecture decision made for main must be analyzed against what brain-apps will need. This is not a compatibility guarantee — it is a constraint that prevents accidental debt.

**Concrete rules:**
- The `workflow_store` node (main) writes to `workflow_kv_entries(workflow_id, key, value)`. This is intentionally distinct from `data_write`/`data_read` (brain-apps), which write to app-scoped tables. They coexist without conflict. When brain arrives, `workflow_kv_entries` becomes queryable by the Brain as structured facts — zero schema change required.
- Workflow `inputContract` / `outputContract` fields (main) are the same shape as `AppRuntimeContract` outputs (brain-apps). An app is a workflow with a named contract. Design the workflow contract schema to be exactly what `AppRuntimeContract` will reference.
- The `agent_swarm` engine handler already exists. Unlocking its UI on main does not conflict with brain-apps — it is a pure workflow primitive. The brain adds context; it does not own the swarm.
- The `data_event` and `workflow_completed` trigger types in `TriggerNodeConfig` are brain-apps territory. Do not surface them in the TriggerForm on main.
- The `brain_lookup` node degrades gracefully already. Do not remove it from the engine or the type system — just do not add a palette entry on main.
- The LLM synthesis tool is already wired via the chat tool catalog. Upgrading `buildWorkflowDraft()` to a real LLM call is safe — the brain will extend it, not replace it.

### Principle 8 — Long-Running Workflows Are a First-Class Design Target

"Workflows that run for months" is not a performance footnote. It is a product category. Meeting this bar requires explicit design at three layers:
1. **State layer**: workflow-scoped persistent KV that survives run boundaries.
2. **Execution layer**: durable phase checkpoints, loop chunking (process N items at a time, not all at once), and run data compaction.
3. **Canvas layer**: phase-based graph organization with collapse/expand so a 200-node monthly pipeline is navigable.

---

## Part III — The Complete Node Taxonomy

This is the authoritative, ground-truth node list. Status reflects the actual codebase, not aspirational descriptions.

### Tier 1 — Control Flow

| Node | Description | LLM? | Engine status | Brain-apps impact |
|------|-------------|-------|---------------|-------------------|
| `trigger` | Entry point — manual, cron, webhook, persistent_listener | No | **Implemented** | Gains `data_event`, `workflow_completed` types |
| `router` | Conditional branching — first_match, all_matching | No (llm_route: Yes) | Implemented; llm_route handler **missing** | No change |
| `merge` | Join multiple branches — all/any/specific | No | **Implemented** | No change |
| `loop` | Iterate over array with concurrency control | No (body may use LLM) | **Not yet built** | No change |
| `parallel` | Fan-out to N structurally independent branches | No | **Not yet built** | No change |
| `wait` | Time-based delay, resume after interval | No | Form exists; palette entry + engine handler **missing** | No change |
| `subflow` | Embed another workflow inline | No | **Implemented** | No change |

### Tier 2 — Data & Logic (zero LLM tokens)

| Node | Description | Cache? | Engine status | Brain-apps impact |
|------|-------------|--------|---------------|-------------------|
| `transform` | JS template expression — map, extract, reshape | Always | **Not yet built** | No change |
| `filter` | Condition gate — pass or route to skip handle | Always | **Not yet built** | No change |
| `integration` | Call built-in connector (Slack/Gmail/GitHub/HTTP/Sheets) | Optional | **Not yet built** (backend in `packages/integrations`) | Gains credential vault integration |
| `http_request` | Raw outbound HTTP with auth templates | Optional | **Not yet built** | No change |
| `workflow_store` | Read/write workflow-scoped persistent KV | No | **Not yet built** | KV entries become Brain-queryable structured facts |
| `scratchpad` | Read/write run-scoped ephemeral state | No | **Implemented** | No change (remains run-scoped) |

### Tier 3 — Intelligence (LLM-powered — use deliberately)

| Node | Description | Cache? | Engine status | Brain-apps impact |
|------|-------------|--------|---------------|-------------------|
| `agent_task` | Dispatch to routed agent with self-heal | Optional | **Implemented** | Brain injects abilities + profile (already wired, degrades gracefully) |
| `skill_task` | Typed deterministic skill (builtin/node_worker/docker) | Yes TTL | **Implemented** | No change |
| `agent_swarm` | Parallel agent fan-out over input array | Optional | Engine complete; **no palette/UI on main** | No change; unlock UI on main |
| `evaluator` | LLM-as-judge — PASS/FAIL/critique routing | No | Service exists; **not wired as node type** | No change |
| `guardrails` | Rule-based policy enforcement | No | **Not yet built** | LLM policy layer added by brain |

### Tier 4 — Knowledge & Enrichment

| Node | Description | Cache? | Engine status | Brain-apps impact |
|------|-------------|--------|---------------|-------------------|
| `knowledge` | Retrieve from workspace knowledge base | Yes TTL | **Implemented** | No change |
| `artifact_collect` | Package generated artifacts into versioned collection | No | Engine complete; **no palette/UI on main** | Artifacts become Brain-indexed knowledge |

### Tier 5 — Human Interaction

| Node | Description | Engine status | Brain-apps impact |
|------|-------------|---------------|-------------------|
| `checkpoint` | Human gate — manual review or auto-approve after timeout | **Implemented** | No change |

### Brain-Coupled Nodes (Main: No Palette Entry)

These nodes have engine handlers or type definitions but require app/brain infrastructure. Do not add palette entries on main. Do not remove from the type system.

| Node | Engine status | Why deferred for main |
|------|--------------|----------------------|
| `data_write` | Engine complete | Requires `appId` — throws without it |
| `data_read` | Engine complete | Requires `appId` — throws without it |
| `brain_lookup` | Engine complete | Requires `collectiveBrain` dep — returns empty array without it; misleading UX |

### Removed or Renamed

- `webhook` palette entry: **REMOVE.** Creates nodes with type `'webhook'` which is not in `WorkflowNodeType` and has no engine handler. The correct approach is (a) `TriggerNodeConfig.triggerType: 'webhook'` for inbound webhooks (already works), and (b) `http_request` node for outbound HTTP calls. The palette `webhook` entry is misleading and creates broken workflows.
- `context_compress` as a user-facing palette node: **Deferred.** Context budget management belongs in the dispatch path (a property on `agent_task`), not as an explicit canvas step. Users should not manage token windows manually.
- `goal_task`: **Deferred.** The evaluator-retry pattern covers what this tried to accomplish structurally.
- `code` (sandboxed JS): **Deferred.** The `transform` node covers 95% of the use case. A full inline editor requires significant UX investment for marginal gain.

---

## Part IV — Engine Implementation Plan

### 4.0 Router llm_route Handler (Quick Fix)

`RouterNodeConfig` already has `routingStrategy: 'llm_route'` with a `prompt` field. The engine handler for `router` silently does nothing (returns without routing) when this strategy is set. Before adding any new node types, add the llm_route case so existing schemas work:

The handler dispatches a single structured completion call with the router prompt plus a list of outgoing edge targets. The model returns the chosen edge ID. If the response cannot be parsed or the edge is not found, the handler falls through to `first_match` behavior and logs a warning. No new types required.

### 4.1 Variable Interpolation Resolver (prerequisite for everything else)

This must ship before any new node types matter. Existing workflows with `{{variable.path}}` in prompts are silently broken — the literal string is sent to the model.

**New file:** `apps/api/src/engine/templateResolver.ts`

```ts
export interface TemplateContext {
  trigger: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;  // keyed by nodeId → output
  scratchpad: Record<string, unknown>;
  store: Record<string, unknown>;   // workflow_store snapshot (empty until Gap 8 ships)
  loop?: { item: unknown; index: number };  // present inside loop body subflows
}

export function resolveTemplate(text: string, ctx: TemplateContext): string;
export function resolveTemplateDeep<T extends Record<string, unknown>>(
  obj: T, ctx: TemplateContext
): T;
```

Resolution rules:
- `{{trigger.fieldName}}` → `ctx.trigger.fieldName`
- `{{nodes.STEP_ID.outputKey}}` → `ctx.nodes.STEP_ID.outputKey`
- `{{scratchpad.key}}` → `ctx.scratchpad.key`
- `{{store.key}}` → `ctx.store.key`
- `{{loop.item}}`, `{{loop.index}}` → active iteration context
- JSONPath deep access: `{{nodes.step1.results[0].title}}`
- Missing paths → empty string + warning in `blockData.templateWarnings`
- No `eval`, no function calls, no side effects — pure string interpolation

The resolver is called in `#dispatchNode()` before every handler, building `TemplateContext` from:
- `ctx.state.completedBlocks` for node outputs
- `ctx.state.triggerPayload` for trigger inputs
- In-memory scratchpad snapshot for the current run

`resolveTemplateDeep()` walks the entire config object recursively — applied to any config field that may contain template expressions (prompts, URL strings, header values, body templates, expression strings, criteria text).

### 4.2 Error Edge Routing

`WorkflowEdge` gains a `type` field:

```ts
export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  condition?: string;
  /** @default 'default' */
  type?: 'default' | 'error' | 'condition';
}
```

In `#failNode()` (currently always terminates the run), add an error-edge check before transitioning to FAILED:

```ts
const errorEdge = ctx.graph.edges.find(
  (e) => e.source === nodeId && e.type === 'error'
);
if (errorEdge) {
  await this.#enqueueNode(ctx, errorEdge.target, {
    error: { message: err.message, nodeId, code: err.code, at: new Date().toISOString() },
    ...item.inputData,
  });
  void this.#tick(ctx);
  return;
}
// No error edge — terminate run as today
await this.#transitionRunStatus(ctx, 'FAILED');
```

Error edges render as dashed red lines on the canvas. Every node that can fail (agent_task, skill_task, integration, http_request, loop, evaluator, guardrails) exposes a dedicated `error` source handle rendered on the bottom-right corner. The existing `AgentisEdge.tsx` respects the `type` prop for styling.

### 4.3 Wait Node Handler

The simplest gap to close. ContextInspector has `WaitForm`. The engine has no handler and the palette has no entry.

```ts
case 'wait': {
  const cfg = node.config as WaitNodeConfig;
  const delayMs = cfg.delayMs ?? 0;
  if (delayMs <= 0) {
    await this.#completeNode(ctx, node.id, item.inputData);
    return;
  }
  ctx.state.activeExecutions[node.id] = {
    taskId: `wait:${node.id}`,
    nodeId: node.id,
    executorType: 'wait',
    executorRef: 'timer',
    startedAt: new Date().toISOString(),
  };
  setTimeout(async () => {
    delete ctx.state.activeExecutions[node.id];
    await this.#completeNode(ctx, node.id, item.inputData);
    void this.#tick(ctx);
  }, delayMs);
  return;
}
```

`WaitNodeConfig`: `{ kind: 'wait'; delayMs: number }`. The form already renders a duration input — it just needs `kind: 'wait'` wired and a palette entry.

**Note:** For waits longer than a few minutes in long-running workflows, the in-memory setTimeout approach is insufficient after a server restart. Phase 5 (Long-Running Infrastructure) upgrades wait to a durable scheduled job via `DurableJobQueue`.

### 4.4 Transform Node

Zero LLM tokens. Maps, reshapes, or extracts data from the run context.

```ts
interface TransformNodeConfig {
  kind: 'transform';
  /** JS expression. Receives `input` bound to the node's inputData. Must return the output object. */
  expression: string;
  outputKey?: string;
}
```

Evaluation: `new Function('input', `"use strict"; return (${cfg.expression})`)(resolvedInput)` wrapped in try/catch. No network, no filesystem, no process. Failures route to error edge. Output cached by `sha256(expression + sha256(inputData))` — deterministic, always cached.

Examples:
- `({ results: input.agent.output.slice(0, 5), count: input.agent.output.length })`
- `(input.leads.map(l => ({ name: l.fullName, domain: l.email.split('@')[1] })))`
- `(input.text.toLowerCase().trim())`

The inspector form is a textarea with monospace font. An optional CodeMirror instance (already a dep in web) provides syntax highlighting.

### 4.5 Filter Node

Condition gate — truthy routes to `pass` handle, falsy routes to `skip` handle.

```ts
interface FilterNodeConfig {
  kind: 'filter';
  /** Boolean JS expression. Receives `input`. */
  condition: string;
  skipLabel?: string;
}
```

Same sandboxed evaluation as transform. Canvas renders two labeled output handles. Used in loops to discard items that don't meet criteria without stopping iteration.

### 4.6 Integration Node

**Highest-impact addition.** `packages/integrations` is fully built. This is purely a wiring task.

```ts
interface IntegrationNodeConfig {
  kind: 'integration';
  integrationId: string;   // slug from ConnectorRegistry manifest
  operationId: string;     // operation ID within the manifest
  inputs: Record<string, string>;   // values support {{variable}} templates
  credentialId?: string;
}
```

Engine handler:
```ts
case 'integration': {
  const cfg = node.config as IntegrationNodeConfig;
  const resolvedInputs = resolveTemplateDeep(cfg.inputs, buildCtx(ctx, item));
  const result = await this.deps.connectors!.execute({
    workspaceId: ctx.workspaceId,
    integrationId: cfg.integrationId,
    operationId: cfg.operationId,
    inputs: resolvedInputs,
    credentialId: cfg.credentialId,
  });
  await this.#completeNode(ctx, node.id, result);
  return;
}
```

`EngineDeps` gains `connectors?: ConnectorRegistry` (optional for backward compat; error thrown at dispatch time if node used without dep).

**Inspector form:**
1. Integration selector — dropdown from `ConnectorRegistry.list()`
2. Operation selector — from selected integration's manifest
3. Dynamic input fields — generated from operation `inputSchema`; each field supports variable picker
4. Credential selector — from `GET /v1/credentials?integrationId=X`

### 4.7 HTTP Request Node

Raw fallback for integrations without a named connector.

```ts
interface HttpRequestNodeConfig {
  kind: 'http_request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;                          // supports {{variable}} templates
  headers?: Record<string, string>;     // values support templates
  body?: string;                        // JSON string, supports templates
  auth?: {
    type: 'bearer' | 'api_key' | 'basic' | 'none';
    token?: string;
    header?: string;       // for api_key: header name
    username?: string;
    password?: string;
  };
  responseMapping?: {
    bodyPath?: string;     // JSONPath into response body
    outputKey: string;
  };
  retryOn?: number[];      // HTTP status codes to retry (e.g. [429, 503])
  timeoutMs?: number;
}
```

Uses the `packages/integrations/src/connectors/http.ts` connector internally — no duplication.

**Security:** The engine validates that URLs begin with `https://` unless the workspace has `allowInsecureHttp` enabled. Template-injected values are URL-encoded in the URL position. Request/response bodies are never logged in full — only size and status code are persisted in `blockData`.

### 4.8 Workflow Store Node (Gap 8 — Persistent Cross-Run State)

This is the foundation for long-running automations. A workflow that runs daily for a month needs to accumulate context. `scratchpad` is run-scoped and disposed on completion. `workflow_store` is workflow-scoped and persists indefinitely.

**Schema (new table):**
```sql
CREATE TABLE workflow_kv_entries (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       BLOB NOT NULL,       -- JSON-encoded
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(workflow_id, key)
);
CREATE INDEX wf_kv_lookup ON workflow_kv_entries(workflow_id, key);
```

**Node config:**
```ts
interface WorkflowStoreNodeConfig {
  kind: 'workflow_store';
  operations: Array<{
    op: 'get' | 'set' | 'delete' | 'increment' | 'append' | 'get_all';
    key?: string;          // supports {{variable}} templates
    value?: string;        // supports {{variable}} templates; required for set/append
    outputKey?: string;    // key under which to store the result in node output
    incrementBy?: number;  // for increment op, default 1
  }>;
}
```

**Why this table, not `scratchpad`:** The distinction is fundamental. `scratchpad` is the run's working memory — context passed between nodes in a single execution. `workflow_kv_entries` is the workflow's long-term memory — state that accumulates across many runs. In brain-apps: `workflow_kv_entries` rows become atoms in the workspace's knowledge graph. The schema is designed to support that future: `workspace_id` is present for Brain indexing, and `value` is JSON for structured querying.

### 4.9 Evaluator Node (Gap 3 — Reliability Primitive)

`EvaluatorRuntime` already exists as a fully implemented service. The only task is wiring it as a node type.

```ts
interface EvaluatorNodeConfig {
  kind: 'evaluator';
  targetPath: string;      // variable picker path into input data (e.g. "nodes.step1.output.text")
  criteria: string;        // natural-language acceptance criteria
  passThreshold?: number;  // 0–10, default 7
  maxRetries?: number;     // max times the FAIL edge can cycle back, default 3
  rubric?: Array<{ dimension: string; weight: number }>;
}
```

Engine handler dispatches through `EvaluatorRuntime.evaluate()` (already written) using the workspace's fast-tier model. Output:

```ts
{
  score: number;            // 0–10
  passed: boolean;
  critique: string;         // available as {{nodes.EVAL_ID.critique}} in retry prompts
  dimensionScores?: Array<{ dimension: string; score: number }>;
  iterationCount: number;   // how many eval-retry cycles have occurred
}
```

**Eval-retry pattern:** FAIL output handle routes back to the upstream `agent_task`. The evaluator injects `iterationCount` into the run context. At `maxRetries` exceeded, route to the error edge instead. This creates a finite retry cycle — not an infinite loop — with structural guarantees.

**The inspector form shows:** target path (variable picker), criteria textarea, pass threshold slider (0–10), max retries input, optional rubric dimension builder.

### 4.10 Guardrails Node

Deterministic policy enforcement — no LLM calls.

```ts
interface GuardrailsNodeConfig {
  kind: 'guardrails';
  rules: Array<{
    type: 'not_empty' | 'min_length' | 'max_length' | 'contains' | 'not_contains' | 'regex' | 'json_schema';
    target: string;        // dot-notation or JSONPath into input data
    value?: string;        // match string / regex / JSON Schema string
    limit?: number;        // for length checks
    message?: string;      // human-readable violation message
  }>;
  onViolation: 'block' | 'flag';
  // 'block': route to error edge with violation details.
  // 'flag': add { guardrailViolations: [...] } to output and continue.
}
```

`json_schema` rule type validates the target value against a JSON Schema string — this is the bridge to typed workflow contracts: a guardrails node can enforce that an agent's output conforms to a declared schema before passing it downstream.

### 4.11 Loop Node

Array iteration with concurrency control.

```ts
interface LoopNodeConfig {
  kind: 'loop';
  itemsExpression: string;    // {{variable}} path resolving to array
  itemKey: string;            // binding name, e.g. "item" → {{loop.item}}
  indexKey?: string;          // e.g. "index" → {{loop.index}}
  maxConcurrency: number;     // 1 = sequential; >1 = parallel up to this many
  bodyWorkflowId: string;     // subflow executed once per item
  onIterationError: 'stop_all' | 'continue' | 'collect_errors';
  outputArrayKey: string;     // collects all iteration outputs
  chunkSize?: number;         // for large arrays: process this many at a time (default: all)
}
```

**Engine implementation:** Resolves items array via `resolveTemplate()`. Injects `{ loop: { item, index } }` into each subflow's trigger payload. Uses `SubflowExecutor` (already exists) for each item. Tracks `inflightDispatches` for concurrency control. Emits `LOOP_PROGRESS` event per completed iteration.

**`chunkSize` is critical for long-running workflows.** A loop over 10,000 items with `chunkSize: 100` spawns 100 subflows at a time, waits for their completion, then spawns the next 100. This prevents overwhelming the concurrency queue and keeps the run state manageable.

### 4.12 Parallel Fork Node

Structural fan-out to N distinct branches executing simultaneously.

```ts
interface ParallelNodeConfig {
  kind: 'parallel';
  waitFor: 'all' | 'first';
  onBranchError: 'fail_all' | 'continue_with_results';
  mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
}
```

The node's outgoing edges define the branches. A `merge` node downstream collects results. Engine fans out by enqueueing all downstream nodes simultaneously, using `inflightDispatches` for settle tracking.

### 4.13 Workflow Input/Output Contracts (Gap 10)

`WorkflowGraph` gains contract fields:

```ts
interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
  inputContract?: WorkflowContract;
  outputContract?: WorkflowContract;
  phases?: WorkflowPhase[];   // see Part VI
}

interface WorkflowContract {
  fields: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
    required?: boolean;
    description?: string;
    schema?: string;  // JSON Schema string for 'object' and 'array' types
  }>;
}
```

**Engine validation at run start (`startRun()`):** Validate trigger payload against `inputContract`. Emit `CONTRACT_VIOLATION` event and fail the run if a required field is missing or has the wrong type.

**Engine validation at run completion:** Validate the last completed node's output against `outputContract`. If validation fails: complete the run with `status: 'COMPLETED_WITH_CONTRACT_VIOLATION'` (new terminal status) — the workflow ran to completion, but the output doesn't match what was promised. Distinct from `FAILED`.

**SubflowExecutor contract check:** Before starting a subflow, compare the caller's passed inputs against the callee workflow's `inputContract`. Type mismatch → fail at dispatch time, not at run time.

**Brain-apps forward compatibility:** `WorkflowContract.fields` is intentionally the same shape as `AppRuntimeContract.outputs.fields`. An app's "what this produces" IS its root workflow's outputContract. Design the canvas "Contract" panel to be the same component as the app's "Interface" panel — same data structure, same validation logic.

**validateGraph.ts upgrade:** Beyond structural checks, add per-kind semantic validation. `agent_task` without `agentId` is a warning (not a hard error — agentId can be assigned later). `skill_task` without `skillId` is an error. `integration` without `integrationId` is an error. `loop` without `bodyWorkflowId` is an error. Semantic validation runs at save time, not just at run start.

### 4.14 LLM Workflow Synthesis (Gap 9)

Replace the regex implementation in `buildWorkflowDraft()` with a real structured-output LLM call. The function signature stays the same — only the internals change.

**New flow:**
1. Build a system prompt that explains the `WorkflowGraph` JSON schema (from `WorkflowNodeType` union and config interfaces) and includes 3 canonical examples (trigger→agent→checkpoint, trigger→integration→loop→agent, trigger→agent→evaluator→checkpoint).
2. Dispatch a single structured-output completion call with `response_format: { type: 'json_object' }` and the user's description as the user message.
3. Parse and run `validateWorkflowGraph()`.
4. On validation failure, re-dispatch with the validation error appended to the message. Maximum 3 attempts.
5. On success, return the validated `WorkflowGraph` — same return type as before.

This is the LLM-applied-to-workflow-building moment: the agent uses the exact same `validateWorkflowGraph()` contract as a human would, and the retry loop is structurally the same as the evaluator-retry loop users build in their own workflows. The system eats its own cooking.

**Forward compatibility:** The synthesis tool becomes the "agent that builds apps" in brain-apps. When apps arrive, the synthesis prompt gains knowledge of `data_write`/`data_read` and `brain_lookup` node types. No structural change.

---
  expression: string;
  /** Human-readable label shown on canvas edge leaving this node. */
  outputKey?: string;
}
```

The expression runs inside a sandboxed `Function` constructor with `input` bound to `item.inputData`. For safety: `new Function('input', `"use strict"; return (${cfg.expression})`)(inputData)` — wrapped in try/catch, no network access, no filesystem, no process. Failures route to the error edge. Output is cached by input hash (always).

Example: `({ results: input.agent.output.slice(0, 5), count: input.agent.output.length })`

The inspector form is a textarea with monospace font. Syntax highlighting via a minimal CodeMirror or Prism instance is nice-to-have but not blocking.

### 4.5 Filter Node

Condition gate. If expression is truthy, passes input data to the `pass` output handle. If falsy, routes to `skip`.

```ts
interface FilterNodeConfig {
  kind: 'filter';
  /** Boolean JS expression. Receives `input`. */
  condition: string;
  skipLabel?: string;   // label shown on the skip edge
}
```

Evaluation: same sandboxed `Function` pattern as transform, returning boolean. The canvas renders two output handles labeled `pass` and `skip`.

### 4.6 Integration Node

**This is the highest-impact addition in this plan.** The `packages/integrations` ConnectorRegistry already has working Slack, Gmail, GitHub, Google Sheets, and HTTP connectors. The only missing piece is an engine case that dispatches through it.

```ts
interface IntegrationNodeConfig {
  kind: 'integration';
  /** Integration slug from the ConnectorRegistry manifest. */
  integrationId: string;
  /** Operation ID within the integration manifest. */
  operationId: string;
  /** Resolved inputs — values may contain {{variable}} templates. */
  inputs: Record<string, string>;
  /** Credential ID from the workspace credential store. */
  credentialId?: string;
}
```

Engine handler:
```ts
case 'integration': {
  const cfg = node.config as IntegrationNodeConfig;
  const inputs = resolveTemplates(cfg.inputs, buildTemplateContext(ctx, item.inputData));
  const result = await this.deps.connectors.execute({
    workspaceId: ctx.workspaceId,
    integrationId: cfg.integrationId,
    operationId: cfg.operationId,
    inputs,
    credentialId: cfg.credentialId,
  });
  await this.#completeNode(ctx, node.id, result);
  return;
}
```

`EngineDeps` gains: `connectors?: ConnectorRegistry` (optional for backward compat).

The inspector form for the integration node:
1. Integration selector (dropdown populated from `ConnectorRegistry.list()`)
2. Operation selector (populated from the selected integration's manifest)
3. Dynamic input fields generated from the operation's `inputSchema`
4. Credential selector (dropdown from `/v1/credentials?integrationId=X`)

### 4.7 HTTP Request Node

The raw fallback when no named integration connector exists. Supports full auth, templating, and response parsing.

```ts
interface HttpRequestNodeConfig {
  kind: 'http_request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;              // supports {{variable}} templates
  headers?: Record<string, string>;   // values support templates
  body?: string;            // JSON string, supports templates
  auth?: {
    type: 'bearer' | 'api_key' | 'basic';
    token?: string;         // supports {{variable}} (e.g. from scratchpad)
    header?: string;        // for api_key: header name
    username?: string;
    password?: string;
  };
  responseMapping?: {
    bodyPath?: string;      // JSONPath into response body to extract
    outputKey: string;      // key to store the result under
  };
  retryOn?: number[];       // HTTP status codes to retry on (e.g. [429, 503])
  timeoutMs?: number;
}
```

Engine handler calls the existing `packages/integrations/src/connectors/http.ts` connector under the hood. No duplication — the http_request node is a low-level shell around the same HTTP infrastructure.

### 4.8 Evaluator Node

The reliability primitive. Dispatches a single structured LLM call to assess whether agent output meets specified criteria.

```ts
interface EvaluatorNodeConfig {
  kind: 'evaluator';
  /** JSONPath into the input data to find what should be evaluated. */
  targetPath: string;
  /** Natural-language acceptance criteria. */
  criteria: string;
  /** Minimum score to pass (0–10). Default 7. */
  passThreshold?: number;
  /** Optional rubric dimensions for multi-axis scoring. */
  rubric?: Array<{ dimension: string; weight: number }>;
}
```

**Output:**
```ts
{
  score: number;      // 0–10
  passed: boolean;
  critique: string;   // structured feedback; injected into retry prompt via {{node.evaluatorId.critique}}
  dimensionScores?: Array<{ dimension: string; score: number }>;
}
```

**Engine implementation:**
The evaluator dispatches a direct completion call (not through the agent adapter — no task overhead). It uses the workspace's configured fast-tier model. The structured prompt is:

```
You are a quality evaluator. Score the following output against these criteria.

CRITERIA: {{criteria}}
OUTPUT TO EVALUATE: {{targetValue}}
{{rubric section if present}}

Respond with valid JSON: { "score": number (0-10), "passed": boolean, "critique": string }
```

The completion response is parsed and validated. If JSON parse fails, the evaluator scores 0 and fails with "Evaluator response was not valid JSON."

**Routing:** Two output handles — `pass` and `fail`. The `fail` handle routes back to the upstream agent_task with the critique injected into the context as `{{node.EVALUATOR_ID.output.critique}}`. The eval-retry cycle terminates after 3 loops by default (configurable via `maxRetries` on the evaluator node).

**The inspector form shows:** target path (variable picker), criteria textarea, pass threshold slider (0-10), optional rubric dimension builder.

### 4.9 Guardrails Node

Policy enforcement before a node's output is committed. Rule-based only (LLM pass is deferred — rule checks are deterministic and fast; LLM policy adds latency and cost without proportional benefit for most workflows).

```ts
interface GuardrailsNodeConfig {
  kind: 'guardrails';
  rules: Array<{
    type: 'not_empty' | 'min_length' | 'max_length' | 'contains' | 'not_contains' | 'regex';
    target: string;   // dot-notation path into input data
    value?: string;   // match string / regex pattern
    limit?: number;   // for length checks
    message?: string; // human-readable violation message
  }>;
  onViolation: 'block' | 'flag';
  // 'block': route to error edge. 'flag': add metadata and continue.
}
```

### 4.10 Loop Node

Array iteration with optional concurrency.

```ts
interface LoopNodeConfig {
  kind: 'loop';
  /** Template expression resolving to the array to iterate. */
  itemsExpression: string;   // e.g. "{{trigger.leads}}" or "{{step1.results}}"
  /** Variable name for the current item in child node prompts/expressions. */
  itemKey: string;           // e.g. "item" → accessible as {{loop.item}}
  indexKey?: string;         // e.g. "index" → accessible as {{loop.index}}
  /** 1 = sequential, >1 = parallel up to this many concurrent. */
  maxConcurrency: number;
  /** The subflow that executes once per item. */
  bodyWorkflowId: string;
  /** What to do if a single iteration fails. */
  onIterationError: 'stop_all' | 'continue' | 'collect_errors';
  /** Key under which to collect all iteration outputs. */
  outputArrayKey: string;
}
```

**Engine implementation:** Resolves the items array using the template resolver. Creates child runs via SubflowExecutor for each item (reusing existing subflow infra). Tracks completion with `inflightDispatches` (already in RunningContext). Emits `LOOP_PROGRESS` events per iteration. Merges outputs into `outputArrayKey` on completion.

### 4.11 Parallel Fork Node

Structural fan-out to N branches that execute simultaneously. Different from `agent_swarm` (which fans out the same task over an array — engine handler exists but has no UI yet) — this fans out to different structurally distinct node chains.

```ts
interface ParallelNodeConfig {
  kind: 'parallel';
  waitFor: 'all' | 'first';
  onBranchError: 'fail_all' | 'continue_with_results';
  mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
}
```

The node's outgoing edges define the branches. Each edge is a branch. The `merge` node downstream collects results. Engine fans out by enqueueing all downstream nodes simultaneously, using `inflightDispatches` for settle tracking.

---

## Part V — Canvas and UX Architecture

### 5.0 Palette Naming Audit and Broken Entry Fix

The `webhook` palette entry creates nodes with type `'webhook'` which is not in `WorkflowNodeType` and has no engine handler. This creates broken workflows silently. **Remove this entry first.**

Fix the remaining label confusion:

| Current palette label | Actual kind | Fix |
|----------------------|-------------|-----|
| `Agent task` | `agent_task` | Rename to **Agent** |
| `Skill` | `skill_task` | Keep as **Skill** |
| `Approval` | `checkpoint` | Rename to **Checkpoint** |
| `Branch` | `router` | Rename to **Router** |
| `Webhook` | `'webhook'` (broken) | **Remove** — inbound webhooks are a `trigger` type; outbound becomes `HTTP Request` node |
| `Subflow` | `subflow` | Keep as **Subflow** |

New palette entries to add:

| New label | Kind | Tier |
|-----------|------|------|
| Wait | `wait` | Control Flow |
| Loop | `loop` | Control Flow |
| Parallel | `parallel` | Control Flow |
| Transform | `transform` | Data & Logic |
| Filter | `filter` | Data & Logic |
| Integration | `integration` | Data & Logic |
| HTTP Request | `http_request` | Data & Logic |
| Workflow Store | `workflow_store` | Data & Logic |
| Evaluator | `evaluator` | Intelligence |
| Guardrails | `guardrails` | Intelligence |
| Agent Swarm | `agent_swarm` | Intelligence |
| Artifact Collect | `artifact_collect` | Knowledge |

The palette component renders nodes grouped by tier with a section header. Tiers are collapsible.

### 5.1 Variable Picker

**This is the most important UX change in this plan.** Without it, the variable interpolation resolver in the engine is invisible — users cannot discover what paths are available without reading the run output JSON manually.

A `VariablePicker` component appears as a combobox portal triggered by typing `{{` in any template-capable text field. It traverses the current graph topology, finds all nodes upstream of the selected node in topological order, and surfaces their output keys as selectable options with their source node label.

```
{{                                  <- typing this opens picker
  trigger.inputText                 <- trigger node (manual input field)
  trigger.metadata.source
  research-agent.output.summary     <- upstream agent_task (node title shown)
  research-agent.output.sources
  research-agent.output.confidence
  scratchpad.leadStatus             <- from scratchpad read operations
  store.lastRunAt                   <- from workflow_store reads
}}
```

The picker only shows reachable predecessors (not all nodes — no forward references). Selecting an item inserts the full path rendered as a highlighted pill. Unknown deep paths can be typed manually after the auto-completed prefix.

Component: `apps/web/src/components/canvas/VariablePicker.tsx`  
Used in: `AgentTaskForm`, `TransformForm`, `FilterForm`, `HttpRequestForm`, `IntegrationForm`, `EvaluatorForm`, `GuardrailsForm`, `LoopForm`, `WorkflowStoreForm`

### 5.2 Per-Node Test Runner

The single highest-leverage debugging feature. Currently, testing any node requires running the entire workflow.

A **Test** tab in the ContextInspector allows running a single node in isolation:
1. JSON editor pre-populated with the node's declared `inputContract` (if available) or the last run's actual inputData for this node
2. "Run node" button
3. Output panel shows raw JSON + readable summary + timing

Backend: `POST /v1/workflows/:id/nodes/:nodeId/test` accepts `{ inputs: Record<string, unknown> }` and dispatches the node's handler directly against a throwaway run context. Returns output or error without touching persisted run state.

- Deterministic nodes (transform, filter, guardrails): evaluates inline, returns in <100ms
- Agent tasks: creates a real agent dispatch with the provided inputs
- Integration/HTTP: makes the real external call — test uses real credentials
- Evaluator: runs a real LLM eval call

### 5.3 Live Canvas Run Overlay

Extend `AgentFocusOverlayManager` to all node types. `NODE_STARTED`, `NODE_COMPLETED`, `NODE_FAILED`, `NODE_RETRY_SCHEDULED`, and `NODE_CACHE_HIT` events already fire on the run room. The canvas needs to consume them universally.

Per-node visual states during an active run:
- **Queued:** faint border pulse (waiting in readyQueue)
- **Running:** pulsing ring + spinner in node glyph
- **Completed:** green checkmark badge top-right + subtle green wash
- **Failed:** red X badge + red left border + tooltip with error message on hover
- **Retry:** animated dashed border + counter badge (`2/3 retries`)
- **Cache hit:** lightning bolt indicator (CanvasMotionLayer already handles this)
- **Waiting for approval:** pulsing amber border + "Pending review" label
- **Loop in progress:** progress bar under node (`47 / 200 items`)

Edge animations: when a node completes and its successor starts, the connecting edge briefly animates a dot traveling along the path. Duration: 600ms. This gives spatial orientation — users can see which branch is executing without reading node labels.

### 5.4 Edge Condition Labels

Branch edges carry `edge.condition`. Render inline on the path:
- Short label centered on the edge path (truncated to ~40 chars with ellipsis tooltip)
- **Green** for `pass` / `true` / `success` paths
- **Red** for `fail` / `false` / `error` paths
- **Dashed red** for error edges (`edge.type === 'error'`)
- **Gray** for default/catch-all edges

`AgentisEdge.tsx` supports double-click label editing — condition labels use the same render path. Add `type` as a read-only visual discriminant.

### 5.5 Cmd+K Node Command Palette

`NodeCommandPalette.tsx`: modal on Cmd+K (or Ctrl+K) with canvas focus.

Searches unified:
- Node types by name + description
- Installed skills by name + description  
- Reusable subflow workflows by title
- Integration connectors: `"Slack — Send message"`, `"GitHub — Create issue"`, `"Gmail — Send email"`

When a node type is selected: placed at cursor position or auto-connected to the currently selected node. When an integration is selected: creates an `integration` node pre-populated with `integrationId` and `operationId`.

### 5.6 Scheduler UI (Gap 6 — backend 100% complete, UI zero)

No backend work required. This is entirely a frontend gap.

**TriggerForm cron tab** (when `triggerType === 'cron'`):
- Cron expression input with inline human-readable description (e.g., "Every day at 9:00 AM")
- "Next 5 runs" preview (computed client-side using a cron parser library)
- Active/paused toggle → `PATCH /v1/triggers/:id { active: boolean }`
- Timezone selector

**Event chain tab** (when `triggerType === 'workflow_completed'`):
> Note: `workflow_completed` trigger type exists in `TriggerNodeConfig`. Surface this on main. It does NOT require the brain — it is purely a workflow-to-workflow event chain. Only `data_event` (which reads from app tables) should remain hidden on main.

- Source workflow selector (GET /v1/workflows — already exists)
- Source status: completed / failed / any
- Input mapping: map the source workflow's last completed node's output to this workflow's trigger inputs

**Workflows page — Automation tab:** Static list showing all scheduled and event-chain triggered workflows with their next run time or trigger source.

### 5.7 Inspector Forms for All New Nodes

| Node | Form fields |
|------|-------------|
| `integration` | Integration selector → operation selector → dynamic fields from manifest (each supports variable picker) → credential selector |
| `http_request` | Method selector, URL (variable picker + syntax hint), auth type + credential, headers list, body template, response path, retry codes, timeout |
| `transform` | Expression textarea (monospace, CodeMirror if available), variable picker panel showing available `input.*` keys |
| `filter` | Condition expression (monospace), pass/skip edge label customization |
| `workflow_store` | Operations list builder — each operation has op type, key (variable picker + literal), value (variable picker), output key |
| `wait` | Duration input with unit selector (ms / s / m / h / d) |
| `loop` | Items expression (variable picker), item key name, concurrency slider (1–10+), chunk size, error policy selector, output key |
| `parallel` | Wait-for policy, branch error policy, merge strategy |
| `evaluator` | Target path (variable picker), criteria textarea, pass threshold (0–10 slider), max retries, rubric dimension builder |
| `guardrails` | Rule builder (+ button to add rules, each with type dropdown → appropriate input fields), violation action |
| `agent_swarm` | Input array expression (variable picker), merge strategy (collect_all/majority_vote/first_success), max concurrency |
| `artifact_collect` | Sources (list of node IDs to collect from), artifact type selector, approval gate toggle |

### 5.8 Graph Revision History (Gap 11 — partially)

`workflowGraphStore.ts` has full version history built. The only missing piece is API exposure and canvas UI.

**API:** `GET /v1/workflows/:id/revisions` — returns list of `{ revisionNumber, hash, reason, createdAt, nodeCount, edgeCount }`. No new service code required — `listGraphRevisions()` is already written. Just add the route.

**Canvas panel:** A "History" button in the canvas toolbar opens a slide-over panel with the revision list. Each revision shows: timestamp, reason, node/edge count delta. Clicking any revision loads the graph in read-only mode with a "Restore this version" button.

**Canvas auto-save as revision:** Each time the user saves the canvas (manually or after 5 seconds of inactivity), `replaceGraph()` is called with `reason: 'auto-save'`. Named saves (from the revision panel) set a user-provided reason string.

This effectively gives the canvas an undo/redo history that survives page reloads.

### 5.9 Workflow Deployment Surface (Gap 11 — partially)

`workflowDeployments.ts` has a complete deployment system. Surface it.

**Canvas toolbar:** "Deploy" button opens a modal:
1. Shows current deployment status (draft / deployed at version X)
2. "Publish as API endpoint" toggle
3. On publish: shows the generated endpoint URL (`/v1/deploy/:token/run`) with a copy button
4. Sync vs. Async mode selector
5. Shows last N runs triggered via deployment

**Deployment API:** Expose `GET /v1/workflows/:id/deployments` (list) and `POST /v1/workflows/:id/deployments` (create/update). These routes call the existing `workflowDeployments.ts` service.

### 5.10 Long-Running Workflow Canvas Organization (Gap 13)

For workflows with 50+ nodes (monthly pipelines, multi-stage research workflows), the canvas becomes unnavigable without structure.

**Phases** are named groups of nodes defined in `WorkflowGraph.phases`:

```ts
interface WorkflowPhase {
  id: string;
  name: string;
  color: string;        // hex color for visual grouping
  nodeIds: string[];    // node IDs that belong to this phase
  collapsed: boolean;   // UI state — stored in graph
}
```

When a phase is collapsed, the canvas renders it as a single composite node showing the phase name, color, and entry/exit connector points. The underlying nodes remain in the graph — collapse is purely visual. Edges that cross phase boundaries become "tunneled" edges that route through the phase boundary.

Phase assignment is done by Shift+clicking multiple nodes → right-click → "Group as phase." Phase headers are rendered as lightweight background regions (not nodes) using react-flow's `Background` custom layer.

---

## Part VI — Long-Running Workflow Architecture

This section addresses Gap 13: building workflows that run for weeks or months, contain hundreds of nodes, and accumulate meaningful state over time.

### 6.1 What Makes a Workflow "Long-Running"

A workflow crosses into long-running territory when any of these are true:
- A single run takes longer than 24 hours
- The workflow runs recurrently and needs to remember state from previous runs
- The workflow iterates over arrays larger than 1,000 items
- The canvas graph has more than 50 nodes

Each condition requires a specific architectural solution. They are independent.

### 6.2 Cross-Run State (workflow_kv_entries)

The `workflow_store` node (§4.8) is the primary solution. A monthly newsletter workflow can accumulate subscriber preferences, previously sent content IDs, and engagement metrics across 30+ runs without any external infrastructure.

The `workflow_kv_entries` schema supports versioned updates with `version INT` — enabling optimistic concurrency for workflows that might run in parallel and write to the same key. On version conflict: the engine retries the read-modify-write cycle up to 3 times, then routes to the error edge.

**Key access patterns:**
- `GET workflow_id, key` → latest value (fast path via index)
- `GET workflow_id` (all) → full KV snapshot for template context injection
- `SET key, value, IF version = N` → optimistic write
- `INCREMENT key` → atomic counter without read-modify-write race

For the `TemplateContext` (§4.1), the engine loads the full workflow KV snapshot once at run start and injects it as `ctx.store`. Writes during the run are reflected immediately in the current run's store snapshot.

### 6.3 Durable Wait (Long-Delay Resume)

The `wait` handler in §4.3 uses `setTimeout` — this is correct for delays under 30 minutes. For longer delays (e.g., "wait 7 days for user response before sending a reminder"), `setTimeout` is lost on server restart.

For waits > 30 minutes, the engine should persist the deferred resume using `DurableJobQueue`:

```ts
case 'wait': {
  if (delayMs <= 30 * 60 * 1000) {
    // Fast path — in-memory timer
    setTimeout(() => { ... }, delayMs);
  } else {
    // Durable path — survives restarts
    await this.deps.jobQueue.enqueue({
      type: 'workflow_run_resume',
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      nodeId: node.id,
      scheduledAt: new Date(Date.now() + delayMs).toISOString(),
    });
    // The watchdog will drain this job and call resumeNode() when due
  }
}
```

`DurableJobQueue` already uses SQLite with `scheduledAt` support. No new infrastructure required.

### 6.4 Loop Chunking (Large Array Iteration)

For a loop over 10,000 items with `maxConcurrency: 5`, the naive implementation would enqueue 10,000 subflow contexts simultaneously. This is catastrophic for memory and the concurrency queue.

The `chunkSize` field on `LoopNodeConfig` (§4.11) controls this. When set, the engine:
1. Resolves the items array
2. Takes the first `chunkSize` items as the current chunk
3. Spawns subflows for the current chunk (up to `maxConcurrency` at a time)
4. When the chunk completes, emits `LOOP_PROGRESS` and stores the current index in a `workflow_kv_entries` row (for crash recovery)
5. Takes the next chunk and repeats

If the server restarts mid-loop, the watchdog finds the interrupted run, reads the `workflow_kv_entries` row for the loop's progress index, and resumes from the last completed chunk.

**Recommended defaults:** `chunkSize: 100` for most use cases. For very fast operations (transform, filter): `chunkSize: 500`. For slow operations (agent_task with long timeouts): `chunkSize: 10`.

### 6.5 Run Data Compaction

The `workflow_runs` table accumulates `blockData` JSON indefinitely. A 100-node workflow running daily produces substantial storage over 30 days.

**Compaction policy** (new service: `runCompactionService.ts`):
- After 30 days: replace per-node `blockData` with a summary-only record `{ nodeId, kind, status, durationMs, inputSize, outputSize }`. Remove the full input/output JSON.
- After 90 days: move the run row to an `archived_workflow_runs` table (same schema but read-only). The active `workflow_runs` table stays lean.
- Compaction runs as a low-priority job via `DurableJobQueue` during off-hours.

Archived runs are still accessible via the run history panel — the API checks both tables. The canvas RunDrawer distinguishes archived runs with a subtle "archived" badge.

### 6.6 Phase-Level Progress Events

Long-running workflows benefit from phase-level visibility beyond node-level events. When a `WorkflowPhase` completes (all nodes in the phase are in a terminal state), the engine emits:

```ts
PHASE_COMPLETED = 'phase_completed'
PHASE_FAILED    = 'phase_failed'
```

These events are projected into the run's `phaseState` — a lightweight map of phase IDs to statuses. The WorkflowsPage list view can show a workflow that's been running for 3 days as "Phase 2 of 4: Data enrichment — in progress (Day 2)."

### 6.7 Workflow Composition for Large Graphs

For very large workflows (100+ nodes), the right answer is often composition, not a single giant graph. The `subflow` node is exactly this mechanism — but it requires users to manually create and reference child workflows.

**Sub-workflow suggestion:** When a user tries to create a loop with a body containing more than 20 nodes, the canvas offers to extract the loop body into a separate named workflow and automatically replaces it with a `subflow` node. This is a canvas affordance, not an engine constraint.

---

## Part VII — Implementation Sequencing

Ordered strictly by user-visible impact and dependency order. Each phase is independently deployable.

### Phase 1 — Foundation (ship as single batch)

These items are deeply coupled. None produce user-visible UI on their own, but every later phase depends on them.

1. **Variable interpolation resolver** — `templateResolver.ts`. Apply before every node dispatch. Fixes all currently broken `{{variable}}` prompts.
2. **Wait node handler** — ~20 lines in `#dispatchNode()`. Palette entry in `NodePalette.tsx`.
3. **Error edge routing** — `type: 'default' | 'error' | 'condition'` on `WorkflowEdge`. Error-edge check in `#failNode()`.
4. **Transform node** — type + Zod + engine case + `TransformForm` + palette entry.
5. **Filter node** — same pattern as transform, two output handles.
6. **Router llm_route handler** — missing case in the existing `router` switch.
7. **Remove `webhook` palette entry** — cosmetic, prevents broken workflows.
8. **Rename palette entries** — Agent, Skill, Checkpoint, Router, Subflow.

**Validation:** `pnpm --filter @agentis/api test` clean. Unit tests for `resolveTemplate` (nested paths, array access, missing keys, loop context). Engine integration tests: wait fires after delay; error edge routes on failure; transform maps; filter gates.

### Phase 2 — Integration & HTTP (highest real-world impact)

9. **Integration node** — wire `ConnectorRegistry` into `EngineDeps`. `case 'integration'` in engine. Dynamic inspector form from manifest.
10. **HTTP request node** — engine case + `HttpRequestForm` + palette entry.
11. **Variable picker** — `VariablePicker.tsx` wired into all form fields that accept templates.

**Validation:** E2E test — trigger → agent_task (generates summary) → integration (Slack: `{{agent.output.summary}}`). Assert Slack mock received substituted text. HTTP test: trigger → http_request → transform (extract from response) → agent_task (uses `{{transform.result}}`).

### Phase 3 — Reliability

12. **Evaluator node** — wire `EvaluatorRuntime` as engine node type. PASS/FAIL routing. Critique output as `{{nodes.EVAL_ID.critique}}`.
13. **Evaluator-retry cycle** — FAIL edge back to agent_task with critique injection. `maxRetries` cycle limit.
14. **Guardrails node** — rule evaluation engine case + `GuardrailsForm`.
15. **Loop node** — SubflowExecutor + `inflightDispatches` + `LOOP_PROGRESS` events + `chunkSize` support.

**Validation:** Quality-gate workflow: agent_task → evaluator. Short output → FAIL → retry with critique → PASS. Loop over 200-item array with `chunkSize: 50`, assert 4 `LOOP_PROGRESS` events and correct output array.

### Phase 4 — Authoring Velocity

16. **Workflow Store node** — `workflow_kv_entries` migration + `WorkflowStoreService` + engine case + `WorkflowStoreForm`.
17. **Per-node test runner** — `POST /:id/nodes/:nodeId/test` API + **Test** tab in `ContextInspector`.
18. **Live canvas run overlay** — extend to all node types. Edge dot animations.
19. **Edge condition labels** — inline rendering in `AgentisEdge.tsx`.
20. **Workflow Contracts** — `inputContract`/`outputContract` on `WorkflowGraph` + validation in `startRun()` + `SubflowExecutor` contract check + semantic validation in `validateGraph.ts`.
21. **Cmd+K command palette** — `NodeCommandPalette.tsx`.

### Phase 5 — Automation Substrate

22. **Scheduler UI** — cron picker, next-runs preview, active/paused toggle in `TriggerForm`.
23. **Event chain UI** — `workflow_completed` trigger type in `TriggerForm`. Source workflow selector + input mapping.
24. **`agent_swarm` UI** — palette entry + `AgentSwarmForm`. Engine handler already exists.
25. **`artifact_collect` UI** — palette entry + `ArtifactCollectForm`. Engine handler already exists.
26. **Parallel fork node** — engine case + `ParallelForm` + palette entry.
27. **LLM workflow synthesis** — replace regex in `buildWorkflowDraft()` with structured-output LLM call + `validateWorkflowGraph()` retry loop.

### Phase 6 — Surface Hidden Power

28. **Graph revision history** — `GET /v1/workflows/:id/revisions` route + revision history slide-over panel in canvas.
29. **Workflow deployment surface** — `GET/POST /v1/workflows/:id/deployments` routes + "Deploy" button in canvas toolbar + endpoint URL display.
30. **Phase-based canvas organization** — `WorkflowPhase` in graph schema + phase grouping affordance + collapse/expand.
31. **Workflow cost compiler surface** — show `GraphCostShape` pre-run estimate in the run modal.

### Phase 7 — Long-Running Infrastructure

32. **Durable wait** — upgrade `wait` handler to use `DurableJobQueue` for delays > 30 minutes.
33. **Loop crash recovery** — persist loop progress index to `workflow_kv_entries` for watchdog resume.
34. **Run data compaction** — `runCompactionService.ts` + `archived_workflow_runs` table + compaction job.
35. **Phase progress events** — `PHASE_COMPLETED` / `PHASE_FAILED` events from engine + `phaseState` in run state.

---

## Part VIII — Brain-Apps Forward Compatibility Ledger

Every decision in this plan is tracked against its brain-apps impact. This ledger is a promise: nothing shipped on main closes a door that brain-apps needs to open.

| Decision | Brain-apps impact | Verdict |
|----------|-------------------|---------|
| `workflow_kv_entries` table (workflow_store node) | Brain indexes these as structured facts per workflow. Add `workspace_id` column for Brain query scope. Zero schema conflict with `appData`. | ✓ Safe |
| `WorkflowGraph.inputContract` / `outputContract` shape | `AppRuntimeContract.outputs` is the same shape. App interface = workflow output contract. Same canvas component reused. | ✓ Safe |
| `agent_swarm` UI unlocked on main | Brain adds context injection to swarm tasks. Swarm is not owned by the brain — brain enriches it. | ✓ Safe |
| `artifact_collect` UI unlocked on main | Brain indexes artifacts as knowledge. Same artifact schema — Brain just adds a `brainChunkId` foreign key later. | ✓ Safe |
| `evaluator` node wired to `EvaluatorRuntime` | `AppContractRuntime` already uses `EvaluatorRuntime`. Same service, now also a canvas node. | ✓ Safe |
| `workflow_completed` trigger surfaced on main | This is a workflow-to-workflow chain — no app coupling. `data_event` remains hidden. | ✓ Safe |
| `data_event` trigger NOT surfaced on main | Requires app table subscriptions. Keep hidden. Brain-apps exposes it. | ✓ Correct |
| `brain_lookup` no palette entry on main | Keep the engine handler. Just no palette entry. Brain-apps adds the entry. | ✓ Correct |
| `data_write` / `data_read` no palette entry on main | These are the app data layer — strictly brain-apps territory. | ✓ Correct |
| Template resolver uses `{{store.key}}` namespace | `store` in the template context is populated from `workflow_kv_entries`. Brain-apps adds `{{app.tableName.field}}` namespace. No conflict. | ✓ Safe |
| `WorkflowGraph.phases` field | Brain-apps uses phases for app workflow decomposition. Same field, extended with `appId` scope. | ✓ Safe |
| LLM synthesis upgrade (buildWorkflowDraft) | Brain-apps extends the synthesis prompt with app node types and brain capabilities. Same function entry point, richer model knowledge. | ✓ Safe |
| `COMPLETED_WITH_CONTRACT_VIOLATION` terminal status | Brain-apps uses this status for app reliability tracking. Same status, new usage. | ✓ Safe |
| `validateGraph.ts` semantic validation | Brain-apps adds app-specific validation rules. Additive, not breaking. | ✓ Safe |

---

## Part IX — What This Plan Deliberately Does Not Include

**Context compression as a palette node.** Context budget management belongs in the `agent_task` dispatch path (a `contextPolicy` property on the node config). Users should not place token-budget management nodes in their workflow graph.

**Model tiering as a per-node UX selector.** Model preferences are set per-agent, not per-node in a workflow. The evaluator always uses the workspace's fast-tier model — engine-enforced. The canvas should not expose a model dropdown per node.

**`GOAL_NOT_MET` run status.** The evaluator-retry pattern is the structural answer to quality gates. A special terminal status adds UI complexity without proportional user value. Runs fail or complete (possibly with a contract violation). Critique is visible in blockData.

**Full code node (inline sandbox).** `transform` and `filter` cover 95% of the use case without the UX investment of an embedded code editor with full input/output mapping UI. A `code` node is worth reconsidering once transform/filter adoption data is collected.

**Postgres migration.** SQLite is the V1 golden path. Migration is tracked in DECISIONS.md.

**OpenTelemetry trace export.** OTel spans are instrumented. Export to an external provider is an operator configuration choice, not a feature this plan addresses.

**Custom node plugin system.** The node taxonomy is intentionally curated, not extensible by users. Open plugin systems create versioning and security complexity disproportionate to their benefit in a workspace-specific automation platform.

---

## Appendix — Key File Reference

### Engine

| File | Change |
|------|--------|
| `apps/api/src/engine/WorkflowEngine.ts` | Add `#dispatchNode()` cases: `wait`, `transform`, `filter`, `integration`, `http_request`, `workflow_store`, `evaluator`, `guardrails`, `loop`, `parallel`; add error-edge routing in `#failNode()`; add `resolveTemplateDeep()` call before every dispatch; wire `EvaluatorRuntime` into deps; wire `ConnectorRegistry` into deps |
| `apps/api/src/engine/templateResolver.ts` | **New file** — `resolveTemplate()`, `resolveTemplateDeep()`, `buildTemplateContext()` |
| `apps/api/src/engine/validateGraph.ts` | Add per-kind semantic validation (missing required config fields are caught at save time, not run time) |
| `packages/core/src/types/workflow.ts` | Add `WorkflowNodeType` union entries: `wait`, `transform`, `filter`, `integration`, `http_request`, `workflow_store`, `evaluator`, `guardrails`, `loop`, `parallel`; add config interfaces for each; add `type?: 'default' \| 'error' \| 'condition'` to `WorkflowEdge`; add `inputContract`, `outputContract`, `phases` to `WorkflowGraph` |
| `packages/core/src/types/workflow.ts` | Add `WorkflowContract`, `WorkflowPhase` interfaces |
| `packages/core/src/events.ts` | Add: `LOOP_PROGRESS`, `NODE_TEST_COMPLETED`, `PHASE_COMPLETED`, `PHASE_FAILED`, `CONTRACT_VIOLATION` |
| `packages/db/src/sqlite/schema.ts` | Add `workflow_kv_entries` table, `archived_workflow_runs` table |

### Backend Routes

| File | Change |
|------|--------|
| `apps/api/src/routes/workflows.ts` | Add: `POST /:id/nodes/:nodeId/test`, `GET /:id/revisions`, `GET /:id/deployments`, `POST /:id/deployments` |
| `apps/api/src/services/buildWorkflowDraft.ts` (or inline in build.ts) | Replace regex with LLM structured-output + `validateWorkflowGraph()` retry loop |
| `apps/api/src/services/workflowStoreService.ts` | **New file** — CRUD for `workflow_kv_entries` with optimistic concurrency |
| `apps/api/src/services/runCompactionService.ts` | **New file** — run blockData compaction + archival job |

### Frontend

| File | Change |
|------|--------|
| `apps/web/src/components/canvas/NodePalette.tsx` | Remove `webhook`; rename labels; add all new nodes organized in tier sections |
| `apps/web/src/components/canvas/ContextInspector.tsx` | Add forms: `IntegrationForm`, `HttpRequestForm`, `TransformForm`, `FilterForm`, `WorkflowStoreForm`, `EvaluatorForm`, `GuardrailsForm`, `LoopForm`, `ParallelForm`, `AgentSwarmForm`, `ArtifactCollectForm`; update `WaitForm` (handler now exists); add Test tab; wire `VariablePicker` |
| `apps/web/src/components/canvas/AgentisEdge.tsx` | Condition label rendering; error edge dashed-red styling; dot animation on active run |
| `apps/web/src/components/canvas/WorkflowNode.tsx` | All live-run visual states; phase membership visual grouping |
| `apps/web/src/pages/WorkflowCanvasPage.tsx` | Cmd+K command palette mount; "Deploy" toolbar button; revision history button |

### New Frontend Files

| File | Purpose |
|------|---------|
| `apps/web/src/components/canvas/VariablePicker.tsx` | `{{` autocomplete combobox using graph topology |
| `apps/web/src/components/canvas/NodeCommandPalette.tsx` | Cmd+K node/integration/subflow search and insertion |
| `apps/web/src/components/canvas/NodeTestRunner.tsx` | Test tab content for isolated node execution |
| `apps/web/src/components/canvas/RevisionHistoryPanel.tsx` | Graph revision list with restore |
| `apps/web/src/components/canvas/DeploymentModal.tsx` | Workflow deployment UI and endpoint display |
| `apps/web/src/components/canvas/PhaseLayer.tsx` | React-flow background layer for phase region rendering |
| `apps/web/src/components/canvas/WorkflowContractPanel.tsx` | input/output contract declaration UI (brain-apps: reused as App Interface panel) |

