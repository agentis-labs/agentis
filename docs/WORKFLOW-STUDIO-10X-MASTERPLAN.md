# Workflow Studio — 10x Output Surface Masterplan

**Status**: P0-P4 shipped (2026-06-18)
**Replaces**: "Output tab" / `WorkflowOutputTab`

---

## Problem

The Output tab is a **run-centric log viewer**. It assumes every workflow is an event that fires, completes, and leaves a result. That breaks immediately for:

- Always-on monitoring and multi-channel messaging workflows (no meaningful "run" boundary)
- Conversational agents (the output IS the conversation, not a summary of it)
- Long-running hybrid pipelines (DevOps, content factories) mixing sessions + discrete events
- Multiple audiences — operators need a war room, executives need a brief, customers need a status page

The deeper problem: agents produce output but have no way to **write to a UI** in real time. Every interaction goes through `node outputs → post-run render`. There is no live surface.

---

## Vision

**Studio** replaces Output as the live, configurable, multi-surface UI runtime for every workflow.

Three shifts:

1. **Rename + retype**: `Output` → `Studio`. Surface type metadata on `WorkflowGraph.surfaces` tells Studio what chrome to render.
2. **Agent UI Protocol**: `ui_emit` is a first-class agent tool. Agents write directly to named blocks on any surface, in real time, via the existing realtime bus.
3. **Surface Builder** (P2): A visual drag-and-drop editor that produces a `StudioSurfaceSpec` JSON — the "frontend language" for agentic systems.

---

## Architecture

### Surface types

```
event        — run-based, has run history sidebar (default; keeps existing behavior)
stream       — session-based, always-on, no run list; shows session timer + agent bar
conversation — thread-based; the output IS the dialogue
hybrid       — session + run events mixed (DevOps, content factory)
```

Stored on `WorkflowGraph.surfaces[].type`. Absence → `'event'` (full backward-compat).

### `StudioSurfaceSpec`

```ts
{ id, name, type, layout: StudioLayoutRow[], blocks: StudioBlock[], audience?, shareable? }
```

`layout` is an ordered array of rows; each row lists block IDs with optional flex weights. `blocks` carry the typed block definition (see `StudioBlockType`). Both live in `WorkflowGraph.surfaces` alongside nodes/edges — no new DB columns needed.

### Agent UI Protocol (AUP)

Agents call `ui_emit`:

```json
{ "surface": "command-center", "block": "slack-feed", "op": "append", "data": { "role": "agent", "content": "EMEA CTR at 3.2%" } }
```

The `AgentToolRuntime` calls `deps.surfaceEmit(...)` (optional dep, no-op when absent). The bootstrap wires in a function that publishes `STUDIO_BLOCK_EMIT` to the workflow and workspace realtime rooms. The frontend `WorkflowStudioTab` subscribes and applies the op to block state with emit-id dedupe.

### Block registry (14 types)

| Type | Purpose |
|---|---|
| `message_feed` | Live chat-style stream (Slack, Email, WhatsApp, agent dialogue) |
| `metrics_grid` | KPI tiles with deltas, auto-trend sparklines |
| `approval_gate` | Human-in-the-loop gate; resolves back into the engine |
| `data_table` | Live-updatable, sortable, exportable |
| `chart` | Bar / line / pie from structured data |
| `document_viewer` | Report / memo / code with download |
| `map` | Geographic data — regions, pins, heatmaps |
| `agent_card` | Status + what the agent is doing right now |
| `status_board` | Multi-entity health indicators |
| `web_embed` | iframe for external tools / previews |
| `narrative` | AI-written summary; regenerates on demand |
| `conversation_thread` | Direct agent dialogue, action-aware |
| `code_viewer` | Syntax-highlighted code with diff + copy |
| `media_gallery` | Generated images, artifacts, files |

---

## Phases

### P0 — Foundation (done 2026-06-18)
- Rename `WorkflowTab 'output'` → `'studio'` (backward-compat: `?tab=output` → `studio`)
- Add `StudioSurfaceSpec`, `StudioBlock`, `StudioBlockType`, `StudioBlockOp`, `StudioSurfaceType`, `StudioAudience`, `StudioLayoutRow` to `packages/core/src/types/workflow.ts`
- Add `surfaces?: StudioSurfaceSpec[]` to `WorkflowGraph`
- Add `STUDIO_BLOCK_EMIT` to `REALTIME_EVENTS` in `packages/core/src/events.ts`
- Canvas page tab label + URL param updated

