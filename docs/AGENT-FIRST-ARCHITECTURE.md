# Agentis Agent-First Architecture
## Build And Run Agentic Apps That Are Cheap, Reliable, And Native To Agents

> Status: proposed architecture
> Date: 2026-05-09
> Scope: runtime architecture, control plane, execution semantics, app contracts, agent-native tool surface, phased implementation plan

---

## 1. Why this document exists

Agentis already has strong foundations:

- a real workflow engine
- ledger and replay
- app packaging
- data ingestion
- traces and cost telemetrc
- deployments and MCP exposure

But the current system still reflects a mixed worldview:

- part workflow OS
- part human dashboard
- part future agent substrate

That is not enough for the actual goal.

The goal is bigger and much more specific:

1. A user who can only afford `$20` of agent spend today should be able to run work that normally demands `$1000` of LLM-heavy orchestration.
2. Agents should complete long, complex workflows reliably, using ground truth and constraints instead of hallucinating their way through business logic.
3. Agentis should be operable by agents as a first-class machine environment, not as a human dashboard that agents must mentally simulate.

This document defines the architecture required to make that true without turning Agentis into an overengineered science project.

---

## 2. Executive conclusion

The current architecture should not be replaced. It should be re-centered.

Keep:

- `WorkflowEngine`
- ledger
- partial replay
- scratchpad and run state
- package/app model
- workflow deployments
- data ingestion
- telemetry and traces

Change the center of gravity:

- from "UI plus engine"
- to "agent-native operating substrate with UI on top"

In plain language:

**The dashboard becomes a lens. The real product becomes the agent-facing runtime, tool plane, app contract system, and cost-minimizing execution engine.**

---

## 3. Non-negotiable principles

### 3.1 LLMs are for uncertainty, not plumbing

If a step can be handled by code, typed rules, retrieval, deterministic routing, or replay, it must not require an LLM call.

### 3.2 Every agent action must touch ground truth

The system should never rely on "the model thinks it succeeded." Success must be derived from one or more of:

- tool results
- code execution
- evaluator verdicts
- schema validation
- state transition checks
- human approval

### 3.3 The machine surface is the product surface

An agent should be able to:

- inspect state
- build or patch apps
- run and resume workflows
- query knowledge and memory
- resolve or request approvals
- inspect traces and costs
- deploy capabilities through MCP

without needing to reason about pixel layout or human navigation structure.

### 3.4 App contracts are runtime constraints, not documentation

An "agentic app" is not just a package with workflows. It is a system with explicit:

- outputs
- budgets
- evaluator rules
- failure policies
- escalation policies
- degradation behavior

### 3.5 Reliability comes from state, not from optimism

Long-running work is reliable only when the runtime has:

- persistent state
- resumability
- replay
- bounded loops
- checkpoints
- structured outputs
- policy gates

### 3.6 Complexity must compound value, not abstraction

Every new subsystem must either:

- reduce LLM spend
- increase completion rate
- improve control
- improve recoverability
- improve agent operability

If it does none of these, it is noise.

---

## 4. The north-star product model

### 4.1 What an agentic app is

An agentic app is a persistent software system that combines:

- workflows
- agents
- deterministic tools
- integrations
- datasets
- evaluators
- approvals
- deployment surfaces

to continuously produce a business outcome.

Examples:

- outbound SDR app
- market intelligence app
- support triage app
- engineering copilot app
- compliance monitor app

The user does not buy "a graph."
The user buys "an app that keeps doing a job."

### 4.2 What Agentis must become

Agentis must become three things at once:

1. **App authoring substrate**
   Agents and humans can create, edit, patch, evaluate, and deploy agentic apps.

2. **Long-running execution runtime**
   Apps run with persistent state, replay, budgets, contracts, and evaluators.

3. **Agent-native operating environment**
   Agents can operate Agentis through typed tools and protocols, not through human UI assumptions.

---

## 5. The cost thesis, stated precisely

Agentis should not merely lower the cost of a workflow from `$1000` to `$600`.
That is too small a goal.

The real goal is:

**Enable users with small budgets to run categories of work that would otherwise be inaccessible because conventional agent stacks spend LLM tokens on orchestration, memory handling, routing, retries, and recovery.**

### 5.1 The cost equation

For a naive agent harness:

```text
Total Cost = Reasoning + Orchestration + Memory Handling + Retry/Rework + Tool Misuse
```

