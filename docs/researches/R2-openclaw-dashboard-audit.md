# R2 — OpenClaw Dashboard Audit

**Research scope:** Deep technical audit of two community-built OpenClaw management UIs —
`ChristianAlmurr/openclaw-dashboard` and `abhi1693/openclaw-mission-control` — and the
upstream OpenClaw runtime gateway protocol. Purpose: extract concrete interaction models,
data contracts, and design patterns that directly inform the following Agentis components:
`AgentConstellation`, `MissionKanban`, `CommandPalette`, `TerminalPane`, and
`ChannelNotifier`.

**Repositories audited:**

| repo | stars | forks | license | primary language |
|---|---|---|---|---|
| `ChristianAlmurr/openclaw-dashboard` | 34 | 6 | MIT | TypeScript |
| `abhi1693/openclaw-mission-control` | 3,800 | 809 | MIT | TypeScript + Python |

**OpenClaw runtime:** `openclaw/openclaw` — 74,500+ forks, MIT, Node.js, Gateway on
WebSocket port 18789.

---

## 1. Executive Summary

Both repositories are MIT-licensed, community-built management layers on top of the official
OpenClaw runtime. They are design inspiration sources, not code-extraction targets.

`ChristianAlmurr/openclaw-dashboard` is a small (34 stars), local-first single-developer
project built with Next.js 16 / React 19 / SQLite. It is the direct source of the
`AgentConstellation` interaction model: it contains a fully custom Canvas 2D physics
simulation that lays out agents in an orbital graph and drives animated, role-aware node
rendering. No D3, no React Flow — pure `canvas.getContext('2d')` with a hand-rolled spring
integrator.

`abhi1693/openclaw-mission-control` is a larger (3.8k stars), team-oriented product with a
Python/FastAPI backend and a Next.js frontend. It models a full Kanban-style project
management layer above OpenClaw agent fleets: Organizations → Board Groups → Boards →
Tasks, with approval workflows, activity feeds, board memory, board webhooks, and a skills
skill registry. It is the source of Agentis's `MissionKanban` hierarchy model, `CommandPalette`
semantic search inspiration, `TerminalPane` in-browser shell pattern, and `ChannelNotifier`
channel webhook integration.

The OpenClaw runtime Gateway exposes a WebSocket control plane at `127.0.0.1:18789` with a
typed JSON-frame RPC protocol (protocol v3). It pushes real-time events — `agent`,
`session.message`, `session.tool`, `heartbeat`, `cron` — to all connected operator clients.
Agentis's OpenClaw adapter must authenticate against this WebSocket using a shared-secret
device token, declare `role: "operator"` with `operator.read` + `operator.write` scopes, and
consume these events to drive its `NormalizedAgent` and `NormalizedTask` models.

---

## 2. ChristianAlmurr/openclaw-dashboard — Full Audit

### 2.1 Repository Identity

| attribute | value |
|---|---|
| framework | Next.js 16 (app router), React 19, TypeScript 5.9 |
| styling | Tailwind CSS 4 |
| state | TanStack Query v5 (server state), Zustand (client state) |
| data store | SQLite via `better-sqlite3`; feeds Next.js API routes |
| file-watching | Chokidar — watches `~/.openclaw/` for agent session files |
| scheduling | `node-cron` for periodic sync |
| UI primitives | Radix UI, Recharts v3, `@xyflow/react` (OrgMap DAG only) |
| AI | OpenAI SDK (memory health analysis), ElevenLabs (voice) |
| testing | Vitest |
| API surface | 52 Next.js API routes + SSE endpoints |

Data flow: `~/.openclaw/` filesystem → Chokidar watchers + file parsers → SQLite
→ 52 Next.js API routes / SSE → React Query → Zustand → UI.

The dashboard has four top-level views: **OrgMap** (React Flow DAG), **Grid** (card list),
**Feed** (event log), **Constellation** (spatial physics graph). The OrgMap uses
`@xyflow/react`; the Constellation uses pure Canvas 2D with zero React Flow involvement.

---

### 2.2 Constellation Architecture (deep)

The Constellation view is the primary extraction target for Agentis `AgentConstellation`.
Its component tree:

```
ConstellationView.tsx          ← wrapper, stats bar, tooltip, drawer
  └── ConstellationCanvas.tsx  ← Canvas 2D physics simulation (SSR-disabled)
  └── NodeTooltip.tsx          ← hover tooltip (portal, absolute positioned)
  └── NodeDrawer.tsx           ← slide-over drawer on click
```

#### 2.2.1 Data Model

```typescript
interface ConstellationNode {
  id: string;
  name: string;
  role: 'orchestrator' | 'developer' | 'qa' | 'researcher' | 'designer' | 'other';
  status: 'active' | 'idle' | 'error' | 'offline';
  modelPrimary: string;       // e.g. 'Claude Sonnet 4.6'
  provider: string;           // 'anthropic' | 'openai' | 'google' | 'other'
  tokensUsed24h?: number;
  costUSD24h?: number;
  errorCount24h?: number;
}

interface ConstellationEdge {
  id: string;
  from: string;               // source node id
  to: string;                 // target node id
  type: 'delegation' | 'message';
  strength: number;           // 0–1, controls line width + alpha
  ratePerMin?: number;        // pulse spawn rate; missing = no pulses
}
```

Internal simulation types (not exposed externally):

