# Agent Chat Runtime Implementation

This document describes the Agentis chat execution and presentation contract.

## Runtime contract

- Every supported runtime enters Agentis through the same streaming delta protocol.
- Runtime planning and raw reasoning are not operator-facing answer content.
- Raw reasoning is neither sent to the browser nor stored in message metadata.
- CLI runtimes expose only their latest or explicit terminal assistant message as the answer.
- Text emitted during a tool-call round is buffered and discarded from the transcript.
- Only text from the terminal model round becomes the final assistant answer.
- Factual activity events bypass answer buffering and reach the browser immediately.
- Tool calls and confirmations remain visible while work runs.
- Cancelling a turn aborts the active request and changes unfinished tool rows to stopped.

The central implementation is `apps/api/src/services/chatSessionExecutor.ts`.

## Activity presentation

`LiveActivityTrace` renders a single compact status line while a turn is active. It uses
the latest factual runtime activity instead of model reasoning or backend log prose.
Each new status replaces the previous line, so progress does not grow into a transcript.

When execution finishes, the summary is computed from the actual meaningful activity
events, for example `Completed 4 steps in 18s`. No step count is hardcoded. Expanding
the row reveals the individual activity entries and their details.

Generic transport events such as request receipt, waiting for output, and response ready
are excluded from the visible step count.

## Final answer presentation

Agentis does not infer a progress plan from arbitrary Markdown in the final answer.
This prevents ordinary numbered content from being rendered as fabricated completed
steps. The final answer is rendered once through `ChatMarkdown`.

## Composer behavior

- The textarea and controls occupy separate layout rows, so long drafts cannot cover
  model, context, attachment, voice, or send controls.
- Drafts are persisted by workspace and conversation in local storage.
- Closing and reopening chat restores the draft.
- `Ctrl+Z` or `Cmd+Z` restores the most recently sent message when the composer is empty;
  native textarea undo remains available while editing.
- Slash-command results use an opaque surface and remain readable above the composer.

## Runtime controls

The composer exposes compact model, reasoning-effort, and context/usage controls from
the selected agent's `runtime-context` endpoint. The UI only displays fields supplied
by that runtime. Missing context or quota data is not estimated or fabricated.

Model and effort changes update the agent runtime configuration and dispatch a runtime
refresh event so all visible selectors stay synchronized.

## Scrolling and navigation

The conversation follows new activity while the operator is at the bottom. Reading
older content disables forced scrolling and shows a `Jump to latest` control. Loading
older pages preserves the current reading position.

Maximizing chat records the exact route it came from. Minimizing returns to that route
instead of forcing `/home`.

## Verification

Focused coverage lives in:

- `apps/api/tests/services/chatSessionExecutor.test.ts`
- `apps/api/tests/adapters/CodexAdapter.test.ts`
- `apps/api/tests/adapters/ClaudeCodeAdapter.test.ts`
- `apps/web/tests/components/LiveActivityTrace.test.tsx`
- `apps/web/tests/components/ExecutionFeed.test.tsx`

The executor test verifies that tool-round narration cannot leak into the final answer.
It also proves that factual activity reaches the consumer before the model turn completes.
The adapter tests verify that explicit terminal output wins over intermediate narration.
The UI tests verify one-line active progress, collapsed logs, and real completed counts.
