# Abilities V2 — Battle Plan: Replacing SKILL.md Dependency

> **Goal**: Every capability that makes operators reach for a `SKILL.md` file today
> must have a better-engineered home in the Agentis Ability system. Not by being
> fancier — by being more reliable, more observable, and more composable.

---

## The Four Kills

The analysis found four categories where SKILL.md wins today. This plan kills each one.

| Kill | SKILL.md advantage today | Abilities V2 answer |
|---|---|---|
| **K1 — Zero infrastructure** | Drop a file, it works | Zero-compile fast path + static abilities |
| **K2 — Breadth of control** | Tool dispatch, env inject, slash commands, gating | All four added to Ability schema |
| **K3 — Ecosystem maturity** | ClawHub, verify trust, community | AgentisHub protocol + ability package registry |
| **K4 — Token efficiency** | No bloat (static text) | Compressed semantic injection + budget discipline |

---

## Current State (Precise)

Before planning changes, know exactly what exists:

### What the engine already does (do not break)

- **`#buildAbilityBlock`** (WorkflowEngine.ts:1983) — cosine-scores all compiled abilities
  against the task embedding, merges pinned abilities, enforces `ABILITY_TOKEN_BUDGET`,
  emits `<ability>…</ability>` XML.
- **`renderAbilityXml`** (abilityService.ts:792) — builds the XML block with `<persona>`,
  `<specs>`, `<rules>`, `<tool_hints>`, `<knowledge>`, `<examples>`. Token-budgeted per
  section (45% knowledge / 55% examples of the remaining budget after header).
- **4-step compiler** (abilityCompilerService.ts) — embed examples → contextualize
  knowledge → generate synthetic examples → synthesize persona → publish to workspace brain.
- **Pinning** — `agent_ability_pins` table; pinned abilities always inject at `score=1.0`.
- **Flywheel** — `POST /v1/abilities/:id/examples/from-run` promotes run outputs as examples.
- **Export/import** — JSON package `format_version: '1.0'` with examples + knowledge.

### What is missing (precise gaps)

1. **No zero-compile path** — every ability needs the full 4-step pipeline before it fires.
   An operator installing a pre-built package still waits for recompile.
2. **No env/secret injection** — `AdapterConfig.env` exists on `ClaudeCodeAdapterConfig`,
   `CodexAdapterConfig`, etc., but Abilities have no way to contribute env vars to a dispatch.
3. **No slash command surface** — `commandIndex.ts` handles Cmd+K navigation only; it does
   not expose ability-triggered slash commands to the chat UI or harnesses.
4. **No tool dispatch** — Abilities only inject text into the system prompt. They cannot
   directly invoke a tool or bypass the model.
5. **No runtime gating** — Abilities have no equivalent of `requires.bins`, `requires.env`,
   `os` filters. All compiled abilities are always eligible (subject to relevance).
6. **No public hub** — `hubSlug` / `hubVersion` fields exist in the DB schema but there is
   no registry. `AGENTIS_HUB_URL` paths in packager.ts handle packages, not abilities.
7. **Compile is a single point of failure** — if the embedding provider is misconfigured,
   abilities stay `pending` indefinitely. There is no static / no-compile fallback mode.
8. **`NormalizedTask` has no ability field** — the task dispatched to the harness contains
   `toolManifest` (awareness only) but no structured representation of injected abilities.
   The ability block arrives as raw text inside `description`, invisible to harness tools.
9. **Token accounting is approximate** — `estimateTokens` uses a 4-chars/token heuristic
   with no feedback loop. No actual token counts are tracked post-dispatch.
10. **Slash commands are frontend-only** — `apps/web/src/lib/slashCommands.ts` implements
    `/run`, `/pause`, `/wake` etc. as window event handlers. There is no server-side slash
    command system. Abilities cannot register a slash command today at any layer.
11. **Hermes `dispatchTask` hardcodes its system prompt** — `HermesAdapter.buildHermesPrompt`
    puts ability XML into the `user` message role, not the `system` role. This is architecturally
    wrong: behavioral persona must be system-role injection for Hermes to respect it properly.
    ClaudeCode (stdin = full assembled prompt) and Codex are not affected.
12. **`toolHints` have no enforcement** — they are plain text strings in `<tool_hints>` XML,
    purely advisory to the LLM. No mechanism routes them to actual tool pre-loading or
    `allowedTools` configuration in any adapter.

