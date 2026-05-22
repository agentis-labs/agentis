# Chat 10x Vision — The Platform Brain Experience

> **Status**: Spec — Ready for sprint planning
> **Date**: May 21, 2026
> **Scope**: Entire chat surface, agent intelligence layer, real-time execution UX, adapter protocol
> **Priority**: P0 — This is the platform's center of gravity. Everything else depends on this working.
> **References**: `CHAT-AGENT-LOOP.md`, `CHAT-10X-REPLAN.md`, `AGENTS-10X-REPLAN.md`, `AGENTIS-UX-V2.md`, `PLATFORM-VISION.md`

---

## 0. The Problem in One Paragraph

When a user asks "build me a Hello World workflow," the orchestrator responds with a JSON blob and tells the user to paste it somewhere. The agent knew it *should* call `agentis.build_workflow`. It just didn't. The infrastructure exists — SSE streaming, tool catalog, chat loop executor, viewport context. But the agent doesn't trust its tools, the system prompt doesn't compel action, the adapters don't forward the tool catalog correctly, and the UI offers no feedback that anything is actually happening. The chat surface is currently a message relay with smart autocomplete. It needs to be the platform brain — watching, thinking, building, and narrating in real time.

---

## 1. Industry Research — What the Best Do Right

Before redesigning anything, we looked at what every major agentic interface has independently converged on. The patterns are strikingly consistent across Claude Code, Codex, Cursor Composer, and Perplexity.

### 1.1 The Anatomy of a Claude Code Session

Claude Code shows the operator a live feed of what it is doing:

```
> I'll start by reading the relevant files, then make the changes.

[Reading file]  src/routes/workflows.ts         ●  0.1s
[Reading file]  apps/api/src/engine/WorkflowEngine.ts  ●  0.2s

[Editing file]  src/routes/workflows.ts
  + export async function buildWorkflow(...)

[Running tool]  bash                             ●  0.9s
  $ pnpm tsc --noEmit
  ✓ 0 errors

Done. I added the buildWorkflow function and ran the typecheck.
```

Key observations:
- The agent narrates its plan in **one sentence** before acting.
- Every tool call appears as a **live status row** (file name + status dot + duration).
- Tool outputs are collapsed by default but expandable.
- The final response is short — the *doing* is the content.

### 1.2 The Anatomy of a Codex Session

