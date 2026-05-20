# Changelog

All notable changes to Agentis are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org).

## [Unreleased]

—

## [1.0.0] — 2026-05-20

The **workflows-only** first stable release. Cut from the v1.3.0 WIP
checkpoint by removing the Brain / Apps / Memory-OS surfaces. Workflows,
agents, skills, knowledge bases, teams, budgets, approvals, and the chat
runtime are the v1.0 product.

### Added

- `/v1/teams` route — Fleet Organization Layer. Group agents +
  workflows into named teams with shared context, operating principles,
  and a Team Architect proposal endpoint.
- `/v1/budgets` route — per-agent monthly spend caps, `recordSpend`,
  `grantExtension`, and a workspace-level pre-spend gate
  (`BUDGET_LIMIT_EXCEEDED`). Auto-creates an approval card when an
  agent task would exceed its cap.
- `budget_events` table — append-only ledger of `spend`, `limit_hit`,
  `extension_granted` events for the Budgets UI.

### Changed

- `WorkflowEngine.#transitionRunStatus` now performs all internal
  bookkeeping (terminal conversation message, SubflowExecutor
  notification) **before** publishing `RUN_COMPLETED` /
  `RUN_FAILED` / `RUN_CANCELLED`. External observers can now treat
  these events as a reliable "everything is done" barrier — closes a
  race the v1.3 WIP introduced.
- `WorkflowNodeType` is exactly 11 kinds: `trigger`, `agent_task`,
  `agent_swarm`, `skill_task`, `knowledge`, `scratchpad`, `router`,
  `merge`, `checkpoint`, `subflow`, `artifact_collect`.
- Trigger types are exactly 4: `manual`, `cron`, `webhook`,
  `persistent_listener`.
- `ApprovalCreateArgs.source` accepts `budget_limit` in addition to
  the existing checkpoint / openclaw / install / credential sources.

### Removed

- **Brain** (`collective_brain`, `brain_promotions`, `session_atoms`,
  `dialectic_*`, `peer_representations`, `dreaming_*`) — all tables,
  services, routes, events, types, and UI.
- **Apps** (`app_instances`, `app_brain`, `app_graph`, `data_tables`,
  `app_data`) — all tables, services, routes, events, types, and UI.
- **Memory OS** (`memory_entries`, `memory_planes`, `team_memory`) —
  all tables, services, routes, events, types, and UI.
- Aspirational node primitives that were never implemented in the
  engine: `variables`, `loop`, `parallel`, `wait`, `response`,
  `guardrails`, `evaluator`, `human_in_the_loop`. Loop/parallel
  semantics live in `subflow` for v1.0.
- Sprint C externalization surface — `workflow_deployments`,
  `mcp_servers`, `mcp_tools`, the `/v1/deployments`, `/v1/mcp`,
  `/v1/traces` routes, the telemetry sidecar, and the `traceId` /
  `tokenUsage` / `costMicros` / `graphSnapshot` columns on
  `workflow_runs`. Returns fresh in v1.1.
- 14 v1.1-deferred files (agentLedger, evals, files, inbox, policies,
  routines, dataIngestion, agentIdentity, plus their route pairs).
  Schema-less and unmounted; will be designed against the post-cut
  schema in v1.1.

### Fixed

- 12 pre-existing test failures from the v1.3 WIP checkpoint
  (sprintA aspirational tests, terminalTransition race, authRateLimit
  IP bucketing, deploymentsMcp, tracesXray, workflowGraphStore,
  nodeWorkerRuntime CPU flake, telemetrySink missing exports).
- `/v1/scheduler` error code (`SCHEDULE_NOT_FOUND` → `RESOURCE_NOT_FOUND`).
- `EventChainService` null guard on `sourceRun.workflowId`.
- `WorkflowEngine.drainWorkflowQueue` — the method `SchedulerService.tick`
  has been calling since v1.3 WIP but didn't exist on the engine.

### Migration

This release is **not** a drop-in upgrade from v1.3.0 — the schema
deletes 29 tables. To preserve a v1.3 database before upgrading:

```bash
git checkout archive/v1.3.0-full
# export whatever you need
git checkout master
# fresh boot will create the v1.0 schema
```

The Brain/Apps/Memory snapshot of v1.3.0 source is preserved on the
`archive/brain-apps` branch and the `archive/v1.3.0-full` tag for
reference when porting concepts forward to v1.1.

[Unreleased]: https://github.com/nexseed-labs/agentis/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nexseed-labs/agentis/releases/tag/v1.0.0
