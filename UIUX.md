# Agentis UX/UI Final Touch-Up Plan

Date: 2026-04-29

This plan is the product-quality pass for Agentis V1: not a cosmetic skin, but the interaction layer that makes the platform obvious, fast, and confidence-building. The current UI already has strong ingredients: a dark operational canvas, live state, restrained colors, thin borders, and useful real-time surfaces. The final touch-up should turn those pieces into a coherent SaaS cockpit where users always understand what is happening, what needs attention, and what they can do next.

Primary references reviewed:

- Attached workflow-builder image: dark, sharp, spatial, node-first, low-noise controls, visible run/publish/share actions, and a premium operational feel.
- Local Crunchbase chat reference in `C:\Users\antar\Downloads\chat-design`: persistent assistant object that starts as a small orb, expands into a compact input bar, and can become a full conversation panel without forcing navigation.
- Running Agentis app on `http://127.0.0.1:5173`: `/fleet`, `/workflows`, workflow canvas, `/runs`, run detail, `/agents`, `/gateways`, `/conversations`, `/activity`, `/approvals`, `/skills`, `/settings`, `/settings/channels`, `/workspaces`, command palette, onboarding strip, live strip, and conversation dock.
- Source surfaces in `apps/web/src/App.tsx`, `apps/web/src/pages/*`, and shared components under `apps/web/src/components/*`.

## Product North Star

Agentis should feel like a mission-control surface for autonomous work. It should not feel like a collection of admin pages. The user should be able to land anywhere and immediately answer four questions:

1. What is running right now?
2. What needs my attention?
3. What can I safely do from here?
4. Where is the AI conversation attached to this work?

The target experience is:

- Sharp, dark, technical, and spatial, like the workflow reference image.
- Dense enough for operators, but never cryptic.
- Action-first: every empty state, table, card, drawer, and modal should make the next useful action obvious.
- Persistent-chat-first: chat is not a separate destination. It is a durable object that follows the user and can attach itself to agents, runs, workflows, approvals, skills, and pages.
- Inspect-in-place: users should not bounce between pages to understand context. Details should open in drawers, inspectors, expandable rows, or right-side panels.

## Highest Priority Decisions

### P0. Redesign the Global Shell

The current shell is the biggest UX constraint. The left sidebar is icon-only and uses symbolic glyphs such as `◎`, `⌘`, `⟳`, `◈`, `⏚`, `≈`, `✦`, and `▣`. These are visually interesting but not self-explanatory. A first-time user cannot know what most of them mean without hovering.

Replace the shell with a three-zone layout:

1. Left navigation rail with labels.
	 - Use real icons from a consistent icon set, ideally `lucide-react`.
	 - Group navigation by mental model, not route order:
		 - Monitor: Fleet, Activity, Runs, Approvals
		 - Build: Workflows, Skills
		 - Operate: Agents, Gateways, Channels
		 - Admin: Workspaces, Settings
	 - Keep a collapsed mode, but default to expanded labels on desktop.
	 - Show live badges directly in nav: pending approvals, active runs, degraded gateways, unread chat.

2. Top context bar.
	 - Keep workspace and ambient selectors, but make them clearer.
	 - Replace the visible `Cmd+K to search` pill with a compact search button/input that looks like a command surface.
	 - Move low-frequency actions like sign out into a user/account menu.
	 - Keep gateway health visible, but make it actionable: clicking should open a gateway health drawer, not just link away.

3. Persistent right assistant object.
	 - Replace the current `Threads` button and separate `/conversations` destination behavior with a Crunchbase-style persistent assistant.
	 - Default state: small orb/button anchored bottom-left or bottom-right, with unread/typing/risky-action indicators.
	 - Focus state: floating input bar, same page, similar to the Crunchbase reference.
	 - Expanded state: large side panel with thread list, current page context, conversation, and page-aware quick prompts.
	 - Full page state: optional route for management/history only, not the primary chat experience.

### P0. Make Chat a Persistent Object, Not a Page

The current app has both `/conversations` and `ConversationDock`, but the experience still feels like chat is a destination. The Crunchbase reference points to a better model: the assistant is always there, context-aware, and expandable.

New assistant behavior:

- Collapsed orb:
	- Shows agent/avatar mark, unread count, or live typing shimmer.
	- Tooltip: current context, for example `Ask about this run`, `Ask about this workflow`, `Ask an agent`.

- Compact input bar:
	- Opens in place without covering the whole UI.
	- Placeholder changes by page:
		- Fleet: `Ask what needs attention...`
		- Canvas: `Ask about this workflow...`
		- Run detail: `Ask why this run behaved this way...`
		- Agents: `Ask an agent or inspect fleet status...`
		- Skills: `Ask which skill fits this node...`

- Expanded panel:
	- Left mini rail: chats, updates, pinned agents, recent runs.
	- Main thread: current context thread by default.
	- Header: context label such as `Exploring workflow: Untitled workflow` or `Inspecting run bdcf0b99`.
	- Footer: input with slash/at suggestions, attach current page toggle, send button, and optional mode switch.

- Context attachment:
	- Every route should publish a context object to the assistant: page type, selected entity, visible filters, selected node/run/agent/approval.
	- User can ask from anywhere and the assistant should know what `this` means.

- Approvals inside chat:
	- Keep inline approval cards, but make them richer: risk summary, requesting workflow/run, requested action, approve/reject with optional note.
	- If an approval is pending, the assistant orb should pulse with a warning tone.

### P0. Fix Broken or Brittle Behavior While Redesigning

These are not just polish items. They will undermine trust if the new UI ships without them.

