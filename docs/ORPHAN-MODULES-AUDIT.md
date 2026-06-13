# Orphan Modules Audit

Generated from a whole-repo import-graph analysis (relative + dynamic imports
resolved, **tests/scripts/e2e counted as importers**, entry points and
package.json `exports` excluded). A module is "orphan" = imported by nothing in
its category.

> **Key lesson:** in this codebase "imported by nothing" ≠ "dead." Many orphans
> are **intentional V1-SPEC spec-named re-export shims** or **forward-built /
> deferred WIP**. Do **not** mass-delete. Treat this as a *review list*. Only
> remove a module with a named live replacement or an explicit decommission
> decision (e.g. a route that now `<Navigate>`s away).

Legend — **Verdict**: 🟢 keep (intentional) · 🟡 review · 🔴 likely removable.
**Git**: `new` (untracked), `mod` (modified), `base` (committed & untouched).

---

## A. Spec-traceability shims — 🟢 KEEP (deleting breaks the spec→code map)

These have a header like `V1-SPEC §x.y spec-named entry point` and re-export the
canonical implementation so the module path matches the spec document.

| Module | Git | Re-exports / notes |
|---|---|---|
| `apps/api/src/engine/PartialReplay.ts` | base | → `services/partialReplay.ts` |
| `apps/api/src/engine/ReadyQueue.ts` | base | spec §3.3/§6.2 FIFO contract; test-covered |
| `apps/api/src/engine/RunStateStore.ts` | base | spec §3.3/§6.4 snapshot persistence; test-covered |
| `apps/api/src/engine/WaitingInputBuffer.ts` | base | spec §3.3/§6.3; test-covered |
| `apps/api/src/websocket/events.ts` | base | spec-named event surface |
| `apps/web/src/components/shared/CommandPalette.tsx` | base | → `components/CommandPalette.tsx` |

## B. Live via tests / cross-package — 🟢 KEEP (not actually dead)

| Module | Git | Why it's live |
|---|---|---|
| `apps/api/src/security/unauthAllowList.ts` | mod | Security contract pinned by `tests/security/unauthAllowList.test.ts` (the auditable unauthenticated surface, V1-SPEC §10 / DECISIONS D32) |
| `apps/api/src/services/backup.ts` | base | Exposed via `@agentis/api/backup` package export; consumed by `packages/cli` |
| `apps/api/src/adapters/LocalLlmAdapter.ts` | base | Optional local-LLM adapter; covered by adapter tests |
| `apps/api/src/engine/triggerConnectors.ts` | base | HMAC trigger connectors; test-covered |

## C. Forward-built / deferred WIP — 🟢 KEEP (built ahead of wiring)

Real, recent feature work not yet mounted into a page/parent. Wiring pending,
not abandoned.

| Module | Git | Intended home |
|---|---|---|
| `apps/web/src/components/agents/SpecialistStudioPanel.tsx` | new | Specialist Studio (explicitly deferred per Specialists-10x Phase 0) |
| `apps/web/src/components/agents/AgentExtensionsPanel.tsx` | new | Agent detail → extensions |
| `apps/web/src/components/agents/AgentInteractionFeed.tsx` | new | Agent detail (test-covered) |
| `apps/web/src/components/agents/AgentMemoryIngestPanel.tsx` | new | Agent detail → memory (test-covered) |
| `apps/web/src/components/canvas/ListenerHealthPanel.tsx` | new | Canvas → listener inspector |
| `apps/web/src/components/canvas/ListenerInspector.tsx` | new | Canvas → listener node |
| `apps/web/src/components/chat/ScrollToBottomPill.tsx` | new | Chat thread |
| `apps/web/src/components/chat/StickyBuildBanner.tsx` | new | Chat build banner |
| `apps/web/src/hooks/useAutoScroll.ts` | new | Chat thread autoscroll |
| `apps/web/src/components/brain/BrainActivityFeed.tsx` | new | Brain page (vs wired `BrainView`/`BrainStage`) — confirm not superseded |
| `apps/web/src/components/brain/BrainNodeCard.tsx` | new | Brain page — confirm not superseded |
| `apps/web/src/components/brain/BrainTabHeader.tsx` | new | Brain page — confirm not superseded |

## D. Decommissioned by an explicit decision — 🟡 REVIEW (safe to remove)

| Module | Git | Decision |
|---|---|---|
| `apps/web/src/pages/AbilitiesPage.tsx` | new | `/abilities` route deliberately `<Navigate to="/agents">`; abilities now surface via the Agents page + `AbilityDetailPage`. Standalone list page superseded. |

