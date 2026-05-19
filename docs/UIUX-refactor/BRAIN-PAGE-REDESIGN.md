# Agentis Brain 2.0 — Architecture & Redesign Plan

> **Status:** Planning spec — May 2026
> **Scope:** Full Brain surface redesign + Knowledge unification + Interactive graph engine
> **Author:** Architecture review against Obsidian graph UX + Agentis V1 codebase audit
> **Goal:** Make Brain the most powerful, visually compelling, and genuinely useful knowledge
> intelligence surface in any AI agent platform — while staying 100% on-brand with how
> Agentis does Canvas, Apps, and everything else.

---

## 0. The Core Problem Statement

The current Brain page has dots on a canvas. That is not a brain. It is a scatter plot.

When compared to what Obsidian has built with their Graph View — which is fundamentally
just a note-linking tool for humans — Agentis Brain should be *far* more powerful: our atoms
are auto-generated from agent runs, our links encode semantic reasoning relationships,
our graph crosses multiple apps and agents, and it grows in real-time as work happens.

Yet right now:
- 51 atoms exist with **0 links** — every node is an island
- Uploading a document creates chunks but never connects them to each other or to existing atoms
- Nodes cannot be dragged, so the layout is purely decorative
- The Knowledge page (/knowledge) and Brain page (/brain) are two separate nav destinations that share the same conceptual space and confuse operators
- The Episodes subpage shows `Failed to load episodes [object Object]` because `String(err)` is called on an API error object instead of `apiErrorMessage(err)`
- No depth exploration — you cannot click a node and say "show me everything 2 hops away"
- No force controls, no group coloring, no time-lapse, no right-click context menu
- The graph is intellectually inert: it shows you atoms exist but tells you nothing about how they relate

This document defines the plan to fix all of it.

---

## 1. Obsidian Graph View — What Makes It Brilliant

Obsidian's graph view is an 8-year investment in making knowledge connections visually
navigable. These are the specific mechanics that make it compelling, studied against the
screenshots and documentation:

### 1.1 Force Simulation Mechanics (the foundation)
- Every node exerts **repulsion** against every other node (charge force)
- Every link exerts **attraction** between its two endpoints (link force)
- A **center force** prevents the graph from drifting off-screen
- A **collision force** prevents nodes from overlapping
- This produces **organic clusters**: notes that link to each other naturally group together
  spatially without any manual layout work — the structure emerges from the connections

Agentis already implemented D3 force simulation in `brainGraphAdapter.ts`. The problem is
that with 0 links, the force simulation is just repulsion — all nodes push away from center
to the same radius. The simulation needs **links** to produce clusters.

### 1.2 Node Visual Grammar
- **Size = degree** (number of connections). In Obsidian: the more notes link to a given note,
  the larger its circle. This means the most important/connected concepts are visually dominant.
  Hub nodes are big. Orphan nodes are tiny dots. The topology is legible at a glance.
- **Glow / color** encodes category (via user-defined groups)
- **Labels appear on hover** for most nodes; always visible for large/important nodes
- Text fade threshold slider: at low zoom labels disappear to reduce clutter

### 1.3 Interaction Model
- **Drag individual nodes** — you can reposition any node; the force simulation adjusts neighbors
- **Hover** — highlights the hovered node's direct connections; all other nodes dim
- **Click** — opens that note's content in the editor (or in our case, opens inspector)
- **Right-click context menu** — rename, delete, open in new tab, etc.
- **Scroll to zoom** — full range from overview (all 1000 nodes visible) to individual node detail
- **Drag on background** to pan
- **Keyboard shortcuts** `+`/`-` for zoom, arrow keys to pan

### 1.4 Local Graph Mode
This is one of Obsidian's most powerful features and something Agentis doesn't have at all:
- From any note, you can open a **Local Graph** showing only that note plus its neighborhood
- A **depth slider** (1–6) controls how many hops of connections are visible
- At depth 1: only direct neighbors
- At depth 2: neighbors of neighbors
- At depth 3+: the semantic neighborhood expands — you discover non-obvious connections
- This is how users find emergent relationships they didn't know existed

### 1.5 Groups (Colored Node Categories)
- Operators define **groups** by search term or tag
- Each group gets a color; nodes matching multiple groups get the first-matched color
- In Agentis terms: color by `app`, by `agent`, by `adapterType`, by `layer`, by `source`
- Groups make topology legible at 1000+ nodes by turning the graph into a color-coded map

### 1.6 Display & Force Controls Panel
- **Node size** slider — global scale factor
- **Link thickness** slider — makes sparse or dense graphs readable
- **Text fade threshold** — labels disappear at lower zoom levels
- **Arrows** toggle — show/hide link directionality
- **Center force, Repel force, Link force, Link distance** sliders — live adjustment
- **Animate** button — time-lapse: nodes appear in chronological order, links draw in as atoms are created

### 1.7 Orphan Management
- **Orphans toggle** — show/hide nodes with no connections
- In Obsidian, orphan notes are the "unloved" ones. In Agentis, orphan atoms are
  documents that haven't been semantically connected yet — they should be visible
  but visually distinct (dimmer, smaller) to prompt the operator to link them

### 1.8 Backlinks as First-Class Citizens
- Every note in Obsidian shows its **backlinks** (who references it)
- This is a fundamental semantic relationship: not just "what does this atom link to"
  but "what atoms reference this atom"
- In Agentis: which workflows use this chunk? Which agents read this memory? Which
  documents reference concepts in this chunk?

---

## 2. What Agentis Can Do That Obsidian Cannot

Before defining the plan, it's worth naming why Agentis Brain 2.0 should be *more*
impressive than Obsidian, not just equivalent:

| Dimension | Obsidian | Agentis Brain 2.0 |
|---|---|---|
| Knowledge source | Human-authored notes, manually linked | Auto-generated from agent runs, uploaded docs, workflow outputs |
| Link semantics | `[[wikilink]]` — purely referential | Typed: `supports`, `contradicts`, `refines`, `derived_from`, `co_observed`, `used_in` |
| Graph growth | Operator creates notes and links | Graph grows as a side-effect of agents doing work |
| Multi-scope | Single vault | App-scoped + workspace-global, two overlapping graphs |
| Contradiction modeling | Not present | First-class `contradicts` edges + disputed node flag |
| Absence modeling | Not present | Gap nodes show what the system doesn't know |
| Agent attribution | Not present | Every atom is attributed to an agent, adapter, run |
| Confidence / trust | Not present | Every atom has confidence + trust scores, drives visual weight |
| Real-time updates | Not present | Live via WebSocket — new atoms animate in as runs complete |
| Shared intelligence | Manual export | Workspace-global promotion when confidence gate reached |

The plan below is designed to make all of these advantages visually legible.

---

## 3. Unified Brain Surface — Architecture Decision

### 3.1 Merge Brain + Knowledge into one surface

**Current state:** Two nav items, two pages, two teams of features.
- `/brain` → The Brain (global workspace graph)
- `/knowledge` → Workspace Knowledge (documents, bases, memory, episodes)

**Problem:** These are one feature. Knowledge is the *input* to the brain. The brain is
the *visualization and intelligence layer* over the knowledge. Separating them forces
operators to jump between two places to understand and manage the same thing.

**Decision:** Merge into a single `Brain` nav item, with a tab-style mode switcher
identical to how the Apps page handles `Surface / Canvas / Data / Brain / Deploy`:

```
[ Brain ]  ←→  Graph | Documents | Bases | Memory | Episodes
```

The Brain nav item already exists. The Knowledge page becomes its content tabs.
The `/knowledge` route redirects to `/brain?tab=documents`.

### 3.2 Tab structure

| Tab | Content | Maps to (current) |
|---|---|---|
| **Graph** | Force-directed knowledge graph (redesigned) | BrainPage + BrainView |
| **Documents** | Upload zone + document list | KnowledgePage → documents tab |
| **Bases** | Knowledge base grid + drilled view | KnowledgePage → bases tab |
| **Memory** | Workspace memory write + list | KnowledgePage → memory tab |
| **Episodes** | Promoted lessons from runs | KnowledgePage → episodes tab |

### 3.3 Workspace Brain vs. App Brain

The workspace Brain stays at `/brain`. The app Brain stays inside `/apps/:slug` under the
Brain tab (already exists). Both use `BrainView` with `slug=null` vs. `slug=appSlug`.

The tab switcher appears in both contexts. When inside an app, the Documents/Bases/Memory/
Episodes tabs show app-scoped content. When at workspace level, they show workspace-scoped
content. The `BrainView` component already handles this via its `slug` prop.

---

## 4. Interactive Graph — Feature Redesign

### 4.1 Make Nodes Draggable

`BrainStage.tsx` currently sets `nodesDraggable={false}`. This is the single biggest
missing interaction. Change to `nodesDraggable={true}`.

When a node is dragged, pin its position (`fx`, `fy`) in the local layout state so it
stays where the user placed it. Other nodes continue to be force-positioned. This is
exactly what Obsidian does: dragging a node overrides the force for that node while
the rest of the simulation continues.

Store dragged positions in `sessionStorage` keyed by `brainGraphLayout:{workspaceId}:{scope}`
so positions survive page navigations but reset on refresh (no backend persistence needed for v1).

### 4.2 Hover Neighborhood Highlighting

When hovering a node, the `neighborhood` set should activate:
- **Hovered node**: full opacity, scale 1.1, label always visible
- **Direct neighbors**: full opacity, labels visible
- **Connecting edges**: full opacity, animated pulse on `feeds` edges
- **Everything else**: dim to 15% opacity

This is already implemented via the `neighborhood` useMemo + `dim` prop. The gap is
that hover doesn't trigger selection — it should trigger a lighter highlight without
full selection. Add a `hoveredId` state alongside `selectedId`.

### 4.3 Right-Click Context Menu on Nodes

Right-clicking a node opens a small context menu (Radix Dropdown or a custom positioned div):

```
Open inspector
Open local graph
──────────────
Link to another atom...
──────────────
Archive atom
```

"Open local graph" switches to local graph mode centered on that node (see §4.5).
This mirrors exactly what Obsidian offers on right-click.

### 4.4 Node Size = Degree (Connection Count)

Currently node size is based on `weight` which is derived from `confidence` and
`reinforceCount`. Add **degree** (number of links) as a primary factor:

```ts
function weightFor(node: BrainGraphNode, degree: number): number {
  if (node.atomKind === 'core') return 1;
  const degreeBoost = Math.min(0.45, Math.log1p(degree) / 5);
  const reinforcement = Math.min(0.25, Math.log1p(node.reinforceCount) / 8);
  return Math.max(0.28, Math.min(1.0, node.confidence * 0.5 + degreeBoost + reinforcement));
}
```

This means: upload 1 document → creates N chunks → all small. Start running agents
that reference those chunks → degree goes up → nodes grow. The visual importance
mirrors actual usage. This is the same mechanic that makes Obsidian's hubs visually
dominant.

### 4.5 Local Graph Mode (Depth Explorer)

This is the most impactful missing feature. Add a "Local graph" mode toggle in the graph
toolbar. When active:

1. A selected node becomes the **anchor**
2. A depth slider (1–4) controls how many hops are shown
3. Only nodes within N hops of the anchor are rendered
4. A breadcrumb shows: `Workspace Brain > Social Listening Agent > OWNER-INTELLIGENCE-GUIDE.md`
5. A "Return to full graph" button exits local graph mode

