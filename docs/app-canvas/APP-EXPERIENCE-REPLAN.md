# Agentis App Experience — Full Replan
## PM + UX Audit, Root Causes, and Actionable Decisions

> **Status:** Active planning — May 2026
> **Scope:** App configuration, app canvas, app output surface, onboarding, task issuing
> **Trigger:** Direct operator feedback on Social Listening build + screenshot audit

---

## The Core Problem in One Sentence

We built the app experience for engineers, not for operators who use apps.
Every surface exposes implementation details — workflows, glyph fallbacks, credential keys, dataset job IDs —
instead of value: what this app does for me, is it working, and what did it produce.

---

## Part I — App Configuration

### 1.1 Diagnosis

The current Configuration tab exposes seven "settings" sections that should never have existed in their current form.

**Identity** requires the operator to fill in:
- Image URL → redundant when you can upload
- Glyph fallback → should be auto-generated from initials, completely invisible
- Accent color → operators don't care; auto-derive from image or pick from a small palette
- Category → we call groupings "Spaces" in the product; using "Category" here is confusing and adds a free-text field for something that should be a Space assignment

**Workflows** presents raw workflow cards labeled with internal status badges and "0/0 triggers active" counter. An operator who didn't build this app has no idea what "0/0 triggers active" means or why they should care in a settings view.

**Agents** shows status and heartbeat info with no editing controls. It belongs in a monitoring/observability surface, not configuration. If we can't configure it here, it should not be here.

**Credentials** is called "Credential bindings" — a term from our internal model. Operators think "connections" or "accounts". The section itself is useful but the language and position are wrong.

**Output labels** is a developer concept. Operators don't think in paths and artifact types. This belongs inside the canvas or as part of the Output surface configuration, not as a standalone settings section.

**Budget & intelligence** mixes spend metrics (read-only facts) with the only editable field (soft cap), then buries datasets at the bottom of the same section.

**Danger zone** is the only section that is correctly placed and understood.

### 1.2 What Operators Actually Need from Configuration

There are three meaningful configuration concerns for an operator:

| Concern | What they want to do |
|---|---|
| **Identity** | Name it, give it a face, optionally say what it's for |
| **Connections** | See which external accounts this app needs; connect/reconnect them |
| **Limits** | Set a monthly cost cap, pause or delete |

Everything else is either:
- Auto-handled (glyph, accent color, defaults)
- Belongs to the canvas build surface (output labels, workflow wiring)
- Belongs to monitoring/observability (agent status, trigger last-fired)
- Not configurable at all and shouldn't be shown (dataset job IDs, workflow trigger counts)

### 1.3 Decisions

#### D-1: Collapse Identity to 3 fields
- **Name** (text input)
- **Image** (upload only — drop zone / click — no URL field, no glyph, no color picker)
- **Description** (optional, textarea)
- **Space** (dropdown of existing spaces the operator has — same concept as the Spaces nav, not a freetext "Category")
- Auto-generate initials avatar from name when no image is uploaded
- Drop glyph fallback, accent color, Image URL field entirely

#### D-2: Rename and simplify Credentials
- Call it **Connections** consistently everywhere
- Show one card per connection: service icon + service name + status (Connected / Missing) + one CTA button (Connect / Reconnect / Manage)
- Remove the "key", "profile", "binding label" fields from the visible UI — those are internal data

#### D-3: Remove Workflows, Agents, Output labels, Datasets from Config
- **Workflows**: belongs in Canvas (already accessible via the Canvas layer)
- **Agents**: belongs in a monitoring view, not config; nothing is configurable here
- **Output labels**: belongs in the Output surface "Setup" state (see Part III)
- **Datasets**: belongs in the Brain layer's "Import" view (already exists as BrainManageView)

#### D-4: Rename Budget → Limits, simplify
- Show only: monthly spend (read-only pill), soft cap input, pause/delete actions
- No usage bar, no dataset list, no "knowledge bases" counter in this section

#### D-5: Final config structure
```
Config sidebar:
  Identity       → 3 fields + image upload
  Connections    → service cards (was Credentials)
  Limits         → soft cap + pause/delete
```
That's it. Three sections. The rest is surfaced where it belongs.

---

## Part II — App Canvas

### 2.1 Diagnosis

The current app canvas has three compounding problems.

#### Problem A: It's visually and behaviorally different from the workflow canvas

The workflow canvas is fluid — panning is smooth, node grabs snap cleanly, everything responds immediately.
The app canvas feels laggy. Node grab lags, drag is jumpy, the experience breaks the illusion of a live system.

