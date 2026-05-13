# R6 — Sim Studio Architecture Deep Dive

> **Purpose:** Ground-truth architectural analysis of the Sim Studio open-source codebase  
> (`C:\Users\antar\OneDrive\Documentos\nexseed\sim`). Every section is derived from direct source reading — no speculation. Used as the implementation reference when building Agentis analogues.  
> **Source commit:** `simstudioai/sim` · May 2026 · Apache 2.0  
> **Companion:** `docs/SIM-REFACTOR.md` (gap list)

---

## 1. Monorepo Layout

```
sim/
├── apps/
│   ├── sim/          ← Main Next.js 15 App Router application (Bun runtime)
│   ├── realtime/     ← Socket.IO collaboration server (pure Node.js/Bun)
│   └── docs/         ← Mintlify docs site
├── packages/
│   ├── db/           ← Drizzle ORM schema + migrations (PostgreSQL)
│   ├── auth/         ← Better Auth wrapper
│   ├── logger/       ← Pino-based structured logger
│   ├── utils/        ← Shared helpers (id gen, errors, string ops)
│   ├── workflow-types/    ← Shared TypeScript types for WorkflowState
│   ├── workflow-authz/    ← Authorization helpers for workflow access
│   ├── workflow-persistence/ ← Normalized DB persistence layer
│   ├── realtime-protocol/    ← Socket.IO event type contracts (shared between apps)
│   ├── security/         ← Security utilities (redaction, sanitization)
│   ├── audit/            ← Audit log writer
│   ├── tsconfig/         ← Shared tsconfig presets
│   ├── testing/          ← Vitest helpers
│   ├── ts-sdk/           ← Published TypeScript SDK
│   ├── python-sdk/       ← Published Python SDK
│   └── cli/              ← Published CLI
├── docker/           ← Docker Compose files (local, prod, ollama)
├── helm/             ← Kubernetes Helm charts
├── scripts/          ← Migration, seed, and maintenance scripts
└── turbo.json        ← Turborepo pipeline
```

**Turborepo pipeline** (`turbo.json`):
- `build` depends on `^build`; outputs `.next/**` and `dist/**`
- `transit` task wires inter-package type generation (custom task)
- `test` depends on `^build` (ensures built packages before tests)
- `dev` is persistent, no cache
- `envMode: "loose"` — env vars not strictly scoped per task

---

## 2. Technology Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Bun** | All apps run under Bun; leverages Bun's native TS execution, faster package installs |
| Web framework | **Next.js 15** App Router | Full SSR/RSC; API routes as Route Handlers; no Express |
| Database | **PostgreSQL** + **pgvector** | Drizzle ORM; 90+ tables; vector extension for knowledge base |
| ORM | **Drizzle ORM** | Type-safe SQL builder; schema-first; migrations via drizzle-kit |
| Auth | **Better Auth** | Session tokens + API keys; org multi-tenancy; SSO; OAUTH; JWKS |
| Realtime | **Socket.IO** | Separate server; Redis adapter for multi-pod; or in-memory single-pod |
| Background jobs | **Trigger.dev** (preferred) or **DB polling** | Pluggable backend; auto-detected from env vars |
| Code sandbox | **isolated-vm** | V8 isolates for function blocks and loop condition evaluation |
| Cache / pub-sub | **Redis** (ioredis) | SSE event buffer, cancellation flags, MCP tool cache, Socket.IO adapter |
| Vector search | **pgvector** | Semantic embeddings stored in `embedding` table; hybrid search |
| Observability | **OpenTelemetry** | Trace spans on executor, providers, tool calls; Prometheus metrics |
| UI | **React 18** + **ReactFlow** | Canvas = ReactFlow nodes/edges; Zustand stores; TanStack Query |
| Styling | **Tailwind CSS** + **shadcn/ui** | Design system via shadcn components + Radix UI primitives |
| Package manager | **Bun** (`bun.lock`) | `bunfig.toml` configures registry and workspace |
| Linting / Format | **Biome** | Replaces ESLint + Prettier; `biome.json` at root |

---

## 3. Database Schema (packages/db/schema.ts)

90+ tables in a single Drizzle schema file. Grouped by domain:

### 3.1 Auth & Identity
```
user               — id, name, email, normalizedEmail, stripeCustomerId, role, banned
session            — id, token, userId, activeOrganizationId, impersonatedBy
account            — OAuth provider accounts per user
verification       — email verification tokens
organization       — id, name, slug, plan, stripeCustomerId, ssoProviderId
member             — userId, organizationId, role (owner/admin/member)
invitation         — workspace invitations
workspace          — id, name, organizationId, plan settings
permissions        — userId, entityType, entityId, role (Read/Write/Admin)
permissionGroup    — named permission sets
permissionGroupMember
invitationWorkspaceGrant
ssoProvider        — SAML/OIDC config per org
oauthApplication   — OAuth2 app registrations
oauthAccessToken
oauthConsent
jwks               — JSON Web Key Sets for SSO
apiKey             — workspace or user-scoped API keys
```

### 3.2 Workflow Definition (normalized storage)
```
workflowFolder      — hierarchical folder tree; parentId self-ref; archivedAt soft-delete
workflow            — id, userId, workspaceId, folderId, name, color, isDeployed, isPublicApi,
                      runCount, lastRunAt, variables (JSON), archivedAt
workflowBlocks      — per-block: type, name, position, enabled, subBlocks (JSONB), outputs (JSONB),
                      data (JSONB), advancedMode, triggerMode, locked, height
workflowEdges       — sourceBlockId → targetBlockId, sourceHandle, targetHandle
workflowSubflows    — type ('loop'|'parallel'), config (JSONB) per workflow
workflowDeploymentVersion — snapshot of deployed workflow state
workflowCheckpoints — copilot undo/redo checkpoints per workflow
```

**Key design decision**: Workflow structure is stored in three normalized tables  
(`workflowBlocks`, `workflowEdges`, `workflowSubflows`) rather than a monolithic JSONB blob.  
The serializer flattens them into `SerializedWorkflow` at execution time.

### 3.3 Execution & Runs
```
workflowExecutionLogs   — id, workflowId, executionId, triggerType, status, duration,
                          cost (decimal), tokenUsage (JSONB), error, traceSpans (JSONB),
                          output (JSONB), runData (JSONB), createdAt
pausedExecutions        — executionId, workflowId, snapshotData (JSONB), pausePoints (JSONB),
                          contextId, status (paused/resuming/resumed/failed/queued), createdAt
resumeQueue             — pending resume requests; processed by background poller
workflowExecutionSnapshots — stateHash (unique per workflow), stateData (JSONB); deduped by hash
asyncJobs               — id, type, payload (JSONB), status, attempts, createdAt, scheduledFor
jobExecutionLogs        — background job history
idempotencyKey          — prevents duplicate job submission
outboxEvent             — transactional outbox for event sourcing (e.g., realtime broadcast)
```

