# Agent Commissioning — Complete Replan

> **Status**: Implemented — all phases complete
> **Date**: May 14, 2026
> **Scope**: `AgentCreateWizard.tsx`, `RuntimePicker.tsx`, `harnessProbe.ts`, new `HarnessInstallSlideOver.tsx`, new `/v1/harness/install` SSE endpoint, `packages/cli/src/commands/bootstrap.ts`, new `POST /v1/bootstrap`
> **Predecessors**: `AGENT-CREATE-WIZARD-REPLAN.md` (wizard UX fixes — still valid). `HOME-WORKSPACE-CANVAS-REPLAN.md` (canvas as primary surface — defines the "moment after" commissioning). This doc covers: runtime detection that actually works, in-app install with live progress, wizard steps that match Agentis's command-hierarchy DNA, and a perfect zero-ambiguity path for AI agents setting up Agentis for their operator.
> **Thesis**: Commissioning an agent is a hiring act — you are placing a mind into a position in your command hierarchy. The wizard should feel like that. The canvas should show the result. If the runtime is already installed, the wizard should detect and pre-select it before the user finishes typing the agent's name. If it is not installed, install it right here. When an AI agent does the setup, it speaks directly to the API with a single canonical command.

---

## 0. The Problem Today

| Pain point | File | Symptom |
|---|---|---|
| Installed runtimes not detected | `harnessProbe.ts` | `probeBinary('claude')` and `probeBinary('codex')` fail silently on Windows because npm global installs land in `%APPDATA%\Roaming\npm` which is absent from Node's inherited PATH |
| Detection result not used | `RuntimePicker.tsx` | Detection result shown as a badge only — no fields auto-filled, no adapter pre-selected |
| No install path | Nowhere | When a runtime is `not_found`, the only guidance is a static string; user must leave the browser, run it manually, come back |
| Wizard steps fight the hierarchy | `AgentCreateWizard.tsx` | Identity and runtime are mixed into one step. The agent's position in the command chain — who it reports to, what it commands — is an afterthought |
| No playbook step | `AgentCreateWizard.tsx` | Agents are commissioned without behavioral instructions. A harness without a playbook is a brain without a job description |
| No budget in wizard | `AgentCreateWizard.tsx` | `monthlyBudgetCents` is core Agentis infrastructure but absent from the commissioning flow |
| Commission ends in a toast | `AgentCreateWizard.tsx` | After commission the agent exists in a database row. It should appear — with a FLIP animation — in the authority tree on the home canvas |
| Ghost nodes have no direct action | `HOME-WORKSPACE-CANVAS-REPLAN.md` | Ghost nodes signal missing slots in the hierarchy but cannot be clicked to open the wizard pre-configured for that slot |
| Channel setup deferred | Everywhere | The orchestrator's inbox (Telegram/Discord/Slack) is configured in a separate Settings journey; it should be wired during commissioning |
| Agent-driven path has no canonical CLI | Everywhere | When Claude Code or Codex tries to set up Agentis for the operator, it must guess API shapes from README snippets — no `agentis bootstrap` command exists |
| OpenClaw gateway not prompted | `AgentCreateWizard.tsx` | Selecting OpenClaw with no gateway silently disables the commission button; no guidance given |

---

## 1. Mental Model — Commissioning as a Hiring Act

> The sections below describe the experience and architecture from this mental model outward.

Commissioning an agent is placing a mind into a position in your command hierarchy. The wizard must reflect this:

- **Role comes first.** Is this agent the workspace brain, a domain manager, or a task executor?
- **Chain of command is immediate.** The moment role is selected, the hierarchy slot becomes clear — who this agent reports to, what tier it occupies.
- **The harness is chosen second.** Once we know *who* the agent is, we choose *how* it runs.
- **The playbook is given third.** What are this agent's standing instructions, personality, and operating parameters?
- **The moment after matters.** When commissioning completes, the agent takes its place in the hierarchy on the home canvas. The tree assembles with it in it.

---

## 2. The New Commissioning Flow (Human Path)

### 1.1 Four visible steps

```
Step 1 — IDENTITY   Name · Role · Position in hierarchy · Avatar
Step 2 — RUNTIME    Harness — auto-selected if detected; install inline if not
Step 3 — PLAYBOOK   Instructions template + model override + budget cap
Step 4 — COMMISSION Summary + fire

(Detection runs silently in background during step 1 — no extra step)
(Orchestrator inbox wired inline in step 1 — not a separate step)
```

Workers get 3 bars (no inbox). Orchestrators and managers get 4 bars.

**Why identity first:** The command hierarchy is the core Agentis concept. The role and reporting chain answer "who is this agent?" before we ever ask "what software does it run?" Getting the harness right before knowing the role inverts this — it optimizes for plumbing over purpose.

