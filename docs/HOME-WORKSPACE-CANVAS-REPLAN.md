# Home Workspace Canvas -- 10x Replan
## The Viral Screenshot: Your AI Organization, Alive and Hierarchical

> **Status**: Planning -- not yet implemented
> **Date**: May 14, 2026
> **Scope**: `HomePage.tsx`, `WorkspaceEcosystemCanvas.tsx`, new `CanvasMonitorWindow.tsx`, new `/canvas-monitor` route
> **Predecessor**: `WorkspaceEcosystemCanvas` exists as a 420px below-the-fold widget. This replan makes it the primary surface.
> **Thesis**: When someone takes a screenshot of Agentis, *this* is the screen. A top-down living org-chart of their AI organization -- orchestrator at the crown, managers branching below, workers fanning out beneath them, every app/workflow/knowledge base hanging from the agent that owns it, all connected by animated command-and-data edges that pulse with real work. The cockpit of something powerful. The kind of thing you put on your second monitor.

---

## 0. The Problem with the Current Canvas

The `WorkspaceEcosystemCanvas` is already architecturally correct -- custom pan/zoom, SVG animated edges, node model. But it fails on every experiential dimension:

| Issue | Current state | Target state |
|-------|--------------|--------------|
| Viewport | 420px fixed-height card, **below the fold** | **Primary surface**: fills the entire viewport from page load |
| Layout philosophy | Left-to-right columns by type | **Top-down authority tree**: Orchestrator -> Managers -> Workers -> Resources |
| Node limit | 2 apps, 3 workflows, 2 agents (hard-sliced) | All entities; tree layout handles any count |
| Node identity | Uniform tiny buttons | Variable by tier: orchestrator largest, resources smallest |
| Edge meaning | One edge type: data-flow | **Two types**: thick *command edges* (agent->agent) + thin *resource edges* (agent->resource) |
| Animation | Circles on active edges only | Command pulses, heartbeat glow, run flash, particle density scaling |
| Hover state | Simple tooltip | Rich activity popover with live tool-call feed |
| Canvas feel | Static on pan, abrupt stop | Inertial momentum, parallax depth layers, radial light |
| Composer | Separate section above the fold | Overlaid glass-morphism bar, contextual greeting |
| First impression | Nodes appear all at once | Cascade entrance: hierarchy assembles tier by tier |
| Full-screen | Not supported | YouTube-style with HUD overlay |
| Second-monitor | Not supported | Detachable `CanvasMonitorWindow` |
| Empty state | "Nothing mapped yet" text | Animated ghost hierarchy -- the product demo before setup |

---

## 1. Layout: The Authority Tree

### 1.1 The visual metaphor

The canvas shows **who commands whom and what they use**. This is a command hierarchy -- a living org chart of your AI organization, not a data-pipeline diagram (that belongs in the workflow editor).

```
                              +---------------------+
                              |   ORCHESTRATOR      |  <- violet crown glow
                              |      "The Brain"    |     large: 200x72px
                              |      active         |
                              +---------------------+
                             /                       \
              +--------------+               +--------------+
              |  MANAGER     |               |  MANAGER     |  <- cyan
              |  Marketing   |               |  Sales       |     160x60px
              +--------------+               +--------------+
             /      \                       /        \
      +------+    +------+           +------+    +------+
      |Worker|    |Worker|           |Worker|    |Worker|  <- blue, 130x52px
      +------+    +------+           +------+    +------+
       /|\
  [App][Wf][Kb]                                            <- leaf nodes, 80x36px
```

**Command edges** (thick, colored): Orchestrator -> Manager, Manager -> Worker. Authority lines with traveling pulse animations.

**Resource edges** (thin, green when active): Agent -> App/Workflow/Knowledge. Show what each agent uses.

### 1.2 The new `/home` structure

```
+------------------------------------------------------------------------------+
|  [Top bar -- 48px, existing shell]                                           |
+------------------------------------------------------------------------------+
|  W O R K S P A C E   C A N V A S   (flex-1)                                |
|                                                                              |
|  +-- floating composer, top-center ------------------------------------+     |
|  |  Good morning, Omar. 2 agents working.  [-> Orchestrator]           |     |
|  +----------------------------------------------------------------------+    |
|                                                                              |
|            [ORCHESTRATOR]   <- violet crown, top center                     |
|           /               \                                                  |
|    [Manager A]         [Manager B]                                           |
|    /     \               /    \                                              |
| [Wkr 1] [Wkr 2]    [Wkr 3] [Wkr 4]                                         |
|  /|\                   /|\                                                   |
| [App][Wf][Kb]         [App][Wf]   <- resource leaves                        |
|                                                                              |
|  +-- bottom HUD bar -----------------------------------------------+        |
|  |  2 active  4 idle  1 attention  3 workflows  [Chat] [Mon] [FS]   |        |
|  +-------------------------------------------------------------------+       |
+------------------------------------------------------------------------------+
```

### 1.3 Component hierarchy

```
HomePage (flex col, h-full)
+-- WorkspaceEcosystemCanvas (flex-1, min-h-0, relative)
    +-- CanvasBackground (dual-layer parallax dot grid)
    +-- CanvasRadialLight (orchestrator-centered radial gradient)
    +-- CanvasSvgEdgeLayer (SVG overlay, pointer-events-none)
    |   +-- CommandEdges (thick violet/cyan, hierarchy lines)
    |   +-- ResourceEdges (thin, green active, data-flow)
    +-- CanvasNodeLayer (absolutely-positioned divs)
    |   +-- OrchestratorNode
    |   +-- ManagerNode[]
    |   +-- WorkerNode[]
    |   +-- ResourceNode[] (app / workflow / knowledge / artifact / approval)
    +-- CanvasComposerOverlay (floating, top-center)
    +-- CanvasHudBar (bottom, fleet status + controls)
    +-- CanvasNodeDetailPanel (slide-over, canvas-local, on node click)
    +-- CanvasControls (bottom-right, zoom + reset)
```

The `FleetMetricBar` is removed from `HomePage` -- data moves into `CanvasHudBar`. The home page becomes: **top bar (shell) + canvas (everything else)**.

### 1.4 Canvas height

Current: `h-[420px]` fixed.
New: canvas takes `className="flex-1 min-h-0"` from `HomePage`. Internally:

```tsx
<div className="relative h-full w-full touch-none overflow-hidden bg-canvas">
  {/* canvas content */}
</div>
```

