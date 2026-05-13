# Agentis The Brain UX Architecture
## Output / Canvas / Brain For Agentic Apps

> Status: proposed product + frontend architecture
> Date: 2026-05-09
> Scope: app detail IA, "The Brain" memory surface, global orchestrator brain, visual system, phased rollout, component architecture, API contracts
> Depends on: `docs/AGENTIS-UX-V2.md`, `docs/AGENTIS-APP-FORMAT.md`, `docs/MEMORY-ARCHITECTURE.md`, current `AppDetailPage.tsx`

---

## 1. Why this document exists

The current app experience is structurally correct but emotionally weak.

Right now the app detail surface is still too close to a standard operations dashboard:

- Performance
- Results
- Configuration
- Activity

That is serviceable.
It is not category-defining.

Agentis is trying to make **agentic apps** feel like a new class of software:

- alive
- running
- learning
- remembering
- changing over time

If that is true, the UI cannot present an app as a flat admin object.
It needs to present an app as a **living system**.

This is especially important before the full memory architecture lands.
We need a strong interaction model now so the platform can grow into it rather than bolt it on later.

The right answer is to reorganize the app experience around three primary views:

1. **Output**
2. **Canvas**
3. **Brain**

This document defines the UI/UX architecture for that system.

---

## 2. Executive conclusion

Every app in Agentis should have a three-view shell:

- **Output**: what the app produces
- **Canvas**: how the app works
- **Brain**: what the app knows, remembers, and learns

Above those app brains sits a **Global Brain** for the main orchestrator and workspace-level intelligence.

The Brain should not be a generic graph visualization.
It should be a high-signal intelligence surface that makes memory legible, operational, and beautiful.

The right mental model is:

```text
Output = what happened
Canvas = how it happened
Brain  = why this app knows what it knows
```

That is the architecture.

---

## 3. Design direction

### 3.1 Aesthetic thesis

The Brain should feel like a **cerebral observatory**, not a productivity dashboard and not a fake galaxy chart.

Visual principles:

- dark, atmospheric, low-glare surfaces
- bioluminescent knowledge accents
- crisp structural geometry
- deep negative space
- minimal chrome
- visible hierarchy through glow, line weight, and depth

The memorable thing is not "a graph."
The memorable thing is:

**you can see an app's intelligence architecture as a living structure.**

### 3.2 What to borrow from the reference

The reference image gets several things right:

- a central knowledge core
- strong radial composition
- node grouping by color
- line topology that feels alive
- dark spacious atmosphere

What we should not copy:

- fake decorative metrics with weak product meaning
- a static educational mind map structure
- too many equal-weight nodes at once
- a left nav that competes with the actual feature

Agentis needs something more operational, more layered, and more data-honest.

---

## 4. Product meaning of The Brain

### 4.1 What The Brain is

The Brain is the intelligence surface for an agentic app or the global orchestrator.

It is where the operator sees:

- what data the app knows
- what memories it has promoted
- what evaluator patterns it has learned
- where its strongest intelligence comes from
- what is stale, missing, disputed, or improving

### 4.2 What The Brain is not

It is not:

- a decorative graph
- a replacement for the canvas
- a raw database browser
- a transcript viewer
- a vector search admin panel

### 4.3 The core user promise

When the operator opens The Brain, they should instantly understand:

- whether this app is still generic or truly trained on their world
- what its memory is built from
- whether the intelligence is healthy
- what knowledge is driving today's outcomes

That is the job.

---

## 5. Information architecture

### 5.1 App-level shell

Every app detail page should move from the current four-tab model to a stronger primary navigation model:

```text
/apps/:slug

[Output] [Canvas] [Brain]
```

These are not equal in meaning.

- **Output** is the default for operators
- **Canvas** is for builders and debugging
- **Brain** is for trust, intelligence, and learning

### 5.2 Secondary surfaces

Secondary controls should live inside the active view rather than in top-level tabs.

Examples:

- Output subviews:
  - Live
  - History
  - Decisions

- Canvas subviews:
  - Build
  - Run
  - X-Ray

- Brain subviews:
  - Map
  - Sources
  - Memory
  - Baselines

### 5.3 Global orchestrator shell

At the workspace level, add:

```text
/brain
```

This is the **Global Brain**.

It represents:

- orchestrator intelligence
- cross-app knowledge flows
- workspace memory health
- app-to-app intelligence exchange

