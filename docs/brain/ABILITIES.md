# Agentis Abilities — Architecture & Specification

**Status**: Implemented — Phase 7A (backend), Phase 7B (UI), Phase 7C (.agentiswf bundle install) all live on `main`.
**Date**: May 25, 2026 (design) · May 26, 2026 (backend + UI + bundle implementation)
**Scope**: Full specification of the Ability system — the behavioral specialization primitive for the agentic era.

> **Implementation log**: see §15. Phase 7A (backend) shipped first, then Phase 7B (UI surface — abilities sidebar page, creation wizard, detail page with examples/knowledge/settings, agent-detail pin tab) and Phase 7C (.agentiswf bundle: agentis-package contents now carry abilities + per-agent pin slugs; PackagerService deploys agent + workflows + abilities + pins in one operation; file-based publish/install via .ability export/import).

---

## 0. The Problem With Everything That Came Before

**Executable skills** (node_worker / docker_sandbox) define what an agent can *do* — they are sandboxed code that runs. They are tools.

**Markdown skill injection** (the SKILL.md / context injection pattern) tries to make agents smarter by prepending a static text file to their context. This is the right idea with the wrong implementation: the file is static, it is not semantically retrieved, it has no examples, it has no multimodal knowledge, it gets stale, and it cannot be shared or composed.

An **Ability** replaces the static markdown injection pattern entirely and makes it orders of magnitude more powerful:

| | Markdown Skill Injection | Ability |
|-|--------------------------|---------|
| Content | Static text file | Compiled persona + structured rules + specs + live knowledge + retrieved examples |
| Retrieval | Always inject everything | Semantically retrieve only what's relevant to the current task |
| Multimodal | Text only | Images, audio, documents, URLs — anything |
| Examples | None | KNN-matched behavioral demonstrations |
| Compiled | No | Yes — one-time LLM synthesis into specialist prompt |
| Shareable | Copy-paste | `.ability` package, AgentisHub installable |
| Composable | Manually merged | Stack multiple abilities, priority-ordered, token-budgeted |
| Learning | Never improves | Gets better as more examples and knowledge are added |

Abilities do not replace executable skills. They replace the behavioral specification layer — the "how this agent should think and respond" layer — with something that actually works.

---

## 1. What an Ability Is

An Ability is a **named, versioned, compiled behavioral specialization unit** that any agent can acquire.

It has six layers, each serving a distinct purpose:

```
┌──────────────────────────────────────────────────────────────┐
│                         ABILITY                              │
│                                                              │
│  1. PERSONA       — who this specialist IS (synthesized)    │
│  2. SPECS         — structured domain specifications         │
│  3. RULES         — ALWAYS/NEVER behavioral constraints      │
│  4. TOOL HINTS    — tool selection preferences               │
│  5. KNOWLEDGE     — retrieved domain documents & media       │
│  6. EXAMPLES      — KNN-matched behavioral demonstrations    │
└──────────────────────────────────────────────────────────────┘
```

Layers 1–4 are **static** after compilation — they are computed once and stored.  
Layers 5–6 are **dynamic** — they are retrieved at dispatch time based on the current task.

This means an ability's injection into context is always **tailored to the task at hand**, not a fixed blob of text that grows stale.

---

## 2. The Full Ability Injection Format

This is what gets prepended to agent context when an ability fires. Every field is populated from the compiled ability data and live retrieval.

```xml
<ability name="Senior UI Engineer" version="2.1" domain="ui_engineering">

  <persona>
    You are a senior UI engineer with deep expertise in design systems, component
    architecture, and accessible interfaces. You produce production-grade code that
    is responsive by default, semantically correct, and visually excellent without
    requiring design intervention.
  </persona>

  <specs>
    stack:          React 19 + TypeScript 5.5
    styling:        Tailwind CSS v4 — utility classes only, never @apply
    components:     shadcn/ui (base) → Radix UI primitives (custom)
    icons:          Lucide React
    animation:      Framer Motion (complex transitions) | CSS transitions (hover/focus)
    grid_unit:      8px base
    breakpoints:    375px (base) | 768px (tablet) | 1280px (desktop) | 1920px (wide)
    accessibility:  WCAG 2.1 AA minimum — aria-* required on interactive elements
    output_format:  component code + "Design Decisions" rationale + usage example
    color_system:   CSS custom properties via Tailwind theme, never hardcoded hex
  </specs>

  <rules>
    ALWAYS:
    — Use semantic HTML: nav, main, section, article, button, dialog
    — Include keyboard navigation (tabIndex, onKeyDown handlers)
    — Verify color contrast ≥ 4.5:1 (text) and ≥ 3:1 (UI components)
    — Export as named exports, never default exports
    — Type all props with a TypeScript interface above the component
    — Add a "Design Decisions" section explaining layout and visual choices

    NEVER:
    — Inline styles (style={{}})
    — Fixed pixel widths on layout containers (use %, vw, or max-w-* utilities)
    — CSS-in-JS (styled-components, emotion, stitches)
    — Nested ternaries in JSX — extract to named variables
    — Bootstrap, Material UI, Ant Design, Chakra UI
    — Comments explaining obvious code — only comment non-obvious decisions
  </rules>

  <tool_hints>
    IF figma_tool available → inspect design before writing code
    IF browser_preview available → test responsive breakpoints after generation
    PREFER knowledge_search("component library") before building custom primitives
    PREFER knowledge_search("brand guidelines") before choosing colors or typography
  </tool_hints>

  <knowledge retrieved="5" query="{current_task}">
    — [Relevant chunk from uploaded design system documentation]
    — [Relevant chunk from brand guidelines image OCR + description]
    — [Relevant chunk from uploaded Figma token export]
    — [Relevant chunk from accessibility audit report]
    — [Relevant chunk from component pattern reference]
  </knowledge>

  <examples retrieved="3" method="knn" query="{current_task}">
    <example score="0.94">
      Task: "Build a pricing section with three tiers for a SaaS product"
      Response: [full curated ideal response stored in ability_examples]
    </example>
    <example score="0.91">
      Task: "Create a responsive navigation with mobile hamburger menu"
      Response: [full curated ideal response]
    </example>
    <example score="0.88">
      Task: "Design a hero section with headline, subtext, and dual CTA"
      Response: [full curated ideal response]
    </example>
  </examples>

</ability>
```

**The key insight**: an agent reading this context does not need its weights fine-tuned. The persona tells it who to be. The specs tell it exactly what to use. The rules tell it exactly what to avoid. The examples show it precisely how to respond to similar problems. The knowledge grounds it in the actual domain content the user uploaded.

This is strictly better than fine-tuning for most real-world use cases because:
- It is updatable in real-time — add a new example, it is live immediately
- It works with any base model (Llama, Mistral, Claude, GPT, Qwen)
- It is interpretable — you can read exactly what the ability tells the agent
- It is composable — stack multiple abilities without weight conflicts
- It costs zero at inference time after compilation

---

## 3. Ability Discovery — Workspace Pool + Optional Agent Pinning