Implementation:
```ts
function getNeighborhoodAtDepth(
  nodeId: string,
  allEdges: BrainEdge[],
  depth: number
): Set<string> {
  const visited = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const edge of allEdges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !visited.has(edge.source)) next.add(edge.source);
    }
    for (const id of next) visited.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return visited;
}
```

When depth > 1, a second-hop node that's not directly connected to the anchor but connected
through an intermediary appears — this is where operators discover non-obvious relationships.

### 4.6 Force Controls Panel

Add a collapsible "Forces" panel in the graph toolbar (right side, below mode switcher):

```
Forces  ▼
──────────────────
Center force   ●────────  0.08
Repel force    ──●──────  -150
Link force     ──────●──  0.42
Link distance  ───●─────  96px
Node size      ──●──────  1.0x
Link thickness ●────────  1.0x
Text threshold ────────●  0.8
──────────────────
[ Animate ]   [ Reset ]
```

Changes to sliders update the D3 simulation parameters live. Store the configuration
in `localStorage` keyed by `brainForceConfig:{userId}` so the operator's preferred
layout persists.

The "Animate" button triggers a time-lapse: atoms fade in one by one ordered by `createdAt`,
links draw in sequentially. Useful for onboarding demos and understanding how the brain grew.

### 4.7 Group Coloring

Add a "Groups" section to the forces panel:

```
Groups  ▼
──────────────────
+ New group
  [by app ▼]    ● cyan    [×]
  [by agent ▼]  ● violet  [×]
──────────────────
Display
Arrows  ○
```

Group presets:
- **By layer** (default) — knowledge=cyan, memory=violet, judgment=amber
- **By app** — each app gets a unique color; workspace-global atoms are white
- **By agent** — each agent gets a unique color; no-agent atoms are grey
- **By adapter** — claude_code=purple, openclaw=green, http=slate
- **By freshness** — fresh=bright, stale=dim orange, disputed=red pulse

Groups are purely cosmetic — no data model change needed. They're computed from existing
`node.metadata` fields (`appId`, `agentId`, `adapterType`) in the frontend.

### 4.8 Orphan Node Treatment

Add an **Orphans** toggle to the filter bar (alongside the existing ALL / KNOWLEDGE / MEMORY
/ JUDGMENT / Warnings / Gaps filters):

```
Filters:  ALL  KNOWLEDGE  MEMORY  JUDGMENT  ⚠ Warnings  ○ Gaps  · Orphans
```

When "Orphans" is toggled off, nodes with `degree === 0` are hidden. When on (default),
orphan nodes appear at 40% opacity with a subtle dashed ring to indicate they have no
connections — a visual invitation to link them.

Add a "Suggest links" action in the orphan node's right-click menu. This calls a new API
endpoint `POST /v1/brain/atoms/:kind/:id/suggest-links` which runs keyword similarity
against the full atom pool and returns the top 5 candidate connections for the operator
to confirm.

---

## 5. Auto-Linking on Document Upload

This is the most critical backend change. Currently:
- Operator uploads a document → KB chunks are created → NO connections are made to existing atoms
- The graph stays disconnected
- The brain is not a brain; it is a filing cabinet

### 5.1 The Problem

`CollectiveBrainService.extractAndPromote()` is only called at agent task completion. It
never runs when a document is imported via the knowledge base upload flow. This means 100%
of manually-inserted knowledge is permanently disconnected.

### 5.2 Auto-Link Pipeline (new backend)

When `POST /v1/knowledge-bases/:id/documents` successfully processes chunks, the API
should fire a background auto-link job:

```ts
// apps/api/src/services/knowledgeAutoLinker.ts (new)

export class KnowledgeAutoLinker {
  constructor(
    private readonly brain: CollectiveBrainService,
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  async linkNewChunks(
    workspaceId: string,
    chunks: Array<{ id: string; kind: 'kb_chunk' | 'knowledge_chunk'; text: string }>,
    options: { appId?: string | null } = {},
  ): Promise<{ linked: number }> {
    let linked = 0;

    // Load existing atoms for comparison
    const existingAtoms = this.brain.loadAtoms(workspaceId, {
      scope: options.appId ? 'app' : 'workspace',
      appId: options.appId ?? null,
      limit: 300,
    });

    for (const chunk of chunks) {
      // 1. Cross-link new chunk against all existing atoms (similarity >= 0.48)
      const candidates = existingAtoms
        .filter((a) => a.id !== chunk.id || a.kind !== chunk.kind)
        .map((a) => ({ atom: a, score: cosineSimilarity(chunk.text, a.text) }))
        .filter((c) => c.score >= 0.48)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5); // top 5 related atoms per chunk

      for (const { atom, score } of candidates) {
        const relation = score >= 0.82 ? 'supports' : score >= 0.62 ? 'refines' : 'co_observed';
        this.brain.createLink({
          workspaceId,
          sourceId: chunk.id,
          sourceKind: chunk.kind,
          targetId: atom.id,
          targetKind: atom.kind,
          relation,
          confidence: Math.min(0.85, score * 0.9),
          appId: options.appId ?? null,
        });
        linked++;
      }

      // 2. Cross-link new chunk against sibling chunks from same document
      // (chunks from the same doc are highly related by definition)
    }

    // 3. Cross-link chunks within the new document against each other
    for (let i = 0; i < chunks.length; i++) {
      for (let j = i + 1; j < chunks.length; j++) {
        const score = cosineSimilarity(chunks[i].text, chunks[j].text);
        if (score >= 0.55) {
          this.brain.createLink({
            workspaceId,
            sourceId: chunks[i].id,
            sourceKind: chunks[i].kind,
            targetId: chunks[j].id,
            targetKind: chunks[j].kind,
            relation: 'co_observed',
            confidence: Math.min(0.75, score * 0.85),
            appId: options.appId ?? null,
          });
          linked++;
        }
      }
    }

    return { linked };
  }
}
```

