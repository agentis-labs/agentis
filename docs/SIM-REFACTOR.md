# Sim Studio → Agentis Refactor Reference

> **Sources**: source-code analysis of `simstudioai/sim` (Apache 2.0, May 2026) + web/docs audit (July 2025)  
> **Architecture reference**: `docs/researches/R6-sim-studio-architecture.md` (full source-level deep dive)  
> **Status**: Living document — update each gap section as it ships

---

## Orientation

Sim Studio is the most structurally similar competitor to Agentis: workflow-as-DAG execution engine, block palette, agent blocks with LLM tool-calling, workspace-level data stores, MCP integration, deployment surfaces. Understanding exactly *how* Sim implements each feature lets Agentis avoid re-discovering the same design traps.

This document is organized differently from a typical gap list. Each gap includes:
1. **What Sim has** — product-visible capability
2. **Sim internals** — exact source files, data structures, and implementation patterns from the codebase
3. **Agentis status** — what exists today
4. **Agentis adaptation** — concrete DB schema, interfaces, and steps (not just "add X")
5. **Key decisions** — non-obvious design choices that must be made before building

---

## Agentis Differentiators (Do Not Copy Away)

Agentis capabilities that Sim lacks and must be deepened, not diluted:

| Differentiator | Sim Analogue | Why Agentis Wins |
|---|---|---|
| Agents as persistent entities (hierarchy, budget, goals, routines) | Stateless workflow nodes | Agentis models agents as first-class org members |
| Approval inbox with escalation chain | HITL block (no hierarchy) | Agentis escalates to supervisor via org chart |
| Docker sandbox skill runtime | isolated-vm only | Real container isolation per skill, not a V8 isolate |
| Gateway monitoring + channel bridge | Webhook triggers only | Unified inbound channel management |
| Deterministic ready-queue with topological ordering | Concurrent event-driven engine | Explicit ordering with reproducible audit trail |
| AgentisHub (planned) | Inline template gallery only | External skill/workflow marketplace |

---

## Core Architectural Patterns (Adopt These)

Before the gap catalog, eight implementation patterns discovered in Sim's source that Agentis should adopt directly. Each is referenced again in the relevant gap.

### P1 — Sentinel Node Injection (for loops and parallels)
Sim injects invisible "start sentinel" and "end sentinel" nodes around loop/parallel containers in the DAG. The execution engine never needs special-case container logic — it just processes sentinel nodes like any other node. The orchestrators (LoopOrchestrator, ParallelOrchestrator) handle all iteration logic inside the sentinel handlers.

Source: `apps/sim/executor/dag/builder.ts` → `LoopConstructor.execute()`, `ParallelConstructor.execute()`  
Nodes: `{loopId}_loop_start`, `{loopId}_loop_end`, `parallel_start_{parallelId}`, `parallel_end_{parallelId}`

**Adopt in Agentis**: inject sentinels during workflow serialization before passing to the engine.

### P2 — Variable Resolver Chain
A priority-ordered chain of resolvers replaces any if/else dispatch. Each resolver either matches a `<prefix.field>` template or passes through. First match wins. Chain order: LoopResolver → ParallelResolver → WorkflowResolver → EnvResolver → BlockResolver.

Source: `apps/sim/executor/variables/resolver.ts`

**Adopt in Agentis**: refactor current template resolution into this chain; add resolvers incrementally as new block types ship.

### P3 — Branch ID Suffixing for Parallelism
Parallel branches get unique block IDs by suffixing with a Unicode subscript: `blockId₍0₎`, `blockId₍1₎`. ExecutionState stays a flat map — no nested scopes. Cross-branch output lookup strips the suffix. This makes the engine branch-unaware; only the ParallelOrchestrator knows about branches.

Source: `apps/sim/executor/execution/state.ts` → `getBlockOutput(blockId, currentNodeId?)`  
Stripping logic: strip `₍N₎` or `_loopN` suffixes → normalized ID lookup

**Adopt in Agentis**: use `__branch_N__` delimiter if Unicode subscript is awkward in Agentis's ID space.

### P4 — Normalized Workflow Storage (3 tables, not 1 JSONB blob)
Sim stores workflow definitions in `workflowBlocks`, `workflowEdges`, and `workflowSubflows` — not a monolithic JSON column. The serializer flattens them at execution time. This enables per-block updates without rewriting the whole workflow, SQL queries on block types, and clean separation of live vs. deployed state.

**Adopt in Agentis**: migrate `workflow.definition_json` → normalized `workflow_nodes`, `workflow_edges`, `workflow_subflows` tables.

### P5 — Content-Hash Deduplication for Snapshots
`workflowExecutionSnapshots` stores a `stateHash` (content hash of the serialized state). Before inserting a new snapshot, Sim checks if the hash already exists. Repeated executions of the same workflow state don't duplicate storage.

Source: `packages/db/schema.ts` → `workflowExecutionSnapshots` (unique index on `workflowId + stateHash`)

**Adopt in Agentis**: hash the serialized `RunSnapshot` before storing; skip insert on collision.

### P6 — Pluggable Job Queue Backend
The `JobQueueBackend` interface has two implementations: `TriggerDevJobQueue` (cloud) and `DatabaseJobQueue` (DB polling). Selection is runtime-configured. The same workflow execution code runs in both modes.

Source: `apps/sim/lib/core/async-jobs/config.ts` — `getAsyncBackendType()`, `getJobQueue()`  
Interface: `enqueue(job, options?) → jobId`, `getStatus(jobId)`, `cancel(jobId)`

**Adopt in Agentis**: implement with `pg-boss` (Postgres) as the default backend; interface allows future cloud backend.

### P7 — Redis ZSET Event Buffer for SSE Streaming
Execution events are written to a Redis ZSET with monotonic sequence numbers. SSE readers call ZRANGEBYSCORE to get unseen events. TTL: 1 hour. This allows multiple subscribers, late joiners, and cross-pod delivery without a message broker.

Source: `apps/sim/lib/execution/event-buffer.ts`  
Keys: `execution:stream:{id}:events` (ZSET), `execution:stream:{id}:seq` (counter), `execution:stream:{id}:meta` (HSET)

**Adopt in Agentis**: implement the same Redis ZSET pattern for the WebSocket/SSE broadcast during runs. Fallback: in-memory EventEmitter if Redis is not configured.

### P8 — Generic Tool Handler + Registry Fallback
Sim has 15 dedicated handlers for core block types, then a `GenericBlockHandler` that covers all 200+ tool integrations via a block registry lookup. Adding a new tool integration requires only a block definition file — no new handler class.

Source: `apps/sim/executor/handlers/registry.ts` + `apps/sim/executor/handlers/generic/`

**Adopt in Agentis**: for API-only tool integrations, use a GenericBlockHandler backed by a tool registry. Code-first Docker skills remain for anything requiring real compute isolation.

---

## Category 1 — New Workflow Block Types

### GAP-01: Loop Block (container node)

**What Sim has**  
A container node that holds other blocks and runs them repeatedly. Four loop types:
- **for** — fixed iteration count (max 1,000)
- **forEach** — iterate over an array; array can be a literal or a `<blockId.field>` reference
- **while** — condition evaluated before each iteration in an isolated V8 sandbox
- **doWhile** — condition evaluated after each iteration; always runs at least once

Inside the loop, blocks reference `<loop.index>`, `<loop.currentItem>`, `<loop.items>`. After the loop, downstream blocks access `<blockId.results>` (array of all iteration outputs).

**Sim internals**

*Sentinel injection* (P1):
```
DAGBuilder injects:
  node: `{loopId}_loop_start`  (LoopStartSentinel)
  node: `{loopId}_loop_end`    (LoopEndSentinel)
```

*LoopScope data structure* (`apps/sim/executor/execution/state.ts`):
```typescript
interface LoopScope {
  iteration: number
  currentIterationOutputs: Map<string, NormalizedBlockOutput>
  allIterationOutputs: NormalizedBlockOutput[][]
  maxIterations?: number          // cap: 1000
  item?: any                      // current forEach item
  items?: any[]                   // full forEach collection
  condition?: string              // JS expression for while/doWhile
  loopType: 'for' | 'forEach' | 'while' | 'doWhile'
  skipFirstConditionCheck?: boolean  // doWhile
  validationError?: string
}
```

*Condition evaluation* (`apps/sim/executor/orchestrators/loop.ts`):
```typescript
const LOOP_CONDITION_TIMEOUT_MS = 5000
// Runs condition string in isolated-vm with pre-resolved block references
const result = await executeInIsolatedVM(condition, context, {
  timeout: LOOP_CONDITION_TIMEOUT_MS,
})
```

*Iteration lifecycle*:
1. Loop-start sentinel → `LoopOrchestrator.initializeLoopScope()`
2. Body blocks execute with LoopResolver providing `<loop.*>` references
3. Loop-end sentinel → evaluate continuation:
   - for/forEach: `iteration < maxIterations` or `iteration < items.length`
   - while/doWhile: isolated-vm evaluation of condition expression
4. Continue → reset `currentIterationOutputs`, increment `iteration`, re-enqueue start sentinel
5. Exit → emit `allIterationOutputs` as `results[]`, continue past end sentinel

*Empty loop handling*: empty `nodes[]` → logs error, sets `validationError`, throws to abort execution cleanly.

**Agentis status**  
No loop primitive. Recursive subflow patterns exist but are not ergonomic and don't expose `loop.index` / `loop.currentItem` as resolvable references.

**Agentis adaptation**