In many systems, all five are partially paid in model calls.

For Agentis:

```text
Total Cost = Irreducible Reasoning
           + Deterministic Orchestration
           + Retrieval / Tool Execution
           + Bounded Replay
           + Contract / Evaluator Enforcement
```

The architecture wins when:

- orchestration is deterministic
- routing is deterministic when possible
- state is externalized
- retries are bounded and replayed from suffixes, not from the root
- evaluators catch drift early
- agents use high-cost reasoning only where uncertainty is real

### 5.2 What the runtime must do to make this true

The runtime must actively transform "model work" into:

- graph logic
- typed tool calls
- state machine transitions
- retrieval calls
- evaluator checks
- app policy checks
- patch operations

If it only tracks cost after the fact, it will not achieve the goal.

---

## 6. Current architecture: what is already right

The current repo has a solid, well-tested execution core. These files exist and are production-ready:

**Workflow engine**

- `apps/api/src/engine/WorkflowEngine.ts` — full run lifecycle, async dispatch, settle detection
- `apps/api/src/engine/ReadyQueue.ts` — FIFO node scheduling
- `apps/api/src/engine/WaitingInputBuffer.ts` — merge and join semantics
- `apps/api/src/engine/RunStateStore.ts` — persistent run state
- `apps/api/src/engine/PartialReplay.ts` + `apps/api/src/services/partialReplay.ts` — four replay modes
- `apps/api/src/engine/SafeConditionParser.ts` — hand-written recursive-descent grammar, no eval
- `apps/api/src/engine/TriggerRuntime.ts` — cron, webhook, persistent listener, manual
- `apps/api/src/engine/ActiveWorkflowRegistry.ts` — trigger rehydration on boot
- `apps/api/src/engine/validateGraph.ts` — cycle detection, reference validation

**Adapters**

- `apps/api/src/adapters/AdapterManager.ts` — typed event fan-out, health checks
- `apps/api/src/adapters/ClaudeCodeAdapter.ts` — subprocess JSONL stream, maxTurns cap
- `apps/api/src/adapters/OpenClawAdapter.ts` — WebSocket bridge, circuit breaker
- `apps/api/src/adapters/HttpAdapter.ts` — HMAC-signed callback, circuit breaker
- `apps/api/src/adapters/CircuitBreaker.ts` — shared three-state breaker used by all adapters
- `apps/api/src/adapters/channels/` — Telegram (inbound + outbound) and Discord (outbound-only)

**Services**

- `apps/api/src/services/ledger.ts` — append-only, monotonic sequence, replay source
- `apps/api/src/services/scratchpad.ts` — mutable run-scoped state with soft size warning
- `apps/api/src/services/skillRuntime.ts` — three trust tiers: builtin, node_worker, docker_sandbox
- `apps/api/src/services/approvalInbox.ts` — approval lifecycle, resolution
- `apps/api/src/services/sessionMirror.ts` — adapter event → conversation continuity
- `apps/api/src/services/conversationStore.ts` — message store with workspace isolation
- `apps/api/src/services/channelBridge.ts` — outbound delivery, inbound idempotency
- `apps/api/src/services/subflowExecutor.ts` — child run creation, parent-resume callbacks
- `apps/api/src/services/credentialVault.ts` — AES-256-GCM, rotation support
- `apps/api/src/services/activityFeed.ts` — workspace-scoped activity events
- `apps/api/src/services/registryClient.ts` — skill registry bridge with circuit breaker

**Observability**

- `apps/api/src/telemetry/index.ts` — OTel interface with dynamic import; `engine.tick` and `adapter.dispatch` spans instrumented

**Core types**

- `packages/core/src/types/workflow.ts` — discriminated union over all node kinds
- `packages/core/src/types/adapter.ts` — `AgentAdapter`, `NormalizedTask`, `NormalizedAgentEvent`
- `packages/core/src/types/skill.ts` — `SkillManifest`, `SkillRuntime`
- `packages/core/src/types/domain.ts`, `types/registry.ts` — app and registry domain types
- `packages/core/src/events.ts` — closed realtime event enumeration

Together these give the platform durable execution, multi-tier skill sandboxing, multi-agent dispatch, append-only audit, partial replay, and realtime observability. The test suite covers them thoroughly: 454 vitest + 315 Playwright.

**What does not yet exist:**