- Workflow canvas currently logs React Flow edge warnings: `Couldn't create edge for source handle id: "null"`. The custom canvas node needs proper React Flow handles so edges render reliably and users understand flow direction.
- Several frontend subscriptions still use legacy realtime event names in agent surfaces, including `agent.status`, `agent.heartbeat`, `agent.task_started`, `agent.task_finished`, and `conversation.message_appended`. These should be migrated to canonical events already used elsewhere, such as `agent.status.changed`, `conversation.message.received`, and related `REALTIME_EVENTS` values.
- Some UI uses Tailwind classes outside the documented token discipline, including `text-warn`, `bg-warn`, and `border-warn`. Either formalize warning tokens in the design system or replace with supported classes consistently.
- Modals/drawers can be brittle. In live inspection, the agent registration modal's visible `Cancel` button became effectively outside the clickable viewport. All overlays need stable layout, max-height, internal scroll, Escape close, focus trap, and accessible close controls.
- Browser `confirm` and `alert` are used for destructive and status actions. Replace them with first-class confirm dialogs and toast/inline feedback.
- Raw UUIDs and raw JSON dominate activity/run/ledger/detail views. Keep raw data available, but default to readable summaries.

## Visual System Direction

Keep the current dark core, but sharpen it.

### Keep

- Dark canvas foundation.
- Thin borders and subtle dividers.
- Accent green for successful/healthy/live state.
- Compact operational density.
- Real-time bottom/status awareness.
- Canvas-first workflow identity.

### Change

- Reduce the amount of very rounded `rounded-2xl` UI. The reference image feels sharper. Standardize most panels at 6-8px radius, nodes at 8-12px, modals/drawers at 10-12px.
- Replace symbolic glyphs with real icons.
- Reduce card-heavy page structure. Use tables, split panes, drawers, command surfaces, inspectors, and full-width work areas.
- Improve hierarchy: page headers should include title, status/counts, primary action, secondary filters, and context actions.
- Use accent color sparingly. Today green appears as action color, healthy color, live state, and sometimes active selection. Split semantic color roles:
	- Green: healthy/completed/live.
	- Blue/cyan: selected/focused/navigation.
	- Amber: waiting/risk/attention.
	- Red: failed/destructive.
	- Neutral: inactive metadata.
- Add purposeful motion only for live state: running node pulse, agent focus trails, assistant typing, stream updates.

### Design Tokens Needed

Add a richer but still restrained token set:

- `bg-panel`, `bg-panel-muted`, `bg-elevated`, `bg-overlay`
- `border-subtle`, `border-strong`, `border-focus`
- `text-secondary`, `text-tertiary`
- `accent-focus`, `accent-live`, `accent-warning`
- `status-success`, `status-running`, `status-waiting`, `status-failed`, `status-paused`
- `radius-panel`, `radius-control`, `radius-node`, `radius-drawer`
- `shadow-drawer`, `shadow-popover`, `shadow-focus-ring`

## Page-by-Page Audit and Redesign Plan

### Fleet Overview

Current impression:

- Strong concept: constellation, active runs, gateways, approvals, activity, quick launch.
- But the layout reads as a dashboard grid of boxes, not a guided cockpit.
- Empty states are informative but passive.
- Activity text contains raw IDs and audit verbs like `operator update workflow ...`, which feels internal.
- Quick launch tiles use symbolic icons and duplicate nav rather than guiding setup.

Redesign:

- Make Fleet the command cockpit.
- Top band: `Operational state` with active runs, pending approvals, gateway health, online agents, and last incident.
- Center: agent constellation or agent work map with click-to-inspect drawer.
- Right: `Needs attention` stack: approvals, degraded gateways, failed runs, disconnected agents.
- Bottom: readable activity timeline with grouped events and entity links.
- Empty state should become setup flow: `Connect gateway`, `Register agent`, `Run first workflow`, each with status and direct action.
- Replace `Quick launch` with `Next best actions`, derived from actual state.

Critical improvements:

- Convert raw activity summaries into human text: `Workflow "Untitled workflow" was updated`, `Run bdcf0b99 completed in 42ms`.
- Allow clicking any dashboard region to open a drawer instead of navigating away immediately.
- Add severity sorting so the most urgent item is obvious.

### Workflows List

Current impression:

- Basic card grid with `Untitled workflow`, `No description`, and update date.
- Primary action exists, but no templates, status, run history, owner, trigger type, or last result.
- Repeated `Untitled workflow` cards are hard to distinguish.

Redesign:

- Use a workflow library layout, not generic cards.
- Header: title, count, search/filter, `New workflow` button.
- Provide three creation paths:
	- Blank canvas.
	- From template.
	- From prompt/chat.
- Each workflow row/card should show:
	- Name and editable summary.
	- Trigger type.
	- Last run status and duration.
	- Active/published/draft state.
	- Number of nodes.
	- Last edited.
	- Inline actions: Run, Duplicate, Open, More.
- Add filters: All, Draft, Active, Failed recently, Has approvals, Scheduled.

Critical improvements:

- Prompt for a meaningful name on creation or auto-name from the first trigger/skill.
- Avoid creating identical `Untitled workflow` entries with no context.
- Add bulk and row actions only after the information architecture is clear.

### Workflow Canvas

Current impression:

- Best page conceptually and closest to the attached reference.
- Current implementation is too static: nodes display but editing is limited, Publish is disabled, and the inspector shows raw JSON.
- The palette is visible, but the drag/add/edit/save mental model is not obvious.
- React Flow edge warnings indicate the flow rendering is not fully healthy.

Redesign:

- Treat this as the signature product surface.
- Top canvas toolbar:
	- Back breadcrumb.
	- Editable workflow name.
	- Draft/saved/live state.
	- Undo/redo.
	- Test run.
	- Run.
	- Share/export.
	- Publish when available, otherwise hide or explain in a disabled tooltip with roadmap state.
- Left rail:
	- Node palette grouped by Trigger, Work, Control, Integrations.
	- Search nodes.
	- Suggested next nodes based on selected node.
- Canvas:
	- Proper handles and visible edge direction.
	- Node status overlays during run: queued, running, completed, failed, waiting approval.
	- Minimap only if helpful; keep controls sharp and unobtrusive.
	- Empty canvas should show a starter path, not a blank grid.
- Right inspector:
	- Replace raw JSON with typed forms per node kind.
	- Include tabs: Configure, Inputs/Outputs, Run history, Notes.
	- Show validation errors inline.
	- Allow changing skill/agent/trigger from searchable selectors.
- Run drawer:
	- Keep in-canvas run visibility.
	- Show live timeline, failed node, output preview, replay options.

Critical improvements:

- Fix React Flow node handles before further canvas polish.
- Make adding a node persist to backend.
- Make node configuration editable through real controls.
- Add auto-save and clear saved/error states.
- Connect assistant context to selected node so the user can ask, `What does this node do?` or `Why did this fail?`.

### Run History

Current impression:

- Functional table, but feels like logs rather than an operations screen.
- Filter buttons are uppercase and compete visually.
- Empty state does not help the user start a run.
- Uses `CANCELLED`, while other code/statuses may use `CANCELED`; standardize spelling.

Redesign:

- Turn into a run operations table.
- Header metrics: active, waiting, failed last 24h, median duration.
- Filters as segmented controls and search.
- Add time range: last hour, day, week, all.
- Columns should include workflow name, status, duration, started by, trigger, and actions.
- Row expand should show node timeline preview without leaving the page.
- Replay should be a split-button with modes: failed branch, from checkpoint, whole run.

Critical improvements:

- Replace raw IDs with names plus short IDs.
- Add confirmation and feedback for replay.
- Keep active/running rows pinned or visually alive.

### Run Detail

Current impression:

- Contains the right raw information but presents it as a low-level ledger dump.
- Ledger lines are concatenated and hard to read.
- User cannot quickly answer why something happened, where it failed, or what to do next.

Redesign:

- Layout as a run inspector.
- Left: run summary, workflow link, status, duration, trigger, inputs, outputs.
- Center: visual node timeline matching the workflow graph.
- Right: event inspector with human-readable summaries and raw payload toggle.
- Add tabs: Timeline, Inputs/Outputs, Logs, Replay, Audit.
- If failed, show a failure callout at top with failed node, error, suggested action, and replay button.
- Add `Ask about this run` assistant context as a first-class action.

Critical improvements:

- Pretty-print event payloads only inside expandable details.
- Show node labels, not just node IDs.
- Add copy links and short IDs in tooltips/menus.

### Agents

Current impression:

- Table is clear but sparse.
- Register flow exposes technical fields (`adapterType`, raw JSON config) too early.
- Empty state points to three agent types but does not help the user choose.
- Some realtime subscriptions use legacy names, so live updates may silently fail.

Redesign:

- Make Agents a fleet operations page.
- Top metrics: online, busy, offline, errored, current tasks.
- Add view switch: table and map/constellation.
- Table row should show status, current task, gateway, capabilities, last heartbeat, and actions.
- Register agent should be a guided wizard:
	- Choose adapter: OpenClaw, Claude Code, HTTP.
	- Show what each adapter is for.
	- Collect only necessary fields for that adapter.
	- Validate config before submit.
	- Show connection instructions after creation.
- Add `Open chat`, `Inspect`, `Cancel task`, and `View gateway` as row actions.

Critical improvements:

- Replace raw JSON config with structured fields plus advanced JSON editor.
- Fix legacy realtime event subscriptions.
- Fix modal viewport/closing behavior.

### Agent Detail

Current impression:

- Feels like a terminal transcript, not an agent profile.
- Duplicates chat/thread behavior.
- Header has confusing layout: cancel button and back link both use `ml-auto`, which can fight for position.
- Uses legacy realtime event names.

Redesign:

- Make this an agent profile and operations surface.
- Header: agent identity, status, adapter, gateway, heartbeat, current task.
- Main split:
	- Left: profile, capabilities, connection health, recent tasks.
	- Center: live terminal/task stream.
	- Right: assistant/chat panel attached to this agent, or a compact `Open assistant` affordance.
- Add task controls: cancel, pause if supported, retry, view run.
- Separate `terminal send` from normal conversation if they are semantically different.

Critical improvements:

- Migrate realtime subscriptions.
- Do not show chat as raw monospace unless the mode is explicitly terminal/logs.
- Use the global assistant instead of making every detail page reinvent chat.

### Gateways

Current impression:

- Clear empty state and pair button.
- Pairing asks for URL and token but does not guide the user through where those values come from.
- Gateway cards include Sync/Delete, but no health summary or setup diagnostics.
- Delete uses browser confirm.

Redesign:

- Make Gateways a connection health page.
- Header metrics: connected, degraded, disconnected, last sync, agents discovered.
- Empty state should be a pairing checklist:
	- Install/start OpenClaw gateway.
	- Copy device token.
	- Paste URL/token.
	- Verify connection.
- Gateway cards/rows should show health trend, last heartbeat, agent count, sync status, and errors.
- Pair drawer should become a stepper with connection test.
- Gateway detail drawer should remain but be more useful:
	- Overview health.
	- Agents discovered.
	- Recent events.
	- Pairing/config details.
	- Troubleshooting.

Critical improvements:

- Replace browser confirm with confirm modal.
- Add sync result toast/inline feedback.
- Do not hide important connection errors in raw event JSON only.

### Conversations and Assistant

Current impression:

- The full page works as a basic chat inbox.
- Empty state is weak when no agents exist: it says pick an agent, but there are none.
- The dock is useful but too small, too separate, and still labelled as `Threads` rather than an assistant.

Redesign:

- Rename product surface to Assistant or Copilot-like internal naming, while routes can stay technical.
- Full `/conversations` should be a history/inbox page, not the default way users chat.
- Persistent assistant should replace the current dock as the primary interaction.
- The assistant should support:
	- Page context.
	- Agent selection with `@agent`.
	- Quick search with `@workflow`, `@run`, `@skill`.
	- Inline approvals.
	- Updates feed.
	- Start new chat.
	- Minimize/expand like Crunchbase Scout.

Critical improvements:

- Empty state should route users to create/connect an agent when none exist.
- Thread header should show agent name/status, not `Thread -> agent`.
- Message metadata should render as chips with readable labels.

### Activity

Current impression:

- Too raw and too empty when state is not loaded or workspace context differs.
- Shows actor/event/summary/date, but no grouping, filters, or readable entities.

Redesign:

- Turn into an audit/activity timeline.
- Add filters by type: workflow, run, gateway, agent, approval, credential, channel.
- Add severity: info, success, warning, error, security.
- Group by time: Now, Earlier today, Yesterday, This week.
- Make each item expandable with raw details.
- Add entity icons and links.

Critical improvements:

