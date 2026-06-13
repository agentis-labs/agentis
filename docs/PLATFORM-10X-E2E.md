# Agentis Platform 10x — End-to-End Build → Run → Deliver

> **Principle.** Agentis is a **domain-agnostic** automation platform. Every workflow — email, Slack, CRM, scraping, multi-agent research, anything — must: (1) **actually execute the real action** (never "complete" by emitting dead JSON), (2) show **live, progressive feedback** in a great UI (never blank-until-done), and (3) ask for missing setup in **intelligent plain language** (never rigid formats, never a connector special-case). **Nothing is hardcoded per use-case.** If a fix only helps "email workflows," it is the wrong fix.

This document is the reconciled, evidence-based plan. Each finding cites real code. It marks what shipped vs. what remains, with exact files.

---

## The four failures we are eliminating

From a real session ("email Robson" — used as a *platform test*, not a goal):
1. **Created duplicate workflows** — a "revise" spawned a twin instead of patching.
2. **Blank until done** — no realtime: canvas/chat showed nothing during build, then "done."
3. **Output was code, not the action** — the workflow "finished" but no message was sent.
4. **Dumb asks** — it expected rigid input ("email format") instead of conversing like an AI.

And a meta-failure: a prior fix **hardcoded an email workflow** (`compileFixedMessageEmailWorkflow`) and an **email-only approval preview**. Both are now deleted/generalized.

---

## Findings (evidence)

| # | Finding | Evidence |
|---|---------|----------|
| F1 | **Duplicate creation** has a general fix already: a per-conversation/MCP **latch** binds a build session to one workflow id so a re-build patches in place. | `buildWorkflowLatchKey` + `lastWorkflowByConversation` ([build.ts:27-42](apps/api/src/services/agentisToolHandlers/build.ts)) |
| F2 | **The backend already streams rich build events** (phases, repairs, critiques, node-by-node animation with `sleep(120)`, team roster) to the **workspace + workflow + run** rooms. So "blank until done" is a **delivery/subscription** problem, not missing events. | `publishCanvas` ([build.ts:1301-1313](apps/api/src/services/agentisToolHandlers/build.ts)); `phase(...)` calls; `WORKFLOW_BUILD_PHASE`/`_REPAIR`/`_CRITIQUE`/`AGENT_WORK_STEP` |
| F3 | **Realtime silently never connected in local dev.** The socket URL resolver only redirected `127.0.0.1:5173 → :3737`. Opening the app at **`localhost:5173`** fell through to the page origin (Vite), so socket.io connected to Vite and received **zero** events. | `realtimeUrl()` ([realtime.ts:16-26](apps/web/src/lib/realtime.ts)) |
| F4 | **Integrations do fail on missing credentials** (manifest connectors throw `INTEGRATION_CREDENTIAL_MISSING`; AgentMail uses `AGENTMAIL_API_KEY` env fallback). So a send without setup doesn't silently "succeed" — but the run **paused at the approval checkpoint before the send**, and the approval wasn't surfaced, so it never ran. | `manifestHttp.ts:83`; `apiConnectors.ts:154`; `#executeIntegration` ([WorkflowEngine.ts:2904-2944](apps/api/src/engine/WorkflowEngine.ts)) |
| F5 | **Nothing told the operator, in plain language, what setup was needed** before they hit the wall. | (absence) |
| F6 | **Hardcoding to remove:** an email-specific deterministic compiler and an email-specific approval preview. | `compileFixedMessageEmailWorkflow` (build.ts, removed); `checkpointEmailPreview`/`EMAIL_DELIVERY_INTEGRATIONS` (WorkflowEngine.ts, removed) |

---

## Shipped (this work, verified)

- **De-hardcoded the platform.**
  - Removed `compileFixedMessageEmailWorkflow` + `extractEmailBody`; the deterministic dispatch now carries an explicit *no connector-specific compiler* contract ([build.ts `tryCompileDeterministicWorkflow`](apps/api/src/services/agentisToolHandlers/build.ts)). Email/Slack/HTTP/etc. all go through the same general synthesis.
  - Generalized the checkpoint approval preview: `checkpointApprovalCopy` now previews **any** guarded downstream action (integration / http_request / agent) via `checkpointGuardedAction` ([WorkflowEngine.ts](apps/api/src/engine/WorkflowEngine.ts)). Removed `EMAIL_DELIVERY_INTEGRATIONS`, `checkpointEmailPreview`, `deliveryServiceLabel`.
  - Tests updated to assert **general** behavior (not email). `createWorkflowDelivery`, `agentisChatTools`, `WorkflowEngine.newNodes` green.
- **Realtime actually connects in dev (F3).** `realtimeUrl()` now redirects to the API port for **any** local/LAN host on the Vite port (`localhost`, `127.0.0.1`, LAN IP), overridable via `VITE_AGENTIS_API_PORT`. This is the most likely cause of "nothing shows in realtime." Web typecheck clean.
- **General, plain-language setup readiness (F5).** New [`workflowReadiness.ts`](apps/api/src/services/workflowReadiness.ts) — connector-agnostic `analyzeWorkflowReadiness(db, workspaceId, graph)` returns `{ ready, requirements[], summary }` in natural language ("Connect your <X> account so the '<step>' step can run."). An integration is satisfied by a node credential, a workspace credential of that type, or a conventional `<SLUG>_API_KEY` env fallback. Wired into:
  - the **build result** (`readiness` field) so the orchestrator can relay it;
  - `GET /v1/workflows/:id/readiness`;
  - the `build_workflow` tool **description** instructs the orchestrator to ask in plain language (never rigid formats).
  - 6 unit tests green.

---

## Plan (remaining — needs the running app to verify visually)

