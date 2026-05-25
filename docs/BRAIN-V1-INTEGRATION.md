# Brain — V1.0.0 Full Integration Plan

## Thesis

The Brain is the workspace intelligence layer. It is the difference between agents that execute tasks in isolation and agents that compound what they know over time. Every document an operator uploads, every pattern an agent discovers, every decision that succeeds or fails — the Brain retains it and injects it back at the right moment.

The infrastructure is mostly built. The gap is that the Brain is not _activated_: knowledge bases exist but their content never reaches agents automatically; cross-run memory writes but nothing reads it back; the UI labels this "Knowledge" with no framing for what it actually does. This plan closes all of those gaps.

---

## Architecture: What the Brain Is

The Agentis Brain has three distinct layers:

| Layer | What it stores | How agents access it |
|---|---|---|
| **Workspace context** | WORKSPACE.md, MEMORY.md, WORKFLOW.md — static facts, learned patterns, delivery conventions | Injected automatically into every `agent_task` prompt via `buildContextBlock()` |
| **Knowledge bases** | Documents chunked and indexed in `kb_chunks` — SOPs, product specs, guides, reference material | `knowledge` node (explicit graph retrieval) + `knowledge_search` agent tool (reactive, on demand) |
| **Workflow memory** | `workflow_kv_entries` — key-value state that persists across runs of the same workflow | `workflow_store` node (engine-side read/write) |

V1.0.0 fully activates all three layers.

---

## Current State Audit

### What is fully working

- `KnowledgeBaseService` — CRUD, document chunking, lexical FTS/BM25 search on `kb_chunks`
- `knowledge` engine node — contextual / strict / exploratory retrieval modes, wired and dispatching
- `knowledge_search` agent tool in `AgentToolRuntime` — searches all workspace KBs, returns ranked hits
- `ROLE_TOOLS` grants `knowledge_search` to: `planner`, `researcher`, `analyst`, `monitor`, `architect`
- `/v1/knowledge-bases` routes — full CRUD + document upload + per-KB search endpoint
- `KnowledgePage` + `KnowledgeBasePage` — functional UI with document upload, KB search, doc list, delete
- Sidebar "Knowledge" nav entry
- `KnowledgeCanvasCallout` on the canvas when a `knowledge` node is present but no KBs exist
- `ContextInspector` fetches KB list for `knowledge` node configuration
- `workflow_store` node — engine handler complete (`WorkflowStoreService` wired), node in `NodePalette`, description in `ContextInspector`
- `workflow_kv_entries` table with `workspace_id` column in schema
- `WorkspaceIntelligenceService` — reads WORKSPACE.md, MEMORY.md, WORKFLOW.md; scores MEMORY entries for relevance; `buildContextBlock()` wired into every `agent_task` dispatch via `WorkflowEngine.#withWorkspaceContext()`
- `appendMemory()` on `WorkspaceIntelligenceService` — appends structured entries to MEMORY.md sections
- `buildWorkspaceInventory()` in creation pipeline — lists KB names and IDs in the `CreationBrief`
- Iron Rule 5 in synthesis preamble: "Knowledge Before Agent — wire a `knowledge` node before an `agent_task` that needs workspace facts"
- `workflow_store` node schema in synthesis prompt (under data node category)
- `workspaceIntelligence`, `knowledgeBases`, `workflowStore` all wired into `WorkflowEngine` deps at bootstrap

### The gaps

Ten integration gaps prevent the Brain from being fully active.

---

## Integration Gaps

### G1 — KB chunks not injected into agent context

**File:** `apps/api/src/services/workspaceIntelligence.ts` · `WorkspaceIntelligenceService.buildContextBlock()`  
**File:** `apps/api/src/engine/WorkflowEngine.ts` · `#withWorkspaceContext()`

`buildContextBlock()` assembles context from the three MD files only. KB chunk content is never fetched here. An agent dispatched with `agentRole: 'researcher'` receives WORKSPACE.md, MEMORY.md, and WORKFLOW.md in its system preamble — but not a single sentence from any KB document.

