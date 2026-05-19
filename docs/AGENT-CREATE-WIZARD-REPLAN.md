# Agent Create Wizard — Complete Redesign

> **Status**: Planning — not yet implemented
> **Date**: May 14, 2026
> **Scope**: `AgentCreateWizard.tsx`, `RuntimePicker.tsx`, `AgentHierarchyNode.tsx` (ghost nodes), `AgentHierarchyCanvas.tsx` (ghost copy), `AgentsPage.tsx` (banner removal)
> **Predecessor**: `AGENTS-MANAGEMENT-REPLAN.md` — implemented May 2026. This doc replaces the wizard design produced there.

---

## 0. What Is Wrong Right Now

### 0.1 Space field on orchestrator

**File**: `AgentCreateWizard.tsx` ~line 242
**Problem**: The `Space` `<select>` is rendered unconditionally in step 1. When `role === 'orchestrator'`, this is a lie — the orchestrator belongs to the entire workspace, not to any space. Showing it makes users think they need to assign a space.
**Fix**: Hide the `Space` field entirely when `role === 'orchestrator'` or when `lockInitialRole === true && initialRole === 'orchestrator'`.

### 0.2 Orchestrator ghost node references space

**File**: `AgentHierarchyCanvas.tsx` ~line 222
**Problem**: The ghost node for a missing orchestrator shows `ghostDescription: 'One orchestrator per workspace is recommended.'` which is fine, but the `createPreset` has no space, which is correct. However the ghost card is rendered with the same tier-color styling as manager ghosts. The orchestrator ghost should be visually distinct — it is workspace-level, not space-level. Currently nothing tells the user this.
**Fix**: Ghost orchestrator copy must say "workspace brain" not "space". Ghost manager copy keeps the space reference (correct). Ghost card for orchestrator drops all color — neutral border only, no tier accent.

### 0.3 Color swatches clutter step 1

**File**: `AgentCreateWizard.tsx` ~line 233
**Problem**: Six `SWATCHES` color pickers are shown above the Description field. This is a profile preference, not a commissioning requirement. Users should not be choosing brand colors before the agent even has a runtime. The color swatch row adds visual noise, increases decision fatigue, and has nothing to do with the agent working.
**Fix**: Remove `SWATCHES` and the color picker from the wizard. Keep `colorHex` state and auto-assign it by role (`orchestrator: #8b5cf6`, `manager: #06b6d4`, `worker: #60a5fa`). The user can change the color from the agent detail page later.

### 0.4 Avatar upload affordance disappears

**File**: `AgentCreateWizard.tsx` ~line 206
**Problem**: The avatar circle shows `<Upload size={18} />` only when `name` is empty. Once the user starts typing a name, the circle switches to initials and the camera/upload hint disappears. There is no way to know the circle is clickable.
**Fix**: Always show a small camera overlay icon on the avatar circle (bottom-right corner, 18x18px, `bg-surface-2/80 rounded-full`). On hover: `opacity-1`. At rest: `opacity-60`. This makes the upload affordance permanently visible regardless of whether initials or a photo is shown.

### 0.5 `ADAPTER_MODEL_REGISTRY` is architecturally wrong

**File**: `RuntimePicker.tsx` ~line 148
**Problem**: The registry hardcodes model lists for Claude, Codex, Cursor, and Hermes. This violates the platform's own contract from `HARNESS-CONFIG.md §1`:

> *"Agentis does not download models, host models, route model-provider tokens for Kind A harnesses, or expose raw model endpoints in the V1 setup path."*

The harness owns its model list — Claude Code CLI decides which models it supports. Codex CLI decides its model list. We do not know what models the user has access to, what API keys they have configured in their harness, or whether they are using local models, OpenRouter, OAuth, or direct API. Presenting a curated dropdown of model IDs is misleading.

**Fix**: Remove `ADAPTER_MODEL_REGISTRY`. Replace `ModelPicker` with a `HarnessModelPassthrough` component that:
1. Shows the model as reported by the harness detection (`/v1/adapters/harness-status`) when available
2. Provides a single optional text field: "Override model ID (optional)" — for users who know exactly what they want to pass via `--model` flag
3. Shows helper text explaining what the harness will use by default if left blank

