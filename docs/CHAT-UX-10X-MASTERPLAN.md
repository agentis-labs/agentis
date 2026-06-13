# Agentis Chat UX 10x Masterplan

**Status:** Proposed refactor plan  
**Scope:** Chat dock, full-page chat, workflow creation handoff, activity persistence, realtime UI protocol  
**North star:** Chat is the operator's command surface. The transcript explains the work. The workspace stage shows the work becoming real.

---

## 1. Executive Decision

Do not polish the current transcript incrementally.

Refactor chat around a persisted **Agent Activity** model and a composable **Workspace Stage**. The assistant response remains conversational, but tool use, plans, workflow creation, approvals, artifacts, and run progress become typed UI records instead of markdown fragments inferred after the fact.

The highest-impact behavior is workflow creation:

1. The operator asks Orchy to create a workflow.
2. Chat immediately creates an activity session and shows one calm active-work card.
3. As soon as the workflow build starts, full-page chat automatically opens a split workspace stage.
4. The canvas animates nodes and connections into place from real backend events.
5. The side rail narrates the current phase, specialists, repairs, critiques, and wiring blockers.
6. Chat stays available on the right for steering without obscuring the canvas.
7. Completion collapses into a concise summary with direct actions: review canvas, configure missing integrations, test run, schedule, or keep chatting.

The interface must never present suggested next steps as completed work.

---

## 2. Why This Needs A Structural Refactor

The current UI already contains strong ingredients, but they are connected through fragile inference and duplicated surfaces.

### Current strengths

- The backend emits workflow build phases, repairs, critiques, roster data, node placement, edge connection, and completion events.
- The workflow creation pipeline persists an empty graph first and streams real nodes into the canvas.
- The active chat implementation supports reasoning, tool calls, confirmation cards, pagination, message editing, regeneration, viewport context, proactive cards, auto-scroll recovery, and a mini canvas.
- Full-page chat has an early split-canvas preview concept.

### Current failure modes

| Current behavior | Root cause | Product effect |
| --- | --- | --- |
| Suggested follow-up steps can appear as `3/3 Completed` | `PlanList` extracts numbered markdown and guesses state from tool-call counts | The UI claims work happened when it did not |
| Build trace and mini canvas compete with the conversation | Activity UI is mounted at the composer boundary and again inside the canvas embed | The chat becomes visually noisy while the main artifact stays secondary |
| The richer workspace stage opens only after an explicit click | `CanvasEmbed.handleOpen()` dispatches preview navigation on demand | The user misses the key moment: watching the workflow become real |
| Live build narration is ephemeral | Timeline components subscribe to socket events without persisted replay | Reloading or joining late loses the story |
| Two chat generations remain in the repo | `components/chat/*` and `components/ChatPanel/*` overlap | Behavior drifts and future polish becomes slower |
| Raw tool names and JSON dominate expanded execution details | Generic tool rendering is the default | Operators must translate implementation details into meaning |
| Reasoning and status compete for attention | Model thinking, tool calls, build phases, sticky banners, and canvas embeds render as separate layers | The interface feels busy instead of alive |

### Important code anchors

- Markdown plan inference: `apps/web/src/components/chat/PlanList.tsx`
- Main chat renderer: `apps/web/src/components/chat/ThreadView.tsx`
- Current execution feed: `apps/web/src/components/chat/ExecutionFeed.tsx`
- Current full-page split preview: `apps/web/src/pages/ChatPage.tsx`
- Current inline live canvas: `apps/web/src/components/ChatPanel/CanvasEmbed.tsx`
- Workflow event publisher: `apps/api/src/services/agentisToolHandlers/build.ts`
- Realtime event catalog: `packages/core/src/events.ts`

---

## 3. Product Research Synthesis

The best current agent interfaces converge on a few patterns.

### Codex

OpenAI positions the Codex app as a command center for long-running, parallel agent work. Threads retain context, agent changes are reviewable inside the thread, and the product exposes live state such as approvals, screenshots, terminal output, diffs, and test results. Codex CLI also tracks complex work with a to-do list and formats tool calls and diffs for scanability.

**Agentis implication:** a transcript is not enough. Chat needs durable activity state, reviewable outputs, and a live artifact surface.

Sources:

- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- [Introducing upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)

### Claude Code

