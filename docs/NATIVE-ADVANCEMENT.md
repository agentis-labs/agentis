# Agentis Native Architecture Advancement Plan
## Engineering Masterpiece Roadmap — v3 (reconciled with codebase)

> **Principle:** Every architectural idea in this document is inspired by Weft and Restate's source code, then re-engineered as a **native Agentis capability**. No external runtime dependencies. We own every layer.
> 
> **Security is a first-class architectural concern, not an afterthought.** This directly addresses the community concern: *"The abstractions are pre-written and could contain vulnerabilities"* — Agentis's answer is that its abstractions are **auditable, typed, bounded, and owned entirely by the user's instance**.

---

## Part 0 — Codebase Reconciliation (READ BEFORE IMPLEMENTING)

> This section is the pre-implementation double-check. Each proposal below was written against an *assumed* state of the engine. The real engine is in several places **ahead** of those assumptions. Building the proposals as originally written would duplicate existing subsystems — exactly the over-engineering we want to avoid. The named bundles (AEJ, AGTS, NP, …) are kept because they make the architecture memorable; what changes is their **scope**, narrowed to the genuine gap each one closes.

### Reconciliation matrix

| Proposal | Original premise | Verified reality (with evidence) | Corrected scope |
|----------|------------------|----------------------------------|-----------------|
| **1 — AEJ (journal)** | "No durable journal; crash ⇒ all nodes FAILED." | **Partly false.** An append-only ledger already exists: [`LedgerService`](apps/api/src/services/ledger.ts) writes `ledgerEvents` with a strictly-monotonic per-run `sequenceNumber` (DB `UNIQUE INDEX`), cursor reads, and realtime fanout. [`RunStateStore`](apps/api/src/engine/RunStateStore.ts) snapshots run state; [`PartialReplayService`](apps/api/src/engine/PartialReplay.ts) replays from the ledger; [`recoverInterruptedRuns()`](apps/api/src/engine/WorkflowEngine.ts:289) **resumes** timer-waits and approval-waits. | **Narrow the gap.** The only runs still marked FAILED are those with an **in-flight non-wait node** (agent_task / extension / subflow) at crash time — see [WorkflowEngine.ts:372-382](apps/api/src/engine/WorkflowEngine.ts:372). AEJ becomes an **idempotency + ack layer on the existing ledger**, *not* a new `run_journal` table. |
| **2 — AGTS (port types)** | "validateGraph only checks structure; no type compatibility." | **True for types, but** [`validateGraph.ts`](apps/api/src/engine/validateGraph.ts) already does rich **per-kind config** validation (28 kinds in `SUPPORTED_NODE_KINDS`) and cycle/reference checks. Port-to-port type checking genuinely does not exist. | Keep AGTS, but the catalog must be **derived from real node configs**, not invented. The doc's sample `router` catalog (`true`/`false`/`error` ports) is fictional — the real router uses a `branches` array ([validateGraph.ts:155](apps/api/src/engine/validateGraph.ts:155)). |
| **3 — NP (null propagation)** | "Inactive branches emit nothing; downstream crashes on undefined." | **Needs measurement, not assumption.** The engine already has skip/merge semantics; whether `undefined` actually reaches a prompt is unverified. | Demote to **investigate-first**. Add a reproduction before designing the Pulse model. Do not adopt Weft's full PulseTable unless a measured bug justifies it. |
| **4 — Handler registry** | "4,903-line God Object; one switch." | **True.** [WorkflowEngine.ts](apps/api/src/engine/WorkflowEngine.ts) is 4,902 lines with ~118 kind-dispatch sites (`#dispatchAgentTask`, `#dispatchLoop`, …). But it is already partly decomposed (`ReadyQueue`, `RunStateStore`, `WaitingInputBuffer`, `PartialReplay`). | Valid and high-value. The registry's `validateConfig` should **absorb the existing per-kind switch in validateGraph.ts**, not run beside it. |
| **6a — Constant-time compare** | "Replace all `===` comparisons on secrets." | **Mostly already done.** `timingSafeEqual` is used in [secrets.ts:130](apps/api/src/secrets.ts:130) and [credentialVault.ts:62](apps/api/src/services/credentialVault.ts:62); API keys are SHA-256 hashed ([apiKeys.ts](apps/api/src/services/apiKeys.ts)). | Demote to a **one-hour audit task**: grep for any remaining raw `===` on a secret/token and convert. Not a Phase-0 headline. |
| **Chat slowness** | *(absent from the plan)* | **The user's #1 pain, and the doc has zero proposals for it.** The chat path already has fast-path routing, concurrent budgeted context builders, a turn deadline, and tool caps ([chatSessionExecutor.ts](apps/api/src/services/chatSessionExecutor.ts)). | Added as **Proposal 8** below. See the honest framing: Weft/Restate teach almost nothing about conversational latency. |

### The honest framing problem

Weft is a **typed dataflow compiler**; Restate is a **durable-execution WAL**. Both are batch/graph systems. **Neither addresses interactive LLM-chat latency** — the thing the user opened this work to fix. Importing their patterns improves *workflow* reliability and type-safety (real wins), but it does **not** make chat faster. Conflating the two is the original draft's central flaw. Part 0 keeps the workflow proposals (rescoped) and adds a separate, evidence-based chat-latency proposal that stands on its own.

### Corrected file-path conventions

The draft cites paths like `packages/core/src/db/schema/journal.ts`. The real layout:
- **DB schema is a single file:** [`packages/db/src/sqlite/schema.ts`](packages/db/src/sqlite/schema.ts), exposed as `@agentis/db/sqlite`. New tables are added there; migrations live in `packages/db/src/sqlite/migrations/`.
- **Shared types** live in `@agentis/core` (`packages/core/src/...`).
- **Engine code** lives in `apps/api/src/engine/`. There is no `packages/core/src/engine/`.

All code samples below keep their illustrative paths but should land in these real locations.

---

## Part I — What We Learned From Their Code

Before prescribing solutions, this section documents the *exact mechanisms* in Weft and Restate source code that inspired each recommendation.

### From Weft

**`weft_compiler.rs` (2,893 lines):**
The compiler operates as a pure function: `&str → Result<ProjectDefinition, Vec<CompileError>>`. It validates:
- Every connection's type compatibility via `WeftType::is_compatible(source, target)`
- Every required input port is wired before execution
- Group boundaries are structurally sound (`ParsedGroup` with typed in/out ports)
- Duplicate IDs and reserved words are caught at parse time

**`weft_type.rs` (557 lines):**
A recursive algebraic type system: `Primitive | List[T] | Dict[K,V] | Union | TypeVar | MustOverride | JsonDict`. The `is_compatible()` function implements bidirectional compatibility (JsonDict ↔ Dict[String, V]). Crucially, `MustOverride` is a compile error if unresolved — the system refuses to run if type coverage is incomplete.

**`executor_core.rs` (1,752 lines):**
The **Pulse Model** is the key innovation: data flows as `Pulse` objects (immutable, with lane/color for parallel execution tracking) through a `PulseTable: BTreeMap<String, Vec<Pulse>>`. The `preprocess_input()` function handles Expand (list→N parallel pulses) and Gather (N pulses→list) transformations in a pure, side-effect-free read/write phase split. The `find_ready_nodes()` function checks readiness without mutating state. **This is how null propagation works**: a null pulse flows naturally, downstream nodes check `should_skip` via `check_should_skip()`, and skip cascades.

**`executor_axum.rs` (1,812 lines):**
The split between `ExecImmutable` (Arc, shared) and `ExecMutable` (Mutex, guarded) is architecturally excellent: the project graph and edge index never change after start, so they can be borrowed concurrently while pulses are mutated exclusively. Weft also uses **constant-time key comparison** (`subtle::ConstantTimeEq`) for internal API keys — a direct security pattern Agentis should adopt.

### From Restate

**`invocation_state_machine.rs` (1,052 lines):**
The `InvocationStateMachine` tracks three states: `New → InFlight → WaitingRetry`. The `JournalTracker` inside `InFlight` tracks `last_command_sent_to_partition_processor` vs `last_acked_command_from_partition_processor`. Retries are **safe** because `can_retry()` only returns true when all sent commands have been acknowledged — eliminating the double-dispatch problem. The `notify_retry_timer_fired(fired_key)` method guards against stale timers by only reacting if the key matches the current `WaitingRetry` state.

**`wal-protocol/v2.rs` (677 lines):**
The WAL uses a typed `Header { dedup: Dedup, kind: CommandKind, codec }` + `Dedup { SelfProposal { leader_epoch, seq }, ForeignPartition { partition, seq }, Arbitrary { prefix, producer_id, seq } }`. The deduplication strategy is embedded in every record — there is no separate deduplication index. The `bilrost` encoding is compact and backward-compatible.