The canvas fills the entire viewport below the top bar.

### 1.5 Pan/zoom quality specification

The canvas must feel like a native application. Sticky or choppy interaction ruins the immersive experience regardless of how alive the nodes look.

**Event model**: `onPointerDown/Move/Up` + `touch-action: none` handles mouse, stylus, and touch uniformly. Cursor is `grab` at rest, `grabbing` while panning.

**Inertial momentum**: on `pointerup`, capture velocity from the last 3 delta samples. Decay at `FRICTION = 0.88` per animation frame until `|velocity| < 0.3`. The canvas glides to a natural stop.

```typescript
function applyMomentum() {
  if (Math.abs(vel.x) + Math.abs(vel.y) < 0.3) return;
  setPan(p => ({ x: p.x + vel.x, y: p.y + vel.y }));
  vel.x *= 0.88; vel.y *= 0.88;
  requestAnimationFrame(applyMomentum);
}
// On pointerup: capture velocity from last 3 pointer delta samples, then call applyMomentum()
```

**Wheel / trackpad**:
- `ctrlKey` or `metaKey` = zoom. Always zooms toward the cursor, not the canvas center: `newPan.x = cursor.x - (cursor.x - pan.x) * (newZoom / zoom)`.
- Plain wheel = pan. Apply `0.8` multiplier on `deltaY` for smooth trackpad feel.

```typescript
function handleWheel(e: WheelEvent) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const delta   = -e.deltaY * 0.003;
    const newZoom = Math.max(0.3, Math.min(3.0, zoom * (1 + delta)));
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setPan({ x: cx - (cx - pan.x) * (newZoom / zoom), y: cy - (cy - pan.y) * (newZoom / zoom) });
    setZoom(newZoom);
  } else {
    setPan(p => ({ x: p.x - e.deltaX * 0.8, y: p.y - e.deltaY * 0.8 }));
  }
}
```

**Zoom bounds**: `0.3 <= zoom <= 3.0`. At `0.3` the full hierarchy fits any screen >= 1024px wide. At `3.0` a single worker node fills the viewport.

**Double-click on canvas background**: animate zoom to `1.0` and center on the orchestrator node over 400ms via `requestAnimationFrame` lerp. Keyboard `Home` key does the same reset.

**Touch**: single-finger pan = pointer. Two-finger pinch uses `TouchList` distance delta to compute zoom toward the pinch midpoint.

### 1.6 Background parallax depth

Two SVG dot-grid layers at different parallax speeds create perceived z-depth with zero WebGL. When panning, the subtle speed difference registers subliminally -- users feel depth without consciously noticing it.

```tsx
// CanvasBackground.tsx
function CanvasBackground({ pan, zoom }: { pan: Vec2; zoom: number }) {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 0 }}>
      <defs>
        {/* Far plane: large sparse dots, 65% parallax speed -- appears more distant */}
        <pattern id="bg-far" width="56" height="56" patternUnits="userSpaceOnUse"
          patternTransform={`translate(${pan.x * 0.65} ${pan.y * 0.65}) scale(${zoom * 0.75})`}>
          <circle cx="28" cy="28" r="1.5" fill="rgba(255,255,255,0.065)" />
        </pattern>
        {/* Near plane: small dense dots, tracks exactly with nodes */}
        <pattern id="bg-near" width="24" height="24" patternUnits="userSpaceOnUse"
          patternTransform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <circle cx="12" cy="12" r="0.8" fill="rgba(255,255,255,0.20)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg-far)" />
      <rect width="100%" height="100%" fill="url(#bg-near)" />
    </svg>
  );
}
```

Combined with the radial orchestrator light (ss4.8), the canvas has four perceived depth layers: *deep space background -> distant dot plane -> near dot plane -> node hierarchy with glowing orchestrator core*. Four genuine depth planes. Zero 3D/WebGL.

---

## 2. Floating Composer Overlay

### 2.1 Visual design

```
+-----------------------------------------------------------------------------+
|  Good morning, Omar. 2 agents working.                                      |
|  +-----------------------------------------------------------------------+  |
|  | [Orch] Orchestrator v  |  Ask the orchestrator...                [->] |  |
|  +-----------------------------------------------------------------------+  |
|  [Review lead request]  [Status on Content Pipeline]                        |
+-----------------------------------------------------------------------------+
```

CSS: `position: absolute; top: 20px; left: 50%; transform: translateX(-50%); width: min(680px, calc(100% - 48px)); z-index: 40`

Container: `backdrop-blur-md bg-surface/80 border border-line/60 rounded-2xl shadow-2xl`

### 2.2 Send behavior -- inline reply first, panel second

Sending follows a two-step flow:

1. **Inline acknowledgment**: orchestrator's first response appears as a compact bubble directly below the composer -- max 2 lines, `bg-surface/90 border border-line/60 rounded-xl px-3 py-2 text-[13px]`. E.g. *"Running the social digest now"*. Canvas stays fully visible.

2. **Auto-open ChatPanel**: the existing right-side `ChatPanel` slides open with the full conversation. Canvas stays visible behind it. No navigation occurs.

The inline bubble fades out once the ChatPanel is open (300ms delay, then fade).

### 2.3 Collapse behavior

When panning (pointer down), composer fades to `opacity: 0.3`. Fades back to `opacity: 1` on pointer-up or focus.

### 2.4 Chat and full-screen

The ChatPanel is a user-controlled toggle in full-screen -- never forced closed. A `Chat` toggle in the HUD bar shows/hides it. The ChatPanel header has a button to open `/chat` full-screen.

### 2.5 Contextual composer state

The composer is not a static input box. The greeting, placeholder, and suggestion chips update in real time to reflect what the orchestrator is currently doing. Every time the user opens Agentis, the composer greets them with the current situation -- not a generic welcome.

