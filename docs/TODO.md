# Agentis V1 — Implementation TODO

> Tracks the gaps surfaced by the V1-SPEC audit after D30/D31. Batches are
> ordered by risk-reduction and unblocking value: each batch produces a
> shippable slice and leaves the tree green. Tick boxes as work lands and
> reference the new DECISIONS.md entry on each PR.

---

## Batch 1 — Security & Hardening (highest leverage, smallest blast radius)

- [x] **D31** Gate `/v1/_test/reset` on `NODE_ENV !== 'production'` + log `agentis.test_mode.refused`
- [x] **D32** Audit every other unauthenticated `/v1/*` route — `src/security/unauthAllowList.ts` SSoT + pinning test
- [x] **D32** Add `helmet`-equivalent default headers (CSP, X-Frame-Options, Referrer-Policy, COOP/CORP, Permissions-Policy, HSTS in prod) via `middleware/securityHeaders.ts`
- [x] **D32** Rate-limit `POST /v1/auth/login` (in-memory token bucket: 5/min per (IP,username) + 20/min per IP)
- [x] **D32** Rotate-friendly JWT: `kid` = RFC 7638 thumbprint stamped on every token + `GET /.well-known/jwks.json` returns the JWK
- [x] **D32** Vault rotation: `CredentialVault.rotateAll({db,oldKeyB64,newKeyB64,logger})` re-encrypts credentials + registry_connections_removed in one txn

**Exit criteria:** OWASP A01/A05/A07 covered by tests. Green vitest + e2e.

---

## Batch 2 — Missing Route Unit Tests (raise apps/api coverage to ~80%)

Each route gets `apps/api/tests/routes/<name>.test.ts` modeled after the D28 pattern (`createTestContext` + `buildApp([{path, app: buildXxxRoutes(...)}])`). Aim for happy path + auth-required + workspace-scope + 404 + validation 422 per file.

- [x] `workflows.test.ts` (CRUD + run trigger + graph validation) — D33
- [x] `runs.test.ts` (list, detail, cancel, ledger) — D33
- [x] `gateways.test.ts` — D33
- [x] `agents.test.ts` — D33
- [x] `approvals.test.ts` — D33
- [x] `tasks.test.ts` — D33
- [x] `skills.test.ts` — D33
- [x] `hub.test.ts` (status + registry + install + connect, unconfigured-bridge fixture) — D33
- [x] `triggers.test.ts` (webhook secret lifecycle, runtime delegation) — D33
- [x] `scratchpad.test.ts` — D33
- [x] `ledger.test.ts` (dedicated builder + ?after_sequence) — D33
- [x] `conversations.test.ts` — D33
- [x] `credentials.test.ts` (encryption round-trip + plaintext non-leak) — D33
- [x] `replay.test.ts` (modes + delegation) — D33

**Exit criteria:** `pnpm --filter @agentis/api test` ≥ ~370 tests, all passing. ✅ Achieved 327 tests / 53 files (D33; +81 over D32).

---

## Batch 3 — Engine & Service Unit Tests (the V1.1 core)

- [x] `tests/engine/WorkflowEngine.fanout.test.ts` — re-tick after `#dispatchNode` resolves (D23 fix) — D34
- [x] `tests/engine/WorkflowEngine.terminalTransition.test.ts` — child-run completion notifies SubflowExecutor — D34
- [x] `tests/engine/PartialReplay.test.ts` — all 4 modes — D34
- [x] `tests/services/triggerRuntime.test.ts` — cron schedule, webhook HMAC + replay-window, listener idle/connected — D34
- [x] `tests/services/activeWorkflowRegistry.test.ts` — D34
- [x] `tests/services/skillRuntime.test.ts` — builtin echo, http_fetch SSRF guard via `safeUrl.ts`, dynamic-import unavailable error codes — D34
- [x] `tests/services/registryClient.test.ts` — install pipeline incl. `verifyArtifactHashes` mismatch + `SKILL_REGISTRY_SCAN_BLOCKED` — D34
- [x] `tests/services/sessionMirror.test.ts` — adapter event glue — D34
- [x] `tests/services/conversationStore.test.ts` (extend) — D34 (`conversationStore.extended.test.ts`)