### 3.4 Workspace Data
```
userTableDefinitions   — workspace-scoped table schema (columns as JSONB)
userTableRows          — rows with data (JSONB); workspaceId FK + tableId FK
knowledgeBase          — id, name, description, embeddingModel, embeddingDimension, chunkingConfig
document               — knowledgeBaseId, name, content, tokenCount, status, archivedAt
embedding              — documentId, chunkIndex, content, embedding (vector), metadata (JSONB)
docsEmbeddings         — platform documentation embeddings (for Mothership/Copilot context)
workspaceFile          — legacy file metadata (being migrated to workspaceFiles)
workspaceFiles         — id, workspaceId, name, size, mimeType, storageKey, createdAt
knowledgeConnector     — external source sync config
knowledgeConnectorSyncLog
environment            — user-level env vars (name, value, isSecret)
workspaceEnvironment   — workspace-level env vars
workspaceBYOKKeys      — Bring Your Own Key encryption keys
```

### 3.5 Triggers & Integrations
```
workflowSchedule       — cron/interval triggers per workflow
webhook                — inbound webhook configs
workspaceNotificationSubscription — Slack/email notification preferences
workspaceNotificationDelivery
memory                 — agent memory entries (keyed by workspaceId + workflowId + conversationId)
skill                  — registered agent skills (name, description, code, tags, workspaceId)
customTools            — user-defined custom tool code per workflow
```

### 3.6 Copilot & Mothership
```
copilotChats           — conversation threads per workspace/workflow
copilotWorkflowReadHashes — per-workflow content hashes for incremental reading
copilotRuns            — execution traces of copilot-driven runs
copilotRunCheckpoints  — async tool call states within a copilot run
copilotAsyncToolCalls  — long-running tool call state (async continuation)
copilotFeedback        — user thumbs up/down per message
```

### 3.7 MCP
```
mcpServers             — workspace MCP server registry (name, url, authType, workspaceId)
workflowMcpServer      — links workflows to MCP servers as tools
workflowMcpTool        — per-tool config (name, description, parameter descriptions)
```

### 3.8 Marketplace / Community
```
templates              — workflow templates (state JSON, name, description, category, tags)
templateCreators       — author profiles
templateStars          — user stars on templates
```

### 3.9 Enterprise
```
auditLog               — immutable; actor, action, resource, metadata, timestamp
usageLog               — token/cost usage per workspace per model
permissionGroup        — named access control sets
permissionGroupMember
```

### 3.10 Credentials
```
credential             — encrypted credential blobs (OAuth tokens, API keys)
credentialMember       — per-user/workspace credential sharing
pendingCredentialDraft — draft OAuth flow state
credentialSet          — named group of credentials
credentialSetMember
credentialSetInvitation
```

### 3.11 Billing & Rate Limiting
```
subscription           — Stripe subscription state per org
rateLimitBucket        — sliding window rate limit state
userStats              — per-user aggregate stats (runs, tokens)
```

### 3.12 Misc
```
chat                   — public chat session state (for deployed chat workflows)
form                   — public form state (for deployed form workflows)
mothershipInboxAllowedSender — sender allow-list for Mothership email integration
mothershipInboxTask    — tasks created from inbound Mothership emails
mothershipInboxWebhook
academyCertificate     — completion certificates for Academy courses
a2aAgent               — A2A protocol agent registry
a2aTask                — A2A task execution records
a2aPushNotificationConfig
waitlist               — platform waitlist
```

---

## 4. Executor Architecture

The executor is the most important subsystem. It lives in `apps/sim/executor/` and is invoked server-side for every workflow run.

### 4.1 Component Hierarchy

```
DAGExecutor                         ← entry point (exported as `Executor`)
├── DAGBuilder                      ← constructs the execution graph from SerializedWorkflow
│   ├── PathConstructor             ← computes reachable blocks from trigger
│   ├── LoopConstructor             ← inserts sentinel nodes around loops
│   ├── ParallelConstructor         ← inserts sentinel nodes around parallels
│   ├── NodeConstructor             ← builds DAGNode per block
│   └── EdgeConstructor             ← wires edges + sets incoming edge counts
├── ExecutionContext                 ← mutable execution state passed through all components
├── ExecutionState (BlockStateController) ← block outputs + executed set
├── VariableResolver                ← `<block.field>` template resolution
│   ├── LoopResolver                ← `<loop.index>`, `<loop.currentItem>`, `<loop.items>`
│   ├── ParallelResolver            ← `<parallel.index>`, `<parallel.item>`
│   ├── WorkflowResolver            ← `<workflow.variableName>`
│   ├── EnvResolver                 ← `<env.VAR_NAME>`
│   └── BlockResolver               ← `<blockId.outputField>`
├── BlockExecutor                   ← per-block execution (resolves inputs, calls handler)
│   └── BlockHandler[] (registry)   ← 15 handler types
├── ExecutionEngine                 ← main run loop (ready queue + concurrency)
├── NodeExecutionOrchestrator       ← routes nodes to correct handler (sentinel vs user block)
├── LoopOrchestrator                ← manages LoopScope lifecycle + iteration logic
└── ParallelOrchestrator            ← manages ParallelScope lifecycle + branch fan-out
```

### 4.2 DAG Data Structures

```typescript
interface SerializedWorkflow {
  version: string
  blocks: SerializedBlock[]        // flat list of all blocks
  connections: SerializedConnection[] // source → target edges with optional condition
  loops: Record<string, SerializedLoop>     // loopId → config
  parallels?: Record<string, SerializedParallel> // parallelId → config
}

interface SerializedBlock {
  id: string
  position: Position
  config: {
    tool: string           // maps to block type (e.g., "agent", "function")
    params: Record<string, unknown>  // sub-block values
  }
  inputs: Record<string, ParamType>
  outputs: Record<string, OutputFieldDefinition>
  metadata?: { id, name, description, category, icon, color }
  enabled: boolean
  canonicalModes?: Record<string, 'basic' | 'advanced'>
}

interface SerializedLoop {
  id: string
  nodes: string[]          // block IDs inside the loop
  iterations: number       // for 'for' type
  loopType?: 'for' | 'forEach' | 'while' | 'doWhile'
  forEachItems?: any[] | string    // array or JS expression
  whileCondition?: string          // JS expression → boolean
  doWhileCondition?: string
}

interface SerializedParallel {
  id: string
  nodes: string[]
  distribution?: any[] | string    // items or JS expression
  count?: number                   // for count-based parallel
  parallelType?: 'count' | 'collection'
}
```

**DAGNode** (built from SerializedBlock):
```typescript
interface DAGNode {
  id: string                        // may be suffixed: `blockId₍N₎` for parallel branches
  block: SerializedBlock
  incomingEdges: Set<string>        // source nodeIds; decremented as deps complete
  outgoingEdges: Map<string, DAGEdge>
  metadata: NodeMetadata            // loopId?, parallelId?, isSentinel, isContainer, etc.
}
```