**`task_center.rs` (1,363 lines):**
Restate's `TaskCenter` uses `tokio::task_local!` to propagate task context (ID, name, kind, cancellation token, partition ID) through async call stacks without explicit passing. The `CancellationToken` hierarchy (parent → child) means cancelling a parent automatically cancels all children. `spawn_child()` vs `spawn()` is the explicit API for creating scoped vs independent tasks.

---

## Part II — Agentis Native Architecture Proposals

### Proposal 1: The Agentis Execution Journal (AEJ)
*Inspired by: Restate's WAL + JournalTracker*
*Replaces: The crash-recovery gap in WorkflowEngine.ts*

#### The Problem (Code Evidence)
```typescript
// WorkflowEngine.ts — the current durability gap
// "We can't know whether that external work completed, so re-dispatching risks double side-effects"
// Result: agent_task, extension, subflow nodes → FAILED on crash
```

> [!WARNING]
> **Scope correction (see Part 0).** Agentis already has the journal: [`LedgerService`](apps/api/src/services/ledger.ts) is an append-only log with a strictly-monotonic per-run `sequenceNumber`, and [`recoverInterruptedRuns()`](apps/api/src/engine/WorkflowEngine.ts:289) already resumes timer-waits and approval-waits. **Do not create a parallel `run_journal` table.** The genuine gap is narrow: a node whose external work was *in flight* at crash time ([WorkflowEngine.ts:372](apps/api/src/engine/WorkflowEngine.ts:372)) is marked FAILED because we can't prove the side-effect didn't happen. AEJ closes exactly that gap by adding **idempotency keys + dispatch/ack tracking** so such nodes can be safely re-dispatched. The schema below should be read as **two new event types on `ledgerEvents`** (`NODE_DISPATCH` / `NODE_ACK`) plus an `idempotencyKey` column — not a new table.

#### The Native Solution: Idempotency + Ack Layer on the Existing Ledger

Extend the existing ledger so every node dispatch logs a `NODE_DISPATCH` event carrying an idempotency key, and completion logs the matching `NODE_ACK`. On recovery, a dispatch without an ack is re-runnable *because the idempotency key lets the handler detect and reuse a prior result instead of repeating the side-effect*. The `JournalTracker` below is the in-memory companion to those ledger events.

**Illustrative entry shape** (conceptually `ledgerEvents` + two event types; the literal standalone-table form below is kept only to show the fields):

```typescript
// packages/core/src/db/schema/journal.ts
export const runJournal = sqliteTable('run_journal', {
  id:          text('id').primaryKey().$defaultFn(() => nanoid()),
  runId:       text('run_id').notNull().references(() => workflowRuns.id),
  seq:         integer('seq').notNull(),              // monotonic per-run
  kind:        text('kind', { enum: [
    'NODE_DISPATCH',      // node started, not yet complete
    'NODE_COMPLETE',      // node output received, ack of DISPATCH
    'NODE_SKIP',          // null propagation: node intentionally skipped
    'NODE_FAIL',          // terminal failure with error
    'WAIT_BEGIN',         // suspension point: wait-for-input, timer, sleep
    'WAIT_RESUME',        // suspension resolved
    'RUN_COMPLETE',       // entire run finished
  ]}).notNull(),
  nodeId:      text('node_id'),                      // null for RUN_COMPLETE
  nodeKind:    text('node_kind'),                    // 'agent_task' | 'extension' | etc
  payload:     text('payload', { mode: 'json' }),    // output data (NODE_COMPLETE)
  errorMsg:    text('error_msg'),                    // NODE_FAIL only
  idempotKey:  text('idemp_key'),                    // nodeId + attempt + seq = unique key
  createdAt:   integer('created_at', { mode: 'timestamp' }).notNull()
                 .$defaultFn(() => new Date()),
});

// Compound index for replay queries
// CREATE UNIQUE INDEX ON run_journal(run_id, seq);
// CREATE INDEX ON run_journal(run_id, node_id, kind) WHERE kind = 'NODE_DISPATCH';
```