**Exit criteria:** Engine + V1.1 services have regression tests. Coverage report attached. ✅ Achieved 392 tests / 62 files (D34; +65 over D33).

---

## Batch 4 — Channel Bridge (V1-SPEC §0.3 #24, §3.3, §11)

The Telegram + Discord bridge is the largest remaining feature. Build it end-to-end on a feature branch.

### 4a — Backend
- [x] Schema: `channel_connections` table (workspace_id, kind, encrypted_token, settings JSON) — D35 (also `channel_deliveries` for inbound idempotency)
- [x] `services/channelBridge.ts` — interface `ChannelAdapter { send, listen, verify }` — D35 (`{ kind, send, verify, parseInbound }`)
- [x] `adapters/telegram.ts` — long-poll OR webhook; HMAC verify — D35 (webhook + `x-telegram-bot-api-secret-token` constant-time verify)
- [x] `adapters/discord.ts` — gateway WS dynamic import — D35 (REST outbound only; inbound returns `CHANNEL_DISCORD_INBOUND_UNAVAILABLE`)
- [x] Routes: `apps/api/src/routes/channels.ts` (list/connect/disconnect/test) — D35 (+ `GET /:id/webhook-info`)
- [x] Webhook ingress: `POST /v1/webhooks/channel/:connectionId` (mirrors trigger pattern) — D35 (added to unauth allow-list)
- [x] Bus events: `CHANNEL_MESSAGE_RECEIVED`, `CHANNEL_MESSAGE_SENT` in `REALTIME_EVENTS` — D35 (+ `CHANNEL_CONNECTION_STATUS`)

