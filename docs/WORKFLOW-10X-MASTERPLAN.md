# Agentis Workflow Engine — 10x Masterplan
## The Definitive Agentic Execution Platform for the Enterprise

> **Status:** Architecture plan — P0 Strategic Initiative
> **Date:** May 22, 2026
> **Scope:** Complete architectural rethinking — from automation tool to coordinated multi-agent execution fabric capable of running entire company sectors autonomously
> **References:** `WORKFLOW-REPLAN.md`, `ENGINE-10X.md`, `CHAT-10X-VISION.md`, `PLATFORM-VISION.md`, `AGENTS-10X-REPLAN.md`, `MULTI-AGENT-UX.md`, `ORCHESTRATOR.md`

---

## 0. The Brutal Honest Diagnosis

### 0.1 The Immediate Symptom

A user typed: *"create a workflow that opens a browser and shows Hello World"*.

Six tool calls. Four minutes. `finishReason: "error"`. Nothing opened. A Windows process kill because the agent ran out of ideas after repeatedly re-generating the same regex-produced graph.

That is embarrassing. But the Hello World failure is a **symptom**, not the disease. We could fix Hello World in a week. That would not fix anything meaningful.

### 0.2 The Real Disease

The real disease is that Agentis's workflow engine was architected as a **step sequencer** — a flowchart runner where a human draws boxes and arrows and agents execute them. That is n8n with LLM nodes stapled on. It is a fine V0, but it is not a platform that automates sectors of companies.

What every serious agentic platform is converging on — Claude Code, Codex, ECC (153,000+ stars on GitHub), OpenAI Operator, Devin — is something structurally different: **an orchestrated agent economy where a planning layer decomposes goals into hierarchical task networks, delegates to specialized agents, manages budgets and timelines, remembers decisions across sessions, and self-improves from observed patterns**.

The critical insight from Karpathy's CLAUDE.md going viral with 82,000 stars: developers spend $975/week per developer just *repeating themselves to AI* because there is no persistent workspace context. One file an agent reads at the start of every session eliminates that. Agentis must provide this natively.

The critical insight from ECC (the Anthropic hackathon winner): a solo founder with the right agent setup ships like a team of 3–4 people. Not because the AI is smarter. Because the **setup is right** — agents carry persistent context, a Planner breaks goals into structured phases and delegates to specialists, skills activate contextually, and the system builds "instincts" by observing session patterns over time.

### 0.3 What "Automating a Company Sector" Actually Means

When a company wants to automate its software development lifecycle, here is what a real workflow looks like:

```
GOAL: "Ship v2.1 of the payment service by end of sprint"

Phase 0 — Discovery (Day 1)
  [Planner Agent]
    read WORKSPACE.md (tech stack, conventions, architectural decisions)
    read MEMORY.md (previous sprint learnings, what failed, what worked)
    produce: Phase Plan with SLAs, agent assignments, budget breakdown
  [Human Gate: Approve plan]

Phase 1 — Requirements (Days 1-2)
  [Requirements Agent] uses: GitHub Issues, Notion
    summarize open issues tagged v2.1
    generate requirements doc
    identify technical risks
  [Architecture Agent] uses: codebase analysis, DECISIONS.md
    propose system design
    validate against existing architectural decisions
  [Human Gate: Approve spec]

Phase 2 — Implementation (Days 3-8, parallel fan-out)
  [parallel: N Feature Agents, one per feature]
    each reads: feature spec + WORKSPACE.md conventions
    each: writes code -> runs tests -> opens PR
  [Code Review Agent] runs per PR: security scan + quality gate + style
  [Security Agent] runs per PR: OWASP Top 10 scan
  condition: all PRs pass -> Phase 3
  condition: any PR fails -> evaluator-retry with critique (max 3 attempts)
  condition: 3 failures -> escalate to human

Phase 3 — Integration (Day 9)
  [Integration Agent]
    merge all branches
    run full test suite
    generate migration scripts
  condition: tests green -> Phase 4
  condition: tests red -> diagnose + fix (2h budget) -> re-run
  condition: 2h exceeded -> alert human + pause

Phase 4 — Release (Day 10)
  [Deploy Agent]
    deploy to staging -> smoke tests
    [Human Gate: Production deploy approval]
    deploy to production -> wait 10min -> check error rates
  condition: error rate < 0.1% -> success + notify team
  condition: error rate > 0.1% -> auto-rollback + alert

Phase 5 — Monitor (Ongoing)
  [Monitor Agent] schedule: every 15min
    check error rates, latency, business metrics
    anomaly detected -> wake [Diagnose Agent]
    weekly: generate performance report -> Slack + PDF artifact
```

**This is 20+ specialized agents, 5 phases, parallel execution, conditional branching, human gates, SLA tracking, budget governance, self-healing, persistent memory, and a 10-day execution window.** No current Agentis workflow can express this. This is what we need to build.

### 0.4 The Five Root Causes

| # | Root Cause | Consequence |
|---|-----------|-------------|
| RC1 | No workspace persistent context | Agents start from zero every task. No memory of decisions, stack, or conventions. Every run rediscovers the same facts. |
| RC2 | No planning layer | Complex requests produce a single linear chain. No phase decomposition, no parallel execution, no specialist delegation. |
| RC3 | No specialist agent library | Every task goes to a generic agent. No security reviewer, no data analyst, no architect. The planner has no team to delegate to. |
| RC4 | No long-running workflow architecture | Workflows designed for single-session execution. No phase gates, no cross-session state, no SLA tracking, no budget accumulation. |
| RC5 | No self-improvement | System doesn't learn from runs. Patterns that failed 10 times still fail the 11th. There is no instinct layer. |

Fixing Hello World addresses none of these. This plan addresses all of them.

---

## 0.5 Current-State Audit & Reconciliation (2026-05-22)

> Added during implementation. The "Brutal Diagnosis" above was written as if the
> engine were a bare step-sequencer. The actual codebase is **much further along** —
> this section reconciles the plan with what the code already does so we build the
> *real* gaps, not the imagined ones. Source of truth is the code, not §0.

