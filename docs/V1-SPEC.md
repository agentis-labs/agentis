# Agentis - V1 Spec

> **This is the real, buildable V1 specification.** V1 is not a static admin panel and not a generic workflow platform renamed for agents. It is the first public version of Agentis — the proactive ambient dashboard OpenClaw should have had from day one, with n8n-class workflow execution built from scratch for agent architectures.
>
> The full platform vision and post-V1 roadmap live in [PLATFORM-VISION.md](./PLATFORM-VISION.md).

**Spec Version:** 1.3.0  
**Date:** April 27, 2026  
**Build target:** Shippable in weeks by a serious team, without lowering the architecture bar.  
**Thesis:** Agentis V1 is the proactive ambient dashboard OpenClaw deserves — a dark canvas-first harness OS where your agent fleet comes alive: workspaces, ambients, multi-gateway control, agent presence, visual workflow execution, approval inboxes, global activity, run history, command search, and a Skill registry community ecosystem for sharing and installing agent packages. Where other dashboards give you boards and logs, Agentis gives you the place agent work should have always happened.

---

## Meta-Rules

1. **Workflow is the product noun.** Do not use legacy goal-object terminology in V1 product, API, database, UI, or docs. Users already understand workflows.
2. **Agentis must be the most capable OpenClaw dashboard in existence.** The engine quality bar is n8n-class because your OpenClaw setup deserves it: persistent run state, queue discipline, multi-input buffering, partial replay, trigger lifecycle management, credential isolation, and live canvas events. No static admin panel, no board-and-task model, no adapted-from-elsewhere UX — designed from scratch, for OpenClaw, evolving with it.
3. **BullMQ is infrastructure, not the engine.** BullMQ persists wake-ups and background jobs. The Agentis Workflow Engine owns execution semantics.
4. **Self-hosted users are never commercially limited.** Agentis may ship local-dev defaults and safety warnings, but no hard self-hosted product gates. A user with 100 machines and 1,000 agents must be able to scale by configuration and infrastructure.
5. **One-step start is mandatory.** A new user must be able to run Agentis locally with one command and see a working canvas.
6. **Minimal architecture wins.** V1 runs as one application process plus PostgreSQL plus Redis. No separate microservice graph unless the operator chooses to scale workers independently.
7. **Every external call has timeout, retry, and failure behavior.** Skill registry, agents, adapters, webhooks, and LLM calls are never fire-and-forget.
8. **Every interface is complete.** No unbounded maps unless the comment explains why the payload is intentionally user-defined.
9. **No eval().** Workflow edge conditions use a safe parser.
10. **OWASP Top 10 is a hard constraint.** Security is part of the spec, not a later hardening phase.
11. **OpenClaw is the primary first-class adapter.** Every canvas feature, every presence event, and every workflow primitive must work perfectly with OpenClaw agents before any other adapter is considered. The OpenClaw WebSocket Gateway is not one integration among many — it is the reason Agentis exists.
12. **The dashboard experience is part of the core product, not decoration.** Fleet overview, agent fleet, gateways, activity, approvals, run history, command palette, workspaces, and the workflow canvas are V1 product surfaces with explicit data, API, realtime, and release-gate requirements.
13. **Agentis must feel like the native place to operate agents.** Do not copy Mission Control's board model, n8n's generic automation framing, or observability-only dashboards. Agentis combines live operations, workflow harnessing, and ambient agent presence into one operating surface.

---

## Section 0 - Product Definition

### 0.1 What Agentis V1 Is

Agentis V1 is the proactive ambient dashboard OpenClaw should have had from day one — a self-hosted, open-source harness OS designed from scratch to match and evolve with OpenClaw, not adapted from a generic tool and renamed for agents.

It is the most powerful place to run your OpenClaw setup: 10x more capable than any existing surface, with workspaces for different operating contexts, ambients for dev/prod/fleet modes, multi-gateway management, a living canvas where your agent fleet breathes in real time, n8n-class workflow execution built specifically for agent architectures, and a community Skill registry for sharing and installing agent packages.

**What makes Agentis different from every other OpenClaw dashboard:**

- **A living canvas, not a static panel.** Agent presence overlays move at 20Hz via direct DOM mutations. Status transitions animate with FLIP. Task progress streams as typewriter text. When your agents work, you see it — not in a log tab, but directly on the canvas, where the work is happening.
- **A workflow harness, not a task board.** Visual graphs that orchestrate your OpenClaw agents: trigger, run parallel branches, merge outputs, replay failed paths, fork from the Skill registry — n8n-class execution built for agent architectures, not API automation.
- **OpenClaw-native, not OpenClaw-compatible.** The OpenClaw adapter is the reason Agentis exists. It speaks the Gateway WebSocket protocol directly, consumes real-time agent events, and is the first-class connection surface. Every canvas feature works with OpenClaw before anything else.
- **A full operating cockpit, not a single builder page.** Fleet Overview, Agent Fleet, Gateways, Activity, Approvals, Run History, Command Palette, Workspaces, and the Workflow Canvas all ship in V1. The canvas is the strongest surface, but it is not the only surface.
- **A community ecosystem, not a local tool only.** Skill registry connects Agentis to a Nexseed-operated platform for sharing, installing, and co-creating agent packages, workflow templates, and skills — the GitHub for agents.

The primitives stay the same as V1 always planned. The reason they exist is now the product pitch:

- **Workflows:** durable visual harness graphs that orchestrate your OpenClaw agents — trigger, replay, fork, publish.
- **Agents:** your OpenClaw fleet, registered and monitored in one surface with live health, presence, and dispatch.
- **Workspaces and ambients:** named operating contexts that separate OpenClaw setups, gateways, credentials, workflows, and active runs.
- **Gateways:** first-class OpenClaw Gateway connections with live health, agent mapping, sync, reconnect, and event stream visibility.
- **Skills:** reusable capabilities with manifests, credentials, versioning, and Skill registry distribution.
- **Scratchpad:** workflow-scoped shared state your agents read and write while the run is live.
- **Ledger:** append-only event history for replay, recovery, audit, and canvas status updates.
- **Skill registry:** community platform for agent packages, workflow templates, and skills — install, fork, publish, co-create.

V1 must feel like the dashboard you always wished OpenClaw had: a fleet cockpit when you need awareness, a workflow canvas when you need harnessing, a command palette when you need speed, an approval inbox when agents need judgment, and a run history when you need to understand exactly what happened.

### 0.2 What V1 Solves

**Gaps vs. existing OpenClaw dashboards (openclaw-mission-control and others):**

| Existing Dashboard Gap | Agentis V1 Answer |
|---|---|
| Static board/task model for agent work | Visual workflow canvas: agent orchestration as a live graph, not a Kanban board |
| No workflow execution engine | n8n-class Workflow Engine: parallel branches, merge nodes, partial replay, persistent run state |
| No real-time visual agent feedback | Living Canvas: presence overlays at 20Hz, FLIP-animated status transitions, typewriter progress streams |
| Approval flows only, no workflow composition | Checkpoint nodes: manual approvals, auto-timeout, full replay from checkpoint, embedded in visual graph |
| Activity logs only, no shared run state | Ledger + Scratchpad: append-only run history, shared state visible live, deterministic replay |
| Agent management is only a CRUD table | Agent Fleet + Constellation: status, heartbeat, current task, gateway, capabilities, live aura, terminal stream |
| Gateway setup is hidden infrastructure | Multi-Gateway Management: connect, pair, sync, health, reconnect, agent mapping, Gateway event stream |
| Approvals are trapped inside board/task pages | Approval Inbox: all pending checkpoint and OpenClaw exec approvals across the workspace |
| Run history is scattered per board/task | Run History Browser: every run across every workflow, filterable, replayable, inspectable |
| Search is page-local | Command Palette: search agents, workflows, runs, skills, Skill registry packages, commands, and recent events |
| No environment separation | Workspaces + Ambients: local/dev/prod/fleet contexts with scoped gateways, credentials, workflows, and activity |
| No community/distribution ecosystem | Skill registry Bridge: install, fork, publish, sync agent packages and workflow templates |
| No skill/capability abstraction layer | Skill Runtime: reusable capabilities with manifests, versioning, and Skill registry distribution |
| No canvas-native workflow composition | React Flow canvas with trigger, agent_task, skill_task, router, merge, checkpoint, and subflow nodes |

**MAS-level failure modes from R5 that V1 also addresses:**

| Failure Mode | V1 Mechanism |
|---|---|
| Blank-Slate Problem | Persistent Agent Registry, Workflow definitions, Skill registry packages, reusable Skills |
| Summarization Cliff | Workflow state lives in Ledger + Scratchpad, not only agent context windows |
| Coordination Desert | Scratchpad, live task events, concurrent task execution, agent presence |
| Interruption Tax | Append-only Ledger, resumable Workflow Runs, adapter heartbeats, task timeouts |
| Context Tax | Workflow injects only declared Scratchpad keys and workflow metadata per task |
| AGENTS.md Burden | Skill registry-installed agent packages and workflow templates replace hand-maintained flat files |
| Verification Desert | Skill health, run history, adapter status, deterministic replay, canvas status events |

### 0.3 V1 Scope

**In V1:**

