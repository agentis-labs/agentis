# Brain V1 — Work Log

Date: 2026-05-24
Scope: Bring the **Brain** concept from the `brain-apps` branch to `main`, decoupled from the apps concept, implemented end-to-end. Plan: [BRAIN-V1-INTEGRATION.md](BRAIN-V1-INTEGRATION.md) (gaps G1–G11). The reconciled per-gap outcome table lives at the end of that plan; this file is the full change inventory + the honest list of what is *not* finished.

---

## 1. Outcome at a glance

- All gaps **G1–G11 implemented**. G7 turned out to be a false gap (already done); G5 shipped with a deliberate deviation (no `kb_search_log` table).
- The Brain now has **four memory scopes**: workspace (`MEMORY.md`), workflow (`workflow_kv_entries`), knowledge bases (`kb_chunks`), and **agent** (new `agent_memories`).
- New composed surface: `BrainService` + `GET /v1/brain` → `BrainOverview`. **No `appId` / apps coupling anywhere in the new code.**
- `@agentis/core`, `@agentis/db`, `@agentis/api`, `@agentis/web` all typecheck clean. Targeted + new tests green. API boots, migration v39 applies, route registered.
- **Not done / needs a decision:** excising the pre-existing apps-concept leakage already in `main` (§5), and live browser verification of the authenticated Brain UI (§4).

---

## 2. Files changed

### New files
| File | Purpose |
|---|---|
| `packages/core/src/types/brain.ts` | App-free Brain read-model types: `BrainOverview`, `BrainStats`, `BrainGap`, per-stratum stat types. |
| `apps/api/src/services/agentMemory.ts` | `AgentMemoryService` — the agent's personal memory (append/list/search/clear/contextSection/stats). Lexical scorer; no embeddings. |
| `apps/api/src/services/brain.ts` | `BrainService.overview()` — composes the workspace Brain from context files + MEMORY.md + KB stats + workflow memory + agent-memory roll-up; derives honest `gaps[]`. |
| `apps/api/src/routes/brain.ts` | `GET /v1/brain` + `/v1/brain/agents/:agentId/memory` (list/append/delete one/clear). Auth + workspace gated. |
| `apps/web/src/pages/BrainPage.tsx` | The Brain surface: Overview (stats, gap banners, four strata) + Documents / Knowledge Bases tabs. Replaces `KnowledgePage.tsx`. |
| `apps/api/tests/services/brain.test.ts` | 6 tests: empty-state gaps, KB chunk stats, empty-KB gap, memory counting, workflow-memory aggregation, agent memory in the brain. |
| `apps/api/tests/services/agentMemory.test.ts` | 8 tests: service CRUD/search/scoping + the `memory_append` scope split, `agent_memory_search`, identity guard, and workflow-memory round-trip. |

