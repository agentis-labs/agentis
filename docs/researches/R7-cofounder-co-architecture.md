# R7 — Cofounder.co Deep-Dive: MAS Architecture, UX, and Feature Analysis

> **Purpose:** Comprehensive research into how Cofounder.co (by The General Intelligence Company of New York / Superoptimizers) designs and operates its Multi-Agent System (MAS), workspace UX, user-facing features, and infrastructure. All data derived from their public website, docs, pricing page, and how-to guides (May 2026).  
> **Source:** https://cofounder.co · https://docs.cofounder.co · https://cofounder.co/pricing  
> **Relevance to Agentis:** Direct competitor in the "AI-powered company OS" space. Primary reference for department-level agent organization, human-in-the-loop approval flows, Tech Tree UX, and agent skill composition.

---

## 1. Product Vision & Positioning

Cofounder is not a workflow builder or a single-purpose coding assistant. Its positioning is:

> **"An agent orchestration platform designed to help you run an entire business."**

The product frames itself as the infrastructure for the *one-person billion-dollar company* — a company where the founder directs AI agents across every department (engineering, sales, marketing, design, ops, finance, legal, support) rather than hiring headcount for each function. This is captured in their tagline:

> **"Cofounder lets you run an entire company with agents."**

They coined the term **"Agentic departments"**: structured around real company org-chart lanes, not by tool type or workflow type.

**Core design principles (from homepage):**
1. **Agentic departments** — Work is organized as a real company structure (departments + managers + shared context), not as a flat list of automations.
2. **Human in the loop** — Agents work alongside the user and require approval when potentially dangerous actions are taken.
3. **Fully extensible** — Connect MCP, custom APIs, custom skills, or an entire custom codebase.

---

## 2. MAS Architecture: The Three-Layer Mental Model

Cofounder's MAS is built around three composable primitives:

```
┌─────────────────────────────────────────────────┐
│              WORKSPACE (organization)            │
│  ┌───────────────────────────────────────────┐  │
│  │              DEPARTMENTS                  │  │
│  │  ┌────────────────────────────────────┐   │  │
│  │  │             AGENTS                 │   │  │
│  │  │  (Instructions + Model + Tools     │   │  │
│  │  │   + Skills + Department Context)   │   │  │
│  │  └────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Their documentation explicitly states: **"An agent is the worker. A skill is reusable guidance attached to that worker. A department is the operating area that groups agents and their work."**

### 2.1 Departments (the top-level organizational unit)

After onboarding, the workspace is seeded with 8 departments mirroring a real company org chart:

| Department | Scope |
|---|---|
| **Engineering** | Product, app, repository, infrastructure, security, database, deployment |
| **Sales** | Pipeline, leads, outreach, customer conversations, revenue |
| **Marketing** | Positioning, content, SEO, launch work, marketing-site |
| **Design** | Brand identity, visual systems, decks, email templates, UI kits |
| **Support** | Customer support, issue resolution, customer success operations |
| **Operations** | Recurring workflows, internal process, reporting, cross-system cleanup |
| **Finance** | Billing, collections, accounting handoff, close support, financial reporting |
| **Legal** | Contract support, policy review, compliance artifacts, legal-ops workflows |

Each department is a self-contained workspace containing:
- Its own **agents** (scoped to that lane)
- Its own **tasks** (active and completed work)
- **Department Context** (durable shared background info visible to all agents in the dept)
- **Artifacts/Files** (outputs, working files, shared Library files associated to that dept)

**Key architectural decision:** Department context is not access-gated — any agent can read any Library file — but it *acts as a routing hint* to make context relevant to each lane.

### 2.2 Agents (the worker primitive)

Every agent is composed of five elements:

```
Agent
├── Instructions   ← What the agent owns and how it behaves
├── Model          ← The reasoning engine (multi-model support)
├── Integrations   ← Which tools and systems it can use
├── Skills         ← Reusable guidance packages
└── Department     ← Which lane of the company it belongs to
```

**Default seeded agents (post-onboarding):**

| Agent | Department | Primary Role |
|---|---|---|
| **Cofounder** | (top-level, workspace) | Workspace-level routing agent in the side panel |
| **Operations Agent** | Operations | Broad tasks, routes work to the right tools/agents |
| **Engineer** | Engineering | Product and app work |
| **Marketing Agent** | Marketing | Launches, messaging, campaigns, marketing assets |
| **Design Agent** | Design | Brand systems, decks, email templates, visual assets |
| **Sales Agent** | Sales | ICP, outbound, customer development, pipeline, GTM |
| **Support Agent** | Support | Support replies, ticket triage, workflow improvements |
| **Ops Agent** | Operations | Reconciliation, recurring reporting, operational cleanup |
| **Finance Agent** | Finance | Collections, billing inbox, close support, finance reporting |

**Cofounder** (the top-level agent) is architecturally distinct: it sits *above* department agents and handles workspace-level routing. It can be invoked from the side panel at any time to create or route tasks across the workspace. This is the "manager" or "orchestrator" layer.

### 2.3 Skills (reusable guidance packages)

Skills are modular guidance units that can be attached to multiple agents. Each skill includes:
- A `name`
- A `description`
- A `SKILL.md` file
- Optional supporting files

Skills support:
- Built-in skills (read-only, shipped by Cofounder)
- Custom skills (created by the user, editable in-app, deletable)
- Import from GitHub

**When to use a skill vs. agent-specific instructions:**
- Use a skill when guidance needs to be shared across multiple agents or is deep enough to deserve its own file.
- Use agent custom instructions when guidance is specific to one agent and doesn't need reuse.

---

## 3. Task System: The Execution Engine

Tasks are the primary unit of work. Every request to an agent becomes a task.

### 3.1 Task Lifecycle States

```
Created
  ↓