### 0.6 OpenClaw with no gateway: should block, not degrade

**File**: `RuntimePicker.tsx` `ModelPicker` function ~line 299
**Problem**: When OpenClaw is selected and `openclawGatewayId` is empty, `gatewayModels` is empty, and `ModelPicker` falls back to "Enter a model ID manually." This allows creating an agent that points at nothing. The platform is silently letting the user configure a broken agent.
**Fix**: OpenClaw requires a gateway. If no gateway is configured in the workspace, step 2 must show a **gateway gate** — a blocked state with a "Connect a gateway first" CTA that opens Settings → Gateways. The "Commission agent" button must be disabled with a tooltip: "Requires an active OpenClaw gateway."

### 0.7 Advanced connection settings are deferred incorrectly

**File**: `RuntimePicker.tsx` ~line 266
**Problem**: Step 2 currently shows: *"Advanced connection settings are available in the agent config tab after commissioning."* This defers settings that are actually **required** for the agent to work:
- OpenClaw: `gatewayUrl` without which the adapter cannot connect at all
- CLI harnesses: `binaryPath` when the binary is not on `$PATH`, `cwd` for agents scoped to a repo

The text tells the user to finish setup now and then go fix it — creating a broken agent on purpose.
**Fix**: Rename the section to "Connection details" (not "Advanced"). Show it **collapsed by default** with a disclosure toggle. If the harness detection already resolved the binary path, pre-fill the fields and keep it collapsed. If the harness was NOT detected (status `not_found`), auto-expand the section with a note: "Harness not detected — verify the path below."

### 0.8 Role icons look generic

**File**: `AgentHierarchyNode.tsx` line 3, `AgentCreateWizard.tsx` line 2
**Problem**: `Crown`, `UserCog`, `Bot` are generic Lucide icons. They look like any AI dashboard. They communicate nothing about the role's position in a command hierarchy.
**Fix**: Replace with geometric SVG glyphs defined inline:
- **Orchestrator**: a hexagon — conveys authority, network-node topology, the center of a graph
- **Manager**: a diamond — conveys coordination, a routing node
- **Worker**: a small square — conveys a bounded execution unit

These are simple, scalable, and carry architectural meaning rather than decorative metaphor. See §4 for SVG specs.

### 0.9 Wizard header intro paragraph is too heavy

**File**: `AgentCreateWizard.tsx` ~line 84
**Problem**: `resolvedIntro` renders a full multi-sentence paragraph below the heading. Examples:
- *"Set the workspace brain first so routing, approvals, and command surfaces have a proper owner."*
- *"Step through identity, hierarchy, and runtime before the agent goes live."*

This reads like onboarding copy. The wizard is a task, not a tutorial. Copy should be a single clause, max 60 characters.
**Fix**: Replace all `resolvedIntro` variants with short, action-oriented single lines. See §1.1 for exact copy.

### 0.10 Page banner is redundant

**File**: `AgentsPage.tsx` — the "Commission your orchestrator first" banner at the top
**Problem**: The ghost orchestrator node on the canvas already tells the user they need an orchestrator. The page-level banner doubles this and fills vertical space. If the canvas is the CTA, the banner is noise.
**Fix**: Remove the banner. Ghost nodes are the single point of entry for setup guidance.

---

## 1. Step 1 Redesign — Identity Only

Step 1 becomes a clean identity form: who is this agent, what role do they play, where do they live. Nothing about runtime, nothing about color swatches.

### 1.1 Header copy

| Trigger | Heading | Sub-heading |
|---------|---------|-------------|
| `initialRole === 'orchestrator'` (locked) | Commission your orchestrator | Workspace brain — commands all other agents |
| `initialRole === 'manager'` (locked) | Assign a manager | Coordinates workers inside a space |
| `initialRole === 'worker'` (locked) | Add a worker | Runs focused tasks assigned by a manager |
| No lock, generic | Commission agent | Identity first, then connect a runtime |

Sub-headings are ≤ 60 characters. No paragraphs.

