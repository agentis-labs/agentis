# Agentis — Architecture (canonical)

> The single doc to trust for *what Agentis is and how to build in it*. Kept in sync with what `agentis.orient` returns to agents. The historical masterplans in `docs/` are archaeology; this is the current model. See [AGENT-NATIVE-PLATFORM-PLAN.md](AGENT-NATIVE-PLATFORM-PLAN.md) for the rationale and roadmap, and [LIMITS.md](LIMITS.md) for the honest v1 ceilings.

## The model: one spine, six primitives

Agentis is **one Durable Entity spine** projected into six primitives. You build systems by composing these — never by minting a separate app per workflow.

- **Agent** — a persistent worker. Identity + memory that outlive any run (`agentIdentity`, `agentMemory`). Opt it into `config.residency` and it wakes on its own clock to act, carrying plan/observations across wakes (`AgentSessionService.getOrCreateResident`, `residency.ts`, driven by `CommandHeartbeat.tickResidency`; save state with `agentis.residency.remember`). It owns scoped Connections and supervises Subjects.
- **Subject** — a durable per-entity actor (a lead, ticket, order, host…). Its own long-lived state + inbox; waits days, receives events out of order, drives its own lifecycle independent of any run. Runs on the spine via `SubjectRuntime` (`durable_entities` + `entity_inbox`); drive it with `agentis.subject.enroll/post/get/list`.
- **Connection** — a channel/credential/mcp mount an agent uses to act on the world. **Owned + scoped**: open until its first grant, then only its owner + granted agents may use it (`connection_agent_grants`, enforced at the send door; `agentis.connection.grants/request/grant`). Deterministic token-free sends go straight through the channel bridge; agent sends go through grant-checked tools.
- **Orchestration** — how work runs: a workflow graph (`build_workflow`, evolved live via `evolveGraph`/`pursue`/`converge`) with deterministic nodes where a step is proven and agent nodes where judgment is needed.
- **Experiment** — measurement: variants + per-variant success rate over outcomes (`experiments` + `experiment_assignments`; `agentis.experiment.define/assign/record/results`).
- **Interface** — the App's live declarative view tree (`agentis.ui.render`) over the App datastore — pipeline boards, inboxes, dashboards. One App hosts many workflows + collections + surfaces + agents.

**The Durable Entity spine** (`durable_entities` + `entity_inbox`, `DurableEntityService` + `DurableEntityDispatcher`) is the shared substrate: a keyed, restart-durable, single-writer-per-key record with a typed inbox and a wake clock, driven by one leased dispatcher. A persistent **Agent** and a per-subject **Subject** are the same primitive at different `kind`. A workflow **run** is the transient thing a wake spawns — related by reference, never merged.

## How to build (the loop)

1. **Orient / find-or-reuse.** Call `agentis.orient` — read the object model and your current inventory. Bind to an existing App/agent/connection instead of duplicating (creation tools are find-or-create; `agentis.app.create` reuses by name/owner).
2. **Compose in code.** `agentis.code.execute` runs async code against the whole `agentis.*` SDK — loops, conditionals, find-or-create-then-wire — in one shot. `agentis.code.api` lists the surface. This is the primary build interface; the discrete tools are what the SDK calls underneath.
3. **Give it data + interface.** `agentis.data.define_collection`, `agentis.ui.render`.
4. **Make it run continuously.** Resident agent (`config.residency`) and/or a cron/listener trigger; subjects on the spine for per-entity lifecycles.
5. **Connect + authorize.** Ensure the acting agent has a Connection grant (`agentis.connection.request` → operator `agentis.connection.grant`).
6. **Measure + clean up.** `agentis.experiment.*` for A/B; `agentis.app.archive`/`delete` (preview→confirm) to retire duplicates.

## Where things live (pointers, not exhaustive)

- Engine / graph: `apps/api/src/engine/WorkflowEngine.ts`, `engine/validateGraph.ts`.
- Spine: `apps/api/src/services/durableEntities.ts`, `subjectRuntime.ts`.
- Agents: `agentSession.ts`, `agentIdentity.ts`, `agentMemory.ts`, `residency.ts`, `commandHeartbeat.ts`.
- Connections: `connectionGrants.ts`, `channelBridge.ts`, `credentialVault.ts`.
- Experiments: `experiments.ts`. Code-mode: `codeMode.ts`.
- Apps / interface / data: `packages/app/*`, `surfaceGenerator.ts`, `agentisToolHandlers/appData.ts`.
- Agent tool surface: `apps/api/src/services/agentisToolHandlers/*` (registered in `index.ts`).
- Errors (codes + remediations, surfaced over MCP): `packages/core/src/errors.ts`.
- Schema + migrations: `packages/db/src/sqlite/schema.ts`, `migrations.ts`.

## Non-negotiables

- Never a ninth subsystem: new capability lands **in** the spine or **explicitly generalizes** a named existing subsystem (`feedback_no_duplication`).
- General, never per-use-case: every primitive is domain-neutral (`feedback_agentis_general_not_use_case`).
- Errors are directives (code + remediation), verdicts carry evidence, grants default-deny once set, and the interface/DSLs are views over the durable core.