Abilities are **workspace-level assets**, not agent-level. Every compiled ability in the workspace is available to every agent — no explicit assignment required. This is the same mental model as the Skills page: skills exist at the workspace level, any agent can use them.

The dispatch engine resolves which abilities to inject via two mechanisms:

```
DISCOVERY MODEL

  Level 1 — Pinned (always injected, regardless of task)
    agent_abilities table: explicit overrides per agent
    Use when: you always want Agent X to behave as a UI expert

  Level 2 — Semantic Pool (workspace-wide, task-relevant injection)
    All compiled abilities in the workspace are scored against the current task
    Top-N are injected up to the token budget
    Use when: you want abilities to fire automatically when relevant

  Merge order (priority DESC):
    Pinned abilities → Semantic matches (deduplicated)
```

Example — a workspace with 6 abilities, agent receives a React component task:

```
Workspace abilities:
  🎨 React UI Expert       (compiled, quality 94%)
  ⚖️  Legal Compliance      (compiled, quality 80%)
  🔧 Node.js API Architect (compiled, quality 88%)
  📊 Data Analysis Expert  (compiled, quality 91%)
  ✍️  Technical Writing     (compiled, quality 85%)
  🔒 Security Hardening    (compiled, quality 79%)

Task: "Build a responsive pricing table component in React"

Semantic scores (cosine vs task embedding):
  React UI Expert       0.91  ← INJECT
  Technical Writing     0.54  ← INJECT (output format help)
  Node.js API Architect 0.22  skip
  Security Hardening    0.18  skip
  Data Analysis Expert  0.11  skip
  Legal Compliance      0.08  skip

Final injection: React UI Expert + Technical Writing
  (within 3,000 token budget)
```

The agent got the right abilities for the right task automatically. No one configured it.

**Token budget allocation** (3,000 tokens across all injected abilities):
- Each ability's compiled_prompt + specs + rules: ~200 tokens
- Knowledge retrieval: 150 tokens per ability
- Examples: top-2 per ability × ~150 tokens
- Budget is divided proportionally by relevance score if more abilities compete

**Rule conflicts**: if two injected abilities give contradictory rules, the higher relevance-score ability wins at dispatch time. Pinned abilities always win over semantic matches. Conflicts are flagged in the Brain page Insights tab: "React UI Expert (pinned) and Custom Theme (semantic) conflict on CSS approach — React UI Expert takes precedence."

---

## 4. The Compile Pipeline

"Compiling" an ability is a one-time async process triggered after the user builds it. The result is stored and never repeated unless the ability changes.

```
User clicks "Compile Ability"
     │
     ▼
Step 1 — Embed all example inputs (async, batched 50/req)
     ability_examples.embedding = embed(input_text)
     Enables KNN retrieval at dispatch time
     │
     ▼
Step 2 — Contextualize all knowledge documents
     ChunkContextualizer runs on every uploaded document
     (same service as Brain Phase 1 — ability reuses existing infra)
     Each chunk gets: contextPrefix, entities[], importanceScore, keyFacts[]
     ability_knowledge.embedding = embed(contextPrefix + '\n\n' + content)
     │
     ▼
Step 3 — Generate synthetic examples from knowledge
     For each knowledge chunk with importanceScore > 0.6:
       LLM prompt: "Given this domain content: {chunk}
                    Write 2 examples of how a {domain} specialist would 
                    respond to a practical question that requires this knowledge.
                    Format: Task: [question] | Response: [ideal answer]"
       → Stored as ability_examples with source='synthetic'
     This bootstraps behavioral coverage even when the user provides few manual examples.
     │
     ▼
Step 4 — Compile specialist prompt (1 LLM call, stored permanently)
     Input: all curated examples + specs + domain name
     Prompt: "You are helping define a specialist AI agent in {domain}.
              Here are the specs this specialist follows: {specs_json}
              Here are {N} examples of this specialist's responses: {examples}
              Write a 4-6 sentence first-person behavioral description that captures
              how this specialist thinks, what they prioritize, and what makes their
              output distinctive. This will be injected as their professional identity."
     Output stored in abilities.compiled_prompt
     │
     ▼
Step 5 — Mark compile_status = 'ready'
     Emit ABILITY_COMPILED event → UI updates indicator
```

**Total compile cost**: N embedding calls + N/3 cheap LLM calls (synthetic generation) + 1 LLM call (persona synthesis). One-time. Zero cost at every future dispatch.

---

## 5. Database Schema

New migration file: `packages/db/src/migrations/v{next}_abilities.ts`

```sql
-- ─────────────────────────────────────────────────────────────
-- Core ability table
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abilities (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL workspace_id = global / AgentisHub-installed ability

  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,          -- url-safe: 'ui-design-expert'
  description       TEXT,
  domain_tag        TEXT,                   -- 'ui_engineering' | 'legal' | 'sales' | 'finance' | ...
  icon_emoji        TEXT DEFAULT '⚡',
  author_id         TEXT REFERENCES users(id),

  -- Compiled outputs (populated by AbilityCompilerService)
  compiled_prompt   TEXT,                   -- synthesized specialist persona (Layer 1)
  specs             TEXT DEFAULT '{}',      -- JSON: structured domain specs (Layer 2)
  rules_always      TEXT DEFAULT '[]',      -- JSON string[] ALWAYS rules (Layer 3)
  rules_never       TEXT DEFAULT '[]',      -- JSON string[] NEVER rules (Layer 3)
  tool_hints        TEXT DEFAULT '[]',      -- JSON string[] tool preferences (Layer 4)

  -- Stats
  example_count     INTEGER NOT NULL DEFAULT 0,
  knowledge_count   INTEGER NOT NULL DEFAULT 0,
  compile_status    TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'compiling' | 'ready' | 'failed' | 'dirty' (needs recompile)
  last_compiled_at  TEXT,
  compile_error     TEXT,

  -- Sharing
  is_public         INTEGER NOT NULL DEFAULT 0,
  hub_slug          TEXT,                   -- AgentisHub identifier if published
  hub_version       TEXT DEFAULT '1.0.0',   -- semver
  install_count     INTEGER NOT NULL DEFAULT 0,

  -- Per-ability token budget override.
  -- NULL = use the workspace default (workspace_settings.ability_token_budget, default 3000).
  -- Raise for complex multi-layer abilities (legal, finance); lower for lightweight persona nudges.
  token_budget      INTEGER,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  UNIQUE(workspace_id, slug)
);

-- ─────────────────────────────────────────────────────────────
-- Behavioral examples — the behavioral core of every ability
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ability_examples (
  id                TEXT PRIMARY KEY,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,

  input_text        TEXT NOT NULL,          -- the task / prompt input
  output_text       TEXT NOT NULL,          -- the ideal specialist response
  input_media_url   TEXT,                   -- URL if example has a visual/audio input
  media_description TEXT,                   -- LLM description of media content

  quality_score     REAL NOT NULL DEFAULT 0.8,  -- user-rated or auto-scored
  source            TEXT NOT NULL DEFAULT 'user',
  -- 'user_curated' | 'synthetic' | 'promoted_from_run' | 'imported'

  embedding         TEXT,                   -- JSON float[] — embed(input_text)
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ability_examples_ability
  ON ability_examples(ability_id);

-- ─────────────────────────────────────────────────────────────
-- Domain knowledge backing the ability
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ability_knowledge (
  id                TEXT PRIMARY KEY,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,

  kb_chunk_id       TEXT REFERENCES kb_chunks(id),  -- link to source if from KB
  content           TEXT NOT NULL,                   -- denormalized for fast access
  embedding         TEXT,                            -- JSON float[]
  source_type       TEXT NOT NULL DEFAULT 'document',
  -- 'document' | 'image' | 'audio' | 'url' | 'manual'
  source_url        TEXT,
  importance_score  REAL DEFAULT 0.5,                -- from ChunkContextualizer

  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ability_knowledge_ability
  ON ability_knowledge(ability_id);

-- ─────────────────────────────────────────────────────────────
-- Agent ability pins (OPTIONAL — workspace pool is the default)
-- Only needed when you want an ability always-on for a specific agent,
-- regardless of task-time semantic relevance scoring.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_ability_pins (
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- Pinned abilities always inject before semantic pool matches.
  -- No priority column needed: semantic score orders pool results;
  -- pinned always win over pool.
  created_at        TEXT NOT NULL,
  PRIMARY KEY (agent_id, ability_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_ability_pins_agent
  ON agent_ability_pins(agent_id);
```

