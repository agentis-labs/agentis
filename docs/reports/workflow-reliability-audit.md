# Workflow Reliability Audit

Generated: 2026-06-10T22:06:28.279Z

## Agentis Surface

- API test files scanned: 193
- Workflow node kinds: 28
- Trigger kinds: 4

### Node Coverage

| Node kind | Test mentions | Covered |
| --- | ---: | --- |
| `trigger` | 192 | yes |
| `router` | 11 | yes |
| `merge` | 25 | yes |
| `subflow` | 3 | yes |
| `wait` | 8 | yes |
| `loop` | 4 | yes |
| `parallel` | 1 | yes |
| `transform` | 95 | yes |
| `filter` | 11 | yes |
| `integration` | 35 | yes |
| `http_request` | 14 | yes |
| `workflow_store` | 5 | yes |
| `workspace_store` | 5 | yes |
| `scratchpad` | 7 | yes |
| `agent_task` | 74 | yes |
| `agent_session` | 7 | yes |
| `extension_task` | 20 | yes |
| `agent_swarm` | 1 | yes |
| `dynamic_swarm` | 1 | yes |
| `planner` | 1 | yes |
| `evaluator` | 3 | yes |
| `guardrails` | 1 | yes |
| `knowledge` | 1 | yes |
| `artifact_collect` | 1 | yes |
| `return_output` | 53 | yes |
| `artifact_save` | 3 | yes |
| `browser` | 5 | yes |
| `checkpoint` | 9 | yes |

### Trigger Coverage

| Trigger kind | Test mentions | Covered |
| --- | ---: | --- |
| `manual` | 93 | yes |
| `cron` | 16 | yes |
| `webhook` | 13 | yes |
| `persistent_listener` | 11 | yes |

### Critical Surfaces

| Surface | Source | Source present | Paired test | Test present |
| --- | --- | --- | --- | --- |
| Workflow engine | `apps/api/src/engine/WorkflowEngine.ts` | yes | `apps/api/tests/engine/WorkflowEngine.newNodes.test.ts` | yes |
| Trigger runtime | `apps/api/src/engine/TriggerRuntime.ts` | yes | `apps/api/tests/services/triggerRuntime.test.ts` | yes |
| Listener runtime | `apps/api/src/engine/ListenerRuntime.ts` | yes | `apps/api/tests/engine/ListenerRuntime.test.ts` | yes |
| Graph validation boundary | `apps/api/src/engine/validateGraph.ts` | yes | `apps/api/tests/validateGraph.test.ts` | yes |
| Reference lint | `apps/api/src/engine/validateGraphReferences.ts` | yes | `apps/api/tests/engine/validateGraphReferences.test.ts` | yes |
| Graph normalization | `apps/api/src/services/workflowGraphNormalization.ts` | yes | `apps/api/tests/services/workflowGraphNormalization.test.ts` | yes |
| Workflow readiness | `apps/api/src/services/workflowReadiness.ts` | yes | `apps/api/tests/services/workflowReadiness.test.ts` | yes |
| Trigger deployment | `apps/api/src/services/workflowTriggerDeployment.ts` | yes | `apps/api/tests/services/workflowTriggerDeployment.test.ts` | yes |
| Extension runtime | `apps/api/src/services/extensionRuntime.ts` | yes | `apps/api/tests/services/extensionRuntime.test.ts` | yes |

## n8n Reference

- packages discovered: @n8n, cli, core, extensions, frontend, node-dev, nodes-base, testing, workflow
- nodes-base directories counted: 307

### n8n Core Files

- `packages/core/src/execution-engine/workflow-execute.ts`
- `packages/core/src/execution-engine/active-workflows.ts`
- `packages/core/src/execution-engine/execution-lifecycle-hooks.ts`
- `packages/core/src/execution-engine/scheduled-task-manager.ts`
- `packages/workflow/src/run-execution-data/run-execution-data.v1.ts`
- `packages/workflow/src/interfaces.ts`

## Reliability Backlog Seeds

- Node kinds without direct API test mentions: none
- Trigger kinds without direct API test mentions: none
- Use this report to drive the next hardening wave before adding new workflow features.
