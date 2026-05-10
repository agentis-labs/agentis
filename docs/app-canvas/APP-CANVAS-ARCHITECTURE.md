# Agentis App Canvas Architecture
## Visual App Building On Top Of The Workflow Engine

> Status: implemented (V1) — 2026-05-10
> Date: 2026-05-09
> Scope: app graph model, app detail IA, shared canvas infrastructure, node taxonomy, editing model, runtime mapping, phased implementation
> Depends on: `docs/AGENTIS-APP-FORMAT.md`, `docs/THE-BRAIN-UX-ARCHITECTURE.md`, `docs/MEMORY-ARCHITECTURE.md`, current workflow canvas implementation
>
> Implementation status: AppGraph types, manifest template, instance persistence,
> validation service, REST surface (`/v1/apps/:slug/canvas`), three-layer app
> shell (Output / Canvas / Memory), drag-drop editor with 12 node types and
> 8 edge types, drill-down to workflow editor. The Memory tab still surfaces
> wedge data (knowledge / memory / evaluators / baselines); the dedicated
> Brain UX from THE-BRAIN-UX-ARCHITECTURE will replace it in the next pass.

---

## 1. Why this document exists

App creation in Agentis is structurally powerful and experientially weak.

Today:

- workflows are visual
- apps are mostly package composition
- app editing is scattered across cards, tabs, setup, and indirect workflow links

That creates a product gap:

- the engine is visual
- the app concept is not visual enough
- the app concept is also not concrete enough

Users can build workflows.
They still cannot clearly **build an app as a system**.

This document defines the correct architecture for making app creation and editing visual without collapsing the distinction between:

- an app as a product/system
- a workflow as an execution graph

The guiding product shape is:

When the operator opens an app, the top of the page should expose three primary layers:

```text
[Output] [Canvas] [Memory]
```

This segmented control is not decoration.
It is the new core mental model for app operation:

- **Output** = what the app produces
- **Canvas** = how the app is built and how its systems connect
- **Memory** = what the app knows, remembers, and learns

---

## 2. Executive conclusion

The current workflow canvas should be reused as the **editing engine**.
It should not be reused as the **semantic model** for app creation.

That is the key decision.

The correct architecture is:

1. Keep the workflow graph as the execution DAG.
2. Introduce a new **AppGraph** as a first-class system-composition graph.
3. Reuse the same canvas infrastructure for both.
4. Give apps their own shell with `Output / Canvas / Memory`.
5. Make the app canvas minimal at the top level and drill down into workflows.

In blunt terms:

**Reuse the canvas renderer and interaction model. Do not reuse the workflow meaning.**

---

## 3. The core product distinction

### 3.1 Workflow canvas

A workflow answers:

- what executes
- in what order
- with what branching
- with what state handoffs

Its model is low-level and execution-oriented.

### 3.2 App canvas

An app answers:

- what the system is made of
- which workflows are central
- where data enters
- where agents and tools live
- where approvals happen
- what outputs emerge
- how memory and intelligence fit into the system

Its model is higher-level and system-oriented.

### 3.3 Why one graph model for both is wrong

If you try to use the workflow graph itself as the app graph:

- app meaning becomes too low-level
- editing becomes overloaded
- users lose clarity
- the engine model gets polluted with presentation concerns
- the app concept becomes a giant workflow instead of a coherent product system

This is a modeling error, not just a UX problem.

---

## 4. Current infrastructure review

This section judges the current codebase honestly.

### 4.1 What is strong already

The current workflow editor gives you a serious foundation:

- drag/drop graph building in [WorkflowCanvasPage.tsx](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/web/src/pages/WorkflowCanvasPage.tsx)
- palette interactions in [NodePalette.tsx](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/web/src/components/canvas/NodePalette.tsx)
- inspector-based editing in [ContextInspector.tsx](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/web/src/components/canvas/ContextInspector.tsx)
- graph persistence and validation in [workflow.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/workflow.ts) and workflow routes
- app packaging and activation in [package.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/package.ts) and [apps.ts](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/routes/apps.ts)

That means this problem is not "build a new editor from nothing."

### 4.2 What is weak today

#### Workflow canvas is too page-owned

The canvas implementation is still heavily owned by the page, not by a reusable graph editor engine.

That is acceptable for one editor.
It becomes a scaling problem when you want:

- workflow builder
- app builder
- future memory/brain map
- specialized graph surfaces

#### Palette is workflow-semantic

The current palette is explicitly workflow-shaped:

- trigger
- agent task
- skill
- approval
- branch
- subflow
- webhook
- wait

That is not a useful top-level language for app composition.

#### Inspector is workflow-node-specific

The current inspector switches on workflow node kinds.
App editing needs a different object system entirely.

#### App model is not graph-native

The current `agentis` package format is list-based and composition-based:

- `agents[]`
- `workflows[]`
- `skills[]`
- `integrations[]`
- `datasetSpecs[]`
- `knowledgeSeeds[]`
- `evaluatorRubrics[]`
- `workflowBaselines[]`

That is strong as a package model.
It is not enough as a visual editing model.

### 4.3 Engineering implication

The codebase is ready for:

- shared graph editing infrastructure
- a new app graph type
- app-specific nodes and inspector forms

It is not ready for:

- pretending the current workflow graph is the app graph

---

## 5. The new app shell

When an operator clicks into an app, the shell should become:

```text
[Output] [Canvas] [Memory]
```

This should be implemented as a segmented control at the top of the page, not as a heavy old-style tab bar.

It should feel closer to the interaction language of the reference:

- clear
- compact
- central
- product-defining

### 5.1 Meaning of the three layers

#### Output

The operator surface.

Shows:

- live outputs
- run outcomes
- current value produced
- approvals and issues
- recent artifacts and decisions

#### Canvas

The system architecture and build surface.

Shows:

- app modules
- workflow modules
- agent groups
- data sources
- integration surfaces
- output surfaces

This is where the user visually creates and edits the app as a system.

#### Memory

The intelligence surface.

Shows:

- imported knowledge
- promoted memories
- evaluator patterns
- baselines
- gaps and staleness

This aligns with [THE-BRAIN-UX-ARCHITECTURE.md](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/docs/THE-BRAIN-UX-ARCHITECTURE.md), but uses `Memory` as the operator-facing term in the segmented shell if that is clearer and more direct than `Brain`.

### 5.2 Why `Memory` and not `Brain` in the segmented shell

If the product copy for the segmented control is:

- `Output`
- `Canvas`
- `Memory`

then users instantly understand the hierarchy better.

`The Brain` can remain:

- the internal name of the memory intelligence surface
- or the title inside the Memory view

Example:

```text
[Output] [Canvas] [Memory]

Memory
The Brain of Autonomous SDR
```

This is better product language than exposing metaphor too early.

---

## 6. The app canvas model

### 6.1 Principle

The app canvas is not a workflow DAG.
It is a **system composition graph**.

### 6.2 What the top level must optimize for

At first zoom level, the app canvas must answer:

- what this app is made of
- how the major modules connect
- what enters and what exits
- where the main control points are

It must not answer:

- every internal workflow branch
- every skill mapping
- every prompt
- every low-level execution detail

Those belong on drill-down.

### 6.3 First-zoom rule

At default zoom, show no more than:

- 1 core app node
- 3 to 7 major modules
- 2 to 5 external surfaces
- key data inputs
- key outputs

If the first view is dense, the system has already failed.

---

## 7. AppGraph: the new first-class model

### 7.1 Required addition

Introduce a new canonical type:

```ts
interface AppGraph {
  version: 1;
  nodes: AppGraphNode[];
  edges: AppGraphEdge[];
  viewport: { x: number; y: number; zoom: number };
}
```

This should live in:

- `packages/core/src/types/appGraph.ts`

and be used by:

- app builder
- app detail canvas
- future import/export logic
- app graph validation

### 7.2 Why AppGraph must exist

Without it, the UI either:

- renders a derived diagram that cannot really be edited
- or abuses workflow graph semantics for app structure

Neither is acceptable.

### 7.3 AppGraph node taxonomy

Use a strict, minimal taxonomy.

```ts
type AppGraphNodeType =
  | 'app_core'
  | 'entry_workflow'
  | 'workflow_module'
  | 'agent_group'
  | 'knowledge_source'
  | 'memory_surface'
  | 'integration_surface'
  | 'approval_surface'
  | 'output_surface'
  | 'scheduler'
  | 'channel_surface'
  | 'brain_surface';
```

Each node should be meaningful at the system level.

### 7.4 Node semantics

#### `app_core`

The center of the app.
Represents identity, status, and primary entrypoint.

#### `entry_workflow`

The main orchestrating workflow for the app.

#### `workflow_module`

A reusable or secondary workflow inside the app.

#### `agent_group`

A logical group of agents or a major role cluster.
Not every individual agent at top level.

#### `knowledge_source`