The following files were listed as existing foundations in an earlier draft of this document. They do not exist in the current codebase and represent genuinely new work:

- `apps/api/src/services/appInstances.ts`
- `apps/api/src/services/workflowDeployments.ts`
- `apps/api/src/services/dataIngestion.ts`
- `apps/api/src/services/mcpInterop.ts`
- `packages/core/src/types/package.ts` (app contract type — currently distributed across `domain.ts` and `registry.ts`)
- `apps/api/src/routes/traces.ts`
- Any agent-facing tool registry or chat tool executor

The problem is not lack of primitives.

The problem is that the agent-first runtime layer is absent:

- there is no typed machine surface through which an agent can build, inspect, or operate apps
- multi-turn agent work is not a native engine concept — `agent_task` is single-dispatch
- app contracts exist as schema descriptions but are not enforced at runtime
- cost is tracked via OTel spans but not compiled into execution policy before a run starts
- the six missing files above represent features that are planned but not started

---

## 7. The target architecture

The architecture should be organized into eight explicit planes.

```text
+----------------------------------------------------------------------------------+
|  1. APP CONTRACT PLANE                                                           |
|  Declares what an app is allowed, required, expected, and budgeted to do.        |
+----------------------------------------------------------------------------------+
|  2. AGENT CONTROL PLANE                                                           |
|  Typed tools, MCP, chat loop, build/patch/run/inspect operations.                |
+----------------------------------------------------------------------------------+
|  3. EXECUTION PLANE                                                               |
|  Workflow engine, multi-turn task loop, replay, queues, checkpoints.             |
+----------------------------------------------------------------------------------+
|  4. DETERMINISTIC WORK PLANE                                                      |
|  Skills, transforms, routing, evaluators, integrations, code execution.          |
+----------------------------------------------------------------------------------+
|  5. STATE AND KNOWLEDGE PLANE                                                     |
|  Scratchpad, ledger, memory, knowledge, ingested datasets, baselines.            |
+----------------------------------------------------------------------------------+
|  6. EVALUATOR AND POLICY PLANE                                                    |
|  Output validation, rubric scoring, approvals, spend gates, failure policy.      |
+----------------------------------------------------------------------------------+
|  7. DEPLOYMENT AND INTEROP PLANE                                                  |
|  Workflow deployments, app deployments, MCP exposure and consumption.            |
+----------------------------------------------------------------------------------+
|  8. OBSERVABILITY AND ECONOMICS PLANE                                             |
|  Traces, token use, cost, latency, drift, replay anchors, outcome metrics.       |
+----------------------------------------------------------------------------------+
```

The rest of this document defines each plane.

---

## 8. Plane 1: App Contract Plane

### 8.1 Why this plane matters

Today the `agentis` package format is strong, but it still behaves too much like a rich manifest and not enough like a runtime contract.

That must change.

An app contract should answer:

- What outcomes must this app produce?
- What inputs and datasets does it require?
- What budget envelope is acceptable?
- How is success measured?
- When should it replan?
- When should it stop?
- When must it escalate?
- What counts as degraded but acceptable service?

### 8.2 Required contract sections

Add a new runtime-level contract model to the `agentis` package format:

```ts
interface AppRuntimeContract {
  outputs: Array<{
    key: string;
    description: string;
    schema?: unknown;
    required: boolean;
  }>;
  successPolicy: {
    completionRule: 'all_required_outputs' | 'evaluator_pass' | 'workflow_terminal';
    minEvaluatorScore?: number;
  };
  budgetPolicy: {
    maxCostCentsPerRun?: number;
    maxCostCentsPerDay?: number;
    costMode: 'strict' | 'warn' | 'adaptive';
  };
  reliabilityPolicy: {
    maxTurnsPerAgentTask?: number;
    maxReplansPerRun?: number;
    replayStrategy: 'suffix_only' | 'checkpoint' | 'full';
    onContractViolation: 'fail' | 'escalate' | 'degrade';
  };
  escalationPolicy: {
    requireApprovalFor: string[];
    pauseOnAmbiguity: boolean;
    pauseOnBudgetRisk: boolean;
  };
  degradationPolicy: {
    fallbackModelClass?: 'small' | 'medium' | 'large';
    allowPartialOutputs: boolean;
    minOutputSet?: string[];
  };
}
```

### 8.3 Runtime enforcement

The engine must load this contract at run start and apply it during:

- dispatch
- retries
- replan
- completion
- evaluator verdicts
- deployment execution

This is not a UI-level check. It is engine policy.

---

## 9. Plane 2: Agent Control Plane

### 9.1 Principle

If agents are meant to build and operate apps, the control plane must be:

- typed
- explicit
- composable
- introspectable
- minimal in surface ambiguity

### 9.2 The current gap

The agent-facing tool surface does not exist as a coherent system.

There is no `chatToolCatalog.ts` and no `ChatToolExecutor`. The builtin skill registry (`builtinSkills.ts`) executes `echo` and `http_fetch`, but there is no typed machine surface through which an agent can inspect run state, patch a workflow, query knowledge, or resolve an approval programmatically.

The gap is not between promised and executable capability. The gap is that this layer has not been started. An agent interacting with Agentis today must reason about human navigation structure rather than a typed protocol.

This is the most important architectural gap in the repo today.

### 9.3 The target tool plane

Introduce a first-class `AgentisToolRegistry` independent from builtin skills.

It should expose typed platform tools grouped into families:

#### Build tools

- `agentis.app.create`
- `agentis.app.patch`
- `agentis.workflow.create`
- `agentis.workflow.patch`
- `agentis.workflow.validate`
- `agentis.workflow.compile`
- `agentis.agent.create`
- `agentis.skill.bind`
- `agentis.integration.bind`

#### Run tools

- `agentis.app.run`
- `agentis.workflow.run`
- `agentis.run.status`
- `agentis.run.cancel`
- `agentis.run.replay`
- `agentis.run.resume`

#### Inspect tools

- `agentis.app.inspect`
- `agentis.workflow.inspect`
- `agentis.run.inspect`
- `agentis.trace.inspect`
- `agentis.cost.inspect`
- `agentis.approval.list`
- `agentis.approval.resolve`

#### Data tools

- `agentis.knowledge.search`
- `agentis.knowledge.write`
- `agentis.memory.read`
- `agentis.memory.write`
- `agentis.dataset.import`
- `agentis.dataset.status`

#### Environment tools

- `agentis.space.summary`
- `agentis.viewport.context`
- `agentis.deployment.create`
- `agentis.mcp.expose`
- `agentis.mcp.consume`

### 9.4 Tool design rules

Every tool must:

- have a single clear purpose
- use explicit argument names
- require IDs when mutation is dangerous
- return typed structured output
- return `error` as data, not as an opaque crash
- include machine-readable `nextActions` when helpful

The system must optimize for "hard to misuse" tools, not for cleverness.

### 9.5 Architectural location

Add:

- `apps/api/src/services/agentisToolRegistry.ts`
- `apps/api/src/services/agentisToolHandlers/*.ts`

Then make:

- `chatToolCatalog.ts` derive from this registry
- `ChatToolExecutor` execute against this registry
- MCP exposure optionally map these tools outwards

This unifies:

- chat
- workflow tool use
- external MCP clients
- future orchestrator agents

around one real machine surface.

---

## 10. Plane 3: Execution Plane

### 10.1 Principle

The engine must own long-running autonomy, not just graph dispatch.

### 10.2 The required shift

`agent_task` must evolve from "single dispatch with completion callback" into a native execution primitive that supports:

- multi-turn continuation
- bounded iteration
- intermediate work state
- turn-by-turn budget checks
- contract checks
- human escalation
- durable continuation history

This is directionally captured in `docs/CHAT-TASKS.md` and should be promoted into the core runtime roadmap.

### 10.3 New agent task semantics

Every `agent_task` should support:

```ts
interface AgentTaskRuntimePolicy {
  multiTurn?: boolean;
  maxTurns?: number;
  onTurnCap?: 'escalate' | 'fail' | 'replan';
  requireStructuredOutput?: boolean;
  outputSchema?: unknown;
  evaluatorRef?: string;
  modelClass?: 'small' | 'medium' | 'large';
  costTier?: 'cheap' | 'balanced' | 'power';
}
```

### 10.4 Continuation history

Continuation history must not bloat `runState`.

Use:

- scratchpad for active condensed history
- ledger for durable replay anchors
- optional trace payload store for full forensic detail

The engine should store:

- current turn count
- latest working memory summary
- latest tool results
- latest evaluator status
- latest unresolved blockers

not the entire raw transcript inside the main run JSON.

### 10.5 Replanning

Replanning should become an explicit engine facility:

- detect contract failure or evaluator failure
- generate graph patch proposal
- validate patch
- apply patch with revisioning
- continue run with provenance

The existing graph patch capability is a strong base. It needs a runtime policy layer above it.

---

## 11. Plane 4: Deterministic Work Plane

### 11.1 Principle

The biggest cost win will come from expanding the amount of useful work that can happen without a frontier model call.

### 11.2 What belongs here

- routing
- branch selection when classifiable
- merge
- scratchpad ops
- transforms
- extraction
- validation
- code execution
- integrations
- evaluators
- artifact shaping

### 11.3 Required node families

The runtime should support, either as graph nodes or tool primitives:

- `integration`
- `transform`
- `extract`
- `validate`
- `evaluate`
- `batch`
- `code`
- `artifact_emit`
- `policy_gate`

Some of these already exist directionally in docs and schemas. The architecture should consolidate them rather than proliferate ad hoc node types.

### 11.4 Deterministic-first routing

Routing must use this order:

1. exact rule
2. typed classifier
3. evaluator rubric
4. LLM routing

This ensures that expensive semantic routing is used only when rules and bounded classifiers are insufficient.

### 11.5 Cost compiler

Introduce a pre-run optimizer:

- inspect graph
- classify each node as deterministic, cheap model, or expensive model
- compute estimated spend envelope
- annotate execution policy
- warn or adapt if the graph is wasteful

Suggested service:

- `apps/api/src/services/workflowCostCompiler.ts`

This service should not be "nice to have." It is central to the business thesis.

---

## 12. Plane 5: State And Knowledge Plane

### 12.1 Principle

Reliable agents externalize state.

The model should not be the source of truth for:

- workflow state
- memory
- intermediate outputs
- past decisions
- approvals
- baselines

### 12.2 State layers

Keep and clarify the separation:

#### Run scratchpad

- fast mutable state for one run
- compact, operational, ephemeral

#### Ledger

- append-only event log
- replay source
- provenance source

#### Memory

- structured, durable lessons or facts
- useful for future runs and operators

#### Knowledge

- indexed documents and dataset-derived records
- retrieval substrate

#### Baselines

- expected cost, latency, output frequency, evaluator scores

### 12.3 New requirement: state compaction

Long-running apps need state compaction and summarization policies.

Add:

- rolling scratchpad compaction
- turn history summarization
- replay anchors every N steps
- evaluator state snapshots

This reduces:

- token drag
- JSON bloat
- replay cost
- operational fragility

### 12.4 Dataset imports as first-class app intelligence

The app format already captures `datasetSpecs`.
The next step is runtime linkage:

- imported datasets must register as app capabilities
- retrieval should be scoped by app and dataset role
- evaluator examples should be queryable as a separate class of evidence

This makes imported business history part of the runtime, not just part of setup.

---

## 13. Plane 6: Evaluator And Policy Plane

### 13.1 Principle

If apps are supposed to produce desired outputs instead of hallucinated outputs, then evaluator infrastructure is not optional.

### 13.2 Evaluator roles

Evaluators should be able to:

- validate structured output
- score answer quality
- verify external side effects
- compare against rubric examples
- decide whether to continue, retry, patch, or escalate

### 13.3 Evaluator cost discipline

Evaluators must not cancel the cost savings they are meant to protect. An evaluator that makes a frontier LLM call to verify a frontier LLM output is a zero-sum operation.

Evaluators must follow this priority order:

1. **Schema validation** — structured output matches declared schema
2. **Rule-based checks** — presence of required fields, value range, format
3. **Rubric scoring against known examples** — retrieval-backed comparison, no LLM required
4. **LLM evaluation** — only when the above tiers cannot resolve the verdict

An evaluator must only reach tier 4 when semantic judgment is genuinely irreducible. The runtime should log the tier used per evaluation so the operator can identify evaluators that are spending unnecessarily.

### 13.4 Runtime behavior

Every important `agent_task` or terminal branch should optionally chain into an evaluator stage.

Example:

```text
agent_task -> evaluator -> one of:
  - accept and continue
  - retry same node with new instructions
  - patch downstream graph
  - escalate to human
  - fail the run
```

### 13.5 Policy engine

Create a runtime policy engine that receives:

- app contract
- current run cost
- evaluator verdicts
- approval status
- environment state

and produces one of:

- allow
- warn
- pause
- escalate
- degrade
- fail

