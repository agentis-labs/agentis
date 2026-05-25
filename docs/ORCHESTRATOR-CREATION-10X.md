# Orchestrator Creation Engine — 10x Plan
## The End-to-End Architecture for World-Class Workflow Creation in Agentis

*May 2026. This document defines the complete architecture for making Agentis the
best workflow creation experience on the planet — not just for one workflow, but for
every workflow every user will ever create. The north star is: a user describes what
they want, in natural language, to any agent they trust, and gets a perfectly
structured, production-ready workflow that actually runs.*

> **How to read this document.** Sections 0–6 fix the creation pipeline — necessary
> but not differentiating. Section 7 introduces the **Integration Wiring Node**: the
> amber-pulsing canvas state + inline credential setup that turns broken integration
> nodes into a live wiring experience. Section 8 introduces the **Specialist Assembly
> Protocol**: the 10-role library drives synthesis by tool manifest, not keyword guess.
> Section 9 introduces the **Builder Session**: the only creation paradigm in the
> industry where the operator co-authors the workflow phase-by-phase in a live session.
> *The pipeline is hygiene. Sections 7–9 are the moat.*

---

## 0. The Honest Starting Point

Before proposing any architecture, it helps to understand exactly why creation is
broken today. There are three revelations.

### Revelation 1 — The Context Erasure Problem

Every agent in Agentis that enters the chat loop loses its identity. Completely.

`ChatSessionExecutor.turn()` always calls `buildOrchestratorSystemPrompt()`, which
opens with:

> "You are the Agentis platform orchestrator: the central intelligence for this
> workspace."

This string is written to every agent's context — the researcher, the content
manager, the ops manager, the specialist you trained to know your entire tech stack.
The moment they enter a chat turn, their `instructions`, their `role`, their
`capabilityTags`, their domain expertise — all of it is discarded. They become
a generic orchestrator wearing a different name badge.

The function signature doesn't even accept `agentInstructions`. It's not a bug. It
was never a feature. Agent identity was never designed to survive the chat boundary.

**The real-world consequence:** When a user chats with their content manager agent
and says "build me a social content calendar workflow," that manager — who knows the
team uses Buffer, Notion, and Slack; who knows the posting cadence; who knows which
humans approve content — contributes zero of that knowledge to the workflow being
built. The synthesis LLM is flying completely blind about the domain it's building for.

### Revelation 2 — The Five Layers of Context Loss

The path from "user says what they want" to "workflow node in canvas" has five
separate places where context is dropped:

```
Layer 1: User speaks to their domain-expert agent
         → Agent's instructions/role IGNORED in chat system prompt
         → Lost: all agent domain expertise

Layer 2: Agent decides to call agentis.build_workflow
         → synthesizeWithLlm() receives workspace context + agents list
         → Missing: calling agent's instructions, available credentials,
                    configured integrations, workspace tool inventory

Layer 3: LLM synthesizes the workflow graph
         → No constraint against collapsing multiple steps into one agent_task
         → No rule requiring http_request for URL fetches
         → No rule requiring integration nodes for email/Slack/GitHub/etc
         → Result: one giant agent_task with the whole prompt verbatim

Layer 4: Graph is emitted to canvas
         → agentRole not shown in ContextInspector (invisible to operator)
         → No model override in AgentTaskForm
         → No "agent offline" or "credential missing" warnings
         → Result: operator sees a broken-looking workflow with empty fields

Layer 5: Operator tries to run the workflow
         → Specialist agents seeded as 'offline' — execution fails
         → Integration nodes may lack credentials — execution fails
         → No pre-flight check caught this before the build
         → Result: workflow created, run fails, operator gives up
```

This is not a prompt problem. It is a pipeline problem. Fixing `SYNTHESIS_SYSTEM_PROMPT`
improves Layer 3 marginally. The real fix requires every layer.

### Revelation 3 — Role Change Doesn't Regenerate Identity

There is a third failure that works in the opposite direction from Revelation 1.

When the operator changes an agent's role — say, promoting a Department Manager to
`orchestrator` — the platform keeps the old `agentis.md` platform instruction file
unchanged. The agent now carries the wrong identity in storage:

```
Before:  role = 'manager'   →  agentis.md: "You are Department Manager..."
After:   role = 'orchestrator'  →  agentis.md: "You are Department Manager..." (unchanged)
```

The agent is labelled orchestrator in the UI, behaves like orchestrator in the chat
loop (Revelation 1 makes every agent the orchestrator anyway), but has manager
instructions written to disk. When an external runtime reads `agentis.md` to
configure itself — Codex, Claude Code, any HTTP adapter — it reads stale, wrong
instructions.

This is the identity problem from the other side: not erasure at runtime, but
**staleness at rest**. The stored instructions no longer match the declared role.

**The fix:** Whenever `role` is changed on an agent, the platform must regenerate
(or prompt the operator to regenerate) the `agentis.md` platform instruction block to
match the new role. The role-specific instruction template for each role type
(`orchestrator`, `manager`, `researcher`, etc.) should be a first-class resource —
not something that only applies to newly-created agents.

---

## 1. The Architecture Vision

### The Thesis

The best agent platforms treat workflow creation as a **first-class agentic act** —
not a template lookup, not a regex substitution, not a single LLM call with a long
system prompt. Creation is a pipeline with its own intelligence, its own context
assembly, its own quality gates, and its own feedback loop.

Anthropic's research on building effective agents states it plainly:
> "The most successful implementations weren't using complex frameworks or
> specialized libraries. They were building with simple, composable patterns."

The Agentis creation engine should be composable. Each stage should be independently
testable, improvable, and replaceable. The whole pipeline should be observable — the
operator should see every decision the creation engine makes, be able to inspect it,
and be able to intervene.

### The Mental Model: The Creation Session

When a user asks any agent to build a workflow, a **Creation Session** begins. A
Creation Session is a first-class object that:

1. Preserves the calling agent's full identity and domain context
2. Assembles the workspace's complete "what can we actually build" inventory
3. Runs intent classification and complexity assessment before synthesis
4. Synthesizes the best possible graph given the constraints
5. Validates the graph against what will actually run (not just what's valid JSON)
6. Streams the build to the operator with live explanation
7. Flags unresolved dependencies before the run is attempted

The Creation Session is the unit of improvement. Every metric — complex workflow
success rate, time-to-first-run, agent-task collapse rate — is measured per Creation
Session. Every improvement is a change to a stage in this pipeline.

---

## 2. The Architecture

### The Six-Stage Creation Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CREATION SESSION                                     │
│                                                                              │
│  [1. IDENTITY ASSEMBLY]   Build the caller's full context                    │
│       ↓                                                                      │
│  [2. WORKSPACE INVENTORY] What can we actually build here?                  │
│       ↓                                                                      │
│  [3. INTENT + COMPLEXITY GATE]  What kind of workflow is this?              │
│       ↓                                                                      │
│  [4. SYNTHESIS]           Build the graph (mode selected by gate)           │
│       ↓                                                                      │
│  [5. VALIDATION + ENRICHMENT]  Does this actually run?                      │
│       ↓                                                                      │
│  [6. STREAMING BUILD]     Stream to canvas, explain every node               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Stage 1 — Identity Assembly

**What it does:** Before anything else, build a complete "who is asking, and what do
they know?" context block.

**The problem it solves:** Agent identity erasure. Every Creation Session begins by
reading the calling agent's full record from the database and assembling it into a
context block that propagates through all downstream stages.

**The CallerContext type:**

```typescript
interface CallerContext {
  agentId: string;
  agentName: string;
  role: string | null;             // 'manager' | 'researcher' | 'writer' | ...
  instructions: string | null;     // The agent's full system prompt
  capabilityTags: string[];        // What this agent is good at
  // Inferred from instructions via lightweight classification:
  domainKeywords: string[];        // e.g. ['content', 'social', 'scheduling']
  mentionedIntegrations: string[]; // e.g. ['Buffer', 'Notion', 'Slack']
  mentionedTools: string[];        // e.g. ['web_search', 'scheduling']
}
```

**How it flows downstream:**
- Stage 2 uses `mentionedIntegrations` to prioritize integration inventory
- Stage 3 uses `role` and `domainKeywords` to classify intent
- Stage 4 uses `instructions` as a domain brief in the synthesis prompt
- Stage 6 uses `agentName` to narrate "Your content manager built this with..."

**Implementation:** A new `CallerContextService.assemble(agentId)` that reads the
agent row and runs a cheap classification pass over `instructions` to extract
`domainKeywords`, `mentionedIntegrations`, and `mentionedTools`. This is a one-time
read at session start, not a per-turn operation.

---

### Stage 2 — Workspace Inventory

**What it does:** Answer the question "what can we actually build here?" with
concrete facts about this workspace's configuration.

**The problem it solves:** The synthesis LLM currently builds in a vacuum. It doesn't
know what connectors are configured, what agents are available and online, what skills
exist, what credentials are stored. It builds workflows that are structurally valid
but operationally impossible because a required credential doesn't exist.

**The WorkspaceInventory type:**

```typescript
interface WorkspaceInventory {
  // Agents that can actually execute (not just seeds)
  availableAgents: Array<{
    id: string;
    name: string;
    role: string | null;
    adapterType: string;
    status: 'online' | 'offline' | 'error';
    capabilityTags: string[];
  }>;

  // Credentials by integration type
  configuredCredentials: Array<{
    id: string;
    name: string;
    integrationSlug: string;    // 'slack' | 'gmail' | 'github' | ...
    isVerified: boolean;
  }>;

  // Skills available for skill_task nodes
  availableSkills: Array<{
    id: string;
    slug: string;
    name: string;
    applicableTo: string[];
  }>;

  // Knowledge bases for knowledge nodes
  knowledgeBases: Array<{
    id: string;
    name: string;
    documentCount: number;
  }>;

  // Integrations that have at least one credential configured
  wireableIntegrations: string[];  // ['slack', 'gmail']

  // Workspace context summary (condensed from WORKSPACE.md/MEMORY.md)
  workspaceContext: string;
}
```

**Why `wireableIntegrations` matters:** This is the key field the synthesis LLM uses
to decide whether to wire an integration node or emit a placeholder. If `gmail` is
in `wireableIntegrations`, the LLM generates a real `integration` node with
`credentialId`. If not, it generates a `checkpoint` node with "configure Gmail
credential to enable email delivery" as the instruction — instead of a broken
integration node that will fail at runtime.

**Implementation:** `WorkspaceInventoryService.build(workspaceId)` — assembles from
existing DB queries. Cached per workspace, TTL 30s. Never blocks the creation
session; a stale or empty inventory falls back gracefully.

---

### Stage 3 — Intent Classification + Complexity Gate

**What it does:** Classify the request into one of four archetypes and route it to
the right synthesis mode.

**The problem it solves:** A single synthesis path cannot serve both "hello world"
and "multi-source competitor intelligence engine with ensemble analysis and Slack
alerts." These need radically different treatment. The current code has one regex
path and one LLM call. Both produce the same 3-node result for complex inputs.

**The four archetypes:**

```
ARCHETYPE        COMPLEXITY    SYNTHESIS MODE    EXAMPLE
───────────────────────────────────────────────────────────────────
ATOMIC           Low           template          "Send me a Slack when a PR merges"
PIPELINE         Medium        LLM-fast          "Summarize my Notion meeting notes daily"
ORCHESTRATED     High          LLM-deep          "Morning AI digest: scrape, analyze, email"
ENTERPRISE       Very High     planner           "Competitor intelligence engine with 5 sources"
```

**Classification signals:**
- Node count estimate (heuristic from keyword density)
- Number of distinct integrations mentioned
- Number of distinct data sources
- Presence of scheduling + delivery + multiple processing steps
- CallerContext `role` (a `manager` agent asking something complex → bias toward `ORCHESTRATED`)
- Whether workspace has the required credentials for the stated integrations

**Routing:**
```
ATOMIC      → Template Library (fast, deterministic, no LLM)
PIPELINE    → LLM Synthesis (WORKFLOW_SYNTHESIS_MODEL, 4o-mini speed)
ORCHESTRATED → LLM Synthesis (WORKFLOW_SYNTHESIS_MODEL, with deep mode prompt)
ENTERPRISE  → Planner Protocol (Phase 3: HTN planning with plan confirmation)
```

**The gate output:**
```typescript
interface IntentClassification {
  archetype: 'atomic' | 'pipeline' | 'orchestrated' | 'enterprise';
  extractedTriggerType: 'manual' | 'cron' | 'webhook';
  requiredIntegrations: string[];       // e.g. ['gmail', 'slack']
  missingCredentials: string[];         // integrations with no configured credential
  estimatedNodeCount: number;
  estimatedAgentRoles: string[];
  requiresPlanConfirmation: boolean;    // true for 'enterprise'
}
```

If `missingCredentials` is non-empty, the creation session emits a warning *before*
building: "This workflow needs Gmail. Set up a Gmail credential first, or I'll use a
placeholder checkpoint node instead." The operator decides. The workflow is not built
broken by default.

---

### Stage 4 — Synthesis

**What it does:** Build the actual workflow graph using the best method for the
classified archetype.

#### 4.1 Template Library (ATOMIC)

Expanded from the current `matchTemplate()` with a typed, testable library of
single-purpose workflow patterns. Each template is a pure function:
`(trigger, integrations, callerContext) → WorkflowGraph`.

```
Template Catalog (Phase 1 of this plan):
  notify_on_event    → trigger + filter + integration(notify)
  daily_digest       → cron + knowledge + agent_task + integration(email)
  pr_review          → webhook + skill(code-review-rubric) + integration(github)
  data_transform     → trigger + http_request + transform + artifact_save
  approval_gate      → trigger + agent_task + checkpoint + integration(notify)
  scrape_summarize   → trigger + http_request + agent_task + return_output
  form_fill          → trigger + browser(fill_form) + return_output
  scheduled_report   → cron + knowledge + agent_task + return_output(markdown)
```

Templates use `wireableIntegrations` from Stage 2 to choose real integration nodes
vs. placeholder checkpoints.

#### 4.2 LLM Synthesis (PIPELINE + ORCHESTRATED)

The most important rewrite in this plan. The synthesis LLM currently receives a
generic node catalog and produces generic graphs. The upgraded version receives a
**rich creation brief** that makes domain-specific, operationally-valid graphs
possible.

**The Creation Brief:**

```typescript
interface CreationBrief {
  // What the user asked for
  userRequest: string;

  // Who is building this (Stage 1)
  callerDomain: string;        // Condensed from CallerContext.instructions
  callerRole: string | null;
  callerMentionedTools: string[];

  // What we can actually wire (Stage 2)
  wireableIntegrations: string[];     // Only confirmed credentials
  availableAgents: Array<{ name: string; role: string; tags: string[] }>;
  availableSkills: string[];

  // What we know about the workspace
  workspaceContext: string;           // WORKSPACE.md + MEMORY.md condensed

  // Classification result (Stage 3)
  triggerType: 'manual' | 'cron' | 'webhook';
  missingCredentials: string[];       // So LLM can use checkpoints instead
  estimatedComplexity: 'pipeline' | 'orchestrated';
}
```

**The upgraded Synthesis System Prompt:**

The current `SYNTHESIS_SYSTEM_PROMPT` is a node catalog. The upgraded version is a
**workflow architecture protocol** with enforced rules:

```
WORKFLOW ARCHITECTURE PROTOCOL

You are a workflow architect. Your job is to translate a user's intent into a
perfectly structured Agentis workflow graph. You have a complete inventory of what
this workspace can actually do.

IRON RULES (never violate these):
1. If the workflow fetches data from a URL, use an http_request node — never
   delegate URL fetching to an agent_task prompt.
2. If the workflow sends email/Slack/GitHub notifications, use an integration
   node with the credential from wireableIntegrations — never ask an agent to "send
   an email" in its prompt.
3. If a required integration is NOT in wireableIntegrations, use a checkpoint node
   with the instruction: "Configure [integration] credential to enable this step."
4. An agent_task node must have exactly ONE responsibility. If a node's prompt
   contains more than one distinct action (fetch AND summarize AND send), split it.
5. Use deterministic nodes (transform, filter, http_request) wherever the output
   is fully determined by the input. Agent tokens are expensive.
6. A cron trigger means the workflow runs automatically — do not include a manual
   review step unless the user explicitly requested one.

DOMAIN BRIEF:
The workflow is being built by: {callerRole} — {callerDomain}
Workspace context: {workspaceContext}
Available integrations (credentials configured): {wireableIntegrations}
Available agent roles: {availableAgents}

BUILD THE GRAPH. Do not summarize. Do not explain. Return JSON only.
```

The key additions: **domain brief from the calling agent**, **available integrations
list (only real ones)**, and **iron rules that prevent collapse and phantom wiring**.

#### 4.3 Planner Protocol (ENTERPRISE — Phase 3)

For enterprise-complexity workflows, the synthesis LLM does not build immediately.
It produces a **Workflow Plan** — a structured decomposition into named phases, each
with responsible agent roles, integration requirements, and estimated cost range.

```typescript
interface WorkflowPlan {
  phases: Array<{
    name: string;
    description: string;
    nodes: string[];          // Node type labels
    agentRole: string | null;
    requiredCredential: string | null;
    estimatedCostCents: [number, number]; // range
  }>;
  totalEstimatedDuration: string;
  totalEstimatedCost: string;
  missingDependencies: string[];
  question?: string; // One clarifying question, if any
}
```

The plan is rendered as **Phase Cards in the chat panel** — compact, actionable,
approvable. The operator sees what will be built before a single canvas node is
created. After approval (or inline edit), the graph is synthesized from the
approved plan, not from the raw prompt.

This is the Anthropic principle in action:
> "Prioritize transparency by explicitly showing the agent's planning steps."

The Planner Protocol is not a bottleneck for simple workflows. The Complexity Gate
in Stage 3 only routes here for genuine enterprise complexity. A morning digest
workflow never hits the planner.

#### 4.4 Specialist Casting

Today, `agentRole: 'researcher'` is assigned whenever something "sounds like
research." This is the wrong model. Role assignment must be driven by **capability
requirements** — what tools does this node's task actually need?

Agentis already ships 10 specialist roles with precise tool manifests in `ROLE_TOOLS`.
These manifests are the ground truth for what each role can do:

| Role | Tools | Best for |
|------|-------|----------|
| `planner` | knowledge_search, call_workflow | Decomposition, orchestration |
| `researcher` | web_search, read_url, knowledge_search | Fetching + synthesizing external data |
| `coder` | read_file, write_file, run_code, git_status | Code generation |
| `reviewer` | read_file, git_diff, search_code | Code/content review |
| `analyst` | read_file, run_code, knowledge_search | Data transformation, scoring |
| `writer` | web_search, read_url, read_file | Content drafting, summarization |
| `monitor` | read_url, knowledge_search, call_workflow | Recurring checks, alerts |
| `architect` | read_file, search_code, git_diff | System design, technical evaluation |
| `debugger` | read_file, run_code, search_code, git_diff | Root-cause analysis |
| `deployer` | read_file, call_workflow | Deployment sequences, ops automation |

The `CreationBrief.availableAgents` is upgraded to include each role's full tool
manifest. The synthesis LLM selects the **minimum sufficient role** for each node:

- Node that needs URL fetching → must be `researcher` or `writer` (only roles with
  `read_url`). Prefer `researcher` for analysis-oriented fetching, `writer` for
  content-oriented fetching.
- Node that needs `run_code` → `analyst` (data processing) or `coder` (generation).
- Node that reviews a diff → must be `reviewer` (only role with `git_diff`).
- Node that sends messages → `ops` integration node, not an agent role.

The synthesis LLM also stores a `castingReason` on each node — a one-sentence
explanation that the ContextInspector surfaces on hover:

```
[R] Researcher   "Needs web_search + read_url for URL content extraction"
```

Stage 5 validation adds a CAPABILITY_MISMATCH check: if a node's inferred tool
requirements don't intersect with the assigned role's tool manifest, the node is
flagged before the operator sees the graph.

**Team Roster emit:** After synthesis, before streaming the graph to canvas, the
creation session emits a Team Roster in the chat panel:

```
Assembling team for this workflow...

[R]  Researcher   web_search, read_url         online
[A]  Analyst      run_code, knowledge_search   offline   ⚠ runtime not connected
[W]  Writer       web_search, read_url         online

⚠ Analyst runtime not connected. Node 4 will fail on first run.
[Connect runtime →]
```

The operator sees their team before the graph appears. Offline specialists get a
direct link to connect a runtime — not a failure after the first run.

---

### Stage 5 — Validation + Enrichment

**What it does:** Before emitting the graph to the canvas, run it through a
pre-flight check that catches issues that `validateGraph()` doesn't catch today.

**The problem it solves:** Today, `validateGraph()` checks schema validity. It does
not check operational validity. A workflow can pass validation and still fail
immediately on first run because an agent is offline, a credential is missing, or
a `agentRole` has no configured runtime.

**The pre-flight checks:**

```
CHECK 1 — Agent binding resolution
  For every agent_task node:
  - If agentId is set: verify agent exists and adapter ≠ 'offline'
  - If agentRole is set: verify specialist role exists in this workspace
  - If neither: flag as UNBOUND — emit warning to canvas

CHECK 2 — Credential verification
  For every integration node:
  - Verify credentialId is set and exists in credentials table
  - If missing: replace node with checkpoint + TODO instruction
  - Emit CREDENTIAL_REQUIRED warning to chat panel

CHECK 3 — Loop/parallel body validation
  For every loop and parallel node:
  - Verify bodyWorkflowId or subWorkflowId is set and exists
  - If missing: emit BODY_REQUIRED warning

CHECK 4 — Dead end detection
  Walk the graph. Any node with no outgoing edge (except terminal nodes) is flagged.
  A graph with dead ends is always a synthesis error.

CHECK 5 — Cost estimation
  Estimate total run cost based on node types:
  - agent_task: model's $/1K token rate × estimated tokens
  - http_request: ~$0
  - skill_task: ~$0
  - integration: ~$0
  Total emitted to canvas status bar and chat narration.
```

**Enrichment:** After validation, the engine enriches the graph:
- Binds `agentId` from `agentRole` where possible (if specialist already exists)
- Sets `credentialId` on integration nodes from `wireableIntegrations` inventory
- Adds `isOutput: true` to the terminal `return_output` node

**Output:** A `ValidationResult` with `warnings[]`, `errors[]`, and an `enriched`
graph. Errors block the build. Warnings stream to the chat panel as inline
suggestions: "⚠ Gmail credential not configured — added a checkpoint. Set it up
to complete this workflow."

---

### Stage 6 — Streaming Build + Live Narration

**What it does:** Emit the graph to the canvas with streaming node-by-node
construction and a live narration in the chat panel.

**The problem it solves:** Today, the canvas shows the final graph all at once after
`build_workflow` completes. The operator has no visibility into why each node was
chosen, what it does, or what the callerAgent contributed. It feels like a magic box,
not a collaborator.

**The streaming protocol:**

```
1. Chat panel: "Building your workflow..."
   Canvas: empty

2. For each node (in topological order):
   → Emit CANVAS_NODE_ADD event (node appears on canvas, animates in)
   → Emit chat fragment: "Added [node type]: [reason from nodeReason()]"

3. After all nodes:
   → Emit CANVAS_EDGE_ADD batch (edges connect the nodes)
   → Emit cost estimate to canvas status bar

4. Final chat narration:
   "[Agent name] built this with [N] nodes. 
    Trigger: [trigger description].
    [Integration nodes]: Uses [integration] via [credential name].
    Estimated cost per run: $[range].
    [Warnings if any]."
```

The narration template uses `callerContext.agentName` so it reads as:
"**Your content manager** built this with 6 nodes..."

This is the difference between a tool and a collaborator.

---

## 3. The Manager Agent Problem — Full Solution

The manager agent problem is a manifestation of the identity erasure issue, but it
has its own solution path because managers have a specific superpower that should be
preserved: **domain authority**.

### What a Manager Agent Should Be in Agentis

A manager agent is an agent with:
- Deep instructions about a business domain (content ops, sales, engineering, finance)
- Knowledge of which integrations the team actually uses
- Conventions about how work should be structured in this domain
- Authority to decide workflow architecture for their domain

This is exactly what `role`, `backstory`, and `instructions` encode in CrewAI's model.
In Agentis, these exist in the `agents.instructions` field but never survive the chat
boundary.

### The Fix: Agent-Persona-Aware Chat

`ChatSessionExecutor.turn()` is called for every agent. The fix is not to change the
global orchestrator prompt — it is to augment it with the calling agent's identity
when the calling agent is not the orchestrator.

```typescript
// In ChatSessionExecutor.turn():
const callerAgent = await this.#db.getAgent(ctx.agentId);
const isOrchestrator = callerAgent?.role === 'orchestrator' || !callerAgent?.instructions;

const baseSystemPrompt = buildAgentAwareSystemPrompt({
  context: ctx,
  agentName: callerAgent?.name,
  agentRole: callerAgent?.role,
  // NEW: inject agent instructions if not the default orchestrator
  agentInstructions: isOrchestrator ? null : callerAgent?.instructions,
  agentCapabilityTags: callerAgent?.capabilityTags ?? [],
  ...this.#loadPromptContext(ctx),
});
```

In `buildAgentAwareSystemPrompt()`, the agent instructions are injected as:

```
PLATFORM KNOWLEDGE
[...existing PLATFORM_KNOWLEDGE content...]

YOUR IDENTITY AND DOMAIN EXPERTISE
You are [agent name]. [agent instructions verbatim, up to 2000 tokens]

CURRENT CONTEXT
Workspace: [workspace]
Your role in this workspace: [role]
Your capabilities: [capabilityTags]
...
```

The platform knowledge stays. The orchestrator behavior rules stay. But now the
manager's domain expertise is present when they call `build_workflow`. The synthesis
LLM gets the caller domain brief. The workflow is built for the domain.

### The Domain Brief Injection

The `agentInstructions` from the manager flow directly into the `CreationBrief.callerDomain`:

```typescript
function extractCallerDomain(instructions: string | null): string {
  if (!instructions) return '';
  // Lightweight extraction: first 800 chars + domain keyword extraction
  const keywords = extractDomainKeywords(instructions);
  return `${instructions.slice(0, 800)}\nDomain keywords: ${keywords.join(', ')}`;
}
```

When the content manager's instructions say "we use Buffer for social scheduling,
Notion for drafts, Slack for team alerts, and we always need human approval before
publishing" — all of that flows into the synthesis LLM as domain context. The
workflow built will have a Buffer integration node, a Notion integration node, a
Slack integration node, and a checkpoint node. Not because the regex matched, but
because the manager told the synthesis LLM exactly what this domain needs.

---

## 4. The Canvas Side — Inspector and Feedback

The creation pipeline produces a great graph. The canvas must display it correctly.
Today it doesn't. These are the three critical fixes:

### Fix 1 — agentRole in ContextInspector

The `AgentTaskForm` only shows the `agentId` dropdown. Workflows built with
`agentRole` show an empty "— Pick an agent —" select to the operator, who has no
idea the node is correctly configured. This is the inspector lying to the operator.

**Fix:** When `data.agentRole` is set and `data.agentId` is empty, render:

```
Agent Role    [researcher ▼]    (Specialist auto-assigned at runtime)
              ──────────────────
              Or bind to a specific agent:
Agent         [— Pick an agent —]
```

The role is shown first as a readonly badge with a description of the specialist.
The dropdown is offered as an optional override. The operator understands: this node
has a defined specialist role and will work.

### Fix 2 — Model Override in AgentTaskForm

The `ModelChooser` component exists and is excellent. It is used only on the Agent
detail page. It belongs in `AgentTaskForm` too — directly below the agent selector.

```typescript
function AgentTaskForm({ data, update, agents, upstream }) {
  const agentId = asStr(data.agentId);
  const adapterType = resolveAdapterType(agents, agentId);
  return (
    <>
      {/* ... agent/role selectors ... */}
      {agentId && adapterType && (
        <Field label="Model override">
          <ModelChooser
            adapterType={adapterType}
            agentId={agentId}
            value={asStr(data.modelOverride)}
            onChange={(m) => update({ modelOverride: m || undefined })}
            variant="compact"
          />
        </Field>
      )}
    </>
  );
}
```

This lets operators tune the model for individual agent_task nodes without modifying
the agent's global configuration. A workflow can use claude-opus on the synthesis
node and claude-haiku on the formatting node — same workflow, right cost profile.

### Fix 3 — Operational Status in Inspector

When an `agent_task` node has a bound agent, the inspector should show that agent's
operational status:

```
Agent    [Researcher ▼]   ● offline   ⚠ No runtime connected
```

The `● offline` badge with a tooltip explaining what "offline" means and a direct
link to the adapters configuration page. The operator sees immediately: this workflow
will not run until a runtime is connected to this agent. Not as an error after
running. Before.

---

## 5. The Workflow Architecture Grammar

The synthesis LLM knows what nodes exist. What it lacks is a **grammar** — a set of
structural rules that produce architecturally correct workflows regardless of domain.

This grammar should be embedded in the synthesis prompt and enforced by the Stage 5
validation. It has 12 rules:

```
RULE 1  — Single Responsibility
  Every agent_task node has exactly one responsibility.
  "Fetch and summarize" → http_request node + agent_task node.

RULE 2  — Determinism First
  If the output is fully determined by inputs, use a deterministic node.
  "Extract the subject line from this email" → transform node.

RULE 3  — Native Integration
  Sending email/Slack/GitHub events → integration node.
  Never instruct an agent_task to "send an email" in its prompt.

RULE 4  — Source Fetching
  Fetching URL content → http_request node.
  Never instruct an agent_task to "visit the URL and read it."

RULE 5  — Knowledge Before Agent
  If the workflow has access to workspace knowledge, wire a knowledge node
  before the agent_task that needs it. Retrieval is cheaper than reasoning.

RULE 6  — Guard the Expensive Steps
  Any agent_task with output that feeds a delivery action (email, Slack post,
  external API write) should have an evaluator or checkpoint node before
  the delivery.

RULE 7  — Scheduled Workflows Don't Need Manual Review
  A cron trigger means the workflow runs autonomously. Don't add checkpoint
  nodes unless the user explicitly requested human approval.

RULE 8  — Parallel When Independent
  If two branches don't depend on each other's outputs, use a parallel node.
  "Fetch from source A and source B" → parallel(http_request A, http_request B).

RULE 9  — Name Nodes for Their Output, Not Their Type
  Name: "Fetch Hacker News Top Stories" — not "HTTP Request 1".
  Name: "Extract 'Why It Matters' from each story" — not "Agent Task 2".

RULE 10 — Terminal Node is Always return_output or artifact_save
  Every workflow must end with an explicit output node. A workflow that ends
  with an agent_task and no output node is always incomplete.

RULE 11 — Scheduling is a Trigger Property
  "Every morning at 9am" → cron trigger.
  Never add a wait node at the start of a workflow to simulate scheduling.

RULE 12 — Credentials Drive Integration Choices
  If a credential exists for an integration, use it.
  If no credential exists, use a checkpoint with a setup instruction.
  Never wire an integration node with a missing credentialId.
```

These 12 rules are injected into the synthesis system prompt as the IRON RULES block.
Stage 5 validation enforces Rules 1, 10, and 12 programmatically. Rules 2-9 are
enforced through the LLM prompt until pattern-matching detection is added.

---

## 6. WORKFLOW.md — The Workspace's Workflow Constitution

`WORKSPACE.md` tells agents who the company is and what stack they use.
`MEMORY.md` records patterns that worked.

There is a missing third document: **WORKFLOW.md** — the workspace's conventions for
how workflows should be built.

```markdown
# Workflow Conventions — Acme Corp

## Delivery Rules
- Email delivery: always use gmail credential 'team-gmail'
- Slack alerts: always post to #ops-alerts channel
- GitHub: always use github credential 'github-actions-bot'

## Review Policy
- Any workflow that sends external communications requires a checkpoint
- Automated reports: no checkpoint needed
- Anything that creates or modifies records: checkpoint required

## Standard Patterns
- Morning reports: cron(0 8 * * *) → knowledge → agent_task → gmail(digest)
- PR review: webhook(github.pr) → skill(code-review-rubric) → github(comment)
- Content approval: trigger → agent_task → checkpoint(content-lead) → buffer(post)

## Model Preferences
- Summarization tasks: gpt-4o-mini (fast + cheap)
- Code review: claude-sonnet (best reasoning)
- Content drafting: claude-sonnet (best prose)

## Cost Guardrails
- No workflow should cost more than $0.50/run in normal operation
- Swarm tasks: max 5 parallel agents
```

`WorkspaceIntelligenceService` reads `WORKFLOW.md` and includes it in the workspace
context block assembled for the synthesis LLM. The synthesis LLM follows the
workspace's own conventions — the right credential, the right channel, the right
model, the right approval policy — not generic guesses.

`WORKFLOW.md` is editable from the Workspace Settings page or by agents via
`PUT /v1/workspace-context/WORKFLOW`. An orchestrator or manager agent that learns
something about workflow conventions writes it here, exactly like MEMORY.md.

---

## 7. The Integration Wiring Node — The Living Canvas

### The Problem with Placeholders

When a required integration has no credential, the current plan emits a `checkpoint`
node with a TODO instruction. This is a quiet failure: the workflow looks complete on
canvas, runs until it hits the checkpoint, then stops. The operator doesn't know it's
incomplete until the run fails.

The right model: **the integration node is always built. Its state reflects reality.**
An unconfigured integration is not absent — it is present and waiting for its
credential. The canvas shows this state explicitly.

### The Four Integration Node States

```
STATE             VISUAL                          MEANING
────────────────────────────────────────────────────────────────────────────
configured        green dot + integration logo    Credential bound. Ready to run.
pending-config    pulsing amber ring + glow       Built. Needs credential setup.
error             red dot + exclamation           Credential exists but auth failed.
disabled          gray + strikethrough            Credential revoked or plan limit.
```

The `pending-config` state uses an amber-500 pulse ring — `ring-2 ring-amber-500
animate-pulse shadow-amber-400/50 shadow-md` — Agentis's warning color token. The
integration logo renders at 50% opacity with "Connect [name]" text below it. This is
the glowing orange node: it signals "this workflow needs your attention here" without
blocking creation or hiding the full picture.

### The Inline Wiring Panel

Clicking any `pending-config` node opens the **Integration Wiring Panel** inside the
ContextInspector — no navigation away from canvas:

```
┌─────────────────────────────────────────────────────────────┐
│  Connect Gmail                              [Gmail logo]    │
│  ────────────────────────────────────────────────────────── │
│  This node sends your workflow output via Gmail.            │
│  Connect a Google account to activate it.                   │
│                                                              │
│  [  G  Sign in with Google                               ]  │
│                                                              │
│  ── Or use an existing credential ───────────────────────── │
│  (o)  team-gmail     alice@acme.com      verified           │
│  ( )  mktg-gmail     mktg@acme.com       verified           │
│                                                              │
│  [ Use selected ]        [ Create new credential ]          │
└─────────────────────────────────────────────────────────────┘
```

When the operator connects or selects a credential:
1. The `credentialId` is bound to the node immediately (PATCH to the workflow graph)
2. Amber ring fades out, green dot fades in (300ms CSS transition)
3. Canvas status bar: `2 integrations need setup` → `1 needs setup` → `All connected`
4. Chat: "Gmail connected. 1 integration remaining."
5. On the last one: "All integrations ready. Your workflow is complete." — brief green
   pulse on the workflow title bar

### Why This Is Better Than Every Alternative

**vs. checkpoint placeholder:** Workflow structure is correct from creation. Operator
wires in place, not by rebuilding. The node's position and edges in the graph are
preserved.

**vs. pre-flight warning in chat:** Wiring happens on the canvas where the operator
already is — not a detour to Settings.

**vs. blocking creation on missing credentials:** Operator sees exactly what needs
wiring, configured as part of the creation flow at their pace — or later. The workflow
is never "blocked"; it is "incomplete and honest about it."

This is the experience Zapier and n8n approximate but can't fully deliver — their
integration nodes aren't first-class graph objects with operational state. In Agentis
they are. The amber node is the visual proof.

---

## 8. The Specialist Assembly Protocol

### Creation Knows Who to Cast

For every `agent_task` node produced by synthesis, the creation session runs a
**role casting decision** against the 10-specialist roster. Casting is driven by the
node's tool requirements — not keyword similarity with the role name.

The synthesis LLM receives each specialist's tool manifest and one rule:

> *For each agent_task: identify what tools the task requires. Select the specialist
> whose tool manifest best satisfies those requirements. Include both `agentRole` and
> `castingReason` in the node config.*

Example casting chain:

```
Node purpose:     Fetch and extract content from 3 competitor blog URLs
Required tools:   read_url (URL retrieval), web_search (content extraction)
Capable roles:    researcher (web_search, read_url, knowledge_search) [MATCH]
                  writer     (web_search, read_url, read_file)         [MATCH]
Casting decision: researcher — fetching for analysis, not content production
castingReason:    "Needs read_url + web_search for parallel URL extraction"
Canvas label:     [R] Researcher
```

The `castingReason` is stored on the node and surfaced in the ContextInspector as a
tooltip on the role badge. This is the difference between a black box that picked a
role and a transparent decision the operator can understand and override.

### Fallback Chains

When the preferred specialist is offline, the creation engine falls back to the next
role with an overlapping tool manifest:

```
researcher offline  →  writer   (same URL tools, weaker for analysis)
analyst offline     →  coder    (both have run_code)
reviewer offline    →  architect (both have git_diff + read_file)
```

Fallbacks are shown in the Team Roster with an explanation:
"Using Writer as a fallback for Researcher (offline). Connect a Researcher runtime
to use the preferred specialist."

### Stage 5 CAPABILITY_MISMATCH Validation

A new Stage 5 check verifies every `agentRole` assignment against its node's
inferred tool requirements. If the role's manifest doesn't satisfy the requirements,
the node is flagged:

```
CAPABILITY_MISMATCH on node "Score Competitive Threat Level"
  agentRole: writer
  Required tools: run_code (for scoring calculation)
  writer tool manifest: [web_search, read_url, read_file]
  run_code is NOT in writer manifest
  Suggested fix: use analyst or coder
```

This catches synthesis mistakes before the graph reaches the canvas.

### The Specialist `.md` Filesystem (Phase 4, from MASTERPLAN)

Today specialists are DB rows. Phase 4 of the MASTERPLAN introduces
`agents/platform/<role>.md` — each specialist is a Volume markdown file:

```markdown
---
name: Senior Researcher
role: researcher
model: gpt-4o-mini
tools: [web_search, read_url, knowledge_search]
capabilityTags: [research, web, synthesis]
colorHex: "#10B981"
---

You are a senior research analyst. You fetch content from URLs, synthesize
information from multiple sources, and produce structured research reports.
You always cite your sources. You never fabricate citations.
```

When the creation engine reads this file as part of Stage 2 (Workspace Inventory),
the specialist's customized instructions, tool set, and model flow into the creation
brief. A workspace where the operator has trained their Researcher on domain-specific
sources gets workflows built with that specific researcher — not the platform default.

### Custom Role Expansion

Operators register domain-specific roles:

```markdown
---
name: Compliance Checker
role: compliance_analyst
model: claude-sonnet
tools: [read_file, knowledge_search]
capabilityTags: [compliance, legal, review]
---
You are a compliance specialist for financial services regulation...
```

A compliance manager building a document review workflow gets this role cast
automatically — because the specialist's `capabilityTags` and domain keywords matched
the request. Custom roles expand the creation engine's casting vocabulary without any
engine change. Adding a role is adding a markdown file.

---

## 9. The Builder Session — The Paradigm Shift

### The Honest Critique

Sections 0–8 describe a better pipeline. Better context, better synthesis, better
validation, amber integration nodes, capability-driven specialist selection. Every
one of these improvements is real and necessary.

But none of them changes the creation model. Every competitor — n8n's AI builder,
Zapier's AI assistant, Make's AI mode — produces a workflow from a prompt:

```
User types prompt  ->  service processes  ->  graph appears
```

Improving synthesis quality doesn't change this. It just makes the graph slightly
better.

**The paradigm shift: creation is not a tool call. It is a session.**

### The Builder Session

Builder Mode is a first-class UI mode entered from the workflow canvas via **Cmd+B**
or "New Workflow → Build with AI." It opens a split-pane view:

```
+─────────────────────────────+──────────────────────────────────────────────+
│  BUILDER CHAT               │  LIVE CANVAS                                 │
│                             │                                              │
│  [Manager] is               │  (nodes animate in as phases are approved)  │
│  building with you.         │                                              │
│                             │   [cron:7am] ──> [parallel] ──> [merge]     │
│  > "Build a competitor      │               +──> [http]                   │
│    analysis workflow..."    │               +──> [http]    |               │
│                             │                         [R researcher]       │
│  Phase 1: Intelligence      │                              |               │
│    [✓] Approved             │                         [A analyst]          │
│                             │                              |               │
│  Phase 2: Analysis          │                   [gmail ** pending-config]  │
│    [→] In progress...       │                                              │
│                             │  ✓ 2 agents ready   ** 1 integration pending│
│  ─ Specialist roster ──     │                                              │
│  [R] Researcher  ● online   │                                              │
│  [A] Analyst     ● online   │                                              │
│  [W] Writer      ● online   │                                              │
+─────────────────────────────+──────────────────────────────────────────────+
```

### The Session Flow

**Step 1 — Intent (0-3s)**
Operator describes the workflow. Intent Classification + Complexity Gate runs.
ATOMIC/PIPELINE go directly to streaming build. ORCHESTRATED/ENTERPRISE enter the
Planner agent.

**Step 2 — Phase Cards (3-8s)**
The Planner specialist (role `planner`, HTN decomposition) produces Phase Cards in
the chat panel. Each card is interactive and editable:

```
+─────────────────────────────────────────────────────+
│  Phase 1: Fetch Tech Blog Sources         [edit]    │
│  [R] Researcher • 3x parallel http_requests         │
│  Estimated: $0.000/run              [✓ Approve]     │
+─────────────────────────────────────────────────────+
│  Phase 2: Score AI Stories                [edit]    │
│  [A] Analyst (gpt-4o-mini) • filter + rank          │
│  Estimated: $0.012/run              [✓ Approve]     │
+─────────────────────────────────────────────────────+
│  Phase 3: Draft Digest                    [edit]    │
│  [W] Writer (claude-sonnet) • markdown email        │
│  Estimated: $0.018/run              [✓ Approve]     │
+─────────────────────────────────────────────────────+
│  Phase 4: Deliver                         [edit]    │
│  Gmail → team-digest@acme.com                       │
│  ** Uses team-gmail (verified)                      │
│  Estimated: $0.000/run              [✓ Approve]     │
+─────────────────────────────────────────────────────+
Total: $0.030 – $0.045/run    [✓ Approve all] [Redesign]
```

Tapping [edit] on any card opens inline editing: change the specialist, change the
model, add a review checkpoint, swap the delivery integration. The Planner
re-synthesizes only that phase. The cost meter updates live.

**Step 3 — Live canvas build (8-15s)**
Each approved Phase Card animates its nodes onto the canvas in real time — trigger
appears, edges connect, specialist nodes appear with avatar badges, the integration
node appears with the amber pulse ring (Section 7) or immediately green if the
credential was already in the inventory.

**Step 4 — Inline wiring (operator-paced)**
The amber Gmail node catches the operator's eye. They click it. The Integration
Wiring Panel opens. They connect. The node goes green. Status bar: "All integrations
connected."

**Step 5 — Done**
Chat: "*Your content manager* built this with 9 nodes. Runs daily at 7am UTC.
Estimated $0.03–0.04/run."
CTAs: **[Run now]** **[Save & schedule]**

Total: **under 10 seconds**. Zero failed runs. Zero manual wiring.

### What No Competitor Has

| Dimension | n8n AI / Zapier AI / Make AI | Agentis Builder Session |
|-----------|------------------------------|-------------------------|
| Creation model | Batch: prompt → graph | Session: dialogue → phased live build |
| Operator role | Receive artifact, edit later | Co-author every phase, live |
| Integration setup | Pre-requisite or post-failure | Inline amber node → wired green |
| Specialist visibility | None | Named roles + tool manifests in roster |
| Mid-build modification | Restart required | Tap Phase Card to edit in place |
| Cost visibility | After build, if at all | Live meter updated per phase approval |
| Offline agent detection | Runtime failure | Specialist roster during build |
| "Why this node?" | Never | Natural language explanation on demand |

The Builder Session is only possible because Agentis has three things competitors
lack: a real specialist library (10 roles with tool manifests), real integration nodes
as first-class graph objects with operational state, and a real Planner agent capable
of HTN decomposition. These three combine to produce the only creation paradigm where
the operator is genuinely a co-author — not a prompt writer waiting for a result.

### The Operator's Vocabulary

The Builder Session creates a shared language. Operators learn to say:

- *"Add a review checkpoint before the email"* → checkpoint node injected before
  integration node; phase card's cost estimate updates
- *"Use claude-sonnet on the analysis phase"* → analyst model override set; cost
  updates live
- *"Why parallel here?"* → "3 independent fetches with no data dependency —
  parallel reduces total latency by ~60%"
- *"Swap the Analyst for my compliance specialist"* → role swap applied,
  `castingReason` updated, node re-labeled on canvas instantly
- *"What does the Researcher actually have access to?"* → tooltip: tool manifest,
  default model, current status

Each operator who uses the Builder Session becomes progressively better at describing
workflows. The creation engine becomes progressively better at understanding this
operator's patterns — via MEMORY.md entries tagged `[wf-creation]`.

---

## 10. Implementation Roadmap

### Phase 1 — The Pipeline (2 weeks)

Fixes the five layers of context loss. Minimum viable creation quality.

| Item | Effort | Impact |
|------|--------|--------|
| `CallerContextService.assemble()` | S | Domain brief from caller identity — ✅ done 2026-05 (`assembleCreationBrief`, reads `ctx.agentId` → caller domain) |
| `WorkspaceInventoryService.build()` | M | Credential-aware synthesis — ✅ done (`buildWorkspaceInventory`) |
| Intent classification + complexity gate | M | ✅ done (`classifyIntent` → atomic/pipeline/orchestrated/enterprise) |
| Updated `CreationBrief` (domain + inventory) | S | ✅ done (`CreationBrief` + `renderCreationBrief`) |
| `SYNTHESIS_SYSTEM_PROMPT` with 12 Iron Rules | M | ✅ done (`SYNTHESIS_ARCHITECT_PREAMBLE`) |
| Stage 5 pre-flight validation (checks 1-5) | M | ✅ done (`preflightAndEnrich`: credential bind, terminal output, unbound/offline agent, dead-end, cost) |
| `AgentTaskForm`: agentRole badge + model override | S | ✅ done (role select + `ModelChooser` + offline status) |
| `WORKFLOW.md` support in `WorkspaceIntelligenceService` | S | ✅ done (4th context file, in the synthesis brief) |
| `buildAgentAwareSystemPrompt()` for non-orchestrator agents | M | ⬜ deferred — touches `ChatSessionExecutor` (in-flight chat refactor). Caller domain already flows via `assembleCreationBrief`. |
| Role-change triggers `agentis.md` regeneration prompt | S | ⬜ deferred — pairs with the chat/agent-identity refactor |

**Phase 1 targets:** Complex workflow success ~25% → ~65%. Phantom integration nodes ~40% → <5%.

---

### Phase 2 — Integration Wiring Node (1 week) — ✅ DONE (web, 2026-05-23)

The amber-pulsing integration node and inline wiring panel (Section 7). Shipped:
`pending-config` amber pulse ring on integration nodes missing a credential
(`isPendingConfig` in `WorkflowCanvasPage`, AgentisNode border + "Connect to
activate" badge), the **Integration Wiring Panel** in `ContextInspector`
(credential selector filtered by slug, green "Connected" state, change/clear),
credential bind via the existing graph PATCH with live amber→green sync on save,
and a canvas toolbar **"N integrations need setup"** counter chip. **Inline OAuth
"Sign in with X" is now done too** (2026-05-23): clicking the amber node's
"Sign in with Google/Slack/GitHub" runs the auth-code flow in a popup and the
minted credential binds the node green — never leaving the canvas. Phase 2 is
fully complete.

| Item | Effort | Impact |
|------|--------|--------|
| `pending-config` state on integration nodes (synthesis always builds the node) | S | Never a phantom placeholder again |
| Amber ring CSS + state transitions (`configured`, `pending-config`, `error`, `disabled`) | S | Visual operational state on canvas |
| Integration Wiring Panel in `ContextInspector` (OAuth + credential selector) | M | Inline setup, no navigation away |
| Canvas status bar: "N integrations need setup" counter | S | Operator sees completion at a glance |
| Credential bind PATCH on node + green transition animation | S | Immediate visual confirmation |
| Chat narration: "All integrations connected" moment | S | Session closure signal |

**Phase 2 targets:** Integration setup friction ~4 navigations → in-place (0 navigations). First-run integration failure rate ~40% → <5%.

---

### Phase 3 — Specialist Assembly (1.5 weeks) — ✅ DONE (2026-05-23)

The 10-role library drives synthesis by tool manifest (Section 8).

| Item | Effort | Status |
|------|--------|--------|
| `SpecialistBrief` type: tool manifest + status in `CreationBrief` | S | ✅ done |
| `castingReason` field in synthesis output + stored on node | S | ✅ done |
| Stage 5 CAPABILITY_MISMATCH validation | M | ✅ done |
| Team Roster emit in chat before graph streams | S | ✅ done — `WORKFLOW_TEAM_ROSTER` event + Builder cast panel |
| Offline specialist warning with connect link | S | ✅ done — roster shows offline + fallback in the Builder |
| Fallback chain: researcher → writer, analyst → coder, reviewer → architect | S | ✅ done (`buildTeamRoster` + `SPECIALIST_FALLBACK`) |

**Phase 3 targets:** Correct role assignment rate baseline → >90%. Offline specialist failures during run baseline → <10%.

---

### Phase 4 — The Builder Session (4–5 weeks) — ✅ COMPLETE (2026-05-23)

The paradigm shift (Section 9). Split-pane creation, Phase Cards, live canvas.
**Shipped:** the dedicated **Builder page** (`/workflows/build`, "Build with AI"
on the Workflows page) — a split-pane: left builder chat (describe → Phase Cards
with live cost meter → specialist roster), right **live canvas** that animates
nodes/edges in via the streamed `CANVAS_NODE_PLACED/EDGE_CONNECTED/BUILD_COMPLETE`
events (`CanvasEmbed`). Driven by `POST /v1/workflows/plan` (Phase Cards) and
`POST /v1/workflows/build` (full creation pipeline + live build via the shared
`createWorkflowFromDescription`). Now also: **Cmd+B** entry, **"why this node?"**
rationale in the inspector, a **live approved-cost subtotal** + **plan export** on
the cards, and the **cast team** (`WORKFLOW_TEAM_ROSTER`) shown before the graph
streams. **Inline per-phase `[edit]` re-synthesis is now done too** (2026-05-23):
the build is **plan-driven** — edit a card's instructions / specialist / model and
"Build it" assembles the graph from the edited plan (`assembleGraphFromPlan` +
`POST /v1/workflows/build` accepting an optional `plan`). Phase 4 is complete.

| Item | Effort | Impact |
|------|--------|--------|
| Builder Mode entry (Cmd+B + "New Workflow → Build with AI") | S | Mode switch UX |
| Split-pane layout: chat (left) + live canvas (right) | M | Co-authorship surface |
| Phase Cards UI component (editable, cost-metered, approvals) | L | Operator reviews plan phase-by-phase |
| Planner agent (role `planner`) + HTN decomposition prompt | L | Produces structured Phase Cards |
| Phase-by-phase streaming build: nodes animate on as phases are approved | L | Live creation visible |
| Per-phase cost meter (model + estimated tokens → cost) | M | Cost transparency at approval time |
| Inline Phase Card edit: swap specialist, change model, add checkpoint | M | Mid-build modification without restart |
| "Why this node?" natural language explanation | M | Operator vocabulary + trust |
| Operator vocabulary commands mid-session (swap, add, explain) | L | Full co-authorship UX |

**Phase 4 targets:** Time to production-ready complex workflow <15s. Operator-modified workflows during session >40% (operators are engaging, not just accepting).

---

### Phase 5 — Enterprise Planner Protocol (2–3 weeks)

Full HTN enterprise planning for multi-agent workflows with cross-agent dependencies.

| Item | Effort | Impact |
|------|--------|--------|
| `WorkflowPlan` type: `PlanPhase[]` with dependencies, specialists, cost | M | Structured plan artifact |
| Missing dependency wizard (credential not found → guided setup inline in plan) | M | Zero "figure it out yourself" moments |
| Cross-phase dependency validation (phase N requires output of phase M) | M | Correct DAG ordering |
| Plan export / import (workspace → template for reuse) | M | Plans become institutional knowledge |
| Manager → Planner delegation (`agent_task` with `role: planner` in non-Builder context) | M | Planner accessible outside Builder Mode |

**Phase 5 targets:** Enterprise workflow success rate ~65% → ~85%.

---

### Phase 6 — The Feedback Loop (2 weeks)

Creation learns from every run. Quality compounds.

| Item | Effort | Impact |
|------|--------|--------|
| `InstinctEngine` feeds successful patterns → synthesis template library | M | Best patterns become defaults |
| Post-run synthesis quality scoring (run success → creation credit) | M | Measures Phases 1–5 improvements |
| `MEMORY.md` entries tagged `[wf-creation]` from learning loop | S | Creation patterns persist |
| `build_workflow` analytics: archetype distribution, success rate per archetype | M | Per-archetype tuning visibility |
| Operator explicit feedback ("this node is wrong") → MEMORY entry | M | Closed loop: operators teach the builder |

---

## 11. The Northstar Experience

**User (to their content manager agent):**
*"Build me a workflow that monitors three tech blogs every morning, extracts AI
stories, scores them by impact, and sends me a digest email with the top 5."*

**What the operator sees:**

*0s:* Builder Mode opens. Chat left, canvas right. Manager agent name visible.

*0–1s:* "Analyzing your workspace... I see your Gmail credential and these blogs in
your knowledge base. Classifying complexity: 3 parallel fetches + transform + delivery
→ orchestrated."

*1–4s:* Phase Cards appear:

```
Phase 1: Fetch Blog Sources       [R] Researcher × 3 parallel   $0.000/run  [✓]
Phase 2: Extract + Score AI Stories [A] Analyst (gpt-4o-mini)   $0.012/run  [✓]
Phase 3: Draft Top-5 Digest        [W] Writer (claude-sonnet)   $0.018/run  [✓]
Phase 4: Deliver via Gmail         Gmail → you@acme.com (verified) $0.000  [✓]
                                                    Total $0.030–0.045/run

[✓ Approve all]   [Redesign]
```

*4s:* Operator approves all phases.

*4–7s:* Canvas builds live: trigger node → parallel group (3 http_requests) → merge
→ analyst node → writer node → Gmail node (green immediately — credential was already
in workspace inventory). Team roster appears in chat sidebar.

*7s:*
```
Your content manager built this with 9 nodes.
Runs every morning at 7am UTC.
Fetches 3 sources in parallel, scores AI stories, sends top-5 digest via Gmail.
Est. $0.03–0.05/run.

[Run now]   [Save & schedule]
```

**Total: 7 seconds. No failed runs. No manual wiring. No editing after.**

---

*Contrast with the experience as of May 2026:*
The workflow collapses to 1 node: `agent_task(instructions: "Monitor three tech
blogs every morning, extract AI stories, score them by impact, send a digest email
with the top 5")`. The Gmail node appears but has no credential. First run fails
with `CREDENTIAL_NOT_FOUND`. Operator spends 20–40 minutes manually building what
should have been built in seconds.

---

## 12. Why This Wins

| Dimension | Before (May 2026) | After (Phase 1–6) |
|-----------|-------------------|-------------------|
| Context used by synthesis | Workspace MEMORY only | Caller domain + inventory + WORKFLOW.md + specialists |
| Complex workflow quality | 1-node collapse | Multi-node structured decomposition |
| Integration nodes | Phantom (broken at runtime) | `pending-config` → inline wiring → green |
| Integration setup | Post-failure navigation | Inline amber node → one-click connect |
| Specialist selection | Keyword guess | Tool manifest capability matching |
| Role transparency | `agentRole` invisible | Badge + castingReason tooltip |
| Manager agent domain | Erased at chat boundary | Flows into creation brief |
| Enterprise workflows | Silent failure | Phase Cards → plan approval → structured build |
| Mid-build modification | Restart required | Phase Card inline edit |
| Cost visibility | After build or never | Live meter per phase approval |
| Offline agent detection | Runtime failure | Team Roster before graph appears |
| Creation model | Batch: prompt → graph | Session: dialogue → live co-authored build |
| Creation feedback loop | None | Every run teaches the builder |
| Time to production-ready (complex) | Hours of editing | Under 10 seconds |

The pattern that all leading agent platforms converge on — Anthropic's orchestrator-workers,
AutoGen's customizable agents, CrewAI's role+goal+backstory identity — is the same:
**agent identity must survive every boundary crossing.** Agentis ships all the
primitives. The Builder Session is what happens when they compose.

---

## 13. Principles

**P1 — The caller's context is the most valuable input the creation engine has.**
No external LLM knows more about a workflow domain than the manager agent
trained for that domain.

**P2 — Operational validity matters more than structural validity.**
A graph that passes schema validation but fails on first run is not a success.

**P3 — Complexity gates prevent LLM laziness.**
The gate is the constraint. Route complexity to a synthesis mode that handles it.

**P4 — The operator must be able to understand every node.**
Invisible role, missing credential, offline agent — these are inspector failures.

**P5 — The creation pipeline learns from every run.**
Quality compounds. Run #1,000,000 should produce better graphs than run #1.

**P6 — Show the plan for complex work; build immediately for simple work.**
Confirmation proportional to risk. Never block the simple case with complex-case
overhead.

**P7 — Domain authority belongs to the manager.**
Platform knowledge does not override domain knowledge.

**P8 — Creation is a session, not a tool call.**
The operator is a co-author. The Builder Session is the expression of this
principle in the product.

---

## Implementation Log

> Append-only. Entries added as phases ship.

*(Phase 1 in progress as of May 2026. Sections 7–9 added May 2026.)*

---

### 2026-05-23 — Phase 1 Creation Pipeline (the core fix)

**Context.** Workflow creation was producing 1-node all-agent collapses that ignored
required inputs (websites, models, email, integrations). Built the six-stage creation
pipeline so synthesis is credential-aware, domain-aware, and architecturally constrained.

**Shipped.**
- **`creationPipeline.ts`** — the composable pipeline (Stages 1-5):
  - `buildWorkspaceInventory()` (Stage 2): agents (with online/offline status), credentials →
    `integrationSlug`, skills, knowledge bases, **`wireableIntegrations`** (only confirmed
    credentials), the 10 specialist roles with their `ROLE_TOOLS` manifests, and the
    workspace context block.
  - `classifyIntent()` (Stage 3): deterministic archetype gate
    (atomic/pipeline/orchestrated/enterprise) + `triggerType`, `requiredIntegrations`,
    `missingCredentials`, `requiresPlanConfirmation`.
  - `assembleCreationBrief()` (Stages 1+4): reads the **calling agent** (`ctx.agentId`) and
    injects its domain instructions as authoritative context — P1/P7. Skips the orchestrator
    (it has no domain authority).
  - `preflightAndEnrich()` (Stage 5): binds credentials from inventory, guarantees a terminal
    `return_output`, and emits operational warnings (`CREDENTIAL_REQUIRED`, `AGENT_UNBOUND`,
    `AGENT_OFFLINE`, `MISSING_OUTPUT`, `DEAD_END`) + a cost estimate — operational validity,
    not just schema validity (P2).
- **Synthesis rewrite** (`build.ts`): `SYNTHESIS_ARCHITECT_PREAMBLE` encodes the **12 Iron
  Rules** (§5) — single responsibility, determinism-first, native integration nodes,
  http_request for fetches, terminal output, credentials-drive-integrations, etc. The user
  prompt now carries the full creation brief: caller domain, `wireableIntegrations`, specialist
  roles + tool manifests, classification, missing credentials. `agent_task` gets a
  `castingReason`.
- **`WORKFLOW.md`** — a 4th workspace context file (delivery rules, review policy, standard
  patterns, model preferences, cost guardrails) read into the synthesis brief and editable via
  `GET/PUT /v1/workspace-context/WORKFLOW.md` (§6).
- **Canvas (§4)**: `AgentTaskForm` now shows the specialist-role selector + `castingReason`,
  a `ModelChooser` per-node model override, and the bound agent's offline status — the inspector
  no longer looks empty for role-configured nodes. `modelOverride` + `castingReason` added to
  the type + schema so they persist.
- The `build_workflow` result + `CANVAS_BUILD_COMPLETE` now carry `archetype`, `warnings`, and
  `estimatedCostCents` so the operator sees what needs attention before running.

**Files.** New: `services/creationPipeline.ts`, `tests/services/creationPipeline.test.ts`.
Edited: `services/agentisToolHandlers/build.ts`, `services/workspaceIntelligence.ts`,
`routes/workspaceContext.ts`, `packages/core/src/{types,schemas}/workflow.ts`,
`apps/web/src/components/canvas/ContextInspector.tsx`.

**Verified.** Typecheck clean (db/core/api/web). 343 api tests across 55 files green, incl. new
`creationPipeline` suite (inventory, classification atomic→enterprise, credential bind, terminal
output, unbound-agent) and the existing build golden tests.

**Deferred (honest).** §3 agent-aware chat (`buildAgentAwareSystemPrompt`) + role→`agentis.md`
regeneration touch `ChatSessionExecutor` / agent-identity, which are mid-refactor — the caller
domain already reaches synthesis via the brief. §7 amber Integration Wiring **UI**, §8
CAPABILITY_MISMATCH validation + Team Roster emit + fallback chains, and §9 the **Builder
Session** (split-pane, Phase Cards, live phased build) remain — these are the Phase 2-4 frontier
and the real differentiators.

---

### 2026-05-23 — Phase 2 amber Integration Wiring (web) + Phase 4 Phase Cards

**Context.** Pushed the two headline creation-UX frontiers forward: the §7 living integration
node (Phase 2) is now fully wired on the canvas, and the §9 Builder Session's Phase Cards
(Phase 4 Step 2) ship with an HTTP-exposed Planner.

**Shipped — §7 Integration Wiring (Phase 2, DONE on web).**
- `pending-config` is now a real canvas state: `isPendingConfig(config)` (integration node with no
  `credentialId`) drives an amber pulse ring + "Connect to activate" badge on the node
  (`AgentisNode` in `WorkflowCanvasPage`).
- **Integration Wiring Panel** in `ContextInspector`: when a credential is unbound, an amber panel
  lists workspace credentials matched to the integration slug ("Connect <slug>"); one click binds
  `credentialId`. Bound state renders a green "Connected" card with change/clear. Credentials are
  fetched from `/v1/credentials` (new `needsCredentials` path).
- Binding syncs the node's amber→green state on save without a full re-hydration.

**Shipped — §9 Phase Cards (Phase 4 Step 2).**
- `POST /v1/workflows/plan` exposes the deterministic Planner (`planWorkflow`) over HTTP — named
  phases, cast specialist, node kinds, per-phase + total cost range, missing dependencies.
- `PhaseCards.tsx` renders the plan with per-card approve, a live cost label, and optional
  approve-all/redesign actions; mounted as a "Plan" preview slide-over on the workflow canvas.

**Files.** New: `apps/web/src/components/workflows/PhaseCards.tsx`. Edited:
`apps/web/src/components/canvas/ContextInspector.tsx`,
`apps/web/src/pages/WorkflowCanvasPage.tsx`, `apps/api/src/routes/workflowIo.ts`,
`apps/api/tests/routes/workflowIo.test.ts`.

**Verified.** Typecheck clean (api + web). `workflowIo` route suite green incl. the new plan test.
Full api suite: 649 tests / 115 files green. UI is typecheck-verified, not browser-driven this pass
(no seeded authenticated canvas).

**Remaining (the real §9 differentiator).** The split-pane **Builder mode** (Cmd+B): live animated
phase-by-phase canvas build (Step 3), inline `[edit]` per-phase re-synthesis, the specialist roster
panel, per-phase live cost meter on approval, and the operator vocabulary ("why this node?",
"swap the analyst"). Also still open: §7 inline OAuth + status-bar counter; §8 CAPABILITY_MISMATCH
+ Team-Roster-in-chat; the creation/analytics dashboards.

---

### 2026-05-23 (batch 2) — The Builder Session ships as a mode

**Context.** The previous entry shipped Phase Cards (§9 Step 2) and the amber wiring (§7). This pass
turns the Builder Session into a real, first-class **mode** — the paradigm shift, end to end.

**Shipped.**
- **Builder page** (`WorkflowBuilderPage`, route `/workflows/build`, "Build with AI" entry on the
  Workflows page) — a split-pane: **left** builder chat (describe → `PhaseCards` with live cost meter
  → specialist roster with online/offline dots), **right** a **live canvas** (`CanvasEmbed`) that
  animates nodes and edges in as they stream (Step 3).
- **`POST /v1/workflows/build`** — the non-chat creation entry. The `build_workflow` tool body was
  refactored into a shared, exported `createWorkflowFromDescription` (brief → synthesis → pre-flight →
  persist → stream `CANVAS_NODE_PLACED/EDGE_CONNECTED/BUILD_COMPLETE`); both the tool and the route
  call it. Approving the Phase Cards / "Build it" triggers the streamed build, and the right pane fills
  in live.
- **§7 status-bar counter** — the canvas toolbar now shows "N integrations need setup".
- **Analytics dashboard UI** — a slide-over over `GET /v1/workflows/:id/analytics` (stat tiles +
  status/failure bar charts), the first of the creation/ops dashboards.

**Files.** New: `apps/api/src/routes/workflowBuild.ts`, `apps/web/src/pages/WorkflowBuilderPage.tsx`,
`apps/api/tests/routes/workflowBuild.test.ts`. Edited: `apps/api/src/services/agentisToolHandlers/build.ts`
(extract shared creation core), `apps/api/src/bootstrap.ts`, `apps/web/src/{App,pages/WorkflowsPage,
pages/WorkflowCanvasPage}.tsx`, `apps/web/src/components/workflows/{OutputViewers,WorkflowArtifactGrid}.tsx`.

**Verified.** Typecheck clean (api + web). `workflowBuild` + `workflowIo` (plan) route suites green;
full api suite re-run for regression after the `build_workflow` extraction. Web typecheck-verified,
not browser-driven (no seeded authenticated canvas this pass).

**Remaining (polish, not paradigm).** Inline per-phase `[edit]` re-synthesis + specialist/model swap
in the Builder; "why this node?" explanation; Cmd+B keybinding; §7 inline OAuth; §8 Team-Roster-in-chat
before the graph streams; creation dashboard; Share (signed URL) + "re-run with changes".

---

### 2026-05-23 (batch 3) — Phase 3 closed; Builder + viewers polish

**Context.** Closed Phase 3 (Specialist Assembly) end-to-end and swept the remaining tractable
Builder/output checkboxes.

**Shipped.**
- **§3 — Team Roster before the graph streams + offline warnings.** New `WORKFLOW_TEAM_ROSTER`
  realtime event emitted by `createWorkflowFromDescription` (before node streaming) carrying the cast
  (`buildTeamRoster`: role, online/offline status, fallback). The Builder page renders a "Cast for
  this build" panel live, with offline → fallback hints. Phase 3 is now fully done (CAPABILITY_MISMATCH,
  `castingReason`, fallback chains were already shipped in #28).
- **§9 Builder polish** — Cmd/Ctrl+B opens the Builder from the canvas; "why this node?" rationale
  (`NODE_REASON`) under the inspector heading; live **approved-cost subtotal** + **plan export** (JSON)
  on `PhaseCards`.
- **Layer 6 (MASTERPLAN §6) viewers** — `DeploymentCard` (URL + health + preview) and `APIExplorer`
  (OpenAPI operations) finish the planned registry except Archive + `serve_project`. Re-run output
  action on the Output tab.

**Files.** `packages/core/src/events.ts`, `apps/api/src/services/agentisToolHandlers/build.ts`,
`apps/web/src/{pages/{WorkflowCanvasPage,WorkflowBuilderPage},components/canvas/ContextInspector,
components/workflows/{OutputViewers,WorkflowArtifactGrid,PhaseCards,WorkflowOutputTab}}.tsx`.

**Verified.** Typecheck clean (core/api/web). Build-path suites green; full api regression re-run.

**The honest last mile (needs architecture / infra, not faked).** Inline per-phase `[edit]`
re-synthesis requires a **plan-driven build** (build currently re-synthesizes from the raw description);
inline OAuth needs OAuth infra; `serve_project` live hosting, git sync, signed-URL share, the
creation/cost dashboards, and the always-on Workspace Orchestrator + marketplace remain. The creation
*paradigm* (session → phased live build, specialist casting, amber wiring, operational validity) is
shipped.

---

### 2026-05-23 (batch 4) — Plan-driven build + inline OAuth (the two foundational closes)

**Context.** The previous "last mile" called out two items as needing real architecture: the
plan-driven build (so editing a Phase Card actually changes the graph) and inline OAuth (so a
credential can be minted without leaving the canvas). Both are now built end-to-end.

**Shipped — plan-driven build (§9 Phase 4 complete).**
- `assembleGraphFromPlan(plan, description)` (build.ts) deterministically builds the graph from an
  approved/edited plan: trigger → one node per Phase Card (agent_task w/ role+model, or integration
  w/ a sensible default operation, or transform passthrough) → return_output, with each phase a real
  graph phase group. `preflightAndEnrich` still binds credentials + guarantees terminal output.
- `createWorkflowFromDescription` + `POST /v1/workflows/build` accept an optional `plan` (zod-validated);
  when present it drives the build, otherwise synthesis runs as before.
- `PhaseCards` is now **editable** (instructions / specialist / model per card); the Builder holds the
  plan in state and sends the edited plan on "Build it" — so *edit a card → rebuild* round-trips.

**Shipped — inline OAuth (§7 Phase 2 complete).**
- `OAuthService` (oauthService.ts): provider registry (Google / Slack / GitHub) built from env,
  per-slug scopes, single-use TTL'd CSRF `state`, authorize-URL construction, and code→token exchange
  (provider-normalized; `fetchImpl` injectable for tests).
- `routes/oauth.ts`: `GET /providers` + `POST /:provider/authorize` (authed) and a **public**
  `GET /:provider/callback` that exchanges the code, encrypts the tokens via the CredentialVault into a
  workspace credential (`credentialType: oauth_<slug>` so the wiring panel matches it), then
  postMessages the opener and closes.
- Wiring panel: a configured provider renders **"Sign in with {Google/Slack/GitHub}"** on the amber
  node → popup → consent → the minted credential binds the node green, no navigation. New env:
  `AGENTIS_PUBLIC_URL` + `OAUTH_{GOOGLE,SLACK,GITHUB}_CLIENT_ID/SECRET`.

**Files.** New: `services/oauthService.ts`, `routes/oauth.ts`, `tests/routes/oauth.test.ts`. Edited:
`services/agentisToolHandlers/build.ts`, `routes/workflowBuild.ts`, `services/creationPipeline.ts`
(PlanPhase.model), `env.ts`, `bootstrap.ts`, `apps/web/.../components/{canvas/ContextInspector,
workflows/PhaseCards}.tsx`, `pages/WorkflowBuilderPage.tsx`, + `tests/routes/workflowBuild.test.ts`.

**Verified.** Typecheck clean (db/core/api/web). New suites green: `oauth` (providers / authorize→callback
→ encrypted credential / bad-state) and plan-driven `workflowBuild`; full api regression green.

**Now genuinely remaining (infra/subsystems).** OAuth token *refresh* on use (tokens + refresh_token are
stored; a refresh-on-expiry helper for connectors is the follow-up); `serve_project` live hosting; git
sync; signed-URL share + share-bundle; cost/creation dashboards; the always-on Workspace Orchestrator;
community marketplace; InstinctEngine→synthesis-template feedback. The creation + execution + output
spine, the Builder Session, and inline credentialing are complete.
