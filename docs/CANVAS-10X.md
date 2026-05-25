# Workspace Canvas — 10x Architecture
## The Living Operations View for Agent Organizations

*May 2026. The workspace canvas is not a dashboard. It is a control surface —
the place where an operator reads the health of their entire agent organization
at a glance, finds problems before they cause impact, and intervenes without
navigating away. Every design and engineering decision in this document serves
that mission. Nothing else does.*

> **Reference point.** The Bloomberg Terminal is the most information-dense
> professional tool in existence, used by the most demanding operators in the
> world. It is trusted not despite its density but because of its discipline:
> every pixel means exactly one thing, consistently, always. That is the standard
> this canvas is built to meet.

---

## 0. The Honest Starting Point

### What Is Currently Broken

The existing canvas fails at its primary job. An operator opening it cannot answer
the three questions that matter:

```
Is my organization healthy right now?    → impossible to tell
Where does something need my attention?  → not surfaced
What has been produced today?            → not visible
```

The specific failures, in order of severity:

**1. Everything is rendered at equal visual weight simultaneously.**
Agent nodes, workflow nodes, knowledge base nodes, artifact nodes, domain circles,
edges, labels, status text — all present at rest, all competing for attention.
The operator's eye has no reading order. There is no hierarchy in the rendering,
only in the data.

**2. The visual grammar has no contract.**
Teal circles appear because a developer added them. "MANAGER · IDLE" text appears
under every node because it was available data. "page.png" floats mid-canvas because
artifacts needed to go somewhere. None of these were decisions — they were defaults.
A canvas with no visual grammar cannot be read.

**3. Workflow nodes are disconnected objects floating in empty space.**
They have no spatial relationship to the agents they belong to. The operator cannot
understand why those pill shapes exist in the upper left quadrant.

**4. Status does not equal state.**
`status: 'online'` means the adapter responded to a ping. It says nothing about
whether the agent is executing, idle, errored, or blocked. The most important
information — what is actually happening — is absent.

**5. The previous version was clearer not because it was better designed, but
because it had less to be wrong about.** Fewer elements forced clarity. The lesson:
clarity is achieved by removal, not addition.

### The Root Cause

Every iteration has added elements to communicate more, which communicated less.
This is the canonical enterprise product failure mode. The fix is not a better
arrangement of the same elements. It is a principled deletion down to structure,
followed by a disciplined rebuild using an inviolable grammar.

---

## 1. Design Philosophy: Minimum Legible Complexity

**The governing principle:** find the absolute minimum visual complexity that
communicates the maximum meaningful information, then stop.

This is not minimalism as aesthetic. It is minimalism as functional requirement.
An operator monitoring 50 agents on a secondary screen cannot process a canvas
with 8 simultaneous visual layers. They need one question answered: healthy or not?
The canvas at rest answers that question. Every other question is answered through
engagement.

### The Three Operator Modes

The canvas serves three modes. Most designs address only mode 3. This canvas
is built for mode 1 first.

```
MODE 1 — AMBIENT MONITORING  (90% of the time)
  Canvas is on a secondary screen or in peripheral vision.
  Question: "Is everything healthy?"
  Required: Zero interaction. Answer visible in under 3 seconds.
  Design target: A healthy workspace at rest is almost silent.

MODE 2 — ACTIVE TRIAGE  (occasional)
  Something needs attention. Operator turns to the canvas.
  Question: "What is wrong and how do I fix it?"
  Required: Attention items surface automatically. One click to resolve.
  Design target: Time from opening canvas to problem resolved < 60 seconds.

MODE 3 — DIRECT INTERVENTION  (intentional)
  Operator wants depth on a specific agent, workflow, or artifact.
  Question: "What exactly is this agent doing right now?"
  Required: Rich detail without leaving the canvas.
  Design target: Agent live state readable in the same view. No navigation.
```

---

## 2. The 3-Step Modernization Framework

### Step 1 — Subtract to Load-Bearing Structure

Before any new design decision, identify what is *load-bearing* — what must be
visible at rest to answer the mode 1 question. Remove everything else from the
resting state.

**Load-bearing (present at rest):**
```
Nodes       Agent circles, sized by hierarchy tier
Edges       Thin lines showing reporting relationships
Rings       Operational state — the only color on the canvas
Position    Hierarchy expressed spatially (center = authority)
```

