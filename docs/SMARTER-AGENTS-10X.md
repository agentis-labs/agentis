# Smarter Agents: The 10x Platform Plan
## From Workflow Executor to Autonomous Agent Runtime

**Date**: May 2026  
**Status**: Strategic Plan — supersedes `AGENT-AUTONOMY-10X.md` and `AGENT-SESSION-ARCHITECTURE.md`  
**Research basis**: Claude Code dynamic workflows, OpenAI Codex / background mode, OpenAI Responses / Conversations API, Letta stateful agents / sleep-time compute, Anthropic "Building Effective Agents" guide  
**Scope**: Engine + Adapters + DB + Canvas + Chat surface

---

## The Vision in One Sentence

> Agentis gives you the raw power of 200-agent dynamic swarms — and the only platform that lets you see every decision they made, replay any branch, cap what they cost, and approve the ones that matter.

---

## Part I — The Current Ceiling

The current Agentis engine is a **workflow executor**. A human (or the Brain planner) designs a graph. The graph runs. Nodes fire. Agents inside `agent_task` nodes execute exactly what their node config says, then report back. The graph decides everything; the agent decides nothing.

```
Human designs graph → Engine executes graph → Agents follow orders
```

The actual intelligence in this model lives in the human who designed the graph, not in the agents. The agents are sophisticated function callers, not decision-makers.

A real autonomous agent should be able to:
- **Delegate** a subtask to a specialist and **await** the result before continuing
- Decide **how many** sub-agents to spawn based on what it discovers at runtime
- **Fail fast** and restructure its approach mid-execution
- **Communicate** with a peer agent running in the same workflow right now
- **Evaluate** its own output and loop until satisfied
- **Maintain memory** across hours of work without losing context
- **Sleep zero-cost** while a long tool runs, wake up with full context

None of these are possible today. This document is the plan to make all of them possible — without dismantling the observability, budget, and replay foundations that make Agentis a serious platform.

---

## Part II — How Real Agents Actually Work (The Secret Behind Sleep/Wake)

When you watch Codex or an Antigravity agent run a terminal command that takes several minutes, the agent appears to stop. It issued the command. Now it's waiting. Crucially: **it is not burning tokens**. When the command returns — however many minutes later — the agent reads the output and continues exactly where it left off.

This is not magic. It is the result of one architectural decision:

```
THINKING MODE   ──►  Token generation is running. The LLM decides what to do next.
                     Output: text to the user, OR a set of tool calls.
                     Ends when the LLM finishes its output.

DOING MODE      ──►  Token generation is OFF. Zero spend.
                     Something in the world is changing:
                     a terminal command, a file write, a web fetch, a subtask.
                     Ends when all tool calls return results.
```

These two modes strictly alternate. **You never spend tokens while a tool is running.**

The reason this is hard to get right is that most platforms conflate the two modes. The adapter receives a task, runs a loop internally that mixes inference and tool execution, and reports done. From the billing perspective you see tokens being generated constantly even when nothing meaningful is happening.

The key insight from Codex's architecture is even deeper: **the agent between steps is just a row in a database**, not a running process. The "agent" is:

```
{ sessionId, messageHistory[], status: "waiting_for_tool_result" }
```

When the tool finishes, the platform reconstructs the full context from the database and fires a new LLM inference call. Zero compute between tool calls. Zero tokens. The agent was a DB record for those 15 minutes.

This is what we are building.

---

## Part III — Honest Audit: What Already Exists

Before building anything, the current state:

| Primitive | File | Status | Gap |
|---|---|---|---|
| Parallel fan-out | `WorkflowEngine.ts #dispatchAgentSwarm` | ✅ Works | Flat, max 64, same agent type, no recursive spawn |
| Static child workflows | `SubflowExecutor.ts` | ✅ Works | Pre-declared only, agent can't create at runtime |
| Live graph mutation | `WorkflowEngine.applyGraphPatch()` | ✅ Works | Called externally; agents can't call it mid-task |
| Agent dispatch tool | `agentisToolHandlers/agent.ts` | ✅ Exists | **Fire-and-forget** — no result propagation back to caller |
| Agent spawn tool | `agentisToolHandlers/agent.ts` | ✅ Exists | Creates agent entity, doesn't run a task |
| Workflow create tool | `agentisToolHandlers/build.ts` | ✅ Exists | Agent can build a workflow but can't run-and-await |
| Workflow run tool | `agentisToolHandlers/run.ts` | ✅ Exists | Fires run, returns `{runId}` — no await on result |
| Evaluator service | `services/evaluatorRuntime.ts` | ✅ Exists | Not wired as a node type |
| Scratchpad | `services/scratchpad.ts` | ✅ Works | Per-run, single namespace — agents get a snapshot, not live |
| Session ID tracking | `ClaudeCodeAdapter.#sessionId` | ✅ Exists | CLI-private; Agentis can't inject into or inspect it |
| Brain tool context | `#dispatchAgentTask` L824 | ✅ Works | Injected at dispatch, static snapshot — agent can't update it |
| `toolManifest` in `NormalizedTask` | `packages/core/src/types/adapter.ts` | ✅ Exists | Comment says "awareness only; fire-and-forget — interactive tool execution happens on the chat() path, not here" |

The picture: **the pieces exist but don't compose**. An agent can call `agentis.agent.dispatch` and `agentis.workflow.run`, but those are fire-and-forget — the agent never gets results back.

---

## Part IV — The Five Problems

### Problem 1: Agents are stateless across tasks

`NormalizedTask.scratchpadSnapshot` is a static snapshot created at dispatch time. When the task ends, any knowledge the agent accumulated dies with the process. When the same agent runs the next `agent_task` node, it starts from zero.