Imported dataset or seed-based knowledge domain.

#### `memory_surface`

Represents the memory system of the app as a module, not the internal memory graph.

#### `integration_surface`

Represents external operational systems:

- HubSpot
- Notion
- Slack
- GitHub
- custom ERP

#### `approval_surface`

Represents a human checkpoint zone.

#### `output_surface`

Represents meaningful outcomes:

- booked meetings
- generated reports
- updated CRM records
- produced content

#### `scheduler`

Represents cron or event-based recurring activation.

#### `channel_surface`

Represents external communication outputs or inputs.

#### `brain_surface`

Represents the bridge into the Memory layer.
This is the explicit visual connection between the app architecture and the intelligence architecture.

### 7.5 AppGraph edges

Edges should support semantic meaning:

```ts
type AppGraphEdgeType =
  | 'activates'
  | 'feeds'
  | 'reads_from'
  | 'writes_to'
  | 'approves'
  | 'publishes_to'
  | 'observes'
  | 'depends_on';
```

This lets the graph express system relationships rather than generic arrows.

---

## 8. Shared canvas engine, separate semantic layers

### 8.1 The right reuse strategy

Reuse:

- zoom/pan
- node dragging
- edge creation
- minimap
- autosave
- selection model
- inspector shell
- node rendering infrastructure

Do not reuse directly:

- workflow node taxonomy
- workflow inspector forms
- workflow palette
- workflow validation rules

### 8.2 Architecture direction

Split the current canvas system into:

#### Shared graph editor infrastructure

- generic graph shell
- viewport
- selection
- persistence hooks
- keyboard actions
- drag/drop framework

#### Workflow graph mode

- current workflow node kinds
- current workflow palette
- current workflow forms

#### App graph mode

- app node kinds
- app palette
- app forms
- app validation

This is the clean engineering architecture.

### 8.3 Recommended file structure

```text
apps/web/src/components/graph/
  GraphEditorShell.tsx
  GraphToolbar.tsx
  GraphPalette.tsx
  GraphInspectorShell.tsx
  GraphMinimap.tsx
  graphTypes.ts

apps/web/src/components/workflow-graph/
  WorkflowGraphPalette.tsx
  WorkflowGraphInspector.tsx
  WorkflowGraphNode.tsx
  WorkflowGraphConfig.ts

apps/web/src/components/app-graph/
  AppGraphPalette.tsx
  AppGraphInspector.tsx
  AppGraphNode.tsx
  AppGraphConfig.ts
  AppGraphLegend.tsx

apps/web/src/pages/
  WorkflowCanvasPage.tsx
  AppCanvasPage.tsx
```

### 8.4 Backend type structure

```text
packages/core/src/types/
  workflow.ts
  appGraph.ts
```

Do not hide app graph types inside web-only code.
They are product contracts.

---

## 9. Editing model

### 9.1 App canvas is system editing

When editing an app, the user should be editing:

- what major modules exist
- how they connect
- what workflows power them
- what datasets feed them
- what outputs they expose
- where approvals and integrations sit

### 9.2 Drill-down model

Clicking an app module should open one of:

- linked workflow
- linked data source
- linked output surface
- linked memory surface
- linked agent group

This is the key UX principle:

**App canvas for composition. Workflow canvas for execution logic.**

### 9.3 Edit granularity

At the app level, edits should be:

- add module
- remove module
- connect module
- relabel module
- bind module to a workflow/agent/integration/dataset
- reorder importance visually

At the workflow level, edits remain detailed and execution-specific.

### 9.4 Prevent semantic leakage

Do not let app canvas edits silently mutate workflow internals unless the action explicitly drills into workflow editing.

This keeps the mental model clean.

---

## 10. App canvas visual language

### 10.1 Design goal

The app canvas should feel:

- powerful
- intentional
- readable
- calm
- system-level

It should not feel:

- crowded
- simulated-enterprise
- fake-metrics-heavy
- poster-like

### 10.2 Use the inspiration correctly

The reference image is useful for:

- showing power visually
- using strong color-coded subsystems
- revealing system structure
- making a multi-part app feel alive

But we should simplify it aggressively:

- fewer modules visible at first
- tighter hierarchy
- less ornamental text
- fewer equally weighted cards
- stronger central narrative

### 10.3 Top-level composition

Preferred composition:

```text
inputs / knowledge      app core + orchestration      outputs / channels
```

This is more understandable than a large radial galaxy for app editing.

Use:

- slight asymmetry
- directional left-to-right or hub-and-spoke hybrid
- grouped color zones