---

## 6. TypeScript Types

**File**: `packages/core/src/types/ability.ts`

```typescript
export interface AbilitySpecs {
  stack?: string;                  // e.g. "React 19 + TypeScript 5.5"
  styling?: string;                // e.g. "Tailwind CSS v4"
  components?: string;             // e.g. "shadcn/ui → Radix UI"
  icons?: string;
  animation?: string;
  grid_unit?: string;
  breakpoints?: string;
  accessibility?: string;
  output_format?: string;
  [key: string]: string | undefined; // arbitrary domain specs
}

export interface AbilityManifest {
  name: string;
  slug: string;
  version: string;
  domain_tag: string;
  icon_emoji?: string;
  description?: string;
  compiled_prompt: string;
  specs: AbilitySpecs;
  rules_always: string[];
  rules_never: string[];
  tool_hints: string[];
  example_count: number;
}

export interface AbilityExample {
  id: string;
  ability_id: string;
  input_text: string;
  output_text: string;
  input_media_url?: string;
  media_description?: string;
  quality_score: number;
  source: 'user_curated' | 'synthetic' | 'promoted_from_run' | 'imported';
  embedding?: number[];
  created_at: string;
}

/** Shape of the .ability export file (gzipped JSON) */
export interface AbilityPackage {
  format_version: '1.0';
  manifest: AbilityManifest;
  examples: Array<Omit<AbilityExample, 'id' | 'ability_id'>>;
  knowledge: Array<{
    content: string;
    embedding?: number[];
    source_type: string;
    importance_score: number;
  }>;
}
```

---

## 7. Service Architecture

### 7.1 AbilityService

**File**: `apps/api/src/services/abilityService.ts`

```typescript
export class AbilityService {
  // CRUD
  create(workspaceId: string, input: CreateAbilityInput): Promise<Ability>;
  update(id: string, input: UpdateAbilityInput): Promise<Ability>;
  delete(id: string): Promise<void>;
  list(workspaceId: string): Promise<Ability[]>;
  get(id: string): Promise<Ability>;

  // Example management
  addExample(abilityId: string, example: AddExampleInput): Promise<AbilityExample>;
  updateExample(exampleId: string, input: UpdateExampleInput): Promise<AbilityExample>;
  deleteExample(exampleId: string): Promise<void>;
  promoteRunToExample(runId: string, abilityId: string): Promise<AbilityExample>;
  // ^ user marks a successful run as a training example — promoted_from_run

  // Knowledge management  
  addKnowledge(abilityId: string, content: AddKnowledgeInput): Promise<AbilityKnowledge>;
  // This calls ChunkContextualizer + EmbeddingProvider internally

  // Compilation
  compile(abilityId: string): Promise<void>;
  // Triggers the 5-step compile pipeline async via CognitivePromotionQueueWorker

  // Dispatch-time context assembly
  buildContextBlock(
    abilityId: string,
    task: string,
    tokenBudget: number
  ): Promise<string>;
  // Returns the formatted <ability>...</ability> XML block for injection
  // Does: KNN search on examples, cosine search on knowledge, assembles XML

  // Export / Import
  export(abilityId: string): Promise<AbilityPackage>;
  importFromPackage(workspaceId: string, pkg: AbilityPackage): Promise<Ability>;
}
```

### 7.2 AbilityCompilerService

**File**: `apps/api/src/services/abilityCompilerService.ts`

Runs the 4-step compile pipeline (see §4) via the existing `CognitivePromotionQueueWorker` job queue.

```typescript
export class AbilityCompilerService {
  async compile(abilityId: string, workspaceId: string): Promise<void>;
  // Step 1: embed all examples
  async #embedExamples(abilityId: string): Promise<void>;
  // Step 2: contextualize knowledge
  async #contextualizeKnowledge(abilityId: string): Promise<void>;
  // Step 3: generate synthetic examples
  async #generateSyntheticExamples(abilityId: string): Promise<void>;
  // Step 4: synthesize compiled_prompt
  async #synthesizePersona(abilityId: string): Promise<string>;
}
```

### 7.3 Dispatch Integration

**File**: `apps/api/src/engine/WorkflowEngine.ts`

In `#withWorkspaceContext()` (or wherever the agent dispatch playbook is assembled), after building the base context:

```typescript
// Step 1 — Collect pinned abilities (always-on overrides)
const pins = await this.deps.abilities.listPinsForAgent(agentId);
const pinnedIds = new Set(pins.filter(p => p.enabled).map(p => p.ability_id));

// Step 2 — Semantic pool: score all workspace abilities against the current task
const allAbilities = await this.deps.abilities.listCompiled(workspaceId);
const taskEmbedding = await provider.embed(currentTask);
const scored = allAbilities
  .filter(a => !pinnedIds.has(a.id))    // exclude pinned (already included)
  .map(a => ({
    ability: a,
    score: cosineSimilarity(taskEmbedding, a.domain_embedding),
  }))
  .filter(s => s.score >= ABILITY_MIN_RELEVANCE_SCORE)  // skip irrelevant
  .sort((a, b) => b.score - a.score);

// Step 3 — Inject: pinned first, then semantic matches, up to token budget
const toInject = [
  ...pins.filter(p => p.enabled).map(p => ({ ability: p.abilityData, score: 1.0 })),
  ...scored,
];

let usedTokens = 0;
for (const { ability, score } of toInject) {
  const remainingBudget = ABILITY_TOKEN_BUDGET - usedTokens;
  if (remainingBudget < MIN_ABILITY_TOKENS) break;
  const block = await this.deps.abilityService.buildContextBlock(
    ability.id,
    currentTask,
    remainingBudget,
  );
  abilityBlocks.push(block);
  usedTokens += estimateTokens(block);
}
if (abilityBlocks.length > 0) {
  playbook += '\n\n' + abilityBlocks.join('\n\n');
}
```