### P-A · Realtime progressive build/run handoff (the marquee UX)
Now that the socket connects (F3), make the experience unmissable:
- **On build start**, take the operator to the live canvas (or a prominent inline live trace). The components exist (`LiveActivityTrace`, `WorkflowBuildTimeline`, `StickyBuildBanner`, `ChatCanvasPreview`, `CanvasNarration`); ensure the chat opens/links to the canvas the moment `WORKFLOW_BUILD_PHASE` for a new workflow arrives — not only on the final result.
- **Verify the canvas subscribes** to the workflow + workspace rooms and renders nodes as they animate in (empty-graph-first is already emitted).
- **Run feedback:** ensure node status transitions stream to the canvas + a run timeline (no black screen). Confirm the run drawer reads the real ledger/scratchpad shapes.
- *Watch-out:* `publishCanvas` also targets `conversation(agentId)` — verify the web subscribes by the right key (workspace room is the reliable channel; conversationId is often absent under MCP builds).

### P-B · Approval as a conversation, not a form (fixes "dumb asks" + the unran send)
- Surface a pending checkpoint as a **rich, actionable card in chat AND on the canvas node**, using the now-generic `checkpointApprovalCopy` ("Approve running Send Email (agentmail). to: …"). One click approves/rejects; the run resumes.
- When a checkpoint guards a step that **isn't ready** (per `workflowReadiness`), the card should offer **"Connect <X>"** inline instead of a dead end.

### P-C · Execute-for-real + setup gating
- At run start, run `analyzeWorkflowReadiness`; if not ready, **pause with a natural-language setup request** (and a connect affordance) instead of letting the run reach a step that 401s. Resume automatically once connected.
- Map connector `INTEGRATION_CREDENTIAL_MISSING` / auth errors to the same plain-language "Connect your <X> account" copy at runtime.

### P-D · Result & error surfacing
- A completed run shows its **real output** appropriately (a sent message confirmation, an artifact, a table) — `return_output.renderAs` should drive a human view, not raw JSON by default.
- Failures surface the **real** adapter/connector error in plain language, never a generic "I didn't produce a reply."

### P-E · Intelligent clarification during creation
- When the build needs info it can't infer, the orchestrator asks **conversationally** (it already receives `readiness`; extend to ambiguous inputs). Never demand formats.

---

## Implementation Log

### 2026-06-05 — De-hardcode + readiness + realtime dev fix
- Deleted email-specific compiler; generalized approval preview to any downstream action. Tests de-emailed and green.
- Added connector-agnostic `workflowReadiness` (NL setup requirements) + `/readiness` endpoint + build-result `readiness` + orchestrator NL guidance. 6 tests green. API `tsc` clean.
- Fixed realtime socket URL for `localhost`/LAN on the Vite dev port (was 127.0.0.1-only) — the likely root of "no realtime." Web `tsc` clean.
- **Pre-existing failure (not from this work):** `tests/services/chatGoldenPath.test.ts` fails in the working tree (build-pipeline mid-refactor); it fails with my changes stashed too. Flag for the build-pipeline refactor.
- **Next:** P-A realtime handoff + P-B approval-as-conversation are the highest-impact visible wins; both need the running app to verify.

### 2026-06-05 — P-A realtime handoff + P-B approval-as-conversation — ✅ SHIPPED & browser-verified

- **Golden-path failure fixed (root cause).** `buildingAgentCompleter` called `deps.adapters?.get` which threw when `adapters` was a partial stub; guarded with a `typeof … === 'function'` check ([build.ts](apps/api/src/services/agentisToolHandlers/build.ts)). Rewrote the stale test to validate the real deterministic build fast-path (no model round-trip). Green.
- **P-A · Realtime build→canvas handoff.**
  - *Open canvas on build START:* ThreadView now navigates on the first `CANVAS_NODE_PLACED` (the empty graph is already persisted by then), not only `CANVAS_BUILD_COMPLETE` — the operator watches construction live. ([ThreadView.tsx](apps/web/src/components/chat/ThreadView.tsx))
  - *No black screen on run:* the canvas now subscribes to the **run room** when `activeRunId` is set — `NODE_STARTED/COMPLETED/FAILED/WAITING` publish there, not the workspace room, so live per-node status finally arrives. ([WorkflowCanvasPage.tsx](apps/web/src/pages/WorkflowCanvasPage.tsx))
  - These build on the earlier socket-URL fix (the actual root of "no realtime" in local dev).
- **P-B · Approval-as-conversation.** New [`ChatApprovalStrip`](apps/web/src/components/chat/ChatApprovalStrip.tsx) renders pending approvals as rich, one-click cards above the composer (live via `useWorkspaceData().approvals`), using the engine's generic `checkpointApprovalCopy` summary; Approve/Reject → `/v1/approvals/:id/resolve`, run resumes.
- **Browser-verified (Claude Preview, local-bypass auth, no model — deterministic fast-path):**
  1. Chat "build a hello world workflow" → UI **navigated live to `/workflows/<id>`** with the built graph + Realtime monitor.
  2. **Test run → Run** → completed in 112ms, canvas showed **"Return Output [TEXT]: Workflow is working"** (human output, not raw JSON, no black screen).
  3. Ran a `trigger→checkpoint→return_output` workflow → **"Approval needed — AWAITING YOU"** card appeared in chat → **Approve & run** → card cleared, pending count 0, run resumed.
- **Tests:** `chatGoldenPath` rewritten + green; `ChatApprovalStrip` component test; API + web `tsc` clean. Pre-existing `WorkspaceEcosystemCanvas` web errors are unrelated.
- **Still open (P-C/D/E):** run-start setup gating with connect-inline, runtime credential-error → NL copy, and conversational clarification for ambiguous builds.