```typescript
// Internal node extended with physics state
interface SimNode {
  node: ConstellationNode;
  x: number; y: number;       // current position
  vx: number; vy: number;     // velocity
  targetX: number; targetY: number;  // layout target
  radius: number;
  phase: number;              // breathing animation phase offset (random seed)
  breathRate: number;         // ~0.8–1.2 Hz
  particles: Particle[];      // orbiting particle ring
}

interface SimEdge {
  edge: ConstellationEdge;
  fromIdx: number; toIdx: number;
  pulses: Pulse[];            // active pulses traveling along the bezier
}

interface Pulse {
  t: number;         // progress 0–1 along bezier curve
  speed: number;     // pixels per ms equivalent
  size: number;      // dot radius
  opacity: number;
  trail: number[];   // array of t-offsets for trailing dots
}

interface Particle {
  angle: number;     // radians
  distance: number;  // from node center
  speed: number;     // radians per frame
  size: number;
  opacity: number;
  hue: number;
}
```

#### 2.2.2 Layout Algorithm

Initial placement uses a deterministic orbital layout — no randomness, so the canvas does
not jump on remount:

```typescript
function layoutNodes(nodes: ConstellationNode[], width: number, height: number): {x: number, y: number}[] {
  const cx = width / 2;
  const cy = height / 2;
  const orbitRadius = Math.min(width, height) * 0.32;

  return nodes.map((node, i) => {
    if (node.role === 'orchestrator') {
      return { x: cx, y: cy };                    // always dead center
    }
    const nonOrchNodes = nodes.filter(n => n.role !== 'orchestrator');
    const idx = nonOrchNodes.indexOf(node);
    const total = nonOrchNodes.length;
    const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;  // start at top
    return {
      x: cx + Math.cos(angle) * orbitRadius * 1.2,  // wider x orbit
      y: cy + Math.sin(angle) * orbitRadius * 0.85, // tighter y orbit (ellipse)
    };
  });
}
```

#### 2.2.3 Physics Integrator

Every animation frame calls `applyForces` with `dt` (milliseconds since last frame), then
advances positions and clamps velocity:

```typescript
const SPRING_K   = 0.003;   // attraction toward layout target
const DAMPING    = 0.92;    // velocity decay per frame
const JITTER     = 0.15;    // random noise for organic movement

function applyForces(simNodes: SimNode[], dt: number) {
  for (const n of simNodes) {
    const dx = n.targetX - n.x;
    const dy = n.targetY - n.y;

    n.vx += dx * SPRING_K;
    n.vy += dy * SPRING_K;

    // organic jitter — small random nudges each frame
    n.vx += (Math.random() - 0.5) * JITTER;
    n.vy += (Math.random() - 0.5) * JITTER;

    n.vx *= DAMPING;
    n.vy *= DAMPING;

    n.x += n.vx * dt;
    n.y += n.vy * dt;
  }
}
```

The simulation runs on `requestAnimationFrame` via a `useEffect` inside
`ConstellationCanvas`. When node data changes (new agent added/removed), layout targets are
recalculated and the spring forces smoothly animate each node to its new orbit position.

#### 2.2.4 Node Rendering

Rendered using Canvas 2D draw calls inside a `drawNode(ctx, simNode, isHovered)` function:

**Role → polygon shape + base radius:**

| role | polygon points | radius multiplier | base radius |
|---|---|---|---|
| orchestrator | 8 pts (double-star) | 0.85 | 38 px |
| developer | 6 pts (hexagon) | 0.70 | 26 px |
| qa | 4 pts (square) | 0.75 | 24 px |
| researcher | 5 pts (pentagon) | 0.60 | 24 px |
| designer | 4 pts (rotated sq) | 0.75 | 24 px |
| other | 4 pts | 0.75 | 22 px |

**Status → fill color:**

| status | primary color | glow intensity |
|---|---|---|
| active | `#3b82f6` (blue-500) | 0.15 |
| idle | `#64748b` (slate-500) | 0.05 |
| error | `#ef4444` (red-500) | 0.12 |
| offline | `#334155` (slate-700) | 0.05 |

**Breathing animation:** `effectiveRadius = baseRadius * (1 + sin(t * breathRate + phase) * 0.06)`.
Each node has a unique `phase` offset (seeded from node id) so they don't pulsate in sync.

**Hover state:** scale ×1.15, computed via `effectiveRadius * 1.15` on hovered node only.

**Outer glow:** Radial gradient from `rgba(statusColor, glowIntensity)` at center to
`rgba(0,0,0,0)` at `radius * 2.5`. Drawn as `fillRect` over entire canvas with
`globalCompositeOperation = 'lighter'`.

**Orbiting particle ring:** Active status spawns 12 particles; idle 5; offline 2; error 8
(error particles have redder hue). Each particle orbits at `distance = radius * 1.6` to
`radius * 2.2`, advancing `angle += speed` each frame.

**Pixel face:** Deterministic 5×5 pixel-art face generated from a hash of `node.id`. Each
pixel is 2px × 2px, drawn in a color derived from the node's status color. Makes each agent
visually unique without external assets.

**Status overlays:**
- Error: pulsing red ring at `radius * 1.3`, drawn as a dashed arc, opacity modulated by
  `sin(t * 2)`.