**Sentinel nodes**: Loop and Parallel containers inject invisible "start sentinel" and "end sentinel" nodes at either end of the container. These handle iteration state transitions and branch aggregation without being visible to users.

- Loop start sentinel: `{loopId}_loop_start`
- Loop end sentinel: `{loopId}_loop_end`
- Parallel start sentinel: `parallel_start_{parallelId}`
- Parallel end sentinel: `parallel_end_{parallelId}`

### 4.3 Variable Resolution System

Template strings use the pattern `<blockId.fieldName>`. Resolution priority (first resolver that matches wins):

1. **LoopResolver**: `<loop.index>`, `<loop.currentItem>`, `<loop.items>` — only inside loop containers
2. **ParallelResolver**: `<parallel.index>`, `<parallel.item>` — only inside parallel containers
3. **WorkflowResolver**: `<workflow.varName>` — references workflow-level variables
4. **EnvResolver**: `<env.VAR>` — workspace environment variables
5. **BlockResolver**: `<blockId.outputField>` — any prior block's output

**Key lookup logic** in `ExecutionState.getBlockOutput()`:
- Direct lookup by exact node ID first
- Strip loop iteration suffix (`₍N₎` unicode subscript) for base ID lookup
- Fallback: scan all block states for matching normalized ID

This suffix system (`blockId₍0₎`, `blockId₍1₎`) is how parallel branches get unique IDs while still being resolvable by their base block ID from outside the parallel container.

### 4.4 ExecutionEngine — Run Loop

```typescript
class ExecutionEngine {
  private readyQueue: string[]        // nodeIds with all deps satisfied
  private executing: Set<Promise<void>>
  private pausedBlocks: Map<string, PauseMetadata>
  private cancelledFlag: boolean
  private useRedisCancellation: boolean  // if Redis available
  private readonly CANCELLATION_CHECK_INTERVAL_MS = 500
}
```

**Run loop pseudocode**:
```
initializeQueue(triggerBlockId)
  → push trigger block to readyQueue

while readyQueue not empty OR executing not empty:
  drain readyQueue:
    for each nodeId in readyQueue:
      promise = executeNode(nodeId)
        → checks if cancelled (local flag OR Redis poll every 500ms)
        → resolves inputs via VariableResolver
        → calls NodeOrchestrator.executeNode()
        → on complete: updates ExecutionState, decrements incoming edges of successors
        → enqueues any successor nodes with incomingEdges.size === 0

  await Promise.race(executing) to make progress

finalOutput = collect Response block outputs (or last executed block)
```

**Concurrency model**: Multiple blocks execute concurrently. The ready queue is drained synchronously into promises; `Promise.race` drives progress. A `queueLock` mutex prevents race conditions when multiple concurrent promises try to enqueue new blocks simultaneously.

**Cancellation**: Two-tier system:
1. `AbortSignal` on the request — caught immediately when the HTTP connection drops
2. Redis key `execution:cancel:{executionId}` — polled every 500ms for cross-process cancellation (multi-pod deployments)

**Response block locking**: Once a Response block produces output, `responseOutputLocked = true`. Subsequent Response blocks in other branches are ignored. This makes the final workflow output deterministic.

### 4.5 Loop Orchestrator

`LoopScope` per loop in the execution context:
```typescript
interface LoopScope {
  iteration: number
  currentIterationOutputs: Map<string, NormalizedBlockOutput>  // this iteration's block outputs
  allIterationOutputs: NormalizedBlockOutput[][]               // all iterations accumulated
  maxIterations?: number
  item?: any               // current ForEach item
  items?: any[]            // full ForEach collection
  condition?: string       // while/doWhile condition expression
  loopType?: 'for' | 'forEach' | 'while' | 'doWhile'
  skipFirstConditionCheck?: boolean  // doWhile behavior
}
```

**Iteration lifecycle**:
1. Loop start sentinel fires → `initializeLoopScope()` → set `iteration = 0`, resolve collection/count
2. Loop body blocks execute normally (using LoopScope for `<loop.*>` refs)
3. Loop end sentinel fires → `evaluateLoopContinuation()`:
   - **for**: continue if `iteration < maxIterations` (cap: 1000)
   - **forEach**: continue if `iteration < items.length` (cap: 1000)
   - **while**: evaluate `whileCondition` JS expression in `isolated-vm` (timeout: 5s)
   - **doWhile**: same as while but `skipFirstConditionCheck = true`
4. If continue → reset iteration outputs, increment `iteration`, re-enqueue loop start sentinel
5. If exit → emit `allIterationOutputs` as `results[]`, proceed past loop end sentinel

**Condition evaluation**: `while`/`doWhile` conditions are evaluated in `isolated-vm` (V8 isolate) with a 5-second timeout. The condition string is a JavaScript boolean expression with block references pre-resolved.

**ForEach items resolution**: The `forEachItems` field can be:
- A literal array (JSON)
- A `<blockId.field>` reference string that gets resolved to an array at loop init time

### 4.6 Parallel Orchestrator

`ParallelScope` per parallel:
```typescript
interface ParallelScope {
  parallelId: string
  totalBranches: number
  branchOutputs: Map<number, NormalizedBlockOutput[]>  // branchIndex → outputs
  items?: any[]        // for collection-based parallel
  isEmpty?: boolean    // if collection is empty, skip all branches
}
```

**Branch ID suffixing**: Each branch of a parallel gets a unique node suffix. Block `agent1` in branch 2 becomes `agent1₍2₎`. This is what allows two instances of the same block to have independent outputs in `ExecutionState`.

**Aggregation**: The parallel end sentinel collects all `branchOutputs` and assembles them into a single array output accessible as `<parallelId.results>` downstream.

**Nested containers**: Loops inside parallels work because each branch has its own loop scope. The branch suffix propagates into all nested block IDs.

### 4.7 Block Handler Interface

```typescript
interface BlockHandler {
  canHandle(block: SerializedBlock): boolean
  execute(
    ctx: ExecutionContext,
    block: SerializedBlock,
    inputs: Record<string, any>
  ): Promise<BlockOutput | StreamingExecution>
}
```

