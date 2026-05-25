# Agentis Workflow Engine -- 10x Masterplan
## The Definitive Agentic Execution Platform for the Enterprise

*This document supersedes all previous workflow planning documents. Append-only
implementation log at the bottom. Last substantive edit: 2026-05-22.*

---

## SS0 -- Accurate Ground Truth (2026-05-22)

> **Read this section before any other.** The planning sections below were written
> against an incomplete picture of the codebase. This section records what is
> *actually* built as of today, verified by direct code audit.

### What the engine already has

`WorkflowEngine` (`apps/api/src/engine/WorkflowEngine.ts`, ~2 600 lines) is a
complete, production-grade workflow runtime. Every claim below is verified against
code.

**All node kinds -- implemented and dispatched:**

| Node | Status | Notes |
|------|--------|-------|
| `trigger` | done | manual, schedule, webhook |
| `router` | done | first_match / all_matching / llm_route |
| `merge` | done | any-completes / all-complete / N-of-M |
| `transform` | done | sandboxed `vm.Script`, frozen context |
| `filter` | done | sandboxed boolean expression, true/false handles |
| `wait` | done | duration, until-datetime, webhook -- crash-recoverable |
| `loop` | done | chunked concurrency via `SubflowExecutor` |
| `parallel` | done | fan-out; waits for all (or configurable minimum) |
| `http_request` | done | retry/backoff, auth, SSRF guard via `safeUrl.ts` |
| `integration` | done | `ConnectorRegistry` + `CredentialVault` decryption |
| `subflow` | done | nested workflow execution |
| `scratchpad` | done | in-run KV reads/writes |
| `workflow_store` | done | cross-run workflow-scoped KV (Tier 2 state) |
| `agent_task` | done | workspace-context injection, self-heal retry |
| `skill_task` | done | sandboxed code-skill execution |
| `agent_swarm` | done | parallel fan-out, pool saturation, collect_all / first_success / majority_vote |
| `evaluator` | done | LLM-as-judge with retry_upstream + critique injection |
| `guardrails` | done | rule enforcement gate |
| `knowledge` | done | dynamic / contextual retrieval |
| `artifact_collect` | done | collects upstream artifact refs |
| `artifact_save` | done | persists value to `artifacts` store |
| `return_output` | done | `renderAs: html/markdown/table/json/text` |
| `browser` | done | Playwright/Chromium: serve_html, screenshot, pdf, navigate, extract_text |
| `checkpoint` | done | human approval gate |

**Services wired at bootstrap:**

`WorkflowEngine`, `WorkspaceIntelligenceService` (WORKSPACE/MEMORY/DECISIONS
injection), `BrowserPool` (Playwright/Chromium on-demand install),
`WorkspaceVolumeService`, `WorkflowStoreService`, `ConnectorRegistry`
(Slack / Gmail / GitHub / Sheets / HTTP), `CredentialVault`, `EvaluatorRuntime`
(optional -- requires env vars), `SubflowExecutor`, `LedgerService`,
`ScratchpadService`, `ActivityFeedService`, `ApprovalInboxService`,
`SchedulerService`, `ChannelBridge` (Telegram / Discord),
`SpecialistAgentService`, `AdapterManager`.

**Engine features beyond node dispatch:**

- Error edge routing (`edge.type = 'error'` fires catch branch instead of failing run)
- Live graph patching (`applyGraphPatch`) -- mid-run graph mutation
- Run recovery after restart (`recoverInterruptedRuns`) -- wait nodes resume;
  other in-flight nodes fail loud with a clear error
- Output contract validation on `COMPLETED` transition
- Variable interpolation (`templateResolver.ts`) -- every string field in every
  node config is template-resolved before dispatch
- Cost ledger events after every node completion
- Node test runner (`testNode`) -- isolated single-node execution without a full run
- Agent swarm with pool-size saturation guard

**Canvas (web):**

`WorkflowCanvas`, `ContextInspector`, `NodePalette`, `RunDrawer`, `VariablePicker`,
`PhaseLayer`, `NodeTestRunner`, `AgentisEdge`, `SkillCombobox`, `TemplatedTextField`,
`WorkflowContractsPanel`, `NodeCommandPalette`, `NodePeekPortal`, `EventChainsPanel`.

**`SpecialistAgentService`:** Fully implemented. Seeds built-in specialist agents as
DB rows (idempotent). `ensureRole(workspaceId, userId, role)` creates on first use.
`resolveRole` looks up without creating. `ensureAll` seeds the full library.

### The real gaps (what is actually missing)

**Gap 1 -- `agentRole` dispatch -- RESOLVED (2026-05-22).**
`#dispatchAgentTask()` now resolves `config.agentRole` via
`specialists.ensureRole(workspaceId, userId, role)` when no explicit `agentId` is
bound, and prepends the role's system prompt ahead of the workspace-context block
(role identity -> context -> task). `build_workflow` emits `agentRole` on generated
agent tasks. `validateGraph` treats `agentRole` as satisfying the binding check. The
specialist system is now end-to-end. *(Open follow-up: specialists seed `status:
'offline'`; execution still requires a connected adapter/runtime, same as any agent.)*

**Gap 2 -- `buildWorkflowDraft()` regex fallback is weak -- PARTIALLY RESOLVED (2026-05-22).**
LLM synthesis is no longer hard-gated to the evaluator: a dedicated
`WORKFLOW_SYNTHESIS_MODEL` / `_BASE_URL` / `_API_KEY` runtime is used when set, falling
back to the evaluator runtime, and only then to regex. *Still todo:* the intent-extraction
and template-matching stages (§6.1 Steps 2-3), which lift complex success rate toward the
~85% target without requiring an LLM call for common patterns.

**Gap 3 -- Skill `.md` protocol system doesn't exist.**
`SkillRuntime` handles sandboxed code-execution skills. Behavioral markdown
protocols (SS2.5) -- the `skills/` Volume directory, frontmatter parsing, skill
injection at agent dispatch -- are not built.

**Gap 4 -- Agent `.md` filesystem doesn't exist.**
`SpecialistAgentService` seeds specialists as DB rows. The `agents/platform/`,
`agents/custom/`, `agents/community/` Volume directory structure (Principle #11)
is aspirational. Specialists live in the database, not on the filesystem.

**Gap 5 -- `WorkflowPhase` is cosmetic only.**
The type is `{id, name, color, nodeIds, collapsed}` -- a canvas grouping.
No SLA, no `humanGate`, no `budgetCents`. The entire Layer 5 enterprise execution
model (phases as execution primitives, SLA tracking, budget governance) is unbuilt.

**Gap 6 -- Output viewers are thin.**
`LiveHTMLRenderer` (iframe + device mode) and basic `RunOutputCard` (`renderAs`
dispatch) exist. The full `VIEWER_REGISTRY` -- `DataTableViewer`, `CodebaseViewer`,
`WebsitePreview`, `DashboardViewer`, `PDFViewer`, `ImageViewer`, `VideoPlayer`,
`AudioPlayer`, `DeploymentCard`, `APIExplorer` -- is not built.

**Gap 7 -- Instinct engine -- RESOLVED V1 (2026-05-22).**
`InstinctEngine.onRunFailed()` does post-run pattern analysis (root-cause classification
+ repeat-failure counting across recent runs), writes a confidence-scored entry to
MEMORY.md, and emits `INSTINCT_PROPOSED`. V1 proposes; auto-patch via `applyGraphPatch`
is the remaining follow-up.

**Gap 8 -- Workspace-scoped KV (Tier 3) -- RESOLVED (2026-05-22).**
`workspace_kv` table + `WorkspaceStoreService` + `workspace_store` node +
`{{workspace.kv.*}}` interpolation. Cross-workflow shared state now works.

**Gap 9 -- `browser: fill_form` + `extract_table` -- RESOLVED (2026-05-22).**
All seven browser operations are now implemented (serve_html, screenshot, pdf, navigate,
extract_text, fill_form, extract_table). `serve_project` remains (needs live ServingSession).

**Gap 10 -- No integration setup wizard in chat.**
Missing-credential detection and guided credential setup flow are not built.

### Where we actually are in the phase plan

| Phase | Status |
|-------|--------|
| Phase 1 -- Close the Hello World Gap | COMPLETE (2026-05-22) |
| Phase 2 -- Node Library | ~90% complete -- see updated table in SS7 |
| Phase 3 -- Intelligence Layer | Partial -- workspace intelligence + specialist library + agentRole dispatch done; planner/skills/agent-md/marketplace todo |
| Phase 4 -- Enterprise Execution | Partial -- Tier 2 + Tier 3 KV, audit trail, phase SLA + budget governance done; phase human-gates / long-running snapshots / YAML todo |
| Phase 5 -- Universal Output Surface | Partial -- HTML/Markdown/DataTable/Image/PDF/Code viewers + artifact grid + artifact_save done; Codebase/Dashboard/Video/Audio viewers + serve_project/WebsitePreview + gallery actions todo |
| Phase 6 -- Self-Improvement & MCP | Partial -- instinct engine V1 (proposal) done; analytics dashboard / cost surface / MCP / git-sync todo |

---

## North Star -- The Semi-Deterministic Engine for the Agentic Era

> This is the organizing thesis. Every layer below is in service of it. If a
> proposed feature does not strengthen this thesis, it does not belong in the plan.

The agentic market has split into two camps, and both are wrong on their own:

- **Pure determinism** (n8n, Zapier, Make). Every node is a pure function. Safe,
  reproducible, auditable -- and unable to reason. You cannot say "summarize what
  changed and decide who to notify." You wire it by hand, forever.
- **Pure non-determinism** (OpenAI Operator, Devin, raw computer-use agents). One
  model with a keyboard. It can reason about anything -- and a company cannot run its
  quarterly close on "an AI that browses the web and does things." No phase gate, no
  budget ceiling, no approval protocol, no replay, no audit. Power without a harness.

**Agentis is the synthesis: a semi-deterministic execution fabric where reasoning is
bounded by deterministic scaffolding.** Non-determinism is not removed -- it is the
source of the platform's power -- it is *contained*. Every reasoning step (`agent_task`,
`agent_swarm`, `llm_route`) runs inside a cage built from deterministic parts:

```
        NON-DETERMINISM (reasoning)              DETERMINISTIC CAGE (governance)
        ---------------------------              -------------------------------
        agent_task / agent_swarm        wrapped  evaluator gate   (quality bound)
        llm_route classification          by     guardrails       (policy bound)
        Planner HTN decomposition                budget / SLA     (cost + time bound)
                                                 error edges      (failure bound)
                                                 phases + gates   (structure bound)
                                                 audit + replay   (accountability)
        EVERYTHING ELSE -> deterministic nodes (transform/filter/http/loop/...)
```

This reframes features the rest of the doc treats as separate. They are not separate.
The evaluator-retry loop, guardrails, per-phase budgets, SLA tracking, error edges,
the audit trail, and the "deterministic-first" rule are **one mechanism**: the
apparatus that makes machine reasoning safe enough to run a company sector unattended.

**Three consequences that become first-class capabilities:**

1. **Determinism dial (autonomy as a function of proof).** Autonomy is earned, not
   granted. A path made of deterministic nodes runs fully unattended. A novel
   reasoning step runs behind a human gate. As the Instinct Engine accumulates
   evidence that a pattern is reliable (confidence rising in MEMORY.md), the platform
   *promotes* it -- fewer gates, more autonomy. Approval modes (all / risky / none),
   evaluator thresholds, and instinct confidence are the same dial at different
   resolutions. **The longer it runs, the more deterministic -- and the more
   autonomous -- it becomes.**

2. **Reasoning budget = bounded non-determinism.** A budget is not only cost control;
   it is a hard cap on how much the system is permitted to *think* before it must
   either finish or ask. Per-node / per-phase / per-workflow / per-day ceilings make
   non-determinism financially and temporally finite -- the precondition for trusting
   it on production systems.

3. **Deterministic replay.** Because deterministic nodes are pure and their outputs
   are recorded, a run is partially reproducible: re-execute from any node, replaying
   the deterministic prefix and re-running only the reasoning steps. (`partialReplay`
   + run snapshots already exist; this elevates them to a headline capability.)
   Reproducibility in an agentic world is itself a moat.

**The bet:** the winner of the agentic era is not the smartest model or the prettiest
flowchart. It is the **execution fabric that lets a company hand reasoning to machines
without handing over control.** Semi-determinism is that fabric. This document is the
plan to build it.

---

## Layer 1 -- The Workspace Intelligence Layer

### 1.1 The Agent Identity Protocol