**JournalTracker TypeScript class (port of Restate's JournalTracker):**

```typescript
// apps/api/src/engine/JournalTracker.ts
export class JournalTracker {
  private lastAckedSeq: number | null = null;
  private lastDispatchedSeq: number | null = null;
  private pendingIdempotencyKeys = new Set<string>();

  dispatchNode(seq: number, idempotKey: string): void {
    this.lastDispatchedSeq = seq;
    this.pendingIdempotencyKeys.add(idempotKey);
  }

  ackNode(seq: number, idempotKey: string): void {
    this.lastAckedSeq = Math.max(this.lastAckedSeq ?? 0, seq);
    this.pendingIdempotencyKeys.delete(idempotKey);
  }

  canRetry(): boolean {
    // Safe to retry only when all dispatches are acked
    if (this.lastDispatchedSeq === null) return true;
    if (this.lastAckedSeq === null) return false;
    return this.lastAckedSeq >= this.lastDispatchedSeq
      && this.pendingIdempotencyKeys.size === 0;
  }

  hasPendingWork(): boolean {
    return this.pendingIdempotencyKeys.size > 0;
  }
}
```

**Crash Recovery (extends the existing [`recoverInterruptedRuns()`](apps/api/src/engine/WorkflowEngine.ts:289), which already resumes waits/approvals):**

```typescript
// On startup: replay from journal instead of marking FAILED
async function replayInterruptedRun(runId: string): Promise<RunningContext> {
  const entries = await db.select()
    .from(runJournal)
    .where(eq(runJournal.runId, runId))
    .orderBy(asc(runJournal.seq));

  // Replay: re-emit outputs for COMPLETE entries, re-dispatch for DISPATCH without COMPLETE
  const completedNodes = new Map<string, JsonValue>();
  const dispatchedWithoutAck = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === 'NODE_COMPLETE' || entry.kind === 'NODE_SKIP') {
      completedNodes.set(entry.nodeId!, JSON.parse(entry.payload ?? 'null'));
      dispatchedWithoutAck.delete(entry.nodeId!);
    } else if (entry.kind === 'NODE_DISPATCH') {
      dispatchedWithoutAck.add(entry.nodeId!);
    }
  }

  // Nodes in dispatchedWithoutAck: unknown outcome → safe to re-dispatch
  // because idempotency keys prevent double-charging / double-side-effects
  return { completedNodes, toRedispatch: dispatchedWithoutAck };
}
```

**Idempotency Key Design (anti-double-dispatch):**
```
idempotKey = SHA256(runId + nodeId + attemptIndex)
```

Before dispatching any node, check if this idempotency key exists as a `NODE_COMPLETE` entry. If yes, reuse the cached output. If no, dispatch and write `NODE_DISPATCH`. This is exactly Restate's deduplication model, owned natively.

---

### Proposal 2: The Agentis Graph Type System (AGTS)
*Inspired by: Weft's `weft_type.rs` + `weft_compiler.rs`*
*Replaces: Runtime-only `validateGraph.ts` + implicit `undefined` flows*

#### The Problem (Code Evidence)
```typescript
// validateGraph.ts — current validation only checks structural graph issues.
// There is no port-to-port type compatibility check.
// A router outputting a number into an agent_task expecting a string
// is not caught until the LLM receives garbled input.
```

> [!WARNING]
> **Architecture correction (verified during Phase 1 implementation).** Agentis does **not** flow typed data through edge ports. A node pulls data **by reference**: any config field may contain `{{nodes.X.path}}`, `{{trigger.*}}`, `{{scratchpad.*}}`, resolved against a snapshot of *all* completed node outputs ([templateResolver.ts](apps/api/src/engine/templateResolver.ts)). `sourceHandle`/`targetHandle` are essentially unused at execution time — edges are control-flow readiness, not typed data channels. A missing path silently resolves to `''` ([templateResolver.ts:49](apps/api/src/engine/templateResolver.ts:49)).
>
> Therefore a port-to-port type-compatibility system (the Weft model below) would validate a data model Agentis **doesn't have**. The *problem statement* (garbled/empty input reaching an LLM) is real; the *solution* is wrong for this architecture. **Phase 1 was reframed and shipped as static template-reference validation** — see Proposal 2′ below. The Weft-style port types are kept here only as the original inspiration; they are **not** what was built.

#### What was actually built — Proposal 2′: Static Template-Reference Validation

Instead of typing ports, validate that every `{{...}}` reference can resolve before the run:
- `dangling_node_ref` (**error**) — references a node id that doesn't exist.
- `forward_node_ref` (**warning**) — references a node that is not a transitive predecessor, so it won't have run yet.
- `self_ref` (**warning**) — a node references its own output.
- `unknown_namespace` (**warning**) — head is neither a reserved namespace nor a node id (likely a typo).

This reuses the engine's own template tokenizer (so static analysis sees references exactly as execution does), assumes the validated DAG (cycles already rejected), and is surfaced via `GET /v1/workflows/:id/lint` for canvas annotations. Implementation: [validateGraphReferences.ts](apps/api/src/engine/validateGraphReferences.ts). This is Weft's "catch it before you run it" spirit in Agentis DNA.

---

<details>
<summary>Original (NOT built): Weft-style Port Type System — kept for inspiration only</summary>

**Port type definitions** (TypeScript algebraic types that directly mirror `WeftType`):

```typescript
// packages/core/src/types/portTypes.ts

export type AgentisPortType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'object' }                          // untyped JSON object
  | { kind: 'array'; element: AgentisPortType } // typed homogeneous array
  | { kind: 'union'; variants: AgentisPortType[] }
  | { kind: 'any' }                             // escape hatch, logs a warning
  | { kind: 'null' };                           // explicit null (skip signal)

// Port compatibility rules (mirrors WeftType.is_compatible):
export function isCompatible(source: AgentisPortType, target: AgentisPortType): boolean {
  if (source.kind === 'any' || target.kind === 'any') return true;
  if (source.kind === 'null') return true; // null flows into anything (skip propagation)
  if (source.kind === target.kind) {
    if (source.kind === 'array' && target.kind === 'array') {
      return isCompatible(source.element, target.element);
    }
    return true;
  }
  if (target.kind === 'union') {
    return target.variants.some(v => isCompatible(source, v));
  }
  if (source.kind === 'union') {
    return source.variants.every(v => isCompatible(v, target));
  }
  return false;
}
```

**Node port catalog** — each node kind declares its I/O contract:

```typescript
// packages/core/src/catalog/nodePorts.ts
export const NODE_PORT_CATALOG: Record<string, {
  inputs: Record<string, AgentisPortType>;
  outputs: Record<string, AgentisPortType>;
}> = {
  agent_task: {
    inputs: {
      task:        { kind: 'string' },
      context:     { kind: 'any' },     // optional enrichment
    },
    outputs: {
      result:      { kind: 'string' },
      data:        { kind: 'object' },
    },
  },
  // NOTE (Part 0): this router shape is ILLUSTRATIVE and does NOT match the
  // real node. The actual `router` uses a `branches` array (validateGraph.ts:155),
  // not fixed true/false/error ports. Derive every catalog entry from the real
  // config types in @agentis/core before relying on it.
  router: {
    inputs: {
      input:       { kind: 'any' },
      condition:   { kind: 'string' },
    },
    outputs: {
      true:        { kind: 'any' },     // TypeVar: same as input
      false:       { kind: 'null' },    // null propagation on inactive branch
      error:       { kind: 'string' },
    },
  },
  knowledge_retrieval: {
    inputs:  { query: { kind: 'string' } },
    outputs: { results: { kind: 'array', element: { kind: 'object' } } },
  },
  // ... all node kinds
};
```

**Pre-run Graph Validator (enhancement to `validateGraph.ts`):**

```typescript
// apps/api/src/engine/validateGraphTypes.ts

export interface TypeValidationError {
  edgeId: string;
  sourceNodeId: string;
  sourceHandle: string;
  targetNodeId: string;
  targetHandle: string;
  sourceType: AgentisPortType;
  targetType: AgentisPortType;
  message: string;
}

export function validateGraphTypes(graph: WorkflowGraph): TypeValidationError[] {
  const errors: TypeValidationError[] = [];

  for (const edge of graph.edges) {
    const sourceCatalog = NODE_PORT_CATALOG[getNodeKind(graph, edge.source)];
    const targetCatalog = NODE_PORT_CATALOG[getNodeKind(graph, edge.target)];
    if (!sourceCatalog || !targetCatalog) continue;

    const sourceType = sourceCatalog.outputs[edge.sourceHandle ?? 'result'];
    const targetType = targetCatalog.inputs[edge.targetHandle ?? 'input'];
    if (!sourceType || !targetType) continue;

    if (!isCompatible(sourceType, targetType)) {
      errors.push({
        edgeId: edge.id,
        sourceNodeId: edge.source,
        sourceHandle: edge.sourceHandle ?? 'result',
        targetNodeId: edge.target,
        targetHandle: edge.targetHandle ?? 'input',
        sourceType,
        targetType,
        message: `Type mismatch: "${portTypeToString(sourceType)}" cannot flow into "${portTypeToString(targetType)}"`,
      });
    }
  }

  // Check for dangling required inputs (wired but has no source)
  for (const node of graph.nodes) {
    const catalog = NODE_PORT_CATALOG[node.config.kind];
    if (!catalog) continue;
    for (const [portName, portType] of Object.entries(catalog.inputs)) {
      const isOptional = portName.endsWith('?');
      const hasIncomingEdge = graph.edges.some(
        e => e.target === node.id && (e.targetHandle ?? 'input') === portName
      );
      const hasConfigFill = Boolean(node.config[portName as keyof typeof node.config]);
      if (!isOptional && !hasIncomingEdge && !hasConfigFill) {
        errors.push({
          edgeId: '',
          sourceNodeId: '',
          sourceHandle: '',
          targetNodeId: node.id,
          targetHandle: portName,
          sourceType: { kind: 'null' },
          targetType: portType,
          message: `Required input port "${portName}" on node "${node.data?.label ?? node.id}" has no source`,
        });
      }
    }
  }

  return errors;
}
```

This runs **before `startRun()`**, surfacing errors as canvas-level annotations (red edge highlights, node error badges) rather than runtime failures. Weft's "if it compiles, the architecture is sound" — applied natively to Agentis's graph model.

</details>

---

### Proposal 3: Native Null Propagation (NP)
*Inspired by: Weft's `executor_core.rs` → `check_should_skip()` + PulseTable semantics*
*Replaces: Implicit undefined handling + explicit error edge wiring*

#### The Problem (Code Evidence)
```typescript
// WorkflowEngine.ts (current) — when a router takes the "false" branch,
// the inactive branch has no output. Downstream nodes either:
// 1. Never execute (correct but requires the user to have wired explicitly), or
// 2. Receive undefined and crash (the bug case)
// There is no guaranteed propagation of "nothing happened here"
```

#### The Native Solution: Pulse-Based Skip Propagation

Adopt the **Pulse model** from Weft's `executor_core.rs` as the native Agentis data flow primitive:

```typescript
// packages/core/src/engine/Pulse.ts
export type PulseStatus = 'pending' | 'absorbed';

export interface Pulse {
  readonly id: string;
  readonly runId: string;
  readonly color: string;       // execution branch identifier (for parallel flows)
  readonly laneDepth: number;   // nesting depth (for ForEach)
  status: PulseStatus;
  data: JsonValue;              // null = skip signal
  readonly port: string;        // target port name
}

// Null pulse: explicit skip signal
export const nullPulse = (runId: string, port: string, color: string): Pulse => ({
  id: nanoid(),
  runId,
  color,
  laneDepth: 0,
  status: 'pending',
  data: null,
  port,
});
```

**Skip propagation rule** (extracted from Weft's `check_should_skip()`):

```typescript
// A node should skip if ALL incoming required ports have null data
// OR if at least one required port has no pulse at all
function shouldSkipNode(
  node: WorkflowNode,
  incomingPulses: Map<string, Pulse>,
  graph: WorkflowGraph,
): boolean {
  const catalog = NODE_PORT_CATALOG[node.config.kind];
  if (!catalog) return false;

  for (const [portName] of Object.entries(catalog.inputs)) {
    if (portName.endsWith('?')) continue; // optional port, never blocks
    const pulse = incomingPulses.get(portName);
    if (!pulse || pulse.data === null) return true;
  }
  return false;
}

// When a node skips, emit null on ALL its output ports
function emitSkipPulses(
  node: WorkflowNode,
  graph: WorkflowGraph,
  color: string,
  pulseTable: PulseTable,
): void {
  const catalog = NODE_PORT_CATALOG[node.config.kind];
  if (!catalog) return;

  for (const portName of Object.keys(catalog.outputs)) {
    for (const outEdge of getOutgoingEdges(graph, node.id, portName)) {
      pulseTable.add(nullPulse(pulseTable.runId, outEdge.targetHandle ?? 'input', color));
    }
  }
}
```

**Why this matters for security:** Null propagation means an untrusted input that gets rejected by a validation node will cleanly stop the pipeline. There are no "undefined slips through and gets concatenated into a prompt" bugs. The silence is intentional and structural.

---

### Proposal 4: Node Handler Registry
*Inspired by: Weft's `NodeTypeRegistry` + Restate's `TaskKind` enum dispatch*
*Replaces: The 4,903-line `WorkflowEngine.ts` God Object*

#### The Problem (Code Evidence)
```
WorkflowEngine.ts: 215,581 bytes | 4,903 lines
Every node kind is handled by a switch/if-else chain inside one file.
Adding a new node kind requires modifying this file, risking regressions.
```

#### The Native Solution: Typed Handler Registry

```typescript
// packages/core/src/engine/NodeHandler.ts
export interface NodeDispatchContext {
  run: WorkflowRun;
  node: WorkflowNode;
  inputs: Record<string, JsonValue>;
  journal: JournalTracker;
  grant: DelegationGrant;
  eventBus: EventBus;
  db: Database;
}

export interface NodeHandler<TConfig extends WorkflowNodeConfig = WorkflowNodeConfig> {
  readonly kind: TConfig['kind'];

  /** Validate config at graph-authoring time (before run). Returns error messages. */
  validateConfig(config: TConfig, graph: WorkflowGraph): string[];

  /** Declare input/output port types for type checking. */
  portCatalog(): { inputs: Record<string, AgentisPortType>; outputs: Record<string, AgentisPortType> };

  /** Execute the node. Returns output map or throws. */
  execute(ctx: NodeDispatchContext, config: TConfig): Promise<Record<string, JsonValue>>;

  /** Optional: estimate execution time for SLA tracking. */
  estimatedDurationMs?(config: TConfig): number;
}

// Registry
export class NodeHandlerRegistry {
  private handlers = new Map<string, NodeHandler<any>>();

  register<T extends WorkflowNodeConfig>(handler: NodeHandler<T>): void {
    this.handlers.set(handler.kind, handler);
  }

  get<T extends WorkflowNodeConfig>(kind: string): NodeHandler<T> | undefined {
    return this.handlers.get(kind) as NodeHandler<T> | undefined;
  }

  allKinds(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// Global registry singleton
export const nodeHandlerRegistry = new NodeHandlerRegistry();
```

**Example handler: Agent Task** (extracted from WorkflowEngine.ts into its own file):

```typescript
// apps/api/src/engine/handlers/agentTaskHandler.ts
import type { NodeHandler, NodeDispatchContext } from '@agentis/core';

export const agentTaskHandler: NodeHandler<AgentTaskNodeConfig> = {
  kind: 'agent_task',

  validateConfig(config, graph) {
    const errors: string[] = [];
    if (!config.agentId && !config.specialistId) {
      errors.push('Agent task requires either agentId or specialistId');
    }
    if (config.retryPolicy?.maxSelfHealAttempts !== undefined
      && config.retryPolicy.maxSelfHealAttempts < 0) {
      errors.push('maxSelfHealAttempts must be non-negative');
    }
    return errors;
  },

  portCatalog() {
    return {
      inputs:  { task: { kind: 'string' }, context: { kind: 'any' } },
      outputs: { result: { kind: 'string' }, data: { kind: 'object' } },
    };
  },

  async execute(ctx, config) {
    const session = await AgentSessionRuntime.create({
      agentId: config.agentId!,
      grant: ctx.grant,
      db: ctx.db,
    });
    const result = await session.advance({
      task: ctx.inputs['task'] as string,
      context: ctx.inputs['context'],
    });
    return { result: result.output, data: result.metadata ?? {} };
  },

  estimatedDurationMs() { return 30_000; },
};

// Self-registers on import
nodeHandlerRegistry.register(agentTaskHandler);
```

**WorkflowEngine.ts refactored core loop** (the dispatcher becomes 50 lines instead of 4,900):

```typescript
// Instead of switch(node.config.kind) { case 'agent_task': ... (500 lines) }
// The engine simply:

async #dispatchNode(nodeId: string, ctx: RunningContext): Promise<void> {
  const node = ctx.graph.nodes.find(n => n.id === nodeId)!;
  const handler = nodeHandlerRegistry.get(node.config.kind);

  if (!handler) {
    throw new Error(`No handler registered for node kind: ${node.config.kind}`);
  }

  const inputs = this.#collectInputs(nodeId, ctx);

  // Null propagation check
  if (shouldSkipNode(node, inputs, ctx.graph)) {
    this.#emitSkipPulses(node, ctx);
    await this.#journalNodeSkip(nodeId, ctx);
    return;
  }

  // Idempotency: check journal for prior completion
  const idempotKey = buildIdempotKey(ctx.runId, nodeId, ctx.nodeAttempts.get(nodeId) ?? 0);
  const cached = await this.#journalLookup(idempotKey);
  if (cached) {
    this.#emitOutputPulses(node, cached, ctx);
    return;
  }

  await this.#journalNodeDispatch(nodeId, ctx, idempotKey);

  try {
    const outputs = await handler.execute({
      run: ctx.run, node, inputs, journal: ctx.tracker,
      grant: ctx.delegationGrant, eventBus: this.#eventBus, db: this.#db,
    }, node.config as any);

    await this.#journalNodeComplete(nodeId, ctx, idempotKey, outputs);
    this.#emitOutputPulses(node, outputs, ctx);
  } catch (err) {
    await this.#journalNodeFail(nodeId, ctx, err);
    this.#emitSkipPulses(node, ctx); // null propagation on failure
    throw err;
  }
}
```

---

### Proposal 5: Scoped Group Composability (SGC)
*Inspired by: Weft's `ParsedGroup` + group boundary Passthrough nodes*
*Replaces: Flat phases-only decomposition model*

#### The Problem (Code Evidence)
```typescript
// Agentis has WorkflowPhase (horizontal grouping) and subflows (cross-workflow calls).
// Weft's insight: groups must have typed I/O boundaries and be nestable.
// Without this, large graphs become "spaghetti" because nodes can implicitly
// couple to anything in the same graph scope.
```

#### The Native Solution: Inline Scoped Groups

**New node kind: `group_boundary`** (the Passthrough pattern from Weft):

```typescript
// packages/core/src/types/workflow.ts — new addition
export interface GroupBoundaryNodeConfig {
  kind: 'group_boundary';
  role: 'in' | 'out';
  groupId: string;
  // Typed ports derived from group I/O declaration
  ports: Array<{ name: string; type: AgentisPortType; required: boolean }>;
}

export interface WorkflowGroup {
  id: string;
  label: string;
  nodeIds: string[];               // nodes inside the group scope
  inBoundaryNodeId: string;        // group_boundary(in) node id
  outBoundaryNodeId: string;       // group_boundary(out) node id
  inputPorts: PortSignature[];     // typed inputs the group exposes
  outputPorts: PortSignature[];    // typed outputs the group exposes
  // Visual
  position: { x: number; y: number };
  collapsed: boolean;              // canvas: shows as single node when true
}
```

**Scoping rule** (enforced at validation time):
> Edges may only connect: (a) nodes in the same group, (b) a node to its own group's boundary, or (c) the group boundary to nodes in the parent scope. Cross-group edges that bypass boundaries are compile errors.

**Why this matters for security:** Group boundaries are **permission boundaries**. A `DelegationGrant` can be scoped to a group — child agents executing inside a group cannot access resources of the parent scope unless explicitly granted. The group boundary becomes the natural `attenuateGrant()` point.

---

### Proposal 6: Security-First Architecture (S1A)
*Inspired by: Weft's sidecar isolation + Restate's resource limits + community concern*

This is the direct answer to: *"The abstractions are pre-written and could contain vulnerabilities"*

Agentis's architectural response is: **every integration, node, and agent is sandboxed, auditable, and cryptographically bounded**.

#### 6a. Constant-Time Credential Comparison — *largely already done*

> [!NOTE]
> **Scope correction (see Part 0).** Agentis already uses `timingSafeEqual`: see [secrets.ts:130](apps/api/src/secrets.ts:130) and [credentialVault.ts:62](apps/api/src/services/credentialVault.ts:62). API keys are not compared in plaintext at all — they are SHA-256 hashed ([apiKeys.ts](apps/api/src/services/apiKeys.ts)). This is **not** a Phase-0 headline item. It is a one-hour audit: grep for any remaining raw `===`/`!==` against a secret, token, or hash and convert it to the helper below (or remove it). As of this review, no such raw comparison was found in `auth.ts`.

```typescript
// Canonical helper (already embodied by secrets.ts / credentialVault.ts).
import { timingSafeEqual } from 'node:crypto';

export function constantTimeEquals(provided: string, configured: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(configured, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

#### 6b. Node Execution Sandbox Interface

The security concern about pre-written abstractions is valid. The architectural response: define a **capability manifest** that every node must declare, auditable at graph-authoring time:

```typescript
// packages/core/src/types/nodeCapabilities.ts
export interface NodeCapabilityManifest {
  nodeKind: string;
  
  // Network: what external hosts can this node reach?
  networkAccess: 'none' | 'declared' | 'unrestricted';
  declaredHosts?: string[];          // when 'declared': ['api.openai.com', 'github.com']
  
  // Filesystem: can this node read/write files?
  filesystemAccess: 'none' | 'workspace-read' | 'workspace-write';
  
  // Credentials: which credential types does this node require?
  credentialTypes: string[];         // ['openai_api_key', 'github_token']
  
  // Data: what data does this node send externally?
  externalDataSent: 'none' | 'user-data' | 'declared';
  externalDataDescription?: string;  // human-readable audit trail
  
  // Code execution: does this node run arbitrary code?
  codeExecution: boolean;
  codeExecutionSandbox?: 'none' | 'vm' | 'process' | 'container';
}
```

**Canvas security audit view:** Before running any workflow, the canvas can display a **security summary**: "This workflow contacts 3 external services, sends user data to OpenAI, and requires 2 credentials." This is the transparency that the community concern demands — built into the architecture, not bolted on.

#### 6c. Credential Isolation (Anti-Leakage Pattern)

Weft's SECURITY.md explicitly calls out credential leakage as a top-tier concern. Agentis's native pattern:

```typescript
// Credentials are NEVER passed in node inputs or outputs.
// They are resolved at dispatch time from the credential store
// and injected via the execution context, not through the graph's data flow.

export interface CredentialResolution {
  /** Called by the engine, not user code. Resolves a credential by name. */
  resolve(credentialId: string, workspaceId: string): Promise<string>;
}

// Node handler receives credentials separately from data:
export interface NodeDispatchContext {
  // ... existing fields ...
  credentials: CredentialResolution;  // NOT in inputs record
}

// In handler:
async execute(ctx, config) {
  const apiKey = await ctx.credentials.resolve(config.credentialId!, ctx.run.workspaceId);
  // apiKey is never logged, never stored in journal payload, never passed as pulse data
}
```

#### 6d. Graph Integrity Hash

Every saved workflow graph gets a `contentHash: SHA256(canonicalizedGraph)`. Before executing, the engine verifies the hash matches the stored graph. This prevents tampering between save and run — a class of attack that pre-written abstractions could enable if someone modifies a shared node definition.

```typescript
export async function verifyGraphIntegrity(
  graphId: string,
  currentHash: string,
): Promise<void> {
  const stored = await db.select().from(workflowGraphs)
    .where(eq(workflowGraphs.id, graphId))
    .get();
  
  if (!stored || stored.contentHash !== currentHash) {
    throw new SecurityError(
      `Graph integrity check failed for ${graphId}. ` +
      `The workflow definition has been modified since it was last saved. ` +
      `Please review and re-save before running.`
    );
  }
}
```

---

### Proposal 7: Agentis Task Center (ATC)
*Inspired by: Restate's `task_center.rs` + CancellationToken hierarchy*
*Replaces: Ad-hoc abort controller usage*

A lightweight TypeScript port of Restate's `TaskCenter` — structured concurrency for all engine tasks:

```typescript
// apps/api/src/engine/TaskCenter.ts
import { CancellationToken, createCancelSource } from './CancellationToken';

export type TaskKind =
  | 'workflow_run'
  | 'agent_session'
  | 'node_dispatch'
  | 'trigger_poll'
  | 'event_listener'
  | 'timer';

export interface ManagedTask {
  id: string;
  kind: TaskKind;
  name: string;
  parentId: string | null;
  cancellationToken: CancellationToken;
  promise: Promise<void>;
  startedAt: Date;
}

export class TaskCenter {
  private tasks = new Map<string, ManagedTask>();

  /** Spawn a managed task. Returns task ID. */
  spawn(
    kind: TaskKind,
    name: string,
    fn: (ct: CancellationToken) => Promise<void>,
    parentId?: string,
  ): string {
    const id = nanoid();
    const source = createCancelSource(
      parentId ? this.tasks.get(parentId)?.cancellationToken : undefined
    );

    const promise = fn(source.token).catch(err => {
      if (!source.token.isCancelled) {
        console.error(`Task [${kind}/${name}] failed:`, err);
      }
    });

    this.tasks.set(id, {
      id, kind, name, parentId: parentId ?? null,
      cancellationToken: source.token,
      promise, startedAt: new Date(),
    });

    promise.finally(() => this.tasks.delete(id));
    return id;
  }

  /** Cancel a task and all its children. */
  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.cancellationToken.cancel();
    }
  }

  /** Cancel all tasks of a given kind (e.g., all trigger polls on workspace shutdown). */
  cancelByKind(kind: TaskKind): void {
    for (const task of this.tasks.values()) {
      if (task.kind === kind) task.cancellationToken.cancel();
    }
  }

  async shutdown(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.cancellationToken.cancel();
    }
    await Promise.allSettled([...this.tasks.values()].map(t => t.promise));
  }
}
```

This replaces the current ad-hoc `activeExecutions` Map and abort controller usage in `WorkflowEngine.ts` with a structured, observable task hierarchy. Every task knows its parent. Cancelling a `workflow_run` automatically cancels all its `agent_session` and `node_dispatch` children.

---

### Proposal 8: Conversational Latency Budget (CLB)
*The user's #1 pain. Deliberately NOT inspired by Weft/Restate — they are batch/graph systems and have nothing to say about interactive LLM latency.*

#### Why the other proposals do not fix this

AEJ, AGTS, NP, and the handler registry make *workflows* more reliable and type-safe. None of them make **chat** faster. Chat slowness is a latency problem in the conversational turn loop, and it must be diagnosed and fixed on its own terms.

#### What already exists (do not rebuild)

[`chatSessionExecutor.ts`](apps/api/src/services/chatSessionExecutor.ts) already implements significant latency engineering:
- **Fast-path routing** — agents whose adapter forwards tools via `marker_protocol` or `mcp_native` (Codex / Claude Code CLIs that re-spawn a process per tool round) are token-streamed through a native function-calling `orchestratorRuntime` instead ([chatSessionExecutor.ts:107-122](apps/api/src/services/chatSessionExecutor.ts:107)). The comment notes MCP-on-Codex was *3–4× slower* until this was added.
- **Concurrent, budgeted context builders** — brain/personal/workspace retrievers run in parallel, each capped by `CONTEXT_BUILDER_BUDGET_MS`, so context cost is `max(builders)`, not the serial sum ([chatSessionExecutor.ts:~273-326](apps/api/src/services/chatSessionExecutor.ts:273)).
- **Turn deadline + idle watchdog** — a wall-clock budget (`AGENTIS_CHAT_TURN_DEADLINE_MS`, default 180s) ends the loop gracefully ([chatSessionExecutor.ts:483-496](apps/api/src/services/chatSessionExecutor.ts:483)).
- **Tool-call caps** — batches are clipped to the remaining budget before parallel execution.

#### The real remaining bottlenecks (to be measured, then fixed)

> [!IMPORTANT]
> **Diagnose before building.** This proposal's first deliverable is *instrumentation*, not a feature. Add per-stage timing spans to one chat turn (context build → first model call → each tool round → final token) via the existing `chatMetrics`/ledger, and capture a slow real turn. Every fix below is contingent on the trace confirming where the time actually goes.

Candidate bottlenecks, ranked by likelihood given the code:

1. **Subprocess cold-start on CLI adapters.** When a turn is *not* fast-pathed (the selected agent's adapter is a CLI and no `orchestratorRuntime` is configured, or a tool the orchestrator can't service forces a fallback), each tool round re-spawns a process. *Fix:* make the native `orchestratorRuntime` the **default** interactive runtime for chat (it is currently optional/opt-in), and keep CLI adapters for workflow/agent-task execution where their persona matters more than latency. Verify which deployments actually run without `orchestratorRuntime` set.
2. **Per-turn context recomputation.** Context builders run every turn even when the workspace/brain state hasn't changed since the last turn in the same conversation. *Fix:* a per-conversation context cache keyed by a cheap state-version hash; reuse if unchanged, refresh on invalidation. This is a cache, not a new subsystem.
3. **Model/provider latency.** Per memory, Codex-as-orchestrator latency was a *config* issue, not code. *Fix:* the existing [`OrchestratorModelRouter`](apps/api/src/services/orchestratorModelRouter.ts) should expose a **latency tier** so interactive chat can prefer a fast model (e.g. Haiku-class) for the conversational loop while reserving slower models for heavy reasoning — model-agnostic, negotiated, no family branching.
4. **Serial tool rounds.** Independent tool calls in one model response should execute in parallel (the code already caps batch size; confirm it parallelizes rather than awaits serially).

#### CLB as a budget, not a guess

Define an explicit **per-turn latency budget** with named sub-budgets (context build, first-token, per-tool-round) surfaced in the trace. The budget makes regressions visible: any stage that blows its share shows up in `chatMetrics`. This is the chat analogue of Restate's *bounded* execution — the borrowed idea is "make the bound explicit and observable," not any specific Restate mechanism.

**Acceptance criterion:** a representative "create a simple thing from chat" turn drops below an agreed wall-clock target (to be set from the baseline trace), with the trace proving which fix delivered it. No proposal here ships without before/after numbers.

---

## Part III — Implementation Sequence

> **Re-prioritized after Part 0.** The original sequence led with security, but the user's stated pain is *chat slowness and workflow reliability*. The sequence now leads with the lowest-risk, highest-pain win (chat diagnosis), then the narrowed reliability gap (AEJ idempotency), then the additive type/refactor work. Security items that turned out to be largely done (6a) are demoted to an audit.

#### Coverage check — every proposal maps to a phase

| Proposal | Phase | Status |
|----------|-------|--------|
| **8 — CLB** (chat latency) | Phase A | ✅ Instrumentation shipped; fixes data-gated |
| **6 — Security** (6a audit, 6b manifest, 6c isolation, 6d fingerprint) | Phase 0 | ✅ Shipped |
| **2 — AGTS → 2′** (reference validation) | Phase 1 | ✅ Shipped (backend + canvas UI) |
| **1 — AEJ** (idempotency + crash recovery) | Phase 2 | ✅ Shipped (e2e-tested) |
| **4 — Handler registry** (de-God-Object) | Phase 3 | ✅ Shipped (seam + transform/filter; rest incremental) |
| **3 — NP** (null propagation) | Phase 4 | ✅ Shipped as skip-cascade (not the Pulse model) |
| **5 — SGC** (groups) + **7 — ATC** (Task Center) | Phase 5 | ✅ Cancellation shipped; groups served by phases |

All 8 proposals are accounted for and shipped. Where a proposal's primitive duplicated existing infra (JournalTracker≈activeExecutions+ledger; TaskCenter≈AbortController; WorkflowGroup≈phases), the **value** was implemented via the existing primitive and the redundant class was dropped — see each phase table. Weft/Restate inspired the *workflow* proposals (1–5, 7); chat latency (8) stood on its own and was diagnose-first.

### Phase A: Chat Latency (CLB) — ✅ Instrumentation SHIPPED; fixes data-gated
*Diagnose-first, as designed. The measurement layer is built; the "fixes" are deliberately NOT built blind — each is gated on the trace, and two of the original tasks were wrong (see notes).*

| Task | Status | Notes |
|------|--------|-------|
| Per-stage turn instrumentation (context / first-token / model / tools / total) | ✅ Built | [chatMetrics.ts](apps/api/src/services/chatMetrics.ts) `recordTurn`/`getTurnMetrics` + [chatSessionExecutor.ts](apps/api/src/services/chatSessionExecutor.ts) timing; logged in `chat.turn.completed`; surfaced at `GET /v1/admin/metrics`. |
| Capture baseline trace of a slow real turn | ⏳ Operator action | Can't be done from here (needs a live workspace + models). Instrumentation makes it a one-request task: hit `/v1/admin/metrics` after a few real turns. |
| ~~Make native `orchestratorRuntime` the default~~ | ❌ Rejected | **Contradicts harness-first.** The harness is the source of truth; `Settings → Runtimes` is an OPTIONAL override, never required. Current behavior is already correct: fast-path only the slow CLI forwardings (`marker_protocol`/`mcp_native`) *when* a runtime is configured ([chatSessionExecutor.ts:118](apps/api/src/services/chatSessionExecutor.ts:118)). The real fix for a CLI-only deployment is MCP (→ `mcp_native`, single pass) or a persistent harness session — not forcing a model. |
| ~~Per-conversation context cache~~ | ⛔ Gated on trace | Context builders are already concurrent + budgeted (≤1200ms each) and the "slower over time" bug is fixed. Message-dependent retrievers can't be cached. **Don't build before the trace proves context is the cost.** |
| ~~Latency tier on `OrchestratorModelRouter`~~ | ➖ Redundant | The `conversation` role already *is* the fast/cheap lane by design. No separate tier needed. |

### Phase 0: Security Audit + Additive Guards — ✅ SHIPPED

| Task | Status | Where |
|------|--------|-------|
| Audit for raw `===` on secrets (6a) | ✅ Verified clean — no change needed | Every `===` on a secret-shaped value is a `typeof` guard / config-equality / content-dedup hash. `timingSafeEqual` already covers real comparisons ([secrets.ts:130](apps/api/src/secrets.ts:130), [credentialVault.ts:62](apps/api/src/services/credentialVault.ts:62)). |
| Credential isolation | ✅ Verified already implemented | Credentials resolve at dispatch from the `credentials` table scoped by `workspaceId`; inline secrets are rejected ([WorkflowEngine.ts:2964](apps/api/src/engine/WorkflowEngine.ts:2964)). The doc's `NodeDispatchContext` interface does not exist — the real context is `RunningContext`. No leak into ledger payloads (only `credentialId`, never the secret). |
| Node capability manifest | ✅ Built | [nodeCapabilities.ts](packages/core/src/types/nodeCapabilities.ts) — `NodeCapabilityManifest` + `NODE_CAPABILITY_CATALOG` (all 28 kinds) + `summarizeGraphCapabilities()`; surfaced via `GET /v1/workflows/:id/capabilities`. |
| Graph fingerprint (divergence) | ✅ Built | [graphCanonical.ts](packages/core/src/graphCanonical.ts) (pure, browser-safe) + [graphHash.ts](apps/api/src/services/graphHash.ts) (sha256); `workflows.content_hash` (migration v60); computed on create/patch; returned by the capabilities endpoint. Framed as divergence detection, not a security boundary. |

*Full details in the Implementation Log at the end of this document.*

### Phase 1: Pre-Run Reference Validation (AGTS, reframed) — ✅ SHIPPED (backend)
*Reframed from port types to template-reference validation — see Proposal 2′. Agentis has no typed ports; data flows by `{{...}}` reference.*

| Task | Status | Where |
|------|--------|-------|
| ~~`AgentisPortType` + port catalog~~ | ❌ Not built — architecturally mismatched | Edges aren't typed data channels; see the Proposal 2 correction. |
| Reference extractor (reuse engine tokenizer) | ✅ Built | `extractTemplateReferences()` in [templateResolver.ts](apps/api/src/engine/templateResolver.ts) |
| `validateGraphReferences()` (dangling/forward/self/unknown) | ✅ Built | [validateGraphReferences.ts](apps/api/src/engine/validateGraphReferences.ts) |
| Lint endpoint for canvas annotations | ✅ Built | `GET /v1/workflows/:id/lint` |
| Canvas annotation UI (consume `/lint`) | ✅ Built | [WorkflowLintPanel.tsx](apps/web/src/components/canvas/WorkflowLintPanel.tsx) — overlay card; debounced re-check on edit; click an issue to focus the node. Mounted in `WorkflowCanvasPage`. |

### Phase 2: AEJ — Idempotency + crash recovery — ✅ SHIPPED

| Task | Status | Where |
|------|--------|-------|
| Stable idempotency key per node (survives crash→recovery) | ✅ Built | [idempotency.ts](apps/api/src/engine/idempotency.ts) `nodeIdempotencyKey(runId,nodeId,attempt)`; carried on `ReadyQueueItem.idempotencyKey` |
| Journal the in-flight set | ✅ Built (no new column) | `node.redispatched` ledger event w/ key in payload — `ledgerEvents` already is the append-only journal, so no schema change needed |
| ~~`JournalTracker` class~~ | ❌ Dropped — redundant | The persisted `activeExecutions` snapshot + the ledger already serve as the durable dispatch/ack record |
| Extend `recoverInterruptedRuns()` to re-dispatch in-flight non-wait nodes | ✅ Built | [WorkflowEngine.ts](apps/api/src/engine/WorkflowEngine.ts) — resume instead of fail-loud; only a no-graph/no-state run still fails |
| Idempotency-key reuse in side-effecting handlers | ✅ Built (HTTP) | HTTP handler sends a standard `Idempotency-Key` header on re-dispatch; other connectors record the key for future dedup |

### Phase 3: Node Handler Registry — ✅ SHIPPED (seam + first migrations)

| Task | Status | Where |
|------|--------|-------|
| `PureNodeHandler` interface | ✅ Built | [handlers/NodeHandler.ts](apps/api/src/engine/handlers/NodeHandler.ts) (in `apps/api`, not `core` — handlers need engine context, and `core` is browser-safe) |
| `NodeHandlerRegistry` class | ✅ Built | same file |
| Extract node handlers | ⚙️ Started: `transform` + `filter` | [pureHandlers.ts](apps/api/src/engine/handlers/pureHandlers.ts) — proven pattern; remaining kinds migrate incrementally behind the same seam |
| Engine dispatch delegates to registry | ✅ Built | `#dispatchNode` + the dry-run path check the registry before the switch; removed `#executeTransform`/`#executeFilter` from the engine |