**Already implemented & wired** (don't rebuild these):

| Plan area | Reality in code |
|-----------|-----------------|
| Deterministic nodes (transform/filter/http/wait/loop/parallel/router/merge) | ✅ All present in `WorkflowEngine.ts` + `types/workflow.ts`. `transform`/`filter` use a sandboxed `safeExpression`; `wait` persists `wakeAt` and is crash-recoverable; `loop` is chunked + concurrent via `SubflowExecutor`. |
| Integration node + ConnectorRegistry | ✅ `integration` node decrypts via `CredentialVault` and calls `ConnectorRegistry.execute()`. Not "disconnected." |
| Evaluator / guardrails / agent_swarm | ✅ Present, with evaluator-retry + self-heal on `agent_task`. |
| Variable interpolation engine (§4.3) | ✅ `engine/templateResolver.ts` resolves every templated config field before dispatch. |
| Error edges (§3.5) | ✅ `WorkflowEdge.type='error'` already routes failures to a catch branch instead of failing the run. |
| Tier 1 + Tier 2 state (§4.1) | ✅ `scratchpad` (run) + `workflow_store` (cross-run KV). |
| `build_workflow` (§6) | ✅ Already does LLM synthesis + regex fallback, including a Hello-World HTML path. Not pure regex. |
| Live graph patching / replan | ✅ `applyGraphPatch` + run recovery exist. |

**Where the plan's references are wrong:**

- §1.3 says "extend `WorkspaceContextService.buildContextBlock()`". That service
  (`services/workspaceContext.ts`) is **only a tenant resolver** — no `buildContextBlock`,
  no file reading. ✅ RESOLVED 2026-05-22: built a *new* `WorkspaceIntelligenceService`
  rather than overloading the resolver.
- §3.2 / §3.1 say "Playwright is already in the repo as a devDependency." Only
  `@playwright/test` (e2e harness) was present — the `playwright` runtime + Chromium were
  not installed. ✅ RESOLVED 2026-05-22: `playwright` added to `apps/api`, BrowserPool
  auto-installs Chromium on first use.
- §2.2 `AgentTaskNodeConfig.agentRole` — not implemented. `#dispatchAgentTask` hard-requires
  `agentId` and throws otherwise. No specialist library, no role tool manifests.
- §5.1 `WorkflowPhase` with SLA/humanGate/budget — the existing `WorkflowPhase` is a
  **cosmetic canvas grouping** (`{id,name,color,nodeIds,collapsed}`), not an execution primitive.
- The `artifacts` table was defined in Drizzle `schema.ts` but **created by neither
  `embedded-sql.ts` nor any migration** — a latent bug that broke `artifact_collect`
  and the `/v1/artifacts` routes. Fixed 2026-05-22 (see Implementation Log).

**The genuine remaining gaps (what this plan should actually deliver):** the Universal
Output Surface (Layer 6 — was fake: HTML rendered as raw text), the `browser` node +
Playwright runtime, Workspace Intelligence (Layer 1), specialist agents + `agentRole`
(Layer 2), real execution-primitive Phases (Layer 5), Tier-3 `workspace_kv` + Workspace
Volume (§4.4), and Layer 7 (instinct/analytics/MCP).

---

## 1. True North Star

**What we are building:** A coordinated multi-agent execution fabric where operators describe goals at any level of complexity — from "show Hello World" to "run my entire quarterly reporting cycle" — and the platform decomposes, delegates, executes, monitors, learns, and self-heals with minimal human intervention.

**The experience we are building toward:**

An operator opens Agentis and types:

> *"Automate our weekly engineering standup: every Monday at 8am, collect all PRs opened last week, summarize what each engineer worked on, identify blocked items, post to #standup on Slack, and email the CTO a 1-page digest with risk flags highlighted."*

The agent responds:

```
I'll build that for you. Let me check what I know about your workspace first.

[Reading]  WORKSPACE.md         found: GitHub org, Slack workspace, CTO email
[Reading]  MEMORY.md            found: stack = TypeScript + pnpm, Jira disabled
[Checking] GitHub integration   authenticated
[Checking] Slack integration    not configured

I need Slack access to complete this. I need:
  Bot token with: channels:read, chat:write, users:read
  Channel ID for #standup

Want me to walk you through setup? It takes ~2 minutes.
```

Operator: "Yes"

```
[Guide] 1. Go to api.slack.com/apps -> Create New App
[Guide] 2. Under OAuth & Permissions, add these scopes: [shown inline]
[Guide] 3. Install to your workspace, copy the Bot User OAuth Token

Paste the token here: ___________
```

Operator pastes the token.

```
[Verifying] Slack token         connected as @agentis-bot
[Resolving] #standup channel    found: C04XYZABC12
[Saving]    credential          encrypted and stored

Building workflow...

[Planning]  decomposing goal     3 phases
[Drafting]  graph synthesis      9 nodes
[Validating] schema + creds     all resolved

Here's what I created:

  Schedule Trigger  [Monday 8:00 AM]
    |
    GitHub: List PRs  [last 7 days, all authors]
    |
    Transform: Group PRs by author
    |
  [parallel]
    +-- Agent Task: Write standup summary     [Writer agent]
    +-- Agent Task: Identify blocked items    [Risk detector agent]
    | [merge]
    Agent Task: Write CTO digest             [Writer agent]
    |
  [parallel]
    +-- Slack: Post to #standup
    +-- Gmail: Send to CTO
    |
    Artifact: Save digest as PDF
    |
    Return Output

First run: Monday 8:00 AM. Want to test with last week's data?
```

**That is the north star.** The platform reads workspace context, detects missing integrations and guides setup, builds a multi-branch multi-agent graph from natural language, and produces rendered outputs that humans actually want to look at.

---

## 2. The Seven Foundational Layers

```
+=====================================================================+
|  LAYER 7: OBSERVABILITY + SELF-IMPROVEMENT                         |
|  Instinct engine / pattern detection / cost analytics / health     |
+=====================================================================+
|  LAYER 6: UNIVERSAL OUTPUT SURFACE                                 |
|  Type registry / per-type viewers / output gallery / live serving  |
+=====================================================================+
|  LAYER 5: ENTERPRISE EXECUTION MODEL                               |
|  Phase gates / SLA tracking / budget governance / audit trail     |
+=====================================================================+
|  LAYER 4: ARTIFACT & MEMORY SYSTEM                                 |
|  Three-tier state / artifact store / workspace volume / decisions  |
+=====================================================================+
|  LAYER 3: NODE LIBRARY                                             |
|  Deterministic: transform, filter, loop, http, wait, browser      |
|  Agentic: agent_task, evaluator, swarm, subflow                   |
|  Integration: slack, github, gmail, sheets, webhook (native)      |
+=====================================================================+
|  LAYER 2: PLANNING & ORCHESTRATION BRAIN                           |
|  Hierarchical planner / specialist library / delegation protocol  |
+=====================================================================+
|  LAYER 1: WORKSPACE INTELLIGENCE (FOUNDATION)                      |
|  WORKSPACE.md / MEMORY.md / DECISIONS.md / integration registry  |
+=====================================================================+
```

---

## Layer 1 — Workspace Intelligence

### 1.1 The CLAUDE.md Lesson

Karpathy's CLAUDE.md went viral with 82,000 stars because it solved the most expensive problem in AI: agents starting from zero every session. Developers were spending $975/week per developer just re-explaining context.

Agentis already has `AGENTS.md` at the workspace root. But agents don't read it. No agent in any workflow is injected with the workspace's stack, conventions, decisions, or constraints. Every agent call starts from zero. This must change fundamentally.

### 1.2 The Three Persistent Context Files

**`WORKSPACE.md`** — Permanent facts, always true

```markdown
# Workspace: Acme Engineering

## Tech Stack (always use these — never suggest alternatives)
Language: TypeScript | Framework: Next.js 14 (App Router)
Package manager: pnpm | Database: PostgreSQL + Drizzle ORM
Testing: Vitest + Playwright | CI/CD: GitHub Actions + Railway

## Architectural Rules (never contradict without flagging)
- All API routes in apps/api/src/routes/ — one file per resource
- No class components. Functional + hooks only.
- Error codes from @agentis/core/errors.ts — never invent inline.
- Background jobs via DurableJobQueue, not setTimeout.

## Active Integrations
- GitHub: org/acme (authenticated)
- Slack: workspace/acme-eng, channels: #general, #engineering, #standup
- Gmail: cto@acme.com, reports@acme.com
- PagerDuty: not configured

## Constraints
- Never deploy to production on Fridays.
- All PRs require at least 2 reviews before merge.
- Budget: $50/workflow run, $500/day total.
```

**`MEMORY.md`** — Decision and learning log (append-only by agents)

```markdown
# Session Memory Log

## Decisions Made
- [2026-05-10] Chose Drizzle over Prisma: lighter runtime, better TS inference
- [2026-05-15] GitHub Actions over CircleCI: already on GH org plan

## Patterns That Failed
- [2026-05-19] Agent summarizer hallucinated PR authors when input > 50 PRs.
  Diagnosis: context overflow. Fix: truncate to top 20 by activity score first.
- [2026-05-12] Splitting PR summary into 2 subflows caused auth token issues.
  Fix: keep PR workflows as single-graph, no subflow splits.

## Effective Patterns
- [2026-05-08] Evaluator-retry with critique injection: failure rate 23% -> 4%
  on code review workflows. Apply to all agent-heavy workflows.
```

**`DECISIONS.md`** — Architectural decision record

```markdown
## ADR-001: Authentication — JWT RS256 (2026-04-10)
Decision: JWT RS256, JWKS at /.well-known/jwks.json
Rejected: Opaque tokens (no offline verify), HS256 (key distribution)

## ADR-002: Workflow state — SQLite WAL (2026-04-12)
Decision: Single SQLite file, WAL mode
Rejected: PostgreSQL (overkill V1), Redis (extra dep)
```

### 1.3 Context Injection Architecture

Extend the existing `WorkspaceContextService` (`apps/api/src/services/workspaceContext.ts`) with a `buildContextBlock()` method that reads the three context files and assembles a prompt block:

```typescript
// Extension to existing WorkspaceContextService
async buildContextBlock(workspaceId: string): Promise<string> {
  const [workspace, memory, integrations] = await Promise.all([
    this.readContextFile(workspaceId, 'WORKSPACE.md'),
    this.readContextFile(workspaceId, 'MEMORY.md'),
    this.getIntegrationStatus(workspaceId),
  ]);

  return trimTemplate(`
    ## Your Workspace Context
    ${workspace}
    Active Integrations: ${integrations.filter(i => i.ok).map(i => i.name).join(', ')}
    Missing Integrations: ${integrations.filter(i => !i.ok).map(i => i.name).join(', ')}
    ${memory}
  `);
}
```

This block is injected into:
- Every `agent_task` node system prompt (prepended, via `#dispatchAgentTask`)
- The `build_workflow` LLM synthesis prompt
- The orchestrator's conversation context at session start
- The Planner agent's context before producing any plan

### 1.4 Context Auto-Maintenance

Agents update context as they work, without operator involvement:

- After any significant architectural decision -> append to `DECISIONS.md`
- After a workflow fails 3+ times with the same root cause -> append to `MEMORY.md` failure patterns
- After a workflow runs 10+ times successfully -> append to `MEMORY.md` effective patterns
- After a new integration is configured -> `WORKSPACE.md` integrations section auto-updates

The operator reviews all three files from Settings > Workspace > Context. Changes take effect on the next agent call.

### 1.5 Integration Setup Wizard

**Current state:** Missing credential = silent failure or runtime error.

**New state:** The `IntegrationRegistry` is checked during `build_workflow` synthesis. If a required integration is missing, the agent pauses and enters a guided setup conversation — entirely within the chat panel, no separate UI page:

1. "I need [Integration] access. Here's what I need and why." — shows required permissions
2. Step-by-step instructions rendered as a numbered guide in the chat
3. Agent asks operator to paste the credential
4. Validates the credential with a live test call
5. Saves to `CredentialVault` with encrypted storage
6. Updates `WORKSPACE.md` integration status
7. Resumes workflow synthesis

**Native-first principle:** For operations we can run locally (webpage screenshot, HTML rendering, PDF generation, file I/O), we own the implementation via Playwright and Node.js. No external screenshot API. No PDF service. We control the cost, we eliminate the vendor dependency, we engineer the solution correctly.

### 1.6 Memory Management at Scale

`MEMORY.md` is append-only by design — agents never edit entries, only add. Without management, a workspace running daily workflows for six months accumulates hundreds of entries. Injecting all of them into every agent call is wasteful and counterproductive: old, low-confidence patterns dilute the signal from recent high-value ones.

The solution is **relevance-scored retrieval with automatic compaction** — no database, no embeddings, no external service.

**Structured entry format:**

Each entry carries inline metadata that `buildContextBlock()` parses for scoring:

```markdown
## Patterns That Failed
- [2026-05-19][uses:3][wf:standup][conf:high] Agent summarizer hallucinated PR authors with input > 50 PRs. Fix: truncate to top 20 by activity score first.
- [2026-04-02][uses:0][wf:any][conf:low] Parallel fan-out over 10 agents caused rate-limit spikes. Fix: cap fan-out at 5, add 200ms stagger between workers.
```

- `[uses:N]` — incremented each time the entry is selected and injected. Starts at 0.
- `[wf:slug]` — workflow this originated from. `any` applies workspace-wide.
- `[conf:low|medium|high]` — confidence, upgraded as more evidence accumulates.

**Relevance scoring in `buildContextBlock()`:**

```typescript
function selectRelevantEntries(
  entries: MemoryEntry[],
  ctx: { workflowId?: string; tokenBudget: number; maxEntries: number }
): MemoryEntry[] {
  const now = Date.now();
  const scored = entries.map(e => {
    const ageDays = (now - e.timestamp) / 86_400_000;
    const recency = Math.max(0, 1 - ageDays / 90);      // decays to 0 at 90 days
    const usage   = Math.min(1, e.uses / 10);            // saturates at 10 uses
    const wfMatch = e.workflowId === ctx.workflowId ? 1 : 0.3;
    return { entry: e, score: recency * 0.40 + usage * 0.35 + wfMatch * 0.25 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, ctx.maxEntries)
    .map(s => s.entry)
    .filter(e => estimateTokens(e.text) <= ctx.tokenBudget);
}
```

Default: top 10 entries, 2,000-token budget. Both configurable in Settings > Workspace > Memory.

**Automatic compaction:**

When the file exceeds 80 entries, a background job fires — no LLM, pure heuristics:

1. Entries with `[uses:0]` and age > 90 days → moved to `MEMORY-archive-{year}.md`
2. Entries sharing the same `[wf:]` tag and root cause keyword → merged into one, confidence upgraded
3. Operator notified in chat: "Memory compacted: 63 entries → 21 entries. 42 archived to MEMORY-archive-2026.md."

The compacted file stays human-readable and human-editable. The archive is preserved and searchable. No context is lost — only noise is filtered. Over time, `MEMORY.md` converges to a dense, high-signal library of patterns that genuinely improve agent behavior rather than a log nobody reads.

---

## Layer 2 — Planning & Orchestration Brain

### 2.1 The Hierarchical Planner

The most important insight from ECC: **a Planner agent that breaks down tasks and delegates to specialists is worth more than all 156 skills combined**. A task that took a junior developer a day takes Planner + 3 specialists 20–40 minutes, without the bugs that take a week to fix afterward.

#### 2.1.1 The Planner Agent

A built-in workspace agent named "Planner" (role: `planner`) with specific behavior enforced in its system prompt:

```
MANDATORY PLANNING PROTOCOL (execute in order, every time):

STEP 1: GOAL DECOMPOSITION
  What is the ultimate outcome (not the process)?
  What are the concrete success criteria?
  What are the failure criteria?

STEP 2: CONTEXT CHECK
  Read WORKSPACE.md — what constraints apply?
  Read MEMORY.md — any failure patterns to avoid? Any effective patterns to reuse?
  Read DECISIONS.md — any architectural decisions that affect this plan?

STEP 3: DEPENDENCY MAPPING
  What data is needed? From where?
  What integrations are required? Are they configured?
  What is strictly sequential vs. parallelizable?

STEP 4: RISK ASSESSMENT
  What can go wrong at each phase?
  What is the rollback plan for each phase?
  What requires human judgment vs. what can be fully automated?

STEP 5: RESOURCE ALLOCATION
  Which specialist agent handles each task?
  Budget per phase?
  SLA targets per phase?

OUTPUT: Structured ExecutionPlan object — not a text block
```

The Planner outputs an `ExecutionPlan`:

```typescript
interface ExecutionPlan {
  goalSummary: string;
  phases: Phase[];
  estimatedDurationHours: number;
  estimatedCostCents: number;
  requiredIntegrations: string[];
  missingIntegrations: string[];   // triggers setup wizard before build
  riskFlags: RiskFlag[];
}

interface Phase {
  id: string;
  name: string;
  description: string;
  slaDurationHours: number;
  agentAssignments: AgentAssignment[];
  parallelizable: boolean;
  humanGateRequired: boolean;
  humanGateType?: 'approve_plan' | 'approve_output' | 'provide_input';
  successCriteria: string;
  rollbackPlan: string;
  dependsOn: string[];
}
```

The plan renders in the chat as expandable **Phase Cards** — not a wall of text:

```
+-----------------------------------------------------------+
|  EXECUTION PLAN: "Weekly Engineering Standup"             |
|  3 phases  Est. 2min/run  Est. $0.04/run                 |
+-----------------------------------------------------------+
|  Phase 1: Data Collection          SLA: 45s     [v]      |
|  GitHub collect PRs -> transform by author               |
|                                                           |
|  Phase 2: Content Generation       SLA: 60s     [v]      |
|  [Summarizer agent] [parallel] [Risk detector agent]     |
|                                                           |
|  Phase 3: Distribution             SLA: 15s     [v]      |
|  Slack post + Gmail digest + PDF artifact                |
+-----------------------------------------------------------+
|  [Approve & Build Workflow]   [Edit Plan]   [Cancel]     |
+-----------------------------------------------------------+
```

#### 2.1.2 Plan-to-Graph Translation

When the operator approves, the Planner synthesizes the full workflow graph from the approved plan — not from the original natural language prompt. This produces a far more accurate graph because:

- Phase boundaries translate directly to phase groupings in the canvas
- SLAs map to phase `slaDurationMs` fields
- Agent assignments map to specific `agentRole` references
- Risk flags map to evaluator nodes and error edges placed automatically

### 2.2 The Specialist Agent Library

Built-in specialist agents available in every workspace — each pre-configured with role-specific system prompt, optimal model, capability tags, and memory:

| Agent | Role | Primary Capabilities | Default Model |
|-------|------|---------------------|---------------|
| **Planner** | `planner` | Goal decomposition, HTN planning, workflow building, re-planning | GPT-4o (quality) |
| **Researcher** | `researcher` | Web search, document analysis, synthesis, knowledge extraction | GPT-4o-mini (cost) |
| **Code Writer** | `coder` | TDD, implementation, refactoring, test writing | Claude Sonnet |
| **Reviewer** | `reviewer` | Security scan, code quality, architecture review, PR review | GPT-4o |
| **Data Analyst** | `analyst` | Data transformation, statistical analysis, pattern detection, reporting | GPT-4o-mini |
| **Content Writer** | `writer` | Blog posts, summaries, reports, emails, documentation | Claude Sonnet |
| **Monitor** | `monitor` | Metric tracking, anomaly detection, alerting, health reporting | GPT-4o-mini |
| **Architect** | `architect` | System design, ADR writing, technology evaluation | GPT-4o (quality) |
| **Debugger** | `debugger` | Root-cause analysis, structured diagnosis, fix verification | Claude Sonnet |
| **Deployer** | `deployer` | CI/CD orchestration, environment management, rollback | GPT-4o-mini |

Each specialist reads `WORKSPACE.md` + `MEMORY.md` before its first action. Each accumulates workspace-specific knowledge across runs into its own memory subsection in `MEMORY.md`.

**Usage in workflows:** Reference by role — the engine resolves to the workspace's actual agent with that role at run time:

```typescript
interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentRole?: 'planner' | 'researcher' | 'coder' | 'reviewer' | 'analyst'
             | 'writer' | 'monitor' | 'architect' | 'debugger' | 'deployer';
  agentId?: string;          // explicit reference still supported
  tools?: AgentTool[];       // explicit override — replaces role defaults
  additionalTools?: AgentTool[]; // additive — appended to role defaults
  prompt: string;
  // ...
}
```

#### 2.2.1 Role-Scoped Tool Manifests

Role names without tools are just labels. What makes a Researcher actually research and a Coder actually code is the **tool manifest** — the set of capabilities the engine grants at dispatch time. The engine includes these schemas in the LLM function-call list, handles invocations, feeds results back, and loops until the agent emits a `finish` response. This is the full agentic tool-use loop, not a single LLM call.

```typescript
type AgentTool =
  | 'web_search'          // Search the web (no API key required for basic)
  | 'read_url'            // Fetch + extract clean text from any URL
  | 'read_file'           // Read workspace file by relative path
  | 'write_file'          // Write file, scoped to .agentis/workspace/{workspaceId}/
  | 'search_code'         // Regex/text search across workspace files
  | 'run_code'            // Execute expression in sandboxed Transform runtime
  | 'git_diff'            // Get diff for a file or full repo
  | 'git_status'          // Get working tree status
  | 'knowledge_search'    // Semantic search across knowledge base nodes
  | 'call_workflow';      // Invoke another workflow in this workspace, await result

const ROLE_TOOLS: Record<AgentRole, AgentTool[]> = {
  planner:    ['knowledge_search', 'call_workflow'],
  researcher: ['web_search', 'read_url', 'knowledge_search'],
  coder:      ['read_file', 'write_file', 'run_code', 'search_code', 'git_status'],
  reviewer:   ['read_file', 'git_diff', 'search_code', 'run_code'],
  analyst:    ['read_file', 'run_code', 'knowledge_search'],
  writer:     ['web_search', 'read_url', 'read_file'],
  monitor:    ['read_url', 'knowledge_search', 'call_workflow'],
  architect:  ['read_file', 'search_code', 'knowledge_search', 'git_diff'],
  debugger:   ['read_file', 'run_code', 'search_code', 'git_diff', 'git_status'],
  deployer:   ['read_file', 'call_workflow'],
};
```

**`call_workflow` is the key composition primitive.** It makes every Agentis workflow callable as a tool from inside any agent task. The Planner can invoke a `data_collector` workflow, receive its result, reason about it, then decide which specialist to delegate to next — without a monolithic Planner prompt that tries to do everything itself. Complex workflows compose from simpler ones, triggered by agent reasoning rather than fixed graph edges.

**Security boundaries on tool execution:**
- `write_file` is scoped to `.agentis/workspace/{workspaceId}/` — agents cannot write outside this directory
- `run_code` uses the same sandboxed `vm.Script` context as the Transform node — no I/O, no `require`, no `process`
- `call_workflow` only invokes workflows within the same workspace — cross-workspace calls are rejected
- `read_file` respects a configurable path allowlist; system paths and `.env` files are blocked by default

### 2.3 Hierarchical Multi-Agent Execution (Agent Swarm)

The existing `agent_swarm` node becomes the core primitive for multi-agent coordination. It surfaces in the palette with a full inspector form and this configuration:

```typescript
interface AgentSwarmNodeConfig {
  kind: 'agent_swarm';

  // Coordinator
  coordinatorRole?: AgentRole;
  coordinatorAgentId?: string;
  coordinatorPrompt: string;

  // Workers
  workers: Array<{
    agentRole?: AgentRole;
    agentId?: string;
    prompt: string;           // supports {{variable}} interpolation
    inputMapping?: Record<string, string>;
  }>;

  // Execution
  executionModel: 'parallel' | 'sequential' | 'coordinator_driven';

  // Result handling
  mergeStrategy: 'array' | 'coordinator_merge' | 'first_success';
  minSuccessRatio?: number;   // 0.8 = 80% workers must succeed
  onBelowMinSuccess: 'fail' | 'partial_proceed' | 'escalate';
}
```

**Example — Parallel code review that runs 3x faster than sequential:**

```
Agent Swarm: "Review PR #142"
  Coordinator: Reviewer Agent
    -> "Synthesize 3 reports into final verdict with blocking/non-blocking items"
  Worker 1: Reviewer Agent — "Check for OWASP Top 10 security vulnerabilities"
  Worker 2: Reviewer Agent — "Check for TypeScript antipatterns and type safety"
  Worker 3: Reviewer Agent — "Check for test coverage gaps and test quality"
  Merge: coordinator_merge
```

Three review passes run in parallel. Total time: max(3 agents) + synthesis = 3x faster than sequential.

### 2.4 Canvas and Chat: One Mental Model

Two interaction paradigms that look like competing products are actually one surface. The mental model that unifies them:

> **Chat is the keyboard. Canvas is the screen.**

Chat is where you express intent, review plans, approve phases, and watch execution narrate itself. Canvas is where the workflow lives, runs, and evolves. You never *have* to open the canvas — you can build, run, and iterate entirely through chat. But the canvas is always there when you want to see structure, drag a node, or understand what the Planner built.

**Bidirectional sync — every change is reflected in both:**

```
Chat -> Canvas:
  "Add a filter before the summarizer that drops PRs with no comments"
    -> Filter node appears on canvas, wired automatically
    -> Chat narrates: "Added: Filter node. PRs with zero comments will be dropped."

  [Planner: Phase Card approved]
    -> Canvas populates with the full graph, nodes animate in phase by phase
    -> Chat narrates the graph as it builds: "9 nodes across 3 phases."

  "Change the Slack channel to #engineering"
    -> Slack node inspector updates on canvas
    -> Chat narrates: "Updated: Slack node posting to #engineering."

Canvas -> Chat:
  [User drags Summarizer Agent to run after Transform]
    -> Chat records: "Moved: Summarizer Agent — now runs after Transform node."

  [User sets GitHub timeout to 45s in Inspector]
    -> Chat records: "Updated: GitHub List PRs timeout -> 45s."

  [User deletes Wait node]
    -> Chat records: "Removed: Wait node. Downstream nodes reconnected."
```

The chat conversation is literally the history of how the workflow was designed. Scroll back and you see every decision, every approval, every configuration change that produced the current graph. This doubles as living documentation — shareable, reviewable, and the starting point for re-planning.

**Focus modes:**

```
CHAT MODE    Full-screen chat. Canvas as minimap in the bottom-right corner.
             Click to expand canvas. Default for new workflows and simple edits.

CANVAS MODE  Full-screen canvas. Chat as a collapsible side panel.
             Collapse to a single "type here" bar. Default during debugging.

SPLIT MODE   50/50 split. Default during active planning sessions.
             Phase Cards on the left, graph building on the right in real time.
```

The Planner always opens in **split mode**: Phase Cards render in chat as each phase is approved, nodes animate onto the canvas simultaneously. The operator sees the plan and the graph at the same time — two representations of the same execution model, always in sync.

This unified model eliminates the power-user divide. Operators who prefer chat never need to touch the canvas. Operators who prefer visual editing can mute chat narration entirely. Both modes produce identical workflows, observable from either surface.

---

## Layer 3 — The Node Library

### 3.1 Deterministic Nodes — Close the LLM Tax

The biggest hidden cost in current Agentis workflows: agent tasks are used for work that requires zero reasoning — extracting a field from an object, calling a REST endpoint, iterating an array. Every such step burns LLM tokens, adds latency, and introduces non-determinism into steps that should be pure functions.

**Rule:** If the output of a step is fully determined by its inputs — no reasoning required — it must use a deterministic node.

| Node | Runtime | What it does |
|------|---------|-------------|
| **Transform** | `vm.Script` + isolated context | Evaluate a JS expression against inputs. Full JS stdlib. No I/O. 1s timeout. |
| **Filter** | `vm.Script` | Boolean expression gate. `true` handle and `false` handle. |
| **Loop** | Engine fan-out + collect | Iterate an array, execute loop body subgraph per item, aggregate results. |
| **Parallel** | Engine fan-out | Fan out to N branches simultaneously. Wait for all (or configurable minimum) to complete. |
| **Wait** | Engine + DB timer | Duration, until-datetime, webhook signal, or polling condition. Cross-session safe (persisted). |
| **HTTP Request** | ConnectorRegistry + safeUrl | Full REST call. Template interpolation in URL/body/headers. Response mapping. SSRF guard. |
| **Router** | Condition evaluator | first_match or all_matching branches. `llm_route` mode for classification-based routing. |
| **Merge** | Union pass-through | Join N branches. Modes: any-completes, all-complete, N-of-M. |

**Transform node security:** Expression runs in `vm.Script` with a frozen context that blocks `require`, `process`, `globalThis`, and `fetch`. For agent-generated expressions, route through the `isolated-vm` skill runtime instead.

### 3.2 Browser Control Node — Native Playwright

**Native-first principle applied.** Playwright is already in the repo as a devDependency. We run it in a `BrowserPool` child process — isolated from the API process, capped at `AGENTIS_BROWSER_CONCURRENCY` (default: 3). No external screenshot service. No PDF rendering API. We own the implementation.

```typescript
interface BrowserNodeConfig {
  kind: 'browser';
  operation:
    | 'screenshot'          // Full-page screenshot -> artifact (image/png)
    | 'pdf'                 // Print to PDF -> artifact (application/pdf)
    | 'serve_html'          // Spin up local HTTP server, open HTML, screenshot
    | 'navigate'            // Navigate to URL, return title + DOM snapshot
    | 'fill_form'           // Fill fields by label/selector, submit
    | 'click'               // Click element by CSS selector
    | 'extract_text'        // Extract visible text by selector
    | 'extract_table'       // Extract <table> data -> JSON array
    | 'extract_links'       // Extract all <a> links -> {href, text}[]
    | 'run_script'          // Execute JS in page context, return value
    | 'wait_for_selector'   // Wait until element appears
    | 'scroll_to_bottom'    // Scroll to bottom (infinite scroll pages)
    | 'serve_project';      // Serve a Workspace Volume directory, keep alive, return URL

  url?: string;             // Supports {{variable}} interpolation
  html?: string;            // For serve_html — the HTML string to render
  dirPath?: string;         // For serve_project — path relative to Workspace Volume root
  selector?: string;        // CSS selector for element operations
  formData?: Record<string, string>;
  script?: string;
  timeout?: number;         // Default: 30_000ms
  headless?: boolean;       // Default: true. false = visible browser on operator's desktop
  viewport?: { width: number; height: number };
  captureScreenshot?: boolean;
}
```

`serve_html` is the Hello World fix: spins up a local HTTP server on a random port, navigates to it, screenshots the result, saves as artifact, and the Output tab renders the iframe preview. `headless: false` opens a real visible browser window on the operator's desktop. In Docker/CI, this falls back to headless with a logged warning.

`serve_project` takes a directory from the Workspace Volume (e.g., `sites/landing-page-v3/`) and starts a persistent local HTTP server serving all files in that directory. Unlike `serve_html` which renders a single HTML string, `serve_project` serves a full directory tree and keeps the session alive for the duration of the run — the WebsitePreview viewer in the Output tab connects to it live. When agents update files in the Volume, the serving session detects the change and triggers a hot-reload. `headless: false` opens the running project in a full browser window on the operator's desktop.

### 3.3 Integration Nodes — Unlock the Existing ConnectorRegistry

The `packages/integrations` package has complete, working connectors (Slack, Gmail, GitHub, Google Sheets, HTTP, Webhook). They are completely disconnected from the engine. The unlock is four structural changes:

```
1. Add 'integration' to WorkflowNodeType union
2. Inject deps.connectorRegistry into WorkflowEngine via bootstrap
3. Add case 'integration': -> deps.connectorRegistry.execute(config, credential)
4. Add integration palette entries in NodePalette (8 entries)
5. Add per-connector config forms in ContextInspector
```

Available immediately after unlock:

| Connector | Operations |
|-----------|-----------|
| **HTTP** | GET, POST, PUT, PATCH, DELETE — full template interpolation |
| **Slack** | Post message, post file, list channels, get users |
| **Gmail** | Send email, read emails, create draft |
| **GitHub** | List PRs, list issues, create issue, comment, get file, create PR |
| **Google Sheets** | Read range, write range, append rows, create spreadsheet |
| **Webhook Send** | POST to external URL, HMAC signing |

Adding a new connector: implement the `Connector` interface in `packages/integrations/src/native/`, register in the manifest. No engine changes required.

### 3.4 Evaluator Node — Wire the Existing EvaluatorRuntime

```typescript
interface EvaluatorNodeConfig {
  kind: 'evaluator';
  rubric: string;             // "Output must be valid JSON with title, body, labels fields"
  input: string;              // {{upstream_node.output}} path
  onFail: 'fail_run' | 'retry_upstream' | 'branch';
  retryNodeId?: string;       // agent_task node to re-run on failure
  maxRetries?: number;        // Default: 2
  critiqueInjection: boolean; // Inject evaluator feedback into retry prompt
}
```

The `agent_task -> evaluator -> retry` loop becomes the canonical pattern for quality-guaranteed output. Observed in MEMORY.md: failure rate 23% -> 4% after introducing this pattern on code review workflows.

### 3.5 Error Edge Architecture

Add `type: 'data' | 'error'` to `WorkflowEdge`. Error edges fire when their source node fails, instead of failing the run:

```
[HTTP Request: GitHub API]
  |  <- data edge (normal path)
  +-> [Transform: process issues]
  |
  +x  error edge (fires on failure)
       |
       [Error Handler: log + notify + use fallback]
            |
            [Slack: Post "GitHub unavailable, using cached data"]
            |
            [workflow_kv: load cached issues from last run]
```

The error handler node receives `{{source_node.error}}` as input. It can log, alert, substitute fallback data, or route through an alternative path. Error edges render as dashed red lines on the canvas. Drawing from a node shows a secondary error handle on the bottom-right.

---

## Layer 4 — Artifact & Memory System

### 4.1 Three Tiers of State

Agentis currently has one tier: in-memory `ScratchpadService` that evaporates when the run ends. Complex workflows require three:

```
TIER 1 — Run State (existing)
  Scope: single run
  Lifetime: run duration
  Access: {{nodeId.outputKey}} variable interpolation
  Use: pass data between nodes within a run

TIER 2 — Workflow State (new: workflow_kv_entries table)
  Scope: single workflow, all runs
  Lifetime: permanent or configured TTL
  Access: {{workflow_kv.my_key}} + WorkflowKV node
  Use: accumulate across runs, rolling windows, counters, last-seen state
  Example: "only process PRs we haven't seen before" -> store processed PR IDs

TIER 3 — Workspace State (new: workspace_kv table)
  Scope: entire workspace, all workflows
  Lifetime: permanent
  Access: {{workspace.my_key}} + WorkspaceKV node
  Use: shared constants, global flags, cross-workflow coordination
  Example: "the weekly report config" shared across 3 different workflows
```

### 4.2 Artifact Store

New service: `ArtifactStore` with local filesystem backend (V1) and S3/R2 backend (V2). Interface-injected — engine code is storage-agnostic.

```typescript
interface ArtifactRecord {
  id: string;
  workspaceId: string;
  runId: string;
  nodeId: string;
  name: string;           // filename.ext
  contentType: string;    // MIME type
  size: number;           // bytes
  storageKey: string;     // .agentis/artifacts/{wid}/{rid}/{id}-{name} (V1)
  expiresAt?: string;     // null = permanent
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

Artifact-producing nodes: `browser: screenshot/pdf/serve_html`, `artifact_save` (new node), `http_request` (configurable for binary), `agent_task` (via `saveFiles: true`), `return_output` (when `renderAs: 'html'`).

### 4.3 Variable Interpolation Engine

Every string-typed field in every node config is template-resolved before dispatch. This is infrastructure — not a feature.

```typescript
// Template syntax: {{nodeId.outputKey.nested.path}}
// Additional sources:
//   {{workflow_kv.key}}      workflow-scoped KV
//   {{workspace.kv.key}}     workspace-scoped KV
//   {{run.id}}               current run ID
//   {{workspace.id}}         workspace ID
//   {{env.AGENTIS_PUBLIC_*}} allowlisted env vars only

const context = {
  trigger: nodeOutputs['trigger_node_id'],
  [nodeId]: nodeOutputs[nodeId],     // every completed upstream node
  workflow_kv: workflowKvSnapshot,
  workspace: { id, kv: workspaceKvSnapshot },
  run: { id, startedAt, triggeredBy },
};
```

Resolution in `#dispatchNode()` before any adapter or service call. Unresolved references throw `WORKFLOW_VARIABLE_NOT_FOUND` — a clear error, not a silently wrong prompt.

### 4.4 Workspace Volume

The Workspace Volume is the persistent, mutable filesystem available to every agent and workflow in a workspace. It is fundamentally different from the ArtifactStore:

```
ArtifactStore     Immutable. Per-run snapshots. Indexed by runId.
                  Written once, never modified. Think: run receipts.

Workspace Volume  Mutable. Cross-run, cross-workflow. Read + write.
                  Persists indefinitely. Think: workspace hard drive.
```

Root path on host: `.agentis/workspace/{workspaceId}/`

```typescript
interface VolumeEntry {
  name: string;
  path: string;      // relative to workspace root
  kind: 'file' | 'dir';
  size?: number;     // bytes, files only
  modifiedAt: string;
}

interface ServingSession {
  port: number;
  url: string;       // http://127.0.0.1:{port}
  rootPath: string;  // directory being served from the Volume
  stop: () => Promise<void>;
}
```

The Volume is accessible from:
- **Coder agent** via `write_file` / `read_file` tools — scoped to workspace root, cannot escape
- **Browser node** via `serve_project` operation — serves any Volume subdirectory as a live site
- **Users** via the Volume Explorer panel (Output tab > Volume tab)
- **Any node config** via `{{volume.path('relative/path')}}` interpolation

**Volume directory conventions:**

```
.agentis/workspace/{workspaceId}/
  projects/     <- Multi-file codebases generated by Coder agent
  sites/        <- Websites and apps generated by Coder/Builder agents
  reports/      <- Documents and PDFs generated by Writer/Analyst agents
  datasets/     <- Enriched datasets generated by Analyst agent
  assets/       <- Images, audio, video generated by media workflows
  context/      <- WORKSPACE.md, MEMORY.md, DECISIONS.md
```

The **Volume Explorer panel** (Output tab > Volume tab) shows the full directory tree with file previews on hover, "Open in VS Code" at directory level, per-file download, and a cleanup tool to remove files older than N days.

---

## Layer 5 — Enterprise Execution Model

### 5.1 Workflow Phases

A `phase` is a first-class structural primitive — not just a visual grouping:

```typescript
interface WorkflowPhase {
  id: string;
  name: string;
  nodeIds: string[];
  slaDurationMs: number;
  humanGate?: {
    type: 'approve' | 'provide_input' | 'review_output';
    message: string;
    timeoutMs?: number;            // null = wait indefinitely
    onTimeout: 'escalate' | 'auto_approve' | 'fail';
    escalateTo?: string;           // userId or channel
  };
  successCriteria?: string;        // JS expression evaluated after phase
  rollbackPlan?: string;
  budgetCents?: number;
}
```

Canvas renders phases as dashed boundary boxes with phase name headers. RunDrawer shows phase progress:

```
+----------------------------------------------------+
|  Phase 1: Data Collection     [OK] COMPLETE   12s  |
|  Phase 2: Content Generation  [>>] RUNNING    45s  |
|  Phase 3: Distribution        [ ]  PENDING         |
+----------------------------------------------------+
```

### 5.2 SLA Tracking

Every phase has an SLA. On breach: emit `PHASE_SLA_BREACHED`, alert the workspace's configured ops channel, and turn the phase boundary box amber on the canvas. SLA breaches alert — they do not kill runs.

### 5.3 Budget Governance

Multi-tier enforcement — none of these are optional:

```
WORKSPACE BUDGET: $500/day
  WORKFLOW BUDGET: $50/run (per workflow settings)
    PHASE BUDGET: $10/phase (per phase config)
      NODE BUDGET: $2/agent_task (estimatedCostCents on node)
```

Live cost accumulation shown in the canvas status bar during execution. `BUDGET_PHASE_EXCEEDED` event halts the run with a clear error.

### 5.4 Full Audit Trail

Every action in every workflow run is attributed and logged:

```typescript
interface AuditEntry {
  id: string;
  workspaceId: string;
  runId: string;
  phaseId?: string;
  nodeId?: string;
  agentId?: string;
  action: string;        // "node.started", "human_gate.approved", "artifact.saved"
  actorType: 'agent' | 'user' | 'system' | 'scheduler';
  actorId: string;
  inputSummary?: string; // compressed preview
  outputSummary?: string;
  costCents?: number;
  at: string;
}
```

Available at `GET /v1/runs/:runId/audit`. Nodes on canvas are clickable to see their full audit entries — every tool call, every cost, every output. This is what makes multi-agent automation safe to run on production systems.

### 5.5 Long-Running Workflow Architecture

Workflows that run for days or weeks have specific requirements that the current architecture doesn't meet:

- **Phase snapshots:** After each phase completes, a deliberate milestone checkpoint is taken — distinct from crash-recovery snapshots. Enables resume from a specific phase, re-run of a phase with different params, view of exact state at phase completion.
- **Cross-session state:** Phase gates that wait for human approval (`wait: 'webhook'`) survive server restarts. Persisted as `wait_state` records with phase context in the DB.
- **Execution window:** Configurable `maxExecutionWindowDays` per workflow. After expiry, run is marked `TIMEOUT` and an alert fires. No zombie runs.

---

## Layer 6 — Universal Output Surface

### 6.1 The Artifact Type Registry

Every artifact the engine produces is registered with a type that maps to a dedicated viewer component. The renderer system is a registry — adding a new artifact type never requires touching the output surface code.

```typescript
type ArtifactType =
  // Data
  | 'text/csv'                   // DataTableViewer
  | 'application/json'           // auto: DataTableViewer (array) or CodeViewer (object)
  | 'application/vnd.ms-excel'   // DataTableViewer (XLSX)
  | 'application/x-dataset'      // DatasetViewer (large structured data, paginated)
  // Documents
  | 'application/pdf'            // PDFViewer
  | 'text/markdown'              // MarkdownRenderer
  | 'text/plain'                 // CodeViewer (plain text mode)
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'    // DocxViewer
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation' // SlideViewer
  // Code & Projects
  | 'text/x-code-file'           // CodeViewer (syntax highlight, language auto-detected)
  | 'application/x-codebase'     // CodebaseViewer (file tree + multi-file editor)
  | 'text/x-diff'                // DiffViewer (unified diff format)
  // Web & UI
  | 'text/html'                  // LiveHTMLRenderer (sandboxed iframe)
  | 'application/x-website'      // WebsitePreview (served from Volume, full navigation)
  | 'application/x-dashboard'    // DashboardViewer (chart spec with filters)
  // Media
  | 'image/*'                    // ImageViewer (zoom, pan, compare across runs)
  | 'video/*'                    // VideoPlayer (seek, speed, frame export)
  | 'audio/*'                    // AudioPlayer (waveform, speed)
  // Deployment
  | 'application/x-deployment'   // DeploymentCard (live URL + health + rollback)
  | 'application/x-openapi'      // APIExplorer (interactive docs + try-it)
  // Archives
  | 'application/zip'            // ArchiveViewer (list + preview + extract)
  | 'application/x-tar';         // ArchiveViewer

const VIEWER_REGISTRY: Record<string, React.ComponentType<ViewerProps>> = {
  'text/csv':                  DataTableViewer,
  'application/json':          JsonOrTableViewer,    // auto-detects array vs object
  'application/x-dataset':     DatasetViewer,
  'application/pdf':           PDFViewer,
  'text/markdown':             MarkdownRenderer,
  'text/x-code-file':          CodeViewer,
  'application/x-codebase':    CodebaseViewer,
  'text/html':                 LiveHTMLRenderer,
  'application/x-website':     WebsitePreview,
  'application/x-dashboard':   DashboardViewer,
  'image/*':                   ImageViewer,
  'video/*':                   VideoPlayer,
  'audio/*':                   AudioPlayer,
  'application/x-deployment':  DeploymentCard,
  'application/x-openapi':     APIExplorer,
  'application/zip':           ArchiveViewer,
  '*':                         BinaryDownloadCard,   // fallback for unknown types
};
```

### 6.2 Viewer Specifications

Each viewer is a full-featured, production-grade component — not a basic wrapper.

**DataTableViewer** (`text/csv`, `application/json` array, XLSX)
- Pagination: 25 / 50 / 100 / all rows, with total row count in header
- Sort: click column header; shift-click for multi-column sort
- Per-column filter bar and global search across all fields
- Column stats panel: null%, min/max/avg for numeric, unique count for strings
- Pivot mode: drag columns to build aggregate views like a spreadsheet
- Export: CSV, XLSX, JSON
- Row detail drawer: click any row to see the full record as formatted JSON
- "Send to Google Sheets" action: appends rows via the Sheets integration

**LiveHTMLRenderer** (`text/html`)
- Sandboxed iframe (`sandbox="allow-scripts"`) — no access to parent origin, cookies, or localStorage
- Device mode toolbar: Desktop (1440px) / Tablet (768px) / Mobile (375px)
- Responsive resize handle: drag to any custom width
- JS console panel: captures errors and logs from inside the sandboxed page
- "Open in new tab" → served from a signed temporary URL

**WebsitePreview** (`application/x-website`)
- Full in-panel browser: address bar, back/forward, and reload buttons
- Served live from the Workspace Volume via `serve_project` (local HTTP server on a random port)
- Multi-page navigation: click links, navigate between pages exactly as in a real browser
- Hot-reload: when agents update Volume files, the preview automatically refreshes
- Device mode toggle: Desktop / Tablet / Mobile
- Page map sidebar: all HTML files in the project tree
- "Open in system browser" → launches the localhost URL in the OS default browser

**CodebaseViewer** (`application/x-codebase`)
- File tree sidebar: full directory tree, expandable, showing file type icons
- Syntax-highlighted editor pane: opens any file on click, language auto-detected
- Search: regex/text search across all files, results with context lines and line numbers
- Diff mode: compare any file to its state in the previous run
- "Open in VS Code" → executes `code .agentis/workspace/{wid}/projects/{name}`
- Stats bar: total files, total lines, language composition pie chart
- "Download as ZIP" → bundles the full project directory

**ImageViewer** (`image/*`)
- Click to lightbox (full-viewport)
- Scroll-to-zoom (up to 10×), drag-to-pan when zoomed
- "Compare with previous run" → side-by-side or overlay with opacity slider
- For AI-generated images: renders the generation prompt in a tooltip badge
- Download in original format or convert to PNG / WebP / JPG

**VideoPlayer** (`video/*`)
- Standard controls: play/pause, seek bar, volume, full-screen
- Playback speed: 0.25×, 0.5×, 1×, 1.5×, 2×
- Frame export: capture current frame as a PNG artifact
- Loop toggle; keyboard shortcuts (Space = play/pause, Arrow = seek 5s)

**AudioPlayer** (`audio/*`)
- Waveform visualization rendered from the audio data
- Play/pause, seek, speed, loop
- For TTS outputs: shows the source text alongside the waveform

**DashboardViewer** (`application/x-dashboard`)
- Chart types: bar, line, area, pie, scatter, heatmap, funnel
- Multiple chart cards in a responsive grid layout
- Global date range filter applied to all charts simultaneously
- Toggle between chart view and underlying data table
- Export: each chart as PNG, underlying data as CSV

**PDFViewer** (`application/pdf`)
- Page navigation: arrows, jump-to-page input, thumbnail strip
- Zoom: fit-width, fit-page, 50% / 75% / 100% / 150% / custom
- Text selection and copy
- Full-text search with highlighted matches across all pages
- Download button

**DeploymentCard** (`application/x-deployment`)
- URL display with one-click copy and QR code
- Live iframe preview (disable with `previewEnabled: false` in metadata for auth-protected apps)
- Health status: live HTTP check badge — green / amber / red with last-checked timestamp
- Metadata: platform (Vercel / Railway / Netlify), branch, commit hash, deploy time
- "Rollback" button → triggers the workspace's configured rollback workflow
- "View logs" → opens the deployment platform's log URL

**APIExplorer** (`application/x-openapi`)
- Renders OpenAPI spec as interactive documentation: endpoint list, schemas, examples
- "Try it" panel: fill path params, query params, request body; execute; see response
- Auth: injects workspace API key automatically for same-workspace APIs
- Download spec as JSON or YAML

### 6.3 The OutputGallery — Multi-Artifact Runs

Most real workflows produce multiple artifacts. A leads generation workflow produces a data table, a PDF report, an HTML dashboard, a personalized email sequences directory, and an audio summary. All five are equally first-class outputs — not attachments to a "primary" result.

```
Run: "Generate Q2 EMEA Leads"   ✓ Success   47s   $0.12
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUTS (6 artifacts)

  +---------------------+  +---------------------+  +---------------------+
  |  [T]  leads.csv     |  |  [D]  report.pdf     |  |  [W]  dashboard     |
  |  DataTable          |  |  PDF - 12 pages      |  |  WebsitePreview     |
  |  847 rows - 14 cols |  |  2.4 MB              |  |  live - hot-reload  |
  |  [Open] [Export v]  |  |  [Open] [Send v]     |  |  [Open] [Deploy v]  |
  +---------------------+  +---------------------+  +---------------------+

  +---------------------+  +---------------------+  +---------------------+
  |  [F]  sequences/    |  |  [A]  summary.mp3    |  |  [M]  exec-brief.md |
  |  Codebase - 15 files|  |  Audio - 4:22        |  |  Markdown - 1,200w  |
  |  TypeScript         |  |  TTS summary         |  |  rendered           |
  |  [Open] [VS Code v] |  |  [Open]              |  |  [Open] [Export v]  |
  +---------------------+  +---------------------+  +---------------------+

  [Export All as ZIP]   [Pin Selected to Workspace]   [Share Bundle v]
```

Clicking "Open" on any card expands the full viewer inline — the output panel transforms into the viewer for that artifact. All other artifact cards remain accessible in a collapsed strip at the top for quick switching.

### 6.4 Output Actions

Every viewer has a contextual action bar. Actions flow output forward — they are the bridge between what agents built and what happens next.

**Universal actions (every artifact type):**
- **Download** — original format
- **Pin to workspace** — saves as a named, permanent workspace resource accessible to other workflows via `{{workspace.resources.name}}`
- **Share** — generates a signed URL with configurable expiry (1h / 24h / 7d / permanent)
- **Re-run with changes** — opens the workflow that produced this artifact with it pre-loaded as input; the operator types a refinement and the workflow re-executes with full context about what it previously produced

**Type-specific actions:**

| Artifact Type | Additional Actions |
|--------------|-------------------|
| DataTable | Export CSV / XLSX / JSON; Pivot mode; Send to Google Sheets |
| CodeProject | Open in VS Code; Deploy (triggers deploy workflow); Download as ZIP |
| WebSite | Open in system browser; Deploy to Vercel/Railway/Netlify; Screenshot all pages |
| PDF | Send via Gmail (triggers Gmail workflow); Extract data (runs Analyst agent on PDF) |
| Image | Regenerate with changes (opens prompt editor + re-runs generation node); Upscale |
| Dashboard | Export all charts as PNG; Export underlying data as CSV |
| Deployment | Rollback; View logs; Run smoke tests |
| Any | Use as workflow input (passes artifact as trigger to any workflow in the workspace) |

**"Re-run with changes"** closes the feedback loop between output and execution. The operator sees the leads table, notices the company size column is missing, types "add company size using LinkedIn enrichment", and the workflow re-executes — knowing it already produced 847 leads and needs to enrich them, not regenerate them from scratch.

### 6.5 The Three Views

**View 1 — Last Run (default):**

OutputGallery for the most recent run. Each artifact card opens its dedicated viewer inline. The active viewer fills the panel; all other artifact cards collapse to a strip at the top for quick switching.

**View 2 — All Runs:**

Timeline of every run, each expandable to show its artifact gallery. Filterable by date range, success/failure status, and artifact type. Shows the evolution of outputs over time — essential for scheduled workflows where the real question is "is this report getting better every week?"

**View 3 — Diff View:**

Select any two runs. Side-by-side comparison per artifact type:
- **DataTable**: rows added/removed highlighted in green/red; cell changes highlighted
- **Code/Project**: file-level diff with unified diff view and line-level highlighting
- **Image**: side-by-side or overlay with opacity slider
- **Markdown/PDF**: paragraph-level text diff, additions in green, removals in red
- **Numeric outputs**: delta value with arrow indicator and percentage change
- **All types**: metadata comparison (file size, row count, duration) in the header

### 6.6 Canvas Live Behavior

- **Data packets:** When a node completes, an animated particle travels along its outgoing edges carrying a preview — first 60 chars of text, or a 32×32 thumbnail for images and HTML
- **Phase rings:** Phase boundary boxes pulse gently while their nodes run; turn solid green on phase completion
- **SLA countdown:** Phase boxes show a progress ring that turns amber as the SLA window narrows, red on breach
- **Cost bar:** Running total in the canvas status bar updates after every completed node
- **Live Volume indicator:** When a Coder or Builder agent is writing to the Workspace Volume, a pulsing write indicator appears in the node header. When `serve_project` is active, a "Live preview" badge is clickable to expand a WebsitePreview panel directly in the canvas corner
- **Artifact tray:** As each artifact is saved during a run, a card rises into a tray at the bottom of the canvas showing its type icon, name, and size. Click any card to open the full viewer without leaving the canvas

---

## Layer 7 — Observability & Self-Improvement

### 7.1 Workspace Analytics

The platform accumulates intelligence about workflow patterns over time and surfaces it:

- Which workflows run most often?
- Which steps fail most often (by workflow, by node kind)?
- Average cost per workflow run, cost trend over time?
- SLA bottlenecks (which phases consistently breach)?
- Budget burn rate by workflow

**Per-workflow analytics:**

```
Workflow: "Weekly Standup"
  Runs: 47 (last 30 days)   Success rate: 94%   Avg cost: $0.04/run

  Node failure breakdown:
    GitHub: List PRs      2 failures — rate limit errors
    Summarizer Agent      1 failure — prompt too long (>50 PRs)

  Auto-optimization suggestions:
    -> Add retry+backoff to GitHub: List PRs (currently no retry policy)
    -> Add Transform: truncate to top 20 PRs before Summarizer Agent
```

### 7.2 The Instinct Engine

ECC's most compelling feature is a system that develops "instincts" by observing session patterns. Agentis builds this natively.

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
    description: string;  // "truncate input to 20 items before this agent task"
  };
  confidence: number;     // 0-1, grows with evidence
  appliedCount: number;   // times this instinct prevented a failure
  lastObservedAt: string;
}
```

The instinct engine runs after every failed run:

```
Run failed at: Summarizer Agent
Failure reason: CONTEXT_TOO_LONG (input was 52 items, 18,000 tokens)
Previous failures at same node: 3 times in last 7 days (same root cause)