The app-level Brain is local and sharp.
The Global Brain is strategic and systemic.

---

## 6. The three primary views

## 6.1 Output

### Purpose

Show the value the app produces.

### Primary questions answered

- What did the app do?
- What is running now?
- What artifacts or outcomes did it produce?
- What requires my attention?

### Core layout

```text
+--------------------------------------------------------------------------------+
| Header                                                                         |
| App name · status · mode · triggers · quick actions                            |
+--------------------------------------------------------------------------------+
| KPI rail                                                                       |
| output count · success rate · cost · approvals · trend                         |
+--------------------------------------------------------------------------------+
| Main split                                                                     |
| Left: live output stream / decisions / artifacts                               |
| Right: run summary / health / pending actions                                  |
+--------------------------------------------------------------------------------+
```

### Output should feel

- immediate
- useful
- non-technical by default

This is the operator-facing default because operators care about what the app actually produced.

---

## 6.2 Canvas

### Purpose

Show the system as a machine of execution.

### Primary questions answered

- How is the app built?
- What path is executing right now?
- Where did it fail?
- How would I modify or debug it?

### Core layout

This largely builds on the existing canvas direction and should preserve:

- live workflow animation
- graph patch visibility
- active run overlays
- trace / x-ray inspection

The canvas remains the strongest "show the machine working" surface.
Do not diminish it.

---

## 6.3 Brain

### Purpose

Show the app as a machine of intelligence.

### Primary questions answered

- What does this app know?
- Where did that knowledge come from?
- What has it learned from real operation?
- What memory is affecting current outcomes?
- Is the intelligence layer healthy or weak?

### Core layout

The Brain is not a list page.
It is a layered field.

```text
+--------------------------------------------------------------------------------+
| Header                                                                         |
| Brain title · health state · scope chip · last updated · view controls         |
+--------------------------------------------------------------------------------+
| Intelligence stat rail                                                         |
| knowledge nodes · promoted memories · evaluator examples · baseline confidence |
+--------------------------------------------------------------------------------+
| Main stage                                                                     |
|   layered brain visualization                                                  |
|   centered core + source clusters + relationship traces                        |
+--------------------------------------------------------------------------------+
| Bottom context rail                                                            |
| selected node details · source provenance · related outputs · actions          |
+--------------------------------------------------------------------------------+
```

The stage is the hero.
The details rail is contextual, not dominant.

---

## 7. The Brain visual model

### 7.1 The correct model

The Brain should visualize the memory architecture defined in `MEMORY-ARCHITECTURE.md`.

That means the UI should not be one flat graph.
It should expose the five layers, but at the right level of abstraction.

For the UX, compress them into four visible strata:

1. **Core**
2. **Knowledge**
3. **Memory**
4. **Judgment**

This is visually cleaner than exposing all five system layers directly.

### 7.2 The four visible strata

#### Core

The center of the map.

Represents:

- app identity
- current intelligence health
- active mode
- dominant outcome loop

The core node should feel powerful and calm, not noisy.

#### Knowledge

The app's imported and seeded understanding.

Represents:

- seed knowledge
- imported datasets
- indexed documents
- external sources

Visual language:

- larger clusters
- structural, rectangular nodes
- cool-cyan / deep-teal range

#### Memory

The durable lessons and promoted episodes.

Represents:

- success patterns
- failures
- decisions
- recovered incidents
- operator-confirmed lessons

Visual language:

- orbital nodes with stronger glow
- warm violet / indigo / electric magenta range

#### Judgment

The evaluator and baseline layer.

Represents:

- rubric examples
- pass/fail bands
- confidence envelopes
- cost and latency expectations

Visual language:

- sharper geometry
- lime / amber accents
- stronger line precision

### 7.3 Why this is better than one flat graph

Because it reflects the architecture truth:

- imported knowledge is not the same as promoted memory
- promoted memory is not the same as evaluator judgment
- evaluator judgment is not the same as live output

When the UI expresses this clearly, operators can trust the system much faster.

---

## 8. Brain view modes

The Brain itself should have three internal visualization modes, switchable in the top-right of the Brain stage.

### 8.1 Map

The spatial knowledge map.

Best for:

- seeing the system shape
- understanding where intelligence comes from
- identifying thin or overloaded areas

### 8.2 Flow

A directional graph that shows how intelligence feeds outcomes.