`ClaudeCodeAdapter` tracks `#sessionId` and passes `--resume sessionId` — but this only works for consecutive dispatches to the same adapter instance. The session content is the Claude CLI's private session; Agentis cannot inspect, inject into, or control it.

### Problem 2: Agents are blind to the workflow

The agent receives a description (string prompt), inputData (JSON), and a scratchpad snapshot. It does not know:
- What workflow it is part of
- What other nodes are running in parallel right now
- What the overall goal of the run is
- What other agents are thinking
- How many iterations this node has been retried
- What failed before it

It is not an agent working on a mission. It is a sophisticated function call.

### Problem 3: Tool calls can only go sideways, never upward

The `toolManifest` comment says it plainly: *"workflow-node dispatch is fire-and-forget — this is awareness only"*. Agents know tools exist but cannot invoke them during a workflow task. An agent cannot call `agentis.delegate_task` in the middle of executing an `agent_task` node. The workflow controls the agent; the agent cannot influence the workflow.

### Problem 4: No memory management for long runs

Every agent has a finite context window. Claude Sonnet has ~200k tokens. Long agentic runs — codebase migrations, multi-hour research tasks — will exceed this. When that happens today, the CLI truncates (losing earlier context) or fails. There is no mechanism for:
- Summarizing older content before eviction
- Retaining key decisions in a compressed form
- Searching historical steps when needed
- Running a background consolidation pass

### Problem 5: No suspension model

If an agent wants to wait for something — a long build, another agent's output, a human decision — it must poll (burning tokens asking "is it done yet?") or block (holding the adapter process open). Every wait burns resources.

---

## Part V — How State-of-the-Art Platforms Solve This

### Codex

Codex runs each task inside an isolated cloud container. Between LLM inference calls, the container exists and holds state. The platform makes a new API call with the full message history reconstructed from the container's log. No process is blocked between calls.

```
Step N:
  1. Load message history from DB
  2. Reconstruct context window: system + messages
  3. LLM inference → tool_calls
  4. Save new assistant message to DB
  5. Execute tool calls (async, could take 1-30 minutes)
  6. Save tool results to DB
Step N+1:
  1. Load message history from DB  ← the state lives HERE
  2. LLM inference → continues where it left off
```

Zero tokens between steps 5 and 6. The agent is a DB record.

### Claude Code Dynamic Workflows

*"Progress is saved as the run goes, so a job that's interrupted picks up where it left off instead of starting over."* The orchestration layer saves the agent's state after every step. Subagents are separate conversation threads that can be serialized to storage and resumed without losing context. The `--resume sessionId` flag is the surface API.