Pattern detected (confidence: 0.85)
Instinct proposed: "Add Transform to truncate items to 20 before Summarizer Agent"
User notified: "I noticed the same failure 4 times. Want me to add a fix automatically?"
```

When approved: the engine patches the workflow graph, writes the pattern to `MEMORY.md` effective patterns, increments `appliedCount`, monitors next run to verify. Over time the workspace accumulates a library of proven patterns that make workflows progressively more reliable.

### 7.3 Cost Intelligence

The `WorkflowCostCompiler` exists but is not surfaced. Surface it everywhere:

- **Pre-run estimate** in the canvas header before every manual run
- **Per-node cost breakdown** in Run Detail
- **Cost trend chart** in workflow analytics
- **Budget burn alert:** "80% of today's budget used. Largest spender: Code Review workflow ($12.40/day)"
- **Optimization suggestions:** "This classification step uses GPT-4o but gpt-4o-mini handles it at 5% of the cost"

---

## 3. Integration Architecture

### 3.1 Native-First Engineering

For operations that run frequently in automations, we own the implementation:

| Operation | Our implementation | What we avoid |
|-----------|-------------------|---------------|
| Webpage screenshot | Playwright (already in repo) | ScrapingBee, Browserless API |
| HTML to PDF | Playwright print-to-PDF | DocRaptor, WeasyPrint API |
| HTML rendering | Browser node + sandboxed iframe | External renderer services |
| File I/O | Node.js `fs` module | File storage APIs |
| JSON/CSV/Markdown parsing | Pure TS | Parsing APIs |

### 3.2 External Integration Rules

When an operation is inherently remote (Slack, Gmail, GitHub), external APIs are correct. Rules:

1. **Never call an external API without a stored credential.** The setup wizard handles missing credentials before the workflow runs.
2. **Every external call has a timeout, retry policy, and circuit breaker.** Already enforced by `ConnectorRegistry`.
3. **Credentials never appear in workflow logs.** `CredentialVault` decrypts at execution time; only masked values in observability.
4. **SSRF guard on every configurable URL.** `safeUrl.ts` applies to HTTP Request, Webhook Send, and all user-configurable URL fields.

### 3.3 Integration Roadmap

Phase 1 (unlock existing): Slack, Gmail, GitHub, Google Sheets, HTTP, Webhook Send
Phase 2 (high demand): Notion, Airtable, Jira, Linear, Discord, Telegram
Phase 3 (power user): Salesforce, HubSpot, Stripe, Twilio, AWS S3, PostgreSQL
Phase 4 (AI services): OpenAI, Anthropic, Replicate, ElevenLabs, Stability AI

Each is a module in `packages/integrations/src/native/`. Adding one never requires engine changes.

---

## 4. Workflow as Code

### 4.1 YAML Serialization

Workflows should be versionable, reviewable, and portable — not JSON locked in a SQLite column:

```yaml
name: Weekly Engineering Standup
description: Collect PRs, summarize, post to Slack and email CTO
schedule: "0 8 * * MON"