---

## Phase 1 — Zero-Compile Fast Path (Kill K1 + K4 partial)

**Why first**: This is the biggest structural gap. Without it, abilities are unusable on a
fresh install, in CI, or after importing a package.

### 1.1 Static Ability Mode

Add `mode: 'static' | 'compiled'` to `AbilityRecord` and the DB schema.

A **static** ability skips the compiler entirely:
- `compiledPrompt` is authored directly by the operator (or arrived via import).
- `domainEmbedding` is computed from `name + domainTag + compiledPrompt` using the local
  `HashingEmbeddingProvider` — always available, zero external dependency.
- `compileStatus` is set to `ready` immediately on creation.
- The full `<ability>` XML block is rendered the same way as a compiled ability.

**Schema change** (`packages/db/src/schema.ts`):
```sql
ALTER TABLE abilities ADD COLUMN mode TEXT NOT NULL DEFAULT 'compiled';
-- 'static' = no LLM compile required; 'compiled' = full pipeline
```

**`AbilityRecord`** (`packages/core/src/types/ability.ts`):
```ts
mode: 'static' | 'compiled';
```

**`AbilityService.create`**: when `mode: 'static'` is passed and `compiledPrompt` is provided,
skip queueing a compile and instead call `#activateStatic()` which runs the hashing embed
synchronously and sets `compileStatus = 'ready'` in the same transaction.

**`AbilityService.update`**: static abilities do NOT set `compileStatus = 'dirty'` on
behavioral field changes — they regenerate the hashing embed inline.

**Result**: An operator can create an ability, write its persona manually, and it fires on
the next dispatch — same as dropping a SKILL.md.

### 1.2 Import Activates Immediately

Current behavior: `importPackage` sets `compileStatus = 'pending'` and waits for the
cognitive promotion queue worker to recompile.

New behavior: If the imported package's `compiled_prompt` is non-empty, activate as static:
```ts
// In AbilityService.importPackage
if (pkg.manifest.compiled_prompt && pkg.manifest.compiled_prompt.trim()) {
  this.#activateStatic(ability.id, pkg.manifest.compiled_prompt);
}
```

Pre-built abilities from the hub are usable within milliseconds of install.

### 1.3 Compile-On-Demand (not on creation)

Remove the implicit compile trigger from `AbilityService.create`.

New flow:
- Static mode: ready immediately.
- Compiled mode: `compileStatus = 'pending'` — operator explicitly hits **Compile** or
  the background worker picks it up if an LLM is configured.

This means a fresh install with no LLM still works — static abilities are fully functional.

---

## Phase 2 — Env / Secret Injection (Kill K2.1)

**The exact gap**: `ClaudeCodeAdapterConfig.env` is a static `Record<string, string>`.
There is no mechanism for an Ability to inject env vars into a dispatch at runtime.

### 2.1 Ability Env Schema

Add to `AbilityRecord` and the `abilities` table:
```ts
// packages/core/src/types/ability.ts
envKeys: string[];        // env var names this ability requires (e.g. ['GITHUB_TOKEN'])
envSecretIds: string[];   // CredentialVault IDs resolved at dispatch time
```

Schema:
```sql
ALTER TABLE abilities ADD COLUMN env_keys TEXT DEFAULT '[]';
ALTER TABLE abilities ADD COLUMN env_secret_ids TEXT DEFAULT '[]';
```

### 2.2 AbilityService.resolveEnv

New method that resolves env vars for an ability at dispatch time:
```ts
resolveEnv(abilityId: string, credentialVault: CredentialVault): Record<string, string>
```

- Reads `envSecretIds`, decrypts each via `CredentialVault`.
- Reads `envKeys`, checks `process.env` for each — only injects if missing (no overwrite).
- Returns merged `Record<string, string>`.

### 2.3 Engine Integration

In **`#buildAbilityBlock`** (WorkflowEngine.ts:1983), after resolving injected abilities:

```ts
const abilityEnv: Record<string, string> = {};
for (const entry of injected) {
  const env = this.deps.abilities.resolveEnv(entry.id, this.deps.credentialVault);
  Object.assign(abilityEnv, env); // later abilities override earlier on collision
}
```

Then pass `abilityEnv` into the task build path so adapters can apply it.

### 2.4 NormalizedTask Extension

