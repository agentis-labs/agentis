# Agentis v1.0.0 — Architecture Reference

> This document is the authoritative technical reference for the Agentis v1.0.0
> platform. It describes every major subsystem, the data flow between them, and
> the extension points available to operators and contributors.

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Workflow Engine](#3-workflow-engine)
4. [Agents & Adapters](#4-agents--adapters)
5. [Triggers & Scheduler](#5-triggers--scheduler)
6. [Skills & Skill Runtimes](#6-skills--skill-runtimes)
7. [Integrations](#7-integrations)
8. [Knowledge Bases](#8-knowledge-bases)
9. [Packages & Registry](#9-packages--registry)
10. [Conversations & Channels](#10-conversations--channels)
11. [Authentication & Security](#11-authentication--security)
12. [Realtime & Event Bus](#12-realtime--event-bus)
13. [Observability & Ledger](#13-observability--ledger)
14. [Database Layer](#14-database-layer)
15. [CLI & Deployment](#15-cli--deployment)
16. [Extension Points](#16-extension-points)

---

## 1. Platform Overview

Agentis is a **self-hosted agent workflow platform**. It lets operators compose,
schedule, and monitor AI agent workflows — multi-step graphs where each node is
either a deterministic operation (integration call, variable binding, branching)
or a live agent task dispatched to a connected AI adapter.

### Core design principles

| Principle | Expression in v1.0.0 |
|---|---|
| **Self-hosted first** | Single binary or Docker container; SQLite as default; no cloud dependency |
| **Graph-native execution** | Workflows are directed graphs, not YAML scripts — parallel branches, loops, subflows, and checkpoints are first-class constructs |
| **Adapter-agnostic agents** | Any agent runtime (HTTP, OpenClaw, ClaudeCode, Codex, Hermes, local LLM) plugs in through a single adapter interface |
| **Observable by default** | Every node execution is ledgered, every cost is tracked, every run is replayable |
| **Multi-tenant** | All data is scoped to `workspaceId`; every query enforces workspace isolation |

### Data flow at a glance

```
Trigger fires
    ↓
WorkflowEngine.startRun()
    ↓  (builds initial RunState from graph snapshot)
#tick() → selects ready nodes from readyQueue
    ↓
#dispatchNode() → routes by node.config.kind
    ↓
agent_task → AdapterManager.dispatchTask()
    ↓  (adapter streams events back)
notifyTaskCompleted() → #completeNode()
    ↓
#tick() → next ready nodes  ...  RunState.status = COMPLETED
    ↓
LedgerService.append() at each transition
ActivityFeedService.record() at run open/close
BudgetService.settle() at run close
```

---

## 2. Monorepo Structure

```
agentis/
├── apps/
│   ├── api/          @agentis/api    — Hono HTTP server, engine, services, routes
│   └── web/          @agentis/web    — React SPA (Vite, Tailwind, xyflow canvas)
├── packages/
│   ├── core/         @agentis/core   — Shared types, events, errors, schemas
│   ├── db/           @agentis/db     — Drizzle schema, migrations, SQLite helpers
│   ├── integrations/ @agentis/integrations — ConnectorRegistry + built-in connectors
│   ├── sdk/          @agentis/sdk    — Public SDK for external tool authors
│   └── cli/          @agentis/cli    — CLI: up / stop / bootstrap / backup / restore
├── e2e/              Playwright end-to-end specs
├── scripts/          agentis-doctor.ts preflight diagnostics
├── docker-compose.yml
├── Dockerfile
└── railway.toml
```

### Key dependency graph

```
@agentis/core
    ↑ (types, errors, events)
@agentis/db ──────────────────── schema, migrations, openSqlite()
    ↑
@agentis/integrations ─────────── ConnectorRegistry, connectors
    ↑
@agentis/api ──────────────────── engine, services, routes, bootstrap
    ↑ (proxied in dev)
@agentis/web ──────────────────── SPA, Vite, xyflow canvas
```

`@agentis/core` has zero runtime dependencies. `@agentis/db` depends only on
`drizzle-orm` and `better-sqlite3`. Nothing in `packages/` depends on `apps/`.

---

## 3. Workflow Engine

**File:** `apps/api/src/engine/WorkflowEngine.ts`

The engine is the execution core. It owns the lifecycle of every workflow run:
from initial state construction through tick-driven node dispatch to terminal
status transitions and recovery.

### 3.1 RunState

Each run is represented as a `WorkflowRunState` stored in `workflow_runs.run_state`
(JSON column). It contains:

```typescript
interface WorkflowRunState {
  status:       'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING'
  nodeStates:   Record<nodeId, NodeState>   // status per node
  readyQueue:   ReadyQueueItem[]            // nodes waiting to be dispatched
  variables:    Record<string, unknown>     // workflow-level variable store
  observability: {
    blockData:        Record<nodeId, BlockData>
    cacheHits:        CacheHitRecord[]
    graphSnapshot:    WorkflowGraph
    graphSnapshotHash: string
  }
  costMicros:   number   // accumulated USD * 1e6
}
```

`readyQueue` is the engine's scheduler: the `#tick()` method drains it,
dispatching each item through `#dispatchNode()`.

### 3.2 Node kinds

| Kind | Behaviour |
|---|---|
| `trigger` | Pass-through; seeds initial inputs |
| `agent_task` | Dispatches to AdapterManager; async callback via `notifyTaskCompleted` |
| `skill_task` | Runs a registered skill in the workspace; result returned synchronously |
| `evaluator` | Scores an agent output against a rubric; emits pass/fail verdict |
| `guardrails` | Policy gate — blocks or allows passage based on content policy |
| `goal_task` | Structured goal decomposition node |
| `scratchpad` | Named working memory; readable/writable by any node in the same run |
| `variables` | Binds or updates workflow-level variables |
| `context_compress` | Reduces context size via key_filter, extractive, or llm_summary strategy |
| `table` | Reads/writes structured tabular data |
| `knowledge` | Queries a connected knowledge base |
| `router` | Dynamic branching based on a condition expression |
| `checkpoint` | Saves a named state snapshot; enables partial replay |
| `human_in_the_loop` | Pauses execution pending an operator approval decision |
| `wait` | Timed pause |
| `loop` | Iterates over a collection, dispatching child subgraphs per item |
| `parallel` | Fan-out to N concurrent child branches, fan-in at merge |
| `merge` | Union pass-through for converging parallel branches |
| `response` | Emits the run's final output value |
| `subflow` | Nests a complete workflow as a child run via `SubflowExecutor` |
| `integration` | Executes a connector action via `ConnectorRegistry` |

### 3.3 Tick loop

```
#tick(ctx)
  while (readyQueue.length > 0 || inflightDispatches > 0):
    for each item in readyQueue:
      inflightDispatches++
      #dispatchNode(item)
        .then(() => #tick(ctx))   ← re-tick after each completion
        .catch(handleFailure)
        .finally(() => inflightDispatches--)
  if readyQueue.empty AND inflightDispatches === 0:
    #attemptSettle(ctx)   ← check for terminal state
```

The `inflightDispatches` counter prevents premature settle when passthrough
nodes (trigger, merge, router) complete synchronously mid-tick.

### 3.4 Fan-out / fan-in (parallel nodes)

```
parallel node:
  for each branch:
    creates a child RunState slice
    adds each branch head to readyQueue
  #tick() dispatches all branches concurrently

merge node (at convergence):
  waits until all expected edges have arrived
  unions all incoming contexts
  passes unified context to downstream node
```

### 3.5 Retry and recovery

- **Per-node retry:** Each node config carries `maxAttempts` and `retryBackoffMs`.
  On failure, `#scheduleRetry()` enqueues a `NODE_RETRY_SCHEDULED` event and
  re-adds the node to `readyQueue` after the backoff.
- **Watchdog:** `startWatchdog()` runs a 2s probe that calls `recoverActiveRuns()`
  on startup and after crashes. Runs in `RUNNING` or `WAITING` status that were
  interrupted are reconstructed from their persisted `runState`.
- **Partial replay:** `PartialReplayService` supports four replay modes:
  `from_checkpoint`, `failed_branch_only`, `single_node`, and `from_node`.
  Each mode rebuilds a `RunState` from the graph snapshot and ledger history,
  preserving completed node outputs.

### 3.6 Concurrency control

`workflows.max_concurrent_runs` (nullable INT) caps how many runs of the same
workflow can be RUNNING simultaneously. The overflow policy
(`concurrencyOverflow: 'queue' | 'reject' | 'replace_oldest'`) determines
what happens to a new trigger when the cap is hit.

### 3.7 Caching

Node-level caching is keyed on `(workspaceId, workflowId, nodeId, inputHash)`.
A cache hit skips dispatch entirely and emits `NODE_CACHE_HIT`. Cache entries
carry a TTL and hit count. The cache can be cleared per-node or per-workflow
via `DELETE /v1/workflows/:id/cache`.

---

## 4. Agents & Adapters

**File:** `apps/api/src/adapters/`

### 4.1 Adapter interface

All adapters implement:

```typescript
interface AgentAdapter {
  adapterType: string
  dispatchTask(task: NormalizedTask): Promise<void>
  onEvent(handler: (event: NormalizedAgentEvent) => void): () => void
  cancelTask(taskId: string): Promise<void>
  healthCheck(): Promise<AdapterHealthResult>
}
```

The engine calls `AdapterManager.dispatchTask(task, agentId)`. The adapter
streams `NormalizedAgentEvent` objects back (task.started → task.streaming →
task.completed or task.failed). The engine's `onEvent` subscriber routes these
to `notifyTaskCompleted()` / `notifyTaskFailed()`.

### 4.2 Adapter implementations

| Adapter | Description |
|---|---|
| `OpenClawAdapter` | Connects to an OpenClaw gateway process over WebSocket |
| `HttpAdapter` | Generic HTTP POST adapter; any endpoint that speaks the Agentis task protocol |
| `ClaudeCodeAdapter` | Spawns claude-code CLI as a subprocess; streams stdout events |
| `CodexAdapter` | OpenAI Codex/GPT-4o via the Responses API with tool-use loop |
| `HermesAdapter` | Agentis-native Hermes agents (runs locally with the Hermes runtime) |
| `HermesAgentAdapter` | Hermes multi-agent variant with team coordination |
| `LocalLlmAdapter` | Ollama or any OpenAI-compatible local endpoint |
| `CursorAdapter` | Cursor AI IDE integration |

### 4.3 Adapter registration

Adapters are registered against an agent record at bootstrap time or when a
gateway connects. `AdapterManager.register(agentId, adapter)` maps one adapter
per agent. Multiple gateways (each hosting one or more agents) can be registered
simultaneously.

### 4.4 NormalizedTask

The engine builds a `NormalizedTask` that carries everything an agent needs:

```typescript
interface NormalizedTask {
  taskId:        string
  workflowId:    string
  runId:         string
  nodeId:        string
  agentId:       string
  instructions:  string          // assembled from node config + variables
  context:       string          // upstream node outputs
  tools:         AgentTool[]     // MCP tools + integration actions
  budgetCents:   number          // per-task spend cap
  mcpServerIds?: string[]        // MCP server references
  playbook?:     string          // agent system prompt
}
```

### 4.5 Cost tracking

Every `agent_task` node can carry `estimatedCostCents`. The engine accumulates
`costMicros` (USD × 10⁶, integer arithmetic) across all nodes in a run. At run
close, `BudgetService.settle()` reconciles actual against estimated and records
the final figure on `workflow_runs.cost_micros`.

---

## 5. Triggers & Scheduler

**Files:** `apps/api/src/services/scheduler.ts`, `apps/api/src/routes/triggers.ts`

### 5.1 Trigger types

| Type | Description |
|---|---|
| `manual` | Operator-initiated via `POST /v1/workflows/:id/runs` |
| `cron` | Time-based schedule via `node-cron` expressions |
| `webhook` | HMAC-verified inbound HTTP call to `/v1/webhooks/trigger/:triggerId` |
| `listener` | Responds to internal realtime events (e.g., `RUN_COMPLETED` on another workflow) |

### 5.2 TriggerRuntime

`TriggerRuntime` manages the lifecycle of active triggers:

- **Cron:** installs a `node-cron` job; on fire, enqueues a run via
  `workflow_run_queue`.
- **Webhook:** validates HMAC signature (`createHmac('sha256', secret).update(\`${ts}.${body}\`)`)
  and delivery idempotency (`webhook_events.delivery_id UNIQUE`) before starting
  a run.
- **Listener:** subscribes to the event bus; on matching `eventType` from the
  source workflow, fires the target workflow (subject to `coalescePolicy` and
  `catchupPolicy`).

### 5.3 Run queue

`workflow_run_queue` provides durable buffering when the concurrency cap is hit
or a trigger fires while the server is down:

```
workflow_run_queue
  id, workspaceId, workflowId, userId
  inputs (JSON), initialState, graphSnapshot
  enqueuedAt, scheduledAt, priority
  reason, parentRunId, chainDepth
  status: pending | processing | dequeued | dropped
```

`SchedulerService.tick()` runs on a 1s interval, draining pending queue items
against the concurrency cap.

### 5.4 Event chains

Workflows can subscribe to outcomes of other workflows via
`workflow_event_subscriptions`. On `RUN_COMPLETED` / `RUN_FAILED` /
`NODE_COMPLETED` / `NODE_FAILED`, the scheduler checks for matching
subscriptions and fires the target workflow with the mapped inputs. Chain depth
is capped at `EVENT_CHAIN_MAX_DEPTH = 5`.

---

## 6. Skills & Skill Runtimes

**Files:** `apps/api/src/services/skillRuntime.ts`, `skillIsolatePool.ts`,
`skillDockerPool.ts`, `builtinSkills.ts`

### 6.1 Skill tiers

| Tier | Runtime | Isolation | When available |
|---|---|---|---|
| `builtin` | In-process | None (trusted code) | Always |
| `node_worker` | `isolated-vm` V8 isolate | Memory + CPU sandboxed | When `isolated-vm` is installed |
| `docker_sandbox` | `dockerode` container | Full OS-level | When Docker socket is available |

The `skillRuntime.ts` service dispatches to the correct pool based on
`skill.manifest.runtime`. If the required runtime is unavailable, the node
outputs a structured `SKILL_RUNTIME_UNAVAILABLE` outcome rather than throwing.

### 6.2 Built-in skills

- **`echo`** — returns its input unchanged (useful for testing and passthrough)
- **`http_fetch`** — outbound HTTP with SSRF protection (`safeUrl.ts` validates
  against RFC6761 reserved TLDs and private IP ranges)

### 6.3 Skill manifest

Skills are installed with a typed manifest:

```typescript
interface SkillManifest {
  name:          string
  slug:          string
  version:       string
  runtime:       'builtin' | 'node_worker' | 'docker_sandbox'
  entrypoint:    string         // file path or inline source
  capabilityTags?: string[]
  inputSchema?:  JSONSchema
  outputSchema?: JSONSchema
  timeoutMs?:    number
}
```

### 6.4 Skill registry

When `AGENTIS_SKILL_REGISTRY_URL` is configured, the registry client fetches
available skills. Installation requires:

1. Operator acknowledges permissions (`permissionsAcknowledged: true`)
2. Artifact bytes are fetched and SHA-256 verified against the registry manifest
3. `RegistryScanner` checks for secrets, PEM keys, and prompt-injection markers
4. On pass: `installed_registry_artifacts` row is created; skill is active

Skills can also be installed locally via `POST /v1/skills/install-local`.

---

## 7. Integrations

**Package:** `packages/integrations/`

### 7.1 ConnectorRegistry

`ConnectorRegistry` is the central integration hub. It holds connector
manifests and dispatches `execute(connectorId, action, params, credentials)`
calls at runtime. The engine's `integration` node type calls
`defaultConnectorRegistry.execute()`.

### 7.2 Credential resolution

Credentials are encrypted at rest in `CredentialVault` (AES-256-GCM,
key stored in `secrets.json`). At dispatch time:
- Scalar credentials → `{ value: string }`
- JSON credentials → parsed to object

`CredentialVault.rotateAll()` re-encrypts all credentials in a single
transaction when the key is rotated.

### 7.3 Built-in connectors

| Connector | Actions |
|---|---|
| `http_request` | GET, POST, PUT, PATCH, DELETE with headers, body, and auth |
| `webhook_send` | POST to a configured URL with retry and HMAC signing |
| `slack` | Send message, upload file, create channel |
| `gmail` | Send email, read inbox, search messages |
| `github` | Create/read issues, PRs, repos, commits |
| `google_sheets` | Read/write cells, append rows, clear ranges |

Additional connectors are manifest-only stubs; their `execute` handlers are
added as they are implemented.

---

## 8. Knowledge Bases

**Files:** `apps/api/src/services/knowledgeBase.ts`, `knowledgeStore.ts`,
`dataIngestion.ts`

### 8.1 Structure

```
knowledge_bases
  id, workspaceId, name, description, createdAt
  └── kb_documents
        id, kbId, title, mimeType, storedAt
        └── kb_chunks
              id, documentId, content, embedding (JSON float32 array)
```

### 8.2 Document ingestion

`dataIngestion.ts` processes uploaded files:
1. Extracts text (PDF, DOCX, TXT, Markdown, HTML)
2. Splits into overlapping chunks (512 tokens, 64-token stride)
3. Embeds each chunk via the workspace embedding provider
4. Inserts `kb_chunks` rows with embedding vectors

### 8.3 Retrieval

The `knowledge` node type in workflows queries a knowledge base at run time.
Retrieval uses cosine similarity between the query embedding and stored chunk
embeddings, returning top-K chunks above a configurable similarity threshold.
Results are injected into the node's output context.

### 8.4 Auto-linking

`KnowledgeAutoLinker` connects newly uploaded documents to relevant existing
workspace knowledge by comparing embeddings and inserting `knowledge_links`
with a computed weight.

---

## 9. Packages & Registry

**Files:** `apps/api/src/services/packager.ts`, `apps/api/src/routes/packages.ts`

### 9.1 Package manifest

An Agentis package is a JSON manifest that declares a bundle of resources:

```typescript
interface AgentisPackageContents {
  agents:      AgentSeed[]
  workflows:   WorkflowSeed[]
  skills:      SkillSeed[]
  triggers?:   TriggerSeed[]
  credentials?: CredentialSeed[]
  knowledge?:  KnowledgeBaseSeed[]
}
```

### 9.2 Activation

`Packager.activate(packageId, workspaceId)` processes a manifest:

1. Creates or updates agent records from `agents` seeds
2. Creates workflow records from `workflows` seeds (graphs preserved)
3. Installs skills from `skills` seeds via `SkillRuntime`
4. Creates trigger records and registers them with `TriggerRuntime`
5. Provisions credentials (operator fills values; package provides keys)
6. Creates knowledge base stubs ready for document population

Packages support versioning. Re-activating a newer version patches existing
resources and creates new ones; it does not delete operator-added data.

### 9.3 Hub bridge

When `AGENTIS_HUB_URL` is configured, `HubBridge` connects to the package
registry hub. Operators can browse, install, and update packages from the
Skills → Packages page in the dashboard. Registry communication is read-only
and anonymous; installation is local.

---

## 10. Conversations & Channels

**Files:** `apps/api/src/services/conversationStore.ts`, `sessionMirror.ts`,
`channelBridge.ts`, `apps/api/src/adapters/channels/`

### 10.1 Conversation model

Conversations are persistent message threads between operators and agents.
Each conversation is scoped to an `(agentId, workspaceId)` pair.

```
conversations
  id, workspaceId, agentId, userId, title, createdAt
  └── conversation_messages
        id, conversationId, role (user|assistant|system|tool), content
        authorType (operator|agent|system), createdAt
```

`ConversationStore` provides read/write/search over messages.
`SessionMirror.bind(adapter)` taps into adapter side-channel events
(`session.message`, `approval.requested`) and appends them to the correct
conversation.

### 10.2 Channel bridge

External messaging platforms connect via `ChannelBridge`. Each channel
connection is stored in `channel_connections` with an encrypted token:

```
channel_connections
  id, workspaceId, agentId, channelType, encryptedToken
  webhookSecret, status (active|paused|error)
```

Inbound messages arrive at `POST /v1/webhooks/channel/:id` (unauthenticated,
HMAC-verified per-channel) and are dispatched to the linked agent as a
conversation message, triggering a reply.

**Supported channels:**

| Channel | Inbound | Outbound |
|---|---|---|
| Telegram | ✓ (bot token, secret header verify) | ✓ |
| Discord | — | ✓ (webhook URL) |

New channels implement the `ChannelAdapter` interface:
`verify(req) → boolean`, `receive(req) → ChannelMessage`,
`send(message, credentials) → void`.

### 10.3 Delivery idempotency

`channel_deliveries.external_id` carries a UNIQUE constraint. Duplicate
inbound message IDs (Telegram `update_id`, Discord `message_id`) are silently
dropped, making webhook replay safe.

---

## 11. Authentication & Security

**Files:** `apps/api/src/services/auth.ts`, `apps/api/src/middleware/`

### 11.1 JWT authentication

Agentis issues signed RS256 JWT access + refresh token pairs:

- **Access token:** 15-minute TTL; carries `userId`, `workspaceId`, `kid`
  (RFC 7638 thumbprint), `jti` (random UUID per issue).
- **Refresh token:** 30-day TTL; stored hashed in `refresh_tokens` table.
- **Public key:** served at `GET /.well-known/jwks.json` for external
  verification.
- **Local launch:** `GET /v1/auth/launch` issues a token automatically on
  localhost without credentials (local CLI flow).

### 11.2 Rate limiting

Token-bucket rate limiter (`middleware/rateLimit.ts`):

- `POST /v1/auth/login`: 5 requests/min per `(IP, username)` + 20/min per IP
- Failed attempts use a non-existent username to skip bcrypt and exhaust the
  bucket at minimal CPU cost
- Returns `429 OPERATION_RATE_LIMITED` on breach

### 11.3 Security headers

`middleware/securityHeaders.ts` applies on every response:

- `Content-Security-Policy`: forbids inline scripts, restricts frame ancestors
- `Strict-Transport-Security`: max-age 1 year, subdomains (production only)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`

### 11.4 SSRF protection

`safeUrl.ts` is enforced on all outbound HTTP from skills and integrations.
It rejects:
- RFC 1918 private IP ranges (10.x, 172.16–31.x, 192.168.x)
- Loopback (127.x, ::1)
- Link-local (169.254.x, fe80::/10)
- RFC 6761 reserved TLDs (.local, .localhost, .invalid, .test, .example)

### 11.5 Unauthenticated allow-list

`security/unauthAllowList.ts` is the single source of truth for routes that
bypass `requireAuth`. Currently: `/healthz`, `/v1/auth/*`, `/.well-known/*`,
`/v1/webhooks/*`, `/v1/openapi.json`, `/v1/docs`. Any new unauthenticated
endpoint must be added here; the allow-list is contractually pinned by a test.

### 11.6 Audit log

`middleware/auditLog.ts` intercepts every authenticated `POST`, `PATCH`, `PUT`,
`DELETE` request to `/v1/*`. It resolves the entity type from the URL prefix,
maps the HTTP verb to an action name, and writes an `activity_events` row
with `actorId`, `entityType`, `entityId`, `action`, and ISO-8601 timestamp.
Failures are swallowed as warnings so they never break the response.

---

## 12. Realtime & Event Bus

**Files:** `packages/core/src/events.ts`, `apps/api/src/websocket/`

### 12.1 Socket.io rooms

The API server runs a Socket.io server alongside Hono. Clients join typed rooms:

| Room kind | Key | Events received |
|---|---|---|
| `workspace` | `workspaceId` | Agent status, workflow mutations, budget events |
| `workflow` | `workflowId` | NODE_STARTED, NODE_COMPLETED, NODE_FAILED, graph patches |
| `run` | `runId` | All node events for a specific run |
| `agent` | `agentId` | Presence events, terminal messages, heartbeats |
| `gateway` | `gatewayId` | Gateway connect/degrade/disconnect |
| `conversation` | `agentId` | Conversation message events |

### 12.2 Canonical events

All publish/subscribe uses canonical keys from `REALTIME_EVENTS` in
`@agentis/core`. Magic strings are not permitted. Key event groups:

```
Runs:          RUN_CREATED | RUN_RUNNING | RUN_COMPLETED | RUN_FAILED | RUN_QUEUED
Nodes:         NODE_STARTED | NODE_COMPLETED | NODE_FAILED | NODE_WAITING_FOR_INPUT
               NODE_RETRY_SCHEDULED | NODE_CACHE_HIT | NODE_COMPRESS_STATS
Agents:        AGENT_CREATED | AGENT_UPDATED | AGENT_STATUS_CHANGED | AGENT_HEARTBEAT
Presence:      AGENT_PRESENCE_FOCUS | AGENT_PRESENCE_BLUR | AGENT_PRESENCE_THINKING
               AGENT_TERMINAL_MESSAGE | AGENT_TERMINAL_TOOL_CALL
Approvals:     APPROVAL_REQUESTED | APPROVAL_RESOLVED
Activity:      ACTIVITY_CREATED | LEDGER_EVENT
Conversations: CONVERSATION_MESSAGE_RECEIVED | CONVERSATION_MESSAGE_SENT
Channels:      CHANNEL_MESSAGE_RECEIVED | CHANNEL_MESSAGE_SENT
Canvas:        CANVAS_NODE_PLACED | CANVAS_EDGE_CONNECTED | CANVAS_BUILD_COMPLETE
Scheduler:     SCHEDULE_FIRED | EVENT_CHAIN_FIRED | WATCHDOG_TIMEOUT
Workflows:     WORKFLOW_CREATED | WORKFLOW_UPDATED | WORKFLOW_GRAPH_PATCHED
```

### 12.3 Internal bus

Within the API process, `EventBus` provides pub/sub between services without
going through Socket.io. It carries `BusMessage = { room, envelope }`. Services
subscribe with `bus.subscribe((msg) => { if (msg.room === ...) ... })`.

### 12.4 Web client

```typescript
// Single shared socket — never instantiate per-component
const socket = getSocket()   // apps/web/src/lib/realtime.ts

// React hook
useRealtime([REALTIME_EVENTS.NODE_COMPLETED], (env) => { ... })

// Room subscription
rtSubscribe('run', { runId })
```

---

## 13. Observability & Ledger

**Files:** `apps/api/src/services/ledger.ts`, `apps/api/src/services/activityFeed.ts`

### 13.1 Ledger

Every state transition in a run is appended to `ledger_events` as an
immutable, append-only record:

```
ledger_events
  id, workspaceId, runId, sequenceNumber (per-run)
  eventType, nodeId, payload (JSON)
  createdAt
```

The ledger is the source of truth for replay (`PartialReplayService`),
transcript rendering, and run debugging. `GET /v1/runs/:id/ledger` returns
the full event sequence. FTS5 indexing enables full-text search across payloads.

### 13.2 blockData

For each completed node, the engine stores `blockData[nodeId]` in the run
state:

```typescript
interface BlockData {
  inputData:    unknown   // what the node received
  outputData:   unknown   // what it produced
  compression?: { inputChars, outputChars, reductionRatio }
  cacheHit?:    boolean
  durationMs:   number
  costMicros:   number
}
```

This is exposed in the canvas ContextInspector (I/O tab) and the run detail
page.

### 13.3 Run history and health

`GET /v1/workflows/:id/health?window=24h|7d|30d` returns:

```typescript
{
  runCount:    number
  successRate: number   // 0–1
  trend:       'up' | 'flat' | 'down'
  mostFailingNodeId?: string
}
```

Node-level history: `GET /v1/workflows/:id/nodes/:nodeId/run-history` returns
the last 50 executions of that node with status, duration, and I/O.

### 13.4 Activity feed

`ActivityFeedService.record()` writes `activity_events` rows at meaningful
operator-facing moments (run started, run completed, approval resolved, skill
installed, package activated). These surface in the dashboard History page
grouped by timeline.

### 13.5 Telemetry

When `AGENTIS_OTEL_ENDPOINT` is configured, `loadTelemetry()` dynamically
imports the OpenTelemetry SDK and instruments:

- `engine.tick` span (per WorkflowEngine `#tick` cycle)
- `adapter.dispatch` span (per `AdapterManager.dispatchTask` call)

When the SDK is absent, a no-op `noopTelemetry` is used. Startup never fails
due to missing telemetry dependencies.

---

## 14. Database Layer

**Package:** `packages/db/`

### 14.1 Drivers

| Mode | Driver |
|---|---|
| Default (self-hosted) | `better-sqlite3` (synchronous, WAL mode) |
| Embedded (test harness) | In-memory `better-sqlite3` with full schema |

PostgreSQL (`AGENTIS_MODE=standard`) is architecturally planned but not
implemented in v1.0.0. The SQLite path is the production golden path.

### 14.2 Schema highlights

| Table | Purpose |
|---|---|
| `workspaces` | Multi-tenant root; every query scopes to this |
| `users` | Operator accounts (email, bcrypt hash, role) |
| `agents` | Agent registry (adapterType, config, capabilityTags, status) |
| `workflows` | Workflow definitions (graph JSON, settings, concurrency config) |
| `workflow_runs` | Execution instances (runState JSON, costMicros, blockData) |
| `workflow_run_queue` | Durable trigger buffer (priority, chainDepth, status) |
| `triggers` | Trigger records per workflow (type, config, status) |
| `tasks` | Agent task executions (nodeId, inputData, outputData, status) |
| `ledger_events` | Append-only run event log (sequenceNumber, payload) |
| `node_execution_cache` | Input-hash-keyed node output cache |
| `schedule_runs` | Cron schedule state (scheduledAt, lastFiredAt, missedFires) |
| `workflow_event_subscriptions` | Event chain wiring between workflows |
| `skills` | Installed skills (manifest JSON, runtime, slug) |
| `installed_registry_artifacts` | Skills installed from registry (SHA-256 verified) |
| `agent_packages` | Package installation records (manifest, version) |
| `credentials` | Encrypted credential store (AES-256-GCM) |
| `approval_requests` | Human-in-the-loop gates (status, source, title) |
| `conversations` | Agent conversation threads |
| `conversation_messages` | Individual messages (role, content, authorType) |
| `channel_connections` | External channel bridge (encrypted token, webhookSecret) |
| `channel_deliveries` | Idempotency log for inbound channel messages |
| `knowledge_bases` | KB metadata (name, workspaceId) |
| `kb_documents` | Uploaded documents |
| `kb_chunks` | Embedded text chunks (content, embedding JSON) |
| `activity_events` | Operator-facing audit log |
| `refresh_tokens` | Active refresh tokens (hashed) |
| `webhook_events` | Inbound webhook idempotency (deliveryId UNIQUE) |

### 14.3 Migrations

`runSqliteMigrations(db)` in `packages/db/src/migrations.ts` is version-stamped
using a `migrations` table. Each migration is idempotent (`CREATE TABLE IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`). The embedded in-memory path
(`EMBEDDED_INIT_SQL`) mirrors the same schema so tests get identical structure.

### 14.4 Multi-tenancy pattern

Every service method takes `workspaceId` as a first-class parameter and applies
it as a WHERE clause. No cross-workspace data is ever returned. Row-level
enforcement is validated by the security test suite.

---

## 15. CLI & Deployment

**Package:** `packages/cli/`

### 15.1 CLI commands

```bash
agentis up [--port 3737] [--data-dir .agentis]   # start API + serve dashboard
agentis stop                                       # graceful shutdown
agentis bootstrap --url <url> --api-key <key>      #   register as an agent
agentis backup [--output ./backup]                 # snapshot DB + secrets
agentis restore <dir> [--force]                    # restore from backup
agentis doctor                                     # preflight diagnostics
```

### 15.2 `agentis doctor` checks

| Check | Condition |
|---|---|
| Node version | ≥ 20.10 |
| Data directory | `.agentis/` exists and is writable |
| Secrets file | `secrets.json` present, mode 0600, contains required JWT + credential keys |
| SQLite | `better-sqlite3` loads; DB opens; `PRAGMA integrity_check = ok`; WAL mode |
| Ports | 3737 (API) and 5173 (web dev) are free |

### 15.3 Backup and restore

`backup.ts` uses `sqlite3.backup(dest)` (SQLite online backup API — consistent
snapshot without locking reads). The backup directory contains:

```
backup-YYYY-MM-DDTHH-MM-SS/
  manifest.json   { version: 1, createdAt, dbFile, hasSecrets }
  data.db         full DB snapshot
  secrets.json    (chmod 0600, optional)
```

Restore validates the manifest version and refuses to overwrite an existing
database without `--force`.

### 15.4 Docker

The `Dockerfile` builds a production image:

```
FROM node:20-alpine
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
EXPOSE 3737
ENTRYPOINT ["node", "apps/api/dist/index.js"]
```

Health probe: `GET /healthz` returns `{ ok: true }`.

`docker-compose.yml` provides a one-command local stack:
```bash
docker compose up -d
```

### 15.5 Railway

`railway.toml` configures Railway deployment with the same health probe and
`PORT` environment variable. The build command is `pnpm install && pnpm build`.

### 15.6 Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENTIS_DATA_DIR` | `.agentis` | Data directory for DB and secrets |
| `AGENTIS_PORT` | `3737` | HTTP server port |
| `AGENTIS_DASHBOARD_DIST` | — | Path to pre-built dashboard; serves as SPA |
| `AGENTIS_SEED_PASSWORD` | (random) | Initial operator password on first boot |
| `AGENTIS_SKILL_REGISTRY_URL` | — | Skill registry hub; disabled if unset |
| `AGENTIS_HUB_URL` | — | Package hub; disabled if unset |
| `AGENTIS_OTEL_ENDPOINT` | — | OpenTelemetry collector; disabled if unset |
| `AGENTIS_OTEL_SERVICE_NAME` | `agentis-api` | Service name for telemetry |
| `NODE_ENV` | `development` | `production` enables HSTS and disables test harness |

---

## 16. Extension Points

### 16.1 Adding a new node kind

1. Define the config schema in `packages/core/src/schemas/workflow.ts` —
   add a discriminated union branch keyed on `kind`.
2. Add a case to `#dispatchNode()` in `WorkflowEngine.ts`.
3. Add the node label in `ContextInspector` (Configure tab form).
4. Add the node icon to `NODE_GLYPH` in `WorkflowNode.tsx`.
5. Add the node to `PALETTE_NODES` in `NodePalette.tsx`.

### 16.2 Adding a new adapter

1. Implement `AgentAdapter` in `apps/api/src/adapters/YourAdapter.ts`.
2. Emit `NormalizedAgentEvent` via the registered `onEvent` callback.
3. Register in `bootstrap.ts`: `adapterManager.register(agentId, new YourAdapter(config))`.
4. Add the `adapterType` string to the `agents.adapter_type` allowed values.

### 16.3 Adding a new connector

1. Create `packages/integrations/src/connectors/yourConnector.ts` implementing
   `ConnectorDef { id, manifest, execute(action, params, credentials) }`.
2. Register in `ConnectorRegistry` by adding to the `connectors` array in
   `packages/integrations/src/index.ts`.

### 16.4 Adding a new channel adapter

1. Implement `ChannelAdapter` in `apps/api/src/adapters/channels/yourChannel.ts`:
   `verify(req) → boolean`, `receive(req) → ChannelMessage`,
   `send(message, credentials) → Promise<void>`.
2. Register in `ChannelBridge.getAdapter(channelType)`.

### 16.5 Adding a new realtime event

1. Add the key to `REALTIME_EVENTS` in `packages/core/src/events.ts`.
2. Emit via `deps.bus.publish(REALTIME_ROOMS.workspace(id), REALTIME_EVENTS.YOUR_KEY, payload)`.
3. Subscribe in the web component: `useRealtime([REALTIME_EVENTS.YOUR_KEY], handler)`.

### 16.6 Adding a new route

1. Create `apps/api/src/routes/yourResource.ts` exporting a
   `buildYourResourceRoutes(deps) → Hono` factory.
2. Mount in `apps/api/src/bootstrap.ts`:
   `app.route('/v1/your-resource', buildYourResourceRoutes(deps))`.
3. If unauthenticated, add the path to `security/unauthAllowList.ts`.

---

## Appendix A — API Surface Summary

All routes are mounted under `/v1/`. Authentication via `Authorization: Bearer <token>`
and `x-agentis-workspace: <workspaceId>` headers on every authenticated request.

| Resource | Methods | Path |
|---|---|---|
| Auth | POST login/refresh/logout, GET me/launch | `/v1/auth/*` |
| Workspaces | GET list/get, POST create, PATCH update | `/v1/workspaces/*` |
| Agents | GET list/get, POST create, PATCH update | `/v1/agents/*` |
| Workflows | GET list/get/health, POST create/run/draft, PATCH update | `/v1/workflows/*` |
| Runs | GET list/get/ledger/transcript, POST cancel/retry | `/v1/runs/*` |
| Triggers | GET list/get, POST create, PATCH update, DELETE | `/v1/triggers/*` |
| Schedules | GET/POST/PATCH/DELETE | `/v1/schedules/*` |
| Subscriptions | GET/POST/PATCH/DELETE | `/v1/subscriptions/*` |
| Skills | GET list, POST install-local | `/v1/skills/*` |
| Packages | GET list/get, POST install/activate, PATCH | `/v1/packages/*` |
| Credentials | GET list, POST create, PATCH update, DELETE | `/v1/credentials/*` |
| Knowledge | GET/POST/PATCH/DELETE bases + documents | `/v1/knowledge/*` |
| Conversations | GET/POST messages, GET list | `/v1/conversations/*` |
| Channels | GET/POST/PATCH/DELETE + webhook-info | `/v1/channels/*` |
| Approvals | GET list, POST resolve | `/v1/approvals/*` |
| Gateways | GET/POST/PATCH/DELETE + health | `/v1/gateways/*` |
| Tasks | GET list/get | `/v1/tasks/*` |
| Ledger | GET events | `/v1/runs/:id/ledger` |
| Activity | GET feed | `/v1/activity/*` |
| Dashboard | GET metrics | `/v1/dashboard/*` |
| Webhooks | POST (unauthenticated) | `/v1/webhooks/trigger/:id`, `/v1/webhooks/channel/:id` |
| JWKS | GET | `/.well-known/jwks.json` |
| Health | GET | `/healthz` |
| OpenAPI | GET spec + docs | `/v1/openapi.json`, `/v1/docs` |

---

## Appendix B — Workflow Graph Schema

```typescript
interface WorkflowGraph {
  nodes:    WorkflowNode[]
  edges:    WorkflowEdge[]
  viewport: { x: number; y: number; zoom: number }
}

interface WorkflowNode {
  id:       string
  type:     'agentisNode'
  position: { x: number; y: number }
  data: {
    label:   string
    kind:    NodeKind           // see §3.2
    config:  NodeConfig         // discriminated union on kind
  }
}

interface WorkflowEdge {
  id:      string
  source:  string    // nodeId
  target:  string    // nodeId
  data?:   { label?: string; condition?: string }
}
```

Graphs are stored as JSON in `workflows.graph` and snapshotted into
`workflow_runs.run_state.observability.graphSnapshot` at run start so
run-history replay is immune to graph edits.

---

## Appendix C — Error Response Format

All API errors return:

```json
{
  "error": {
    "code":    "AGENTIS_ERROR_CODE",
    "message": "Human-readable description",
    "details": { }   // optional, operation-specific
  }
}
```

HTTP status is derived from the error code. Common codes:

| Code | Status |
|---|---|
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `VALIDATION_FAILED` | 422 |
| `OPERATION_RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |
| `SKILL_RUNTIME_UNAVAILABLE` | 503 |
| `HUB_UNAVAILABLE` | 503 |

---

*Agentis v1.0.0 — architecture frozen at release.*
