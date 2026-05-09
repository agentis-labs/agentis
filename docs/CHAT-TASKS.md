# Chat Tasks — Multi-Turn Agent Execution

> **One-line architecture:** *A Chat Task is a `workflow_runs` row whose sole node is an `agent_task` with `multiTurn: true`. The agent loops until it signals completion or hits the turn cap — and every turn streams back into the chat thread that spawned it.*
>
> **Scope boundary:** Chat Tasks solve "agent quits halfway." Goals/Missions solve "coordinate multiple agents across a multi-day plan." They share the engine, the ledger, and the UI tree — they are two entry points, not two runtimes.

---

## 1. The problem this solves

`#dispatchAgentTask` in `WorkflowEngine.ts` fires a single call to `AdapterManager.dispatchTask()` and marks the node complete when the adapter fires `task.completed`. One shot. Done.

`ClaudeCodeAdapter` already works around this by spawning the Claude CLI with `--max-turns` — the CLI loops internally, the engine sees one terminal callback. This is why Claude Code tasks feel autonomous while OpenClaw tasks with non-Claude models stop mid-work: the multi-turn loop is inside the binary, not in Agentis.

For every other adapter — `OpenClawAdapter` with GPT/Gemini/Mistral, `HttpAdapter` — the engine has no concept of "still working, re-dispatch with accumulated history." The agent signals completion after its first response regardless of whether the task is finished.

**What we are building:** a first-class multi-turn protocol at the engine level and adapter level, with a **New Task modal** in `ChatPanel` so operators can fire tasks against any agent without touching the canvas.

---

## 2. What already exists (do not rebuild)

| Concern | Existing primitive | File |
|---|---|---|
| Single agent_task dispatch | `#dispatchAgentTask` | `apps/api/src/engine/WorkflowEngine.ts` L782 |
| Adapter event protocol | `NormalizedAgentEvent` | `packages/core/src/types/index.ts` |
| Turn cap (Claude Code) | `--max-turns` CLI flag + `AGENT_TASK_MAX_TURNS_DEFAULT` | `apps/api/src/adapters/ClaudeCodeAdapter.ts` L61 |
| Run parent/child lineage | `workflow_runs.parentRunId` column | `packages/db/src/sqlite/schema.ts` L336 |
| Work step streaming | `AGENT_WORK_STEP` event | `packages/core/src/events.ts` |
| Per-agent conversation thread | `ConversationStore` + `ThreadView` | `apps/api/src/services/conversationStore.ts`, `apps/web/src/components/ChatPanel/ThreadView.tsx` |
| Budget gate on agent_task | `BudgetService.checkAndReserve()` | `WorkflowEngine.ts` L801 |
| Subagent lineage for subflows | `SubflowExecutor` + `findParentByChildRunId` | `apps/api/src/services/subflowExecutor.ts` |
| Run inspection | `RunDrawer` (flat ledger timeline) | `apps/web/src/components/canvas/RunDrawer.tsx` |
| History table | `HistoryPage` (flat table) | `apps/web/src/pages/HistoryPage.tsx` |
| Agent card work steps | `AgentWorkStream` component | `apps/web/src/components/AgentWorkStream.tsx` |

**Net new code is contained:** three new fields on `AgentTaskNodeConfig`, two new fields on `notifyTaskCompleted` args, one `#buildTaskPayload` helper in `WorkflowEngine`, one "New Task" modal component in `ChatPanel`, one tree-mode toggle in `RunDrawer`. No new tables. No new routes (the task run uses existing `POST /v1/workflows/:id/run`). No new realtime event types beyond `CHAT_TASK_CREATED` (the existing `AGENT_WORK_STEP` covers turn progress streaming).

---

## 3. Core: `multiTurn` on `AgentTaskNodeConfig`

### 3.1 Why not `loop: true`

The engine already has a `loop` node kind dispatched at `WorkflowEngine.ts` L639 via `#executeLoop`, which handles array-iteration semantics (`loopScopes`, `iterationCount`, `loopType`). Adding a boolean field named `loop` to `AgentTaskNodeConfig` creates a naming collision in the type discriminant, the canvas palette, and in any code that inspects `node.config`. The correct field name is `multiTurn`.