1. Workflow Builder: visual graph creation, run, replay, partial replay, fork, and publish.
2. Agentis Workflow Engine: n8n-class execution semantics for OpenClaw and agent architectures.
3. Trigger Runtime: manual, cron, webhook, and persistent listener triggers.
4. Agent Registry: OpenClaw (first-class), Claude Code, and Generic HTTP adapters.
5. Skill Runtime: local and Skill registry-installed skill manifests executed in Node.js Workers.
6. Agent Packages: installable bundles of agents, skills, credentials schema, and workflow templates.
7. Scratchpad: workflow-scoped shared state with live events.
8. Ledger: append-only run history, cursor pagination, replay, recovery.
9. Skill registry Bridge: browse, install, fork, publish, sync, and co-create Skill registry artifacts.
10. Living Canvas with Presence: design-locked dark canvas with 20Hz agent presence overlays, FLIP animations, and typewriter progress streams.
11. Local Auth: username/password, JWT RS256, local secrets encryption.
12. One-Step Local Start: `npx agentis@latest up` — no Docker, no Postgres, no Redis required. Starts in embedded mode (SQLite + in-process event bus) in under 30 seconds on a cold machine.
13. OpenClaw Native Integration: Gateway WebSocket adapter, real-time agent event consumption, device token auth, persistent listener triggers.
14. Fleet Overview: the first operating cockpit after login, with live fleet status, active runs, gateway health, pending approvals, recent activity, and quick-launch actions.
15. Agent Fleet + Agent Detail: all agents across gateways with online/busy/offline/error states, heartbeat, model, capabilities, current task, terminal stream, and workflow assignments.
16. Global Activity Feed: cross-workspace, cross-agent, cross-run timeline sourced from Ledger, adapter events, approvals, Skill registry sync, and gateway events.
17. Approval Inbox: all pending checkpoint approvals and OpenClaw `exec.approval.requested` events in one review surface.
18. Run History Browser: global run table with filters, search, duration, status, replay, Ledger, Scratchpad, and canvas jump links.
19. Command Palette: keyboard-first search and command surface for workflows, agents, gateways, runs, approvals, Skill registry packages, skills, and settings.
20. Multi-Gateway Management: connect and operate multiple OpenClaw gateways, including health, pairing, sync, agent mapping, and reconnect behavior.
21. Workspaces + Ambients: V1 supports multiple named operating contexts with scoped agents, workflows, credentials, gateways, activity, and default ambient selection.
22. Terminal Pane: OpenClaw `session.message` and `session.tool` event stream with agent RPC input for direct intervention.
23. Conversation Panel + Session Continuity: Agentis mirrors existing OpenClaw sessions, approvals, and direct operator messages into one per-agent thread. Threads are persisted, searchable, linked to running workflows, and let the operator continue existing agent work from Agentis without rebuilding context or switching to a separate communication surface.

**Out of V1:**

| Feature | Deferred To | Reason |
|---|---|---|
| Hosted Agentis Cloud | V3 | V1 is self-hosted first. Railway deploy is supported, but no Nexseed-managed control plane. |
| Enterprise SSO / SAML | V3 | Local auth is enough for V1 open-source launch. |
| Firecracker microVM isolation | V3 | V1 ships a Docker sandbox tier for Skill registry-installed skills (see §9.2). Firecracker is promoted when hosted/metered execution of fully untrusted third-party code requires hypervisor-level guarantees that Docker cannot provide. |
| ELO routing | V2 | V1 stores capability tags and run outcomes; ELO needs history before signal matters. |
| Full 3-tier Memory OS | V2 | V1 has Scratchpad + Ledger. Semantic/episodic memory follows once workflows generate enough data. |
| External channel bridges and advanced notification rules | V2 | V1 integrates existing OpenClaw sessions and approvals directly inside Agentis. Telegram/Discord/Slack/WhatsApp routing and conditional notification rules follow once the core session and approval event taxonomy stabilizes. |
| Multi-user workspace membership | V2 | V1 supports multiple local workspaces for one authenticated operator. Team membership, roles, and collaboration follow after the single-user operator loop is excellent. |

### 0.4 What Agentis V1 Is NOT

These clarifications prevent regression back to the wrong positioning:

| It is NOT this | Because |
|---|---|
| A generic API automation platform | n8n already does that. Agentis is built for agent architectures, not webhook chains. |
| A board-and-task project management layer | openclaw-mission-control already covers that. Agentis is a workflow harness and living canvas, not Kanban. |
| A chatbot wrapper replacing the canvas | The canvas and workflow engine are the primary product surfaces. Conversation Panel and OpenClaw session continuity are additive operator layers for continuing existing work, not replacements for the workflow and fleet surfaces. |
| Adapted from another platform and relabeled | Not n8n with agent labels. Not Mission Control with a canvas bolted on. Designed from scratch, for OpenClaw. |
| A cloud-only or Nexseed-operated runtime | V1 is self-hosted first. One command to run locally. Skill registry is Nexseed-operated; the runtime is yours. |

---

## Section 1 - Naming Contract

No V1 implementation uses legacy goal-object terminology.

| Concept | V1 Name | Examples |
|---|---|---|
| Top-level graph | Workflow | `workflows` table, `/v1/workflows`, `WorkflowCanvas` |
| One execution of a workflow | Workflow Run | `workflow_runs` table, `/v1/workflows/:id/runs` |
| Node executed by an agent or skill | Task | `tasks` table |
| Reusable capability | Skill | `skills` table, Skill registry skill bundle |
| Bundle of agents + skills + templates | Agent Package | Skill registry package artifact |
| Shared state during a run | Scratchpad | Redis + optional persisted snapshots |
| Immutable history | Ledger | `ledger_events` table |
| Top-level operating boundary | Workspace | `workspaces` table, top-left switcher, scoped credentials/gateways/workflows |
| Saved operating context inside a workspace | Ambient | `ambients` table, Local / Dev / Prod / Fleet modes |
| OpenClaw runtime connection | Gateway | `openclaw_gateways` table, `/v1/gateways`, gateway health surface |
| Cross-surface timeline item | Activity Event | `activity_events` table, `/v1/activity` |
| Human decision request | Approval Request | `approval_requests` table, `/v1/approvals` |

---

## Section 2 - Open-Source Product Bar

### 2.1 n8n-Class Does Not Mean Clone

Agentis adopts n8n's proven execution quality bar — visual workflows, triggers, credentials, run history, node status, templates, packages, and a community ecosystem — because OpenClaw users deserve that level of reliability. Agentis replaces the parts that break for agent architectures: sequential-only node execution, static graphs, output-to-input-only communication, no agent identity, and no live presence.

The n8n mental model is a quality reference, not the product identity. Agentis is an OpenClaw harness dashboard first. The workflow engine is what makes that dashboard 10x more capable than any existing surface.

| Capability | n8n Quality Bar | Agentis V1 Requirement |
|---|---|---|
| Workflow runs | Durable execution data | Durable `workflow_runs` + `run_state` + Ledger |
| Execution queue | Deterministic queue discipline | Ready queue + waiting inputs + concurrent branches |
| Multi-input nodes | Waiting buffers | `waitingInputs` buffer per task node |
| Partial replay | Run dirty subgraphs | Replay from any task, checkpoint, or failed branch |
| Triggers | ActiveWorkflows + Scheduler + Webhooks | ActiveWorkflowRegistry + TriggerRuntime + persistent listener adapters |
| Node ecosystem | Node packages | Skill registry agent packages (each bundle contains agents, skills, and workflow templates) |
| Canvas updates | Push lifecycle events | Ledger + live presence + task status streams |
| Credentials | Isolated credential store | Encrypted credential vault, scoped to packages/agents/skills |

### 2.2 Self-Hosted Freedom

Agentis V1 has no license, tier, or product-level concurrency limits for self-hosted users.

The app may ship **local-development defaults** so `npx agentis@latest up` works on a laptop. These defaults are not product gates. Operators can set parallelism to any value their infrastructure supports.

```bash
# Examples
AGENTIS_WORKFLOW_PARALLELISM=auto        # default: based on online agents + CPU
AGENTIS_WORKFLOW_PARALLELISM=unbounded   # dispatch every ready task, adapter backpressure only
AGENTIS_WORKFLOW_PARALLELISM=250         # explicit operator-controlled cap
```

Agentis should warn when an operator asks a small machine to do too much, but it must not prevent a self-hosted deployment from controlling a large agent fleet.

---

## Section 3 - Minimal Architecture

### 3.1 Runtime Shape

V1 runs in **embedded mode** by default and can be promoted to **standard mode** for production deployments.

#### Embedded mode (default — zero external dependencies)

```text
agentis app process
  Hono API
  WebSocket server
  Workflow Engine
  Trigger Runtime (node-cron; no Redis/BullMQ required)
  Skill Runtime (isolated-vm pool)
  Adapter manager
  OpenClaw session mirror
  Static dashboard assets

embedded dependencies (no Docker, no Postgres, no Redis)
  SQLite  (\.agentis/data.db via better-sqlite3 + Drizzle SQLite dialect)
  In-process event bus (Node.js EventEmitter; SSE fan-out for realtime)
  File-based encrypted session store (\.agentis/sessions.db)
```

Embedded mode is the default for `npx agentis@latest up`. It starts in under 30 seconds on a cold machine. No Docker. No separate service. No config file required before first run. SQLite with WAL mode handles all workloads a single self-hosted operator will encounter; there is no practical ceiling for the V1 use case.

#### Standard mode (opt-in — set `AGENTIS_MODE=standard`)

```text
agentis app process
  (everything in embedded mode)
  + BullMQ job queues (replaces node-cron + in-process queue)
  + Docker sandbox pool (Skill registry-installed skill execution)

external dependencies
  PostgreSQL  (AGENTIS_DATABASE_URL)
  Redis       (AGENTIS_REDIS_URL; enables BullMQ, distributed scratchpad pub/sub)
  Docker      (AGENTIS_SKILL_DOCKER=true; skill sandbox only — all other features work without it)
```

Standard mode is recommended when an operator needs: horizontal worker scaling, persistent distributed Scratchpad across multiple app processes, or Skill registry skill sandboxing via Docker. Nothing in the V1 feature set is gated on standard mode; every product surface works in embedded mode.