**15 registered handlers** (in priority order):
1. `TriggerBlockHandler` — start_trigger, schedule, webhook, api_trigger, chat_trigger, manual
2. `FunctionBlockHandler` — JS/TS code execution in isolated-vm
3. `ApiBlockHandler` — HTTP request to external APIs
4. `ConditionBlockHandler` — if/else-if/else branching
5. `RouterBlockHandler` — AI-based intelligent routing
6. `ResponseBlockHandler` — workflow output terminator
7. `HumanInTheLoopBlockHandler` — pause execution, generate portal URL
8. `AgentBlockHandler` — full LLM agent with tools, memory, skills
9. `MothershipBlockHandler` — workspace command center execution
10. `VariablesBlockHandler` — read/write workflow-scoped variables
11. `WorkflowBlockHandler` — sub-workflow invocation (recursive DAGExecutor)
12. `WaitBlockHandler` — time-based delay
13. `EvaluatorBlockHandler` — LLM quality scoring
14. `CredentialBlockHandler` — secret resolution from vault
15. `GenericBlockHandler` — catch-all for tool-backed blocks (60+ tool integrations)

**GenericBlockHandler** is the most important for coverage. It handles all 200+ tool blocks (GitHub, Slack, Airtable, etc.) by looking up the block's tool definition, resolving parameters, and making the configured API call. This handler is why Sim has 200+ integrations without 200+ individual handlers.

### 4.8 Agent Handler — Full Detail

The agent handler is the most complex:

```typescript
// Inputs resolved from block params
interface AgentInputs {
  model: string
  systemPrompt: string
  messages?: Message[]
  tools?: ToolInput[]
  skills?: string[]         // skill IDs to load
  responseFormat?: string   // JSON Schema for structured output
  temperature?: number
  maxTokens?: number
  memoryConfig?: {
    mode: 'none' | 'conversation' | 'sliding_window_messages' | 'sliding_window_tokens'
    conversationId?: string
    windowSize?: number
  }
  reasoningConfig?: {       // model-specific thinking controls
    effort?: 'low' | 'medium' | 'high'  // OpenAI o-series
    thinkingEnabled?: boolean            // Claude / Gemini
    budgetTokens?: number
  }
}
```

**Execution flow**:
1. **Tool validation**: filter unavailable MCP tools; check `validateMcpToolsAllowed()`, `validateSkillsAllowed()`, `validateModelProvider()` (EE permission checks)
2. **Skill resolution**: `resolveSkillMetadata()` → builds a `load_skill` tool injected into the tool list; agent calls it to dynamically load skill code into the isolate
3. **Memory**: `memoryService.getMessages()` → queries `memory` table by `(workspaceId, workflowId, conversationId)`; applies windowing
4. **Provider request**: `executeProviderRequest()` → dispatches to the correct provider adapter (OpenAI, Anthropic, Google, Groq, etc.)
5. **Tool call loop**: if model returns tool calls, execute each tool (MCP call, skill invocation, or native tool) and continue conversation
6. **Memory persistence**: `memoryService.saveMessages()` → upserts to `memory` table
7. **Streaming**: SSE stream via the `onStream` callback; provider streams are proxied through

**MCP tool resolution at agent time**:
- DB query: `SELECT * FROM mcpServers WHERE workspaceId = ?`
- For each configured MCP server: call `tools/list` via `McpClient` (HTTP SSE transport)
- Cache results in Redis with `MCP_CONSTANTS.CACHE_TIMEOUT` TTL
- Merge with native tools before sending to provider

### 4.9 Pause / Resume (HITL)

When a Human-in-the-Loop block executes:
1. `BlockExecutor` calls `HumanInTheLoopBlockHandler.execute()`
2. Handler generates `contextId` (UUID), builds resume URLs:
   - API: `/api/resume/{workflowId}/{executionId}/{contextId}`
   - UI: `/resume/{workflowId}/{executionId}`
3. Sends notifications (Slack/Gmail/Teams/SMS/Webhook) via configured channels
4. Returns a `PauseMetadata` object instead of a normal `BlockOutput`
5. `ExecutionEngine` detects the pause, stores `PauseMetadata` in `pausedBlocks` map
6. After engine run completes: `handlePostExecutionPauseState()` called → serializes `SerializableExecutionState` → stores in `pausedExecutions` table

**Resume flow**:
```
POST /api/resume/{workflowId}/{executionId}/{contextId}
  → validates contextId matches pausedExecutions record
  → stores resume data in resumeQueue
  → background poller picks up resumeQueue item
  → deserializes snapshot from pausedExecutions.snapshotData
  → re-runs DAGExecutor with `resumeFromSnapshot: true` + pre-populated block states
  → HITL block output = the submitted form data
  → execution continues from next block
```

**HITL in loops/parallels**: `PauseMetadata` includes `loopScope` and `parallelScope` fields. When resuming inside a loop, the loop orchestrator re-initializes from the serialized `LoopScope` rather than starting from iteration 0.

### 4.10 Run-From-Block (Partial Replay)

Sim has a "run from block" feature that pre-loads outputs from a prior execution snapshot:

```typescript
interface RunFromBlockContext {
  startBlockId: string
  dirtySet: Set<string>          // blocks that need to re-execute
  cachedOutputs: Map<string, NormalizedBlockOutput>  // reused from snapshot
}
```

`computeExecutionSets(startBlockId, dag, executedBlocks)` walks the DAG backwards from `startBlockId` to determine which blocks are "upstream" (cached) vs "downstream" (dirty, must re-run).

`NodeExecutionOrchestrator.executeNode()` checks `runFromBlockContext.dirtySet.has(nodeId)` — if not dirty, returns the cached output immediately without calling the handler.

### 4.11 Execution Snapshot Serialization

`SerializableExecutionState`:
```typescript
interface SerializableExecutionState {
  blockStates: Record<string, { output, executed, executionTime }>
  executedBlocks: string[]
  loopScopes?: Record<string, LoopScope>
  parallelScopes?: Record<string, ParallelScope>
  dagIncomingEdges?: Record<string, string[]>  // for DAG reconstruction on resume
}
```

Stored in `workflowExecutionSnapshots` table with a content-hash deduplication key (`stateHash`). This avoids storing duplicate snapshots when the same workflow state is reached via multiple paths.

---

## 5. Workflow Serialization / Persistence

### 5.1 Serializer

`apps/sim/serializer/` converts the Zustand store's `WorkflowState` (canvas-editor format) to/from `SerializedWorkflow` (executor format).

The canvas format stores blocks as ReactFlow nodes with position, size, handles, sub-block values in a deeply nested structure. The serializer flattens this into the executor's `SerializedBlock[]` + `SerializedConnection[]` format.

### 5.2 Normalized vs JSONB Storage

Workflow blocks/edges are stored in **three normalized tables** for query performance:
```
workflowBlocks  — one row per block
workflowEdges   — one row per edge
workflowSubflows — one row per loop/parallel
```

The `workflow` table itself does NOT store the workflow state as JSONB — it just stores metadata (name, color, isDeployed, etc.).

This design enables:
- Querying "all workflows using agent blocks" without JSON parsing
- Efficient updates (change one block without rewriting entire workflow)
- Deployed state: `workflowDeploymentVersion` stores a serialized snapshot of the deployed state, separate from the live editor state

### 5.3 Live vs Deployed State