This is unacceptable when the workflow canvas already exists and works.
Root cause: the app canvas is likely rendering in a separate canvas component that isn't sharing the same interaction optimization that the workflow canvas uses.

#### Problem B: The node taxonomy is wrong

Current node labels in the app canvas:
- `CORE`, `INTEGRATION`, `AGENTS`, `ENTRY`, `OUTPUT`, `BRAIN`, `APPROVAL`, `CHANNEL`, `KNOWLEDGE`

These are *internal architecture categories*, not concepts that make sense to the operator building or reading the system graph.

An operator building a "Social Listening" app shouldn't need to mentally translate:
- "CORE" → "what does my app do"
- "BRAIN" → "this is the memory bridge"
- "CHANNEL" → "inbound/outbound comm"

The language should be the app's own language: data comes in, agents process it, results go out.

#### Problem C: Node configuration (Inspector) is terrible

When you click a node, the inspector shows:
- A form tied to the internal `packageContents` schema
- Fields like `workflowId`, `agentId`, `knowledgeBaseIds[]` — raw ID pickers
- No preview of what the connected entity actually does
- No inline help text, no visual affordance for what each field changes

A builder clicking "App core" and seeing a blank ID field has no idea what to do.

#### Problem D: The warning "Connect a workflow to Entry workflow so it has something to run" is obscure

This message is technically correct but productively useless. The operator doesn't know what "Entry workflow" means in this context, and the message doesn't tell them how to fix it.

### 2.2 Decisions

#### D-6: Fix the interaction layer first
- The app canvas now uses the shared React Flow `CanvasEngine`, so the original concern is not a separate custom engine.
- If app-canvas drag still feels laggy, profile the graph state/save pipeline rather than replacing the canvas engine.
- The likely remaining issue is `onNodesChange` pushing the full graph into React state during drag; defer persistence until drag end or debounce graph sync more aggressively.
- Keep the rule: no new canvas surface gets a bespoke pan/zoom/drag loop.

#### D-7: Rethink node labels — use operator language
Instead of `CORE / INTEGRATION / AGENTS / ENTRY / OUTPUT / BRAIN / APPROVAL / CHANNEL / KNOWLEDGE`:

| Current label | Replace with |
|---|---|
| CORE | **App core** (keep, but show "runs your main logic") |
| ENTRY | **Trigger** (when this app runs) |
| AGENTS | **Team** (the agents doing the work) |
| INTEGRATION | **Integration** (tools and APIs your agents use) |
| OUTPUT | **Output** (what this app produces) |
| BRAIN | **Memory** (what this app knows and learns) |
| APPROVAL | **Checkpoint** (pause for human review) |
| CHANNEL | **Channel** (where results are delivered) |
| KNOWLEDGE | **Knowledge** (information sources) |

Node subtitles should be one plain sentence, not an architecture type.
Example: "Entry workflow" → "Trigger · Runs when this app is triggered" → fine.
But `BRAIN` → `Brain bridge` with subtitle "BRAIN" is meaningless.

#### D-8: Inspector becomes a mini-card, not a raw form
When you click a node:
- Show the connected entity's name, type icon, and status in a preview card at the top
- Allow connecting/disconnecting with a search picker that shows entity names, not IDs
- Show at most 3 meaningful fields with plain-English labels
- Add a single "Open in canvas" or "Open agent" CTA to go deeper if needed

#### D-9: Replace obscure warnings with inline guidance
Instead of "Connect a workflow to Entry workflow so it has something to run":
- Show a pulsing dashed connector line from the Entry node to an empty slot
- Overlay text: "Connect a workflow here — this is how your app starts"
- Offer a "+ Connect workflow" button directly on the node

---

## Part III — App Output Surface

### 3.1 Diagnosis

This is the biggest gap.