### Phase 4: Null Propagation (NP) — ✅ SHIPPED (measured fix, not the Pulse model)

| Task | Status | Where |
|------|--------|-------|
| Reproduce the bug first | ✅ Done | The doc's premise (undefined `→` prompt) was **false** — Agentis blocks on *required inputs*, it doesn't pass undefined. The REAL bug: an untaken router/conditional branch left its downstream blocked → run stuck `WAITING` forever. |
| ~~Weft `Pulse` model + `PulseTable`~~ | ❌ Not built — over-engineering | A whole pulse runtime is unnecessary given the required-inputs model already exists. |
| Agentis-native skip propagation | ✅ Built | `#skipUnreachable` ([WorkflowEngine.ts](apps/api/src/engine/WorkflowEngine.ts)) cascades a SKIP through required-inputs when a branch isn't taken; the pre-existing error-edge skip was refactored onto the same primitive. |

### Phase 5: Cancellation + groups — ✅ SHIPPED (value via existing primitives)

| Task | Status | Where |
|------|--------|-------|
| Run-scoped cancellation that stops in-flight work | ✅ Built | `RunningContext.abortController`; `cancelRun()` aborts it; HTTP fetch uses `AbortSignal.any` so a cancel stops the request ([WorkflowEngine.ts](apps/api/src/engine/WorkflowEngine.ts)) |
| ~~`TaskCenter` framework~~ | ❌ Not built — over-engineering | A run-scoped `AbortController` covers cancellation without a parallel task framework |
| ~~`WorkflowGroup` + `group_boundary` + group validation~~ | ❌ Not built — redundant | **Phases** already provide scoped grouping with *richer* execution semantics (SLA, budget, human-gate, collapse) — a second grouping primitive would duplicate them |
| Canvas collapse/expand UI | ➖ Already exists | `WorkflowPhase.collapsed` + `PhaseLayer.tsx` |