Agents with `knowledge_search` in their tool manifest can call it reactively, but only if the task prompt gives the LLM sufficient motivation. High-value workspace knowledge — product requirements, standard operating procedures, compliance rules — sits in KBs unused by most agent tasks.

**Fix:** Add a `knowledgeBases?: KnowledgeBaseService` parameter to `buildContextBlock()`. Before assembling the context block, run a best-effort search across all workspace KBs using the incoming task prompt as the query (topK: 3, one search call). Append the hits as a `## Relevant Workspace Knowledge` section inside `<workspace_context>`. Gate the search behind a `injectKnowledge?: boolean` flag so callers can opt out. In `#withWorkspaceContext()`, pass the task prompt as the query and enable injection.

When no KBs exist, this is a no-op. The enrichment is strictly additive.

**Scope:** ~60 lines across two files. No schema changes.

---

### G2 — No structured memory write tool for agents

**File:** `packages/core/src/types/specialist.ts` · `AgentTool` union + `ROLE_TOOLS`  
**File:** `apps/api/src/services/agentToolRuntime.ts` · `executeTool()`

`WorkspaceIntelligenceService.appendMemory()` exists and works. But no agent tool exposes it. Agents who want to write a memory must call `write_file` with the path `context/MEMORY.md` in the correct format — fragile and prone to overwriting the file rather than appending.

**Fix:** Add `memory_append` to the `AgentTool` union. Wire a `case 'memory_append'` in `AgentToolRuntime.executeTool()` that calls `this.deps.workspaceIntelligence.appendMemory(workspaceId, section, entry)`. Register it in `ROLE_TOOLS` for `planner`, `analyst`, `monitor`, and `researcher`. Add a description to `TOOL_DESCRIPTIONS`: `"Record a finding or decision to the workspace memory log. args: { section: string, entry: string }"`.

This gives agents a clean, structured path to accumulate knowledge over time without risking file corruption.

**Scope:** ~25 lines across two files + one type definition. Requires `workspaceIntelligence` added to `AgentToolRuntime` deps (currently only `volume` and `knowledgeBases`).

---

### G3 — Workflow memory inaccessible to agent tool loops

**File:** `packages/core/src/types/specialist.ts` · `AgentTool` union + `ROLE_TOOLS`  
**File:** `apps/api/src/services/agentToolRuntime.ts` · `executeTool()`

`workflow_store` nodes read/write `workflow_kv_entries` during graph execution. But this state is invisible to agents in their tool-call loop. An agent in a cron workflow has no way to ask "what did this workflow find yesterday?" — the `WorkflowStoreService` is engine-only.

**Fix:** Add `workflow_memory_read` to the `AgentTool` union. Wire a `case 'workflow_memory_read'` in `AgentToolRuntime.executeTool()` that calls `this.deps.workflowStore?.get(workspaceId, workflowId, key)` and returns the value. Also add `workflow_memory_write` for symmetry — lets agents update state without a `workflow_store` node. Register `workflow_memory_read` in `ROLE_TOOLS` for `planner`, `analyst`, `monitor`. Register `workflow_memory_write` in the same roles. Pass `workflowId` through `AgentToolRuntime` (already available as a dispatch argument in `AgentToolRuntime.run()`).

Agents in recurring workflows can now track state, deduplicate work, accumulate findings, and reference prior outputs.

**Scope:** ~40 lines across two files + type definitions. Requires `workflowStore` added to `AgentToolRuntime` deps.

---

### G4 — Brain identity invisible to operators

**File:** `apps/web/src/components/Sidebar.tsx`  
**File:** `apps/web/src/pages/KnowledgePage.tsx`  
**File:** `apps/web/src/components/canvas/ContextInspector.tsx`  
**File:** `apps/web/src/pages/WorkflowCanvasPage.tsx` · `KnowledgeCanvasCallout`