Every agent in Agentis has an identity: a name, a purpose, a set of capabilities,
a preferred model, and a system prompt. Agent identity is defined in a markdown file
in the workspace Volume -- human-readable, AI-writable, git-versionable.

```
agents/
  platform/   <- Shipped with Agentis (read-only)
    planner.md
    researcher.md
    coder.md
    writer.md
    analyst.md
    reviewer.md
    ops.md
  custom/     <- Operator-created agents
    cro-analyst.md
    onboarding-specialist.md
  community/  <- Installed from marketplace
    sales-outreach-agent/1.2.0/agent.md
```

An agent file is a markdown document with a YAML frontmatter block:

```markdown
---
name: Senior TypeScript Engineer
role: coder
model: claude-opus-4-5
tools: [read_file, write_file, run_code, search_web]
skills: [tdd-protocol, owasp-checklist]
capabilityTags: [coding, typescript, testing]
colorHex: "#3B82F6"
---

You are a senior TypeScript engineer who writes clean, tested, well-documented code.
You write failing tests before implementations. You never ship code without tests.
You review your own output for security issues before returning.
```

The database tracks what agents **did** (runs, audit entries, cost ledger). The
filesystem defines what agents **are**. This eliminates agent management UI overhead,
makes definitions human-readable and AI-writable, and gives git versioning for free.

> **Current state (2026-05-22):** Specialists exist as DB rows seeded by
> `SpecialistAgentService`. The `.md` filesystem for agent identity is aspirational
> and targeted for Phase 3.

### 1.2 Platform Agents

**Shipped today (2026-05-22) -- 10 specialist roles** defined in
`packages/core/src/types/specialist.ts` (`SPECIALIST_AGENTS` + `ROLE_TOOLS`) and
seeded as workspace DB rows by `SpecialistAgentService`. The `AgentRole` union, the
Zod enum, and the engine resolver all key off this exact set:

| Agent | Role | Default model | Tool manifest (`ROLE_TOOLS`) |
|-------|------|--------------|------------------------------|
| Planner | `planner` | gpt-4o | knowledge_search, call_workflow |
| Researcher | `researcher` | gpt-4o-mini | web_search, read_url, knowledge_search |
| Code Writer | `coder` | claude-sonnet | read_file, write_file, run_code, search_code, git_status |
| Reviewer | `reviewer` | gpt-4o | read_file, git_diff, search_code, run_code |
| Data Analyst | `analyst` | gpt-4o-mini | read_file, run_code, knowledge_search |
| Content Writer | `writer` | claude-sonnet | web_search, read_url, read_file |
| Monitor | `monitor` | gpt-4o-mini | read_url, knowledge_search, call_workflow |
| Architect | `architect` | gpt-4o | read_file, search_code, knowledge_search, git_diff |
| Debugger | `debugger` | claude-sonnet | read_file, run_code, search_code, git_diff, git_status |
| Deployer | `deployer` | gpt-4o-mini | read_file, call_workflow |

> **The agentic tool-use execution loop is now built (2026-05-23).** `AgentToolLoop`
> (`services/agentToolLoop.ts`) runs a bounded ReAct loop over the role-scoped
> `AgentToolRuntime`: each step the LLM returns one JSON decision (call a tool /
> finish), the loop executes granted tools (manifest-enforced), feeds observations
> back, and caps steps. Wired into the engine — an `agent_task` with
> `useRoleTools: true` + an `agentRole` runs in-process (no external adapter) and
> completes synchronously. Provider-agnostic: uses the existing JSON-mode endpoint
> (`EvaluatorRuntime.completeStructured`), so it needs no orchestrator
> function-calling runtime. Canvas toggle in the AgentTask inspector.

**Phase 3 expansion -- business-sector roles.** To deliver "automate any company
sector," the library expands beyond the engineering-leaning set above with:
`ops` (Slack/email/http distribution), `qa`, `designer`, `security`, and
`data_engineer`. Adding a role = one entry in `SPECIALIST_AGENTS` + `ROLE_TOOLS`
(plus, once the `.md` filesystem lands, an `agents/platform/<role>.md` file). The
union, enum, and resolver pick it up automatically -- no engine change. The role set
the code ships and the role set this doc describes will converge on this superset.

### 1.3 The Workspace Intelligence Layer

Every agent call in Agentis starts the same way: workspace context is loaded and
prepended before the task prompt. This is infrastructure, not a feature toggle.
Principle #2 is enforced at the engine level in `#withWorkspaceContext()`.

```
[WORKSPACE CONTEXT BLOCK]         <- assembled by WorkspaceIntelligenceService
  WORKSPACE.md: who we are, stack, conventions
  MEMORY.md:    relevant patterns (recency x usage x workflow-match scored)
  DECISIONS.md: architectural decisions with rationale

[AGENT IDENTITY]                   <- system prompt from agent file / DB row
[SKILL BLOCKS]                     <- injected skills (Phase 3)
[TASK PROMPT]                      <- the workflow node's prompt field
```

`WorkspaceIntelligenceService` reads from the Volume's `context/` directory, seeds
defaults on first access, parses MEMORY.md structured entries
(`[date][uses:N][wf:slug][conf]`), scores them (recency*0.40 + usage*0.35 +
workflowMatch*0.25, confidence-nudged), and assembles a context block within a
configurable token budget. A context-read failure is best-effort -- it never blocks
a dispatch.

**Status: Complete (2026-05-22)**

### 1.4 WORKSPACE.md

The workspace identity document. Operators write this once and agents use it forever.

```markdown
# Acme Corp Engineering Workspace

Stack: TypeScript, React, PostgreSQL, Railway
Repo: github.com/acme/platform (main branch)
Coding standards: ESLint strict, test coverage > 80%
Deploy: Railway auto-deploy on push to main

Primary contacts:
  Tech lead: @alice (Slack)
  Design: @bob (Figma)

Current priorities (update weekly):
  - Q2: Payment system re-architecture
  - Q2: Mobile app launch (React Native)
```

### 1.5 MEMORY.md

A structured log of patterns that worked. Agents write here. Operators annotate here.
The intelligence layer reads and scores entries by relevance.

```markdown
## Patterns

[2026-04-12][uses:7][wf:code-review][conf:0.92]
evaluator retry loop: agent_task -> evaluator -> retry reduces failure 23% -> 4%.
Use on any code generation node. Max 2 retries. critiqueInjection: true.

[2026-04-08][uses:3][wf:*][conf:0.85]
GitHub rate limit: add retry+backoff (3 attempts, 2s initial) to all GitHub
integration nodes. Bare requests hit 403 during peak hours.
```

### 1.6 DECISIONS.md

Architectural decision records. Survives team turnover. Agents cite specific
decisions when explaining their choices.

```markdown
# ADR-001: No ORM in hot path
Date: 2026-03-01 | Status: Active
Decision: Raw SQL in hot-path queries; Drizzle only for schema/migrations.
Rationale: Drizzle query builder adds 2-4ms latency per query in benchmarks.
Consequences: New hot-path devs must be briefed. No query-builder sugar in
/v1/runs/*.
```

---

## Layer 2 -- The Specialist Agent Library

### 2.0 One workspace, many specialists

The Orchestrator does not do the work. It plans and delegates. Specialists do the
work. The right way to build a multi-agent workflow: Planner produces a plan, each
phase maps to the specialist best suited for it, Planner's role ends at delegation.

This is the architectural moat. n8n has no agents. OpenAI Operator has one agent
that does everything. Agentis has a team.

### 2.1 The Planner Agent

The Planner transforms a natural language request into a validated, executable
workflow graph using HTN (Hierarchical Task Network) planning.

**The planning protocol:**

```
User: "Build a weekly competitor analysis report and email it to the team."

Planner:
  Phase 1: Intelligence Gathering (Researcher)
    -> search_web: top 5 competitor blog posts this week
    -> search_web: competitor product updates, pricing changes
    -> knowledge_retrieve: our existing competitive intelligence base

  Phase 2: Analysis (Analyst)
    -> synthesize findings, score competitive threat level per competitor
    -> produce structured dataset

  Phase 3: Report Generation (Writer)
    -> draft_report: COMPETITIVE INTELLIGENCE BRIEF
    -> format: executive summary (3 bullets) + full breakdown table

  Phase 4: Distribution (Ops)
    -> send_email: weekly-intel-recipients@acme.com
    -> send_slack: #competitive-intel channel

  Estimated cost: $0.06 - $0.14 per run
  Estimated duration: 45 - 90s

  Approve this plan? [Yes] [Edit] [Redesign]
```

Phase Cards appear in the chat panel as the Planner works. The canvas builds in
parallel -- nodes animate into place as each phase is approved. Split mode shows
both representations simultaneously.

**Status: todo (Phase 3)**

### 2.2 Platform Specialists

`SpecialistAgentService` seeds specialists as workspace DB rows on first use.
`ensureRole(workspaceId, userId, role)` creates if absent; idempotent on re-call.
Specialists start with `status: 'offline'` -- they activate once an adapter/runtime
is connected, exactly like any user-created agent.

> **Resolved (2026-05-22):** `#dispatchAgentTask()` resolves `agentRole` →
> `specialists.ensureRole()` when no `agentId` is bound, and injects the role's
> system prompt ahead of the workspace context. A node with `agentRole: 'researcher'`
> now seeds + binds the Researcher specialist on first dispatch. Execution still
> requires a connected adapter/runtime (specialists seed `offline`).

### 2.3 Custom Agents

Operators create custom agents from the Agents page or by writing a `.md` file to
`agents/custom/`. Custom agents persist across runs and are available in NodePalette
as selectable workers for `agent_task` nodes.

### 2.4 Community Marketplace

Published agent and skill packages, versioned, browsable, installable.

```
agentis install researcher-pro
agentis install aarrr-framework
```

**Status: todo (Phase 3)**

### 2.5 The Skill Library

A **skill** is a behavioral protocol -- a markdown file that teaches any agent *how*
to approach a class of task. Where an agent file defines WHO does the work (identity,
tools, model), a skill file defines HOW to do specific work (framework, checklist,
cognitive rubric).

**The core distinction:**

```
agents/coder.md        WHO   "I am a TypeScript engineer. I write tests first."

skills/tdd-protocol.md HOW   "When implementing any feature:
                                1. Write the failing test first.
                                2. Write the minimum implementation to make it pass.
                                3. Refactor only after green."
```

The `coder.md` agent knows TypeScript. Loaded with `tdd-protocol.md` it *enforces*
TDD. Loaded with `owasp-checklist.md` it *enforces* security review. Same agent,
radically different behavior -- no new agent file required.

**Skill file format:**

```markdown
---
name: aarrr-framework
version: 1.0.0
applicableTo: [analyst, cro_analyst, writer, researcher]
tags: [product, metrics, growth]
---

# AARRR Analysis Framework

When analyzing any product or business metric, structure thinking in this order:

1. **Acquisition** -- How are users finding the product? (CAC, channel mix)
2. **Activation** -- First-experience quality? (onboarding completion, TTV)
3. **Retention** -- Are they coming back? (DAU/MAU, churn, cohort curves)
4. **Revenue** -- Monetization effectiveness? (ARPU, LTV, payback period)
5. **Referral** -- Are users referring others? (NPS, viral coefficient)
```

**How skills are assembled at dispatch:**

```
[Workspace context block]        <- WORKSPACE.md + MEMORY.md
[Agent identity]                 <- agents/custom/cro-analyst.md body
[Skill: aarrr-framework]         <- skills/aarrr-framework.md body
[Skill: statistical-testing]     <- skills/statistical-testing.md body
[Task prompt]                    <- the workflow node's prompt field
```

Token budget is respected. Skills are trimmed in reverse priority order if the
context window is exceeded. The agent identity block is never trimmed.

**Platform skills (shipped with Agentis):**

| Skill | Tags | Purpose |
|-------|------|---------|
| `tdd-protocol` | coding | Enforces test-first development |
| `owasp-checklist` | security | OWASP Top 10 security review |
| `aarrr-framework` | product, growth | Metric analysis structure |
| `statistical-testing` | data, analytics | Significance testing guidelines |
| `adr-format` | architecture | ADR writing template |
| `api-design-guidelines` | coding | REST API design principles |
| `code-review-rubric` | review | Structured review checklist |

**Status: done (2026-05-22).** `SkillLibraryService` seeds these as `skills/*.md` on the
Volume (operator edits win), parses frontmatter, and injects a token-budgeted skill block
into `agent_task` prompts via `agent_task.skills`. `api-design-guidelines` also shipped.

---

## Layer 3 -- The Node Library

### 3.1 Deterministic Nodes -- Status: Complete

The biggest hidden cost in current Agentis workflows: agent tasks used for work that
requires zero reasoning. Every such step burns LLM tokens, adds latency, and
introduces non-determinism where none is needed.

