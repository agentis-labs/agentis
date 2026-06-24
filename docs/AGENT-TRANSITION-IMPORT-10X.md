# Agent Transition & Import — 10x Masterplan

**"Bring your agents."** Detect the agents a user already runs outside Agentis
(Claude Code, Codex, Cursor, Hermes — *especially Hermes multi-agent rosters*),
and transition them in whole: identity, runtime config, model, **and their real
accumulated memory** — routed into the Agentis Brain at the right scope (the
agent's private Brain *and* the workspace Brain).

The transition must feel *continuous*: the agent carries forward what it already
knew instead of starting from zero. This is core to Agentis' proposition — the
switching cost to adopt Agentis should be ~0.

> Status: **SHIPPED & VERIFIED (2026-06-16)** — Track R + P0–P4 complete;
> api/web/core typecheck clean; 15 import+ingestion tests green. Builds on
> `UNIVERSAL-HARNESS-ARCHITECTURE.md`, `AGENT-ONBOARDING-REPLAN.md`, and the Brain
> (`docs/brain/*`). Extends existing seams — **no parallel subsystem** (governing
> principle: never duplicate). §3–§9 describe the design; the **as-built names +
> file manifest** are in §12–§13. Where the two differ, §13 is authoritative.

---

## 0. What already exists (the foundation — do not rebuild)

| Seam | File | Role today |
|---|---|---|
| Runtime detection | `services/harnessProbe.ts` → `detectHarnesses()` | Finds installed CLI runtimes + auth + config (claude_code / codex / cursor / hermes_agent / openclaw / http). `/v1/harness/detect`. |
| Instruction-file reader | `services/agentInstructionFiles.ts` → `listAgentInstructionFiles()` | Reads an agent's instruction files (CLAUDE.md, ~/.codex/AGENTS.md, .cursorrules, per-agent home AGENTS.md). |
| Memory ingestion | `services/harnessMemoryIngestion.ts` | Distills instruction files → agent Brain via `EpisodicMemoryStore`. Quality gate + content-hash + semantic dedup + idempotent. `preview()` / `commit()`. |
| Ingestion API | `routes/agents.ts` | `GET /:id/memory/ingest/preview`, `POST /:id/memory/ingest`. |
| Ingestion UI | `components/agents/AgentMemoryIngestPanel.tsx` | Per-agent scan → review → import. |
| Agent creation | `services/agentCommission.ts` → `commissionAgent()` | Creates an Agentis agent (identity + config + model + registers adapter). |
| Per-agent home | `services/harnessAgentHome.ts` | Managed cwd + native `AGENTS.md` per agent. |
| Brain sink | `services/episodicMemoryStore.ts` | One physical store. `scopeId = agentId` ⇒ agent-private; **falsy `scopeId` ⇒ workspace-wide**. |
| Formation gate | `services/brainFormation.ts` (FormationJudge) | Mem0-style staged formation; wired via `setFormationCompleter`. |

**The current flow assumes the Agentis agent already exists and only reads its
instruction files.** This plan closes the four gaps below.

---

## 1. The four gaps (why this is more than the panel we have)

1. **Memory ≠ instruction files.** Agents keep *real* memory the ingester never
   reads:
   - Claude Code: `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` + `memory/*.md`
     (structured fact files with frontmatter — *exactly the user's own setup*),
     plus session learnings.
   - Hermes: per-agent memory under the Hermes home / per-agent dirs.
   - Codex: `~/.codex/` history + memory.
   These are richer and more structured than CLAUDE.md and carry the *durable
   residue* we actually want.

2. **No discovery → create.** There is detection of *runtimes* but no
   enumeration of *agents*, and no path that turns an external agent into an
   Agentis agent. The user must already have hand-created the agent.

3. **No multi-agent fan-out.** One harness home defines **many** agents:
   - Claude Code subagents: `~/.claude/agents/*.md` + `<project>/.claude/agents/*.md`
     (each has frontmatter `name` / `description` / `tools`).
   - Hermes: a roster of agents ("multiple agents mainly").
   Each must become a distinct Agentis agent.

4. **Agent scope only.** Shared project knowledge (a repo's `CLAUDE.md`
   conventions, team rules) belongs in the **workspace** Brain, not buried in one
   agent. Per Brain B7: **scope = applicability, not source location.**

---

## 2. Foundational reframe — agents are Agentis-proprietary; the runtime is a *binding*

> Operator directive (2026-06-16): **agents are not fixed to a runtime. An agent
> is an Agentis-native entity, not a Claude Code / Codex / Hermes agent.**

This reshapes import at the root. Importing an external Claude Code agent does
**not** create "a claude_code agent in Agentis." It creates an **Agentis agent**
whose *durable essence* — name, role, persona, **Brain/memory**, abilities,
hierarchy — is Agentis-owned and portable, and whose *current runtime* is one
swappable **binding** you can later change to Codex, Hermes, a local model, etc.
**without losing identity or memory.**

**Current reality (the gap):** `commissionAgent()` takes `adapterType` as a
required field and `agentMutations.ts` re-registers `existing.adapterType` on
every update — there is **no rebind path**. The agent *is* welded to its runtime
at birth. The Brain is already runtime-independent (`scopeId = agentId`,
`EpisodicMemoryStore`), so the essence is portable; only the binding is welded.

**Workstream R — Runtime Binding (prerequisite track, runs alongside P0/P1):**
1. Treat `(adapterType, config, runtimeModel)` as a named **RuntimeBinding** on
   the agent, conceptually separate from identity. (No new table required for V1
   — keep the columns, but model them as a swappable binding and stop treating
   `adapterType` as identity.)
2. Add `switchRuntime(agentId, { adapterType, config, runtimeModel })` —
   tears down the old adapter registration, registers the new one, **leaves
   identity + Brain + abilities + hierarchy untouched**. Surface as
   `POST /v1/agents/:id/runtime`.
3. UI: a **Runtime** selector on the agent (RuntimePicker already exists) that
   *rebinds* instead of forcing re-creation; "running on Claude Code · switch →".
4. Import (L3 below) sets the *initial* binding from the discovered harness but
   marks it swappable from the first screen.

This makes the transition truly smooth: a user brings their Claude Code agent in,
and later runs the *same agent* (same memory, same persona) on whatever runtime
they prefer — the agent is theirs, not the runtime's.

---

## 3. Architecture — three new thin layers over the existing spine

Naming is deliberate. We avoid the overloaded words: **adapter** (= harness
`AdapterManager`), **connector** (= `integration-${service}`), and
**KnowledgeSource** (= the Grounding external-source system). This domain's
prefix is already `harness*`, so we stay there.

```
                         ┌─────────────────────────────────────────────┐
   detect runtimes  ──▶  │ harnessProbe.detectHarnesses()  (EXISTS)     │
                         └─────────────────────────────────────────────┘
                                          │
   enumerate agents ──▶  ┌─────────────────────────────────────────────┐
        (NEW: L1)        │ harnessDiscovery.discoverAgents(env)         │
                         │   per harness → DiscoveredAgent[]            │
                         └─────────────────────────────────────────────┘
                                          │  (normalized bundle)
   read everything  ──▶  ┌─────────────────────────────────────────────┐
        (NEW: L2)        │ harnessImportSources/<harness>.ts           │
                         │   identity + config + memory files          │
                         │   (generalizes agentInstructionFiles)       │
                         └─────────────────────────────────────────────┘
                                          │
   transition in    ──▶  ┌─────────────────────────────────────────────┐
        (NEW: L3)        │ harnessAgentImport.importAgent()            │
                         │   commissionAgent()  +  scoped ingest       │
                         │   (reuses harnessMemoryIngestion sink)      │
                         └─────────────────────────────────────────────┘
```

### L1 — discovery spine *(as built: `services/harnessImport/registry.ts`)*

`discoverAgents(opts?) → DiscoveredAgent[]`. For each runtime found by
`detectHarnesses()`, walk that harness's *agent locations* (§4) and emit a
normalized record. One harness can yield many. (The plan called this
`harnessDiscovery.ts`; it shipped inside `harnessImport/registry.ts` so the
sources, types and spine live in one cohesive folder — see §13.)

```ts
interface DiscoveredAgent {
  adapterType: V1HarnessAdapterType;
  externalId: string;          // stable id within the harness (path/slug) → idempotency key
  name: string;                // from frontmatter / dir name / config
  role?: string | null;        // inferred (orchestrator/worker) where the harness encodes it
  persona?: string;            // system prompt / description
  detectedModel?: string | null;
  config: Record<string, unknown>;     // ready for commissionAgent (binaryPath, model, mcp, cwd…)
  origin: { harness: string; rootPath: string };
  // as built: cheap roster counts instead of lazy source refs
  summary: { memoryFiles: number; workspaceFiles: number; agentFiles: number };
}
// `alreadyImported: { agentId } | null` is added by the orchestrator on the
// `DiscoveredAgentRow` it returns (not on the base type) — see §13.
```

`alreadyImported` is resolved by stamping `agents.config.importOrigin =
{ adapterType, externalId }` at import time and matching on re-scan → **re-runnable, never duplicates an agent.**

### L2 — sources *(as built: `services/harnessImport/sources/`)* (generalizes `agentInstructionFiles.ts`)

One module per harness exporting a small interface. `agentInstructionFiles.ts`
stays (back-compat for the live Instructions tab); these *add* the memory-store
reading it lacks and the agent-enumeration L1 needs.

```ts
interface HarnessImportSource {
  adapterType: V1HarnessAdapterType;
  /** Enumerate distinct agents this harness defines on disk / via gateway. */
  discover(ctx: DiscoverCtx): DiscoveredAgent[];
  /** Read raw identity + memory inputs for one discovered agent. */
  read(agent: DiscoveredAgent): ImportInputs;   // { instructionFiles, memoryFiles, persona, … }
}
```

`ImportInputs.memoryFiles` is the new surface: structured memory (frontmatter
typed) is preserved (type/scope hints survive), unstructured falls back to the
existing line distiller.

### L3 — `harnessAgentImport.ts` (the orchestrator)

```ts
// as built: batch-first, scope is derived from per-file hints (not a scopePlan arg)
importAgents(deps, { workspaceId, userId, specs: ImportAgentSpec[], env?, cwd? }) : Promise<ImportBatchResult>
// ImportAgentSpec = { externalId, overrides?: { name?, role?, reportsTo? }, acceptedHashes?, minQuality? }
// plus: discoverImportableAgents(), previewAgentImport(), checkImportUpdates()  (§13)
```

Steps, all idempotent:
1. **Create or find the agent** — if `alreadyImported`, reuse; else
   `commissionAgent()` with identity + config + model mapped from `discovered`.
2. **Ingest memory** — reuse `harnessMemoryIngestion`, extended to (a) read
   `ImportInputs.memoryFiles`, (b) **route each atom to agent vs workspace scope**
   (§5), (c) pass through the **FormationJudge** / formation pipeline so imported
   memory is formed exactly like native memory (deterministic gate is the
   fallback). Step 1 sets the agent's *initial* RuntimeBinding (§2), swappable.
3. **Stamp provenance** — `metadata.harness` (already) + `importOrigin` on the
   agent row + `source: 'harness_ingest'` on atoms (trust-calibrated below
   first-party observation).

Batch wrapper `importAgents([...])` for the fleet case.

---

## 4. The discovery map (where each harness keeps agents & memory)

| Harness | Agent definitions (→ N agents) | Workspace knowledge | Agent-personal memory |
|---|---|---|---|
| **Claude Code** | `~/.claude/agents/*.md`, `<cwd>/.claude/agents/*.md` (frontmatter name/desc/tools) | `<cwd>/CLAUDE.md`, `~/.claude/CLAUDE.md` | `~/.claude/projects/<enc-cwd>/memory/MEMORY.md` + `memory/*.md` |
| **Hermes (multi)** | Hermes roster under `~/.hermes/` (+ per-agent dirs) — **primary multi-agent case** | `~/.hermes/AGENTS.md` / project `AGENTS.md` | per-agent memory dir |
| **Codex** | single agent (home) | `~/.codex/AGENTS.md`, project `AGENTS.md` | `~/.codex/` history/memory |
| **Cursor** | single agent | `.cursorrules`, `.cursor/rules/*.mdc` | (rules only) |
| **OpenClaw / HTTP** | **as built:** one identity-only agent when an endpoint is *configured* (no roster protocol exists to enumerate — §13) | n/a (remote) | remote — n/a |

The map is **declarative per source module** so adding a harness = adding one
file, not touching the orchestrator.

---

## 5. Scope routing & the formation pipeline (the "AND the workspace" requirement)

Per Brain B7 — **scope = applicability, not where the bytes lived.**

**The importer does NOT classify constitutional-vs-ordinary itself** (operator
chose "something else" over both bespoke options — and rightly: a bespoke
classifier here would fork the Brain). Instead, import is **just another source
feeding the canonical formation pipeline** that native capture already uses. The
pipeline (FormationJudge + write-policy + scope resolver) is the *single* place
that decides type, durability, and whether something is a governing/constitutional
rule. Import contributes only:

1. **A scope *hint*** (not a verdict): workspace for shared-cwd / project-typed
   knowledge; agent for persona + private lessons. The resolver may override.
2. **Structured type hints** preserved from memory frontmatter (`user` /
   `feedback` / `project` / `reference`) so the judge starts from real signal
   instead of re-deriving from prose.
3. **Earn breadth, don't assume it** (B7 #2): when the hint is uncertain, write
   *narrow* (agent scope); the reflection engine (C1) promotes recurring facts to
   workspace scope by reuse. **No blanket promotion at import.**

Net: whatever rule the Brain would apply to a natively-captured fact is exactly
what it applies to an imported one — zero special-casing, zero duplication. The
UI still shows the resulting scope per atom with a one-click override, so the
operator stays the final gate.

---

## 6. Trust & garbage control (reuse, don't reinvent)

- **Quality gate** — already in `harnessMemoryIngestion` (rejects URLs, table
  rows, boilerplate, first-person narration). Keep.
- **Formation pass** — route imported atoms through `FormationJudge` so a CLAUDE.md
  dump gets the same episodic/semantic separation as native capture.
- **Dedup + idempotency** — content-hash + semantic (already). Re-scan after the
  harness files evolve **reinforces**, never duplicates. Add agent-level
  idempotency via `importOrigin`.
- **Trust calibration** — imported atoms get source-derived trust (platform >
  workspace > runtime home), strictly below first-party Agentis observation, so a
  transitioned belief can be corrected by lived experience.

---

## 7. UX — the masterpiece: "Bring your agents"

One flow, four stages, reachable from the **AgentsPage empty-state** ("We found
**8 agents** on this machine — 3 Claude Code, 5 Hermes. Import them →") and a
standing **Import agents** action.

1. **Detect** — live runtime probe (existing `/v1/harness/detect`).
2. **Roster** — cards grouped by harness, one per `DiscoveredAgent`, each showing
   what we found: *persona ✓ · model ✓ · 12 memories · 4 workspace rules ·
   already imported ✗*. Select all / per-agent.
3. **Review** (expand a card) — editable name/role, hierarchy (`reportsTo`),
   and the memory candidate list with quality score, dedup verdict ("already
   known"), and **scope chip** (Agent ⇄ Workspace) per atom. Pre-selects new
   non-duplicate atoms (matches current panel behavior).
4. **Import** — progress per agent → deep-links to each created agent + a
   workspace Brain summary ("+37 atoms to this workspace, +112 across 8 agents").

`AgentMemoryIngestPanel` is **retained** as the per-agent "top-up" surface and
re-uses the same generalized preview/commit endpoints — no duplicate logic.

---

## 8. API surface (extends `/v1/harness`)

```
GET  /v1/harness/agents              → discoverAgents() roster (DiscoveredAgentRow[])
POST /v1/harness/agents/preview      → { externalId, cwd?, minQuality? } → identity + scope-routed
                                        memory candidates (with dedup verdicts)
POST /v1/harness/import              → { agents: [{ externalId, overrides?, acceptedHashes?, minQuality? }] }
                                        → batch importAgents(); returns { imported[], totalAtoms }
GET  /v1/harness/import/updates       → P4: per imported agent, { pendingNew } new memory (read-only)
POST /v1/agents/:id/runtime           → Track R: rebind runtime (adapterType, config?, runtimeModel?)
```

Existing `GET/POST /v1/agents/:id/memory/ingest*` stay (per-agent top-up). The
preview/commit core is shared. All `/v1/harness/*` import routes live in
`routes/harnessImport.ts`, mounted alongside `buildHarnessRoutes`.

---

## 9. Phasing

- **Track R — Runtime Binding (prerequisite, parallel to P0/P1).** Decouple
  identity from runtime: `switchRuntime()` + `POST /v1/agents/:id/runtime`,
  RuntimePicker rebinds in place, `adapterType` stops being identity (§2). This
  is what makes an imported agent *yours, not the runtime's*.
- **P0 — Discovery spine.** `harnessDiscovery.discoverAgents()` + `DiscoveredAgent`
  type + **all local harness source modules at once** (Claude Code, Hermes
  [multi-agent], Codex, Cursor) + `GET /v1/harness/agents`. Unit-tested against
  fixture homes. *No UI.*
- **P1 — Memory-source expansion.** Read real memory stores across all four
  (Claude `~/.claude/projects/*/memory/*.md`, Hermes per-agent, Codex history,
  Cursor rules) in L2; frontmatter-aware type hints; **scope routing** (§5) feeding
  the canonical formation pipeline. Generalize `harnessMemoryIngestion` to accept
  memory files + a scope resolver. Extend dedup to workspace scope.
- **P2 — Import orchestrator.** `harnessAgentImport.importAgent()` (sets the
  initial swappable RuntimeBinding) + `importOrigin` idempotency +
  `POST /v1/harness/import` (batch).
- **P3 — Onboarding UX.** The "Bring your agents" wizard (detect→roster→review→
  import) with the Runtime selector inline, AgentsPage empty-state hook, re-scan
  "N new". Retain per-agent panel as top-up.
- **P4 — Continuous transition.** *(as built: scheduled poll, not fs-watch)*
  `HarnessImportSyncService` re-scans imported agents on a cadence + on demand
  (`/import/updates`), emits `harness.import.updates`, and the wizard offers
  "N new · pull" — **approval-gated**, never silent auto-merge. Remote gateway
  *roster* enumeration stays out (no protocol — §13).

---

## 10. Non-negotiables (architecture baseline)

1. **No parallel store / no fork.** One Brain (`EpisodicMemoryStore`), one
   creation path (`commissionAgent`), one detection path (`detectHarnesses`). New
   code is thin layers, not a subsystem.
2. **Idempotent & re-runnable** at both levels (agent via `importOrigin`, atom
   via content hash + semantic dedup).
3. **Operator is the final gate** — preview → review → commit; nothing lands
   unseen; scope is shown and overridable.
4. **Model/harness-agnostic** — never branch on model family; per-harness
   knowledge lives only in the declarative source modules.
5. **Provenance + trust calibration** on everything imported, below first-party.
6. **Scope = applicability**, narrow-write/earn-breadth (Brain B7).

---

## 11. Resolved decisions & remaining open questions

**Resolved (operator, 2026-06-16):**
- **Agents are runtime-agnostic.** Identity/Brain/abilities are Agentis-owned;
  runtime is a swappable binding (§2, Track R). *This is now a foundational
  principle, not an option.*
- **No bespoke workspace-knowledge classification.** Import feeds the canonical
  formation pipeline; the Brain (not the importer) decides constitutional vs
  ordinary. Import supplies only scope + type *hints* (§5).
- **All local harnesses in P0/P1** — Claude Code, Hermes, Codex, Cursor together.

**Resolved by implementation (2026-06-16):**
- **Live-link vs snapshot?** → **Snapshot + approval-gated poll.** P4 ships as
  `HarnessImportSyncService` (scheduled re-scan) + `/import/updates` + wizard
  "pull" — never silent auto-merge.
- **OpenClaw/Hermes *remote* rosters?** → **Identity-only for configured
  endpoints; no roster enumeration.** Confirmed no gateway list-agents protocol
  exists, so none was fabricated. Local Hermes rosters are enumerated in P0.
- **Track R blast radius?** → **No migration.** V1 reinterprets the existing
  `adapterType`/`config`/`runtimeModel` columns as a swappable binding;
  `switchRuntime` persists them + re-registers the adapter.

**Genuinely still open (need substrate that does not exist yet):**
- **Remote *roster* enumeration** — blocked on a gateway "list agents" protocol.
- **fs-watch push** — intentionally not built; the scheduled poll + on-demand
  check covers the need without a fragile cross-platform watcher.

---

## 12. Implementation log

**2026-06-16 — Track R + P0–P3 shipped & verified (api + web typecheck clean; 5 new e2e import tests + 6 existing ingestion tests green).**

- **Track R (runtime rebind).** `switchRuntime()` in `agentCommission.ts` — persists the new `(adapterType, config, runtimeModel)` binding, tears down + re-registers the adapter, leaves identity/Brain/abilities/hierarchy untouched; same-adapter rebind merges prior config, cross-adapter starts fresh; paused agents just unregister; emits `AGENT_UPDATED`. Route `POST /v1/agents/:id/runtime` (`agentMutations.ts`, `switchRuntimeSchema`). Web: `AgentConfigPanel` now wires the (previously locked) `RuntimePicker.onAdapterChange` → `rebindRuntime()` → `switchAgentRuntime()`; selecting a different runtime rebinds in place.
- **P0 — discovery spine.** `services/harnessImport/` — `types.ts` (`DiscoveredAgent`/`ImportMemoryFile`/`HarnessImportSource` + scope hints), `fsScan.ts` (safe reads, frontmatter parse, `claudeProjectSlug` cwd→`~/.claude/projects/<slug>` encoder), `registry.ts` (`discoverAgents()` merges runtime detection's binary/model into each agent; `readAgentInputs()`). **All four local harnesses at once:** `sources/claudeCode.ts` (primary agent + memory store + subagents), `sources/hermes.ts` (multi-agent roster — flat files + per-agent dirs), `sources/codex.ts`, `sources/cursor.ts`.
- **P1 — real memory + scope routing.** Claude source reads `~/.claude/projects/*/memory/*.md` (skips the `MEMORY.md` pointer index), preserving frontmatter `type` as a hint; workspace instructions (`CLAUDE.md`) → workspace scope, `feedback`-typed → agent scope. `harnessMemoryIngestion` generalized: shared `distillContent` core, `previewImport`/`commitImport` ingest scope-hinted files, scope-aware dedup (`#findDuplicate` uses candidate scope), writes `scopeId = workspace?null:agentId`. Existing `preview`/`commit` (per-agent panel) preserved + refactored onto the shared commit core.
- **P2 — import orchestrator.** `harnessAgentImport.ts` — `discoverImportableAgents()` (annotates `alreadyImported` from `agents.config.importOrigin`), `previewAgentImport()`, `importAgents()` (commission new agent **paused** + initial swappable binding + scoped ingest; idempotent at agent + atom level). Routes `GET /v1/harness/agents`, `POST /v1/harness/agents/preview`, `POST /v1/harness/import` (`routes/harnessImport.ts`, mounted alongside `buildHarnessRoutes`).
- **P3 — UX.** `ImportAgentsWizard.tsx` ("Bring your agents"): detect → roster grouped by harness (persona/memory/workspace-rule counts, already-imported badge) → expandable per-agent memory review with **scope chips** (Workspace/Agent) → batch import → summary. Hooked into `AgentsPage` header button + empty-state secondary action. Client lib `lib/agentImport.ts`.
**2026-06-16 (cont.) — the three deferred items shipped & verified (api/web/core typecheck clean; 15 import+ingestion tests green, incl. 4 new).**

- **FormationJudge path (was deferred).** `HarnessMemoryIngestionService.setFormationPromoter()` — when a Formation model is wired, `commitImport` FORMS the accepted set through the canonical `SharedIntelligence.promote()` pipeline (per scope group: workspace `scopeId:null`, agent `scopeId:agentId`), so imported memory is third-person-rewritten, typed and reconciled (ADD/UPDATE/NOOP) exactly like native capture. **Deterministic write is the fallback** when the strict judge forms nothing — an operator-curated atom is never silently lost. Wired in bootstrap inside the `evaluatorRuntime` guard (so it only activates with a real model, never the episodic-staging fallback that would hide imports).
- **P4 continuous transition (was deferred).** `checkImportUpdates()` re-scans imported agents and reports `pendingNew` (new, non-duplicate atoms) — pure read, **approval-gated** (operator pulls via the idempotent import). `GET /v1/harness/import/updates`. `HarnessImportSyncService` (scheduled, 6h, env-overridable `AGENTIS_HARNESS_IMPORT_SYNC_MS`) emits `harness.import.updates` (new core event) per workspace with imports. Wizard fetches updates on scan and shows "N new · pull" on already-imported agents.
- **Remote endpoint import (was deferred — done honestly).** Confirmed **no gateway roster protocol exists** in the codebase, so we do NOT fabricate enumeration. Instead, a configured OpenClaw gateway / HTTP endpoint surfaces as ONE identity-only importable agent (registry, from detection) — importing makes it an Agentis-owned, runtime-swappable (Track R) agent. Local Hermes multi-agent rosters were already enumerated in P0.

**Still genuinely deferred (need external substrate that doesn't exist yet):** true remote *roster* enumeration (blocked on a gateway list-agents protocol); fs-watch push (the scheduled poll + on-demand check covers the need without a fragile cross-platform watcher).

---

## 12b. Post-pilot remediation & expansion (2026-06-17) — PLAN

First real import (operator machine) worked for Claude Code memory but exposed
seven issues + one expansion. Root causes verified in code.

### Bugs to fix

**B1 — Imported memory is invisible on the agent (scope mismatch).** The agent
Memory tab + Agent Brain query **agent scope** (`/v1/brain/agents/:id/memory`,
`scopeId=agentId`), but import routed Claude's `memory/*.md` to **workspace
scope** (frontmatter `type:` project/reference/user → workspace). Data is not
lost (workspace Brain holds it; re-scan shows "already known"), but the operator
who imported "the Claude Code agent" sees an empty agent.
- **Fix (default flip):** an imported agent's **personal memory store**
  (`~/.claude/projects/*/memory/*`) → **that agent's AGENT scope** (it is *that
  agent's* accumulated knowledge — belongs on it, and is visible). Only
  genuinely shared **rule/instruction files** (repo `CLAUDE.md`/`AGENTS.md`,
  `.cursorrules`) → **workspace**. The per-atom scope chip still lets the operator
  push a personal atom to the workspace.
- **Fix (visibility regardless of scope):** import success summary states *where*
  atoms landed with deep-links ("38 to this agent · 4 to the workspace Brain");
  the agent Memory page shows a banner when workspace atoms were transitioned via
  this agent (provenance = `metadata.harness` + `agentId` stamp, already written).

**B2 — All projects aggregated (count blowup / cross-project noise).**
`discoverAgents()` with no `cwd` reads **every** `~/.claude/projects/*/memory/*`
→ 200+ atoms from unrelated projects merged into one workspace.
- **Fix:** group Claude memory **by project** in discovery; the wizard lets the
  operator choose which project(s) to bring (default: none-all — explicit pick,
  or the current workspace's project when a `cwd` is known). Show per-project
  counts. Never silently dump every project.

**B3 — Empty harnesses surfaced + auto-selected.** Discovery gates on *directory
existence* (`~/.cursor` exists empty; `~/.codex`/`~/.hermes` homes exist with no
memory), so empty agents appear and are pre-checked.
- **Fix:** a harness agent is only surfaced when it has **real substance**
  (persona OR ≥1 memory OR ≥1 workspace rule). Truly-empty harnesses are hidden
  (or shown collapsed as "nothing to import"). Pre-selection only picks agents
  with importable content.

**B4 — Imported agents start paused; should be online.** `importAgents` sets
`isPaused:true`.
- **Fix:** create **online** — register the adapter (the runtime was just
  detected). On registration failure, fall back to `error` status (honest), not a
  silent pause. (Commission already maps register-failure → `error`.)

**B5 — Already-imported agents re-offered (looks like "import again").**
Already-imported cards render disabled but inline with importables.
- **Fix:** split the roster into **"New"** and a collapsed **"Already in
  Agentis"** group; the latter is non-selectable and only exposes "pull N new"
  when `/import/updates` reports changes.

**B6 — Imported-agent config page anomalies.** The runtime/config panel for a
freshly-imported agent showed issues.
- **Fix:** ensure imported `config` is valid for the runtime panel — strip/Ignore
  the `importOrigin` marker in the runtime view, guarantee `binaryPath`/`cwd`
  come from detection so Connect works, and verify the panel renders cleanly for
  each harness. (Investigate exact symptom from the pilot before coding.)

### Expansion

**B7 — Skills & plugins → Abilities (the "greater question").** Claude/Cursor
skills (`SKILL.md`) and plugin capability folders are **capabilities, not
memories** — they map to the Agentis **Abilities** subsystem, NOT the Brain.
- **P6 — auto skill detection + transition:** discovery scans for the operator's
  OWN skills (`~/.claude/skills/*/SKILL.md`, project `.claude/skills/*`) and
  surfaces them in the wizard as importable **Abilities** via
  `AbilityCreationService.draft({ from: 'harness_skill', material })` (new origin
  kind), workspace- or agent-pinned. Auto-detection must be effortless.
- **Manual skill → Ability import:** the wizard also offers a manual path —
  point at *any* skill folder (or marketplace plugin skill) and transform it into
  an Agentis Ability. Marketplace/vendor skills (`external_plugins/*/skills/*`)
  are offered but **never auto-selected** (the operator opts in per skill).
- **General folder import:** point at any folder; Agentis classifies each file —
  `SKILL.md`/skill dir → Ability; instruction/memory `.md` → Brain (scope-routed)
  — routed to workspace or a chosen agent. The on-ramp for a full "bring your
  whole setup" transition.

**B8 — NEVER import harness-internal / vendor / cache / tooling content.** Verified
on the operator's machine: `~/.codex/plugins/cache/openai-bundled/browser/.../
docs/capabilities/*` are **vendor docs about how to use Codex's bundled browser
tool** — irrelevant to the user and to Agentis. Importing them would teach the
Brain about Codex internals, not the user's work.
- **Exclusion rule (allow-list user-authored, deny harness-internal):**
  - **Deny** any path containing `plugins/cache/`, `/cache/`, `node_modules/`,
    `.sandbox`, `archived_sessions/`, `logs`, `attachments/`, `assets/`, vendor
    bundles (`*-bundled`), `.codex-plugin/`, and harness/tool self-docs
    (`docs/`, `capabilities/`, `api*.md`, `troubleshooting*.md` *under a plugin/
    vendor dir*). Deny binaries + `*.sqlite` (parse later, separately).
  - **Allow** only user-authored memory + instructions: `~/.codex/memories/*.md`
    (NOT `~/.codex/cache`), `~/.claude/projects/*/memory/*.md`, user `AGENTS.md`/
    `CLAUDE.md`/`.cursorrules`, and user skills.
  - Bug it also fixes: the Codex source currently reads `~/.codex/memory/` — the
    real dir is `~/.codex/memories/` (+ a `memories_*.sqlite` store, deferred).

### Decisions (LOCKED — operator, 2026-06-17)
- **D1 = Agent scope.** An imported agent's personal memory store → that agent's
  AGENT scope (visible on it). Shared rule files → workspace. Per-atom chip
  overrides. (Fixes B1.)
- **D2 = Agentis Abilities**, with **automatic detection prioritized** + a
  **manual "transform skill → Ability"** path in the import.
- **D3 = Hide empty harnesses**, guarded by **B8** so harness-internal/vendor
  content is never mistaken for substance.

### B9 — Transition UX overhaul (operator: "perform a FULL transition")

The current wizard is a flat list of inline-expanding cards with a muddy CTA, no
harness logos, and no real notion of a *complete* agent. It collapses under a
dozen agents. Reframe import as a **full transition**: one operation brings an
agent's whole self — identity + **logo** + runtime + memories + skills(→abilities)
— pre-connected, with a clear manifest of what lands.

**Principles**
1. **Full transition, not a memory dump.** One agent = identity + runtime binding
   (swappable) + memories (agent-scoped + workspace rules) + skills→Abilities, all
   attached on import. The agent lands **complete and online**.
2. **Show the manifest.** Each agent states exactly what will transition:
   *logo · persona ✓ · 38 memories · 5 skills→abilities · model · runtime*.
3. **Scale to dozens.** Master–detail, grouped, searchable, virtualized — never a
   wall of expanding cards.
4. **One unmistakable CTA.** Primary "Transition N agents →" (accent); everything
   else is secondary/ghost.

**Layout — master/detail (replaces inline expand)**
- **Header:** harness logos + a single summary line — "Found **14 agents** across
  Claude Code · Hermes · Codex — **312 memories**, **22 skills**." Primary CTA +
  ghost "Re-scan".
- **Left roster rail:** grouped by harness (logo + count); each agent a *compact*
  row — harness **logo avatar**, name, manifest chips ("38 mem · 5 skills"),
  checkbox; per-group select-all; search box; **"Already in Agentis"** collapsed
  group (B5). Virtualized for dozens.
- **Right detail pane** (selected agent = its **transition manifest**): Identity
  (editable name/role, runtime + logo, model), Memories (scope-split list w/ chips
  + dedup), Skills → Abilities (list, auto vs manual). "Everything here connects
  to this agent on transition."
- **Result state:** per-agent confirmation rows — "Claude Code · **online** · 38
  memories · 5 abilities" with deep-links to each agent.

**Reuse:** harness logos = `components/icons` (`ClaudeIcon`/`CodexIcon`/
`CursorIcon`/`HermesIcon`/…), via RuntimePicker's `{id,title,icon}` map — the same
marks used everywhere else for agents. Avatar of an imported agent = its harness
logo (so the fleet reads consistently).

### B10 — Reframe the Runtime subpage around "runtime is a swappable binding"

The runtime subpage contradicts Track R and is cluttered. Verified:
- `RuntimePicker.tsx:253` — in `editing` mode it shows a **locked** adapter header
  reading *"To switch harness, recreate the agent"* and **hides the adapter
  chooser**, so the Track R `onAdapterChange → switchRuntime` wiring is currently
  **unreachable** from the UI. The copy is also now false.
- `RuntimeTab` stacks `RuntimeNativePanel` + a heavy "Agentis runtime policy"
  `AgentConfigPanel`; the **Instructions** tab *also* renders `RuntimeNativePanel`
  → overlap + confusion.

**Fix — make the runtime a first-class, swappable binding:**
1. **Runtime switcher (not a locked badge).** Replace the locked header with a
   prominent **"Running on <logo> <harness> · Switch runtime"** control: a
   harness picker (the `ADAPTERS` grid / dropdown with logos) that calls
   `switchRuntime` (already built), with honest copy — *"Switching keeps this
   agent's identity, memory and abilities. Only the execution backend changes."*
   On switch: re-detect/connect, surface status (online/error), no recreate.
2. **Declutter the subpage** into a clear hierarchy: (a) **Runtime** — current
   binding + switch + connect/test; (b) **Native resources** (`RuntimeNativePanel`,
   one place — remove the duplicate from Instructions); (c) **Policy** — model,
   budget, capabilities, connection. One concern per section.
3. **Agentis-owned framing.** Copy throughout reflects that the agent is
   Agentis-proprietary from the moment it exists/transitions in; the runtime is
   just where it currently runs.

**Strategic payoff (future, not V1):** because runtime is a binding, when Agentis
ships **its own harness**, *every* agent can be transferred to it in one move —
fleet-wide "switch all to Agentis runtime." `switchRuntime` is the primitive;
a bulk "migrate fleet" action layers on top later. (Design the switcher so a
future `agentis_native` adapterType slots in as just another runtime option.)

### B11 — Agent deletion must decide the fate of its memory

`DELETE /v1/agents/:id` (`agentMutations.ts:293`) drops the row only; agent-scoped
episodes (`scopeId = agentId`) are **detached** — neither cleaned nor preserved.
Per Brain B7 ("on-agent-deletion promote-not-delete"), deletion should ask.
- **Backend:** delete gains a `memoryDisposition`: `promote` (reassign
  `scopeId → null`, i.e. keep in the **workspace Brain** — default), `delete`
  (remove the agent's episodes), or `transfer` (reassign `scopeId → targetAgentId`).
  Run in the same transaction as the row delete; stamp provenance
  ("from deleted agent <name>").
- **Frontend:** the delete confirm dialog presents the three choices with counts
  ("This agent carries **38 memories** — keep them in the workspace Brain /
  delete / move to another agent"). Default = keep (promote).

### Phasing (remediation first)
- **P-fix (now):** B1 (agent-scope default + visibility), B3+B8 (content gate +
  exclusion rule + selection), B4 (online), B5 (roster split). Test-backed.
- **P-fix.2:** B2 (per-project memory selection), B6 (config hardening), Codex
  `memories/` path fix.
- **P6 (expansion):** B7 skills→Abilities (auto + manual) + general folder import.
- **P7 (UX overhaul):** B9 — master/detail wizard, harness logos, full-transition
  manifest, single CTA, dozens-scale roster. The visible payoff of all the above.
- **P8 (agent lifecycle, runtime-agnostic):** B10 runtime-subpage reframe +
  reachable switcher (unlocks Track R in the UI; foundation for fleet→Agentis-harness
  transfer) + B11 deletion memory-disposition.

---

## 12c. Remediation + expansion — SHIPPED (2026-06-17)

api + web typecheck clean; 31 targeted tests green (12 import incl. B11 + 6 ingestion + 13 agent-route).

- **P-fix.** B1: imported personal memory store → **agent scope** (sources stamp
  `scopeHint:'agent'`); shared rule files (CLAUDE.md/AGENTS.md/.cursorrules) →
  workspace. B3: discovery **content-gated** — no agent surfaced for an empty
  harness home (cursor needs rule files, codex/hermes need instr/memory). B4:
  imports land **online** (`isPaused:false`). B8: `isExcludedPath` deny-list
  (plugins/cache, *-bundled, .codex-plugin, vendor docs/capabilities, node_modules,
  .sandbox, logs, *.sqlite) applied in `listFiles`/`scanSkills`; Codex memory path
  fixed `memory/`→`memories/`.
- **P6 — skills → Abilities.** `scanSkills` + Claude source surfaces user/project
  skills (auto) + marketplace skills (opt-in); `importSkills` transitions each via
  `AbilityCreationService.draft({from:'material'})` and `pinAbility` to the agent;
  idempotent by name. `ImportInputs.skills`, `summary.skills`, `SkillCandidate` in
  preview, `acceptedSkillPaths` in the spec/route.
- **P7 — wizard redesign.** `ImportAgentsWizard` rebuilt master/detail: harness
  **logos** (`components/icons`) as avatars, grouped searchable roster, collapsed
  "Already in Agentis" group, per-agent **manifest** (identity · memories w/ scope
  chips · skills→abilities · runtime), single accent CTA "Transition N agents",
  per-agent "pull N new". Scales to dozens.
- **P8 — runtime reframe + deletion.** B10: `RuntimePicker` editing mode now shows
  the **HarnessGrid switcher** (was a locked "recreate the agent" badge) wired to
  `onAdapterChange → switchRuntime`; honest "keeps identity, memory & abilities"
  copy; editing-mode self-detection enabled for live status dots. B11:
  `EpisodicMemoryStore.reassignScope`/`deleteScope`; `DELETE /v1/agents/:id`
  `?memoryDisposition=promote|delete|transfer&targetAgentId`; `DeleteAgentDialog`
  with the three choices + count (default promote, per Brain B7).
- **Deferred (honest):** B2 (per-project Claude memory picker — discovery still
  aggregates all projects when no cwd; agent-scope flip means they at least land
  on the agent); B6 deep config-panel hardening beyond the B10 reframe; general
  folder-import (skill detection covers the high-value path).

---

## 13. As-built file manifest (authoritative)

Where §3–§9's plan naming differs from reality, this section wins.

**API — new**
- `services/harnessImport/types.ts` — `DiscoveredAgent` / `DiscoveredAgentRow` / `ImportMemoryFile` / `HarnessImportSource` / scope hints.
- `services/harnessImport/fsScan.ts` — safe fs reads, frontmatter parse, `claudeProjectSlug` (cwd → `~/.claude/projects/<slug>`).
- `services/harnessImport/registry.ts` — `discoverAgents()` (L1 spine, merges detection), `readAgentInputs()`, identity-only remote endpoints.
- `services/harnessImport/sources/{claudeCode,hermes,codex,cursor}.ts` — L2 per-harness sources.
- `services/harnessAgentImport.ts` — L3 orchestrator: `discoverImportableAgents()`, `previewAgentImport()`, `importAgents()`, `checkImportUpdates()`.
- `services/harnessImportSync.ts` — `HarnessImportSyncService` (P4 scheduled poll → `harness.import.updates`).
- `routes/harnessImport.ts` — `GET /agents`, `POST /agents/preview`, `POST /import`, `GET /import/updates`.

**API — extended**
- `services/agentCommission.ts` — `switchRuntime()` (Track R).
- `routes/agentMutations.ts` — `POST /:id/runtime` (`switchRuntimeSchema`).
- `services/harnessMemoryIngestion.ts` — `previewImport()` / `commitImport()` (scope-routed, async), shared `distillContent` core, scope-aware dedup, `setFormationPromoter()` + deterministic fallback.
- `bootstrap.ts` — mount import routes, wire `setFormationPromoter` (inside the evaluator guard), construct + start/stop `HarnessImportSyncService`.
- `packages/core/src/events.ts` — `REALTIME_EVENTS.HARNESS_IMPORT_UPDATES`.

**Web — new**
- `lib/agentImport.ts` — client: discover / preview / import / `checkImportUpdates` / `switchAgentRuntime`.
- `components/agents/ImportAgentsWizard.tsx` — "Bring your agents" (detect → roster → review w/ scope chips → import; "N new · pull").

**Web — extended**
- `pages/AgentsPage.tsx` — "Import agents" header button + empty-state action + wizard mount.
- `components/agents/AgentConfigPanel.tsx` — `RuntimePicker.onAdapterChange` → `rebindRuntime()` (Track R UI).

**Tests**
- `tests/services/harnessAgentImport.test.ts` — 9 (discovery, scope-routed preview, paused-create + workspace memory, subagent persona, agent+atom idempotency, formation routing, deterministic fallback, remote identity-only, P4 updates).
- `tests/services/harnessMemoryIngestion.test.ts` — 6 existing (regression on the shared/async commit core).