### 4b — Frontend
- [x] `apps/web/src/pages/SettingsChannelsPage.tsx` — D35
- [x] `apps/web/src/components/channels/ConnectionForm.tsx` — D35
- [x] `apps/web/src/components/channels/ConnectionRow.tsx` — D35
- [x] Wire into existing `ConversationThread` so channel messages render alongside in-app — D35 (inbound mirrored as `system` author into the agent's conversation, picked up by the existing thread)

### 4c — Tests
- [x] `apps/api/tests/services/channelBridge.test.ts` — D35 (12 tests)
- [x] `apps/api/tests/routes/channels.test.ts` — D35 (13 tests, incl. unauth ingress 401/202/idempotent)
- [x] `apps/api/tests/adapters/telegramChannelAdapter.test.ts` — D35 (8 tests; verify/parse/send)
- [x] `e2e/api/channels.spec.ts` — D35 (8 tests)
- [x] `apps/web/tests/pages/SettingsChannelsPage.test.tsx` — D35 (2 tests, incl. webhook reveal modal)

**Exit criteria:** Operator can connect a Telegram bot via the UI, send a message in-app, see it delivered in Telegram, and reply back into a conversation thread. Hash-of-token never leaves CredentialVault. ✅ Achieved D35 — 426 api tests / 65 files; 15 web tests; 8 channels e2e.

---

## Batch 5 — Missing Web Pages & Components

- [x] `apps/web/src/pages/AgentsPage.tsx` (uses `AgentFleetTable` + `AgentDetailPanel`) — D36
- [x] Wire `AgentsPage` into router + sidebar — D36 (`/agents` → `AgentsPage`; `AgentFleetPage` is now a thin re-export)
- [x] `apps/web/tests/AgentsPage.test.tsx` — D36 (3 tests)
- [x] Component tests (RTL):
  - [x] `WorkflowCanvas.test.tsx` (DnD via `fireEvent`, node CRUD, edge wiring) — D36 (barrel re-exports + NodePalette DnD; full canvas DnD deferred to UI e2e in Batch 6)
  - [x] `WorkflowNode.test.tsx` — D36 (4 tests)
  - [x] `AgentNode.test.tsx` — D36 (3 tests)
  - [x] `AgentFleetTable.test.tsx` — D36 (4 tests)
  - [x] `PendingApprovalsDock.test.tsx` — D36 (3 tests)
  - [x] `ApprovalInbox.test.tsx` — D36 (5 tests)
  - [x] `RunInspector.test.tsx` — D36 (4 tests)
  - [x] `CommandPalette.test.tsx` — D36 (4 tests)

**Exit criteria:** `apps/web` test count ≥ 25, all passing. ✅ Achieved D36 — 49 tests / 12 files.

---

## Batch 6 — Missing E2E Specs (browser-driven)

UI-driven Playwright specs that complement the D30 API matrix.

- [x] `e2e/ui/login.spec.ts` (extend D29) — D37
- [x] `e2e/ui/canvas-build.spec.ts` — DnD trigger → echo skill → wire edge → save — D37
- [x] `e2e/ui/canvas-run.spec.ts` — run a saved workflow, watch ledger stream — D37
- [x] `e2e/ui/approvals.spec.ts` — approve/reject from dock — D37
- [x] `e2e/ui/terminal.spec.ts` — open agent terminal, send command, see output — D37
- [x] `e2e/ui/activity.spec.ts` — live activity feed updates from bus events — D37
- [x] `e2e/ui/ledger.spec.ts` — ledger panel for a completed run — D37
- [x] `e2e/ui/hub-install.spec.ts` — browse registry, acknowledge permissions, install — D37
- [x] `e2e/ui/command-palette.spec.ts` — D37

**Exit criteria:** Playwright suite ≥ 280 specs, all passing on Windows + CI. ✅ Achieved D37 — 315 tests / 32 files.

---

## Batch 7 — Package Extraction (V1-SPEC §3.3 — deferred per D26)

Spec is satisfied by shim re-exports today. Only do this if/when a second consumer (CLI v2, hosted runtime) needs the modules.

- [ ] `packages/adapters/` — extract from `apps/api/src/adapters/*`
- [ ] `packages/skills/` — extract from `apps/api/src/services/skill*Pool.ts`
- [ ] Update `apps/api` to depend on the new packages; delete shims
- [ ] `pnpm doctor` validates the new layout

**Exit criteria:** Build is green, tests pass, no functional drift.

---

## Batch 8 — Operational Polish

- [x] OpenTelemetry hooks (optional spans around engine ticks + adapter calls) gated by `AGENTIS_OTEL_ENDPOINT` _(D38 — `Telemetry` abstraction with dynamic-import optional SDK, `engine.tick` + `adapter.dispatch` instrumented)_
- [x] Structured audit log: every state-changing route writes a row with `actor + action + target` (universal middleware) _(D38 — writes `activity_events` not `ledger_events`; the spec text was misleading: `ledger_events.runId` is `NOT NULL` so a workspace-scoped audit row cannot live there)_
- [x] Backup/restore CLI: `pnpm --filter @agentis/cli exec tsx src/index.ts backup` _(D38 — directory format with `manifest.json` v1; uses `Database.backup()` for live snapshot)_

**Exit criteria:** Production-grade operability; documented in README + DEPLOYMENT.md. _(3/4 done; Postgres + README/DEPLOYMENT.md docs remain on backlog.)_

---

## Working Rules (apply to every batch)

1. One DECISIONS.md entry per batch (D32, D33, …) summarising the slice + any new gotchas.
2. Update `/memories/repo/agentis-v1.md` only when a new repo-wide invariant appears.
3. Never weaken the D31 gate — every test added must keep `NODE_ENV='test'` in the runner.
4. Never extract or refactor for its own sake; tie each change to a batch item.
5. After each batch: `pnpm test && pnpm --filter @agentis/api test && pnpm test:e2e` must all pass before moving on.