Example path:

```text
CRM import -> knowledge cluster -> evaluator pattern -> outreach approval logic -> booked meeting
```

Best for:

- understanding causality
- debugging why outcomes changed
- showing learning loops

### 8.3 Ledger

A structured temporal memory view.

Best for:

- browsing promoted memories
- reviewing evaluator changes
- seeing baseline evolution

This prevents The Brain from becoming "pretty but shallow."

---

## 9. Node taxonomy

The Brain needs a limited, strict node taxonomy.
Too many node types will kill readability.

### 9.1 Node types

```text
core
dataset
knowledge_cluster
memory_episode
memory_pattern
evaluator
baseline
artifact
decision
warning
gap
```

### 9.2 Visual treatments

#### `core`

- circular
- strongest glow
- central
- contains app glyph + short health phrase

#### `dataset`

- compact card
- low glow
- tagged with source and freshness

#### `knowledge_cluster`

- medium card
- cluster count visible
- relation lines fan into the core or evaluator nodes

#### `memory_episode`

- small luminous capsule
- shows type and confidence

#### `memory_pattern`

- medium-high emphasis
- shows reusable lesson or repeated behavior

#### `evaluator`

- sharp frame
- score and confidence visible

#### `baseline`

- restrained card
- trend mini-sparkline

#### `warning`

- red-amber pulse
- only appears for meaningful issues:
  - stale knowledge
  - disputed memory
  - baseline drift
  - low evaluator confidence

#### `gap`

- dashed frame
- explicitly shows what the app still does not know

This last one is very important.
The Brain should visualize absence, not only presence.

---

## 10. Layout and motion architecture

### 10.1 Spatial rules

The Brain should not be a physics playground.

Use **guided force layout**, not free chaos.

Rules:

- core pinned near visual center
- layers arranged in rings or biased constellations
- selected cluster gently expands
- unrelated clusters dim but remain visible
- edges bundle where possible to reduce spaghetti

### 10.2 Motion philosophy

Motion should communicate:

- emergence
- linking
- learning
- focus

Motion should not communicate:

- novelty for its own sake
- crypto dashboard energy
- particle soup

### 10.3 Required motion moments

#### Page load

- core fades and blooms in
- layer groups appear in staggered cadence
- relationship traces draw outward

#### Selection

- selected node sharpens
- related nodes brighten
- unrelated nodes mute
- detail rail updates with a subtle slide and crossfade

#### New memory promoted

- a new memory pulse appears from the active run source
- line traces to its connected cluster
- confidence ring settles

#### Baseline drift

- quiet amber ripple on the affected baseline node

### 10.4 Performance constraints

This surface must remain smooth on a normal laptop.

Rules:

- use canvas or WebGL only if necessary
- prefer SVG for moderate graph sizes where interactivity matters
- degrade motion and edge density automatically at large scale
- virtualize detail lists

Do not overbuild the renderer before data scale demands it.

---

## 11. The Brain detail rail

### 11.1 Why this matters

The stage gets attention.
The detail rail creates trust.

### 11.2 Content by node type

When a node is selected, show:

#### Dataset

- source type
- import date
- row/doc count
- freshness
- linked knowledge clusters
- impact on evaluator confidence

#### Knowledge cluster

- short summary
- top sources
- related outputs
- related evaluator examples
- browse action

#### Memory pattern

- pattern statement
- confidence / trust / importance
- derived from N runs
- last used in an outcome

#### Evaluator

- rubric summary
- confidence
- last 10 verdict trend
- failure reasons

#### Baseline

- expected success/cost/latency
- current delta vs baseline
- first divergence timestamp

#### Gap

- what is missing
- why it matters
- which data source or run could fill it

### 11.3 Actions

Every selected node should expose a small, meaningful action set:

- `Browse source`
- `Open related output`
- `View in canvas`
- `Inspect run`
- `Compare before/after`
- `Mark stale`
- `Promote lesson`

No giant button soup.

---

## 12. Global Brain vs App Brain

### 12.1 Global Brain

The Global Brain is the orchestrator's intelligence map for the workspace.

Use cases:

- what the orchestrator knows about the whole workspace
- which apps are intelligence-rich or intelligence-poor
- cross-app knowledge flows
- workspace-wide memory health

Visual structure:

- one central orchestrator core
- app brains as orbiting macro-clusters
- shared datasets and shared patterns between them

