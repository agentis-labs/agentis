# Chat UI 10x — assistant-ui Integration Plan

**Library**: [`@assistant-ui/react`](https://github.com/assistant-ui/assistant-ui) · MIT · 10k+ stars  
**Revised strategy**: Use assistant-ui as a **component library**, not as a **runtime framework**.  
**Scope**: `apps/web` only — no API changes.

---

## Architectural critique of the naive "full adoption" plan

Before prescribing the approach, the initial instinct (wrap everything in
`ExternalStoreRuntime` + replace `ThreadView` with `<Thread />`) has several
critical mismatches with Agentis's actual data model:

### 1. Messages are NOT in the Zustand store

`ChatPanelStore` holds only panel-level state (open/closed, width, selected
thread). The actual messages array is **`useState` local to `ThreadView`** and
is never surfaced to the store. The proposed plan would require hoisting the
entire message state + pagination + SSE streaming state into the store — a
high-risk, multi-day refactor completely unrelated to the UI library.

### 2. The streaming state machine is Agentis-custom

ThreadView maintains a 3-tier message reconciliation pipeline:

```
optimistic (tmp-*)  →  streaming (stream-*)  →  server-reconciled (UUID)
```

The helper chain `dedupeMessages → sortMessages → mergeMessage → prependUnique`
handles SSE deltas, temp message replacement, and real-time socket.io arrival
of the same message. `ExternalStoreRuntime`'s streaming model (`setMessages`
mutation in place with text chunks) does not map to this pipeline — you'd have
to run all the Agentis logic BEFORE handing messages to the runtime, making
the runtime a redundant wrapper.

### 3. Pagination (`PAGE_SIZE = 50` + infinite scroll up)

`Thread` has no concept of loading older messages. It auto-scrolls to the
bottom on new messages. If you call `prependUnique` with an older page,
`Thread` treats them as new messages and scrolls to them. Historical paging
would require fighting the library's scroll management, not leveraging it.

### 4. Two fundamentally different message schemas

`AgentMsg` (single agent-thread) and `RoomMsg` (multi-participant room, with
`content: Record<string, unknown>`) share the same `ThreadView`. Forcing both
through a single `convertMessage → ThreadMessageLike` loses the room schema
entirely. Rooms are not "another AI thread" — they're a group-chat surface.

### 5. `ThreadList` is the wrong abstraction for scope tabs

Scope tabs (orchestrator + space managers) are **different agent backends** —
different `agentId`, different adapter types, different capability matrices,
different API endpoints. `ExternalStoreThreadListAdapter` was designed for
thread history (same agent, different conversation IDs). Switching scopes is
not a thread switch; it unmounts one `ThreadView` and mounts another.

### 6. Confirmation cards are not `onAddToolResult`

Agentis's in-conversation approval flow is a **server-side blocking call** —
the agent is paused, the user POSTs to `/v1/conversations/:id/confirm`. The
assistant-ui `onAddToolResult` callback is client-side tool result injection
on an in-flight streaming request. The contract is completely different.

### 7. What assistant-ui was designed for

assistant-ui excels at: user sends text → server streams back text/tool calls →
user continues. Agentis has **proactive pushes** (agent-initiated messages
without a user turn), **multi-step execution feeds** (streaming plan steps +
workflow run status), **per-agent capability detection**, and **archived thread
read-only states**. The `Thread` component has no affordances for any of these.

---

## Revised strategy: component library, not runtime framework

The correct split is:

| assistant-ui layer | Adopt? | Reason |
|---|---|---|
| `@assistant-ui/react-markdown` (MarkdownText) | ✅ Yes | Standalone, zero runtime coupling. Drop-in for `ChatMarkdown.tsx`. Code copy, syntax highlight, math, GFM. |
| `Composer` primitive headless hooks | ✅ Yes | Wire a minimal `LocalRuntime` stub purely to satisfy the Composer context. Gives ⌘↵, auto-resize, file attach, voice dictation without touching message state. |
| Auto-scroll utilities | ✅ Yes | `useScrollToBottom` is exportable; replaces the manual `scrollRef` logic. |
| `Thread` component | ❌ No | Pagination, proactive messages, and the custom execution-feed layout fight the component's assumptions. Build a better custom renderer instead. |
| `ExternalStoreRuntime` as primary state | ❌ No | Creates a second source of truth on top of the working Zustand + local-state pipeline. |
| `ThreadList` for scope tabs | ❌ No | Wrong abstraction; scopes are agent backends, not conversation thread history. |
| Generative UI / `makeAssistantToolUI` | ❌ No | Only usable inside `AssistantRuntimeProvider`; can't be isolated from the full runtime graph. |

---

## What Agentis actually needs (the real UX gaps)