When executing via API or webhook, the executor loads `workflowDeploymentVersion` (the last deployed snapshot). When executing from the canvas editor, it loads from normalized tables (`loadWorkflowFromNormalizedTables()`). The `useDraftState` flag switches between the two.

---

## 6. Async Job System

`apps/sim/lib/core/async-jobs/` — pluggable backend abstraction:

```typescript
interface JobQueueBackend {
  enqueue(job: Job, options?: EnqueueOptions): Promise<string>
  getStatus(jobId: string): Promise<JobStatus>
  cancel(jobId: string): Promise<void>
}
```

**Two backends**:

**1. Trigger.dev backend** (`backends/trigger-dev.ts`):
- Used when `TRIGGER_SECRET_KEY` is in env
- Long-running workflows run as Trigger.dev tasks with durable execution
- Cold starts mitigated by "warm" Trigger.dev workers
- Supports retries, concurrency limits, and real-time status

**2. Database backend** (`backends/database.ts`):
- Uses `asyncJobs` table as a job queue
- Background polling (`/api/jobs/...` cron route picks up pending jobs)
- Suitable for self-hosting without Trigger.dev
- Retry logic via `attempts` column; max retries configurable

**Inline execution** (`shouldExecuteInline()`): Short workflows (under time threshold) execute directly in the API route handler without enqueueing, eliminating async job overhead for fast runs.

---

## 7. Realtime Collaboration Server

`apps/realtime/` — completely separate process from the Next.js app.

### 7.1 Entry Point (`src/index.ts`)
```
createServer() → Node.js HTTP server
createSocketIOServer(httpServer) → Socket.IO with Redis adapter if REDIS_URL present
createRoomManager(io):
  if REDIS_URL → RedisRoomManager (multi-pod)
  else → MemoryRoomManager (single-pod)
io.use(authenticateSocket)  ← JWT/session validation via Better Auth
setupAllHandlers(io, roomManager)
```

### 7.2 Room Model
Each **workflow** is a "room" — multiple users editing the same workflow join the same Socket.IO room. The `RoomManager` tracks which users are in which rooms.

**RedisRoomManager**: Room state stored in Redis hashes. Socket.IO adapter also uses Redis pub/sub for cross-pod event delivery. This enables horizontal scaling — any pod can emit to any room.

### 7.3 Event Types (`packages/realtime-protocol/`)

Shared contract between `apps/sim` (frontend) and `apps/realtime` (server):
- `workflow:join` / `workflow:leave` — join/leave a workflow room
- `workflow:update` — broadcast block/edge/subflow changes
- `cursor:move` — broadcast cursor position + user info
- `user:presence` — active user list in room

### 7.4 Conflict Resolution Strategy
Sim uses **event broadcasting** (not true CRDT). The server re-broadcasts every mutation to all other clients in the room. Last write wins per block field. This is simpler than Yjs CRDT but can lose updates on concurrent edits to the same block property.

The canvas undo/redo is handled client-side via `stores/undo-redo/` (Zustand middleware) and `workflowCheckpoints` table (for persisting copilot undo state).

---

## 8. Copilot Architecture

Copilot is the canvas-integrated workflow builder. It is a full agentic loop with tools, streaming, async continuations, and checkpoints.

### 8.1 Request Flow
```
POST /api/copilot/chat/stream
  → creates or loads CopilotChat record
  → builds RequestContext (user, workspace, workflow state, tool context)
  → calls CopilotRequest.stream()
    → sends to Sim-managed cloud endpoint (NOT the local LLM provider directly)
    → streams back MothershipStreamV1 protocol (proprietary SSE format)
    → parses tool calls from stream
    → dispatches tool calls via ToolExecutionContext
    → accumulates ContentBlocks (text, thinking, tool_call, subagent_text)
  → saves message to copilotChats
```

**Key insight**: Copilot calls a **Sim-managed cloud service** even for self-hosted deployments. The cloud service provides the actual LLM calls + tool routing. Self-hosters get Copilot UI but depend on Sim's cloud for intelligence. (See `COPILOT_URL` env var.)

### 8.2 Copilot Tools (`lib/copilot/tools/`)

The copilot has a large set of workflow management tools it can call:

**Workflow tools** (`handlers/workflow/`):
- `create_workflow` — create new workflow
- `update_workflow` — modify blocks/edges
- `deploy_workflow` — trigger deployment
- `get_workflow_state` — read current canvas
- `run_workflow` — execute workflow and return results

**Management tools** (`handlers/management/`):
- `list_workspaces`, `create_workspace`
- `list_knowledge_bases`, `query_knowledge_base`
- `list_tables`, `query_table`, `update_table_row`
- `list_skills`, `get_skill`

**Platform tools** (`handlers/platform.ts`):
- `search_docs` — query docsEmbeddings table for documentation context
- `get_block_descriptions` — explain what a block type does

**Deployment tools** (`handlers/deployment/`):
- `get_api_key`, `get_deployment_url`

**Access tools** (`handlers/access.ts`):
- `get_workspace_permissions`, `check_feature_access`

### 8.3 Async Tool Calls
For long-running tool operations (e.g., running a workflow that takes minutes), copilot uses **async continuations**:

1. Tool call is dispatched → returns a pending ID
2. `copilotAsyncToolCalls` record created with status `pending`
3. SSE stream sends a "continuation checkpoint" event to the client
4. Background job runs the tool
5. On completion → updates `copilotAsyncToolCalls`, triggers client to poll/reconnect
6. Client resumes the copilot stream from the checkpoint

### 8.4 Checkpoints
`workflowCheckpoints` stores workflow state snapshots keyed to a copilot conversation point. Used for:
- Copilot undo: revert canvas to state before copilot applied changes
- `POST /api/copilot/checkpoints/revert` — restores the checkpoint state to normalized tables

---

## 9. Knowledge Base / RAG System

### 9.1 Tables
```
knowledgeBase       — id, name, embeddingModel, embeddingDimension, chunkingConfig
document            — knowledgeBaseId, name, content, tokenCount, status, archivedAt
embedding           — documentId, chunkIndex, content, embedding(vector), metadata
docsEmbeddings      — platform docs for Mothership context
```

### 9.2 Chunking Config
```typescript
interface ChunkingConfig {
  maxChunkSize: number      // tokens, 100-4000, default 1024
  minChunkSize: number      // chars, 100-2000, default 100
  overlap: number           // tokens, 0-500, default 200
}
```

### 9.3 Processing Pipeline
`POST /api/knowledge/[id]/documents` → `lib/knowledge/`:
1. File parse: `lib/file-parsers/` — PDF (pdfjs-dist + optional Azure/Mistral OCR), DOCX, TXT, MD, HTML, XLS, PPT, CSV, JSON, YAML
2. Chunking: hierarchical splitter respecting document structure
3. Embedding: call configured embedding model API
4. Store: insert `embedding` rows with `vector` type (pgvector)