### 3.2 Schema change — `packages/core/src/types/workflow.ts`

```ts
// packages/core/src/types/workflow.ts  (existing interface, add three fields)
export interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentId?: string;
  agentPackageRef?: string;
  mcpServerIds?: string[];
  retryPolicy?: NodeRetryPolicy;
  cache?: NodeCachePolicy;
  timeoutMs?: number;
  outputSchema?: unknown;
  memory?: AgentMemoryConfig;
  capabilityTags: string[];
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];

  // ── NEW ──────────────────────────────────────────
  /** When true the engine re-dispatches until the adapter signals status:'done'. */
  multiTurn?: boolean;
  /** Hard cap on total turns. Engine enforces this; adapter never sees turn N+1 after cap.
   *  Default: CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT (currently 24, matches ClaudeCode). */
  maxTurns?: number;
  /** What to do when the turn cap is hit.
   *  'escalate' (default) — creates a human_in_the_loop checkpoint and parks the run.
   *  'fail'               — marks the node FAILED with code TURN_CAP_REACHED. */
  onTurnCap?: 'escalate' | 'fail';
}
```

### 3.3 Adapter turn protocol — `packages/core/src/types/index.ts`

The adapter needs to tell the engine whether a turn is terminal. Add a discriminated field to `task.completed`:

```ts
// packages/core/src/types/index.ts (NormalizedAgentEvent)
// Existing: { eventType: 'task.completed'; taskId; output; ... }
// Change to carry an explicit status signal:

export type TaskCompletedEvent = {
  eventType: 'task.completed';
  agentId: string;
  runId: string;
  workflowId: string;
  taskId: string;
  nodeId: string;
  timestamp: string;
  output: Record<string, unknown>;
  /** 'done'    — agent signals the task is finished; engine completes the node.
   *  'working' — agent has more to do; engine re-dispatches with accumulated history.
   *  Omitting this field is treated as 'done' for backwards-compatibility with
   *  ClaudeCodeAdapter and HttpAdapter which emit it once and never loop. */
  turnStatus?: 'done' | 'working';
  /** Present when turnStatus === 'working'. The adapter includes the full
   *  accumulated conversation so the re-dispatch can continue from context. */
  accumulatedHistory?: ConversationTurn[];
};

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResults?: { name: string; result: unknown }[];
}
```

### 3.4 Engine change — `apps/api/src/engine/WorkflowEngine.ts`

The change is localized to `#dispatchAgentTask` and `notifyTaskCompleted`. The run loop itself (`#tick`) does not change.

**In `#dispatchAgentTask`:** add `turnCount` to `activeExecutions[node.id]` so the cap can be enforced at callback time.

```ts
// WorkflowEngine.ts — in #dispatchAgentTask, after building taskInput:
ctx.state.activeExecutions[node.id] = {
  taskId,
  nodeId: node.id,
  executorType: 'agent',
  executorRef: dispatchAgentId,
  startedAt: new Date().toISOString(),
  // NEW:
  turnCount: 0,
  multiTurn: config.multiTurn ?? false,
  maxTurns: config.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT,
  onTurnCap: config.onTurnCap ?? 'escalate',
  // DO NOT store accumulatedHistory here. activeExecutions is serialised inside
  // workflow_runs.runState JSON on every #persistRun(). A 20-turn task with 10KB
  // per turn would add 200KB+ re-written to SQLite on every heartbeat.
  // History lives in ScratchpadService under key `turns:<nodeId>` — see notifyTaskCompleted.
};
```

**In `notifyTaskCompleted`:** check `turnStatus` before completing the node.

> **⚠️ bootstrap.ts is also a change surface.**
> The adapter event glue in `apps/api/src/bootstrap.ts` (L224–240) translates `NormalizedAgentEvent` to engine calls:
> ```ts
> // bootstrap.ts — current code (must be updated alongside notifyTaskCompleted)
> if (event.eventType === 'task.completed') {
>   void engine.notifyTaskCompleted({
>     runId: event.runId,
>     nodeId: event.taskId, // taskId == nodeId in V1
>     output: event.output,
>     // ADD:
>     turnStatus: event.turnStatus,
>     accumulatedHistory: event.accumulatedHistory,
>   });
> }
> ```
> The `notifyTaskCompleted` signature **stays an args-object** (consistent with `notifyTaskFailed`). There is no `#findActiveExecution(taskId)` helper — the engine already has `this.#runs.get(runId)` and the node is found by `ctx.graph.nodes.find(n => n.id === nodeId)`. V1 invariant from bootstrap.ts comment L242: `taskId == nodeId`.