```typescript
// useComposerContext.ts
function useComposerContext(ctx: {
  agents: WorkspaceAgent[];
  activeRuns: ActiveRun[];
  pendingApprovals: PendingApproval[];
  recentCompletions: RecentRun[];
  user: User;
}): { greeting: string; placeholder: string; chips: string[] } {
  const { agents, activeRuns, pendingApprovals, recentCompletions, user } = ctx;
  const orch        = agents.find(a => a.role === 'orchestrator');
  const activeCount = agents.filter(a => a.status === 'active').length;
  const h           = new Date().getHours();
  const timeGreet   = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

  const greeting = !orch
    ? 'Set up your orchestrator to get started.'
    : pendingApprovals.length > 0
    ? `${orch.name} is waiting for your approval.`
    : activeCount > 1
    ? `${activeCount} agents working right now.`
    : activeCount === 1
    ? `${agents.find(a => a.status === 'active')!.name} is working.`
    : `${timeGreet}, ${user.firstName}. Everything is quiet.`;

  const placeholder = activeRuns[0]
    ? `Ask about ${activeRuns[0].workflowName}...`
    : pendingApprovals.length > 0
    ? 'Review pending approval or ask the orchestrator...'
    : 'Ask the orchestrator...';

  const chips: string[] = [];
  if (pendingApprovals.length > 0)  chips.push('Review pending approval');
  if (activeRuns[0])                chips.push(`Status on ${activeRuns[0].workflowName}`);
  const recent = recentCompletions[0];
  if (recent && Date.now() - recent.completedAt < 3_600_000)
    chips.push(`Results from ${recent.workflowName}`);
  if (chips.length < 3) chips.push('What should we work on today?');

  return { greeting, placeholder, chips: chips.slice(0, 3) };
}
```

The greeting transitions with `transition: opacity 0.3s ease` when context changes -- a fade-through, not a jump. Arriving to an active canvas feels like entering a live briefing room: the composer already knows what's happening.

---

## 3. Node Architecture: The Living Org Chart

### 3.1 Node tier system

Four tiers with distinct visual weight, color, and size -- readable at a glance.

| Tier | Node type | Width x MinH | Border accent | Glow |
|------|-----------|-------------|---------------|------|
| 0 | `orchestrator` | 200 x 72px | `border-t-4 border-violet-500` | `box-shadow: 0 0 32px rgba(139,92,246,0.35)` permanent |
| 1 | `manager` | 160 x 60px | `border-t-2 border-cyan-500` | active-only glow |
| 2 | `worker` | 130 x 52px | `border-t border-blue-400` | none |
| 3 | `app` | 80 x 36px | `border-l-2 border-zinc-600` | none |
| 3 | `workflow` | 80 x 36px | `border-l-2 border-emerald-600` | glow on active run |
| 3 | `knowledge` | 80 x 36px | `border-l-2 border-amber-500` | none |
| 3 | `artifact` | 80 x 36px | `border-l-2 border-sky-500` | fade-in on RUN_COMPLETED |

### 3.2 Node visual anatomy by tier

**Orchestrator** (the crown):
```
+--------------------------------------------------+  <- 4px violet top border
|  [avatar 36px]   My Orchestrator        [* *]   |
|                  ORCHESTRATOR                   |  <- violet badge
|                  GPT-4o  .  OpenClaw            |
|  -----------------------------------------------  |
|  "Coordinating lead enrichment campaign"        |  <- current directive (active)
+--------------------------------------------------+
  Permanent violet outer glow. Largest node on canvas.
```

**Manager**:
```
+------------------------------------------+  <- 2px cyan top border
|  [avatar 28px]  Lead Manager     [*]     |
|                 MANAGER                  |  <- cyan badge
|                 Marketing Space  *       |  <- space + color dot
|                 GPT-4o-mini              |
+------------------------------------------+
```

**Worker**:
```
+---------------------------------------+  <- 1px blue top border
|  [avatar 24px]  Social Analyst  *    |
|                 WORKER               |  <- blue badge
|  "Scoring leads..."  [####..] 67%    |  <- task + progress (active only)
+---------------------------------------+
```

**Resource leaf nodes**:
```
 +------------------------+    +---------------------------+
 | [icon] HubSpot CRM     |    | [icon] Lead Enrichment  * |
 |  App                   |    |  Workflow  (live)         |
 +------------------------+    +---------------------------+
```

### 3.3 Status dot

| Status | Appearance |
|--------|-----------|
| `active` | `bg-emerald-400 animate-pulse` |
| `idle` | `bg-zinc-500` |
| `error` | `bg-red-500 animate-ping` |
| `paused` | `bg-amber-400` |

### 3.4 Layout algorithm: hierarchical tree with resource leaves

```typescript
function computeHierarchyLayout(
  agents: WorkspaceAgent[],
  apps: HomeApp[],
  workflows: HomeWorkflow[],
  knowledge: HomeKnowledgeBase[],
  canvasWidth: number,
  canvasHeight: number
): Map<string, { x: number; y: number }>
```

**Step 1 -- Build the authority tree**:
- Root: agent with `role === 'orchestrator'`
- Tier 1: `role === 'manager'`, `reportsTo === orchestrator.id`
- Tier 2: `role === 'worker'`, `reportsTo === manager.id`
- Orphans: separate dimmed row at bottom

**Step 2 -- Tier Y positions** (% of canvas height):
```
Tier 0 (orchestrator): y = 10%
Tier 1 (managers):     y = 28%
Tier 2 (workers):      y = 50%
Tier 3 (resources):    y = 72%
```

**Step 3 -- X positions within each tier**:
- Orchestrator: `x = 50%`
- Managers: evenly distributed in their subtree's x-range, centered under orchestrator
- Workers: distributed under their manager's x-range
- Resource nodes: horizontal fan below each agent, max 4 shown, `+N` overflow chip. Fan width capped at `min(agentSubtreeWidth, 280px)`.

**Step 4 -- Collision resolution**: single pass nudges siblings `+/-12px` if bounding boxes intersect.

Returns `Map<nodeId, { x, y }>` in absolute pixels. Called inside `useMemo`, re-runs on entity changes or canvas resize (`ResizeObserver`).

**Orphan agents**: `y = 88%`, `opacity-50`. Banner: "N workers unconnected -- assign in Fleet view."

### 3.5 Edge types

**Command edges** -- authority lines between agents:

```typescript
type CommandEdge = {
  from: string;
  to: string;
  type: 'command';
  strokeWidth: 1.5;
  strokeColor: 'violet' | 'cyan';  // orchestrator->manager: violet; manager->worker: cyan
  animation: 'pulse-on-activity';
};
```

Slightly curved quadratic bezier (20px control-point offset). On `RUN_CREATED` or `AGENT_STATUS_CHANGED`, a white traveling dot (`r=3`) animates along the edge path over 800ms via `animateMotion`. After arrival, the target agent briefly glows.

**Resource edges** -- agent to resource:

```typescript
type ResourceEdge = {
  from: string;
  to: string;
  type: 'resource';
  strokeWidth: 0.4;   // idle: 0.4 | active: 0.9
  strokeColor: 'emerald' | 'zinc';
  animation: 'flowing-circles';
};
```

Straight lines (resources hang directly below). Active resource edges carry `animateMotion` circles flowing from agent down to resource.

### 3.6 Cascade entrance animation

On initial data load, the hierarchy **assembles itself** tier by tier from the orchestrator downward. This is the first impression -- the most important moment in the product experience.

**Animation timeline** (triggered when `isLoading` transitions to `false`):

| Time | Event |
|------|-------|
| 0ms | Canvas background fades in: `opacity 0->1`, 300ms |
| 150ms | Orchestrator: `scale(0.75) opacity(0)` -> `scale(1.0) opacity(1)`, 450ms `ease-out-back`. Violet aura begins immediately. |
| 500ms | Command edges (orch->managers): SVG `stroke-dashoffset` draws from full-length -> 0, 350ms |
| 600ms | Manager nodes: `translateY(12px) opacity(0)` -> `translateY(0) opacity(1)`, 350ms, 80ms stagger |
| 900ms | Command edges (managers->workers): draw in, 300ms |
| 1000ms | Worker nodes: same slide-in, 300ms, 60ms stagger |
| 1200ms | Resource edges: draw in, 200ms |
| 1300ms | Resource leaves: `translateY(8px) opacity(0)` -> `translateY(0) opacity(1)`, 200ms, 40ms stagger |

Total: ~1.5 seconds. The organization assembles itself around the orchestrator.

```typescript
type EntrancePhase =
  | 'idle' | 'background' | 'orchestrator'
  | 'managers' | 'workers' | 'resources' | 'complete';

const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>('idle');

useEffect(() => {
  if (!isLoading && entrancePhase === 'idle') {
    const T = (ms: number, p: EntrancePhase) => window.setTimeout(() => setEntrancePhase(p), ms);
    setEntrancePhase('background');
    T(150,  'orchestrator');
    T(600,  'managers');
    T(1000, 'workers');
    T(1300, 'resources');
    T(1600, 'complete');
  }
}, [isLoading]);
```

Each node receives `entrancePhase` + its `tier`, computing which CSS animation class to apply. Nodes not yet revealed use `visibility: hidden` (not `display: none`) to preserve layout geometry for edge path calculations. After `entrancePhase === 'complete'`, subsequent data updates use standard opacity appear/disappear -- the cascade fires exactly once per session.

---

## 4. Realtime Animation Layer

All animation is additive -- it layers on the static tree without cluttering it.

### 4.1 Orchestrator permanent breathing aura

The orchestrator always breathes -- even at idle:

```css
@keyframes orchestrator-breathe {
  0%, 100% { box-shadow: 0 0 20px rgba(139,92,246,0.25), 0 0 40px rgba(139,92,246,0.08); }
  50%       { box-shadow: 0 0 32px rgba(139,92,246,0.40), 0 0 60px rgba(139,92,246,0.15); }
}
.node-orchestrator { animation: orchestrator-breathe 4s ease-in-out infinite; }
```

### 4.2 Agent heartbeat glow

When `AGENT_HEARTBEAT` fires:
1. Node gets `node-pulse` class for 1.8s: `box-shadow: 0 0 0 3px rgba(74,222,128,0.35), 0 0 16px rgba(74,222,128,0.2)`
2. Status dot transitions to brief `animate-ping` ring

```typescript
useRealtime([REALTIME_EVENTS.AGENT_HEARTBEAT], (env) => {
  const agentId = env.payload?.agentId as string | undefined;
  if (!agentId) return;
  setPulsingAgents(s => new Set([...s, agentId]));
  window.setTimeout(() => {
    setPulsingAgents(s => { const n = new Set(s); n.delete(agentId); return n; });
  }, 1800);
});
```

### 4.3 Active node animated border

```css
@keyframes node-active-border {
  0%, 100% { border-color: rgba(74, 222, 128, 0.4); }
  50%       { border-color: rgba(74, 222, 128, 0.85); }
}
.node-active { animation: node-active-border 2.2s ease-in-out infinite; }
```

### 4.4 Command pulse animation

When `RUN_CREATED` fires or an agent becomes active:
1. Find the command edge from that agent's parent
2. Spawn `CommandPulse`: white circle `r=3` traveling the edge path over 800ms via `animateMotion`
3. After arrival: target agent briefly glows `box-shadow: 0 0 12px rgba(255,255,255,0.2)`

### 4.5 Run start flash on workflow node

When `RUN_CREATED` fires: `node-flash` class (`@keyframes node-flash { 0% { background: rgba(74,222,128,0.25); } 100% { background: transparent; } }`, 100ms) + resource edge brightens: `strokeWidth: 0.9, stroke-opacity: 1`.

### 4.6 Run complete settle

When `RUN_COMPLETED` fires: circles stop; workflow node shows check overlay (200ms); artifact leaf fades in with `node-enter`.

### 4.7 Edge flow speed tied to run progress

`dur = Math.max(1.2, 3.0 - (run.progress ?? 0) * 0.018) + "s"`. As run nears 100%, circles move faster.

### 4.8 Radial orchestrator light

The canvas background carries a light source centered on the orchestrator's current position. This is the effect that makes the canvas feel like it has a **center of gravity** -- a glowing core that everything orbits.

```tsx
// CanvasRadialLight.tsx
function CanvasRadialLight({
  orchestratorCanvasPos,
  isActive,
}: {
  orchestratorCanvasPos: Vec2 | null;
  isActive: boolean;
}) {
  if (!orchestratorCanvasPos) return null;
  const { x, y } = orchestratorCanvasPos;
  const alpha  = isActive ? 0.11 : 0.06;
  const spread = isActive ? 68   : 52;    // percent of canvas diagonal

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        zIndex: 1,
        background: `radial-gradient(
          circle at ${x}px ${y}px,
          rgba(139,92,246,${alpha})       0%,
          rgba(139,92,246,${alpha * 0.4}) 30%,
          transparent                     ${spread}%
        )`,
        transition: 'background 1.5s ease',
      }}
    />
  );
}
```

`orchestratorCanvasPos` is computed every frame from `layout.x * zoom + pan.x`. Because it is React state that recomputes with every pan/zoom, the light stays perfectly anchored to the orchestrator with no CSS transition lag. The position never "floats" -- it is exact.