### 1.2 Background detection — fires on open, invisible

On `open`, immediately fire `GET /v1/harness/detect` in parallel with loading agents. Do not await it before showing step 1. By the time the user completes identity, detection is done.

```ts
useEffect(() => {
  if (!open) return;
  void Promise.allSettled([
    api<{ agents: ExistingAgent[] }>('/v1/agents'),
    api<{ adapters: HarnessDetectionResult[] }>('/v1/harness/detect'),
  ]).then(([agentsRes, detectRes]) => {
    setAgents(agentsRes.status === 'fulfilled' ? agentsRes.value.agents : []);
    setDetections(detectRes.status === 'fulfilled' ? detectRes.value.adapters : []);
  });
}, [open]);
```

### 1.3 Step 1 — Identity

Four fields + hierarchy assignment + optional orchestrator inbox.

#### 1.3.1 Fields

| Field | Notes |
|---|---|
| Avatar | Upload circle with permanent camera overlay at bottom-right (always clickable) |
| Name | Required, min 2 chars |
| Role | `orchestrator` / `manager` / `worker` — drives everything below |
| Description | One-liner: "What does this agent do?" |

Role selection uses the existing geometric SVG glyphs (hexagon/diamond/square from `AGENT-CREATE-WIZARD-REPLAN.md §4`). Color auto-assigned by role: `orchestrator: #8b5cf6`, `manager: #06b6d4`, `worker: #60a5fa`.

#### 1.3.2 Hierarchy context — role-driven

**Orchestrator selected:**
```
This will be the workspace brain. One orchestrator per workspace.
[hexagon glyph, violet crown]
No "Reports to" field shown.
```

If an orchestrator already exists → show a blocking notice:
```
[!] A workspace brain already exists: "The Brain"
    Add this agent as a manager reporting to it instead.
```

**Manager selected:**
```
Reports to:  [Orchestrator select, defaulting to existing orchestrator]
```

If no orchestrator exists:
```
[!] Commission your orchestrator first — managers need a brain to report to.
    [Commission orchestrator →]   (opens wizard pre-set to orchestrator role)
```

**Worker selected:**
```
Supervised by:  [Manager select, defaulting to first manager]
```

#### 1.3.3 Orchestrator inbox (orchestrator role only)

Below the hierarchy section for orchestrators only — a compact collapsed accordion:

```
[+] Connect your inbox  (optional — set up Telegram, Discord, Slack, or WhatsApp)
```

Expanded:
```
Telegram  [Not set]  >
Discord   [Not set]  >
Slack     [Not set]  >
WhatsApp  [Not set]  >

Configure later in Settings > Channels.
```

Expanding a provider row shows the inline form (bot token, chat ID, "How do I find this?" guide). Channels are **saved immediately on entry, before commission** — they are workspace-level objects that will be linked to the agent ID after creation. This matches the existing `POST /v1/channels` contract.

**Why inbox is in Identity, not a separate step:** Channels are *who can reach the orchestrator*, which is about identity and role, not about the runtime. Telegram/Discord/Slack are the agent's phone number — they belong next to "who is this agent" not "how does this agent run."

### 1.4 Step 2 — Runtime

#### 1.4.1 Layout

Three zones:

```
+------------------------------------------------------------------+
|  FOUND ON THIS MACHINE            (hidden if nothing detected)   |
|  +------------------+  +------------------+                      |
|  |  [claude icon]   |  |  [codex icon]    |                      |
|  |  Claude Code     |  |  Codex           |                      |
|  |  v1.0.3  Ready   |  |  v2.3.1  Ready   |                      |
|  |  [Select]        |  |  [Select]        |                      |
|  +------------------+  +------------------+                      |
+------------------------------------------------------------------+
|  ALL RUNTIMES                                                     |
|  +------+  +------+  +------+  +------+  +------+  +------+     |
|  |Claw  |  |Hermes|  |Claude|  |Codex |  |Cursor|  | HTTP |     |
|  | --   |  |  --  |  |Ready |  |Ready |  |  --  |  |  --  |     |
|  +------+  +------+  +------+  +------+  +------+  +------+     |
+------------------------------------------------------------------+
|  SELECTED: Claude Code  v1.0.3                                    |
|  Binary path   [/usr/local/bin/claude   pre-filled]              |
|  > Override model ID  (optional, collapsed)                      |
|  > Connection details (collapsed; auto-expands if not detected)  |
|                                                                   |
|  [Test connection]  [Reinstall]                                   |
+------------------------------------------------------------------+
```

#### 1.4.2 Detection → auto-select