The coordination layer (outside any agent's context window) tracks which subagents are active, paused, or done, and what each produced.

### Letta (MemGPT)

The most explicit about memory. Their architecture:
- **Memory blocks**: named, size-bounded sections of the context window — `persona`, `human`, and custom blocks editable by the agent via tool calls
- **All state in DB**: messages, tool calls, tool results, reasoning — even after context eviction
- **Archival memory**: all evicted messages stored forever, searchable via `conversation_search`
- **Sleep-time agents**: background agents that run asynchronously between user interactions to consolidate conversation history into memory blocks. Zero cost to the primary agent's active session.

### OpenAI

Two key primitives:
- **Background mode** (`background=true`): Fire inference, get a `response_id` immediately, poll for completion. The inference runs server-side. Client can disconnect/reconnect.
- **Conversations API**: A durable conversation object with its own ID. Survives across HTTP connections, devices, and jobs.
- **Context compaction**: `context_management` + `compact_threshold` — automatic summarization when context window fills, compacted summary replaces raw messages.

### The Common Pattern

All four platforms implement the same core architecture:
1. **Conversation as a durable DB object** — not an in-memory list
2. **Zero-cost waiting** — LLM inference stops when a tool is called; resumes when result arrives
3. **Context reconstruction** — full message history rebuilt from DB before each inference step
4. **Working memory** — key facts always present at context window top, survive compaction
5. **Archival search** — evicted history is retrievable when needed

---

## Part VI — Layer 1: The Cognitive Foundation (Agent Sessions)

This is the infrastructure layer. It makes individual agents persistent, memory-capable, and context-aware. Everything in Layer 2 depends on it.

### The AgentSession

An **AgentSession** is the persistent identity of an agent at work. It lives between LLM inference calls. It is a database record, not a running process.

```
AgentSession {
  id: string                    // stable across the entire task lifetime
  agentId: string               // which agent
  runId: string | null          // which workflow run (or null for chat-based)
  workspaceId: string
  status: 'idle' | 'active' | 'suspended' | 'waiting' | 'completed' | 'failed'
  
  // Memory blocks (editable by the agent via tools)
  personaBlock: string          // who I am, my capabilities, my style
  taskBlock: string             // what I'm trying to accomplish (updated by agent)
  planBlock: string             // my current plan and next steps (updated by agent)
  observationsBlock: string     // key findings accumulated (compacted periodically)
  
  // Message history (append-only, evict old to archival when context fills)
  messages: AgentMessage[]      // the last N messages — in context window
  archivalEnabled: boolean
  
  // Suspension state
  suspendReason: 'delegate' | 'await_event' | 'checkpoint' | 'sleep_until' | null
  suspendPayload: Record<string, unknown> | null
  suspendedAt: string | null
  wakeCondition: string | null  // "task_id:abc123" | "event:RUN_COMPLETED" | "time:ISO"
  
  // Context management
  totalSteps: number
  totalTokensIn: number
  totalTokensOut: number
  lastCompactionAt: string | null
  
  createdAt: string
  updatedAt: string
}
```

### The Step Model

A **step** is one complete thinking→doing cycle:

```
1. WAKE     Engine reconstructs context window from session state (DB read)
2. THINK    Single LLM inference call — ends when generation completes
3. PARSE    Engine parses the response:
              - text content → emit as AGENT_WORK_STEP events
              - tool_calls → classify:
                  · "engine tools" (delegate, broadcast, memory) → engine handles, may suspend
                  · "side-effect tools" (bash, file, http) → execute async
4. EXECUTE  All tool calls executed in parallel (zero tokens consumed here)
5. INJECT   Tool results injected as new messages in session
6. SAVE     Session state persisted to DB
7. DECIDE   Continue, suspend, or complete?
              → continue: loop to step 1 with tool results loaded
              → suspend: status = 'waiting', engine handles the trigger
              → complete: status = 'completed', output returned to engine
```

**The engine owns the loop.** Adapters no longer manage their own internal agent loop. They expose a single `executeStep()` call that does exactly one LLM inference and returns. The engine handles steps 3-7 and decides whether to fire another.

### The Memory Architecture

```
┌─────────────────────────────────────────────────────┐
│  CONTEXT WINDOW (rebuilt before every step)         │
│  ┌─────────────────────────────────────────────────┐ │
│  │ System Prompt (static: role, capabilities)      │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ MEMORY BLOCKS (working memory — always present) │ │
│  │ persona: "I am the Research Analyst agent..."   │ │
│  │ task:    "Analyze Q3 metrics for workspace X"   │ │
│  │ plan:    "1. Fetch raw data ✓ 2. Normalize..."  │ │
│  │ obs:     "Found anomaly in Jul 14 data..."      │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ RUN CONTEXT INJECTION                           │ │
│  │ Goal: "Produce Q3 investor report"              │ │
│  │ Completed: [Trigger, DataFetch]                 │ │
│  │ Running: [ResearchAgent (step 3)]               │ │
│  │ Live scratchpad: {key: value, ...}              │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────┐ │
│  │ RECENT MESSAGES (episodic — evictable)          │ │
│  │ [step 12] user: "focus on the Jul anomaly"      │ │
│  │ [step 13] tool: bash("grep Jul data.csv") → ... │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘

DATABASE (never deleted)
┌─────────────────────────────────────────────────────┐
│ ALL MESSAGES since session start                    │
│ Searchable via agentis.memory.search(query)         │
└─────────────────────────────────────────────────────┘
```

When the context window approaches its limit:
1. **Auto-compaction** (engine-triggered): Summarize the oldest 40% of messages into the `observations` block. Mark old messages as evicted.
2. **Sleep-time consolidation** (background): A lightweight `ConsolidatorService` runs after every K steps. It reads the last N messages, extracts key learnings, and updates the `plan` and `observations` blocks using a cheap fast model (Haiku, Mini). Runs between steps — zero cost to the active session.
3. **Agent-initiated compaction**: Agent calls `agentis.memory.compress()` when it decides context is noisy.

### The Five Yield Points (Where Agents Sleep)

At each yield point, the session is serialized and the engine takes over — no tokens, no process.

**Yield 1: `delegate_task`** — spawn a child agent and await its result.
```typescript
agentis.delegate_task({
  task: "Summarize the financial report",
  agentRole: "analyst",
  input: { documentUrl: "..." },
  timeout: 120_000,
})
// Engine: session → 'waiting', wakeCondition = 'task_id:{childId}'
// Child session completes → engine injects result as tool response → parent resumes
```

**Yield 2: `await_event`** — wait for a specific event on the bus without polling.
```typescript
agentis.await_event({
  event: "RUN_COMPLETED",
  filter: { runId: "run-xyz" },
  timeout: 3_600_000,
})
// Engine: subscribes to bus. Event fires → inject payload as tool response → resume.
```

**Yield 3: `request_approval`** — gate on human decision.
```typescript
agentis.request_approval({
  title: "About to delete 400 files",
  data: { files: [...] },
  expiresIn: 3_600_000,
})
// Engine: creates approval_requests row, emits APPROVAL_REQUESTED.
// Human approves in dashboard → session resumes with result injected.
```

**Yield 4: `sleep_until`** — time-based wake.
```typescript
agentis.sleep_until({ iso: "2026-06-02T09:00:00Z", reason: "Waiting for market open" })
// Engine: TriggerRuntime fires at ISO → session wakes. Zero tokens overnight.
```

**Yield 5: Long-running tool execution (implicit)** — when a skill_task or MCP tool is expected to take >5 seconds, the engine optionally suspends the parent session automatically. The agent doesn't call a special tool; the engine detects it.

### Agent Awareness of the Workflow

On every step, the agent receives a **run context injection** in its system messages:

```
You are part of workflow run {runId} (goal: "{workflowTitle}").
Your role in this run: {nodeTitle} — {nodeDescription}.

Current run state:
  Completed nodes: [Trigger, DataFetch, ...]
  Concurrently running: [ResearchAgent (step 3)], [DatabaseQuery (waiting)]
  Your predecessors' outputs: {inputData summary}
  
Shared scratchpad (live, readable):
  {key}: {value}
  
Tools available to you:
  agentis.delegate_task    — spawn a child agent and await its result
  agentis.broadcast        — write to the run's shared channel
  agentis.read_channel     — read messages from other agents
  agentis.request_approval — request human approval before continuing
  agentis.run_inspect      — inspect the current run's node states
  agentis.scratchpad_write — write live to the shared scratchpad
  agentis.memory_update    — update your own task/plan/observations blocks
  agentis.memory.search    — search your own archival message history
```

The agent is no longer blind. **This is the shift from function to agent.** It knows why it exists, what surrounds it, and has the vocabulary to act beyond its immediate task.

### The New Adapter Contract

V2 adapters expose a thinner interface — one LLM call, nothing else:

```typescript
interface SessionAdapter extends AgentAdapter {
  /**
   * Execute a single inference step.
   * Returns when the LLM finishes generating — NOT when tools are done.
   * The engine handles the loop, tool execution, and session persistence.
   */
  executeStep(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { maxTokens?: number; signal: AbortSignal },
  ): AsyncIterable<StepEvent>;
}

type StepEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; usage: TokenUsage; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' };
```

V1 adapters (`ClaudeCodeAdapter`, `HermesAgentAdapter`) keep their `dispatchTask()` interface for backward compatibility. The engine detects which interface an adapter implements and routes accordingly. Migration to `SessionAdapter` is per-adapter, voluntary.

---

## Part VII — Layer 2: The Workflow Primitives

These are built on top of the session infrastructure. They give the workflow graph new capabilities that only make sense because agents are now stateful and can yield.

### What "Semi-Deterministic" Actually Means

```
Today (fully deterministic):
  Human-designed graph → agents fill in the leaf tasks

Target (semi-deterministic):
  Human-designed skeleton → agents fill in the graph AS they work
     ↑ boundaries (budget, timeout, approval gates) still enforced by engine
```

The skeleton is:
- The **trigger** (what starts the run)
- The **goal** (what does done look like)
- The **resource envelope** (budget, agent pool, max duration)
- The **approval gates** (which decisions require a human)

Everything between those anchors is decided by agents at runtime.

### Primitive 1: `delegate_task` — Blocking Sub-Agent Call

The foundational unlock. Already described as Yield 1 above. The engine-level implementation:

```typescript
// New RunningContext additions for V1 adapter legacy path:
delegatePending: Map<childTaskId, {
  parentNodeId: string;
  parentTaskId: string;
  resolve: (output: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}>
delegationDepth: number  // hard cap at 8, prevents circular delegation
```

Child tasks have their own ledger sequence, cost tracking, and realtime events. Child cannot delegate back to an ancestor (lineage check before dispatch).

### Primitive 2: `loop` Node (Evaluator-Gated)

Routes execution back to an earlier node based on LLM judgment or structured condition:

```
draft_node → evaluator_node → PASS → continue
                             → FAIL → draft_node (with feedback injected)
                             → ESCALATE → human_checkpoint
```

```typescript
// WorkflowEngine.ts
case 'loop': {
  const maxIter = config.maxIterations ?? 5;  // hard cap, engine-enforced
  const iter = (ctx.state.loopCounters[node.id] ?? 0) + 1;
  if (iter > maxIter) {
    await this.#failNode(ctx, node.id, `loop exceeded ${maxIter} iterations`);
    return;
  }
  ctx.state.loopCounters[node.id] = iter;
  const verdict = await evaluateLoopCondition(config, inputData, deps.evaluatorRuntime);
  if (verdict.pass) {
    await this.#completeNode(ctx, node.id, { ...inputData, loopIterations: iter });
  } else {
    ctx.state.readyQueue.push({
      nodeId: config.backEdgeTarget,
      inputData: { ...inputData, feedback: verdict.feedback, iteration: iter },
    });
    void this.#tick(ctx);
  }
}
```

`RunningContext` gains `loopCounters: Record<nodeId, number>` (already tracked for serialization into `runState`).

### Primitive 3: `evaluator` Node (Quality Gate)

`EvaluatorRuntime` already exists in `services/evaluatorRuntime.ts`. Wire it:

```typescript
case 'evaluator': {
  const verdict = await deps.evaluatorRuntime.evaluate({
    content: inputData,
    criteria: config.criteria,
    scoreThreshold: config.passThreshold ?? 0.7,
  });
  const output = { ...inputData, score: verdict.score, passed: verdict.passed, feedback: verdict.feedback };
  if (!verdict.passed && config.onFailEdge) {
    ctx.state.forcedEdgeOverride[node.id] = config.onFailEdge;
  }
  await this.#completeNode(ctx, node.id, output);
}
```

Combined with the `loop` node: **self-correcting pipelines** without human intervention. Content doesn't complete until the evaluator scores it ≥ threshold. Three retries max; on the fourth failure, `APPROVAL_REQUESTED` goes to the human.

### Primitive 4: Agent Channel Bus

Two agents running concurrently in the same workflow run exchange information without waiting for node completion:

```typescript
await agentis.broadcast({ channel: "research_feed", message: { finding: "..." } })
const updates = await agentis.read_channel({ channel: "research_feed", since: cursor })
```

Backed by `ScratchpadService` extended with append-log: `appendChannel(runId, channel, msg)` + `readChannel(runId, channel, sinceSeq)`. The existing `SCRATCHPAD_WRITTEN` realtime event carries channel + payload. The `RunDrawer` shows an "Agent Comms" panel with chronological channel messages and node attribution.

**Three communication layers:**

| Layer | Mechanism | Use |
|---|---|---|
| 1 — Sequential data flow | Workflow edges (already works) | Node A output → Node B input |
| 2 — Live channel | Channel bus (new) | Broadcast across concurrent nodes, no wait |
| 3 — Blocking delegation | `delegate_task` yield (new) | Hand off task, wait for result |

### Primitive 5: `planner` Node (Dynamic Graph Construction)

A node where an LLM **outputs a subgraph** that gets injected into the live run via `applyGraphPatch()`:

```
trigger → planner_node → [dynamically-generated nodes] → artifact_collect
```

The planner node:
1. Calls the synthesis LLM (same pipeline as `draft-from-prompt`) with current run inputs + scratchpad
2. Receives back a `WorkflowGraph` fragment
3. Calls `validateWorkflowGraph()` on the fragment before applying (safety)
4. Calls `this.applyGraphPatch()`, wiring new nodes between the planner output and the terminal node
5. Emits `CANVAS_NODE_PLACED` + `CANVAS_EDGE_CONNECTED` for each new node (already handled by `AgentFocusOverlayManager`)
6. Completes with `{ generatedNodes: N, planRevision: newRevision }`

The human sees the plan **materialize on the canvas** in real time.

### Primitive 6: `dynamic_swarm` Node

Current `agent_swarm` requires a pre-existing array. `dynamic_swarm` lets an agent decide the task list at runtime:

```typescript
interface DynamicSwarmNodeConfig {
  kind: 'dynamic_swarm';
  plannerPrompt: string;         // must return { tasks: Array<{ prompt, input }> }
  maxTasks: number;              // hard cap, engine-enforced (default 200)
  maxParallel: number;           // concurrency cap (default 20)
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote' | 'evaluator_ranked';
  capabilityTags: string[];
  outputKey: string;
  evaluationCriteria?: string;   // optional evaluator pass over merged results
}
```

Engine flow:
1. Call planner agent with `plannerPrompt` + run inputs/scratchpad
2. Parse and validate `tasks` array length ≤ `maxTasks`
3. `BudgetService.checkAndReserve()` for the entire swarm estimate before any subtask fires
4. Fan out via existing `#dispatchSwarmSubtask()` pipeline
5. Optional `evaluatorRuntime` pass over merged results

**The swarm item count is decided by an agent. The safety ceiling is enforced by the engine.** This is the semi-deterministic contract.

---

## Part VIII — The Full Architecture: How the Layers Compose

### Today (deterministic):
```
trigger
  └─ agent_task [Researcher] (scratchpad snapshot at dispatch, done)
  └─ agent_task [Writer]     (reads Researcher's output from previous node)
  └─ agent_task [Reviewer]   (static review task)
  └─ done
```

### Target (semi-deterministic):
```
trigger
  └─ planner [Orchestrator agent decides the plan]
       └─ [dynamically injected nodes based on complexity]
            └─ dynamic_swarm [N parallel research tasks — N decided by planner]
                 └─ (each subtask can delegate_task to specialists)
                 └─ (each subtask broadcasts findings via channel bus)
            └─ coordinator [reads channel, synthesizes, evaluates with delegate_task]
            └─ evaluator [quality gate — score ≥ 0.85]
                 → PASS → artifact_collect
                 → FAIL → loop back to coordinator with feedback
                         [max 3 iterations before escalating to human]
  └─ checkpoint [human approval of final output]
```

The human set the goal. The agents determined the structure. The engine enforced the budget, tracked every decision, and kept all loops capped.

Each agent in this picture:
- Has a **persistent session** spanning all its steps
- Has **working memory** that accumulates and compresses across steps
- **Sleeps zero-cost** while waiting for tool calls, sub-tasks, or events
- Is **visible in real time** on the canvas and in the chat thread
- Can be **interrupted at any yield point** by the human or the budget guard

---

## Part IX — Competitive Position

| Capability | Claude Code | Codex | Letta | **Agentis V2** |
|---|---|---|---|---|
| Zero tokens while tools run | ✅ | ✅ | ✅ | ✅ |
| Session persists across steps | ✅ | ✅ | ✅ | ✅ |
| Agent updates its own memory | ❌ | ❌ | ✅ | ✅ |
| Archival memory search | ❌ | ❌ | ✅ | ✅ |
| Sleep-time consolidation | ❌ | ❌ | ✅ | ✅ |
| Agent sees workflow context | ❌ | ❌ | ❌ | ✅ |
| Agent can yield and resume | ✅ | ✅ | ✅ | ✅ |
| Agent can delegate subtasks | ✅ | ❌ | ✅ | ✅ |
| Agent can watch events | ❌ | ❌ | ❌ | ✅ |
| Cost-bounded execution | ❌ | ❌ | ❌ | ✅ |
| Full ledger of every step | ❌ | ❌ | ❌ | ✅ |
| Partial replay from any step | ❌ | ❌ | ❌ | ✅ |
| Canvas visualization of session | ❌ | ❌ | ❌ | ✅ |
| Dynamic graph generation | ✅ | ❌ | ❌ | ✅ |
| Self-correcting evaluation loop | ❌ | ❌ | ❌ | ✅ |

Claude Code, Codex, and Letta are black boxes that report success or failure. **Agentis is the only platform where autonomous execution is observable, cost-controlled, and replayable.**

### What Makes This a Moat

Every feature that makes Agentis a serious platform today gets **stronger** with autonomy:

| Feature | Why it's stronger with autonomous agents |
|---|---|
| **Ledger** | Every delegate call, loop iteration, and planner decision is a ledger event — full audit trail of autonomous decisions |
| **PartialReplay** | Can replay from any step in a planner-generated subgraph, not just human-designed nodes |
| **BudgetService** | Dynamic swarms have a budget cap before the first subtask fires — agents can't overspend |
| **ApprovalInbox** | Evaluator can escalate to human approval instead of looping — the human stays in control at the exception boundary |
| **Canvas** | Dynamically-generated nodes appear live on canvas — operators see the agent's plan materializing |
| **Realtime** | `NODE_STARTED/COMPLETED`, `SCRATCHPAD_WRITTEN`, `CANVAS_NODE_PLACED` — every autonomous decision has a realtime event |

---

## Part X — The Economics

**Current model for a 30-minute complex task:**
```
Adapter process open for 30 minutes
Tokens: ~100k (thinking + tools mixed continuously)
Cost: ~$5 (at Sonnet rates)
If task fails at minute 29: start over from scratch
```

**Session model for the same task:**
```
~40 steps, each 1-3 seconds of actual inference
Between steps: zero tokens (tools running, agent is a DB record)
Total LLM time: 4-5 minutes spread across 30 minutes
Tokens: ~100k (same total, but distributed across steps)
Cost: ~$5 (same)
If step 38 fails: resume from step 35 via PartialReplay
If budget is exceeded: agent yields at next step, asks for approval to continue
```

Same cost. Different outcomes:
- Failure is recoverable — no more "restart from scratch" at minute 29
- Each step is observable — ledger entry per step, not just per node
- Budget is enforceable at step granularity
- Multiple agents share live scratchpad state within a run
- Humans can review what the agent is thinking via memory blocks at any time

---

## Part XI — Implementation Plan

The two layers have a strict dependency: the cognitive foundation (Layer 1) must come before the workflow primitives (Layer 2) because delegate_task, broadcast, and memory_update are all engine tools that only work inside a session.

### Phase 0 — DB Foundation · 2 days

**New tables** in `packages/db/src/schema.ts`:
```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT REFERENCES workflow_runs(id),
  node_id TEXT,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  persona_block TEXT DEFAULT '',
  task_block TEXT DEFAULT '',
  plan_block TEXT DEFAULT '',
  observations_block TEXT DEFAULT '',
  total_steps INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  last_compaction_at TEXT,
  suspend_reason TEXT,
  suspend_payload TEXT,
  suspended_at TEXT,
  wake_condition TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  in_context_window INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_wake ON agent_sessions(wake_condition) WHERE status='waiting';
```

New `AgentSessionService` in `apps/api/src/services/agentSession.ts`:
- `create()`, `getOrCreate()` — create or resume a session
- `appendMessage()`, `updateMemoryBlock()` — write to session
- `suspend(reason, wakeCondition)`, `wake(wakePayload)` — lifecycle
- `reconstructContext(session) → ChatMessage[]` — the critical rebuild function
- `compactContext(sessionId) → CompactionResult`

---

### Phase 1 — SessionAdapter + Engine Step Loop · 4 days

**New interface** in `packages/core/src/types/adapter.ts`:
```typescript
interface SessionAdapter extends AgentAdapter {
  executeStep(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { maxTokens?: number; signal: AbortSignal },
  ): AsyncIterable<StepEvent>;
}
```

**New engine method** `#runAgentSession()` in `WorkflowEngine.ts`:
```typescript
async #runAgentSession(ctx, node, config, inputData) {
  const session = await this.deps.sessions.getOrCreate(
    config.agentId, ctx.runId, node.id
  );
  while (true) {
    const messages = this.deps.sessions.reconstructContext(session);
    const tools = this.#buildSessionTools(ctx, node, session);
    const result = await this.#executeOneStep(session, messages, tools, ctx);
    if (result.type === 'completed') { await this.#completeNode(ctx, node.id, result.output); return; }
    if (result.type === 'suspended') { return; }  // engine wakes session later
    if (result.type === 'continue')  { await this.deps.sessions.appendMessages(session.id, result.messages); continue; }
  }
}
```

`#executeOneStep()`: stream inference via `SessionAdapter.executeStep()` → collect text deltas (emit as `AGENT_WORK_STEP`) → on `tool_call`: classify engine vs side-effect → execute all in parallel → return `continue` | `suspended` | `completed`.

Adapt `ClaudeCodeAdapter` to also implement `executeStep()` via the Anthropic SDK directly (not the CLI). CLI path stays as legacy fallback.

---

### Phase 2 — Engine Tool Handlers + Blocking Delegation · 3 days

Wire all `agentis.*` tools as engine-owned during session execution.

**`agentis.delegate_task`**: Session suspends, child session dispatched, `wakeCondition = 'task_id:{childId}'`. For V1 (non-session) adapters: `delegatePending` map on `RunningContext`, same mechanic via `notifyTaskCompleted()`.

**`agentis.broadcast`** / **`agentis.read_channel`**: Channel bus via `ScratchpadService` append-log.

**`agentis.scratchpad_write`**: Live write to the run's scratchpad — visible to other agents on their next step.

**`agentis.memory_update`**: Agent updates its own `plan` or `observations` block.
```typescript
agentis.memory_update({ block: 'plan', content: '1. Analyze ✓\n2. Report (in progress)\n3. Review' })
```

**`agentis.memory.search`**: Search over archival messages (vector search when archival enabled, fulltext otherwise).

**`agentis.request_approval`**: Creates `approval_requests` row + suspends session.

**`agentis.run_inspect`**: Returns current run state (node statuses, concurrently running nodes, budget used) — read-only.

---

### Phase 3 — Loop + Evaluator Nodes · 2 days

1. Add `loopCounters: Record<nodeId, number>` and `forcedEdgeOverride: Record<nodeId, edgeId>` to `WorkflowRunState`
2. Implement `#executeLoop()` using `evaluatorRuntime` dep
3. Wire `EvaluatorRuntime` as `case 'evaluator':` node handler with failure edge routing
4. Add both to palette + ContextInspector Configure tab
5. Tests: 3-iteration loop with pass on final iteration

---

### Phase 4 — Context Compaction + Sleep-time Consolidation · 3 days

**Auto-compaction** in `#executeOneStep()`:
- Before reconstructing context, if `total_tokens_in > COMPACTION_THRESHOLD` (70% of model limit):
  - Take oldest 40% of messages
  - Call a cheap LLM: "Summarize these messages into bullet points preserving all decisions and findings"
  - Append summary to `observations_block`
  - Mark old messages `in_context_window = 0`

**`ConsolidatorService`** (new, background):
```typescript
class ConsolidatorService {
  async consolidate(sessionId: string): Promise<void> {
    const session = await this.deps.sessions.get(sessionId);
    const recent = await this.deps.sessions.getRecentMessages(sessionId, 50);
    const summary = await this.deps.fastLlm.complete(
      buildConsolidationPrompt(recent, session.observationsBlock)
    );
    await this.deps.sessions.updateMemoryBlock(sessionId, 'observations', summary);
    await this.deps.sessions.updateMemoryBlock(sessionId, 'plan', extractPlan(summary));
  }
}
```

Runs every K completed steps per session. Uses a fast/cheap model (Haiku, Mini). Triggered by step completion event from the bus.

---

### Phase 5 — Wake Pipeline · 2 days

Extend `TriggerRuntime` and watchdog to handle session wake conditions:

```typescript
bus.subscribe((msg) => {
  if (msg.envelope.event === REALTIME_EVENTS.NODE_COMPLETED) {
    const { taskId } = msg.envelope.payload;
    for (const session of sessionsWaitingFor(`task_id:${taskId}`)) {
      engine.wakeSession(session.id, { taskResult: msg.envelope.payload });
    }
  }
  // Also handle: event:*, time:*, task_id:*
});
```

`wakeSession(sessionId, wakePayload)`: load session → inject wake payload as tool result message → status → `'active'` → enqueue step execution.

---

### Phase 6 — `planner` Node · 3 days

1. `PlannerNodeConfig` type with `plannerPrompt` + `outputConnectToNodeId`
2. `#executePlannerNode()`: call `synthesisRuntime`, parse fragment, `validateWorkflowGraph()`, `applyGraphPatch()`, emit `CANVAS_NODE_PLACED` + `CANVAS_EDGE_CONNECTED` for each new node
3. Canvas subscribes to `CANVAS_NODE_PLACED` → animate node appearing (already handled by `AgentFocusOverlayManager`)
4. `RunDrawer` "Agent Decisions" tab shows the planner's generated JSON
5. Tests: planner generates 3 nodes, all 3 run, run completes

---

### Phase 7 — `dynamic_swarm` Node · 2 days

1. `DynamicSwarmNodeConfig` type (schema above)
2. `#dispatchDynamicSwarm()`: call planner agent → validate length ≤ `maxTasks` → `BudgetService.checkAndReserve()` for entire swarm → run existing `#dispatchSwarmSubtask()` pipeline
3. Optional `evaluatorRuntime` pass over merged results
4. Canvas shows "?" count during planning, actual count after
5. Tests: planner returns 5 tasks, all complete, `collect_all` merge

---

### Phase 8 — Backward Compatibility Bridge · 1 day

```typescript
// WorkflowEngine.ts — in #dispatchAgentTask:
const adapter = this.deps.adapters.get(agentId);
if (isSessionAdapter(adapter)) {
  return this.#runAgentSession(ctx, node, config, inputData);
} else {
  return this.#dispatchTaskLegacy(ctx, node, config, inputData);
}
```

V1 adapters continue to work without change.

---

### Phase 9 — UX Integration · 3 days (parallel: Chat + Canvas)

**Chat surface** (`ThreadView.tsx`, `ChatPanel.tsx`):
- When a conversation is associated with a run, thread view subscribes to `run(runId)` room
- `AGENT_WORK_STEP` events render as compact activity cards in the thread
- Inline run card shows: active agents, current node, step count, cost-so-far, agent `plan_block`
- When `agentis.request_approval` fires, `ConfirmationCard` appears inline — human approves in chat
- "View on Canvas" deep-link opens the live run

**Canvas overlay** (`WorkflowCanvasPage.tsx`, `RunDrawer.tsx`):
- `agent_task` nodes under session model show: step counter badge, memory block tooltip (plan_block)
- Delegation tree: child sessions as sub-nodes connected to parent on canvas
- Session suspension shows as amber "waiting" state on the node
- `planner` node completion: new nodes animate onto canvas as the graph grows
- `RunDrawer` "Agent Decisions" tab: delegation tree, channel messages, evaluator verdicts, planner output

**New palette nodes**: `planner` (⚡ Plan), `loop` (↺ Evaluate Loop), `evaluator` (◉ Quality Gate), `dynamic_swarm` (⟁ Dynamic Swarm)

---

### Implementation Dependency Graph

```
Phase 0 (DB + AgentSessionService)
  └─ Phase 1 (SessionAdapter + step loop)
       └─ Phase 2 (engine tool handlers + delegation)
            ├─ Phase 3 (loop + evaluator)   ← parallel with Phase 4
            ├─ Phase 4 (compaction + sleep-time)
            └─ Phase 5 (wake pipeline)
                 ├─ Phase 6 (planner node)
                 │    └─ Phase 7 (dynamic_swarm)
                 └─ Phase 8 (compat bridge)
                      └─ Phase 9 (UX: Chat + Canvas, in parallel)
```

### Total Estimate

| Phase | Description | Days |
|---|---|---|
| 0 | DB tables + AgentSessionService | 2 |
| 1 | SessionAdapter interface + engine step loop | 4 |
| 2 | Engine tool handlers (delegate, broadcast, scratchpad, memory, inspect) | 3 |
| 3 | Loop + Evaluator nodes | 2 |
| 4 | Context compaction + sleep-time consolidation | 3 |
| 5 | Wake pipeline + suspension index | 2 |
| 6 | Planner node | 3 |
| 7 | Dynamic swarm node | 2 |
| 8 | Backward compatibility bridge | 1 |
| 9 | UX — Chat + Canvas (parallel) | 3 |
| **Total** | | **~25 days** |

Phases 0-8 are pure backend. Phase 9 can be started in parallel with Phases 6-7 once the realtime events from Phase 2 are available.

---

## Part XII — What This Makes Possible

**True multi-day agents**: Delegate tasks on Monday, wake up Wednesday when they're done, synthesize Thursday. Zero tokens overnight.

**Agent as orchestrator**: An orchestrator session understands the entire workflow goal, delegates to workers, reads their broadcasts, and dynamically decides to continue, redirect, or escalate — with the human in the loop only when the agent decides human judgment is needed.

**Self-aware cost management**: An agent calls `agentis.run_inspect()` to see budget utilization, decides to compress its context or delegate expensive parts to cheaper specialized agents, and alerts the human if the task will cost more than expected.

**The terminal command example, fully solved**:
```
Step N:
  Agent calls agentis.skill_task({ skill: "bash", command: "npm run build:full" })
  
Yield: long-running tool → engine suspends session (DB record)
  
[15 minutes later, zero tokens spent]

Engine wakes session:
  Tool result injected: { stdout: "...", exitCode: 0 }
  
Step N+1:
  Agent reads build output, understands what succeeded and failed, continues:
  "Build succeeded. Now running the test suite..."
```

This is exactly what you observed in Codex and Antigravity. Now Agentis does the same — with every step in the ledger, every memory block update tracked, every delegation a first-class entity on the canvas, and the human able to pause, resume, or redirect at any yield point.

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| Runaway loops | `maxIterations` hard cap on `loop` nodes, engine-enforced |
| Runaway cost | `BudgetService.checkAndReserve()` before every subtask batch |
| Infinite delegation depth | `delegationDepth` counter on `RunningContext`, hard cap at 8 |
| Planner generates invalid graph | `validateWorkflowGraph()` called before `applyGraphPatch()` |
| Channel bus overwhelm | `appendChannel` rate-limits at 100 msgs/sec per run |
| Circular delegation | TaskId lineage check — child cannot delegate back to an ancestor |
| Context window overflow | Auto-compaction at 70% threshold before every step |
| Sleep-time consolidation cost | Uses cheap fast model (Haiku/Mini), runs between steps, not during |

---

## References

- [OpenAI Background Mode](https://developers.openai.com/api/docs/guides/background)
- [OpenAI Conversation State](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI Context Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Letta Stateful Agents](https://docs.letta.com/guides/core-concepts/stateful-agents/)
- [Letta Sleep-time Agents](https://docs.letta.com/guides/agents/architectures/sleeptime/)
- [Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Claude Code Dynamic Workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- [OpenAI Codex](https://openai.com/index/introducing-codex/)

---

## Implementation Log

### 2026-05-29 — Autonomous agent runtime (Phases 0–9)

Implemented the AgentSession runtime end-to-end. The engine now hosts persistent,
DB-backed agent identities that think across LLM calls, use tools, and park on
yield points without burning tokens while idle.

**What shipped (E2E, tested):**

- **AgentSession persistence (Phase 0).** New DB tables + `AgentSessionService`
  (CRUD + step append). A session is a durable identity that survives between
  LLM inferences; it consumes zero tokens while tools execute.
- **SessionAdapter contract + step loop (Phase 1).** `packages/core/.../session.ts`
  defines a stateless 1-method adapter (`executeStep(SessionStepInput) →
  SessionStepResult`). `AgentSessionRuntime` drives the
  WAKE → THINK → PARSE → EXECUTE → INJECT → SAVE → DECIDE loop. Memory blocks
  (persona/task/plan/observations) are rebuilt via `reconstructContext` each step.
- **Session tool handlers + blocking delegation (Phase 2).** Five yield points.
  `delegate_task` resolves **synchronously inline**; `await_event`, `sleep_until`,
  and `request_approval` **park** the session (run settles WAITING) and wake via
  engine bookkeeping (`sessionWaiters` / `setTimeout` / `pendingApprovals`).
- **Context compaction + sleep-time consolidation (Phase 4).** Auto-compaction
  before a step when the window crosses threshold; consolidation runs between
  steps on a cheap model.
- **Wake pipeline (Phase 5).** `notifySessionEvent`, timer wake, and task-result
  wake all re-tick the run and resume the parked node.
- **planner + dynamic_swarm nodes (Phases 6–7).** A planner decomposes a goal
  into steps; dynamic_swarm fans planned tasks out across workers with a merge
  strategy.
- **Compat bridge + bootstrap wiring (Phase 8).** Runtime is constructed and
  injected at bootstrap; the existing `agent_task`/`agent_swarm` paths are
  unchanged.
- **UX wiring (Phase 9).** Palette entries (`agent_session`, `dynamic_swarm`,
  `planner`) and ContextInspector forms + `KIND_LABEL`/`NODE_REASON` rationale
  for each. Web typecheck clean.

**Engine correctness fix (load-bearing):**

The `#tickBody` settle logic only held a run WAITING when a *downstream* node was
blocked on `waitingInputs`. A **terminal** parked node (an agent_session that
yields with nothing after it) had no downstream buffer, so the run wrongly
settled COMPLETED. Settle now also holds WAITING when any
`nodeState.status === 'WAITING'`. Verified safe against the three WAITING-assign
sites (session park, checkpoint, phase gate) — checkpoints/phase-gates already
carried downstream waitingInputs, so this only *adds* coverage for terminal
parks.

**Tests:**

- New `WorkflowEngine.agentSession.test.ts` (4 cases, all green): free-text
  completion; `memory_update` → `complete_task`; `sleep_until` wake; `await_event`
  resume via `notifySessionEvent`. Uses a small scripted `SessionAdapter` stub
  rather than scripting HTTP through the LLM adapter.
- Incidental fixture migration: `WorkflowEngine.fanout.test.ts` and
  `WorkflowEngine.graphPatch.test.ts` were stale relative to the in-flight
  skill→extension rename (`skillId` config + `skills:` dep). Migrated to
  `extensionId`+`operationName` config and the `extensions:` dep key. These were
  collateral of the rename, not the settle change (the errors fired at
  start/patch validation, before settle).
- Full engine suite: **97/97 green**. core + api + web typecheck clean.

**Intentionally deferred (not blocking the E2E path):**

- Planner `applyGraphPatch` splice (planner currently runs steps sequentially in
  one node rather than rewriting the live graph; the graph-patch API exists and
  is tested independently).
- Session restart-durability (resuming a parked session across a process
  restart — the wake registrations are in-memory).
- A dedicated `ConsolidatorService` (consolidation is inline in the runtime).