DB schema changes (normalized storage — P4):
```sql
-- Add to workflow_subflows (already exists or create):
CREATE TABLE workflow_subflows (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('loop', 'parallel')),
  config JSONB NOT NULL,  -- SerializedLoop | SerializedParallel
  created_at TIMESTAMP DEFAULT now()
);

-- config for type='loop':
-- { loopType, nodes[], iterations, forEachItems?, whileCondition?, doWhileCondition? }
```

Engine changes:
- `WorkflowEngine`: add `loopScopes: Map<string, LoopScope>` to ExecutionContext
- `DAGBuilder`: inject sentinel block entries during DAG construction
- `LoopOrchestrator`: new class handling sentinel node execution
- `VariableResolver`: add `LoopResolver` at position 0 in the chain (P2)
- For while/doWhile conditions: add `isolated-vm` or `vm2` sandbox (already may exist for Function blocks)

Canvas changes:
- ReactFlow parent nodes for loop containers (`parentId` + `extent: 'parent'`)
- "Loop" block type in the palette; config panel: loop type, iteration count / condition / array source
- Render iteration count badge on loop container during live run

**Key decisions**:
- isolated-vm vs. vm2 for condition evaluation: isolated-vm (V8 isolates, better security; Sim's choice)
- Block ID suffix for iteration-scoped outputs: use `_iter_N` suffix; strip on cross-loop reference lookup
- Max iteration cap: hardcode 1,000 for for/forEach; configurable (with plan limit) for while/doWhile

**Priority**: Tier 1 — required for batch processing, iterative refinement, retry patterns

---

### GAP-02: Variables Block (workflow-scoped state)

**What Sim has**  
A key-value store scoped to a single workflow run. Blocks read and write named variables during execution. Exposed as `<variables.key>` via the standard reference system. Used for counters, accumulators, loop state, and cross-branch shared values.

**Sim internals**

Source: `apps/sim/executor/handlers/variables-handler.ts`

`VariablesBlockHandler`:
- Operation enum: `read | write | update`
- Underlying store: `ExecutionContext.workflowVariables: Map<string, any>` — an in-memory map initialized at execution start from the workflow's `variables` JSON column
- `write` → `context.workflowVariables.set(key, resolvedValue)`
- `read` → `context.workflowVariables.get(key)` → emitted as block output
- `update` → supports atomic `+= value` and `-= value` for numeric counters
- The `WorkflowResolver` (`apps/sim/executor/variables/resolver.ts`) exposes all map entries as `<workflow.key>` references (not per-block-ID references)

`SerializedWorkflow.variables` stores the initial variable definitions:
```typescript
// In the workflow record:
variables: Record<string, { type: 'text'|'number'|'boolean'|'list'|'map', default?: any }>
```

**Agentis adaptation**

WorkflowEngine context addition:
```typescript
interface ExecutionContext {
  // existing fields...
  workflowVariables: Map<string, unknown>  // initialized from workflow.variables_config
}
```

New block type: `variables`
- Config: `operation: 'read' | 'write' | 'update'`, `key: string`, `value?: any`, `updateOp?: '+=' | '-='`
- Handler: `VariablesBlockHandler` — reads/writes `ctx.workflowVariables`
- Output: `{ value: any, key: string }`

Variable resolver addition (P2 chain position 3, before BlockResolver):
```typescript
// WorkflowResolver handles <workflow.key> → ctx.workflowVariables.get(key)
```

Variable definitions stored on `workflows` table:
```sql
ALTER TABLE workflows ADD COLUMN variables_config JSONB DEFAULT '{}';
-- { varName: { type: 'text'|'number'|'boolean'|'list'|'map', default?: any } }
```

**Priority**: Tier 1 — required to make Loop blocks useful; unlocks accumulator/counter patterns

---

### GAP-03: Wait / Delay Block

**What Sim has**  
An explicit time-delay primitive. Pauses execution for a configured duration before the next block begins. Used for rate-limiting, polling intervals, retry back-offs.

**Sim internals**

Source: `apps/sim/executor/handlers/wait-handler.ts`  
Config: `duration: number` (seconds) or `<blockId.field>` reference for dynamic duration  
Implementation: `await sleep(resolvedDuration * 1000)` inside the handler; not a separate scheduler  
Max duration: plan-gated; free tier capped at 300s  
Run state during wait: transitions to `waiting` status in `workflowExecutionLogs`

**Agentis adaptation**  
New block type: `wait`  
Config: `durationSeconds: number | string` (number literal or block reference)  
Handler: `WaitBlockHandler` — `await setTimeout(resolvedMs)` using `timers/promises`  
Free tier cap: 60s; paid cap: 600s (enforced in handler before sleep)

**Priority**: Tier 2 — useful for retry/rate-limit patterns; workarounds exist via Function blocks

---

### GAP-04: Response Block (explicit output terminator)

**What Sim has**  
Marks the explicit terminal output point of a workflow branch. When deployed as an API, the Response block output becomes the HTTP response body. Multiple Response blocks are allowed (success path vs. error path); the first one to execute wins (response output locking).

**Sim internals**

Source: `apps/sim/executor/handlers/response-handler.ts`, `apps/sim/executor/execution/engine.ts`

Response output locking:
```typescript
// In ExecutionEngine:
private responseOutputLocked = false

// In response handler completion:
if (!this.responseOutputLocked) {
  this.finalOutput = resolvedResponse
  this.responseOutputLocked = true
}
// Subsequent Response blocks in other branches are silently ignored
```

The Response block accepts a template string or JSON object with `<blockId.field>` references. Output becomes `workflow.response` in the execution result.

API execution routes check `result.response` vs `result.output` depending on whether the workflow has a Response block.

**Agentis adaptation**  
New block type: `response`  
Config: `content: string | object` (template with block references), `statusCode?: number`  
Engine change: add `responseLocked: boolean` to `ExecutionState`; first response block to complete sets the canonical output  
API execution: if workflow has a response block, use `executionResult.response` as the API response body; otherwise fall back to `executionResult.output`

**Priority**: Tier 1 — required precondition for API Deployment (GAP-16) and Chat Deployment (GAP-17)

---

### GAP-05: Guardrails Block (content safety and validation)

**What Sim has**  
Four validation modes:
1. **JSON Validation** — `JSON.parse` check; pass/fail with error string
2. **Regex Validation** — configurable pattern; match = pass or fail based on `passIfMatch` flag
3. **Hallucination Detection** — queries configured KB, scores AI output against retrieved chunks via LLM (0–10 confidence), passes if score ≥ threshold (default 3); outputs `score`, `reasoning`
4. **PII Detection** — Microsoft Presidio (Python sidecar); 30+ entity types across USA/UK/EU/APAC; two modes: Block (fail if found) or Mask (redact); outputs `detectedEntities`, `maskedText`

All modes output `<guardrails.passed>` boolean + `<guardrails.error>`.

**Sim internals**

Source: `apps/sim/executor/handlers/guardrails-handler.ts`, `apps/sim/app/api/guardrails/`  
JSON/Regex: pure CPU, no external deps  
Hallucination: calls KB service to retrieve top chunks, then calls LLM with grounding check prompt using structured output (JSON Schema strict mode) to extract `{ score: number, reasoning: string, passed: boolean }`  
PII: calls `POST /api/guardrails/pii` which proxies to a Python Presidio microservice; response includes entity list  
Block definition: `apps/sim/blocks/blocks/guardrails.ts`

**Agentis adaptation**

New block type: `guardrails`  
Config: `mode: 'json' | 'regex' | 'hallucination' | 'pii'`, mode-specific options  

V1 (no external deps): JSON + Regex modes only  
V2: Hallucination mode (requires KB — GAP-10)  
V3: PII mode — use `@presidio/analyzer` JS port or call a sidecar

Handler structure:
```typescript
class GuardrailsBlockHandler implements BlockHandler {
  async execute(ctx, block, inputs) {
    switch (inputs.mode) {
      case 'json': return this.validateJson(inputs.content)
      case 'regex': return this.validateRegex(inputs.content, inputs.pattern, inputs.passIfMatch)
      case 'hallucination': return this.checkHallucination(ctx, inputs)
      case 'pii': return this.detectPii(inputs.content, inputs.piiAction)
    }
  }
}
```

**Priority**: Tier 2 — JSON + Regex ship quickly; PII/hallucination deferred to V2/V3

---

### GAP-06: Evaluator Block (AI quality scoring)

**What Sim has**  
Sends content to an LLM for scoring against user-defined metrics. Each metric has a name, description, and numeric range (e.g., Accuracy 1–5). Uses JSON Schema strict mode for structured output. Outputs per-metric scores as `<evaluator.metricName>` and a summary `<evaluator.content>`.

**Sim internals**

Source: `apps/sim/executor/handlers/evaluator-handler.ts`  
Structured output enforcement: builds a JSON Schema from the metrics array:
```typescript
const schema = {
  type: 'object',
  properties: {
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number', minimum: metric.min, maximum: metric.max },
          reasoning: { type: 'string' }
        },
        required: ['name', 'score', 'reasoning']
      }
    },
    summary: { type: 'string' }
  }
}
// Sent as response_format.json_schema with strict: true (OpenAI) or equivalent
```

Calls `executeProviderRequest()` same as AgentBlockHandler — reuses the provider adapter system.  
Outputs: named score fields (one per metric), `summary`, `model`, `tokens`, `cost`.

**Agentis adaptation**

New block type: `evaluator`  
Config: `metrics: Array<{ name, description, min, max }>`, `model: string`, `content: string`  
Handler: builds JSON Schema from metrics → calls `LLMAdapter.complete()` with structured output → parses scores → emits as named outputs  
Uses existing `LLMAdapter` infrastructure — no new provider integration needed  
Output schema generated at serialization time from the metrics config

**Priority**: Tier 2 — straightforward given existing LLM adapter; high value for quality workflows

---

### GAP-07: Human in the Loop Block (first-class workflow primitive)

**What Sim has**  
A block that pauses execution indefinitely until a human responds via a generated portal:
- **Display Data**: JSON object showing context to the approver (references prior block outputs)
- **Notification channels**: Slack, Gmail, Teams, SMS (Twilio), Webhook
- **Resume Form**: JSON Schema defining fields the approver fills in; becomes typed block outputs
- **Auto-generated Approval Portal**: mobile-responsive UI at a unique token URL
- **Resume API**: `POST /api/resume/{workflowId}/{executionId}/{contextId}`
- API execute returns `_resume: { apiUrl, uiUrl, contextId, executionId, workflowId }` so callers know to poll

**Sim internals**

Source: `apps/sim/executor/handlers/hitl-handler.ts`, `apps/sim/executor/execution/engine.ts`, `apps/sim/app/api/resume/`

Pause flow:
```typescript
// HumanInTheLoopBlockHandler.execute() returns:
interface PauseMetadata {
  contextId: string          // UUID; used to match the resume request
  executionId: string
  workflowId: string
  resumeUrl: string
  notificationsSent: string[]
  loopScope?: SerializedLoopScope      // if paused inside a loop
  parallelScope?: SerializedParallelScope  // if paused inside a parallel
}

// ExecutionEngine detects PauseMetadata:
if (result instanceof PauseMetadata) {
  this.pausedBlocks.set(blockId, result)
  this.stoppedEarlyFlag = true
}
```

After engine completes:
```typescript
// handlePostExecutionPauseState():
const snapshot: SerializableExecutionState = {
  blockStates: serializeBlockStates(ctx.state),
  executedBlocks: [...ctx.state.executedBlocks],
  loopScopes: serializeLoopScopes(ctx),
  parallelScopes: serializeParallelScopes(ctx),
  dagIncomingEdges: serializeDagEdges(dag)
}
// Stored in `pausedExecutions` table:
// INSERT INTO paused_executions (executionId, workflowId, snapshotData, contextId, status)
```

Resume flow (`apps/sim/app/api/resume/[workflowId]/[executionId]/[contextId]/route.ts`):
1. Validate contextId matches `pausedExecutions` record
2. Store form data in `resumeQueue` (status: 'pending')
3. Background poller picks up → deserializes snapshot → re-runs DAGExecutor with:
   - `resumeFromSnapshot: true`
   - Pre-populated `blockStates` (all prior outputs restored)
   - HITL block output = the submitted form data

DB tables:
```sql
CREATE TABLE paused_executions (
  execution_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  snapshot_data JSONB NOT NULL,  -- SerializableExecutionState
  pause_points JSONB,            -- PauseMetadata per block
  context_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused',  -- paused|resuming|resumed|failed
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE resume_queue (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  form_data JSONB,
  status TEXT DEFAULT 'pending',  -- pending|processing|processed
  created_at TIMESTAMP DEFAULT now()
);
```

**Agentis status**  
Approval inbox (Paperclip) handles governance escalations. No general-purpose HITL block. No per-run resume form, no serializable execution state, no programmatic resume endpoint.

**Agentis adaptation**

1. Add `paused_runs` and `resume_queue` tables (schema above)
2. `WorkflowEngine`: add `pausedBlocks: Map<string, PauseMetadata>` to engine state; detect pause returns from handlers
3. Implement `SerializableRunState` (analogue to Sim's `SerializableExecutionState`); serialize after any pause
4. Add `human_in_the_loop` block type with `HumanInTheLoopBlockHandler`
5. Resume endpoint: `POST /runs/:runId/resume` — validate contextId, store form data, trigger resume via job queue
6. Resume portal UI: `/resume/:runId` page — fetches `pausedExecutions.pause_points.displayData`, renders form from JSON Schema, submits to resume endpoint
7. Security: resume token must be HMAC-signed and single-use; verify in the resume route before processing
8. Reuse channel bridge (Slack/email) for notifications

The existing approval inbox becomes a specialized HITL use case (governance escalation). This is the generalized version.

**Priority**: Tier 1 — production workflows need human review checkpoints

---

### GAP-08: Credential Block (canvas node for vault access)

**What Sim has**  
A workflow node that resolves a named secret from the credential vault at execution time and emits it as `<credential.value>` for downstream blocks. The credential never appears in the workflow definition.

**Sim internals**

Source: `apps/sim/executor/handlers/credential-handler.ts`  
`CredentialBlockHandler.execute()`: calls `credentialService.resolve(credentialId, workspaceId)` → decrypts → returns `{ value: decryptedSecret }`  
Redaction: `BlockExecutor` applies `redactApiKeys()` before logging block outputs; credential values are never persisted to logs  
The credential value is emitted only in memory as a block output, never stored in the DAG or logs

**Agentis adaptation**  
New block type: `credential`  
Config: `credentialId: string` (reference to CredentialVault entry)  
Handler: `CredentialBlockHandler` — calls existing `CredentialVault.resolve(id, workspaceId)`; emits `{ value }` as output  
Log safety: add to redaction pipeline — never log the `value` output of a credential block (redact in log writer)

**Priority**: Tier 3 — CredentialVault already handles the hard part; canvas-node ergonomics for power users

---

### GAP-09: Parallel Block (concurrent fan-out)

**What Sim has**  
A container node that runs its body blocks concurrently across multiple branches:
- **count** type — fixed number of branches (1–50)
- **collection** type — one branch per item in an array (similar to forEach but concurrent)

Inside a branch, blocks reference `<parallel.index>` and `<parallel.item>`. After completion, `<parallelId.results>` returns an array (one entry per branch) of all branch outputs.

**Sim internals**

Source: `apps/sim/executor/orchestrators/parallel.ts`

Branch ID suffixing (P3):
```typescript
// Each branch of a parallel gets block IDs suffixed with Unicode subscripts:
// blockId → blockId₍0₎, blockId₍1₎, blockId₍2₎
// ExecutionState.getBlockOutput() strips the suffix for cross-parallel reference lookup
```

ParallelScope:
```typescript
interface ParallelScope {
  parallelId: string
  totalBranches: number
  branchOutputs: Map<number, NormalizedBlockOutput[]>
  items?: any[]       // collection-based
  isEmpty?: boolean   // if collection is empty, skip all branches
}
```

Fan-out: parallel-start sentinel fires → ParallelOrchestrator creates N branch clones of each body block node in the DAG, enqueues all branch-0 start nodes simultaneously  
Fan-in: parallel-end sentinel waits until all branches have completed → aggregates `branchOutputs` → emits as `results[]`  
Nesting: loops inside parallels work because each branch has its own loop scope; branch suffix propagates into all nested block IDs

**Agentis adaptation**

DB: same as Loop — store in `workflow_subflows` table with `type='parallel'`  
Config: `{ parallelType: 'count'|'collection', count?: number, items?: any[]|string }`

Engine changes:
- `DAGBuilder`: inject parallel sentinels (P1)
- `ParallelOrchestrator`: new class handling parallel-start and parallel-end sentinel nodes
- Block ID suffixing: `blockId__branch_N__` delimiter (P3 adapted)
- `ParallelResolver`: add to resolver chain (P2) at position 1 (after LoopResolver)
- `ExecutionState.getBlockOutput()`: strip `__branch_N__` suffix for normalized lookup

**Priority**: Tier 1 — concurrent fan-out is required for many real-world AI workflows

---

## Category 2 — Data & Knowledge Infrastructure

### GAP-10: Tables (built-in structured data store)

**What Sim has**  
A first-class relational table store per workspace:
- Column types: Text, Number, Boolean, Date, JSON
- Full filtering (AND logic, per-column conditions) and multi-column sorting
- Table block in workflows: read / write / update / delete / query operations
- Row-level atomicity for concurrent workflow writes
- REST API (full CRUD on tables and rows)
- Rich keyboard shortcuts: navigation, range selection, clipboard, undo/redo
- Paste from spreadsheet for bulk import
- Plan limits: 3 tables / 1k rows (free) → 10k tables / 1M rows (enterprise)

**Sim internals**

Source: `apps/sim/lib/table/service.ts`, `packages/db/schema.ts`

DB schema:
```sql
CREATE TABLE user_table_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  columns JSONB NOT NULL,   -- ColumnDefinition[]
  created_at TIMESTAMP,
  archived_at TIMESTAMP
);

CREATE TABLE user_table_rows (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES user_table_definitions(id),
  workspace_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Column definition shape:
-- { id, name, type: 'text'|'number'|'boolean'|'date'|'json', required?, unique?, defaultValue? }
```

Key service patterns:
```typescript
// Per-transaction Postgres timeouts (prevents pool starvation under pgBouncer):
async function setTableTxTimeouts(trx) {
  await trx.execute(sql`SET LOCAL statement_timeout = '5000ms'`)
  await trx.execute(sql`SET LOCAL lock_timeout = '1000ms'`)
  await trx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '10000ms'`)
}