phases:
  - id: data-collection
    name: Data Collection
    sla: 45s

  - id: content-generation
    name: Content Generation
    sla: 60s

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

  - id: group-by-author
    type: transform
    config:
      kind: transform
      expression: |
        Object.entries(
          input['list-prs'].reduce((acc, pr) => {
            const a = pr.user.login;
            acc[a] = (acc[a] || []);
            acc[a].push({ number: pr.number, title: pr.title });
            return acc;
          }, {})
        ).map(([author, prs]) => ({ author, prs, count: prs.length }))
    dependsOn: [list-prs]
    phase: data-collection

  - id: summarizer
    type: agent_task
    config:
      kind: agent_task
      agentRole: writer
      prompt: |
        Write a standup summary for the engineering team.
        PR activity by author: {{group-by-author}}
        Format as Slack markdown. Be concise. Focus on what was shipped.
      retryPolicy: { maxAttempts: 2, backoff: fixed, initialDelayMs: 1000 }
    dependsOn: [group-by-author]
    phase: content-generation
```

### 4.2 Git Integration

For workspaces that want version-controlled workflows:

```
Settings > Workspace > Git Sync
  Repository: github.com/acme/agentis-workflows
  Branch: main
  Auto-push on save: enabled
  Auto-pull on startup: enabled