```ts
// packages/core/src/types/adapter.ts
export interface NormalizedTask {
  // existing fields unchanged
  abilityEnv?: Record<string, string>;  // env vars contributed by injected abilities
}
```

Each adapter's `dispatchTask` merges `task.abilityEnv` into the subprocess env:

```ts
// ClaudeCodeAdapter.ts (example)
const env = {
  ...process.env,
  ...(this.config.env ?? {}),
  ...(task.abilityEnv ?? {}),   // ability env last = highest priority
};
```

**Security constraints**:
- `resolveEnv` enforces that credential IDs belong to the ability's workspace.
- Env is NOT logged in ledger events (it contains secrets).
- Env is NOT included in ability export packages (operator must re-link credentials).

---

## Phase 3 — Slash Commands (Kill K2.2)

**The gap**: Operators can type in the chat UI today, but there is no `/` prefix dispatch
that invokes an ability directly. SKILL.md skills register slash commands that bypass the
model entirely.

### 3.1 Ability Slash Command Schema

Add to `AbilityRecord`:
```ts
slashCommand: string | null;     // e.g. 'review' → invoked via /review
commandDispatch: 'model' | 'tool' | null;  // how the slash command fires
commandToolName: string | null;  // for dispatch='tool', the registered tool name
```

Schema:
```sql
ALTER TABLE abilities ADD COLUMN slash_command TEXT;
ALTER TABLE abilities ADD COLUMN command_dispatch TEXT;
ALTER TABLE abilities ADD COLUMN command_tool_name TEXT;
```

`UNIQUE` on `slash_command` scoped per-workspace is enforced at the service layer.

### 3.2 Chat Slash Command Resolution

In `chatSessionExecutor.ts`, before dispatching to the model, scan for `/` prefix:

```ts
function resolveSlashCommand(
  input: string,
  workspaceId: string,
  abilities: AbilityService
): SlashCommandResult | null {
  if (!input.startsWith('/')) return null;
  const [command, ...argParts] = input.slice(1).split(/\s+/);
  const ability = abilities.findBySlashCommand(workspaceId, command);
  if (!ability) return null;
  return { ability, args: argParts.join(' '), dispatch: ability.commandDispatch ?? 'model' };
}
```

**For `dispatch: 'model'`**: inject the ability's full XML block as a forced preamble before
the user message, then proceed with normal model call. The ability is guaranteed to fire
regardless of relevance score.

**For `dispatch: 'tool'`**: look up `commandToolName` in `agentisToolRegistry`, call it
directly with `{ command: args, commandName: slashCommand, abilitySlug: ability.slug }`,
return the result as the assistant response — no model call at all.

### 3.3 AbilityService.findBySlashCommand

```ts
findBySlashCommand(workspaceId: string, command: string): AbilityRecord | null {
  return this.db
    .select()
    .from(schema.abilities)
    .where(and(
      eq(schema.abilities.workspaceId, workspaceId),
      eq(schema.abilities.slashCommand, command),
      eq(schema.abilities.compileStatus, 'ready'),
    ))
    .get() ?? null;
}
```

### 3.4 REST API

```
GET  /v1/abilities/slash-commands            → list all slash commands in workspace
POST /v1/abilities/:id/slash-invoke           → programmatic slash dispatch
```

### 3.5 Harness Visibility (for OpenClaw / Hermes agents)

Add `slashCommands` to the `NormalizedTask.toolManifest` entries so the harness knows
which slash commands exist:

```ts
toolManifest: [
  { name: '/review', description: 'Code review specialist — …' },
  { name: '/plan', description: 'Planning specialist — …' },
]
```

The harness can expose these as native commands in its own UI. OpenClaw picks these up
from the tool manifest today.

---

## Phase 4 — Runtime Gating (Kill K2.3)

**The gap**: All compiled abilities are always eligible. SKILL.md has `requires.bins`,
`requires.env`, `requires.config`, `os` — abilities need a runtime gate equivalent.

### 4.1 Ability Gate Schema

Add to `AbilityRecord`:
```ts
gate: AbilityGate | null;
```