### 12.2 App Brain

The App Brain is narrower and more operational.

Use cases:

- why this app produced what it produced
- what knowledge it is grounded in
- whether it has enough memory quality to trust

### 12.3 Rule

Do not merge these two surfaces.
They serve different cognitive jobs.

---

## 13. Pre-memory-system rollout strategy

This is important.

You said the full memory architecture will come later, and that is the right sequencing.
The UI must support that.

### 13.1 Phase A: Brain shell before full memory runtime

Build The Brain using currently available sources:

- `knowledgeSeeds`
- imported dataset status
- `workflowBaselines`
- evaluator rubric presence
- app outputs and run outcomes
- memory entries where they exist

What the Brain can honestly show in this phase:

- knowledge sources
- app intelligence coverage
- imported data richness
- baseline maturity
- memory gaps

What it must not fake:

- dense semantic memory webs that do not exist yet
- invented relationship strength
- fake "learning velocity" metrics

### 13.2 Phase B: Brain with promoted memory

Once episodic memory promotion exists, add:

- memory patterns
- success/failure episodes
- lesson promotion animation
- trust/confidence overlays

### 13.3 Phase C: Brain with evaluator memory and retrieval health

Add:

- evaluator example clusters
- baseline drift overlays
- retrieval-path explainability
- "used in today's run" traces

This phased approach keeps the UI honest and future-proof.

---

## 14. App detail page redesign

### 14.1 Replace the current tab structure

Current:

- Performance
- Results
- Configuration
- Activity

Target:

- Output
- Canvas
- Brain

Move the old content like this:

#### Output

- current Results
- most of current Performance
- pending approvals
- recent run outcomes

#### Canvas

- current workflow/configuration power surface
- run x-ray
- graph editing/debugging

#### Brain

- current intelligence/data/memory/baseline concepts
- new visualization stage

#### Secondary drawers

- Activity
- Configuration
- Settings

Those become drawers or side panels, not primary tabs.

### 14.2 Header redesign

App header should become stronger and simpler:

```text
[App glyph]  Autonomous SDR
Running · 2 live loops · CRM-fed · baseline stable

[Output] [Canvas] [Brain]
                               [Share] [Settings]
```

Below the view tabs:

- a slim health ribbon
- not a heavy stat block

Example:

```text
Knowledge 2,341 · Memory 847 · Evaluators 12 · Baseline 94% confident
```

---

## 15. UI architecture and component model

### 15.1 New page structure

Suggested files:

- `apps/web/src/pages/BrainPage.tsx`
- `apps/web/src/components/brain/BrainShell.tsx`
- `apps/web/src/components/brain/BrainStage.tsx`
- `apps/web/src/components/brain/BrainToolbar.tsx`
- `apps/web/src/components/brain/BrainDetailRail.tsx`
- `apps/web/src/components/brain/BrainLegend.tsx`
- `apps/web/src/components/brain/BrainStats.tsx`
- `apps/web/src/components/brain/BrainNodeCard.tsx`
- `apps/web/src/components/brain/BrainFlowMode.tsx`
- `apps/web/src/components/brain/BrainLedgerMode.tsx`

### 15.2 App shell integration

Evolve:

- [AppDetailPage.tsx](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/web/src/pages/AppDetailPage.tsx)

from a generic tab page into a three-view shell with conditional content mounts.

### 15.3 State model

Suggested client state:

```ts
interface BrainViewState {
  mode: 'map' | 'flow' | 'ledger';
  scope: 'app' | 'workspace';
  selectedNodeId: string | null;
  filters: {
    sourceTypes: string[];
    showGaps: boolean;
    showWarnings: boolean;
    freshness: 'all' | 'recent' | 'stale';
  };
  viewport: {
    zoom: number;
    x: number;
    y: number;
  };
}
```

This state should be local to the Brain surface, not leaked into the global shell store.

---

## 16. API and data contracts

### 16.1 Minimum server contract for Brain phase A

Add a high-level endpoint:

```text
GET /v1/apps/:slug/brain
```

Response shape:

```ts
interface BrainResponse {
  scope: 'app';
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  stats: {
    knowledgeNodes: number;
    memoryNodes: number;
    evaluatorNodes: number;
    baselineConfidence: number | null;
    staleSources: number;
  };
  layers: {
    core: BrainNode[];
    knowledge: BrainNode[];
    memory: BrainNode[];
    judgment: BrainNode[];
  };
  edges: BrainEdge[];
  warnings: BrainWarning[];
  gaps: BrainGap[];
}
```