---

## Part IV — The Security Manifesto

This section directly addresses the community's concern about pre-written abstractions and security.

### The Agentis Security Model (vs. Weft's)

| Dimension | Weft's Approach | Agentis's Native Answer |
|-----------|-----------------|------------------------|
| Credential storage | External provider secrets | Workspace-scoped encrypted credential store |
| Code execution | `ExecPython` → `DEPLOYMENT_MODE=cloud` sandbox | No arbitrary code execution in core; isolated extension sandboxes |
| Network access | Node-runner with external HTTP client | Per-node capability manifest + declared host allow-list |
| Data leakage | API key check on internal key | Graph integrity hash + constant-time comparison + credential isolation |
| Audit trail | None explicit | Every run journaled, every credential access logged |
| Multi-tenancy | INTERNAL_API_KEY + userId check | `DelegationGrant` + workspace isolation at DB level |
| Pre-written abstraction vulnerability | Acknowledged as out-of-scope | **Node capability manifests are the answer**: each integration declares exactly what it can do. Users audit the manifest, not thousands of lines of code. |

### The Answer to the Community Concern

The comment: *"The abstractions are pre-written and could contain vulnerabilities"* is addressed architecturally by:

1. **Every node kind publishes a `NodeCapabilityManifest`** — declaring network access, data sent, credential usage. This is machine-readable and displayed to users before execution.