```

Every workflow save triggers `git commit + push`. PRs that modify workflow YAML are automatically validated by running through `validateGraph()` as a CI check.

---

## 5. MCP Publication Layer

### 5.1 Workflows as MCP Tools

Every published Agentis workflow can be exposed as an MCP (Model Context Protocol) tool — callable from Claude Code, Cursor, Codex, or any MCP-compatible AI client.

```
Published workflow: "Weekly Standup Generator"
  MCP tool name: agentis__standup_generator
  Input schema:  { since?: ISO-8601, team?: string[] }
  Auth:          workspace API key
  Endpoint:      POST /v1/mcp/tools/standup_generator
```

When a developer in Claude Code says "generate last week's standup", it calls `agentis__standup_generator`. The full Agentis workflow executes — all integrations, agents, artifact output — and returns the result to Claude Code.

**Distribution moat:** Every Claude Code, Cursor, and Codex user who installs an Agentis MCP server gains access to a library of production-hardened workspace automations. They stop building their own workflows from scratch.

### 5.2 MCP Publication UI

`[Publish]` button in the canvas header gains a "Publish as MCP Tool" option. Auto-generates the MCP installation command from the workflow's trigger schema.

---

## 6. The `build_workflow` Rewrite

### 6.1 From Regex to Orchestrated Synthesis

Entire `buildWorkflowDraft()` replaced with a multi-step pipeline:

```
build_workflow(prompt)
    |