### 16.2 Node contract

```ts
interface BrainNode {
  id: string;
  type:
    | 'core'
    | 'dataset'
    | 'knowledge_cluster'
    | 'memory_episode'
    | 'memory_pattern'
    | 'evaluator'
    | 'baseline'
    | 'artifact'
    | 'decision'
    | 'warning'
    | 'gap';
  label: string;
  description?: string;
  layer: 'core' | 'knowledge' | 'memory' | 'judgment';
  x?: number;
  y?: number;
  weight?: number;
  confidence?: number | null;
  trust?: number | null;
  freshness?: 'fresh' | 'aging' | 'stale' | null;
  status?: 'ok' | 'warning' | 'error' | 'inactive' | null;
  metadata: Record<string, unknown>;
}
```

### 16.3 Why a high-level endpoint is correct

Do not make the frontend assemble the Brain from ten lower-level endpoints.
This is a composed product surface.
The backend should compose it.

---

## 17. Interaction rules

### 17.1 Primary interaction

Clicking a node:

- focuses the node
- dims unrelated graph parts
- populates the detail rail
- reveals related outputs / runs / sources

### 17.2 Secondary interaction

Hovering:

- highlights immediate neighborhood only
- never floods the stage with labels

### 17.3 Filters

Allowed filters:

- knowledge only
- memory only
- judgment only
- stale only
- warnings only
- recent changes

### 17.4 Search

The Brain needs local search:

- dataset names
- memory patterns
- evaluator names
- knowledge cluster titles

Search should navigate and focus, not return a separate table.

---

## 18. Mobile and narrow layouts

The Brain cannot simply shrink.

### 18.1 Mobile behavior

On small screens:

- stage occupies top half
- detail rail becomes bottom sheet
- stats compress to horizontally scrollable pills
- legend collapses behind an icon

### 18.2 Fallback mode

If the graph becomes too dense or the screen is too narrow, default to:

- `ledger` mode on mobile
- optional `map` mode via toggle

This is practical, not a compromise of vision.

---

## 19. Accessibility

The Brain must be beautiful without being exclusionary.

Requirements:

- keyboard node traversal
- focus ring on selected nodes
- reduced-motion mode
- color not the sole carrier of meaning
- descriptive labels and summaries in the detail rail
- non-graph fallback summary list

Dark atmospheric UI is fine.
Unreadable UI is not.

---

## 20. What not to do

### Do not ship a fake cosmic graph

If relationship quality is unknown, do not imply precision.

### Do not let The Brain replace Output

Most operators still care first about what happened.

### Do not make Brain the same as Canvas

Canvas is execution topology.
Brain is intelligence topology.

### Do not over-index on vanity metrics

Metrics should answer:

- is the app informed?
- is the app learning?
- is the intelligence trustworthy?

Not:

- how many glowy nodes fit on screen

### Do not build a memory UI that depends on full backend completion

The shell must deliver value in stages.

---

## 21. Recommended rollout

### Milestone 1: New app shell

- replace app tabs with `Output / Canvas / Brain`
- keep existing data under the new IA
- no heavy visualization yet

### Milestone 2: Brain phase A

- build Brain shell
- ship `Map / Flow / Ledger` internal modes
- render knowledge sources, baselines, imports, gaps

### Milestone 3: Global Brain

- add workspace orchestrator brain
- show app-level intelligence clusters and cross-app links

### Milestone 4: Brain phase B

- add promoted memory patterns and episodes
- trust/confidence overlays

### Milestone 5: Brain phase C

- evaluator memory
- retrieval explainability
- "used in current run" traces

This sequence is aggressive but sane.

---

## 22. Final design statement

The Brain should become one of the iconic surfaces of Agentis.

Not because it is flashy.
Because it makes something invisible finally understandable:

**how an agentic app becomes intelligent.**

The right architecture is:

- app shell organized around Output / Canvas / Brain
- Brain as a layered intelligence surface
- Global Brain for the orchestrator
- phased rollout aligned with the real backend
- visual ambition anchored in operational truth

If this is executed well, people will not describe Agentis as "a workflow tool with memory."

They will describe it as:

**the place where agentic apps run, think, and remember in a way you can actually see.**