**Mode detection:** The CLI detects mode from environment variables. `AGENTIS_DATABASE_URL` present → PostgreSQL driver. `AGENTIS_REDIS_URL` present → Redis driver + BullMQ. Absence of both → embedded SQLite + in-process bus. No config file or flag is required to start in embedded mode.

### 3.2 One-Step Local Start

The primary install path is:

```bash
npx agentis@latest up
```

This command must:

1. Create `.agentis/` in the current directory if missing.
2. Generate local secrets (JWT keypair, AES credential encryption key) if missing.
3. Initialize the SQLite database and run embedded-mode Drizzle migrations.
4. Seed the default admin user and built-in system skills.
5. Start the Agentis app process in embedded mode.
6. Open or print the dashboard URL: `http://localhost:3737`.

Total time from cold machine (Node.js already installed): **under 30 seconds**. No Docker. No Postgres. No Redis. No config file to edit before step 1.

First-login experience: the dashboard opens directly to Fleet Overview. A contextual onboarding strip guides the operator to connect their first OpenClaw Gateway, register an agent, and run their first workflow. The strip dismisses permanently after the first successful run.

Standard mode (PostgreSQL + Redis) start path:

```bash
AGENTIS_DATABASE_URL=postgres://... AGENTIS_REDIS_URL=redis://... npx agentis@latest up
```

Or via Docker Compose for managed local dependencies:

```bash
pnpm agentis:up   # starts Postgres + Redis via docker-compose, then Agentis in standard mode
```

Advanced source-development path:

```bash
pnpm install
pnpm agentis:up
```

A contributor must be able to run the full stack with one command and reach a seeded working dashboard.

### 3.3 Monorepo Structure

```text
agentis/
  apps/
    api/                     # single production app: Hono API + static dashboard + workers
      src/
        index.ts             # starts HTTP, WS, engine, triggers, adapters
        routes/
          auth.ts
          dashboard.ts
          workspaces.ts
          ambients.ts
          workflows.ts
          runs.ts
          tasks.ts
          agents.ts
          gateways.ts
          activity.ts
          approvals.ts
          skills.ts
          triggers.ts
          command.ts
          terminal.ts
          hub.ts
          ledger.ts
          scratchpad.ts
          conversations.ts
        engine/
          WorkflowEngine.ts
          RunStateStore.ts
          ReadyQueue.ts
          WaitingInputBuffer.ts
          PartialReplay.ts
          ActiveWorkflowRegistry.ts
          TriggerRuntime.ts
        adapters/
          AdapterManager.ts
        services/
          workspaceContext.ts
          credentialVault.ts
          scratchpad.ts
          ledger.ts
          registryClient.ts
          skillRuntime.ts
          skillIsolatePool.ts
          skillDockerPool.ts
          activityFeed.ts
          approvalInbox.ts
          gatewayDirectory.ts
          commandIndex.ts
          conversationStore.ts
          sessionMirror.ts
        websocket/
          rooms.ts
          events.ts
    web/                     # React + Vite canvas app, built to static assets
      src/
        pages/
          FleetOverviewPage.tsx
          WorkflowsPage.tsx
          WorkflowCanvasPage.tsx
          RunHistoryPage.tsx
          AgentFleetPage.tsx
          AgentDetailPage.tsx
          GatewaysPage.tsx
          ActivityPage.tsx
          ApprovalsPage.tsx
          HubPage.tsx
          AgentsPage.tsx
          SkillsPage.tsx
          ConversationsPage.tsx
          WorkspacesPage.tsx
          SettingsPage.tsx
        components/
          dashboard/
            FleetOverview.tsx
            ActiveRunsStrip.tsx
            GatewayHealthRail.tsx
            PendingApprovalsDock.tsx
            RecentActivityStream.tsx
          canvas/
            WorkflowCanvas.tsx
            WorkflowNode.tsx
            AgentNode.tsx
            AgentFocusOverlayManager.ts
            NodePalette.tsx
            RunDrawer.tsx
          agents/
            AgentConstellation.tsx
            AgentFleetTable.tsx
            AgentDetailPanel.tsx
            TerminalPane.tsx
          conversations/
            ConversationList.tsx
            ConversationThread.tsx
            ConversationInput.tsx
            ConversationMessageRow.tsx
          gateways/
            GatewayConnectionForm.tsx
            GatewayStatusCard.tsx
            GatewayAgentMap.tsx
          activity/
            ActivityFeed.tsx
            ActivityEventRow.tsx
          approvals/
            ApprovalInbox.tsx
            ApprovalRequestRow.tsx
          runs/
            RunHistoryTable.tsx
            RunInspector.tsx
          hub/
            HubCommandCenter.tsx
            PackageInstallDrawer.tsx
          shared/
            CommandPalette.tsx
  packages/
    core/                    # constants, schemas, shared types
    db/                      # Drizzle schema and migrations (SQLite + PostgreSQL dialects)
    adapters/                # OpenClaw, Claude Code, HTTP adapters
    skills/                  # built-in skills and skill manifest utilities
    cli/                     # `agentis up` one-step local command
  infrastructure/
    docker-compose.yml       # Optional: PostgreSQL + Redis for standard mode
    railway.toml
```

React + Vite is chosen for the dashboard because Agentis is an authenticated app, not an SEO website. Hono serves the built dashboard assets from the same app process.

---

## Section 4 - Named Constants

All values live in `packages/core/src/constants.ts`. Values below are defaults or warnings, not commercial limits.

```typescript
export const CONSTANTS = {
  // Engine
  WORKFLOW_COMPLEXITY_WARNING_TASKS: 100,
  // Rationale: Above 100 tasks, show a UI warning and recommend grouping into subflows.
  // Do not reject the workflow. Self-hosted operators decide their own limits.

  WORKFLOW_PARALLELISM_DEFAULT: 'auto',
  // Rationale: Auto uses min(readyTasks, onlineAgents, cpuCount * 2) for a laptop-safe default.
  // Operators may set AGENTIS_WORKFLOW_PARALLELISM=unbounded or any positive integer.

  RUN_STATE_SNAPSHOT_INTERVAL_EVENTS: 50,
  // Rationale: Persist a compact run-state snapshot every 50 ledger events so recovery does
  // not replay thousands of events on long workflows.

  MAX_REPLAN_ATTEMPTS_DEFAULT: 3,
  // Rationale: Default retry budget. Operator-configurable. Not a product gate.

  // Timeouts
  PLANNING_LLM_TIMEOUT_MS: 60_000,
  AGENT_TASK_RESPONSE_TIMEOUT_MS: 300_000,
  ADAPTER_HEALTH_CHECK_INTERVAL_MS: 15_000,
  AGENT_HEARTBEAT_INTERVAL_MS: 15_000,

  // Scratchpad warnings, not hard product limits
  SCRATCHPAD_SIZE_WARNING_BYTES: 10_485_760,
  // Rationale: 10MB is where Redis-backed scratchpad usage likely means the user should
  // move large artifacts to files/object storage. Warn, but do not block by default.

  SCRATCHPAD_WRITE_CHUNK_SIZE: 10,

  // Ledger
  LEDGER_PAGE_SIZE: 100,

  // Dashboard surfaces
  ACTIVITY_FEED_PAGE_SIZE: 50,
  RUN_HISTORY_PAGE_SIZE: 50,
  COMMAND_PALETTE_RESULT_LIMIT: 12,
  FLEET_OVERVIEW_REFRESH_MS: 5_000,
  GATEWAY_RECONNECT_BACKOFF_MS: 2_000,
  GATEWAY_RECONNECT_MAX_BACKOFF_MS: 30_000,
  APPROVAL_INBOX_POLL_MS: 10_000,

  // Webhooks
  WEBHOOK_TIMESTAMP_TOLERANCE_MS: 300_000,
  WEBHOOK_MAX_RETRY_ATTEMPTS: 5,

  // Skill registry
  SKILL_REGISTRY_TIMEOUT_MS: 10_000,
  HUB_API_RETRY_COUNT: 2,
  HUB_CACHE_TTL_SECONDS: 300,
  HUB_SYNC_INTERVAL_SECONDS: 300,

  // Skill runtime — isolation tiers
  SKILL_EXECUTION_TIMEOUT_MS: 30_000,
  SKILL_EXECUTION_MAX_TIMEOUT_MS: 300_000,

  // isolated-vm pool (node_worker tier)
  SKILL_ISOLATE_HEAP_MB: 128,
  // Rationale: 128 MB covers realistic skill workloads (HTTP calls, JSON transforms, text processing).
  // Skills that genuinely need more should be redesigned or promoted to docker_sandbox.
  SKILL_ISOLATE_POOL_DEFAULT: 'auto',
  // Rationale: Auto sizes to min(CPU logical cores, 8) — enough for parallel skill branches
  // without saturating a laptop.

  // Docker sandbox pool (docker_sandbox tier — Skill registry-installed skills)
  SKILL_DOCKER_MEMORY_MB: 256,
  // Rationale: 256 MB is the Railway Hobby container default; generous for a single skill.
  SKILL_DOCKER_CPU_QUOTA: 0.5,
  // Rationale: 0.5 CPU cores prevents a misbehaving skill from starving the Agentis process
  // on a shared machine.
  SKILL_DOCKER_TMP_MAX_MB: 64,
  // Rationale: Skills must not use the local filesystem as an output channel; 64 MB is enough
  // for in-flight scratch data without creating an exfiltration surface.
  SKILL_DOCKER_POOL_SIZE: 2,
  // Rationale: 2 warm containers per installed Skill registry skill balances memory usage against cold-start
  // latency. Operators can raise this via AGENTIS_SKILL_DOCKER_POOL_SIZE.
  SKILL_DOCKER_WARM_LATENCY_TARGET_MS: 200,
  // Rationale: Warm container reuse should bring skill dispatch latency below 200 ms, matching
  // the perceived responsiveness of node_worker skills.
  SKILL_DOCKER_COLD_START_TIMEOUT_MS: 10_000,
  // Rationale: Cold container start (image already pulled) takes 1–3 s on most machines.
  // 10 s is a safe ceiling before the skill execution itself begins.

  // Conversation layer
  CONVERSATION_MESSAGE_MAX_LENGTH: 32_000,
  // Rationale: Mirrors OpenClaw's effective context window floor; prevents accidental context floods.
  CONVERSATION_HISTORY_PAGE_SIZE: 50,
  CONVERSATION_AGENT_RESPONSE_TIMEOUT_MS: 120_000,
  // Rationale: Conversational replies are expected faster than workflow tasks; 2 min is a
  // generous ceiling before the UI shows a timeout nudge.

  // OpenClaw session continuity
  CONVERSATION_SESSION_STALE_AFTER_MS: 30_000,
  // Rationale: If no mirrored Gateway event arrives for 30 s while a session is open, show a
  // stale state and prompt the operator to inspect gateway health before sending more input.
  CONVERSATION_SYNC_BATCH_SIZE: 100,
  // Rationale: Session backfill hydrates recent context in bounded chunks so reconnects stay fast.

  // Auth
  BCRYPT_COST: 12,
  PASSWORD_MIN_LENGTH: 12,
  PASSWORD_MAX_LENGTH: 128,
  JWT_ACCESS_TOKEN_EXPIRY_SECONDS: 86_400,
  JWT_REFRESH_TOKEN_EXPIRY_SECONDS: 2_592_000,

  // Living UI
  PRESENCE_EVENT_TTL_MS: 5_000,
  PRESENCE_EVENT_THROTTLE_MS: 50,
  PRESENCE_BATCH_WINDOW_MS: 16,
  PRESENCE_MAX_AGENTS_VISIBLE: 8,
  FLIP_ANIMATION_DURATION_MS: 350,
  TYPEWRITER_CHAR_DELAY_MS: 28,
  LIVE_ACTIVITY_MAX_ENTRIES: 7,
  AGENT_COLOR_PALETTE: [
    '#6366f1',
    '#f59e0b',
    '#10b981',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#f97316',
    '#84cc16',
  ] as const,
} as const;
```

