# Collective Brain Architecture
## Cross-Agent Knowledge Graphs for Agentis

> Status: approved for implementation
> Date: 2026-05-12
> Scope: universal auto-promotion, knowledge graph schema, cross-agent reinforcement, real-time graph visualization, Brain Map upgrade
> Depends on: `MEMORY-ARCHITECTURE.md`, `THE-BRAIN-UX-ARCHITECTURE.md`, `KNOWLEDGE-UX-ARCHITECTURE.md`

---

## 1. Vision

Every agent in Agentis — regardless of which adapter runs it (OpenClaw, ClaudeCode, HttpAdapter, any future adapter) — should grow a shared brain by working.

Not by being told to.
Not by the operator manually adding notes.

**By working.**

The first time an agent learns that the Stripe API rate-limits at 100 req/s, that fact enters the workspace brain.
The second time a different agent encounters the same constraint, it reinforces the same node — it does not create a duplicate.
The third time, a third agent with a completely different adapter reads that fact from the brain before making its first request.

This is the flywheel:

```text
Agent works → learns something → promotes it to the brain
Other agents work → read from the brain → perform better from day one
Better performance → promoted as reinforcement → brain densifies
```

It compounds.

The inspiration is Obsidian's PKM model: small, atomic, linked facts that grow into a networked intelligence structure over time. But Agentis goes further: **agents grow the graph automatically as a side effect of execution.** No manual notes. No human curation required.

---

## 2. The three gaps this closes

### 2.1 The promotion loop is not universal

Today, `RunPromotionExtractor` and `IntelligencePromotion` exist but are invoked per-app and manually. When an agent_task completes in `WorkflowEngine`, nothing automatically writes a learning back to the shared brain.

**This must be fixed.** Every completed agent_task node should trigger a lightweight extraction attempt.

### 2.2 Knowledge is flat, not linked

The current schema has flat tables: `app_memory`, `memory_episodes`, `kb_chunks`. Two agents discovering the same thing produce two independent rows. There is no deduplication, no reinforcement, no bidirectional link.

**This must be fixed.** A new `knowledge_links` table will connect atoms across any source type.

### 2.3 The Brain Map is a placeholder

The `BrainTabHeader` Map/Manage UI exists, but the Map view has no live graph. There is nothing to show the network growing.

**This must be fixed.** The Brain Map becomes the real-time collective knowledge graph.

---

## 3. Architecture

### 3.1 Layers

```text
┌──────────────────────────────────────────────────────────────┐
│                    COLLECTIVE BRAIN                          │
│                                                              │
│   WORKSPACE KNOWLEDGE ATOMS                                  │
│   ┌─────────────┐ ┌──────────────┐ ┌────────────────────┐   │
│   │ kb_chunks   │ │ memory_       │ │ app_memory         │   │
│   │ (documents) │ │ episodes      │ │ (promoted patterns)│   │
│   └──────┬──────┘ └──────┬───────┘ └──────────┬─────────┘   │
│          │               │                     │             │
│          └───────────────┼─────────────────────┘             │
│                          │                                   │
│               knowledge_links (NEW)                          │
│               source ─── relation ─── target                 │
│               agentId, adapterType, confidence, runId        │
│                                                              │
│   UNIVERSAL PROMOTION ENGINE (upgraded)                      │
│   Fires after every completed agent_task                     │
│   Extracts atomic facts → deduplicates → links → reinforces  │
│                                                              │
│   BRAIN MAP (real-time force-directed graph)                 │
│   Nodes = knowledge atoms, colored by layer                  │
│   Edges = knowledge_links                                    │
│   Live updates via BRAIN_LINK_CREATED socket event           │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Knowledge atom scoping

All knowledge atoms in Agentis are already workspace-scoped. This means:

- `kb_chunks` → `workspaceId` FK
- `memory_episodes` → `workspaceId` FK, optional `appId`, optional `agentId`
- `app_memory` → `workspaceId` FK, `appId` (broadened to allow `null` for workspace-global)

The upgrade: atoms with `appId = null` become **workspace-global**. Promoted facts from any agent can be workspace-global if they cross a confidence threshold. App-specific facts stay scoped. Both appear in the Brain Map.

---

## 4. DB Schema

### 4.1 `knowledge_links` table (new)

```sql
CREATE TABLE knowledge_links (
  id           TEXT PRIMARY KEY,
  workspaceId  TEXT NOT NULL REFERENCES workspaces(id),

  -- Source atom
  sourceId     TEXT NOT NULL,
  sourceKind   TEXT NOT NULL, -- 'chunk' | 'episode' | 'memory' | 'pattern'

  -- Target atom
  targetId     TEXT NOT NULL,
  targetKind   TEXT NOT NULL, -- same enum

  -- Relation semantics
  relation     TEXT NOT NULL, -- 'supports' | 'contradicts' | 'refines' | 'derived_from' | 'co_observed'
  confidence   REAL NOT NULL DEFAULT 0.5, -- 0.0 – 1.0
  reinforceCount INTEGER NOT NULL DEFAULT 1,

  -- Provenance
  agentId      TEXT REFERENCES agents(id),
  adapterType  TEXT,          -- 'openclaw' | 'claude_code' | 'http' | etc.
  runId        TEXT,          -- which run created this link
  appId        TEXT,          -- which app context, nullable = workspace-global

  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);