**pgvector usage**: The `embedding` column uses Drizzle's `vector(dimensions)` type. Search queries use `<=>` (cosine distance) operator from pgvector.

### 9.4 Knowledge Block in Executor
`GenericBlockHandler` handles the `knowledge` block type:
- Input: `query` string, `knowledgeBaseId`, `topK` (1-20)
- Execution: Drizzle query with `ORDER BY embedding <=> query_vector LIMIT topK`
- Output: `results[]` array with chunk content + metadata + similarity score

### 9.5 Connectors
`knowledgeConnector` table stores external source sync configs (Google Drive, Confluence, etc.).  
`knowledgeConnectorSyncLog` tracks sync history.  
Background sync job polls connectors and re-ingests changed documents.

---

## 10. Tables System

### 10.1 Schema
```
userTableDefinitions — id, workspaceId, name, columns (JSONB), createdAt, archivedAt
userTableRows        — id, tableId, workspaceId, data (JSONB), createdAt, updatedAt
```

Columns schema (JSONB in `userTableDefinitions.columns`):
```typescript
interface ColumnDefinition {
  id: string
  name: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'json'
  required?: boolean
  unique?: boolean
  defaultValue?: any
}
```

### 10.2 Service Layer (`lib/table/service.ts`)

Notable design choices:

**Per-transaction Postgres timeouts** (prevents pool starvation):
```typescript
async function setTableTxTimeouts(trx, opts?) {
  await trx.execute(sql`SET LOCAL statement_timeout = '${statementMs}ms'`)
  await trx.execute(sql`SET LOCAL lock_timeout = '${lockMs}ms'`)
  await trx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '${idleMs}ms'`)
}
```

**Validation before insert**: `validateRowAgainstSchema()` enforces column types; number columns coerce string "42" → 42; boolean columns parse "true"/"false" strings.

**Unique constraint enforcement**: Application-level unique checks via DB query before insert (avoids leaking constraint violation errors to the client).

**Batch operations**: `BatchInsertData`, `BatchUpdateByIdData` for bulk row manipulation (used by the Table block in workflows).

**Filter/Sort SQL builders** (`lib/table/sql.ts`): dynamic WHERE clause construction from `QueryOptions` — supports per-column filter conditions (equals, contains, gt, lt, etc.) and multi-column ORDER BY.

**Row size limit**: `validateRowSize()` prevents unbounded JSONB storage.

---

## 11. MCP Integration

### 11.1 MCP Server Registry
```
mcpServers           — workspaceId, name, url, authType ('none'|'api_key'), apiKey (encrypted)
workflowMcpServer    — workflowId → mcpServerId mapping
workflowMcpTool      — toolName, description, parameterDescriptions (JSONB)
```

### 11.2 MCP Client (`lib/mcp/client.ts`)
- Implements `@modelcontextprotocol/sdk` client (JSON-RPC 2.0)
- Supports HTTP+SSE transport
- `tools/list` → returns available tools
- `tools/call` → executes a tool by name with arguments

### 11.3 Connection Manager (`lib/mcp/connection-manager.ts`)
- Singleton; manages persistent connections to MCP servers
- Emits events when connections change → `McpService` invalidates cache
- Workspace-scoped: each workspace gets separate connections

### 11.4 Caching (`lib/mcp/storage.ts`)
- Tool list cached in Redis (if available) or in-memory map
- `MCP_CONSTANTS.CACHE_TIMEOUT` TTL
- Invalidated when connection state changes

### 11.5 SSRF Protection
`validateMcpServerSsrf()` + `isMcpDomainAllowed()`:
- Blocks private IP ranges (10.x, 172.16.x, 192.168.x, 127.x, ::1)
- Allowlist of approved external domains
- Prevents users from using MCP servers to reach internal infrastructure

### 11.6 Deploy Workflows as MCP

`POST /api/mcp/{serverId}` — Socket.IO or HTTP SSE endpoint implementing JSON-RPC 2.0:
```
tools/list  → query workflowMcpTool for this server → return tool definitions
tools/call  → find workflowMcpServer → execute matching workflow deployment
           → returns workflow output as tool result
```

Auth: `X-API-Key` header validated against `mcpServers.apiKey` (or public access).

---

## 12. Auth System

### 12.1 Better Auth (`packages/auth/`)

Better Auth is a TypeScript-native auth library with pluggable plugins. Sim's configuration:
- **Email/password** with email verification
- **OAuth providers**: Google, GitHub, etc.
- **Organizations plugin**: orgs, members, invitations, roles
- **API key plugin**: workspace-scoped API keys
- **Admin plugin**: user management, impersonation
- **SSO plugin**: SAML 2.0 / OIDC enterprise login

### 12.2 Hybrid Auth (`lib/auth/hybrid.ts`)

Most API routes use `checkHybridAuth()` which accepts:
1. **Session token** (cookie from browser session)
2. **API key** (Bearer token in Authorization header or `x-api-key` header)

`hasExternalApiCredentials()` — determines if the request is external (API key) vs internal (browser session), which affects logging, rate limiting, and feature access.

### 12.3 Multi-tenancy Model
```
User ─── has many ──► Organization memberships
Organization ──► has many ──► Workspaces
Workspace ──► has many ──► Workflows, Tables, Knowledge Bases, etc.
User ──► can have ──► Permission on specific resources (Read/Write/Admin)
PermissionGroup ──► named set of resource-level permissions
```

A user's access to a resource is checked via:
1. Organization membership role (owner/admin/member)
2. Workspace-level `permissions` table entry
3. `PermissionGroup` membership (enterprise feature)

---

## 13. Telemetry & Observability

### 13.1 OpenTelemetry Instrumentation

Sim has four separate instrumentation files:
- `instrumentation.ts` — server-side OTel setup
- `instrumentation-node.ts` — Node.js-specific spans
- `instrumentation-edge.ts` — Edge runtime (lightweight)
- `instrumentation-client.ts` — client-side browser tracing

Each workflow execution creates a root trace span. The executor emits child spans per block, per LLM iteration, per tool call.

### 13.2 ProviderTimingSegment

```typescript
interface ProviderTimingSegment {
  type: 'model' | 'tool'
  name?: string
  startTime: number
  endTime?: number
  // ... content, tokens, cost per segment
}
```

These segments are emitted by each LLM provider adapter for every iteration (model call) and every tool invocation. They feed the trace span tree UI and per-run cost calculation.

### 13.3 Execution Event Buffer (SSE Streaming)

Redis-backed event buffer for SSE streaming to browser:
```
execution:stream:{executionId}:events  — ZSET (sorted by sequence number)
execution:stream:{executionId}:seq     — atomic counter
execution:stream:{executionId}:meta    — HSET (status, userId, workflowId, updatedAt)
```

**Writer**: batches events into Redis ZADD with sequence IDs; flushes every 15ms; max 1000 events.  
**Reader**: client polls `GET /api/v1/executions/{id}/stream` → ZRANGEBYSCORE for unseen events → SSE encode → flush.

TTL: 1 hour per execution stream. After execution completes, the stream is kept for late subscribers.

### 13.4 Cost Calculation

`usageLog` table stores per-model token usage with cost breakdown. Provider adapters emit:
- `promptTokens`, `completionTokens`, `cachedTokens` per segment
- Pricing tables (hardcoded per model) → `costBreakdown.input`, `costBreakdown.output`, `costBreakdown.total`

Accumulated during execution → written to `workflowExecutionLogs.cost` and `workflowExecutionLogs.tokenUsage`.

---

## 14. Enterprise Features (EE)

`apps/sim/ee/` — Enterprise Edition code (Apache 2.0 but functionally gated):

### 14.1 Access Control (`ee/access-control/`)
`validateBlockType()`, `validateModelProvider()`, `validateMcpToolsAllowed()`, `validateSkillsAllowed()`, `validateCustomToolsAllowed()` — all check `PermissionGroup` and plan-level feature flags.

Checks are injected into:
- `BlockExecutor` (before each block executes)
- `AgentBlockHandler` (before tool setup)
- API route handlers

### 14.2 SSO (`ee/sso/`)
SAML 2.0 assertion processing + OIDC token exchange. Connected to `ssoProvider` table.  
`POST /api/auth/sso/saml/callback` → parse assertion → find/create user → create session.

### 14.3 Audit Log (`packages/audit/`)
Standalone package wrapping `auditLog` table writes. Called from API route handlers on sensitive actions. Schema:
```typescript
interface AuditLogEntry {
  organizationId: string
  actorId: string
  actorType: 'user' | 'api_key' | 'system'
  action: string       // e.g., 'workflow.deploy', 'credential.access'
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  timestamp: Date
}
```

### 14.4 Data Retention (`ee/data-retention/`)
Background job that deletes `workflowExecutionLogs` older than the workspace retention policy. Uses chunked deletes to avoid lock escalation. Connected to `asyncJobs` scheduler.

---

## 15. Block Definition System

`apps/sim/blocks/` — 200+ block definitions:

### 15.1 Structure
```typescript
interface BlockDefinition {
  type: string           // unique identifier
  category: string       // grouping in the UI palette
  name: string
  description: string
  icon: string           // Lucide icon name or custom SVG
  color: string          // hex color for block header