The Brain is labeled "Knowledge" everywhere. Nothing explains that these document collections are the memory layer that agents draw from during execution. First-time operators create a knowledge base and upload a document without knowing what it actually does.

**Changes:**

- **Sidebar:** Rename `label: 'Knowledge'` to `label: 'Brain'`. The route stays `/knowledge`.
- **KnowledgePage heading:** Change the page title from "Knowledge" to "Brain". Add a subtitle: _"Everything your agents know about your workspace — documents, references, and operating guidelines they can retrieve before acting."_
- **ContextInspector knowledge node description:** Update from `"Retrieves relevant context from the workspace knowledge base."` to `"Fetches the most relevant passages from the workspace Brain before the next node runs."` 
- **KnowledgeCanvasCallout:** Update the title from `"Knowledge node needs sources"` to `"Brain node needs content"`. Update the button from `"Open Knowledge"` to `"Open Brain"`. Update the description to explain that the Brain needs documents to retrieve from.
- **NodePalette knowledge entry:** Update `label: 'Knowledge'` to `label: 'Brain'` and `description: 'Retrieve from a workspace knowledge base'` to `'Retrieve relevant context from the workspace Brain'`.

No routing changes. No backend changes.

**Scope:** ~10 targeted label changes across 4 files.

---

### G5 — No KB usage telemetry

**File:** `apps/api/src/services/knowledgeBase.ts` · `search()`  
**File:** `packages/db/src/sqlite/schema.ts`

`KnowledgeBaseService.search()` returns results but records nothing. Operators cannot see which KBs are used, how often, by which workflows, or when. A KB could have zero documents and nobody would know from the KB page alone.

**Fix:** Add a `kb_search_log` table to the schema: `{ id, workspace_id, kb_id, query, result_count, run_id (nullable), workflow_id (nullable), created_at }`. After every `search()` call, insert a row (fire-and-forget, non-blocking). Expose aggregated stats — total searches, last searched at, unique workflows — on the KB detail page (`KnowledgeBasePage`) as a small stat row below the KB header.

Also fix the **empty-KB callout** edge case: `KnowledgeCanvasCallout` currently fires when `knowledgeBaseCount === 0`. It should also fire when KBs exist but the targeted KB has zero indexed chunks. Pass `totalChunkCount` alongside `knowledgeBaseCount` from the fetch and condition the callout on `knowledgeBaseCount === 0 || totalChunkCount === 0`.

**Scope:** One new schema table + ~50 lines in `knowledgeBase.ts` + ~30 lines in the KnowledgeBasePage stats display + 2-line fix in `WorkflowCanvasPage`.

---

### G6 — Creation pipeline doesn't search Brain content

**File:** `apps/api/src/services/creationPipeline.ts` · `buildWorkspaceInventory()`  
**File:** `apps/api/src/services/agentisToolHandlers/build.ts` · inventory section of synthesis prompt

`buildWorkspaceInventory()` lists KB names and IDs. The synthesis LLM sees `AVAILABLE KNOWLEDGE BASES: - id: "kb_01", name: "Product Specs"` but has no content. When it places a `knowledge` node, it can't choose the right KB or suggest a meaningful static query.

**Fix:** In `buildWorkspaceInventory()`, after listing KBs, do a targeted search: take the first 128 characters of the creation request as a query and call `KnowledgeBaseService.search()` across all KBs (topK: 5). Append the top hits to the brief as a `knowledgeExcerpts` field. In the synthesis prompt (inside `SYNTHESIS_ARCHITECT_PREAMBLE`), add the excerpts as a `BRAIN CONTEXT FOR THIS REQUEST` block, before the Iron Rules. The synthesis LLM can now verify that a `knowledge` node is warranted, pick the right KB, and choose a static query that will actually return relevant content.

When no KBs exist or the search returns nothing, the block is omitted.

**Scope:** ~40 lines in `creationPipeline.ts` + 8 lines in the prompt template in `build.ts`.

---

### G7 — Synthesis LLM doesn't receive workspace context