- Humanize event type names.
- Avoid showing raw internal summaries as primary text.
- Add search.

### Approvals

Current impression:

- Simple and understandable, but too thin for high-stakes decisions.
- Approval cards need more context before a user can confidently approve/reject.

Redesign:

- Make approvals a decision inbox.
- Each request should show:
	- Requested action.
	- Risk level.
	- Source workflow/run/agent.
	- What will happen if approved.
	- Data or external systems touched.
	- Time waiting.
	- Approve/reject with optional note.
- Add filters: Pending, Approved, Rejected, Expired, Risky.
- Add bulk only for low-risk approvals if policy allows.
- Add inline assistant explanation: `Explain this approval`.

Critical improvements:

- Approval actions need loading, success, and failure states.
- Keep resolved approvals available for audit, not only pending.

### Skills

Current impression:

- Installed skills are shown as simple cards.
- Registry drawer exists and is directionally good.
- Registry status displayed `breaker undefined` in live inspection, which reads broken.
- Installed skills lack input/output schema, examples, permissions, and usage context.

Redesign:

- Make Skills a capability library.
- Installed skill cards/rows should show:
	- Runtime.
	- Version.
	- Inputs/outputs.
	- Permissions.
	- Last used.
	- Workflows using it.
- Skill detail drawer:
	- Overview.
	- Schema.
	- Example call.
	- Runtime/security.
	- Workflows using this skill.
- Registry drawer:
	- Search and filters.
	- Result cards with type, author, version, permissions, install status.
	- Preview before install.
	- Security scan results.
	- Clear unavailable/unconfigured state.

Critical improvements:

- Fix registry status rendering so missing `breaker.state` does not print `undefined`.
- Make permission acknowledgement more specific than a generic checkbox.
- Add empty state for installed skills if only built-ins are present or registry is disabled.

### Settings

Current impression:

- Basic settings page with credentials, channel bridge, and about.
- It mixes product setup, secrets, integrations, and about info in a narrow column.
- Credential creation exposes raw credential type.

Redesign:

- Split settings into a structured admin area:
	- General.
	- Credentials.
	- Channels.
	- Security.
	- Backup/restore.
	- Telemetry/diagnostics.
	- About.
- Use a settings sidebar or tabs inside the page.
- Credentials vault should provide templates:
	- HTTP adapter secret.
	- API token.
	- Webhook secret.
	- Custom.
- Add masked secrets, creation date, last used, connected resource, rotate/delete actions.

Critical improvements:

- Replace raw credential type input with select/template.
- Replace delete browser confirm.
- Add validation and success feedback.

### Settings: Channels

Current impression:

- The page explains what channels do and has a clear connect action.
- But setup likely requires external bot configuration, so the flow must be more guided.

Redesign:

- Treat each channel as an integration setup wizard.
- Steps:
	- Choose Telegram or Discord.
	- Choose target agent.
	- Enter token.
	- Generate webhook details.
	- Copy command/setup instructions.
	- Test delivery.
- Connection rows should show health, last event, last error, target agent, webhook status, and actions.
- Webhook details modal should have copy buttons and exact setup commands.

Critical improvements:

- Replace `alert` with toast/inline results.
- Make revealed webhook secret copyable and hideable.
- Add error state if no agents exist before connecting.

### Workspaces

Current impression:

- Simple and usable, but switching workspace triggers full page reload.
- Lacks explanation of what workspace contains.
- Creation is inline and minimal.

Redesign:

- Keep it simple, but add confidence.
- Workspace list should show counts: agents, workflows, runs, gateways.
- Create workspace flow should explain isolation boundary.
- Switch workspace without full reload if possible; otherwise show a deliberate transition state.
- Add rename/archive/delete later if supported.

Critical improvements:

- Make active workspace visibly reflected in shell.
- Add empty or single-workspace state with next action.

### Login

Current impression:

- Minimal and clean.
- Looks more like an internal form than the entry to a premium platform.

Redesign:

- Keep it restrained, not a marketing page.
- Add a dark branded operational background or subtle canvas motif.
- Show product identity and environment hint.
- Add password manager-friendly fields, error states, and launch-token progress state.
- Avoid decorative content that distracts from sign-in.

Critical improvements:

- Preserve fast auto-login via token.
- Make loading states feel intentional, not blank `Loading...` screens.

## Cross-Page Interaction Rules

### Every Page Header Should Follow One Pattern

Use a standard `PageHeader` component:

- Breadcrumb/context.
- Page title.
- Status/count summary.
- Primary action.
- Secondary actions menu.
- Search/filter slot when relevant.
- Assistant context action.

This will make pages feel like one product instead of many one-off screens.

### Every Empty State Should Be Actionable

Avoid passive empty states like `No runs match the current filter` or `No threads yet`. Use the pattern:

- What is missing.
- Why it matters.
- Primary next action.
- Secondary link to docs/setup only if useful.

Examples:

- No agents: `Connect your first agent` with OpenClaw, Claude Code, HTTP choices.
- No gateways: `Pair an OpenClaw gateway` with setup checklist.
- No conversations: `Start by registering an agent` or `Open assistant` depending on state.
- No runs: `Run a workflow` and show available workflows.

### Every Risky Action Needs a Real Confirmation Pattern

Replace all browser `confirm` and `alert` usage with:

- Confirm dialog for destructive actions.
- Inline error and success feedback.
- Toasts for background actions.
- Undo where safe.
- Loading state on the exact action button.

### Every Raw Technical Detail Needs a Human Layer

Raw JSON and UUIDs are useful for debugging, but should not be the default information layer.

Default presentation should be:

- Human title.
- Short ID as secondary metadata.
- Status and time.
- Summary.
- Expand/copy/raw details.

Apply this especially to run ledger, activity feed, gateway event stream, workflow cards, and command palette results.

### Drawers Should Be the Main Detail Pattern

Use drawers for inspecting without losing context:

- Agent drawer from Fleet/Agents.
- Gateway drawer from Fleet/Gateways.
- Run drawer from Fleet/Run history/Canvas.
- Skill drawer from Skills/Canvas.
- Approval drawer from Fleet/Approvals/Chat.

Drawer requirements:

- Stable width with responsive full-screen on mobile.
- Internal scroll.
- Escape close.
- Focus trap.
- Close button always visible.
- Header with entity name, status, and primary action.
- Raw details are hidden under a tab or disclosure.

## Navigation Redesign Proposal

Recommended sidebar layout:

```text
Agentis

Monitor
	Fleet
	Runs
	Approvals
	Activity

Build
	Workflows
	Skills

Operate
	Agents
	Gateways
	Channels

Admin
	Workspaces
	Settings
```

Details:

- Use icons plus text labels.
- Use count badges for live items.
- Keep `Channels` as a top-level Operate item or visible Settings child; current location under Settings is too hidden for a user trying to connect Telegram/Discord.
- Keep Settings for admin configuration, not operational integrations.
- On collapsed sidebar, show icons with tooltips and section separators.

## Assistant Object Detailed Specification

This is likely the most important interaction upgrade.

### States

1. Collapsed orb.
	 - Anchored over the app, above the live strip.
	 - Shows assistant mark/avatar.
	 - Displays unread count, typing, or pending approval state.

2. Compact input.
	 - Expands into a horizontal pill input similar to the Crunchbase reference.
	 - Does not steal the whole page.
	 - Has placeholder tied to current page.
	 - Send button on right.
	 - Assistant mark on left.

3. Expanded panel.
	 - Width around 720-980px on desktop, responsive full-screen on smaller screens.
	 - Sidebar for chats/updates.
	 - Main conversation area.
	 - Header names current context.
	 - Minimize and full-screen controls.

4. Context-embedded cards.
	 - Approval card.
	 - Run summary card.
	 - Workflow/node card.
	 - Skill recommendation card.
	 - Gateway troubleshooting card.

### Context Examples

- On `/fleet`: assistant knows fleet snapshot and latest attention items.
- On `/workflows/:id`: assistant knows workflow id, title, nodes, selected node, validation errors, recent runs.
- On `/runs/:id`: assistant knows run status, node states, ledger summaries, failure node, replay options.
- On `/agents/:id`: assistant knows agent status, capabilities, current task, recent messages.
- On `/approvals`: assistant knows pending approval selected/request details.
- On `/skills`: assistant knows installed skills, registry availability, selected skill.

### Visual Direction

- The assistant should feel premium and light against the dark UI.
- Use a subtle luminous focus ring, similar to the Crunchbase blue glow but adapted to Agentis colors.
- Do not make it look like a generic support chat bubble.
- It should be an operator companion, not a help widget.

## Implementation Phases

### Phase 1: Foundations and Broken UX Fixes

Goal: make current UI safer and less cryptic before large visual changes.

- Install/add a consistent icon library, preferably `lucide-react`.
- Replace symbolic nav glyphs with icons and labels.
- Add shared components:
	- `PageHeader`
	- `StatusBadge`
	- `EmptyState`
	- `ConfirmDialog`
	- `ToastProvider`
	- `Drawer`
	- `SegmentedControl`
	- `EntityLink`
- Fix React Flow handles and edge rendering.
- Migrate legacy realtime event names in agent pages.
- Normalize warning/status tokens.
- Replace browser `confirm`/`alert`.
- Fix modal/drawer viewport behavior.

### Phase 2: Shell and Assistant

Goal: transform the experience architecture.

- Build redesigned sidebar with grouped navigation and live badges.
- Redesign top bar around workspace, ambient, search, health, and account.
- Replace `ConversationDock` with persistent assistant object.
- Keep `/conversations` as history/inbox, but make the assistant the default chat surface.
- Add page context provider consumed by assistant.
- Add compact input and expanded panel states.
- Move inline approvals into assistant cards where appropriate.

### Phase 3: Canvas Signature Surface

Goal: make workflow building feel like the reference image and become the product's star screen.

- Redesign canvas toolbar.
- Redesign node palette with groups/search.
- Replace raw inspector JSON with typed configuration forms.
- Add node validation and save states.
- Add live run overlays and richer run drawer.
- Add assistant context for workflow, selected node, and active run.

### Phase 4: Operational Pages

Goal: make all list/detail pages obvious and interactive.

- Rework Fleet into attention-first cockpit.
- Rework Runs into operations table with expandable rows.
- Rework Run Detail into visual inspector.
- Rework Agents into fleet operations page and guided register flow.
- Rework Gateways into connection health page and pairing wizard.
- Rework Approvals into decision inbox.
- Rework Activity into readable timeline.

### Phase 5: Library and Admin Pages

Goal: make setup and capability management feel complete.

- Rework Skills as capability library with skill detail drawer.
- Improve registry drawer with preview, filters, install security detail, and fixed status states.
- Rework Settings into structured admin tabs/sections.
- Upgrade Channels setup into wizard with copyable webhook commands and test results.
- Improve Workspaces with counts and smoother switching.
- Polish Login/loading screens.

## Suggested First Engineering Batch

Start with this batch because it unlocks the rest and removes the biggest trust issues:

1. Add shared `StatusBadge`, `EmptyState`, `Drawer`, and `ConfirmDialog` components.
2. Replace sidebar glyphs with icon+label grouped nav.
3. Build the persistent assistant shell with collapsed orb, compact input, expanded panel, and page context provider.
4. Fix WorkflowCanvas React Flow handles and edge warnings.
5. Replace raw canvas inspector JSON for trigger and skill nodes with the first typed forms.
6. Migrate agent realtime event names to canonical events.
7. Replace `alert` and `confirm` in Gateways, Settings, and Channels.
8. Add visual regression or Playwright smoke checks for shell, assistant, canvas, and modal/drawer closing.

## Acceptance Criteria

The redesign should be considered successful only when these are true:

- A new user can identify every sidebar item without hovering.
- The first screen after login makes the next useful setup or operational action obvious.
- The assistant is available from every page without navigating away.
- Workflow edges render without React Flow warnings.
- A user can create, inspect, run, and understand a workflow without reading raw JSON.
- Runs and activity are readable as human operational history, with raw data available only on demand.
- Every destructive action uses a first-class confirmation dialog.
- Every async action has loading and success/error feedback.
- Empty states lead to useful actions.
- The UI feels sharper and closer to the attached dark workflow reference.
- Chat behavior matches the Crunchbase reference pattern: orb, compact input, expandable panel, persistent context.