**`domain_embedding`** is a single vector stored on the `abilities` table representing the ability's domain — computed at compile time as `embed(name + ' ' + description + ' ' + domain_tag + ' ' + rules_always.join(' '))`. This is what the semantic scoring runs against.

Add to the `abilities` table schema:
```sql
ALTER TABLE abilities ADD COLUMN domain_embedding TEXT;  -- JSON float[], set at compile
```

Constants (in `packages/core/src/constants.ts`):
```typescript
ABILITY_TOKEN_BUDGET:          3000,  // default total tokens across all injected abilities
MIN_ABILITY_TOKENS:             300,   // minimum to bother injecting an ability
ABILITY_MIN_RELEVANCE_SCORE:   0.35,  // cosine threshold — below this, skip
ABILITY_MAX_EXAMPLES:          3,     // max examples per ability per dispatch
ABILITY_MAX_KNOWLEDGE:         5,     // max knowledge chunks per ability per dispatch
```

**Token budget is user-configurable at two levels:**
- **Workspace default** — `workspace_settings.ability_token_budget` (default 3,000). Exposed in *Workspace Settings → Brain → Ability token budget* as a free numeric input — no ceiling. Set it as high as your model's context window allows, or as low as you need for latency-sensitive deploys.
- **Per-ability override** — `abilities.token_budget` column. Set on the Ability detail page under *Advanced*. NULL inherits the workspace default. Useful for a heavyweight Legal Compliance ability that needs more room vs. a lightweight Style Enforcer that needs very little.

Dispatch resolves: `effectiveBudget = ability.token_budget ?? workspace.ability_token_budget ?? ABILITY_TOKEN_BUDGET`

---

### 7.4 Brain Integration — Abilities as Knowledge Nodes

Abilities are not isolated from the workspace brain — they are part of it.

#### Workspace KnowledgeStore node (compile time)

When `AbilityCompilerService` finishes (marks `compile_status = 'ready'`), it calls `KnowledgeBaseService.persistDocument()` with a synthetic document representing the ability:

```typescript
await kbService.persistDocument(workspaceId, {
  title:   `Ability: ${ability.name}`,
  content: [
    ability.compiled_prompt,
    `Domain: ${ability.domain_tag}`,
    `Specs: ${JSON.stringify(ability.specs)}`,
    `Always: ${ability.rules_always.join('; ')}`,
    `Never:  ${ability.rules_never.join('; ')}`,
  ].join('\n\n'),
  metadata: {
    source_type: 'ability',
    ability_id:  ability.id,
  },
});
```

What this gives you:
- **Workspace self-knowledge**: an agent asked *"what specialists do we have here?"* searches the brain and finds the compiled ability nodes. It can answer accurately without any extra wiring.
- **Cross-ability linking**: `KnowledgeAutoLinker` runs on the new node and may link it to related KB documents (e.g., the React UI Expert ability auto-links to the uploaded design system PDF), surfacing that connection in the Brain graph view.
- **Cold-start fallback**: if the embedding provider is unavailable and semantic pool scoring can't run, the WorkflowEngine falls back to lexical KB search and can still surface relevant abilities by name/domain.
- **Sync on change**: when an ability is deleted or recompiled, the corresponding KB node is updated or removed. `kb_node_ability_id` foreign key tracks the relationship.

#### Agent episodic memory (dispatch time)

When one or more abilities fire for a run, `AgentMemoryService` records a lightweight episode:

```typescript
await agentMemoryService.remember(agentId, {
  type:    'ability_used',
  content: `Used ${injected.map(a => a.name).join(', ')} for: ${currentTask.slice(0, 120)}`,
  metadata: {
    ability_ids:      injected.map(a => a.id),
    relevance_scores: injected.map(a => a.score),
    run_id:           runId,
    tokens_used:      usedTokens,
  },
  importance: 0.4,  // informational — lower than task outcomes
});
```

What this gives you:
- **Ability usage history** visible in the Agent Brain tab. The agent literally remembers which specialists it activated and for which tasks.
- **Pin suggestions**: a background heuristic scans episodic memory and detects *"Agent X used Ability Y in 8 of its last 10 runs"*, then surfaces a one-click suggestion: *"Security Hardening fires frequently for this agent — pin it for always-on behavior?"*
- **Quality feedback loop**: when a run that fired an ability is subsequently followed by a `promoted_from_run` example, a lightweight signal is stored — the example count increases and the ability is marked `dirty` (needs recompile), pulling in the new behavioral evidence on the next compile.
- **Run summaries**: `SessionMomentService` includes *"Activated abilities: React UI Expert (0.91), Technical Writing (0.54)"* in the cognitive summary shown in the Brain page timeline.

---

## 8. API Routes

**File**: `apps/api/src/routes/abilities.ts`

```
GET    /v1/abilities                          — list workspace abilities
POST   /v1/abilities                          — create ability
GET    /v1/abilities/:id                      — get ability detail
PATCH  /v1/abilities/:id                      — update ability (name, specs, rules, etc.)
DELETE /v1/abilities/:id                      — delete ability
POST   /v1/abilities/:id/compile              — trigger compile (async)
GET    /v1/abilities/:id/compile-status       — poll compile status + quality score
POST   /v1/abilities/:id/examples             — add example
PATCH  /v1/abilities/:id/examples/:exId       — update example
DELETE /v1/abilities/:id/examples/:exId       — delete example
POST   /v1/abilities/:id/knowledge            — add knowledge (multipart: file | url | text)
DELETE /v1/abilities/:id/knowledge/:kId       — remove knowledge item
GET    /v1/abilities/:id/export               — download .ability package (JSON)
POST   /v1/abilities/import                   — import .ability package

GET    /v1/agents/:id/ability-pins            — list pinned abilities for agent
PUT    /v1/agents/:id/ability-pins/:abilityId — pin ability to agent (always-on)
DELETE /v1/agents/:id/ability-pins/:abilityId — unpin ability from agent
PATCH  /v1/agents/:id/ability-pins/:abilityId — enable/disable a pin
```

---

## 9. The `.ability` Package Format

Abilities are shared as self-contained `.ability` files (gzipped JSON). The format is fully portable: no workspace references, no agent-specific config.