### 1.2 Avatar — always-visible upload affordance

```
+------------------------------------------+
|  +-------+                               |
|  | AS    |  <- initials (or photo)        |
|  |    [o]|  <- camera icon, always shown  |
|  +-------+                               |
|               Name                       |
|               [ Research Lead        ]   |
+------------------------------------------+
```

The `[o]` is a 20x20px circle overlaid at `bottom-0 right-0` of the avatar:
```
className="absolute bottom-0 right-0 flex h-5 w-5 items-center justify-center
           rounded-full border border-line bg-surface-2 text-text-muted
           opacity-60 transition-opacity group-hover:opacity-100"
```

The outer avatar button gets `className="group ..."`. The overlay is always rendered, always clickable. Name initials display as the fallback. The `<Upload>` icon in the avatar center is removed — the overlay corner handles it.

### 1.3 Fields in step 1

| Field | Visible when | Notes |
|-------|-------------|-------|
| Name | Always | `autoFocus`, required |
| Description | Always | Optional, max 160 chars, placeholder "Short focus line" |
| Space | `role !== 'orchestrator'` | Hidden entirely for orchestrator |
| Role cards | Not locked | If `lockInitialRole`, show the single locked card |
| Reports to | `role !== 'orchestrator'` | Unchanged |

Remove: color swatch grid.

### 1.4 Role cards — new icons

Role card buttons replace `Crown / UserCog / Bot` with inline SVG glyphs. See §4 for SVG markup. The card layout is otherwise unchanged.

### 1.5 `canContinue` logic

```typescript
const canContinue =
  name.trim().length >= 2 &&
  !(role === 'orchestrator' && orchestrator);  // unchanged
```

---

## 2. Step 2 Redesign — Harness and Connection

Step 2 is renamed from "Runtime and model" to "Harness". The model concept is removed from this step. Connection details move here, inline.

### 2.1 Step header copy

```
STEP 2 OF 2 - HARNESS
```

Sub-heading: `Connect the runtime that will execute this agent's tasks.`

### 2.2 Harness picker — detection-first, state-aware

The harness picker grid is unchanged in layout (6 tiles, 3-wide on md). Each tile gains a status indicator:

| Tile state | Visual |
|-----------|--------|
| Detected (status `found`) | Green dot bottom-center + `opacity-100` |
| Not detected (status `not_found`) | No dot + `opacity-70` |
| Detecting | Spinner |
| Selected | `border-accent bg-accent/10` |

No more "Detected on this machine" / "Connect a harness" split-sections. One grid. The green dot on tiles that are already installed communicates detection without a separate section heading.

### 2.3 OpenClaw gateway gate

When `adapterType === 'openclaw'`:

1. **Check**: does this workspace have any gateways? Call `GET /v1/gateways` (or read from detection).
2. **If gateways exist**: show a gateway `<select>` to pick which gateway to bind. When one is selected, fetch its available models from `GET /v1/gateways/:id/models` and show them as the model list (read-only chips, not a custom input).
3. **If no gateways**: render a gate block instead of harness config:

```
+--------------------------------------------------+
|  No OpenClaw gateway configured                  |
|  OpenClaw requires an active gateway to connect. |
|                                                  |
|  [-> Go to Settings / Gateways]  (opens /settings/gateways in new tab)
+--------------------------------------------------+
```

The "Commission agent" button is `disabled` with `title="Requires an active OpenClaw gateway"`.

### 2.4 Connection details accordion

Immediately below the harness tiles, inline in step 2:

```
+--------------------------------------------------+
|  Connection details          [v Show / ^ Hide]   |
+--------------------------------------------------+
|  Binary path                                     |
|  [ claude                                    ]   |
|  Working directory                               |
|  [ /home/user/my-repo                        ]   |
|  Timeout (seconds)                               |
|  [ 120                                       ]   |
+--------------------------------------------------+
```

**Auto-expand rules**:
- Harness detected (`status === 'found'`): start **collapsed** — connection already works, no need to touch it
- Harness NOT detected (`status === 'not_found'`): start **expanded** with note: "Harness not detected — verify the binary path."
- OpenClaw selected: start **expanded** (gateway URL and ID are required)