## Final Design Principle

The final Agentis UI should make autonomy legible. The user should not have to decode symbols, raw IDs, logs, JSON, or hidden routes to feel in control. Every page should turn system complexity into a clear operational sentence: what is happening, why it matters, and what the operator can do next.

---

# Part II — Strategic Amplification (Big-Tech-Tier Layer)

> The previous sections describe **what** to build. This part describes **how it has to feel** to land in the same tier as Linear, Vercel, Arc, Stripe, Raycast, Superhuman, Figma, Notion. It is appended — nothing above is overwritten — and it is the contract every PR and design review measures against.

## 1. The Identity We Are Building Toward

Agentis is not a dashboard. It is an **operator cockpit for autonomous work**. The closest spiritual references are not "AI products," they are operator surfaces:

- **Bloomberg Terminal** — density without panic; everything one keystroke away.
- **Linear** — keyboard-first, no chrome, opinionated defaults, aggressive restraint.
- **Vercel dashboard** — monochrome calm, deployments as first-class objects, log clarity.
- **Stripe Dashboard + Docs** — humane microcopy, surgical empty states, status as story.
- **Raycast / Superhuman** — command surfaces, ⌘K as the spine of the product.
- **Arc** — spatial navigation, sidebar as mental model, not decoration.
- **Figma** — multiplayer presence rendered without ego, cursors that mean something.
- **Notion** — slash-commands as a grammar; one input, infinite verbs.

The wrong references — and the ones we explicitly reject — are: generic "AI" landing pages, purple/violet gradient SaaS, glassmorphic crypto dashboards, neon "futuristic" mock-ups, anything that screams "made with v0 in 30 seconds."

**Identity test for any new screen:** if you put the screenshot next to Linear and Vercel, does it look like a peer or a tribute act?

## 2. Mental Model & Information Architecture

The current sidebar of 11 cryptic glyphs forces users to *learn the product* before they can *use the product*. Big-tech IA collapses navigation into 3–5 mental zones, each of which maps to a verb the user already knows.

Agentis has four operator verbs. The IA must mirror them, in this order:

1. **Observe** — Fleet, Activity, Approvals, Runs (the cockpit is here on login).
2. **Compose** — Workflows, Canvas, Skills (the build surface).
3. **Connect** — Agents, Gateways, Channels, Credentials (the integration surface).
4. **Configure** — Workspaces, Settings, Members (the admin surface).

Two non-negotiable rules:

- **Conversations is not a nav item.** It is a persistent assistant object (Part I, §Assistant Spec). Removing it from nav reclaims one slot and reinforces "the assistant is everywhere."
- **Default landing is `/fleet`,** not `/workflows`. The first thing an operator sees is their fleet's pulse, not an empty builder.

## 3. Typography & Spatial System

Right now the app uses Inter at default sizes with ad-hoc spacing. Big-tech polish lives in the **rhythm**.

### 3.1 Type scale (modular, base 14)

| Token | Size / Line | Use |
|---|---|---|
| `text-display` | 28 / 34, -0.02em | Page hero numbers (Fleet pulse, Run summary). |
| `text-h1` | 20 / 28, -0.01em | PageHeader title. |
| `text-h2` | 16 / 22 | Section headers, drawer titles. |
| `text-body` | 14 / 20 | Default body, table cells. |
| `text-small` | 13 / 18 | Secondary metadata, table secondary cells. |
| `text-micro` | 12 / 16, +0.02em uppercase | Labels, kbd hints, status pills. |
| `text-mono` | 13 / 18 JetBrains | IDs, tokens, log lines, code. |

Banned: 10px text. Banned: more than two weights on the same surface (regular 400 + medium 500; semibold 600 only for `text-h1` and numbers).

### 3.2 Spatial scale (4-based)

`space-1=4 space-2=8 space-3=12 space-4=16 space-5=20 space-6=24 space-8=32 space-10=40 space-12=48 space-16=64`. Nothing in the app uses arbitrary `gap-[13px]`. Every PR that introduces a custom pixel value is rejected unless it adds a token.

### 3.3 The 8-column rule

Page content lives in an 8-column grid with a consistent 24px gutter. PageHeader, EmptyState, and section headers all align to column 1. Right-side metadata aligns to column 8. This single rule kills 70% of the "looks AI-generated" feeling.

## 4. Motion Choreography

Motion is not decoration. It is **how the system tells the operator that something happened**. Three rules:

- **Semantic motion only.** Transitions must encode meaning: a row sliding in = new event; a row dimming = stale; a panel pushing = drill-down; a panel fading = ephemeral.
- **120ms / 180ms / 240ms** are the only durations. 120 for hover/focus, 180 for state changes, 240 for panel/drawer entry. Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` (Linear's curve).
- **Reduce-motion respected at the system level.** `@media (prefers-reduced-motion)` collapses all durations to 0ms except opacity fades.

Forbidden: bouncing springs, parallax, "reveal-on-scroll," staggered list animations longer than 240ms total, rotating spinners on anything that completes in <300ms (use a skeleton instead).

The signature motion is the **assistant orb expand**: 240ms ease, scale + opacity + y-translate, panel content fades in at 80ms delay. That is the one moment we let the UI "perform."

## 5. Density Modes

Operators are split: SREs want compact, executives want comfortable. Ship three density modes from day one, persisted per user, switchable from `⌘,`:

| Mode | Row height | Padding | Default for |
|---|---|---|---|
| Comfortable | 44px | `py-3` | First login, demos. |
| Compact | 36px | `py-2` | Default after first week of use. |
| Dense | 28px | `py-1` | Activity, Ledger, Logs (always dense). |

Tables, lists, and cards all consume the density token. This is what separates a "designed app" from a "tool people live in."

## 6. Keyboard-First Operating Model

Every action a power user does more than twice a day must have a shortcut. Every shortcut must be discoverable from `⌘K`. The shortcut is shown next to the menu item in the same monospace pill.

### 6.1 Global

- `⌘K` — command palette
- `⌘J` — toggle assistant panel
- `⌘.` — focus assistant input from anywhere
- `⌘/` — show all shortcuts (cheat-sheet modal)
- `⌘,` — settings
- `g` then `f/w/r/a/g/c` — go to Fleet / Workflows / Runs / Agents / Gateways / Conversations (Vim-style leader, like Linear).
- `?` — context-sensitive help

### 6.2 Local

- Tables: `j/k` row nav, `enter` open, `e` edit, `x` select, `⌘delete` archive.
- Canvas: `space+drag` pan, `cmd+scroll` zoom, `n` new node, `c` connect mode, `⌘d` duplicate, `delete` remove, `⌘enter` run.
- Drawers: `esc` close, `⌘enter` confirm primary action.

If a feature ships without a shortcut, it is not done.

## 7. Signature Moments

Every great product has 3–5 moments users screenshot and share. Agentis's are:

1. **The Assistant Expand** — orb → panel choreography, citations rendering as tiny cards.
2. **Run-as-Story** — the Run Detail page reads top-to-bottom like a Linear changelog: each step a row, each agent a colored thread, each error a red bracket. Operators can scrub a timeline at the top and the rows scroll-sync.
3. **Live Fleet Pulse** — Fleet header has a 60-second sparkline of throughput + a single 28px number. Watching it tick is satisfying. (Vercel does this with deployments; we do it with autonomous work.)
4. **Canvas Run Mode** — when a workflow runs, edges *flow* (subtle 1px dashed-line march, 2s loop), active nodes get a 1px mint ring. No glow, no particles. Just enough to make the graph feel alive.
5. **Approval Cards** — full-bleed dark cards with the agent's reasoning quoted in a left-bordered blockquote (like a chat citation), Approve/Decline/Modify as three flat buttons. Approving plays a 120ms green pulse on the border. That's it.

These are the only places the UI is allowed to "show off."

## 8. Perceived-Performance Budget

Big-tech UIs feel fast even when the network is slow. We enforce numbers:

- **TTI** (time to interactive on `/fleet`): ≤ 1.2s on a fresh load.
- **Interaction latency**: any click → visible feedback in ≤ 50ms. If the action is async, the button shows a `<Spinner inline />` *inside itself*; the page does not block.
- **Optimistic updates** on: starting/stopping agents, approving, archiving, renaming, toggling channels. Roll back with a toast if the server rejects.
- **Skeleton policy**: skeletons appear at 200ms, never before (avoids flashing on cached responses). Skeletons match the final layout's bounding boxes within ±2px so there is no jump.
- **Streaming**: assistant replies, run logs, and ledger entries stream in. Never a "loading…" spinner for streamable content.
- **No layout shift**: pages reserve space for late-arriving chips (status, counts) with `min-w` placeholders.

## 9. State Choreography (Loading, Empty, Error, Success)

Most apps treat these as afterthoughts. We treat them as four design surfaces with their own contracts.

- **Loading** is always either a skeleton (matching shape) or a streaming render. Never a centered spinner on a page.
- **Empty** is always actionable, with a one-sentence `why` + a one-sentence `what next` + a primary button. Never an illustration. Never a "Welcome to X" headline.
- **Error** is always specific: what failed, what to try, a "Copy details" button that copies a structured payload (timestamp, route, request id, message) for support. Never "Something went wrong."
- **Success** is silent for routine actions (button returns to idle), or a 2.5s toast with an undo for destructive ones. Never a modal.

## 10. Accessibility Tier

WCAG 2.2 AA is the floor, not the ceiling.

- Contrast: text-primary on canvas = 13.2:1; text-muted on canvas ≥ 4.7:1. Mint accent on dark = use for borders/icons, never for body text on canvas.
- Focus rings: 2px mint, 2px offset, always visible on keyboard nav. Never `outline: none` without a replacement.
- Hit targets: 32px minimum, 40px for primary actions.
- Every icon button has an `aria-label`. The current symbolic nav (`◎ ⌘ ⟳ ◈ ⏚ ✉ ≈ ✓ ✦ ▣ ⚙`) fails this — text labels are mandatory.
- Reduced motion respected (see §4).
- Color is never the only signal. Status pills always pair color with a glyph or text.
- Dialogs trap focus, restore on close, support `esc`.

## 11. Brand Voice & Microcopy

We write like Stripe and Linear, not like marketing.

- **Sentence case everywhere.** "Pair gateway," not "Pair Gateway."
- **Verbs over nouns** in buttons. "Start agent," "Archive workflow," "Approve step."
- **No "magic," no "powered by AI," no "intelligent."** The product is intelligent; the copy doesn't need to brag.
- **No emoji as icon.** Use the icon system. Emoji is allowed only in user-generated content.
- **Numbers are humanized**: "3 minutes ago," "1.2k events," "$0.04 / run." Raw timestamps live behind a `title` tooltip.
- **Errors are honest**: "Gateway didn't respond. Last seen 4 minutes ago. Retry or open logs."
- **Empty states have personality without cuteness**: "No runs yet — start a workflow and this is where its story will appear."

A microcopy review is part of every PR that touches user-visible strings.

## 12. The Persistent Assistant — Deepened Spec

The assistant is the product's nervous system. Building it like a generic chat sidebar wastes the opportunity.

### 12.1 Three states (already in Part I) — refined

- **Orb** (40px, bottom-right): pulses slowly when idle; shows an unread dot when proactive; rotates a 1px ring during streaming.
- **Compact input** (320px wide, bottom-right): single-line, ghost-text suggestion of the next likely command based on current page (`Ask about this run…`, `Summarize fleet status…`).
- **Panel** (480px right-anchored, full-height): chat thread on top, command surface on bottom, citations rendered inline as tiny cards (like Crunchbase Scout, like Perplexity).

### 12.2 Slash-command grammar

Inside the input, `/` opens a Notion-style command menu scoped to the current context:

- `/run <workflow>` — start a workflow with smart param prompts.
- `/explain <runId | step>` — natural-language summary.
- `/why <error>` — root-cause walk.
- `/find <agent | gateway | run>` — fuzzy search.
- `/approve` — list pending approvals.
- `/save` — convert the conversation into a saved playbook.

### 12.3 Citations as objects

When the assistant references a run, agent, or step, it renders a **citation card** (40px tall, 2px left border in mint, monospace id + human label). Click → drills into that object in a side drawer, *without leaving the conversation*. This is the Crunchbase Scout pattern translated to operations.

### 12.4 Proactive mode

Assistant whispers (never interrupts): when fleet health drops, when an approval has been pending >2 minutes, when a run fails. Whisper = orb gets a single dot + a 2-line preview on hover. No notification spam.

### 12.5 Memory

The assistant remembers the operator's last 20 commands, last 5 viewed objects, and current focus context. `⌘.` from a Run Detail page pre-fills "About this run, …".

## 13. Anti-Patterns — The "AI Slop" Banned List

If a PR contains any of these, it is rejected on sight:

- **Gradient buttons.** Especially purple → pink, or any "AI gradient." Buttons are flat with a 1px border. Primary is mint-on-dark, secondary is line-on-surface.
- **Glassmorphism / backdrop-blur as decoration.** Allowed only on the assistant panel and command palette, where it serves layering. Never on cards, never on nav.
- **Soft `rounded-2xl` on everything.** We use `rounded-md` (6px) for inputs/buttons, `rounded-lg` (10px) for cards, `rounded-node` (14px) only for canvas nodes. Pills are `rounded-full`.
- **Drop shadows for depth.** We use 1px borders + a single token `shadow-card` for elevation. No `shadow-2xl`, no colored glows except the one signature `shadow-glow` on active canvas nodes.
- **Hero illustrations on internal pages.** Empty states are typographic, not illustrated.
- **Emoji in product chrome.** Especially 🚀 ✨ 🤖 🎉. The product is not excited; it's competent.
- **"Magic" / "Smart" / "AI-powered" copy.** Describe the behavior, not the marketing.
- **Toast spam.** No toast for routine success. No toast that auto-dismisses faster than 2.5s. Stack max 3.
- **Modal-for-everything.** Use drawers for editing complex objects, dialogs only for confirmation. Drawers slide from the right at 480px / 640px / 800px tiers — never custom widths.
- **Icon-only nav with no labels.** (Current state. Fix in Part I.)
- **Centered spinners on full pages.** Always a skeleton.
- **Auto-playing animations on idle.** The orb pulse is the *only* idle animation in the entire product.
- **More than 2 fonts.** Inter + JetBrains Mono. Never a third.
- **Custom scrollbars that hide content.** Use the native overlay scrollbar; style only the thumb on `:hover`.
- **Dark-mode that's actually navy.** Our canvas is `#08090b`. Pure operator black, slightly warm. Never `#0f172a` (Tailwind slate-900 is banned as canvas).
- **Confetti / celebration animations.** Even on first run. Especially on first run.