**Not load-bearing (removed from resting state):**
```
Role labels under every node    → hover only
"MANAGER · IDLE" status text    → hover only
Workflow nodes as floating pills → removed entirely from workspace canvas
                                   (workflows live in the workflow canvas)
Domain background circles       → replaced by spatial distance only
Artifact nodes at rest          → appear only when produced (crystallize + drift)
Description text on nodes       → tooltip only
Agent description subtitles     → hover only
```

**The resting canvas has two types of objects: nodes and edges.**
Everything else is a layer that reveals through engagement.

### Step 2 — Establish the Inviolable Visual Grammar

These rules are non-negotiable. Write them on a wall. Treat violations as bugs.

```
PROPERTY    →  MEANING            RULE
──────────────────────────────────────────────────────────────────────
Size        →  hierarchy tier     orchestrator 32px · manager 22px · worker 14px
                                  Never use size for any other distinction.

Position    →  authority + depth  Center = highest authority.
                                  Distance from center = reporting depth.
                                  Never break this to achieve visual balance.

Ring color  →  operational state  white  = executing (active right now)
                                  gray   = idle (online, not running)
                                  amber  = attention needed (breathing animation)
                                  red    = error (no animation — static, permanent)
                                  none   = offline (node dims to 20% opacity)
                                  Never use these colors for any other purpose.

Opacity     →  relevance          Unfocused nodes dim to 30% when any node is focused.
                                  Full opacity = in focus or at rest (no focus).

Motion      →  live data only     Heartbeat ring = agent is executing.
                                  Particle flow = work passing between agents.
                                  Artifact drift = output just produced.
                                  NOTHING moves when the system is idle.
                                  No decorative loops. No ambient animations.

Typography  →  engagement reward  Text appears on hover and in panels.
                                  Never rendered on nodes at rest.
                                  Monospace = agent output. Sans = operator labels.
```

**The amber ring breathes. The red ring does not.**
Amber (attention needed) uses a 3-second opacity cycle: 30% → 80% → 30%.
Red (error) is static at 100%. Errors do not animate because animation implies
the system is working on the problem. A static red ring says: nothing changes
until you act.

### Step 3 — Layer Information Through Engagement

Three layers. Never render all three simultaneously.

**Layer 0 — Resting (mode 1: ambient monitoring)**
```
Visible:   Nodes + edges + state rings
Hidden:    All labels, all text, all panels
Purpose:   System health readable at a glance from across the room
```

**Layer 1 — Hover (identification)**
```
Visible:   Node name, role label, status, artifact count badge
           Parent + child edges highlight to 100% opacity
           All other edges dim to 8% opacity
           All non-connected nodes dim to 30% opacity
Hidden:    All panels
Purpose:   "Who is this and what is their current state?"
```

**Layer 2 — Click (depth)**
```
Visible:   Agent Live Panel slides in from right edge
           Canvas dims to 60% opacity behind panel
           Clicked node remains at full opacity, centered
           Panel contains: current task, tool stream, queue, artifacts, actions
Hidden:    Nothing — the panel contains everything
Purpose:   "What exactly is this agent doing and what can I do about it?"
```

---

## 3. The Rendering Architecture

### Why Not React Flow

React Flow is the right tool for the **workflow canvas** — a node editor where
operators configure execution graphs. It is the wrong tool for the workspace canvas.

React Flow assumptions that break the workspace canvas:
- Every node is a DOM element (limits to ~100 nodes before performance degrades)
- Layout is manual or force-directed (not hierarchy-aware radial)
- Rendering is React reconciliation (60fps particle flow requires a game loop)
- Node appearance is via className (not a programmatic canvas draw model)

The workspace canvas needs a **game-loop renderer**: something that draws at 60fps,
handles particle streams as draw calls, and scales to 500+ nodes without re-rendering
the React tree on every frame.

### The Stack