```json
{
  "format_version": "1.0",
  "manifest": {
    "name": "Senior UI Engineer",
    "slug": "senior-ui-engineer",
    "version": "2.1.0",
    "domain_tag": "ui_engineering",
    "icon_emoji": "🎨",
    "description": "Production-grade React/TypeScript UI components with design system discipline",
    "compiled_prompt": "You are a senior UI engineer with deep expertise in design systems...",
    "specs": {
      "stack": "React 19 + TypeScript 5.5",
      "styling": "Tailwind CSS v4 — utility classes only",
      "components": "shadcn/ui → Radix UI primitives",
      "icons": "Lucide React",
      "animation": "Framer Motion (complex) | CSS transitions (simple)",
      "grid_unit": "8px base",
      "breakpoints": "375 | 768 | 1280 | 1920",
      "accessibility": "WCAG 2.1 AA, aria-* required",
      "output_format": "component code + Design Decisions + usage example"
    },
    "rules_always": [
      "Use semantic HTML elements",
      "Include keyboard navigation support",
      "Type all props with TypeScript interface",
      "Export as named exports only",
      "Add Design Decisions rationale section"
    ],
    "rules_never": [
      "Inline styles (style={{}})",
      "Fixed pixel widths on layout containers",
      "CSS-in-JS libraries",
      "Bootstrap, Material UI, Ant Design"
    ],
    "tool_hints": [
      "IF figma_tool available → inspect design before writing code",
      "PREFER knowledge_search('component library') before building custom primitives"
    ],
    "example_count": 47
  },
  "examples": [
    {
      "input_text": "Build a pricing section with three tiers for a SaaS product",
      "output_text": "...",
      "quality_score": 0.95,
      "source": "user_curated",
      "embedding": [0.023, -0.041, ...]
    }
  ],
  "knowledge": [
    {
      "content": "8px grid system: all spacing values should be multiples of 8...",
      "embedding": [0.018, -0.033, ...],
      "source_type": "document",
      "importance_score": 0.9
    }
  ]
}
```

Embedding vectors are included in the package so the ability is **instantly usable without recompilation** after import. If the target workspace uses a different embedding model, a background recompile is triggered automatically.

---

## 10. UX — The Creation Flow

The guiding principle: **zero ML knowledge required**. The user thinks in domain terms, not in model terms.

### 10.1 Creation Wizard

```
┌────────────────────────────────────────────────────────────────┐
│  New Ability                                          [✕]       │
│                                                                 │
│  Name  [ Senior UI Engineer              ]  Icon [🎨]          │
│  Domain [ UI Engineering ▼ ]                                    │
│  Description [ one-liner optional ]                             │
│                                                                 │
│  ─── Specs ─────────────────────────────────────────────────── │
│  What should every response follow?                             │
│  [ + Add spec ]                                                 │
│  stack:       [ React 19 + TypeScript 5.5             ] [×]    │
│  styling:     [ Tailwind CSS v4                       ] [×]    │
│  components:  [ shadcn/ui                             ] [×]    │
│  [+ Add custom spec key]                                        │
│                                                                 │
│  ─── Rules ──────────────────────────────────────────────────  │
│  ALWAYS                           NEVER                        │
│  [ Use semantic HTML        ] [×] [ Inline styles       ] [×] │
│  [ TypeScript interfaces    ] [×] [ Bootstrap           ] [×] │
│  [ + Add rule ]                   [ + Add rule ]               │
│                                                                 │
│  ─── Reference Material ──────────────────────────────────────  │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  Drop files here (images, PDFs, docs, audio) or       │     │
│  │  paste a URL                                           │     │
│  └───────────────────────────────────────────────────────┘     │
│  design-system.pdf  ✓    brand-screenshot.png  ✓               │
│                                                                 │
│  ─── Examples ────────────────────────────────────────────────  │
│  Show the ability how a specialist behaves (optional but        │
│  recommended — more examples = better quality)                  │
│  ┌──────────────────────┐   ┌──────────────────────────┐       │
│  │  When asked...       │ → │  The specialist responds  │       │
│  └──────────────────────┘   └──────────────────────────┘       │
│  [ + Add example ]  [ Import from run history ]                 │
│                                                                 │
│              [ Cancel ]  [ Save Draft ]  [ Compile Ability → ] │
└────────────────────────────────────────────────────────────────┘
```

### 10.2 Compile State (async, shown in ability list)

```
⚡ Senior UI Engineer    [compiling…  Step 3/4: generating examples]
```

```
⚡ Senior UI Engineer  Ready   [Edit] [Export] [⋯]
```

### 10.3 Workspace Abilities Page (Primary Surface)

**Location**: Abilities live as their own **sidebar navigation item** — same level as Agents, Skills, Workflows, and Brain. Route: `/abilities`. They are NOT nested under the Brain page. The Brain page shows ability nodes in its knowledge graph (see §7.4), but all management — create, edit, compile, export — happens from the Abilities sidebar page.

```
⚡ Abilities                                      [ + New Ability ]  [ Import ]
────────────────────────────────────────────────────────────────────────────
  🎨  Senior UI Engineer    v2.1  Ready       [Edit] [Export] [⋯]
  ⚖️  Legal Compliance      v1.0  Ready       [Edit] [Export] [⋯]
  📊  Data Analysis Expert  v1.2  Ready       [Edit] [Export] [⋯]
  ✍️  Technical Writing     v3.0  Compiling…              [⋯]

All compiled abilities are automatically available to every agent in this
workspace. Agents use them when semantically relevant to the task.
```

### 10.5 Agent Detail — Ability Pins (Optional)

On the Agent Detail page, a new **Ability Pins** section (not a full tab — this is secondary to the workspace page):

```
Ability Pins  — Always active for this agent, regardless of task    [ + Pin ]
────────────────────────────────────────────────────────────────────────────
  🎨  Senior UI Engineer    v2.1  Always on  [ Unpin ]

Other workspace abilities fire automatically when relevant to the task.
```

The mental model matches Skills: skills exist at the workspace level, agents use them. The difference is abilities fire based on task relevance by default — pinning is just for "always-on" overrides.

### 10.5 "Promote Run to Example" Flow

After any agent run completes, a subtle CTA appears:

```
✓ Run completed  ·  3m 24s  ·  [Save as ability example ▸]
```

Clicking opens a modal pre-filled with the run's input and output:
```
Save to Ability:  [ Senior UI Engineer ▼ ]
Input:  [pre-filled from run input]
Output: [pre-filled from run output — editable]
Quality: [ ★★★★★ ] (rate this example before saving)
[ Cancel ]  [ Save Example ]
```

This is the flywheel: every good run can become an example that makes the ability better for the next run.

---

## 11. AgentisHub Integration

### 11.1 Publishing an Ability

From the Ability detail page:

```
[ Publish to AgentisHub ]
  ↓
Enter description for community
Select license (MIT / CC-BY / Private)
Choose version (auto-incremented from current)
  ↓
[ Publish ] → ability.agentiswf file generated + uploaded to hub
```

### 11.2 Installing from Hub

```
AgentisHub → Browse Abilities
  🎨 Senior UI Engineer         ★4.9  (2,341 installs)  [Install]
  ⚖️  Legal Contract Reviewer   ★4.7  (891 installs)    [Install]
  🔧  Node.js API Architect      ★4.8  (1,204 installs)  [Install]
```