**Intensity transitions**:
- Orchestrator becomes active: `alpha 0.06 -> 0.11`, `spread 52% -> 68%` over 1.5s. The canvas visibly wakes up.
- Orchestrator goes idle: same transition in reverse.

This light + the `orchestrator-breathe` CSS animation (ss4.1) make the orchestrator the unmistakable center of attention -- before the user reads any label.

### 4.9 Edge particle density scales with load

The canvas feels **visibly busier** when more work is happening. Particle count and speed scale with the number of active runs connected to each resource edge.

```typescript
function computeEdgeAnimation(
  edge: ResourceEdge,
  activeRunCount: number
): EdgeAnimation {
  if (activeRunCount === 0)
    return { count: 0, dur: 0,   opacity: 0,    strokeColor: '#3f4451', strokeWidth: 0.4 };
  if (activeRunCount === 1)
    return { count: 1, dur: 2.5, opacity: 0.70, strokeColor: '#4ade80', strokeWidth: 0.6 };
  if (activeRunCount === 2)
    return { count: 2, dur: 1.8, opacity: 0.85, strokeColor: '#4ade80', strokeWidth: 0.8 };
  return   { count: 3, dur: 1.2, opacity: 1.00, strokeColor: '#86efac', strokeWidth: 0.9 };
}

// Multiple particles staggered evenly across the animation cycle:
// count=2: begins at 0s and dur/2
// count=3: begins at 0s, dur/3, (dur/3)*2
const begins = (count: number, dur: number) =>
  Array.from({ length: count }, (_, i) => `${(i * dur / count).toFixed(2)}s`);
```

**Busy manager command edges**: when a manager has `activeWorkers >= 2`, the command edge from orchestrator to that manager pulses stroke opacity:

```css
@keyframes command-edge-busy {
  0%, 100% { stroke-opacity: 0.55; }
  50%       { stroke-opacity: 1.00; }
}
.command-edge-busy { animation: command-edge-busy 2s ease-in-out infinite; }
```

An idle canvas is clean and minimal. A canvas with 4 concurrent workflows blazes with particles -- the visual load is a truthful representation of the computational load.

---

## 5. Hover + Click Interactions

### 5.1 Worker hover popover

When hovering an **active** worker agent:

```
+----------------------------------------------------------+
|  [avatar 20px]  Social Analyst  * working                |
|  -------------------------------------------------------- |
|  Current task                                            |
|  "Analyze lead batch #47 from HubSpot CRM"               |
|  -------------------------------------------------------- |
|  Recent activity                                         |
|  ->  Reading HubSpot lead list (12 records)    2s ago    |
|  v   Fetched company data from Clearbit        8s ago    |
|  ~   Scoring leads by ICP criteria...          live      |
|  -------------------------------------------------------- |
|  [View full log ->]                                      |
+----------------------------------------------------------+
```

`w-[320px]`, positioned right of node (or left if near right edge).

### 5.2 Orchestrator hover popover -- dispatch summary

```
+----------------------------------------------------------+
|  [orch avatar]  Orchestrator  * active                   |
|  -------------------------------------------------------- |
|  Directing                                               |
|  "Lead enrichment campaign -- batch #47"                 |
|  -------------------------------------------------------- |
|  Active workers                                          |
|  *  Social Analyst -- scoring leads          2s ago      |
|  *  Thomas -- writing newsletter draft      48s ago      |
|  -------------------------------------------------------- |
|  [Open conversation ->]                                  |
+----------------------------------------------------------+
```

The orchestrator shows which workers it is directing -- reinforcing the mental model: orchestrators command, workers execute.

### 5.3 Hover data source

On hover-enter:
1. `rtSubscribe('agent', { agentId })` -- joins agent room
2. Listens to `AGENT_TERMINAL_TOOL_CALL`, `AGENT_WORK_STEP`, `AGENT_TERMINAL_MESSAGE`
3. Shows last 3 events in reverse-chronological order

On hover-leave (300ms grace period): unsubscribes and clears state.

### 5.4 Idle agents

Simple tooltip only: role + "Last active: 3h ago". No room subscription.

### 5.5 Node click interaction

Every node is clickable. Click is deliberate focus, distinct from hover (passive observation).

**`CanvasNodeDetailPanel`**: clicking any node opens a 380px panel that slides in from the right edge of the canvas. The canvas dims behind it (`bg-black/20 backdrop-blur-[1px]`). Pointer-events remain active through the dim so panning still works. The panel is **canvas-local** -- it does not affect the page shell or the ChatPanel.

```
+-- canvas (dimmed 20%) -----+  +-- CanvasNodeDetailPanel (380px) ------+
|                            |  |                                        |
|  [hierarchy tree visible]  |  |  [Name + tier badge + status dot]      |
|                            |  |  [Model + space assignment]            |
|                            |  |  ──────────────────────────────────── |
|                            |  |  Current task / "Idle"                 |
|                            |  |  [Progress bar if active]              |
|                            |  |  ──────────────────────────────────── |
|                            |  |  Connected resources                   |
|                            |  |  [App chips] [Workflow chips] [KB]     |
|                            |  |  ──────────────────────────────────── |
|                            |  |  [Chat with this agent ->]             |
|                            |  |  [Open agent page ->]                  |
+----------------------------+  +----------------------------------------+
```

**Per-tier panel content**:

| Clicked node | Panel shows |
|-------------|-------------|
| `orchestrator` | Name, badge, current directive, list of active workers, last 3 dispatches, "Open conversation" + "Open agent page" |
| `manager` | Name, badge, space name, workers list with statuses, current task, "Open agent page" |
| `worker` | Name, badge, current task + progress bar, last 3 tool calls (live feed), resources, "Open agent page" |
| `app` | App name + icon, description, connected agents, "Open app ->" -> `/apps/:slug` |
| `workflow` | Name, last run status + time, connected agents, "Open workflow ->" -> `/workflows/:id` |
| `knowledge` | KB name, entry count, connected agents, "Open knowledge ->" |
| `approval` | Full approval prompt, approve + deny buttons inline |

**Focus zoom on click**: canvas smoothly pans and zooms to center the clicked node at `zoom -> 1.35` over 400ms. This motion confirms the canvas is interactive -- not a static poster.