**File:** `apps/api/src/services/agentisToolHandlers/build.ts` · `handleBuildWorkflow()`

`WorkspaceIntelligenceService.buildContextBlock()` is called for every `agent_task` dispatch. But it is NOT called before the synthesis LLM builds the workflow graph. The synthesis LLM gets KB names and workspace inventory but not WORKSPACE.md (tech stack, architectural rules), WORKFLOW.md (delivery conventions, review policy, cost guardrails), or the scored MEMORY.md entries (effective patterns, failed patterns).

This means the synthesis LLM can produce workflows that contradict workspace conventions, use the wrong delivery channel for a notification, or repeat patterns that previously failed.

**Fix:** In `handleBuildWorkflow()`, call `deps.workspaceIntelligence.buildContextBlock(workspaceId, { workflowId: undefined })` before assembling the synthesis prompt. Prepend the returned block to the `SYNTHESIS_ARCHITECT_PREAMBLE`. The synthesis LLM now operates with full workspace context.

**Scope:** ~15 lines in `build.ts`. Requires `workspaceIntelligence` added to the build handler's deps.

---

### G8 — No Iron Rule for recurring workflow memory

**File:** `apps/api/src/services/agentisToolHandlers/build.ts` · `SYNTHESIS_ARCHITECT_PREAMBLE`

The synthesis prompt documents `workflow_store` as a valid "data" node. But without an explicit Iron Rule, the synthesis LLM rarely places it unprompted, even for cron workflows that clearly need cross-run state.

**Fix:** Add Iron Rule 13 to `SYNTHESIS_ARCHITECT_PREAMBLE`:

> _13. Recurring Workflows Remember — for `cron` or `persistent_listener` trigger workflows that accumulate state (deduplication, tracking last-run cursor, appending to a log), add a `workflow_store` read node near the start and a `workflow_store` write node near the end._

Update the Iron Rule count in the preamble header from 12 to 13.

**Scope:** 3 lines.

---

### G9 — Agent task context missing workflow ID

**File:** `apps/api/src/services/agentToolRuntime.ts` · `AgentToolRuntime` constructor deps  
**File:** `apps/api/src/engine/WorkflowEngine.ts` · `#dispatchAgentTask()`

`AgentToolRuntime.executeTool()` already receives `workspaceId` and can call `knowledge_search`. But the `workflowId` is not passed through, so `workflow_memory_read` / `workflow_memory_write` (G3) and the search telemetry (G5) have no workflow context to log against.

**Fix:** Add `workflowId?: string` to the `executeTool()` signature (or the `run()` method context). Pass it from `#dispatchAgentTask()` where `ctx.workflowId` is available. This is the enabling dependency for G3 and G5.

**Scope:** ~10 lines across two files.

---

### G10 — No Brain bootstrapping on workspace setup

**File:** `apps/api/src/routes/workspaces.ts` (or equivalent workspace creation route)  
**File:** `apps/web/src/pages/KnowledgePage.tsx`

New workspaces have no KBs. WORKSPACE.md is seeded lazily with placeholder content. There is no moment where the operator is guided to fill in their workspace context or create their first KB. The Brain starts empty and stays empty until the operator discovers the Knowledge page on their own.

**Fix:**
1. On the `KnowledgePage` (Brain page after rename), add an empty-state card when no KBs exist: _"Your workspace Brain is empty. Add documents your agents can retrieve when they run."_ + "Create knowledge base" button. This replaces the generic empty-list state.
2. When `WORKSPACE.md` contains only placeholder content (detectable via `stripPlaceholders()` returning empty string), show a banner on the Brain page: _"Your workspace context is blank — agents are working without facts about your stack and conventions."_ + link to Settings > Workspace Context.

**Scope:** ~40 lines in `KnowledgePage.tsx`. No backend changes.

---

### G11 — No agent-scoped memory