## 14. Composition Primitives (the design-system spine)

The codebase needs ~14 primitives. Everything else composes from these. Naming is final:

`Button` `IconButton` `Input` `Textarea` `Select` `Combobox` `Checkbox` `Switch` `Tabs` `Pill` `Card` `Drawer` `Dialog` `Toast` `Tooltip` `Kbd` `Spinner` `Skeleton` `EmptyState` `PageHeader` `DataTable` `CommandPalette` `AssistantPanel`.

Every page in Part I is a composition of these. No page-local one-off components. No styled `<div>` that should have been a `Card`. A monthly audit greps for raw `bg-surface` outside primitives and refactors.

## 15. Data-Density Philosophy

Operators look at our tables for hours. Three rules from Bloomberg / Linear:

- **Numbers right-aligned, monospace, tabular-nums.** Always.
- **Secondary data in `text-muted`, not in a smaller size.** Hierarchy is by color, not by size; size shifts cause scanning fatigue.
- **No zebra striping.** Use 1px dividers in `border-line` at 60% opacity. Zebra is a 2010 pattern.
- **Sticky header with the column the user sorted by highlighted in mint underline.**
- **Inline row actions appear on `:hover` only,** never always-visible. On touch devices, a single `⋯` reveals them.

## 16. Multiplayer & Presence (forward-looking)

Even before real multi-user features land, the architecture must reserve space for:

- **Avatar stack** in PageHeader (32px, -8px overlap, max 4 + `+N`).
- **Presence dot** on objects currently being edited by another operator (mint outline on the row, no animation).
- **"Who saw this run"** trail at the bottom of Run Detail — Linear's pattern.

This is a 2-line CSS reservation today; doing it now means we never have to retrofit.

## 17. The North-Star Test

For every screen, before merge, the designer/engineer asks four questions:

1. **Could this screenshot live on the Linear changelog?** If no, it's not done.
2. **Can a new operator complete the primary action without reading docs?** If no, the empty state, microcopy, or affordance is wrong.
3. **Does every interactive element have a keyboard path discoverable from `⌘K`?** If no, add it.
4. **Would I screenshot this?** If no — at least once per page — we've shipped a utility, not a product.

## 18. Sequenced Strategic Bets

In addition to Part I's 5 phases, three strategic bets compound the polish:

- **Bet A — The Cockpit Reframe.** Default route, IA collapse to 4 zones, labeled nav with `Kbd` hints. *Unlocks: every operator finds everything in week one.*
- **Bet B — The Assistant as Spine.** Persistent object, slash-grammar, citations, `⌘J / ⌘.`. *Unlocks: the product's actual differentiator becomes visible.*
- **Bet C — Run-as-Story.** Re-author Run Detail and Activity as readable narratives, not log dumps. *Unlocks: the moment users say "this is the cleanest agent dashboard I've ever used."*

If we only had budget for three things, it would be these three. Everything else in Part I makes them possible.

---

## Closing — What "10x" Actually Means Here

10x is not 10x more pixels, gradients, or animations. 10x is:

- 10x **less** visual noise.
- 10x **more** keyboard reach.
- 10x **clearer** sentences in every empty state, error, and label.
- 10x **faster** perceived latency.
- 10x **more** discipline about which moments are allowed to "perform."

The ceiling we are aiming at is the moment a Vercel or Linear designer opens Agentis, scrolls for thirty seconds, and quietly says *"who built this?"* — and then goes looking for the team.