---

## Section 5 - Data Model

### 5.1 Core Tables

```typescript
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 120 }).notNull(),
  defaultAmbientId: uuid('default_ambient_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ambients = pgTable('ambients', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  kind: text('kind').notNull().default('local'),
  // local | dev | staging | prod | fleet | custom
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const openclawGateways = pgTable('openclaw_gateways', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  gatewayUrl: text('gateway_url').notNull(),
  deviceTokenCredentialId: uuid('device_token_credential_id'),
  // references credentials.id; kept nullable until pairing completes
  status: text('status').notNull().default('disconnected'),
  // connected | degraded | disconnected | error
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  healthSnapshot: jsonb('health_snapshot').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hubEntryId: text('registry_entry_id'),
  hubVersion: text('registry_version'),
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary'),
  graph: jsonb('graph').notNull(),              // WorkflowGraph
  settings: jsonb('settings').notNull().default({}),
  isPublishedToHub: boolean('is_from_registry').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('CREATED'),
  // CREATED | PLANNING | RUNNING | WAITING | COMPLETED | FAILED | CANCELLED
  runState: jsonb('run_state').notNull(),        // Serializable WorkflowRunState
  replanCount: integer('replan_count').notNull().default(0),
  triggerId: uuid('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRunSnapshots = pgTable('workflow_run_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull(),
  runState: jsonb('run_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  nodeId: text('node_id').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  executorType: text('executor_type').notNull(), // agent | skill | subflow | router
  executorRef: text('executor_ref').notNull(),   // agentId, skillId, workflowId, or router id
  capabilityTags: text('capability_tags').array().notNull().default([]),
  status: text('status').notNull().default('PENDING'),
  inputData: jsonb('input_data').notNull().default({}),
  outputData: jsonb('output_data'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activityEvents = pgTable('activity_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  actorType: text('actor_type').notNull(),
  // user | agent | gateway | system | hub
  actorId: text('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  gatewayId: uuid('gateway_id').references(() => openclawGateways.id, { onDelete: 'set null' }),
  source: text('source').notNull(),
  // checkpoint | openclaw_exec | package_install | credential_access
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary').notNull(),
  confidence: integer('confidence'),
  status: text('status').notNull().default('pending'),
  // pending | approved | rejected | expired | cancelled
  resolutionReason: text('resolution_reason'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### 5.2 Skill registry and Package Tables

```typescript
export const hubConnections = pgTable('registry_connections_removed', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hubUserId: text('hub_user_id').notNull(),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
});

export const installedRegistryArtifacts = pgTable('installed_registry_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull(),
  entryType: text('entry_type').notNull(), // workflow | skill | agent_package | template
  version: text('version').notNull(),
  sha256: text('sha256').notNull(),
  localResourceId: uuid('local_resource_id').notNull(),
  permissionsAcknowledgedAt: timestamp('permissions_acknowledged_at', { withTimezone: true }).notNull(),
  // Required: operator must explicitly acknowledge the permission summary before install completes.
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentPackages = pgTable('agent_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hubEntryId: text('registry_entry_id'),
  name: varchar('name', { length: 100 }).notNull(),
  version: varchar('version', { length: 40 }).notNull(),
  manifest: jsonb('manifest').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### 5.3 Agent, Skill, Credential, Ledger Tables

The implementation keeps tables for `agents`, `skills`, `skill_executions`, `ledger_events`, `triggers`, `webhook_deliveries`, and `users`, with these V1 requirements:

- `agents.workspace_id`, `skills.workspace_id`, `credentials.workspace_id`, `triggers.workspace_id`, and `ledger_events.workspace_id` are required.
- `agents.ambient_id`, `skills.ambient_id`, `triggers.ambient_id`, and `ledger_events.ambient_id` are optional but preserved when known.
- `agents.gateway_id` optional foreign key to `openclaw_gateways`; OpenClaw agents are grouped by gateway in the Agent Fleet surface.
- `agents.package_id` optional foreign key to `agent_packages`.
- `skills.package_id` optional foreign key to `agent_packages`.
- `skills.runtime` supports `builtin`, `node_worker`, and `docker_sandbox` in V1. Skill registry-installed skills are always assigned `docker_sandbox` by the install flow; operators cannot downgrade this.
- `ledger_events.run_id` is required; Ledger events are scoped to a Workflow Run, not only a Workflow definition.
- `credentials` table stores encrypted credentials separately from agent/skill configs.
- `approval_requests` are created from both workflow checkpoint nodes and OpenClaw `exec.approval.requested` events.
- `activity_events` are written for user actions, agent events, gateway lifecycle, workflow runs, approvals, package installs, and Skill registry sync.

```typescript
export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  credentialType: text('credential_type').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

---

## Section 6 - Workflow Engine

### 6.1 Engine Principle

The Agentis Workflow Engine is a first-class execution engine. It is not "a BullMQ worker that reads JSON."

BullMQ is used for durability, delayed wake-ups, retries, and horizontal worker claims. The engine owns:

- run-state transitions
- deterministic ready queue behavior
- multi-input buffering
- branch concurrency
- adapter dispatch
- skill execution
- dynamic graph patches
- partial replay
- checkpoint pause/resume
- recovery from Ledger + snapshots

### 6.2 Workflow Graph

```typescript
export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export type WorkflowNodeType =
  | 'trigger'
  | 'agent_task'
  | 'skill_task'
  | 'router'
  | 'merge'
  | 'checkpoint'
  | 'subflow'
  | 'scratchpad';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  condition?: string;
}

export type WorkflowNodeConfig =
  | TriggerNodeConfig
  | AgentTaskNodeConfig
  | SkillTaskNodeConfig
  | RouterNodeConfig
  | MergeNodeConfig
  | CheckpointNodeConfig
  | SubflowNodeConfig
  | ScratchpadNodeConfig;

export interface TriggerNodeConfig {
  kind: 'trigger';
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  triggerId?: string;
}

export interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentId?: string;
  agentPackageRef?: string;
  capabilityTags: string[];
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];
}

export interface SkillTaskNodeConfig {
  kind: 'skill_task';
  skillId: string;
  inputMapping: Record<string, string>; // input field -> scratchpad key or upstream output path
  outputMapping: Record<string, string>; // output field -> scratchpad key
}

export interface RouterNodeConfig {
  kind: 'router';
  routingMode: 'first_match' | 'all_matching' | 'llm_route';
  branches: Array<{ branchId: string; label: string; condition: string }>;
}

export interface MergeNodeConfig {
  kind: 'merge';
  requiredInputs: 'all' | 'any' | string[];
}

export interface CheckpointNodeConfig {
  kind: 'checkpoint';
  approvalMode: 'manual' | 'auto_after_timeout';
  timeoutMs?: number;
}

export interface SubflowNodeConfig {
  kind: 'subflow';
  workflowId: string;
  inputMapping: Record<string, string>; // subflow input -> current workflow value path
  outputMapping: Record<string, string>; // subflow output -> current workflow scratchpad key
}

export interface ScratchpadNodeConfig {
  kind: 'scratchpad';
  operation: 'read' | 'write' | 'append' | 'delete';
  key: string;
  valuePath?: string;
}
```

### 6.3 Workflow Run State

```typescript
export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: 'CREATED' | 'PLANNING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readyQueue: ReadyQueueItem[];
  waitingInputs: Record<string, WaitingInputBuffer>;
  nodeStates: Record<string, WorkflowNodeState>;
  activeExecutions: Record<string, ActiveExecution>;
  completedNodeIds: string[];
  failedNodeIds: string[];
  skippedNodeIds: string[];
  graphRevision: number;
  replanCount: number;
  lastLedgerSequence: number;
}