### 10.4 Color semantics

Suggested semantic palette:

- core/orchestration: indigo-violet
- workflows: cyan-blue
- agent groups: amber-gold
- knowledge/data: teal
- approvals: rose-red
- outputs: lime-green
- integrations/external surfaces: slate with accent edges

The color must carry meaning, not decoration.

### 10.5 Motion

The app canvas should have:

- subtle path tracing on hover
- soft pulse on active module
- staged load reveal
- live run path highlighting

No over-animated graph soup.

---

## 11. The three-layer app shell in detail

This is the page architecture that should replace the current app detail page model.

## 11.1 Output layer

Primary operator layer.

Shows:

- outputs
- runs
- approvals
- live work
- current value delivered

Use the existing app result/performance infrastructure as the starting point.

## 11.2 Canvas layer

Primary build layer.

Shows:

- app graph
- drill-down to workflows
- app architecture editing
- module health and live status

This is the new visual builder layer.

## 11.3 Memory layer

Primary intelligence layer.

Shows:

- knowledge sources
- memory health
- evaluator patterns
- baseline maturity
- eventual Brain surface

This is the execution companion to [MEMORY-ARCHITECTURE.md](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/docs/MEMORY-ARCHITECTURE.md) and [THE-BRAIN-UX-ARCHITECTURE.md](/C:/Users/antar/OneDrive/Documentos/nexseed/agentis/docs/THE-BRAIN-UX-ARCHITECTURE.md).

### 11.4 Why this shell is right

Because it gives each app three clear identities:

- what it does
- how it is built
- what it knows

That is a much better product truth than:

- performance
- results
- config
- activity

The old tabs describe admin categories.
The new shell describes the app itself.

---

## 12. Data model additions required

### 12.1 AppGraph persistence

Every app instance should store or reference an `appGraph`.

Options:

#### Option A: store on app instance

Add `appGraph` JSON field to app instance records.

Pros:

- simple
- app-specific
- direct editing

Cons:

- graph duplicated if reused across environments

#### Option B: store on package contents

Add `appGraph` to `agentisPackageContents`.

Pros:

- app architecture travels with the package
- export/import stays coherent

Cons:

- instance-specific changes become trickier

### 12.2 Recommended model

Use both, deliberately:

- `package.contents.appGraphTemplate`
- `appInstance.appGraph`

Behavior:

- activation copies template -> instance graph
- instance graph can evolve
- export can optionally re-distill instance graph back into template

This mirrors how real apps evolve after activation.

### 12.3 Suggested package addition

```ts
interface AgentisPackageContents {
  // existing fields...
  appGraphTemplate?: AppGraph;
}
```

### 12.4 Suggested app instance addition

```ts
interface AppInstance {
  // existing fields...
  appGraph?: AppGraph;
}
```

---

## 13. Validation rules

The app graph should be validated separately from workflow graphs.

### 13.1 Structural validation

- one `app_core`
- at least one `entry_workflow` or `workflow_module`
- no orphan `output_surface` unless explicitly disconnected by design
- no duplicate binding of the same unique module role where prohibited

### 13.2 Reference validation

If a node binds to:

- workflowId
- agent group reference
- datasetKey
- integration key

the reference must exist and be in scope.

### 13.3 Product validation

Warnings, not hard errors, for:

- no knowledge source
- no output surface
- no approval surface in high-risk app categories
- too many top-level workflow modules

This matters because many bad app designs are structurally valid but product-wise weak.

---

## 14. API architecture

### 14.1 New endpoints

Recommended:

```text
GET    /v1/apps/:slug/canvas
PATCH  /v1/apps/:slug/canvas
POST   /v1/apps/:slug/canvas/validate
POST   /v1/apps/:slug/canvas/from-package
```

### 14.2 Response shape

```ts
interface AppCanvasResponse {
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  graph: AppGraph;
  references: {
    workflows: Array<{ id: string; title: string }>;
    agents: Array<{ id: string; name: string; role?: string | null }>;
    datasets: Array<{ key: string; label: string; status?: string }>;
    integrations: Array<{ service: string; name?: string }>;
  };
  validation: {
    warnings: Array<{ code: string; message: string; nodeId?: string }>;
    errors: Array<{ code: string; message: string; nodeId?: string }>;
  };
}
```

### 14.3 Why the backend should compose this

The frontend should not assemble app architecture from:

- app detail
- package contents
- workflows
- datasets
- integrations
- memory surfaces

through five separate requests and local heuristics.