```ts
// packages/core/src/types/ability.ts
export interface AbilityGate {
  /** Env vars that MUST be set for this ability to fire. */
  requiresEnv?: string[];
  /** Agent affordances required (matches AdapterCapabilities.affordances). */
  requiresAffordances?: AgentAffordance[];
  /** OS filter — undefined means all platforms. */
  os?: ('win32' | 'darwin' | 'linux')[];
  /** Workspace brainSettings keys that must be truthy. */
  requiresConfig?: string[];
  /** If true, ALWAYS inject this ability regardless of all other gates and relevance. */
  always?: boolean;
}
```

Schema:
```sql
ALTER TABLE abilities ADD COLUMN gate TEXT DEFAULT NULL;
-- stored as JSON
```

### 4.2 Engine Gate Check

In **`#buildAbilityBlock`**, before scoring abilities against the task, filter with:

```ts
function abilityPassesGate(
  ability: AbilityRecord,
  agentId: string | undefined,
  adapters: AdapterManager,
  brainSettings: Record<string, unknown>,
): boolean {
  const gate = ability.gate;
  if (!gate) return true;
  if (gate.always) return true;
  if (gate.os && !gate.os.includes(process.platform as any)) return false;
  if (gate.requiresEnv) {
    for (const key of gate.requiresEnv) {
      if (!process.env[key]) return false;
    }
  }
  if (gate.requiresConfig) {
    for (const path of gate.requiresConfig) {
      if (!brainSettings[path]) return false;
    }
  }
  if (gate.requiresAffordances && agentId) {
    const caps = adapters.capabilities(agentId);
    for (const aff of gate.requiresAffordances) {
      if (!caps?.affordances?.[aff]) return false;
    }
  }
  return true;
}
```

**`always: true` abilities** skip the cosine relevance check entirely and always inject
first — this replaces the concept of "always-on bundled skills."

### 4.3 Gate is a Runtime Predicate

Gate check is intentionally evaluated at dispatch time, not at compile time. An ability
compiled on a Mac can gate-filter on Windows agents at runtime — the gate is a runtime
predicate, not a build-time one.

---

## Phase 5 — Token Efficiency (Kill K4)

**The problem**: `estimateTokens` uses `text.length / 4` — no real feedback, no compression,
no awareness of the model's actual context window.

### 5.1 Token Counting Upgrade

Replace `estimateTokens` with a proper BPE tokenizer:

```ts
// packages/core/src/tokens.ts
import { encode } from 'gpt-tokenizer'; // ~50KB wasm, no network dependency

export function countTokens(text: string): number {
  return encode(text).length;
}
```

All callers (`renderAbilityXml`, `WorkflowEngine.#buildAbilityBlock`,
`abilityService.buildContextBlock`) switch to `countTokens`.

**Impact**: The estimate error is currently ±30%. After this it drops to <2%, meaning
`ABILITY_TOKEN_BUDGET` becomes a real hard cap.

### 5.2 Per-Model Context Budget

Add `contextWindowTokens` to `AdapterCapabilities`:
```ts
contextWindowTokens?: number;   // e.g. 200_000 for claude-3.5, 128_000 for gpt-4o
```

The engine computes:
```ts
const modelBudget = capabilities?.contextWindowTokens ?? CONSTANTS.ABILITY_TOKEN_BUDGET;
const safetyMargin = 0.15; // reserve 15% for the model's own output
const abilityBudget = Math.min(
  workspaceBudget,
  Math.floor(modelBudget * safetyMargin),
);
```

### 5.3 XML Compact Mode

Introduce a **compact mode** for static abilities (no examples/knowledge):

```xml
<!-- Full mode (compiled ability with examples) -->
<ability name="React Engineer" version="3" domain="frontend">
  <persona>You are a senior React engineer…</persona>
  <specs>stack: React 19; styling: Tailwind v4</specs>
  <rules>ALWAYS: use TypeScript strict; NEVER: use class components</rules>
  <examples retrieved="2" method="knn">…</examples>
</ability>

<!-- Compact mode (static / always / pinned with no examples) -->
<ability name="React Engineer" domain="frontend" compact="1">You are a senior React engineer… Stack: React 19/Tailwind v4. Always: TypeScript strict. Never: class components.</ability>
```

Compact mode is 60-75% fewer tokens for simple abilities. The engine picks compact mode when:
- The ability has no examples AND no knowledge, OR
- The remaining budget is below `2 × CONSTANTS.MIN_ABILITY_TOKENS`.

### 5.4 Session-Turn Deduplication