Fields shown per harness:

| Harness | Fields in accordion (step 2) | Deferred to config tab |
|---------|------------------------------|------------------------|
| OpenClaw | Gateway select (if gateways exist) | Session key strategy, payload template, timeout |
| Claude Code | Binary path, working directory, timeout | Max turns, allowed tools, extra args, env |
| Codex | Binary path, working directory, timeout | Max turns, reasoning effort, fast mode, extra args |
| Hermes Agent | Binary path, working directory, timeout | Max turns, extra args, env |
| Cursor | Binary path, working directory, timeout | Extra args, env |
| HTTP | Base URL, dispatch path, auth credential | Cancel path, health path, method, headers, payload template |

The "Advanced connection settings are available in the agent config tab after commissioning" note is **kept only for the fields not shown here** (the deferred ones). The label changes to:
> *Additional options (max turns, env vars, etc.) are available in the agent config tab after commissioning.*

### 2.5 Model field — harness owns model, we pass through

Remove `ModelPicker` and `ADAPTER_MODEL_REGISTRY`.

Replace with `HarnessModelPassthrough`:

```tsx
function HarnessModelPassthrough({ adapterType, detection, config, onConfigChange }) {
  if (adapterType === 'openclaw') {
    // Handled in 2.3 — gateway select already shows model list from gateway
    return null;
  }
  if (adapterType === 'http') {
    return null;  // HTTP has no model concept
  }

  const defaultNote = {
    claude_code:  'Claude Code uses the model set in your ~/.claude config or ANTHROPIC_MODEL env var.',
    codex:        'Codex uses the model configured in your OpenAI account or OPENAI_MODEL env var.',
    hermes_agent: 'Hermes uses the model configured in its own settings.',
    cursor:       'Cursor uses the model set in your Cursor account.',
  }[adapterType];

  return (
    <div className="space-y-1.5">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-text-secondary">Model override <span className="font-normal text-text-muted">(optional)</span></span>
        <input
          value={runtimeModelFor(adapterType, config) ?? ''}
          onChange={(e) => onConfigChange(setRuntimeModel(adapterType, config, e.target.value))}
          placeholder="Leave blank to use harness default"
          className={inputCls}
        />
      </label>
      {defaultNote && (
        <p className="text-[11px] leading-relaxed text-text-muted">{defaultNote}</p>
      )}
    </div>
  );
}
```

The model field is **optional**. The user does not need to fill it. The harness already knows its model from its own config (API key, local setup, OAuth). This respects the contract in HARNESS-CONFIG §1.

### 2.6 Summary row

At the bottom of step 2, above the footer:

```
Ready to commission  Research Lead - manager - claude_code
```

Same as current. If model override is blank, just show the harness: `Research Lead - manager - Claude Code`.

### 2.7 Footer button states

| Condition | Button state |
|-----------|-------------|
| Normal | `Commission agent` (green, enabled) |
| OpenClaw + no gateway | `Commission agent` (disabled, `title="Requires an active OpenClaw gateway"`) |
| Creating | `Commissioning...` (spinner, disabled) |

---

## 3. Ghost Node Fixes

### 3.1 Orchestrator ghost

**Current** (`AgentHierarchyCanvas.tsx` ~line 222):
```typescript
{
  id: 'ghost-orchestrator',
  name: 'Set up orchestrator',
  ghostDescription: 'One orchestrator per workspace is recommended.',
  createPreset: { role: 'orchestrator' },
}
```

**Changes**:
- `name`: `'No orchestrator yet'`
- `ghostDescription`: `'The workspace brain. Needed for routing, approvals, and command.'`
- No `spaceId` in `createPreset` (already correct — just making it explicit)
- In `AgentHierarchyNode.tsx`, the ghost card for `role === 'orchestrator'` uses **no tier-color accent**. Border: `border-dashed border-zinc-600`. Background: `bg-zinc-900/50`. No violet, no cyan.

### 3.2 Manager ghost