[Ongoing: Waiting to start...]  ← queued/being prepared
  ↓
[Ongoing: Running...]           ← agent actively working
  ↓
[Needs Action]  ← any of:
  · agent asks a clarification question
  · agent needs approval to continue
  · tool or permission approval required
  · reviewable output (artifact, preview, PR, export, review URL)
  · task failed, errored, or stopped
  ↓
[Done]
  · Completed — explicitly marked complete
  · Finished turn — agent finished without a separate review item
```

Completed tasks move to **history** but are not deleted; archived tasks can be retrieved.

### 3.2 Plan Mode vs. Execute Mode

When creating a task, the user picks **Execute** or **Plan**:

| Mode | When to Use |
|---|---|
| **Execute** | Straightforward tasks where the agent can start right away |
| **Plan** | Large, risky, or multi-system changes; agent proposes the approach first, waits for approval |

Plan mode is specifically recommended for: schema/migration work, auth, billing, permissions, security changes, work across frontend + backend + infra, and unclear bugs.

### 3.3 Human-in-the-Loop Approval

The approval flow is a first-class citizen, not an afterthought. Tasks requiring human gates (tool permissions, dangerous actions, reviewable outputs) surface in **Needs Action** and block forward progress until the human responds. This maps to their marketing principle: *"You stay in control, nothing ships without your approval."*

### 3.4 Attention Queue

A persistent **Attention Queue** (button in the Canvas bottom-right) aggregates all items waiting on the user across all tasks and departments. From it, the user can:
- Move through waiting items
- Open the task
- Snooze for later
- Dismiss when no action needed

This is a notable UX pattern for managing async multi-agent parallelism without cognitive overload.

---

## 4. Canvas: The Main Operating Surface

Canvas is the default landing page for a workspace and the primary UX for navigating an active company.

### 4.1 What Canvas Shows

- Active tasks and their current state
- Agents and the work assigned to them
- Departments and department-level workspaces
- Department artifacts (e.g., the Database artifact in Engineering)
- Work waiting on review
- Suggested next tasks from the Tech Tree or recent workspace activity
- Staging URLs (deterministic preview links)
- Attention queue items

### 4.2 Canvas Navigation Patterns

| Action | How |
|---|---|
| Launch work | + menu → new task or new agent |
| Department-level work | Click into department for agents, tasks, files, rules, context |
| Review + approval | Attention queue (bottom right) |
| Ask Cofounder to route | Side panel chat |
| Save staging URLs | Pin on the Canvas node |

### 4.3 Department Workspaces Inside Canvas

Departments open as **focused workspaces inside Canvas** — not as separate pages. Inside a department:
- Agents visible with their current assigned tasks
- Department context and rules visible/editable
- Files/artifacts scoped to that department
- Engineering specifically: a **Database artifact** (Supabase browser + CSV uploader)

---

## 5. Tech Tree: Guided Company-Building UX

The Tech Tree is Cofounder's answer to "what should I do next?" It's a structured milestone graph covering the full journey from idea to mature company.

### 5.1 Structure

Organized into **Stages** × **Tracks**:

- **Stages:** Idea → Initial Setup → Identity → Build → GTM → Launch → Scale → Mature company
- **Tracks:** Product, Engineering, Brand, Research, Operations, Revenue, Support

Each stage shows completion progress (e.g., `1/4`).

### 5.2 Node Mechanics

Each node can be:

| State | Meaning |
|---|---|
| **Available** | Ready to work on now |
| **In Progress** | Work for this step is underway |
| **Completed** | Step has been finished |
| **Locked** | Prerequisite step needed first |

Opening a node reveals a detail panel with: why the step matters, how to move it forward, subtasks, prerequisites, and what completing it unlocks.

For **agent-backed nodes**, the detail panel includes a **launch action** that kicks off the correct agent automatically.

### 5.3 Auto-Progression

Tech Tree items get checked off automatically as Cofounder detects workspace changes:
- Completed tasks
- Approved work
- Created artifacts
- Connected integrations
- Managed infrastructure setup

This makes the Tech Tree self-updating — a live reflection of where the company is, not just a static checklist.

---

## 6. Engineer Agent: The Most Capable Specialized Agent

The Engineer Agent is the deepest example of a specialized agent and illustrates the full capability range Cofounder provides per department.

### 6.1 Scope

The Engineer owns product and app implementation work:
- Code changes (frontend, backend, API routes, jobs, data flows)
- Database migrations
- Debugging (builds, tests, deploys, previews)
- Stripe/billing implementation
- Technical SEO
- PRs and code review

### 6.2 Sandbox + Browser Testing

A notable capability: the Engineer can run the app **locally in a sandbox**, open it in a browser, click through flows, fill forms, check desktop/mobile layouts, and fix issues — *before* handing back to the user. This is autonomous end-to-end verification.

For authenticated flows: test credentials are stored in AI Settings so the Engineer uses a dedicated test account, not the user's personal account.

For database-backed changes: the Engineer runs **local Supabase** (via `supabase db reset`) to apply migrations and test against a local backend stack.

### 6.3 Preview + Feedback Loop

When a PR is opened, Cofounder surfaces a **staged preview** directly in the workspace. Users can:
- Review the live preview branch
- Leave in-UI feedback via **Agentation** (annotate directly on the UI, point to specific parts of the page)
- Hand feedback back to the Engineer as follow-up work

**Markdown artifacts** also support inline comments: select text, comment on the whole document, and Cofounder keeps the selected quote + surrounding context + current version with the message.

### 6.4 Database Viewer

A built-in database browser (the Database artifact on Canvas / Engineering workspace) provides:
- Browse tables in the managed Supabase project
- Open a table and see its records
- Upload a CSV file into a table (row-append, with header mapping review, row-level error reporting)

---

## 7. Integrations & Extensibility

### 7.1 Built-in (Auto-Connected at Onboarding)

- **GitHub** — app repo + marketing repo
- **Vercel** — app project + marketing project + staging environments
- **Supabase** — managed project (database + auth + storage)
- **Postmark** — managed transactional email server

### 7.2 Standard Integrations (User-Added)

Common examples include: Linear, Slack, Notion, Gmail, Intercom, Stripe.

**Linear is notably first-class:** After connecting Linear, agents can be used *inside Linear itself* and can automatically work on tasks created in Linear — creating a bidirectional trigger.

### 7.3 MCP (Model Context Protocol) via Composio

Cofounder's MCP layer is powered by **Composio**. From the MCP tab in Integrations, users can search, connect, and make available any Composio-supported app to workspace agents.

### 7.4 Custom Integrations

Private API keys + optional endpoint URLs for arbitrary internal or third-party services.

---

## 8. Managed Infrastructure Stack

Cofounder manages the underlying infrastructure so agents can operate without the user setting up accounts or configuring services.

| Service | What Cofounder Manages |
|---|---|
| **GitHub** | App repo + marketing repo; user invited during onboarding |
| **Vercel** | App project + marketing project; staging + production envs; user invited during onboarding |
| **Supabase** | Full project (DB, auth, storage); staging + production; user NOT invited to Supabase UI yet |
| **Postmark** | Transactional email + sending domain setup; fully background-managed |

**Project ownership graduation:** Users can claim full ownership of GitHub, Vercel, and Supabase at any point. This is marketed explicitly as "graduate project ownership."

---

## 9. Publishing Pipeline

Code moves through a Git-based pipeline:

```
feature branch
      ↓
   preview (Vercel PR deploy — unique URL per branch)
      ↓
  staging (main branch)
      ↓
   review + approve
      ↓
  production (prod branch)
      ↓
  Vercel live deployment