In multi-turn sessions, the same pinned abilities inject on every turn. Add a
**session-level ability cache** keyed on `(sessionId, abilityId, version)`:

```ts
// If the ability's version and compiled_prompt haven't changed since
// the last turn, inject a reference token only:
<ability name="React Engineer" ref="cached" />
```

The harness already has the full block from turn 1 in its context window — the reference
prevents re-injection.

**Estimated saving**: 300-1,500 tokens per turn for workspaces with 3+ pinned abilities.

### 5.5 Per-Ability Relevance Threshold

Add `minRelevanceScore: number | null` to `AbilityRecord` so individual abilities
can tune their firing threshold:

```ts
// AbilityRecord
minRelevanceScore: number | null;  // null = use workspace default (ABILITY_MIN_RELEVANCE_SCORE)
```

A "defensive security reviewer" ability fires at low relevance (0.3) for any task.
A "Kubernetes deployment" ability fires only at high relevance (0.75).

Schema:
```sql
ALTER TABLE abilities ADD COLUMN min_relevance_score REAL DEFAULT NULL;
```

---

## Phase 6 — Compile Resilience (Zero-SPOF Guarantee)

**The current failure mode**: If no LLM is configured, every ability stays `pending`.
The 4-step compiler degrades gracefully but never reaches `ready`.

### 6.1 Always-Ready Guarantee

**Rule**: Any ability with a non-empty `compiledPrompt` OR non-empty `name + description`
MUST reach `compileStatus = 'ready'` within 1 second of creation on any installation.

Implementation:

1. After step 4 (persona synthesis), if `llmAvailable = false`, the `#deterministicPersona`
   always returns a string. This part already works.

2. **Add a startup sweep** in bootstrap: on server start, query for all abilities with
   `compileStatus IN ('pending', 'failed')` that have a non-null `compiledPrompt`. For
   each, call `#activateStatic()` immediately — they don't need the LLM pipeline.

3. Static abilities never enter `dirty` state from field edits — they re-hash synchronously.

### 6.2 Compile Error Actionability

Map compile failure categories to actionable messages:
```ts
const COMPILE_ERROR_MAP = {
  'embedding timed out': 'Embedding provider is unreachable. Check AGENTIS_EVALUATOR_BASE_URL.',
  'LLM probe failed': 'No LLM configured. Compiled with deterministic persona. Configure a model in Settings → Abilities to improve quality.',
  'Cannot read properties': 'Internal error. Try recompiling.',
};
```

### 6.3 Compile Health Endpoint

```
GET /v1/abilities/compile-health

→ {
    total: number,
    ready: number,
    pending: number,
    failed: number,
    dirty: number,
    llmAvailable: boolean,
    embeddingProviderDimension: number,
  }
```

---

## Phase 7 — Structured Ability Injection in NormalizedTask

**The gap**: Harnesses receive ability context as raw text in `description`. They cannot
programmatically inspect which abilities fired, what their tool hints are, or route to a
different model based on the active ability.

### 7.1 NormalizedTask.abilities Field

```ts
// packages/core/src/types/adapter.ts
export interface NormalizedTask {
  // existing fields unchanged
  abilities?: InjectedAbility[];
}

export interface InjectedAbility {
  id: string;
  name: string;
  slug: string;
  score: number;           // 0–1 relevance score (1.0 for pinned)
  mode: 'pinned' | 'semantic' | 'slash';
  toolHints: string[];     // the ability's tool_hints — harness can pre-load tools
  slashCommand: string | null;
}
```

### 7.2 Why This Matters

With `abilities` structured on the task:
- **OpenClaw**: can display active abilities in the agent UI as badges.
- **Hermes**: can pre-load tools from `toolHints` before the LLM starts generating.
- **ClaudeCode**: can set `allowedTools` dynamically based on `toolHints`.
- **Any adapter**: can route to a specialist model when a specific ability fires.

### 7.3 Per-Ability Model Routing

Add `preferredModel: string | null` to `AbilityRecord`. When an ability with a
`preferredModel` fires, the engine passes a model hint:

```ts
// NormalizedTask
preferredModel?: string;   // set if any injected ability specifies one; first pinned wins
```

Schema:
```sql
ALTER TABLE abilities ADD COLUMN preferred_model TEXT DEFAULT NULL;
```

---

## Phase 8 — AgentisHub Protocol (Kill K3)