```
┌──────────────────────────────────────────────────────────────────┐
│  CANVAS LAYER (PixiJS or raw Canvas API)                         │
│  - Draws nodes, edges, rings, particle flow                       │
│  - requestAnimationFrame loop at 60fps                            │
│  - Reads from canvas state store (Zustand)                        │
│  - Mouse events translated to canvas coordinates                  │
│  - Zero React rendering in the hot path                           │
├──────────────────────────────────────────────────────────────────┤
│  LAYOUT ENGINE (D3-hierarchy, runs once + on change)             │
│  - d3.cluster() for radial position calculation                   │
│  - Input: agents[] with managerId + canvasAngle                   │
│  - Output: { id, x, y, r } for every node                        │
│  - Recalculates on agent add/remove (400ms animated transition)   │
├──────────────────────────────────────────────────────────────────┤
│  PANEL LAYER (React + Framer Motion — DOM, not canvas)           │
│  - Agent Live Panel                                               │
│  - Triage Panel                                                   │
│  - Artifact Preview Panel                                         │
│  - Integration Wiring Panel (from ORCHESTRATOR-CREATION-10X.md)  │
│  - 200ms ease-out slide transitions. No spring physics.           │
├──────────────────────────────────────────────────────────────────┤
│  STATE STORE (Zustand)                                            │
│  - Canvas state: nodePositions, hoveredId, focusedId, zoom        │
│  - Live data: agentStates{}, workflowEvents[], artifactEvents[]   │
│  - Attention items: attentionItems[]                              │
│  - SSE subscriptions write to this store                          │
│  - Canvas renderer reads from this store each frame               │
├──────────────────────────────────────────────────────────────────┤
│  LIVE DATA LAYER (SSE)                                            │
│  - Single multiplexed stream: GET /v1/workspaces/:id/canvas/stream│
│  - Writes to Zustand on each event                                │
│  - Reconnects automatically on disconnect                         │
└──────────────────────────────────────────────────────────────────┘
```

### The Two-Canvas Model

The workspace canvas and the workflow canvas are different objects. They must
remain separate renderers.

```
WORKSPACE CANVAS
  Tool:      PixiJS / Canvas API
  Purpose:   Observe the organization (agents, hierarchy, health, artifacts)
  Objects:   Agent nodes, hierarchy edges, state rings, artifact drift cards
  NOT:       Workflow node graphs, execution step detail

WORKFLOW CANVAS
  Tool:      React Flow (existing, kept as-is)
  Purpose:   Configure and observe a single workflow execution graph
  Objects:   Trigger nodes, agent_task nodes, integration nodes, edges, inspector
  NOT:       Other agents, the organization hierarchy
```

Access model: clicking a workflow trail on the workspace canvas opens the workflow
canvas in a **slide-over panel** — 80% width, workspace dims behind it. No
navigation. No page change. The operator retains spatial context.

---

## 4. The Layout Engine

### Hierarchy-Aware Radial Layout

Position is not negotiable — it carries meaning. The layout engine calculates
positions from the reporting hierarchy. It does not use force-directed simulation.

```typescript
// Pseudo-code for layout calculation

interface AgentLayoutNode {
  id: string
  role: 'orchestrator' | 'manager' | 'worker'
  managerId: string | null
  canvasAngle: number   // operator-set orbital angle (0–360°)
}

function calculateLayout(agents: AgentLayoutNode[], canvasCenter: Point) {
  const orchestrator = agents.find(a => a.role === 'orchestrator')
  const managers = agents.filter(a => a.role === 'manager')
  const workers = agents.filter(a => a.role === 'worker')

  const R_MANAGER = 200   // px from center to manager ring
  const R_WORKER  = 340   // px from center to worker ring

  const positions: Record<string, Point> = {}

  // Orchestrator: always canvas center
  positions[orchestrator.id] = canvasCenter

  // Managers: equally distributed on R_MANAGER ring,
  // ordered by canvasAngle (operator can reorder by dragging)
  managers
    .sort((a, b) => a.canvasAngle - b.canvasAngle)
    .forEach((mgr, i) => {
      const angle = mgr.canvasAngle ?? (i / managers.length) * 2 * Math.PI
      positions[mgr.id] = {
        x: canvasCenter.x + R_MANAGER * Math.cos(angle),
        y: canvasCenter.y + R_MANAGER * Math.sin(angle),
      }
    })

  // Workers: clustered ±spread around their manager's angle
  managers.forEach(mgr => {
    const mgrWorkers = workers.filter(w => w.managerId === mgr.id)
    const mgrAngle   = Math.atan2(
      positions[mgr.id].y - canvasCenter.y,
      positions[mgr.id].x - canvasCenter.x
    )
    const spread = Math.min(Math.PI / 4, mgrWorkers.length * 0.25)

    mgrWorkers.forEach((w, i) => {
      const wAngle = mgrAngle - spread/2 + (spread / Math.max(1, mgrWorkers.length - 1)) * i
      positions[w.id] = {
        x: canvasCenter.x + R_WORKER * Math.cos(wAngle),
        y: canvasCenter.y + R_WORKER * Math.sin(wAngle),
      }
    })
  })

  return positions
}
```