One-click install: ability appears in workspace, ready to attach to any agent.  
If the workspace embedding model differs from the package's, a background recompile runs automatically after install (typically < 2 minutes).

### 11.3 The `.agentiswf` Bundle

A specialist agent bundle includes its abilities:

```
senior-product-engineer.agentiswf
├── manifest.json          { name, version, author, min_agentis_version }
├── agent.json             { persona, tools, adapter config }
├── workflows/             { curated workflow definitions }
└── abilities/
    ├── react-ui-expert.ability
    └── api-architecture.ability
```

Install the `.agentiswf` bundle → agent + workflows + all abilities deployed in one operation. This is the unit of specialist sharing on AgentisHub.

---

## 12. How Abilities Relate to the Existing Skill System

This is important to keep clear:

| | Executable Skills | Context Markdown Skills | Abilities |
|-|-------------------|------------------------|-----------|
| **What they are** | Sandboxed code that executes (node_worker, docker_sandbox) | Static markdown text injected as context | Compiled behavioral specialization units |
| **Purpose** | Give agents tools to DO things | Give agents background context | Give agents a specialist IDENTITY and behavioral patterns |
| **Dynamic?** | Yes — executes at runtime | No — always full injection | Yes — retrieves relevant knowledge + examples per task |
| **Multimodal?** | N/A | No | Yes — images, audio, documents |
| **Gets better?** | Only if rewritten | Only if edited | Yes — add examples, it improves |
| **Shareable?** | Via packages | Copy-paste markdown | `.ability` format, AgentisHub |
| **Supersedes what?** | Nothing new | Static skill.md injection | The markdown skill injection pattern |

**Decision**: Abilities replace the markdown context injection pattern. Executable skills (node_worker / docker_sandbox) remain unchanged — they are tools, not behavioral specifications. An agent will have both: executable skills for doing things, and abilities for how to think about things.

---

## 13. Implementation Phases

### Phase 7A — Core (1 week)

| # | Task | File | Effort |
|---|------|------|--------|
| A1 | Schema migration: abilities + ability_examples + ability_knowledge + agent_ability_pins + domain_embedding col | `packages/db` new migration | 3h |
| A2 | `AbilityService` core CRUD + example/knowledge management | `services/abilityService.ts` | 8h |
| A3 | `AbilityCompilerService` — 4-step compile pipeline + domain_embedding at step 5 | `services/abilityCompilerService.ts` | 7h |
| A4 | `POST /v1/abilities/:id/compile` job via CognitivePromotionQueueWorker | routes + worker | 3h |
| A5 | `buildContextBlock()` — context assembly with KNN + knowledge retrieval | `services/abilityService.ts` | 4h |
| A6 | Dispatch integration: semantic pool scoring + pin merge in `WorkflowEngine.ts` | `WorkflowEngine.ts` | 4h |
| A7 | REST routes: full CRUD + compile + export/import + pin endpoints | `routes/abilities.ts` | 6h |
| A8 | TypeScript types | `packages/core/src/types/ability.ts` | 1h |
| A9 | Brain integration: KB node on compile + episodic memory on dispatch + pin suggestions heuristic | `abilityCompilerService.ts`, `WorkflowEngine.ts`, `AgentMemoryService.ts` | 3h |

### Phase 7B — UI (1 week)

| # | Task | File | Effort |
|---|------|------|--------|
| B1 | Ability creation wizard — identity + specs + rules editor | `AbilityCreateWizard.tsx` | 10h |
| B2 | Example editor — manual + promote-from-run flow | `AbilityExamplesPanel.tsx` | 6h |
| B3 | Knowledge upload panel (reuse WorkspaceDocDropZone) | `AbilityKnowledgePanel.tsx` | 4h |
| B4 | Workspace Abilities page + compile status indicators | `AbilitiesPage.tsx` | 4h |
| B5 | Agent Detail: Ability Pins section (pin / unpin only) | `AgentAbilityPins.tsx` | 3h |
| B6 | Export button + import flow | inline in AbilityDetail | 3h |

### Phase 7C — AgentisHub (1 week, after A + B)

| # | Task | File | Effort |
|---|------|------|--------|
| C1 | Publish flow + .ability file generation | `services/abilityService.ts` export | 4h |
| C2 | Hub browse + install flow (may reuse package install infra) | `routes/abilityHub.ts` | 6h |
| C3 | `.agentiswf` bundle: include abilities in agent package format | `packages/core/src/types/package.ts` | 3h |
| C4 | Bundle install: deploy agent + workflows + abilities in one operation | `routes/packages.ts` | 4h |

---

## 14. Success Metrics

| Metric | Target | How to measure |
|--------|--------|----------------|
| Abilities created per active workspace | > 2 in first 30 days | `SELECT count(*) FROM abilities WHERE workspace_id = ?` |
| Average examples per ability | > 15 | `SELECT avg(example_count) FROM abilities WHERE compile_status = 'ready'` |
| Abilities installed from hub | > 50 in first month after hub launch | `SELECT sum(install_count) FROM abilities WHERE is_public = 1` |
| Runs promoted to examples | > 5% of completed runs | `SELECT count(*) FROM ability_examples WHERE source = 'promoted_from_run'` |
| Agent retrieval quality (with ability vs without) | > 20% improvement in cosine score | A/B log in `kb_search_log` by `has_ability` flag |

---

## Appendix A — Domain Tag Reference

Suggested `domain_tag` values for the UI picker:

| Tag | Label | Example ability names |
|-----|-------|----------------------|
| `ui_engineering` | UI Engineering | "React Component Expert", "Design System Architect" |
| `backend_engineering` | Backend Engineering | "Node.js API Architect", "SQL Query Optimizer" |
| `devops` | DevOps & Infrastructure | "Kubernetes Deployment Expert", "CI/CD Pipeline Designer" |
| `data_analysis` | Data & Analytics | "pandas/SQL Data Analyst", "Dashboard Designer" |
| `legal` | Legal | "Contract Reviewer", "GDPR Compliance Advisor" |
| `sales` | Sales & Marketing | "Cold Email Copywriter", "B2B Pitch Specialist" |
| `content` | Content & Writing | "Technical Documentation Writer", "SEO Content Expert" |
| `finance` | Finance | "Financial Model Reviewer", "Budgeting Assistant" |
| `design` | Visual Design | "Brand Identity Designer", "Icon & Illustration Expert" |
| `research` | Research | "Academic Literature Reviewer", "Competitive Analysis Expert" |
| `custom` | Custom | (user-defined) |

---

## Appendix B — Research Grounding

Architecture decisions in this document are informed by:

1. **DSPy KNNFewShot optimizer** (Khattab et al., arXiv:2310.03714) — KNN retrieval of behavioral examples is the core mechanism of Level 1–3 specialization. DSPy empirically validates that few-shot retrieval outperforms static few-shot injection by matching examples to the query at hand.