// Application-level unique enforcement (avoids leaking DB constraint errors):
const existing = await trx.select().from(userTableRows)
  .where(and(eq(userTableRows.tableId, tableId), /* column match */))
if (existing.length) throw new ConflictError('Unique constraint violated')
```

Filter / sort SQL builder: `buildFilterClause(filters: FilterOp[])` + `buildSortClause(sorts: SortOp[])` — dynamically constructs Drizzle WHERE / ORDER BY clauses.

Batch operations: `batchInsert(rows[])`, `batchUpdateById(updates[])`, `bulkDelete(ids[])`, `replaceRows(tableId, rows[])` — all atomic.

**Agentis status**  
No workspace-level structured data store. Agents write to external databases via API blocks or skills.

**Agentis adaptation**

DB (SQLite for dev, Postgres for prod — same schema):
```sql
CREATE TABLE workspace_table_definitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  columns TEXT NOT NULL,  -- JSON: ColumnDefinition[]
  archived_at INTEGER,    -- Unix ms, null = not archived
  created_at INTEGER DEFAULT (unixepoch('now') * 1000)
);

CREATE TABLE workspace_table_rows (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  table_id TEXT NOT NULL REFERENCES workspace_table_definitions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  data TEXT NOT NULL,     -- JSON: Record<columnId, value>
  created_at INTEGER DEFAULT (unixepoch('now') * 1000),
  updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
);
```

Service: `apps/api/src/services/tables.ts` — CRUD, column type validation, filter/sort query builder  
Routes: `apps/api/src/routes/tables.ts` — `GET/POST /tables`, `GET/POST/PATCH/DELETE /tables/:id/rows`  
Block type: `table` — operations: `read`, `insert`, `update`, `delete`, `query`  
Table block output: `{ rows: any[], count: number, error?: string }`

**Key decisions**:
- SQLite JSON functions (`json_extract`) for column-level filtering in dev
- Row size limit: 128KB per row to prevent unbounded storage
- Unique enforcement: application-level check before insert (same as Sim)

**Agentis UI positioning — "Agent Ledger" not spreadsheet**:

Sim's Tables UI is a full editable spreadsheet (inline cell editing, keyboard shortcuts, paste from clipboard, column header menus). This positions Sim as a database tool with agents. Agentis should not copy this framing.

Instead, ship a **read-only Agent Ledger view**:
- Grid layout: rows written by agents, columns from the table definition
- Columns: filterable by `agent_id`, `workflow_id`, `run_id`, timestamp
- Toolbar: filter, sort by column, export to CSV — no inline editing
- Each row shows which agent/run produced it (linkable to run detail)
- Edit operations remain available but via a dedicated row detail panel, not inline

The write surface (insert/update/delete) lives entirely in the workflow canvas via the `table` block. Humans inspect; agents write. This is ~2 days of UI work instead of 8 and keeps the narrative: *"Agentis is where agents work; Tables is where you see what they did."*

UI files:
- `LedgerPage.tsx` — read-only grid (TanStack Table), filter toolbar, export button
- Sidebar label: **"Ledger"** (not "Tables") to reinforce the agent-output framing

**Priority**: Tier 1 — fundamental data primitive; many agent workflows need persistent structured output

---

### GAP-11: Knowledge Base (RAG / vector document store)

**What Sim has**  
Per-workspace vector document store backed by pgvector:
- File types: PDF, DOCX, TXT, MD, HTML, XLS, PPT, CSV, JSON, YAML (up to 100MB)
- OCR: Azure or Mistral OCR for scanned PDFs
- Chunking: configurable (max chunk 100–4000 tokens, min 100–2000 chars, overlap 0–500 tokens)
- Chunk editing: view/edit/merge/split/add metadata post-processing
- Vector search: `ORDER BY embedding <=> query_vector LIMIT topK` (pgvector cosine distance)
- Knowledge block: semantic search at execution time, returns `results[]` with content + similarity score
- Connectors: Google Drive, Confluence, etc. sync via `knowledgeConnector` table

**Sim internals**

Source: `apps/sim/lib/knowledge/service.ts`, `packages/db/schema.ts`

DB schema:
```sql
CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  chunking_config JSONB NOT NULL  -- { maxChunkSize, minChunkSize, overlap }
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  name TEXT NOT NULL,
  content TEXT,
  token_count INTEGER,
  status TEXT,   -- processing|ready|error
  archived_at TIMESTAMP
);