  subBlocks: SubBlockDefinition[]   // input UI components
  outputs: OutputDefinition[]       // output fields with types
  tools?: { access: string[] }      // required tool permissions
  memory?: { enabled: boolean }
}

interface SubBlockDefinition {
  id: string
  title: string
  type: 'short-input' | 'long-input' | 'dropdown' | 'code' | 'table' | ...
  required?: boolean
  placeholder?: string
  defaultValue?: any
  options?: Array<{ label: string; value: string }>
}
```

### 15.2 Registry (`blocks/registry.ts`)
All block definitions are registered in `blocks/registry.ts`. The canvas UI reads this registry to render the block palette, generate the block node UI, and validate connections.

The executor's `GenericBlockHandler` also reads this registry to find the handler function for each tool block type.

### 15.3 Tool Blocks vs Handler Blocks

**Handler blocks** (dedicated handler in `executor/handlers/`): agent, api, condition, router, response, HITL, mothership, variables, workflow, wait, evaluator, credential, function, trigger

**Tool blocks** (`blocks/blocks/` directory): All 200+ integrations (GitHub, Slack, Gmail, etc.) — handled by `GenericBlockHandler`. Each tool block defines its parameters and the handler knows how to call the underlying tool function.

---

## 16. Workflow Canvas — Zustand Store Architecture

`apps/sim/stores/workflows/` — the client-side state:

### 16.1 Store Structure
```
WorkflowStore
├── blocks: Record<string, BlockState>     ← ReactFlow nodes
├── edges: Edge[]                          ← ReactFlow edges
├── loops: Record<string, Loop>
├── parallels: Record<string, Parallel>
├── variables: Record<string, Variable>
└── actions: WorkflowActions               ← all mutations
```

### 16.2 Operation Queue (`stores/operation-queue/`)
All store mutations that need to persist to the DB go through an operation queue:
- Debounced writes (prevents spamming DB on rapid edits)
- Queued when offline; flushed on reconnect
- Operations are typed (`addBlock`, `updateBlock`, `addEdge`, etc.)
- `POST /api/workflows/{id}` (PATCH) to persist each operation

### 16.3 Diff System (`stores/workflow-diff/`)
Used by Copilot to compute what changed between two workflow states:
- Detect added/removed/modified blocks and edges
- Generate human-readable change descriptions
- Used in copilot checkpoint comparisons

### 16.4 Undo/Redo (`stores/undo-redo/`)
Zustand middleware that snapshots workflow state on every mutation. Standard undo/redo stack. Copilot undo goes deeper — it reverts to `workflowCheckpoints` records.

---

## 17. Execution API Flow (Complete Path)

```
Browser: POST /api/workflows/{id}/execute
  → ExecuteWorkflowSchema.parse(body)                     ← Zod validation
  → checkHybridAuth()                                     ← session or API key
  → tryAdmit() via admission gate                         ← rate limiting + concurrent execution limits
  → shouldExecuteInline()?
    YES: executeWorkflowCore() directly in request handler
    NO:  enqueue via getJobQueue()
  → loadWorkflowState() or loadDeployedWorkflowState()    ← from normalized tables or deployment snapshot
  → preprocessExecution() → parse input, process file fields
  → LoggingSession.start()                                ← creates workflowExecutionLogs record
  → DAGExecutor({
      workflow: SerializedWorkflow,
      envVarValues,
      workflowInput,
      workflowVariables,
      contextExtensions: { workspaceId, userId, executionId, metadata, callbacks }
    })
  → executor.execute(workflowId, triggerBlockId)
    → DAGBuilder.build() → DAG
    → ExecutionEngine.run()
      → Block execution loop with ready queue
      → Each block: VariableResolver.resolveInputs() → BlockHandler.execute() → state.setBlockOutput()
      → Pause points stored in pausedBlocks Map
  → LoggingSession.complete() → update workflowExecutionLogs record
  → Response: { success, output, logs, metadata }
       or SSE stream of ExecutionEvents
       or { executionId } for async mode