**Key properties of this layout:**
- Orchestrator is always center — spatial authority is unambiguous
- Managers cannot overlap (equal distribution enforced by ring radius)
- Workers cluster behind their manager — the visual group is readable
- No physics simulation — positions are deterministic and stable
- Adding a new manager triggers a smooth redistribution (400ms transition)

### Unassigned Agents

Workers with no `managerId` are placed in an "unassigned" ring at R_WORKER,
distributed in the gap between the last and first manager. They carry an amber
indicator: unassigned workers need to be organized.

---

## 5. The Zoom Architecture

Zoom is continuous. Information density changes at specific thresholds, not at
discrete steps. The renderer adds and removes layers as zoom crosses each threshold.

```
ZOOM SCALE    THRESHOLD    WHAT APPEARS / DISAPPEARS
──────────────────────────────────────────────────────────────────────
< 0.4         Level 0      - Worker nodes hidden (replaced by count badge on manager)
                            - Manager nodes: no labels
                            - Only state rings + particle flow visible
                            - Artifact nodes: hidden
                            - Domain territory: faint tint only (if enabled)

0.4 – 0.8     Level 1      - All agent nodes visible
                            - Hover labels enabled
                            - Artifact count badges on nodes
                            - Workflow trail objects (thin arcs, label on hover)
                            - Domain territory tints

0.8 – 1.5     Level 2      - Node name labels always visible (not hover-only)
                            - Artifact cards appear (compact: icon + name)
                            - Workflow trail labels always visible
                            - Worker nodes slightly larger for readability

> 1.5          Level 3      - Full label hierarchy (name + role + status)
                            - Artifact cards expanded (icon + name + timestamp)
                            - Edge weight visible (line thickness = throughput)
                            - Keyboard shortcut hints shown on hover
```

### Zoom Performance Contract

The canvas must maintain 60fps at all zoom levels with up to 500 agent nodes.
This requires the PixiJS path — raw Canvas API becomes expensive with particle
rendering above ~200 nodes. The PixiJS `Container` hierarchy maps directly to
the organizational hierarchy: one Container per manager domain, children are
worker nodes. Container transform handles domain-level zoom efficiently.

---

## 6. Node Visual Specification

### Agent Node Anatomy

```
                 ┌── state ring (2px stroke, color = operational state)
                 │
                 ▼
            ╔═══════╗
            ║       ║  ← node body (filled circle, node bg #141414)
            ║  icon ║  ← role icon (16px, text-muted, only at zoom > 0.6)
            ║       ║
            ╚═══════╝
                 │
                 └── artifact count badge (appears at zoom > 0.4, hover)
                     bottom-right corner, 10px circle, white text on #262626


Size by role:
  orchestrator   32px diameter
  manager        22px diameter
  worker         14px diameter
  specialist     14px diameter (same as worker)
```

### State Ring Specification

```
State         Ring color    Animation         Opacity
──────────────────────────────────────────────────────
executing     #FFFFFF       4s heartbeat      55% → 100% → 55%
idle          #4B5563       none              100% static
attention     #F59E0B       3s breathe        30% → 80% → 30%
error         #EF4444       none              100% static, permanent
offline       none          none              node dims to 20%
```

The ring is drawn 3px outside the node boundary — it does not share a border with
the node fill. This separation makes state visible at small sizes.

### Edge Specification

```
Type             Weight    Opacity     Color
──────────────────────────────────────────────────────
hierarchy edge   1px       15%         #FFFFFF  (resting)
hierarchy edge   1.5px     60%         #FFFFFF  (on hover of connected node)
active flow      1px       40%         #FFFFFF  (particle flow active)
workflow trail   1px       20%         #FFFFFF  (dashed, faint)
```

Edges are never thick. Thickness implies emphasis. In this canvas, relationships
are structural facts, not points of emphasis. The state rings carry the emphasis.

---

## 7. The Attention System

### Attention as a Layer

The attention system is rendered as a persistent layer above all other canvas
objects. It is never hidden, never dimmed, never obscured by zoom level.

**Attention item types and their visual treatment:**