CREATE TABLE embeddings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(dimensions),   -- pgvector type
  metadata JSONB
);
```

Search query:
```sql
SELECT e.content, e.metadata,
       1 - (e.embedding <=> $queryVector) AS similarity
FROM embeddings e
JOIN documents d ON d.id = e.document_id
WHERE d.knowledge_base_id = $kbId
  AND d.status = 'ready'
  AND d.archived_at IS NULL
ORDER BY e.embedding <=> $queryVector
LIMIT $topK;
```

Conflict detection:
```typescript
class KnowledgeBaseConflictError extends Error {
  code = 'KNOWLEDGE_BASE_EXISTS'
}
```

**Agentis adaptation**

V1 — SQLite + sqlite-vec (dev/self-hosted):
```sql
CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dimension INTEGER NOT NULL DEFAULT 1536,
  chunking_config TEXT NOT NULL DEFAULT '{"maxChunkSize":1024,"minChunkSize":100,"overlap":200}'
);

CREATE TABLE kb_documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  name TEXT NOT NULL,
  token_count INTEGER,
  status TEXT DEFAULT 'pending',  -- pending|processing|ready|error
  created_at INTEGER DEFAULT (unixepoch('now') * 1000)
);

-- sqlite-vec virtual table for embeddings:
CREATE VIRTUAL TABLE kb_embeddings USING vec0(
  embedding FLOAT[1536]
);
-- Companion metadata table:
CREATE TABLE kb_embedding_meta (
  rowid INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT   -- JSON
);
```

V2 — Postgres + pgvector (cloud): same schema, use `VECTOR(1536)` Drizzle type.

Abstraction:
```typescript
interface VectorStore {
  upsertEmbedding(id: string, vector: number[], meta: ChunkMeta): Promise<void>
  search(queryVector: number[], kbId: string, topK: number): Promise<SearchResult[]>
  deleteByDocument(documentId: string): Promise<void>
}
// Implementations: SqliteVecStore, PgvectorStore
```

Service: `apps/api/src/services/knowledgeBase.ts` — upload → parse → chunk → embed → store  
Parser support V1: PDF (`pdfjs-dist`), TXT, MD, JSON, CSV  
Block type: `knowledge` — config: `kbId`, `query`, `topK`; output: `results[]`  
Routes: `POST /knowledge-bases`, `POST /knowledge-bases/:id/documents`, `GET /knowledge-bases/:id/search`

**Priority**: Tier 1 — RAG is table-stakes for production AI; agents without grounded knowledge are toys

---

### GAP-12: Files System (shared workspace storage)

**What Sim has**  
Shared file store for the entire workspace. Upload files (documents, images, media). Renderers: PDF viewer, image gallery. Accessible from any workflow via file references.

**Sim internals**

Source: `packages/db/schema.ts` → `workspaceFiles` table  
Schema: `{ id, workspaceId, name, size, mimeType, storageKey, createdAt }`  
Storage backend: S3-compatible (configured via `STORAGE_*` env vars)  
Access: presigned URL generation via `GET /api/files/:id`  
Plan limits: 5GB free → 500GB Max

**Agentis adaptation**

DB:
```sql
CREATE TABLE workspace_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,  -- relative path in local or S3 bucket
  created_at INTEGER DEFAULT (unixepoch('now') * 1000)
);
```

Storage abstraction:
```typescript
interface FileStorage {
  put(key: string, data: Buffer, mimeType: string): Promise<void>
  getUrl(key: string, expiresInSeconds: number): Promise<string>  // presigned or local proxy URL
  delete(key: string): Promise<void>
}
// Implementations: LocalFileStorage (dev), S3FileStorage (prod)
```

Routes: `POST /files` (multipart), `GET /files`, `GET /files/:id/url`  
UI: `FilesPage.tsx` — list with type icons, upload drop zone (react-dropzone), inline PDF preview (react-pdf)  
File reference in workflows: pass `<files.fileId>` as agent context or API block attachment

**Priority**: Tier 2 — important for document workflows; many workflows start without it

---

## Category 3 — AI Agent Capabilities

### GAP-13: Agent Memory Modes

**What Sim has**  
Four per-agent-block memory configurations:
1. **none** — stateless
2. **conversation** — full message history by conversationId; persists across runs
3. **sliding_window_messages** — last N messages
4. **sliding_window_tokens** — messages kept up to a token budget

**Sim internals**

Source: `apps/sim/executor/handlers/agent/agent-handler.ts` → `buildMessages()`  
Persistent storage: `memory` table — `{ workspaceId, workflowId, conversationId, messages: JSONB }`  
`memoryService.getMessages(workspaceId, workflowId, conversationId)` → filters by mode → returns trimmed history  
Token counting: provider-specific tiktoken wrappers; approximate fallback (4 chars/token) for unsupported models  
Windowing is applied after retrieval, before building the messages array for the LLM call

**Agentis adaptation**

Add `memoryMode` to agent block config:
```typescript
interface AgentMemoryConfig {
  mode: 'none' | 'conversation' | 'sliding_window_messages' | 'sliding_window_tokens'
  conversationId?: string   // defaults to runId if omitted
  maxMessages?: number      // for sliding_window_messages
  maxTokens?: number        // for sliding_window_tokens
}
```

Existing `agent_memory` (or equivalent) table already stores history; add windowing logic to the retrieval step.  
Default: `conversation` (backward compatible).

**Priority**: Tier 2 — explicit context window control is important for cost management in production

---

### GAP-14: Structured Output Enforcement

**What Sim has**  
Per-agent-block JSON Schema for output format. The LLM is called with strict structured output. Downstream blocks access fields as `<agent.fieldName>` rather than parsing `<agent.content>`.

**Sim internals**

Source: `apps/sim/executor/handlers/agent/agent-handler.ts` → `parseResponseFormat()`  
OpenAI: `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`  
Anthropic: tool-calling trick (pass schema as a single tool, force tool use)  
Google: `generationConfig.responseSchema`  
Parsed response: `JSON.parse(content)` → validate against schema → expose top-level keys as named outputs  
Fallback: if provider doesn't support structured output, attempt JSON.parse; set `parseError` output flag if it fails

**Agentis adaptation**

Add `outputSchema` (JSON Schema) to agent block config.  
In `LLMAdapter.complete()`: if `outputSchema` is provided, inject structured output mode per provider.  
Parser step after response: `JSON.parse(content)` → emit each top-level key as a named block output.  
UI: JSON Schema editor widget in agent block config panel (CodeMirror with JSON validation).

**Priority**: Tier 2 — eliminates brittle `JSON.parse` hacks in downstream blocks; enables reliable data pipelines

---

### GAP-15: Per-Model Reasoning Effort Control

**What Sim has**  
Per-agent reasoning configuration:
- OpenAI o-series: `reasoning_effort: 'low' | 'medium' | 'high'`
- Claude 3.7+ extended thinking: `thinking.type = 'enabled'`, `thinking.budget_tokens`
- Gemini 2.x: thinking mode toggle with token budget

**Sim internals**

Source: `apps/sim/executor/handlers/agent/agent-handler.ts` → `buildProviderRequest()`  
Config stored as `canonicalModes` in `SerializedBlock` metadata  
Each provider adapter checks for `reasoningConfig` field and maps to its native API parameter

**Agentis adaptation**

Add `reasoningConfig` to agent block config (optional field, shown only for supporting models):
```typescript
interface ReasoningConfig {
  effort?: 'low' | 'medium' | 'high'         // OpenAI o-series
  thinkingEnabled?: boolean                   // Claude / Gemini
  budgetTokens?: number                       // Claude extended thinking
}
```

Pass to LLM adapters; each adapter translates to native API params.

**Priority**: Tier 3 — power user feature; defaults are sufficient for most workflows

---

### GAP-16: Expanded Tool Ecosystem

**What Sim has**  
200+ tool integrations: Airtable, Algolia, Apollo, Asana, GitHub, Gmail, Google Calendar, HubSpot, Jira, Linear, Notion, Salesforce, Slack, Stripe, Twilio, Zendesk, etc. Plus A2A, AgentMail, AgentPhone.

**Agentis adaptation**  
Agentis's code-first Docker skill model is a deliberate differentiator (real container isolation vs. config-driven API calls). Strategy:
- Build AgentisHub **skill template library** with pre-built skill implementations for top tools
- MCP tool consumption (GAP-21) provides access to the full MCP ecosystem
- For simple API-only integrations, use a GenericBlockHandler backed by an integration registry (P8)

**Priority**: Tier 4 — addressed via AgentisHub + MCP; not a direct copy

---

## Category 4 — Deployment & Integration

### GAP-17: API Deployment (workflow as REST endpoint)

**What Sim has**  
Deploy any workflow as a versioned external REST API:
- Sync (JSON response), streaming (SSE), and async (job ID + poll) modes
- HITL runs return `_resume: { apiUrl, uiUrl, contextId }` instead of final output
- Versioned snapshots: deploying a new version doesn't break existing callers
- Auto-generated docs from workflow input schema

**Sim internals**

Source: `apps/sim/app/api/workflows/[id]/execute/route.ts`

Key design:
```typescript
// Execution mode routing:
const shouldRunInline = shouldExecuteInline(workflow, requestBody)  // fast workflows
const queue = shouldRunInline ? null : getJobQueue()