Codex (OpenAI's coding agent) does the same, but goes further on multi-step planning:

```
I'll explore the repository structure before suggesting the fix.

[Searching] repo structure                       ✓ 0.4s
[Reading]   packages/core/src/events.ts          ✓ 0.1s

Based on what I found, here is my plan:
  1. Add WORKFLOW_PAUSE_REQUESTED to REALTIME_EVENTS
  2. Emit the event in WorkflowEngine.cancelRun()
  3. Subscribe in WorkflowCanvasPage

[Editing]   packages/core/src/events.ts          ✓ 0.2s
[Editing]   apps/api/src/engine/WorkflowEngine.ts ✓ 0.3s
[Editing]   apps/web/src/pages/WorkflowCanvasPage.tsx ✓ 0.2s

All 3 changes applied. Run `pnpm tsc --noEmit` to verify.
```

Key observations:
- The agent **discovers first**, then commits to a plan.
- The plan is presented as a **numbered todo list** before execution.
- Items get checked off live.
- The agent commits to outcomes, not questions.

### 1.3 The Anatomy of a Cursor Composer Session

Cursor Composer adds spatial grounding — the file being edited opens in the editor pane:

- When Cursor edits a file, that file becomes active in the editor.
- A diff view shows exactly what changed.
- The operator can Accept/Reject individual file changes without leaving the chat.

Key observations:
- The agent operates **inside the operator's visual workspace**, not beside it.
- Changes are **reversible and granular** — the user is never locked in.
- The chat thread and the editor share the same spatial context.

### 1.4 The Anatomy of a Perplexity Session

Perplexity shows reasoning as a streaming prefix before the answer:

```
[Searching]  "agentis workflow build API"     ✓
[Searching]  "workflow graph node types"      ✓

Based on 4 sources:
...answer...

Sources: [1] [2] [3] [4]
```

Key observations:
- The thinking/reasoning is **ephemeral** — it disappears once the answer lands. The user saw the work, but the thread stays clean.
- Sources are **cited inline** not appended as a list.

### 1.5 Anthropic's "Building Effective Agents" — The Three Principles

Anthropic's own research paper distills everything to three rules:

1. **Maintain simplicity.** The agentic loop is 30 lines. No framework needed.
2. **Prioritize transparency.** Show planning steps. The user must see an expert working, not wait for a black box.
3. **Invest in the Agent-Computer Interface (ACI).** Tool descriptions matter as much as the system prompt. Each tool needs: what it does, when to use it, examples, clear boundaries from other tools.

### 1.6 AI SDK 4.2 Message Parts — The Emerging Standard

Vercel's AI SDK 4.2 has converged on a `message.parts[]` model that sequences:

```
[{ type: 'reasoning', reasoning: '...' }]
[{ type: 'text', text: '...' }]
[{ type: 'tool-invocation', toolName: '...', state: 'partial-call'|'call'|'result' }]
[{ type: 'source', source: { url, title } }]
```

This is the emerging standard for multi-step agentic message rendering. Agentis already has a compatible delta stream (`thinking | text | tool_call | tool_result | done`) — we need to align the UI rendering with this parts model.

---

## 2. Root Cause Analysis — Why the Current Experience Fails

### 2.1 The Adapter Protocol Break

**Problem**: When an agent dispatched via the Codex adapter receives a chat turn, the adapter's `chat()` method is either not implemented or doesn't forward the `tools` array. Without a `tools` array in the LLM request, the model has no function-calling surface.

**Evidence**: The screenshot shows "I can't call Agentis workflow tools directly from this Codex session." The adapter dispatched the turn but without tool definitions — the model has no way to call `agentis.build_workflow`.

**Root cause files**:
- `apps/api/src/adapters/codex/CodexAdapter.ts` — needs `async *chat()` implementing the Codex CLI streaming protocol with tools forwarded as system context
- `apps/api/src/adapters/hermes/HermesAdapter.ts` — needs the `chat()` method to send `tools[]` in the request body
- `apps/api/src/adapters/claude/ClaudeCodeAdapter.ts` — needs tools forwarded as JSON in the invocation payload

### 2.2 The System Prompt Fails to Compel Action

**Problem**: The orchestrator's system prompt describes what it *can* do, but does not make explicit that its job is to **do things immediately, not describe them**. The prompt does not say:

> "When asked to build a workflow, call `agentis.build_workflow` immediately. Do not describe the JSON. Do not ask for confirmation. Build it. Show your work. Present the result."

Without this instruction, frontier models default to their training behavior: explain what they would do rather than doing it.

**Root cause files**:
- `apps/api/src/services/chatSessionExecutor.ts` — `#buildSystemPrompt()` method

### 2.3 The Tool Catalog Has No Examples

**Problem**: The `AgentisToolRegistry` has tool definitions with `description` fields, but they don't include example invocations. Without examples, the model guesses at argument shapes and gets them wrong.

**Anthropic's rule**: "Put yourself in the model's shoes. Is it obvious how to use this tool? If not, it's probably also true for the model. Add example usage, edge cases, and input format requirements."

**Root cause files**:
- `apps/api/src/services/agentisToolRegistry.ts` — tool definitions need `examples` field
- `apps/api/src/tools/` — all tool handler implementations need example annotations

### 2.4 The UI Has No Execution Theater

**Problem**: The UI renders tool calls as collapsed `ToolCallPill` elements. When a long task runs (say, building a workflow with 8 nodes), the user sees a spinning dot next to "agentis.build_workflow" for 3 seconds, then a success tick. There is no sense of the work happening — no plan, no progress, no spatial connection to what changed.

**What Claude Code does**: Each tool call is a row in a live feed. When the agent edits a file, that file opens. When the agent runs a command, the output streams in. The chat and the workspace are one continuous experience.

**Root cause files**:
- `apps/web/src/components/ChatPanel/ToolCallPill.tsx` — renders a collapsed pill; needs to be an expandable execution row
- `apps/web/src/components/chat/ThreadView.tsx` — renders tool calls inline with text; needs an `ExecutionFeed` component for grouped, plan-first rendering
- `apps/web/src/components/ChatPanel/ThreadView.tsx` — same issue

### 2.5 The Thinking Process Is Invisible

**Problem**: The delta type `{ type: 'thinking', delta: string }` is accumulated in `streamedThinking` and stored in `metadata.thinking`. But the thinking text is never shown to the user — the field is never rendered in any message bubble.

**Root cause files**:
- `apps/web/src/components/chat/ThreadView.tsx` — `MessageBubble` component: no rendering branch for `metadata.thinking`
- `apps/web/src/components/ChatPanel/ThreadView.tsx` — same

### 2.6 Canvas Events Are Not Surfaced from Chat

**Problem**: `CANVAS_NODE_PLACED`, `CANVAS_EDGE_CONNECTED`, and `CANVAS_BUILD_COMPLETE` events exist and are emitted correctly. But when the orchestrator calls `agentis.build_workflow` from the chat loop, it creates the workflow and run in the DB, but:
1. The canvas is not navigated to the new workflow.
2. The run overlay is not launched on the canvas.
3. The user stays in the chat thread watching a pill tick from `running` to `success`.

**Root cause files**:
- `apps/web/src/components/chat/ThreadView.tsx` — no handler for `CANVAS_BUILD_COMPLETE`
- `apps/api/src/tools/buildWorkflow.ts` (or equivalent) — doesn't emit `CANVAS_NODE_PLACED` events during graph construction
- `apps/web/src/pages/WorkflowCanvasPage.tsx` — receives `CANVAS_*` events but has no integration with chat-initiated builds

---

## 3. The 10x Vision — Experience Design

### 3.1 The Single Sentence Summary

> The operator types a request. The agent narrates a one-line plan, then visibly executes it — step by step, with live progress rows, temporary thinking text, and real page navigation. The workspace changes in front of the operator's eyes. The agent reports what it did, not what it would do.

### 3.2 The Execution Feed

The core UX primitive replacing the flat `ToolCallPill` is the **ExecutionFeed**. It appears inside a message bubble below the thinking text, above the final response.

```
┌─────────────────────────────────────────────────────┐
│  I'll build the Hello World workflow for you.       │
│                                                     │
│  ╔══════════════════════════════════════════════╗  │
│  ║  Execution                              ×   ║  │
│  ╠══════════════════════════════════════════════╣  │
│  ║  ✓  agentis.workflow.create     0.2s  [>]   ║  │
│  ║  ✓  agentis.node.add  trigger   0.1s  [>]   ║  │
│  ║  ✓  agentis.node.add  transform 0.1s  [>]   ║  │
│  ║  ✓  agentis.edge.connect        0.1s  [>]   ║  │
│  ╚══════════════════════════════════════════════╝  │
│                                                     │
│  Done. Your "Hello World" workflow is live.         │
│  [Open on canvas →]                                 │
└─────────────────────────────────────────────────────┘
```

Behavior:
- The ExecutionFeed expands progressively as tool calls arrive during streaming.
- Each row shows: tool name → animated spinner → duration → expand chevron.
- Completed rows persist. Running rows animate. Failed rows are highlighted in red.
- Clicking `[>]` expands the row to show the JSON input and output (lazy-rendered).
- A `[×]` button collapses the entire feed once all rows complete.
- After completion, the feed shows a summary count: "4 actions completed".

### 3.3 The Thinking Bubble

Before each tool call cluster, if the adapter emitted thinking deltas, render a **ThinkingBubble** that:
- Appears as an ephemeral prefix inside the current message bubble.
- Uses a lighter, italic style to differentiate it from the final response.
- Fades out progressively when the final response text starts arriving.
- Is never saved to the persisted message — it exists only during streaming.

```
┌─────────────────────────────────────────────────────┐
│  💭  I need to check what workflow types are avail-  │  ← ephemeral, fades out
│       able and whether a transform node is the right  │     when response arrives
│       output type for a fixed message...              │
│                                                     │
│  (execution feed + response appear below)           │
└─────────────────────────────────────────────────────┘
```

After streaming ends, the thinking text is stored in `metadata.thinking` but hidden behind an expandable `[View thinking →]` control for users who want to inspect the reasoning.

### 3.4 The Plan Panel (For Multi-Step Tasks)

For tasks requiring 3+ tool calls, the agent should present a **Plan Panel** before executing. This is a numbered list rendered as part of the assistant message, with each item transitioning through states: `○ pending` → `◉ running` → `✓ done` → `✕ failed`.

```
┌─────────────────────────────────────────────────────┐
│  I'll set up the Hello World workflow end-to-end.   │
│                                                     │
│  Plan:                                              │
│  ✓  1. Create the workflow named "Hello World"      │
│  ◉  2. Add a manual trigger node                   │  ← currently running
│  ○  3. Add a transform node returning fixed text    │
│  ○  4. Connect trigger → transform                 │
│  ○  5. Run a test execution to verify               │
│                                                     │
│  ●●●                                               │
└─────────────────────────────────────────────────────┘
```

The Plan Panel is generated by the orchestrator as part of its initial text response (before tool calls begin). This is not a UI-fabricated element — the orchestrator is instructed to output plans in this structured format.

**Implementation note**: The system prompt instructs the orchestrator: "For tasks requiring 3 or more tool calls, output your plan as a numbered list with each item on its own line before executing. Do not ask for confirmation. Begin executing immediately after the plan."

### 3.5 Canvas Navigation from Chat

When the orchestrator builds or modifies a workflow, the canvas navigates to it. This is a spatial connection between chat and the platform.

**Sequence**:
1. User sends: "build me a Hello World workflow" from the Chat panel.
2. Orchestrator calls `agentis.build_workflow`. The tool creates the workflow in DB.
3. `agentis.build_workflow` emits `CANVAS_BUILD_COMPLETE` with `{ workflowId, agentId }`.
4. The Chat panel's `ThreadView` receives `CANVAS_BUILD_COMPLETE`.
5. ThreadView fires `window.dispatchEvent(new CustomEvent('agentis:open-canvas', { detail: { workflowId } }))`.
6. `App.tsx` (or `Shell.tsx`) handles `agentis:open-canvas` and navigates to `/workflows/:workflowId`.
7. The canvas opens and starts the live run overlay (if a run was also started).
8. The chat panel stays open alongside the canvas, showing the completed execution feed.

**Bonus**: If the run is also started, the canvas shows the node-by-node execution animation via the existing `AgentFocusOverlayManager`. The operator watches the workflow execute in the canvas while the chat shows the execution feed simultaneously.

### 3.6 Live Todos at the Top of the Thread

For long-running operations (>10 seconds), a **sticky progress banner** appears at the top of the thread view (below the header). It shows:

```
┌─────────────────────────────────────────────────────┐
│  Chat     ◉ Running (3/5 steps)          [View ↓]  │
│  ─────────────────────────────────────────────────  │
│  ✓  Created workflow "Hello World"                  │
│  ✓  Added trigger node                              │
│  ◉  Adding transform node...                       │  ← animated
│  ○  Connect edges                                   │
│  ○  Run test                                        │
└─────────────────────────────────────────────────────┘
```

This banner collapses once the task completes and is dismissed with a `[×]`. It reappears for new multi-step tasks.

### 3.7 Ephemeral "Watching You Work" Mode

When the orchestrator calls any tool that changes platform state (creates workflow, runs workflow, modifies agent), the platform enters "watching you work" mode:

- The workspace canvas sidebar (on the Home page ecosystem canvas) highlights the node or area being affected.
- A small activity badge appears on the chat panel header button, counting active tool calls.
- If the operator navigates away from the chat mid-execution, the active task banner follows as a floating progress indicator in the bottom-right corner.

### 3.8 Confirmation Cards — Made Gorgeous

Today's confirmation flow is functional but sparse. The 10x version:

```
┌─────────────────────────────────────────────────────┐
│  ⚠  Before I continue                              │
│                                                     │
│  I'm about to run this workflow:                    │
│  "Lead Enrichment Pipeline" — sends emails to 142   │
│  contacts from the pending queue.                   │
│                                                     │
│  Arguments:                                         │
│  • workflow: Lead Enrichment Pipeline               │
│  • trigger: email_campaign_start                    │
│  • dry_run: false                                   │
│                                                     │
│  [Run it]                              [Cancel]     │
│  Expires in 4:47                                    │
└─────────────────────────────────────────────────────┘
```

The confirmation card must:
- Show the **human-readable consequence**, not just the JSON args.
- Show a countdown timer for the expiry.
- Remain clickable from the thread scroll without scrolling.
- Transition to "approved" or "cancelled" state inline — no page navigation.

---

## 4. Architecture — What Must Be Built

### 4.1 Layer 1 — The Agent Intelligence Layer (Week 1)

These changes make the agent actually *act* when asked.

#### 4.1.1 System Prompt Overhaul

**File**: `apps/api/src/services/chatSessionExecutor.ts` — `#buildSystemPrompt()`

Replace the current advisory-style prompt with an action-first imperative:

```typescript
const ORCHESTRATOR_SYSTEM_PROMPT_V2 = `
You are the Agentis Orchestrator — the central intelligence for the {workspace_name} workspace.

YOUR PRIMARY JOB IS TO TAKE ACTIONS. Not to describe actions. Not to plan and wait. To execute.

CORE RULES:
1. When asked to build something — BUILD IT. Call the tool. Do not describe the JSON.
2. When asked to run something — RUN IT. Call agentis.workflow.run immediately.
3. When asked about status — CHECK IT. Call agentis.workflow.status.
4. When multiple steps are needed — PLAN THEN EXECUTE. Write your numbered plan in one message, then call all tools without stopping for confirmation unless the operation is destructive.
5. After a tool returns — NARRATE BRIEFLY. One sentence. Then continue if there are more steps.

DESTRUCTIVE OPERATIONS (require confirmation):
- Deleting workflows, agents, or workspaces
- Running workflows that send external communications (emails, webhooks)
- Overwriting existing data

EVERYTHING ELSE: Execute immediately.

STYLE:
- Think out loud before your first tool call (thinking tokens). Users like seeing the reasoning.
- Be concise in text. Be thorough in actions.
- After completing a task: confirm what you did in one sentence and offer the next obvious action.
- Never say "I would" or "You could". Say what you are doing and do it.

SCREEN CONTEXT:
{screen_context}

PLATFORM STATE:
{platform_state}
`;
```

#### 4.1.2 Tool Documentation Upgrade

Every tool in `AgentisToolRegistry` must have an `examples` field with at least 2 example invocations.

**New `AgentisToolDefinition` interface field in `packages/core/src/types/chat.ts`**:
```typescript
export interface AgentisToolDefinition {
  id: string;
  family: AgentisToolFamily;
  description: string;
  longDescription?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  mutating: boolean;
  mcpExposed?: boolean;
  requires?: string[];
  // NEW:
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
}
```

**Key tools that MUST have examples** (these are the ones agents call most but get wrong):

| Tool | Common failure | Required example |
|---|---|---|
| `agentis.build_workflow` | Passes wrong node config shape | Show full trigger→transform graph |
| `agentis.workflow.run` | Passes workflowId as workflow title | Show UUID format |
| `agentis.agent.dispatch` | Dispatches to agent by name not ID | Show how to look up agent first |
| `agentis.knowledge.search` | Writes a verbose query → no results | Show short keyword-first queries |
| `agentis.approval.resolve` | Passes wrong turnId | Show how to list approvals first |

#### 4.1.3 Adapter Protocol Alignment

All 5 adapters must implement `chat(messages, tools): AsyncIterable<ChatDelta>`.

Current status:
- `HermesAdapter` — partially implemented; needs to actually pass `tools` array in request body
- `ClaudeCodeAdapter` — not implemented; needs stdin/stdout protocol with tools as JSON in system context
- `CodexAdapter` — not implemented; tools must be injected as a system message (Codex uses OpenAI function calling format)
- `OpenClawAdapter` — session-based; tools passed at session creation, `session.tool` events returned
- `HttpAdapter` — pass `tools` only if `config.supportsTools = true`

**Short-term unblock for Codex**: Since Codex is spawned as a subprocess and communicates via stdin/stdout, the `tools` array cannot be sent in the standard function-calling format. Instead, inject tools as a structured system message appended to the prompt: "You have the following Agentis platform tools available via JSON function calls: [...]". Add a JSON extraction post-processor on the Codex output that parses function call blocks from the response.

**Priority order**: HermesAdapter (widest usage) → CodexAdapter (shown in screenshot) → ClaudeCodeAdapter → HttpAdapter → OpenClawAdapter.

#### 4.1.4 Turn Context Enrichment

The `ChatTurnContext` already exists. What needs to change: ensure the viewport context is always sent with every turn and that the platform state snapshot (`#loadPromptContext`) includes recent build activity (what workflows were created in the last hour, what runs are currently live).

---

### 4.2 Layer 2 — The Execution Theater (Week 2)

These changes make the work visible.

#### 4.2.1 ThinkingBubble Component

**New file**: `apps/web/src/components/chat/ThinkingBubble.tsx`

```typescript
interface ThinkingBubbleProps {
  text: string;      // accumulated thinking text
  streaming: boolean; // true while thinking tokens are arriving
}
```

Rendered inside `MessageBubble` above the body text, below the author row. Uses a distinct visual style:
- Background: `bg-surface-2/60`
- Border: `border-l-2 border-accent/30`
- Font: `text-[11px] italic text-text-muted`
- Prefix glyph: `💭` or `⟳`
- When `streaming=true`: shows animated typing cursor
- When streaming ends: transitions to a collapsed `[View thinking ↓]` toggle

#### 4.2.2 ExecutionFeed Component

**New file**: `apps/web/src/components/chat/ExecutionFeed.tsx`

```typescript
interface ExecutionFeedProps {
  toolCalls: ToolCallPillData[];  // same type as today
  streaming: boolean;
}
```

Renders a bordered, collapsible panel that expands during streaming and collapses on completion.

Each row in the feed:
```
[status-icon]  [tool-name]  [spinner|duration]  [expand-chevron]
```

Status icons: `○` pending (gray), `●` running (animated accent), `✓` success (accent), `✕` error (danger).

On expand: renders the tool input args and output in a `<pre>` block with syntax highlighting (JSON formatter).

After all tools complete: the panel header changes to "N actions completed" and the body is collapsed. The user can re-expand it.

**Replace `ToolCallPill` usage** in both `ThreadView` files: instead of rendering each pill independently inline, collect all tool calls from a message into a single `ExecutionFeed` rendered below the thinking bubble and above the response text.

#### 4.2.3 PlanList Component

**New file**: `apps/web/src/components/chat/PlanList.tsx`

The orchestrator's system prompt instructs it to write plans as numbered Markdown lists. The plan list parser identifies numbered lists in assistant messages and renders them as interactive `PlanList` items.

```typescript
interface PlanListProps {
  items: Array<{
    label: string;
    status: 'pending' | 'running' | 'done' | 'failed';
  }>;
}
```

**The matching algorithm**: As tool calls complete, the plan list items are marked done based on a fuzzy match between the tool's description and the plan item text. This is a best-effort heuristic — if matching fails, all items complete at the end.

The plan list is detected by parsing the assistant message body for numbered list items (`\n1. ...`, `\n2. ...`) and extracting them as `PlanList` data. The raw numbered list text is hidden and replaced with the `PlanList` component.

#### 4.2.4 StickyProgressBanner

**New file**: `apps/web/src/components/chat/StickyProgressBanner.tsx`

Mounted inside `ThreadView` above the message list. Visible when a streaming message contains an active plan list and has >0 running tool calls.

State: derived from the latest streaming message's `toolCalls` and `planItems`. Counts done/total steps. Collapses when `streaming = false` with a brief "✓ Done" flash before hiding.

---

### 4.3 Layer 3 — Canvas Integration (Week 3)

These changes create the spatial connection between chat actions and the platform.

#### 4.3.1 Chat → Canvas Navigation

**Modified file**: `apps/web/src/components/chat/ThreadView.tsx`

Add a `CANVAS_BUILD_COMPLETE` event handler:

```typescript
useRealtime([REALTIME_EVENTS.CANVAS_BUILD_COMPLETE], (env) => {
  const payload = env.payload as { workflowId?: string; runId?: string; agentId?: string };
  if (payload.agentId !== id) return; // only for this agent's thread
  if (!payload.workflowId) return;

  // Surface an action button in the latest message
  setPendingCanvasNavigation({ workflowId: payload.workflowId, runId: payload.runId ?? null });
});
```

The `pendingCanvasNavigation` state renders a `[Open on canvas →]` button inside the latest completed message. Clicking it dispatches `agentis:open-canvas` which the Shell handles.

Additionally: if the operator's preferences allow auto-navigation (new setting: `settings.chatAutoNavigate: boolean`, default `true`), the Shell navigates automatically when `CANVAS_BUILD_COMPLETE` fires, while the chat panel remains open in its docked state.

#### 4.3.2 Build Progress Events from Tools

**Modified file**: `apps/api/src/tools/buildWorkflow.ts` (or whichever file implements `agentis.build_workflow`)

During graph construction, emit fine-grained `CANVAS_NODE_PLACED` events per node:

```typescript
for (const node of graph.nodes) {
  deps.bus.publish(
    REALTIME_ROOMS.agent(agentId),
    REALTIME_EVENTS.CANVAS_NODE_PLACED,
    { runId, workflowId: createdWorkflow.id, nodeId: node.id, kind: node.config.kind, agentId }
  );
  // Small delay to make the animation visible
  await new Promise(r => setTimeout(r, 80));
}
```

This gives the operator the visual experience of watching nodes appear on the canvas one by one as the agent builds the workflow.

#### 4.3.3 Floating Task Badge

**Modified file**: `apps/web/src/components/chat/ChatPanelStore.ts` (or `agentisStore.ts`)

Add `activeAgentTaskCount: number` to the store. The `ChatPanelHeaderButton` renders a pulsing badge when `activeAgentTaskCount > 0`.

When the user navigates away from the chat (panel collapsed or route change), if `activeAgentTaskCount > 0`, render a `FloatingTaskProgress` component in the bottom-right corner of the shell that shows the task name and progress.

---

### 4.4 Layer 4 — Skills Surfacing for Online Agents (Week 3)

This fixes the specific complaint: "the skills built in don't seem to be available to online agents."

#### 4.4.1 The Problem

When an agent is dispatched via `AdapterManager.dispatchTask()`, the task payload currently includes the agent's `playbook` (system prompt + persona) but does NOT include the skill catalog or tool definitions. The agent running inside a Codex subprocess has no awareness of what Agentis tools exist.

The `chat()` path does forward the tool catalog via `ChatSessionExecutor`. But the `dispatchTask()` path (used for workflow-triggered tasks) does not. An agent running a workflow node also needs tool awareness.

#### 4.4.2 The Fix

For `dispatchTask()` (workflow tasks): inject the relevant tools as a `toolManifest` field in the task payload. The adapter is responsible for formatting this for its LLM.

For `chat()` (interactive sessions): the current implementation is correct — `ChatSessionExecutor` passes `options.tools` to `adapter.chat()`. The gap is that not all adapters implement `chat()` yet (see §4.1.3).

**Connector**: `apps/api/src/adapters/AdapterManager.ts` — `dispatchTask()` receives the full `AgentisTask`. Inject a `toolManifest: AgentisToolDefinition[]` field derived from `ChatToolExecutor.registeredTools()` filtered by the agent's `capabilityTags`.

#### 4.4.3 Tool Availability Signal in the UI

Add a `[No tools available]` warning banner to the thread view when the connected agent's adapter type does not implement `chat()`. This makes the degraded state visible rather than silently failing.

```
┌─────────────────────────────────────────────────────┐
│  ⚠  This agent's adapter (Codex) is running in      │
│     relay mode — platform tools are not available.  │
│     [Configure adapter →]                           │
└─────────────────────────────────────────────────────┘
```

---

## 5. Implementation Plan — Phased Delivery

### Phase 0 — Emergency Unblock (3 days)

Goal: Make the agent ACT when it has tool support.

| Task | File | Effort |
|---|---|---|
| Overhaul `#buildSystemPrompt()` with action-first imperative | `chatSessionExecutor.ts` | S |
| Add `examples[]` to the top 5 most-called tools | `agentisToolRegistry.ts` / tool files | M |
| Implement `chat()` in `HermesAdapter` with tools forwarded | `adapters/hermes/HermesAdapter.ts` | M |
| Implement `chat()` in `CodexAdapter` via system-message injection | `adapters/codex/CodexAdapter.ts` | L |
| Render `metadata.thinking` in `MessageBubble` (collapsed) | `chat/ThreadView.tsx` | S |

**Success metric**: When a user asks "build me a Hello World workflow," the agent calls `agentis.build_workflow` and the workflow appears in the DB. No JSON blobs in the response.

---

### Phase 1 — Execution Theater (1 week)

Goal: Make the work visible.

| Task | File | Effort |
|---|---|---|
| `ThinkingBubble` component | `chat/ThinkingBubble.tsx` | S |
| `ExecutionFeed` component (replaces ToolCallPill) | `chat/ExecutionFeed.tsx` | M |
| Wire `ExecutionFeed` into `ThreadView` message rendering | `chat/ThreadView.tsx` | S |
| `PlanList` component + numbered list parser | `chat/PlanList.tsx` | M |
| `StickyProgressBanner` for long-running tasks | `chat/StickyProgressBanner.tsx` | M |
| Polish `ConfirmationCard` with countdown + consequence text | `chat/ThreadView.tsx` | S |

**Success metric**: Building a 5-node workflow shows 5 execution rows in the feed, a plan list that checks off in real time, and a sticky banner counting steps. Total render latency from tool call to UI row < 100ms.

---

### Phase 2 — Canvas Integration (1 week)

Goal: Make chat and canvas a single spatial experience.

| Task | File | Effort |
|---|---|---|
| Emit `CANVAS_NODE_PLACED` per node in `agentis.build_workflow` | tool handler | S |
| Handle `CANVAS_BUILD_COMPLETE` in `ThreadView` | `chat/ThreadView.tsx` | S |
| Add `[Open on canvas →]` action button in completed messages | `chat/ThreadView.tsx` | S |
| Auto-navigate to canvas when `CANVAS_BUILD_COMPLETE` fires | `Shell.tsx` or `App.tsx` | M |
| `FloatingTaskProgress` for background tasks | new shared component | M |
| Add `activeAgentTaskCount` to store | `agentisStore.ts` | S |
| Pulsing badge on `ChatPanelHeaderButton` | `chat/ChatPanel.tsx` | S |

**Success metric**: Asking the orchestrator to build a workflow results in the canvas opening automatically, showing nodes appearing one by one, with a live run overlay running.

---

### Phase 3 — Skills Surfacing (1 week)

Goal: All adapter types have tool support. No silent tool blackouts.

| Task | File | Effort |
|---|---|---|
| Implement `chat()` in `ClaudeCodeAdapter` | `adapters/claude/ClaudeCodeAdapter.ts` | L |
| Implement `chat()` in `HttpAdapter` with `supportsTools` flag | `adapters/http/HttpAdapter.ts` | M |
| Inject `toolManifest` into `dispatchTask()` payload | `AdapterManager.ts` | M |
| Add "No tools available" banner to `ThreadView` | `chat/ThreadView.tsx` | S |
| Add `examples[]` to ALL tools in the registry | `agentisToolRegistry.ts` | L |
| Tool availability audit page in Settings | `settings/SettingsPage.tsx` | M |

**Success metric**: Every adapter type can call platform tools. The settings page shows a tool availability matrix per agent adapter type.

---

### Phase 4 — Polish and 10x Moments (ongoing)

These are the details that separate "functional" from "remarkable."

| Task | Description |
|---|---|
| **Typewriter effect** on plan items transitioning to done | CSS animation: plan item text fades from muted to primary as it completes |
| **Sound design** (opt-in) | Subtle click on tool call start, completion tone on task done |
| **Message reactions** | Operator can 👍 a response to reinforce the behavior pattern |
| **Resumable tasks** | If the session reloads mid-task, the ExecutionFeed is restored from persisted `metadata.toolCalls` |
| **Copy as workflow** | On any execution feed, a `[Save as workflow →]` button that creates a permanent workflow from the ephemeral tool call sequence |
| **Task history** | The session history panel shows tasks with their execution feeds, not just message text |
| **Voice input** | Native speech-to-text on the composer (WebSpeech API) for hands-free operation |
| **Proactive narration** | When a background workflow completes, the orchestrator sends a proactive push with a summary card (already supported via `AGENT_PROACTIVE_PUSH`) |

---

## 6. Technical Decisions

### 6.1 Should the Plan List be Agent-Generated or UI-Fabricated?

**Decision: Agent-generated.** The plan is part of the assistant's first text delta, not constructed by the UI from tool call metadata. This means:
- The plan is accurate (the agent knows its intent).
- The plan can describe intent in plain language (not just tool names).
- The plan can include items that don't map 1:1 to tool calls (e.g. "verify the workflow is correct").

**Implementation**: The system prompt instructs the orchestrator to output plans as numbered lists. The `PlanList` component parses these from the message body. No additional protocol needed.

### 6.2 Should Thinking Text Be Persisted?

**Decision: Stored but collapsed.** Thinking tokens are accumulated in `metadata.thinking` and stored in the DB on message persistence. On the UI, they are shown collapsed behind `[View thinking ↓]`. This means:
- The session history shows full reasoning traces.
- The default view is clean (thinking text doesn't dominate the thread).
- Power users can inspect the reasoning.

### 6.3 Should Canvas Auto-Navigation Be Opt-In?

**Decision: Opt-in with smart default.** The default is `true` (auto-navigate). If the operator has a canvas already open with unsaved changes, the navigation is suppressed and a toast appears: "Workflow built — [Open on canvas →]".

### 6.4 How to Handle Parallel Tool Calls Without Visual Chaos?

When the agent calls 4 tools in parallel, they all appear in the ExecutionFeed simultaneously. **Decision**: render them as a group with a shared "batch header" showing `4 parallel actions`. Individual rows within the group collapse into a compact list until any one fails (which expands that row immediately).

### 6.5 What About Tool Call Rate Limiting in the UI?

Tool calls can arrive very fast (sub-50ms). **Decision**: use a debounced state flush — batch tool call updates at 16ms (one animation frame) to avoid React rendering overhead. The `ExecutionFeed` is optimized with `React.memo` and identity-stable props.

---

## 7. Success Metrics

### 7.1 Functional Gate (Phase 0 + 1)

These must pass before any Phase 1 work ships:

- [ ] Asking "build me a Hello World workflow" → workflow exists in DB within 5 seconds, no JSON in response.
- [ ] Asking "run the [workflow name]" → run starts, orchestrator confirms run ID.
- [ ] Asking "what workflows do I have?" → orchestrator calls `agentis.workflow.list` and returns a formatted list.
- [ ] Asking "approve the pending approval" → orchestrator calls `agentis.approval.resolve` after showing a confirmation card.
- [ ] Thinking text appears during tool call clusters.
- [ ] ExecutionFeed shows all tool calls with correct status.

### 7.2 UX Quality Gate (Phase 1 + 2)

- [ ] Plan list appears for multi-step (3+ tool call) tasks.
- [ ] Canvas navigates automatically to newly built workflows.
- [ ] `[Open on canvas →]` button appears after `CANVAS_BUILD_COMPLETE`.
- [ ] Nodes appear one by one on canvas during `agentis.build_workflow` execution.
- [ ] Sticky progress banner appears for tasks >10 seconds.
- [ ] Floating task badge appears when chat is closed during active task.

### 7.3 Coverage Gate (Phase 3)

- [ ] All 5 adapter types implement `chat()` with tool forwarding.
- [ ] All tools in the registry have at least 1 example.
- [ ] "No tools available" banner appears for relay-mode adapters.
- [ ] `dispatchTask()` injects `toolManifest` into workflow task payloads.

---

## 8. What This Changes About Agentis

This is not a chat feature update. This is the platform finally fulfilling its architecture.

**Before**: The operator writes a message. The agent explains what it would do. The operator does it manually.

**After**: The operator writes a message. The agent thinks briefly, writes a plan, executes it step-by-step with live progress, navigates the canvas to show the result, and says "Done."

The workflow builder, the agent fleet, the approval system, the knowledge base — all of these become **chat-native operations**. The operator never needs to leave the chat thread to accomplish platform goals.

This is what every great agentic product — Claude Code, Codex, Cursor — has understood: the chat is not where you describe work to a human-in-the-loop. The chat is where you delegate to an agent who does the work while you watch.

---

## 9. The True Differentiator — Conversation to Multi-Agent Workflow

The plan in sections 1–8 makes Agentis comparable to Claude Code. That's table stakes. This section describes what puts Agentis in a category of one.

### 9.1 The Core Insight

Claude Code, Codex, and Cursor are all **single-agent, ephemeral** tools. When the session ends, the work is gone. You can't re-run it. You can't schedule it. You can't hand it to a different team member.

Agentis is not a chatbot with tools. It is an **automation platform with a conversational interface**. Every task the orchestrator completes should leave behind a durable artifact — a workflow that can be re-triggered, scheduled, monitored, and improved over time.

The game-changer is not making the agent smarter. It is making the agent a **workflow architect** that delegates work to a team of cheap specialists and builds lasting systems instead of answering questions.

### 9.2 The Experience — Full Scenario

**User**: "Every Monday morning I want to pull our latest Stripe revenue, compare it to last week, write a 3-sentence brief, and post it to our #revenue Slack channel."

**What happens**:

```
Orchestrator (thinking):
  This is a recurring task. I'll build a scheduled workflow rather than
  doing this manually. It needs: a cron trigger, a Stripe fetch, a
  scratchpad to store last week's number for comparison, a brief-writing
  agent, and a Slack integration.

  Before I build, one question: should this use the revenue number from
  your existing Stripe credential "prod-stripe", or a different one?
```

```
┌─────────────────────────────────────────────────────┐
│  Quick question before I build:                     │
│                                                     │
│  Which Stripe credential should this use?           │
│  ○  prod-stripe (currently configured)              │
│  ○  Use a different one                             │
└─────────────────────────────────────────────────────┘
```

**User clicks**: `prod-stripe`

```
Orchestrator:
  Building your Monday Revenue Brief workflow now.

  Plan:
  ✓  1. Create workflow "Monday Revenue Brief"
  ◉  2. Add cron trigger (every Monday 08:00)
  ○  3. Add Stripe revenue fetch (integration node)
  ○  4. Add scratchpad for last-week comparison
  ○  5. Add Analysis Agent to write the brief
  ○  6. Add Slack post to #revenue
  ○  7. Connect edges and validate graph
  ○  8. Run a test execution to verify
```

*[Canvas opens. Nodes appear one by one. Each connection animates. The run starts and shows each node activating in the overlay.]*

```
Orchestrator:
  Done. Your "Monday Revenue Brief" workflow is live.
  First execution: Monday at 08:00.
  Test run: passed — Slack message sent to #revenue.

  [Open on canvas →]   [View test run →]   [Edit schedule →]
```

**This is the moment.** The user went from a natural language description to a running, scheduled, multi-step workflow with a real Slack integration, in one turn, with one clarifying question. No manual node placement. No JSON. No configuration screens.

### 9.3 Why This Cannot Be Replicated by Competitors

| Capability | Claude Code | Codex | Cursor | n8n/Zapier | **Agentis** |
|---|---|---|---|---|---|
| Multi-agent parallel execution | ✗ | ✗ | ✗ | partial | **✓** |
| Conversational workflow creation | ✗ | ✗ | ✗ | ✗ | **✓** |
| Persistent, re-runnable automation | ✗ | ✗ | ✗ | ✓ | **✓** |
| Live visual canvas during build | ✗ | ✗ | ✗ | ✗ | **✓** |
| Scheduled execution | ✗ | ✗ | ✗ | ✓ | **✓** |
| Built-in human approval gates | ✗ | ✗ | ✗ | limited | **✓** |
| Cost-optimized agent routing | ✗ | ✗ | ✗ | ✗ | **✓** |
| Self-modifying live workflows | ✗ | ✗ | ✗ | ✗ | **✓** |

### 9.4 The Infrastructure That Already Exists

Every technical piece required for this feature is already in the codebase:

| Need | Existing implementation |
|---|---|
| Generate a graph from a prompt | `POST /v1/workflows/draft-from-prompt` → `{title, graph}` |
| Create a workflow | `POST /v1/workflows/` |
| Start a run | `POST /v1/workflows/:id/run` |
| Parallel multi-agent execution | `agent_swarm` node type in `WorkflowEngine` |
| Live graph modification mid-run | `WorkflowEngine.applyGraphPatch()` (L383) |
| Node-by-node canvas animation | `CANVAS_NODE_PLACED` + `AgentFocusOverlayManager` |
| Sub-agent progress on canvas | `NODE_STARTED` / `NODE_COMPLETED` events |
| Scheduled triggers | `cron` trigger type + `schedule_runs` table |
| Integration nodes | `ConnectorRegistry` with Slack, Gmail, GitHub, Google Sheets, HTTP |

### 9.5 What Needs to Be Built

**One new tool**: `agentis.build_and_deploy_workflow`

```typescript
// Tool definition
{
  id: 'agentis.build_and_deploy_workflow',
  description: `
    Build and optionally run a multi-node workflow from a natural language description.
    Use this when the user's request requires 3+ steps, involves recurring automation,
    or benefits from parallel agent execution.
    
    Prefer this over calling individual tools sequentially when:
    - The task involves a trigger condition (schedule, webhook, event)
    - Multiple agents or integrations need to coordinate
    - The result should be reusable
    - The task has well-defined inputs and outputs
    
    Do NOT use this for simple one-off queries. Use direct tool calls for those.
  `,
  inputSchema: z.object({
    prompt: z.string().describe('Natural language description of what the workflow should do'),
    runImmediately: z.boolean().default(true).describe('Run a test execution after building'),
    title: z.string().optional().describe('Workflow title — inferred from prompt if omitted'),
    context: z.record(z.unknown()).optional().describe('Any resolved clarifications or user preferences'),
  }),
}
```

**Implementation** (`apps/api/src/tools/buildAndDeployWorkflow.ts`):
1. Call `POST /v1/workflows/draft-from-prompt` with the `prompt` + `context` to get `{title, graph}`.
2. Enhance the graph using the full node compendium (§11) to add integrations, scratchpad, router nodes as appropriate.
3. Call `POST /v1/workflows/` to create the workflow.
4. Emit `CANVAS_NODE_PLACED` for each node with 80ms delay between emissions.
5. Emit `CANVAS_BUILD_COMPLETE` with `{workflowId, agentId}`.
6. If `runImmediately`, call `POST /v1/workflows/:id/run` and return `{workflowId, runId}`.

**System prompt change**: Add after the current action-first rules:
```
WORKFLOW BUILDING RULE:
When a user's request involves 3+ coordinated steps, recurring execution, or multiple
integrations, call agentis.build_and_deploy_workflow instead of executing steps manually.
The workflow will run immediately and be saved for future use.
Think about the FULL architecture needed: which trigger type, which node kinds, which
integrations, whether parallel execution (agent_swarm) is cheaper than sequential.
```

---

## 10. The Cost Intelligence Model

### 10.1 The Problem with Single-Agent Everything

When the orchestrator handles a complex task serially — reading, reasoning, writing, posting — it burns a frontier model token budget on every step. A sequence of 8 tool calls in a single chat session at Claude 3.5 Sonnet pricing costs roughly $0.10–0.40 per execution. If this task runs 50 times a month, that's $5–20/month **per user per automation**.

The Agentis model can cut this by 70–90%: build a workflow where most nodes are **zero-LLM** (integration nodes, scratchpad ops, skill_task with a deterministic script) and only the nodes that genuinely need reasoning use an LLM — and even then, a small model.

### 10.2 The Cost Spectrum of Node Types

| Node type | LLM cost | When to use |
|---|---|---|
| `integration` (Slack, HTTP, Gmail, GitHub) | **$0** | Any external service call |
| `scratchpad` (read/write/append/delete) | **$0** | Storing state between steps |
| `skill_task` (deterministic script) | **$0** | Transform, format, compute |
| `knowledge` (vector search) | **$0** | Retrieve context without reasoning |
| `router` (rule-based) | **$0** | Branch on conditions |
| `merge` | **$0** | Fan-in from parallel branches |
| `checkpoint` | **$0** | Human approval gate |
| `artifact_collect` | **$0** | Gather swarm outputs |
| `trigger` | **$0** | Entry point (cron/webhook/manual) |
| `agent_task` (small model, e.g. GPT-4o-mini) | **~$0.001/call** | Summarize, classify, format |
| `agent_task` (mid model, e.g. GPT-4o) | **~$0.005/call** | Reason, plan, generate |
| `agent_task` (frontier, e.g. Claude 3.5) | **~$0.015/call** | Complex reasoning, code |
| `agent_swarm` | sum of member costs | Parallel specialists |

### 10.3 The Workflow Cost vs. Chat Session Cost

**Chat session** (orchestrator does everything in a single agentic loop):
- 8 tool calls × frontier model reasoning between each = ~$0.35/execution

**Equivalent workflow** (orchestrator delegates to cheap specialists):
```
Trigger (cron)          $0.000
Integration (Stripe)    $0.000
Scratchpad (store)      $0.000
agent_task (GPT-4o-mini, summarize)  $0.001
Integration (Slack)     $0.000
─────────────────────────────────────
Total:                  $0.001/execution  (350× cheaper)
```

The orchestrator's job in workflow design is to **maximize the proportion of zero-cost nodes** and use the smallest capable model for each reasoning step.

### 10.4 Budget-Aware Workflow Composition Directive

Add to the orchestrator's system prompt and to all adapter architecture specialist modules:

```
COST OPTIMIZATION RULES FOR WORKFLOW DESIGN:
1. Never use an agent_task node for something a skill_task or integration can do.
2. Never use a frontier model for something a smaller model handles well.
3. Use scratchpad nodes to pass data between steps instead of repeating context in each agent prompt.
4. Use integration nodes for all external service calls — no agent should make raw HTTP calls.
5. Use knowledge nodes for retrieval — never ask an agent to "remember" facts it could look up.
6. When in doubt: fewer LLM nodes = faster, cheaper, more reliable.
```

---

## 11. The Agentis Node Compendium — Deep Architecture Knowledge for All Agents

Every adapter type — Hermes, Codex, ClaudeCode, OpenClaw, HTTP — must have this knowledge embedded in its system prompt or injected as structured context. An agent that doesn't know the node catalog will either avoid building workflows (current failure) or build broken ones (future failure).

### 11.1 Node Type Reference — Complete Catalog

#### `trigger`
**Purpose**: Entry point for every workflow. Every workflow MUST have exactly one trigger node.
```json
{
  "id": "node-1",
  "kind": "trigger",
  "title": "Manual start",
  "position": { "x": 0, "y": 0 },
  "config": {
    "kind": "trigger",
    "triggerType": "manual"
  }
}
```
`triggerType` options:
- `"manual"` — started by API call or UI button. Use for on-demand workflows.
- `"cron"` — scheduled. Add `"cron": "0 8 * * 1"` (Monday 8am) to config.
- `"webhook"` — HTTP POST to `/v1/webhooks/trigger/:triggerId`. Use for event-driven.
- `"listener"` — fires on a realtime platform event (e.g. run completion, approval resolved).

**Common mistake**: Creating a workflow without a trigger. The engine will not start.

---

#### `agent_task`
**Purpose**: Run a single LLM-powered agent against a task. The workhouse node for reasoning, generation, and decision-making.
```json
{
  "id": "node-2",
  "kind": "agent_task",
  "title": "Write brief",
  "position": { "x": 200, "y": 0 },
  "config": {
    "kind": "agent_task",
    "agentId": "{{agentId}}",
    "task": "Summarize the following revenue data into a 3-sentence brief: {{trigger.output.data}}",
    "timeout": 30000
  }
}
```
- `agentId`: must be a real agent UUID from the workspace. Use `agentis.agent.list` to look up IDs.
- `task`: the instruction string. Use `{{nodeId.output.fieldName}}` to reference prior node outputs.
- `timeout`: milliseconds before the node is marked failed. Default 60000.
- `mcpServerIds`: optional array of MCP server IDs to give the agent additional tool access.

**Cost guidance**: Use the cheapest agent that can do the job. Summarization → small model. Complex reasoning → larger model.

---

#### `agent_swarm`
**Purpose**: Dispatch multiple agents in parallel and collect their outputs. Use when sub-tasks are independent and parallelism saves time.
```json
{
  "id": "node-3",
  "kind": "agent_swarm",
  "title": "Research team",
  "position": { "x": 200, "y": 0 },
  "config": {
    "kind": "agent_swarm",
    "agents": [
      { "agentId": "{{researchAgentId}}", "task": "Find pricing data for competitor A" },
      { "agentId": "{{researchAgentId}}", "task": "Find pricing data for competitor B" },
      { "agentId": "{{researchAgentId}}", "task": "Find pricing data for competitor C" }
    ]
  }
}
```
**Always follow `agent_swarm` with `artifact_collect`** to gather all agent outputs into a single data structure.

---

#### `artifact_collect`
**Purpose**: Gather outputs from an `agent_swarm` into a single array for downstream processing.
```json
{
  "id": "node-4",
  "kind": "artifact_collect",
  "title": "Collect research",
  "position": { "x": 400, "y": 0 },
  "config": {
    "kind": "artifact_collect",
    "sourceNodeId": "node-3"
  }
}
```
Output: `{ results: [ { agentId, output, status }, ... ] }`

---

#### `skill_task`
**Purpose**: Run a deterministic, pre-defined skill script. Zero LLM cost. Use for transforms, format conversions, calculations, and data cleaning.
```json
{
  "id": "node-5",
  "kind": "skill_task",
  "title": "Format as JSON",
  "position": { "x": 600, "y": 0 },
  "config": {
    "kind": "skill_task",
    "skillSlug": "json-formatter",
    "inputs": {
      "data": "{{node-4.output.results}}"
    }
  }
}
```
Use `agentis.skill.list` to see available skills. Skills are far cheaper than agent_task for deterministic operations.

---

#### `integration`
**Purpose**: Call an external service without any LLM. Use for Slack, Gmail, GitHub, Google Sheets, HTTP requests, webhook sends.
```json
{
  "id": "node-6",
  "kind": "integration",
  "title": "Post to Slack",
  "position": { "x": 800, "y": 0 },
  "config": {
    "kind": "integration",
    "connectorId": "slack",
    "operation": "send_message",
    "credentialId": "{{credentialId}}",
    "inputs": {
      "channel": "#revenue",
      "text": "{{node-2.output.brief}}"
    }
  }
}
```
Available connectors: `slack`, `gmail`, `github`, `google_sheets`, `http_request`, `webhook_send`.
Use `agentis.credential.list` to get `credentialId` values.

---

#### `knowledge`
**Purpose**: Search the workspace knowledge base without involving an LLM in retrieval. Returns ranked chunks relevant to a query.
```json
{
  "id": "node-7",
  "kind": "knowledge",
  "title": "Find relevant context",
  "position": { "x": 200, "y": 0 },
  "config": {
    "kind": "knowledge",
    "mode": "contextual",
    "kbIds": ["{{kbId}}"],
    "query": "{{trigger.output.userQuestion}}"
  }
}
```
`mode` options:
- `"contextual"` — returns semantically relevant chunks. Best for general Q&A.
- `"strict"` — exact keyword match. Best for IDs, names, codes.
- `"exploratory"` — broad search, more results. Best for open-ended research.

---

#### `scratchpad`
**Purpose**: Read and write transient data across workflow steps. Acts as the workflow's working memory. Zero cost.
```json
{
  "id": "node-8",
  "kind": "scratchpad",
  "title": "Store last week revenue",
  "position": { "x": 400, "y": 0 },
  "config": {
    "kind": "scratchpad",
    "op": "write",
    "key": "last_week_revenue",
    "value": "{{node-2.output.totalRevenue}}"
  }
}
```
`op` options: `"read"` (returns `{value}`), `"write"`, `"append"` (array push), `"delete"`.

**Pattern**: On first run, read returns `null` — design agents to handle this gracefully.

---

#### `router`
**Purpose**: Branch the workflow based on conditions. Like an `if/else` or `switch` statement.
```json
{
  "id": "node-9",
  "kind": "router",
  "title": "Check revenue change",
  "position": { "x": 600, "y": 0 },
  "config": {
    "kind": "router",
    "mode": "first_match",
    "routes": [
      {
        "condition": "{{node-3.output.percentChange}} > 10",
        "label": "Strong growth",
        "nextNodeId": "node-up"
      },
      {
        "condition": "{{node-3.output.percentChange}} < -10",
        "label": "Significant decline",
        "nextNodeId": "node-down"
      },
      {
        "condition": "true",
        "label": "Stable",
        "nextNodeId": "node-stable"
      }
    ]
  }
}
```
`mode` options: `"first_match"` (stops at first true route), `"all_matching"` (fires all matching routes in parallel).

---

#### `merge`
**Purpose**: Fan-in — wait for all parallel branches to complete before continuing. Use after router with `all_matching` or after `agent_swarm` branches.
```json
{
  "id": "node-10",
  "kind": "merge",
  "title": "Merge branches",
  "position": { "x": 800, "y": 0 },
  "config": { "kind": "merge" }
}
```
Connect edges from all parallel nodes to the merge node. The merge node outputs the union of all inputs.

---

#### `checkpoint`
**Purpose**: Pause the workflow and wait for explicit human approval before continuing.
```json
{
  "id": "node-11",
  "kind": "checkpoint",
  "title": "Approve before sending",
  "position": { "x": 600, "y": 0 },
  "config": {
    "kind": "checkpoint",
    "type": "manual",
    "title": "Review email before sending",
    "description": "Please review the draft before it is sent to customers."
  }
}
```
`type` options:
- `"manual"` — waits indefinitely until approved via API or UI.
- `"auto_after_timeout"` — auto-approves after `timeoutMs` if no human action.

**Rule**: Always use `checkpoint` before integration nodes that send emails, SMS, or webhook notifications. Any workflow that touches external parties MUST have a checkpoint.

---

#### `subflow`
**Purpose**: Embed another workflow as a node. Use to compose reusable sub-workflows.
```json
{
  "id": "node-12",
  "kind": "subflow",
  "title": "Run email formatter",
  "position": { "x": 400, "y": 0 },
  "config": {
    "kind": "subflow",
    "workflowId": "{{formatterWorkflowId}}",
    "inputs": { "rawText": "{{node-1.output.text}}" }
  }
}
```

---

#### `context_compress`
**Purpose**: Reduce the size of data flowing through the workflow to stay within LLM context limits and reduce cost.
```json
{
  "id": "node-13",
  "kind": "context_compress",
  "title": "Compress research",
  "position": { "x": 600, "y": 0 },
  "config": {
    "kind": "context_compress",
    "strategy": "extractive",
    "maxChars": 4000,
    "sourceNodeId": "node-4"
  }
}
```
`strategy` options:
- `"key_filter"` — keep only specified keys from the object.
- `"extractive"` — take first N chars or a sliding window.
- `"llm_summary"` — use an LLM to summarize (adds cost; use only when extractive is insufficient).

---

### 11.2 Graph Composition Patterns

**Pattern A — Linear pipeline** (most common):
```
Trigger → [step 1] → [step 2] → [step 3] → Integration
```
Use for: simple data fetch → transform → post workflows.

**Pattern B — Parallel research then synthesize**:
```
Trigger → agent_swarm → artifact_collect → context_compress → agent_task (synthesize) → Integration
```
Use for: competitor analysis, multi-source data aggregation, research briefs.

**Pattern C — Conditional routing**:
```
Trigger → [assess] → router → [branch A]
                            → [branch B] → merge → [final action]
                            → [branch C]
```
Use for: alert systems, escalation paths, A/B decision workflows.

**Pattern D — Human-in-the-loop**:
```
Trigger → [draft content] → checkpoint → [approved? → send] / [rejected? → revise]
```
Use for: anything that touches customers, sends emails, or makes external API calls with consequences.

**Pattern E — Recurring with memory**:
```
Trigger (cron) → scratchpad.read(last_value) → Integration.fetch(new_value) →
agent_task(compare) → scratchpad.write(new_value) → Integration.post(result)
```
Use for: weekly digests, monitoring, delta reporting.

**Pattern F — Self-expanding (advanced)**:
```
Trigger → agent_task (planner) → [planner calls applyGraphPatch to add nodes] →
[dynamically added nodes execute] → artifact_collect → agent_task (synthesize)
```
Use for: tasks where the exact sub-steps are unknown until the planner reasons about the request. The planner agent calls `agentis.workflow.patch` to add nodes to the running workflow.

---

### 11.3 Common Graph Mistakes and How to Avoid Them

| Mistake | Symptom | Fix |
|---|---|---|
| No trigger node | Workflow cannot start | Always add trigger as node-1 |
| `agent_swarm` without `artifact_collect` | Parallel outputs lost | Always follow swarm with collect |
| `router` without a catch-all route | Workflow hangs on unmatched condition | Add `"condition": "true"` as last route |
| `merge` with only one input edge | Unnecessary overhead | Only add merge when 2+ parallel branches converge |
| Agent task with entire context in prompt | High cost + slow | Use `context_compress` before expensive agent_task nodes |
| Sending external messages without `checkpoint` | Accidental sends | Always add checkpoint before email/webhook/SMS nodes |
| Using `agent_task` for data format conversions | Wasteful LLM cost | Use `skill_task` or `integration` instead |
| Hardcoding agentId UUIDs | Breaks on other workspaces | Always look up agentId via `agentis.agent.list` before building |

---

### 11.4 The Architecture Specialist System Prompt Module

This block is injected into every adapter's system context whenever `agentis.build_and_deploy_workflow` is available. It replaces the generic tool description.

```
AGENTIS WORKFLOW ARCHITECTURE SPECIALIST

You are an expert in Agentis workflow architecture. When building workflows, you must:

NODE SELECTION RULES:
- Every workflow starts with exactly one `trigger` node.
- Use `integration` nodes for ALL external service calls (Slack, Gmail, HTTP, GitHub, Google Sheets, webhooks). Never use `agent_task` for an operation an integration node can handle.
- Use `scratchpad` nodes to pass state between run executions (e.g., storing last week's value for comparison).
- Use `knowledge` nodes for retrieval. Never ask an agent to recall facts it could retrieve.
- Use `skill_task` for deterministic transformations (formatting, calculation, parsing).
- Use `context_compress` before any `agent_task` that receives large inputs.
- Use `checkpoint` before any node that sends external communications (email, webhook, SMS).
- Use `agent_swarm` + `artifact_collect` when sub-tasks are independent and parallelism is beneficial.
- Use `router` to branch on conditions. Always include a catch-all final route.
- Use `merge` to rejoin parallel branches.

TRIGGER SELECTION:
- User asked for "every [time period]" or "scheduled" → triggerType: "cron"
- User asked for "when X happens" or "on event" → triggerType: "webhook" or "listener"
- User asked for "run it now" or "on demand" → triggerType: "manual"

COST RULES:
- Minimize `agent_task` nodes. Every LLM call costs money.
- Use the smallest model sufficient for each reasoning task.
- Prefer a workflow with 2 agent_task nodes over 6, by using integrations and skills for the rest.

GRAPH VALIDATION:
- All nodes must be connected (no orphaned nodes).
- All `agent_swarm` nodes must be followed by `artifact_collect`.
- All `router` nodes must have a catch-all route.
- All edge sourceHandle and targetHandle values must reference real node IDs.

OUTPUT FORMAT:
When calling agentis.build_and_deploy_workflow, pass a `context` object with:
- Resolved agent IDs (from agentis.agent.list)
- Resolved credential IDs (from agentis.credential.list)
- Any user-provided clarifications
```

---

## 12. Workflow Complexity Graduation — Sizing the Response to the Task

The orchestrator must choose the right response size. Not every request needs a workflow. Not every workflow needs 10 nodes. Mis-sizing wastes the user's time and costs money.

### 12.1 The Decision Tree

```
User request
│
├─ Can be answered with factual knowledge, no action needed?
│   → Respond directly. No tool calls.
│
├─ Requires 1-2 tool calls, one-time, no recurrence?
│   → Execute directly via tool calls. No workflow.
│
├─ Requires 3-5 steps, one-time, but could be reused?
│   → Build a micro workflow. Run immediately.
│
├─ Requires 3+ steps AND involves a trigger condition (schedule, event)?
│   → Build a small-to-medium workflow.
│
├─ Requires parallel execution, multiple agents, or 6+ nodes?
│   → Build a medium workflow. Show plan first. Ask 1 clarifying question if ambiguous.
│
└─ Involves 10+ nodes, multiple teams, external approvals, SLAs?
    → Ask 2 clarifying questions. Build a large workflow. Confirm before running.
```

### 12.2 Micro Workflow (1–2 task nodes)

**When**: "Run a quick search and email me the results" — one-time, simple, user wants the result NOW.

```
Trigger (manual) → knowledge.search → integration (gmail.send)
```

Build time: < 2 seconds. Run immediately. No clarifying questions.

### 12.3 Small Workflow (3–5 nodes)

**When**: "Every Friday, pull our GitHub PR count for the week and post it to Slack."

```
Trigger (cron: Fridays) → integration (github.list_prs) →
skill_task (count + format) → integration (slack.send)
```

Build time: < 5 seconds. One clarifying question at most: "Which GitHub repo and Slack channel?"

### 12.4 Medium Workflow (6–10 nodes)

**When**: "Monitor our Stripe revenue daily, compare to last week, and alert us on Slack if it drops more than 20%."

```
Trigger (cron: daily) → integration (stripe.revenue) →
scratchpad.read(last_week) → skill_task (compute_delta) →
router (delta < -20%?) → checkpoint → integration (slack.alert)
                       → scratchpad.write(this_week) [always]
```

Build time: 5–10 seconds. Ask at most 2 clarifying questions. Show the plan before building.

### 12.5 Large Workflow (11+ nodes)

**When**: "Build an automated lead enrichment pipeline that pulls new leads from HubSpot, researches each company, scores them, and routes to the right sales rep based on company size."

```
Trigger (webhook: HubSpot) → scratchpad.read(processed_leads) →
router (already processed?) → stop
                            → agent_swarm (research: web, linkedin, crunchbase) →
                              artifact_collect → agent_task (score + categorize) →
                              router (company size) → [SMB → rep A]
                                                    → [Mid-market → rep B]
                                                    → [Enterprise → checkpoint → rep C]
                              scratchpad.write(processed_leads)
```

Build time: 10–20 seconds. Ask up to 3 clarifying questions. Show detailed plan. Confirm before running (it has a webhook and external routing).

---

## 13. The Clarification Protocol — Asking Without Being Annoying

### 13.1 The Anti-Pattern

The worst version of this feature asks 5 questions before doing anything. Users came to get work done, not to fill out a form. The clarification protocol must be surgical: ask exactly what's needed to avoid building the wrong thing, and nothing more.

### 13.2 When to Ask vs. When to Build

**Never ask when**:
- The request is specific enough to build (even if imperfect — build it, they can edit it).
- The task is small (< 3 nodes) — just build it, cost of being wrong is low.
- The same information can be looked up via a tool call (`agentis.agent.list`, `agentis.credential.list`).
- The question is cosmetic (workflow name, Slack channel name) — use a sensible default and note it.

**Ask one question when**:
- The request is ambiguous between two meaningfully different architectures (cron vs webhook, one agent vs swarm).
- A credential or external resource must be explicitly chosen (which Stripe account, which GitHub repo).
- A destructive or external-communication workflow is being built and the user hasn't confirmed scope.

**Ask two questions when**:
- The workflow is large (11+ nodes) and two key architectural decisions are genuinely ambiguous.
- The task involves approvals or routing and the routing rules aren't clear.

**Never ask more than 2 questions in a single turn.** If you have more unknowns, make reasonable defaults for the rest and note them in the response.

### 13.3 Question Design

Good clarification questions are:
- **Binary or multiple-choice** — not open-ended essays
- **Consequential** — only ask if the answer changes the architecture materially
- **Pre-answered with a sensible default** — show what you'd assume if they don't answer

```
┌─────────────────────────────────────────────────────┐
│  One quick thing before I build:                    │
│                                                     │
│  Should this run automatically on a schedule,       │
│  or only when you manually trigger it?              │
│                                                     │
│  ○  Schedule it (every Monday morning)              │
│  ○  Manual — I'll run it when I need it             │
│                                                     │
│  (If you skip this, I'll default to manual.)        │
└─────────────────────────────────────────────────────┘
```

Bad clarification question: "Can you describe in detail all the requirements for this workflow including edge cases, error handling, and any specific data format requirements you might have?"

Good clarification question: "Should failed leads be retried automatically, or flagged for manual review?"

### 13.4 The Clarification Turn Format

The orchestrator signals clarification by emitting a special delta type before the tool call:

```typescript
// New ChatDelta type
{ type: 'clarification_request', questions: ClarificationQuestion[] }

interface ClarificationQuestion {
  id: string;
  text: string;
  options?: Array<{ label: string; value: string }>;
  default?: string;
}
```

The UI renders this as an inline card in the message bubble (not a modal). The user clicks an option or types a free-form answer. The answer is injected into the next turn as a `clarification_response` prefix.

If the user ignores the card and just sends their next message, the orchestrator treats that as "proceed with defaults."

### 13.5 The Clarification System Prompt Directive

```
CLARIFICATION RULES:
1. Ask at most 2 questions per turn, only if the answer changes the architecture.
2. Never ask for information you can look up (agent IDs, credential IDs, workflow lists).
3. Always show your default assumption — the user can override or accept it silently.
4. Format questions as binary or multiple-choice, not open-ended.
5. If the user doesn't answer the clarification card and sends a new message, proceed with defaults.
6. If the task is under 3 nodes, NEVER ask — build it and offer to adjust.
7. A clarification question is ONLY worth asking if getting it wrong would require completely rebuilding the workflow from scratch.
```

---

## Appendix A — File Change Index

| File | Change |
|---|---|
| `apps/api/src/services/chatSessionExecutor.ts` | System prompt overhaul, turn context enrichment |
| `apps/api/src/adapters/hermes/HermesAdapter.ts` | Implement `chat()` with tools forwarding |
| `apps/api/src/adapters/codex/CodexAdapter.ts` | Implement `chat()` via system-message injection |
| `apps/api/src/adapters/claude/ClaudeCodeAdapter.ts` | Implement `chat()` via Anthropic tool use protocol |
| `apps/api/src/adapters/http/HttpAdapter.ts` | Implement `chat()` with `supportsTools` flag |
| `apps/api/src/adapters/AdapterManager.ts` | Inject `toolManifest` in `dispatchTask()` |
| `apps/api/src/services/agentisToolRegistry.ts` | Add `examples[]` field to all tool definitions |
| `apps/api/src/tools/buildWorkflow.ts` | Emit `CANVAS_NODE_PLACED` per node with delay |
| `packages/core/src/types/chat.ts` | Add `examples[]` to `AgentisToolDefinition` |
| `packages/core/src/events.ts` | No change (events already exist) |
| `apps/web/src/components/chat/ThreadView.tsx` | Wire ThinkingBubble, ExecutionFeed, PlanList, StickyProgressBanner, CANVAS_BUILD_COMPLETE handler |
| `apps/web/src/components/chat/ThinkingBubble.tsx` | New file |
| `apps/web/src/components/chat/ExecutionFeed.tsx` | New file (replaces ToolCallPill inline usage) |
| `apps/web/src/components/chat/PlanList.tsx` | New file |
| `apps/web/src/components/chat/StickyProgressBanner.tsx` | New file |
| `apps/web/src/components/chat/FloatingTaskProgress.tsx` | New file |
| `apps/web/src/store/agentisStore.ts` | Add `activeAgentTaskCount` |
| `apps/web/src/App.tsx` or `Shell.tsx` | Handle `agentis:open-canvas` event for auto-navigation |
| `apps/web/src/settings/SettingsPage.tsx` | Tool availability matrix per adapter type |
| `apps/api/src/tools/buildAndDeployWorkflow.ts` | New tool: `agentis.build_and_deploy_workflow` (§9.5) |
| `apps/api/src/services/workflowArchitect.ts` | New service: enhances `draft-from-prompt` graph with full node catalog knowledge |
| `packages/core/src/types/chat.ts` | Add `clarification_request` delta type + `ClarificationQuestion` interface (§13.4) |
| `apps/web/src/components/chat/ClarificationCard.tsx` | New file: renders inline clarification question card (§13.4) |
| `apps/web/src/components/chat/ThreadView.tsx` | Wire `ClarificationCard` for `clarification_request` deltas |
| `apps/api/src/prompts/architectureSpecialist.ts` | New file: the node compendium system prompt module (§11.4) injected into all adapters |
| `apps/api/src/prompts/costOptimization.ts` | New file: cost rules prompt module (§10.4) |
| `apps/api/src/adapters/hermes/HermesAdapter.ts` | Inject architecture specialist module into system context |
| `apps/api/src/adapters/codex/CodexAdapter.ts` | Inject architecture specialist module via system message |
| `apps/api/src/adapters/claude/ClaudeCodeAdapter.ts` | Inject architecture specialist module into invocation payload |
| `apps/api/src/adapters/http/HttpAdapter.ts` | Inject architecture specialist module when `supportsTools=true` |
| `apps/api/src/adapters/openclaw/OpenClawAdapter.ts` | Inject architecture specialist module at session creation |

---

## Appendix B — The Single Most Important Change

If nothing else from this document ships, ship this:

> **Change the system prompt so the orchestrator knows its job is to act, not to explain. Then give it deep knowledge of the Agentis node catalog so it can build the right workflow for the task.**

The system prompt is the foundation. But a system prompt that says "act now" paired with a model that doesn't know the difference between `agent_task` and `integration` will build expensive, brittle workflows. The two changes must ship together:

1. **Action-first system prompt** (§4.1.1) — the orchestrator stops explaining and starts building.
2. **Architecture specialist module** (§11.4) — the orchestrator knows every node type, when to use it, and how to minimize cost.

Everything else — the UI theater, the canvas integration, the clarification cards — makes the experience beautiful. But these two changes make it **correct**. A plain text response that says "I built your workflow" with a link is better than a stunning ExecutionFeed that the agent never populates because it doesn't know which nodes to use.

> Ship the system prompt. Ship the node compendium. Then make it look great.

---

## Implementation Log

> Live build log. Most recent entry at the bottom. Maintained by Claude during implementation so the operator can follow progress in near real time. This log also records where the spec's assumptions diverged from the actual codebase and why a different path was taken.

### Architecture reconciliation (before writing any code)

I read the whole codebase against the spec. The spec's file map is partially out of date. Key corrections:

- **Tools do not live in `apps/api/src/tools/`** — that directory does not exist. Platform tools are registered in `apps/api/src/services/agentisToolHandlers/*.ts` (`build.ts`, `run.ts`, `agent.ts`, `inspect.ts`, `environment.ts`, `ephemeral.ts`) into a transport-agnostic `AgentisToolRegistry`. The **LLM-facing catalog** (what the model sees) is a *separate* hand-written list in `apps/api/src/services/chatToolCatalog.ts`. So "add examples to tools" means editing the catalog descriptions, not the handlers.
- **The system prompt is not in `chatSessionExecutor.ts`** — it is `apps/api/src/services/orchestratorPrompt.ts` (`buildOrchestratorSystemPrompt`). The current prompt is advisory ("ask before building", "never modify without confirmation"), which is the root cause of the agent describing instead of doing.
- **`agentis.build_workflow` already works end-to-end.** The handler in `build.ts` synthesizes a graph (LLM when an evaluator runtime is configured, regex fallback otherwise), persists the workflow, and emits `CANVAS_NODE_PLACED` / `CANVAS_EDGE_CONNECTED` / `CANVAS_BUILD_COMPLETE` with deliberate delays for the node-by-node animation. The infrastructure the spec asks for in §4.3.2 is already built. The agent just never calls the tool.
- **HermesAdapter already implements `chat()` correctly** with `tools` forwarded as OpenAI function-calling, streaming tool-call fragment assembly, and `reasoning_content` → `thinking` deltas. HTTP/LocalLlm share this path. So tool-calling already works for any OpenAI-compatible runtime. **CodexAdapter.chat() is the broken one** — it spawns the Codex CLI and dumps the tool list as JSON text, which the CLI can't action. That is exactly the screenshot failure.
- **Confirmation gating is too broad.** `ChatToolExecutor.requiresConfirmation()` returns true for *any* `mutating` tool, so even building a workflow pops a confirmation card. The 10x vision wants building to be instant. Fix: add an explicit `autoExecute` opt-out so reversible create/build actions run immediately while run/cancel/approval/external-send still confirm. (Chosen over an allowlist rewrite so the existing generic-mutating-tool confirmation test keeps passing.)
- **The active chat surface is `apps/web/src/components/chat/ThreadView.tsx`** (the docked panel in the screenshot). It already consumes `thinking`/`tool_call`/`tool_result`/`confirmation_required` deltas, but renders thinking as a flat block, tool calls as ungrouped pills, and has **no** handler for the `CANVAS_*` build events. There is a second legacy `ChatPanel/ThreadView.tsx`; the `chat/` one is the live path.

Plan of attack (highest leverage first, per Appendix B): make the agent *act* (prompt + instant build + node knowledge), then make the work *visible* (execution theater), then make it *spatial* (canvas integration).

### Fix 1 — The CLI tool-call leak (root cause of "nothing happened" + PID spam)

**Symptom (from screenshots):** asking codexy to build a workflow returned the literal text `AGENTIS_TOOL_CALL {"name":"agentis.build_workflow",...}}ÊXITO: o processo com PID 12388 … foi finalizado.` and the platform did nothing.

**Diagnosis:** the Codex/Claude CLI marker protocol had two compounding bugs:
1. The `chat()` stdout `catch` branch did `transcript += line` for *every* non-JSON line. The Codex sandbox tears down its child process tree with Windows `taskkill`, whose output (`ÊXITO: … PID … foi finalizado`, Portuguese locale) is printed as raw stdout. So that spam got concatenated directly onto the assistant transcript — right after the marker, with no newline.
2. The marker parser used a line-anchored regex `^AGENTIS_TOOL_CALL\s+({.*})\s*$`. With taskkill text glued onto the marker line, the `\s*$` anchor no longer matched, so the tool call was **never parsed** (→ platform does nothing), **never executed**, and **never stripped** (→ raw marker shown to operator).

**Fix:** new shared module `apps/api/src/adapters/markerToolProtocol.ts`:
- `extractMarkerToolCalls()` — brace-balanced JSON scanner (string/escape aware) that finds `AGENTIS_TOOL_CALL {…}` and `<agentis_tool_call>…</agentis_tool_call>` anywhere in the text, tolerant of trailing prose/junk, multi-line JSON, and nested braces. Returns `{ calls, cleaned }` where `cleaned` is the marker-free operator-visible text.
- `isProcessNoiseLine()` / `stripProcessNoise()` — locale-agnostic filter for process-kill chatter (matches a PID reference + a termination verb across en/pt/es/de/it/fr/ru). Non-JSON noise is now dropped, never shown.
- `buildMarkerToolPrompt()` — single source of truth for the CLI tool-call instructions, so Codex and Claude Code stay in lockstep with the parser.

Both `CodexAdapter` and `ClaudeCodeAdapter` now route through it; non-JSON stdout goes to a `rawFallback` (noise-filtered) used only when the model emitted no JSON at all. Added a regression test reproducing the exact screenshot (marker JSON event followed by two `ÊXITO … PID …` lines) asserting the tool call is parsed and no `PID`/`XITO`/marker text leaks. **All 6 Codex + 3 Claude adapter tests pass.**

**Why "nothing happened" is now fixed end-to-end:** with the marker parsed into a real `tool_call`, the executor runs `agentis.build_workflow`, which is marked `autoExecute: true` (so it runs instantly, no confirmation card), persists the workflow, and emits `CANVAS_BUILD_COMPLETE`. The chat `ThreadView` already listens for that event and dispatches `agentis:open-canvas` → the canvas opens on the new workflow. The whole chain was previously dead only because step 1 (parse) silently failed.

### Fix 2 — Codex reasoning → ThinkingBubble

Codex `exec --json` interleaves chain-of-thought ("reasoning") events with the final answer. The chat path was concatenating *all* extracted text — reasoning included — into one answer blob. Added `isReasoningEvent()` (matches `type`/`item.type` containing `reason`/`think`, deliberately conservative so the plain `{"type":"assistant"}` contract is untouched) and route reasoning to live `thinking` deltas. The UI renders these in the collapsible `ThinkingBubble` (§3.3) instead of the answer body — exactly the "ephemeral thinking, clean thread" behavior the spec calls for.

### Fix 3 — Chat surface UX (LLM-chat norms)

The active surface `apps/web/src/components/chat/ThreadView.tsx` had three rough edges the operator noticed ("a first chat appears with some text then disappears", "weird first message"):

1. **The "No text content" flash.** A streaming assistant bubble with no body yet rendered the literal placeholder `No text content` for the entire wait (Codex buffers ~10–30s before flushing). Replaced with an animated `TypingDots` indicator while `deliveryStatus === 'sending'`; the literal placeholder now only appears for a genuinely empty *delivered* message.
2. **Double "thinking" indicator.** The standalone `{name} is thinking…` footer rendered at the same time as the in-bubble indicator. It's now suppressed whenever a streaming assistant bubble is present (`streamingAgentActive`), so there is exactly one signal at a time.
3. **No streaming affordance.** Added a blinking `StreamingCursor` to in-progress assistant text so token streaming reads as live typing rather than static reflows.

Net effect: send a message → one clean typing indicator → (optional) ThinkingBubble streams reasoning → ExecutionFeed shows the tool running → answer streams in with a cursor → canvas opens. No raw protocol, no PID spam, no placeholder flicker.

### Verification

- `pnpm --filter @agentis/api typecheck` ✅ and `pnpm --filter @agentis/web typecheck` ✅.
- Targeted suites: `chatSessionExecutor` (5), `CodexAdapter` (6, incl. the new noise regression), `ClaudeCodeAdapter` (3) — all green.
- Full API suite: 577/579 pass. The 2 failures are in `tests/routes/agents.test.ts` (a background-install timing test that spawns the `claude` CLI, ~11s; and a "second orchestrator" check that passes in isolation). Both are in the previously-modified agent-creation path and never exercise `chat()` — unrelated to this work, pre-existing flakes worth a separate look.

### Still open (not chat-blocking; deferred per operator)

- `activeAgentTaskCount` store field + pulsing badge on the chat header button, and `FloatingTaskProgress` when the panel is closed mid-task (§3.7, §4.3.3).
- `AdapterManager.dispatchTask()` does not yet inject a `toolManifest` for workflow-triggered agent tasks (§4.4.2) — chat path is fine; this only affects tools inside running workflows.
- Settings tool-availability matrix (§4.4.3 / Phase 3 coverage gate).
- Markdown rendering in the chat bubble (no `react-markdown` dep present; plain `whitespace-pre-wrap` keeps lists readable — adding a renderer is a deliberate follow-up to avoid a new dependency mid-fix).
- Phase 4 polish (typewriter on plan-item completion, opt-in sound, reactions, resumable feeds).

---

## Round 2 — implementing the deferred set

### Fix 4 — Fast native tool-calling routing (the "surreal/fast" path)

**Problem:** the Codex/Claude CLIs re-spawn a whole process per tool round (~10–30s each), so even with the marker fix, a 2-step build feels sluggish. Native OpenAI-compatible runtimes (Hermes/HTTP) stream tool calls token-by-token in a single connection.

**Design (opt-in, zero-risk default):**
- New env `AGENTIS_ORCHESTRATOR_BASE_URL / _API_KEY / _MODEL` (`apps/api/src/env.ts`), falling back to the already-present `AGENTIS_EVALUATOR_*`. When neither is set, behavior is identical to before.
- `bootstrap.ts` constructs a single `HermesAdapter` (`agentId: 'orchestrator-runtime'`) from that config and passes it to `ChatSessionExecutor.configure({ …, orchestratorRuntime })`.
- `ChatSessionExecutor.#resolveChatAdapter(adapter)` transparently swaps the turn onto the orchestrator runtime **only** when the agent's own adapter reports `capabilities().toolForwarding === 'marker_protocol'` (i.e. Codex / Claude Code) and the runtime is configured. Native adapters (Hermes/HTTP/OpenClaw) are never diverted. Applied in both `turn()` and `confirm()`.
- Persona/context/attribution are unchanged — the orchestrator system prompt is still built from the selected agent, the conversation stays the agent's, the bubble still reads "codexy". Only the underlying brain (and the latency) changes.

Two new executor tests assert the fast path engages for `marker_protocol` agents and that native adapters are left alone. **7/7 chatSessionExecutor tests pass; API typecheck clean.**

Operator note: set `AGENTIS_ORCHESTRATOR_BASE_URL`+`AGENTIS_ORCHESTRATOR_MODEL` (e.g. an OpenAI/`gpt-4o`/local vLLM endpoint) to turn this on. Codex chat then becomes a single streamed turn with live tool calls instead of per-round re-spawns.

### Fix 5 — Markdown rendering in chat bubbles

New dependency-free `apps/web/src/components/chat/ChatMarkdown.tsx` renders the constructs LLMs actually emit (headings, bold/italic, inline code, fenced code blocks, ordered/unordered lists, blockquotes, links). All output is React elements (no `dangerouslySetInnerHTML`); link hrefs are sanitized to http(s)/mailto/relative. Incomplete syntax mid-stream degrades to literal text rather than throwing. Wired into assistant bubbles in `chat/ThreadView.tsx` (operator messages stay plain — they typed them). Chose a ~230-line self-contained renderer over adding `react-markdown` to avoid a new transitive tree mid-fix.

### Fix 6 — Active-task badge + FloatingTaskProgress (§3.7, §4.3.3)

`ChatPanelStore` gained `activeTask { agentId, agentName, label, done, total }`. `chat/ThreadView` sets it when an agent turn starts, increments `total`/`done` as tool calls stream, and clears it on done/error. `ChatPanelHeaderButton` shows a pulsing accent ring + dot while a task runs. New `FloatingTaskProgress.tsx` renders a bottom-right progress card **only when the panel is closed mid-task** (mounted from `ChatPanelMount`, which now returns it instead of `null` when hidden); clicking it re-opens the chat on the working agent. The operator can navigate away and still watch progress.

### Fix 7 — `dispatchTask` tool-awareness manifest (§4.4.2)

Added `toolManifest?: ToolManifestEntry[]` to `NormalizedTask` (core). `AdapterManager` gained `setToolManifestProvider()`; `dispatchTask` injects the manifest (best-effort, never blocks dispatch) unless the caller already set one. Bootstrap wires the provider to the mcp-exposed subset of the tool registry (concise, not all ~30 tools). Codex/Claude task prompts append a `formatToolManifestAwareness()` block. **Scope note:** workflow-node dispatch is fire-and-forget, so this is *awareness only* — it tells a CLI agent the platform surface exists; it does not add an in-workflow tool-execution loop (that's a separate, larger feature). The spec (§4.4.2) asks exactly for injection + adapter formatting, which this delivers.

### Fix 8 — Settings → Runtimes tool-availability matrix (§4.4.3)

New "Runtimes" tab in `SettingsPage` renders a per-adapter matrix (chat: interactive/relay; tools: Native / Conditional / Marker / Relay / None) mirroring each adapter's server-declared `capabilities()`. Marker-protocol rows point operators at the orchestrator fast path. Makes relay-mode runtimes visible instead of silently tool-less.

### Fix 9 — Phase 4 touches

- **Resumable execution feed:** verified already satisfied — the SSE route persists `toolCalls` into message metadata (`buildPersistedChatMetadata`), and `MessageBubble` renders `metadata.toolCalls` regardless of streaming, so a reload restores the feed.
- **Plan-item completion transition:** added `transition-colors duration-300` so plan items fade from muted → done as they complete.

Deliberately skipped from Phase 4 (out of scope / higher risk): opt-in sound design, message reactions, voice input. Noted for a future pass.

### Round 2 verification

- `pnpm -r typecheck` ✅ across all 7 packages (core, db, integrations, sdk, web, api, cli).
- Targeted suites green: `chatSessionExecutor` (7, incl. 2 new fast-path tests), `CodexAdapter` (6), `ClaudeCodeAdapter` (3) — 16/16.
- Pre-existing `agents.test.ts` flakes remain out of scope (flagged separately; never touch the chat path).

---

## Round 3 — the real workflow-creation blocker

### Fix 10 — `NOT NULL constraint failed: workflows.concurrency_overflow` (every build was failing)

After Round 1 made the agent actually *call* `agentis.build_workflow`, the tool started failing at the DB layer with `NOT NULL constraint failed: workflows.concurrency_overflow`. (Notably, the Codex agent diagnosed this itself in-chat — exactly the autonomous debugging the 10x vision is about.)

**Root cause:** schema drift. `packages/db/src/sqlite/schema.ts` declares `concurrency_overflow` as **nullable**, but existing databases were created when the column was `NOT NULL` (no default). Several `INSERT`s into `workflows` omit the column entirely, so on those DBs *every* new workflow — from the builder **and** the plain `POST /v1/workflows` route — fails before the graph is saved. This blocked the entire "build from chat" experience regardless of all the prior fixes.

**Fix (universal — works on nullable *and* not-null DBs):**
- Set `concurrencyOverflow: 'queue'` explicitly on all four insert sites that omitted it: `routes/workflows.ts` (create route), `ephemeralWorkflowService.ts` (promote), and both `agentisToolHandlers/build.ts` handlers (`agentis.workflow.create`, `agentis.build_workflow`). (The two `packager.ts` inserts already set it.)
- Future-proofed fresh installs: `schema.ts` column now `.default('queue')` and `embedded-sql.ts` DDL is `concurrency_overflow TEXT DEFAULT 'queue'`, so a brand-new DB can never reintroduce the drift.

No migration needed for existing DBs — providing a value on every insert satisfies the constraint whichever way the live column is defined. **db build + api/web typecheck clean.**

### UX nits from the same session

- **FloatingTaskProgress z-index** bumped to `z-[60]` so the "agent working" card can never sit behind another fixed overlay.
- **Open-source orchestrator config:** confirmed the fast path stays fully opt-in and provider-agnostic (env-driven, no hardcoded provider). The Settings → Runtimes tab documents how to enable it. Nothing is assumed or restricted — operators bring their own endpoint, or stay on the (now-correct) per-agent adapter.
- Codex reasoning vs. final-answer ordering and the in-bubble typing indicator are working as designed (thinking renders as the ephemeral ThinkingBubble above the answer, then collapses to "View thinking"). The earlier "raw thinking / PID spam" is gone after Round-1 Fix 1.

### Fix 11 — Rebuild migration: normalize `concurrency_overflow` to `NOT NULL DEFAULT 'queue'`

Following Fix 10 (which made every insert pass a value), this makes the *column itself* correct so schema and live DBs agree and no future insert path can reintroduce the failure.

- **Migration** `migrateWorkflowsConcurrencyOverflow()` in `packages/db/src/sqlite/index.ts`, run by `runEmbeddedMigrations` (the boot path: `bootstrap → openSqlite → runEmbeddedMigrations`). Follows the established SQLite table-rebuild pattern (`migrateWorkflowRunsEphemeral`): create `workflows_next` with `concurrency_overflow TEXT NOT NULL DEFAULT 'queue'`, `INSERT … SELECT … COALESCE(concurrency_overflow,'queue')` (backfills NULLs), `DROP`/`RENAME`, recreate `idx_workflows_workspace`, all under `PRAGMA foreign_keys=OFF`. Idempotent — guarded by a `PRAGMA table_info` check so it's a no-op once the column is already `NOT NULL DEFAULT 'queue'`. `pick()` fallbacks tolerate very old DBs missing optional columns.
- Consistency: drizzle schema → `.notNull().default('queue')`; embedded DDL + `addColumn` → `TEXT NOT NULL DEFAULT 'queue'`. Fresh DBs are born normalized (migration guard short-circuits).
- **Test:** new `migrate.test.ts` case builds the exact legacy DB (`concurrency_overflow TEXT NOT NULL`, no default), asserts the legacy omit-insert fails, opens via `openSqlite`, then asserts the column is `NOT NULL DEFAULT 'queue'`, the legacy row survived, and an omit-insert now defaults to `'queue'`. **Passes.**
- Drive-by: `packages/db/src/index.ts` was missing re-exports for `runSqliteMigrations` / `getSqliteMigrationStatus` / `SQLITE_MIGRATIONS`, so 4 versioned-runner tests failed at import. Added the re-exports (1 of those tests now passes).

`pnpm -r typecheck` ✅ all 7 packages. The `.notNull()` schema change does not ripple to consumers.

**Pre-existing, out of scope (flagged separately):** 3 `migrate.test.ts` cases for the *versioned* migration system still fail — `SqliteError: cannot change into wal mode from within a transaction` (a registered migration runs a WAL pragma inside `applyMigration`'s `BEGIN IMMEDIATE`), and `openSqlite` not wiring `runSqliteMigrations` at all (it uses the embedded runner). These predate this work and are unrelated to the chat 10x effort.

---

## Round 4 — post-success hardening (workflows build now; making the loop sane)

Workflow creation now works end-to-end (Hello World LP built + test-ran → "Workflow is working"). This round fixes the rough edges that surfaced once the happy path was unblocked.

### Fix 12 — Phantom tools removed from the advertised catalog

The hand-written `CHAT_TOOL_CATALOG` advertised **8 tools the registry never registered** (`memory.read/write`, `knowledge.search/write`, `app.create/compose`, `apps.run_status`, `app.thread.open`). The model called `agentis.knowledge.search` → `TOOL_NOT_FOUND`, wasting a turn, and the agent's "what can you do" answer promised capabilities it didn't have. Fix: `ChatToolExecutor.registeredIds()` + `ChatSessionExecutor.#filterToRegistered()` now drop any advertised tool the registry can't execute (dynamic `workflow.<id>` always kept; unfiltered if the registry isn't configured, so nothing is ever hidden by accident). Catalog and registry can no longer drift — when memory/knowledge/app tools are actually registered later, they auto-surface.

### Fix 13 — Codex stops exploring a filesystem that isn't there

The logs showed Codex spending **minutes** running `rg`/grep/file searches in its sandbox (regex parse errors, 10s command timeouts, ×N) before finally calling the tool. Root cause: Codex is a coding agent and assumed a repo to explore. `buildMarkerToolPrompt` now states plainly: *there is NO local repository/filesystem; do NOT run shell/ripgrep/file commands; the ONLY way to act is `AGENTIS_TOOL_CALL`* — plus "call only tools from the list, exact names." This is the biggest lever for making the default (no-fast-path) Codex chat fast.

### Fix 14 — A chat turn can no longer hang forever

`CodexAdapter`/`ClaudeCodeAdapter` only set a turn timeout when the agent config provided `timeoutSec` — unset meant **no bound**, so a wandering CLI hung the conversation (the 5+ min stuck "working" card). Added `DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000`: every interactive chat turn is now bounded, aborts cleanly on timeout (→ `done: error` → the card clears, the operator sees a failure instead of an infinite spinner). dispatchTask (long coding tasks) is unchanged.

### Fix 15 — The stuck "agent working" card can always be escaped

Two failure modes made the FloatingTaskProgress card orphan: a genuinely long turn, and going fullscreen / navigating (which swaps the `ThreadView` instance that owned the turn). Fixes: (a) a dismiss **×** on the card; (b) `ThreadView` clears any progress card it owns on unmount / agent switch (the server turn keeps running and its result still arrives via realtime). No more undismissable stuck card.

### Fix 16 — Output tab + Publish error

- **"Failed to load output: Not Found":** `WorkflowOutputTab` fetched `/output` and `/records` in one `Promise.all`, but **no `/records` route exists** — its 404 failed the whole tab even though output loaded fine. The records fetch is now best-effort (its failure → empty tables), so output renders.
- **"Publish failed [object Object]":** `handlePublish` did `String(e)` on a structured API error. Switched to `apiErrorMessage(e)` for a readable message.

### Verification
- `pnpm --filter @agentis/api typecheck` ✅ and `pnpm --filter @agentis/web typecheck` ✅.
- `chatSessionExecutor` (7) + `CodexAdapter` (6) + `ClaudeCodeAdapter` (3) = 16/16 green.

### Flagged for a separate pass (out of scope here)
- Canvas editor: can't delete/unlink edges, and autosave only persists every *other* edit (stale-closure/dirty-flag toggle).
- "Test run" vs "Run now" labeling on the workflow toolbar reads as confusing (it *is* the run-now path).
- The deepest lever for Codex chat speed remains the opt-in orchestrator fast path (Fix 4) — provider-agnostic, operator brings their own endpoint.


### Implementation resumed by Codex

I picked up from the previous executor and re-verified the hot path before editing. The first implementation slice is deliberately focused on the platform-brain loop: update the action-first orchestrator prompt, let reversible build/create tools execute without confirmation, preserve tool/thinking metadata through SSE persistence, and replace the tiny tool pills in the active chat surface with a grouped execution feed plus thinking and plan rendering. I am keeping the legacy `ChatPanel/ThreadView.tsx` in mind, but the live docked experience is `apps/web/src/components/chat/ThreadView.tsx`, so that is the priority path for this pass.

### Backend action layer implemented

The orchestrator prompt is now action-first: build requests explicitly call `agentis.build_workflow`, small workflow builds should not ask clarifying questions, and the prompt includes a compact architecture-specialist node catalog so the model chooses deterministic nodes before expensive agent nodes. I added `autoExecute` to the core tool definition contract and marked `agentis.build_workflow` plus `agentis.workflow.create` as reversible build actions that skip confirmation. Generic mutating tools still confirm, and dynamic `workflow.<id>` tools now require confirmation instead of silently bypassing the guard. I also added LLM-facing examples for the most error-prone tools and taught the Codex CLI adapter a strict `AGENTIS_TOOL_CALL {"name":"...","arguments":{...}}` protocol so Codex-backed agents can request Agentis tools instead of claiming they cannot call them.

### Execution theater implemented in the chat surface

The active chat surface now has first-pass execution theater components: `ThinkingBubble`, `ExecutionFeed`, `PlanList`, and `StickyProgressBanner`. Tool-call input arguments are captured, tool results preserve inputs, and SSE-persisted assistant messages now store `metadata.thinking` and `metadata.toolCalls` so a reload does not erase the work trace. Both the modern `components/chat/ThreadView.tsx` and the legacy `components/ChatPanel/ThreadView.tsx` render grouped execution feeds instead of independent tiny pills. `CANVAS_BUILD_COMPLETE` now dispatches `agentis:open-canvas`; the shell listens for it and navigates to `/workflows/:workflowId`, so chat-initiated workflow builds visibly land on the canvas.

### Verification

Focused verification is green: `pnpm --filter @agentis/api test -- tests/services/chatSessionExecutor.test.ts tests/adapters/CodexAdapter.test.ts tests/routes/conversationsSse.test.ts`, `pnpm --filter @agentis/api typecheck`, and `pnpm --filter @agentis/web typecheck` all pass. I also opened the local `/chat` page in the in-app browser against dev API/web servers and found no browser console errors on load. Temporary dev servers were stopped and temporary log files were removed after the smoke check.

### Skill visibility and deterministic builder correction

I found another real gap behind the operator complaint that built-in skills were not available to online agents: the workspace `/v1/skills` route existed, and seeded built-ins existed, but there were no chat-facing `agentis.skills.*` tools in either the registry or LLM catalog. I added read-only `agentis.skills.list` and `agentis.skill.inspect` tools so online agents can discover real skill IDs, entrypoints, schemas, runtimes, and capability tags before wiring `skill_task` nodes. I also updated the orchestrator prompt and chat catalog examples so models are told to inspect skills instead of inventing IDs.

While in the builder path, I fixed a second mismatch: `synthesizeWithLlm()` claimed to pass agents, skills, and knowledge bases to the workflow architect, but the implementation only passed agents and knowledge bases. It now includes workspace skills with real IDs and schemas. The deterministic fallback also now recognizes simple fixed-response / Hello World requests and builds the correct `trigger -> transform(isOutput)` graph with an output contract instead of wasting an `agent_task` on a constant message. Verification is green for the new slice: `pnpm --filter @agentis/api test -- tests/services/agentisChatTools.test.ts tests/services/chatSessionExecutor.test.ts tests/adapters/CodexAdapter.test.ts tests/routes/conversationsSse.test.ts` and `pnpm --filter @agentis/api typecheck`.

### Confirmation UX upgraded

The first pass made build/create actions execute immediately, but the remaining confirmation flow still rendered as a raw JSON block. I upgraded the confirmation contract and UI: `confirmation_required` deltas can now include structured impact metadata (`summary`, `details`, `riskLevel`, reversibility, and external side-effect hints). `ChatSessionExecutor` derives that impact for workflow runs, ephemeral runs, run cancellation, approval resolution, app creation, and generic platform mutations. The active chat confirmation card now renders a risk badge, consequence summary, countdown timer, external-side-effect/reversibility hints, consequence details, and a collapsible audit payload. This keeps risky actions gated without making the operator parse raw tool JSON. Verification is green: `pnpm --filter @agentis/web typecheck`, `pnpm --filter @agentis/api typecheck`, and `pnpm --filter @agentis/api test -- tests/services/chatSessionExecutor.test.ts tests/services/agentisChatTools.test.ts`.

### Browser smoke check after UI changes

I started the local API and web dev servers, opened `http://127.0.0.1:5173/chat` in the in-app browser, and confirmed the chat shell loads with the title `Agentis` and no current browser console errors. The screenshot showed the expected docked chat layout with the Thomas orchestrator thread and composer. Temporary dev processes and `.codex-tmp` logs were cleaned up after the check.

### Pending confirmations now survive reload

While reviewing the confirmation path, I found a durability gap: if the agent paused for confirmation before producing normal text, the live UI showed the card but the server did not persist an assistant message because `finalText` was empty. A refresh could lose the pending decision surface. I extended the streamed metadata capture to store `confirmation_required` deltas and persist a fallback assistant message with `metadata.confirmation` whenever a turn pauses for confirmation. The card metadata includes the new structured impact payload, so reloads preserve the same decision context. Verification is green: `pnpm --filter @agentis/api test -- tests/routes/conversationsSse.test.ts tests/services/chatSessionExecutor.test.ts tests/services/agentisChatTools.test.ts`, `pnpm --filter @agentis/api typecheck`, and `pnpm --filter @agentis/web typecheck`.

### Adapter capability layer and golden-path regression started

I started the next slice by making adapter tool availability explicit instead of inferred from adapter names. The core adapter contract now exposes `capabilities()` with interactive-chat/tool-calling/tool-forwarding metadata. Hermes reports native function calling, Codex and Claude Code report the CLI marker protocol, HTTP reports tool support only when a `chatUrl`/`chatPath` plus `supportsTools` are configured, and task-only adapters now explain their limitation instead of silently pretending they can act through chat. I also wired HTTP chat to a small JSON/SSE contract and added Claude Code chat support using the same `AGENTIS_TOOL_CALL {"name":"...","arguments":{...}}` protocol that unblocked Codex.

The regression target for this slice is the actual operator failure mode: a chat agent asked to build Hello World must call `agentis.build_workflow`, create the workflow, emit canvas build events, and continue from the tool result. I added a golden-path service test for that loop and a Claude Code adapter test for marker parsing. I am running typecheck and focused tests next; if anything shakes loose, I will adjust the implementation rather than treating the current patch as sacred.

### Adapter capability slice verified

The adapter/tool availability slice is now green. Focused tests pass for the new golden path, Claude Code marker parsing, agent capability diagnostics, the existing Codex marker path, chat-session confirmation behavior, skill discovery, and conversation SSE persistence. Typecheck is also green for `@agentis/core`, `@agentis/api`, and `@agentis/web`. I also surfaced adapter capability warnings in the active chat UI: if a selected agent is task-only or can chat without Agentis tool execution, the composer area now explains the limitation directly instead of letting the operator discover it through another failed build request.

Final verification for this slice: `pnpm --filter @agentis/api test -- tests/adapters/HttpAdapter.test.ts tests/adapters/ClaudeCodeAdapter.test.ts tests/adapters/CodexAdapter.test.ts tests/services/chatGoldenPath.test.ts tests/services/chatSessionExecutor.test.ts tests/services/agentisChatTools.test.ts tests/routes/conversationsSse.test.ts tests/routes/agents.test.ts` passed with 34 tests, and `pnpm --filter @agentis/core typecheck`, `pnpm --filter @agentis/api typecheck`, and `pnpm --filter @agentis/web typecheck` all passed. I added the HTTP adapter contract test after noticing custom HTTP agents are the riskiest edge: it proves the adapter only reports tool-capability when configured and normalizes returned tool calls into the common chat loop.