export interface ReadyQueueItem {
  nodeId: string;
  priority: number;
  insertedAt: string;
  inputData: Record<string, unknown>;
}

export interface WaitingInputBuffer {
  requiredInputs: string[];
  receivedInputs: Record<string, unknown>;
  sourceNodeIds: string[];
}

export interface WorkflowNodeState {
  nodeId: string;
  status: 'PENDING' | 'WAITING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  startedAt?: string;
  completedAt?: string;
  inputData?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  error?: string;
}

export interface ActiveExecution {
  taskId: string;
  nodeId: string;
  executorType: 'agent' | 'skill' | 'subflow' | 'router';
  executorRef: string;
  startedAt: string;
  heartbeatAt?: string;
}
```

### 6.4 Execution Loop

```text
load WorkflowRunState
recover from latest snapshot + ledger tail if needed

while run is RUNNING:
  claim ready tasks according to AGENTIS_WORKFLOW_PARALLELISM
  for each ready task:
    resolve credentials
    build execution context
    dispatch to agent, skill, subflow, or router
    emit node.started

  when task completes:
    write output to node state
    append ledger event
    fan out outputs to downstream edges
    for each downstream node:
      if all required inputs present -> push to readyQueue
      else -> update waitingInputs

  every RUN_STATE_SNAPSHOT_INTERVAL_EVENTS:
    persist compact run-state snapshot
```

### 6.5 Partial Replay

V1 supports partial replay because OpenClaw users need it and the n8n quality bar demands it.

| Mode | Behavior |
|---|---|
| Replay from node | Keep upstream completed outputs, reset selected node and downstream branch |
| Replay failed branch | Reset failed nodes and dependents only |
| Replay with edited node | Increment graph revision, keep prior Ledger, start new run from dirty subgraph |
| Replay from checkpoint | Restore snapshot before checkpoint, resume from approval point |

Replay never mutates historical Ledger events. It creates a new Workflow Run linked to the source run.

### 6.6 Dynamic Graph Patches

V1 supports controlled dynamic graph updates during a run:

```typescript
export interface WorkflowGraphPatch {
  patchId: string;
  reason: 'planner_replan' | 'user_edit' | 'hub_package_update';
  baseGraphRevision: number;
  addNodes: WorkflowNode[];
  updateNodes: WorkflowNode[];
  removeNodeIds: string[];
  addEdges: WorkflowEdge[];
  removeEdgeIds: string[];
}
```

Graph patches are validated for cycles, missing nodes, credential availability, and package permissions before applying. Applied patches emit `workflow.graph_patched` and increment `graphRevision`.

---

## Section 7 - Trigger Runtime

Agentis V1 includes an n8n-equivalent trigger lifecycle layer.

### 7.1 ActiveWorkflowRegistry

```typescript
export interface ActiveWorkflowRegistry {
  activate(workflowId: string): Promise<void>;
  deactivate(workflowId: string): Promise<void>;
  reload(workflowId: string): Promise<void>;
  listActive(): Promise<ActiveWorkflow[]>;
}

export interface ActiveWorkflow {
  workflowId: string;
  triggerIds: string[];
  activatedAt: string;
  status: 'active' | 'degraded' | 'error';
  error?: string;
}
```

### 7.2 Trigger Types

| Trigger Type | V1 Support | Notes |
|---|---|---|
| Manual | Yes | Run from canvas or API |
| Cron | Yes | BullMQ repeatable jobs |
| Webhook | Yes | HMAC-SHA256, timestamp tolerance, idempotency |
| Persistent listener | Yes | Adapter-provided listener, e.g. OpenClaw event stream or HTTP long-poll |

Persistent listeners return a cleanup function and are tracked by `ActiveWorkflowRegistry`. On app restart, active workflows are rehydrated from PostgreSQL and listeners are recreated.

---

## Section 8 - Skill registry Bridge

### 8.1 V1 Skill registry Position

Skill registry is not a read-only registry in V1. Skill registry is the Nexseed-operated, free-to-use community platform for Agentis: GitHub for agents.

Skill registry is owned and operated by Nexseed, not self-hosted and not open-source. It provides the public ecosystem layer around the open-source Agentis runtime: distribution, discovery, social proof, automated trust, commerce, community review, and author identity.

**Agent Packages are the primary product of Skill registry.** An agent package is the distributable unit: a signed bundle containing agent definitions, skills, workflow templates, and a credentials schema — analogous to a GitHub repository plus package release for agent systems. Individual skills and workflow templates may also be published standalone, but packages are the hero artifact that the community builds around.

The self-hosted app must support:

- Browse and search Skill registry agent packages, workflow templates, skills, and authors.
- Install published Skill registry agent packages, workflow templates, and skills with hash verification. Skill registry V1 artifacts are free.
- Install individual skills or workflow templates from Skill registry.
- Fork a Skill registry workflow into the local canvas.
- Publish a local workflow to Skill registry.
- Publish a local agent package or skill to Skill registry.
- Sync installed package updates.
- Open Skill registry co-creation sessions from a local workflow.
- Accept Skill registry pull requests/contributions as graph patches.

Monetization is deferred beyond Skill registry V1. Public comments, social profiles, and public moderation live on Skill registry. Runtime execution remains local.

### 8.2 Skill registry Entry Contract

```typescript
export interface RegistryEntry {
  entryId: string;
  entryType: 'agent_package' | 'workflow' | 'skill' | 'workflow_template';
  slug: string;
  title: string;
  summary: string;
  version: string;
  author: {
    hubUserId: string;
    username: string;
    displayName: string;
  };
  verification: {
    automatedChecksPassed: boolean;
    verifiedBadge: boolean;
    lastScannedAt: string;
  };
  pricing: {
    // Skill registry V1 currently returns { model: 'free' }; wider pricing modes are reserved for future Skill registry versions.
    model: 'free' | 'one_time' | 'subscription';
    amountUsd?: number;
  };
  artifacts: RegistryArtifact[];
}

export interface RegistryArtifact {
  artifactType: 'workflow_graph' | 'skill_bundle' | 'agent_package' | 'workflow_template';
  sha256: string;
  downloadUrl: string;
  manifestUrl: string;
}
```

### 8.3 Skill registry Actions

```text
GET  /v1/hub/registry
GET  /v1/hub/registry/:entryId
POST /v1/hub/connect/start
POST /v1/hub/connect/callback
POST /v1/hub/install/:entryId
POST /v1/hub/fork/:entryId
POST /v1/hub/publish/workflow/:workflowId
POST /v1/hub/publish/skill/:skillId
POST /v1/hub/publish/package/:packageId
POST /v1/hub/sync
POST /v1/hub/contributions/:contributionId/apply
```

All install and contribution flows verify SHA-256 before applying local changes. Skill registry unavailability must not stop existing local workflows from running.

### 8.4 Co-Creation Model

Co-creation happens on Skill registry, but can be initiated and applied from V1.

1. User clicks **Co-create on Skill registry** from a local workflow.
2. Agentis publishes a private draft to Skill registry.
3. Collaborators edit the draft on Skill registry.
4. Skill registry returns a signed `WorkflowGraphPatch` contribution.
5. Local Agentis previews the patch in the canvas.
6. User applies or rejects the patch.

This keeps self-hosted runtime local while still giving Skill registry full community power.

---

## Section 9 - Agent Packages and Skills

### 9.1 Agent Package Manifest

```typescript
export interface AgentPackageManifest {
  manifestVersion: 1;
  name: string;
  version: string;
  summary: string;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  workflowTemplates: WorkflowTemplateDefinition[];
  credentials: CredentialRequirement[];
}

export interface WorkflowTemplateDefinition {
  name: string;
  slug: string;
  summary: string;
  graph: WorkflowGraph;
  variables: Array<{
    name: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'secret';
    required: boolean;
    defaultValue?: string | number | boolean;
  }>;
}

export interface CredentialRequirement {
  name: string;
  credentialType: string;
  requiredBy: Array<{ resourceType: 'agent' | 'skill'; resourceName: string }>;
  fields: Array<{
    name: string;
    label: string;
    secret: boolean;
    required: boolean;
  }>;
}

export interface AgentDefinition {
  name: string;
  adapterType: 'openclaw' | 'claude_code' | 'http';
  capabilityTags: string[];
  defaultConfig: Record<string, unknown>; // adapter-specific, validated by adapter schema
}