// Streaming response headers:
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
}

// Call chain anti-circular:
const callChain = parseCallChain(request.headers)
validateCallChain(callChain, workflowId)  // prevents workflow-A calling workflow-A
const nextChain = buildNextCallChain(callChain, workflowId)
```

Deployed state: loaded from `workflowDeploymentVersion` table (immutable snapshot at deploy time)  
Live state: loaded from normalized `workflowBlocks`/`workflowEdges` tables (draft editing state)  
`useDraftState` flag on the execute request switches between the two

Deployed workflow creates a versioned snapshot:
```sql
CREATE TABLE workflow_deployment_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,  -- serialized SerializedWorkflow at deploy time
  deployed_at TIMESTAMP,
  deployed_by TEXT
);
```

**Agentis adaptation**

1. Add `workflow_deployments` table (version snapshot, apiKey, inputSchema, outputSchema)
2. `POST /workflows/:id/deploy` → serialize current workflow state → create deployment record → return `deploymentId + apiKey`
3. `POST /d/:deploymentId` — public execution endpoint:
   - Validate API key against deployment record
   - Load immutable deployment snapshot
   - Execute via WorkflowEngine (inline or async based on workflow complexity)
   - Response: `{ output }` (sync), SSE stream (streaming), or `{ runId }` (async)
4. Anti-circular call chain: include `X-Workflow-Call-Chain` header; validate before execution
5. Response block output (GAP-04) maps to HTTP response body
6. UI: "Deploy" button → modal with deployment URL + API key + code snippets

**Priority**: Tier 1 — makes Agentis workflows consumable by external systems; B2B fundamental

---

### GAP-18: Chat Deployment (workflow as embeddable chat)

**What Sim has**  
Deploy a workflow as an embeddable chat interface. Generates a shareable URL and `<iframe>` snippet. Custom branding. Conversational loop built on API Deployment.

**Agentis adaptation**  
Build on API Deployment:
- Add `chatMode: boolean` + `branding: { name, color, logo? }` to deployment config
- `/chat/:deploymentId` route in web app — standalone chat UI (no sidebar, no auth required by default)
- Messages POST to the deployment endpoint with a session conversationId
- Embed snippet: `<iframe src="...">` with optional API key and theme params
- The workflow must include a Response block (GAP-04) for the chat to know what to render

**Priority**: Tier 2 — high-value for customer-facing demos; trivial to add after GAP-17

---

### GAP-19: Workflow as MCP Tool (bidirectional MCP)

**What Sim has**  
Two directions — consume and expose:

**Consume**: MCP server URL configured in Agent block settings → `tools/list` called at runtime → tools merged with native tools for LLM

**Expose**:
- Workspace MCP server registry (`mcpServers` table)
- Add deployed workflows as tools with name, description, parameter descriptions
- `GET /api/mcp/:serverId` — JSON-RPC 2.0 SSE endpoint implementing MCP protocol
- `tools/list` → returns all tools attached to this server
- `tools/call` → executes the target workflow deployment → returns result as tool output
- Auth: `X-API-Key` header or public access
- Ready-to-paste config for Claude Desktop, Cursor, VS Code, Windsurf

**Sim internals**

Source: `apps/sim/lib/mcp/service.ts`, `apps/sim/lib/mcp/client.ts`, `apps/sim/app/api/mcp/`

SSRF protection on MCP server URL registration:
```typescript
function validateMcpServerSsrf(url: string): void {
  const parsed = new URL(url)
  const privateRanges = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./, /^::1$/]
  if (privateRanges.some(r => r.test(parsed.hostname))) {
    throw new McpSsrfError('MCP server URL points to a private IP range')
  }
}
```

Caching: tool lists cached in Redis (or memory) with `MCP_CONSTANTS.CACHE_TIMEOUT` TTL; invalidated when connection state changes.

MCP protocol server endpoint (standard JSON-RPC 2.0):
```typescript
// tools/list response shape:
{ tools: [{ name, description, inputSchema: JSONSchema }] }

// tools/call request:
{ method: 'tools/call', params: { name: string, arguments: Record<string, any> } }
// → execute matching workflow deployment
// → return: { content: [{ type: 'text', text: JSON.stringify(output) }] }
```

**Agentis adaptation**

Phase 1 — Consume MCP tools in workflows:
- Add MCP server config to workspace settings (table: `mcp_servers`)
- Agent block config: select MCP servers to activate
- At runtime: `McpClient.listTools()` → merge into available tools
- Use `@modelcontextprotocol/sdk` (TypeScript client)
- SSRF validation on server URL registration

Phase 2 — Expose workflows as MCP tools:
- MCP server registry: `mcp_servers` table + `mcp_server_tools` (maps workflows to server as tools)
- `GET /mcp/:serverId` SSE endpoint implementing JSON-RPC 2.0 MCP protocol
- `tools/list` → DB query for all tools attached to this server
- `tools/call` → find workflow deployment → execute → return output
- Auth: API key validation (`X-MCP-API-Key` header)

DB schema:
```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,          -- for inbound servers (consume)
  api_key TEXT,      -- encrypted; for outbound servers (expose)
  type TEXT NOT NULL CHECK(type IN ('inbound', 'outbound'))
);