Wire this into the document ingest completion handler in `apps/api/src/routes/knowledge.ts`
(or `apps/api/src/routes/apps.ts` for app-scoped ingestion). Fire it as a
`setImmediate()` / non-blocking background call so the upload response is not delayed.

### 5.3 Similarity Function

The current `CollectiveBrainService` uses a `HashingEmbeddingProvider` that computes
TF-IDF-style token overlap cosine similarity. This is fast, requires no LLM API call,
and works well enough for V1. Use the same function in `KnowledgeAutoLinker`.

In a future phase, replace with a real embedding endpoint (OpenAI `text-embedding-3-small`
or a local model) for true semantic similarity. The interface is the same — only the
embedding computation changes.

### 5.4 Suggest-Links Endpoint (for orphan linking UI)

```
POST /v1/brain/atoms/:kind/:id/suggest-links
Response: { suggestions: Array<{ targetId, targetKind, targetLabel, relation, confidence, score }> }
```

This runs the same similarity pipeline on demand and returns the top 5 candidates without
creating links. The operator confirms in the inspector UI and then the UI calls the
existing `POST /v1/brain/links` to create the accepted connections.

---

## 6. Inspector Redesign

The current `BrainDetailRail.tsx` is largely well-built. Add three new sections:

### 6.1 Backlinks Section (inbound connections)

Alongside "Connections (N)", add a "Backlinks" sub-section that shows atoms that link
**to** this atom (the target side). This requires no backend change — filter `detail.links`
for links where `link.target === node.id`.

```
CONNECTIONS (5)
  Outbound
  → supports    OWNER-INTELLIGENCE-GUIDE chunk 3
  → refines     Agent Task Decision 2026-05-01

  Inbound (backlinks)
  ← derived from  Social Listening episode
  ← co_observed   Marketing Agent memory
```

### 6.2 Similar Atoms Section

Below Connections, add a "Similar atoms" section that shows the top 3 semantically related
atoms even if they have no link. This surfaces hidden connections.

- Loaded lazily on first expand
- Calls `POST /v1/brain/atoms/:kind/:id/suggest-links`
- Each entry has a "Link" button that calls `POST /v1/brain/links` inline

### 6.3 Edit Content Inline

The textarea is currently `readOnly`. Make it editable with a "Save" button. This calls:
```
PATCH /v1/brain/atoms/:kind/:id
Body: { content: string }
```

This is a new API endpoint but trivially implemented: update the `summary` / `details`
field on the underlying atom row.

---

## 7. Episodes Error Fix

**File:** `apps/web/src/components/knowledge/EpisodesTab.tsx`

**Current code:**
```ts
.catch((err) => { if (!cancelled) { toast.error('Failed to load episodes', String(err)); setEpisodes([]); } })
```

`String(err)` on an API error object (not a string) produces `[object Object]`. The
codebase already has `apiErrorMessage(err)` imported from `../../lib/api` across many
other components.

**Fix:**
```ts
import { api, apiErrorMessage } from '../../lib/api';
// ...
.catch((err) => { if (!cancelled) { toast.error('Failed to load episodes', apiErrorMessage(err)); setEpisodes([]); } })
```

This is the same pattern used in `BrainView.tsx`, `BrainDetailRail.tsx`, `WorkflowsPage.tsx`,
etc.

---

## 8. Navigation Consolidation

### 8.1 Sidebar Change

Remove the `/knowledge` nav item. The Brain nav item absorbs it.

```tsx
// In Sidebar.tsx — remove:
{ path: '/knowledge', label: 'Knowledge', icon: <BookOpen size={16} /> }

// Brain item already exists at:
{ path: '/brain', label: 'Brain', icon: <Brain size={16} /> }
```

### 8.2 Route Change

In `App.tsx`, keep `/knowledge` as a redirect:

```tsx
<Route path="/knowledge" element={<Navigate to="/brain?tab=documents" replace />} />
<Route path="/knowledge/bases/:id" element={<Navigate to="/brain?tab=bases" replace />} />
<Route path="/brain" element={<UnifiedBrainPage />} />
<Route path="/brain/bases/:id" element={<KnowledgeBasePage />} />
```

### 8.3 New `UnifiedBrainPage.tsx`

```tsx
// apps/web/src/pages/UnifiedBrainPage.tsx

type BrainTab = 'graph' | 'documents' | 'bases' | 'memory' | 'episodes';

export function UnifiedBrainPage() {
  const [tab, setTab] = useSyncedTabParam<BrainTab>('tab', 'graph');

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<BrainIcon />}
        title="The Brain"
        description="Workspace orchestrator · cross-app intelligence map"
        action={<BrainTabBar tab={tab} onChange={setTab} />}
      />
      <div className="flex-1 overflow-hidden">
        {tab === 'graph'     && <BrainView slug={null} />}
        {tab === 'documents' && <WorkspaceDocumentsPanel />}
        {tab === 'bases'     && <WorkspaceBasesPanel />}
        {tab === 'memory'    && <WorkspaceMemoryTab />}
        {tab === 'episodes'  && <EpisodesTab />}
      </div>
    </div>
  );
}
```

```
BrainTabBar:
  Graph  |  Documents  |  Bases  |  Memory  |  Episodes
```

The tab bar is identical in style to the Apps page tab bar (Surface / Canvas / Data / Brain / Deploy).

---

## 9. Real-Time Graph Updates

Already partially implemented — `BrainView` listens to `BRAIN_ATOM_CREATED`,
`BRAIN_ATOM_REINFORCED`, and `BRAIN_LINK_CREATED` events and calls `reloadGraph()`.

