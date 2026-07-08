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
- Tools: `agentis.build_workflow`, `agentis.workflow.{create,patch,validate,dry_run,scope,test,harden,restore_blueprint,bless,deliver}`,
  `agentis.run.{await,status,diagnose,cancel,replay,inspect}`, `agentis.plan_workflow`.

---

**Next:** [04 · The Agent Fabric (RAL) →](./04-agent-fabric.md)