CREATE TABLE mcp_server_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id),
  workflow_deployment_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  parameter_descriptions TEXT   -- JSON
);
```

**Priority**: Tier 1 — MCP is the emerging standard for AI tool interop; Agentis without MCP is ecosystem-isolated

---

### GAP-20: Rich Trigger Ecosystem

**What Sim has**  
30+ typed, schema-validated trigger sources beyond schedule and webhook: GitHub, Gmail, Slack, Linear, Stripe, Typeform, Calendly, HubSpot, Notion, Salesforce, and many more. Each trigger validates signatures (HMAC, Stripe-Signature, etc.) and filters event types.

**Agentis adaptation**

Extend the existing webhook handler with typed connectors:
- Generic webhook receiver already exists; add a `connector` registry:
  ```typescript
  interface TriggerConnector {
    id: string
    name: string
    verifySignature(request: Request, secret: string): boolean
    parseEventType(payload: unknown): string
    payloadSchema: ZodSchema
  }
  ```
- Per-connector config in workflow trigger settings: secret, event type filter
- V1 priority connectors: GitHub, Slack, Linear, Stripe, Typeform, Gmail

**Priority**: Tier 2 — typed connectors are production reliability essentials; start with top 6

---

## Category 5 — Workspace & UX

### GAP-21: Mothership / NL Workspace Command Center

**What Sim has**  
Natural language command center over the entire workspace — not a chatbot. Builds workflows, queries tables and knowledge bases, manages files, runs research, triggers automation. Powered by parallel subagents. Features: @-reference autocomplete, OTel trace spans for Mothership operations.

**Agentis adaptation**  
Build a `workspace command agent` powered by Agentis's own skill/agent primitives:
- Tool set: `list_workflows`, `create_workflow`, `run_workflow`, `query_table`, `search_knowledge`, `list_runs`, `get_run_detail`, `create_agent`
- Chat panel in UI with @-reference autocomplete
- Thinking UI showing tool calls in real-time
- This is Agentis's dogfooding story: the command center IS an agent built on Agentis's own primitives

**Priority**: Tier 3 — needs Tables + KB + Deployment to be meaningful; high differentiation once those ship

---

### GAP-22: Copilot (NL Workflow Builder)

**What Sim has**  
Canvas-integrated AI assistant that builds and edits workflows from NL description. Cloud-managed intelligence (even for self-hosted). @-reference autocomplete. Reasoning levels.

**Sim internals**

Source: `apps/sim/app/api/copilot/`, `apps/sim/lib/copilot/`  
Key insight: Copilot calls a **Sim-managed cloud endpoint** even for self-hosted installations. The cloud service handles LLM calls and tool routing. Self-hosters get UI but depend on Sim's infrastructure.

Copilot tools (`lib/copilot/tools/handlers/`): `create_workflow`, `update_workflow`, `deploy_workflow`, `get_workflow_state`, `run_workflow`, `list_workspaces`, `query_knowledge_base`, `query_table`

Async continuations for long-running tools: Copilot issues a tool call → gets back a pending ID → checkpoint saved → background job runs the tool → client reconnects at checkpoint to continue conversation

**Agentis adaptation**  
Add a canvas Copilot panel that uses Agentis's own agent infrastructure (not a cloud dependency):
- Tools: `addBlock(type, config)`, `connectBlocks(a, b)`, `editBlock(id, patch)`, `removeBlock(id)`, `getWorkflow()`, `runWorkflow()`
- V1: generate draft workflow from NL description; V2: edit mode with diff preview; V3: error diagnosis and auto-fix
- Uses Agentis's own LLM adapters — zero external cloud dependency (differentiator vs. Sim)

**Priority**: Tier 3 — requires stable block model first; major UX differentiator

---

### GAP-23: Real-time Multiplayer Collaboration

**What Sim has**  
Socket.IO broadcast server. Live cursors, presence indicators, concurrent editing (last-write-wins per block field — NOT CRDT). Separate `apps/realtime` process.

**Sim internals**

Source: `apps/realtime/src/index.ts`

Architecture:
```
createServer() → Node HTTP server
createSocketIOServer(httpServer) → Socket.IO + Redis adapter (multi-pod) or memory (single-pod)
createRoomManager(io):
  REDIS_URL → RedisRoomManager (room state in Redis hashes, cross-pod events via Redis pub/sub)
  else → MemoryRoomManager (single-pod)
io.use(authenticateSocket)   ← JWT/session validation
```

Each workflow = a room. Multiple users editing the same workflow join the same room.  
Conflict resolution: last-write-wins (no CRDT). Client-side undo stack via Zustand middleware.

**Agentis adaptation**  
Agentis should use **Yjs CRDT** rather than Sim's broadcast approach for stronger consistency:
- Extend existing WebSocket server with a canvas sync channel
- `yjs` for canvas state (blocks, edges, positions as a Yjs document)
- `y-websocket` provider for browser ↔ server sync
- Presence: broadcast cursor + user info as Yjs awareness state
- Redis adapter for multi-pod (same pattern as Sim but with Yjs instead of custom broadcast)

**Priority**: Tier 3 — requires infra work; Yjs makes conflict resolution automatic

---

### GAP-24: Workflow Templates Library

**What Sim has**  
11+ complete workflow templates ready to customize. Stored in DB (`templates` table with full workflow state JSON).

**Agentis adaptation**  
Seed of AgentisHub. V1:
- Static template definitions (JSON files in `apps/api/src/data/templates/`)
- "New Workflow from Template" flow in canvas
- 5–8 templates exercising Agentis differentiators (approval workflows, budget controls, skill sandboxing)
- Templates migrated to AgentisHub marketplace when it ships

**Priority**: Tier 3 — high activation value; start with 5 templates

---

## Category 6 — Observability & Logging

### GAP-25: Enhanced Run Logging

**What Sim has**  
Beyond basic run status:
- **Per-block I/O sidebar**: input and output JSON for each block; Markdown rendering; copy button
- **Run timeline**: per-block start/end timestamps; Gantt-style visualization; bottleneck identification
- **Workflow snapshots**: frozen canvas state at run time — debug workflows that have since changed
- **Live mode**: log list auto-refreshes for real-time monitoring
- **Filtering**: time range, status, trigger type, folder, workflow

**Sim internals**

Source: `apps/sim/lib/logs/types.ts`, `packages/db/schema.ts` → `workflowExecutionLogs`

`workflowExecutionLogs` columns:
```
id, workflowId, executionId, triggerType, status, duration,
cost (decimal), tokenUsage (JSONB), error, traceSpans (JSONB),
output (JSONB), runData (JSONB: per-block I/O), createdAt
```

Workflow snapshot: separate `workflowExecutionSnapshots` table (stateHash dedup — P5):
```typescript
const stateHash = sha256(JSON.stringify(serializedWorkflow))
// Upsert with UNIQUE constraint on (workflowId, stateHash)
// Run log has a FK to the snapshot record
```

**Agentis adaptation**

DB changes:
```sql
-- Extend runs table:
ALTER TABLE runs ADD COLUMN block_data TEXT;  -- JSON: per-block {input, output, startTime, duration}
ALTER TABLE runs ADD COLUMN snapshot_id TEXT REFERENCES run_snapshots(id);

CREATE TABLE run_snapshots (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,   -- serialized workflow at run time
  created_at INTEGER DEFAULT (unixepoch('now') * 1000),
  UNIQUE(workflow_id, state_hash)  -- content-hash dedup (P5)
);
```

Engine changes:
- Emit `blockStart` / `blockComplete` events with input + output + timestamps
- Serialize workflow definition at run start → compute SHA-256 → upsert into `run_snapshots`
- Store snapshot FK on the run record

UI changes:
- `RunDetailPage`: add per-block accordion (block name, status, duration, I/O JSON viewer)
- Run timeline: Gantt bar chart (D3 or CSS flexbox) showing block durations relative to total run time
- Snapshot viewer: "View Snapshot" opens canvas in read-only mode with historical definition loaded

**Priority**: Tier 2 — per-block I/O and snapshots are essential for production debugging

---

### GAP-26: Per-Run Cost Calculation

**What Sim has**  
Every run log includes: total cost in USD, token breakdown (prompt, completion, total), per-model cost splits. Provider-specific pricing tables.

**Sim internals**

Source: `apps/sim/lib/logs/types.ts`

```typescript
interface CostBreakdown {
  input: number     // USD
  output: number
  total: number
  tokens: { input: number, output: number, total: number }
  model: string
  pricing: PricingInfo
}

interface ProviderTimingSegment {
  type: 'model' | 'tool'
  name?: string
  startTime: number
  endTime?: number
  // tokens, cost per segment
}
```

Pricing tables: hardcoded config per model (regularly updated); stored in `lib/providers/pricing.ts`.  
Accumulation: each agent/evaluator handler emits a `CostBreakdown`; the engine sums them into `totalCost`.

**Agentis adaptation**

- Add pricing config: `apps/api/src/config/llm-pricing.ts` — `Record<modelId, { inputPerMToken: number, outputPerMToken: number }>`
- LLM adapters: return `{ promptTokens, completionTokens, model }` in all completion responses
- WorkflowEngine: accumulate cost per block → store as `cost_usd` and `token_usage` on the run record
- RunDetailPage: display cost breakdown alongside run status
- Budget service: connect to actual token cost (currently approximate) for accurate deduction

**Priority**: Tier 2 — cost visibility critical for production ops; ties into budget controls

---

### GAP-27: Execution Event Buffer (SSE Streaming)

**What Sim has**  
Redis-backed event buffer for SSE streaming. Multiple subscribers, late joiners, cross-pod delivery. Events are written as a ZSET with sequence numbers. TTL: 1 hour.

**Sim internals**

Source: `apps/sim/lib/execution/event-buffer.ts` (P7)

```typescript
// Redis key structure:
const EVENTS_KEY = `execution:stream:${executionId}:events`  // ZSET (score = seq)
const SEQ_KEY    = `execution:stream:${executionId}:seq`     // INCR counter
const META_KEY   = `execution:stream:${executionId}:meta`    // HSET

// Writer:
class ExecutionEventWriter {
  write(event: ExecutionEvent): void  // buffered; flushed every 15ms
  flush(): Promise<void>              // ZADD batch (max 200 events per flush)
  close(): Promise<void>              // set meta.status = 'complete'
}