### 9.1 Animate new atoms in

When `BRAIN_ATOM_CREATED` fires, instead of re-running the full layout:
1. Add the new node to the force simulation at a random position near the center
2. Let the simulation run 50 additional ticks with the new node
3. The node animates to its settled position via CSS `transition`

This makes the brain feel alive — operators who have the Brain tab open during a
workflow run will see nodes materialize in real time.

### 9.2 Live link creation animation

When `BRAIN_LINK_CREATED` fires, draw the new edge with a brief pulse animation
(the existing animated edge style for `feeds` kind works well here).

---

## 10. Privacy & Knowledge Visibility Layer

### 10.1 The Problem

As the platform grows, operators will want to:
- Keep some knowledge atoms private to their workspace (default)
- Share useful general-purpose knowledge through the Packages system
- Prevent sensitive operational patterns (internal agent strategies, proprietary data)
  from being included in anything shared externally

### 10.2 Atom Visibility Model

Add a `visibility` field to the underlying atom tables (`memory_episodes`,
`knowledge_chunks`, `kb_chunks`, `app_memory`):

```sql
-- Migration: add visibility to knowledge atoms
ALTER TABLE memory_episodes    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE knowledge_chunks   ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE kb_chunks          ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE app_memory         ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
```

Values:
| Value | Meaning |
|---|---|
| `private` | Only visible to the creating workspace; excluded from all exports |
| `workspace` | Default. Visible within the workspace. Not exported. |
| `package` | Explicitly marked for inclusion in a distributable package |

### 10.3 Sensitivity Guardrails

When an atom is created or when visibility is elevated to `package`, run a lightweight
sensitivity scan:
- Check for patterns matching API keys, credentials, tokens (regex: `sk-`, `Bearer `, `password`)
- Check for PII patterns (email addresses, phone numbers, SSNs)
- If flagged: `visibility` is forced to `private`, a `warning` node is added to the graph
  with `atomKind: 'warning'` and a message: "Atom contains potentially sensitive data"
- The operator can review and either redact the content or confirm it's safe to elevate

This guardrail is a server-side hook in `CollectiveBrainService.createAtom()` and
`KnowledgeAutoLinker.linkNewChunks()`. No frontend changes needed beyond rendering
the warning atom in the inspector.

### 10.4 Package Export (Future — Packages System Foundation)

The `packages` page already exists as the distribution layer for this future capability.
The architecture is:

```
Workspace Brain
  └─ Atoms with visibility='package'
       └─ Packager reads only visibility='package' atoms
            └─ Serialized to package manifest
                 └─ Packages page distributes the manifest
                      └─ Recipient imports → atoms appear in their brain with
                         source='imported_package', appId=null, visibility='workspace'
```

When a package is imported, the brain auto-links the incoming atoms against the recipient's
existing graph — so knowledge compounds across organizations.

Implementation steps (deferred to Packages v2):
1. `GET /v1/packages/:id/brain-export` — returns package atoms with `visibility='package'`
2. `POST /v1/packages/:id/brain-import` — imports atoms into target workspace
3. Imported atoms get `source='package:{packageId}'` in their `metadata`
4. Auto-linker runs on import to connect incoming atoms to existing workspace knowledge

**Privacy note on confidential strategies**: Agents that develop proprietary operational
intelligence (custom routing strategies, learned domain-specific patterns) should default
their atoms to `visibility='private'`. The inspector shows a lock icon for private atoms.
Operators must explicitly change to `package` visibility. This is an intentional friction
point — there is no bulk-export action; every shared atom is a conscious decision.

---

## 11. Implementation Phases

### Phase 1 — Unify + Fix (3–5 days)

**Goal:** Stop the pain. One nav item, no errors.

| Task | File(s) | Effort |
|---|---|---|
| Fix Episodes error | `EpisodesTab.tsx` | 5 min |
| Add `/knowledge` redirect routes | `App.tsx` | 30 min |
| Create `UnifiedBrainPage.tsx` with tab bar | new file | 2h |
| Move Knowledge tab content to Brain shell | `KnowledgePage.tsx` → refactor | 2h |
| Remove Knowledge nav item from Sidebar | `Sidebar.tsx` | 5 min |
| Add `BrainTabBar` component | new component | 1h |

**Deliverable:** `/brain` shows Graph tab by default. Clicking Documents/Bases/Memory/
Episodes shows the existing knowledge panels inside the Brain shell. `/knowledge` redirects.
Episodes no longer show "[object Object]".

---

### Phase 2 — Interactive Graph (5–7 days)

**Goal:** Nodes can be dragged. Hover highlights neighborhood. Right-click works.
Local graph mode exists. Force controls panel is visible.

| Task | File(s) | Effort |
|---|---|---|
| Enable `nodesDraggable` + pin state | `BrainStage.tsx` | 2h |
| Add `hoveredId` state + hover neighborhood dim | `BrainStage.tsx`, `BrainView.tsx` | 3h |
| Right-click context menu on nodes | `BrainStage.tsx` + new `BrainNodeMenu.tsx` | 4h |
| Node size = degree | `brainGraphAdapter.ts` | 1h |
| Local graph mode + depth slider | `BrainStage.tsx`, `BrainView.tsx` | 1 day |
| Force controls collapsible panel | new `BrainForcePanel.tsx` | 1 day |
| Group coloring (by app, by agent, by adapter) | `brainGraphAdapter.ts`, `BrainStage.tsx` | 1 day |
| Orphan visual treatment + toggle | `BrainStage.tsx`, `BrainView.tsx` | 3h |

**Deliverable:** Graph is genuinely interactive. Dragging nodes repositions them.
Hovering highlights connections. Right-click opens menu. Local graph shows neighborhood.
Force panel gives live layout control. Groups color-code the topology.

---