The current Output surface, when you open an app, shows:
1. Performance tab (costs, run counts, cost trends, cost by agent)
2. Results tab (empty for most apps because output labels aren't configured)
3. Configuration
4. Activity

The operator opens their app and sees **money and costs first**. That is backwards.

An operator using an app should feel like:
> "My app ran, here's what it produced, here's what I need to look at, here's what I can send it to do next."

Not:
> "Your app spent $0.00. Success rate: 0%. 0 runs."

The mental model should feel like opening a mobile app:
- You see the *output* — the thing the app is for
- You see what needs your attention (approvals, issues, stalled runs)
- You see health signals as a small, ambient indicator, not the hero content

Additionally, there is no way to issue a task — no way to tell the app "do this now, investigate this, add this to the queue." Paperclip's issue/kanban system solves this exactly: operators issue work items that agents pick up and execute. Agentis has no equivalent.

### 3.2 What the Output Surface Should Feel Like

Think of opening a mobile app:
- Instagram opens showing you content, not your follower analytics
- Linear opens showing your issues, not your ticket creation costs
- Notion opens showing your documents, not your API usage

An app's Output layer should open showing the thing the app produces, with cost and performance as secondary ambient context.

### 3.3 Decisions

#### D-10: Redesign the Output hero — results first

The primary view when opening an app is the **Results view**, organized around the app's actual output.

Three states:

**State A: App has runs and output labels configured**
- Hero area: latest result rendered with rich output components (not a table of paths)
- Recent results timeline below: swipeable cards, each showing the full result snapshot
- Ambient health strip: small top bar showing success rate + cost + last run time

**State B: App has runs but no output labels**
- Hero: "Set up what to show here" prompt with a CTA to define outputs in Canvas
- Below: recent runs list as a fallback (shows status, duration, cost)

**State C: App has no runs**
- Hero: "Your app is ready to run" with a primary CTA (Run now or Set up a trigger)
- No cost data shown — nothing to show

#### D-11: Output components system — flexible, not fixed

Replace the current "output labels with path + format + artifact type" developer configuration with a **component-based output system**:

Each output component has a **type** that determines how it renders:
- `Metric` — a number with a label and optional trend arrow
- `Text` — a rendered markdown body (summaries, reports, analysis)
- `List` — a bulleted or numbered list of items
- `Decision` — a highlighted verdict with supporting reasoning
- `Table` — structured tabular data
- `Document` — full-length generated document (scrollable card)
- `Link` — a URL result with title and preview
- `File` — a downloadable artifact

Operators define output components in the Canvas (on the Output node), not in a settings form.
The output node inspector shows a drag-and-drop list of components with a "+ Add component" button.
Each component has a name (plain text) and a type (dropdown of the above).
The source path is auto-detected from the workflow output schema, not manually entered.

This is the opposite of the current form (which forces operators to know `_extracted.fieldname` paths).

#### D-12: Issue / Task system — app-scoped work queue

Add an **Issues** sub-surface to the Output layer.

This is a lightweight Kanban for the app:
- **Backlog** — issues queued for the next run
- **Running** — issues the app is currently working on
- **Review** — results needing operator approval
- **Done** — completed issues (last 30 days)

An issue is:
- A natural-language task description
- An optional priority (urgent / normal / low)
- An assignee (defaults to the app's entry workflow)
- A result (populated after the run completes)

Creating an issue triggers the entry workflow with the task as context.

This replaces the current "run now" button — instead of triggering a blind run, you issue a task.

The issues surface is available from a fourth tab in the Output layer:
```
[Output]  [Canvas]  [Brain]
  Results  |  Issues  |  Performance  |  Activity
```

Or — better — issues are embedded inside the Results view as a sidebar panel:
```
┌──────────────────────────┬────────────────┐
│  Latest results (hero)   │  Issues queue  │
│  Recent runs timeline    │  + New issue   │
└──────────────────────────┴────────────────┘
```

This matches the Paperclip pattern: the work queue is always visible alongside the output, not buried in a separate tab.

#### D-13: Costs are ambient, not hero

Move performance/cost data to a **Performance** tab that operators access intentionally, not as the default view.

The Performance tab keeps everything it has today (spend, trend, cost by agent, budget bar).
It just stops being the first thing you see.

Tab order changes to:
```
Results  |  Issues  |  Performance  |  Activity
```

The header shows a small ambient cost strip: `$0.00 this month · 3 runs · ↑ 0%`
That's enough for ambient cost awareness without making it the hero.

---

## Part IV — App Creation

### 4.1 Honest Diagnosis

The canvas-based app creation path is currently broken — not conceptually wrong, just not usable yet. Nodes are unclear, the inspector is built for developers, and every new app lands with a warning that can't be acted on. There is no viable self-serve "build it yourself" path today.

Designing a polished creation wizard on top of a broken builder is the wrong order of operations. The right answer is to connect the two things that already work — the orchestrator and the canvas — and not build a third thing in between.

### 4.2 The Two Paths

#### Path 1 — Talk to the orchestrator (ship now)

**Entry:** "New app" button → routes directly to a pre-configured chat thread with the orchestrator.

The thread opens with a system-injected prompt that sets the context: the operator is here to create an app. The orchestrator already has `agentis.build_workflow`, full workspace inventory (agents, workflows, skills), and knows how to assemble a canvas. The operator describes what they want in plain language. The orchestrator reads the workspace, finds matching pieces, builds the graph, names the app, and confirms with the operator in the thread before committing anything.

The operator never sees a form. They see a conversation. They confirm. They land on a working app.

**What this requires technically:**
- Route "New app" CTA to `ChatPage` with a `new-app` intent.
- Pre-fill the composer with `/newapp`, which expands server-side into the app-creation instruction.
- Add `agentis.app.create` so chat can create a deployed app, not only a workflow.
- Use `agentis.build_workflow` for standalone workflow creation; use `agentis.app.create` for confirmed app creation.
- No new wizard component.

**Implementation status:** shipped in the first end-to-end pass.

#### Path 2 — Build it yourself in Canvas (unblock after Part II + VII)

The canvas path is valid but currently too broken to be a creation entry point. Once the canvas work in Parts II and VII is complete — clear node labels, working inspector, inline guidance, unified interaction model — this path becomes:

- "New app" → blank canvas, no warnings
- Drag nodes from palette, connect them with plain-language labels
- Inspector shows entity preview cards, not raw ID fields
- Inline guidance replaces all warnings

No wizard, no steps, no form. Just a working canvas that explains itself.

This path ships after Part VII is complete. Until then it stays blocked — we do not route operators here.

### 4.3 What Gets Deleted

| What | Why |
|---|---|
| `GuidedAppCreateDialog` — the 2-step wizard | Removed; replaced by the chat path entirely |
| "App kind" picker (automation / research / etc.) | Meaningless to operators; the orchestrator infers this |
| "Cover image URL" field | Nobody has an image URL on hand during creation |
| "Goal" textarea that goes nowhere | Currently stored but not wired to the orchestrator — either wire it or delete it |
| `NewPackageDialog` repurposed for app creation | Wrong mental model; packaging is for archiving, not creating |

### 4.4 The Principle

> Don't create a new onboarding experience. Connect the orchestrator to the canvas. The orchestrator is the creation path. The canvas is the editing path. These two already exist.

---

## Part V — Bugs and Quick Fixes

### 5.1 App image not reflecting on apps list page

The apps list (`/apps`) fetches app records and renders the icon.
The icon update goes through the `PATCH /v1/apps/:appId` endpoint which updates `packageContents`.
The apps list likely reads from a stale field or renders the old icon from a different source.

**Fix:** ensure the apps list reads `iconUrl` and `iconColor` from the same `packageContents` field that the detail page updates. Invalidate or re-fetch after save. If the apps list uses a cached summary that doesn't include `iconUrl`, that summary needs to include it.

**Implementation status:** shipped. `/v1/apps` now returns `iconUrl` and `coverImage`, and app cards render `iconUrl` before falling back to initials/glyph.

### 5.2 App canvas performance

**Symptoms:** node grab lags, drag is not smooth, panning stutters vs workflow canvas.

**Likely root cause:** the app canvas component (`AppCanvasView`) is likely re-rendering the entire component tree on every pointer move because:
- State updates (node positions) trigger React re-renders in the component tree instead of going through direct DOM manipulation (transform: translate)
- The workflow canvas likely uses `useRef` + `requestAnimationFrame` or CSS transforms for drag instead of React state

**Fix approach:**
1. Profile with React DevTools — identify which component re-renders on every mouse move during drag
2. Ensure drag deltas go through a ref + CSS transform pipeline, not React state
3. Share the interaction primitive with WorkflowCanvasPage if it uses a more optimized approach

---

## Part VI — Prioritized Implementation Plan

### Phase 0 — Immediate bugs (1–2 days)
| # | Item | Impact |
|---|---|---|
| P0-1 | Fix app image not reflecting on apps list | Operators confused, breaks trust |
| P0-2 | Profile and fix app canvas drag lag | Makes the canvas unusable |

### Phase 1 — Configuration simplification (2–3 days)
| # | Item |
|---|---|
| P1-1 | Collapse Identity to Name + Image upload + Description + Space — shipped |
| P1-2 | Rename Credentials → Connections, simplify to service cards — shipped |
| P1-3 | Collapse Budget → Limits (cap input + pause/delete only) — shipped |
| P1-4 | Remove Workflows, Agents, Output labels, Datasets from config sidebar — shipped in UI; old code paths can be deleted in cleanup |

### Phase 2 — Output surface rebuild (1 week)
| # | Item |
|---|---|
| P2-1 | Redesign Results view: three states (has output / no labels / no runs) |
| P2-2 | Build output component system (Metric, Text, List, Decision, Document, File, Link) |
| P2-3 | Add Issues panel alongside results (Backlog / Running / Review / Done) |
| P2-4 | Move costs to Performance tab, ambient strip in header |
| P2-5 | Update tab order: Results → Issues → Performance → Activity |

### Phase 3 — App canvas overhaul (1 week)
| # | Item |
|---|---|
| P3-1 | Fix node label taxonomy (operator language, not arch types) |
| P3-2 | Replace Inspector raw ID forms with entity preview cards |
| P3-3 | Replace obscure warnings with inline guidance on nodes |
| P3-4 | Share interaction model with workflow canvas |

### Phase 4 — App creation (1–2 days for chat path; canvas path unlocks after Phase 3)
| # | Item |
|---|---|
| P4-1 | Delete `GuidedAppCreateDialog` (2-step wizard) — shipped |
| P4-2 | Route "New app" CTA → pre-seeded orchestrator chat thread — shipped |
| P4-3 | Add `/newapp` chat intent + `agentis.app.create` tool — shipped |
| P4-4 | Canvas path unblocked once Part VII canvas work ships (no new UI needed, just remove the "blocked" guard) |

---

## Reference: What Good Feels Like

The mental model to hold when evaluating any decision in this plan:

> An operator opens their "Social Listening" app.
> They see: the last digest the app produced. Three flagged mentions. One item awaiting their review.
> They issue a new task: "Find all mentions of our product launch from the last 48h."
> The app picks it up. They switch tabs. They come back. The result is there.
>
> They never saw a "BRAIN" node, a glyph fallback field, or a credential binding key.

That is the product.

---

---

## Part VII — Canvas Architecture Unification (Engineering Debt)

### 7.1 The Problem: Five Canvas Implementations, Zero Shared Primitive

The platform currently has five separate canvas surfaces, each implemented with a different engine. This is not a design decision — it is accumulated technical debt that causes the UX divergence, the lag differences, and the maintenance burden described in Parts II–III.

| Surface | File | Engine | Interaction model |
|---|---|---|---|
| Workflow canvas | `WorkflowCanvasPage.tsx` | React Flow via `CanvasEngine` | ✅ Shared wrapper |
| App canvas stage | `AppGraphStage.tsx` | React Flow via `CanvasEngine` | ✅ Shared wrapper |
| Chat canvas embed | `CanvasEmbed.tsx` | React Flow — **direct, bypasses wrapper** | ⚠️ Inconsistent |
| Brain / Memory map | `BrainStage.tsx` | **Custom SVG** + manual pan/zoom via mouse events | ❌ Completely bespoke |
| Home ecosystem map | `WorkspaceEcosystemCanvas.tsx` | **Custom div** + pointer capture + `setViewport` React state | ❌ Completely bespoke |

The workflow canvas and app canvas correctly use `CanvasEngine` — the shared React Flow wrapper in `components/canvas/CanvasEngine.tsx`. The other three do not.

`BrainStage` implements its own SVG-based renderer with manual pan (`setPan`), zoom (`setZoom`), and a `dragRef` for mouse drag — roughly 130+ lines of custom interaction code that duplicates what React Flow already handles.

`WorkspaceEcosystemCanvas` implements its own div-based canvas with `setViewport({ x, y, scale })` driven by `handleCanvasPointerDown`, `handleCanvasPointerMove`, `handleCanvasPointerUp`, and `handleCanvasWheel` — another custom interaction loop that sets React state on every pointer event, causing re-renders on every mouse move.

`CanvasEmbed` uses React Flow directly (`import { ReactFlow } from '@xyflow/react'`) without going through `CanvasEngine`, bypassing minimap standardization, background theming, and the drop handler contract.

### 7.2 Why This Matters Beyond Code Quality

Each bespoke canvas implementation diverges on:
- **Pan/zoom feel** — the SVG-based brain map pans differently than the React Flow workflow canvas
- **Interaction lag** — `WorkspaceEcosystemCanvas` calls `setViewport` on every `pointermove`, which triggers React re-renders of the entire canvas tree on every frame
- **Accessibility** — no shared keyboard navigation, no shared focus management, no shared reduced-motion support
- **Theming** — background dot grids, node colors, minimap appearance are each custom, not shared
- **Feature parity** — when a canvas interaction improvement is made to `CanvasEngine`, it does not propagate to `BrainStage` or `WorkspaceEcosystemCanvas`

The brain canvas deserves the same interaction quality as the workflow canvas. The home ecosystem canvas deserves the same performance model. Right now they are second-class surfaces maintained by different code paths.

### 7.3 The Rule Going Forward

> **Every canvas surface on the platform must render through `CanvasEngine`.**

`CanvasEngine` is the single canvas primitive. All surfaces use it. They differ only in:
- Which node types they register (`nodeTypes` prop)
- Whether nodes are draggable, connectable, or selectable
- The background style and minimap appearance (both `CanvasEngine` props)

Custom node renderers are fine — `AppGraphNode`, `BrainNodeCard`, `EcosystemNode` are all valid as separate components registered with `nodeTypes`. What is not acceptable is reimplementing pan, zoom, drag, pointer capture, or the render loop.

### 7.4 Migration Plan per Surface

#### `CanvasEmbed.tsx` — Simple fix (1–2 hours)
Replace the direct `import { ReactFlow }` with `CanvasEngine`. The component already uses React Flow state. It just needs to go through the wrapper to pick up shared defaults (background, controls, theming). Mark as read-only: `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable={false}`.

#### `BrainStage.tsx` — Medium migration (1–2 days)
Current approach: pure SVG with polar-positioned nodes, cubic Bézier edges, manual pan/zoom.
Migration path:
1. Keep the `BrainNode` and `BrainEdge` data model as-is — only the render layer changes
2. Convert each `BrainNode` to a React Flow `Node` with a custom node type (`brainNode`)
3. Build `BrainNodeCard` as a React Flow custom node component (it already exists as a component — just needs to be wrapped with `Handle` ports)
4. Convert `BrainEdge` items to React Flow edges with a custom edge type if the arc shape needs to be preserved
5. Mount via `CanvasEngine` with `nodesDraggable={false}` (brain map is read-only — operators don't rearrange nodes)
6. Delete the `handleMouseDown`, `handleMouseMove`, `handleMouseUp`, `handleWheel` handlers and the `pan`/`zoom` state — React Flow owns all of that

The polar layout positions (`n.x`, `n.y`) map directly to React Flow node positions. No layout algorithm changes needed.

#### `WorkspaceEcosystemCanvas.tsx` — Medium migration (1–2 days)
Current approach: custom div canvas, pointer capture, `setViewport` React state on every mouse move, custom zoom buttons.
Migration path:
1. Replace the outer `<div>` canvas with `CanvasEngine`
2. Build `EcosystemNode` as a React Flow custom node type (the existing node rendering logic moves into a component registered with `nodeTypes`)
3. The `buildCanvasModel()` output maps to React Flow `Node[]` and `Edge[]` directly — the data model is already compatible
4. Replace the zoom control `<button>` pair with `CanvasEngine`'s built-in `Controls` (already rendered by `CanvasEngine`)
5. Delete `handleCanvasPointerDown/Move/Up/Wheel`, the `dragRef`, `viewport` state, `zoomBy`, `resetViewport` — React Flow owns all of that
6. The tooltip/hover card for selected nodes stays as an overlay on top of `CanvasEngine` (React portal or absolute-positioned div)

### 7.5 Outcome

After migration, the platform has **one canvas primitive** (`CanvasEngine`) and **five sets of node types**:
- `WorkflowNode` / `AgentNode` — workflow canvas
- `AppGraphNode` — app canvas
- `BrainNodeCard` — brain/memory map
- `EcosystemNode` — home workspace canvas
- Inline node — chat embed (read-only)

Every canvas gets pan, zoom, minimap, keyboard navigation, drag, reduced-motion support, and theming for free. Any improvement to `CanvasEngine` propagates everywhere. This is what good platform architecture looks like.

---

## Related Documents

- [APP-CANVAS-ARCHITECTURE.md](APP-CANVAS-ARCHITECTURE.md) — structural model for the app graph
- [AGENTIS-APP-FORMAT.md](../AGENTIS-APP-FORMAT.md) — internal package model
- [PAPERCLIP.md](../PAPERCLIP.md) — reference for issue/task system
- [AGENTIS-UX-V2.md](../AGENTIS-UX-V2.md) — shell and navigation direction
- [THE-BRAIN-UX-ARCHITECTURE.md](../memory/THE-BRAIN-UX-ARCHITECTURE.md) — memory/brain surface