**File:** `packages/db/src/sqlite/schema.ts`  
**File:** `apps/api/src/engine/WorkflowEngine.ts` · `#dispatchAgentTask()`  
**File:** `packages/core/src/types/specialist.ts` · `AgentTool` union + `ROLE_TOOLS`  
**File:** `apps/api/src/services/agentToolRuntime.ts` · `executeTool()`  
**File:** `apps/web/src/pages/AgentPage.tsx` (or equivalent agent detail page)

The Brain has three memory scopes: workspace (MEMORY.md — shared by all agents), workflow (`workflow_kv_entries` — scoped to one workflow), and knowledge bases (shared by all agents). There is no **agent-scoped** memory layer — a persistent store belonging to a specific agent that survives across every task it executes, in every workflow, over time.

When a `researcher` agent investigates competitors across five different workflows over months, every finding goes into the shared workspace MEMORY.md with no agent attribution. The next time that agent is dispatched, it starts with zero personal history. There is no answer to the question: _"what does this specific agent know and remember?"_

**Fix:**

1. **Schema** — add an `agent_memories` table: `{ id, agent_id, workspace_id, section, content, tags (JSON), created_at }`. Index on `(agent_id, workspace_id)`.

2. **Context injection** — in `#dispatchAgentTask()`, after `buildContextBlock()` assembles the workspace context, load the dispatched agent's personal memory entries (most recent N, scored by recency) and append them as a `## Agent Memory` section inside the context block. This is best-effort: a load failure must not block dispatch.

3. **`memory_append` scope** — extend the existing `memory_append` tool's args to accept `scope: 'workspace' | 'agent'` (default `'workspace'` for backward compatibility). When `scope === 'agent'`, write to `agent_memories` instead of MEMORY.md. The `agentId` is available on the dispatch context already.

4. **`agent_memory_search` tool** — add a new `AgentTool` entry. Wire a `case 'agent_memory_search'` in `AgentToolRuntime` that does a lightweight lexical search over `agent_memories` for the calling agent. Register it in `ROLE_TOOLS` for `planner`, `researcher`, `analyst`, `monitor`.

5. **UI** — on the agent detail page, add a "Memory" tab that lists the agent's memory entries by section, with timestamps, and a clear-all button. This makes the agent's Brain visible and auditable to the operator.

The key distinction: workspace MEMORY.md is what every agent inherits from the collective. Agent memory is what a specific agent builds about its own domain over time — personal expertise that compounds independently of the workspace-wide log.

**Scope:** One new schema table + ~70 lines across `WorkflowEngine.ts`, `agentToolRuntime.ts`, `specialist.ts` + ~60 lines for the agent detail UI tab.

---

## Implementation Order

The gaps are sequenced by foundational dependency and immediate value:

| Phase | Items | What operators gain |
|---|---|---|
| **Phase 1 — Core wiring** | G9 → G2 → G3 | Agents get `memory_append` and `workflow_memory_read`; workflow_id context threaded through |
| **Phase 2 — Auto enrichment** | G1 → G7 | Every agent task and every synthesis call starts with workspace knowledge and Brain content; the value of every KB document multiplies |
| **Phase 3 — Synthesis intelligence** | G6 → G8 | Workflow builder produces graphs that reference actual KB content and place `workflow_store` nodes for recurring workflows |
| **Phase 4 — Observability** | G5 | Operators can see which KBs are being used and when; empty KBs surface clearly |
| **Phase 5 — Identity + onboarding** | G4 → G10 | "Brain" is the product name everywhere; new operators are guided to fill it in |
| **Phase 6 — Agent identity** | G11 | Each agent accumulates its own memory across all workflows; the agent detail page shows its personal Brain |

Phase 1 is prerequisite for Phase 2. Phases 3, 4, and 5 are independent once Phase 2 is complete.

---

## Effort Summary