```

Publishing in Cofounder creates or reuses a GitHub pull request from `main` → `prod`. When that PR is merged, Vercel updates the live production deployment.

The user can publish from Canvas (publish button) or ask Cofounder to publish via chat.

---

## 10. Company View & Company Memory

### 10.1 Company View

The Company view is a workspace-level dashboard showing:
- **Metric cards** — MRR, active users, churn, signups (empty until a real data source is connected)
- **Stack status** — Setup status per infrastructure component (domains, email, payments, hosting)
- **Active agents** — All agents available in the workspace
- **Company Memory** — Imported context from other AI tools

### 10.2 Company Memory

A shared, workspace-wide knowledge store that agents search when they need prior decisions, project notes, or company facts. Sources:
- Completed tasks
- Connected integrations
- Company Context imports

Good memory: company/product facts, important decisions + rationale, recurring workflows, active projects/goals/risks.
Forbidden in memory: secrets, API keys, private credentials, raw transcripts.

Memory can be updated by telling Cofounder what to change in chat, updating the connected source, or importing via Company Context settings.

---

## 11. UX Design Patterns: Key Observations

### 11.1 Org-Chart Mental Model as Navigation
Cofounder deliberately maps its UX to a familiar company org chart. Users navigate to a "department" and pick an "agent" rather than selecting a workflow or tool. This dramatically lowers cognitive load for non-technical founders: they already understand what "Marketing" and "Engineering" are.

### 11.2 Async-First with Review Surfaces
The architecture is designed for agents running in parallel, with the human processing the queue of outputs rather than babysitting individual agents. The Attention Queue, Needs Action task state, and Canvas review mode are all designed around this async review pattern.

### 11.3 Nothing Ships Without Human Approval
A recurring theme is explicit approval gates. Dangerous actions (inc. billing, auth, migrations, domain changes, email sends) require human approval. This is both a safety mechanism and a trust-building mechanism for users new to AI-autonomous work.

### 11.4 Preview-First Engineering Review
Rather than reviewing code diffs, the user reviews **live preview URLs**. Every PR from the Engineer deploys to a unique Vercel URL. Code review becomes a "does this work?" check instead of a line-by-line audit.

### 11.5 Feedback Directly on the UI
The Agentation integration means users leave feedback on the live preview — clicking on UI elements and annotating them — rather than writing a text description. This closes the loop between "what I see" and "what I want changed."

### 11.6 Guided vs. Open-Ended Entry Points
Two modes for starting work:
- **Guided (Tech Tree):** Step-by-step company-building roadmap with agent launch actions
- **Open-ended (Canvas + side panel):** Ask Cofounder to route or go directly to a department + agent

This serves both structured onboarding and experienced daily usage.

---

## 12. Pricing & Business Model

| Tier | Price | Included Usage | Key Features |
|---|---|---|---|
| **Free Trial** | $0 | $15 | 7-day Cofounder Pro access, multiple AI models, agent-built previews, preview environments |
| **Cofounder Pro** | $20/month + usage | $20 | Everything in Free + domain purchasing/hosting, agent inboxes, graduate project ownership |
| **Team Plan** | $50/month + usage | $50 | Everything in Pro + Multiplayer, SOC 2, Priority support (coming soon) |

**Usage-based pricing on top of base plan.** Components include:
- Token cost (LLM inference)
- Compute cost (sandbox/agent execution)
- Database cost (Supabase)
- Customer support cost
- Ad spend (marketing automation)
- Data purchasing (lead enrichment, data sourcing)

**Graduated ownership:** When a user is ready to leave Cofounder, they can claim full ownership of their GitHub repos, Vercel projects, and Supabase database. This reduces lock-in perception while keeping the default "we manage it for you" opinionated.

---

## 13. Sales & Marketing Automation (Go-to-Market Agents)

Cofounder's GTM agents handle the full outbound sales motion autonomously:

### 13.1 Sales Agent Capabilities
- ICP definition (turning a broad customer idea into a sharp specific profile)
- Lead list building + scoring (Tier 1 / Tier 2 / Tier 3 by ICP fit + buying trigger)
- CRM setup and pipeline management
- Inbox warming (gradual email ramp to avoid spam reputation damage)
- Outreach drafting (contextual, trigger-referenced, concise cold emails)
- Follow-up sequences and outbound cadence management
- Consult call note → product/positioning feedback loop

### 13.2 Marketing Agent Capabilities
- Brand guideline creation (story, values, visual identity)
- Marketing site generation (homepage, product pages, CTAs)
- Content strategy (channel selection by ICP, content calendar, drafts)
- Asset generation via integrations: images (gpt-image-2, Midjourney), motion videos (HyperFrames), HTML-based social visuals and decks
- Multi-platform content distribution (X, LinkedIn, YouTube, TikTok, newsletters, communities)
- SEO, paid, organic, and partnership channel strategy

### 13.3 Email Automation
- **Agent inboxes** (Pro+): agents can send and receive email
- Outbound campaign management with open rate / reply rate tracking
- **Inbox warming:** configures SPF, DKIM, DMARC; ramps volume gradually from 2→5 emails/day to build sender reputation before scaling

---

## 14. The "Company Roadmap" as a Product Feature

Cofounder ships a four-chapter "How to start a company" guide (Start → Build → Sell → Scale) that is not just marketing content — it *directly maps to the Tech Tree stages and to agent task templates*. Key insight: the documentation is the onboarding funnel.

### 14.1 Startup Lifecycle Coverage

| Chapter | What Cofounder Automates |
|---|---|
| **I — Start** | ICP definition, company naming, domain purchase + DNS/SSL setup, LLC incorporation (with approval gate) |
| **II — Build** | Spec + plan mode, GitHub repo setup, Vercel pipeline, secret management, scaffold generation, Stripe integration, Supabase schema + auth, testing, CI/CD |
| **III — Sell** | Brand guidelines, marketing site, CRM setup, ICP, lead lists, inbox warming, outreach sequences, consult call templates |
| **IV — Scale** | Product analytics (sign-ups, DAU, MAU, churn), Stripe payments, customer support inbox automation |

---

## 15. Architecture Gaps / Observations for Agentis

These are patterns observed in Cofounder that Agentis does not yet fully implement, or where Cofounder's approach offers a useful contrast:

| Observation | Cofounder Approach | Agentis Gap / Implication |
|---|---|---|
| **Department-scoped context** | Each department has its own shared context block (written rules + background info for all agents in that lane) | Agentis has workspace-level context; per-department context isolation is not yet shipped |
| **Tech Tree / milestone graph** | Guided company-building roadmap with auto-progression based on workspace state | Agentis has no guided onboarding milestone graph |
| **Attention Queue** | Aggregated async review surface across all departments and tasks | Agentis surfaces approvals per-task; no centralized review queue yet |
| **Preview-first code review** | Every engineering PR auto-deploys to a Vercel preview URL; code review is UX testing | Agentis has no managed deployment pipeline |
| **Agent inbox** | Pro agents can send + receive email directly | Agentis has no agent email inbox |
| **Agentation (UI annotation feedback)** | Users annotate live preview UI directly → feedback routed to Engineer | Agentis has no visual feedback → task routing mechanism |
| **Sandbox browser testing** | Engineer runs app + browser in a sandbox autonomously before PR | Agentis has no agent-controlled sandbox execution |
| **MCP via Composio** | MCP connections through a managed Composio layer | Agentis MCP is direct; no managed connector layer |
| **Company Memory** | Workspace-wide shared knowledge store that all agents can search | Agentis has per-run context; no persistent workspace memory layer yet |
| **Skills as GitHub-importable modules** | Skills (SKILL.md + supporting files) can be imported from any GitHub repo | Agentis skills concept exists; GitHub import not yet available |
| **Graduation / ownership transfer** | Managed infra but user can claim ownership at any time | Agentis fully self-hosted; no managed-then-graduate model |

---

## 16. Summary: Cofounder's Core Architectural Bets

1. **Org-chart as navigation** — Departments are the primary UX primitive, not workflows or tools.
2. **Department-scoped context** — Agents in the same department share background knowledge; agents in different departments don't cross-contaminate.
3. **Approval gates as trust** — Nothing ships without human sign-off; dangerous actions are always gated.
4. **Managed infra, gradual ownership** — Handle all the DevOps so the user can focus on the product; let them take ownership when ready.
5. **Preview over diff review** — Live URLs are the review artifact for engineering work, not code diffs.
6. **Async-first with a central review queue** — Agents run in parallel; the human processes a review queue, not individual agent streams.
7. **The guide is the product** — The how-to guide (Start → Build → Sell → Scale) maps directly to the Tech Tree and agent capabilities, making the documentation itself an acquisition and onboarding mechanism.

---

*Research compiled: May 2026 · Sources: cofounder.co, docs.cofounder.co, cofounder.co/pricing, cofounder.co/how-to/*