```ts
// WorkflowEngine.ts — notifyTaskCompleted (corrected):
async notifyTaskCompleted(args: {
  runId: string;
  nodeId: string;
  output: Record<string, unknown>;
  turnStatus?: 'done' | 'working';
  accumulatedHistory?: ConversationTurn[];
}) {
  // Use the existing lookup pattern — no new helper needed.
  const ctx = this.#runs.get(args.runId);
  if (!ctx) return;
  const node = ctx.graph.nodes.find((n) => n.id === args.nodeId);
  if (!node) return;
  const exec = ctx.state.activeExecutions[node.id]!;
  exec.turnCount = (exec.turnCount ?? 0) + 1;

  const effectiveStatus = args.turnStatus ?? 'done';

  if (effectiveStatus === 'working' && exec.multiTurn) {
    const cap = exec.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT;
    if (exec.turnCount >= cap) {
      if (exec.onTurnCap === 'fail') {
        // notifyTaskFailed stays args-object — consistent with the existing signature.
        await this.notifyTaskFailed({ runId: args.runId, nodeId: args.nodeId, error: `Turn cap of ${cap} reached` });
      } else {
        await this.#escalateTurnCap(ctx, node, exec);
      }
      return;
    }
    // Store history in ScratchpadService — NOT on activeExecutions (avoids runState JSON bloat).
    if (args.accumulatedHistory) {
      this.deps.scratchpad.write(ctx.runId, `turns:${node.id}`, args.accumulatedHistory);
    }
    const history = (this.deps.scratchpad.read(ctx.runId, `turns:${node.id}`) ?? []) as ConversationTurn[];
    // Explicitly re-check budget with estimatedCents: 0.
    // The reservation was made on turn 1, but a depleted workspace must still park the run.
    await this.deps.budget?.checkAndReserve({ workspaceId: ctx.workspaceId, estimatedCents: 0, runId: ctx.runId });
    await this.deps.adapters.dispatchTask({
      ...this.#buildTaskPayload(ctx, node, exec),
      continuationHistory: history,
    }, exec.executorRef);
    return;
  }

  // Terminal: complete the node normally.
  await this.#completeNode(ctx, node, args.output);
}
```

The `#buildTaskPayload` helper extracts the reused dispatch fields (taskId, runId, workflowId, nodeId, description, inputData) that are already assembled in `#dispatchAgentTask`. Extracting them to a shared helper avoids duplication — this is the only new internal helper. `accumulatedHistory` is never stored on `ActiveExecution`; the `ScratchpadService` is in-memory and does not re-serialize on every `#persistRun()`.

### 3.5 `NormalizedTask` gets `continuationHistory`

```ts
// packages/core/src/types/index.ts (NormalizedTask)
export interface NormalizedTask {
  taskId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  title?: string;
  description: string;
  inputData: Record<string, unknown>;
  scratchpadSnapshot?: Record<string, unknown>;
  capabilityTags?: string[];
  timeoutMs?: number;
  // NEW:
  continuationHistory?: ConversationTurn[]; // present on re-dispatch turns (turn >= 2)
}
```

---

## 4. Adapter implementations

### 4.1 `ClaudeCodeAdapter` — no change needed

`ClaudeCodeAdapter` already handles multi-turn internally via `--max-turns`. It fires `task.completed` once when the process exits. It should remain unchanged and never emit `turnStatus: 'working'`. The `maxTurns` field on the node config maps to the CLI's `--max-turns` flag if desired (see §4.3).

### 4.2 `OpenClawAdapter` — multi-turn WS protocol

This is the adapter that actually needs to change. The current `dispatchTask` sends `{kind: 'task.dispatch', task}` and waits for `task.completed` from the gateway. For multi-turn to work, the gateway needs to support a turn protocol.

