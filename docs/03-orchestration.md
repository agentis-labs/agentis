# 03 · Self-Healing Orchestration

The workflow engine executes directed graphs of typed nodes, recovers from failures without
fabricating results, and judges runs against declared outcomes. Source: `apps/api/src/engine/`.

## Execution model

`WorkflowEngine` (`engine/WorkflowEngine.ts`) holds, per active run, a `ReadyQueue` and a
`WaitingInputBuffer`. Each tick:

1. drains the ready queue up to a configured parallelism;
2. dispatches each node by `config.kind` (a discriminated union — the dispatch switch is
   exhaustive at the type level);
3. completes deterministic nodes synchronously, or registers an async execution record for
   agent tasks, checkpoints, and subflows;
4. appends a monotonic `ledger_events` row and publishes a realtime envelope per transition;
5. snapshots run state to `workflow_run_snapshots` periodically for partial replay.

State stores: `RunStateStore.ts`, `ReadyQueue.ts`, `WaitingInputBuffer.ts`,
`ActiveWorkflowRegistry.ts`. Crash recovery re-hydrates interrupted runs on boot.

## Node kinds (47)

`WorkflowNodeType` (`packages/core/src/types/workflow.ts`):

- **Control flow** — `trigger`, `router`, `merge`, `parallel`, `loop`, `wait`, `subflow`,
  `checkpoint`, `stop_error`, `error_trigger`, `return_output`.
- **Deterministic data & logic (zero LLM tokens)** — `transform`, `filter`, `code`,
  `data_query`, `data_mutate`, `aggregate_window`, `http_request`, `graphql`,
  `workflow_store`, `workspace_store`, `scratchpad`.
- **Intelligence** — `agent_task`, `agent_session`, `agent_swarm`, `dynamic_swarm`, `planner`,
  `evaluator`, `guardrails`, `extension_task`.
- **Knowledge** — `knowledge` (semantic search), `knowledge_ingest`.
- **Utility** — `datetime`, `crypto_util`, `xml_parse`, `markdown`, `spreadsheet` (csv/xlsx),
  `html_extract`, `json_schema_validate`.
- **I/O & artifacts** — `browser` (headless render / screenshot / PDF / form-fill),
  `artifact_collect`, `artifact_save`.
- **Human / annotation** — `human_input`, `sticky_note`.

Executors live in `engine/executors/` and `engine/handlers/` (deterministic/IO controller,
pure-expression handlers, and unit-testable utility converters).

## Objectives & cognitive looping

- **Objectives + SWIFT** — `agentis.workflow.scope` declares the acceptance outcome; the SWIFT
  verdict engine judges a run **accomplished** vs merely **completed**
  (`services/workflow/workflowDeliveryOrchestrator.ts`).
- **converge / pursue** (`engine/convergeLoop.ts`, `engine/pursuitControl.ts`) — iterative
  refinement with multi-signal stagnation detection (structural repeat, oscillation, plateau,
  regression), ASSESS/REFLECT triggers, and budget breakers (iterations / tokens / wall-clock).
  Loop state persists to the durable **blackboard** (queryable at `/v1/runs/:id/blackboard`).

## Self-healing

`engine/selfHeal/` + `services/workflow/workflowSelfHeal.ts`. Recovery layers, in order:

1. **Output-contract recovery** — re-extract declared fields from the agent's own output.
2. **Runtime rebind** — swap the failed agent/adapter for a capable fallback specialist.
3. **Graph surgery** — intent-preserving structural repair (`WorkflowGraphPatch`), gated by an
   anti-hallucination certification (the patch must preserve intent and be grounded).
4. **Honest escalation** — if it can't recover, fail loudly rather than fabricate.

Guardrails: the **Blueprint law** — a graph proven to work is *blessed*
(`agentis.workflow.harden`) and never silently restructured; `restore_blueprint` rolls back;
a proven-divergence detector warns when a blessed graph was edited. Repair snapshots persist to
`workflow_repair_checkpoints`.

## Triggers, listeners, scheduling

- Direct triggers (`triggers` table, `engine/TriggerRuntime.ts`, `/v1/triggers`): **manual**,
  **cron** (timezone-aware), **webhook** (HMAC-SHA256, idempotency window).
- **Persistent listeners** v2 (`engine/ListenerRuntime.ts`, `/v1/listeners`): file / cursor /
  poll sources, JSONPath + JMESPath predicates, first-match / threshold / window fire policies,
  health tracking.
- Natural-language scheduling → UTC cron (`services/scheduleFromNaturalLanguage.ts`).
  Schedule bookkeeping in `schedule_runs`.

## Replay, subflows, ephemeral runs

- **Partial replay** (`services/partialReplay.ts`, `/v1/runs/:id/replay`): `from-node`,
  `failed-branch`, `with-edited-node`, `from-checkpoint`; each creates a new run linked by
  `parentRunId`.
- **Subflows** (`services/subflowExecutor.ts`) — parent awaits child terminal status; child
  scratchpad is namespaced to avoid collisions.
- **Ephemeral runs** (`services/ephemeralWorkflowService.ts`, `/v1/ephemeral`) — ad-hoc
  execution with no persisted workflow row; a debug mode suppresses self-heal/fallbacks to
  expose raw failures.
- **Idempotency** (`engine/idempotency.ts`) — deterministic per-node keys for safe retries.