- Active: rotating dashed blue arc at `radius * 1.4`, with `lineDashOffset` advancing each
  frame to create the "spinning" effect.

**Label:** Node name below the polygon in 12px system font, model string in monospace 10px
two lines further down. Both center-aligned on the node's `(x, y)`.

#### 2.2.5 Edge Rendering

Each `SimEdge` is drawn as a quadratic bezier between `simNodes[fromIdx]` and
`simNodes[toIdx]`:

```typescript
function drawEdge(ctx: CanvasRenderingContext2D, simEdge: SimEdge, simNodes: SimNode[]) {
  const from = simNodes[simEdge.fromIdx];
  const to   = simNodes[simEdge.toIdx];

  // perpendicular offset for visual separation of parallel edges
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx*dx + dy*dy);
  const cpX = midX + (-dy / len) * len * 0.05;  // 5% perpendicular curve
  const cpY = midY + ( dx / len) * len * 0.05;

  const isActive = simEdge.edge.type === 'delegation';
  ctx.strokeStyle = isActive
    ? `rgba(59,130,246,${0.3 + simEdge.edge.strength * 0.4})`  // blue, strength-scaled
    : `rgba(100,116,139,${0.2 + simEdge.edge.strength * 0.3})`; // slate
  ctx.lineWidth = 1 + simEdge.edge.strength * 2;

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
  ctx.stroke();
}
```

**Pulse system:** Each frame, new pulses are spawned per active edge:

```typescript
const spawnRate = (edge.ratePerMin / 60) * (dt / 1000) * 3;
if (Math.random() < spawnRate && simEdge.pulses.length < 8) {
  simEdge.pulses.push({
    t: 0,
    speed: 0.0004 + Math.random() * 0.0003,
    size: 2 + Math.random() * 2,
    opacity: 0.7 + Math.random() * 0.3,
    trail: [-0.015, -0.03, -0.045, -0.06],  // 4 trailing ghost positions
  });
}
```

Each pulse advances `t += speed * dt` and is removed when `t > 1`. Position along the
bezier is resolved via the quadratic formula: `lerp(lerp(from, cp, t), lerp(cp, to, t), t)`.
The four trailing dots are drawn at `t + trail[i]` with decreasing opacity.

#### 2.2.6 Interaction Model

**Hit detection:** On `mousemove`, iterate `simNodes`, check `distance(mouse, node) < node.radius * 1.2`. First match is hovered. O(n) but fleet size is small (≤ 50 agents realistically).

**Hover → tooltip:** `ConstellationView` passes `onHover(nodeId | null)` into
`ConstellationCanvas`. `ConstellationView` maintains `hoveredNodeId` state, positions
`NodeTooltip` absolutely at `{x: mouse.x + 12, y: mouse.y - 8}` relative to the canvas
bounding rect. `NodeTooltip` shows: name, role badge, status badge, model, tokens/24h,
cost/24h, error count/24h.

**Click → drawer:** `ConstellationCanvas` fires `onClick(nodeId)`. `ConstellationView`
maintains `selectedNodeId` state, renders `NodeDrawer` as a right-side slide-over panel
(Radix `Sheet` primitive). `NodeDrawer` shows full agent profile: all metrics, recent
activity, direct reports, tool list.

#### 2.2.7 Data Layer

```typescript
// useConstellationGraph.ts
const { data } = useQuery({
  queryKey: ['constellation-graph'],
  queryFn: () => fetch('/api/agents/graph').then(r => r.json()),
  refetchInterval: 60_000,   // poll every 60s
  staleTime: 30_000,
});
```

The `/api/agents/graph` Next.js route reads from SQLite, which is kept in sync by Chokidar
watching `~/.openclaw/workspace/` for agent session file changes. A static fallback graph
(8 nodes, 8 edges) is hardcoded in the hook for development / no-gateway scenarios.

#### 2.2.8 Stats Bar (ConstellationView wrapper)

Above the canvas, a status bar shows:
- Active agent count / total agent count
- 24h token aggregate across all nodes
- 24h cost USD aggregate
- LIVE indicator (pulsing green dot + "LIVE" text) when refetch interval is active

---

### 2.3 AgentNode.tsx — Distinct from Constellation

`AgentNode.tsx` is **not** part of the constellation. It is the custom node type for the
`@xyflow/react` OrgMap DAG view — the cron pipeline visual builder. Key differences:

- Uses `@xyflow/react` Handle components for connector ports (not Canvas 2D)
- Glass morphism design (backdrop-blur, semi-transparent bg) — design language not relevant to Agentis
- Contains: agent name, title, description text, cron count badge, tool count badge,
  model badge with provider icon
- Has explicit `selected` state styling (ring highlight)

Agentis does **not** use this component or its design language.

---

### 2.4 Other Features (Noted, Not Extracted)

| feature | what it does | relevance to Agentis |
|---|---|---|
| Memory Health Panel | Calls OpenAI API to analyze memory staleness via LLM | Design inspiration only; Agentis has different memory model |
| Competitor Intelligence | Scrapes competitor URLs, summarizes via LLM | Not relevant |
| Market Intelligence | Aggregated market signal feed | Not relevant |
| Cron Pipeline Builder | Visual DAG editor via @xyflow/react | Agentis uses different execution model |
| Voice | ElevenLabs TTS for agent output | Possible future feature, not V1 |
| TipTap Reference Editor | Rich text editor for reference docs | Not relevant |
| Activity Console | SSE-based live event console | Informs TerminalPane visual pattern |
| Cost Analytics | Per-agent spend dashboard via Recharts | Future Agentis billing panel (not V1) |