// Reader (SSE endpoint):
// ZRANGEBYSCORE(EVENTS_KEY, lastSeq + 1, '+inf') → new events → SSE encode
```

**Agentis adaptation**

For run streaming (already partially exists via WebSocket):
- Implement Redis ZSET event buffer (P7) for SSE endpoint: `GET /runs/:id/events`
- Fallback: in-memory EventEmitter when Redis is not configured (single-pod only)
- Event types: `block_start`, `block_complete`, `block_error`, `tool_call`, `llm_token`, `run_complete`, `run_error`
- TTL: 1 hour per run stream

**Priority**: Tier 2 — reliable streaming is table-stakes for real-time workflow monitoring

---

### GAP-28: Trace Span Tree Visualization

**What Sim has**  
Hierarchical OTel-style trace tree in run detail: nested spans (per-block, per-LLM-call, per-tool-call), timing bars, input/output/cost per span.

**Sim internals**

Source: `apps/sim/lib/logs/types.ts` → `traceSpans: JSONB` on the run log record  
Span schema:
```typescript
interface TraceSpan {
  spanId: string
  parentSpanId?: string
  name: string             // e.g., 'block:agent1', 'llm:gpt-4o', 'tool:search_web'
  startTime: number
  endTime?: number
  input?: unknown
  output?: unknown
  cost?: CostBreakdown
  error?: string
  children?: TraceSpan[]   // nested for tree rendering
}
```

**Agentis adaptation**

OTel infrastructure already exists in `apps/api/src/telemetry/`.  
Gap is visualization:
- WorkflowEngine: emit spans using OpenTelemetry SDK (may already happen); serialize span tree to JSON at run end → store in `runs.trace_spans`
- `RunDetailPage`: span tree component:
  - Nested tree rendering: each span has child spans for sub-operations
  - Proportional timing bar (width = duration / total run time × 100%)
  - Click to expand: shows `input`, `output`, `cost` for that span
  - Filter controls: errors only, LLM calls only, tool calls only

**Priority**: Tier 2 — OTel infrastructure exists; visualization is the gap

---

### GAP-29: Data Retention Policies

**What Sim has**  
Org-level log retention. Free: 7-day retention. Pro/Enterprise: configurable. Background job deletes expired logs in chunks to avoid lock escalation.

**Agentis adaptation**  
Add `log_retention_days` to workspace settings (default: 90, unlimited for paid).  
Background cleanup job: `scripts/cleanup-old-runs.ts` — delete runs older than retention in chunks of 500 rows.  
Run as scheduled task via pg-boss or cron route.

**Priority**: Tier 3 — compliance requirement; simple chunked DELETE implementation

---

## Category 7 — Enterprise Features

### GAP-30: Single Sign-On (SAML / OIDC)

**Sim internals**: `packages/db/schema.ts` → `ssoProvider` table; `apps/sim/ee/sso/` — SAML 2.0 assertion parsing + OIDC token exchange; integrated with Better Auth session creation.

**Agentis adaptation**: `passport-saml` + `openid-client`. `sso_providers` table per org. Enterprise plan gate. Maps IdP identity to Agentis `users` record; creates session on success.

**Priority**: Tier 3 — required for enterprise sales

---

### GAP-31: Audit Log

**Sim internals**: `packages/audit/` standalone package; `auditLog` table (append-only); fields: `organizationId`, `actorId`, `actorType`, `action`, `resourceType`, `resourceId`, `metadata`, `ipAddress`, `userAgent`, `timestamp`.

**Agentis adaptation**:
```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,  -- user|api_key|system
  action TEXT NOT NULL,      -- workflow.deploy|credential.access|user.invite...
  resource_type TEXT,
  resource_id TEXT,
  metadata TEXT,  -- JSON
  ip_address TEXT,
  created_at INTEGER DEFAULT (unixepoch('now') * 1000)
);
```

Append-only: no UPDATE/DELETE on this table (enforce via DB trigger or service contract).  
Middleware hooks on sensitive routes.

**Priority**: Tier 3 — compliance requirement; straightforward append-only table

---

### GAP-32: Access Control Groups

**Sim internals**: `permissions` table — `(userId, entityType, entityId, role)`; `permissionGroup` + `permissionGroupMember` for named sets. EE-gated.

**Agentis adaptation**: Add `resource_permissions(workspace_id, user_id, resource_type, resource_id, permission_level)` table. Checked in route handlers after workspace-role check. Initial allowed `resource_type` values: `workflow`, `table`, `knowledge_base`.

**Priority**: Tier 4 — current workspace-level roles are sufficient for V1

---

### GAP-33: External Workspace Invitations

**Sim internals**: `invitationWorkspaceGrant` table — invite non-org users to a specific workspace. Scoped-invitation with workspace-level role. Token-based invite link.

**Agentis adaptation**: `workspace_invitations(id, workspace_id, email, role, token, expires_at)` table. Invite link: `GET /invite/:token` → creates workspace member if email matches.

**Priority**: Tier 3 — important for agency/client collaboration scenarios

---

## Category 8 — Infrastructure

### GAP-34: Background Job Queue

**What Sim has**  
Pluggable backend (P6): `TriggerDevJobQueue` (cloud) or `DatabaseJobQueue` (DB polling via `asyncJobs` table). Selection via env var. Same `JobQueueBackend` interface. Inline execution path for fast workflows bypasses the queue entirely.

**Sim internals**

Source: `apps/sim/lib/core/async-jobs/config.ts`

Inline vs async decision:
```typescript
function shouldExecuteInline(workflow: SerializedWorkflow, request: ExecuteRequest): boolean {
  // Heuristic: no wait blocks, no HITL blocks, estimated duration < threshold
  // Returns true for fast workflows that can complete within the HTTP timeout
}
```

Database backend polls `asyncJobs` table:
```sql
-- asyncJobs schema:
(id, type, payload JSONB, status, attempts, max_attempts, scheduled_for, created_at)
-- Worker: SELECT ... WHERE status='pending' AND scheduled_for <= now() LIMIT 10 FOR UPDATE SKIP LOCKED
```

Retry: `attempts++`; if `attempts >= max_attempts`, set `status='failed'`; else reschedule with exponential back-off.

**Agentis adaptation**

Use `pg-boss` (Postgres-backed job queue) — no extra infra beyond existing Postgres:
```typescript
import PgBoss from 'pg-boss'
const boss = new PgBoss(process.env.DATABASE_URL)

// Enqueue:
await boss.send('workflow-execution', { workflowId, input, runId })

// Worker:
await boss.work('workflow-execution', async (job) => {
  await WorkflowEngine.execute(job.data)
})
```

`JobQueueBackend` interface (P6):
```typescript
interface JobQueueBackend {
  enqueue(job: Job, options?: EnqueueOptions): Promise<string>
  getStatus(jobId: string): Promise<JobStatus>
  cancel(jobId: string): Promise<void>
}
```

Retry: exponential back-off (1s, 5s, 30s); max 3 retries for transient LLM failures; dead letter after max retries.  
Inline execution: keep the `shouldExecuteInline()` heuristic for fast workflows.

**Priority**: Tier 2 — necessary for production reliability; in-process execution loses long runs on server restart

---

### GAP-35: Normalized Workflow Storage

**What Sim has**  
Workflow structure stored in three normalized tables (`workflowBlocks`, `workflowEdges`, `workflowSubflows`) rather than a single JSONB blob. Serializer flattens at execution time. Enables per-block updates, SQL queries on block types, and clean live-vs-deployed state separation (P4).

**Agentis adaptation**

Migrate from `workflows.definition_json` to normalized tables:
```sql
CREATE TABLE workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- block type (agent, function, api, condition, ...)
  name TEXT NOT NULL,
  position TEXT NOT NULL,      -- JSON: { x, y }
  config TEXT NOT NULL,        -- JSON: block-type-specific config
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch('now') * 1000),
  updated_at INTEGER DEFAULT (unixepoch('now') * 1000)
);

CREATE TABLE workflow_edges (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  condition TEXT   -- JSON: { type: 'if'|'else'|'else if', expression? }
);