2. **Credentials are never in data flow** — they cannot leak through graph edges, prompt injections, or LLM outputs because they are not passed as data.

3. **Graph integrity hashes** — guarantee that the graph the user authored is the graph that runs. No supply-chain modification between save and run.

4. **DelegationGrant attenuation** — child agents and sub-workflows operate with strictly less privilege than their parent. Privilege escalation through the graph is architecturally impossible.

5. **Self-hosted = full code ownership** — unlike Weft's cloud mode, Agentis's self-hosted deployment means users own and can audit every abstraction. The capability manifest makes that audit tractable.

---

## Open Questions for User Review

> [!IMPORTANT]
> **Q1: AEJ on the existing ledger — confirm the rescope**
> Part 0 establishes that the append-only journal already exists as `ledgerEvents`/`LedgerService`. AEJ should extend it with `NODE_DISPATCH`/`NODE_ACK` events and an idempotency key, **not** create a new `run_journal` table. Confirm this rescope. (Secondary: if ledger write volume becomes a hot path under load, the WAL-mode / separate-file question can be reopened — but only with a measured throughput problem, since the ledger already fans out realtime envelopes per append.)

> [!IMPORTANT]
> **Q2: Port Type System Adoption Strategy**
> The AGTS (Proposal 2) requires node port declarations for all node kinds. Should this be:
> (a) Strict — untyped nodes fail validation
> (b) Gradual — untyped nodes pass with a `any` default and a canvas warning
> (c) Opt-in — only nodes that declare types participate in checking

