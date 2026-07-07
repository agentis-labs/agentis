# Agentis — Known Limits (v1, honest)

> The disclosed ceilings agent-facing doctrine links, so agents (and operators) don't trust an affordance past where it actually holds. `agentis.orient` returns the load-bearing subset of these. Update as limits move.

## Durability / execution
- **Restart-durable wakes cover an enumerated set**: `wait` timers, parked `agent_session` yields (event/time/approval), and `subflow` children re-bind on boot (`recoverInterruptedRuns`). Other mid-flight executions re-dispatch with an idempotency key — effectively-once, which still requires downstream dedup, not exact resume.
- **The Durable Entity spine needs its lease honored**: SQLite is single-writer for the *file*, not per entity. All entity mutation must go through `DurableEntityService.claimDue`/`release` (the CAS lease) — do not mutate a leased entity out of band.
- **Wake granularity is the sweep interval** (60s for residency/subjects). Fine for minutes/hours/days; not a sub-minute SLA timer.

## Agents / residency
- **Residency acting requires the autonomy double-switch**: `AGENTIS_COMMAND_AUTONOMY=true` (deployment) AND a per-workspace opt-in. Without both, residency is surface-only.
- A resident agent's cross-wake memory is its `plan`/`observations` blocks (small, curated) — not a full transcript replay.

## Connections
- Connection ownership enforces at the agent send door and is **additive**: a connection is open until its first grant (or globally hardened via `AGENTIS_ENFORCE_CONNECTION_GRANTS`). Grants are per-(agent, connection); there is no per-message scope beyond read/send/manage yet.

## Experiments
- Assignment is sticky + deterministic (hash of subjectKey); arms are roughly, not exactly, balanced. Success = outcomes in {won, success, positive, converted}. No built-in significance testing yet — `results` gives rates + counts; judge significance yourself.
- Outcomes are not yet auto-fed from `appLearning.recordOutcome`; record them explicitly (`agentis.experiment.record`) or wire the bridge.

## Code-mode
- `agentis.code.execute` runs in a `node:vm` context. This is a **capability surface + resource governor** (call budget, wall-clock timeout, no ambient globals) — **not a hard security sandbox** against adversarial code. It suits the OSS single-tenant, trusted-operator threat model; do not expose it to untrusted third-party code without a real isolate.
- Per-execution budgets: default 30 tool calls, 20s wall-clock, capped result/log size. Plan-mode mutation blocks still apply to each underlying tool call.

## Subjects (spine)
- `SubjectRuntime`'s stage set is `send`/`agent`/`wait`/`done` (+`{{fact}}` interpolation). Branch/classify is done inside an `agent` step today, not as a declarative stage.
- Inbound channel replies are not yet auto-routed into a subject's inbox by correlation — an agent/dispatcher calls `agentis.subject.post`. Auto-routing is the remaining integration.

## Interface
- The interface is Agentis's owned declarative view tree (render-anywhere), not arbitrary compiled frontends. A cross-agent "mission control" surface (living agents + subjects + experiment dashboards) is composable from existing nodes but not yet shipped as a default.

## Platform shape
- OSS single-operator deployment; multi-tenant authz is out of scope for v1.
- Postgres portability is a stub; SQLite single-writer is by design.