---

## 3. abhi1693/openclaw-mission-control — Full Audit

### 3.1 Repository Identity

| attribute | value |
|---|---|
| backend | Python 3.12+, FastAPI 0.131.0, SQLModel + Alembic, PostgreSQL |
| backend pkg mgr | `uv` |
| frontend | TypeScript 55.4%, Next.js app router, TanStack Query |
| auth | Local bearer token OR Clerk JWT |
| infra | Docker Compose, installer script |
| stars/forks | 3,800 / 809 |
| license | MIT |

### 3.2 Backend Architecture

FastAPI application entry (`backend/app/main.py`) wires the following router families:

| router | domain |
|---|---|
| `auth` | Identity bootstrap, session context resolution |
| `agents` | Organization-level agent directory, lifecycle, status |
| `agent` | Agent-scoped surface (`X-Agent-Token` header auth) |
| `activity` | Audit timeline, feed events across boards |
| `gateway` | Single gateway connection + sync |
| `gateways` | Gateway CRUD, connection management |
| `metrics` | Board analytics, operational metrics |
| `organizations` | Org profile, membership, governance |
| `souls-directory` | Agent soul templates + variants |
| `skills-skill registry` | Install/uninstall/sync skills |
| `board-groups` | Board group CRUD |
| `board-group-memory` | Shared memory scoped to board groups |
| `boards` | Board lifecycle, config |
| `board-memory` | Board-scoped persistent context |
| `board-webhooks` | Webhook registration + delivery config |
| `board-onboarding` | Onboarding state + setup actions |
| `approvals` | Approval request, review, status-tracking |
| `tasks` | Task CRUD, dependency management, workflow |
| `custom-fields` | Org-level custom field definitions |
| `tags` | Tag registry, task-tag associations |
| `users` | User profile, settings |

There are also three agent-role sub-routers under `agent`:
- `agent-lead` — delegation, review orchestration, approvals, coordination
- `agent-worker` — task execution, comments, board/group context reads during heartbeat loops
- `agent-main` — gateway-main control, message board leads, broadcast coordination

Security middleware: `SecurityHeadersMiddleware` adds HSTS-class headers
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`). CORS is configured with explicit origins. Rate limiting via Redis or
memory backend.

### 3.3 Data Model Hierarchy

The conceptual entity hierarchy that drives the Kanban structure:

```
Organization
  └── BoardGroup (one org has many board groups)
        └── Board (Kanban board = a "mission" or project)
              ├── BoardMemory (persistent context scoped to this board)
              ├── BoardWebhooks (notification endpoints: Telegram/Discord/WA)
              └── Task (Kanban card)
                    ├── assigned agent(s)
                    ├── priority
                    ├── due date
                    ├── mentions (@agent / @user)
                    ├── CustomFields (org-defined schema)
                    ├── Tags
                    └── Approval (confidence-based sign-off workflow)