Suggested service:

- `apps/api/src/services/runtimePolicyEngine.ts`

This is the control brain that prevents expensive wandering.

### 13.6 Budget policy is not enough

The current budget service is useful but insufficient by itself.

The runtime needs:

- spend reservation
- estimated future spend
- cost per remaining branch
- cost-aware model downgrade
- cost-aware replay policy

This is how a `$20` user gets `$1000` class work.

---

## 14. Plane 7: Deployment And Interop Plane

### 14.1 Principle

Agentis apps must be operable both internally and externally.

### 14.2 Deployment layers

There should be two deployable units:

#### Workflow deployment

- current system already supports this
- useful for narrow APIs and MCP exposure

#### App deployment

- higher-order deployment for an `agentis` app
- exposes:
  - app entrypoints
  - status
  - summary
  - app-scoped tools

### 14.3 MCP strategy

MCP should become a native part of the platform story:

- Agentis can consume external tools through MCP
- Agentis can expose app capabilities through MCP
- Agents inside Agentis can call MCP tools through the same tool registry

This is the cleanest path to "Agentis as the best environment for agents."

### 14.4 One registry, many transports

The architecture should converge on:

```text
AgentisToolRegistry
  -> chat executor
  -> workflow tool execution
  -> MCP exposed tools
  -> remote MCP consumed tools
  -> future SDK / CLI clients
```

That removes duplication and makes Agentis legible to models and external runtimes.

---

## 15. Plane 8: Observability And Economics Plane

### 15.1 Principle

If cost and reliability are core value, they must be visible as first-class runtime outputs.

### 15.2 Minimum observability model

Every run should have:

- total cost
- cost by node
- cost by model class
- token use by context block source
- replay count
- replan count
- evaluator failures
- approvals triggered
- output completeness
- latency by phase

### 15.3 App-level economics

Every app should have:

- cost per completed outcome
- completion rate
- evaluator pass rate
- average operator interventions
- average replay savings
- estimated spend avoided through deterministic execution

That last metric is essential. It demonstrates the whole thesis.

### 15.4 The "saved spend" metric

The platform should estimate:

```text
Saved Spend =
  estimated cost if orchestration/routing/retries were LLM-mediated
  minus
  actual spend under Agentis execution
```

This is not vanity if the assumptions are explicit and grounded in measurement.

To make this credible, the platform must collect baseline spend data from real runs before publishing the metric. The correct sequence is:

1. Instrument actual token spend per node and per model class (OTel spans already exist for this)
2. Establish a counterfactual cost model with explicit, documented assumptions
3. Validate the model against a set of controlled runs where naive and Agentis execution are compared
4. Only then surface "saved spend" as a user-facing metric

A saved-spend number derived from undocumented assumptions is a marketing claim. One derived from measured baselines with published assumptions is a product proof. Build the latter.

---

## 16. What must change in the current codebase

This section maps the architecture onto the repo.

### 16.1 Keep and strengthen

These files exist and are load-bearing. Do not refactor for its own sake — extend them only where the new planes require it.

**Engine**

- `apps/api/src/engine/WorkflowEngine.ts`
- `apps/api/src/engine/PartialReplay.ts` + `apps/api/src/services/partialReplay.ts`
- `apps/api/src/engine/ReadyQueue.ts`
- `apps/api/src/engine/WaitingInputBuffer.ts`
- `apps/api/src/engine/RunStateStore.ts`
- `apps/api/src/engine/SafeConditionParser.ts`
- `apps/api/src/engine/TriggerRuntime.ts`
- `apps/api/src/engine/ActiveWorkflowRegistry.ts`

**Services**

- `apps/api/src/services/ledger.ts`
- `apps/api/src/services/scratchpad.ts`
- `apps/api/src/services/skillRuntime.ts`
- `apps/api/src/services/approvalInbox.ts`
- `apps/api/src/services/sessionMirror.ts`
- `apps/api/src/services/conversationStore.ts`
- `apps/api/src/services/channelBridge.ts`
- `apps/api/src/services/subflowExecutor.ts`
- `apps/api/src/services/activityFeed.ts`

**Adapters**

- `apps/api/src/adapters/AdapterManager.ts`
- `apps/api/src/adapters/ClaudeCodeAdapter.ts`
- `apps/api/src/adapters/OpenClawAdapter.ts`
- `apps/api/src/adapters/HttpAdapter.ts`
- `apps/api/src/adapters/CircuitBreaker.ts`