**The gap**: ClawHub is live. Agentis has `hubSlug`/`hubVersion` on the schema but no
registry, no install flow, no trust verification.

### 8.1 Hub Protocol (Minimal)

**Registry entry format** (what the hub serves at `GET /v1/abilities/:slug`):
```json
{
  "slug": "react-engineer",
  "version": "1.0.0",
  "sha256": "abc123…",
  "download_url": "https://hub.agentis.dev/abilities/react-engineer-1.0.0.ability",
  "manifest": { "...": "AbilityManifest" },
  "scan": { "status": "clean", "checkedAt": "2026-06-01T…" }
}
```

**Install flow**:
```
POST /v1/abilities/hub-install
{ "slug": "react-engineer", "hubUrl": "https://hub.agentis.dev" }

1. Downloads the .ability package
2. Verifies SHA-256 against the registry manifest
3. Scans with RegistryScanner (existing, reuse)
4. Calls AbilityService.importPackage
5. Calls #activateStatic if compiledPrompt present
6. Returns { ability } with compileStatus='ready'
```

### 8.2 Trust Envelope

Each installed hub ability records:
```sql
ALTER TABLE abilities ADD COLUMN hub_sha256 TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN hub_url TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN hub_verified_at TEXT DEFAULT NULL;
```

`GET /v1/abilities/:id/verify` re-fetches the registry entry, re-checks SHA-256, and
returns `{ verified: boolean, sha256Match: boolean, scanStatus: string }`.

### 8.3 Ability Publish

```
POST /v1/abilities/:id/publish
{ "hubUrl": "https://hub.agentis.dev", "apiKey": "…" }
```

Calls `AbilityService.export()`, uploads to the hub, stores `hubSlug`/`hubVersion`.

---

## Phase 9 — Ability Gating for Chat-Native Dispatch

### 9.1 Chat-Mode Ability Selection

In direct chat (no workflow), ability injection is not guaranteed today. Fix: wire
`#buildAbilityBlock` into `chatSessionExecutor.buildSystemPrompt()` using the same
`WorkflowEngine.deps.abilities` reference.

### 9.2 Agent-Role Gating

Add to `AbilityGate`:
```ts
requiresAgentRole?: AgentRole[];   // Only fire if the dispatching agent has one of these roles
```

A "Lead Developer" ability only fires for orchestrators. A "Code Reviewer" fires for
workers and managers. This is something SKILL.md cannot express.

---

## Phase 10 — Automatic Flywheel

### 10.1 Automatic Example Promotion

After each successful `agent_task` node execution, the engine calls
`#enqueueSuccessfulBrainCapture`. Extend this to check:

- Did any ability fire during this task? (check `injected` array from `#buildAbilityBlock`)
- If yes, queue an ability flywheel event.

The `CognitivePromotionQueueWorker` handles this:
```ts
case 'ability_flywheel': {
  // Ask the LLM: "Is this output a good example for the '<ability>' specialist?"
  // If yes: call AbilityService.addExample (source='promoted_from_run')
  // If example count crosses threshold: re-queue compile
}
```

### 10.2 Ability Usage Metrics

```
GET /v1/abilities/:id/metrics?window=7d

→ {
    injectionsTotal: number,
    avgRelevanceScore: number,
    taskSuccessRateWhenInjected: number,
    examplesPromoted: number,
    topAgents: [{ agentId, count }],
    topWorkflows: [{ workflowId, count }],
  }
```

---

## Schema Migration (All at Once)

```sql
-- migration: abilities_v2
ALTER TABLE abilities ADD COLUMN mode TEXT NOT NULL DEFAULT 'compiled';
ALTER TABLE abilities ADD COLUMN slash_command TEXT;
ALTER TABLE abilities ADD COLUMN command_dispatch TEXT;
ALTER TABLE abilities ADD COLUMN command_tool_name TEXT;
ALTER TABLE abilities ADD COLUMN env_keys TEXT DEFAULT '[]';
ALTER TABLE abilities ADD COLUMN env_secret_ids TEXT DEFAULT '[]';
ALTER TABLE abilities ADD COLUMN gate TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN min_relevance_score REAL DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN preferred_model TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN hub_sha256 TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN hub_url TEXT DEFAULT NULL;
ALTER TABLE abilities ADD COLUMN hub_verified_at TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS abilities_slash_command_workspace
  ON abilities(workspace_id, slash_command)
  WHERE slash_command IS NOT NULL;
```