| Gap | Current state | 10x fix | Source |
|---|---|---|---|
| No code copy button | `ChatMarkdown.tsx` renders raw code blocks | `MarkdownText` from `@assistant-ui/react-markdown` | assistant-ui |
| Weak markdown (no math, no GFM tables) | Partial remark pipeline | Full remark + rehype pipeline in `MarkdownText` | assistant-ui |
| ⌘↵ doesn't send | `<textarea>` only handles Enter | `Composer` primitive keyboard handlers | assistant-ui |
| No voice dictation | — | `WebSpeechRecognitionAdapter` on Composer | assistant-ui |
| Auto-scroll fights manual scroll | Manual `scrollRef` with `useEffect` | `useAutoScroll` from assistant-ui or scroll-lock pattern | assistant-ui |
| No message edit | Not implemented | Inline edit on `ChatMessage` component | custom |
| No regenerate | Not implemented | Re-send last user turn via existing `sendEndpoint` | custom |
| ThinkingBubble is visually weak | Single expanding pre block | Redesign `ThinkingBubble` with animated reveal | custom |
| ExecutionFeed is overwhelming | Flat list of every step | Progressive collapse + summary line | custom |
| Confirmation card has no timer | `expiresAt` exists but not shown | Countdown ring on `ConfirmationCard` | custom |
| No unread count on scope tabs | Not wired | Wire `unreadCount` from realtime to scope tab pill | custom |
| No virtual scroll | Full list always rendered | `@tanstack/react-virtual` for large histories | library |
| File attachments | Not implemented | New upload endpoint + Composer attach button | new feature |

---

## File map

```
apps/web/src/
  components/
    chat/
      ChatMarkdown.tsx          → REPLACE with MarkdownText wrapper
      ThinkingBubble.tsx        → REDESIGN (no library change)
      ExecutionFeed.tsx         → PROGRESSIVE COLLAPSE redesign
      ThreadView.tsx            → ADD: edit/regenerate, virtual scroll,
                                         auto-scroll fixes
      ChatPanel.tsx             → ADD: unread count on scope tabs
    ChatPanel/
      Composer.tsx              → ADD: ⌘↵, voice dictation via assistant-ui
                                         Composer primitives (stub runtime)
```

---

## Phases

### Phase 1 — `MarkdownText` replaces `ChatMarkdown.tsx` (0.5 day)

**Zero coupling to runtime.** `@assistant-ui/react-markdown` is a standalone
package. No `AssistantRuntimeProvider` needed.

```bash
pnpm add @assistant-ui/react-markdown
# Syntax highlighting (pick one):
pnpm add rehype-highlight  # or shiki via rehype-shiki
```

```tsx
// ChatMarkdown.tsx becomes a thin wrapper:
import { MarkdownText } from '@assistant-ui/react-markdown';

export function ChatMarkdown({ children }: { children: string }) {
  return <MarkdownText>{children}</MarkdownText>;
}
```

**Gains**: code copy button, syntax highlighting, GFM tables, task lists, math
blocks, proper code language labels.

**Deliverable**: Drop-in replacement, no other file changes. Verify in Vitest.

---

### Phase 2 — Composer UX (⌘↵, auto-resize, voice) (1 day)

Mount a **minimal `LocalRuntime` stub** purely to satisfy the Composer's context
requirement. The stub does nothing with messages — it's only there so the
`Composer` primitives compile. All actual send logic stays in the existing
`Composer.tsx` handler.

```bash
pnpm add @assistant-ui/react
```

```tsx
// In Composer.tsx — add a provider shell at the top:
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { ComposerPrimitive } from '@assistant-ui/react';

function ComposerShell({ onSend, disabled, placeholder, children }) {
  // LocalRuntime stub — messages array is ignored; we intercept onSend
  const runtime = useLocalRuntime({ onNew: async (msg) => onSend(msg.content[0].text) });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input placeholder={placeholder} />
        <ComposerPrimitive.Send />
        {children}
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
```

**Gains**: ⌘↵ / Ctrl+↵ sends, Shift+↵ newline, auto-resize textarea, accessible
send button state, foundation for file attach and voice in later phases.

Voice dictation:

```tsx
import { WebSpeechAdapter } from '@assistant-ui/react';
const runtime = useLocalRuntime({ onNew, adapters: { speech: new WebSpeechAdapter() } });
// Adds a microphone button to ComposerPrimitive automatically.
```

**Deliverable**: Composer sends on ⌘↵, auto-resizes, has mic button.

---

### Phase 3 — Auto-scroll + virtual scroll (1 day)

**Auto-scroll**: Replace the manual `scrollRef` + `useEffect` scroll logic in
`ThreadView` with the `useScrollToBottom` pattern from assistant-ui, or a
simple custom hook using `ResizeObserver` on the list container. The current
logic has scroll-preserve bugs when loading older pages.

```tsx
// hooks/useAutoScroll.ts — ~40 lines, no library dependency
// Pins to bottom unless user has manually scrolled up (>100px from bottom).
// Re-locks on new message from agent (authorKind === 'agent').
```