```
EXECUTION_FAILED     →  static red ring on the failed workflow's owner agent
APPROVAL_REQUIRED    →  amber breathing ring on the blocked agent
CREDENTIAL_MISSING   →  amber breathing ring on the workflow trail object
AGENT_OFFLINE        →  node dims to 20%, no ring (absence is the signal)
BUDGET_EXCEEDED      →  amber ring on orchestrator (escalated to top)
CAPABILITY_MISMATCH  →  amber ring on the misconfigured agent_task's owner
```

### The Compass Model

When an attention item's associated entity is outside the current viewport (operator
has zoomed in elsewhere), an amber compass indicator appears on the nearest canvas
edge, pointing toward the off-screen entity. The compass is a 6px circle with a
directional tick. The operator follows the compass to find the issue.

This eliminates the scenario where an error is happening in a domain the operator
isn't currently viewing and they don't know until they pan away.

### The Triage Panel

Keyboard shortcut `T` or the status bar "N attention" button. Slides in from the
right edge. Lists all active attention items, prioritized:

```
┌─────────────────────────────────────────────────────────────────┐
│  ATTENTION                                           5 items    │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ● FAILED    Morning Digest · node 4                    [Fix]   │
│    "gmail credential expired"                                   │
│                                                                 │
│  ● APPROVAL  Social Content · pending publish approval  [View]  │
│    "Approve before posting to Buffer"                           │
│                                                                 │
│  ○ OFFLINE   Analyst · runtime not connected           [Connect] │
│                                                                 │
│  ○ WIRING    Workflow 1 · Gmail integration unwired     [Wire]  │
│  ○ WIRING    Workflow 3 · Slack integration unwired     [Wire]  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

● = requires immediate action (errors, blocking approvals)
○ = informational / non-blocking (offline agents, unwired integrations)

Every item has a single action button. [Fix] opens the relevant credential panel.
[Wire] opens the Integration Wiring Panel inline. [View] opens the approval.
[Connect] opens the adapter configuration. Zero navigation required.

---

## 8. The Agent Live Panel

Opened by clicking any agent node. The canvas dims behind it. The panel slides in
from the right edge (200ms ease-out). The canvas does not navigate — it dims.

```
┌────────────────────────────────────────────────────────────┐
│  codexy                                         manager    │
│  ─────────────────────────────────────────────────────── │
│                                                            │
│  ● EXECUTING                                               │
│  Morning AI Digest  ·  step 3 of 7  ·  01:24 elapsed       │
│                                                            │
│  TOOL CALL                                                 │
│  knowledge_search  "AI funding rounds May 2026"            │
│  → 11 chunks  ✓  142ms                                     │
│                                                            │
│  OUTPUT ────────────────────────────────────────────────── │
│  The most significant infrastructure raise this week       │
│  was Scale AI's $1.4B Series F, led by...  ▌               │
│                                                            │
│  ─────────────────────────────────────────────────────── │
│  QUEUE (2)                       ARTIFACTS TODAY (4)       │
│  · Competitor brief request      Competitor brief    9:04  │
│  · Weekly Slack digest           Analysis report     8:47  │
│                                  Social content      8:31  │
│                                  Weekly digest       8:12  │
│                                                            │
│  [→ Give instruction]  [⊞ View workflow]  [⏸ Pause]        │
└────────────────────────────────────────────────────────────┘
```

**State-conditional rendering:**

| Agent state | Panel shows |
|---|---|
| executing | Current task + tool call stream + output stream + queue + artifacts |
| idle | Last activity + time since + queue (next up) + artifacts |
| error | Error message + stack fragment + suggested fix + [Fix] CTA |
| offline | Adapter status + last seen + [Connect runtime] CTA |
| attention | Attention reason + [Resolve] CTA + affected workflow |

The panel **never shows "no data available."** An idle agent shows what it last
did. A new agent shows a prompt: "Give this agent its first instruction."

### The "Give Instruction" CTA

Opens an inline input field within the panel. Sends a chat message to that agent's
session directly. This is the operator walking up to an agent's desk — no context
switch, no navigation to the chat page.

---

## 9. Artifacts as Canvas Objects

### The Crystallization Behavior

When an artifact is produced (`artifact.created` event arrives via SSE):

1. A small dot appears at the producing agent's node position
2. Over 800ms: dot fades in and expands to a compact card
3. Over 3s: card drifts 60px outward from the agent (ease-out deceleration)
4. Card rests in its final position (orbiting near the agent)
5. After 24h: card fades out over 10 minutes unless pinned

The drift direction is radially outward from the agent — like output leaving
the agent and entering the workspace. The card does not move after it rests.

### Artifact Card

```
Compact (zoom < 1.5):
  ┌────────┐
  │  📄  ▫  │  ← icon + type indicator
  └────────┘
  Content Brief   ← name (appears on hover)