### P1 — Agent UI Protocol (done 2026-06-18)
- Add `'ui_emit'` to `AgentTool` (specialist.ts) + description in `TOOL_DESCRIPTIONS`
- Add `surfaceEmit?: (args) => void` to `AgentToolRuntimeDeps`
- Add `ui_emit` case to `AgentToolRuntime.#run()` — calls `deps.surfaceEmit`
- Bootstrap wires `surfaceEmit` → realtime room publish for `STUDIO_BLOCK_EMIT`
- Frontend `WorkflowStudioTab` subscribes to `STUDIO_BLOCK_EMIT` and applies block ops

### P2 — Surface Builder (done 2026-06-18)
- Canvas-level Studio builder: block palette + layout canvas + properties panel
- Produces `StudioSurfaceSpec` JSON saved to `WorkflowGraph.surfaces`
- Multiple surfaces per workflow, named, typed, duplicated, deleted, audience-tagged, and autosaved

### P3 — Surface chrome per type (done 2026-06-18)
- `stream` surface: session timer and always-on live surface chrome
- `conversation` surface: thread-first chrome
- `hybrid` surface: live + run-event chrome
- `event` surface: backward-compatible legacy output when no saved Studio surfaces exist

### P4 — Multi-surface + sharing (done 2026-06-18)
- Multiple named surfaces per workflow (Command Center, Executive Brief, Debug, Customer/Public)
- Audience tags stored per surface and surfaced in builder/share metadata
- `POST /v1/workflows/:id/surfaces/:sid/share` creates a time-limited public link with a hashed token stored in workflow settings
- `GET /v1/workflows/public/surfaces/:token` returns only the published surface definition when the token is active, unexpired, and the surface remains shareable
- `/public/workflows/surfaces/:token` renders a read-only Studio surface without requiring an Agentis account

### Corrected assumptions
- P1 was previously marked shipped, but runtime execution, default specialist access, bootstrap realtime publishing, and frontend subscription were incomplete. This pass closes the loop end to end.
- `WorkflowGraph.surfaces` was present in types but not validated in the shared Zod schema. This pass adds explicit Studio surface validation.
- Public sharing needs token storage and expiry. This implementation avoids a database migration by storing hashed share records in workflow settings and exposing a narrow public read route.

---

## Impl log

### 2026-06-18 — P0 + P1 shipped

- Added Studio surface types to `packages/core/src/types/workflow.ts`
- Added `STUDIO_BLOCK_EMIT` to `packages/core/src/events.ts`
- Added `ui_emit` to `AgentTool` + `TOOL_DESCRIPTIONS` in `packages/core/src/types/specialist.ts`
- Added `surfaceEmit` dep + `ui_emit` case to `apps/api/src/services/agentToolRuntime.ts`
- Renamed `WorkflowTab 'output'` → `'studio'` in `apps/web/src/pages/WorkflowCanvasPage.tsx` with backward-compat for `?tab=output` URL param

### 2026-06-18 — P2-P4 implementation pass

- Added shared Zod validation for Studio surface types, audiences, block types, block ops, blocks, rows, and `WorkflowGraph.surfaces`.
- Added `ui_emit` to default specialist tools and the agent-session tool schema so agents can actually call the Agent UI Protocol.
- Wired `AgentToolRuntime.ui_emit` through `surfaceEmit`, publishing `STUDIO_BLOCK_EMIT` with a generated `emitId` to workflow and workspace realtime rooms.
- Replaced the legacy Output tab render path with `WorkflowStudioTab`, preserving `?tab=output` as a Studio alias and preserving legacy run output for workflows with no saved surfaces.
- Built the Studio UI: Operate/Build modes, surface rail, surface duplication/deletion, surface type chrome, audience picker, shareable toggle, layout rows, flex controls, block palette, block inspector, JSON config editor, and autosave to `WorkflowGraph.surfaces`.
- Implemented all 14 planned block renderers: message feed, metrics grid, approval gate, data table, chart, document viewer, map, agent card, status board, web embed, narrative, conversation thread, code viewer, and media gallery.
- Added runtime block-state application for `upsert`, `append`, `remove`, and `set_prop`, with realtime emit dedupe.
- Added authenticated public-share creation, hashed token persistence in workflow settings, unauthed public-surface read route, and a read-only public Studio surface page.
- Fixed an existing web typecheck blocker in `WorkspaceEcosystemCanvas` by threading `fleet` into `CommandCenterSnapshot` and sizing its metrics grid for the token metric.
- Verification: `pnpm --filter @agentis/core typecheck`, `pnpm --filter @agentis/api typecheck`, `pnpm --filter @agentis/web typecheck`, and `pnpm --filter @agentis/api test -- tests/services/agentToolRuntime.test.ts`.