- If **exactly one** runtime is `found`: auto-select it silently, pre-fill `binaryPath` + `detectedModel`. Show a `Detected and selected` notice in the section header.
- If **multiple** found: show "Found on this machine" section; default selection = first detected; user can switch.
- If **none** found: hide "Found on this machine" section; show only "All runtimes" with `Not installed` badges.

#### 1.4.3 Pre-fill from detection

When a detected runtime is selected, immediately write to form state:
- `binaryPath` ← `detection.binaryPath` (resolved absolute path)
- `modelOverride` ← `detection.detectedModel` (left empty if harness uses its own default)

Both fields remain editable. The user can override either.

#### 1.4.4 Install slide-over — the missing piece

Every `Not installed` tile shows an `Install` button. Clicking opens `HarnessInstallSlideOver` (§4.2) — a right-anchored slide-over with a live step list.

On install `complete`: detection auto-reruns, tile flips to `Installed`, slide-over closes, adapter is auto-selected.

#### 1.4.5 OpenClaw gateway gate

Selecting OpenClaw when no gateway is configured in the workspace shows a blocking state instead of the config form:

```
+----------------------------------------------------------+
|  [OpenClaw icon]                                         |
|  OpenClaw needs a gateway to connect.                    |
|  A gateway is an OpenClaw server that owns your agent    |
|  sessions, channels, and connectivity.                   |
|                                                          |
|  [Connect a gateway →]   [What is OpenClaw?]            |
+----------------------------------------------------------+
```

"Connect a gateway" opens a gateway slide-over inline (URL + WebSocket test). On success, gateway is saved and OpenClaw becomes selectable.

### 1.5 Step 3 — Playbook

The playbook is the agent's job description, personality, and standing instructions. It is what separates an orchestrator from a blank subprocess.

#### 1.5.1 Template picker

Uses the existing `PlaybookLibrary` component. Templates are keyed to the agent's role — orchestrators see orchestrator templates, workers see worker templates.

```
Start from a template:
+------------------+  +------------------+  +------------------+
|  Workspace Brain |  |  Marketing Lead  |  |  Research Worker |
|  Orchestrator    |  |  Manager         |  |  Worker          |
+------------------+  +------------------+  +------------------+
[or start blank]
```

Clicking a template fills `PlaybookEditor` and pre-fills capability tags.

#### 1.5.2 Playbook editor

`PlaybookEditor` — existing component. Markdown, min 0 chars (playbook can be blank but a notice says: "Without instructions, this agent will follow only what tasks assign it.").

#### 1.5.3 Monthly budget

```
Monthly budget    [$  500  ]   per calendar month across all tasks
```

`monthlyBudgetCents` — default `$500`. User can set to blank (unlimited) or a lower value. This is the Agentis cost-control knob and must not be omitted from commissioning.

### 1.6 Step 4 — Commission

A clean summary card before firing.

```
+----------------------------------------------------------+
|  [avatar]  The Brain                                     |
|  Orchestrator — workspace brain                          |
|                                                          |
|  Runtime    Claude Code  v1.0.3                          |
|  Model      claude-opus-4-5  (harness default)           |
|  Budget     $500 / month                                 |
|  Inbox      Telegram connected                           |
+----------------------------------------------------------+
|                        [Commission agent]                |
+----------------------------------------------------------+
```

**Commission button states:**

| Condition | Button | Behavior |
|---|---|---|
| Runtime detected + verified | **Commission agent** (accent) | Fires immediately, no confirm |
| Runtime installed during wizard | **Commission agent** (accent) | Same |
| Runtime `not_found` | **Commission anyway** (muted) | Tooltip: "Agent cannot run tasks without a harness. Connect it in agent config later." |
| Orchestrator already exists | Button disabled | Error notice in step 1 blocks progression |

### 1.7 The moment after — canvas entrance

On successful commission, the wizard does not just close. It hands off to the canvas.

```ts
// In AgentCreateWizard.tsx — after successful POST /v1/agents
onCreated(created.agent);

// In the parent (AgentsPage or HomePage canvas)
// onCreated fires CANVAS_NODE_PLACED via the realtime bus
// HOME-WORKSPACE-CANVAS-REPLAN.md §6 cascade entrance fires:
//   - new node materializes at correct tier position with opacity 0
//   - tier-by-tier cascade: orchestrator fades in, then managers, then workers
//   - command edges draw from parent to new node
//   - if from ghost node: ghost dissolves as real node fades in (FLIP)
```

**Ghost node entry point**: Clicking a ghost orchestrator/manager/worker node on the home canvas opens `AgentCreateWizard` with `initialRole` pre-set and `lockInitialRole: true`. The ghost node position becomes the FLIP source rect, so the real commissioned node animates directly into that slot.