2. **In-context learning quality research** (Min et al., 2022; Wei et al., 2023) — The format and diversity of examples matter more than their quantity. Quality score as avg pairwise cosine distance directly implements the diversity finding: 20 diverse examples outperform 100 similar ones.

3. **Anthropic Contextual Retrieval** (2024) — The compile step's contextual embedding (contextPrefix + content) is directly applied to ability knowledge chunks, delivering the documented 49% retrieval improvement.

4. **A-MEM Zettelkasten interconnection** (Xu et al., arXiv:2502.12110, NeurIPS 2025) — The "promote run to example" flywheel mirrors A-MEM's interconnection formation principle: new observations trigger review and enrichment of the existing behavioral network.

5. **Self-RAG demand-gating** (Asai et al., arXiv:2310.11511) — The `MIN_ABILITY_TOKENS` threshold and token budget management ensure abilities only fire when there is capacity for meaningful injection, not diluting context with partial ability blocks.

---

## 15. Implementation Log

### 2026-05-26 — Phase 7A backend complete

**Author**: Claude Opus 4.7 (architect/specialist pass)

What landed in `main`:

| Area | Files | Notes |
|------|-------|-------|
| Schema | `packages/db/src/sqlite/migrations.ts` (v44 `abilities`), `packages/db/src/sqlite/schema.ts` (drizzle tables) | Single migration adds `abilities`, `ability_examples`, `ability_knowledge`, `agent_ability_pins`. `domain_embedding` and `kb_document_id` are columns on `abilities` rather than separate tables. |
| Core types | `packages/core/src/types/ability.ts` + `index.ts` export, `packages/core/src/constants.ts` | New constants: `ABILITY_TOKEN_BUDGET`, `MIN_ABILITY_TOKENS`, `ABILITY_MIN_RELEVANCE_SCORE`, `ABILITY_MAX_EXAMPLES`, `ABILITY_MAX_KNOWLEDGE`, `ABILITY_MAX_INJECTED`, `ABILITY_SYNTHETIC_IMPORTANCE_THRESHOLD`. |
| Services | `apps/api/src/services/abilityService.ts`, `apps/api/src/services/abilityCompilerService.ts` | CRUD + example/knowledge management + dispatch context assembly + import/export. Compiler runs the 4-step pipeline, falls back to a deterministic persona template when no LLM is wired. |
| REST | `apps/api/src/routes/abilities.ts` (mounted at `/v1/abilities`) | Full CRUD + compile + status + examples + knowledge + export/import + agent pin endpoints (mounted under `/v1/abilities/agents/:agentId/pins/...` to keep all ability surface area on one route). |
| Engine | `apps/api/src/engine/WorkflowEngine.ts` — `#withWorkspaceContext()` now interleaves an `#buildAbilityBlock()` step | Workspace-pool semantic scoring + pinned merge + token-budget injection. Records `ability_used` to agent memory + `brain_quality_events` for traceability. |
| Bootstrap | `apps/api/src/bootstrap.ts` | Wires `AbilityService`, `AbilityCompilerService`, the queue compile hook, and the abilities route. The dispatch-time embedding-provider resolver is forward-declared so the engine constructs cleanly before `SharedIntelligence` is built. |
| Queue | `apps/api/src/services/cognitivePromotionQueueWorker.ts` already supported an `ability_review` item type; the compile pipeline reuses it by setting `brainQueue.abilityReviewer` from bootstrap. No new queue type, no new poller. |
| Tests | `apps/api/tests/services/ability.test.ts` (7 cases), `apps/api/tests/routes/abilities.routes.test.ts` (2 cases) | Cover create/list/update/delete, compile pipeline + persona fallback, semantic scoring, XML context block, export/import round-trip, pin lifecycle, KB Brain integration, route auth. |

### Specialist decisions that diverged from the spec

The spec was written by non-implementers. Several choices were made during build to ship something useful end-to-end without breaking adjacent systems:

1. **No new `workspace_settings` table.** §3 + §7.3 referenced one. The codebase already stores per-workspace JSON config in `workspaces.brain_settings`; the dispatch-time budget resolver reads `brainSettings.ability_token_budget` and falls back to the global `ABILITY_TOKEN_BUDGET` constant. Adding a table for one field would have been gratuitous.

2. **Compile queue reuses `ability_review` item type.** §4 implied a new queue type. `CognitivePromotionQueueWorker` already had a typed `ability_review` slot with a `kind` payload field — repurposing it kept the worker's circuit breaker + lease semantics free of duplication. The bootstrap sets `brainQueue.abilityReviewer` to a thin adapter that forwards `kind:'compile'` to `AbilityCompilerService.compile()`.

3. **Brain publish writes `knowledge_chunks` directly.** §7.4 said "call `KnowledgeBaseService.persistDocument()`". That service requires a `knowledgeBaseId`, which forces operators to pre-create a KB just to host ability nodes. The compiler writes a `source='promotion'` row in `knowledge_chunks` with `provenance.kind='ability'` so workspace-Brain searches surface ability nodes automatically — and stores the chunk id in `abilities.kb_document_id` so subsequent compiles replace (not duplicate) the synthetic chunk.

4. **`AbilityService.attachCompileHook` is a thin setter, not a service-level dep.** Avoids a circular import between `AbilityService` ↔ `CognitivePromotionQueueWorker` while still letting bootstrap wire them together in one place.

5. **Deterministic persona fallback always available.** §4 step 4 requires an LLM call. With Agentis' "zero config" default (no `AGENTIS_EVALUATOR_BASE_URL` set), the compiler falls back to a template assembled from name + description + specs + rules + curated rule slices. Operators that wire an LLM get the synthesised version; operators on a fresh install get a working, if blunter, persona. Either way `compile_status` reaches `ready`.

6. **Synthetic-example generation is opt-in.** §4 step 3 is skipped silently when no LLM is wired (warned at info level). Re-running compile after configuring an LLM picks them up.

7. **Embeddings are stored on rows in the same dimension as the workspace's provider.** A workspace embedding-provider change requires recompile (and we mark `dirty` aggressively on any behavioural mutation). This avoids `embedding`-column-length-vs-cosine bugs at retrieval time.

8. **Dispatch is best-effort.** Every failure path in `#buildAbilityBlock` returns `''`. Abilities must never crash a dispatch — the engine treats the feature as an enrichment, not a load-bearing dependency.

9. **`ABILITY_MAX_INJECTED` (4) is a hard ceiling above token budget.** Even if the budget allowed more, four ability blocks is the readability ceiling for a system prompt — and prevents pathological "everything fires for everything" workspaces.

10. **Pin endpoints live at `/v1/abilities/agents/:agentId/pins/...`.** The spec showed them under `/v1/agents/:id/ability-pins`. Keeping all ability-related surface on one route module reduces route discoverability churn and lets the abilities surface own its own `agentId-in-workspace` guard rather than spreading that check across the agents route.

### Outstanding (Phase 7B + 7C)