**Rule:** If the output of a step is fully determined by its inputs, it must use a
deterministic node.

| Node | Runtime | What it does |
|------|---------|-------------|
| **Transform** | `vm.Script` + isolated context | Evaluate a JS expression against inputs. Full JS stdlib. No I/O. 1s timeout. |
| **Filter** | `vm.Script` | Boolean expression gate. `true` handle and `false` handle. |
| **Loop** | Engine fan-out + collect | Iterate an array, execute loop body subgraph per item, aggregate results. |
| **Parallel** | Engine fan-out | Fan out to N branches simultaneously. Wait for all (or configurable minimum). |
| **Wait** | Engine + DB timer | Duration, until-datetime, webhook signal. Cross-session safe (persisted). |
| **HTTP Request** | ConnectorRegistry + safeUrl | Full REST call. Template interpolation. Response mapping. SSRF guard. |
| **Router** | Condition evaluator | first_match or all_matching branches. `llm_route` mode for classification routing. |
| **Merge** | Union pass-through | Join N branches. Modes: any-completes, all-complete, N-of-M. |

**Transform node security:** Expression runs in `vm.Script` with a frozen context
blocking `require`, `process`, `globalThis`, and `fetch`.

### 3.2 Browser Control Node -- Status: Mostly Complete

Playwright runs in a `BrowserPool` -- semaphore-controlled sessions, capped at
`AGENTIS_BROWSER_CONCURRENCY` (default: 3). Chromium auto-installs on first use via
the Playwright CLI (single-flight).

```typescript
interface BrowserNodeConfig {
  kind: 'browser';
  operation:
    | 'screenshot'       // done -- Full-page PNG artifact
    | 'pdf'             // done -- Print-to-PDF artifact
    | 'serve_html'      // done -- Render HTML string, screenshot result
    | 'navigate'        // done -- Load URL, return page title + content
    | 'extract_text'    // done -- Load URL, return visible text
    | 'fill_form'       // todo
    | 'extract_table'   // todo
    | 'serve_project';  // todo -- needs live ServingSession lifecycle
  url?: string;
  html?: string;
  selector?: string;
  captureScreenshot?: boolean;
  headless?: boolean;
}
```

`serve_project` serves a Volume directory as a live site -- the `WebsitePreview`
viewer connects to it live. Planned for Phase 5.

### 3.3 Integration Nodes -- Status: Complete

> **Correction from earlier drafts of this doc:** Integration nodes were described as
> "completely disconnected from the engine." This was wrong. The integration node is
> fully wired: `ConnectorRegistry` is injected at bootstrap, `CredentialVault`
> decrypts credentials at dispatch time, and `#executeIntegration()` routes to the
> registered connector.

| Connector | Operations |
|-----------|-----------|
| **HTTP** | GET, POST, PUT, PATCH, DELETE -- full template interpolation |
| **Slack** | Post message, post file, list channels, get users |
| **Gmail** | Send email, read emails, create draft |
| **GitHub** | List PRs, list issues, create issue, comment, get file, create PR |
| **Google Sheets** | Read range, write range, append rows, create spreadsheet |
| **Webhook Send** | POST to external URL, HMAC signing |

Adding a new connector: implement the `Connector` interface in
`packages/integrations/src/native/`, register in the manifest. No engine changes
required.

**Missing credential handling:** When a workflow uses an integration whose credential
is not configured, the engine throws at dispatch time. A pre-flight credential check
with a chat-guided setup wizard is planned for Phase 3.

### 3.4 Evaluator Node -- Status: Complete

```typescript
interface EvaluatorNodeConfig {
  kind: 'evaluator';
  rubric: string;             // "Output must be valid JSON with title, body, labels"
  targetPath: string;         // {{upstream_node.output}} path
  criteria: string;
  onFail: 'fail_run' | 'retry_upstream' | 'branch';
  retryNodeId?: string;       // agent_task node to re-run on failure
  maxRetries?: number;        // Default: 2
  critiqueInjection: boolean; // Inject evaluator feedback into retry prompt
}
```

The `agent_task -> evaluator -> retry` loop is the canonical pattern for
quality-guaranteed output. Observed in MEMORY.md: failure rate 23% -> 4% after
introducing this pattern on code review workflows.

### 3.5 Error Edge Architecture -- Status: Complete

`WorkflowEdge.type: 'data' | 'error' | 'condition'`. Error edges fire when their
source node fails, routing to an error handler instead of failing the run. Zod
schema updated (2026-05-22) to preserve `edge.type`.

```
[HTTP Request: GitHub API]
  |  data edge (normal path)
  +-> [Transform: process issues]
  |
  x  error edge (fires on failure)
     |
     +-> [Scratchpad: log error] -> [Slack: alert #ops]
```

Error handler nodes receive `{{source_node.error}}` as input. Canvas renders error
edges as dashed red lines.

---

## Layer 4 -- Artifact & Memory System

### 4.1 Three Tiers of State

```
TIER 1 -- Run State                                  STATUS: complete
  Scope: single run
  Lifetime: run duration
  Access: {{nodeId.outputKey}} variable interpolation
  Use: pass data between nodes within a run

TIER 2 -- Workflow State (workflow_kv_entries table)  STATUS: complete
  Scope: single workflow, all runs
  Lifetime: permanent or configured TTL
  Access: {{workflow_kv.my_key}} + workflow_store node
  Use: rolling windows, counters, last-seen state
  Example: "only process PRs we haven't seen before"

TIER 3 -- Workspace State (workspace_kv table)        STATUS: done (2026-05-22)
  Scope: entire workspace, all workflows
  Lifetime: permanent
  Access: {{workspace.kv.my_key}} + workspace_store node
  Use: shared constants, global flags, cross-workflow coordination
  Example: "weekly report config" shared across 3 workflows
```

### 4.2 Artifact Store -- Status: Complete (V1)

`artifacts` table created in `embedded-sql.ts` with indexes. Inline content storage
(V1). S3/R2 filesystem backend is V2.

```typescript
interface ArtifactRecord {
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  name: string;           // filename.ext
  contentType: string;    // MIME type
  size: number;           // bytes
  storageKey: string;     // data-URL (V1); filesystem path (V2)
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

### 4.3 Variable Interpolation Engine -- Status: Complete

Every string-typed field in every node config is template-resolved before dispatch.

```
Template syntax: {{nodeId.outputKey.nested.path}}
Additional sources:
  {{workflow_kv.key}}      workflow-scoped KV (Tier 2) -- done
  {{workspace.kv.key}}     workspace-scoped KV (Tier 3) -- done (2026-05-22)
  {{run.id}}               current run ID -- done
  {{workspace.id}}         workspace ID -- done
  {{env.AGENTIS_PUBLIC_*}} allowlisted env vars only -- done
```

Unresolved references throw `WORKFLOW_VARIABLE_NOT_FOUND` -- a clear error, not
a silently wrong prompt.

### 4.4 Workspace Volume -- Status: Complete (V1)

`WorkspaceVolumeService` rooted at `{AGENTIS_DATA_DIR}/workspace/{workspaceId}/`.
Path-escape protection (`WORKSPACE_VOLUME_PATH_ESCAPE` error code).
Read/write/append/list/scaffold operations. Conventional directory structure
scaffolded on first access.

```
.agentis/workspace/{workspaceId}/
  agents/
    platform/   <- Platform agents (read-only, shipped with Agentis) [Phase 3]
    custom/     <- Operator-created agents [Phase 3]
    community/  <- Installed from marketplace [Phase 3]
  skills/       <- Behavioral protocols [Phase 3]
  projects/     <- Multi-file codebases generated by Coder agent
  sites/        <- Websites and apps generated by Coder/Builder agents
  reports/      <- Documents and PDFs generated by Writer/Analyst agents
  datasets/     <- Enriched datasets generated by Analyst agent
  assets/       <- Images, audio, video generated by media workflows
  context/      <- WORKSPACE.md, MEMORY.md, DECISIONS.md -- done
```

The **Volume Explorer panel** (Output tab > Volume tab) shows the full directory tree
with file previews, "Open in VS Code", per-file download, and a cleanup tool.
Planned for Phase 5.

---

## Layer 5 -- Enterprise Execution Model

### 5.1 Workflow Phases -- Status: done (2026-05-22)

> **Current state:** `WorkflowPhase` carries `slaDurationMs`, `budgetCents`, `humanGate`,
> and `successCriteria`. The engine tracks phase start/completion, arms an SLA timer
> (PHASE_SLA_BREACHED alert), accrues per-node `estimatedCostCents`, halts the run on
> budget overrun (BUDGET_PHASE_EXCEEDED), and **enforces human gates**: when a gated
> phase's first node is reached the run pauses (node WAITING, `phase_gate` approval
> created) and resumes on approval / fails on rejection via `engine.resolveApproval()`.
> (This pass also fixed a latent checkpoint-resume bug — the resume target was stored in
> `approval.task_id`, which has a `tasks` FK; it's now tracked in-memory by approval id.)

Target schema:

```typescript
interface WorkflowPhase {
  id: string;
  name: string;
  nodeIds: string[];
  slaDurationMs: number;           // todo: not enforced
  humanGate?: {
    type: 'approve' | 'provide_input' | 'review_output';
    approvers: string[];
    timeoutMs?: number;
    escalateTo?: string;
  };
  successCriteria?: string;        // todo: JS expression evaluated after phase
  rollbackPlan?: string;
  budgetCents?: number;            // todo: not enforced
}
```

RunDrawer target (todo):

```
+----------------------------------------------------+
|  Phase 1: Data Collection     [OK] COMPLETE   12s  |
|  Phase 2: Content Generation  [>>] RUNNING    45s  |
|  Phase 3: Distribution        [ ]  PENDING         |
+----------------------------------------------------+
```

### 5.2 SLA Tracking -- Status: done (2026-05-22)

Every phase has an SLA. On breach: emit `PHASE_SLA_BREACHED`, alert the configured
ops channel, turn the phase boundary box amber on canvas. Breaches alert -- they do
not kill runs.

### 5.3 Budget Governance -- Status: DONE — all three tiers (2026-05-23)

```
WORKSPACE BUDGET: $500/day      <- workspaces.daily_budget_cents   (enforced)
  WORKFLOW BUDGET: $50/run      <- workflows.budget_cents          (enforced)
    PHASE BUDGET: $10/phase     <- WorkflowPhase.budgetCents       (enforced)
```

The complete nested budget cage is wired, each tier halting the run FAILED on
overrun: per-phase (`BUDGET_PHASE_EXCEEDED`, `#onPhaseNodeComplete`), **per-run
workflow** (`BUDGET_RUN_EXCEEDED`, `#workflowRunBudgetExceeded` accruing
`ctx.runCostCents` vs `workflows.budget_cents`), and **workspace/day**
(`BUDGET_WORKSPACE_EXCEEDED`, `#workspaceDailyBudgetExceeded` summing
`AuditTrailService.workspaceSpendSince(midnightUTC)`). Workspace cap set via
`PATCH /v1/budgets/workspace`; `GET /v1/budgets` reports cap + today's spend.

### 5.4 Full Audit Trail -- Status: done (2026-05-22)

`audit_entries` table + `AuditTrailService` record run + node lifecycle with phase /
actor / cost attribution; `GET /v1/runs/:runId/audit` returns the full per-node trail.

### 5.5 Long-Running Workflow Architecture -- Status: todo

- Phase snapshots: deliberate milestone checkpoints distinct from crash-recovery
- Phase-gate wait surviving server restarts (wait nodes do this today; phase gates do not)
- `maxExecutionWindowDays` with `TIMEOUT` status on expiry

---

## Layer 6 -- Universal Output Surface

### 6.1 The Artifact Type Registry

```
Current viewer registry (done 2026-05-22):
  text/html      -> LiveHTMLRenderer (sandboxed iframe + device mode)
  text/markdown  -> MarkdownRenderer (via ChatMarkdown)
  table/csv/json-array -> DataTableViewer (sort, filter, paginate, CSV/JSON export)
  application/json (object) -> CodeViewer / JSON block
  application/pdf -> PdfViewer (iframe + download)
  image/*        -> ImageViewer (lightbox + zoom + keyboard)
  text/x-code-file / code artifacts -> CodeViewer (line numbers + copy)
  video/*        -> VideoPlayer (controls + playback speed + download)   [done 2026-05-23]
  audio/*        -> AudioPlayer (controls + download)                    [done 2026-05-23]
  text/x-diff / diff code     -> DiffViewer (colorized unified diff)     [done 2026-05-23]
  application/x-codebase (data {files:[]}) -> CodebaseViewer (tree+code) [done 2026-05-23]
  application/x-dashboard (data {series:[]}) -> DashboardViewer (bars)   [done 2026-05-23]
  application/x-website (document URL) -> WebsitePreview (addr bar+iframe)[done 2026-05-23]
  *              -> BinaryDownloadCard (fallback)

  application/x-deployment (data {deployment:{url}}) -> DeploymentCard (URL+health+preview) [done 2026-05-23]
  application/x-openapi (data {openapi|swagger}) -> APIExplorer (operations list)           [done 2026-05-23]
  *              -> BinaryDownloadCard (fallback)

Planned viewer registry (remaining):
  application/zip             -> ArchiveViewer
  (WebsitePreview renders any hosted URL; `serve_project` live-from-Volume hosting is still todo;
   DeploymentCard "rollback" + APIExplorer "try-it" are read-only for now)
```