This is a product surface.
The backend should present it as one contract.

---

## 15. Component architecture

### 15.1 New app canvas page

Add:

- `apps/web/src/pages/AppCanvasPage.tsx`

### 15.2 New app graph components

Add:

- `apps/web/src/components/app-graph/AppGraphStage.tsx`
- `apps/web/src/components/app-graph/AppGraphPalette.tsx`
- `apps/web/src/components/app-graph/AppGraphInspector.tsx`
- `apps/web/src/components/app-graph/AppGraphNode.tsx`
- `apps/web/src/components/app-graph/AppGraphEdge.tsx`
- `apps/web/src/components/app-graph/AppGraphToolbar.tsx`
- `apps/web/src/components/app-graph/AppGraphMiniMap.tsx`

### 15.3 Shared infrastructure extraction

Refactor current workflow canvas into reusable primitives:

- `GraphEditorShell`
- `GraphSelectionState`
- `GraphViewportStore`
- `GraphAutosaveController`
- `GraphKeyboardShortcuts`

### 15.4 Do not duplicate implementations

If app canvas and workflow canvas fork too early, you will create permanent product drag.

The split must be:

- shared engine
- separate graph modes

not:

- two separate editors

---

## 16. User value review

### 16.1 Strong upside

If executed correctly, this could:

- make the app concept immediately legible
- reduce onboarding confusion
- make editing and reasoning about apps much easier
- visually differentiate Agentis from generic workflow products
- create a strong demo moment without deception

### 16.2 Why users will care

Users do not think:

- "I want to edit a package manifest"

They think:

- "I want to see how my SDR system works"
- "I want to understand what feeds this app"
- "I want to change this app without opening ten screens"

The app canvas directly addresses that.

### 16.3 Biggest user risk

If the app canvas becomes too dense or too decorative, users will stop trusting it as an editor and treat it as a marketing diagram.

That would be a major loss.

So the design rule must be:

**clarity first, drama second**

but still much more beautiful than the current state.

---

## 17. Engineering value review

### 17.1 Why this is worth the complexity

This is not "just UI polish."

It creates:

- a first-class app authoring model
- a place for app-level features to live
- a bridge between workflows and memory
- a clearer path to future app deployment, app visualization, and app debugging

### 17.2 Why this is risky

Because if you do it without introducing a new app graph model, you will create:

- semantic confusion
- fragile editor logic
- bad long-term product architecture

### 17.3 Final engineering judgment

This idea is **high-value and worth doing**.
But only under one condition:

**App canvas must become a first-class model, not a visual skin on top of workflow internals.**

That is the non-negotiable line.

---

## 18. Rollout plan

### Phase 1: Refactor the canvas engine

Goal:

- extract shared graph editing infrastructure from `WorkflowCanvasPage`

### Phase 2: Introduce `AppGraph`

Goal:

- add canonical app graph types and persistence

### Phase 3: Build the app shell

Goal:

- replace current app detail primary tabs with segmented `Output / Canvas / Memory`

### Phase 4: Ship minimal app canvas

Goal:

- system composition graph with:
  - app core
  - workflows
  - data sources
  - outputs
  - integrations

### Phase 5: Add drill-down and live overlays

Goal:

- workflow drill-down
- data freshness badges
- output status
- approvals and run indicators

### Phase 6: Connect to Memory layer

Goal:

- link app canvas to the Memory view and Brain architecture

This gives you a staged, realistic build path.

---

## 19. What not to do

### Do not use workflow node types as top-level app node types

That will feel clever for one week and wrong forever.

### Do not ship a static architecture poster

If it cannot be edited meaningfully, it is not a builder surface.

### Do not overload the first zoom level

Top-level app comprehension is the job.
Detail belongs on drill-down.

### Do not wait for the full memory system to ship the app canvas

The app canvas should land first and create the structural home for future layers.

### Do not turn the app page into a wall of tabs again

Use the segmented shell.
Make it feel central and intentional.

---

## 20. Final design statement

The correct future for app creation in Agentis is not:

- a workflow canvas with more colorful nodes
- or a static enterprise system diagram

It is:

**a first-class app canvas built on the same graph engine as workflows, but using a different semantic model**

inside an app shell organized around:

```text
Output / Canvas / Memory
```

This architecture gives Agentis something rare:

- a visual language for app composition
- a visual language for workflow execution
- a visual language for app intelligence

all connected, but not collapsed into one confusing surface.

If executed well, this becomes one of the strongest product moves in the platform.