```typescript
function focusNode(nodeId: string) {
  const pos = layoutMap.get(nodeId);
  if (!pos) return;
  const targetZoom = 1.35;
  const targetPan  = {
    x: canvasW / 2 - pos.x * targetZoom,
    y: canvasH / 2 - pos.y * targetZoom,
  };
  animatePanZoom(targetPan, targetZoom, 400); // requestAnimationFrame lerp
}
```

**Closing**: clicking the canvas background closes the panel and restores full opacity. `Escape` also closes. Arrow keys pan when the panel is open. The panel is not modal -- free panning and zooming work while it is open.

---

## 6. Full-Screen Mode

True full-screen -- not a CSS max-width expansion.

### 6.1 Entry / exit

```typescript
function enterFullscreen() { document.documentElement.requestFullscreen(); }
function exitFullscreen()  { document.exitFullscreen(); }
document.addEventListener('fullscreenchange', () => {
  setIsFullscreen(Boolean(document.fullscreenElement));
});
```

When `isFullscreen === true`:
- Sidebar hides: `document.body.classList.add('fullscreen-mode')` + `body.fullscreen-mode aside { display: none; }`
- Top bar hides similarly
- Canvas takes entire screen (100vw x 100vh)
- Floating composer **remains fully functional**
- ChatPanel stays open if it was open -- not forced closed
- `Chat` toggle in HUD lets user show/hide ChatPanel
- ChatPanel header gains a button to open `/chat` full-screen

In full-screen the hierarchy tree has more room to breathe. The orchestrator's radial light fills more of the screen. Nodes spread further. This is the virally shareable state.

### 6.2 Full-screen HUD overlay

```
+------------------------------------------------------------------------------+
|  [logo]  test02 workspace  .  * 2 active  o 3 idle  ! 0                     |
|  --------------------------------------------------------------------------- |
|  -> Content Pipeline  . 67%  running 4m22s      v Lead Enrichment  1m ago   |
|  -> Social Digest     . 12%  running 48s         o Daily Report    idle      |
|  --------------------------------------------------------------------------- |
|  [Chat toggle]  [Monitor]  [X Exit]                                          |
+------------------------------------------------------------------------------+
```

CSS: `position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999; backdrop-blur-xl bg-canvas/90 border-t border-line/40 px-6 py-3`

**Keyboard shortcuts**: `Escape` exits. `F` toggles full-screen. `C` toggles ChatPanel.

---

## 7. Detachable Mission Monitor Window

A standalone window for a second monitor -- live workspace activity at arm's length.

### 7.1 Opening the monitor

```typescript
function openMonitor() {
  const url      = `${window.location.origin}/canvas-monitor?workspace=${workspaceId}`;
  const features = 'width=460,height=920,resizable=yes,scrollbars=no';
  window.open(url, 'agentis-monitor', features);
}
```

### 7.2 `/canvas-monitor` route

```typescript
<Route path="/canvas-monitor" element={<CanvasMonitorWindow />} />
```

`CanvasMonitorWindow` is a minimal shell -- no sidebar, no top bar.

### 7.3 Monitor layout (~460x920)

```
+----------------------------------+
|  AGENTIS LIVE                    |  <- header, violet accent
|  test02  .  May 14 10:42 AM      |
+----------------------------------+
|  FLEET                           |
|  * 2 active  o 3 idle  ! 0       |
|  * 4,230 tokens today            |
|  * $0.12 spent today             |
+----------------------------------+
|  WORKING NOW                     |
|  +-----------------------------+ |
|  | Social Analyst      * 2m    | |
|  | "Scoring leads by ICP"      | |
|  | [#########.....] 67%        | |
|  +-----------------------------+ |
|  +-----------------------------+ |
|  | Thomas              * 48s   | |
|  | "Writing newsletter draft"  | |
|  | [##.............] 12%       | |
|  +-----------------------------+ |
+----------------------------------+
|  LIVE EVENTS        auto-scroll  |
|  +-----------------------------+ |
|  | -> 10:42:18  tool_call      | |
|  |    read_hubspot_leads        | |
|  |    -> 47 records fetched     | |
|  | v  10:42:11  task_completed  | |
|  |    Lead Enrichment done      | |
|  +-----------------------------+ |
+----------------------------------+
|  RECENT OUTPUTS                  |
|  +-----------------------------+ |
|  | [doc] Weekly Newsletter     | |
|  |    Generated 8m ago  [open] | |
|  +-----------------------------+ |
+----------------------------------+
```

### 7.4 Monitor realtime events

| Event | Effect |
|-------|--------|
| `AGENT_STATUS_CHANGED` | Update fleet counts; update Working Now |
| `AGENT_HEARTBEAT` | Flash Working Now card (green, 400ms) |
| `AGENT_TERMINAL_TOOL_CALL` | Add row to Live Events |
| `AGENT_WORK_STEP` | Add row to Live Events |
| `RUN_CREATED` | Add to Working Now |
| `RUN_COMPLETED` | Move to Recent Outputs |
| `RUN_FAILED` | Red error row in Live Events |
| `FLEET_SNAPSHOT_UPDATED` | Refresh fleet stats |

Live Events auto-scrolls. "Pause scroll" button on hover.

### 7.5 Monitor visual design

- **Background**: `#080c10`
- **Typography**: monospace for event rows, proportional for sections
- **Accent**: violet (`#8b5cf6`) matching the orchestrator
- **Working Now cards**: gradient left border by tier color, live progress bar, elapsed counter ticking every second
- **Token odometer** (stretch): `AGENT_TERMINAL_MESSAGE` causes token count to tick up visibly

---

## 8. Attention, Approvals, and Special States

### 8.1 Approval banner

Floating overlay at top-right of canvas:

```
+---------------------------------------------+
|  ! 1 pending approval  [Review ->]           |
+---------------------------------------------+
```

`position: absolute; top: 12px; right: 12px; z-index: 40`. Dismissible per session.

### 8.2 Approval node on canvas

Pending approvals become an `approval` resource node hanging below the blocked worker -- amber, `animate-pulse`:

```
+----------------------------+  <- amber left border, animate-pulse
| ! Approve: send email?     |
|   [Resolve ->]             |
+----------------------------+
```

Clicking opens the approval via `CanvasNodeDetailPanel` (ss5.5) -- inline within the canvas hierarchy without leaving the page.

### 8.3 Empty state: the animated promise

When a workspace has no agents, the canvas shows a **ghost hierarchy** -- not a blank page. This is the product demo before the product is built: the user sees exactly what their canvas will look like, making the value proposition viscerally clear before any setup investment.