---

## Execution Order

```
Phase 1  (Zero-compile)         — no dependencies, do first
Phase 6  (Compile resilience)   — no dependencies, parallel with Phase 1
Phase 2  (Env injection)        — depends on Phase 1 schema
Phase 4  (Gating)               — depends on Phase 1 schema
Phase 5  (Token efficiency)     — depends on nothing, parallel
Phase 3  (Slash commands)       — depends on Phase 1
Phase 7  (NormalizedTask)       — depends on Phase 2 + Phase 3 schema
Phase 8  (Hub)                  — depends on Phase 1 import flow
Phase 9  (Chat-mode)            — depends on Phase 1 + Phase 4
Phase 10 (Flywheel)             — depends on Phase 7
```

---

## What Abilities Do That SKILL.md Never Will

These are the strategic moats — not parity items, genuine advantages:

| Advantage | Why SKILL.md cannot match this |
|---|---|
| **Semantic selection** | SKILL.md selects by env/binary presence. Abilities select by cosine similarity to the actual task. An ability fires when the task needs it — not because a flag is set. |
| **Few-shot KNN retrieval** | SKILL.md has static text. Abilities serve the most relevant examples from a curated library, scored against the current task. The model gets better behavioral examples, not more text. |
| **Learning flywheel** | Every successful run can promote its output as a new example. SKILL.md is a static file — you update it by hand. |
| **Compile-time persona synthesis** | The LLM writes a tight, first-person behavioral persona from specs + examples. SKILL.md is whatever you type. |
| **Token budget enforcement** | The engine enforces a hard token budget per ability and across the workspace. SKILL.md injects in full, always. |
| **Observability** | Every injection is recorded with relevance score, token cost, and run outcome. SKILL.md has no equivalent. |
| **Agent pinning** | Specific agents can be hard-wired to specific abilities. SKILL.md is all-or-nothing per harness config. |
| **Cross-adapter portability** | One ability works for ClaudeCode, Codex, OpenClaw, Hermes, HTTP. SKILL.md is harness-specific. |
| **Agent-role gating** | An ability can restrict itself to orchestrators, planners, or workers. SKILL.md cannot express this. |
| **Model routing** | An ability can request a specific model at dispatch time. SKILL.md cannot. |

---

## Open Questions

> **These decisions block implementation of Phase 3 and Phase 7.**

1. **Slash command scope**: Should slash commands be workspace-global or per-agent? The
   schema uses `UNIQUE(workspace_id, slash_command)` — all agents share the slash namespace.
   Should agents be able to override or disable workspace-level slash commands?

2. **Env secret resolution timing**: Resolved at dispatch time (per-task, most secure) or
   at agent startup (cached, faster)? Per-task means rotated secrets take effect immediately
   but adds a DB read per dispatch.

3. **Hub ownership model**: Standalone service (separate deploy) or embedded in Agentis
   behind an opt-in flag? An embedded hub is simpler but creates namespace collision between
   workspace ability slugs and global hub slugs.

4. **Compact mode trigger**: Opt-in per ability, or automatic when the engine detects budget
   pressure? Recommend: automatic, with a `forceFullXml: boolean` escape hatch.

5. **Token counting dependency**: `gpt-tokenizer` adds a wasm dependency (49KB, MIT license).
   Acceptable? Alternatives: keep the heuristic but calibrate per model family.

---

## Definition of Done

An ability must be able to do everything in this checklist without a SKILL.md file:

- [ ] Created without an LLM configured → reaches `ready` in < 1 second (Phase 1)
- [ ] Injects `GITHUB_TOKEN` from a Credential into a ClaudeCode subprocess env (Phase 2)
- [ ] Registered as `/review` → typing `/review fix this` in chat invokes it (Phase 3)
- [ ] Gated to only fire on agents with `fileSystem` affordance (Phase 4)
- [ ] Token budget is a real token count, not a character estimate (Phase 5)
- [ ] Compile failure shows an actionable error message (Phase 6)
- [ ] Harness receives `task.abilities` array with tool hints (Phase 7)
- [ ] Installable from hub URL with SHA-256 verification (Phase 8)
- [ ] Fires in direct chat sessions, not just workflow engine dispatches (Phase 9)
- [ ] Successful task outputs auto-propose new examples (Phase 10)
