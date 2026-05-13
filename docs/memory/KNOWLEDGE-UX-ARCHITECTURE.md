# Knowledge UX Architecture
## How Users Feed Agentis With Intelligence

> Status: implementation specification
> Date: 2026-05-12
> Scope: all user-facing surfaces for knowledge ingestion, memory management,
>        and data feeding — at workspace, app, agent, and workflow levels
> Depends on: MEMORY-ARCHITECTURE.md, APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md,
>             THE-BRAIN-UX-ARCHITECTURE.md, AGENTIS-APP-FORMAT.md

---

## The Problem This Document Solves

The knowledge backend is fully implemented.

`KnowledgeStore`, `AppMemoryStore`, `DatasetIngestion`, `EpisodicMemoryStore`,
`MemoryRuntime`, `BrainComposer` — all wired, tested, running.

`DataImportPanel` — a production-ready drag-and-drop file upload component with
preview, progress streaming, and format detection — exists and works.

None of it is reachable by users.

The Brain page is a read-only intelligence observatory. Users can see what's there
but have no path to put anything there. There is no "Knowledge" entry in the
sidebar. The import panel sits orphaned in `components/apps/DataImportPanel.tsx`,
imported by zero pages.

This document defines the UX architecture to close that gap completely.

The principle is simple:

**Every surface where intelligence is used must be within one click of the
surface where intelligence is created.**

---

## Table of Contents