CREATE INDEX idx_knowledge_links_workspace ON knowledge_links(workspaceId);
CREATE INDEX idx_knowledge_links_source ON knowledge_links(workspaceId, sourceId, sourceKind);
CREATE INDEX idx_knowledge_links_target ON knowledge_links(workspaceId, targetId, targetKind);
CREATE INDEX idx_knowledge_links_agent ON knowledge_links(workspaceId, agentId);
```

### 4.2 `app_memory` extension (existing, broadened)

Existing table already has `workspaceId` and `appId`. The upgrade:

```sql
-- appId becomes nullable = workspace-global memory
-- Add two new columns:
ALTER TABLE app_memory ADD COLUMN adapterType TEXT;
ALTER TABLE app_memory ADD COLUMN globalConfidence REAL DEFAULT 0.0;
-- globalConfidence > 0.7 → shown in workspace Brain Map regardless of app
```

### 4.3 New realtime event

```typescript
// packages/core/src/events.ts
BRAIN_LINK_CREATED: 'brain:link_created'
BRAIN_ATOM_REINFORCED: 'brain:atom_reinforced'
```

---

## 5. Universal Auto-Promotion Engine

### 5.1 The hook location

```typescript
// apps/api/src/engine/WorkflowEngine.ts
// Inside #completeRun() or #completeNode() when node.config.kind === 'agent_task'

private async #maybePromoteFromAgentTask(
  ctx: RunContext,
  node: WorkflowNode,
  output: AgentTaskOutput
): Promise<void> {
  // Fire-and-forget — never blocks run completion
  setImmediate(async () => {
    try {
      await this.deps.collectiveBrain.extractAndPromote({
        workspaceId: ctx.workspaceId,
        agentId:     node.config.agentId,
        adapterType: output.adapterType,
        runId:       ctx.runId,
        appId:       ctx.appId ?? null,
        taskInput:   output.inputSnapshot,
        taskOutput:  output.result,
        toolCalls:   output.toolCalls ?? [],
        durationMs:  output.durationMs,
      });
    } catch {
      // Swallow — learning failures must never affect run outcomes
    }
  });
}
```

Key principle: **promotion is always async and always swallowed.** It enriches the brain without ever touching the critical path.

### 5.2 `CollectiveBrainService` (new service)

```typescript
// apps/api/src/services/collectiveBrain.ts

export class CollectiveBrainService {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly episodicStore: EpisodicMemoryStore,
    private readonly intelligencePromotion: IntelligencePromotion,
    private readonly knowledgeStore: KnowledgeStore,
  ) {}

  async extractAndPromote(input: ExtractionInput): Promise<void>
  async createLink(input: LinkInput): Promise<KnowledgeLink>
  async reinforce(workspaceId: string, linkId: string): Promise<void>
  async findSimilar(workspaceId: string, text: string, limit?: number): Promise<KnowledgeAtom[]>
  async getGraph(workspaceId: string, options?: GraphOptions): Promise<BrainGraph>
}
```

### 5.3 Extraction pipeline (inside `extractAndPromote`)

```text
1. Parse agent output for extractable facts
   - detect factual claims (heuristic: short declarative sentences)
   - detect observed tool results (API responses, db results)
   - detect failure patterns (error messages + what was tried)

2. For each candidate fact:
   a. Call findSimilar() against existing atoms
   b. If similarity > 0.85 → reinforce existing + skip insert
   c. If similarity 0.5–0.85 → insert new atom + create 'refines' link
   d. If similarity < 0.5 → insert new standalone atom