[Step 1: Load Context]
  WORKSPACE.md + MEMORY.md + DECISIONS.md
  Integration registry (what's configured, what's missing)
  Specialist agent catalog
  Workflow template library
    |
[Step 2: Intent Extraction]  (no LLM, fast)
  Trigger type: manual / schedule / webhook
  Integrations mentioned
  Output type: html / pdf / message / data
  Complexity: simple / multi-phase / enterprise
  Missing integrations -> trigger setup wizard (blocks here if needed)
    |
[Step 3: Template Matching]  (no LLM, fast)
  Known patterns: "collect-summarize-distribute", "monitor-alert",
    "review-approve-deploy", "etl", "research-report", "daily-digest"
  If match -> instantiate template with substitutions
  If no match -> proceed to LLM synthesis
    |
[Step 4: LLM Graph Synthesis]  (only when needed)
  Model: WORKFLOW_SYNTHESIS_MODEL env (default: gpt-4o-mini)
  System prompt: node catalog + WORKSPACE.md context + MEMORY.md patterns
    + variable syntax + graph schema examples
  Temperature: 0.1
  Response format: json_object
    |
[Step 5: Validation + Patch]
  validateGraph() + Zod schema
  If invalid -> inject error + retry once with LLM
  If still invalid -> return partial graph + flag for manual completion
    |