Expanded (zoom ≥ 1.5):
  ┌──────────────────────────────────┐
  │  📄  Content Brief               │
  │      codexy · 9:04am             │
  │      "Competitor analysis for... │
  │                      [Preview]   │
  └──────────────────────────────────┘
```

Clicking an artifact card opens a preview panel (right edge slide-over, same
pattern as Agent Live Panel). The artifact renders inline — markdown, image, or
code depending on type. A [Pin] button prevents the 24h fade.

---

## 10. The Live State Stream — Infrastructure Requirements

The canvas vision is architecturally constrained by what the API currently exposes.
These are the gaps. Without them, the canvas renders `status: 'online'` in a
prettier layout — which is not the goal.

### Current API State

```
Available now:
  GET /v1/agents              → list with status, role, managerId (partial)
  GET /v1/workflows           → list with runs
  GET /v1/artifacts           → list
  SSE /v1/chat/:id/stream     → chat token stream (per-session)

Missing (required for living canvas):
  SSE /v1/workspaces/:id/canvas/stream   → multiplexed canvas event stream
```

### The Canvas Stream

A single multiplexed SSE endpoint that the workspace canvas subscribes to on mount.

```typescript
// GET /v1/workspaces/:id/canvas/stream

type CanvasEvent =
  // Agent execution state
  | { type: 'AGENT_TASK_START';   agentId: string; taskId: string; workflowId: string; nodeLabel: string }
  | { type: 'AGENT_TOOL_CALL';    agentId: string; tool: string; input: string }
  | { type: 'AGENT_TOOL_RESULT';  agentId: string; tool: string; status: 'ok'|'error'; ms: number }
  | { type: 'AGENT_OUTPUT_TOKEN'; agentId: string; token: string }
  | { type: 'AGENT_TASK_DONE';    agentId: string; taskId: string; artifactId?: string }
  | { type: 'AGENT_TASK_ERROR';   agentId: string; taskId: string; error: string }
  | { type: 'AGENT_IDLE';         agentId: string }

  // Workflow execution progress
  | { type: 'WORKFLOW_RUN_START';    workflowId: string; runId: string }
  | { type: 'WORKFLOW_NODE_ENTER';   workflowId: string; runId: string; nodeId: string; nodeLabel: string }
  | { type: 'WORKFLOW_NODE_EXIT';    workflowId: string; runId: string; nodeId: string; status: 'ok'|'error' }
  | { type: 'WORKFLOW_RUN_COMPLETE'; workflowId: string; runId: string }
  | { type: 'WORKFLOW_RUN_FAILED';   workflowId: string; runId: string; error: string }

  // Artifacts
  | { type: 'ARTIFACT_CREATED'; artifactId: string; agentId: string; name: string; mimeType: string }
  | { type: 'ARTIFACT_DELETED'; artifactId: string }

  // Attention
  | { type: 'ATTENTION_ADD';     itemId: string; kind: AttentionKind; entityId: string; message: string }
  | { type: 'ATTENTION_RESOLVE'; itemId: string }
```

### What the API Must Instrument

```
EXECUTION HOOKS (new):
  - Agent task dispatch → emit AGENT_TASK_START
  - LLM token stream → emit AGENT_OUTPUT_TOKEN (already exists in chat, extend)
  - Tool call entry/exit → emit AGENT_TOOL_CALL / AGENT_TOOL_RESULT
  - Task completion/failure → emit AGENT_TASK_DONE / AGENT_TASK_ERROR
  - Agent returns to idle → emit AGENT_IDLE

WORKFLOW ENGINE (extend existing):
  - WorkflowExecutor node transitions → emit WORKFLOW_NODE_ENTER / EXIT

ARTIFACT SERVICE (minor):
  - Artifact save → emit ARTIFACT_CREATED (likely one line)

ATTENTION DETECTOR (new service):
  - AttentionDetectorService: subscribes to error/approval/offline events,
    emits ATTENTION_ADD events to the canvas stream
  - ATTENTION_RESOLVE when the blocking condition is cleared
```

### DB Changes Required

```sql
-- agents table
ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agents(id);
ALTER TABLE agents ADD COLUMN canvas_angle REAL DEFAULT NULL;
ALTER TABLE agents ADD COLUMN domain_color TEXT DEFAULT NULL;  -- hex, operator-set