Unchanged in data. Keep `spaceName` in `ghostDescription` — it is correct here because managers ARE space-scoped.

```
ghostDescription: `Assign a manager to keep ${space.name} owned.`
```

The ghost card for manager ghosts also drops color — `border-dashed border-zinc-600`, neutral. The tier-color borders (violet/cyan/blue) are for real, live agents only. Ghosts are always neutral.

### 3.3 Ghost card style rule

In `ghostCardClass()` (`AgentHierarchyNode.tsx`):

```typescript
function ghostCardClass(data: AgentNodeData) {
  return clsx(
    'w-[240px] rounded-lg border border-dashed border-zinc-600 bg-zinc-900/50 px-3 py-3',
    data.highlighted && 'ring-1 ring-accent/50',
    data.dimmed && 'pointer-events-none opacity-25',
  );
}
```

No change needed — the current implementation is already color-neutral. The fix is to ensure `cardStyle()` is NOT called for ghost nodes (it currently is not, because the ghost branch returns early before `cardStyle` is applied). Verify and keep as-is.

---

## 4. Icon Replacement Specification

### 4.1 Orchestrator — hexagon glyph

```tsx
function OrchestratorGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <polygon
        points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

A regular hexagon. Conveys: network centrality, authority node, structured command.

### 4.2 Manager — diamond glyph

```tsx
function ManagerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <polygon
        points="8,1.5 14.5,8 8,14.5 1.5,8"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

A diamond rotated 45°. Conveys: coordination node, routing, bridging tiers.

### 4.3 Worker — rounded square glyph

```tsx
function WorkerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3" y="3" width="10" height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}
```

A bounded square. Conveys: execution unit, contained scope, task runner.

### 4.4 Where to use these

Replace all `Crown`, `UserCog`, and `Bot` icon references in:

| File | Location | Replace |
|------|----------|---------|
| `AgentHierarchyNode.tsx` | line 2 (`Crown, Bot, UserCog` import) | Import `OrchestratorGlyph`, `ManagerGlyph`, `WorkerGlyph` |
| `AgentHierarchyNode.tsx` | `const Icon = role === 'orchestrator' ? Crown : ...` | Use glyphs by role |
| `AgentCreateWizard.tsx` | `ROLE_OPTIONS` array icon fields | Use glyphs |
| `AgentsPage.tsx` | `Bot` in `EmptyState icon` | Keep `Bot` here — this is a generic empty state, not a role indicator |

---

## 5. Notification Simplification

### 5.1 Remove the page-level banner

The current "Commission your orchestrator first" banner in `AgentsPage.tsx` (if present as a separate component above the canvas) must be removed. The ghost orchestrator node on the canvas is the single call to action. Two CTAs for the same action is noise.

### 5.2 Single persistent canvas notification

The only notification that should exist on the Agents page is a subtle status bar at the bottom of the canvas — already implemented as the "N workers unconnected" panel in `AgentHierarchyCanvas.tsx`. This pattern is correct. Extend it:

```tsx
// In AgentHierarchyCanvas.tsx — the single notification surface
{graph.unconnectedWorkers > 0 && (
  <Panel position="bottom-left" className="...">
    {graph.unconnectedWorkers} {graph.unconnectedWorkers === 1 ? 'worker is' : 'workers are'} unconnected — drag to assign.
  </Panel>
)}
{!hasOrchestrator && (
  <Panel position="bottom-left" className="...">
    No orchestrator — click the ghost node above to set one up.
  </Panel>
)}
```

One message at a time. No floating banners. No header-level callouts. The canvas speaks for itself.

---

## 6. Files to Change

| File | Change |
|------|--------|
| `apps/web/src/components/agents/AgentCreateWizard.tsx` | Remove `SWATCHES`, remove color picker, auto-assign `colorHex` by role, hide `Space` for orchestrator, fix avatar overlay, update header copy, update step 2 to use `HarnessModelPassthrough` |
| `apps/web/src/components/agents/RuntimePicker.tsx` | Remove `ADAPTER_MODEL_REGISTRY`, remove `ModelPicker`, add `HarnessModelPassthrough`, add `openclawGatewayGate`, expand connection details accordion, adjust auto-expand rules |
| `apps/web/src/components/agents/AgentHierarchyNode.tsx` | Replace `Crown/UserCog/Bot` imports with inline SVG glyphs |
| `apps/web/src/components/agents/AgentHierarchyCanvas.tsx` | Update orchestrator ghost `name` + `ghostDescription`, update banner copy |
| `apps/web/src/pages/AgentsPage.tsx` | Remove page-level orchestrator banner (if present as JSX above canvas) |