---

## 3. Backend Changes

### 2.1 Fix PATH detection on Windows

**File**: `apps/api/src/services/harnessProbe.ts`

Current `probeBinary` uses `execFile(binary, ['--version'])` with no PATH override. On Windows, npm global installs land in `%APPDATA%\Roaming\npm` which is absent from Node's inherited PATH — this is why Claude Code and Codex are not detected even when installed.

```ts
async function probeBinary(binary: string): Promise<ProbeResult> {
  const expandedPath = buildExpandedPath();
  const envWithPath = { ...process.env, PATH: expandedPath };

  const version = await runProbe(binary, ['--version'], envWithPath);
  if (version.ok) return version;

  const locator = process.platform === 'win32' ? 'where' : 'which';
  const located = await runProbe(locator, [binary], envWithPath);
  if (located.ok) {
    return { ok: true, detail: located.detail?.trim().split('\n')[0] };
  }
  return { ok: false, error: version.error && located.error };
}
```

#### 2.1.1 `buildExpandedPath()` — `apps/api/src/services/pathExpander.ts`

**Windows** — append if directory exists:
- `%APPDATA%\npm`
- `%LOCALAPPDATA%\npm`
- `%USERPROFILE%\AppData\Roaming\npm`
- `%USERPROFILE%\.local\bin`
- `%USERPROFILE%\scoop\shims`
- `C:\Program Files\nodejs`

**macOS / Linux** — append if directory exists:
- `$HOME/.local/bin`
- `$HOME/.npm-global/bin`
- `/usr/local/bin`
- `$HOME/.volta/bin`
- `$HOME/.nvm/versions/node/<active>/bin` (read `NVM_DIR` or `~/.nvm/alias/default`)
- `/opt/homebrew/bin`

Exported as `buildExpandedPath(): string`. Called once per `detectHarnesses()` invocation and reused for all binary probes in that call.

### 2.2 Harness self-reporting — `detectedModel` + `binaryPath`

When `probeBinary` returns `ok: true`, run a secondary model probe:

```ts
async function probeHarnessModel(binary: string, adapterType: V1HarnessAdapterType, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  // claude: parse "Claude Code 1.0.3" → detectedModel stays undefined (harness uses its own default)
  // codex: same pattern
  // hermes: same
  // Return undefined if the harness doesn't surface a model in --version output.
  // This field is informational only — the harness decides at runtime.
}
```

Model field semantics: the UI shows "harness default" when `detectedModel` is absent, not a dropdown of fabricated models. See `AGENT-CREATE-WIZARD-REPLAN.md §0.5` — the harness owns its model registry.

### 2.3 `GET /v1/harness/detect` — extended response

```ts
interface HarnessDetectionResult {
  adapterType: V1HarnessAdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;           // version string / error message
  binaryPath?: string;       // NEW: resolved absolute path to binary
  detectedVersion?: string;  // NEW: parsed semver string
  detectedModel?: string;    // NEW: default model if advertised by harness
  installCommand?: string;
}
```

### 2.4 `POST /v1/harness/install` — new endpoint (SSE)

**File**: `apps/api/src/routes/harness.ts`

```
POST /v1/harness/install
Authorization: Bearer <token>
Content-Type: application/json
Body: { adapterType: 'claude_code' | 'codex' }

Response: text/event-stream
```

Rate-limited: 2 install attempts per workspace per minute. Behind standard auth.

**Automated install support:**

| Harness | Command | Pre-checks |
|---|---|---|
| `claude_code` | `npm install -g @anthropic-ai/claude-code` | `npm --version`, `node --version >= 18` |
| `codex` | `npm install -g @openai/codex` | Same |
| `hermes_agent` | No public package yet — manual path | Return `{ type: 'manual', instructions, url }` immediately (not SSE) |
| `cursor` | Desktop app — no CLI installer | Same manual response |
| `openclaw` | No install — redirect to gateway setup | Same manual response |
| `http` | No install | Same manual response |

**SSE event format:**
```
event: step
data: {"index":0,"label":"Check Node.js version","status":"running"}

event: step
data: {"index":0,"label":"Check Node.js version","status":"done","detail":"Node 24.14"}

event: step
data: {"index":1,"label":"npm install -g @anthropic-ai/claude-code","status":"running"}

event: log
data: {"line":"added 247 packages in 12s"}

event: step
data: {"index":1,"label":"npm install -g @anthropic-ai/claude-code","status":"done"}

event: step
data: {"index":2,"label":"Verify binary on PATH","status":"running"}

event: complete
data: {"ok":true,"binaryPath":"/usr/local/bin/claude","detectedVersion":"1.0.3"}

event: error
data: {"message":"npm not found on PATH","detail":"..."}
```

