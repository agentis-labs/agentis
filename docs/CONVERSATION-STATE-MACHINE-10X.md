# Conversation State Machine + Plan-First Apps (10x)

> Operator stress test: a persistent WhatsApp outbound-sales specialist — find ICP
> stores, message them on a staged script (deterministic greeting → personalized
> pitch → classify the reply → on a "yes" run the store factory → deliver → **stop**).
> The point is to fix the *class* of capability so **every** conversational, multi-part
> App is buildable, using this app as the acceptance test.

See the gap analysis in `.claude/plans/fluffy-wandering-crown.md`. The App *substrate*
was already strong (multi-workflow chaining, a resident cast, an enforced outbound
envelope, mature WhatsApp transport). What was missing was the **runtime + authoring
layer** that turns that substrate into a living, conversational, multi-stage worker.

## What shipped

### 1. The keystone — a per-contact Conversation State Machine (GAP B1/B3)
The `wait` node is a timer only; listeners *start* runs but never *resume* a parked
per-contact one; inbound always landed as a fresh full agent turn. So "send → await
THEIR reply → branch → run a workflow → resume → stop" could not be expressed. Now it
is a **declarative script** the channel dispatcher advances automatically:

- **Schema** — `packages/core/src/types/conversationScript.ts`: stages with an `entry`
  (`send_deterministic` = templated, ZERO tokens, `{greeting}`+`{facts.x}`; `send_agent`
  = a small model composes one message; `run_workflow` = trigger + rest until it
  completes; `none`) and a transition (`onReply`: `goto` | `classify`→branches;
  `onComplete`: `goto`; `terminal`). References are validated (no dangling stages).
- **Runtime** — `apps/api/src/services/conversationRuntime.ts`: the pure interpreter
  (`enroll` / `onInbound` / `onWorkflowComplete`). All side effects injected → unit-tested
  in isolation. Cost discipline is structural: only `send_agent`/`classify` call a model.
- **Service** — `apps/api/src/services/conversationService.ts`: binds the runtime to the
  App datastore (script in `conversation_script`, one record per contact in the script's
  `contactCollection` — render-ready for a DataBoard, survives restarts, no new tables),
  the channel bridge (deterministic sends), a small-model completer, and the engine.
- **Wiring** — agent tools `agentis.conversation.define` / `.enroll`; a dispatcher hook
  (`channelTurnDispatcher.#executeTurn`) that offers each inbound to the script FIRST and,
  when a script owns the contact, advances the stage and does NOT run an agent turn; and a
  bus `RUN_COMPLETED` subscription that wakes a `run_workflow` contact when its build
  finishes (App resolved from `workflow.appId`, contact by `awaitingRunId`).

Net: msg1 = a deterministic timed greeting (**zero tokens**); await-reply is implicit
(the next inbound advances the stage); msg2 = a small-model pitch; a positive classify
triggers the build workflow and rests; the build's completion delivers msg3; a `terminal`
stage stops — and a stopped contact stays silent (owned, never falls through to an agent).

### 2. Plan-first decomposition (GAP A1/B4)
`build_workflow` builds ONE workflow and the doctrine said "build immediately", so the
agent produced one giant workflow instead of an App of parts. New `agentis.app.plan`
(`apps/api/src/services/agentisToolHandlers/appPlan.ts`) makes the agent ENUMERATE the
parts (workflows with `dependsOn`, whether it needs a conversation script, collections,
cast, outbound policy), ensures the App shell, applies the policy, records the blueprint,
and returns an **ordered build checklist** (dependency-respecting). Doctrine added to
`orchestratorPrompt.ts`: PLAN-FIRST for multi-part/conversational/recurring intents, and
"per-contact outreach is a SCRIPT, not a workflow".

### 3. Deferred (documented) — a standalone `channel` node (part of B2)
B2's essence, a token-free deterministic send, is delivered by the runtime's
`send_deterministic`. A standalone `channel` *workflow node* would need the ChannelBridge
wired into `WorkflowEngine` deps + a new node kind (~6 canvas/validate points) — engine
surgery with regression risk and no benefit to this app. Left as a follow-up.

## Verification
- `conversationRuntime.test.ts` — **10/10**: every stage kind + transition, and the cost
  guarantee (enroll's greeting spends ZERO model calls; classify branches; terminal stops
  stay silent; unknown label rests; failed build clears the wait).
- `conversationService.test.ts` — **3/3** integration over the REAL datastore: collections
  auto-create, script/contacts persist + reload, a `run_workflow` stage inserts a real run
  row, and the run-complete hook resolves the App and wakes the right contact through the
  whole funnel greet→pitch→build→deliver(stop).
- `appPlan.test.ts` — **3/3**: dependency-respecting order (no hang on cycles/unknown deps).
- `channelTurnDispatcher.test.ts` — **12/12** unchanged (the hook is inert without a script).
- API + core + web typecheck: **0 errors**.

## How to use it (the sales desk)
1. `agentis.app.plan { intent, workflows:[find, build], conversation:true, policy:{ quietHours, maxPerHour } }`
   → creates the App + an ordered checklist.
2. Build `find` + `build` workflows (SWIFT-verify each).
3. `agentis.conversation.define { appId, script }` — greet(send_deterministic "Oi, {greeting}")
   → pitch(send_agent) → qualify(classify positive/negative) → build(run_workflow → onComplete deliver)
   → deliver(send_agent, terminal) / closed(terminal).
4. `agentis.conversation.enroll { appId, address, facts }` per ICP store → the greeting goes
   out; every reply advances the contact automatically; on "yes" the factory runs and its
   completion delivers the store; then it stops.

⚠️ Needs an API restart to load the new tools + dispatcher hook + bus subscription.

## Implementation log
- **2026-07-06 — SHIPPED.** Core schema + runtime + service + tools + dispatcher hook +
  bus RUN_COMPLETED subscription + `app.plan` + orchestrator doctrine. Tests: runtime 10,
  service 3, appPlan 3; dispatcher 12 unchanged; typecheck 0. `channel` node deferred.
