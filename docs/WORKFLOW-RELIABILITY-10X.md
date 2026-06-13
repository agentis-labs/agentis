# Workflow Reliability 10x

Make every workflow run, explain itself, and set up once.

This document is the single reliability program for Agentis workflow execution. It exists to stop us from fixing one broken workflow at a time and to force every repair through shared engine contracts.

## 2026-06-10 Program Reset

The scope is broader than one failing workflow. Agentis has to be reliable across:

- every node contract;
- every trigger path: `manual`, `cron`, `webhook`, `persistent_listener`;
- every extension/runtime boundary;
- every workflow deployment and reactivation path;
- every orchestrator-to-canvas build assumption;
- every API boundary where invalid graphs can still enter the system.

### Non-negotiable rules

1. No case-specific fixes. Every change must strengthen a shared contract, normalize legacy input, or add regression coverage around an engine invariant.
2. No duplicate architecture. Reuse these choke points first:
   - `workflowGraphNormalization`
   - `validateWorkflowGraph`
   - `validateGraphReferences`
   - `workflowReadiness`
   - `workflowTriggerDeployment`
3. Use n8n as a reference, not a blueprint. Compare execution rigor, trigger discipline, and coverage expectations without copying its data model blindly.
4. Reliability beats convenience. A structurally invalid graph should fail at authoring, import, or publish time, not after a long run.

### Current architecture-strengthening batch

1. Canonical graph normalization
   - Repair legacy router branch shape (`id` -> `branchId`).
   - Normalize template/JS router conditions into the safe engine grammar.
   - Normalize stored workflows on read as well as write so older graphs stop breaking new runs.
2. Runtime input-shape hardening
   - Persistent listeners expose a stable single-event payload shape: root fields, `event`, `item`, `events`, `count`.
   - Router conditions execute with the semantic scope the rest of the engine expects: `input`, `inputs`, `output`, `trigger`, `nodes`, `scratchpad`.
3. Validation boundary hardening
   - Invalid router and edge conditions are rejected by `validateWorkflowGraph`.
   - Dangling template references are treated as validation failures instead of silently resolving to empty runtime input.
   - Forward/self references remain warnings in lenient authoring mode so drafting still works.
4. Synthesis contract hardening
   - Builder/orchestrator instructions explicitly forbid `{{...}}`, `===`, and `!==` inside router conditions.
   - Listener-source payload expectations are explicit so persistent listeners stop being inferred incorrectly.

### Reliability audit harness

Entry point:

```bash
pnpm workflow:audit
```

The audit now:

- inventories Agentis workflow node kinds and trigger kinds from the real core types;
- scans API tests for direct coverage mentions by node/trigger kind;
- checks that critical engine/reliability surfaces exist and have paired tests;
- inspects the local `n8n` repo for the execution-engine files and node surface we are benchmarking against;
- writes the latest report to `docs/reports/workflow-reliability-audit.md`.

This gives us one living baseline for the hardening program instead of scattered terminal notes.

### Acceptance criteria for the next waves

- A malformed graph is blocked before run or publish.
- A persistent listener is publishable, activatable, reconnectable, and inspectable without manual surgery.
- The orchestrator reuses an existing eligible extension instead of generating duplicates.
- Trigger deployment stays singular per workflow and idempotent across republish/reactivate flows.
- Every supported node kind has explicit engine coverage, not accidental coverage through unrelated tests.

### Reliability waves

1. Boundary wave
   - validation, normalization, import/publish gates, condition grammar, reference integrity.
2. Trigger/runtime wave
   - cron, webhook, listener activation, reconnect semantics, health/reporting, backend availability.
3. Extension/connectivity wave
   - extension identity resolution, listener-source eligibility, dedupe, runtime I/O contracts.
4. Orchestrator awareness wave
   - reuse-vs-create decisions, existing asset discovery, trigger/persistent-listener authoring correctness.
5. Parity wave
   - compare Agentis support and invariants against the local n8n trigger/deployment/execution reference and close material gaps.

## Existing Reliability Fronts

### A. Execution robustness

Root cause already identified and fixed:

- Transform/filter expressions used to assume a single JS expression.
- LLM-synthesized workflows often emit function bodies with `return`.
- That mismatch caused valid generated workflows to die with syntax errors.

Shipped:

- Dual-mode expression evaluation in [apps/api/src/engine/safeExpression.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/engine/safeExpression.ts) to support both expression and function-body forms.
- Tests covering `return`, multi-statement bodies, context access, and blocked tokens.

Next:

- Build-time expression validation so invalid transforms/filters/evaluators are caught before run time.
- Continued failure taxonomy so the next engine-wide breakages are found empirically.

### B. Credentials

Problem:

- Re-entering the same credentials per workflow is needless friction.

Direction:

- Inline "save this key to my workspace" opt-in at the point of need.
- Dedicated settings surface for stored credentials, masking, rotation, deletion, and auditability.
- Reuse the existing encrypted vault, never a separate plaintext path.

### C. Auto-diagnosis

Problem:

- A failed run should come with a grounded explanation by default, not a dead-end button.

Shipped:

- Deterministic failure analyzer wired into failure cards.
- Auto-explained failures instead of generic "diagnose" prompts.

Next:

- Workspace toggle for auto-diagnosis.
- Fix remaining card actions so `Open workflow` and related actions are always live.

### D. Integrations

Problem:

- Synthesized `operationId` values can be incompatible with the actual connector.
- Failure handling previously allowed dead branches to leave runs stuck in waiting states.

Shipped:

- Integration operation normalization against the real connector catalog.
- Readiness warnings for unsupported operations before run time.
- Success-branch skipping after handled failures so runs reach a real terminal state.

Next:

- Feed per-integration operation catalogs and required params directly into synthesis so new builds start valid instead of being repaired later.