[Step 6: Build Narration]
  Stream CANVAS_BUILD_COMPLETE to chat panel
  Show: node count, integrations, estimated cost, missing cred warnings
```

---

## 7. Phased Delivery

### Phase 1 — Close the Hello World Gap (Sprint 1)

Status legend: ✅ done · 🔶 partial · ⬜ todo

| Item | Effort | Status |
|------|--------|--------|
| Formalize `return_output` node with `renderAs` field | S | ✅ 2026-05-22 |
| Output tab: render HTML in sandboxed iframe (`LiveHTMLRenderer`) | S | ✅ 2026-05-22 |
| Transform node (sandboxed expression runtime) | M | ✅ pre-existing |
| Variable interpolation resolver | M | ✅ pre-existing |
| Artifacts table + routes + storage backend | M | 🔶 table DDL gap fixed 2026-05-22; content stored inline (V1). Filesystem/S3 backend = V2 |
| `artifact_save` node | S | ✅ 2026-05-22 |
| `browser: serve_html` + `browser: screenshot` + BrowserPool | M | ✅ 2026-05-22 — Playwright runtime + Chromium auto-install on demand |
| Fix `webhook` palette node (maps to wrong kind) | XS | ⬜ todo |
| Output tab: artifact card grid (`WorkflowArtifactGrid`) | M | ✅ 2026-05-22 |

**Done (target):** User asks "show Hello World in a browser." Agent builds Transform + Browser + Return Output. Workflow runs. Browser opens. Output tab shows rendered HTML with screenshot artifact card.

**Done so far (2026-05-22):** the non-Playwright path is complete — `build_workflow`
emits `trigger → transform → return_output(renderAs:'html')`; the run completes; the
Output tab renders the HTML live in a sandboxed iframe (device-mode toolbar, open-in-tab)
and shows produced artifacts as a card grid with inline HTML preview + download. The
real `browser` node (Playwright screenshot / visible window) is the remaining piece.

### Phase 2 — Node Library (Sprints 2-3)

| Item | Effort |
|------|--------|
| Filter node | S |
| Wait node (duration + webhook modes) | M |
| HTTP Request node (unlock ConnectorRegistry) | M |
| Loop node | L |
| Parallel node engine handler | M |
| Error edges + `error_handler` node | L |
| Integration nodes: Slack, Gmail, GitHub, Sheets | M |
| Integration setup wizard in chat | L |
| `browser: fill_form`, `extract_table`, `extract_text`, `navigate` | M |
| Variable picker UI (`{{` triggers autocomplete) | M |
| Evaluator node (wire EvaluatorRuntime) | M |

### Phase 3 — Intelligence Layer (Sprints 4-5)

| Item | Effort | Status |
|------|--------|--------|
| WORKSPACE.md + MEMORY.md + DECISIONS.md system | M | ✅ 2026-05-22 — on the Workspace Volume `context/` dir |
| WorkspaceContextService (inject into all agent calls) | M | ✅ 2026-05-22 — new `WorkspaceIntelligenceService` (the §1.3 name was wrong); injected into agent_task + build_workflow |
| `build_workflow` -> LLM synthesis pipeline | L | 🔶 LLM synthesis pre-existing; workspace context now injected. Intent/template stages still TODO |
| Intent extractor + template library (8 patterns) | M | ⬜ todo |
| Specialist agent library (Planner, Researcher, Reviewer, Analyst, Writer) | L | ⬜ todo |
| Planner agent with HTN planning protocol | L | ⬜ todo |
| Phase plan card UI in chat | M | ⬜ todo |
| Approval mode settings (all/risky/none) | M | ⬜ todo |

### Phase 4 — Enterprise Execution (Sprints 6-7)

| Item | Effort |
|------|--------|
| Workflow phases (engine + schema + canvas boundary boxes) | L |
| Phase gates (human approval between phases) | M |
| SLA tracking + alerting | M |
| Budget governance (per-phase caps) | M |
| Audit trail (full run attribution log) | M |
| Cross-run workflow state (workflow_kv + node) | M |
| Workspace state (workspace_kv + node) | M |
| Agent Swarm palette entry + inspector form | M |
| Long-running workflow snapshot architecture | L |
| Workflow as Code (YAML export/import) | M |

### Phase 5 — Universal Output Surface (Sprints 8-9)

| Item | Effort |
|------|--------|
| Artifact type registry + `VIEWER_REGISTRY` dispatch system | M |
| DataTableViewer: sort, filter, column stats, pivot mode, export CSV/XLSX/JSON | L |
| LiveHTMLRenderer: sandboxed iframe + device mode toolbar + console panel | M |
| WebsitePreview: `serve_project` + in-panel browser + hot-reload | L |
| CodebaseViewer: file tree + syntax highlight + search + VS Code open | L |
| ImageViewer: lightbox + zoom/pan + compare-across-runs overlay | M |
| VideoPlayer + AudioPlayer + waveform visualization | M |
| DashboardViewer: multi-chart grid + date range filter + export | L |
| PDFViewer: page navigation + zoom + full-text search | M |
| DeploymentCard: URL + health check + rollback action | M |
| OutputGallery: multi-artifact card grid + export-all-as-zip + share-bundle | L |
| Output Actions: download, pin-to-workspace, share, re-run-with-changes | M |
| Workspace Volume filesystem + Volume Explorer panel | M |
| Output tab: All Runs timeline with per-run artifact gallery | L |
| Output tab: Diff View (DataTable, code, image, text, numeric) | L |
| Artifact tray on canvas (cards emerge as nodes produce artifacts) | M |
| `browser: serve_project` + `ServingSession` lifecycle management | M |
| `browser: pdf` operation | S |
| Artifact expiry + cleanup job | S |

### Phase 6 — Self-Improvement & MCP (Sprints 9-10)

| Item | Effort |
|------|--------|
| Workspace analytics dashboard | L |
| Instinct engine (pattern detection + auto-patch) | L |
| Cost intelligence (per-node breakdown, trend chart) | M |
| Scheduler UI (cron/event triggers via canvas) | L |
| MCP publication layer | L |
| Git sync for workflows | M |
| Workflow marketplace / template gallery | L |

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

The gap n8n can never close: their execution model is deterministic. Every n8n node is a pure function. Adding native reasoning requires rebuilding the platform. Agentis `agent_task` nodes reason with workspace context, persistent memory, and specialist roles. That is the architectural moat.

### Against OpenAI Operator / Anthropic Computer Use

These give AI direct computer access but no structure. No phase gate, no budget governance, no human approval protocol, no audit trail. A company cannot safely run its quarterly reporting on "AI that browses the web and does things." They need the workflow structure — the observable, auditable, phase-gated execution model — that Agentis provides. Browser control is one node inside a larger orchestrated system. That is the correct framing.

### Against Devin / Cursor Background Agent

Coding-specific. Agentis is company-wide automation. Engineering is one sector we automate. Marketing, sales, finance, HR are others. The Planner agent reading WORKSPACE.md for a marketing team has the same architecture as one for an engineering team — different specialists, different integrations, same execution fabric.

---

## 9. Metrics That Define Success

| Metric | Today | Phase 1 | Phase 3 | Phase 6 |
|--------|-------|---------|---------|---------|
| "Hello World in browser" time | impossible | < 2 min | < 30s | < 15s |
| `build_workflow` complex success rate | ~10% | 25% | 85% | 92% |
| Workflows with zero agent_task nodes | 0% | 20% | 50% | 65% |
| Output tab: % runs with rendered output | 0% | 70% | 95% | 99% |
| Max supported workflow phases | 1 | 1 | unlimited | unlimited |
| Users creating 2nd workflow within 7 days | baseline | +20% | +60% | +85% |
| Workflow run failure rate | ~30% | ~20% | ~8% | ~4% |
| Avg agent task cost per workflow run | $0.12 | $0.09 | $0.04 | $0.02 |

---

## 10. Architecture Principles (Enforced)

1. **Native before external.** Any operation that runs locally (Playwright, Node.js fs, pure TS) must never call an external API.

2. **Workspace context is always injected.** No agent call starts without `WORKSPACE.md + MEMORY.md`. This is infrastructure, not a feature toggle.

3. **Plan before build.** Complex requests go through the Planner's HTN protocol. The plan is presented and approved before a single node is written.

4. **Deterministic first.** If a step requires no reasoning, it gets a deterministic node. Agent tasks are for reasoning, generation, interpretation — nothing else.

5. **Every output is a rendered artifact.** Workflows produce human-readable results. Raw JSON in the output tab is a failure mode.

6. **Self-improvement is structural.** The instinct engine is not a future nice-to-have. It is how the platform becomes more valuable the longer it runs.

7. **The audit trail is sacred.** Every action in every workflow run is attributed, timestamped, and inspectable. This is what makes multi-agent automation safe on production systems.

8. **Budget governance is non-negotiable.** No workflow runs without a budget. No phase starts if the budget is exhausted.

9. **Every output type has a dedicated renderer.** The output surface is a type registry, not a generic component. A leads table renders as an interactive DataTable with sort, filter, pivot, and export. A generated website renders as a live WebsitePreview served from the Workspace Volume. A codebase renders as a navigable file tree with syntax highlighting. Raw bytes in a download button is a failure mode.

10. **The Workspace Volume is the agent's hard drive.** Artifacts are immutable run receipts. The Volume is the live, mutable filesystem where agents build. Coder writes projects here. Builder deploys sites from here. Analyst accumulates datasets here. Everything agents build is explorable, persistent, and independently useful — not ephemeral output that vanishes with the run.

---

*This document supersedes `WORKFLOW-10X-MASTERPLAN.md` v1 (May 22, 2026) and `ENGINE-10X.md` for the next development phase.*

---

## Implementation Log

> Append-only. Each entry records what was actually built against this plan,
> dated, with the files touched and how it was verified. Newest at the bottom.

### 2026-05-22 — Codebase audit + Layer 6 foundation (Output Surface) + `return_output`/`artifact_save`

**Context.** First implementation pass. Began with a full audit of the engine
against this plan (see §0.5). Key realization: the engine already implements most
of Layers 3–4; the real Phase-1 gap is the *output surface* (HTML was rendered as
raw text) and the explicit output/artifact nodes. Chose the Output Surface vertical
first because it is the highest-visibility, lowest-risk slice — it does **not** touch
the in-flight `brain-apps` adapter refactor and does **not** require the (uninstalled)
Playwright runtime.

**Shipped.**
- **`return_output` node** (Layer 6) — new node kind + `OutputRenderAs`
  (`html|markdown|table|json|text`). Engine resolves the value and tags it with the
  render hint; the Output API treats `return_output` (and legacy `isOutput`) nodes as
  the declared output surface and surfaces `renderAs` to the web.
- **`artifact_save` node** (Layer 4) — persists a value to the `artifacts` store
  (inline content, V1), inferring artifact type + MIME from filename/content.
- **Universal Output Surface, V1** (Layer 6) — web `LiveHTMLRenderer` (sandboxed
  `iframe sandbox="allow-scripts"`, device-mode toolbar, open-in-new-tab), `renderAs`
  dispatch in `RunOutputCard` (html→iframe, markdown→`ChatMarkdown`, table, json, text),
  auto-detection of legacy `{type:'html',content}` payloads, and a new
  `WorkflowArtifactGrid` (artifact cards with inline HTML preview + download), wired into
  `WorkflowOutputTab` via `GET /v1/artifacts?runId=`.
- **`build_workflow`** now emits `trigger → transform → return_output(renderAs)` for
  static/HTML outputs instead of the `transform + isOutput` idiom; LLM synthesis prompt
  taught the two new nodes.
- **Latent bug fixed.** The `artifacts` table existed in Drizzle `schema.ts` but was
  created by *neither* `embedded-sql.ts` nor any migration — every `artifact_collect` /
  `artifact_save` / `/v1/artifacts` write would have failed with "no such table." Added
  the `artifacts` DDL (+ indexes) to `embedded-sql.ts`.
- Added the missing `type` field to the Zod `workflowEdgeSchema` (the engine already
  honored `edge.type='error'`, but the schema silently dropped it).

**Files touched.** `packages/core/src/types/workflow.ts`,
`packages/core/src/schemas/workflow.ts`, `apps/api/src/engine/WorkflowEngine.ts`,
`apps/api/src/routes/workflows.ts`, `apps/api/src/services/agentisToolHandlers/build.ts`,
`packages/db/src/sqlite/embedded-sql.ts`, `apps/web/src/components/workflows/RunOutputCard.tsx`,
`apps/web/src/components/workflows/WorkflowArtifactGrid.tsx` (new),
`apps/web/src/components/workflows/WorkflowOutputTab.tsx`,
`apps/api/tests/engine/WorkflowEngine.outputSurface.test.ts` (new).

**Verified.** `typecheck` clean across `@agentis/core`, `@agentis/api`, `@agentis/web`.
Tests green: new `WorkflowEngine.outputSurface.test.ts` (return_output renderAs +
artifact_save persistence), plus existing engine/route/schema suites (31 + 6 db). UI
rendering is type-checked and logic-tested but **not yet exercised in a live browser**
(needs a seeded completed run with HTML output) — flagged for follow-up verification.

**Next candidates.** (1) `browser` node + Playwright BrowserPool (needs dep approval) to
finish the literal Hello-World demo; (2) Layer 1 Workspace Intelligence (new context
service — note §1.3's reference is wrong); (3) wire `return_output`/`artifact_save` into
the canvas NodePalette + inspector; (4) markdown/table viewers polish toward the full
viewer registry (§6.1).

### 2026-05-22 — Layer 1 Workspace Intelligence + Workspace Volume + native `browser` node

**Context.** Big batch on the user's direction: "Playwright self-installs on demand
(cannot defer), then Layer 1 and more." Three tightly-coupled subsystems shipped:
the Workspace Volume (the filesystem the other two stand on), Layer 1 Workspace
Intelligence (RC1), and the native `browser` node (finishes the Hello-World demo).

**Shipped.**
- **Workspace Volume** (§4.4) — `WorkspaceVolumeService` rooted at
  `{AGENTIS_DATA_DIR}/workspace/{workspaceId}/` with read/write/append/list/scaffold and
  a single path-escape chokepoint (`WORKSPACE_VOLUME_PATH_ESCAPE`, new error code) +
  the conventional dirs (projects/sites/reports/datasets/assets/context).
- **Layer 1 — Workspace Intelligence** (§1.2–1.6, RC1) — new `WorkspaceIntelligenceService`
  reads `context/{WORKSPACE,MEMORY,DECISIONS}.md` from the Volume, seeds defaults on first
  read, parses MEMORY.md structured entries (`[date][uses:N][wf:slug][conf]`), and
  relevance-scores them (recency·0.40 + usage·0.35 + workflowMatch·0.25, confidence-nudged)
  within a token budget for `buildContextBlock()`. Distinct from the misnamed
  `WorkspaceContextService` (a tenant resolver) — §1.3's reference was wrong.
- **Context injection** (Principle #2) — `buildContextBlock()` is prepended to every
  `agent_task` prompt (engine-level `#withWorkspaceContext`, not the in-flight adapter
  files) and to the `build_workflow` LLM synthesis prompt. Best-effort: a context-read
  failure never blocks a dispatch.
- **Context API** — `GET/PUT /v1/workspace-context[/:file]` (Settings > Workspace > Context),
  returns the three files + the assembled block agents actually see.
- **Native `browser` node** (§3.2) — `BrowserPool` runs headless Chromium via Playwright,
  capped by `AGENTIS_BROWSER_CONCURRENCY` (semaphore). **On-demand install**: `playwright`
  is a declared dep; the Chromium binary auto-installs (single-flight, via the Playwright
  CLI) on first use if missing. Typecheck is decoupled from Playwright via a non-literal
  dynamic import + local shim, so a fresh checkout still `tsc`s. Operations: `serve_html`,
  `screenshot`, `pdf`, `navigate`, `extract_text` — screenshots/PDFs persisted as `data:`-URL
  artifacts. `build_workflow` now emits a `browser` serve_html node when the prompt mentions
  "open a browser"/"screenshot".

**Files touched.** New: `services/workspaceVolume.ts`, `services/workspaceIntelligence.ts`,
`services/browserPool.ts`, `routes/workspaceContext.ts`, plus 3 test files. Edited:
`packages/core/src/{types,schemas}/workflow.ts`, `packages/core/src/errors.ts`,
`apps/api/src/engine/{WorkflowEngine,validateGraph}.ts`, `bootstrap.ts`,
`services/agentisToolHandlers/{deps,build}.ts`.

**Verified.** Playwright + Chromium installed (exit 0). Typecheck clean across core/api/web.
Tests green (102 across 15 engine/schema files + service tests): real-Chromium PNG
screenshot (magic-byte check), MEMORY.md parse/score/select, Volume path-escape guard,
and a full engine e2e — `trigger → transform → browser(serve_html) → return_output(html)`
completing with a persisted image artifact and the HTML flowing through. **The literal
"Hello World in a browser" path now works end-to-end through the real engine.**

**Deferred.** `browser: serve_project` + live `ServingSession`/WebsitePreview (needs a
long-lived HTTP server tied to the run); specialist agents + `agentRole` (Layer 2, touches
the in-flight adapter path); canvas palette/inspector entries for the new nodes; full UI
browser verification (needs a seeded run + dev server).