**Observability**

- `apps/api/src/telemetry/index.ts`

**Core types**

- `packages/core/src/types/workflow.ts`
- `packages/core/src/types/adapter.ts`
- `packages/core/src/types/skill.ts`
- `packages/core/src/types/domain.ts`
- `packages/core/src/events.ts`

### 16.2 Add new core services

- `apps/api/src/services/agentisToolRegistry.ts`
- `apps/api/src/services/agentisToolHandlers/`
- `apps/api/src/services/workflowCostCompiler.ts`
- `apps/api/src/services/runtimePolicyEngine.ts`
- `apps/api/src/services/appContractRuntime.ts`
- `apps/api/src/services/evaluatorRuntime.ts`
- `apps/api/src/services/turnStateStore.ts`

### 16.3 Build new and evolve existing services

#### `ChatToolExecutor` and `chatToolCatalog.ts` — build from scratch

These files do not exist. They should be built as thin execution and catalog layers that derive directly from `AgentisToolRegistry`. There is no legacy implementation to migrate — the registry is the starting point.

#### `ChatSessionExecutor` — build from scratch

This file does not exist. It should be introduced as the session-scoped execution coordinator that connects the unified tool registry to conversation turns, using the same contract and policy context as workflow runs.

#### `WorkflowEngine`

Add:

- multi-turn `agent_task`
- app contract checks
- policy engine calls
- turn-state integration
- evaluator stage hooks
- cost compiler annotations at run start

#### `workflowDeployments.ts` — build from scratch

This service does not yet exist. Build it to support both workflow-level and app-level deployment profiles, and app-scoped tool exposure. It should land as part of Phase 5.

#### `mcpInterop.ts` — build from scratch

This service does not yet exist. Build it to map MCP tools into the unified tool registry and expose app capabilities as typed MCP tools. It should land as part of Phase 5 alongside app-level deployments.

### 16.4 Evolve core types

#### `packages/core/src/types/workflow.ts`

Add:

- richer `agent_task` runtime policy
- evaluator hooks
- policy gate node or equivalent config
- optional app contract references

#### `packages/core/src/types/domain.ts` and `packages/core/src/types/registry.ts`

App contract fields are currently distributed across these two files. Rather than creating a new `package.ts`, extend the existing domain types to include:

- `runtimeContract`
- evaluator bindings
- deployment profiles
- explicit output contracts

If the surface grows large enough to warrant separation, extract to `packages/core/src/types/appContract.ts` at that point — not preemptively.

#### `packages/core/src/types/chat.ts` — build from scratch

This file does not exist. It should be introduced to hold tool call request and result structures that align with `AgentisToolRegistry`, replacing ad hoc inline types in conversation routes.

---

## 17. The target runtime flow

This is the ideal end-to-end flow for a serious app run.

```text
1. App run requested
2. App contract loaded
3. Workflow cost compiler annotates graph
4. Runtime policy engine checks budgets and mode selection
5. Workflow engine starts
6. Deterministic nodes run without LLM
7. Agent tasks run in bounded multi-turn mode
8. Tool results and state updates feed back into the run
9. Evaluators verify important outputs
10. Failures trigger retry, replay, replan, degrade, or escalate
11. Terminal outputs are validated against app contract
12. Run emits final result, traces, economics, and provenance
13. App baselines update if confidence thresholds are met
```

This is the architecture that makes apps both cheaper and more reliable.

---

## 18. A minimal data model expansion

Do not create ten new tables unless reality demands it.

The architecture can stay lean with only a few targeted additions:

### 18.1 Likely necessary

- `app_runtime_contracts` or package-embedded contract with runtime snapshot
- `run_evaluations`
- `run_policy_events`
- `turn_state` or compact per-node turn state storage
- `app_baseline_snapshots`

### 18.2 Avoid unless proven necessary

- giant separate orchestration databases
- generic memory meta-framework tables
- parallel speculative planning stores
- excessive agent persona tables

The system should remain understandable.

---

## 19. Phased implementation plan

### Phase 1: Make the machine surface real

Goal:

- eliminate the gap between described tools and executable tools

Work:

- introduce `AgentisToolRegistry` and `agentisToolHandlers/`
- build `ChatToolExecutor` and `chatToolCatalog.ts` derived from the registry
- wire all tool definitions to real handlers
- expose the same handlers through MCP where appropriate