### Phase 3 — Auto-Linking (3–5 days)

**Goal:** Upload a document → it becomes connected in the graph.

| Task | File(s) | Effort |
|---|---|---|
| Create `KnowledgeAutoLinker` service | new `services/knowledgeAutoLinker.ts` | 1 day |
| Wire auto-linker into document ingest completion | `routes/knowledge.ts` or `routes/apps.ts` | 3h |
| Wire auto-linker into app data ingestion | `routes/apps.ts` | 2h |
| Add `POST .../suggest-links` endpoint | `routes/brain.ts` | 2h |
| Add "Suggest links" to orphan node right-click | `BrainNodeMenu.tsx` | 2h |
| Add "Similar atoms" section to inspector | `BrainDetailRail.tsx` | 3h |
| Backlinks section in inspector | `BrainDetailRail.tsx` | 1h |

**Deliverable:** Uploading a document to any knowledge base immediately creates connections
to related existing atoms. The graph is no longer a scatter plot. Orphan atoms get a
"Suggest links" action. The inspector shows both outbound and inbound connections.

---

### Phase 4 — Content Editing + Atom Management (2–3 days)

**Goal:** Operators can curate their brain directly from the graph.

| Task | File(s) | Effort |
|---|---|---|
| Make inspector textarea editable | `BrainDetailRail.tsx` | 2h |
| Add `PATCH /v1/brain/atoms/:kind/:id` endpoint | `routes/brain.ts` + `collectiveBrain.ts` | 3h |
| Merge atoms action (combine two similar atoms) | inspector + new endpoint | 1 day |
| Animate new atoms in via realtime | `BrainStage.tsx`, `BrainView.tsx` | 3h |
| Time-lapse animation (Animate button) | `BrainStage.tsx` | 1 day |

---

### Phase 5 — Privacy + Visibility Layer (2–3 days)

**Goal:** Every atom has a visibility. Sensitive data is flagged. Foundation for future sharing.

| Task | File(s) | Effort |
|---|---|---|
| Add `visibility` column migration | `packages/db/src/sqlite/schema.ts` | 1h |
| Sensitivity scan in atom creation | `collectiveBrain.ts`, `knowledgeAutoLinker.ts` | 1 day |
| Visibility badge in inspector | `BrainDetailRail.tsx` | 2h |
| Lock icon for private atoms in graph | `BrainStage.tsx` | 1h |
| Visibility toggle in inspector | `BrainDetailRail.tsx` | 2h |
| Filter bar: hide private atoms toggle | `BrainView.tsx` | 1h |

---

## 12. Component Inventory

### New Files

| File | Purpose |
|---|---|
| `apps/web/src/pages/UnifiedBrainPage.tsx` | Shell that hosts all Brain tabs |
| `apps/web/src/components/brain/BrainTabBar.tsx` | Graph/Documents/Bases/Memory/Episodes tab switcher |
| `apps/web/src/components/brain/BrainForcePanel.tsx` | Force controls + Groups + Display settings |
| `apps/web/src/components/brain/BrainNodeMenu.tsx` | Right-click context menu for graph nodes |
| `apps/web/src/components/brain/BrainLocalGraph.tsx` | Local graph mode with depth slider |
| `apps/api/src/services/knowledgeAutoLinker.ts` | Auto-linking pipeline for uploaded documents |

### Modified Files

| File | Change |
|---|---|
| `apps/web/src/App.tsx` | Add `/brain` route, `/knowledge` redirects |
| `apps/web/src/components/layout/Sidebar.tsx` | Remove `/knowledge` nav item |
| `apps/web/src/components/brain/BrainStage.tsx` | nodesDraggable=true, hoveredId, right-click |
| `apps/web/src/components/brain/BrainView.tsx` | Tab integration, force config state |
| `apps/web/src/components/brain/BrainDetailRail.tsx` | Backlinks, similar atoms, editable content |
| `apps/web/src/components/brain/brainGraphAdapter.ts` | Node size = degree, group coloring |
| `apps/web/src/components/knowledge/EpisodesTab.tsx` | Fix `apiErrorMessage(err)` |
| `apps/api/src/routes/brain.ts` | Add suggest-links, PATCH atom endpoints |
| `apps/api/src/services/collectiveBrain.ts` | Add visibility support, `loadAtoms()` made public |
| `apps/api/src/routes/knowledge.ts` | Wire auto-linker on ingest completion |
| `packages/db/src/sqlite/schema.ts` | Add visibility column to atom tables |

---

## 13. API Surface Changes

### New Endpoints

```
POST /v1/brain/atoms/:kind/:id/suggest-links
  → { suggestions: Array<{targetId, targetKind, targetLabel, relation, confidence}> }

PATCH /v1/brain/atoms/:kind/:id
  Body: { content?: string; visibility?: 'private' | 'workspace' | 'package' }
  → { updated: true }

POST /v1/apps/:slug/brain/atoms/:kind/:id/suggest-links
  → (same as workspace variant, app-scoped)

PATCH /v1/apps/:slug/brain/atoms/:kind/:id
  → (same as workspace variant, app-scoped)
```

### Modified Endpoints

```
POST /v1/knowledge-bases/:id/documents
  → (after existing response) fire KnowledgeAutoLinker.linkNewChunks() as background job

POST /v1/apps/:slug/data/:key/ingest
  → (after ingest completes) fire KnowledgeAutoLinker.linkNewChunks() as background job
```

---

## 14. Design System Alignment

The Brain Graph tab must look and feel like the rest of Agentis:

### Canvas consistency
- Use the existing `CanvasEngine` wrapper (already done in `BrainStage`)
- Same background radial gradient, same minimap styling
- Same pane background color (`#23252d` / `bg-bg-base`)