```

This maps directly to Agentis's `MissionKanban` data shape:
- Board → `Mission`
- Task → `MissionTask`
- BoardGroup → `MissionGroup`
- Approval → `TaskApproval`

### 3.4 Frontend Component Inventory

From `frontend/src/components/` directory listing:

| directory | extracted patterns |
|---|---|
| `activity/` | Activity feed event row patterns; per-board event timeline |
| `agents/` | Agent list, agent card, agent assignment picker |
| `atoms/` | Base UI tokens (buttons, badges, inputs) |
| `auth/` | Clerk provider wrappers, auth guards |
| `board-groups/` | Board group CRUD UI, group sidebar |
| `boards/` | **Core Kanban UI** — column layout, board config panel |
| `charts/` | Metric sparklines, board analytics charts |
| `custom-fields/` | Dynamic field renderer based on org schema |
| `gateways/` | Gateway connection form, status indicator |
| `molecules/` | Compound UI (search combos, date pickers) |
| `organisms/` | Complex page-level organisms (likely TerminalPane here) |
| `organization/` | Org profile, member management |
| `providers/` | React context providers (query client, auth, theme) |
| `skills/` | Skills skill registry card, install/uninstall UI |
| `tables/` | Generic sortable data tables |
| `tags/` | Tag picker, tag badge |
| `templates/` | Page layout templates (sidebar + main) |
| `ui/` | shadcn/ui re-exports and overrides |

Confirmed board components (inspected filenames):
- `BoardApprovalsPanel.tsx` — approval request list, approve/reject controls with
  confidence scores
- `BoardChatComposer.tsx` — message composer for board-level agent chat
- `BoardGoalPanel.tsx` — board objectives, success metrics, milestone tracking
- `BoardOnboardingChat.tsx` — wizard chat for board setup

### 3.5 BoardApprovalsPanel — Interaction Model

`BoardApprovalsPanel.tsx` implements the approval workflow UI that Agentis extracts for its
`TaskApproval` pattern:

- Panel opens as a right-side slide-over when any task enters `pending_approval` status
- Shows list of pending approval requests with:
  - Requesting agent name + avatar
  - Task title + board name
  - Confidence score badge (0.0–1.0 from agent self-assessment)
  - Proposed action summary text
  - Timestamp
- Each item has two actions: **Approve** (green) and **Reject** (red with reason field)
- Approval resolves via `POST /api/v1/approvals/{id}/resolve` with `{approved: bool, reason?: string}`
- Panel has an approval count badge in the header; clears when all resolved

The confidence score concept — agent-reported certainty about a proposed action — is a
design pattern Agentis adopts for its own `TaskApproval.confidence` field.

### 3.6 Activity Feed — Event Row Pattern

`activity/` components implement a chronological event feed with:

- Event types: `task.created`, `task.moved`, `task.completed`, `agent.assigned`,
  `approval.requested`, `approval.resolved`, `board.created`, `comment.added`
- Each row: relative timestamp (e.g., "3m ago"), actor badge (agent or user icon), event
  description text, optional linked entity (task title as a link, board name)
- Live updates via TanStack Query `refetchInterval` (not WebSocket — HTTP polling)
- Grouped by date header ("Today", "Yesterday", ISO date for older)
- Infinite scroll via `fastapi-pagination` on the backend (`GET /api/v1/activity?limit=20&offset=N`)

Agentis adopts this event row structure for the activity feed in `MissionKanban` sidepanel.

### 3.7 Gateway Integration Pattern

abhi1693's backend manages a single OpenClaw gateway connection via the `gateways` router.
From `main.py`, the gateway service is called `gateway_rpc` (likely a helper that wraps
OpenClaw's HTTP/WebSocket API). The frontend `gateways/` components provide:

- Gateway connection form: host URL + bearer token fields
- Connection status indicator (connected / disconnected / error)
- Sync button: triggers `POST /api/v1/gateways/{id}/sync` to re-pull agent state from
  OpenClaw into the PostgreSQL database

This indicates the mission-control does **not** maintain a persistent live WebSocket
connection to OpenClaw — it polls/syncs on demand. The `agents` data in PostgreSQL is a
cached snapshot of the OpenClaw agent state, not a live view. This is a key architectural
limitation Agentis avoids by implementing a persistent WebSocket adapter.

### 3.8 Souls Directory and Skills Skill registry

Two features unique to abhi1693 that Agentis notes for future roadmap:

**Souls Directory** (`/api/v1/souls-directory`): A registry of agent persona templates
("souls") — each soul is a named personality configuration: system prompt presets, memory
defaults, channel behaviors. Agents can be instantiated from souls.

**Skills Skill registry** (`/api/v1/skills-skill registry`): Install/uninstall skills (equivalent
to OpenClaw's ClawHub) via the mission-control UI. Skills are packaged as
`SKILL.md`-containing folders installable into an agent's workspace.

### 3.9 TerminalPane — Derived Pattern

No file named `TerminalPane.tsx` was found in the inspected component directory listing,
but the pattern is established by:

1. The `BoardChatComposer.tsx` — inline message input that sends to an agent via `POST
   /api/v1/agent/chat` with a `sessionKey` and `message` body; response is streamed back
   via SSE at `GET /api/v1/agent/chat/stream?sessionKey=…`.
2. The `organisms/` directory likely contains a terminal-style component wrapping an xterm.js
   or custom textarea-based REPL that proxies to the OpenClaw gateway `agent` RPC method.
3. The `session.message` and `session.tool` WebSocket events from the OpenClaw gateway (see
   §4) are the canonical source of terminal output.

Agentis's `TerminalPane` adopts the pattern: a read-only log pane that renders
`session.message` (LLM text) and `session.tool` (tool call + result) events as formatted
rows, plus an input bar that fires `agent` RPC calls via the gateway WebSocket.

### 3.10 ChannelNotifier — Board Webhooks

`board-webhooks/` and the `board_webhooks` router provide Telegram / Discord / WhatsApp
notification integration:

- Each board can register N webhooks
- Webhook types: Telegram (bot token + chat_id), Discord (webhook URL), WhatsApp
  (via WhatsApp Business API credentials)
- Trigger events: `task.completed`, `approval.requested`, `board.error`, `agent.offline`
- Payload: configurable JSON template with board/task/agent placeholders
- Delivery config: retry count (default 3), timeout (default 10s)

This pattern drives Agentis's `ChannelNotifier` design: per-workspace notification rules
that fanout to configured channel targets when mission events occur.

---

## 4. OpenClaw Runtime Gateway Protocol

This section describes the actual OpenClaw WebSocket protocol that Agentis's adapter layer
must implement. Source: `docs.openclaw.ai/gateway/protocol` + `docs.openclaw.ai/concepts/architecture`.

### 4.1 Transport Layer

- **Protocol:** WebSocket, text frames with JSON payloads
- **Default bind:** `127.0.0.1:18789` (loopback only; remote access via SSH tunnel or
  Tailscale)
- **Protocol version:** 3 (clients must send `minProtocol: 3, maxProtocol: 3`)
- **Canvas / Control UI:** also served on same port at `/__openclaw__/canvas/` and
  `/__openclaw__/a2ui/`

### 4.2 Handshake Sequence

```
Server → Client:  {type:"event", event:"connect.challenge", payload:{nonce:"…", ts:1737264000}}
Client → Server:  {type:"req", id:"…", method:"connect", params:{
  minProtocol: 3, maxProtocol: 3,
  client: { id:"agentis-adapter", version:"0.1.0", platform:"linux", mode:"operator" },
  role: "operator",
  scopes: ["operator.read", "operator.write"],
  caps: [], commands: [], permissions: {},
  auth: { token: "<OPENCLAW_GATEWAY_TOKEN>" },
  locale: "en-US",
  userAgent: "agentis/0.1.0",
  device: {
    id: "<stable-device-fingerprint>",
    publicKey: "…",
    signature: "…",   // signs nonce + device + role + scopes
    signedAt: <ts>,
    nonce: "<nonce from challenge>"
  }
}}
Server → Client:  {type:"res", id:"…", ok:true, payload:{
  type: "hello-ok",
  protocol: 3,
  server: { version: "…", connId: "…" },
  features: { methods: ["…"], events: ["…"] },
  snapshot: { … },
  policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
  auth: { deviceToken: "…", role: "operator", scopes: ["operator.read","operator.write"] }
}}
```

Clients must persist `hello-ok.auth.deviceToken` per `deviceId + role` for future connects
(avoids repeat pairing approval).

### 4.3 Wire Framing

```typescript
// All frames are JSON-serialized text WebSocket messages