export interface SkillDefinition {
  name: string;
  slug: string;
  version: string;
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox';
  // builtin: in-process, fully trusted, Nexseed-authored only.
  // node_worker: isolated-vm V8 isolate; operator-installed local skills.
  // docker_sandbox: Docker container with resource limits and network namespace;
  //   auto-assigned to all Skill registry-installed skills; cannot be downgraded by operator.
  entrypoint: string;
  capabilityTags: string[];
  inputSchema: Record<string, unknown>;  // JSON Schema
  outputSchema: Record<string, unknown>; // JSON Schema
  timeoutMs?: number;
}
```

### 9.2 Skill Runtime

V1 enforces a three-tier skill trust model. The isolation level applied to any skill execution is determined by its trust tier, established at install time and never downgradeable by the operator at runtime.

#### Skill Trust Tiers

| Tier | `runtime` value | Who installs it | Isolation level |
|---|---|---|---|
| `builtin` | `builtin` | Nexseed ships in core | In-process — fully trusted, reviewed as part of the Agentis codebase |
| `node_worker` | `node_worker` | Operator installs from local files | `isolated-vm` V8 isolate — separate heap, no shared memory, no Node.js built-in access, domain-restricted fetch |
| `docker_sandbox` | `docker_sandbox` | Skill registry-installed packages (auto-assigned) | Docker container — read-only filesystem, capped CPU and memory, network namespace restricted to declared `allowedDomains` |

All Skill registry-installed skills are assigned `docker_sandbox` automatically by the install flow. Operators cannot downgrade a Skill registry skill to `node_worker`. Operators may upgrade a local `node_worker` skill to `docker_sandbox` manually.

#### `node_worker` — V8 Isolate Execution

`node_worker` skills execute inside an `isolated-vm` `Isolate`:

- A dedicated heap capped at `SKILL_ISOLATE_HEAP_MB` (default: 128 MB).
- No access to the host Node.js module graph — `require` and `import` are not exposed into the isolate context.
- No access to `process`, `__dirname`, `__filename`, or any environment variables.
- A `fetch` proxy that enforces the skill manifest's `allowedDomains`; requests to unlisted hostnames throw `SKILL_NETWORK_VIOLATION`.
- `crypto` limited to `randomUUID()`, `subtle.digest()`, and `subtle.generateKey()`.
- Execution is aborted with `SKILL_TIMEOUT` if it exceeds `timeoutMs` (bounded by `SKILL_EXECUTION_MAX_TIMEOUT_MS`).
- The isolate is destroyed and garbage-collected after each execution; no state persists between calls.

Isolates are pooled in `skillIsolatePool.ts` and reused across invocations of the same skill version to amortize creation cost. Pool size is controlled by `SKILL_ISOLATE_POOL_DEFAULT`.

#### `docker_sandbox` — Container Execution

`docker_sandbox` skills execute in a Docker container. Docker must be present on the host; if unavailable, Skill registry skill execution is blocked with `SKILL_DOCKER_UNAVAILABLE` and a persistent dashboard warning is shown. All non-Skill registry functionality is unaffected.

Container constraints applied to every Skill registry skill execution:

- Read-only root filesystem; a `/tmp` tmpfs is mounted with a `SKILL_DOCKER_TMP_MAX_MB` cap.
- Memory hard limit: `SKILL_DOCKER_MEMORY_MB` (default: 256 MB).
- CPU quota: `SKILL_DOCKER_CPU_QUOTA` (default: 0.5 cores).
- Network: custom Docker bridge network with egress filtered to `allowedDomains` from the skill manifest via an in-container proxy; no raw socket access outside the allowlist.
- No Docker socket mount; no `--privileged`; no host PID or network namespace.
- The skill bundle's npm dependencies are installed with `npm ci --ignore-scripts --omit=dev` at image build time; no runtime package installation.

**Container warming pool:** `skillDockerPool.ts` maintains `SKILL_DOCKER_POOL_SIZE` warm containers per installed Skill registry skill. Warm reuse targets latency below `SKILL_DOCKER_WARM_LATENCY_TARGET_MS`. A cold start (pool exhausted) is permitted and logged; it does not fail the execution. Cold start timeout is `SKILL_DOCKER_COLD_START_TIMEOUT_MS`.

#### UI Trust Communication

Before any skill install — Skill registry or local — the dashboard must display:

- The skill's trust tier and its isolation level in plain language.
- The `allowedDomains` network allowlist from the manifest.
- Each declared permission (external service access, filesystem declarations, sensitive data access).
- A prominent warning if the skill declares a wildcard network allowlist.
- For Skill registry skills: the Skill registry Trust Score, automated scan results, and verification badge.

The operator must explicitly acknowledge the permission summary before the install completes. This acknowledgment is recorded in `installed_registry_artifacts.permissionsAcknowledgedAt`. No code executes before acknowledgment is recorded.

---

## Section 10 - Adapters

```typescript
export interface AgentAdapter {
  readonly adapterType: 'openclaw' | 'claude_code' | 'http';
  connect(config: AgentAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
  dispatchTask(task: NormalizedTask): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  createPersistentListener?(trigger: TriggerConfig): Promise<TriggerListenerHandle>;
  onEvent(handler: (event: NormalizedAgentEvent) => void): void;
}

export type AgentAdapterConfig = OpenClawAdapterConfig | ClaudeCodeAdapterConfig | HttpAdapterConfig;

export interface OpenClawAdapterConfig {
  adapterType: 'openclaw';
  gatewayId: string;
  gatewayUrl: string;
  deviceTokenCredentialId: string;
  agentName: string;
}

export interface ClaudeCodeAdapterConfig {
  adapterType: 'claude_code';
  claudeBinaryPath: string;
  workingDirectory: string;
  allowedTools: string[];
  modelOverride?: string;
  maxTurns?: number;
}

export interface HttpAdapterConfig {
  adapterType: 'http';
  baseUrl: string;
  authCredentialId?: string;
  dispatchPath: string;
  cancelPath?: string;
  healthPath?: string;
  dispatchTimeoutMs: number;
}

export interface AdapterHealthStatus {
  isHealthy: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

export interface TriggerConfig {
  triggerId: string;
  workflowId: string;
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  config: Record<string, unknown>; // trigger-specific config, validated by trigger schema before use
}

export interface TriggerListenerHandle {
  triggerId: string;
  startedAt: string;
  close: () => Promise<void>;
}

export interface NormalizedTask {
  taskId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  title: string;
  description: string;
  inputData: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
  capabilityTags: string[];
  timeoutMs: number;
  callbackUrl?: string;
}

export type NormalizedAgentEvent =
  | { eventType: 'task.started'; agentId: string; taskId: string; runId: string; workflowId: string; timestamp: string }
  | { eventType: 'task.progress'; agentId: string; taskId: string; runId: string; workflowId: string; message: string; timestamp: string }
  | { eventType: 'task.completed'; agentId: string; taskId: string; runId: string; workflowId: string; output: Record<string, unknown>; timestamp: string }
  | { eventType: 'task.failed'; agentId: string; taskId: string; runId: string; workflowId: string; error: string; timestamp: string }
  | { eventType: 'agent.thinking'; agentId: string; runId: string; workflowId: string; timestamp: string }
  | { eventType: 'agent.tool_call'; agentId: string; taskId: string; runId: string; workflowId: string; tool: string; input: unknown; timestamp: string }
  | { eventType: 'agent.heartbeat'; agentId: string; timestamp: string };
```

OpenClaw, Claude Code, and HTTP adapters ship in V1. Each adapter implements health checks, dispatch, cancellation, event normalization, and circuit breaker behavior.

---

## Section 11 - REST API

Base path: `/v1`

```text
# Auth
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me

# Dashboard / Workspaces
GET    /dashboard/fleet-overview
GET    /workspaces
POST   /workspaces
GET    /workspaces/:workspaceId
PUT    /workspaces/:workspaceId
POST   /workspaces/:workspaceId/select
GET    /ambients
POST   /ambients
PUT    /ambients/:ambientId
POST   /ambients/:ambientId/select

# Workflows
POST   /workflows
GET    /workflows
GET    /workflows/:id
PUT    /workflows/:id
DELETE /workflows/:id
POST   /workflows/:id/run
POST   /workflows/:id/publish
POST   /workflows/:id/fork

# Runs
GET    /runs
GET    /workflows/:id/runs
GET    /runs/:runId
POST   /runs/:runId/cancel
POST   /runs/:runId/replay
POST   /runs/:runId/replay-from-node/:nodeId
GET    /runs/:runId/ledger
GET    /runs/:runId/scratchpad

# Activity / Approvals / Command
GET    /activity
GET    /approvals
POST   /approvals/:approvalId/resolve
GET    /command/search
POST   /command/execute

# Agents / Skills / Packages
POST   /agents
GET    /agents
GET    /agents/:agentId
GET    /agents/:agentId/activity
GET    /agents/:agentId/runs
POST   /agents/:agentId/connect
POST   /agents/:agentId/disconnect
POST   /agents/:agentId/terminal/send
GET    /skills
POST   /skills/install-local
GET    /packages
POST   /packages/install-local

# Gateways
GET    /gateways
POST   /gateways
GET    /gateways/:gatewayId
PUT    /gateways/:gatewayId
POST   /gateways/:gatewayId/connect
POST   /gateways/:gatewayId/disconnect
POST   /gateways/:gatewayId/sync
GET    /gateways/:gatewayId/agents
GET    /gateways/:gatewayId/events

# Triggers
POST   /triggers
GET    /triggers
POST   /triggers/:id/fire
POST   /webhooks/trigger/:triggerId

# Skill registry
GET    /hub/registry
POST   /hub/connect/start
POST   /hub/install/:entryId
POST   /hub/fork/:entryId
POST   /hub/publish/workflow/:workflowId
POST   /hub/sync

# Conversations
GET    /conversations
GET    /conversations/:agentId
GET    /conversations/:agentId/sessions
POST   /conversations/:agentId/send
POST   /conversations/:agentId/continue/:sessionId
DELETE /conversations/:agentId
```

All list endpoints use cursor pagination. All request bodies use Zod validation. Every route checks ownership by `user_id`.

---

## Section 12 - Real-Time Events

Transport: Socket.io over WSS.

Rooms:

| Room | Events |
|---|---|
| `user:{userId}` | Workspace selected, Skill registry sync, package updates, command index refresh |
| `workspace:{workspaceId}` | Fleet overview, global activity, approvals, gateway health, agents, runs |
| `workflow:{workflowId}` | Workflow definition edits and Skill registry patch previews |
| `run:{runId}` | Run state, node status, Ledger, Scratchpad, presence |
| `gateway:{gatewayId}` | Gateway health, OpenClaw event stream, agent heartbeat, terminal session output |
| `agent:{agentId}` | Agent status, current task, terminal stream, capability updates |
| `conversation:{agentId}` | Inbound and outbound conversation messages for the operator’s thread with that agent |

Event families:

```typescript
type RealtimeEventName =
  | 'workspace.selected'
  | 'ambient.selected'
  | 'fleet.snapshot.updated'
  | 'gateway.connected'
  | 'gateway.degraded'
  | 'gateway.disconnected'
  | 'gateway.event'
  | 'agent.created'
  | 'agent.updated'
  | 'agent.status.changed'
  | 'agent.heartbeat'
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.graph_patched'
  | 'run.created'
  | 'run.running'
  | 'run.completed'
  | 'run.failed'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.waiting_for_input'
  | 'agent.presence.focus'
  | 'agent.presence.blur'
  | 'agent.presence.thinking'
  | 'agent.terminal.message'
  | 'agent.terminal.tool_call'
  | 'activity.created'
  | 'approval.requested'
  | 'approval.resolved'
  | 'scratchpad.written'
  | 'ledger.event'
  | 'command.index.updated'
  | 'hub.sync.completed'
  | 'hub.contribution.preview'
  | 'conversation.message.received'   // agent → operator from a mirrored or Agentis-originated session
  | 'conversation.message.sent'       // operator → agent dispatched
  | 'conversation.agent.typing'       // agent is processing; used to render typing indicator
  | 'conversation.session.discovered' // Gateway session first mirrored into Agentis
  | 'conversation.session.synced'     // backfill or live session events merged into a thread
  | 'conversation.session.stale';     // Gateway disconnected or session stream stalled
```

Presence events are ephemeral and never persisted to the Ledger.

Activity events are persisted to `activity_events` and may reference Ledger events. Terminal stream events are persisted only when they are part of an agent task or explicit operator intervention; passive Gateway noise is not persisted by default.

---

## Section 13 - Frontend and Design Lock

### 13.1 Reference Image

The V1 UI must match [docs/design-inspirations/image.png](design-inspirations/image.png) as the primary visual reference.

This means:

- Dark canvas-first surface.
- App shell feels like an operating cockpit, not an admin CRUD dashboard.
- Minimal top bar with workflow title, status, zoom controls, run, share, and publish actions.
- Left vertical category rail for node groups and workspace tools.
- Floating compact node cards with icons, provider labels, handles, and status dots.
- Curved connector edges with small insertion buttons.
- Green Publish action as the dominant positive command.
- Fleet Overview is allowed as the first screen, but it must feel like a live cockpit, not a card-heavy homepage.
- No marketing hero inside the app.
- No glassmorphism, blur-heavy panels, decorative gradients, or oversized text.

### 13.2 Design Tokens

```css
--color-canvas: #08090b;
--color-surface-1: #121417;
--color-surface-2: #1a1d22;
--color-surface-3: #22262d;
--color-border: #2a2f35;
--color-border-strong: #3b424c;
--color-text-primary: #f2f4f7;
--color-text-secondary: #9aa3af;
--color-text-muted: #697281;
--color-accent: #9cffb0;
--color-success: #9cffb0;
--color-warning: #f6c85f;
--color-error: #ff6b6b;
--radius-sm: 4px;
--radius-md: 8px;
```

### 13.3 App Shell and Navigation

The first screen after login is `/home`, the Fleet Overview cockpit. Deep links may open a workflow canvas, agent detail, run, or approval directly.

Persistent app shell:

1. **Top bar**: workspace switcher, ambient selector, global gateway health, command palette button, Skill registry status, user menu.
2. **Left rail**: Home, Canvas, Agents, Gateways, Conversations, Activity, Approvals, Runs, Skill registry, Skills, Settings.
3. **Main region**: current surface, full-height, dark background, no marketing hero.
4. **Right dock**: context inspector, terminal pane, conversation thread, approval detail, run detail, or package install drawer depending on selection.
5. **Bottom live strip**: active runs, latest terminal event, pending approval count, unread conversation messages, gateway reconnect indicator.

The shell must preserve the selected workspace and ambient across reloads. Switching workspace changes all scoped surfaces. Switching ambient filters gateways, agents, workflows, runs, and activity to that operating context.

### 13.4 Fleet Overview Cockpit

Fleet Overview is not a generic dashboard summary. It is the operator's live starting surface.

Required regions:

| Region | Required Behavior |
|---|---|
| Fleet pulse header | Shows online/busy/offline/error agent counts, active workflow runs, pending approvals, unhealthy gateways, and Skill registry sync status |
| Agent constellation preview | Physics-inspired mini constellation of active agents; clicking expands to Agent Fleet or Agent Detail |
| Active runs strip | Shows currently running workflows with progress, currently active nodes, elapsed time, and jump-to-canvas action |
| Gateway health rail | One compact status card per OpenClaw Gateway with latency, last heartbeat, connected agents, reconnect action |
| Pending approvals dock | Top pending approval requests with approve/reject, source workflow/gateway, confidence, and jump-to-context |
| Recent activity stream | Cross-surface activity events grouped by time; click opens entity detail |
| Quick launch | New workflow, install package, connect gateway, message agent, open command palette |

The Fleet Overview refreshes from `/v1/dashboard/fleet-overview` and receives `fleet.snapshot.updated`, `activity.created`, `approval.requested`, `gateway.*`, and `agent.status.changed` events.

### 13.5 Workflow Canvas and Node Harness

The workflow canvas remains the signature surface and follows [docs/design-inspirations/image.png](design-inspirations/image.png) closely.

Main canvas regions:

1. **Top bar**: back button, workflow title, dirty/saved state, ambient badge, zoom, run, replay, share, publish.
2. **Left node rail**: triggers, OpenClaw agents, Skill registry packages, skills, routers, data, checkpoints, subflows, scratchpad.
3. **Canvas**: React Flow graph, full viewport, dark background, compact cards, curved connector edges, inline insert buttons.
4. **Context inspector**: node config, credentials, input/output mapping, gateway binding, capability tags, run state.
5. **Run drawer**: Ledger, Scratchpad, live activity, terminal events, pending approvals, replay controls.

Required node experience:

| Node Type | Visual Contract |
|---|---|
| OpenClaw agent task | Agent avatar/color, gateway badge, capability tags, live status dot, current tool call preview |
| Skill task | Skill icon, package/source badge, input/output schema summary, health ring |
| Router | Branch labels, condition summary, selected path highlight during run |
| Merge | Waiting input counters and completed branch chips |
| Checkpoint | Approval status, confidence, timeout countdown, inbox jump action |
| Scratchpad | Key/value operation, live write pulse, affected keys |
| Subflow | Nested workflow name, current sub-run status, drill-in action |

Presence overlays use direct DOM mutations via `requestAnimationFrame`; React state is not used for 20Hz overlay position updates. Node movement and run-state changes use Motion One FLIP animations.

### 13.6 Agent Fleet and Agent Detail

Agent Fleet is the operator's map of living agents, not a CRUD list.

Required Agent Fleet modes:

| Mode | Required Behavior |
|---|---|
| Table | Sort/filter by status, gateway, ambient, model, capability, current task, heartbeat age, package source |
| Constellation | Physics-driven spatial map from R2/R3: orchestrator center, role/status coloring, activity aura, edge pulses for delegation/message traffic |
| Gateway grouped | Agents grouped under each OpenClaw Gateway with connection health and sync state |

Agent Detail must show identity, adapter config, gateway, ambient, current task, active run, heartbeat history, capability tags, installed skills, recent activity, assigned workflows, terminal stream, and disconnect/reconnect controls.

### 13.7 Gateway Management

Gateways are first-class operational objects.

Required Gateway surface:

| Capability | Behavior |
|---|---|
| Connect | Add OpenClaw Gateway URL, pair device token, store encrypted credential, select workspace/ambient |
| Health | Show connected/degraded/disconnected/error, latency, heartbeat age, protocol version, feature list |
| Agent map | Show agents discovered from each Gateway and whether they are registered locally |
| Event stream | Show Gateway `heartbeat`, `health`, `presence`, `session.message`, `session.tool`, approval, and shutdown events |
| Sync | Manual sync imports agent status and capabilities; persistent WebSocket keeps live state updated |
| Reconnect | Backoff reconnect with operator-visible state and failure reason |

Mission Control's gateway CRUD proves the need. Agentis goes further: live persistent Gateway WebSocket is the default, not a cached snapshot.

### 13.8 Activity, Approvals, and Run History

These surfaces turn the Ledger into an operator experience.

| Surface | Required Behavior |
|---|---|
| Global Activity | Timeline across all workflows, agents, gateways, approvals, Skill registry installs, and operator actions; filter by workspace, ambient, entity type, actor, status, time |
| Approval Inbox | All pending checkpoint and OpenClaw exec approvals; approve/reject with reason; confidence score; jump to canvas, run, agent, or gateway |
| Run History | Search/filter all Workflow Runs; status, duration, trigger, ambient, active agents, failed node; replay run, replay from node, inspect Ledger/Scratchpad |

Activity events are concise rows with actor, action, entity, timestamp, and context jump. Approval rows follow the R2 pattern: requesting agent, target task/workflow, confidence, proposed action, timestamp, approve/reject.

### 13.9 Command Palette

`CommandPalette.tsx` is a required V1 surface, not a placeholder.

It searches:

- Workflows, workflow nodes, runs, agents, gateways, skills, packages, Skill registry entries, approvals, activity events, settings.

It executes:

- Create workflow, run workflow, replay failed run, connect gateway, open terminal for agent, approve/reject approval, install Skill registry package, publish workflow, open settings, switch workspace, switch ambient.

Results are grouped by domain and ranked by recent use, exact match, active status, and current workspace relevance. Commands that mutate state require confirmation unless they are local navigation.

### 13.10 Workspaces and Ambients

V1 supports multiple local workspaces for a single authenticated operator.

| Concept | V1 Behavior |
|---|---|
| Workspace | Top-level operating boundary for workflows, agents, credentials, gateways, Skill registry installs, runs, activity, approvals |
| Ambient | Saved operating context inside a workspace: Local, Dev, Staging, Prod, Fleet, or Custom |
| Switcher | Top bar control; switching updates every scoped surface without full reload when possible |
| Default seed | First startup creates `Personal` workspace and `Local OpenClaw` ambient |

V1 does not include team membership or shared workspace collaboration. That is V2. But V1 must not be a flat single-bucket app; serious OpenClaw users need to separate local experiments from production fleets.

### 13.11 Terminal Pane

Terminal Pane renders OpenClaw Gateway session events as an operator-grade stream:

- `session.message` as assistant text rows.
- `session.tool` as collapsible tool call/result rows.
- `agent` events as turn summaries.
- Approval prompts as inline action rows.
- Operator input sends `agent` RPC calls through the selected Gateway with idempotency keys.

Terminal Pane can open from Agent Detail, Run Drawer, Gateway Event Stream, or Command Palette. It is secondary to the canvas, but essential for direct intervention.

### 13.12 Conversation Panel

Conversation Panel is the natural-language continuity layer for the operator's agent fleet. It is available from the left rail (Conversations) and as a collapsible right-dock panel from any surface.

**Structure:**

The Conversations page shows a left list of all registered agents with unread badge counts and active session indicators. Selecting an agent opens its thread — a chronological message stream between the operator and that agent, styled like a messaging app (compact bubbles, timestamps, status ticks). If multiple OpenClaw sessions exist for one agent, the thread includes a session switcher and source badges so the operator can continue the correct live context.

**Message routing:**

If a session already exists in OpenClaw, Agentis attaches to that Gateway-backed session and continues it in place. Outbound messages (operator → agent) are dispatched through the agent's registered Gateway against the mirrored session when available; starting from Agentis creates or resumes a Gateway session, never a parallel silo. The agent's response arrives via `conversation.message.received` and session sync events, then appends to the same thread with a typing indicator while the agent is processing.

**Persistence:**

All conversation messages are stored in `conversation_messages` (see §5 data model note). Mirrored session metadata is stored with the thread so Agentis can reconnect to the same OpenClaw context after a reload or Gateway restart. Threads are scoped to workspace; history persists across app restarts.

**Approval integration:**

When a pending approval exists for an agent, it renders as a non-dismissible inline card inside the conversation thread with Approve and Reject buttons. Resolving from the conversation also resolves it in the Approval Inbox.

**Canvas linkage:**

If an agent message references a workflow run (e.g., "I just completed the summarization step in run X"), Agentis renders a compact run card with a jump-to-canvas action.

**UX requirements:**

- Message input supports multi-line with `Shift+Enter`; `Enter` sends.
- Typing indicator shows while agent is processing (`conversation.agent.typing` event).
- Unread badge on left-rail Conversations icon; per-agent badge in the thread list.
- All conversation messages are searchable from the Command Palette.
- Mirrored sessions show source badges, session IDs, and a stale/reconnecting banner when Gateway sync is interrupted.
- The operator can continue an imported OpenClaw session from Agentis without copying context into a new thread.

### 13.13 OpenClaw Session Continuity

V1 must integrate existing OpenClaw work rather than create a separate communication lane.

Required continuity behavior:

| Capability | Behavior |
|---|---|
| Session discovery | On Gateway connect or sync, Agentis discovers active and recent OpenClaw sessions and binds them to the correct agent, workspace, and ambient when possible. |
| Live mirror | `session.message`, `session.tool`, approvals, and related activity stream into the Conversation Panel, Terminal Pane, Activity Feed, and Agent Detail in near real time. |
| Continue in place | If work started outside Agentis, the operator can open that mirrored session in Agentis and keep talking in the same context instead of starting over. |
| Read-only fallback | If the Gateway disconnects, mirrored sessions remain visible with stale status and jump-to-gateway repair actions, but sending new input is disabled until reconnect succeeds. |
| Context linkage | Mirrored sessions link to workflows, runs, approvals, gateways, and recent agent activity so conversation is always attached to operations context. |

The continuity rule is simple: Agentis must never require the operator to abandon or duplicate an existing OpenClaw interaction surface to get value. New conversation UI is additive only when it stays bound to the same underlying Gateway session.

---

## Section 14 - Security

- Local auth: username/password, bcrypt cost 12.
- JWT RS256 access tokens; sessions backed by Redis in standard mode, encrypted SQLite in embedded mode.
- AES-256-GCM encrypted credentials and Skill registry tokens.
- Timing-safe HMAC validation for webhooks and HTTP adapter callbacks.
- SHA-256 verification for Skill registry artifacts before install.
- Package install permission screen for domains, env vars, filesystem access, and skill runtime.
- Drizzle parameterized queries only.
- No `eval()` in condition evaluation.
- RLS enabled as defense in depth.
- OpenClaw session continuity: mirrored sessions and operator replies are accepted only from owned Gateway connections and workspace-scoped agents. When a Gateway disconnects, mirrored sessions become read-only until trust in the session stream is re-established.

---

## Section 15 - Testing and Release Gates

Required before V1 release:

1. One-command start: `npx agentis@latest up` works on a clean machine with Docker installed.
2. Workspace seed test: first startup creates `Personal` workspace and `Local OpenClaw` ambient; switching workspace/ambient scopes visible data.
3. Fleet Overview visual test: Playwright screenshot confirms live cockpit layout at desktop and mobile widths: fleet pulse, constellation preview, active runs, gateway rail, approvals, recent activity.
4. Canvas visual test: Playwright screenshot matches [docs/design-inspirations/image.png](design-inspirations/image.png) layout contract at desktop width.
5. Agent Fleet test: register mock agents across multiple gateways; table, constellation, gateway-grouped modes all reflect status, heartbeat, current task, and gateway mapping.
6. Gateway test: connect two mock OpenClaw Gateways, stream heartbeat/session/tool/approval events, disconnect one, verify reconnect/backoff and UI health state.
7. Activity feed test: workflow run, gateway event, approval request, package install, and operator action all create `activity_events` and appear in Global Activity with filters.
8. Approval inbox test: checkpoint approval and OpenClaw `exec.approval.requested` both create `approval_requests`; approve/reject updates run/gateway state and activity feed.
9. Conversation continuity test: mirror an existing OpenClaw session into Agentis, continue it from the dashboard, and verify approvals, terminal events, and run links stay synchronized across Conversations, Terminal Pane, and Activity.
10. Command palette test: search workflows, agents, runs, gateways, approvals, skills, Skill registry packages; execute navigation and guarded mutation commands.
11. Run History test: filter all runs across workflows, inspect Ledger/Scratchpad, replay from failed node without rerunning completed upstream nodes.
12. Workflow run test: trigger -> ready queue -> waiting input -> concurrent branches -> merge -> completion.
13. Persistent listener test: activate workflow, restart app, listener rehydrates.
14. Skill registry install test: install workflow, agent package, and skill with SHA-256 verification.
15. Skill registry publish test: local workflow publishes to Skill registry draft and receives entry ID.
16. Skill registry unavailable test: local workflows continue running while Skill registry returns 503.
17. Self-hosted scale test: configure `AGENTIS_WORKFLOW_PARALLELISM=unbounded`, register many mock agents across multiple gateways, verify engine dispatches beyond local-dev defaults.
18. Security test: invalid webhook signatures, expired timestamps, artifact hash mismatch, cross-workspace access, unauthorized approval resolution, and cross-gateway session spoofing all fail closed.

---

## Appendix A - Architecture Self-Check

Ask this before implementation is accepted:

| Question | Required Answer |
|---|---|
| Is this the best architecture for open-source users? | Yes: embedded mode requires only Node.js — SQLite + in-process event bus, zero external dependencies. Standard mode (PostgreSQL + Redis) is opt-in for production scale. |
| Can users start in one step with no Docker? | Yes: `npx agentis@latest up` starts in embedded mode in under 30 seconds on a clean machine. |
| Can operators continue existing OpenClaw sessions inside Agentis? | Yes: Agentis mirrors Gateway sessions, preserves session context, and lets the operator continue the same thread from Conversations or Terminal Pane. |
| Is there a conversational interface in the dashboard? | Yes: Conversation Panel in the left rail with mirrored per-agent threads, typing indicators, unread badges, approval inline cards, and canvas jump links. |
| Is Agentis the most capable OpenClaw dashboard? | Yes: living canvas, presence overlays, workflow execution, Skill registry ecosystem, conversation continuity, and deep Gateway integration — no existing dashboard comes close. |
| Does V1 include the full dashboard experience? | Yes: Fleet Overview, Agent Fleet, Gateways, Activity, Approvals, Run History, Command Palette, Workspaces/Ambients, Terminal, Canvas, and Conversations. |
| Are workspaces and ambients real in V1? | Yes: they scope workflows, agents, credentials, gateways, runs, approvals, activity, Skill registry installs, and conversation threads for one local operator. |
| Are OpenClaw gateways first-class? | Yes: multiple gateways, pairing, health, reconnect, event stream, and agent mapping are V1 requirements. |
| Is V1 built for agent architectures, not API automation? | Yes: agents, skills, Scratchpad, Ledger, presence, agent packages, dynamic graph patches. OpenClaw is first-class. |
| Are self-hosted users limited? | No: only warnings and defaults; operators control parallelism and scale. |
| Is the UI design locked? | Yes: match `docs/design-inspirations/image.png`. |
| Is Skill registry powerful in V1? | Yes: install, fork, publish, sync, co-create, and apply contributions. |
| Does the canvas feel alive? | Yes: presence overlays at 20Hz, FLIP animations, typewriter progress, design-locked to dark canvas aesthetic. |

## Appendix B - V2 Enables

V1 is designed so V2 can add ELO routing, full Memory OS, richer Skill registry monetization, multi-user workspace collaboration, advanced channel notification rules (conditional templates, WhatsApp/Slack connectors, event-filter expressions), and hosted Agentis Cloud without replacing the engine or the dashboard surface model.