### Force Panel styling
Identical to the right-click menus and inspector panels in `ContextInspector.tsx`:
- Rounded card border (`rounded-card border border-line bg-surface`)
- Section headers: `text-[10px] font-semibold uppercase tracking-wider text-text-muted`
- Sliders: use the same `input[type=range]` styling as the rest of the UI

### Tab bar styling
Match the App detail page tab pattern (`Surface / Canvas / Data / Brain / Deploy`):
- Pills with `rounded-pill border`
- Active: `bg-accent-soft text-accent border-accent-muted`
- Inactive: `bg-surface-2 text-text-muted border-line hover:text-text-primary`

### Node colors
The current color scheme is already strong:
- Knowledge = `#22d3ee` (cyan) — information
- Memory = `#a78bfa` (violet) — experience
- Judgment = `#f59e0b` (amber) — evaluation
- Core = `#e2e8f0` (white) — identity
- Warning = `#fb7185` (rose) — conflict/disputed
- Gap = `#475569` (slate, dashed ring) — absence/unknown

Keep these. They are visually distinct and meaningful.

---

## 15. Why This Architecture Is Right for Agentis

Obsidian is brilliant but it's a tool for human note-takers. Every connection must be
manually created. Every insight must be manually written. The graph only knows what the
human tells it.

Agentis Brain 2.0 is different in a fundamental way: **the connections emerge from work**.

When an agent runs a workflow and distills a lesson → the brain grows.
When a document is uploaded → the brain connects it to what already exists.
When two agents on different adapters converge on the same insight → the brain reinforces it.
When an agent contradicts an existing belief → the brain marks the dispute.

The visual result of this over 30, 60, 90 days of active use is a graph that actually
looks like the Obsidian screenshots in the reference images: dense, clustered, alive.
Nodes that are truly important (referenced across many agents and workflows) are visually
large. Clusters form around apps, around domains of knowledge, around agents.

The operator looking at this graph is not managing notes. They are reading the collective
intelligence of their AI fleet. That is the Agentis value proposition, and Brain 2.0 is
the surface that makes it legible.

---

## 16. Known Issues Not Covered in This Plan

These exist in the codebase and need to be tracked separately:

1. **`llm_summary` branch in `#executeContextCompress()`** — `summarizeContext()` is not
   implemented. The branch exists but is a no-op. This affects any workflow using
   `context_compress` with `strategy: 'llm_summary'`.

2. **`tests/services/goalRun.test.ts`** — imports a missing `../../src/services/missions.js`
   and causes the test suite to fail if run holistically. This is a broken test unrelated
   to Brain.

3. **Hashing embedding quality** — `HashingEmbeddingProvider` uses TF-IDF token overlap
   which is fast but semantically weak. "neural network" and "machine learning" would score
   low similarity despite being closely related concepts. In Phase 3+, upgrading to a real
   embedding model would dramatically improve auto-linking quality.

4. **No bulk-delete or bulk-link UI** — currently operators must manage atoms one at a time
   in the inspector. A future Ledger table view enhancement could support multi-select with
   bulk actions.

---

*This document supersedes the previous `BRAIN-PAGE-REDESIGN.md` which focused only on the
graph visualization layer. The scope here is the full Brain + Knowledge unification and
the path to making Agentis Brain genuinely more powerful than any personal knowledge
management tool, because ours learns automatically.*

---

## 17. Implementation Log — End-to-End Execution

> **Status:** ✅ Phases A–D shipped — May 2026
> **Verification:** `pnpm --filter @agentis/web exec tsc --noEmit` → 0 errors. `pnpm --filter @agentis/api exec tsc --noEmit` → 0 errors. `pnpm --filter @agentis/api exec vitest run tests/services/collectiveBrain.test.ts` → 4/4 passed.

Every file touched, grouped by phase, with a one-line summary of the change.

### Phase A — Backend Auto-Linker & Atom Edit Plumbing

| File | Change | Summary |
|---|---|---|
| [apps/api/src/services/knowledgeAutoLinker.ts](apps/api/src/services/knowledgeAutoLinker.ts) | **NEW** | Mines similar atoms via Jaccard tokenization; persists top-4 `co_observed` links (threshold 0.18) and `derived_from` to the chunk-zero sibling. Exposes `autoLink()` (persist) and `suggestLinks()` (read-only preview). |
| [apps/api/src/services/collectiveBrain.ts](apps/api/src/services/collectiveBrain.ts) | **+listLinkCandidates / +updateAtomContent** | `listLinkCandidates(workspaceId, {appId, limit})` returns lightweight `{id, kind, label, tokens}` for similarity scoring. `updateAtomContent(workspaceId, kind, id, {title?, content?})` writes back to the correct table per atom kind (episode/memory/pattern/knowledge_chunk/kb_chunk) and re-hydrates the `BrainGraphNode`. |
| [apps/api/src/services/knowledgeBase.ts](apps/api/src/services/knowledgeBase.ts) | **+setAutoLinker / +autoLink call** | Optional `setAutoLinker(linker)` hook; after each kb_chunk insert in `persistDocument`, calls `autoLinker.autoLink(...)` so newly ingested docs immediately weave into the graph instead of arriving as islands. |
| [apps/api/src/bootstrap.ts](apps/api/src/bootstrap.ts) | **+import / +instantiate / +route dep** | Constructs `KnowledgeAutoLinker` after `collectiveBrain`, wires it into `knowledgeBaseService.setAutoLinker(...)`, and threads it into `buildBrainRoutes({...})`. |
| [apps/api/src/routes/brain.ts](apps/api/src/routes/brain.ts) | **+PATCH /atoms/:kind/:id / +POST /atoms/:kind/:id/suggest-links** | PATCH validates `{title?, content?}` (Zod refine: at least one), calls `updateAtomContent`, returns updated `{node}` or 404. Suggest-links endpoint resolves the source atom, runs `suggestLinks()`, returns `{candidates}`. |