Claude Code creates a task list for complex work with pending, in-progress, and complete states. Tasks persist across context compactions. Plan mode is a distinct interaction state: the agent researches first, then the operator chooses how execution may proceed. Claude Code also gives subagents explicit color identity in the task list and transcript.

**Agentis implication:** plans must be explicit state, not parsed text. Planning, execution, and approval are different modes with different affordances. Specialist identity should be visible but restrained.

Sources:

- [Claude Code interactive mode: task list](https://code.claude.com/docs/en/interactive-mode#task-list)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)

### GitHub Copilot Coding Agent

GitHub exposes a sessions list and a detailed session log. Operators can monitor progress, token usage, session length, steer a running session with a follow-up prompt, stop it, and archive it.

**Agentis implication:** active work needs a global session surface with steering and stop controls. Completed work should remain inspectable and archivable.

Source:

- [GitHub Docs: Managing agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)

### Cursor

Cursor's public docs describe separate chat tabs for parallel tasks, background agents with status and takeover, and automatic checkpoints that can be restored after agent changes.

**Agentis implication:** isolate concurrent work, preserve recovery points, and keep background work visible outside the currently open thread.

Sources:

- [Cursor Docs: Tabs](https://docs.cursor.com/agent/chats)
- [Cursor Docs: Background agents](https://docs.cursor.com/background-agent)
- [Cursor Docs: Checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints)

### Chat UI Infrastructure

assistant-ui provides accessible headless primitives for thread, composer, message, streaming, tool calls, auto-scroll, and keyboard behavior. Vercel AI SDK's UI stream model supports typed message chunks, merging, persistence, error handling, and finish callbacks.

**Agentis implication:** borrow primitive patterns and typed-stream ideas, but keep Agentis's domain model. Agentis has proactive pushes, rooms, workflow canvas events, approvals, and platform-specific activities that generic chat runtimes do not model.

Sources:

- [assistant-ui headless primitives](https://www.assistant-ui.com/docs/primitives)
- [Vercel AI SDK: createUIMessageStream](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream)

---

## 4. Experience Direction

### Concept: Operations Desk

Agentis should feel like a calm operations desk for autonomous work, not a messaging app with extra cards.

The memorable interaction is simple:

> Ask for an outcome in chat. Watch the workspace assemble itself beside the conversation. Step in only where judgment is useful.

### Visual character

- Dark charcoal surfaces, not pure black.
- One restrained emerald accent for live and successful state.
- Amber only for human action or missing configuration.
- Red only for failure or destructive action.
- Compact sans-serif UI typography with monospace reserved for IDs, durations, tool names, and metrics.
- Fewer nested cards. Use whitespace, divider lines, and layered surfaces to establish hierarchy.
- The canvas is the hero artifact during workflow creation. The chat becomes the control rail.

### UX rules

1. Show the most important live state once.
2. Prefer semantic labels over internal tool names.
3. Keep the latest active action visible without forcing scroll.
4. Collapse finished activity automatically, but preserve inspectability.
5. Distinguish `planned`, `running`, `waiting`, `done`, `failed`, and `cancelled`.
6. Never expose raw chain-of-thought as the primary UX. Show concise reasoning summaries and inspectable system events.
7. Let the operator steer, stop, retry, or open the artifact at any time.
8. Preserve active activity across route changes, reloads, and chat dock collapse.

---

## 5. Target Information Architecture

### Full-page chat

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Session rail        Workspace stage                           Chat rail     │
│                     (appears when work has an artifact)                    │
│ [new thread]        ┌──────────────────────────────────────┐  Orchy         │
│ Active              │ Workflow canvas / run / artifact    │  Context       │
│ ● Morning digest    │                                      │               │
│ ○ Research brief    │ Live nodes animate into place        │  Transcript    │
│                     │                                      │               │
│ Recent              │ Inspector: current phase, roster,    │  Composer      │
│ ...                 │ blockers, audit notes                │               │
│                     └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Docked chat

```text
┌──────────────────────────────────────────┐
│ Orchy · Workspace orchestrator       ... │
├──────────────────────────────────────────┤
│ Transcript                               │
│                                          │
│ [Active workflow build]                  │
│ Placing nodes · 4/7                      │
│ [Open live canvas] [Stop]                │
│                                          │
├──────────────────────────────────────────┤
│ Context chip                             │
│ Ask Orchy...                       [↑]   │
└──────────────────────────────────────────┘
```

The dock does not embed a 220px canvas by default. It shows an activity summary and an explicit **Open live canvas** action. Full-page chat automatically opens the workspace stage.

### Mobile

- One surface at a time: `Chat`, `Activity`, `Canvas`.
- Active work appears as a pinned compact banner.
- Opening the canvas pushes a full-screen view with a persistent return-to-chat affordance.
- Approvals always remain reachable in one tap.

---

## 6. Golden Workflow Creation Flow

### 6.1 Prompt sent

Operator:

> Create a workflow that searches for AI agent news and sends me a morning email.

UI response:

- Operator bubble appears immediately.
- A single assistant activity shell enters with `Preparing workflow`.
- The composer stays usable for steering.

### 6.2 Build starts

On the first `workflow.build.phase` event:

- Create or hydrate a `workflow_build` activity.
- Full-page chat opens the workspace stage automatically.
- The dock shows a compact activity card with **Open live canvas**.
- Stage header shows the workflow title, live status, elapsed time, and actions.

### 6.3 Plan and specialist roster

The stage inspector shows:

```text
Designing workflow
Planner complete
Architect drafting graph
Reviewer waiting

Specialists
● Planner
● Workflow architect
○ Reviewer
```

Only show roster members that actually participate. Do not fabricate collaboration.

### 6.4 Graph animation

When `canvas.node.placed` arrives:

- Insert the real node.
- Animate with `opacity` and `transform` only.
- Draw its incoming edge after the node settles.
- Briefly highlight the new node.
- Update the current narration line: `Added Gmail delivery`.

When a repair arrives:

- Add a concise amber audit note: `Added Gmail delivery because the request requires email output.`
- Keep the raw Iron Rule and payload inside an expandable technical details section.

### 6.5 Wiring blockers

If a node requires credentials:

- Node uses an amber outline and `Needs setup` badge.
- Stage inspector offers the relevant credential or OAuth action inline.
- Completion state becomes `Built with 1 setup item`, not an error and not a silent success.

### 6.6 Completion

Stage header:

```text
Morning AI agent news
Built · 7 nodes · 3 repairs · Gmail setup required
```

Chat receives a concise assistant response:

```text
I built the morning AI agent news workflow.

It searches the configured sources, summarizes the results, and delivers an
email digest. Gmail still needs to be connected before the first scheduled run.

[Review canvas] [Connect Gmail] [Test workflow]
```

The activity shell collapses to a one-line summary but remains expandable.

### 6.7 Follow-up suggestions

Suggestions render as suggestion chips:

```text
Try next
[Change the delivery time] [Limit sources] [Send a test email]
```

They are never rendered as execution tasks and never receive completion checkmarks.

---

## 7. The New Domain Model

### 7.1 Persisted activity records

Add a durable `chatActivities` record:

```ts
type ChatActivityKind =
  | 'workflow_build'
  | 'workflow_run'
  | 'platform_action'
  | 'approval'
  | 'research'
  | 'delegation'
  | 'artifact_generation';

type ChatActivityStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'completed_with_attention'
  | 'failed'
  | 'cancelled';

interface ChatActivity {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string | null;
  kind: ChatActivityKind;
  title: string;
  status: ChatActivityStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  workflowId?: string | null;
  runId?: string | null;
  summary?: string | null;
  attentionCount?: number;
  metadata?: Record<string, unknown>;
}
```

### 7.2 Persisted activity steps

```ts
type ActivityStepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface ChatActivityStep {
  id: string;
  activityId: string;
  key: string;
  label: string;
  detail?: string | null;
  status: ActivityStepStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  order: number;
  technical?: Record<string, unknown>;
}
```

### 7.3 Typed chat message parts

Replace metadata accumulation and markdown parsing with ordered parts:

```ts
type ChatMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning_summary'; text: string; durationMs?: number }
  | { type: 'activity'; activityId: string }
  | { type: 'approval'; approvalId: string }
  | { type: 'artifact'; artifactId: string }
  | { type: 'run'; runId: string }
  | { type: 'suggestions'; items: Array<{ label: string; prompt: string }> }
  | { type: 'error'; title: string; detail?: string; retryable?: boolean };
```

### 7.4 Realtime protocol

Introduce durable activity events:

```ts
activity.created
activity.updated
activity.step.upserted
activity.log.appended
activity.artifact.linked
activity.completed
activity.failed
```

Workflow-specific events continue to exist, but the backend projector also maps them into activity state. The UI can hydrate from REST and then subscribe to deltas.

### 7.5 Why persistence matters

- Reloading full-page chat reconstructs the active workflow build.
- Opening the dock after work started shows real progress.
- Joining late receives current graph state plus event history.
- Session history remains inspectable after completion.
- Missed websocket events no longer leave the canvas empty.

---

## 8. Component Architecture

### 8.1 Consolidate the duplicate chat implementations

Target structure:

```text
apps/web/src/components/chat/
  ChatDock.tsx
  ChatWorkspace.tsx
  ChatThread.tsx
  ChatComposer.tsx
  MessageRenderer.tsx
  parts/
    TextPart.tsx
    ReasoningSummaryPart.tsx
    ActivityPart.tsx
    ApprovalPart.tsx
    ArtifactPart.tsx
    RunPart.tsx
    SuggestionPart.tsx
  activities/
    ActivityCard.tsx
    ActivityTimeline.tsx
    WorkflowBuildActivity.tsx
    WorkflowRunActivity.tsx
    PlatformActionActivity.tsx
  stage/
    WorkspaceStage.tsx
    WorkflowBuildStage.tsx
    WorkflowBuildInspector.tsx
    StageHeader.tsx
  hooks/
    useChatThread.ts
    useChatActivity.ts
    useWorkspaceStage.ts
    useAutoScroll.ts
```

Retire the legacy `apps/web/src/components/ChatPanel/ChatPanel.tsx` generation after parity is verified. Keep reusable primitives only where they have one clear owner.

### 8.2 One renderer per concept

| Concept | Owner |
| --- | --- |
| Assistant text | `TextPart` |
| Concise thought/status summary | `ReasoningSummaryPart` |
| Workflow build progress | `WorkflowBuildActivity` |
| Generic platform tool call | `PlatformActionActivity` |
| Approval | `ApprovalPart` |
| Live canvas stage | `WorkflowBuildStage` |
| Dock summary | Compact variant of the same activity renderer |

The transcript and stage read from the same persisted activity. They do not subscribe independently and reconstruct different versions of reality.

### 8.3 Tool presentation registry

Add a semantic registry:

```ts
interface ToolPresentation {
  label: (args: unknown, result?: unknown) => string;
  summary: (args: unknown, result?: unknown) => string;
  icon: IconComponent;
  tone: 'neutral' | 'live' | 'attention' | 'danger';
  renderer?: React.ComponentType<ToolPresentationProps>;
}
```

Examples:

| Raw tool | Operator label |
| --- | --- |
| `agentis.build_workflow` | `Build workflow` |
| `agentis.workflow.run` | `Run workflow` |
| `agentis.run.cancel` | `Stop run` |
| `agentis.memory.write` | `Save workspace memory` |
| Unknown tool | Humanized fallback with technical details collapsed |

### 8.4 assistant-ui adoption boundary

Use assistant-ui only where it reduces basic chat plumbing without becoming a second source of truth:

- Good candidates: composer keyboard behavior, attachment primitives, dictation affordances, accessibility patterns, scroll-to-bottom patterns.
- Avoid full runtime replacement in the first refactor: Agentis has rooms, proactive pushes, persisted platform activities, confirmations, archived threads, viewport context, and canvas stage state.
- Re-evaluate full runtime adoption after the typed message-part migration.

---

## 9. Interaction States

### 9.1 Assistant turn states

```text
idle
  -> preparing
  -> responding
  -> acting
  -> waiting_for_operator
  -> completed
  -> failed
  -> cancelled
```

### 9.2 Workflow build state

```text
analyzing
  -> drafting
  -> repairing?
  -> reviewing?
  -> building
  -> completed
  -> completed_with_attention
  -> failed
```

### 9.3 Stage behavior

| Event | Dock | Full-page chat |
| --- | --- | --- |
| First build phase | Show compact active card | Auto-open workflow stage |
| Node placed | Update progress count | Animate real node into stage |
| Repair or critique | Increment audit count | Append inspector note |
| Missing credential | Show attention badge | Highlight node and show setup CTA |
| Completion | Collapse summary | Keep stage open for review |
| User closes stage | Keep active card | Return to transcript-focused layout |
| New build while stage closed | Update badge | Re-open stage only if operator has not explicitly dismissed auto-open for this activity |

### 9.4 Steering

While an activity is running:

- Composer remains enabled.
- New input is labeled `Steer current work`.
- Server queues steering input after the current atomic tool action.
- Activity timeline records the steering note.
- A visible `Stop` action cancels the activity after confirmation when side effects may already exist.

---

## 10. Motion System

Motion must explain state change, not decorate every pixel.

### Timing

| Interaction | Duration |
| --- | --- |
| Button press | `100-140ms` |
| Tooltip or small popover | `120-180ms` |
| Activity expansion | `160-220ms` |
| Stage reveal | `220-280ms` |
| Node placement | `180-240ms` |
| Edge draw | `160-220ms` |

### Rules

- Animate only `transform`, `opacity`, and SVG stroke reveal.
- Use a strong ease-out curve for entrances: `cubic-bezier(0.23, 1, 0.32, 1)`.
- Use ease-in-out for node repositioning.
- Avoid perpetual motion except one active-state indicator.
- Do not animate keyboard-driven navigation.
- Gate hover effects behind `(hover: hover) and (pointer: fine)`.
- Respect `prefers-reduced-motion`: keep fades, remove travel and graph choreography.
- Keep node placement stagger short enough that a 20-node workflow remains readable and fast.

---

## 11. Refactor Phases

### Phase 0: Freeze The Contract

**Goal:** lock the intended behavior before deleting or moving UI.

Tasks:

- Add visual regression fixtures for docked chat, full-page chat, active workflow build, completed build, missing credentials, approval waiting, failed action, and mobile layout.
- Add a deterministic seeded workflow-build stream fixture.
- Document the current active chat entry points and mark the legacy generation for retirement.

Acceptance:

- Existing behavior can be replayed deterministically in tests.
- Screenshots exist for the current state and the target states.

### Phase 1: Persist Agent Activities

**Goal:** remove semantic guessing from the UI.

Tasks:

- Add `chatActivities`, `chatActivitySteps`, and optional `chatActivityLogs`.
- Create an activity projector for workflow build events.
- Add REST endpoints to fetch active and historical activities by conversation.
- Add activity realtime events.
- Add hydration on reconnect.

Acceptance:

- Reloading during workflow creation restores the current phase, steps, graph link, and attention items.
- Joining after node placement still renders the current graph.
- No UI parses numbered markdown to decide task completion.

### Phase 2: Typed Message Parts

**Goal:** make the transcript composable.

Tasks:

- Extend stored chat messages with ordered `parts`.
- Preserve `body` temporarily for backward compatibility.
- Add part renderers and migration adapters for old metadata.
- Render suggestions as suggestion chips, never task rows.
- Render reasoning as concise summaries, not raw internal reasoning dumps.

Acceptance:

- Existing historical messages still render.
- New turns do not need `extractPlan()`.
- The screenshot bug where future suggestions become completed tasks cannot occur.

### Phase 3: Consolidate Chat UI

**Goal:** remove duplicate owners and simplify the render tree.

Tasks:

- Build `ChatDock`, `ChatWorkspace`, `ChatThread`, and `MessageRenderer`.
- Move reusable composer behavior into one `ChatComposer`.
- Replace overlapping `ThreadView`, `CanvasEmbed`, timeline, and sticky banner ownership with activity-backed components.
- Remove the legacy `components/ChatPanel/ChatPanel.tsx` branch after parity.

Acceptance:

- Docked and full-page chat share the same message and activity renderers.
- A workflow build timeline appears once.
- A tool result has one semantic summary and one expandable technical payload.

### Phase 4: Workspace Stage

**Goal:** make workflow creation visually exceptional.

Tasks:

- Add `WorkspaceStage` and `WorkflowBuildStage`.
- Auto-open the stage on the first workflow build phase in full-page chat.
- Hydrate graph state from the workflow snapshot, then apply realtime node and edge deltas.
- Add inspector sections for phase, roster, narration, repairs, critiques, and setup blockers.
- Add explicit open-stage action in docked chat.

Acceptance:

- Sending a build request opens the split stage before the graph is complete.
- Nodes and edges appear progressively from real events.
- Closing the stage returns focus to chat without losing progress.
- Completion keeps the artifact open for review.

### Phase 5: Supervision Controls

**Goal:** make long-running work steerable.

Tasks:

- Add global active-activity center and improve floating dock progress.
- Add `Stop`, `Retry`, `Open artifact`, and `Steer current work`.
- Add waiting-for-operator cards with explicit impact and expiry.
- Add session archive and recap summaries.
- Add optional checkpoint records before mutating workflow revisions.

Acceptance:

- A running activity is visible from any route.
- The operator can redirect or stop work without hunting through the transcript.
- Approvals identify the action, impact, reversibility, and destination.

### Phase 6: Composer And Message Craft

**Goal:** make everyday interaction feel finished.

Tasks:

- Keep viewport context as a removable chip.
- Replace simulated attachments with real persisted upload behavior.
- Add paste/drop attachments, voice dictation where supported, and keyboard submit options.
- Add copy, edit, retry, regenerate, and quote actions with restrained hover reveal.
- Add empty states that teach slash commands and context references.

Acceptance:

- Attachments survive sending and reload.
- Message actions are keyboard accessible.
- Composer never jumps during streaming or stage reveal.

### Phase 7: Accessibility, Performance, And Cleanup

**Goal:** make the 10x UI durable.

Tasks:

- Add reduced-motion graph behavior.
- Virtualize long threads and long activity logs.
- Batch canvas deltas when event volume spikes.
- Measure render time, reconnect recovery, and scroll stability.
- Remove old feature flags, duplicated code, and obsolete plan inference.

Acceptance:

- 500-message history remains responsive.
- 100-node streamed graph remains usable.
- Reload and reconnect do not duplicate events.
- Keyboard-only and reduced-motion flows pass.

---

## 12. Test Strategy

### Unit

- Activity projector: workflow events -> persisted activity state.
- Typed part migration: legacy metadata -> new message parts.
- Tool presentation registry fallbacks.
- Suggestion rendering cannot become task rendering.
- Reconnect deduplication.

### Integration

- Build request -> activity created -> phases streamed -> graph hydrated -> completion summary.
- Missing Gmail credential -> amber node -> inline setup action.
- Reload mid-build -> stage reconstructs accurately.
- Dock close mid-build -> floating progress -> reopen -> same activity.
- Steering message while running -> queued -> activity log entry.
- Stop activity -> cancellation state with preserved partial artifact.

### E2E

1. Ask Orchy to build the morning-news workflow.
2. Assert the full-page stage opens automatically.
3. Assert nodes appear progressively.
4. Assert build narration updates from real events.
5. Assert completion presents review and setup actions.
6. Assert suggestion chips are not marked completed.
7. Assert docked mode exposes **Open live canvas** instead of embedding an oversized graph.
8. Assert mobile uses separate `Chat`, `Activity`, and `Canvas` surfaces.

---

## 13. Immediate Implementation Order

Build in this order:

1. Persist activity records and project existing workflow events into them.
2. Replace markdown plan inference with typed parts and explicit suggestions.
3. Build the shared activity renderer.
4. Add the full-page workspace stage with auto-open.
5. Collapse the dock to a compact live summary.
6. Consolidate duplicate chat implementations.
7. Add supervision controls, attachment persistence, accessibility, and performance hardening.

The first visible milestone should ship after steps 1-5:

> Ask Orchy for a workflow, see a live activity card, watch the canvas open and animate in real time, and finish with a truthful summary plus next-action chips.

---

## 14. Definition Of Done

The chat UX refactor is complete when:

- Chat no longer guesses task state from assistant markdown.
- Workflow creation auto-opens a live stage in full-page chat.
- The canvas uses real persisted workflow state plus realtime deltas.
- Reloading or reconnecting preserves active progress.
- Docked and full-page chat share one renderer architecture.
- Completed activity collapses cleanly and remains inspectable.
- Suggestions never appear as completed work.
- Missing configuration is visible and actionable inline.
- Long-running work can be steered, stopped, resumed, and reviewed from any route.
- Mobile, keyboard, and reduced-motion experiences are intentional.
- The UI feels quieter while showing more truth.