**Do not change**:
- `apps/api/src/routes/agents.ts` — API unchanged
- `packages/db/src/sqlite/schema.ts` — schema unchanged
- `apps/web/src/components/agents/AgentHierarchyDetailPanel.tsx` — unchanged
- `apps/web/src/components/agents/FleetToolbar.tsx` — unchanged
- Any test files that don't reference changed selectors

---

## 7. What NOT to Change

- **The two-step structure** — step 1 identity, step 2 harness. This is correct.
- **`Reportsto` field** — still useful, keep as-is.
- **`runtimeConfig` state shape** — the `RuntimeConfig` type and `DEFAULT_RUNTIME_CONFIG` remain; we are only removing the model picker UI, not the config contract.
- **Harness tile grid layout** — the 6-tile grid works. Only the model section and advanced-settings deferral change.
- **The `adapterType` / `runtimeModel` API contract** — `runtimeModel` stays nullable on the agent. The harness uses it as a CLI `--model` flag if provided. We just stop forcing the user to pick one.
- **Ghost node data shape** — `AgentHierarchyAgent` interface unchanged.
- **Canvas drag/connect behavior** — unchanged.

---

## 8. Implementation Order

### Phase A — Ghost node fixes + icon replacement (0.5 days)
- Replace role icons with SVG glyphs across wizard and canvas node
- Fix ghost orchestrator copy (no space reference, neutral border confirmed)
- Remove page-level banner if present

### Phase B — Wizard step 1 cleanup (0.5 days)
- Remove `SWATCHES` and color grid
- Auto-assign `colorHex` by role
- Hide `Space` field for orchestrator
- Fix avatar overlay (permanent camera corner icon)
- Update `resolvedHeading` / `resolvedIntro` copy

### Phase C — Wizard step 2 harness redesign (1.5 days)
- Remove `ADAPTER_MODEL_REGISTRY` and `ModelPicker`
- Add `HarnessModelPassthrough` (optional override text field + helper note)
- Move connection fields inline as collapsible accordion in step 2
- Add OpenClaw gateway gate (check `/v1/gateways`, block if none)
- Auto-expand accordion when harness not detected
- Update deferred-note copy to reflect what is actually deferred

### Phase D — Tests (0.5 days)
- Update any Vitest / Playwright selectors that reference changed text or icons
- Add test for OpenClaw gateway gate blocking commission
- Add test for avatar overlay always visible

---

## 9. Definition of Done

- [ ] Role icons are geometric SVG glyphs — no Crown, UserCog, or Bot in agent hierarchy surfaces
- [ ] Avatar circle always shows a camera overlay corner icon; initials display as fallback
- [ ] No color swatch grid in step 1; `colorHex` auto-assigned by role
- [ ] `Space` field hidden when `role === 'orchestrator'`
- [ ] Orchestrator ghost copy says "workspace brain", no space reference
- [ ] Ghost cards (all tiers) use neutral dashed border — no tier-color accent
- [ ] Step 2 header says "HARNESS", not "RUNTIME AND MODEL"
- [ ] `ADAPTER_MODEL_REGISTRY` removed; no curated model dropdown for CLI harnesses
- [ ] Model override field is optional, clearly labeled, with helper note per harness
- [ ] OpenClaw with no gateway renders gate block; "Commission agent" button disabled
- [ ] Connection details shown in accordion on step 2 (not deferred to config tab)
- [ ] Accordion auto-expands when harness not detected; stays collapsed when detected
- [ ] Page-level orchestrator banner removed from `AgentsPage`
- [ ] All existing Vitest and Playwright tests green