CREATE TABLE workflow_subflows (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('loop', 'parallel')),
  node_ids TEXT NOT NULL,  -- JSON: string[]
  config TEXT NOT NULL     -- JSON: loop/parallel config
);
```

Serializer: `serializeWorkflow(workflowId)` → JOIN query → builds `SerializedWorkflow`  
Deployed state: `workflow_deployment_versions.state_json` stores a serialized snapshot at deploy time  
Canvas updates: individual `PATCH /workflows/:id/nodes/:nodeId`, `PATCH /workflows/:id/edges/:edgeId`  

**Priority**: Tier 2 — architectural improvement; unlock SQL-queryable workflow graphs; required before Canvas Copilot

---

### GAP-36: Kubernetes Deployment

**Sim internals**: `helm/` directory with production-grade charts. Separate deployments for `web`, `api`, `realtime` (Socket.IO), `background-worker`. Well-documented K8s deployment guide.

**Agentis adaptation**: Create Helm charts for Agentis components. Document deployment on Railway, Render, Fly.io (easier path for most self-hosters). Docker Compose for local development (already exists).

**Priority**: Tier 4 — needed for enterprise self-hosting at scale

---

## Priority Matrix

### Tier 1 — Core Competitiveness (next sprint cycle)

| Gap | What It Unlocks | Effort |
|-----|----------------|--------|
| GAP-04 Response Block | API/Chat Deployment; deterministic output | Low |
| GAP-02 Variables Block | Accumulator / counter patterns; Loop utility | Low |
| GAP-01 Loop Block | Batch processing; iterative refinement | Medium |
| GAP-09 Parallel Block | Concurrent fan-out | Medium |
| GAP-07 HITL Block | Human review checkpoints; approval workflows | Medium |
| GAP-10 Tables | Persistent structured data in workflows | High |
| GAP-11 Knowledge Base V1 | Grounded agent answers; RAG pipelines | High |
| GAP-17 API Deployment | Workflows consumable by external systems | Medium |
| GAP-19 MCP Integration | Ecosystem interoperability standard | Medium |

### Tier 2 — Product Depth

| Gap | What It Unlocks | Effort |
|-----|----------------|--------|
| GAP-05 Guardrails (JSON+Regex) | Quality control gates | Low |
| GAP-06 Evaluator Block | A/B testing; quality scoring | Low |
| GAP-14 Structured Output | Reliable block-to-block data pipelines | Medium |
| GAP-13 Agent Memory Modes | Cost control; context management | Low |
| GAP-18 Chat Deployment | Customer-facing agent interfaces | Low (after GAP-17) |
| GAP-20 Trigger Connectors top-6 | Production automation pipelines | Medium |
| GAP-12 Files System V1 | Document workflows | Medium |
| GAP-25 Enhanced Run Logging | Production debugging; snapshot replay | Medium |
| GAP-26 Per-Run Cost Calculation | Accurate budget deduction; ops visibility | Low |
| GAP-27 Execution Event Buffer | Reliable SSE streaming multi-subscriber | Medium |
| GAP-28 Trace Span Tree UI | Deep run diagnostics (OTel infrastructure exists) | Medium |
| GAP-34 Background Job Queue | Production reliability for long runs | Medium |
| GAP-35 Normalized Workflow Storage | Per-block updates; Canvas Copilot precondition | High |

### Tier 3 — Platform Maturity

| Gap | Notes |
|-----|-------|
| GAP-03 Wait Block | Easy; workarounds exist |
| GAP-08 Credential Canvas Block | Vault service already exists |
| GAP-15 Reasoning Effort | Power user feature |
| GAP-21 Mothership / NL Command | Needs Tables + KB + Deployment |
| GAP-22 Copilot Canvas Builder | Needs stable block model |
| GAP-23 Real-time Collaboration (Yjs) | Infrastructure investment |
| GAP-24 Workflow Templates V1 | High activation value; seed for AgentisHub |
| GAP-29 Data Retention Policies | Compliance; simple chunked DELETE |
| GAP-30 SSO | Enterprise sales requirement |
| GAP-31 Audit Log | Compliance; append-only table |
| GAP-33 External Workspace Invites | Agency/client collaboration |
| GAP-36 Native Email Sending | Platform-level Sendgrid account |

### Tier 4 — Enterprise / AgentisHub

| Gap | Notes |
|-----|-------|
| GAP-16 Expanded Tool Ecosystem | → AgentisHub skill templates + MCP |
| GAP-11 Full KB Connectors | Google Drive, Confluence, Notion sync |
| GAP-32 Access Control Groups | Scale-stage only |
| GAP-37 SCIM User Provisioning | Large enterprise IdP-managed directories |
| GAP-38 Whitelabeling | Reseller/OEM customers |
| GAP-39 Kubernetes Charts | Enterprise self-hosting |

---

## Sprint Plan

### Sprint A — Core Block Primitives (Week 1–2) — DONE
1. **DONE — GAP-04** Response Block + response locking in engine — shipped May 1, 2026
2. **DONE — GAP-02** Variables Block + WorkflowResolver-compatible `<workflow.key>` references — shipped May 1, 2026
3. **DONE — GAP-01** Loop Block V1 — executable loop scope/results node with container metadata reserved for normalized storage — shipped May 1, 2026
4. **DONE — GAP-09** Parallel Block V1 — executable parallel scope/results node with branch metadata reserved for normalized storage — shipped May 1, 2026
5. **DONE — GAP-03** Wait Block — shipped May 1, 2026
6. **DONE — GAP-07** HITL Block — engine pause detection, SerializableRunState, paused_runs + resume_queue tables, authenticated resume endpoint — shipped May 1, 2026

### Sprint B — Data Layer (Week 3–4) — DONE
7. **DONE — GAP-10** Tables / Agent Ledger — workspace table schema, typed row service, `/v1/ledger`, LedgerPage, and workflow Ledger block — shipped May 1, 2026
8. **DONE — GAP-11** Knowledge Base V1 — KB/doc/chunk schema, TXT/MD/CSV/JSON lexical ingestion + search, `/v1/knowledge-bases`, KnowledgePage, and workflow Knowledge block; sqlite-vec/pgvector remains the next embedding backend — shipped May 1, 2026
9. **DONE — GAP-12** Files System V1 — local `AGENTIS_DATA_DIR` storage, metadata/checksum schema, upload/download/delete routes, FormData-safe web client, and FilesPage; S3-compatible backend remains a later storage adapter — shipped May 1, 2026

### Sprint C — Deployment & Interop (Week 5–6) — DONE
10. **DONE — GAP-17** API Deployment — workflow_deployments snapshot/version table, API-key/public execution at `/d/:deploymentId`, sync-with-timeout + async run fallback, and deployment UI in the canvas — shipped May 1, 2026
11. **DONE — GAP-18** Chat Deployment — public `/chat/:deploymentId` page backed by deployment execution with optional key-bearing links — shipped May 1, 2026
12. **DONE — GAP-19** MCP Phase 1 — outbound MCP server registry, SSRF URL guard, JSON-RPC `tools/list` client, encrypted bearer token storage, and agent-task `mcpServerIds` tool catalog injection — shipped May 1, 2026
13. **DONE — GAP-19** MCP Phase 2 — inbound MCP server records, mapped deployment tools, authenticated JSON-RPC `/mcp/:serverId` endpoint with `initialize`, `tools/list`, and `tools/call` — shipped May 1, 2026

### Sprint D — Quality & Observability (Week 7–8) — DONE
14. **DONE — GAP-06** Evaluator Block — deterministic criteria/expected-value scoring node with threshold failure semantics, canvas palette entry, inspector form, and engine coverage — shipped May 1, 2026
15. **DONE — GAP-05** Guardrails Block (JSON + Regex modes) — JSON-schema-lite and regex validation node with run-failing rejection semantics, canvas palette entry, inspector form, and engine coverage — shipped May 1, 2026
16. **DONE — GAP-14** Structured Output Enforcement — agent-task `outputSchema` contract, inspector schema editor, runtime validation on agent completion, and schema coverage — shipped May 1, 2026
17. **DONE — GAP-26** Per-Run Cost Calculation — token/cost extraction from adapter outputs, model pricing fallback, `workflow_runs` token/cost columns, and run detail cost summary — shipped May 1, 2026
18. **DONE — GAP-25** Enhanced Run Logging — persisted per-block input/output/timing/error data, graph snapshot hash/snapshot, timeline view, and block I/O panels on run detail — shipped May 1, 2026
19. **DONE — GAP-28** Trace Span Tree UI — per-node trace span capture, `workflow_runs.trace_spans`, and run detail trace panel — shipped May 1, 2026

### Sprint E — Integration & Reliability (Week 9–10) — DONE
20. **DONE — GAP-20** Trigger Connectors — connector-aware webhook verification for GitHub, Slack, Gmail, Linear, Stripe, and Typeform while preserving Agentis HMAC webhooks — shipped May 1, 2026
21. **DONE — GAP-34** Background Job Queue — embedded `async_jobs` queue, inline/async/auto routing, retry accounting, and queued workflow dispatch; pg-boss remains the Postgres production adapter — shipped May 1, 2026
22. **DONE — GAP-13** Agent Memory Modes — agent-task memory config plus conversation, sliding-message, and approximate sliding-token window injection from the existing conversation store — shipped May 1, 2026
23. **DONE — GAP-35** Normalized Workflow Storage — normalized node/edge/subflow mirror tables, SQLite migration + Postgres parity schema, create/update sync, and live graph-patch sync — shipped May 1, 2026

---

## Key Architectural Decisions

### Decision 1: Vector Store Backend
`sqlite-vec` (zero additional infra for dev/self-hosted) vs. pgvector (Postgres-native, Sim's choice).  
**Recommendation**: abstract behind `VectorStore` interface with two implementations. Ship `SqliteVecStore` first; `PgvectorStore` when migrating to production Postgres. Abstraction cost is low; switching cost without it is high.

### Decision 2: Loop/Parallel Container Rendering on Canvas
Sim uses ReactFlow's native parent/child node system (`parentId` + `extent: 'parent'`). Container blocks are rendered as resizable boxes that physically contain their child nodes.  
**Recommendation**: adopt ReactFlow parent nodes. Serialize the container's child node list into `workflow_subflows.node_ids`. During DAG build, read subflows to inject sentinels around the nodes.

### Decision 3: Background Job Queue
`pg-boss` (Postgres-backed, zero additional infra) vs. `BullMQ` (Redis-backed, more powerful but requires Redis).  
**Recommendation**: `pg-boss` on existing SQLite/Postgres; `BullMQ` when Redis becomes a hard dependency anyway (for the event buffer). Wrap behind `JobQueueBackend` interface (P6) to allow future swap.

### Decision 4: HITL Resume Security
The resume token must be HMAC-signed and single-use to prevent replay attacks.  
Pattern: `token = HMAC-SHA256(contextId + executionId + secret)`. Verify in the resume route. Mark `paused_executions.status = 'resuming'` atomically before processing to prevent double-use.

### Decision 5: Normalized Workflow Storage Migration
Existing workflows have `definition_json`. Migration path:  
1. Add normalized tables alongside `definition_json`  
2. Add serializer that reads from normalized tables (new writes use both)  
3. Backfill existing workflows from `definition_json`  
4. After all workflows are migrated and verified, remove `definition_json`  
Ship this in Sprint E (after the block model is stable), not earlier.

### Decision 6: Branch ID Delimiter for Parallel
Sim uses Unicode subscripts (`₍N₎`). For Agentis, use `__branch_N__` (ASCII, easier to parse and debug):  
- `blockId__branch_0__`, `blockId__branch_1__`  
- Strip pattern: `/^(.+)__branch_\d+__$/` → normalized ID  
This keeps block ID spaces ASCII-clean while supporting the same flat-map lookup strategy (P3).

---

*Ground truth for Sim-driven roadmap decisions. Mark each gap with `[shipped: date]` as features land.*  
*Source architecture reference: `docs/researches/R6-sim-studio-architecture.md`*