| Gap | Files touched | Estimated lines |
|---|---|---|
| G1 — KB chunk injection into context | `workspaceIntelligence.ts`, `WorkflowEngine.ts` | ~60 |
| G2 — `memory_append` agent tool | `specialist.ts`, `agentToolRuntime.ts` | ~25 |
| G3 — `workflow_memory_read/write` tools | `specialist.ts`, `agentToolRuntime.ts` | ~40 |
| G4 — Brain identity + labels | `Sidebar.tsx`, `KnowledgePage.tsx`, `ContextInspector.tsx`, `WorkflowCanvasPage.tsx`, `NodePalette.tsx` | ~15 |
| G5 — KB usage telemetry | `schema.ts`, `knowledgeBase.ts`, `KnowledgeBasePage.tsx`, `WorkflowCanvasPage.tsx` | ~85 |
| G6 — Creation pipeline Brain search | `creationPipeline.ts`, `build.ts` | ~50 |
| G7 — Synthesis workspace context | `build.ts` | ~15 |
| G8 — Iron Rule 13 | `build.ts` | ~3 |
| G9 — workflow ID in agent tool context | `agentToolRuntime.ts`, `WorkflowEngine.ts` | ~10 |
| G10 — Brain empty-state + onboarding | `KnowledgePage.tsx` | ~40 |
| G11 — Agent-scoped memory | `schema.ts`, `WorkflowEngine.ts`, `specialist.ts`, `agentToolRuntime.ts`, agent detail UI | ~130 |

Total: approximately 473 lines of net new or modified code across 13 files.

---

## What Gets Better

After full integration:

- Every agent task with a non-trivial prompt automatically receives the 3 most relevant KB passages before the LLM generates a response. No workflow graph changes required.
- `planner`, `analyst`, `monitor`, and `researcher` agents can write structured observations to MEMORY.md during a run. The next run starts knowing what the previous one learned.
- Cron and persistent-listener workflows can store run cursors, deduplication keys, and accumulating findings in `workflow_kv_entries` and read them back from agent tool loops — true stateful automation.
- The workflow builder places `knowledge` nodes with content-aware queries and `workflow_store` nodes for recurring workflows, because the synthesis prompt now has actual Brain content to reason from.
- Operators see KB search frequency, last-used timestamps, and which workflows query each KB — making the Brain legible and auditable.
- New operators land on a Brain page that tells them exactly what to do and why, instead of an unlabeled list of empty knowledge bases.
- Each agent builds its own personal memory across all the workflows and tasks it runs. A researcher that investigated competitors last month starts its next task already knowing what it found. The agent detail page makes that memory visible, browsable, and clearable.

---

## Implementation Log — 2026-05-24

Status: **shipped** to `main`. All gaps implemented end-to-end; `@agentis/core`, `@agentis/db`, `@agentis/api`, `@agentis/web` typecheck clean; the API boots and applies the new migration on a real DB. Where reality diverged from the plan's assumptions, it is recorded below (the plan was written against a slightly stale read of the code).

### Per-gap outcome

