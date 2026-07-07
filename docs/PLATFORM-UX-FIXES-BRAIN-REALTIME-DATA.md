# Platform UX fixes: App Brain · Realtime creations · Data page

Three operator-reported gaps, fixed. Plan + diagnosis in `.claude/plans/fluffy-wandering-crown.md`.

## Fix 3 — App Data page = a real Supabase-like editor
`DataFacet` (`apps/web/src/pages/AppEditorPage.tsx`) was a stub — it listed collection *name cards* and never fetched records. The API already had full record CRUD. New `apps/web/src/components/apps/AppDataGrid.tsx`: a collections left-rail + an editable record grid (query endpoint, keyset-paginated, values via the `format` kit), inline **Insert / edit-row drawer / delete**, and **live refetch on `DATA_CHANGED`** (dual-published to the workspace room already) so records appear as agents/runs write them. Added `appsApi.insertRecord/updateRecord/deleteRecord`. Assets kept via a "Records | Assets" toggle. The `ConversationService` datastore now passes the bus, so contacts advancing through the pipeline show live.

## Fix 2 — Realtime: SEE what agents create (esp. inside agent_tasks/apps)
Priority was seeing concrete creations, not text. New `publishAgentCreation` (`agentWorkProgress.ts`) emits a structured creation as an `AGENT_WORK_STEP` (`{ creationKind, title, count, collection, ref }`) to the workspace room + the run room, with a concrete description ("Wrote 12 records → leads"). `realtimeActivity.ts` renders a `creation` payload as a distinct success item (kind `tool`, the creation label + ref). Wired at the datastore write tools (`agentis.data.insert/upsert/define_collection` in `appData.ts`) — the highest-value "creations inside an app". So the chat/app/run feeds show the *products* an agent makes, live.
- **Already present (verified, no new code):** build auto-reveal — `AppEditorPage` `BUILD_REVEAL` effect selects the built workflow + switches to the Workflow facet to watch it stream node-by-node (2B); `RealtimeStatusIndicator` mounted in `App.tsx` surfaces `connecting/connected/fallback/disconnected` (2D). The approve **page** is already gone (approvals are modal-based).
- **Approvals (2C):** `ApprovalPreviewCard` now shows a compact "what will happen" chip row (action + record/asset/change counts) alongside the **Review** button (opens the rich decision-document modal); the global `openApprovalModal` lets any surface open it.

## Fix 1 — App Brain: make it demonstrably useful
It was wired (recall into App turns; `AppLearningsPanel`) but only learned from `app_contacts` outcomes via a route — nothing auto-fed it, so it looked dead. Now a **terminal conversation stage that declares an `outcome`** (`won`/`lost`/`abandoned`, new field on the script) deposits a graded lesson into the App owner's memory plane via new `AppLearningService.recordConversationOutcome` (reuses the deposit + graduation path, no `app_contacts` row). Wired through `conversationRuntime` (a `recordOutcome` dep on terminal stages) → `conversationService` (`learning` dep) → bootstrap. So an outreach App's Brain fills with real "what closed / what didn't", recalled into future turns and shown in the Brain facet (same `m2_lesson` + `app:<id>` tags the panel already reads).

## Verification
- Typecheck: **core / api / web = 0 errors** (3 pre-existing storage-WIP untouched).
- Tests: `conversationRuntime` **11/11** (new terminal-outcome → Brain test), `conversationService` **3/3**, `appLearning` **5/5**, `channelTurnDispatcher` **12/12** unchanged.
- ⚠️ Needs an API restart. Live visual verification of the Data grid needs a running stack + an App with collections (e.g. the sales-desk App's `contacts`).

## Follow-ups (noted, not done)
- Emit `publishAgentCreation` from asset saves (`assets.ts`) + `data_mutate` engine nodes for full creation coverage.
- Global-chat build auto-open (navigate to the App/canvas when a build starts from anywhere, not only when already on the App page).