## Validation

`engine/validateGraph.ts`, `validateGraphReferences.ts`, `validateExpressions.ts`,
`SafeConditionParser.ts` (hand-written recursive-descent grammar — never `eval`), plus graph
normalization that infers missing fields.

## API surface

- HTTP: `/v1/workflows`, `/v1/runs` (status, stream, activity, ledger, scratchpad,
  blackboard, replay), `/v1/triggers`, `/v1/listeners`, `/v1/scheduler`, `/v1/ephemeral`.
- Tools: `agentis.build_workflow`, `agentis.workflow.{create,validate,dry_run,scope,test,harden,restore_blueprint,bless,deliver}`,
  `agentis.run.{await,status,diagnose,cancel,replay,inspect}`, `agentis.plan_workflow`.

## Completion, accomplishment, and executable App rules

`run.completed` is an execution lifecycle event. It says the graph stopped cleanly; it does
not prove that the requested result exists. A scoped workflow emits `run.accomplished` only
after its persisted definition-of-done passes. Success-gated App dependencies, event rules,
conversation continuations, and operator status surfaces all use the same outcome interpreter
(`services/workflow/runOutcome.ts`).

Executable cross-workflow rules are persisted in `workflow_event_subscriptions` and authored
with `agentis.workflow.rule`. App-level `dependsOn` remains the simple dependency primitive;
event subscriptions add typed events, filters, input mapping, and coalescing. `agentis.app.doctor`
inspects the whole App across bindings, triggers, subscriptions, outcome contracts, state
machines, connections, and UI claims. The App interface exposes the same rules as first-class,
editable automation: operators can create, edit, enable, disable, and delete rules, configure
filters/mappings/coalescing/catch-up, and see Doctor blockers without inventing a second “run
pipeline” action.

Rule delivery is a durable state machine, not an in-memory event callback. Every source event is
journaled in `workflow_event_deliveries` with a stable event/delivery identity, payload snapshot,
status, retry count, lease, target queue/run evidence, and terminal error. CAS claims, expiring
leases, bounded backoff, queue idempotency, and restart reconciliation close the duplicate-run and
enqueue-before-ack crash windows. New rules only perform bounded catch-up for eligible runs created
after the subscription. Operators can inspect and retry failed deliveries through
`/v1/scheduler/deliveries`; delivered/skipped transitions are immutable and cannot be replayed into
a duplicate business action.

Doctor remediation is deliberately bounded. `agentis.app.doctor.repair` and
`POST /v1/apps/:id/doctor/repair` preview by default and can apply only deterministic safe repairs
(for example invalid dependencies or a stale source-node filter). Ambiguous findings remain
`review_required`. `agentis.apps.conformance.migrate` applies the same policy workspace-wide; it
does not make app-specific guesses.

## Safe graph mutation

Stored replacement, stored editing, and live-run evolution are separate contracts:

- `agentis.workflow.graph.replace` — complete at-rest replacement;
- `agentis.workflow.graph.patch` — recursive field/structural operations that preserve omitted
  fields;
- `agentis.run.graph.evolve` — live execution evolution only.

Stored mutations support graph hashes / `updatedAt` optimistic concurrency, dry-run diffs,
atomic validation, intent and approval guards, and the green ratchet. The old
`agentis.workflow.patch` remains a deprecated compatibility alias.

`workflow.patch` is therefore still a whole-graph replacement contract for compatibility. Agents
must not “retry it with more complete fields” to simulate a scoped edit. They use
`agentis.workflow.graph.patch` for field/structural operations; omitted node fields are preserved.
Every committed mutation records a bounded graph revision snapshot. Operators and agents can list
revision metadata with `agentis.workflow.graph.revisions` and preview/commit a rollback with
`agentis.workflow.graph.rollback`. Rollback requires the current `baseHash`, revalidates the graph,
and records the pre-rollback graph so the rollback itself is reversible.

## P0–P4 platform acceptance

| Phase | Platform invariant | Acceptance evidence |
|---|---|---|
| P0 — truth | Lifecycle completion never impersonates business accomplishment; channel delivery requires provider evidence. | Shared outcome interpreter, accomplishment events, provider receipts, no-false-success regressions. |
| P1 — durability | Rules, schedules, and queue transitions survive replay, concurrency, crashes, and restarts without duplicate target runs. | Delivery journal, CAS leases, stable idempotency keys, recovery and retry tests. |
| P2 — mutation safety | Scoped edits preserve omitted graph fields and every committed graph can be inspected and rolled back safely. | Preview/confirm, base-hash concurrency, validation/approval guards, revisions and reversible rollback tests. |
| P3 — app operability | Automation rules are persisted and editable in the product; Doctor distinguishes safe repair from human review. | Rule CRUD API/editor, guarded actions, Doctor repair/migration, truthful UI failure states. |
| P4 — agent power | Runtime powers are native, versioned, configuration-sensitive contracts enforced before dispatch. | Built-in adapter manifests, reusable conformance suite, structured mismatch evidence, third-party compatibility path. |

These are domain-neutral invariants. No phase contains Fashion-specific states, WhatsApp-specific
conversation logic, or assumptions about a particular app archetype.

---

**Next:** [04 · The Agent Fabric (RAL) →](./04-agent-fabric.md)