### 6.2 Viewer Specifications

**DataTableViewer** (`text/csv`, `application/json` array, XLSX)
- Pagination: 25 / 50 / 100 / all rows
- Sort: click column header; shift-click for multi-column sort
- Per-column filter bar and global search
- Column stats: null%, min/max/avg, unique count
- Pivot mode, export CSV/XLSX/JSON
- Row detail drawer, "Send to Google Sheets" action

**LiveHTMLRenderer** (`text/html`) -- done
- Sandboxed iframe (`sandbox="allow-scripts"`) -- no parent origin access
- Device mode toolbar: Desktop (1440px) / Tablet (768px) / Mobile (375px)
- Responsive resize handle
- "Open in new tab" via signed temporary URL
- JS console panel: todo

**WebsitePreview** (`application/x-website`) -- todo
- Full in-panel browser: address bar, back/forward, reload
- Served live from Workspace Volume via `serve_project`
- Multi-page navigation, hot-reload, device mode toggle
- "Open in system browser"

**CodebaseViewer** (`application/x-codebase`) -- todo
- File tree sidebar, syntax-highlighted editor pane, search across all files
- Diff mode: compare any file to previous run
- "Open in VS Code", stats bar (files, lines, language pie), "Download as ZIP"

**ImageViewer** (`image/*`) -- todo
- Click-to-lightbox, scroll-to-zoom (10x), drag-to-pan
- Compare with previous run (side-by-side or opacity overlay)
- Download + format conversion

**VideoPlayer / AudioPlayer** -- todo
- VideoPlayer: standard controls, playback speed, frame export, loop, keyboard shortcuts
- AudioPlayer: waveform visualization, TTS source text display alongside waveform

**DashboardViewer** (`application/x-dashboard`) -- todo
- Chart types: bar, line, area, pie, scatter, heatmap, funnel
- Responsive grid, global date range filter, export charts as PNG

**PDFViewer** (`application/pdf`) -- todo
- Page navigation, zoom (fit-width/fit-page/custom), text selection, full-text search

**DeploymentCard** (`application/x-deployment`) -- todo
- Live iframe preview, health status badge (HTTP check), metadata, rollback button

**APIExplorer** (`application/x-openapi`) -- todo
- Interactive docs, try-it panel, workspace API key injection

### 6.3 The OutputGallery -- Multi-Artifact Runs

`WorkflowArtifactGrid` renders artifact cards with inline preview and download --
done. Full gallery with export-all-as-zip and share-bundle is Phase 5.

Target layout:

```
Run: "Generate Q2 EMEA Leads"   Success  47s  $0.12
--------------------------------------------------------------
OUTPUTS (6 artifacts)

  +-----------------+  +-----------------+  +-----------------+
  | leads.csv       |  | report.pdf      |  | dashboard       |
  | DataTable       |  | PDF 12 pages    |  | WebsitePreview  |
  | 847r x 14c      |  | 2.4 MB          |  | live hot-reload |
  | [Open][Export]  |  | [Open][Send]    |  | [Open][Deploy]  |
  +-----------------+  +-----------------+  +-----------------+

  [Export All as ZIP]   [Pin Selected]   [Share Bundle]
```

### 6.4 Output Actions

| Action | Status |
|--------|--------|
| Download (original format) | done |
| Pin to workspace | done (2026-05-23) — `artifacts.pinned` + `POST /v1/artifacts/:id/pin` + `?pinned=true` filter |
| Share (signed URL with expiry) | todo |
| Re-run | done (2026-05-23) — "Re-run" on the Output tab last-run header (re-run *with changes* still todo) |
| Type-specific (CSV export, VS Code open, Deploy, etc.) | todo |

### 6.5 The Three Views

- **Last Run** (default) -- `WorkflowOutputTab` renders the most recent run: done
- **All Runs** -- timeline of every run with expandable artifact gallery: todo
- **Diff View** -- select two runs, compare side-by-side per artifact type: todo

### 6.6 Canvas Live Behavior -- Status: todo

- Data packets along edges carrying output previews (first 60 chars / 32px thumbnail)
- Phase rings pulsing during execution, solid on phase completion
- SLA countdown ring (amber warning, red on breach)
- Running cost total in canvas status bar
- Live Volume write indicator in node header during Coder agent writes
- Artifact tray rising at canvas bottom as nodes produce artifacts

---

## Layer 7 -- Observability & Self-Improvement

### 7.1 Workspace Analytics -- Status: backend done (2026-05-22); dashboard UI todo

`GET /v1/workflows/:id/analytics` returns run counts, status breakdown, success rate,
avg duration, avg/total cost (from the audit trail), and the per-node failure breakdown
(with sample errors). Remaining: the dashboard UI + cross-workflow rollups + cost trend.

- Most-run workflows, per-step failure rates, avg cost per run, cost trend
- Per-workflow failure breakdown by node + auto-optimization suggestions
- SLA bottleneck analysis

### 7.2 The Instinct Engine -- Status: done V1 (2026-05-22; proposes + writes MEMORY, auto-patch todo)

An **instinct** is a pattern observed in enough runs to be applied automatically:

```typescript
interface Instinct {
  id: string;
  workspaceId: string;
  workflowId?: string;
  trigger: {
    pattern: 'node_always_fails_when' | 'output_always_exceeds' | 'rate_limit_pattern';
    nodeKind?: WorkflowNodeKind;
    condition: string;
  };
  action: {
    type: 'add_transform' | 'add_retry' | 'add_truncation' | 'suggest_change';
    config: Record<string, unknown>;
    description: string;
  };
  confidence: number;     // 0-1, grows with evidence
  appliedCount: number;
  lastObservedAt: string;
}
```

The instinct engine runs after every failed run, detects repeat patterns, proposes a
fix, and -- when approved -- applies it via `applyGraphPatch` and writes the learned
pattern to MEMORY.md.

Observed trigger pattern example:

```
Run failed at: Summarizer Agent
Failure: CONTEXT_TOO_LONG (input was 52 items, 18,000 tokens)
Previous failures: 3 times in last 7 days (same root cause)

Pattern detected (confidence: 0.85)
Proposed fix: "Add Transform to truncate items to 20 before Summarizer Agent"
"I noticed the same failure 4 times. Want me to add a fix automatically?"
```

### 7.3 Cost Intelligence -- Status: todo (event collection done)

`LedgerService` collects cost events. The surface layer is unbuilt:

- Post-run cost breakdown per node (token counts x model prices)
- Live budget bar during execution
- Historical cost range for recurring workflows
- Cost trend chart in workflow analytics
- Model substitution suggestions ("this node uses GPT-4o but mini handles it at 5%
  of the cost")

Pre-run cost estimation is intentionally absent. Token consumption in dynamic
multi-agent workflows is inherently unpredictable. Historical ranges are surfaced
instead.

---

## 3. Integration Architecture

### 3.1 Native-First Engineering

| Operation | Our implementation | What we avoid |
|-----------|-------------------|---------------|
| Webpage screenshot | Playwright (already in repo) | ScrapingBee, Browserless API |
| HTML to PDF | Playwright print-to-PDF | DocRaptor, WeasyPrint API |
| HTML rendering | Browser node + sandboxed iframe | External renderer services |
| File I/O | Node.js `fs` module | File storage APIs |
| JSON/CSV/Markdown parsing | Pure TS | Parsing APIs |

### 3.2 External Integration Rules

1. **Never call an external API without a stored credential.**
2. **Every external call has a timeout, retry policy, and circuit breaker.**
   Enforced by `ConnectorRegistry`.
3. **Credentials never appear in workflow logs.** `CredentialVault` decrypts at
   execution time; only masked values in observability.
4. **SSRF guard on every configurable URL.** `safeUrl.ts` applies to HTTP Request,
   Webhook Send, and all user-configurable URL fields.

### 3.3 Integration Roadmap

- Phase 1 (done): Slack, Gmail, GitHub, Google Sheets, HTTP, Webhook Send
- Phase 2: Notion, Airtable, Jira, Linear, Discord, Telegram
- Phase 3: Salesforce, HubSpot, Stripe, Twilio, AWS S3, PostgreSQL
- Phase 4: OpenAI, Anthropic, Replicate, ElevenLabs, Stability AI

---

## 4. Workflow as Code -- Status: todo

### 4.1 YAML Serialization

Workflows should be versionable, reviewable, and portable -- not JSON locked in a
SQLite column:

```yaml
name: Weekly Engineering Standup
description: Collect PRs, summarize, post to Slack and email CTO
schedule: "0 8 * * MON"

phases:
  - id: data-collection
    name: Data Collection
    sla: 45s

nodes:
  - id: trigger
    type: trigger
    config: { kind: schedule, cron: "0 8 * * MON" }
    phase: data-collection

  - id: list-prs
    type: integration
    config:
      kind: integration
      integrationId: github
      operation: list_pulls
      params: { since: "{{date.lastWeek}}", state: all }
    dependsOn: [trigger]
    phase: data-collection

  - id: summarizer
    type: agent_task
    config:
      kind: agent_task
      agentRole: writer
      prompt: |
        Write a standup summary. PR activity: {{list-prs.result}}
        Format as Slack markdown. Be concise. Focus on what shipped.
      retryPolicy: { maxAttempts: 2, backoff: fixed, initialDelayMs: 1000 }
    dependsOn: [list-prs]
    phase: content-generation
```

### 4.2 Git Integration -- Status: todo

Every workflow save triggers `git commit + push`. PRs that modify workflow YAML are
validated by `validateGraph()` as a CI check.

---

## 5. MCP Publication Layer -- Status: done V1 (2026-05-23)

> `routes/mcp.ts`: `POST /v1/mcp/publish` marks a workflow published (slug in
> `workflow.settings.mcp`), `GET /v1/mcp/tools` lists published tools as MCP descriptors
> with an input schema derived from the workflow's inputContract, and
> `POST /v1/mcp/tools/:slug` runs the workflow, awaits completion, and returns the unwrapped
> output. Remaining: a standalone MCP *server* transport + the publish button in the canvas UI.

### 5.1 Workflows as MCP Tools

Every published Agentis workflow exposed as an MCP tool -- callable from Claude Code,
Cursor, Codex, or any MCP-compatible AI client.

```
Published workflow: "Weekly Standup Generator"
  MCP tool name: agentis__standup_generator
  Input schema:  { since?: ISO-8601, team?: string[] }
  Auth:          workspace API key
  Endpoint:      POST /v1/mcp/tools/standup_generator
```

**Distribution moat:** Every Claude Code, Cursor, and Codex user who installs an
Agentis MCP server gains access to a library of production-hardened workspace
automations. They stop building their own workflows from scratch.

### 5.2 MCP Publication UI -- Status: todo

`[Publish]` button in canvas header gains a "Publish as MCP Tool" option.
Auto-generates the MCP installation command from the workflow's trigger schema.

---

## 6. The `build_workflow` Pipeline

### 6.1 Current State + Target Architecture

**Current state:** `buildWorkflowDraft()` is a regex/keyword fallback producing
simple linear chains. LLM synthesis exists but is gated by
`AGENTIS_EVALUATOR_BASE_URL` + `AGENTIS_EVALUATOR_MODEL`. Most installs don't
configure these, so most users get the regex path. Workspace context injection is
done; intent/template stages are not built.

**Target:** Replace the evaluator-env gating with a dedicated
`WORKFLOW_SYNTHESIS_MODEL` env var (default `gpt-4o-mini`) so LLM synthesis is the
default path for all installs.

```
build_workflow(prompt)
    |
[Step 1: Load Context]               STATUS: done
  WORKSPACE.md + MEMORY.md + DECISIONS.md
  Integration registry
  Specialist agent catalog
  Workflow template library
    |
[Step 2: Intent Extraction]          STATUS: done (2026-05-22, partial)
  Trigger type: manual / schedule / webhook -- done (inferTriggerConfig)
  Output type: html / text / data -- done
  Integrations mentioned / setup wizard -- todo
    |
[Step 3: Template Matching]          STATUS: done (2026-05-22)
  Patterns live: research-report (researcher->analyst->writer),
    review pipeline, collect-summarize. monitor-alert / etl / deploy todo.
  Match -> instantiate specialist-pipeline template (agentRole nodes)
  No match -> Step 4
    |
[Step 4: LLM Graph Synthesis]        STATUS: done (2026-05-22 -- ungated from evaluator)
  Model: WORKFLOW_SYNTHESIS_MODEL (default: gpt-4o-mini)
  Dedicated synthesis runtime; falls back to evaluator runtime; regex only if neither set.
  System: node catalog + WORKSPACE.md + MEMORY.md + graph schema
  Temperature: 0.1, response_format: json_object
    |
[Step 5: Validation + Patch]         STATUS: done
  validateGraph() + Zod schema
  Invalid: inject error + retry once with LLM
  Still invalid: partial graph + flag for manual completion
    |
[Step 6: Build Narration]            STATUS: done (canvas events streaming)
  Stream CANVAS_BUILD_COMPLETE to chat
  Show: node count, integrations, estimated cost, missing cred warnings
```

---

## 7. Phased Delivery

Status legend: done / partial / todo

### Phase 1 -- Close the Hello World Gap -- STATUS: COMPLETE (2026-05-22)

| Item | Effort | Status |
|------|--------|--------|
| `return_output` node with `renderAs` field | S | done 2026-05-22 |
| Output tab: render HTML in sandboxed iframe (LiveHTMLRenderer) | S | done 2026-05-22 |
| Transform node (sandboxed expression runtime) | M | done pre-existing |
| Variable interpolation resolver | M | done pre-existing |
| Artifacts table + routes + storage backend | M | done DDL fixed 2026-05-22; inline V1 |
| `artifact_save` node | S | done 2026-05-22 |
| `browser: serve_html` + `screenshot` + BrowserPool | M | done 2026-05-22 |
| Output tab: artifact card grid (WorkflowArtifactGrid) | M | done 2026-05-22 |
| Fix `webhook` palette node (maps to wrong kind) | XS | todo |

### Phase 2 -- Node Library -- STATUS: ~90% Complete

| Item | Effort | Status |
|------|--------|--------|
| Filter node | S | done pre-existing |
| Wait node (duration + webhook modes, crash-recoverable) | M | done pre-existing |
| HTTP Request node (retry + backoff + SSRF guard) | M | done pre-existing |
| Loop node (chunked concurrency via SubflowExecutor) | L | done pre-existing |
| Parallel node engine handler | M | done pre-existing |
| Error edges + error handler routing | L | done pre-existing + schema fix 2026-05-22 |
| Integration nodes: Slack, Gmail, GitHub, Sheets | M | done pre-existing |
| `browser: pdf`, `navigate`, `extract_text` | M | done 2026-05-22 |
| Variable picker UI (`{{` autocomplete) | M | done VariablePicker.tsx |
| Evaluator node (EvaluatorRuntime wired) | M | done pre-existing |
| Guardrails node | M | done pre-existing |
| Agent Swarm node | L | done pre-existing |
| `browser: fill_form`, `extract_table` | M | done 2026-05-22 |
| Integration setup wizard in chat | L | todo |

### Phase 3 -- Intelligence Layer -- STATUS: Partial

| Item | Effort | Status |
|------|--------|--------|
| WORKSPACE.md + MEMORY.md + DECISIONS.md on Volume | M | done 2026-05-22 |
| WorkspaceIntelligenceService + injection into all agent calls | M | done 2026-05-22 |
| Specialist library: AgentRole + ROLE_TOOLS + SPECIALIST_AGENTS (core) | M | done 2026-05-22 |
| `agentRole` dispatch in `#dispatchAgentTask()` + role system-prompt injection | XS | done 2026-05-22 |
| `build_workflow` emits `agentRole` on generated agent tasks | XS | done 2026-05-22 |
| Canvas wiring for new nodes (palette + inspector forms + glyphs) | M | done 2026-05-22 (return_output, artifact_save, browser) |
| `build_workflow` LLM synthesis for all installs (remove evaluator-env gate) | S | todo |
| Intent extractor + template library | M | done 2026-05-22 (trigger inference + research-report / review / collect-summarize pipelines) |
| Agent `.md` filesystem (agents/platform/, custom/, community/) | M | done 2026-05-23 (`AgentLibraryService`) |
| Platform agent library as `.md` files (SS1.2) | L | done 2026-05-23 (platform specialists export to `agents/platform/<role>.md`; custom roles in `agents/custom/*.md` expand casting) |
| Skill `.md` filesystem + injection at dispatch (SS2.5) | M | done 2026-05-22 (SkillLibraryService + 7 platform skills + dispatch injection) |
| Planner: HTN planning + Phase Cards in chat | L | backend done (`planWorkflow` + `POST /v1/workflows/plan`); `PhaseCards` UI done; live split-pane Builder remaining |
| Workspace Orchestrator: always-on background monitor | L | todo |
| Phase plan card UI in chat | M | done 2026-05-23 (`PhaseCards` + Plan preview on canvas) |
| Approval mode settings (all / risky / none) | M | todo |
| Community agent/skill marketplace | L | todo |

### Phase 4 -- Enterprise Execution -- STATUS: Partial

| Item | Effort | Status |
|------|--------|--------|
| Workflow phases as execution primitives (SLA + budgetCents) | L | done 2026-05-22 |
| Phase gates (human approval between phases) | M | done 2026-05-22 (pause → approval → resume/fail) |
| SLA tracking + alerting | M | done 2026-05-22 (PHASE_SLA_BREACHED) |
| Budget governance (per-phase enforcement caps) | M | done 2026-05-22 (BUDGET_PHASE_EXCEEDED halts run) |
| Audit trail table + GET /v1/runs/:runId/audit | M | done 2026-05-22 |
| Workspace-scoped KV (Tier 3) | M | done 2026-05-22 |
| Long-running workflow phase snapshots | L | todo |
| YAML workflow export/import | M | todo |
| Cross-run workflow state | M | done WorkflowStoreService + workflow_store node |

### Phase 5 -- Universal Output Surface -- STATUS: Partial

| Item | Effort | Status |
|------|--------|--------|
| Artifact type registry + VIEWER_REGISTRY dispatch | M | done 2026-05-22 (OutputViewers + per-type dispatch) |
| DataTableViewer: sort, filter, export | L | done 2026-05-22 (pivot still todo) |
| WebsitePreview: serve_project + in-panel browser + hot-reload | L | todo |
| CodebaseViewer: file tree + syntax highlight + search + VS Code | L | todo (CodeViewer single-file done) |
| ImageViewer: lightbox + zoom/pan + compare-across-runs | M | done 2026-05-22 (compare-across-runs todo) |
| VideoPlayer + AudioPlayer + waveform | M | todo |
| DashboardViewer: multi-chart grid + date filter + export | L | todo |
| PDFViewer: page nav + zoom + full-text search | M | done 2026-05-22 (iframe viewer; full-text search todo) |
| DeploymentCard: URL + health check + rollback | M | todo |
| OutputGallery: multi-artifact grid + export-all-as-zip + share-bundle | L | todo |
| Output Actions: pin, share, re-run-with-changes | M | todo |
| Volume Explorer panel | M | todo |
| All Runs timeline with per-run artifact gallery | L | todo |
| Diff View (DataTable, code, image, text, numeric) | L | todo |
| Artifact tray on canvas | M | todo |
| `browser: serve_project` + ServingSession lifecycle | M | todo |
| `browser: fill_form` + `extract_table` | M | todo |
| Artifact expiry + cleanup job | S | todo |
| LiveHTMLRenderer JS console panel | S | todo |

### Phase 6 -- Self-Improvement & MCP -- STATUS: Not Started

| Item | Effort | Status |
|------|--------|--------|
| Workspace analytics dashboard | L | partial -- backend `GET /v1/workflows/:id/analytics` done 2026-05-22; dashboard UI todo |
| Instinct engine (pattern detection + auto-patch) | L | done 2026-05-23 — proposal + MEMORY write + `applyInstinct` auto-patch (truncation insert / retry+timeout hardening) |
| Cost intelligence surface (per-node breakdown, trend chart) | M | partial -- per-node `estimatedCostCents` accrued + in audit; UI surface todo |
| Scheduler UI (cron/event triggers via canvas) | L | todo |
| MCP publication layer | L | done V1 2026-05-23 (publish + list + run-and-return; standalone MCP server transport todo) |
| Git sync for workflows | M | todo |
| Workflow marketplace / template gallery | L | todo |

---

## 8. Why This Wins

### Against n8n

| Dimension | n8n | Agentis (Phase 3+) |
|-----------|-----|-------------------|
| Building workflows | Manual node placement | "Do X" -> full phased graph with parallel branches and integrations |
| Agent integration | HTTP node to external API | Native agent_task with workspace context, specialist roles, evaluator-retry |
| Multi-agent | None | Agent Swarm with planner-coordinator-worker hierarchy |
| Memory | Variables node (session only) | Three-tier state + WORKSPACE.md + MEMORY.md instinct learning |
| Browser automation | External service or Code node | Native Playwright: screenshot, PDF, form fill, scrape, serve HTML |
| Enterprise workflows | Not designed for it | Phase gates, SLA tracking, budget governance, audit trail |
| Self-improvement | None | Instinct engine observes patterns and auto-patches workflows |
| Distribution | Workflow exports | MCP publication: other AI tools call your workflows as tools |

The gap n8n can never close: their execution model is deterministic. Every n8n node
is a pure function. Adding native reasoning requires rebuilding the platform.
Agentis `agent_task` nodes reason with workspace context, persistent memory, and
specialist roles. That is the architectural moat.

### Against OpenAI Operator / Anthropic Computer Use

These give AI direct computer access but no structure. No phase gate, no budget
governance, no human approval protocol, no audit trail. A company cannot safely run
its quarterly reporting on "AI that browses the web and does things." They need the
workflow structure -- observable, auditable, phase-gated execution -- that Agentis
provides. Browser control is one node inside a larger orchestrated system.

### Against Devin / Cursor Background Agent

Coding-specific. Agentis is company-wide automation. Engineering is one sector.
Marketing, sales, finance, HR are others. The Planner reading WORKSPACE.md for a
marketing team has the same architecture as one for an engineering team -- different
specialists, different integrations, same execution fabric.

---

## 9. Metrics That Define Success

| Metric | Phase 1+2 (today) | Phase 3 target | Phase 6 target |
|--------|-------------------|----------------|----------------|
| "Hello World in browser" time | < 2 min (done) | < 30s | < 15s |
| `build_workflow` complex success rate | ~25% | 85% | 92% |
| Workflows with zero `agent_task` nodes | ~20% | 50% | 65% |
| Output tab: % runs with rendered output | ~70% | 95% | 99% |
| Max workflow phases (as execution primitives) | 0 (cosmetic only) | unlimited | unlimited |
| Users creating 2nd workflow within 7 days | baseline | +60% | +85% |
| Workflow run failure rate | ~20% | ~8% | ~4% |
| Avg agent task cost per workflow run | ~$0.09 | ~$0.04 | ~$0.02 |

---

## 10. Architecture Principles (Enforced)

1. **Native before external.** Any operation that runs locally (Playwright, Node.js
   fs, pure TS) must never call an external API.

2. **Workspace context is always injected.** No agent call starts without
   WORKSPACE.md + MEMORY.md. This is infrastructure, not a feature toggle.
   **Status: enforced at engine level in `#withWorkspaceContext()`.**

3. **Plan before build.** Complex requests go through the Planner's HTN protocol.
   The plan is presented and approved before a single node is written.
   **Status: todo -- Planner not yet built. `build_workflow` proceeds directly to
   synthesis today.**

4. **Deterministic first.** If a step requires no reasoning, it gets a deterministic
   node. Agent tasks are for reasoning, generation, interpretation -- nothing else.

5. **Every output is a rendered artifact.** Workflows produce human-readable results.
   Raw JSON in the output tab is a failure mode.

6. **Self-improvement is structural.** The instinct engine is not a future
   nice-to-have. It is how the platform becomes more valuable the longer it runs.

7. **The audit trail is sacred.** Every action in every workflow run is attributed,
   timestamped, and inspectable. This is what makes multi-agent automation safe on
   production systems.

8. **Budget governance is non-negotiable.** No workflow runs without a budget. No
   phase starts if the budget is exhausted.
   **Status: per-phase enforcement done (2026-05-22) -- BUDGET_PHASE_EXCEEDED halts the
   run; node `estimatedCostCents` accrued per phase. Workspace/day ceilings still todo.**

9. **Every output type has a dedicated renderer.** The output surface is a type
   registry, not a generic component.
   **Status: HTML + Markdown renderers done. Full registry is Phase 5.**

10. **The Workspace Volume is the agent's hard drive.** Artifacts are immutable run
    receipts. The Volume is the live, mutable filesystem where agents build.
    **Status: WorkspaceVolumeService complete (2026-05-22).**

11. **An agent is a file, not a record.** Agent definitions should live on the
    filesystem as markdown files -- human-readable, AI-writable, git-versionable.
    The database tracks what agents *did*; the filesystem defines what agents *are*.
    **Current state: specialists are DB rows seeded by `SpecialistAgentService`.
    The `.md` filesystem is the target, planned for Phase 3.**

12. **Bound every reasoning step.** No `agent_task`, `agent_swarm`, or `llm_route`
    ships to production without a deterministic boundary around it -- an evaluator
    gate, guardrails, a budget ceiling, an error edge, or a human gate. Naked
    non-determinism is the failure mode. (See the North Star.)

13. **Autonomy is earned, not granted.** Deterministic, proven paths run unattended;
    novel reasoning runs behind a gate. The Instinct Engine promotes a pattern's
    autonomy as its confidence accrues. Approval modes, evaluator thresholds, and
    instinct confidence are one dial at different resolutions.
    **Status: the pieces (approval modes, evaluator, instinct) are partly built; the
    unified dial is the Phase 6 target.**

14. **Runs are reproducible by construction.** Deterministic node outputs are recorded
    so any run can be replayed from any node -- re-executing the deterministic prefix,
    re-running only the reasoning. Reproducibility is a headline capability, not a
    debugging afterthought. **Status: `partialReplay` + run snapshots exist; the
    operator-facing "replay from here" surface is Phase 4-5.**

---

## Implementation Log

> Append-only. Each entry records what was actually built against this plan,
> dated, with the files touched and how it was verified. Newest at the bottom.

---

### 2026-05-22 -- Output Surface + `return_output` + `artifact_save`

**Context.** First implementation pass. Began with a full engine audit. Key
realization: the engine already implements most of Layers 3-4; the real Phase-1 gap
is the output surface (HTML was rendered as raw text) and the explicit output/artifact
nodes.

**Shipped.**
- `return_output` node with `OutputRenderAs` (`html|markdown|table|json|text`).
  Engine resolves the value and tags it with the render hint.
- `artifact_save` node -- persists a value to the `artifacts` store (inline V1),
  inferring MIME from filename/content.
- Universal Output Surface V1 -- web `LiveHTMLRenderer` (sandboxed iframe,
  device-mode toolbar, open-in-new-tab), `renderAs` dispatch in `RunOutputCard`,
  `WorkflowArtifactGrid` (artifact cards with inline HTML preview + download), wired
  into `WorkflowOutputTab` via `GET /v1/artifacts?runId=`.
- `build_workflow` emits `trigger -> transform -> return_output(renderAs)` for
  static/HTML outputs.
- **Latent bug fixed.** `artifacts` table existed in Drizzle schema but was never
  created by `embedded-sql.ts`. Added `artifacts` DDL + indexes.
- Added missing `type` field to Zod `workflowEdgeSchema` (engine honored
  `edge.type='error'` but schema silently dropped it on save/validation).

**Files touched.** `packages/core/src/types/workflow.ts`,
`packages/core/src/schemas/workflow.ts`,
`apps/api/src/engine/WorkflowEngine.ts`,
`apps/api/src/routes/workflows.ts`,
`apps/api/src/services/agentisToolHandlers/build.ts`,
`packages/db/src/sqlite/embedded-sql.ts`,
`apps/web/src/components/workflows/RunOutputCard.tsx`,
`apps/web/src/components/workflows/WorkflowArtifactGrid.tsx` (new),
`apps/web/src/components/workflows/WorkflowOutputTab.tsx`,
`apps/api/tests/engine/WorkflowEngine.outputSurface.test.ts` (new).

**Verified.** Typecheck clean across core/api/web. Tests green: new
`WorkflowEngine.outputSurface.test.ts` + existing engine/route/schema suites
(31 + 6 db tests).

---

### 2026-05-22 -- Layer 1 Workspace Intelligence + Workspace Volume + native browser node

**Context.** Three tightly-coupled subsystems: Workspace Volume (the filesystem the
other two stand on), Layer 1 Workspace Intelligence (RC1), and the native `browser`
node (finishes the Hello-World demo).

**Shipped.**
- **Workspace Volume** -- `WorkspaceVolumeService` with read/write/append/list/
  scaffold, single path-escape chokepoint (`WORKSPACE_VOLUME_PATH_ESCAPE`), and
  conventional directory structure.
- **Layer 1 Workspace Intelligence** -- `WorkspaceIntelligenceService` reads
  `context/{WORKSPACE,MEMORY,DECISIONS}.md`, seeds defaults on first read, parses
  MEMORY.md structured entries, scores them
  (recency*0.40 + usage*0.35 + workflowMatch*0.25), assembles context within token
  budget. Injected into every `agent_task` prompt (engine-level, not adapter-level)
  and into `build_workflow` LLM synthesis.
- **Context API** -- `GET/PUT /v1/workspace-context[/:file]`.
- **Native browser node** -- `BrowserPool` with on-demand Chromium auto-install
  (single-flight via Playwright CLI). Operations: `serve_html`, `screenshot`, `pdf`,
  `navigate`, `extract_text`. Screenshots/PDFs persisted as `data:`-URL artifacts.

**Files touched.** New: `services/workspaceVolume.ts`,
`services/workspaceIntelligence.ts`, `services/browserPool.ts`,
`routes/workspaceContext.ts`, + 3 test files. Edited:
`packages/core/src/{types,schemas}/workflow.ts`, `packages/core/src/errors.ts`,
`apps/api/src/engine/{WorkflowEngine,validateGraph}.ts`, `bootstrap.ts`,
`services/agentisToolHandlers/{deps,build}.ts`.

**Verified.** Playwright + Chromium installed (exit 0). Typecheck clean. 102 tests
across 15 files: real-Chromium PNG screenshot (magic-byte check), MEMORY.md
parse/score/select, Volume path-escape guard, and full engine e2e
(`trigger -> transform -> browser(serve_html) -> return_output(html)` completing
with a persisted image artifact and the HTML flowing through).
**The literal "Hello World in a browser" path now works end-to-end.**

---

### 2026-05-22 -- Full codebase audit (establishes SS0)

**Context.** Before continuing with new feature work, performed a systematic code
audit to establish accurate baseline state. The earlier masterplan text contained
several factual errors about what was and wasn't built. SS0 of this document records
the findings and supersedes all prior status claims.

**Key corrections from audit.**

1. **SS3.3 previously claimed connectors were "completely disconnected from the
   engine."** WRONG. `ConnectorRegistry` is wired in `bootstrap.ts`, `CredentialVault`
   decrypts at dispatch, `#executeIntegration()` routes to the registered connector.
   All Phase 2 integration nodes are complete.

2. **`SpecialistAgentService` is fully implemented** (idempotent seed, `ensureRole`,
   `resolveRole`, `ensureAll`, `list`). The one missing wire: `#dispatchAgentTask()`
   never calls `specialists.ensureRole()`. `EngineDeps.specialists` is declared and
   injected but the call is absent -- a one-line fix that unblocks the entire
   specialist role system.

3. **All Phase 2 node library items are implemented.** The plan was written as if
   they needed to be built; they don't. Filter, wait, http_request, loop, parallel,
   error edges, integration, evaluator, guardrails, agent_swarm -- all pre-existing.

4. **`WorkflowPhase` is cosmetic only** -- confirmed directly in
   `packages/core/src/types/workflow.ts`. Phase is `{id, name, color, nodeIds,
   collapsed}`. No SLA, humanGate, or budgetCents.

5. **`buildWorkflowDraft()` regex fallback is weak** -- confirmed. LLM synthesis path
   confirmed evaluator-env-gated. Unlocking for all installs via a new
   `WORKFLOW_SYNTHESIS_MODEL` env var is a small config change.

6. **Canvas is substantially built**: `ContextInspector`, `NodePalette`, `RunDrawer`,
   `VariablePicker`, `PhaseLayer`, `NodeTestRunner`, `AgentisEdge`, `SkillCombobox`,
   `TemplatedTextField`, `WorkflowContractsPanel` all exist in
   `apps/web/src/components/canvas/`.

**No files changed.** Audit only. SS0 and all phase tables updated in this document.

**Next priorities in order:** *(item 1 below was completed 2026-05-22 -- see the
latest Implementation Log entry; remaining order stands)*
1. ~~Wire `agentRole` dispatch~~ -- **DONE 2026-05-22.**
2. Ungate `build_workflow` LLM synthesis from evaluator env vars (new
   `WORKFLOW_SYNTHESIS_MODEL`) -- S effort, raises complex success rate from ~25% to ~70%.
3. Phase 3 -- Intent extractor + 8 workflow templates.
4. Phase 3 -- Planner agent with HTN planning + Phase Cards.
5. Phase 3 -- agentic tool-use execution loop (grant + run `ROLE_TOOLS` at dispatch).

---

### 2026-05-22 -- Layer 2 specialist library + `agentRole` dispatch + canvas wiring + North Star

**Context.** Closed the doc's #1 priority (the missing `agentRole` wire), made the
three new Layer-6/3 nodes actually usable on the canvas (palette + inspector), and
added the strategic frame the platform was missing -- the *semi-deterministic engine*
thesis -- per the directive to evolve the plan toward an era-defining vision.

**Shipped -- Layer 2 (specialist agents).**
- Core: new `packages/core/src/types/specialist.ts` -- `AgentRole` (10 roles),
  `AgentTool` + `ROLE_TOOLS`, `SPECIALIST_AGENTS` definitions (role, system prompt,
  capability tags, default model, tool manifest), `specialistForRole()`. Exported via
  `types/index.ts`. `agentRole` added to `AgentTaskNodeConfig` + `AgentSwarmNodeConfig`
  + Zod enum.
- `SpecialistAgentService` -- idempotent seed (`ensureAll`), `ensureRole` (create on
  first use), `resolveRole`, `list`. Seeds DB rows keyed by `role`, `offline`.
- Engine: `#dispatchAgentTask()` resolves `agentRole` -> `ensureRole()` when no
  `agentId`; composes the preamble as **role identity -> workspace context -> task
  prompt** (`#withWorkspaceContext` refactored to accept a role prefix). `validateGraph`
  accepts `agentRole` as a valid binding. Wired `specialists` into `EngineDeps` +
  bootstrap.
- `build_workflow` emits `agentRole` (inferred: reviewer/coder/analyst/researcher/
  writer) on generated agent tasks instead of leaving `agentId` blank, and teaches the
  synthesis prompt the role set.

**Shipped -- canvas wiring (the "wire it or it's nothing" fix).**
- `NodePalette`: new "Output & native" tier with `return_output`, `artifact_save`,
  `browser`. `WorkflowNode` glyphs for all three.
- `ContextInspector`: full per-kind forms -- `ReturnOutputForm` (renderAs/title/
  valuePath), `ArtifactSaveForm` (name/type/contentPath/titlePath), `BrowserForm`
  (operation-aware: url/html/htmlPath/selector/headless). KIND_LABEL entries added.
- Fixed an FK foot-gun: `#persistArtifact` nulls the `run_id` for synthetic `test-…`
  runs so the canvas "Test this node" dry-run on `artifact_save`/`browser` doesn't
  trip the artifacts FK.

**Shipped -- plan (this doc).**
- New **North Star -- The Semi-Deterministic Engine** section: reasoning bounded by a
  deterministic cage; the determinism dial (earned autonomy), reasoning budget
  (bounded non-determinism), and deterministic replay as first-class capabilities.
- New Principles #12-#14 (bound every reasoning step / autonomy is earned / runs
  reproducible by construction).
