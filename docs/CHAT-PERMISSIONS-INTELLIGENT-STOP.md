# Chat Permissions + Intelligent Stop

> Two operator complaints, one masterplan:
> 1. *"We should add permissions like ask or bypass mode for chat — I asked a long
>    implementation and the agent simply started to do it, no plan, nothing."*
> 2. *"And worse, stopped after 600ms… we shouldn't limit time, we should stop a
>    clearly bug like some eternal loop or consecutive same things — intelligent stop!"*

## Diagnosis (what was actually there)

- **No operator-controlled permission mode.** The chat loop had a single hardcoded
  confirmation rule (`workflow.*` + non-`autoExecute` mutating tools). There was a
  per-*turn* `/plan` slash that flipped `conversations.execution_mode` (which the
  tool registry already honors by blocking mutations), but no *sticky* mode and no
  way to say "just run everything" (bypass).
- **A wall-clock guillotine, not intelligent stopping.** The loop was bounded by
  `maxTurns` (clamped 5–8), `maxToolCalls` (clamped to 24), and a hard turn
  deadline (`45s` streaming / `600s` harness). It guillotined long, legitimate work
  while doing *nothing* to detect a model genuinely stuck repeating itself.

Both map onto seams that already existed — this is **extend, not rebuild**.

## Design

### Permission modes (sticky, per-conversation): Ask / Plan / Auto

- New `conversations.permission_mode` column (migration **v93**, default `ask`).
- `ChatPermissionMode = 'ask' | 'plan' | 'auto'` on `ChatTurnContext`.
- `ChatToolExecutor.requiresConfirmation(name, mode)`:
  - `auto` → never confirm (the **bypass** the operator asked for).
  - `plan` → don't confirm; mutations are blocked upstream by the registry
    (`executionMode='plan'`), which returns an error the model adapts to.
  - `ask` (default) → **today's behavior**: confirm workflow runs + mutating tools
    that are *not* `autoExecute`. `autoExecute` tools are operator-*requested*
    creations (`build_workflow` right after "build me X"), so re-confirming them is
    pure friction — **Plan mode** is the answer to "propose before acting." This
    keeps the carefully-tuned live build narration intact.
- **Control surfaces:**
  - Web: a 3-way `PermissionModePicker` in the composer (Ask/Plan/Auto), sticky in
    `localStorage` per conversation, persisted server-side via
    `POST /conversations/session/:id/mode` and carried on every send body.
  - Channels (no composer): slash commands `/ask` `/plan` `/auto` (aliases
    `/bypass`, and legacy `/chat` `/act` → ask). A bare command switches + ack's;
    `/plan build X` switches *and* runs. Shared grammar in `chatPermissionMode.ts`
    so web and channels interpret it identically.

### Intelligent stop (time-free): `ChatProgressMonitor`

Replaces the `maxTurns` loop bound **and** the turn deadline. The loop now runs
until the model is done, the operator cancels, or the monitor detects a pathology.

Each tool round is scored for a **progress signal** (a never-before-seen
`(tool,args)`, a new result hash, or new operator text). Detectors, in priority:

1. `identical_repetition` — same `(tool,args)` across ≥3 rounds.
2. `oscillation` — a short cycle of rounds repeating (A,B,A,B); seen 2×.
3. `error_storm` — ≥4 consecutive all-errored rounds.
4. `no_progress` — ≥3 consecutive zero-progress rounds. **The complete backstop.**

**Why no timer is safe:** progress is defined strictly, so a stuck loop cannot
manufacture novelty forever → the no-progress streak *always* eventually fires for
any loop the faster detectors miss. A long task taking distinct productive steps
never trips. On stop, the loop emits an **honest** message naming the pathology
("I was repeating myself — I called X 3 times with identical arguments") instead of
a canned timeout. The only remaining ceiling is a defensive `absoluteMaxRounds`
(150, env-overridable) the monitor should always beat. Per-round model-call
liveness timeouts stay (they bound a single network/stdio call, not the task).

All thresholds are env-overridable (`AGENTIS_CHAT_MAX_IDENTICAL_CALLS`,
`AGENTIS_CHAT_MAX_NO_PROGRESS_ROUNDS`, `AGENTIS_CHAT_MAX_ROUNDS`,
`AGENTIS_CHAT_MAX_TOOL_CALLS`, …).

## Impl log — 2026-06-25 (SHIPPED)

- **DB:** migration v93 `conversation_permission_mode`; schema.ts + embedded-sql.ts
  + index.ts drift patch all mirror the new column. db tests 12/12 green.
- **Core:** `ChatPermissionMode` + `ChatTurnContext.permissionMode` (`chat.ts`).
- **Monitor:** new `chatProgressMonitor.ts` (+ `chatProgressMonitor.test.ts`,
  10/10) — the load-bearing test proves a 50-round productive run never trips.
- **Executor:** `chatSessionExecutor.ts` — removed the turn deadline + `maxTurns`
  bound, raised `maxToolCalls` default to 80, instantiates the monitor, records
  each tool round, emits `stopReasonMessage` on a pathology. Removed dead deadline
  constants/functions.
- **Confirmation:** `chatToolExecutor.ts` — `requiresConfirmation(name, mode)`.
- **Shared:** `chatPermissionMode.ts` — `parseModeCommand`, `MODE_SWITCH_ACK`,
  `defaultTaskForMode`, `PLAN_MODE_SYSTEM_ADDENDUM` (moved out of the route).
- **Route:** `conversations.ts` — sticky-mode resolution + slash parsing in
  `streamConversationTurnReply`, `permissionMode` on `sendSchema`, new
  `POST /session/:id/mode` toggle endpoint.
- **Channels:** `channelTurnDispatcher.ts` — slash mode switch + ack, reads/persists
  the conversation's sticky mode, injects plan addendum. Tests 10/10 green.
- **Web:** `PermissionModePicker.tsx` + `ThreadView.tsx` (composer footer, sticky
  state, send-body + endpoint persistence). Verified live: picker renders
  Ask/Plan/Auto, toggling updates selection + localStorage, server call fires once
  a conversation exists.
- **Verification:** api/web/db/core typecheck clean; chatSessionExecutor 28/29
  (1 failure is **pre-existing** — the memory/brain context-budget test fails on
  the original source too), chat-tool suites 17/17, channel 10/10, monitor 10/10.

### Known follow-ups

- A build confirmed in **Ask** mode runs via `confirm()` which does not (yet)
  stream the live build narration the inline path does. Not a regression for the
  default flow (build is `autoExecute` → no confirm in Ask), only for a future
  non-`autoExecute` build behind confirmation. Bridge `#streamBuildNarration` into
  `confirm()` when that case appears.