**Virtual scroll**: Add `@tanstack/react-virtual` for threads with > 100 messages.
This is a pure performance win with no UX change.

```bash
pnpm add @tanstack/react-virtual
```

The `messages.map(...)` loop in `ThreadView` becomes a virtualizer window. Pagination
(`prependUnique`) stays unchanged — virtualizer handles the growing list.

**Deliverable**: No layout jank on long threads. Scroll-to-bottom pill appears
when user scrolls up.

---

### Phase 4 — Message edit + regenerate (1 day)

Both are custom — no library required for the mechanics:

**Edit** (`setEditingId` already exists in `ThreadView`):
1. Clicking edit on a message populates the Composer with the message text.
2. On send, POST to `sendEndpoint` with `{ editMessageId: msg.id }` (or truncate
   locally + re-send depending on API contract).
3. Call `upsertMessage` on the response.

**Regenerate** (new button on last agent message):
1. Find the last `authorKind === 'operator'` message before the target.
2. POST that text to `sendEndpoint` with `{ regenerate: true }`.
3. Stream response via existing SSE pipeline.

Add action buttons (`Copy`, `Edit`, `Regenerate`) as an icon row that appears on
message hover — rendered inside each `ChatMessage` component, no library needed.

**Deliverable**: Every agent message has copy/regenerate. Every user message has edit.

---

### Phase 5 — Component polish (1 day)

These are pure Agentis-custom improvements, no library:

**ThinkingBubble redesign**:
- Animated thinking dots → expand to reveal full reasoning text with a
  smooth height transition.
- Collapsed by default after the agent responds (show "Thought for Xs" header).

**ExecutionFeed progressive disclosure**:
- Show only the current/last step while streaming.
- Completed feed collapses to a summary line ("Ran 7 steps · 3.2s").
- Expand button reveals the full step list.

**ConfirmationCard expiry timer**:
- `expiresAt` field is already in `ConfirmationCardData` but not displayed.
- Add a countdown ring that auto-cancels on expiry.

**Scope tab unread badge**:
- Wire `setUnreadCount` (already in `ChatPanelStore`) from realtime
  `CONVERSATION_MESSAGE_RECEIVED` when the tab is not selected.

---

### Phase 6 — File attachments (1.5 days)

Requires a small API addition + Composer integration:

**API** (one endpoint):
```
POST /v1/conversations/:id/attachments
Content-Type: multipart/form-data
→ { attachmentId, url, fileName, mimeType }
```

**Composer** (in Phase 2's Composer shell):
```tsx
adapters: {
  attachments: {
    accept: 'image/*, application/pdf, text/*',
    add: async ({ file }) => {
      const { attachmentId, url } = await api.uploadAttachment(convId, file);
      return { id: attachmentId, name: file.name, url, contentType: file.type };
    },
    remove: async ({ id }) => api.deleteAttachment(convId, id),
    send: async ({ attachments }) => { /* include in message payload */ },
  }
}
```

**Deliverable**: File/image attach button in composer. Attachments render as
thumbnails in the message thread.

---

## What stays exactly as-is

- **API transport**: `streamSse`, `api`, socket.io realtime — unchanged.
- **`ChatPanelMount.tsx`** — unchanged.
- **Realtime subscriptions** — unchanged.
- **`ChatPanelStore`** — no messages moved into it; local state stays local.
- **`scopeIdentity.tsx`**, **`usePrimaryChatScopes.ts`** — unchanged.
- **`AgentModelSelector.tsx`** — unchanged.
- **`RoomCreateDialog.tsx`**, `RoomList.tsx` — unchanged.
- **Message dedup/sort/merge pipeline** (`sortMessages`, `mergeMessage`, etc.) — unchanged.
- **Scope tabs structure** — unchanged (just gains the unread badge).

---

## Effort summary

| Phase | Description | Effort |
|---|---|---|
| 1 | MarkdownText drop-in | 0.5 day |
| 2 | Composer (⌘↵, voice, auto-resize) | 1 day |
| 3 | Auto-scroll + virtual scroll | 1 day |
| 4 | Message edit + regenerate | 1 day |
| 5 | Component polish (thinking, execution, confirmation, unread) | 1 day |
| 6 | File attachments | 1.5 days |
| **Total** | | **6 days** |

Risk is low: phases 1–4 are independent and each ships in isolation. Phase 6
requires a backend stub but is gated on that, not on the frontend work.

---

## References

- [assistant-ui docs](https://www.assistant-ui.com/docs)
- [MarkdownText](https://www.assistant-ui.com/docs/ui/markdown)
- [Composer primitives](https://www.assistant-ui.com/docs/ui/composer)
- [LocalRuntime](https://www.assistant-ui.com/docs/runtimes/custom/local-runtime)
- [Adapters (attach, speech)](https://www.assistant-ui.com/docs/runtimes/concepts/adapters)
- [@tanstack/react-virtual](https://tanstack.com/virtual/latest)