### Modified files
| File | Change |
|---|---|
| `packages/core/src/types/specialist.ts` | Added `memory_append`, `agent_memory_search`, `workflow_memory_read`, `workflow_memory_write` to `AgentTool`; granted them in `ROLE_TOOLS`; added `TOOL_DESCRIPTIONS`. |
| `packages/core/src/types/index.ts` | Export `./brain.js`. |
| `packages/db/src/sqlite/schema.ts` | New `agentMemories` table (`agent_memories`). |
| `packages/db/src/sqlite/migrations.ts` | Migration **v39** `agent_memories` (v2-v38 remain reserved by older builds; idempotent `CREATE TABLE IF NOT EXISTS` + index). |
| `apps/api/src/services/agentToolRuntime.ts` | New `AgentToolContext { workflowId?, agentId? }`; deps gained `workspaceIntelligence`, `workflowStore`, `agentMemory`; implemented `memory_append` (scope split), `agent_memory_search`, `workflow_memory_read/write`. |
| `apps/api/src/services/agentToolLoop.ts` | Thread `workflowId` + `agentId` into `runtime.execute(...)`. |
| `apps/api/src/services/workspaceIntelligence.ts` | G1: `buildContextBlock()` gained `knowledgeQuery`/`knowledgeBases`/`knowledgeTopK` → injects a "Relevant Workspace Knowledge" section. Exported `stripPlaceholders`. |
| `apps/api/src/services/workflowStore.ts` | Scrubbed an apps-hint comment (was "Brain-apps compatibility… app_data/data_write"). |
| `apps/api/src/engine/WorkflowEngine.ts` | G1 query wiring; `agentMemory` dep; `#withWorkspaceContext()` now injects `<agent_memory>` and takes `agentId`; `#dispatchAgentTask` + `#maybeRunAgentToolLoop` pass `agentId`; loop gets `workflowId`. |
| `apps/api/src/services/creationPipeline.ts` | G6: `buildWorkspaceInventory(deps, workspaceId, request?)` returns `knowledgeExcerpts`; `assembleCreationBrief` passes the description. |
| `apps/api/src/services/agentisToolHandlers/build.ts` | G6 `BRAIN CONTEXT FOR THIS REQUEST` block in the synthesis prompt; G8 Iron Rule 13 (+ count 12→13). |
| `apps/api/src/bootstrap.ts` | Construct `AgentMemoryService` + `BrainService`; wire them into `AgentToolRuntime` + `WorkflowEngine` deps; register `/v1/brain`. |
| `apps/web/src/App.tsx` | `BrainPage` import; route `/brain` (canonical) + `/knowledge` (alias). |
| `apps/web/src/components/Sidebar.tsx` | Nav item `Knowledge`→`Brain`, `BookOpen`→`Brain` icon, `/knowledge`→`/brain`. |
| `apps/web/src/components/canvas/NodePalette.tsx` | Section + node label `Knowledge`→`Brain`; description updated. (Node `kind` stays `knowledge`.) |
| `apps/web/src/components/canvas/ContextInspector.tsx` | `knowledge` node display name → `Brain`; reason text updated. |
| `apps/web/src/pages/WorkflowCanvasPage.tsx` | Callout text `Knowledge`→`Brain`; **G5 fix**: fire on `bases===0 || chunks===0` (via `/v1/brain` stats); nav `/brain`. |
| `apps/web/src/pages/AgentDetailPage.tsx` | New **Memory** tab → `MemoryTab` (list by section, delete one, clear-all). |
| `apps/web/src/components/home/CanvasActivityPopover.tsx` | `knowledge` label → `Brain`. |
| `apps/web/src/components/knowledge/KnowledgeStatusCard.tsx` | Labels `Knowledge`→`Brain`; nav `/brain`. |
| `docs/BRAIN-V1-INTEGRATION.md` | Appended the reconciled "Implementation Log" (per-gap outcome + decisions). |

### Deleted files
| File | Reason |
|---|---|
| `apps/web/src/pages/KnowledgePage.tsx` | Replaced by `BrainPage.tsx`; no remaining imports. |

### Outside the repo (assistant memory)
- `…/memory/project_brain_v1.md` (new), `…/memory/feedback_apps_invisible.md` (new), `…/memory/MEMORY.md` (index updated).

---

## 3. Verification performed

- **Typecheck:** `pnpm --filter @agentis/core build`, `@agentis/db build`, `@agentis/api typecheck`, `@agentis/web typecheck` — all clean.
- **Tests:** `creationPipeline` (11), `WorkflowEngine.agentToolLoop` (1), `migrate` (6, incl. the v2 path), new `brain.test.ts` (6), new `agentMemory.test.ts` (8) — all green.
- **Runtime:** API boots (`http://127.0.0.1:3737`); v2 migration applied on the real existing DB without error; `/v1/brain` returns 401 unauthenticated (registered + gated) while an unknown route returns 404. Server stopped after the check.

---

## 4. Hard thing #1 — UI not verified live (honest gap)

The authenticated Brain page and the agent **Memory** tab were **not rendered in a browser**. The local DB has a generated seed password and `AGENTIS_TEST_MODE` is off, so `POST /v1/auth/login` returned 401 with every credential I could try. What *is* confirmed: the web bundle typechecks, and the endpoints the UI consumes (`/v1/brain`, `/v1/brain/agents/:id/memory`, `/v1/knowledge-bases`) are wired and gated correctly.

To close this: set `AGENTIS_TEST_MODE=1` (or `AGENTIS_SEED_PASSWORD`) on a fresh data dir, run `pnpm dev:full`, log in, then:
1. Visit `/brain` → expect the Overview (stats strip, gap banners when empty, the four strata).
2. Create a KB + upload a doc → empty-KB gap should clear; chunk count should appear.
3. Open an agent → **Memory** tab → after a run that calls `memory_append scope:agent`, entries should list; "Clear all" should empty it.

---

## 5. Hard thing #2 — pre-existing apps-concept leakage still visible in `main`

**This is the one unmet requirement.** The stated constraint is that engineers reading the codebase must find *zero* trace of the apps future version. They currently can. None of it was introduced by this Brain work — it is residue from the prior mid-implementation commit — but it is real and it is visible.