Exit condition:

- an agent can reliably inspect, run, patch, replay, approve, search, and deploy through tools alone

### Phase 2: Native multi-turn agent execution

Goal:

- make long agent work reliable at the engine level

Work:

- add multi-turn `agent_task`
- add turn-state store
- add turn caps and escalation
- add contract-aware completion

Exit condition:

- long-running agent tasks can continue, recover, and stop safely without adapter hacks

### Phase 3: Runtime contracts and evaluators

Goal:

- replace "looks good" with enforceable output quality

Work:

- add app runtime contract
- add evaluator runtime
- add policy engine
- gate terminal success on contract and evaluator outcomes

Exit condition:

- apps succeed because outputs satisfy policy, not because the model stopped talking

### Phase 4: Cost compiler and adaptive execution

Goal:

- make low-budget powerful apps truly feasible

Work:

- classify graph cost shape
- annotate node execution policy
- add model-tier routing
- add deterministic-first execution optimization
- expose saved-spend metrics

Exit condition:

- the runtime can explain why a run was affordable and how much model work it avoided

### Phase 5: App-native deployment and compounding intelligence

Goal:

- make Agentis apps deployable, measurable, and self-improving

Work:

- app-level deployment profiles
- app-scoped MCP exposure
- baseline updates from trusted runs
- evaluator example accumulation

Exit condition:

- an app is a real operational unit with its own economics, deployment surface, and learning loop

---

## 20. What not to do

To keep this architecture powerful without becoming bloated:

### Do not build a giant abstract "agent framework"

Keep the runtime close to the actual product primitives:

- app
- workflow
- run
- tool
- evaluator
- contract
- deployment

### Do not push everything into chat

Chat is a control surface, not the only runtime.
The workflow engine remains the durable execution substrate.

### Do not let agents mutate production structure without policy

App and workflow patching should be real, but policy-gated and revisioned.

### Do not hide economics

If a run is expensive, say so.
If a graph is wasteful, say so before execution.

### Do not create duplicate tool systems

One registry.
Many transports.

---

## 21. The final design statement

The architecture of Agentis should be:

- simple at the core
- strict at the boundaries
- deterministic by default
- agentic only where flexibility is necessary
- deeply observable
- economical by construction

The winning design is not "more AI."
The winning design is:

**a rigorous runtime that gives AI more leverage while forcing it to operate through state, tools, contracts, and evaluators.**

That is how Agentis becomes:

- cheaper than naive agent harnesses
- more reliable on long workflows
- truly native to agent operation
- the best place for agents to build and run serious software systems

---

## 22. Recommended next moves

If this document is accepted, the highest-leverage sequence is:

**Before Phase 1 begins:**

- Write `docs/AGENTIS-APP-FORMAT.md` — defines the app package contract that Phase 3 enforces at runtime
- Write `docs/CHAT-TASKS.md` — specifies multi-turn task semantics needed to design Phase 2
- Write `docs/CHAT-AGENT-LOOP.md` — specifies the agent loop model that Phase 1 tools must serve

These three specs are listed as inputs to this document but do not yet exist. Starting implementation without them means teams will resolve ambiguities independently and create conflicting assumptions.

**Implementation sequence:**

1. Build `AgentisToolRegistry` and make the tool plane real.
2. Implement multi-turn `agent_task` in the engine.
3. Add `runtimeContract` to the app package format; enforce it at runtime.
4. Add `runtimePolicyEngine` plus evaluator hooks with cost-tier ordering.
5. Build `workflowCostCompiler`; collect baseline spend data; validate the saved-spend model before exposing it as a user-facing metric.

That sequence preserves the strongest parts of the current architecture while directly attacking the three core goals.

---

## Appendix A: Design influences

This architecture intentionally aligns with a few proven ideas without copying anyone's product framing:

- Anthropic's distinction between workflows and agents, and the advice to prefer simple composable patterns over unnecessary framework complexity.
- MCP's model of typed tools and bidirectional machine-readable interoperability.
- OpenAI's agent guidance around safety, predictability, tool use, and structured orchestration.

These sources are not the product strategy. They are useful confirmation that the platform should become more explicit, more typed, and more tool-centered, not more magical.

Sources:

- https://www.anthropic.com/research/building-effective-agents
- https://modelcontextprotocol.io/specification/2024-11-05/basic/index
- https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