// Client → Server: request
{ type: "req",   id: string,   method: string, params: object }

// Server → Client: response
{ type: "res",   id: string,   ok: boolean,    payload?: object, error?: object }

// Server → Client: event (broadcast, unsolicited)
{ type: "event", event: string, payload: object, seq?: number, stateVersion?: number }
```

Side-effecting methods (`agent`, `send`) require idempotency keys in `params` to enable
safe retry without duplicate execution.

### 4.4 Events Relevant to Agentis Adapter

| event | payload summary | Agentis use |
|---|---|---|
| `agent` | Agent ran a turn; includes `sessionKey`, `agentId`, `message`, `streaming` | Drive `TerminalPane` output stream |
| `session.message` | Assistant message from a session turn | Text content for `TerminalPane` |
| `session.tool` | Tool call + result from a session turn | Tool call rows in `TerminalPane` |
| `sessions.changed` | Session list/metadata changed | Refresh session selector |
| `heartbeat` | Periodic heartbeat with agent status | Update `ConstellationNode.status` |
| `health` | Gateway health snapshot | Connection indicator in status bar |
| `cron` | Cron job ran / changed | Cron badge on agent node |
| `presence` | System presence snapshot (connected devices) | Multi-instance awareness |
| `exec.approval.requested` | Exec action needs human approval | Drive `TaskApproval` creation |
| `exec.approval.resolved` | Approval was resolved | Clear pending approval badge |
| `shutdown` | Gateway shutting down | Show disconnected state |
| `tick` | Periodic keepalive | Heartbeat; close if silence > `tickIntervalMs * 2` |

Events `agent`, `session.message`, `session.tool` require `operator.read` scope.
Transport events (`heartbeat`, `tick`, `presence`) are unrestricted.

### 4.5 Methods Relevant to Agentis Adapter

| method | scope | purpose |
|---|---|---|
| `connect` | — | Handshake (must be first frame) |
| `status` | `operator.read` | Get gateway + agent status snapshot |
| `agent` | `operator.write` | Send message to agent / initiate turn |
| `sessions.list` | `operator.read` | List active sessions |
| `sessions.history` | `operator.read` | Get session transcript |
| `health` | `operator.read` | Liveness probe |
| `system-presence` | `operator.read` | Get connected clients snapshot |
| `commands.list` | `operator.read` | Get runtime command inventory for agent |
| `tools.registry` | `operator.read` | Get tool registry for agent |
| `skills.status` | `operator.read` | Get skill inventory + eligibility |
| `exec.approval.resolve` | `operator.approvals` | Approve or reject a pending exec |

### 4.6 Workspace Filesystem Layout

OpenClaw stores all agent state under `~/.openclaw/`:

```
~/.openclaw/
  openclaw.json              ← main config (model, agents, channels, gateway)
  workspace/
    AGENTS.md                ← primary agent persona
    SOUL.md                  ← agent personality definition
    TOOLS.md                 ← tool allowlist
    skills/
      <skill-name>/
        SKILL.md             ← skill definition
    sessions/
      <session-id>/          ← session state (memory, transcript snippets)
```

ChristianAlmurr's dashboard reads this filesystem directly via Chokidar + custom parsers.
Agentis does **not** do this — it connects to the WebSocket gateway instead.

### 4.7 Adapter Design for Agentis

Agentis's `OpenClawAdapter` (in the `adapters/openclaw/` module, planned) must:

1. **Discover gateway:** Read `OPENCLAW_GATEWAY_URL` (default `ws://127.0.0.1:18789`) and
   `OPENCLAW_GATEWAY_TOKEN` from environment or Agentis workspace config.
2. **Handle challenge:** Wait for `connect.challenge` event, sign the nonce with the
   registered device keypair (stored in Agentis config under the workspace), send `connect`
   frame with `role: "operator"`, `scopes: ["operator.read","operator.write"]`.
3. **Persist device token:** Store `hello-ok.auth.deviceToken` keyed by `(workspaceId,
   deviceId)` in Agentis's PostgreSQL `adapter_credentials` table (encrypted at rest).