**Security — non-negotiable:**
- `adapterType` must be in the server-side whitelist `['claude_code', 'codex']`. All others get the manual response.
- Install command is a fixed constant per type — never constructed from user input.
- Uses `execFile` directly with a string array of arguments — no shell, no interpolation.
- `npm` binary resolved via `buildExpandedPath()` — never via user-supplied path.

### 2.5 `GET /v1/harness/install-options` — new endpoint

Tells the frontend which harnesses support automated install vs. manual guidance.

```ts
GET /v1/harness/install-options
Response: {
  adapters: Array<{
    adapterType: V1HarnessAdapterType;
    canAutoInstall: boolean;
    installCommand?: string;
    manualUrl?: string;
    manualInstructions?: string;
  }>
}
```

---

## 4. Frontend Changes

### 3.1 `AgentCreateWizard.tsx` — step restructure

```ts
type WizardStep = 'identity' | 'runtime' | 'playbook' | 'commission';
```

Step bar: 4 bars for orchestrators and managers, 3 bars for workers (playbook step still shown; inbox accordion hidden in identity).

Detection fires in the `useEffect` on `open` alongside agents fetch (§2.2). Results land in `detections: HarnessDetectionResult[]` state before the user advances to `runtime`.

`lockInitialRole?: boolean` prop — when truthy, the role selector is read-only (for ghost-node entry point where role is pre-determined).

### 3.2 `HarnessInstallSlideOver.tsx` — new component

**Location**: `apps/web/src/components/agents/HarnessInstallSlideOver.tsx`

Right-anchored slide-over (not modal). Props:

```ts
interface HarnessInstallSlideOverProps {
  adapterType: AdapterType;
  onInstalled: (result: { binaryPath: string; detectedVersion: string }) => void;
  onClose: () => void;
}
```

Behavior:
- Loads `GET /v1/harness/install-options` on mount.
- If `canAutoInstall`: renders step list + "Run install" button.
- If not: renders copyable command + documentation link.
- "Run install" opens `EventSource` to `POST /v1/harness/install` (SSE).
- Each `step` event renders as a row: pending circle / spinning loader / green check / red X.
- `log` events append to a capped (200 lines) monospace log area below the step list.
- On `complete`: calls `onInstalled`, closes itself, parent triggers detection re-run.
- On `error`: shows message with "Try again" button.

### 3.3 `RuntimePicker.tsx` — detection integration

New behavior (additions only — existing props and config forms stay):