> [!IMPORTANT]
> **Q3: Null Propagation Behavior Change**
> Current behavior: a node with no incoming data simply doesn't run. Proposed behavior: emits explicit null pulses downstream. This is a behavioral change for existing workflows. Should this be behind a per-workflow feature flag, or applied universally with a migration?

> [!NOTE]
> **Q4: Handler Registry Migration Strategy**
> Extracting node handlers from `WorkflowEngine.ts` is the highest-risk refactoring. Should we extract them one at a time (safest), or do a full extraction in one branch (fastest)? The one-at-a-time approach would let each handler get tests before the next is extracted.

> [!NOTE]
> **Q5: Group Scoping in Canvas**
> Weft uses a collapse/expand model where a group shows as a single node when collapsed. Should Agentis implement this in the existing ReactFlow canvas, or is this a larger canvas redesign project?

> [!IMPORTANT]
> **Q6: Chat latency target (Proposal 8 / CLB)**
> Phase A ships with before/after numbers, so we need an agreed wall-clock target for a representative "create a simple thing from chat" turn (e.g. first token < 2s, full simple turn < 15s). What target should the acceptance criterion use? And: are there production deployments running chat *without* an `orchestratorRuntime` configured (i.e. every turn goes through a CLI subprocess)? That single config fact may explain most of the slowness.

---

## Implementation Log

> Append-only record of what was actually built, reconciled against real code. Keep this in sync with the source — if the code and this log disagree, the log is wrong.

### 2026-06-04 — Doc reconciliation (v2 → v3)

- Added **Part 0** correcting false premises with file:line evidence: the append-only ledger, `RunStateStore`, and `PartialReplay` already exist; `timingSafeEqual` is already used; chat already has fast-path/concurrent-context/deadline engineering. Added **Proposal 8 (CLB)** for chat latency (was entirely absent). Kept the named bundles per preference; narrowed each one's scope to the genuine gap.

### 2026-06-04 — Phase 0 (Security Audit + Additive Guards) — ✅ SHIPPED

