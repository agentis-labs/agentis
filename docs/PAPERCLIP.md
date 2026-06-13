# Paperclip â€” Feature Reference

> **"If OpenClaw is an employee, Paperclip is the company."**
>
> Paperclip is an open-source, self-hosted Node.js + React control plane that lets you run entire businesses staffed by AI agents.  
> Source: `C:\Users\antar\OneDrive\Documentos\nexseed\paperclip`  
> Website: https://paperclip.ing  
> GitHub: https://github.com/paperclipai/paperclip  
> License: MIT

---

## Table of Contents

1. [Core Concept](#1-core-concept)
2. [Dashboard Panel](#2-dashboard-panel)
3. [Org Chart Panel](#3-org-chart-panel)
4. [Multi-Company Architecture](#4-multi-company-architecture)
5. [Agents Panel & Agent Detail](#5-agents-panel--agent-detail)
6. [Issue / Ticket System](#6-issue--ticket-system)
7. [Goals System](#7-goals-system)
8. [Projects Panel](#8-projects-panel)
9. [Routines (Heartbeats / Scheduled Jobs)](#9-routines-heartbeats--scheduled-jobs)
10. [Approvals / Governance](#10-approvals--governance)
11. [Costs & Budget Tracking](#11-costs--budget-tracking)
12. [Activity Log](#12-activity-log)
13. [Inbox](#13-inbox)
14. [Execution Workspaces](#14-execution-workspaces)
15. [Skills System](#15-skills-system)
16. [Extension System](#16-extension-system)
17. [Adapter System](#17-adapter-system)
18. [Company Portability (Export / Import / Clipmart)](#18-company-portability-export--import--clipmart)
19. [Sidebar Navigation](#19-sidebar-navigation)
20. [Command Palette (Cmd+K)](#20-command-palette-cmdk)
21. [Real-time / Heartbeat Infrastructure](#21-real-time--heartbeat-infrastructure)
22. [Authentication & Access Control](#22-authentication--access-control)
23. [Instance Administration](#23-instance-administration)
24. [Onboarding Wizard & CLI](#24-onboarding-wizard--cli)
25. [Mobile Support](#25-mobile-support)
26. [Technical Architecture](#26-technical-architecture)

---

## 1. Core Concept

Paperclip is a **human control plane for AI labor**. It is not a chatbot, not an agent framework, and not a workflow builder. It is the operating system for an AI-run company:

| Layer | What Paperclip provides |
|---|---|
| **Org chart** | Hierarchies, roles, reporting lines â€” agents have a boss, a title, and a job description |
| **Goal alignment** | Every task traces back to the company mission through a goal tree |
| **Governance** | You sit at the top as the board of directors â€” approve hires, override strategy, pause or terminate any agent |
| **Cost control** | Monthly budgets per agent; when they hit the limit, they stop. No runaway costs |
| **Observability** | Every ticket traced, every decision explained, every tool call logged |
| **Multi-company runtime** | One install can host unlimited companies with complete data isolation |

### Philosophy

- **Not a single-agent tool.** Designed for teams, hierarchies, and entire companies.
- **Bring Your Own Agent.** Works with OpenClaw, Claude Code, Codex, Cursor, Gemini, OpenCode, raw HTTP, bash â€” anything that can receive a heartbeat.
- **You manage the organization, not the prompts.** Agents bring their own models and runtimes; Paperclip manages the org they work in.

---

## 2. Dashboard Panel

**Route:** `/dashboard`  
**File:** `ui/src/pages/Dashboard.tsx`

The main command center for a company. Shows an at-a-glance summary of the business with live-updating activity.

### Metric Cards (top row)
Four summary tiles rendered by `MetricCard`:
- **Agents** â€” total agent count with status breakdown
- **Active runs** â€” currently running agent tasks
- **Pending approvals** â€” items waiting for board decision
- **Monthly cost** â€” formatted spend in cents (DollarSign icon)

### Active Agents Panel
Component: `ActiveAgentsPanel`  
Shows a card grid of the most recent agent heartbeat runs (default: 4 cards on dashboard, expandable to 50 on the Live page). Each card:
- Agent name + icon
- Linked issue title and identifier
- Run status badge (queued / running / succeeded / failed / timed_out / cancelled)
- Live transcript stream (polls every 15 s, reads up to 64 KB per run, capped at 40 chunks)
- Run cost and token count
- Relative timestamp
- Link to full agent detail

### Activity Charts (four chart cards)
Component: `ChartCard`, `RunActivityChart`, `PriorityChart`, `IssueStatusChart`, `SuccessRateChart`
- **Run activity** â€” bar chart of runs over time
- **Priority distribution** â€” pie/donut of issue priorities
- **Issue status** â€” breakdown of issue statuses
- **Success rate** â€” agent run success vs failure trend

### Recent Issues
Sorted by `updatedAt` descending â€” shows up to 10 most-recently-touched tickets with status icon, assignee avatar, and title.

### Live Activity Feed
Fetches last 10 activity events for the company. New items animate in (highlight for ~980 ms). Each row shows actor identity, action description, entity reference, and relative time. Keyed to a seen-IDs ref so only genuinely new items animate.

### Dashboard Live sub-page
**Route:** `/dashboard/live`  
Shows up to 50 heartbeat run cards in a larger `3-column` grid. Each card is `420 px` tall. Provides a dedicated "control room" view for power users who want to watch every agent simultaneously.

---

## 3. Org Chart Panel

**Route:** `/org`  
**File:** `ui/src/pages/OrgChart.tsx`

An interactive, canvas-based visual org chart rendered in a raw `<canvas>` element (not SVG, not React Flow â€” fully hand-drawn for performance).

### Layout Engine
Custom Reingold-Tilford-style tree algorithm:
- `subtreeWidth()` recursively computes how wide each subtree needs to be
- `layoutTree()` assigns absolute (x, y) coordinates top-down
- Constants: `CARD_W=200`, `CARD_H=100`, `GAP_X=32`, `GAP_Y=80`, `PADDING=60`
- Minimum zoom: `0.2Ã—`, maximum zoom: `2Ã—`

### Interaction
- **Pan** â€” click + drag on empty canvas
- **Pinch-to-zoom** â€” two-finger gesture on touch devices
- **Scroll zoom** â€” mouse wheel
- **Click node** â€” navigates to `/agents/:id`
- **Expand/collapse** subtrees via chevron button inside each node

### Agent Cards (on canvas)
Each node card shows:
- Agent icon (custom emoji or default bot glyph)
- Agent name (truncated to fit card width)
- Role label (from `AGENT_ROLE_LABELS` map)
- Status dot â€” `bg-green-400` (active), `bg-yellow-400` (paused), `bg-amber-400` (pending_approval), `bg-red-400` (error), `bg-neutral-400` (offline)

### Toolbar
- **+/âˆ’** zoom buttons
- **Maximize / Fit** â€” resets zoom to show entire tree
- **Download** â€” exports the rendered canvas to a PNG file via `<a download>`
- **Upload** â€” imports an org structure (planned)

### Sidebar Org-List variant
**File:** `ui/src/pages/Org.tsx`  
An alternative indented tree list (non-canvas) for the sidebar context, with same status dots and collapsible subtrees.

---

## 4. Multi-Company Architecture

**Route:** `/companies`  
**Component:** `CompanySwitcher`, `Companies`, `CompanyRail`

One Paperclip deployment can host unlimited independent companies. Each company is a fully isolated entity with its own:
- Agents, projects, goals, issues, routines
- Budget policies and cost ledger
- Skill library
- Members and roles
- Audit log
- Brand color, logo URL, and issue identifier prefix

### Company Switcher (sidebar)
The `CompanySwitcher` component at the top of the sidebar shows the currently selected company's name in bold. A dropdown lets you switch between companies or create a new one. Each company gets a `CompanyPatternIcon` â€” a procedurally generated SVG icon derived from the company's ID for quick visual recognition even before a logo is set.

### Company Settings
**Route:** `/company/settings`  
Editable fields:
- Name, description, brand color
- Logo (uploaded via asset API, displayed in sidebar)
- Attachment max size (in MiB, min 1 MiB, max configurable)
- `requireBoardApprovalForNewAgents` toggle â€” when on, every new agent hire triggers an approval request before the agent can run
- Issue prefix (e.g. `ENG-`, `MKT-`)

### Company Environments
**Route:** `/company/settings/environments`  
Define named environment tiers (e.g. production, staging) that agents and workspaces can target for execution.

### Company Access & Invites
- **Access** (`/company/settings/access`) â€” manage company members and their roles
- **Invites** (`/company/settings/invites`) â€” generate invite links or OpenClaw-compatible onboarding snippets; pending invites shown as a queue

---

## 5. Agents Panel & Agent Detail

### Agents List
**Route:** `/agents/all`, `/agents/active`, `/agents/paused`, `/agents/error`  
**File:** `ui/src/pages/Agents.tsx`

Filterable list of all company agents. Tab filters: All / Active / Paused / Error. Each row shows agent icon, name, role, adapter label, status badge, last run time.

Actions from list:
- **Run** â€” immediately triggers a heartbeat run
- **Pause/Resume** â€” toggles agent availability
- **New Agent** â€” opens `NewAgentDialog`

### Agent Detail
**Route:** `/agents/:agentId`  
**File:** `ui/src/pages/AgentDetail.tsx`

Deep detail view with multiple tabs:

#### Overview / Activity Tab
- Run activity chart (bar), priority chart, issue status chart, success rate chart â€” same components as dashboard but scoped to the single agent
- Recent activity feed for this agent
- Agent icon (editable via `AgentIconPicker` â€” custom emoji/color picker)
- Inline title editor for agent name

#### Runs Tab
Full paginated run history:
- Status icons: `CheckCircle2` (succeeded), `XCircle` (failed), `Loader2` (running), `Clock` (queued / scheduled_retry), `Timer` (timed_out), `Slash` (cancelled)
- Per-run: issue link, start time, duration, cost (formatted in USD), token count (`formatTokens`)
- Retry state description (`describeRunRetryState`) â€” shows retry count, delay, next attempt time
- Click run â†’ full transcript view

#### Run Transcript View
**Component:** `RunTranscriptView`  
Two display modes: **"nice"** (rendered markdown with tool cards) and **"raw"** (paginated text, virtualized at >300 entries, 40-row overscan).

Transcript block types:
- **message** (role: assistant/user) â€” markdown-rendered with `MarkdownBody`
- **thinking** â€” collapsible reasoning block (Claude extended thinking)
- **tool** â€” expandable tool call card showing input + result, duration, error state
- **command_group** â€” terminal command cluster (bash/shell tools grouped visually)
- **activity** â€” in-progress or completed activity marker

#### Config Tab
All adapter configuration for the agent:
- **Adapter type** â€” dropdown showing all available adapters (OpenClaw, Claude Code, Codex, Cursor, Gemini, OpenCode, HTTP, bash, + any installed external adapters)
- **Role** â€” from `AGENT_ROLE_LABELS` enum (CEO, CTO, CMO, COO, Engineer, Designer, Marketer, etc.)
- **Reports To** â€” `ReportsToPicker` component to set org chart parent
- **Command** â€” the shell command / startup command for the agent, with secret redaction on display
- **Environment variables** â€” key-value editor with:
  - Auto-redaction of secrets matching regex `/(api[-_]?key|access[-_]?token|auth(?:_?token)?|secret|passwd|password|jwt|private[-_]?key|â€¦)/i`
  - `secret_ref` type support (references to vault entries, shown as `***SECRET_REF***`)
  - JWT value auto-detection and redaction
  - Username segment redaction for home path privacy
- **Working directory (cwd)**
- **Adapter-specific config fields** â€” dynamically loaded schema from the selected adapter

#### Skills Tab
- Shows agent's assigned skills from the company skill library
- Skill snapshot system: version-lock an agent to a specific skill revision
- `isReadOnlyUnmanagedSkillEntry` check for skills that cannot be removed (system-managed)
- Add/remove skills; skill file tree preview inline

#### Budget Tab
- `BudgetPolicyCard` â€” shows current month spend vs. budget limit
- Edit monthly budget cap (in dollars)
- Budget incidents list (`BudgetIncidentCard`) for any overage events

#### Keys Tab
- Create and revoke agent API keys
- Copy key to clipboard
- Show/hide key value toggle (`Eye`/`EyeOff`)

#### Agent Actions
- `RunButton` â€” triggers an immediate heartbeat run
- `PauseResumeButton` â€” toggles active/paused
- Delete agent (with confirmation)
- Claude login flow (`ClaudeLoginResult`) for Claude-backed agents
- Permission update system (`AgentPermissionUpdate`)

---

## 6. Issue / Ticket System

**Route:** `/issues`, `/issues/:issueId`  
**Files:** `ui/src/pages/Issues.tsx`, `ui/src/pages/IssueDetail.tsx`

Paperclip's ticket system is modeled closely after Linear. Every piece of work is a ticket with a full conversation thread and agent assignment.

### Issue List Views

#### List View (`IssuesList`)
- Sortable columns: identifier, title, status, priority, assignee, project, updated
- Priority icons: Urgent (flame), High (up arrow), Medium (dash), Low (down arrow), None
- Status icons: backlog, todo, in_progress, in_review, blocked, done, cancelled
- Live indicator: issues with active runs show an animated pulse dot
- Grouped by: status, priority, project, or assignee (collapsible groups with `IssueGroupHeader`)
- Column picker (`IssueColumnPicker`) to show/hide fields
- Filter bar (`IssueFiltersPopover`): multi-select status, priority, assignee, project
- Full-text search with debounce
- Assignee avatars with agent icon or user avatar

#### Kanban View (`KanbanBoard`)
- Columns: Backlog â†’ To Do â†’ In Progress â†’ In Review â†’ Blocked â†’ Done â†’ Cancelled
- Drag-and-drop between columns via `@dnd-kit/core` + `@dnd-kit/sortable`
- `DragOverlay` for smooth drag preview
- Card shows: identifier, title, priority icon, assignee identity, live dot

### Issue Detail

The issue detail page is a full-featured collaboration surface:

#### Chat Thread (`IssueChatThread`)
Built on `@assistant-ui/react` runtime with a custom `usePaperclipIssueRuntime` hook.

- Full markdown rendering with syntax highlighting (`MarkdownBody`)
- Markdown composer (`MarkdownEditor`) with: rich text, @mention autocomplete (agents + users), image paste/drag-drop upload, keyboard submit (Ctrl/Cmd+Enter)
- Optimistic comment posting with queue â€” comments appear instantly and reconcile on server response
- Infinite scroll backward-loading of older messages (`useInfiniteQuery`, `getNextIssueCommentPageParam`)
- Live run transcript entries interleaved into the thread â€” tool calls, thinking blocks, command groups all appear inline
- `IssueContinuationHandoff` component â€” when an agent finishes and the issue is passed to another agent, a handoff card with summary appears
- `IssueThreadInteractionCard` â€” special interactive cards for agent-triggered interactions:
  - `AskUserQuestions` â€” agent asks clarifying questions, user fills in a form inline
  - `RequestConfirmation` â€” agent pauses and asks the human to confirm before proceeding
  - `SuggestTasks` â€” agent proposes a set of sub-tasks for user approval
- Approval cards (`ApprovalCard`) inline in the thread when an agent triggers an approval request
- Feedback buttons (`OutputFeedbackButtons`) â€” thumbs up/down with optional data sharing preference

#### Properties Panel (`IssueProperties`)
Collapsible right-side panel:
- Status (inline selector)
- Priority (inline selector)
- Assignee (agent or user picker)
- Project
- Labels
- Target date
- Issue identifier (e.g. `ENG-42`)
- Created by, created at, updated at
- Blocker notice (`IssueBlockedNotice`) when the issue is blocked

#### Run Ledger (`IssueRunLedger`)
Lists all agent heartbeat runs scoped to this issue:
- Run ID, status, agent, start time, duration, cost
- Click â†’ opens full transcript side panel

#### Documents Section (`IssueDocumentsSection`)
Work products (files, screenshots, diffs) produced by agents during execution:
- `DocumentDiffModal` â€” side-by-side diff view for file changes
- `ImageGalleryModal` â€” full-screen image viewer for agent-produced screenshots
- `PackageFileTree` â€” for skill/artifact packages attached to the issue

#### Sub-Issues
`shouldRenderRichSubIssuesSection` decides when to show a rich nested sub-issue section vs. a simple count. Full recursive sub-issue tree with create-new and link-existing actions.

#### Related Work Panel (`IssueRelatedWorkPanel`)
Shows issues linked via `issue-references` (blocks/blocked-by, duplicates, related).

#### Reference Pills (`IssueReferencePill`)
Inline `#NUM` reference pills that open a quicklook popover (`IssueLinkQuicklook`) without navigating away.

#### Keyboard Shortcuts
- `G + I` â€” go to Issues
- `G + D` â€” go to Dashboard
- `E` â€” archive (when in inbox context)
- `Cmd+Z` / `Ctrl+Z` â€” undo archive
- `ArrowUp/Down` â€” navigate between issues in inbox

---

## 7. Objective Management

Long-horizon objective management is deferred beyond V1. Paperclip's V1 product model stays focused on projects, issues, routines, agents, workflows, approvals, and run history.

---

## 8. Projects Panel

**Route:** `/projects`, `/projects/:projectId`  
**File:** `ui/src/pages/Projects.tsx`, `ui/src/pages/ProjectDetail.tsx`

Projects are the primary unit of work organization. Each project has:

### Project Detail Tabs

#### Overview Tab
- Inline editable description (markdown + image upload)
- Status badge selector
- Target date
- `ProjectProperties` side panel â€” status, color swatch (from `PROJECT_COLORS`), target date, linked goal

#### Issues Tab
Full issue list scoped to this project â€” same list/kanban views as the global issues page, but filtered.

#### Workspaces Tab (`ProjectWorkspacesContent`)
Lists all execution workspaces associated with this project as `ProjectWorkspaceSummaryCard` cards. Each card shows:
- Workspace name
- Running service count (green badge)
- Last updated time
- Link to workspace detail

#### Budget Tab
`BudgetPolicyCard` for the project â€” monthly budget cap with current spend indicator.

#### Configuration Tab
`ProjectProperties` full-edit form for all project metadata.

### Project Sidebar
`SidebarProjects` â€” expandable list of projects in the sidebar with color-coded project icon.

---

## 9. Routines (Heartbeats / Scheduled Jobs)

**Route:** `/routines`, `/routines/:routineId`  
**Files:** `ui/src/pages/Routines.tsx`, `ui/src/pages/RoutineDetail.tsx`

Routines are automated workflows that run agents on a schedule or via webhook. They are the "always-on" backbone of an autonomous company.

### Routine Configuration

#### Triggers (Schedule & Webhook)
A routine can have multiple triggers:

**Schedule trigger:**
- Cron expression (with `ScheduleEditor` component showing human-readable description)
- Enable/disable toggle per trigger
- `describeSchedule()` converts cron to English ("every 4 hours", "daily at 9am", etc.)

**Webhook trigger:**
- Unique webhook URL (auto-generated, shown once and then obscured)
- Signing mode selection:
  - `bearer` â€” shared bearer token in Authorization header
  - `hmac_sha256` â€” HMAC-SHA256 over request body with shared secret
  - `github_hmac` â€” GitHub-style `X-Hub-Signature-256` header
  - `none` â€” URL as secret (no signing)
- Secret rotation (`RotateRoutineTriggerResponse`)

#### Concurrency Policy
Controls what happens when a new trigger fires while a run is already active:
- `coalesce_if_active` â€” keep at most one follow-up queued (default)
- `always_enqueue` â€” queue every occurrence even if several stack up
- `skip_if_active` â€” drop new occurrences while a run is active

#### Catch-up Policy
Controls behavior after recovery from paused/offline state:
- `skip_missed` â€” ignore windows that were missed
- `enqueue_missed_with_cap` â€” catch up missed windows in capped batches

#### Template Variables (`RoutineVariablesEditor`)
Variables can be declared with `{variable_name}` syntax in the routine prompt. At run time they can be:
- Pre-set as defaults in the routine config
- Prompted at manual trigger time via `RoutineRunVariablesDialog`
- Injected dynamically from external webhooks

### Routine List Views
- Group by: none / project / assignee (collapsible groups)
- Sort by: updated / created / title / last run time (asc/desc)
- Per-routine: last run timestamp, next scheduled run, enable/disable toggle, run button
- Runs tab: history of all executions with status and live widget for active ones

### Routine Activity
Dedicated "Activity" tab per routine â€” scoped audit log of all events for that routine.

---

## 10. Approvals / Governance

**Route:** `/approvals/pending`, `/approvals/all`, `/approvals/:approvalId`  
**Files:** `ui/src/pages/Approvals.tsx`, `ui/src/pages/ApprovalDetail.tsx`

You operate as the **board of directors**. Agents cannot hire new agents, execute risky strategies, or make config changes without your approval.

### Approval Queue
- **Pending tab** â€” items requiring action, sorted newest first, with count badge (yellow)
- **All tab** â€” full history including resolved approvals
- Status filter: pending / revision_requested / approved / rejected

### Approval Card (`ApprovalCard`)
Each approval displays:
- Requesting agent name + icon
- Approval type icon (`defaultTypeIcon` / `typeIcon` â€” e.g. user-plus for hiring, shield for governance)
- Human-readable label (`approvalLabel`)
- Payload preview â€” type-specific rendering of what the agent wants to do (`ApprovalPayload`)
- Status badge (pending / approved / rejected / revision_requested)
- Created timestamp

### Actions
- **Approve** â€” marks as approved and resumes the agent's blocked execution
- **Reject** â€” marks as rejected and notifies the agent
- **Request Revision** â€” sends a comment back to the agent asking for changes before re-submitting

### Approval Payload Rendering (`ApprovalPayload`)
Renders the approval body according to its type â€” e.g. for a "hire" approval it shows the proposed agent config; for a strategy approval it shows the proposed plan as markdown.

### Governance Rules
- `requireBoardApprovalForNewAgents` company setting â€” when enabled, every new agent creation blocks until approved
- The approval system is also used inline in issue threads â€” approval cards appear in the chat when an agent pauses for human sign-off

---

## 11. Costs & Budget Tracking

**Route:** `/costs`  
**File:** `ui/src/pages/Costs.tsx`

Full financial visibility into every token, dollar, and budget policy across your AI company.

### Summary Metrics (top row)
Four `MetricTile` components:
- **Total spend** â€” formatted in USD for the selected date range
- **Estimated charges** â€” provider-estimated upcoming charges
- **Event count** â€” number of billable events
- **Net position** â€” debit âˆ’ credit balance

### Date Range Selector
Presets via `useDateRange` hook: This Week, Last Week, This Month, Last Month, Last 30 Days, Last 90 Days. Custom from/to range also supported.

### Tabs

#### By Agent
`BillerSpendCard` per agent â€” bar indicator of spend vs. budget, token breakdown (input / cached-input / output), model name.

#### By Provider Model
Grouped by LLM provider (Anthropic / OpenAI / Google / etc.) with per-model rows:
- Input tokens, cached input tokens, output tokens
- Cost in cents â†’ formatted USD
- Provider display name (`providerDisplayName`)

#### By Biller
`FinanceBillerCard` â€” for deployments using subscription-aware accounting (e.g. Claude subscription vs. API billing). Shows cost by biller type with `billingTypeDisplayName`.

#### Finance Ledger
`FinanceSummaryCard` â€” account-level charges that don't map to a single inference request (e.g. Anthropic subscription charges). Shows debit / credit / net / estimated debit / event count.

#### Timeline
`FinanceTimelineCard` â€” spending over time as a chart, with the current date range overlaid.

### Budget Policies (`BudgetPolicyCard`)
Per-agent or per-project monthly budget:
- Current spend as a `QuotaBar` progress indicator
- Hard limit â€” agent stops when limit is reached
- Budget incidents (`BudgetIncidentCard`) for any overage events with timestamp and overage amount

### Provider Quota Windows (`ProviderQuotaCard`)
Tracks rate-limit quota windows per provider API â€” shows current usage vs. window limit, reset time.

---

## 12. Activity Log

**Route:** `/activity`  
**File:** `ui/src/pages/Activity.tsx`

An append-only, immutable audit trail of everything that happens in the company.

- Up to 200 events loaded per page
- Filter by entity type: issue, project, goal, agent, company, routine
- Each `ActivityRow` shows:
  - Actor â€” agent icon + name or user avatar + display name
  - Action text â€” `formatIssueActivityAction` renders human-readable descriptions ("created issue ENG-42", "approved hire request for Claude-Coder", "updated budget policy", etc.)
  - Entity reference â€” identifier + title (e.g. `ENG-42 Implement WebSocket handler`)
  - Relative timestamp (`timeAgo`)
- No deletions or edits â€” append-only by design for full accountability

---

## 13. Inbox

**Route:** `/inbox`  
**File:** `ui/src/pages/Inbox.tsx`

A unified inbox that aggregates everything requiring your attention, inspired by Linear's inbox pattern.

### Content Sources
Four categories displayed with tab filters:
1. **Issues** â€” tickets assigned to you (filtered by `INBOX_MINE_ISSUE_STATUS_FILTER`)
2. **Approvals** â€” pending governance requests with inline approve/reject actions
3. **Failed runs** â€” heartbeat runs that errored out, surfaced as actionable items
4. **Join requests** â€” users requesting to join a gated company (`JoinRequestQueue` via `accessApi`)

### Inbox Features
- **Badge system** (`useInboxBadge`) â€” separate counts for unread inbox items and failed runs. Failed runs turn the badge red in the sidebar.
- **Search** â€” full-text filter within the inbox list
- **Swipe to archive** (`SwipeToArchive`) â€” mobile-friendly swipe gesture to dismiss issues
- **Undo archive** â€” keyboard `Cmd+Z` / toast-based undo for accidental dismissals
- **Column picker** â€” choose which columns to display for issue rows
- **Status grouping** â€” issues grouped by status with collapsible `IssueGroupHeader`
- **Filter popover** (`IssueFiltersPopover`) â€” filter by status, priority, project, assignee simultaneously
- **Quick assignee** â€” change assignee from inline selector without opening the issue
- **Prefetch on hover** â€” `prefetchIssueDetail()` fires on mouse enter to pre-warm the cache
- **Issue detail location state** â€” breadcrumb seed is stored in router state so the detail page can show "â† Inbox" correctly

---

## 14. Execution Workspaces

**Route:** `/workspaces`, `/execution-workspaces/:workspaceId`  
**Files:** `ui/src/pages/Workspaces.tsx`, `ui/src/pages/ExecutionWorkspaceDetail.tsx`

Execution workspaces are **isolated development environments** that agents run code inside. They are associated with projects and provide a reproducible context for coding agents.

### Workspace Configuration Fields
- **Name** â€” human-readable label
- **CWD** â€” working directory path inside the environment
- **Repo URL** â€” git repository URL
- **Base ref** â€” branch or commit to base from
- **Branch name** â€” the working branch the agent will push to
- **Provider ref** â€” external reference (e.g. GitHub environment name)
- **Provision command** â€” shell command to set up the environment (install deps, etc.)
- **Teardown command** â€” run on workspace close
- **Cleanup command** â€” run on agent checkout release
- **Workspace runtime JSON** â€” arbitrary JSON config passed to the runtime driver
- **Inherit runtime** â€” whether to inherit config from the project's default runtime

### Workspace Detail Tabs
- **Configuration** â€” all fields above with inline editing and validation
- **Runtime Logs** â€” streaming log output from the workspace's running services (`WorkspaceRuntimeControls`)
- **Issues** â€” issues linked to this workspace

### WorkspaceRuntimeControls
`buildWorkspaceRuntimeControlSections` organizes the workspace's services into control sections. Each service can be:
- Started / stopped via `WorkspaceRuntimeControlRequest`
- Status-indicated (running/stopped/error)

### Workspaces Overview Page
Groups all workspaces by project with `ProjectWorkspaceGroup`. Sorted by:
1. Running service count (descending â€” active workspaces first)
2. Last updated time
3. Project name alphabetically

---

## 15. Skills System

**Route:** `/skills`  
**File:** `ui/src/pages/CompanySkills.tsx`

Skills are **runtime context injection** for agents. A skill is a markdown file (or package of files) that is read into the agent's context at the start of a task so it knows how to find things, what conventions to follow, and what the codebase structure is.

This is the implementation of the `SKILLS.md` pattern described on the Paperclip website.

### Skill Sources
A skill can be sourced from:
- **Inline** â€” write markdown directly in the UI editor
- **GitHub repo** â€” fetched via `github-fetch` service, with branch/path selector
- **Vercel** â€” fetched from a Vercel deployment URL (`VercelMark` logo shown)
- **URL** â€” arbitrary HTTPS fetch
- **Project scan** (`CompanySkillProjectScanResult`) â€” Paperclip scans the linked codebase for existing `SKILLS.md`, `AGENT.md`, `CLAUDE.md` etc. and imports them

### Skill File Tree (`PackageFileTree`)
- Hierarchical file browser for multi-file skill packages
- Expandable folder nodes
- File kind badges: `markdown`, `code`, `image`, `data`, `config`, `other`
- Click file â†’ renders preview in the right panel (markdown rendered via `MarkdownBody`, code shown in textarea)
- `buildFileTree()` builds a `FileTreeNode` tree from a flat file list

### Skill Management
- Create skill via `+` button â†’ fill in name, source type, and content
- Edit inline via `MarkdownEditor` with split-pane preview
- `stripFrontmatter()` / `splitFrontmatter()` â€” the skill UI hides YAML frontmatter from the editor body but preserves it on save
- Update status badge (`CompanySkillUpdateStatus`) â€” shows if a skill is up-to-date or has upstream changes available
- Source badge (`CompanySkillSourceBadge`) â€” icon indicating origin (inline / github / vercel / url)
- Refresh â€” re-fetch from source
- Delete with confirmation

### Agent Skill Assignments
- Each agent has a skill list managed in the **Skills tab** of Agent Detail
- `applyAgentSkillSnapshot` â€” applies a saved snapshot to pin an agent to specific skill versions
- `isReadOnlyUnmanagedSkillEntry` â€” marks skills managed externally that cannot be removed from the UI

---

## 16. Extension System

**Route:** `/extensions/:extensionId`, **Admin:** instance settings  
**Files:** `ui/src/pages/ExtensionManager.tsx`, `ui/src/pages/ExtensionSettings.tsx`

Extensions extend Paperclip's functionality via Node.js worker processes loaded at runtime. They follow a lifecycle defined in `EXTENSION_SPEC.md`.

### Extension Lifecycle
States: `installing` â†’ `loaded` â†’ `enabled` / `disabled` / `error`

### Extension Manager UI
- Lists all installed extensions with: name, version, category badges, status
- **Install** â€” dialog to input an npm package name; installs via server-side npm
- **Enable / Disable** â€” power toggle per extension
- **Settings** â€” navigates to per-extension settings page if the extension provides a settings UI
- **Uninstall** â€” two-step confirmation dialog to prevent accidental removal
- **Error details** â€” expandable error panel showing `extension.lastError`

### Extension Extension Points (Slots)
Extensions declare UI slots via `ExtensionSlotOutlet` / `ExtensionSlotMount`:
- `sidebar` â€” add nav items to the sidebar
- `issue_detail` â€” inject UI into issue detail pages
- `project_detail` â€” inject UI into project detail pages
- `agent_detail` â€” inject UI into agent detail pages
- `dashboard` â€” inject panels into the dashboard

### Extension Launchers (`ExtensionLauncherOutlet`)
Floating action buttons or contextual launchers that extensions can register on specific pages.

### Extension Settings
`ExtensionSettings.tsx` â€” each extension can register a settings page with arbitrary configuration fields rendered via extension-supplied schema.

### Dev Mode
`ExtensionDevWatcher` â€” in development, extensions can be loaded from a local path with live file watching and hot-reload.

---

## 17. Adapter System

**Route:** Instance Settings â†’ Adapter Manager  
**File:** `ui/src/pages/AdapterManager.tsx`

Adapters are the bridge between Paperclip and actual agent runtimes. They are simpler than extensions: no workers or event buses â€” just a `ServerAdapterModule` that provides model discovery and execution.

### Built-in Adapters
Located in `packages/adapters/`:
| Adapter | Description |
|---|---|
| `openclaw-gateway` | OpenClaw agent via the OpenClaw gateway API |
| `claude-local` | Claude Code running locally via subprocess |
| `codex-local` | OpenAI Codex CLI running locally |
| `cursor-local` | Cursor IDE background agent |
| `gemini-local` | Google Gemini CLI |
| `opencode-local` | OpenCode agent |
| `acpx-local` | ACPX (generic MCP-based) local agent |
| `pi-local` | Pi local agent |

HTTP adapter supports any agent reachable over HTTP that can accept Paperclip's heartbeat format.

### External Adapters
- Install from npm package name via the Adapter Manager UI
- Install from local file system path (dev/custom adapters)
- `invalidateDynamicParser()` + `invalidateConfigSchemaCache()` after install/reload

### Adapter Manager UI
Per-adapter controls:
- **Enable / Disable** â€” hide from agent config menus without uninstalling
- **Reload** â€” hot-reload the adapter module without server restart
- **Reinstall** â€” re-download from npm
- **Remove** â€” uninstall from the server
- Source badge: `Built-in` vs `External`
- Local-path indicator (amber folder icon)
- Override badge â€” shows when a built-in is overridden by an external adapter of the same type

### Adapter Capabilities
`useAdapterCapabilities` hook â€” queries each adapter for what it supports (e.g. does it support streaming? does it support structured tool calls? does it have a native login flow?). The UI adjusts accordingly (e.g. hiding the Claude login button for non-Claude adapters).

---

## 18. Company Portability (Export / Import / Clipmart)

**Routes:** `/company/export`, `/company/import`  
**Files:** `ui/src/pages/CompanyExport.tsx`, `ui/src/pages/CompanyImport.tsx`

Paperclip companies are portable. You can export a full company as a ZIP archive, share it, and import it on any Paperclip instance.

### Export Flow

1. **Preview** â€” server generates a `CompanyPortabilityExportPreviewResult` showing all files that would be exported
2. **File tree with checkboxes** â€” `PackageFileTree` with per-file and per-folder check/uncheck
3. **Selection filtering** â€” `checkedSlugs()` extracts agent/project/routine slugs from checked file paths; `filterPaperclipYaml()` strips unchecked entries from `.paperclip.yaml` line-by-line
4. **Secret scrubbing** â€” all credential values are replaced with `<redacted>` placeholders before export
5. **Download as ZIP** â€” `createZipArchive()` assembles the checked files + filtered manifest into a client-side ZIP file

### Export Archive Contents
```
.paperclip.yaml              â† manifest: agents, projects, routines, sidebar order
agents/
  {slug}/
    AGENT.md                 â† agent instructions and config
    skills/                  â† agent-specific skill files
projects/
  {slug}/
    PROJECT.md               â† project description and config
tasks/
  {slug}/
    TASK.md                  â† routine/task template
```

### Import Flow
1. Upload ZIP or drag-drop onto import page
2. Server parses manifest and shows a preview
3. Collision detection â€” if agent/project slugs already exist, user is warned
4. Import applies agents, projects, routines, and skills with configurable merge strategy

### Clipmart (Coming Soon)
A community marketplace for pre-built company templates. Browse and one-click import:
- **Content Marketing Agency** (8 agents, SEO/blogs/social)
- **Crypto Trading Desk** (12 agents, analysis/execution/risk/compliance)
- **E-commerce Operator** (10 agents, listings/support/inventory/ads)
- **YouTube Factory** (6 agents, scripts/edits/thumbnails/scheduling)
- **Dev Agency** (9 agents, PM/engineers/QA/DevOps)
- **Real Estate Leads** (7 agents, prospecting/outreach/follow-up)

---

## 19. Sidebar Navigation

**File:** `ui/src/components/Sidebar.tsx`

The sidebar is the primary navigation shell. It is always visible on desktop and slides in from the left on mobile.

### Structure (top to bottom)
```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  [CompanySwitcher]  [Search]â”‚  â† 12px height header
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  [âœ New Issue]              â”‚  â† Quick action button
â”‚  [Dashboard] [live:N badge] â”‚  â† Shows count of active runs
â”‚  [Inbox]     [N badge]      â”‚  â† Red badge if failed runs exist
â”‚  [Extension sidebar slots]     â”‚  â† Extension-injected nav items
â”œâ”€â”€ Work â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  [Issues]                   â”‚
â”‚  [Goals]                    â”‚
â”‚  [Projects]  â–¼ expandable   â”‚
â”‚    project-1                â”‚
â”‚    project-2                â”‚
â”œâ”€â”€ Agents â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  [Agents]                   â”‚
â”‚  [Org Chart]                â”‚
â”‚  [Routines]                 â”‚
â”œâ”€â”€ Company â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  [Costs]                    â”‚
â”‚  [Activity]                 â”‚
â”‚  [Skills]                   â”‚
â”‚  [Settings]                 â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### Badge System
- **Dashboard** â€” live run count in a small number badge (auto-refreshes every 10 s via `heartbeatsApi.liveRunsForCompany`)
- **Inbox** â€” unread count from `useInboxBadge`; if `failedRuns > 0` the badge tone is `"danger"` (red)

### SidebarAgents (`SidebarAgents`)
Expandable section that lists agents inline with status dots. Agents with active runs show a pulsing indicator.

### SidebarProjects (`SidebarProjects`)
Expandable project list with color-coded project icons.

### Mobile Sidebar
On mobile the sidebar is an overlay drawer controlled by `useSidebar().setSidebarOpen`. `MobileBottomNav` provides an alternative bottom tab bar.

---

## 20. Command Palette (Cmd+K)

**File:** `ui/src/components/CommandPalette.tsx`  
**Trigger:** `Cmd+K` (Mac) or `Ctrl+K` (Windows/Linux) from anywhere in the app

A `cmdk`-powered fuzzy search overlay for rapid navigation.

### Groups (when query is empty)
- **Quick actions** â€” New Issue (SquarePen), New Agent (Bot)
- **Navigate** â€” Dashboard, Inbox, Goals, Issues, Costs, Activity
- **Recent issues** â€” last 50 issues from the cached list
- **Agents** â€” all company agents with icon + name
- **Projects** â€” all non-archived projects

### Search Mode (when typing)
- `issuesApi.list({ q: searchQuery, limit: 10, includeRoutineExecutions: true })` â€” full-text issue search including routine execution issues
- Results update on each keystroke with debounce
- Agent and project results come from the already-cached lists (no extra requests)

### Navigation
Selecting any result calls `navigate(path)` and closes the palette. On mobile, opening the palette also closes the sidebar drawer.

---

## 21. Real-time / Heartbeat Infrastructure

Paperclip's "always-on" feeling is driven by a polling-based heartbeat system (not WebSocket by default, though `packages/mcp-server` extends this).

### Live Run Tracking
- `heartbeatsApi.liveRunsForCompany(companyId, { minCount, limit })` â€” returns active + recent completed runs for a company
- Sidebar dashboard badge auto-refreshes every 10 s
- Dashboard and DashboardLive pages show live cards for up to 50 simultaneous runs
- `isRunActive(run)` checks `status === 'queued' || status === 'running'`

### Run Log Streaming (`useLiveRunTranscripts`)
- Polls the run log store every 15 s per active run card on the dashboard
- Reads up to 64 KB per request, capped at 40 chunks per run
- `RunChatSurface` renders the streamed transcript entries in a live card

### Live Issue Indicators (`collectLiveIssueIds`)
- Used throughout the issues list and inbox to show a live pulse dot on issues that have an active run
- Computed from the `liveRuns` query result by extracting `run.issueId`

### Realtime Events (SSE / Extension Bus)
- `packages/mcp-server` â€” MCP (Model Context Protocol) server integration for advanced real-time agent communication
- `server/src/realtime/` â€” server-sent event broadcasting for live state updates
- `server/src/services/live-events.ts` â€” live event emitter service
- `server/src/services/extension-event-bus.ts` â€” extension-to-extension and extension-to-UI event bus

---

## 22. Authentication & Access Control

### Board Claim
**Route:** `/board-claim`  
First-run setup: the first user who visits a fresh Paperclip instance claims the board (admin role). No prior account is needed.

### CLI Auth
**Route:** `/cli-auth`  
Token-based authentication for the `paperclipai` CLI. Generates a short-lived token that the CLI exchanges for a session.

### Company Invites
- Open invite links â€” operator generates a URL and sends it to collaborators
- OpenClaw onboarding snippet â€” generates a prompt that can be pasted into OpenClaw to onboard an agent as a company member automatically (`accessApi.createOpenClawInvitePrompt`)
- `InviteLandingPage` â€” the page a user lands on when following an invite link

### Join Request Queue
**Route:** `/join-queue`  
When a company has `requireBoardApprovalForNewAgents` enabled, external users who try to join land in the `JoinRequestQueue` page. The board can approve or reject from the Approvals panel.

### User Roles
Two-level RBAC:
- **Instance level** â€” admin vs. member (`InstanceAccess` page)
- **Company level** â€” board (admin) vs. member (`CompanyAccess` page)

### Profile Settings
**Route:** `/profile`  
User display name, avatar, notification preferences.

---

## 23. Instance Administration

**Route prefix:** `/instance/settings/`  
**Files:** `ui/src/pages/InstanceSettings.tsx`, `InstanceGeneralSettings.tsx`, `InstanceExperimentalSettings.tsx`, `InstanceAccess.tsx`

### General Settings
Server-level configuration: heartbeat intervals, retention policies, logging verbosity, allowed origins.

### Experimental Settings
Feature flags for opt-in beta functionality:
- `enableIsolatedWorkspaces` â€” when true, shows the Workspaces nav item and enables execution workspace features

### Instance Access
Manage which users have admin (board) rights at the instance level. Required for server operators who manage multiple companies.

### Extension Manager (instance-scoped)
The extension install/manage UI lives under Instance Settings since extensions are server-side Node.js workers that affect all companies.

### Adapter Manager (instance-scoped)
Adapters are also server-side, so the Adapter Manager is under Instance Settings.

### Database Backups
**Route:** `instance-database-backups`  
Server-side SQLite backup management â€” trigger manual backups, list existing backup files, restore.

---

## 24. Onboarding Wizard & CLI

### Onboarding Wizard
**Component:** `OnboardingWizard.tsx`  
A multi-step guided wizard shown on first login or when no company exists:
1. **Create company** â€” name, description, brand color
2. **Hire your first agent** â€” choose adapter, role, name
3. **Set a goal** â€” define the company mission
4. **Approve & run** â€” start the first heartbeat

### CLI Quickstart
```bash
npx paperclipai onboard --yes
```
Interactive CLI that walks through:- Database setup (SQLite by default)
- Auth configuration (JWT secret generation)
- First company creation
- First agent hire
- Optional: ngrok tunnel setup for webhooks

The CLI communicates with the server API and uses the same authentication tokens as the web UI.

### npx / Global Install
```bash
npm install -g paperclipai
paperclip up          # start the server
paperclip companies   # list companies
paperclip agents      # list agents
paperclip run <id>    # trigger a heartbeat
```

---

## 25. Mobile Support

Paperclip is designed to work on phones â€” you can monitor and manage your autonomous businesses from anywhere.

### Mobile Components
- **`MobileBottomNav`** â€” bottom tab bar replacing the sidebar on small screens. Tabs: Dashboard, Issues, Agents, Inbox, More.
- **`SwipeToArchive`** â€” swipe left on an issue row to reveal an archive button; complete the swipe to archive. Uses `TouchEvent` tracking with threshold detection.
- **Responsive grids** â€” all card grids use Tailwind responsive breakpoints: `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`
- **Pinch-to-zoom** on the org chart canvas â€” `TouchGesture` state machine handles single-touch pan vs. two-finger pinch with `startDistance` + `startCenter` tracking
- **`TOUCH_MOVE_THRESHOLD = 6px`** â€” prevents accidental navigation when tapping org chart nodes on touch screens

### Mobile Auth
`SidebarAccountMenu` provides a full-screen bottom sheet on mobile for account actions.

---

## 26. Technical Architecture

### Monorepo Layout
```
paperclip/
â”œâ”€â”€ server/          Node.js + Express/Hono API (TypeScript)
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ routes/   REST API (one file per resource)
â”‚       â”œâ”€â”€ services/ Business logic (50+ services)
â”‚       â”œâ”€â”€ adapters/ Agent adapter integrations
â”‚       â””â”€â”€ realtime/ SSE / event broadcasting
â”œâ”€â”€ ui/              React 18 SPA (TypeScript + Vite)
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ pages/    Route-level page components
â”‚       â”œâ”€â”€ components/ Shared UI components
â”‚       â”œâ”€â”€ api/      Typed API client wrappers
â”‚       â”œâ”€â”€ adapters/ Client-side adapter capabilities
â”‚       â”œâ”€â”€ hooks/    Custom React hooks
â”‚       â””â”€â”€ extensions/  Extension slot/launcher system
â””â”€â”€ packages/
    â”œâ”€â”€ shared/       Canonical types shared by server + UI
    â”œâ”€â”€ db/           Database schema + migrations (Drizzle ORM or similar)
    â”œâ”€â”€ adapters/     Built-in agent adapter implementations
    â”œâ”€â”€ adapter-utils/ Shared adapter utilities (log redaction, path scrubbing)
    â”œâ”€â”€ mcp-server/   MCP (Model Context Protocol) integration
    â””â”€â”€ extensions/      Extension runtime and sandbox
```

### Key Libraries
| Layer | Library |
|---|---|
| Frontend framework | React 18 |
| Build | Vite |
| Routing | React Router v6 (custom wrapper `@/lib/router`) |
| State / data fetching | TanStack Query v5 |
| Drag and drop | @dnd-kit/core + @dnd-kit/sortable |
| Chat / transcript | @assistant-ui/react |
| Markdown | Custom `MarkdownBody` (remark-based) |
| Forms | Custom inline editors |
| UI primitives | Radix UI + Tailwind CSS + shadcn/ui patterns |
| Icons | lucide-react |
| Database | SQLite (better-sqlite3 via @agentis/db pattern) |
| Auth | JWT (RS256) |

### Server Services (selected)
- `heartbeat.ts` â€” agent wakeup + run orchestration
- `budgets.ts` â€” budget enforcement (atomic checkout + spend tracking)
- `issue-execution-policy.ts` â€” determines which agent runs on an issue
- `company-portability.ts` â€” export/import ZIP logic
- `extension-runtime-sandbox.ts` â€” isolated Node.js worker for extensions
- `workspace-runtime.ts` â€” execution workspace lifecycle management
- `agent-instructions.ts` â€” assembles the full SKILLS.md context for an agent at run time
- `costs.ts` â€” per-run token cost accounting
- `approvals.ts` â€” approval state machine
- `routines.ts` â€” cron scheduler + webhook ingress

### Data Flow (agent run lifecycle)
```
1. Trigger     â†’ Schedule/webhook fires or user clicks Run
2. Checkout    â†’ heartbeat service checks budget, sets agent lock
3. Context     â†’ agent-instructions assembles skills + goal ancestry + issue context
4. Dispatch    â†’ adapter sends heartbeat to agent runtime (OpenClaw/Claude/etc.)
5. Streaming   â†’ run logs written to run-log-store, polled by UI
6. Tool calls  â†’ workspace operations, approvals, sub-issue creation all recorded
7. Completion  â†’ run status set, cost recorded, budget updated, activity logged
8. Realtime    â†’ live-events broadcasts run completion to subscribed UI clients
```