-- artifacts table
ALTER TABLE artifacts ADD COLUMN canvas_x REAL DEFAULT NULL;
ALTER TABLE artifacts ADD COLUMN canvas_y REAL DEFAULT NULL;
ALTER TABLE artifacts ADD COLUMN pinned_at INTEGER DEFAULT NULL;
```

---

## 11. Implementation Roadmap

### Phase 1 — The Foundation (2–3 weeks)

*Goal: canvas renders a correct, stable hierarchy with real operational state rings.
No live data yet, but the visual grammar is correct and the layout is right.*

| Item | What it delivers |
|------|-----------------|
| `agents.managerId` hierarchy fully populated | Layout engine has correct input |
| `agents.domainColor`, `agents.canvasAngle` DB columns | Domain + orbital position |
| Radial layout engine (`calculateLayout()`) | Deterministic, hierarchy-driven positions |
| PixiJS canvas renderer replacing React Flow at workspace level | Performance + correctness |
| Correct node sizing (32/22/14px by role) | Visual hierarchy communicates tier |
| State ring rendering (white/gray/amber/red/none) | Operational state from current `status` |
| Layer 0 resting state (nodes + edges + rings, nothing else) | Ambient monitoring baseline |
| Layer 1 hover (name + role label + connected edge highlight) | Identification on demand |
| `canvasAngle` drag to reorder managers | Operator layout control |

**Phase 1 exit condition:** The canvas shows the correct hierarchy, each node's
tier is readable from its size, state rings communicate current `status`, and
hovering shows a name + role. Nothing more. This is cleaner than today.

---

### Phase 2 — The Live Canvas (3–4 weeks)

*Goal: the canvas moves. Idle agents are still. Active agents pulse. Work flowing
is visible as particles. Artifacts appear when produced.*

| Item | What it delivers |
|------|-----------------|
| `GET /v1/workspaces/:id/canvas/stream` SSE endpoint | Live data stream |
| Agent execution instrumentation → AGENT_TASK_START/DONE/IDLE events | Heartbeat activation data |
| Heartbeat ring animation (driven by TASK_START/DONE events) | Executing agents pulse |
| Workflow run instrumentation → WORKFLOW_NODE_ENTER/EXIT events | Particle flow data |
| Particle flow on edges (driven by WORKFLOW_NODE_ENTER events) | Work visible in motion |
| ARTIFACT_CREATED event + crystallization animation | Outputs appear live |
| Artifact card rendering (compact at zoom < 1.5) | Artifacts as canvas objects |
| Canvas Zustand store (nodeStates, liveData, attention) | Reactive state bridge |
| SSE → Zustand write, PixiJS reads Zustand each frame | Clean data → render pipeline |

**Phase 2 exit condition:** An operator can watch their workspace and see which
agents are executing (heartbeats), where work is flowing (particles), and what is
being produced (artifacts appearing). The canvas is alive.

---

### Phase 3 — The Agent Live Panel (2 weeks)

*Goal: clicking an agent opens a live window into its current state.*

| Item | What it delivers |
|------|-----------------|
| Agent Live Panel React component | Click earns value |
| AGENT_OUTPUT_TOKEN → streaming output in panel | Agent thought stream visible |
| AGENT_TOOL_CALL → current tool call display | Execution transparency |
| Agent queue API (`GET /v1/agents/:id/queue`) | "What's next" visible |
| Artifacts timeline in panel | Daily production history |
| "Give instruction" inline input → POST to agent chat | Direct intervention |
| Workflow slide-over panel (workflow canvas in panel) | No navigation away |
| Canvas dims to 60% when panel open | Focus maintained |

**Phase 3 exit condition:** Operator can click any agent, read what it's doing right
now, see the tool calls and output streaming, review artifacts, and send a direct
instruction — without leaving the workspace canvas.

---

### Phase 4 — The Attention System (1.5 weeks)

*Goal: nothing requiring operator attention goes unnoticed.*

| Item | What it delivers |
|------|-----------------|
| `AttentionDetectorService` (error/approval/offline/wiring detection) | Attention event source |
| ATTENTION_ADD/RESOLVE events in canvas stream | Attention layer data |
| Amber breathing ring on attention items | Always-visible signals |
| Compass indicator for off-screen attention items | Nothing hidden by viewport |
| Triage Panel component with one-click resolution | Fast-path resolution |
| Status bar live counts (running/idle/attention/failed/today) | Persistent summary |

**Phase 4 exit condition:** All attention items visible on canvas within 2 seconds
of occurring. All resolvable from canvas without navigation.

---

### Phase 5 — Zoom Levels + Domain View (2 weeks)

*Goal: semantic zoom delivers progressive disclosure correctly.*

| Item | What it delivers |
|------|-----------------|
| Level 0 rendering (worker count badges, no labels) | Readable from across room |
| Level 2 rendering (persistent labels, expanded artifact cards) | Deep domain view |
| Domain territory tints (faint, non-overlapping) | Spatial domain identity |
| Zoom threshold transitions (info layer add/remove at thresholds) | Progressive disclosure |
| Worker group badges on managers at zoom < 0.4 | Scale to hundreds of workers |
| Artifact count badge on agent nodes at zoom > 0.4 | Productivity at a glance |

---

## 12. What This Is Not

These decisions are final. They are not "to be revisited later."

**No workflow nodes in the workspace canvas.**
Workflows are not objects in the workspace canvas. They are trails (thin arcs)
between agents. The full workflow graph is in the workflow canvas, accessible via
slide-over. Adding workflow nodes to the workspace canvas is what created the
unreadable floating pills that prompted this replan.

**No 3D depth or perspective effects.**
3D communicates nothing about agent state or hierarchy. It communicates "this is
a demo." No perspective transforms. No z-index-as-depth. Flat, authoritative.

**No decorative ambient animations.**
If every agent has a gentle idle glow, the glow means nothing. Motion is reserved
for live execution data. A workspace where all agents are idle is visually silent.
That silence is intentional — it means everything is healthy and nothing is running.

**No animated errors.**
Red rings are static. An animated error implies the system is responding to the
problem. The system is not. The operator must respond.

**No celebratory animations on completion.**
A workflow completing is the default expected outcome. It should receive a 200ms
opacity transition on a checkmark, not a celebration. Celebrations are for
exceptional success. Completion is normal operation.

**No force-directed layout.**
Force-directed graphs cluster nodes toward center and produce non-deterministic
layouts that shift on every render. The hierarchy is the layout. Position is
meaning. A node's position must be stable and predictable.

---

## 13. The Northstar Experience

**Workspace: a content operation. 8 agents. 3 active workflows. 9:07am.**

The operator opens the workspace canvas. What they see:

The orchestrator sits at canvas center — the largest node, still, white ring
absent (not currently executing). Two manager nodes orbit it: codexy (left,
domain tint barely visible) and Social Analyst (right). Three worker nodes
cluster behind each manager at the outer ring. All idle except one — a worker
behind Social Analyst has a slow, steady white heartbeat ring. It is executing.

A thin particle stream flows from that worker toward Social Analyst's node.
Work is passing up the chain. The particles are small, 35% opacity, barely
there — visible because they move, not because they're prominent.

In the upper-right area near Social Analyst, a small card crystallizes. A
document icon appears, expands slightly, then drifts 60px outward. A content
brief was just produced. The artifact count badge on Social Analyst updates: `2`.

On the left edge of the canvas, an amber compass indicator. Something needs
attention in codexy's domain, which is off-screen to the left.

*Elapsed: 4 seconds. Zero clicks. The operator knows: one agent is active,
one artifact was just produced, and something needs attention in codexy's domain.*

The operator follows the compass — pans left. codexy's domain comes into view.
codexy has an amber breathing ring. The status bar shows `1 attention`.

They press T. The Triage Panel opens:

```
● FAILED    Morning Digest · "gmail credential expired"    [Fix]
```

They click [Fix]. The Gmail credential panel opens inline. They reconnect.
Amber ring fades. The compass disappears. Status bar: `0 attention`.

They click codexy's node. The Agent Live Panel opens. codexy is idle — last task
completed 4 minutes ago. Queue shows one pending task: "Weekly competitor brief."
Four artifacts from this morning are listed.

The operator types in the "Give instruction" field: "Prioritize the Slack digest
over the competitor brief today." Sends. codexy's queue reorders. The operator
closes the panel.

*Total time: 90 seconds. Canvas never left. Every action taken without navigation.*

---

## Implementation Log

> Append-only. Entries added as phases ship.

*(Architecture defined May 2026. Replaces previous orbital canvas attempt.)*