| Gap | Outcome | Notes / corrections |
|---|---|---|
| G1 — KB injection into agent context | Done | Implemented via `BuildContextOptions.knowledgeQuery` + `knowledgeBases` on `buildContextBlock()`; `WorkflowEngine.#withWorkspaceContext()` passes the task prompt as the query. Best-effort, never blocks dispatch. |
| G2 — `memory_append` | Done | Added to `AgentTool` + `ROLE_TOOLS` (planner/researcher/analyst/monitor) + runtime case. Requires `workspaceIntelligence` in `AgentToolRuntime` deps (wired in bootstrap). |
| G3 — `workflow_memory_read/write` | Done | Added tools + runtime cases backed by `WorkflowStoreService`. Scoped by `workflowId` threaded through the tool context. |
| G4 — Brain identity | Done | Sidebar, NodePalette, ContextInspector, canvas callout, home status card, activity popover all relabeled. The graph node `kind` stays `'knowledge'` (data contract); only display text changed. |
| G5 — KB telemetry + empty-KB callout | **Done with deviation** | The empty-KB callout now fires on `bases === 0 \|\| chunks === 0` (via the new `/v1/brain` stats), and per-KB chunk/last-indexed stats are surfaced on the Brain page. The plan's `kb_search_log` table was **deliberately not built** — a write-on-every-search telemetry table was judged not worth the extra migration + hot-path write for V1; usage legibility is delivered through Brain stats instead. Revisit if per-query audit trails are needed. |
| G6 — Creation-pipeline Brain search | Done | `buildWorkspaceInventory(deps, workspaceId, request?)` now returns `knowledgeExcerpts`; synthesis prompt renders a `BRAIN CONTEXT FOR THIS REQUEST` block. |
| G7 — Synthesis workspace context | **Already done — false gap** | `buildWorkspaceInventory()` already calls `workspaceIntelligence.buildContextBlock()` and `synthesizeWithLlm()` already prepends it. No change needed. |
| G8 — Iron Rule 13 | Done | Added to `SYNTHESIS_ARCHITECT_PREAMBLE`; count updated 12 → 13. |
| G9 — workflow ID in tool context | Done | Added `AgentToolContext { workflowId?, agentId? }`; threaded through `AgentToolLoop` → `AgentToolRuntime.execute()` and from `#maybeRunAgentToolLoop`. |
| G10 — Brain page + onboarding | **Done, rebuilt** | `KnowledgePage.tsx` was replaced by `BrainPage.tsx`: an Overview surface (stats, honest gap banners, the four strata) plus the existing Documents / Knowledge Bases tabs. Empty-state + blank-context nudges come from the backend `gaps[]`. Route: `/brain` is canonical, `/knowledge` kept as an alias. |
| G11 — Agent-scoped memory | Done | New `agent_memories` table (migration v39; v2-v38 are reserved by older builds) + `AgentMemoryService`; `memory_append` gained a `scope: 'workspace' \| 'agent'` arg; new `agent_memory_search` tool; agent memory injected into each dispatch preamble (`<agent_memory>`); agent detail page gained a **Memory** tab. |

### Architecture decisions beyond the plan

- **New composed surface.** Added `BrainService` (`/v1/brain`) returning a single `BrainOverview` (core type `packages/core/src/types/brain.ts`) stitched from context files + MEMORY.md, knowledge bases (with chunk stats), workflow memory, and an agent-memory roll-up — with `gaps[]` so absence is shown honestly rather than faked. The frontend composes nothing itself.
- **App-free by construction.** None of the Brain code references the apps concept (no `appId`, no `agent_packages`, no app graph). The Brain here is strictly workspace-scoped.
- **Four memory scopes, complete.** workspace (MEMORY.md) · workflow (`workflow_kv_entries`) · knowledge bases · **agent** (`agent_memories`). G11 closed the missing fourth scope.

### Verification
- Typecheck: core, db, api, web — all clean.
- Tests: `creationPipeline` (11), `WorkflowEngine.agentToolLoop` (1), `migrate` (6, incl. the v2 path), plus new `brain.test.ts` (6) and `agentMemory.test.ts` (8) — all green.
- Runtime: API boots, v2 migration applies on the existing DB, `/v1/brain` registered and auth-gated (401 vs 404 for unknown).
- **Not verified:** the rendered authenticated Brain page / agent Memory tab in a browser — the local DB has a generated password and test mode is off, so login wasn't possible. The web bundle typechecks and the endpoints it consumes are confirmed; the UI itself was not exercised live.

### Follow-up flagged (out of scope, needs a decision)
`main` already ships **visible apps-concept code** unrelated to this work: the `{{apps.*}}` template namespace (live resolver case in `templateResolver.ts`), chat tools `agentis.app.compose` / `agentis.apps.status` / `agentis.apps.run_status` (with "App Canvas", "installed app", "fleet view" language), the `agent_packages` schema table, and assorted "Brain-apps will…" forward-looking comments. If the apps future version must be invisible to engineers reading the codebase, excising this is a separate, deliberate effort (schema + chat tools + resolver + comments) with real blast radius — not folded into the Brain integration.