**Ghost hierarchy structure**:

```
                +- - - - - - - - - - - - +
                |    ADD ORCHESTRATOR     |  <- dashed violet border, 30% opacity
                |     [+ Create now]      |     violet aura at 20% opacity
                +- - - - - - - - - - - - +
               /                          \
    +- - - - - - -+               +- - - - - - -+
    |  ADD MANAGER |               |  ADD MANAGER |  <- dashed cyan, 25% opacity
    |  [+ Create]  |               |  [+ Create]  |
    +- - - - - - -+               +- - - - - - -+
    /    \                          /    \
  [?]   [?]   [?]               [?]   [?]   [?]    <- ghost workers, dashed blue
```

All ghost edges: `stroke-dasharray: 4 4`, `stroke: rgba(100,100,120,0.3)`.

**Ghost breathing**: all ghost nodes pulse together: `opacity: 0.20 -> 0.40 -> 0.20`, 3.5s cycle. Slower and quieter than the active green heartbeat -- an invitation, not an alarm.

**Ghost hover tooltips**:
- Orchestrator ghost: "Your orchestrator goes here -- it directs all other agents."
- Manager ghost: "Managers coordinate workers within a space."
- Worker ghost: "Workers execute tasks: research, writing, data enrichment, and more."

**Ghost click**: opens `AgentCreateWizard` with the appropriate `role` pre-filled. Wizard header shows hierarchy context: "Create your Orchestrator -- the center of your AI organization."

**Overlay text** (centered below the ghost tree):
```
        Your AI organization will appear here.

              [+ Add Orchestrator]           <- violet, prominent CTA
           Learn how the hierarchy works ->  <- secondary link
```

**Partial empty states** -- ghosts fill the gaps:
- Has orchestrator, no managers: real orchestrator + ghost managers + ghost workers
- Has orchestrator + managers, no workers: real agents + ghost workers below each manager
- Has workers, all unassigned: real workers in orphan row, orphan banner below

The canvas never shows a fully empty state after the first agent is created. Missing tiers are filled with ghosts that show you exactly where you are in the setup journey.

---

## 9. Component File Plan

| File | Action | Notes |
|------|--------|-------|
| `apps/web/src/pages/HomePage.tsx` | Modify | Remove below-fold sections; canvas `flex-1`; remove `FleetMetricBar` |
| `apps/web/src/components/home/WorkspaceEcosystemCanvas.tsx` | Modify | Remove height cap; hierarchy tree layout; two edge types; entrance animation state machine; full-screen; monitor |
| `apps/web/src/components/home/CanvasBackground.tsx` | Create | Dual-layer parallax dot grid (near 1.0x + far 0.65x coefficients) |
| `apps/web/src/components/home/CanvasRadialLight.tsx` | Create | Radial gradient centered on orchestrator canvas position; intensity tied to status |
| `apps/web/src/components/home/CanvasComposerOverlay.tsx` | Create | Floating composer; collapse-on-pan; inline reply bubble |
| `apps/web/src/components/home/CanvasHudBar.tsx` | Create | Bottom status bar: fleet counts + full-screen + monitor buttons |
| `apps/web/src/components/home/CanvasNodeDetailPanel.tsx` | Create | 380px canvas-local slide-over; per-tier content; focus-zoom on click; Escape to close |
| `apps/web/src/components/home/CanvasActivityPopover.tsx` | Create | Hover popover: task + live events. Orchestrator variant = dispatch summary. |
| `apps/web/src/components/home/CanvasApprovalNode.tsx` | Create | Amber resource node for pending approvals; resolves via detail panel |
| `apps/web/src/pages/CanvasMonitorWindow.tsx` | Create | Standalone monitor: minimal shell, realtime, second-monitor design |
| `apps/web/src/hooks/useComposerContext.ts` | Create | Derives greeting, placeholder, suggestion chips from realtime fleet state |
| `apps/web/src/App.tsx` | Modify | Add `/canvas-monitor` route |
| `packages/core/src/events.ts` | Verify | Confirm `AGENT_HEARTBEAT`, `AGENT_TERMINAL_TOOL_CALL`, `AGENT_WORK_STEP` event shapes |

---

## 10. Implementation Phases

### Phase A -- Canvas fills the viewport + hierarchy layout + entrance (1.5 days)

| # | Task |
|---|------|
| A-1 | Remove `h-[420px]`; canvas takes `flex-1 min-h-0` |
| A-2 | Refactor `HomePage` to `flex flex-col h-full`; remove below-fold sections |
| A-3 | Implement hierarchy tree layout algorithm (`computeHierarchyLayout`) |
| A-4 | Remove node count caps; render all entities |
| A-5 | Extract `CanvasComposerOverlay`; implement `useComposerContext` hook |
| A-6 | Add `CanvasHudBar` with fleet counts |
| A-7 | Implement cascade entrance animation state machine |
| A-8 | Implement pan/zoom: inertial momentum + zoom-toward-cursor + double-click reset |
| A-9 | Create `CanvasBackground` with dual-layer parallax |

**DoD Phase A**:
- [ ] Canvas fills full viewport; hierarchy visible (orchestrator -> managers -> workers -> resources)
- [ ] Entrance: hierarchy assembles tier-by-tier in ~1.5s on first load
- [ ] Pan feels inertial; zoom goes toward cursor; double-click resets to orchestrator
- [ ] Far dot layer noticeably slower than near layer during pan (parallax depth)
- [ ] Composer greets with contextual state (idle/active/approval)
- [ ] Suggestion chips update based on active runs and recent completions

### Phase B -- Edge system + realtime animation (2 days)

| # | Task |
|---|------|
| B-1 | Command edges (thick violet/cyan) between agent tiers |
| B-2 | Resource edges (thin, green active) agent -> resource |
| B-3 | Command pulse: traveling dot on `RUN_CREATED` + `AGENT_STATUS_CHANGED` |
| B-4 | Heartbeat glow: `AGENT_HEARTBEAT` -> pulsing ring |
| B-5 | Run start flash + run complete settle |
| B-6 | Edge flow speed: `dur` tied to run progress |
| B-7 | Orchestrator breathing aura (`orchestrator-breathe`) |
| B-8 | Active agent animated border |
| B-9 | `CanvasRadialLight`: radial gradient centered on orchestrator; intensity on active/idle |
| B-10 | Edge particle density: `computeEdgeAnimation()` scales count 1-3 with active run count |