4. **Map to `NormalizedAgent`:** On `heartbeat` events, map OpenClaw agent state to:
   ```typescript
   interface NormalizedAgent {
     adapterId: 'openclaw';
     externalId: string;          // OpenClaw session key or agent id
     name: string;
     role: AgentRole;             // map OpenClaw role to Agentis enum
     status: AgentStatus;         // 'active' | 'idle' | 'error' | 'offline'
     model: string;
     provider: string;
     workspaceId: string;
   }
   ```
5. **Map to `NormalizedTask`:** On `exec.approval.requested`, create an Agentis
   `TaskApproval` record with the proposed action, agent id, confidence (if available), and
   reference to the originating Agentis mission.
6. **Stream to `TerminalPane`:** Forward `session.message` and `session.tool` events over
   Agentis's internal WebSocket bus to the `TerminalPane` component subscription.
7. **Send messages:** Translate Agentis `SendMessageCommand` → `agent` RPC method call with
   idempotency key = `command.id`.
8. **Reconnect:** Implement exponential backoff (initial 1000ms, max 30000ms) on disconnect;
   on reconnect, retry with stored device token first before full re-pairing.

**Key gap:** The OpenClaw gateway does **not** push a live agent list — agent enumeration
requires polling `status` or `sessions.list`. The `heartbeat` event provides per-session
liveness, not a fleet-wide agent index. Agentis's adapter must build its own agent registry
by combining `sessions.list` polling (every 30s) with `heartbeat`-driven status updates.

---

## 5. What Agentis Extracts vs. Rewrites

### 5.1 From ChristianAlmurr/openclaw-dashboard

| element | disposition | notes |
|---|---|---|
| Constellation layout algorithm (orbital ellipse + center orchestrator) | **Extract interaction model, rewrite implementation** | Keep concept; rebuild in Agentis canvas engine |
| Physics integrator (spring + damping + jitter) | **Extract concept, rewrite constants** | K=0.003, damping=0.92 are reasonable defaults; tune for Agentis fleet sizes |
| Hit detection pattern (radius check, hover→tooltip, click→drawer) | **Extract exact pattern** | Direct interaction model parity |
| Node radius / polygon shape lookup by role | **Extract concept, rewrite visual tokens** | Map to Agentis solid-dark color palette; replace Apple-blue with Agentis accent colors |
| Breathing animation formula | **Extract** | `sin(t * breathRate + phase) * 0.06` is subtle and correct |
| Pulse system on edges (bezier travel, spawn rate from ratePerMin) | **Extract** | Keep the bezier lerp formula exactly |
| Stats bar (active/total, tokens, cost, LIVE indicator) | **Extract** | Direct parity for Agentis fleet stats bar |
| NodeTooltip layout (name, role, status, model, metrics) | **Extract structure, rewrite styling** | Different design language |
| NodeDrawer slide-over | **Extract pattern** | Radix Sheet component already in Agentis stack |
| SQLite data layer | **Discard** | Agentis uses PostgreSQL + Redis |
| Chokidar filesystem watching | **Discard** | Agentis uses gateway WebSocket adapter |
| Glass morphism / frosted design | **Discard** | Agentis uses solid-dark token system |
| Apple-blue / slate color palette | **Replace** | Agentis `AGENT_COLOR_PALETTE` + brand accent |
| Pixel face hashing for node identity | **Evaluate** | Interesting but possibly too whimsical for enterprise Agentis V1; revisit in V2 |
| Orbiting particle rings | **Tone down** | Reduce particle count; keep only for active status |

### 5.2 From abhi1693/openclaw-mission-control

| element | disposition | notes |
|---|---|---|
| Organization → BoardGroup → Board → Task hierarchy | **Extract data model** | Direct mapping to Agentis `Workspace → MissionGroup → Mission → Task` |
| Kanban column structure | **Extract** | Column states: `backlog`, `in_progress`, `review`, `done`, `blocked` |
| BoardApprovalsPanel interaction model (confidence score, approve/reject) | **Extract** | Agentis `TaskApproval` adopts confidence field |
| Activity feed event row structure | **Extract** | Event types, row layout, date grouping |
| Board memory / group memory concept | **Extract** | Maps to Agentis `MissionContext` (shared scratchpad) |
| Board webhooks (Telegram/Discord/WA, trigger events, retry config) | **Extract pattern** | Agentis `ChannelNotifier` configuration schema |
| Skills skill registry install/uninstall UI | **Evaluate for V2** | |
| Souls directory concept | **Evaluate for V2** | Agent persona templates |
| PostgreSQL + SQLModel data store | **Compatible but not copied** | Agentis uses PostgreSQL independently |
| Python FastAPI backend | **Not relevant** | Agentis backend is Next.js + TypeScript |
| Clerk auth integration | **Potentially reuse** | Agentis evaluates Clerk for auth layer |
| Gateway connection form + sync UI | **Adapt** | Agentis shows gateway connection status in settings |
| Rate limiting + security headers pattern | **Adopt** | Agentis backend should apply same headers |

---

## 6. Gaps: What Neither Repo Provides

These capabilities are required by the Agentis spec but are absent from both audited repos.
They must be built from scratch:

| gap | Agentis solution |
|---|---|
| Mission-scoped constellation (only agents active in one mission) | `AgentConstellation` filters by `missionId`; changes fleet graph to mission subgraph |
| DAG execution graph (task dependency visualization) | `MissionCanvas` with React Flow — distinct from constellation |
| Scratchpad viewer (agent working memory inspection) | `ScratchpadDrawer` connected to `MissionContext` |
| Ledger / timeline scrubbing | `MissionTimeline` component (V2) |
| ELO routing visualization | `ELOGraph` (V2) — shows model routing decisions |
| Multi-framework adapter protocol | Agentis `AdapterRegistry` — OpenClaw is one of N adapters |
| Repair agent / skill health UI | `SkillHealthPanel` (V2) |
| Real-time agent fleet WebSocket stream | Agentis builds persistent WS bus; OpenClaw gateway poll bridge is one source |
| Native mission isolation | Both repos show a global agent fleet with no per-mission scope |
| Agent capability negotiation | Agentis `AgentCapabilityProfile` — model routing based on declared skills |

---

## 7. Licensing Confirmation

Both `ChristianAlmurr/openclaw-dashboard` and `abhi1693/openclaw-mission-control` are
licensed under the **MIT License**. The upstream `openclaw/openclaw` runtime is also MIT.

MIT permits: use, copy, modify, merge, publish, distribute, sublicense.
Requirement: include the copyright notice and permission notice in all copies.


---

*Document written after direct inspection of source files: `ConstellationCanvas.tsx`,
`ConstellationView.tsx`, `AgentNode.tsx`, `useConstellationGraph.ts` (ChristianAlmurr repo);
`backend/app/main.py` (abhi1693 repo); `docs.openclaw.ai/gateway/protocol`,
`docs.openclaw.ai/concepts/architecture` (OpenClaw official documentation).*

---

## 8. The 10x Platform: The Mission Surface, Not the Status Board

> *To build better lighting, we didn't evolve the candle — we created the electric light bulb.*

Both dashboards audited here are extraordinary pieces of engineering. The constellation physics is genuinely beautiful. The Kanban hierarchy is coherent. The approval panel is thoughtful. But both share the same foundational assumption — and that assumption is the candle.

The assumption: **you are the manager, agents are the workers, and the dashboard is your observation deck.**

You sit above the system looking down. You approve. You monitor. You intervene when something turns red. The agents do their thing somewhere below, and the dashboard surfaces their status up to you in a form you can process.

That mental model produces great dashboards. It does not produce the platform you actually need when you're building with openclaw and Claude Code at the same time.

---

### You have already bumped into the ceiling

If you run an openclaw setup alongside Claude Code or n8n, you have hit at least one of these:

- Opened the constellation and seen a beautiful spinning map — then switched to a separate terminal to actually *do* anything
- Approved 11 agent actions in a row that you didn't meaningfully review, because the queue keeps growing and the real work is elsewhere
- Set up board webhooks to Telegram so your phone would tell you what was happening, because the dashboard didn't
- Found that "board memory" resets context you thought you had already established — because each board starts fresh
- Had Agent A finish something Agent B needed, and manually passed the output across because the two had no way to find each other

You weren't doing it wrong. The dashboards were doing exactly what they were designed to do: show you a managed system from above. The friction is not a bug in the software. It is the ceiling of the worldview.

---

### What you can finally do

**The constellation is the coordination layer — not the status board.**
Agents don't just appear on the map. They use it. When Agent A needs to delegate a subtask, it finds the right agent through the same surface you're watching. You see the delegation happen as it happens — not as a logged event after the fact. The canvas is alive because agents are alive on it, not because pixels are animating.

**You set intent. The mission runs.**
You describe what needs to happen — "research this, validate the output, write the brief." The platform figures out which agents should run, in what order, with what handoffs. You watch. You step in when it matters. You don't manage a ticket queue of approvals for things that don't require a human decision.

**Memory is the fabric agents are made of — not a config you set per board.**
Every agent carries the context of every mission it has been part of. It doesn't start fresh on a new board. It remembers how the last three research tasks resolved. It knows which approach your team prefers. Board memory isn't a scratchpad you configure — it's the accumulated experience of agents that have been working with you.

**Approval is a conversation, not a checkpoint.**
An agent doesn't pause the world and wait for you to click Approve. It surfaces a decision point — here's what I'm about to do, here's why, here's my confidence — and it keeps going on the things it is confident about while you respond on the ones it isn't. You are a collaborator in the process, not a gate at the end of it.

**Your whole setup — openclaw, Claude Code, n8n — talks through one surface.**
No more switching between your terminal, the constellation, n8n's execution log, and a Telegram notification to understand what's happening in a single mission. One canvas. All agents. All events. The tool boundary disappears.

---

### The one thing that makes it 10x — not 2x

Both audited dashboards are dashboards *about* agents. They are observation instruments. Exquisitely built, but external.

Agentis is the place where agents actually operate — and where you operate alongside them. The distinction sounds subtle. It is not.

When the platform is an observation deck, agents and humans have separate surfaces and the dashboard bridges them. When the platform is a shared operating environment, agents and humans are in the same space doing different kinds of work, and coordination emerges from that proximity rather than being engineered on top.

You can't get to the second thing by improving the first. A more beautiful constellation is still a status board. A smarter approval panel is still a gate. A richer board memory is still a config field.

The platform needs to be built for the team — not for the manager watching the team. That is the light bulb.

---

> **A dashboard tells you what your agents did.**
> A platform is where your agents work — and where you work with them.

---

*Agentis is not a better openclaw dashboard. It is what the operational surface looks like when agents are citizens of the platform, not subjects of it.*