### Phase B — Brain + Knowledge Page Unification

| File | Change | Summary |
|---|---|---|
| [apps/web/src/components/knowledge/EpisodesTab.tsx](apps/web/src/components/knowledge/EpisodesTab.tsx) | **Bug fix** | Replaced `String(err)` (which rendered `[object Object]`) with `apiErrorMessage(err)` from `lib/api`, fixing the "Failed to load episodes" toast. |
| [apps/web/src/components/knowledge/WorkspaceKnowledgePanels.tsx](apps/web/src/components/knowledge/WorkspaceKnowledgePanels.tsx) | **NEW** | Tab-aware panel container (`documents` / `bases` / `memory` / `episodes`); self-fetches counts and reports back via `onCounts`. Reuses existing `WorkspaceDocDropZone`, `DocumentList`, `KnowledgeBaseList`, `WorkspaceMemoryTab`, `EpisodesTab`. |
| [apps/web/src/pages/KnowledgePage.tsx](apps/web/src/pages/KnowledgePage.tsx) | **Rewritten as redirect** | Returns null; in `useEffect` reads the legacy `?tab=` query and `nav('/brain?tab=<value>', { replace: true })`. Preserves all old deep links. |
| [apps/web/src/pages/UnifiedBrainPage.tsx](apps/web/src/pages/UnifiedBrainPage.tsx) | **NEW** | Single Brain surface with tabs `graph / documents / bases / memory / episodes`. Reads tab from URL via the shared `Tabs param="tab"` component; renders `<BrainView/>` for graph, `<WorkspaceKnowledgePanels/>` for the others, and shows live counts as tab badges. |
| [apps/web/src/App.tsx](apps/web/src/App.tsx) | **Route swap** | `/brain` now lazy-loads `UnifiedBrainPage`; `/knowledge` keeps `KnowledgePage` (redirect); `/knowledge/bases/:id` preserved. |
| [apps/web/src/components/Sidebar.tsx](apps/web/src/components/Sidebar.tsx) | **−Knowledge nav** | Removed the standalone Knowledge nav entry and its unused `BookOpen` lucide import. Single source of truth in the sidebar. |
| [apps/web/src/components/brain/BrainView.tsx](apps/web/src/components/brain/BrainView.tsx) | **Redirect hrefs + layoutKey** | All `/knowledge` deep-link buttons now route to `/brain?tab=documents`; passes `layoutKey={slug ?? 'workspace'}` to `BrainStage` so per-scope drag layouts persist independently. |

### Phase C — Interactive Graph (Drag, Hover, Persist)

| File | Change | Summary |
|---|---|---|
| [apps/web/src/components/brain/BrainStage.tsx](apps/web/src/components/brain/BrainStage.tsx) | **Drag + hover + per-key persistence** | Non-core nodes are now draggable (`draggable: node.layer !== 'core'`). Hovering a node sets `focusId` (overrides selection) for instant neighborhood preview; hovered nodes get an extra ring/glow. Drag-stop persists `{[id]:{x,y}}` to `localStorage` under `agentis.brain.layout.v1.<layoutKey>` and merges with server positions on next render. Layout re-reads when `layoutKey` changes. |

### Phase D — Inspector: Editable Content, Suggested Links, Backlinks

| File | Change | Summary |
|---|---|---|
| [apps/web/src/components/brain/BrainDetailRail.tsx](apps/web/src/components/brain/BrainDetailRail.tsx) | **Editable atoms + Suggest Links** | Content section gains an Edit/Cancel/Save flow (PATCH `/v1/brain/atoms/:kind/:id`) with live refresh and graph re-fetch on success. New "Suggested Links" section calls POST `/atoms/:kind/:id/suggest-links` and renders top candidates with relation + similarity %; one-click "Link" creates the relation via the existing link endpoint. `Section` helper now accepts an `action` slot for inline buttons. |

### Verification Run

```pwsh
pnpm --filter @agentis/web exec tsc --noEmit          # → 0 errors
pnpm --filter @agentis/api exec tsc --noEmit          # → 0 errors
pnpm --filter @agentis/api exec vitest run tests/services/collectiveBrain.test.ts
# → Test Files  1 passed (1)
# → Tests       4 passed (4)
```

### Deferred (intentionally out of scope for this batch)

- **Phase 5 — Visibility migration.** Per-atom workspace/app visibility flags + UI filters remain as planned in §13; no schema or filter UI changed in this pass. Auto-linker respects the existing `appId` scope passed by callers, so promoting visibility later requires no auto-linker change.
- **Backlinks panel.** The inspector now surfaces outgoing connections + suggested links; a dedicated incoming-link "Backlinks" section is trivial follow-up (`detail.links.filter(l => l.target === node.id)`).
- **Auto-link backfill for existing 51 islanded atoms.** New ingests are linked on write; a one-off backfill script can replay `autoLink()` over historical kb_chunks if/when desired.

### What the user gets, end-to-end

1. **One Brain.** `/knowledge` is gone from the sidebar; everything lives under `/brain` with tabs, and every old `/knowledge?tab=…` link redirects cleanly.
2. **No more islands.** Every newly ingested document chunk automatically grows `co_observed` edges to its most similar existing atoms — the graph stops looking like a scatter plot the moment new knowledge lands.
3. **A graph you can actually arrange.** Non-core nodes drag freely; positions persist per workspace/app slug in localStorage; hover gives instant neighborhood preview without clicking.
4. **An inspector that does something.** You can edit atom titles/content inline and persist back to the right table per kind, and you can mine + accept suggested links straight from the side rail.
5. **The episodes bug is dead.** No more `[object Object]` — the toast now surfaces the real API error message.