3. Emit BRAIN_ATOM_REINFORCED or BRAIN_LINK_CREATED on the workspace room

4. If atom confidence > 0.7 → set globalConfidence, mark as workspace-global
```

### 5.4 What counts as a promotable fact

The extractor looks for:

| Signal | Example |
|---|---|
| Explicit tool result | `GET /rate-limit returned 429 after 100 requests` |
| Agent conclusion | `The customer tier determines discount eligibility` |
| Failure pattern | `Retrying with exponential backoff resolved the timeout` |
| Successful pattern | `Summarizing to 3 bullet points before sending reduces approval time` |
| Contradiction | `Documentation says 200 limit, but actual limit observed was 100` |

What it does **not** promote:

- intermediate reasoning steps
- token-level stream content
- data that looks like PII
- tool calls that returned errors without resolution

---

## 6. Cross-Agent Deduplication and Reinforcement

### 6.1 The deduplication boundary

Two knowledge atoms are considered duplicates if:

```text
similarity(atom_a.text, atom_b.text) > 0.85
AND atom_a.workspaceId == atom_b.workspaceId
AND they are not contradictions of each other
```

Similarity uses the existing `HashingEmbeddingProvider` for now. The upgrade path is a proper embedding model (sentence-transformers or an LLM embedding call), but the hash approach gives 80% of the value at zero cost.

### 6.2 Reinforcement model

When an existing atom is reinforced:

```text
new_confidence = old_confidence + (1 - old_confidence) * 0.15
reinforceCount += 1
```

This gives diminishing returns — confidence asymptotically approaches 1.0 but never reaches it. A single agent cannot make a fact "gospel." It requires many independent observations.

### 6.3 Contradiction handling

When similarity > 0.85 but the new fact contradicts the existing one:

```text
1. Create a 'contradicts' link between them
2. Flag both atoms with disputed = true
3. Emit BRAIN_ATOM_REINFORCED with disputed flag
4. Show a warning node in the Brain Map at that edge
```

The operator sees the contradiction in the Brain Map and can resolve it manually (confirm one, archive the other, or let both stand with a note). This is the "gap/warning" node type from `THE-BRAIN-UX-ARCHITECTURE.md §9.1`.

---

## 7. The Brain Map — Real-Time Graph Visualization

### 7.1 Decision: Brain Map is the right home

**The workflow Canvas stays unchanged.** The Canvas visualizes execution flow. The Brain Map visualizes knowledge topology. These are different jobs.

The Brain Map is already specced as one of the three Brain internal modes in `THE-BRAIN-UX-ARCHITECTURE.md §8.1`. The upgrade is making it live and real instead of a placeholder.

From a navigation standpoint:

```text
App detail page
  └── Brain tab
        └── Map mode   ← THIS IS THE COLLECTIVE GRAPH
        └── Sources mode
        └── Memory mode
        └── Baselines mode

Global Brain (/knowledge or /brain)
  └── Map mode   ← WORKSPACE-WIDE COLLECTIVE GRAPH
  └── Sources mode
  └── Memory mode
  └── Episodes mode
```

### 7.2 Graph data model for the UI

```typescript
interface BrainGraph {
  nodes: BrainNode[];
  links: BrainLink[];
  meta: {
    workspaceId: string;
    scope: 'app' | 'workspace';
    appId?: string;
    atomCount: number;
    linkCount: number;
    lastActivityAt: string;
    adapterTypes: string[];         // which adapters contributed
  };
}