1. Accept `detections: HarnessDetectionResult[]` as a prop (passed from wizard's shared state).
2. On `detections` received:
   - Single `found`: auto-select that adapter, call `onAdapterChange`, write `binaryPath` + `detectedModel` to config.
   - Multiple `found`: show "Found on this machine" section; default to first.
   - Zero `found`: hide the section; show detection-state badges on tiles.
3. Each `Not installed` tile shows an `Install` button → opens `HarnessInstallSlideOver`.
4. Connection details section: collapsed by default; auto-expanded when selected harness status is `not_found`.

### 3.4 `PlaybookStep.tsx` — updated component

The playbook step already exists as inline JSX in `CommissionFlow.tsx`. Extract it as `PlaybookStep`:

```ts
// apps/web/src/components/agents/PlaybookStep.tsx
interface PlaybookStepProps {
  role: AgentRole;
  name: string;
  playbook: string;
  tags: string[];
  monthlyBudget: string;
  entries: PlaybookEntry[];
  onPlaybookChange: (value: string) => void;
  onTagsChange: (tags: string[]) => void;
  onMonthlyBudgetChange: (value: string) => void;
}
```

Three sections:
1. **Template picker** — `PlaybookLibrary` filtered by role (`orchestrator` / `manager` / `worker` templates).
2. **Playbook editor** — `PlaybookEditor`. If blank, show subtle notice.
3. **Budget** — Single `monthlyBudget` field with `$` prefix and `/month` suffix. Default `500`.

### 3.5 Ghost node → wizard connection

**File**: `apps/web/src/components/canvas/WorkspaceEcosystemCanvas.tsx` (future home canvas)

Ghost node `onClick` handler:

```ts
function onGhostNodeClick(role: AgentRole) {
  const ghostRect = ghostNodeRef.current?.getBoundingClientRect() ?? null;
  openCommissionWizard({
    initialRole: role,
    lockInitialRole: true,
    flipFrom: ghostRect ? captureFlip(ghostRect) : null,
  });
}
```

`CommissionFlow`'s `onCommissioned` callback:

```ts
function onCommissioned(agentId: string) {
  // 1. Emit CANVAS_NODE_PLACED via realtime bus (server already does this on AGENT_CREATED)
  // 2. Trigger FLIP: animate from wizard card position to the slot the ghost occupied
  window.requestAnimationFrame(() =>
    playFlip(document.getElementById(`agent-node-${agentId}`), flipFrom ?? null)
  );
  onClose();
}
```

The `CANVAS_NODE_PLACED` event (already in `REALTIME_EVENTS`) causes the home canvas to add the new node at the correct tier. The ghost dissolves as the real node fades in.

---

## 5. The "Agent Does the Setup" Path

This is the scenario where the operator tells Claude Code or Codex: *"Set up Agentis for me."* The agent reads this section of `AGENTS.md` and executes the bootstrap. No guessing.

Two sub-scenarios:

**A. First boot** — Agentis is running but no agents exist. The AI agent commissions itself as orchestrator.

**B. Config reflection** — The AI agent already has an existing team configured in its own runtime (Claude Project, Codex workspace memory, etc.). It reflects that full configuration into Agentis — creating all agents, assigning hierarchy, wiring channels.

### 4.1 CLI command: `agentis bootstrap`

**File**: `packages/cli/src/commands/bootstrap.ts`

```bash
# Minimum: become the orchestrator
agentis bootstrap \
  --url http://localhost:3737 \
  --api-key <key> \
  --name "The Brain" \
  --adapter claude_code

# Full: with channels
agentis bootstrap \
  --url http://localhost:3737 \
  --api-key <key> \
  --name "The Brain" \
  --adapter claude_code \
  --model claude-opus-4-5 \
  --description "Workspace orchestrator. Routes goals, coordinates managers." \
  --channel-telegram-token $TELEGRAM_BOT_TOKEN \
  --channel-telegram-chat-id $TELEGRAM_CHAT_ID

# Config reflection: import full team from a JSON config file
agentis bootstrap \
  --url http://localhost:3737 \
  --api-key <key> \
  --import ./agentis-config.json
```

**Execution sequence:**
1. Validate connectivity — `GET /healthz`.
2. Check for existing orchestrator — `GET /v1/agents?role=orchestrator`.
3. If orchestrator exists + `--name` matches + `--adapter` matches: return `{ alreadyExists: true, agentId }`. Exit 0.
4. If orchestrator exists + different agent: print error "Workspace brain already exists: {name}". Exit 1 (unless `--role manager` is passed, in which case commission as manager reporting to it).
5. Create agent via `POST /v1/agents`.
6. Wire channels via `POST /v1/channels` for each `--channel-*` pair provided.
7. If `--import` provided: run import flow (§5.3).
8. Print JSON result.

**Machine-readable output:**
```json
{
  "ok": true,
  "agentId": "ag_01jxxxxx",
  "role": "orchestrator",
  "workspaceId": "ws_01jxxxxx",
  "channels": ["telegram"],
  "imported": { "agents": 0, "channels": 0 }
}
```

### 4.2 API endpoint: `POST /v1/bootstrap`

For agents using HTTP directly. Idempotent — safe to call twice.

```http
POST /v1/bootstrap
Authorization: Bearer <token>
Content-Type: application/json

{
  "agent": {
    "name": "The Brain",
    "role": "orchestrator",
    "description": "Workspace orchestrator.",
    "adapterType": "claude_code",
    "runtimeModel": "claude-opus-4-5",
    "config": { "binaryPath": "claude", "cwd": "/workspace" }
  },
  "channels": [
    { "type": "telegram", "botToken": "xxx", "chatId": "891861452" }
  ]
}
```

**Idempotency rule:** If an agent with the same `name` + `role: orchestrator` already exists in the workspace, return `{ "alreadyExists": true, "agentId": "..." }` with HTTP 200. Do not create a duplicate. Do not return an error. AI agents will retry on network failures — the endpoint must be safe for that.

### 4.3 Config reflection: `agentis-config.json`

When an AI agent bootstraps Agentis, it can reflect its entire existing team into the platform. Claude Code's team memory typically lives in `~/.claude/` project files and `CLAUDE.md`; Codex stores team context in its workspace memory. The bootstrap command reads these and generates a portable `agentis-config.json`:

```bash
# Claude Code — generate from project context
agentis bootstrap generate-config --from claude_code --output ./agentis-config.json

# Codex — same
agentis bootstrap generate-config --from codex --output ./agentis-config.json
```

**What `generate-config` reads:**

| Runtime | Source files | What is extracted |
|---|---|---|
| `claude_code` | `~/.claude/projects/<hash>/`, `CLAUDE.md`, `.claude/settings.json` | Agent names/roles from memory entries tagged with role keywords; model from settings; any named "team members" in project memory |
| `codex` | `~/.codex/`, workspace memory | Agent definitions from memory |

**`agentis-config.json` schema v1:**
```json
{
  "version": "1",
  "workspace": { "name": "My Company" },
  "agents": [
    {
      "name": "The Brain",
      "role": "orchestrator",
      "adapterType": "claude_code",
      "description": "Workspace orchestrator. Routes goals, coordinates managers.",
      "instructions": "You are the workspace brain..."
    },
    {
      "name": "Marketing Lead",
      "role": "manager",
      "adapterType": "claude_code",
      "reportsTo": "The Brain",
      "description": "Owns marketing space."
    }
  ],
  "channels": [
    { "type": "telegram", "agentName": "The Brain", "botToken": "...", "chatId": "..." }
  ]
}
```

**Import endpoint:** `POST /v1/bootstrap/import`

Import logic:
1. Validate schema — reject unknown fields, check role values.
2. Create agents in hierarchy order: orchestrator first, then managers, then workers.
3. Resolve `reportsTo` by name match within the import batch.
4. Create channels linked to the named agents.
5. Return `{ created: { agents: N, channels: N }, skipped: N, errors: [] }`.

Agents already existing by exact `name` match are skipped (not duplicated). Errors are non-fatal per agent — the import continues and reports failures in `errors[]`.

### 4.4 `AGENTS.md` — machine-readable setup instructions

**File**: `AGENTS.md` (repo root)

When Claude Code, Codex, or any agent reads this file before setting up Agentis, it gets complete, unambiguous instructions. No guessing from README.

```markdown
# Agentis — Agent Setup Instructions

This file is for AI agents configuring Agentis. If you are a human, see README.md.

## Quick start — become the orchestrator

agentis bootstrap --url <url> --api-key <key> --name "Your Name" --adapter claude_code

## Get the API key

1. Start Agentis: pnpm --filter @agentis/cli exec tsx src/index.ts up
2. Open http://localhost:5173 (or the URL printed at startup)
3. Log in as operator with the password printed at startup
4. Settings > API Keys > New key

## Bootstrap rules

- Run `GET /v1/agents?role=orchestrator` FIRST. Only proceed if empty.
- If an orchestrator already exists, use `--role manager` to add yourself below it.
- Use exact adapterType strings: `claude_code`, `codex`, `hermes_agent`, `openclaw`, `cursor`, `http`.
- Always use env variables for tokens, never hardcode: `--channel-telegram-token $TELEGRAM_BOT_TOKEN`.

## Reflect your existing team

agentis bootstrap --import ./agentis-config.json --url <url> --api-key <key>
agentis bootstrap generate-config --from claude_code --output ./agentis-config.json

## API (if you prefer HTTP)

POST /v1/bootstrap
Authorization: Bearer <key>
{ "agent": { "name": "...", "role": "orchestrator", "adapterType": "claude_code", ... } }

POST /v1/bootstrap/import
{ "agents": [...], "channels": [...] }
```

---

## 6. Implementation Phases

### Phase 1 — Fix detection (ship first, immediate user value)

1. `pathExpander.ts` with cross-platform path candidates.
2. `harnessProbe.ts` passes expanded PATH to all `probeBinary` calls.
3. `GET /v1/harness/detect` returns `binaryPath` + `detectedVersion`.
4. `RuntimePicker.tsx` auto-selects single detected runtime, pre-fills binary path.

**Done when**: Claude Code and Codex are detected on Windows when installed via npm global, regardless of whether `%APPDATA%\npm` is in Node's inherited PATH.

### Phase 2 — In-app install

1. `POST /v1/harness/install` SSE endpoint.
2. `GET /v1/harness/install-options` endpoint.
3. `HarnessInstallSlideOver.tsx`.
4. Security review: whitelist, execFile, rate limit.

**Done when**: Clicking "Install Claude Code" in the wizard shows live install progress and auto-selects the harness on completion.

### Phase 3 — Wizard restructure

1. `AgentCreateWizard.tsx` 4-step flow with `lockInitialRole`.
2. `PlaybookStep.tsx` with role-filtered templates + budget field.
3. Orchestrator inbox accordion in identity step.
4. OpenClaw gateway gate.
5. Ghost node → wizard wiring in `WorkspaceEcosystemCanvas`.
6. Post-commission FLIP + `CANVAS_NODE_PLACED` event.

**Done when**: A user with Claude Code installed opens the wizard from a ghost orchestrator node, gives a name, picks a template, and their agent appears in the hierarchy on the home canvas — all in under 90 seconds.

### Phase 4 — Agent bootstrap path

1. `packages/cli/src/commands/bootstrap.ts`.
2. `POST /v1/bootstrap` (idempotent).
3. `POST /v1/bootstrap/import`.
4. `agentis bootstrap generate-config` subcommand.
5. `AGENTS.md` at repo root.

**Done when**: Claude Code can read `AGENTS.md`, run `agentis bootstrap --url http://localhost:3737 --api-key <key> --name "The Brain" --adapter claude_code`, and appear as orchestrator on the home canvas with zero ambiguity.

---

## 7. Design System Notes

### 6.1 Step bar

4 bars for orchestrators/managers, 3 for workers. Active bar at 70% opacity; completed bars at 100%.

```tsx
<div className="flex gap-2 mt-4">
  {visibleSteps.map((s, i) => (
    <span key={s} className={clsx('h-1 flex-1 rounded-full transition-colors',
      i < currentStepIndex ? 'bg-accent' :
      i === currentStepIndex ? 'bg-accent/70' :
      'bg-surface-2'
    )} />
  ))}
</div>
```

### 6.2 Install step row

Matches the Hyperclaw-style step list exactly:

```tsx
<div className="flex items-start gap-3 py-2">
  <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs',
    s === 'done'    ? 'bg-accent/20 text-accent' :
    s === 'running' ? 'border border-accent/40 bg-transparent' :
    s === 'error'   ? 'bg-danger/20 text-danger' :
                      'border border-line bg-transparent'
  )}>
    {s === 'done'    ? <Check size={12} /> :
     s === 'running' ? <Loader2 size={12} className="animate-spin" /> :
     s === 'error'   ? <X size={12} /> :
     <div className="h-1.5 w-1.5 rounded-full bg-surface-2" />}
  </span>
  <div>
    <div className="text-sm text-text-primary">{label}</div>
    {detail && <div className="text-xs text-text-muted mt-0.5">{detail}</div>}
  </div>
</div>
```

### 6.3 Detection badge

```tsx
{status === 'found' && (
  <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
    Installed
  </span>
)}
{status === 'not_found' && (
  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">
    Not installed
  </span>
)}
{detecting && (
  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted animate-pulse">
    Checking...
  </span>
)}
```

---

## 8. Files Created / Modified

### New files

| File | Purpose |
|---|---|
| `apps/api/src/services/pathExpander.ts` | Cross-platform PATH expansion for binary probing |
| `apps/api/src/routes/harnessInstall.ts` | `POST /v1/harness/install` SSE + `GET /v1/harness/install-options` |
| `apps/web/src/components/agents/HarnessInstallSlideOver.tsx` | Install slide-over with live step list |
| `apps/web/src/components/agents/PlaybookStep.tsx` | Playbook templates + editor + budget field |
| `packages/cli/src/commands/bootstrap.ts` | `agentis bootstrap` command |
| `apps/api/src/routes/bootstrap.ts` | `POST /v1/bootstrap` + `POST /v1/bootstrap/import` |
| `AGENTS.md` | Machine-readable bootstrap instructions for AI agents |

### Modified files

| File | Change |
|---|---|
| `apps/api/src/services/harnessProbe.ts` | PATH expansion; `binaryPath` + `detectedVersion` + `detectedModel` in result |
| `apps/api/src/routes/harness.ts` | Mount `harnessInstall` routes |
| `apps/web/src/components/agents/RuntimePicker.tsx` | Accept `detections` prop; auto-select; pre-fill; "Install" button trigger |
| `apps/web/src/components/agents/AgentCreateWizard.tsx` | 4-step flow; `lockInitialRole`; playbook + budget step; inbox accordion; ghost FLIP |
| `apps/web/src/components/canvas/WorkspaceEcosystemCanvas.tsx` | Ghost node `onClick` → wizard; `CANVAS_NODE_PLACED` handler |

---

## 9. Anti-Patterns to Avoid

| Pattern | Why |
|---|---|
| `exec(string)` in install endpoint | Shell injection — always `execFile` with a fixed string array |
| User-supplied package names in install | Whitelist only — `@anthropic-ai/claude-code` and `@openai/codex` are constants |
| Hardcoded model dropdowns in UI | Violates `HARNESS-CONFIG.md §1` — harness owns its model registry |
| Non-idempotent bootstrap endpoint | AI agents retry on network errors — same-name same-role orchestrator must return `alreadyExists`, not 409 |
| Commission ends with a toast only | The agent should appear on the canvas — commissioning is an organizational act, not a form submission |
| Channels as a separate wizard step | Channels belong to identity (who can reach this agent), not to runtime (how it runs) |
| `lockInitialRole` without pre-detecting harness | When opening from a ghost node, detection must also fire immediately — the user should see harness status on arrival at step 2 |
| Deferring budget to "agent config later" | Cost control is Agentis DNA — `monthlyBudgetCents` must be set at commission time |