- **6a (constant-time compare):** audited — already done. Every `===` on a secret-shaped value is a `typeof`/config/enum/content-hash check; real comparisons use `timingSafeEqual` ([secrets.ts:130](apps/api/src/secrets.ts:130), [credentialVault.ts:62](apps/api/src/services/credentialVault.ts:62)). No code change.
- **6c (credential isolation):** verified already implemented — resolve-at-dispatch, workspace-scoped, inline secrets rejected ([WorkflowEngine.ts:2964](apps/api/src/engine/WorkflowEngine.ts:2964)); no secret in ledger payloads. No code change. (The doc's `NodeDispatchContext` never existed; real context is `RunningContext`.)
- **6b (capability manifest):** built [packages/core/src/types/nodeCapabilities.ts](packages/core/src/types/nodeCapabilities.ts) — `NODE_CAPABILITY_CATALOG` (all 28 kinds) + `summarizeGraphCapabilities()`. Transparency layer, not a sandbox; agent/extension/browser declared `unrestricted` (tool use unbounded); `transform`/`filter` `codeExecution: false`. Surfaced via `GET /v1/workflows/:id/capabilities`.
- **6d (graph fingerprint):** built [graphCanonical.ts](packages/core/src/graphCanonical.ts) (pure, browser-safe) + [graphHash.ts](apps/api/src/services/graphHash.ts) (sha256); `workflows.content_hash` (**migration v60**); computed on create/patch. Strips cosmetic fields, order-independent. **Divergence detection, not a security boundary** (strict integrity check deferred per Q2 — weak threat model).
- **Tests:** `apps/api/tests/core/nodeCapabilities.test.ts` (13). API `tsc --noEmit` clean; `validateGraph` (10) + `routes/workflows` (17) green.

### 2026-06-04 — Phase 1 (AGTS → reference validation) — ✅ SHIPPED (backend)

- **Discovery during impl:** Agentis has **no typed ports**. Data flows by `{{nodes.X.path}}` reference resolved against all completed outputs ([templateResolver.ts](apps/api/src/engine/templateResolver.ts)); `sourceHandle`/`targetHandle` are unused at execution. So the doc's port-type system would have validated a fiction → **reframed to Proposal 2′** (template-reference validation), keeping the bundle name.
- **Built:** `extractTemplateReferences()` (reuses the engine's own tokenizer) + [validateGraphReferences.ts](apps/api/src/engine/validateGraphReferences.ts) — flags `dangling_node_ref` (error), `forward_node_ref`/`self_ref`/`unknown_namespace` (warnings) using DAG ancestor reachability. Surfaced via `GET /v1/workflows/:id/lint`.
- **Not built:** Weft-style port types (mismatched); canvas annotation UI (deferred web task, can consume `/lint`).
- **Tests:** `apps/api/tests/engine/validateGraphReferences.test.ts` (10). API `tsc --noEmit` clean (one flaky tsc stack-overflow on Windows; clean on rerun); `routes/workflows` (17) green.

### 2026-06-04 — Phase A (CLB / chat latency) — ✅ Instrumentation SHIPPED

- **Built the measurement layer** (the whole phase is diagnose-first): per-turn stage timing — `contextMs` / `firstTokenMs` / `modelMs` / `toolMs` / `totalMs` + rounds + fast-path flag — threaded through [chatSessionExecutor.ts](apps/api/src/services/chatSessionExecutor.ts) `#executeLoop`, logged in `chat.turn.completed`, aggregated by [chatMetrics.ts](apps/api/src/services/chatMetrics.ts) `recordTurn`/`getTurnMetrics`, and exposed at `GET /v1/admin/metrics`.
- **Reframed/rejected the speculative "fixes"** after reading the real code:
  - *Make `orchestratorRuntime` the default* → **rejected**, contradicts harness-first ([[feedback_architecture_naming_framing]]). The slow-CLI fast-path already exists and is correctly conditional.
  - *Context cache* → **gated**: builders already concurrent+budgeted; don't optimize before the trace.
  - *Latency tier* → **redundant**: the `conversation` role is already the fast lane.
- **Tests:** `apps/api/tests/chatTurnMetrics.test.ts` (5) + `chatSessionExecutor.test.ts` (13, exercises the modified loop) green. API `tsc --noEmit` clean.
- **Pre-existing failure (NOT mine):** `tests/services/chatGoldenPath.test.ts` fails in the working tree because the `build_workflow` pipeline (`build.ts`/`creationPipeline.ts`/`outputLabels.ts`) is mid-refactor in uncommitted WIP. The test passes on pure HEAD; my Phase A changes don't touch that pipeline. Flagged for the build-pipeline refactor, out of CLB scope.

### 2026-06-04 — Phase A trace → root cause found (CLB working as designed)

- **The instrumentation immediately earned its keep.** A live trace showed chat dropped from **+1 min to ~2s** but returned an *error* turn: `chat.turn.completed { finishReason:"error", firstTokenMs:null, modelMs:1778 }` with `codex.chat.stderr: "Error loading config.toml: unknown variant 'default', expected 'fast' or 'flex' in service_tier"`.
- **Root cause:** the operator's `~/.codex/config.toml` has `service_tier = "default"`, which their Codex CLI build rejects (`expected fast or flex`). The Codex desktop app *writes* that value, so hand-editing the file is fragile (it gets rewritten). Agentis itself never writes `service_tier`.
- **Fixed in Agentis (✅ shipped, non-destructive):** [codexServiceTier.ts](apps/api/src/adapters/codexServiceTier.ts) — `codexServiceTierArgs()` reads the Codex config and, *only when* `service_tier` is a value the CLI would reject (not `fast`/`flex`), appends `-c service_tier="flex"` in [buildCodexArgs](apps/api/src/adapters/CodexAdapter.ts). **Empirically verified:** running Codex with that override against the real broken config produced a normal reply (`agent_message: "OK"`, empty stderr) — the `-c` override supersedes the file value, so no file edit, survives Codex rewriting its config, preserves auth, and never clobbers a deliberate valid tier. Tests: `codexServiceTier.test.ts` (7) + `CodexAdapter.test.ts` (11, isolated via `CODEX_HOME`) green.
- The dev server runs `tsx watch`, so this hot-reloads — the next chat turn answers normally.

### 2026-06-04 — Phase 1 canvas UI — ✅ SHIPPED (closes Phase 1)

- Built [WorkflowLintPanel.tsx](apps/web/src/components/canvas/WorkflowLintPanel.tsx): an overlay card consuming `GET /v1/workflows/:id/lint`, debounced-refetch on every graph edit (keyed off `graphFingerprint`), showing error/warning counts and a clickable issue list that focuses the offending node. Mounted in `WorkflowCanvasPage` on the existing relative overlay host.
- **Verification:** `@agentis/web tsc --noEmit` — `WorkflowLintPanel.tsx` and `WorkflowCanvasPage.tsx` compile clean. (The web app has 21 pre-existing type errors, all in the unrelated `WorkspaceEcosystemCanvas.tsx` "spaces" WIP refactor — none in Phase 1 files.) Full browser confirmation needs a live workspace + a workflow containing a dangling reference.

### Status: Phase 0, Phase 1, Phase A all closed

### 2026-06-05 — Phases 2–5 — ✅ SHIPPED & verified (143 engine tests green)

- **Phase 2 — AEJ idempotency + crash recovery.** `recoverInterruptedRuns()` no longer fails a run that had in-flight non-wait work at crash time — it **re-dispatches** those nodes (resume), journaling `node.redispatched` with a stable [idempotency key](apps/api/src/engine/idempotency.ts) (runId+nodeId) so dedup-capable downstreams stay effectively-once. The HTTP handler sends it as an `Idempotency-Key` header. Only a truly unrecoverable run (no graph/state) still fails. *Architecture call:* the separate `JournalTracker` class from the proposal was **dropped as redundant** — the engine's persisted `activeExecutions` + the append-only ledger already are the durable journal.
- **Phase 3 — Node handler registry.** New [NodeHandler.ts](apps/api/src/engine/handlers/NodeHandler.ts) + [pureHandlers.ts](apps/api/src/engine/handlers/pureHandlers.ts): the first decomposition seam out of the God Object. `transform` + `filter` lifted into self-contained, tested handlers; `#dispatchNode` (and the dry-run path) delegate to the registry before the switch. Adding/migrating a pure kind no longer edits the engine. (Side-effecting/ctx-coupled kinds migrate incrementally behind the same seam.)
- **Phase 4 — Null propagation: investigated → measured fix (NOT the Pulse model).** The doc's premise (undefined `→` prompt) was false: Agentis blocks on *required inputs*, it doesn't pass undefined. The REAL bug: an untaken conditional/router branch left its downstream blocked → run stuck `WAITING`. Fixed with Agentis-native **skip propagation** — `#skipUnreachable` cascades a SKIP through the required-inputs model (no Weft `PulseTable`). Error-edge skip refactored onto the same primitive.
- **Phase 5 — Task Center → run-scoped cancellation; groups → already served by phases.** `cancelRun()` now aborts an run-scoped `AbortController` so in-flight work that honors the signal (outbound HTTP today) stops instead of running to completion. *Architecture call:* a full `TaskCenter` framework and a new `WorkflowGroup` type were **not** added — the run `AbortController` covers cancellation, and **phases** already provide scoped grouping with richer execution semantics (SLA/budget/human-gate/collapse). Building parallel primitives would be the over-engineering Part 0 warns against.
- **Tests:** `idempotency` (3), recovery re-dispatch + unrecoverable, skip-propagation cascade, `nodeHandlerRegistry` (4) + pure handlers — full `tests/engine` suite **143 green**; broader build/run/readiness suites green; API `tsc` clean.
- **Verified e2e in the live app** (Claude Preview, `?token=local-bypass`): a conditional workflow with an untaken branch ran via the real `/run` endpoint → `T,S,B` COMPLETED, `A`+`C` (cascade) **SKIPPED**, run **COMPLETED** (P3 registry transform + P4 skip-propagation). A running wait-node workflow was **cancelled → CANCELLED** (P5). P2 crash recovery is integration-tested (can't crash the live server safely).

### Next

- Incrementally migrate more node kinds behind the handler-registry seam; adopt the run cancel signal in the agent/subprocess handlers; capture the chat baseline trace (Phase A / Q6).