interface BrainNode {
  id: string;
  kind: 'core' | 'chunk' | 'episode' | 'memory' | 'pattern' | 'warning' | 'gap';
  label: string;
  confidence: number;               // 0.0 – 1.0, drives glow intensity
  reinforceCount: number;           // drives node size
  agentId?: string;
  adapterType?: string;             // drives color family
  appId?: string;                   // null = workspace-global
  isDisputed?: boolean;
  isStale?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface BrainLink {
  id: string;
  source: string;                   // BrainNode.id
  target: string;                   // BrainNode.id
  relation: 'supports' | 'contradicts' | 'refines' | 'derived_from' | 'co_observed';
  confidence: number;
  reinforceCount: number;
  agentId?: string;
  adapterType?: string;
}
```

### 7.3 API endpoint

```typescript
GET /v1/brain/graph
Query:
  ?scope=workspace|app
  &appId=<appId>        (when scope=app)
  &kinds=chunk,episode,memory,pattern   (filter atom types)
  &minConfidence=0.3
  &limit=200            (max nodes)

Response: { graph: BrainGraph }
```

```typescript
GET /v1/brain/graph/node/:id
Response: { node: BrainNode, links: BrainLink[], relatedNodes: BrainNode[] }
```

### 7.4 Frontend component architecture

```text
BrainMapView (apps/web/src/components/brain/BrainMapView.tsx)
  ├── BrainGraphStage         ← SVG/canvas force-directed graph
  │     ├── BrainGraphNode    ← per-node renderer (glow, ring, label)
  │     ├── BrainGraphEdge    ← per-link renderer (relation type → stroke style)
  │     └── BrainGraphCore   ← the central workspace/app identity node
  ├── BrainMapToolbar         ← filter chips (adapter, kind, minConfidence)
  ├── BrainNodeDetailRail     ← right-side detail panel on selection
  │     ├── NodeHeader        ← kind badge, confidence meter, adapter tag
  │     ├── NodeProvenance    ← which run/agent/adapter created it
  │     ├── NodeLinks         ← list of links in/out with relation labels
  │     └── NodeActions       ← confirm, archive, override, create link
  └── BrainLiveIndicator      ← pulsing dot when new atoms are arriving
```

### 7.5 Force layout rules

```text
- Core node: pinned at visual center, never moves
- Workspace-global atoms: tight orbital ring around core
- App-scoped atoms: outer ring, grouped by appId (color)
- Adapter-colored: each adapterType gets a hue family
  - openclaw    → cyan  (#06b6d4)
  - claude_code → violet (#7c3aed)
  - http        → amber (#d97706)
  - future      → auto-assigned from palette
- Confidence → glow intensity + ring size
- reinforceCount → node radius (log scale)
- 'contradicts' links → red dashed stroke
- 'supports' links → faint line, same color family as dominant adapter
- 'refines' links → dotted, neutral gray
- 'derived_from' links → directional arrow, slight gradient
```

### 7.6 Real-time behavior

When `BRAIN_LINK_CREATED` arrives on the workspace socket room:

```text
1. Animate new node in: bloom from its source (which agent is active)
2. Draw the link from source → new node with a trace animation
3. Ripple the source node if it was reinforced
4. Update BrainLiveIndicator
```

When `BRAIN_ATOM_REINFORCED` arrives:

```text
1. Brief pulse animation on the existing node (confidence ring expands and settles)
2. reinforceCount label increments
3. If confidence crosses 0.7 → glow intensifies, "workspace-global" badge appears
```

### 7.7 Visual design system

Following the aesthetic from `THE-BRAIN-UX-ARCHITECTURE.md §3.1`:

```text
Background: #080b12  (near-black, atmospheric)
Core node:  #e2e8f0 with a 16px cyan glow (rgba(6,182,212,0.4))
Confidence rings: concentric dashed circles, opacity = confidence * 0.8
Grid: subtle polar grid lines at opacity 0.04
Link strokes: 1px default, 1.5px for high-confidence, 2.5px for contradictions
Font: system-ui, tabular nums for counts
Selection: hard white border + all non-related nodes at 0.25 opacity
```

---

## 8. Implementation Phases

### Phase 1 — Data foundation (backend only)

1. Add `knowledge_links` table via Drizzle migration
2. Add `adapterType` + `globalConfidence` columns to `app_memory`
3. Add `BRAIN_LINK_CREATED` + `BRAIN_ATOM_REINFORCED` to `REALTIME_EVENTS`
4. Scaffold `CollectiveBrainService` with `createLink()`, `reinforce()`, `getGraph()`
5. Wire `CollectiveBrainService` into `bootstrap.ts`
6. Add `GET /v1/brain/graph` route

### Phase 2 — Universal promotion hook

7. Add `#maybePromoteFromAgentTask()` inside `WorkflowEngine` at `agent_task` completion
8. Wire `CollectiveBrainService.extractAndPromote()` (fire-and-forget)
9. Start with simple heuristic extraction (declarative sentence detection, tool result extraction)
10. Emit realtime events on every link creation or reinforcement

### Phase 3 — Brain Map UI

11. Create `BrainMapView.tsx` with `@visx/network` or D3 force simulation
12. Create `BrainGraphNode.tsx`, `BrainGraphEdge.tsx`, `BrainGraphCore.tsx`
13. Create `BrainNodeDetailRail.tsx`
14. Create `BrainMapToolbar.tsx` (filter chips)
15. Wire into existing `BrainTabHeader` Map mode in `AppDetailPage`
16. Wire into `KnowledgePage` for the workspace-wide Global Brain view
17. Subscribe to `BRAIN_LINK_CREATED` / `BRAIN_ATOM_REINFORCED` on workspace room
18. Implement enter/pulse animations

### Phase 4 — Cross-agent intelligence

19. Add similarity-based deduplication in `extractAndPromote()`
20. Add contradiction detection → `'contradicts'` link + disputed flag
21. Add global confidence elevation (> 0.7 → workspace-global)
22. Add `GET /v1/brain/graph/node/:id` detail endpoint
23. Add node actions in detail rail: confirm, archive, override confidence

---

## 9. What this unlocks beyond the tweet

The tweet shows agents with a shared knowledge graph they mostly feed manually. Agentis's architecture after this implementation does something fundamentally different:

| Feature | Tweet's vision | Agentis after this |
|---|---|---|
| Knowledge source | Manually curated | Auto-promoted from every agent run |
| Graph growth | Operator feeds it | Grows as a side effect of work |
| Cross-agent sharing | Shown as a feature | Structural — workspace scope by default |
| Adapter diversity | Single runtime | Any adapter contributes (openclaw, claude_code, http, future) |
| Deduplication | Not described | Automatic similarity-based merging |
| Contradiction handling | Not present | First-class disputed node type |
| Real-time visualization | Static graph | Live force-directed map, new nodes animate in |
| Absence modeling | Not present | Gap nodes show what the brain doesn't know yet |
| Global vs. app scope | Not present | Two-tier: app-local + workspace-global (confidence-gated) |

The specific "ahead of" moments:

**1. Gap nodes** — the Brain Map explicitly shows what the system doesn't know. No other system makes absence visible as a first-class UI element. This turns "I don't know" from a silent failure into an actionable insight.

**2. Contradiction edges** — when two agents learn contradictory facts, the Brain Map shows a red disputed edge. The operator resolves it. This is an explicit model of epistemological conflict, not just soft confidence scores.

**3. Confidence-gated global promotion** — a fact starts app-scoped. When 3 different agents on 3 different adapters have independently confirmed it (reinforceCount ≥ 3, confidence ≥ 0.7), it auto-elevates to workspace-global. No human curator needed. The collective decides.

**4. Adapter-colored topology** — you can see at a glance which parts of the brain were contributed by OpenClaw agents vs. ClaudeCode agents vs. HTTP agents. If all your best knowledge came from one adapter, that's a visible architectural risk.

---

## 10. What stays unchanged

- The **workflow Canvas** is untouched. It visualizes execution. The Brain Map visualizes knowledge. Different jobs.
- The **existing memory tables** (`app_memory`, `memory_episodes`, `kb_chunks`) are extended, not replaced.
- The **existing promotion pipeline** (`RunPromotionExtractor`, `IntelligencePromotion`) is called from inside `CollectiveBrainService`, not replaced.
- The **existing Brain Manage view** stays as the editable list view. Map and Manage remain two modes.
- **No changes to the adapter protocol.** Adapters don't need to know about the brain. The engine observes their output and the brain service handles the rest.

---

## 11. Open questions for implementation

1. **Embedding quality**: `HashingEmbeddingProvider` gives lexical similarity only. For Phase 4, should we call an LLM embedding endpoint (e.g., `text-embedding-3-small`) for true semantic deduplication, or accept lexical accuracy for V1?

2. **Extraction model**: The heuristic extractor (declarative sentence detection) may miss rich insights from multi-step reasoning. Should we add an optional "summarize learnings" LLM call after long agent_tasks?

3. **Graph scaling**: With 200 node limit, what is the default ranking? Most recent? Highest confidence? Most connected? Recommendation: default to `ORDER BY confidence DESC, reinforceCount DESC LIMIT 200`.

4. **Workspace Brain route**: Should the Global Brain live at `/knowledge` (existing Knowledge Hub with a Map tab) or at a new `/brain` top-level route? Recommendation: add a Map tab to the existing `/knowledge` page in Phase 3 to avoid a new nav item, then graduate to `/brain` in a future release if needed.