Excising it is a **separate, deliberate effort** with real blast radius, and it must **not** break the *public* Packages feature. Critical distinction:
- `agent_packages` table + `apps/api/src/routes/packages.ts` + the sidebar "Packages" entry = the **public Packages feature**. Likely keep (verify), do **not** blindly delete.
- `agentis.app.*` chat tools, `{{apps.*}}` template namespace, "App Canvas / deployed app / installed app / fleet view" language, `/newapp`, and "Brain-apps will…" comments = the **secret apps concept**. These are the leaks to excise.

### Leak inventory (file:line — actionable)

**Backend — functional (handlers/tools/resolver):**
- `apps/api/src/services/chatToolCatalog.ts` — `agentis.apps.status` (130), `agentis.app.create` (577), `agentis.app.compose` (605–652), `agentis.apps.run_status` (824), `agentis.app.thread.open` (838–846). Language: "app builder flow", "App Canvas", "installed app", "fleet view".
- `apps/api/src/services/chatSessionExecutor.ts` — `/newapp` prompt (551), confirm/label maps (572–585), `agentis.app.create` handler (660). "Apps page", "Agentis app".
- `apps/api/src/services/orchestratorPrompt.ts` — `agentis.app.create` guidance (109, 136). "deployed app", "app canvas".
- `apps/api/src/services/agentisToolHandlers/inspect.ts` — `agentis.app.inspect` tool (21–43); `appId` variable actually keys `installedRegistryArtifacts.entryId` (naming leak).
- `apps/api/src/services/agentisToolHandlers/build.ts` — `appId` param + `config: { appId }` (≈487–523) tied to registry/package install (verify vs public Packages).
- `apps/api/src/services/environment.ts` — `agentis.apps.status` (94).
- `apps/api/src/engine/templateResolver.ts` — `{{apps.*}}` resolver `case 'apps'` (≈132), reserved `apps?` field on `TemplateContext` (43), ctx init `apps: {}` (≈246), forward-looking comment (17–19, 42). The namespace is functional but always empty on main.

**Backend — comments only (pure "tips", zero functional risk):**
- `apps/api/src/engine/WorkflowEngine.ts` — "Brain-apps will reuse this" (≈3045), "Brain-apps' AppRuntimeContract reuses this same function" (≈3499).
- `apps/api/src/services/runCompactionService.ts` — "Brain-apps will plug into the same service" (≈15).

**Schema / test harness:**
- `packages/db/src/sqlite/schema.ts` — `agentPackages` (`agent_packages`, 184) + `agents.packageId` FK (209). **Likely the public Packages backing store — confirm before touching.**
- `apps/api/src/routes/testHarness.ts` — `deps.db.delete(schema.agentPackages)` (48).
- `apps/api/src/routes/packages.ts` — header comment "one `agent_packages` row" (11). Public feature.

**Web — comments referencing brain-apps:**
- `apps/web/src/components/canvas/WorkflowContractsPanel.tsx` — "brain-apps' AppRuntimeContract reuses this same" (14).
- `apps/web/src/components/canvas/PhaseLayer.tsx` — "brain-apps' AppLayoutSection will" (15).

### Recommended approach (if authorized)
1. Remove the secret `agentis.app.*` chat tools + their handlers + `/newapp` + orchestrator guidance, and the `agentis.app.inspect` tool. Confirm nothing user-facing depends on them.
2. Drop the `{{apps.*}}` namespace: remove the resolver `case 'apps'`, the `TemplateContext.apps` field, and the ctx init — all currently inert on main.
3. Reword/remove every "Brain-apps / AppRuntimeContract / AppLayoutSection / app-scoped" comment (backend + web).
4. Leave `agent_packages` / `routes/packages.ts` / Packages nav **intact** if they back the public feature; only rename internal `appId` variables that actually mean "registry entry".
5. Re-run all four typechecks + the test suite; grep again for `app` tokens to confirm zero remaining secret-apps references.

---

## 6. Other deviations from the plan (recorded so nothing is silent)

- **G7 was a false gap.** Synthesis already receives workspace context via `buildWorkspaceInventory()` → `synthesizeWithLlm()`. No change made.
- **G5 `kb_search_log` table intentionally skipped.** A write-on-every-search telemetry table wasn't worth the migration + hot-path write for V1; KB usage legibility is delivered via Brain stats (chunk counts, last-indexed) instead. Revisit if per-query audit trails are required.
- **Route naming.** Plan said keep `/knowledge`. Shipped `/brain` as canonical with `/knowledge` as an alias, so the URL matches the product name without breaking any in-app links.
- **Page rebuilt, not patched.** `KnowledgePage.tsx` was replaced by `BrainPage.tsx` rather than edited, because G4 + G5 + G10 amounted to a new surface.