## E. Pre-existing, untouched, non-shim — 🟡 REVIEW for removal

Likely superseded during the big refactor, but verify each has a live
replacement before deleting (no spec-shim header, no test).

**API**

| Module | Note |
|---|---|
| `apps/api/src/routes/transcripts.ts` | `buildTranscriptRoutes` never mounted in bootstrap |
| `apps/api/src/routes/ledger.ts` | `buildLedgerRoutes` never mounted (separate ledger surfaced via `/v1/runs`) |
| `apps/api/src/routes/admin.ts` (mod) | `buildAdminRoutes` never mounted — WIP or superseded |
| `apps/api/src/services/liveNodeTail.ts` | no importer |
| `apps/api/src/services/outputLabels.ts` (mod) | logic re-implemented inline in `agentisToolHandlers/inspect.ts` (`aggregateOutputLabels`) → genuine duplicate |
| `apps/api/src/services/gatewayDirectory.ts` | test-only |
| `apps/api/src/services/workspaceContext.ts` | test-only; name collides with `routes/workspaceContext.ts` |

**Web — likely superseded components**

| Module | Likely replacement |
|---|---|
| `apps/web/src/components/agents/AgentOrgChart.tsx` (mod) | `AgentHierarchyCanvas.tsx` |
| `apps/web/src/components/agents/AgentHierarchyDetailPanel.tsx` (mod) | `AgentQuickDetailPanel.tsx` |
| `apps/web/src/components/agents/AgentHierarchyNode.tsx` (test-only) | node renderer inlined inside `AgentHierarchyCanvas.tsx` → **duplicate** |
| `apps/web/src/components/agents/CommissionFlow.tsx` (mod) | `AgentCreateWizard` / commission route |
| `apps/web/src/components/agents/PlaybookStep.tsx` | — |
| `apps/web/src/components/canvas/WorkflowCanvas.tsx` (test-only) | `CanvasEngine.tsx` |
| `apps/web/src/components/canvas/CanvasMotionLayer.ts` | — |
| `apps/web/src/components/canvas/CanvasNarration.tsx` | — |
| `apps/web/src/components/canvas/CanvasTabs.tsx` | — |
| `apps/web/src/components/canvas/NodePeekPortal.tsx` | — |
| `apps/web/src/components/chat/RoomList.tsx` | `RoomCreateDialog` + scope picker |
| `apps/web/src/components/chat/messageModel.ts` (test-only) | `components/chat/messageModel.ts` vs `toolCalls.ts` — confirm |
| `apps/web/src/components/AgentWorkStream.tsx` | `LiveActivityTrace` / `ExecutionFeed` |
| `apps/web/src/components/AvatarDropdown.tsx` | header user menu |
| `apps/web/src/components/TopBarPills.tsx` | `LiveStrip` |
| `apps/web/src/components/WorkspaceCard.tsx` | `WorkspaceEcosystemCanvas` |
| `apps/web/src/components/WorkspaceContextBlock.tsx` | — |
| `apps/web/src/components/MiniMonitorWidget.tsx` (test-only) | `WorkflowMonitorCard` |
| `apps/web/src/components/assistant/FleetBroadcastThread.tsx` | chat broadcast |
| `apps/web/src/components/home/FleetMetricBar.tsx` | home canvas |
| `apps/web/src/components/home/HomeLauncher.tsx` (mod) | `HomeLauncher` is imported? re-check — flagged orphan |
| `apps/web/src/components/knowledge/KnowledgeBaseList.tsx` | `KnowledgeBasePage` |
| `apps/web/src/components/knowledge/KnowledgeStatusCard.tsx` (mod) | brain/knowledge panels |
| `apps/web/src/components/notifications/NotificationBell.tsx` | `shared/NotificationPanel` |
| `apps/web/src/components/workflows/PhaseCards.tsx` | `PhaseLayer` |
| `apps/web/src/lib/slashCommands.ts` | command palette / composer |
| `apps/web/src/pages/ChatDeploymentPage.tsx` | — (no route) |
| `apps/web/src/pages/TeamsPage.tsx` (mod) | no `/teams` route (`/fleet`→`/home`) |

---

## How to reproduce

The detector script was removed after use. To regenerate: walk `apps/*/src` +
`packages/*/src` as orphan candidates, walk `apps/*/tests`, `packages/*/tests`,
`scripts`, `e2e` as importer-only roots, resolve relative specifiers
(`.js`/`.tsx`/`index`), and report candidates with zero importers. Counting
tests as importers is essential — otherwise test-only modules (e.g.
`unauthAllowList`) are false positives.