```

**Streaming response**: `createStreamingResponse()` wraps the execution in a `ReadableStream`, encoding each `ExecutionEvent` as an SSE frame. Block start/complete events, tool call events, LLM token events, final output — all streamed to the client in real-time.

---

## 18. Security Model

### 18.1 Input Sanitization
- `sanitizeInputFormat()` + `sanitizeTools()` — strip unexpected fields before passing to LLM providers
- `redactApiKeys()` — regex-based redaction of credential patterns from log data (applied in `BlockExecutor` before logging block inputs)
- Zod schemas on all API route bodies

### 18.2 Code Isolation
- **Function blocks** and **loop conditions**: executed in `isolated-vm` (V8 isolates)
  - No access to Node.js APIs unless explicitly provided
  - Timeout enforced at isolate level
  - Memory limits configurable
- **Skill code**: loaded into the same isolate as the calling agent block; sandbox prevents file system / network access

### 18.3 SSRF Prevention
- MCP server URL validation (`validateMcpServerSsrf()`) blocks private IP ranges
- Allowlist for permitted external domains
- API block also validates URLs (prevent internal network requests)

### 18.4 Credential Security
- Credentials stored encrypted in DB (`credential` table)
- Never logged — `redactApiKeys()` applied before all log writes
- `workspaceBYOKKeys` table for Bring Your Own Key encryption
- `CredentialBlockHandler` resolves at execution time, passes value in memory only

### 18.5 Rate Limiting
- `rateLimitBucket` table implements token-bucket sliding window
- Applied per workspace per endpoint
- Admission gate (`lib/core/admission/gate.ts`) enforces concurrent execution limits

---

## 19. Key Architectural Patterns to Adopt in Agentis

### Pattern 1: Sentinel Node Injection
Sim's approach to loops and parallels is elegant: inject invisible "start" and "end" sentinel nodes around the container. The engine never needs special-case logic for containers — it's just more nodes in the DAG. The orchestrators handle the iteration logic in the sentinel handlers.

**Agentis adaptation**: Add loop/parallel container types to the canvas; inject sentinel blocks during workflow serialization before passing to the engine.

### Pattern 2: Variable Resolver Chain
The resolver chain (Loop → Parallel → Workflow → Env → Block) with ordered priority elegantly handles all reference scenarios. No complex if/else dispatch — just try each resolver in order, return first match.

**Agentis adaptation**: Refactor Agentis's current template resolution into this resolver chain pattern; add Loop and Parallel resolvers when those blocks are built.

### Pattern 3: Block ID Suffixing for Parallelism
Instead of a separate execution context per branch, Sim suffixes block IDs with `₍N₎` (Unicode subscript) for parallel branch instances. This means `ExecutionState` is a flat map — no nested scopes — and cross-branch output lookup just strips the suffix.

**Agentis adaptation**: Same approach; use a different suffix delimiter if Unicode is awkward (e.g., `__branch_N__`).

### Pattern 4: Normalized Workflow Storage
Storing workflow definition in three normalized tables (`blocks`, `edges`, `subflows`) instead of a single JSONB blob enables:
- Per-block updates without full workflow rewrite
- SQL queries on block types/configs
- Deployed vs. live state separation without JSON diffing

**Agentis adaptation**: Migrate from monolithic `workflow.definition_json` to normalized tables.

### Pattern 5: Pluggable Async Backend
The `JobQueueBackend` interface with `trigger-dev` and `database` implementations means the same workflow execution code works in both self-hosted (DB polling) and cloud (Trigger.dev) deployments.

**Agentis adaptation**: Implement the same abstraction with `pg-boss` (Postgres) and future cloud job provider.

### Pattern 6: Execution Event Buffer
Redis ZSET with sequence numbers for SSE streaming allows:
- Multiple subscribers to the same execution stream
- Late subscribers to catch up on missed events (within TTL)
- Reliable delivery across pod restarts

**Agentis adaptation**: Implement the same Redis ZSET + sequence number pattern for the WebSocket broadcast during runs.

### Pattern 7: Execution Snapshot Deduplication
Content-hashing `SerializableExecutionState` before storing in `workflowExecutionSnapshots` means repeated executions of the same workflow state don't duplicate storage. The hash is a cheap Bloom filter alternative.

**Agentis adaptation**: Add content-hash deduplication when implementing run-from-block replay.

### Pattern 8: Handler + Generic Fallback
Having 15 dedicated handlers for core block types, plus a `GenericBlockHandler` that covers all tool blocks via a registry lookup, keeps the handler codebase manageable as integrations scale to 200+.

**Agentis adaptation**: The current approach of having individual skill implementations is even better (code-first vs config-first), but the `GenericBlockHandler` concept can apply for lightweight API-only integrations.

---

## 20. Gaps Confirmed by Source Reading

These gaps from `SIM-REFACTOR.md` are now confirmed with implementation details:

| Gap | Sim Implementation | Agentis Needs |
|-----|-------------------|---------------|
| **Loop Block** | Container node with 4 types, sentinel injection, LoopScope, isolated-vm for conditions | Sentinel pattern + LoopScope + isolated-vm |
| **Variables Block** | `VariablesBlockHandler` writes to `ExecutionContext.workflowVariables` in-memory | Add to WorkflowEngine context, expose via VariableResolver |
| **HITL Block** | `PauseMetadata` → `pausedExecutions` table → `resumeQueue` → snapshot resume | Run state machine + resume endpoint + serializable state |
| **Parallel Block** | Branch suffixing (`₍N₎`), `ParallelScope`, sentinel nodes, branchOutputs Map | Branch ID strategy + ParallelScope |
| **Tables** | `userTableDefinitions` + `userTableRows`, per-tx Postgres timeouts, filter/sort SQL | Schema + service + Table block handler |
| **Knowledge Base** | pgvector, chunking config, document processing pipeline, Knowledge block | Vector store abstraction + KB block handler |
| **MCP bidirectional** | `mcpServers` + `workflowMcpServer` tables, JSON-RPC 2.0 server endpoint, SSRF validation | MCP client + server endpoint + SSRF guards |
| **API Deployment** | `workflowDeploymentVersion`, inline vs async execution, Response block terminal | Deployment record + execution mode routing |
| **Async jobs** | `asyncJobs` table + Trigger.dev/DB backends | pg-boss or DB polling backend |
| **Snapshot replay** | `SerializableExecutionState` + content-hash dedup + `computeExecutionSets()` | Run-from-block context + snapshot serialization |
| **Cost calculation** | `ProviderTimingSegment` per iteration, pricing tables, `usageLog` table | Per-block cost accumulation + pricing config |
| **Enhanced logging** | `workflowExecutionSnapshots` linked to run logs, `traceSpans` JSONB in log record | Frozen canvas snapshot + span tree in run detail |
| **Copilot** | Full agentic loop, tool registry, async continuations, checkpoints, cloud-hosted intelligence | Workspace command agent using Agentis own primitives |
| **Realtime collab** | Socket.IO broadcast (not CRDT), room manager, Redis adapter, client-side undo stack | Yjs CRDT preferred over broadcast for stronger consistency |

---

*Document generated from direct source reading of `simstudioai/sim` · May 2026*