- Reconciled the specialist role divergence: §1.2 now reflects the 10 shipped roles
  with real `ROLE_TOOLS`, framing `ops/qa/designer/security/data_engineer` as the
  Phase-3 business-sector expansion (the sets converge on a superset).
- Flipped stale statuses (Gap 1, §2.2 known-gap, Phase 3 rows, §0 phase line, audit
  next-priorities).

**Files touched.** New: `packages/core/src/types/specialist.ts`,
`apps/api/src/services/specialistAgents.ts`,
`apps/api/tests/services/specialistAgents.test.ts`. Edited:
`packages/core/src/types/{index,workflow}.ts`,
`packages/core/src/schemas/workflow.ts`,
`apps/api/src/engine/{WorkflowEngine,validateGraph}.ts`, `bootstrap.ts`,
`services/agentisToolHandlers/build.ts`,
`apps/web/src/components/canvas/{NodePalette,WorkflowNode,ContextInspector}.tsx`.

**Verified.** Typecheck clean across core/api/web. Tests green: new
`specialistAgents.test.ts` (idempotent seed, ensureRole stability, resolveRole) +
schema suite. Engine `agentRole` resolution covered by typecheck + the resolver path;
full role *execution* still requires a connected adapter (specialists seed `offline`).

**Deferred / next.** Agentic tool-use execution loop for `ROLE_TOOLS`; `.md` agent +
skill filesystem (Principle #11); ungate `build_workflow` synthesis; Planner/HTN.

---

### 2026-05-22 -- Layers 4/5/7 batch: Tier-3 KV, audit trail, phase governance, instinct engine, browser ops, synthesis ungate

**Context.** "Finish the whole implementation e2e." Drove the remaining backend
masterplan in six verified slices, each typechecked + tested before the next. All
slices are deterministic/self-contained and avoid the in-flight adapter refactor.

**Shipped.**
- **Tier-3 Workspace KV (§4.1, Gap 8).** `workspace_kv` table (+ embedded SQL),
  `WorkspaceStoreService` (get/set/delete/increment/append/snapshot), `workspace_store`
  node (engine handler + schema + validator + palette-eligible), and the
  `{{workspace.kv.*}}` + `{{run.*}}` template namespaces wired into the resolver and
  `#buildTemplateContext`. Cross-run + cross-workflow shared state.
- **Audit trail (§5.4, Principle #7).** `audit_entries` table, `AuditTrailService`
  (best-effort, never blocks a run), engine recording at run + node lifecycle
  (run.started/completed/failed, node.started/completed/failed) with phase + actor +
  cost attribution, and `GET /v1/runs/:runId/audit`.
- **Phases as execution primitives (§5.1-5.3, Gap 5).** `WorkflowPhase` extended with
  `slaDurationMs`/`budgetCents`/`humanGate`/`successCriteria`; node `estimatedCostCents`.
  Engine tracks phase start (PHASE_STARTED), arms an SLA timer (PHASE_SLA_BREACHED on
  breach -- alerts, does not kill), accrues per-node cost, and **halts the run**
  (BUDGET_PHASE_EXCEEDED -> FAILED) when a phase exceeds its budget; PHASE_COMPLETED on
  finish. New events added to core.
- **Instinct engine (§7.2, Gap 7).** `InstinctEngine.onRunFailed()` runs after a FAILED
  run, classifies the root cause, counts same-node+same-cause failures across recent
  runs, and at threshold writes a scored entry to MEMORY.md + emits INSTINCT_PROPOSED.
  This is the "autonomy is earned" dial (Principle #13) made concrete. V1 proposes;
  auto-patch via `applyGraphPatch` is the follow-up.
- **Browser `fill_form` + `extract_table` (Gap 9).** BrowserPool methods (form fill with
  read-back values; table → row objects via page evaluate), node ops + schema + validator
  + inspector form fields.
- **`build_workflow` synthesis ungate (§6, Gap 2).** New `WORKFLOW_SYNTHESIS_MODEL` /
  `_BASE_URL` / `_API_KEY` env + a dedicated synthesis runtime in bootstrap; synthesis
  prefers it, falls back to the evaluator runtime, regex only when neither is set --
  decoupling LLM synthesis from the evaluator gate.
- New error codes already covered; updated the two golden-path tests to the
  `trigger → transform → return_output` shape build_workflow now emits.

**Files touched.** New: `services/workspaceStore.ts`, `services/auditTrail.ts`,
`services/instinctEngine.ts`, `routes/audit.ts`, + 3 engine/service test files. Edited:
`packages/db/src/sqlite/{schema,embedded-sql}.ts`,
`packages/core/src/{events.ts, types/workflow.ts, schemas/workflow.ts}`,
`apps/api/src/engine/{WorkflowEngine,validateGraph,templateResolver}.ts`,
`apps/api/src/services/{browserPool, agentisToolHandlers/{deps,build}}.ts`,
`apps/api/src/{env,bootstrap}.ts`,
`apps/web/src/components/canvas/ContextInspector.tsx`, + golden-path tests.

**Verified.** Typecheck clean across db/core/api/web. Full regression green:
db (6) + api engine/services/core/workflows (318 total, all passing after the two
intended golden-path shape updates). New focused suites: tier3+audit (2), phase
budget+SLA (2), instinct (2), browser ops (4).

**Honest remaining (NOT done this turn).** The Layer 6 *full* viewer registry
(DataTable/PDF/Codebase/Dashboard/Image/Video/Audio viewers -- HTML+Markdown+artifact
grid already ship); the agentic **tool-use execution loop** that grants + runs
`ROLE_TOOLS` at dispatch (depends on the in-flight orchestrator function-calling
runtime); the `.md` agent/skill filesystem (Principle #11) + skill injection; MCP
publication; Git sync; analytics dashboard; `serve_project`/WebsitePreview; output
gallery extras (pin/share/re-run). These remain genuinely unbuilt -- the platform is
substantially further along but not 100% of all six phases.

---

### 2026-05-22 -- Layer 6 viewers, skill protocols, template library, analytics

**Context.** "Finish with excellence -- big batch." Five more polished, verified slices,
each typechecked + tested, continuing to avoid the in-flight orchestrator path.

**Shipped.**
- **Layer 6 viewer registry (§6.1-6.2).** `OutputViewers.tsx`: production-grade
  `DataTableViewer` (sort, global filter, pagination, CSV/JSON export, sticky header),
  `ImageViewer` (lightbox + zoom + keyboard), `PdfViewer` (iframe + download),
  `CodeViewer` (line numbers + copy). Wired into `RunOutputCard` (renderAs:table →
  interactive DataTable) and `WorkflowArtifactGrid` (per-type inline preview via an
  `ArtifactPreview` dispatcher). HTML + Markdown were already done.
- **Behavioral skill protocols (§2.5, Principle #11).** Core `PLATFORM_SKILLS` (7 skills:
  tdd-protocol, owasp-checklist, aarrr-framework, statistical-testing, adr-format,
  code-review-rubric, api-design-guidelines). `SkillLibraryService` seeds them as
  `skills/*.md` on the Volume (operator edits win over defaults), parses frontmatter, and
  builds a token-budgeted injection block. `agent_task.skills` added; the engine injects
  the skill block between workspace context and the task prompt (role → context → skills →
  task).
- **Intent extractor + template library (§6.1 Steps 2-3).** `build_workflow` now infers
  the trigger (manual/cron/webhook + schedule) and matches deterministic templates
  (research→analyze→write report; review pipeline; collect→summarize) into multi-specialist
  `agentRole` pipelines *before* any LLM call -- richer graphs without a model.
- **Workspace analytics (§7.1).** `GET /v1/workflows/:id/analytics` -- run counts,
  status breakdown, success rate, avg duration, avg/total cost (from the audit trail), and
  the per-node failure breakdown (with sample errors) that feeds optimization suggestions.

**Files touched.** New: `apps/web/src/components/workflows/OutputViewers.tsx`,
`packages/core/src/types/skillProtocol.ts`, `apps/api/src/services/skillLibrary.ts`,
`apps/api/src/routes/analytics.ts`, + 2 test files. Edited:
`packages/core/src/types/{index,workflow}.ts`, `packages/core/src/schemas/workflow.ts`,
`apps/api/src/engine/WorkflowEngine.ts`,
`apps/api/src/services/agentisToolHandlers/build.ts`, `apps/api/src/bootstrap.ts`,
`apps/web/src/components/workflows/{RunOutputCard,WorkflowArtifactGrid}.tsx`, + golden tests.

**Verified.** Typecheck clean across db/core/api/web. **305 tests pass across 50 files**
(engine + services + core), incl. new suites: skillLibrary (3), build-template pipeline (1).

**Honest remaining after this batch.** Phase human-gate *enforcement* (schema + SLA/budget
done; gate-pause needs the approval-resolution wiring -- deferred to avoid touching that
path mid-change); the agentic **tool-use execution loop** for `ROLE_TOOLS` (in-flight
orchestrator dependency); full **agent `.md` identity** (skills are file-based; agent
identity is still DB rows); remaining Layer 6 viewers (Codebase/Dashboard/Video/Audio);
MCP publication; Git sync; `serve_project`/WebsitePreview; analytics *dashboard UI*
(backend done); output gallery actions (pin/share/re-run); instinct auto-patch. The
backend execution fabric (Layers 1-5 + 7-instinct) is now substantially complete; the
largest remaining frontier is the agentic tool-use loop, gated on the orchestrator refactor.

---

### 2026-05-22 -- Phase human-gate enforcement (Layer 5 §5.1 completed)

**Context.** Closed the last open task. Human gates now actually pause and resume runs.

**Shipped.**
- **Gate hold.** `#maybeHoldForPhaseGate` runs before a node starts: if the node's phase
  has a `humanGate` and it isn't granted, the node is marked WAITING, its ready item is
  stashed, and a `phase_gate` approval is created. Downstream nodes stay in waitingInputs,
  so the run settles to **WAITING** (not COMPLETED) — exactly the checkpoint pattern.
- **Resume / fail.** `engine.resolveApproval({runId, approvalId, decision})` is the single
  entry point the approval-resolution wiring calls. Approve → `resumePhaseGate` re-enqueues
  the held nodes and ticks; reject → `failRunForGate` skips open nodes and fails the run.
  Audit entries: `human_gate.requested` / `.approved` / `.rejected`.
- **Latent bug fixed.** Checkpoint resume previously stashed the node id in
  `approval.task_id`, which carries a `tasks` FK (insert would throw). Resume targets
  (checkpoint node id / phase id) are now tracked in-memory by approval id; `task_id` stays
  null. The bootstrap + chat approval paths route through `resolveApproval`.

**Files touched.** `apps/api/src/engine/WorkflowEngine.ts` (gate hold/resume/fail +
`pendingApprovals` map), `apps/api/src/services/approvalInbox.ts` (resume handler carries
source + decision; fires for `phase_gate`), `apps/api/src/bootstrap.ts` (single
`resolveApproval` binding), + `WorkflowEngine.humanGate.test.ts` (new).

**Verified.** Typecheck clean (db/core/api/web). **239 engine + services tests pass across
46 files**, incl. the new gate suite (pause→approve→complete; pause→reject→fail). With this,
**every task in the batch plan is complete** and Layer 5 (phases / SLA / budget / gates /
audit) is done end-to-end. Remaining frontier unchanged: the agentic tool-use execution
loop (orchestrator-gated), remaining Layer 6 viewers + serve_project, MCP, Git sync,
analytics dashboard UI, agent `.md` identity, instinct auto-patch.

---

### 2026-05-23 — Role tool runtime, instinct auto-patch, MCP publication (+ creation engine in parallel)

**Context.** Worked the masterplan and the new `ORCHESTRATOR-CREATION-10X.md` in parallel
(creation pipeline logged in that doc). Masterplan items closed this pass:

- **AgentToolRuntime (§2.2.1)** — `services/agentToolRuntime.ts`: the sandboxed `ROLE_TOOLS`
  execution layer with the security boundaries — `read_file`/`write_file` scoped to the Volume
  (path-escape + `.env`/`.git` blocked), `run_code` via the Transform sandbox, `search_code`,
  `knowledge_search`, `read_url` (SSRF guard), role-manifest enforcement. The substance of role
  tools; the LLM function-calling loop that *drives* it stays orchestrator-gated.
- **Instinct auto-patch (§7.2)** — `InstinctEngine.applyInstinct()`: applies an approved instinct
  to the stored workflow graph (insert a truncation transform + rewire for `context_too_long`;
  retry/timeout hardening for `rate_limit`/`timeout`), validates, and records the fix to MEMORY.
- **MCP publication (§5)** — `routes/mcp.ts`: publish / list / run-and-return (see §5).
- Phase **human-gate enforcement** completed earlier this session is also done end-to-end.

**Verified.** Typecheck clean across db/core/api/web. **343 api tests across 55 files** green,
incl. new suites: `agentToolRuntime` (security boundaries + role manifest), `instinctEngine`
auto-patch, `routes/mcp` (publish→list→run).

**Remaining frontier.** The agentic tool-use **loop** (orchestrator-gated); remaining Layer 6
viewers (Codebase/Dashboard/Video/Audio) + `serve_project`/WebsitePreview; Git sync; the
analytics + creation dashboards; agent `.md` identity; and — from ORCHESTRATOR-CREATION — the
amber Integration Wiring UI (§7) and the Builder Session (§9), which are the headline creation
differentiators.

---

### 2026-05-23 — Tool-use loop, agent `.md` identity, workspace/day budget, pin, media viewers, Phase Cards

**Context.** Closing out the remaining masterplan + ORCHESTRATOR-CREATION frontier in one
verified pass (each slice typechecked + tested before the next). The earlier "orchestrator-gated"
caveat on the tool-use loop is now retired — it didn't need a function-calling runtime.

**Shipped — masterplan.**
- **Agentic tool-use execution loop (§2.2) — DONE.** `AgentToolLoop` (`services/agentToolLoop.ts`):
  a bounded ReAct loop over the role-scoped `AgentToolRuntime`. Each step the LLM returns one JSON
  decision (`{action:"tool",tool,args}` / `{action:"final",output}`); the loop runs granted tools
  (manifest-enforced), feeds observations back, caps steps (default 6/max 12). Provider-agnostic —
  reuses `EvaluatorRuntime.completeStructured` (JSON mode), so **no orchestrator dependency**. Wired
  into the engine: `agent_task` with `useRoleTools:true` + `agentRole` runs in-process (no external
  adapter) and completes synchronously. New `AgentTaskNodeConfig.useRoleTools`/`maxToolSteps`
  (type + zod). Canvas toggle in the AgentTask inspector. `TOOL_DESCRIPTIONS` added to core.
- **Principle #11 agent `.md` identity — DONE.** `AgentLibraryService` is now wired (bootstrap +
  `ToolHandlerDeps.agentLibrary`). Platform specialists export to `agents/platform/<role>.md`;
  operator `agents/custom/*.md` roles flow into creation casting via
  `buildWorkspaceInventory` → `listCustomRoles` — no engine change (as designed).
- **Workspace/day budget ceiling (§5.3) — DONE.** `workspaces.daily_budget_cents` (schema +
  embedded-sql + idempotent ALTER). Engine `#workspaceDailyBudgetExceeded` sums
  `AuditTrailService.workspaceSpendSince(midnightUTC)` after each node; over-cap halts FAILED +
  `BUDGET_WORKSPACE_EXCEEDED`. `PATCH /v1/budgets/workspace` set/clear; `GET /v1/budgets` reports
  cap + today's spend.
- **Pin to workspace (§6.4) — DONE.** `artifacts.pinned` column + `POST /v1/artifacts/:id/pin` +
  `?pinned=true` list filter.
- **Layer 6 viewers — Video + Audio DONE.** `VideoPlayer` (playback-rate + download) + `AudioPlayer`
  added to `OutputViewers.tsx` and the `WorkflowArtifactGrid` dispatcher (data:/extension detection).
- **Phase Cards (Builder §9 Step 2) — DONE.** `PhaseCards.tsx` renders the Planner's `WorkflowPlan`
  (named phases, cast specialist, cost range, approve). `POST /v1/workflows/plan` exposes the plan
  over HTTP; a "Plan" preview slide-over on the workflow canvas calls it.

**Files touched.** New: `services/agentToolLoop.ts`, `services/agentLibrary.ts` (wired this pass),
`components/workflows/PhaseCards.tsx`, + 4 test files (`agentToolLoop`, `agentLibrary`,
`WorkflowEngine.agentToolLoop`, `WorkflowEngine.workspaceBudget`, `routes/budgetPinRoutes`). Edited:
`packages/core/src/{events,types/{specialist,workflow},schemas/workflow}.ts`,
`packages/db/src/sqlite/{schema,embedded-sql,index}.ts`,
`apps/api/src/{bootstrap,engine/WorkflowEngine,services/{auditTrail,budget},routes/{budgets,artifacts,workflowIo},services/agentisToolHandlers/deps}.ts`,
`apps/web/src/{components/canvas/ContextInspector,pages/WorkflowCanvasPage,components/workflows/{OutputViewers,WorkflowArtifactGrid}}.tsx`.

**Verified.** Typecheck clean across db/core/api/web. **Full api suite green: 649 tests / 115 files**
(incl. new loop/library/budget/pin/plan suites; two stale `approvalInbox` tests updated to the
human-gate behavior where the resume handler fires on both approve and reject).

**Honest remaining (the real frontier).** The full **Builder Session split-pane** (§9): live
animated canvas build (Step 3), inline per-phase re-synthesis (`[edit]`), and the specialist roster
panel — Phase Cards (Step 2) and the amber wiring node (§7) ship, but the streaming co-author
experience is still assembled from parts, not one mode. Remaining Layer 6 viewers
(Codebase/Dashboard/WebsitePreview/Deployment/APIExplorer) + `serve_project`. Analytics / cost /
creation **dashboards** (backends exist; UIs don't). Per-run workflow budget tier. Git sync. Share
(signed URL) + re-run output actions. UI changes here are typecheck-verified but not browser-driven
this pass (no seeded authenticated canvas available).

---

### 2026-05-23 (batch 2) — Builder Session split-pane, per-run budget tier, viewer registry, analytics UI

**Context.** Continued to "100%": built the Builder Session as a real mode, completed the budget
cage, finished the bulk of the Layer 6 viewer registry, and shipped the analytics dashboard UI.

**Shipped.**
- **Builder Session (ORCHESTRATOR-CREATION §9) — split-pane page.** New `/workflows/build`
  (`WorkflowBuilderPage`, "Build with AI" on the Workflows page): left = describe → `PhaseCards`
  (live cost) → specialist roster; right = live canvas (`CanvasEmbed`) that animates the graph in
  from streamed `CANVAS_*` events. Backed by a refactor: the `build_workflow` tool body is extracted
  into the exported `createWorkflowFromDescription` (shared core) and exposed over HTTP at
  `POST /v1/workflows/build` (full pipeline + streaming). `build_workflow` tool now calls the shared fn.
- **Per-run workflow budget (§5.3) — the middle tier.** `workflows.budget_cents` (schema +
  embedded-sql + idempotent ALTER) + engine `#workflowRunBudgetExceeded` (accrues `ctx.runCostCents`,
  caches the cap, halts FAILED + `BUDGET_RUN_EXCEEDED`). §5.3 is now DONE across all three tiers.
- **Layer 6 viewers.** `DiffViewer` (colorized unified diff), `CodebaseViewer` (file tree + code),
  `DashboardViewer` (dependency-free bar chart), `WebsitePreview` (address bar + iframe), plus
  `dashboardSpecFrom`/`filesFrom` parsers — all wired into the `WorkflowArtifactGrid` dispatcher
  (data-shape / content detection). With Video+Audio (batch 1), only Deployment/APIExplorer +
  `serve_project` live-hosting remain planned.
- **Analytics dashboard UI (§7.1).** "Analytics" slide-over on the canvas consumes
  `GET /v1/workflows/:id/analytics` — stat tiles (runs, success %, avg/total cost, avg duration) +
  `DashboardViewer` for runs-by-status and failures-by-node.
- **§7 integration counter.** Canvas toolbar chip: "N integrations need setup" (counts amber
  pending-config nodes).

**Files touched.** New: `apps/api/src/routes/workflowBuild.ts`,
`apps/web/src/pages/WorkflowBuilderPage.tsx`, + `tests/routes/workflowBuild.test.ts`. Edited:
`apps/api/src/services/agentisToolHandlers/build.ts` (extract `createWorkflowFromDescription`),
`apps/api/src/{bootstrap,engine/WorkflowEngine}.ts`,
`packages/{core/src/events,db/src/sqlite/{schema,embedded-sql,index}}.ts`,
`apps/web/src/{App,pages/{WorkflowsPage,WorkflowCanvasPage},components/workflows/{OutputViewers,WorkflowArtifactGrid}}.tsx`,
+ `tests/engine/WorkflowEngine.workspaceBudget.test.ts` (run-budget case).

**Verified.** Typecheck clean across db/core/api/web. New/changed suites green: `workflowBuild`,
`workflowIo` (plan), budget tiers (phase/run/workspace). Full api regression suite re-run to confirm
no regressions from the `build_workflow` extraction + schema columns.

**Honest remaining.** Inline per-phase `[edit]` re-synthesis + model/specialist swap in the Builder
(rebuild a single phase), the "why this node?" explanation, Cmd+B keybinding; `serve_project`
live-from-Volume hosting; Deployment/APIExplorer/Archive viewers; Git sync; Share (signed URL) +
"re-run with changes" output actions; inline OAuth in the wiring panel. Web verified by typecheck,
not browser-driven (no seeded authenticated canvas this pass).

---

### 2026-05-23 (batch 3) — Builder polish, last viewers, output actions, team roster, Cmd+B

**Context.** Drove the remaining frontier checkboxes to closure where tractable; documented the few
that need architectural changes (per-phase re-synthesis, OAuth, git sync) honestly.

**Shipped.**
- **§6 viewer registry — now ~complete.** `DeploymentCard` (live URL + health badge + iframe) and
  `APIExplorer` (OpenAPI operations list) added to `OutputViewers.tsx` with `deploymentSpecFrom` /
  `openApiFrom` parsers, wired into the artifact dispatcher (highest-specificity first). Only
  Archive (zip) + `serve_project` live-hosting remain.
- **§6.4 Re-run output action.** "Re-run" on the Output tab's last-run header (reuses the run path).
- **§9 "why this node?"** — `NODE_REASON` rationale shown under the node heading in `ContextInspector`.
- **§9 Cmd/Ctrl+B** — opens the Builder Session from the workflow canvas.
- **§3 Team Roster before the graph streams** — new `WORKFLOW_TEAM_ROSTER` event emitted by
  `createWorkflowFromDescription` before node streaming; the Builder shows the cast (role + online/offline
  + fallback) live, fulfilling "operator sees the team before the graph appears".
- **Builder polish** — `PhaseCards` now shows a **live approved-cost subtotal** (updates as phases are
  approved) and a **plan export** (download the `WorkflowPlan` as JSON, ORCH Phase 5).

**Files touched.** `packages/core/src/events.ts`,
`apps/api/src/services/agentisToolHandlers/build.ts`,
`apps/web/src/{pages/{WorkflowCanvasPage,WorkflowBuilderPage},components/canvas/ContextInspector,
components/workflows/{OutputViewers,WorkflowArtifactGrid,PhaseCards,WorkflowOutputTab}}.tsx`.

**Verified.** Typecheck clean (core/api/web). Build-path suites green (`chatGoldenPath`,
`agentisChatTools` build fallback, `workflowBuild`); full api regression re-run after the additive
`WORKFLOW_TEAM_ROSTER` emit.

**Genuinely remaining (needs architecture or heavy infra — documented, not faked).**
Per-phase `[edit]` re-synthesis + specialist/model swap (requires a **plan-driven build**: the build
re-synthesizes from the raw description today, so plan edits don't flow through — a real change to
make the graph plan-authored). Inline OAuth "Sign in with X" (OAuth infra). `serve_project`
live-from-Volume hosting. Git sync. Share via signed URL + "re-run with changes". OutputGallery
zip/share-bundle, Volume Explorer, All-Runs timeline, cross-run diff. Workspace Orchestrator
background monitor. Community marketplace. InstinctEngine → synthesis-template feedback. These are
the honest long-tail; the platform's creation + execution + output spine is complete.

---

### 2026-05-23 (batch 4) — Plan-driven build + inline OAuth

**Context.** Closed the two items the batch-3 log flagged as the foundational architectural gaps.
Full detail in `ORCHESTRATOR-CREATION-10X.md` (batch 4); summary here for the masterplan record.

- **Plan-driven build** — `assembleGraphFromPlan` (build.ts) assembles the graph deterministically
  from an approved/edited plan (one node per Phase Card → real graph phases); `POST /v1/workflows/build`
  + the tool accept an optional `plan`; `PhaseCards` is editable (instructions/specialist/model) and the
  Builder round-trips the edit → rebuild. This is the spine of the Builder co-author loop.
- **Inline OAuth (§7 / credentials)** — `OAuthService` + `/v1/oauth/{providers,authorize,callback}`:
  Google/Slack/GitHub auth-code flow, single-use TTL state, tokens encrypted via the CredentialVault
  into a workspace credential; "Sign in with X" on the amber node mints + binds it without leaving the
  canvas. New env: `AGENTIS_PUBLIC_URL` + `OAUTH_*`.

**Verified.** Typecheck clean (db/core/api/web). New suites green: `oauth`, plan-driven `workflowBuild`;
full api regression green (a later dot-reporter re-run hit a Node OOM — tooling, not a test failure).