- **UI**: creation wizard, examples editor, knowledge upload, workspace abilities page, agent-detail pins section, "promote run to example" CTA, export/import buttons. None of these are blocked by the backend — every endpoint they need is live and tested.
- **AgentisHub**: publish flow, hub browse, `.agentiswf` bundle inclusion. Awaits the `apps/web` surface to settle.
- **Pin suggestions heuristic**: §7.4 mentions a background scan over `agent_memories` for "Agent X used Ability Y in 8 of last 10 runs". The signal is now logged (every dispatch writes an `ability_used` brain_quality_event with `delta` = relevance score); the heuristic can sit on top in a follow-up. Not part of 7A core.
- **Async knowledge upload (multipart files, URL fetch, image OCR)**: the REST surface accepts manual text knowledge today. File/URL ingestion reuses the existing `KnowledgeBaseService` enrichment pipeline; surfacing that on the abilities route is a Phase 7B chore.

### 2026-05-26 — Phase 7B + 7C shipped

**Author**: Claude Opus 4.7 (specialist pass)

What landed on top of the 7A backend:

| Area | Files | Notes |
|------|-------|-------|
| Web API client | `apps/web/src/lib/abilities.ts` | Typed wrapper around `/v1/abilities`. Owns the Ability/Example/Knowledge/Pin/Package types so every page shares them. Exposes `DOMAIN_TAGS`, `compileStatusLabel`, `compileStatusTone`. |
| Workspace abilities page | `apps/web/src/pages/AbilitiesPage.tsx` (+ route registered in `App.tsx`, sidebar entry added in `Sidebar.tsx`) | List + search + filter, compile-status pill (live-polls while any ability is `compiling`), row actions (recompile, export to `.ability` file, delete with confirm). Creation wizard is a single-page Drawer with sections for Identity → Specs (key/value rows) → Always/Never rules → Tool hints; optional "compile right after creation" checkbox triggers the compile queue inline. Import accepts `.ability` JSON via a hidden file input. |
| Ability detail page | `apps/web/src/pages/AbilityDetailPage.tsx` | Route `/abilities/:id`. Four tabs: Overview (persona + specs + always/never/tool-hints cards), Examples (inline editor modal, source pill, quality slider, type-to-confirm delete), Knowledge (similar editor w/ source-type select + URL field for `source_type='url'`), Settings (token budget override, recompile, danger-zone delete). Dirty / failed banners. |
| Agent detail pin tab | `apps/web/src/pages/AgentDetailPage.tsx` — `AgentAbilitiesTab` | Lists every workspace ability with status pill + pin / enable / remove buttons. Pinning a `dirty` ability is allowed; pinning a `pending` / `failed` ability is disabled with a tooltip explaining "compile first". Deep-links to `/abilities/:id`. |
| Bundle schema | `packages/core/src/types/package.ts` | Adds `abilityPackageContentsSchema` (subset of `AbilityPackage` with sensible defaults) and `agents[].pinnedAbilitySlugs?: string[]`; appends `abilities: AbilityPackageContents[]` to `agentisPackageContentsSchema`. Defaults default `[]` to keep existing bundles backward-compatible. |
| Bundle install | `apps/api/src/services/packager.ts` | `PackagerService` accepts an optional `abilities: AbilityService` dep. In `activateAgentisPackage()`, abilities install first (so pin lookups resolve), each is import-routed through `AbilityService.importPackage()` and queued for recompile, then agents apply `pinnedAbilitySlugs` after `agents.id` is known. Unknown slugs log a warning and skip — installs never fail on a stale pin reference. |
| Bundle create | `apps/api/src/routes/packages.ts` | `POST /v1/packages` now accepts `abilityIds: string[]` and `agentAbilityPins: Record<agentId, abilityId[]>`. The route exports each ability via `AbilityService.export()` and rewrites pins from `agentId → abilityId` to `agentId → abilitySlug` so the bundle is portable across workspaces. |
| Wiring | `apps/api/src/bootstrap.ts` | Passes `abilityService` into both `sharedPackager` and `buildPackageRoutes()`. |
| Tests | `apps/api/tests/services/abilityBundle.test.ts` (2 cases) | Round-trips a bundle: agent + ability + pin slug → install → verifies the ability landed, the agent was created, and the pin wired through. Second case: unknown slug skipped without throwing. |

### Specialist decisions for 7B + 7C

11. **One drawer, no multi-step wizard.** §10.1 sketched a multi-section wizard. A single Drawer with collapsible sections matches the workspace's existing creation surfaces (e.g. workflows) and avoids a sticky-state state machine. Spec / rule lists are dynamic add-rows, not separate steps.

12. **Compile-after-creation is opt-in via checkbox.** Default ON. Lets power users author drafts without queueing compute, while keeping the obvious path one-click.

13. **Export downloads a JSON file with `.ability` extension.** §11 imagined gzipping. Gzip adds a roundtrip and a dependency for a savings that's irrelevant at this size (typical ability < 100 kB JSON). The `.ability` extension is preserved so a future gzipped variant can ship without breaking the consumer side. Filename = `${slug}.ability`.

14. **Import is a workspace-page CTA, not a separate route.** No `.agentiswf`-style two-stage import — the operator picks a file, the file is POSTed straight to `/v1/abilities/import`. AgentisHub-style browse will sit on top of the same API if/when the registry surface ships.

15. **Pin endpoints respect compile state on the UI side.** Backend allows pinning any ability; UI disables the Pin button for non-compiled abilities with a tooltip — fewer support questions about "I pinned it but nothing happens".

16. **Bundle export rewires pins by slug, not by id.** The portable invariant is the slug (ids are workspace-local). Bundle install resolves slugs to the freshly-installed ability ids before applying pins. Unknown slugs are warned and skipped so a partially-stale bundle still installs cleanly.

17. **Bundle install triggers compile per ability.** Importing the manifest carries the persona + embeddings forward (instant usability), and a background compile is queued anyway because the target workspace may use a different embedding model than the source. Operators don't have to remember to re-compile after install.

18. **No new sidebar group.** Abilities sits at the same level as Workflows / Agents / Brain / Packages — consistent with §10.3 ("their own sidebar navigation item — same level as Agents, Skills, Workflows, and Brain").

### Phase 7B + 7C — what's still open

- **AgentisHub registry integration** — a real remote registry (publish to a Nexseed-hosted hub, browse community abilities, install with one click). Today's flow is file-based: export → share `.ability` file → import. The remote hub UX layer sits on top of `/v1/abilities/export` + `/v1/abilities/import` once the registry product is up.
- **Multipart file ingestion for knowledge** — text-only today. The KB ingestion pipeline already handles PDF/image/audio; wiring it to `/v1/abilities/:id/knowledge` is a small follow-up.
- **Promote-run-to-example CTA from run detail** — endpoint is live (`POST /v1/abilities/:id/examples/from-run`), no UI affordance yet on `RunDetailPage`.
- **Pin suggestion banner** — the dispatch signal is logged to `brain_quality_events`. A small batch job over the last N runs would surface "this agent fires X 8/10 times — pin it" in the agent detail page.