1. [UX Strategy — Four Feeding Paths](#1-ux-strategy--four-feeding-paths)
2. [Path A — Workspace Knowledge Hub](#2-path-a--workspace-knowledge-hub)
3. [Path B — App Brain: Intelligence Manager](#3-path-b--app-brain-intelligence-manager)
4. [Path C — Agent Knowledge Tab](#4-path-c--agent-knowledge-tab)
5. [Path D — Workflow Knowledge Node](#5-path-d--workflow-knowledge-node)
6. [Cross-Path: Empty States As Invitations](#6-cross-path-empty-states-as-invitations)
7. [Cross-Path: The Knowledge Primer (Onboarding)](#7-cross-path-the-knowledge-primer-onboarding)
8. [Implementation Plan — Priority Order](#8-implementation-plan--priority-order)
9. [Component Inventory](#9-component-inventory)
10. [API Surface Checklist](#10-api-surface-checklist)
11. [Navigation & Routing Changes](#11-navigation--routing-changes)

---

## 1. UX Strategy — Four Feeding Paths

Agentis has four scopes where knowledge matters. Each has a distinct user intent,
a distinct type of data, and must have its own front door:

```
SCOPE           INTENT                        DATA TYPE
---------------------------------------------------------------------------
Workspace       "Our company knows this"      Documents, policies, references,
                                              shared knowledge bases

App             "This app knows my business"  Domain datasets, CRM exports,
                                              evaluator examples, seed facts

Agent           "This agent always does this" Instructions, preferences, rules,
                                              behavioral facts

Workflow        "At this step, use this data" Inline reference docs, context
                                              injections, retrieval nodes
```

Each path is fully independent. A user working with an agent never needs to
understand the full memory architecture. They just need to see "Memory" on the
agent page and be able to add a rule.

The paths do share a design language:

- **Write surfaces** use a consistent card-based item list with inline add
- **Import surfaces** use the drag-drop `DataImportPanel` component
- **Empty states** always include a specific, actionable prompt — never just
  "Nothing here yet."
- **Confidence, trust, and source** are shown on every item so operators can
  understand where intelligence came from

---

## 2. Path A — Workspace Knowledge Hub

### 2.1 What it is

A first-class sidebar entry. The workspace's central place for shared intelligence
that any app or agent can draw from.

This is where an operator uploads the company handbook, pastes API documentation,
adds brand guidelines, imports a customer FAQ, or records standing business rules.

### 2.2 Where it lives

**Route:** `/knowledge`
**Sidebar:** Add `{ to: '/knowledge', label: 'Knowledge', icon: BookOpen }` to
the `NAV` array in `apps/web/src/components/Sidebar.tsx` — position between
`/packages` and `/brain`.

### 2.3 Page structure

```
KnowledgePage
  ├─ Header: "Workspace Knowledge"
  │   subtitle: "Shared intelligence available to all apps and agents"
  │   [+ Add document]  [+ Add knowledge base]
  │
  ├─ TabBar: [Documents]  [Knowledge Bases]  [Memory]  [Episodes]
  │
  ├─ Tab: Documents
  │   ├─ DropZone (full-width, prominent)
  │   │   "Drop files here — PDF, Markdown, plain text, CSV"
  │   │   "or click to browse"
  │   ├─ FormatHint row: "Supported: .txt .md .pdf .csv .json .docx"
  │   └─ DocumentList
  │       [SearchInput]
  │       <DocumentRow> × n
  │         title | source tag | chunk count | added date | [Delete]
  │
  ├─ Tab: Knowledge Bases
  │   ├─ Empty: "No knowledge bases yet. A knowledge base groups related
  │   │   documents for targeted retrieval. [Create your first base →]"
  │   └─ KnowledgeBaseList
  │       <KnowledgeBaseCard> × n
  │         name | doc count | last updated | [Open] [Delete]
  │         [Open → KnowledgeBasePage]
  │
  ├─ Tab: Memory
  │   ├─ MemoryWriteForm (always visible at top)
  │   │   Kind: [Fact] [Rule] [Preference] [Pattern] [Lesson]
  │   │   Title: _______________
  │   │   Content: (textarea, 3 rows)
  │   │   [Save to workspace memory]
  │   └─ MemoryList
  │       <MemoryEntryRow> × n
  │         kind badge | title | content preview | trust bar | [Archive] [Edit]
  │
  └─ Tab: Episodes
      subtitle: "Lessons promoted automatically from workflow runs"
      [Filter: all | decision | failure | recovery | correction | pattern]
      <EpisodeRow> × n
        type badge | summary | confidence | promoted from run link | date
```

### 2.4 KnowledgeBasePage

Drilled into from the Knowledge Bases tab:

```
/knowledge/bases/:knowledgeBaseId

KnowledgeBasePage
  ├─ Header: [← Back]  "Base name"  [Edit name]  [Delete base]
  │
  ├─ DocDropZone — same drag-drop as top level but scoped to this base
  │
  ├─ SearchBar: "Search this base..."
  │   → calls POST /v1/knowledge-bases/:id/search
  │   → shows semantic search results inline
  │
  └─ DocumentList (same as top-level Documents tab, scoped to base)
```

### 2.5 File upload behavior

When a file is dropped on any drop zone in this path:

1. File is read as text (`File.text()`)
2. MIME type is inferred from extension if not provided
3. POST to `/v1/knowledge-bases/:id/documents` with `{name, mimeType, content}`
4. Success: row appears in document list with a "processing" badge
5. After 1s (polling or realtime): badge updates to "indexed" with chunk count
6. Error: inline error message on the row; file not added

For PDFs: the API's `extractText()` in `knowledgeBase.ts` handles extraction.
No client-side PDF parsing needed.

### 2.6 Component files to create

```
apps/web/src/pages/KnowledgePage.tsx
apps/web/src/pages/KnowledgeBasePage.tsx
apps/web/src/components/knowledge/WorkspaceDocDropZone.tsx
apps/web/src/components/knowledge/DocumentList.tsx
apps/web/src/components/knowledge/DocumentRow.tsx
apps/web/src/components/knowledge/KnowledgeBaseList.tsx
apps/web/src/components/knowledge/KnowledgeBaseCard.tsx
apps/web/src/components/knowledge/WorkspaceMemoryTab.tsx
apps/web/src/components/knowledge/MemoryWriteForm.tsx
apps/web/src/components/knowledge/MemoryEntryRow.tsx
apps/web/src/components/knowledge/EpisodesTab.tsx
apps/web/src/components/knowledge/EpisodeRow.tsx
```

---

## 3. Path B — App Brain: Intelligence Manager

### 3.1 The problem with the current Brain tab

The current `AppDetailPage` Brain tab renders `<BrainView slug={slug} />`.

`BrainView` is a read-only intelligence observatory — it shows the map, the flow,
the ledger. It is beautiful. It is the right answer for "what does this app know."

But it answers zero of the question "how do I make this app know more."

The Brain tab must split into two sub-modes:

```
[Brain] tab
  ├─ [Map]     ← current BrainView (unchanged, unchanged API)
  └─ [Manage]  ← new write surface
```

The switcher is a compact segmented control inside the Brain tab header, not a
new top-level layer. The [Output] / [Canvas] / [Brain] tri-switcher stays exactly
as it is.

### 3.2 The Manage sub-mode

```
AppDetailPage → [Brain] → [Manage]

BrainManageView
  ├─ Header stat strip: n knowledge chunks | n memory entries | n evaluator examples
  │
  ├─ SectionCard: "Data Sources"
  │   subtitle: "Import your business data so this app can use it"
  │   └─ DataImportPanel (ALREADY BUILT — just mount it here)
  │       props: { appSlug, datasets, latestJobs, onRefresh }
  │       ← fetched from GET /v1/apps/:slug/intelligence
  │
  ├─ SectionCard: "Memory"
  │   subtitle: "Facts, rules, and preferences this app always remembers"
  │   ├─ MemoryWriteForm (kind selector + title + content + [Save])
  │   │   → POST /v1/apps/:slug/memory
  │   └─ MemoryEntryList
  │       → GET /v1/apps/:slug/memory
  │       each row: kind badge | title | content | trust | [Edit] [Archive]
  │
  └─ SectionCard: "Evaluator Examples"
      subtitle: "Examples that define what good and bad outputs look like"
      ├─ EvaluatorExampleForm
      │   Evaluator key: _____  Input: (textarea)
      │   Expected: (textarea)  Verdict: [Pass] [Fail]
      │   [Add example]
      │   → POST /v1/apps/:slug/evaluators/examples
      └─ EvaluatorExampleList
          → GET /v1/apps/:slug/evaluators/examples
```

### 3.3 DataImportPanel mounting — the minimal change

`DataImportPanel` is already feature-complete. The only missing work is:

1. Fetch `datasets` and `latestJobs` from `GET /v1/apps/:slug/intelligence`
   (the response already includes `datasetSpecs` and ingestion status)
2. Pass them as props to `DataImportPanel`
3. Mount `DataImportPanel` inside `BrainManageView`

This is a ~40-line change to `AppDetailPage.tsx` plus a new
`apps/web/src/components/brain/BrainManageView.tsx` file.

### 3.4 The Map / Manage switcher anatomy

```
BrainTabHeader
  ┌────────────────────────────────────┐
  │ [Map view]  [Manage]               │  ← compact pill-switcher, right-aligned
  │  ↑ selected by default                in the Brain tab sub-header
  └────────────────────────────────────┘
```

State lives in `AppDetailPage` alongside the existing `layer` state:
```ts
const [brainMode, setBrainMode] = useState<'map' | 'manage'>('map');
```

When `layer === 'brain'`:
- `brainMode === 'map'`    → render `<BrainView slug={slug} />`
- `brainMode === 'manage'` → render `<BrainManageView slug={slug} />`

URL persistence: append `?brain=manage` so direct links work.

### 3.5 Intelligence gaps as calls to action

When `BrainView` is in Map mode and there are zero knowledge nodes, the empty
stage should not just show an empty SVG. It should render an invitation:

```
EmptyBrainStage (shown when allNodes.length === 0 or only core node present)

  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │   [Brain icon — large, faint]                        │
  │                                                      │
  │   This app's intelligence is empty.                  │
  │                                                      │
  │   Import your business data, add facts this app      │
  │   should always know, and provide evaluator          │
  │   examples to calibrate its judgment.                │
  │                                                      │
  │   [Go to Manage →]                                   │
  │                                                      │
  └──────────────────────────────────────────────────────┘
```

The `[Go to Manage →]` button switches `brainMode` to `'manage'`.

### 3.6 Component files to create / modify

```
apps/web/src/components/brain/BrainManageView.tsx       (new)
apps/web/src/components/brain/BrainTabHeader.tsx         (new)
apps/web/src/components/brain/EmptyBrainStage.tsx        (new)
apps/web/src/pages/AppDetailPage.tsx                     (modify — add brainMode state, mount BrainManageView)
```

---

## 4. Path C — Agent Knowledge Tab

### 4.1 The current state

`AgentDetailPage` has a Memory tab. It fetches `/v1/agents/:id/memory` and shows
a filtered read-only list. There is no write action.

### 4.2 What it should do

The Memory tab is the single most accessible place to teach an agent something.
Most operators do not understand memory layers, Brain pages, or embedding
pipelines. They understand: "I want this agent to always do X."

The Memory tab must become an editable instruction layer.

### 4.3 New Memory tab design

```
AgentDetailPage → Memory tab

MemoryTab
  ├─ Section: "What this agent knows"
  │   subtitle: "Rules, facts, and preferences that always apply"
  │
  ├─ AgentMemoryWriteForm (always visible at top)
  │   ┌────────────────────────────────────────────────────┐
  │   │ Kind: [Rule ▼]  (Fact | Rule | Preference | Lesson) │
  │   │ Title: ________________________________             │
  │   │ Content:                                            │
  │   │ ┌──────────────────────────────────────┐           │
  │   │ │ (textarea, 3 rows)                    │           │
  │   │ └──────────────────────────────────────┘           │
  │   │                         [Save to agent memory]     │
  │   └────────────────────────────────────────────────────┘
  │   → POST /v1/agents/:agentId/memory
  │
  ├─ Filter pills: [All]  [Rules]  [Facts]  [Preferences]  [Lessons]
  │   + source filter: [all] [manual] [promoted]
  │
  └─ MemoryEntryList
      each entry:
        ┌────────────────────────────────────────────────┐
        │ [kind badge]  Title                [Edit] [×]  │
        │ Content preview (2 lines, expand on click)     │
        │ trust ████░░  source: manual  added 3d ago     │
        └────────────────────────────────────────────────┘
      empty state:
        "No memories yet.
         Add a rule, fact, or preference to shape how this agent behaves.
         These are injected into every task this agent runs."
```

### 4.4 API requirements

The `/v1/agents/:agentId/memory` POST endpoint needs to accept:
```
{ kind: 'fact'|'rule'|'preference'|'pattern'|'lesson', title: string, content: string }
```

This writes to `AppMemoryStore` with `source: 'operator'` and the agent's
`appId`. The existing `GET /v1/agents/:id/memory` already returns entries;
the `POST` is a small addition to `apps/api/src/routes/agents.ts`.

### 4.5 The "Instructions vs Memory" distinction

The existing Instructions tab is for the agent's system prompt — the big text
block that defines its persona and primary objective. That stays as-is.

Memory is for **permanent discrete facts** that supplement the system prompt:
- "Always format currency as USD with 2 decimal places"
- "The customer success SLA is 4 business hours"
- "Never suggest competitors in responses"

These are injected at the top of every task context via `MemoryRuntime.searchKnowledge`
(the recall path in `AppMemoryStore`). The distinction should be visible in the UI:

```
Instructions tab: [long-form system prompt editor]
Memory tab:       [discrete, editable fact/rule cards] ← always-on injection
```

### 4.6 Component files to modify

```
apps/web/src/pages/AgentDetailPage.tsx    (modify MemoryTab function)
apps/api/src/routes/agents.ts              (add POST /:id/memory handler)
```

---

## 5. Path D — Workflow Knowledge Node

### 5.1 What it is

The `knowledge` node type already exists in `WorkflowEngine` (dispatched at
L661). It retrieves from the knowledge store during a run. But the node's
configuration UX in `ContextInspector` is minimal.

This path is about making the knowledge node's config surface clear enough that
a workflow builder understands: "I can point this node at my business data and
the agent in the next node will have it."

### 5.2 Knowledge node inspector — current vs target

**Current:**
The `knowledge` node kind likely shows a generic config form with raw JSON or
a query string field. No reference to the actual knowledge bases that exist.

**Target:**
```
ContextInspector → Configure tab → knowledge node

KnowledgeNodeConfig
  ├─ Section: "What to retrieve"
  │   Query mode: [Static] [Dynamic — from previous node output]
  │   Static query: ___________________________
  │   Dynamic path: (shows when Dynamic selected)
  │     "From node:" [node selector dropdown]
  │     "Path:" ____________ (e.g. $.output.topic)
  │
  ├─ Section: "Where to look"
  │   Source: [All workspace knowledge]
  │            [Specific knowledge base ▼]
  │              → shows list of existing knowledge bases from GET /v1/knowledge-bases
  │
  ├─ Section: "Retrieval settings"
  │   Top K: [8 ▼] (3 / 5 / 8 / 12 / 20)
  │   Mode:  [Hybrid ▼] (Lexical | Vector | Hybrid)
  │
  └─ Section: "Preview"
       [Test retrieval →] button
       → sends query to POST /v1/knowledge-bases/:id/search
       → shows top 3 results inline in inspector
       → so builder can verify before saving
```

### 5.3 "Add knowledge" shortcut from the canvas

When a workflow has a `knowledge` node and zero knowledge bases exist, the
canvas should show a contextual callout on that node:

```
KnowledgeNodeEmpty (overlay or node footer)
  "No knowledge bases found in this workspace.
   [Create a knowledge base →]"
   → navigates to /knowledge?create=1
```

### 5.4 Component files to modify

```
apps/web/src/components/canvas/ContextInspector.tsx   (modify knowledge node config section)
apps/web/src/components/canvas/WorkflowNode.tsx        (add empty-knowledge warning footer)
```

---

## 6. Cross-Path: Empty States As Invitations

Empty states are the highest-leverage UX change in the knowledge system.

Every surface where knowledge can exist but doesn't yet should show a specific,
actionable prompt that tells the user exactly what to do next.

### 6.1 Empty state design rules

1. **Never just say "Nothing here yet."** — say what would be here and why it matters
2. **Always include one primary action** — a button that goes directly to the create/import surface
3. **One secondary context line** — what effect the data will have when added
4. **Consistent visual** — faint icon, 14px primary text, 12px secondary, one button

### 6.2 Empty state catalog

| Location | Empty text | Primary action |
|---|---|---|
| Workspace → Knowledge (no docs) | "No documents yet. Upload files or paste text to give agents shared context." | [Upload your first document] |
| App Brain → Manage → Data Sources (no datasets declared) | "This app has no dataset specs. Add dataset specs to the app package to enable imports." | [Edit package →] |
| App Brain → Manage → Memory (no entries) | "No memory entries. Add facts, rules, and preferences that this app should always know." | [Add memory entry] |
| App Brain → Map (no knowledge nodes) | "This app's intelligence is empty. Import business data or add memory entries to see the knowledge graph fill in." | [Go to Manage →] |
| Agent Memory (no entries) | "No memories. Add rules, facts, or preferences to shape how this agent behaves on every task." | [Add memory] |
| Agent Memory — promoted (none) | "No promoted memories yet. Memories accumulate automatically as this agent completes tasks." | — |
| Brain page (workspace, zero nodes) | "The workspace brain is empty. Import documents, add knowledge bases, or run a few workflows to start accumulating intelligence." | [Open Knowledge Hub →] |

### 6.3 Promoted memory notification

When a run completes and `RunPromotionExtractor` promotes one or more episodes,
a subtle toast should appear:

```
[Brain icon]  "2 lessons learned from this run"
              "View in Brain →"
```

This closes the feedback loop: operators see that running workflows builds
intelligence. It is one of the most important trust signals in the product.

Implementation: subscribe to `RUN_COMPLETED` in a global hook, call
`GET /v1/memory/promotions?runId=:id&limit=1` to check for new promotions,
show toast if found.

---

## 7. Cross-Path: The Knowledge Primer (Onboarding)

### 7.1 The problem

A new user who has never heard of "knowledge bases" or "memory layers" will
navigate to an empty workspace and not know where to start feeding the platform.

The sidebar item `/knowledge` helps, but it is passive — they need to find it.

### 7.2 The solution: Workspace Intelligence Card on HomePage

`HomePage` shows the stat bar and agent fleet. Add a **KnowledgeStatusCard**
below the stat bar (or in the right rail) that is visible when the workspace
has no knowledge:

```
KnowledgeStatusCard (shown when knowledgeChunks === 0 AND memoryEntries === 0)

  ┌────────────────────────────────────────────────────────┐
  │  [BookOpen icon]   Your workspace has no knowledge     │
  │                                                        │
  │  Agents and apps run with general intelligence         │
  │  by default. Add your company's data to make them      │
  │  domain experts.                                       │
  │                                                        │
  │  [Upload documents →]     [Learn more]                 │
  └────────────────────────────────────────────────────────┘
```

Once any knowledge exists, this card disappears permanently (localStorage flag
`agentis.knowledge.primer.dismissed` or by checking the count on load).

### 7.3 App activation knowledge prompt

When a user opens a new app for the first time (`AppDetailPage` with no runs,
no knowledge), the Output tab should show an activation card above the metrics:

```
AppKnowledgeActivationCard (shown when app has no knowledge AND no runs)

  ┌────────────────────────────────────────────────────────┐
  │  Before you run this app, teach it about your business │
  │                                                        │
  │  [1] Import your data                                  │
  │      → [Go to Brain → Manage →]                        │
  │  [2] Add a few memory rules (optional)                 │
  │      → [Go to Brain → Manage →]                        │
  │  [3] Run the app                                       │
  │      [Run now →]                                       │
  └────────────────────────────────────────────────────────┘
```

This is dismissible with a "Skip for now" link. Dismissed state stored per
appId in localStorage.

---

## 8. Implementation Plan — Priority Order

Each item is independent. They can be shipped in any order.
The priority ranking is by user-visible impact per implementation hour.

### P0 — Unblocks the entire data ingestion flow (2 hours)

**Mount `DataImportPanel` in App Brain**

1. Create `apps/web/src/components/brain/BrainManageView.tsx`
   - Fetch `GET /v1/apps/:slug/intelligence` for `datasets` and `latestJobs`
   - Import and render `<DataImportPanel ... />`
   - Add `MemoryWriteForm` section below
2. Add `brainMode: 'map' | 'manage'` state to `AppDetailPage`
3. Render `<BrainTabHeader>` inside the Brain layer with mode switcher
4. Render `<BrainManageView>` when `brainMode === 'manage'`

---

### P1 — Visible write surface on the most-used page (1.5 hours)

**Agent Memory write form**

1. Add `MemoryWriteForm` to `MemoryTab` in `AgentDetailPage.tsx`
2. Add `POST /v1/agents/:id/memory` route to `apps/api/src/routes/agents.ts`
   - Body: `{ kind, title, content }`
   - Writes to `AppMemoryStore` with `source: 'operator'`, `appId` from agent row

---

### P2 — Workspace-level front door (4 hours)

**Workspace Knowledge Hub**

1. Add `/knowledge` to Sidebar `NAV` array (between `/packages` and `/brain`)
2. Create `KnowledgePage.tsx` with the four-tab layout described in §2.3
3. Create `KnowledgeBasePage.tsx` for drilled-in base management
4. Create `WorkspaceDocDropZone.tsx` — reusable file upload drop zone
5. Wire to existing API: `GET/POST /v1/knowledge-bases`,
   `POST /v1/knowledge-bases/:id/documents`, `GET/POST /v1/memory`,
   `GET /v1/memory/episodes`
6. Add lazy import and `<Route path="/knowledge" />` in `App.tsx`
   Add `<Route path="/knowledge/bases/:id" />` for the drilled view

---

### P3 — Feedback loop (1 hour)

**Promoted memory toast**

1. Add `useMemoryPromotionNotifier` hook in `apps/web/src/lib/memoryPromotion.ts`
   - Subscribes to `REALTIME_EVENTS.RUN_COMPLETED` via `useRealtime`
   - On event: `GET /v1/memory/promotions?runId=:id&after=now-30s&limit=1`
   - If promotions found: `toast.info('Lessons learned from this run', n + ' episodes promoted')`
   - Includes `[View in Brain →]` link in toast
2. Mount hook in `App.tsx` (global, single instance)

---

### P4 — Empty states (2 hours)

**Empty state sweep**

1. Add `EmptyBrainStage.tsx` — invites to Manage when Brain map is empty
2. Add `KnowledgeStatusCard.tsx` on `HomePage` when workspace has no knowledge
3. Add `AppKnowledgeActivationCard.tsx` on `AppDetailPage` Output tab for new apps
4. Update all existing `"Nothing here yet"` strings in knowledge/memory contexts
   with the copy from §6.2

---

### P5 — Workflow knowledge node inspector (2 hours)

**Knowledge node config**

1. Update `ContextInspector.tsx` knowledge node config section with:
   - Dynamic query toggle
   - Knowledge base selector (fetches from API)
   - Top K + retrieval mode dropdowns
   - "Test retrieval" inline preview
2. Add empty-knowledge callout on `WorkflowNode.tsx` for knowledge kind nodes
   when workspace has no knowledge bases

---

## 9. Component Inventory

### New components to create

| Component | Path | Purpose |
|---|---|---|
| `KnowledgePage` | `pages/KnowledgePage.tsx` | Workspace knowledge hub |
| `KnowledgeBasePage` | `pages/KnowledgeBasePage.tsx` | Drilled-in base view |
| `WorkspaceDocDropZone` | `components/knowledge/WorkspaceDocDropZone.tsx` | Reusable file drop zone |
| `DocumentList` | `components/knowledge/DocumentList.tsx` | Document table with search |
| `DocumentRow` | `components/knowledge/DocumentRow.tsx` | Single doc row with actions |
| `KnowledgeBaseList` | `components/knowledge/KnowledgeBaseList.tsx` | Base cards grid |
| `KnowledgeBaseCard` | `components/knowledge/KnowledgeBaseCard.tsx` | Single base card |
| `WorkspaceMemoryTab` | `components/knowledge/WorkspaceMemoryTab.tsx` | Memory write+list for workspace |
| `MemoryWriteForm` | `components/knowledge/MemoryWriteForm.tsx` | Shared write form (used in 3 places) |
| `MemoryEntryRow` | `components/knowledge/MemoryEntryRow.tsx` | Single memory card |
| `EpisodesTab` | `components/knowledge/EpisodesTab.tsx` | Promoted episodes list |
| `EpisodeRow` | `components/knowledge/EpisodeRow.tsx` | Single episode card |
| `BrainManageView` | `components/brain/BrainManageView.tsx` | App Brain write surface |
| `BrainTabHeader` | `components/brain/BrainTabHeader.tsx` | Map/Manage switcher |
| `EmptyBrainStage` | `components/brain/EmptyBrainStage.tsx` | Empty Brain map invitation |
| `KnowledgeStatusCard` | `components/home/KnowledgeStatusCard.tsx` | Homepage primer card |
| `AppKnowledgeActivationCard` | `components/apps/AppKnowledgeActivationCard.tsx` | App onboarding card |

### Existing components to modify

| Component | Change |
|---|---|
| `Sidebar.tsx` | Add `/knowledge` nav item with `BookOpen` icon |
| `App.tsx` | Add `/knowledge` and `/knowledge/bases/:id` routes |
| `AppDetailPage.tsx` | Add `brainMode` state, `BrainTabHeader`, `BrainManageView` |
| `AgentDetailPage.tsx` | Add `MemoryWriteForm` to `MemoryTab`, wire POST endpoint |
| `ContextInspector.tsx` | Enhance knowledge node config section |
| `WorkflowNode.tsx` | Add empty-knowledge warning for knowledge nodes |
| `HomePage.tsx` | Mount `KnowledgeStatusCard` |

### Existing component to mount (requires no changes)

| Component | Mount location |
|---|---|
| `DataImportPanel` | `BrainManageView` — just import and render with correct props |

---

## 10. API Surface Checklist

All backend routes are already implemented. This section confirms which routes
each frontend surface depends on, so nothing is accidentally missed.

### Workspace Knowledge Hub

| Route | Used by |
|---|---|
| `GET /v1/knowledge-bases` | KnowledgePage — list bases |
| `POST /v1/knowledge-bases` | KnowledgePage — create base |
| `GET /v1/knowledge-bases/:id` | KnowledgeBasePage — header |
| `GET /v1/knowledge-bases/:id/documents` | DocumentList |
| `POST /v1/knowledge-bases/:id/documents` | WorkspaceDocDropZone + inline add |
| `POST /v1/knowledge-bases/:id/search` | KnowledgeBasePage search bar |
| `GET /v1/memory` | WorkspaceMemoryTab list |
| `POST /v1/memory` | MemoryWriteForm → workspace scope |
| `PATCH /v1/memory/:id` | MemoryEntryRow edit |
| `DELETE /v1/memory/:id` | MemoryEntryRow archive |
| `GET /v1/memory/episodes` | EpisodesTab |

### App Brain Manage

| Route | Used by |
|---|---|
| `GET /v1/apps/:slug/intelligence` | BrainManageView — datasets + jobs |
| `POST /v1/apps/:slug/data/:key/preview` | DataImportPanel (already wired) |
| `POST /v1/apps/:slug/data/:key/ingest` | DataImportPanel (already wired) |
| `GET /v1/apps/:slug/data/:key/progress` | DataImportPanel (already wired) |
| `DELETE /v1/apps/:slug/data/:key` | DataImportPanel (already wired) |
| `GET /v1/apps/:slug/memory` | BrainManageView memory section |
| `POST /v1/apps/:slug/memory` | MemoryWriteForm → app scope |
| `GET /v1/apps/:slug/evaluators/examples` | BrainManageView evaluators section |
| `POST /v1/apps/:slug/evaluators/examples` | EvaluatorExampleForm |

### Agent Memory

| Route | Used by |
|---|---|
| `GET /v1/agents/:id/memory` | MemoryTab (already implemented) |
| `POST /v1/agents/:id/memory` | MemoryWriteForm — **needs to be added** |

### Brain Feedback

| Route | Used by |
|---|---|
| `GET /v1/memory/promotions` | `useMemoryPromotionNotifier` hook |

### Workflow Knowledge Node

| Route | Used by |
|---|---|
| `GET /v1/knowledge-bases` | ContextInspector knowledge base selector |
| `POST /v1/knowledge-bases/:id/search` | ContextInspector "Test retrieval" |

---

## 11. Navigation & Routing Changes

### Sidebar change

File: `apps/web/src/components/Sidebar.tsx`

Add to `NAV` array, after `/packages`, before `/brain`:

```ts
{ to: '/knowledge', label: 'Knowledge', icon: BookOpen },
```

Import `BookOpen` from `'lucide-react'`.

### App.tsx route additions

```tsx
const KnowledgePage = lazy(() =>
  import('./pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage }))
);
const KnowledgeBasePage = lazy(() =>
  import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage }))
);
```

```tsx
<Route path="/knowledge" element={<KnowledgePage />} />
<Route path="/knowledge/bases/:knowledgeBaseId" element={<KnowledgeBasePage />} />
```

Both routes sit inside the authenticated shell alongside the existing routes.

### App Brain URL convention

The `brainMode` state is URL-reflected as `?brain=manage` or `?brain=map`.
When `AppDetailPage` mounts with `?brain=manage`, it initialises `brainMode`
to `'manage'` and `layer` to `'brain'` automatically.

This allows deep links from empty state CTAs:
- `/apps/:slug?layer=brain&brain=manage` → opens Brain → Manage directly
- `/apps/:slug?layer=brain&brain=manage#datasets` → scrolls to Data Sources

---

## Design Tokens and Visual Conventions

All knowledge-related UI follows these conventions for consistency:

### Kind badge colors

| Memory kind | Color class |
|---|---|
| `fact` | `bg-blue-500/15 text-blue-200 border-blue-400/30` |
| `rule` | `bg-rose-500/15 text-rose-200 border-rose-400/30` |
| `preference` | `bg-violet-500/15 text-violet-200 border-violet-400/30` |
| `pattern` | `bg-amber-500/15 text-amber-200 border-amber-400/30` |
| `lesson` | `bg-teal-500/15 text-teal-200 border-teal-400/30` |

### Episode type badge colors

| Episode type | Color class |
|---|---|
| `decision` | `bg-blue-500/15 text-blue-200` |
| `failure` | `bg-rose-500/15 text-rose-200` |
| `recovery` | `bg-teal-500/15 text-teal-200` |
| `correction` | `bg-amber-500/15 text-amber-200` |
| `pattern` | `bg-violet-500/15 text-violet-200` |

### Trust bar rendering

```tsx
// Trust is 0..1. Always show as a small colored bar.
function TrustBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? 'bg-teal-400' : value >= 0.5 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-text-muted">{pct}%</span>
    </div>
  );
}
```

### Source badge

```tsx
function SourceBadge({ source }: { source: 'seed' | 'operator' | 'promotion' | 'import' }) {
  const labels: Record<string, string> = {
    seed: 'seeded', operator: 'manual', promotion: 'auto-learned', import: 'imported',
  };
  return (
    <span className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[10px] text-text-muted">
      {labels[source] ?? source}
    </span>
  );
}
```

---

## Summary

The knowledge system is one of Agentis's strongest product differentiators.
The backend is production-ready. The gap is entirely in UX access.

Four paths. All independent. All achievable:

| Path | Entry point | Key unblocked capability |
|---|---|---|
| A — Workspace Knowledge Hub | `/knowledge` sidebar item | Upload docs, manage knowledge bases, write workspace memory |
| B — App Brain Manage | App detail → Brain → Manage | Import datasets (DataImportPanel finally mounted), write app memory |
| C — Agent Knowledge | Agent detail → Memory tab | Teach agents rules and facts through the UI |
| D — Workflow Knowledge Node | Canvas inspector | Visual knowledge base selector with live preview |

The single highest-impact change: **mount `DataImportPanel` in `BrainManageView`**.
The component is fully built. It takes one import and a fetch call to unlock the
entire dataset ingestion flow for every app in the platform.

---

*Last updated: 2026-05-12.
 Core backend: fully implemented.
 Frontend write surfaces: all described here as new or modified files.
 No backend work required for P0-P4; P5 requires one new POST route on agents.*