**DoD Phase B**:
- [ ] Command edges visually distinct from resource edges (thickness + color)
- [ ] Command pulses travel down hierarchy when runs start
- [ ] Orchestrator breathes with violet aura at all times
- [ ] Radial orchestrator light visible; visibly intensifies when orchestrator becomes active
- [ ] Edge particle count increases with active run count (1 -> 2 -> 3 particles, faster)
- [ ] `command-edge-busy` pulsing on manager edges when 2+ workers active

### Phase C -- Hover + Click interactions (2 days)

| # | Task |
|---|------|
| C-1 | Build `CanvasActivityPopover` (worker variant) |
| C-2 | Orchestrator popover variant (dispatch summary) |
| C-3 | Wire hover-enter -> `rtSubscribe` + 300ms grace period |
| C-4 | Build `CanvasNodeDetailPanel` -- layout, per-tier content |
| C-5 | Focus-zoom animation on node click (`animatePanZoom`) |
| C-6 | Canvas background click closes panel; `Escape` closes panel |
| C-7 | Per-tier navigation: app click -> `/apps/:slug`, workflow click -> `/workflows/:id` |

**DoD Phase C**:
- [ ] Hovering active worker shows task + last 3 events
- [ ] Hovering orchestrator shows dispatch summary
- [ ] Clicking any node opens detail panel with focus-zoom
- [ ] Per-tier panel content correct for all node types
- [ ] App/workflow nodes navigate on click
- [ ] Panel closes on background click and Escape
- [ ] No memory leak: room subscription cleaned up on hover-leave

### Phase D -- Full-screen mode (1 day)

| # | Task |
|---|------|
| D-1 | `requestFullscreen` / `exitFullscreen` with `fullscreenchange` listener |
| D-2 | CSS: hide sidebar + top bar in full-screen |
| D-3 | Full-screen HUD overlay |
| D-4 | `Chat` toggle + `C` shortcut; `F` shortcut for full-screen |

**DoD Phase D**:
- [ ] Full-screen enters true browser full-screen; 100vw x 100vh
- [ ] Hierarchy expands naturally; radial light fills more screen
- [ ] HUD shows fleet + active run data; chat toggle works
- [ ] `Escape`, `F`, `C` shortcuts work

### Phase E -- Canvas Monitor Window (2 days)

| # | Task |
|---|------|
| E-1 | Create `/canvas-monitor` route |
| E-2 | Build `CanvasMonitorWindow`: minimal shell, `#080c10` |
| E-3 | Fleet section: live counts |
| E-4 | Working Now: tier-colored cards, progress bars, elapsed counter |
| E-5 | Live Events feed: auto-scrolling; pause on hover |
| E-6 | Recent Outputs: `RUN_COMPLETED` artifacts |
| E-7 | Monitor button in full-screen HUD |

**DoD Phase E**:
- [ ] All 4 monitor sections render with live data
- [ ] Live Events auto-scrolls; Pause works
- [ ] Working Now cards update in realtime; elapsed timer ticks
- [ ] Monitor works when main window navigates away

### Phase F -- Empty state + polish + tests (1.5 days)

| # | Task |
|---|------|
| F-1 | Ghost hierarchy for zero-agent state: dashed nodes, breathing opacity |
| F-2 | Ghost hover tooltips; ghost click -> `AgentCreateWizard` with pre-filled role |
| F-3 | Partial empty states: ghosts fill missing tiers |
| F-4 | Approval node type: amber leaf below blocked worker; resolves via detail panel |
| F-5 | Attention banner as floating overlay (top-right) |
| F-6 | Orphan worker banner |
| F-7 | Vitest unit tests: `computeHierarchyLayout`, `computeEdgeAnimation`, `useComposerContext` |
| F-8 | Playwright e2e: hierarchy renders, hover popover, click detail panel, fullscreen toggle |

**DoD Phase F**:
- [ ] Ghost hierarchy visible when no agents; ghost breathing animation active
- [ ] Ghost click opens wizard with correct pre-filled role
- [ ] Partial states: real agents + ghost gaps coexist correctly
- [ ] All Vitest tests green
- [ ] Playwright e2e passes

---

## 11. Definition of Done -- Full Canvas

- [ ] Canvas fills the full viewport; no above/below-fold split
- [ ] Hierarchy assembles tier-by-tier in ~1.5s on first load (cascade entrance)
- [ ] Orchestrator at top center: violet crown glow, largest node, permanent breathing aura
- [ ] Command edges (thick, colored) connect tiers; resource edges (thin) connect agents to resources
- [ ] Command pulses travel down hierarchy when agents become active
- [ ] Radial orchestrator light visible; intensifies when orchestrator is active
- [ ] Edge particle count scales with active run count (1 -> 3 particles, faster speed)
- [ ] Pan feels native: inertial glide on release, zoom toward cursor, double-click resets
- [ ] Background parallax: far dots noticeably slower than near dots during pan
- [ ] Composer greeting and chips update contextually based on fleet state
- [ ] Hovering active worker shows task + live events
- [ ] Hovering orchestrator shows dispatch summary
- [ ] Clicking any node opens detail panel with focus-zoom; Escape closes
- [ ] Per-tier detail panel content correct for all node types
- [ ] Ghost hierarchy visible when no agents; ghost click opens wizard
- [ ] Partial empty states: real + ghost coexist for missing tiers
- [ ] Full-screen mode works; hierarchy expands; radial light fills the display
- [ ] Full-screen HUD shows fleet + active runs; chat toggle works
- [ ] Monitor window: all 4 sections live; auto-scroll; heartbeat flash
- [ ] No memory leaks: all realtime subscriptions cleaned up on unmount
- [ ] Vitest green: layout algorithm, edge animation, composer context
- [ ] Playwright e2e: hierarchy, hover popover, click panel, fullscreen

---

## 12. Scope Boundary

- **No graph editing** on home canvas -- observation + interaction only. Editing: `/agents` or `/workflows/:id`
- **No drag-to-reassign** on home canvas (future sprint)
- **No 3D / WebGL** -- parallax dot grid + SVG edges + CSS glow achieves the visual depth needed
- **No audio notifications** -- visual-only
- **No changes** to the workflow canvas (`/workflows/:id`)
- **No changes** to `AgentDetailPage`
- Monitor window is **read-only** -- approvals and retries happen in the main window
- **Home = observe the living hierarchy. Agents = manage the roster. Keep them separate.**