**Adapter-side (Agentis, `apps/api/src/adapters/OpenClawAdapter.ts`):**

```ts
// In #handleMessage:
case 'task.turn':
  // Gateway signals: model finished one turn, has tool calls pending
  // The gateway sends accumulated history with this message
  this.#emit({
    eventType: 'task.completed',
    agentId: this.opts.agentId,
    runId: String(msg.runId ?? ''),
    workflowId: String(msg.workflowId ?? ''),
    taskId: String(msg.taskId ?? ''),
    nodeId: String(msg.nodeId ?? ''),
    timestamp: at(),
    output: (msg.partialOutput as Record<string, unknown>) ?? {},
    turnStatus: 'working',
    accumulatedHistory: (msg.history as ConversationTurn[]) ?? [],
  });
  return;

// In dispatchTask:
async dispatchTask(task: NormalizedTask): Promise<void> {
  await this.#breaker.exec(async () => {
    if (task.continuationHistory?.length) {
      // Re-dispatch: send continuation, not a fresh task.dispatch
      this.#sendOrThrow({ kind: 'task.continue', taskId: task.taskId, history: task.continuationHistory });
    } else {
      this.#sendOrThrow({ kind: 'task.dispatch', task });
    }
  });
}
```

**Gateway-side (not in this repo):** The OpenClaw gateway needs to emit `task.turn` with accumulated history when the model's response includes unexecuted tool calls, instead of emitting `task.completed`. This is a WS protocol extension between Agentis and the gateway operator. Until gateway support is deployed, `OpenClawAdapter` simply never emits `turnStatus: 'working'` — it degrades gracefully (same one-shot behaviour as today). The `multiTurn: true` flag on the node config is a no-op for unupgraded gateways.

### 4.3 `ClaudeCodeAdapter` — hook up `maxTurns` from node config

Currently `ClaudeCodeAdapter` uses `this.opts.maxTurns` set at adapter construction time. For per-task overrides to work, pass `maxTurns` through `NormalizedTask` and prefer it over the adapter default:

```ts
// ClaudeCodeAdapter.ts dispatchTask:
`--max-turns=${task.maxTurns ?? this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
```

Add `maxTurns?: number` to `NormalizedTask`.

### 4.4 `HttpAdapter` — no change

HTTP adapters are stateless per-request. Multi-turn would require the remote endpoint to implement session continuity, which is out of scope for V1. `multiTurn: true` on an `HttpAdapter`-backed agent logs a `MULTI_TURN_UNSUPPORTED` warning and falls through to single-turn.

---

## 5. New Task modal — canvas-free entry point from ChatPanel

> **Why not `/task @agent …`?** The user is already in a `ChatPanel` tab with an agent loaded. A slash command forces them to re-specify the agent they're already looking at, via a CLI syntax (`@mention`) that is unfamiliar to non-developer operators. A modal gives the same three API calls with a discoverable affordance, a proper agent picker (covers multi-word names, avoids regex fragility), and a `maxTurns` control that operators actually need to adjust per task.

### 5.1 `NewTaskModal` component

A small modal (not a new page, not a slash command) attached to a **"+ New Task" button** in the `ChatPanel` header next to the existing thread controls.

```tsx
// apps/web/src/components/ChatPanel/NewTaskModal.tsx
// Fields:
//   Agent:    <AgentPicker> — reuse existing agent selector component, pre-selected to current thread agent
//   Prompt:   <textarea> — free-form task description
//   Max turns: <NumberInput min=1 max=50 default=20> — visible, editable, no hidden singleton baking
// On submit: calls handleCreateChatTask(agentId, prompt, maxTurns)
```

The modal is the only new component. No new slash command verb, no changes to `Composer.tsx`, no `@mention` parsing.

### 5.2 `handleCreateChatTask` — the task launcher

```ts
// apps/web/src/components/ChatPanel/ThreadView.tsx
// Add this function inside ThreadView:

async function handleCreateChatTask(targetAgentId: string, prompt: string, maxTurns = 20) {
  // 1. Create a fresh workflow row per invocation.
  //    The singleton-per-agent pattern was considered and rejected: it bakes maxTurns into
  //    a hidden resource the user can't see or modify, and creates invisible cleanup debt
  //    (agent renames, agent deletes, stale singleton rows). One run = one workflow row
  //    is simpler and explicit. The `chat-task` tag keeps them filtered from the Workflows page.
  const wf = await api<{ workflow: { id: string } }>('/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({
      title: `Task: ${prompt.slice(0, 60)}`,
      summary: prompt,
      tags: ['chat-task'],
      graph: buildChatTaskGraph(targetAgentId, prompt, maxTurns),
    }),
  });
  // 2. Start the run.
  const run = await api<{ runId: string }>(`/v1/workflows/${wf.workflow.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ inputs: {} }),
  });
  // 3. Inject a system message so the user sees "Task started" in the thread.
  setMessages((m) => [
    ...m,
    {
      id: crypto.randomUUID(),
      role: 'system',
      body: `Task started`,
      createdAt: new Date().toISOString(),
      metadata: { source: 'workflow', runId: run.runId },
    },
  ]);
  setActiveChatTaskRunId(run.runId);
}

// prompt and maxTurns are baked into the graph at creation time — no template variables needed
// because this workflow is created fresh per invocation (not a reusable singleton).
function buildChatTaskGraph(agentId: string, prompt: string, maxTurns: number): WorkflowGraph {
  const triggerId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  return {
    nodes: [
      {
        id: triggerId,
        title: 'Start',
        config: { kind: 'trigger', triggerType: 'manual' },
        position: { x: 100, y: 100 },
      },
      {
        id: nodeId,
        title: 'Task',
        config: {
          kind: 'agent_task',
          agentId,
          prompt,
          capabilityTags: [],
          inputKeys: [],
          outputKeys: [],
          multiTurn: true,
          maxTurns,
          onTurnCap: 'escalate',
        },
        position: { x: 100, y: 250 },
      },
    ],
    edges: [{ id: crypto.randomUUID(), source: triggerId, target: nodeId }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
```

`WorkflowGraph` is already imported from `@agentis/core` in the web app — no new import.

---

## 6. `agentis.delegate` — deferred to V1.1

> **Cut from V1.** Agent-directed subagent spawning via `agentis.delegate` has a fundamental blocker: there is no mechanism in the current codebase that surfaces this tool to the LLM. The engine builds the agent's tool list from `config.mcpServerIds` at dispatch time (`WorkflowEngine.ts` L838). `ClaudeCodeAdapter` gets tools from MCP. `OpenClawAdapter` is V1.1. `HttpAdapter` is stateless. None of these adapters can present `agentis.delegate` to the model without changes — and if the model never sees the tool, it can never call it. Path B (engine interceptor) intercepts a tool call that can never be made.
>
> The use case this solved — one agent spawning another mid-task — is already covered by Goals/Missions: the planner emits `agent_task` nodes in a DAG. Orchestration belongs in the graph, not in the turn protocol.
>
> **V1.1 prerequisite:** before implementing, resolve tool injection — either via MCP (Path A) or a first-class `agentis.*` tool namespace injected at dispatch time alongside `mcpTools`. Design that surface first, then implement `agentis.delegate` on top of it.

---

## 7. UI: run progress in `ThreadView`

When a Chat Task is running, `AGENT_WORK_STEP` events arrive on the run's realtime room. `ThreadView` already handles session message events — attach a secondary subscription to the run room so work steps surface in the thread without a separate component.

Child run detail (for future delegation) belongs in `RunDrawer` tree mode (§8), not inline in `ThreadView`. Nesting a second agent's work-step stream inside a chat bubble creates two concurrent streams the user can't distinguish from each other. The primary interaction surface shows task status; the `RunDrawer` shows the full trace.

```tsx
// ThreadView.tsx — subscribe to run room when activeChatTaskRunId is set:
useEffect(() => {
  if (!activeChatTaskRunId) return;
  rtSubscribe('run', { runId: activeChatTaskRunId });
}, [activeChatTaskRunId]);

// In the useRealtime handler, add:
if (env.event === REALTIME_EVENTS.RUN_COMPLETED && payload.runId === activeChatTaskRunId) {
  // Update the "Task started" system message to "Task completed"
  setMessages((m) => m.map((msg) =>
    msg.metadata?.runId === activeChatTaskRunId
      ? { ...msg, body: 'Task completed' }
      : msg,
  ));
  setActiveChatTaskRunId(null);
}
if (env.event === REALTIME_EVENTS.RUN_FAILED && payload.runId === activeChatTaskRunId) {
  setMessages((m) => m.map((msg) =>
    msg.metadata?.runId === activeChatTaskRunId
      ? { ...msg, body: 'Task failed' }
      : msg,
  ));
  setActiveChatTaskRunId(null);
}
```

---

## 8. UI: `RunDrawer` tree mode

### 8.1 Tree view toggle

`RunDrawer` currently fetches `/v1/runs/:runId/ledger` and renders a flat list of `LedgerEvent` rows. Add a **tree mode** toggle that fetches child runs and nests them.

```tsx
// apps/web/src/components/canvas/RunDrawer.tsx — add to state:
const [treeMode, setTreeMode] = useState(false);
const [childRuns, setChildRuns] = useState<ChildRunSummary[]>([]);

// When treeMode is toggled on, fetch children:
useEffect(() => {
  if (!treeMode || !runId) return;
  void api<{ runs: ChildRunSummary[] }>(`/v1/runs?parentRunId=${runId}`)
    .then((r) => setChildRuns(r.runs))
    .catch(() => setChildRuns([]));
}, [treeMode, runId]);
```

This requires a `?parentRunId=` filter on `GET /v1/runs`. The `workflow_runs` table has `parentRunId` — a one-line `where(eq(schema.workflowRuns.parentRunId, parentRunId))` clause in the runs route.

### 8.2 Nested display

In tree mode, each `ChildRunSummary` is rendered as a collapsible row below its parent node's event. Clicking expands the child ledger inline (lazy-loaded on demand). The indentation is CSS `ml-4` per level. Depth capped at 3 to avoid infinite nesting.

---

## 9. UI: `HistoryPage` — parent/child grouping

`HistoryPage` shows a flat table of `workflow_runs` rows. Add a **Group by parent** toggle:

- OFF (default): current flat table, unchanged.
- ON: runs with `parentRunId = null` are top-level rows. Runs with a `parentRunId` are nested under their parent as indented sub-rows. Uses the same `workflow_runs.parentRunId` column — no new API.

Implementation: after fetching the runs list, partition by `parentRunId`. Build a `Map<parentId, runs[]>` and render with `<details>` / `<summary>` for collapse. No new API endpoint.

Filter: Chat Task workflows are tagged `chat-task`. Add a **Show chat tasks** toggle (default OFF) so the history table doesn't fill up with auto-generated single-node workflows.

---

## 10. UI: `AgentWorkStream` — delegation breadcrumb

`AgentWorkStream` shows per-agent `AGENT_WORK_STEP` text on the `HomePage` fleet cards. When an agent's active run has a `parentRunId`, show a one-line breadcrumb.

```tsx
// apps/web/src/components/AgentWorkStream.tsx — add parentAgentName prop:

// When rendering the work step text, prefix with breadcrumb if present:
{parentAgentName && (
  <span className="text-text-muted text-xs mr-1">
    ↑ delegated by {parentAgentName}
  </span>
)}
```

`parentAgentName` is resolved by looking up the parent run's `userId → agentId` from `activeRuns` in the Zustand store — this data is already present from `AGENT_STATUS_CHANGED` events.

---

## 11. New events required

All of these use the existing `REALTIME_EVENTS` enum — add them to `packages/core/src/events.ts`.

```ts
// packages/core/src/events.ts — add to REALTIME_EVENTS:
CHAT_TASK_CREATED: 'chat_task.created',          // emitted when New Task modal creates the run
CHAT_TASK_TURN_STARTED: 'chat_task.turn.started', // emitted at start of each turn ({runId, nodeId, turnNumber})
CHAT_TASK_TURN_COMPLETED: 'chat_task.turn.completed', // emitted at end of each turn
TURN_CAP_REACHED: 'turn_cap.reached',            // emitted when maxTurns hit, before escalate/fail
```

`AGENT_DELEGATED` is **not added in V1** — it belongs to the `agentis.delegate` V1.1 feature (§6).

---

## 12. Safety & cost discipline

- **Turn cap is mandatory.** The `multiTurn: true` flag without `maxTurns` uses `CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT` (currently 24). This is the same constant `ClaudeCodeAdapter` uses today. A missing cap is never treated as "infinite."
- **Budget gate per turn.** `BudgetService.checkAndReserve()` already runs before the first dispatch. On re-dispatch (turn ≥ 2) it runs again with `estimatedCents: 0` (the reservation was already made) — budget is tracked via actual `costMicros` accumulation in the run, not per-turn estimates. If the workspace budget is exhausted mid-turn, the next `checkAndReserve` returns `approval_required` and the run parks at `WAITING`.
- **`agentis.delegate` depth limit.** The delegation chain depth is checked by walking `workflow_runs.parentRunId` up the tree before each spawn. Cap is 5 levels. Code: `COUNT(*) FROM workflow_runs WHERE id IN (recursive parentRunId chain)` — SQLite supports recursive CTEs.
- **Chat-task workflows are hidden by default.** `GET /v1/workflows` adds `WHERE NOT tag_match('chat-task')` to the default query.
- **SSRF is not a new surface here.** `agentis.delegate` dispatches to agents by ID, not URLs. The agent's adapter URL was already validated at gateway registration time.

---

## 13. Implementation phases

Each phase ships independently. Phase 1 alone fixes the immediate bug for ClaudeCode users. Phase 4 is needed before Goals/Missions Phase 4 (real planner LLM) because the planner emits `agent_task` nodes — those nodes benefit from `multiTurn: true` when the planner assigns them to non-Claude agents.

### Phase 1 — `multiTurn` on `AgentTaskNodeConfig` + turn cap enforcement *(~2 hours)*

- Add `multiTurn?: boolean`, `maxTurns?: number`, `onTurnCap?: 'escalate' | 'fail'` to `AgentTaskNodeConfig` in `packages/core/src/types/workflow.ts`.
- Add `turnStatus?: 'done' | 'working'` and `accumulatedHistory?` to `TaskCompletedEvent` in `packages/core/src/types/index.ts`.
- Add `turnCount`, `multiTurn`, `maxTurns`, `onTurnCap` to `ActiveExecution` in the engine's running context type. **Do NOT add `accumulatedHistory` to `ActiveExecution`** — store it in `ScratchpadService` under key `turns:<nodeId>` to avoid runState JSON bloat (see §3.4).
- Modify `notifyTaskCompleted` in `WorkflowEngine.ts` to branch on `turnStatus`.
- Add `#escalateTurnCap` helper that creates a `human_in_the_loop` checkpoint item on the run (reuse `#executeHumanInTheLoop` context-write pattern at L1132).
- Hook `maxTurns` from `NormalizedTask` into `ClaudeCodeAdapter`'s `--max-turns` arg.
- **Tests:** Vitest unit test in `apps/api/tests/engine/` — build a graph with a single `agent_task` node that has `multiTurn: true, maxTurns: 3`. Stub adapter emits `turnStatus: 'working'` twice then `'done'`. Assert: `notifyTaskCompleted` called 3 times, node completes on 3rd call, `turnCount === 3`. Second test: cap at 2 with `onTurnCap: 'fail'` — assert node status `FAILED` with code `TURN_CAP_REACHED`.

### Phase 2 — New Task modal + `handleCreateChatTask` *(~2 hours)*

- Add `NewTaskModal` component to `apps/web/src/components/ChatPanel/NewTaskModal.tsx`.
- Add **"+ New Task" button** to `ChatPanel` header (next to existing thread controls).
- Add `handleCreateChatTask(agentId, prompt, maxTurns)` function in `ThreadView.tsx`.
- Add `buildChatTaskGraph(agentId, prompt, maxTurns)` helper in `ThreadView.tsx`.
- Add `activeChatTaskRunId` state to `ThreadView`; subscribe to run room when set.
- Wire `RUN_COMPLETED` / `RUN_FAILED` events to update the "Task started" system message in thread.
- Filter `chat-task` tagged workflows from `GET /v1/workflows` default query (one `WHERE` clause in `apps/api/src/routes/workflows.ts`).
- Add `CHAT_TASK_CREATED`, `CHAT_TASK_TURN_STARTED`, `CHAT_TASK_TURN_COMPLETED`, `TURN_CAP_REACHED` to `REALTIME_EVENTS`.
- **Tests:** E2E Playwright spec: open New Task modal → select Hermes → enter "say hello" → submit → system message appears in thread → `workflow_runs` row exists with `chat-task` tag → run completes → message updates to "Task completed".

### Phase 3 — *(was `agentis.delegate` — cut from V1; see §6)*

No implementation in V1. The events (`AGENT_DELEGATED`) and the `DelegationCallout` component are also cut. If `agentis.delegate` is added in V1.1, Phase 3 resumes here.

### Phase 4 — `RunDrawer` tree mode + `HistoryPage` grouping *(~2 hours)*

- Add tree mode toggle + child run fetch to `RunDrawer.tsx` (§8).
- Add `?parentRunId=` filter to runs API call in `RunDrawer` and to `GET /v1/runs` in `apps/api/src/routes/runs.ts`.
- Add **Group by parent** toggle to `HistoryPage.tsx` (§9).
- Add **Show chat tasks** toggle to `HistoryPage.tsx`.
- Add delegation breadcrumb to `AgentWorkStream.tsx` (§10).
- **Tests:** Vitest web test for `RunDrawer` tree mode — mock `api` to return one child run, toggle tree mode, assert child run row renders indented.

### Phase 5 — OpenClaw multi-turn WS protocol *(blocked on gateway, V1.1)*

- Implement `task.turn` / `task.continue` message handling in `OpenClawAdapter.ts` (§4.2).
- Coordinate WS protocol extension with gateway team.
- E2E spec (requires a test gateway): GPT-4o agent on OpenClaw runs a two-turn task, assert `CHAT_TASK_TURN_COMPLETED` fires twice before `RUN_COMPLETED`.

---

## 14. Future Autonomous Planning

Chat Tasks stay workflow/run based in V1. Larger autonomous planning surfaces are deferred beyond the V1 scope so this layer can stay focused on multi-turn task execution, delegation, run history, and replay.

| Pattern | Mechanism | When |
|---|---|---|
| Single agent, multi-turn | `agent_task` with `multiTurn: true` (Chat Task) | User opens New Task modal |
| Agent delegates one subtask | `agentis.delegate` — V1.1 only; requires tool injection surface | Agent decides mid-task |
| Chat Task scope grows too large | Agent emits `CHAT_TASK_ESCALATED` event | Future planning surface |

**`parentRunId` is the shared spine.** Both `SubflowExecutor` (Goals/Missions) and `agentis.delegate` (Chat Tasks) write `parentRunId` on child `workflow_runs` rows. The `RunDrawer` tree view, `HistoryPage` grouping, and `DelegationCallout` all read this same column — built once, used by both.

---

## 15. Acceptance criteria

- [ ] New Task modal in `ChatPanel` creates a `workflow_runs` row, starts the agent, and streams `AGENT_WORK_STEP` events back into the chat thread.
- [ ] The "Task started" system message in `ThreadView` updates to "Task completed" / "Task failed" when the run concludes.
- [ ] A `multiTurn: true` agent that signals `turnStatus: 'working'` is re-dispatched with accumulated history until it signals `'done'` or hits `maxTurns`.
- [ ] Hitting `maxTurns` with `onTurnCap: 'escalate'` parks the run as a `WAITING` checkpoint visible in `ApprovalsPage` with the full turn history.
- [ ] Hitting `maxTurns` with `onTurnCap: 'fail'` marks the node `FAILED` with code `TURN_CAP_REACHED` and the run terminates cleanly.
- [ ] `RunDrawer` tree mode shows child runs nested under the node that spawned them (covers subflow children and future delegation).
- [ ] `HistoryPage` "Group by parent" toggle nests child runs under their parent row.
- [ ] Chat task workflows tagged `chat-task` are excluded from `GET /v1/workflows` by default.
- [ ] No regression in the vitest (454) and Playwright (315) suite.
- [ ] `ClaudeCodeAdapter` behaviour is unchanged (single terminal callback, multi-turn handled internally by CLI).
