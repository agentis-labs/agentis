# Agentis — Autonomous App Platform Specification
## Build and Run Your Own Agentic Apps.

> **Document type:** Product + Architecture Vision — **Live specification**
> **Status:** Implemented in the local/self-hosted app runtime (May 2026)
> **Scope:** Platform paradigm shift · `agentis` package kind · full data layer architecture · Builder-First UI/UX · 12 launch apps · competitive positioning
> **Builds on:** `V1-SPEC.md`, `PLATFORM-GAPS-PLAN.md`, `packages/core/src/types/package.ts`

---

## The Thesis

Software has always been static. You install it, it does what it was programmed to do, and it stays the same until someone ships an update.

**Agentis is a BUILD platform.** You open the canvas, wire agents together, configure evaluators, set guardrails — and what you produce is not a workflow template. It's an autonomous application. It runs, it decides, and it improves continuously as it processes your data.

Apps live in your workspace — self-hosted or local. The canvas is where you build them. Your workspace is where they run. Internally, every app is structured as a `.agentis` package: graph, agents, skills, credential slots, dataset specs, and intelligence seeds — all in one place. But that's an architectural detail, not a distribution step. You build it, it runs, you feed it your data.

**The value proposition is BUILD.** The platform provides the primitives — evaluators, knowledge nodes, parallel agents, human checkpoints. What you build with those primitives is yours. The more domain expertise and proprietary data you bring to it, the more powerful your app becomes.

---

## PART I — The Paradigm Shift

---

## § 1 — The New Proposition: Apps, Not Teams

The entire premise changes.

**Before:** You open Agentis, you think in terms of agent teams. You configure individual agents, assign personas, add tools. The output is a collection of AI components. Coordinating them into something that actually runs a business function is still on you. Most people never get there.

**After:** You open Agentis, you build on the canvas. You drag nodes — parallel research agents, evaluator gates, human checkpoints, knowledge lookups. You wire them into a complete autonomous application that runs a business function permanently. You activate it. You feed it your data.

The canvas doesn't disappear — it becomes more powerful. It's the authoring environment for autonomous applications, not just workflow automation. **Building is the primary action.** Running what you built is the reward.

**The fundamental question changes:**

> Before: "Can I configure agents to do this?"
> After: "What can I build on Agentis with my data?"

---

### What Changes Across the Platform

| | Old mental model (Teams) | New mental model (Apps) |
|---|---|---|
| **Primary surface** | Agent fleet configuration | Canvas workflow builder |
| **Unit of value** | Agent persona / skill | Running autonomous app |
| **Entry action** | "Configure my agents" | "Build and run this" |
| **Required expertise** | Agent prompting, tool configuration | Canvas orchestration, node composition |
| **First-run quality** | Cold — starts from scratch | Warm — seeds your own data from day one |
| **Improvement curve** | Flat — static unless rebuilt | Compound — gets smarter as data accumulates |
| **Portability** | Workflow JSON (structure only) | Internal `.agentis` package; export later |
| **Output** | Workflow configuration | Running autonomous application in your workspace |

The canvas is the primary surface. What you produce is a running autonomous application in your workspace — one that gets smarter as it processes your data.

---

## § 2 — The Database Import Revolution

What makes a 10-year veteran better than a new hire isn't process knowledge — it's **institutional context**. They've seen your customers, your deals, your patterns, your failures. They know which objections come up for which types of prospects. They know which PRs in the codebase are high-risk before they read a single line. They know which support tickets signal churn three months before it happens.

When you first build and run your SDR app, it starts capable. It knows the patterns you seeded and the general principles you configured. But without your company's history, it's working from general knowledge — a new hire on day one.

When you **import your CRM history** — 3 years of contacts, deal notes, won/lost reasons, email threads — the app runs all of it through its `DataIngestionPipeline`. It chunks, embeds, and routes every record into the appropriate knowledge store. When the agent researches a new lead from "Acme Corp (fintech, Series B)", it can now:

- Retrieve the 5 most similar past deals and how they evolved
- Surface the top 3 objections that came up in comparable conversations
- Identify the exact pain points that moved similar prospects to close
- Match the email tone to your company's approved communication style

That's not a general AI agent anymore. **That's a domain expert who has read your entire company's history.**

The paradigm shift is that the app's manifest declares what databases it can absorb — explicitly, with format guidance, chunking strategy, and UI instructions for how to export from each source. The operator doesn't need to figure out how to feed data. They just provide the file.

### The Data Layer Distinction

There are three layers of intelligence in an Agentis app, and they're architecturally distinct:

```
+-----------------------------------------------------------------------+
|                INTELLIGENCE LAYERS IN AN AGENTIS APP                  |
+-----------------------------------------------------------------------+
|                                                                       |
|  LAYER 1: SEEDS (Internal app manifest)                               |
|  -------------------------------------------------------------------  |
|  Compact intelligence snapshots stored with the app definition.        |
|  Built by the builder from domain expertise or distilled from runs.    |
|  Small enough to keep in the app manifest (KB-MB range).               |
|  -> knowledgeSeeds, evaluatorRubrics, memorySeeds, promptVariants,     |
|     calibrationExamples, workflowBaselines                             |
|                                                                       |
|  LAYER 2: DATABASE IMPORTS (Live, per workspace)                       |
|  -------------------------------------------------------------------  |
|  Whole databases fed by the operator after activation.                 |
|  Gigabytes of CRM data, codebase history, support tickets, contracts.  |
|  Not stored in the internal package; lives in the workspace.           |
|  Referenced by datasetSpecs in the manifest.                           |
|  Future export can distill these into seeds (top-N patterns only).     |
|  -> DataIngestionPipeline processes these into the knowledge store      |
|                                                                       |
|  LAYER 3: LIVE-ACCUMULATED (Continuous)                                |
|  -------------------------------------------------------------------  |
|  Intelligence generated while the app runs: approved decisions,        |
|  rubric calibrations from human feedback, prompt variant A/B results,  |
|  performance baselines from production runs.                           |
|  Grows automatically in the workspace; future export may include it.   |
|  -> Written by evaluator nodes, human_in_the_loop nodes, adapters       |
|                                                                       |
+-----------------------------------------------------------------------+
```

An operator's competitive advantage is the compound of all three layers:
- Layer 1 gives them a strong starting point (seeds built from domain expertise)
- Layer 2 gives them institutional context (years of company history, day-one)
- Layer 3 continuously compounds on top of both

---

## PART II — Architecture

---

## § 3 — The Package Kind Hierarchy

> **Status — Implemented.** `PackageKind` includes `agentis`; legacy `bundle` rows are backfilled to `agentis` by the SQLite migration.

Agentis has five levels of packagable artifact, each a valid `PackageKind`:

| Kind | What it is | Analogy |
|---|---|---|
| `skill` | A callable function / tool | A library function |
| `agent` | A persona — instructions, adapter, capability tags | A role definition |
| `workflow` | A `WorkflowGraph` — the orchestration of a process | A single process |
| `integration` | A connector manifest for an external API | An API driver |
| **`agentis`** | **A complete autonomous application** | **A `.agentis` package** |

The `agentis` kind is the top-level container. It includes agents, skills, workflows, integrations, credential slots, dataset specs, and all intelligence layers. Everything else is a component.

**The rename: `bundle` → `agentis`**

The `bundle` kind in `packages/core/src/types/package.ts` was a structural placeholder with `items: z.array(z.unknown()).default([])`. It is renamed to `agentis` and replaced with a full schema. "Bundle" implies a static collection. `agentis` is the canonical name of the format — it matches the `.agentis` file extension and unambiguously identifies the top-level artifact.

---

## § 4 — The Complete `agentis` Contents Schema

> **Status — Implemented.** `agentisPackageContentsSchema` and `datasetSpecSchema` live in `packages/core/src/types/package.ts` and are used by package import, activation, app instances, and data ingestion.

```typescript
// packages/core/src/types/package.ts

// ── Dataset Spec — declares what data an app can absorb ──────────────────
const datasetSpecSchema = z.object({
  key: z.string(),             // machine ID: 'CRM_HISTORY', 'CODEBASE', etc.
  label: z.string(),           // human label: "CRM Contact & Deal History"
  description: z.string(),     // "2–3 year export of your CRM contacts, deals, and notes"
  icon: z.string().optional(), // glyph for UI card
  acceptedFormats: z.array(z.string()),  // ['csv', 'hubspot-export', 'salesforce-export']
  targetStore: z.enum(['knowledge', 'memory', 'evaluator_examples', 'baseline_inputs']),
  chunkingStrategy: z.enum([
    'per-row',          // CSV: each row → one knowledge entry
    'per-document',     // markdown: each file → one entry
    'per-function',     // code: each function/class → one entry
    'sliding-window',   // long text: overlapping chunks
    'semantic',         // LLM-guided splits at semantic boundaries
  ]),
  requiredFields: z.array(z.string()).optional(), // validated before import starts
  optional: z.boolean().default(false),
  recommended: z.boolean().optional(),  // 1.1: nudge UI toward this dataset
  // 1.1: ranks this dataset's role in the app's competitive moat.
  wedgeRole: z.enum([
    'primary_specialization',
    'performance_booster',
    'compliance_guardrail',
    'historical_context',
    'quality_calibration',
  ]),
  // 1.1: areas this dataset is expected to influence — feeds the impact preview.
  expectedImpact: z.object({
    affects: z.array(z.enum([
      'retrieval', 'routing', 'evaluation', 'output_quality', 'cost_efficiency',
    ])),
    note: z.string().optional(),
  }).optional(),
  embeddingHint: z.string().optional(),  // guides embedding instruction for retrieval
  // 1.1: how fresh the operator should keep this dataset.
  freshnessExpectation: z.enum(['static', 'monthly', 'weekly', 'daily', 'live']).optional(),
  sizeWarningAboveRows: z.number().optional(),
  example: z.object({
    sampleColumns: z.array(z.string()).optional(),
    exportInstructions: z.string().optional(), // "In HubSpot: Contacts → Export → All properties"
  }).optional(),
});

// ── Full app contents ─────────────────────────────────────────────────────
const agentisPackageContentsSchema = z.object({
  kind: z.literal('agentis'),

  // ── The autonomous system ────────────────────────────────────────────────
  agents: z.array(agentContents).default([]),
  skills: z.array(skillContents).default([]),
  workflows: z.array(workflowContents).default([]),
  integrations: z.array(integrationContents).default([]),

  // ── Setup contract ───────────────────────────────────────────────────────
  // Credentials the operator must fill before the app runs.
  credentialSlots: z.array(z.object({
    key: z.string(),       // e.g. 'GMAIL_OAUTH'
    service: z.string(),   // 'gmail' | 'hubspot' | 'github' | ...
    label: z.string(),     // "Gmail OAuth — used by SDR email agent"
    required: z.boolean().default(true),
    oauthFlow: z.boolean().default(false),
    profile: z.string().optional(), // pre-fills field mapping hints
  })).default([]),

  // ── Data sources contract ────────────────────────────────────────────────
  // Declares what whole databases the app can absorb. NOT stored in the package.
  // Processed by DataIngestionPipeline after activation.
  datasetSpecs: z.array(datasetSpecSchema).default([]),

  // ── Intelligence Seeds — portable trained data ───────────────────────────
  // Agentis 1.1: §16 of docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md
  // Implemented by `apps/api/src/services/appActivation.ts` and the
  // wedge stores (knowledgeStore, appMemoryStore, evaluatorExampleStore,
  // workflowBaselineStore).

  // Class 1: pre-populated knowledge base. Day-one institutional context.
  knowledgeSeeds: z.array(z.object({
    title: z.string(),
    content: z.string(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })).default([]),

  // Class 1 (NEW in 1.1): compact memory facts the app should "already know".
  // Distinguished from knowledge by intent — memory is recalled, knowledge is retrieved.
  memorySeeds: z.array(z.object({
    title: z.string(),
    content: z.string(),
    trust: z.number().optional(),       // 0..1
    importance: z.number().optional(),  // 0..1
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })).default([]),

  // Class 3: rubric-tier evaluator calibration (per node kind).
  evaluatorRubrics: z.array(z.object({
    nodeKind: z.string(),
    context: z.string(),
    examples: z.array(z.object({
      evaluatorKey: z.string(),
      input: z.unknown(),
      expected: z.unknown(),
      verdict: z.enum(['pass', 'fail']),
      reason: z.string().optional(),
      score: z.number().optional(),
    })).default([]),
  })).default([]),

  // Class 3 (NEW in 1.1): top-level evaluator example seeds.
  // Useful when an example targets a single evaluator key without a rubric grouping.
  evaluatorExampleSeeds: z.array(z.object({
    evaluatorKey: z.string(),
    input: z.unknown(),
    expected: z.unknown(),
    verdict: z.enum(['pass', 'fail']),
    reason: z.string().optional(),
    score: z.number().optional(),
  })).default([]),

  // Performance baselines for self-healing and anomaly detection.
  workflowBaselines: z.array(z.object({
    workflowSlug: z.string(),
    p50DurationMs: z.number().optional(),
    p95DurationMs: z.number().optional(),
    expectedSuccessRate: z.number().optional(), // 0–1
    costCentsPerRun: z.number().optional(),
    derivedFromRuns: z.number().optional(),  // how many runs produced this baseline
  })).default([]),

  // ── Presentation ─────────────────────────────────────────────────────────
  entryWorkflowSlug: z.string().optional(),
  category: z.string().optional(),   // 'sales' | 'engineering' | 'ops' | 'security' | ...
  replaces: z.string().optional(),   // "Apollo + Outreach" — shown in setup wizard
  costSavedPerMonth: z.string().optional(), // "$200/mo + SDR time" — shown in setup wizard
  readme: z.string().optional(),     // markdown, shown in setup wizard
  screenshotUrls: z.array(z.string().url()).default([]),
  crossAppDependencies: z.array(z.string()).default([]), // app slugs this benefits from
});
```

---

## § 5 — The DataIngestionPipeline Architecture

> **Status — Implemented.** `DataIngestionService`, `data_ingestion_jobs`, parser/chunking support, preview/import/status/progress/delete routes, target-store routing to knowledge, memory, and evaluator examples, and the app data import UI now exist.

The pipeline is a new service in `apps/api/src/services/dataIngestion.ts`. It is the architectural foundation for database imports.

```typescript
// apps/api/src/services/dataIngestion.ts

type DataSourceFormat =
  | { type: 'csv';              file: Buffer; columnMapping?: Record<string, string> }
  | { type: 'json';             file: Buffer }
  | { type: 'jsonl';            file: Buffer }
  | { type: 'markdown-zip';     file: Buffer }    // Notion, Confluence, GitBook exports
  | { type: 'pdf';              file: Buffer }
  | { type: 'github-repo';      repoUrl: string; token: string; paths?: string[] }
  | { type: 'hubspot-export';   file: Buffer }
  | { type: 'salesforce-export';file: Buffer }
  | { type: 'zendesk-export';   file: Buffer }
  | { type: 'intercom-export';  file: Buffer }
  | { type: 'url-list';         urls: string[] }

interface DataIngestionJob {
  id: string
  appInstanceId: string
  workspaceId: string
  datasetKey: string         // matches DatasetSpec.key in manifest
  sourceFormat: DataSourceFormat['type']
  status: 'pending' | 'processing' | 'indexing' | 'completed' | 'failed' | 'cancelled'
  totalItems: number         // total chunks/rows estimated
  processedItems: number     // chunks embedded so far
  errorItems: number
  startedAt: string
  completedAt?: string
  byteSize: number
  chunkCount: number
  embeddingCount: number
  estimatedCompletionAt?: string
}

// SSE stream events during ingestion
interface DataIngestionProgress {
  jobId: string
  status: DataIngestionJob['status']
  processedItems: number
  totalItems: number
  currentPhase: 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'done'
  percentComplete: number
  latestChunkTitle?: string  // e.g. "Contact: John Smith at Acme Corp"
  errorCount: number
}
```

### Pipeline Phases

```
Input file/source
       ↓
1. PARSE — Convert source format to normalized records
   CSV: each row → { fields }
   Markdown ZIP: each file → { title, content, path }
   Code (GitHub): each function/class → { file, name, code, docstring }
   HubSpot export: each contact/deal/note → structured record
       ↓
2. VALIDATE — Check required fields, flag malformed records
       ↓
3. CHUNK — Split by chunkingStrategy from DatasetSpec
   per-row: one chunk per record (most CSV data)
   per-document: one chunk per file
   per-function: one chunk per function/class
   sliding-window: 512-token windows, 20% overlap
   semantic: LLM identifies natural break points
       ↓
4. ENRICH — Add metadata (source, timestamp, dataset key, app instance)
       ↓
5. EMBED — Generate embedding vectors for retrieval
       ↓
6. INDEX — Write to knowledge_entries / memory_entries table
  keyed by (workspaceId, appInstanceId, datasetKey, chunkId)
       ↓
7. DEDUPLICATE — Cosine similarity check, merge near-duplicates
       ↓
8. COMPLETE — Update DataIngestionJob, emit SSE completion event
              Notify app: new knowledge available
```

### Key Routes

```
POST   /v1/apps/:appSlug/data/:datasetKey/ingest   — start ingestion job
GET    /v1/apps/:appSlug/data/:datasetKey/status   — job status
GET    /v1/apps/:appSlug/data                      — all dataset statuses
GET    /v1/apps/:appSlug/data/:datasetKey/progress — SSE stream
DELETE /v1/apps/:appSlug/data/:datasetKey          — remove imported data
POST   /v1/apps/:appSlug/data/:datasetKey/preview  — estimate without importing
```

---

## PART III — The Intelligence Layers in Detail

---

## § 6 — The Eight Intelligence Layers

### Layer 0: Whole-Database Imports (The Foundation)

This is new. Everything else builds on top of this.

The `datasetSpecs` in the manifest declares what databases the app can absorb. These are not "optional extras" — they are the primary source of competitive advantage. An app without its databases imported is a capable generalist. An app with its databases imported is a domain expert.

**What gets absorbed (examples):**

| App | Database | Size in production | Effect |
|---|---|---|---|
| `autonomous-sdr` | CRM export | 1,000–50,000 contacts | ICP calibration, objection patterns, similar-deal retrieval |
| `engineering-copilot` | GitHub repos | 10k–500k functions | Codebase understanding, author patterns, architectural context |
| `customer-success-autopilot` | Support ticket history | 5k–100k tickets | Churn signal calibration, intervention playbooks |
| `legal-compliance-monitor` | Contract library | 100–5,000 contracts | Standard terms baseline, risk clause library |
| `knowledge-curator` | Confluence/Notion export | 100–50,000 docs | Eliminates cold start entirely — starts with full context |
| `competitive-intel-os` | Market research corpus | 50–2,000 documents | Strategic context, competitive pattern library |
| `product-feedback-loop` | Support + NPS history | 1k–100k records | Theme vocabulary, priority calibration, customer voice |

**The critical architectural point:** Whole-database imports stay in the local or self-hosted workspace. They are not part of the internal app package. A future export path may support `--include-trained-data`, but even then raw database records must never be included. Export should distill high-signal patterns, facts, and examples into compact seeds.

- The app stays fast to activate and run locally
- The workspace remains the source of truth for raw institutional data
- Future exported snapshots stay manageable (MB range, not GB)
- Distilled seeds can preserve the most valuable patterns without leaking raw customer data

### Layer 1: Knowledge Seeds

Compact, structured knowledge entries stored with the app definition. Day-one context before any databases are imported or any runs have occurred. Think of these as the textbook knowledge of the domain — best practices, taxonomies, frameworks, examples.

After data import: the `DataIngestionPipeline` writes thousands of records to the same knowledge store. Seeds and imported records coexist — the app retrieves from all of them. A builder who creates a well-seeded app gives their own workspace a meaningful head start.

**Example — `autonomous-sdr.agentis`:**
```json
{
  "title": "ICP Archetype: Mid-Market SaaS (50–500 employees)",
  "content": "Decision maker: VP Engineering or CTO if technical tool, VP Sales/RevOps if sales tool. Key triggers: raised Series B–C in last 12 months, hiring 30%+ in target function, recently migrated to Salesforce or HubSpot (modernizing stack). Pain points: team growing faster than processes, manual work creating bottlenecks, need to demonstrate ROI to board. Email approach: lead with operational efficiency framing, reference similar companies at same stage.",
  "kind": "pattern",
  "importance": 9,
  "tags": ["icp", "saas", "mid-market", "outreach-strategy"]
}
```

### Layer 2: Evaluator Rubrics

The "taste" of the app. Structured scoring criteria with calibration examples. Not just what score to assign — but *why* something scores high or low, with concrete examples.

After 6 months of production use, the rubric's calibration examples come from real decisions. The weight distribution shifts to match what actually predicts outcomes for this specific operator. A rubric refined against real-world outcomes is far more precise than one built on generic starting assumptions.

```json
{
  "rubricId": "outreach-email-quality",
  "context": "sdr-email-evaluator",
  "sampleSize": 2847,
  "refinedAt": "2026-05-01",
  "dimensions": [
    {
      "name": "personalization",
      "weight": 0.40,
      "examples": [
        {
          "input": "Hi {firstName}, I saw Acme raised a Series B and expanded into APAC — we work with several SaaS companies at exactly this stage navigating international go-to-market...",
          "score": 9.2,
          "reason": "References specific event, draws direct parallel to company stage, shows research"
        },
        {
          "input": "Hi {firstName}, I hope this email finds you well. I wanted to reach out about...",
          "score": 1.8,
          "reason": "No company research, generic opener, zero personalization signal"
        }
      ]
    },
    { "name": "cta_clarity", "weight": 0.30, "examples": [...] },
    { "name": "value_fit", "weight": 0.30, "examples": [...] }
  ],
  "threshold": 7.5
}
```

### Layer 3: Memory Seeds

Pre-populated memory entries so agents aren't starting blind. Facts, rules, patterns the agent should "already know" on day one. These differ from knowledge seeds in granularity: knowledge seeds are reference documents, memory seeds are individual recalled facts.

**Example — `engineering-copilot.agentis`:**
- "PRs touching `src/middleware/auth.ts` require senior engineer sign-off regardless of size"
- "Functions in `src/utils/db.ts` have known N+1 patterns — flag any new callers"
- "Test coverage below 70% on new authentication code is always a block, not a suggestion"

### Layer 4: Prompt Variants

Versioned prompts with production win-rate metadata. Ships with v1 based on best-practice prompt engineering. After A/B testing in production, the winning variant becomes active — selected by real decisions, not guesswork.

The win rate reflects this specific operator's context. A 41% win rate in your market may be very different from what works in another — because your ICP, your tone, and your market are specific.

### Layer 5: Calibration Examples

Input/output pairs that tell evaluator nodes what a correct decision looks like. Used both to prime evaluators at activation time and as ground truth for detecting rubric drift during long-running app runs.

### Layer 6: Workflow Baselines

Expected performance metrics for each workflow in the app. The primary input to self-healing logic: when a workflow's observed p95 duration, success rate, or cost-per-run deviates beyond a configurable threshold, the app generates an alert or autonomously escalates.

These baselines are self-updating: after a configurable number of production runs, the app revises its own baseline using rolling statistics. This prevents false alerts as the system warms up and prevents drift from going unnoticed.

### Layer 7: Credential Slot Profiles

Pre-configured field mapping profiles. When a specific credential is provided, the profile defines how the integration's fields map to the app's internal data model. The point is not public distribution; the point is repeatable activation inside a workspace without re-solving field mappings every time.

---

## PART IV — The Compound Intelligence Loop

---

## § 7 — Compound Intelligence: The Math

The performance of an app's evaluator decisions is a function of calibration quality. Calibration quality improves with every decision that generates a feedback signal (human approval, rejection, or outcome measurement).

This creates an exponential rather than linear improvement curve:

```
Projected performance trajectory (% accurate evaluator decisions):

No data import (cold start):
  Day 1:   ~62%  (knowledge seeds only)
  Month 1: ~67%  (500 live decisions)
  Month 3: ~72%  (1,500 decisions)
  Month 6: ~77%  (3,500 decisions)
  Year 1:  ~81%  (plateau — limited by lack of context)

After CRM import (100k records ingested):
  Day 1:   ~78%  (seeds + 3 years of company history)
  Month 1: ~83%  (500 live decisions on top of historical context)
  Month 3: ~88%  (rubric refining against real outcomes)
  Month 6: ~92%  (compound calibration from live data + history)
  Year 1:  ~96%  (approaching practical ceiling)
```

The gap between the two paths is not closing — it's widening. By year 1, the data-imported version outperforms the cold start by **15+ percentage points** of evaluator accuracy. For an SDR app, 15 points of accuracy on the "should we contact this lead" decision means:

- 15% more meetings booked per thousand leads processed
- 15% less wasted outreach spend
- 15% fewer false positive leads consuming human review time
- Compound: each of those booked meetings is itself a calibration signal that refines the next 1,000 decisions

### The Full Flywheel

```
        +-------------------------------+
        | Import your databases          |
        | CRM, codebase, tickets, etc.   |
        +---------------+---------------+
              |
              v
        +-------------------------------+
        | App starts as domain expert    |
        | not as cold generalist         |
        +---------------+---------------+
              |
              v
        +-------------------------------+
        | Better decisions from Day 1    |
        | Higher outcome rate            |
        +---------------+---------------+
              |
    +-------------------+-------------------+
    |                   |                   |
    v                   v                   v
  More positive       Human approvals       Outcomes tracked
  calibration         generate feedback      in knowledge base
  examples added      -> rubric refines      -> retrieval improves
    |                   |                   |
    +-------------------+-------------------+
              |
              v
        +-------------------------------+
        | Evaluator becomes more precise |
        | on your specifics              |
        +---------------+---------------+
              |
              v
        +-------------------------------+
        | App keeps improving            |
        | Compound effect accumulates    |
        +-------------------------------+
```

The compound effect is self-sustaining. No maintenance required. The more your app runs on top of your historical data, the better it gets.

### Cross-App Intelligence Network

When multiple apps are running in the same workspace, they share a knowledge store (namespaced by app, but cross-queryable). This creates second-order network effects:

- `autonomous-sdr` benefits from `competitive-intel-os` knowing competitor moves
- `engineering-copilot` benefits from `legal-compliance-monitor` knowing API compliance rules
- `executive-intelligence` queries all other apps' knowledge for its morning brief
- `product-feedback-loop` cross-references `customer-success-autopilot`'s churn signals

The more apps running in the workspace, the more valuable each individual app becomes. This is an emergent property of the shared knowledge architecture — design the data layer accordingly.

---

## § 8 — Why Data Depth Determines App Quality

This is the architectural insight that shapes how Agentis handles data. Anyone can build an app on the canvas. But apps powered by rich, domain-specific data perform fundamentally better than apps starting cold — and that difference shows up on Day 1, before any live runs have occurred.

**What changes when you bring your data:**

Consider two people both building an SDR app on Agentis:

- **Person A** builds the app from scratch. Good prompts, solid workflow design, reasonable knowledge seeds. Starts running.
- **Person B** builds the same app — and also has 4 years of CRM export (50,000 contacts, 8,000 deals, won/lost reasons for every one), a corpus of 25,000 approved outbound emails, and call transcripts from 2,000 sales calls. They feed all of it into the app's data layers on Day 1.

Person B's app is not "somewhat better." It is a fundamentally different class of software. It knows which company profiles actually convert. It knows which objections come up and which responses worked. It knows the exact tone and framing that moves deals in this specific market. The knowledge base is pre-loaded with institutional context that took years to accumulate.

This is why Agentis needs a first-class data ingestion system. The platform's job is to make it as easy as possible for builders to bring their institutional data — and for that data to be properly chunked, embedded, indexed, and made retrieval-ready for every agent in the app.

---

### Builder Profiles — Designing for Each

The data layer UI must serve different builders well:

| Profile | What they have | What the platform must do |
|---|---|---|
| **Starting fresh** | Domain expertise, no data corpus yet | Strong seed entry UX; fast improvement as live decisions accumulate |
| **Data-rich operator** | Years of CRM, tickets, codebase, or documents | Smooth bulk import; format support for real export formats; clear indexing progress |
| **Expert with rich data** | Both domain depth AND a proprietary corpus | All of the above; per-dataset impact estimation so they can prioritize what to import first |

---

### Data Import Improves Quality Immediately

An app started with a large data import doesn't need to "run for months to get good." It starts good — because the knowledge base reflects years of real decisions, not textbook patterns.

- Historical data provides Day-1 context that live runs alone could never replicate on any reasonable timeline
- Every live run adds calibration on top of that foundation
- Human approvals and feedback refine evaluator rubrics against real outcomes

This is why the data import UI (§ 12) is the highest-leverage surface in the platform. When a builder successfully imports their CRM, their codebase, their support history — the quality step-change is immediate and measurable.

---

## PART V — The Builder-First Platform UI/UX

> **Status — Implemented.** `/apps`, `AppsPage`, `AppDetailPage`, `AppCard`, `AppSetupWizard`, `DataImportPanel`, and an app-level `EvalsPanel` are in the web app.

---

## § 9 — Builder-First Navigation

The primary platform navigation reflects BUILD as the core action. The canvas is the primary power surface. Apps, Approvals, and Ledger are the runtime surfaces.

**Primary navigation:**

```
Agentis
|-- Canvas        BUILD    "build your agentic app"
|-- Apps          RUNTIME  "what's running in my workspace"
|-- Approvals     ACTION   "what needs me right now"
|-- Ledger        HISTORY  "full audit of what happened"
|-- Agents        CONFIG   "agent personas and adapters"
|-- Skills        CONFIG   "skill registry"
`-- Settings
```

**The flow:** you build on Canvas → you activate the app in your workspace → you monitor it from Apps → you review decisions in Approvals and Ledger.

The canvas is not a "developer surface." It is THE primary surface. Building is what Agentis is for.

---

## § 10 — The Apps Page (Runtime Home)

The Apps page is what you see after building and activating — your running apps, their status, their intelligence health, and pending approvals. The primary entry point is **Canvas** (build); this page is where you observe and manage what's running.

```
+------------------------------------------------------------------------+
| AGENTIS                         3 running   2 pending   1 alert         |
+------------------------------------------------------------------------+
| My Apps                                                [+ New App]       |
|                                                                        |
| +----------------------------------+  +-------------------------------+ |
| | Autonomous SDR          RUNNING  |  | Competitive Intel    RUNNING  | |
| | 82% success · 23 mtgs this week  |  | 14 signals analyzed today     | |
| | Success trend: +3.1%             |  | 3 battlecards updated         | |
| |                                  |  |                               | |
| | Knowledge  2,341 entries OK      |  | Knowledge  891 entries OK     | |
| | CRM        3,247 records OK      |  | Research   importing... 78%   | |
| | Rubrics    12 calibrated (94%)   |  |                               | |
| |                         [Open]   |  |                        [Open] | |
| +----------------------------------+  +-------------------------------+ |
|                                                                        |
| +----------------------------------+  +-------------------------------+ |
| | Engineering Copilot     RUNNING  |  | Content Machine   DATA NEEDED | |
| | 31 PRs reviewed · 0 critical     |  | No data sources imported      | |
| | Codebase   47,231 functions OK   |  | [Configure data]              | |
| | PR History 1,204 records OK      |  |                               | |
| |                         [Open]   |  |                               | |
| +----------------------------------+  +-------------------------------+ |
|                                                                        |
| Pending Approvals                                      [View all]       |
| - SDR: Review outreach batch — 12 leads queued          2 min ago       |
| - Content: "Q2 Marketing Retrospective" needs sign-off   1 hr ago      |
+------------------------------------------------------------------------+
```

Each app card shows:
- Real-time run status and recent outcome metrics
- **Intelligence status:** knowledge entry count, imported dataset status, rubric confidence
- Data import progress bars (live updating via SSE)
- Clear CTA when data is missing ("Configure data →")

---

## § 11 — The App Detail Page

```
/apps/autonomous-sdr
+----------------------------------------------------------------------------+
| < My Apps    Autonomous SDR       v2.1  RUNNING       [Export] [Settings]   |
+----------------------------------------------------------------------------+
| [Performance]  [Intelligence]  [Data]  [Decisions]  [Workflows]             |
+----------------------------------------------------------------------------+
| PERFORMANCE (last 30 days)                                                  |
|                                                                            |
| 847 leads processed    23 meetings booked    $12,400 est. saved            |
| 94.2% success rate     trend +2.1%                                          |
|                                                                            |
| Success rate trend:  flat -> up                                             |
+----------------------------------------------------------------------------+
| INTELLIGENCE                                                                |
|                                                                            |
| Knowledge Base         2,341 entries     2h ago          [Browse]           |
| Memory                 847 entries       live            [Browse]           |
| Evaluator Rubrics      12 calibrated     94% conf.       [View]             |
| Prompt Variants        4 active          v7 @ 41%        [Compare]          |
| Calibration Examples   2,847 pairs                       [View]             |
+----------------------------------------------------------------------------+
| DATA SOURCES                                             [+ Import data]     |
|                                                                            |
| OK CRM History         3,247 contacts · 891 deals       May 3     [Update]  |
| OK Email Archive       12,441 messages                  Apr 28    [Update]  |
| OK ICP Guidelines      PDF · 24 pages                   Mar 15              |
| !! Competitor DB       Not imported                               [Import]  |
+----------------------------------------------------------------------------+
```

The five tabs on the App Detail page:

**Performance** — run metrics, cost, success rate trend, comparison vs baseline  
**Intelligence** — deep dive into all intelligence layers: browse knowledge, compare prompt variants, inspect rubric calibration, view memory  
**Data** — the data import interface (described in §12)  
**Decisions** — recent evaluator decisions with scores and reasoning, recent human approvals/rejections  
**Workflows** — the underlying workflows (power user), link to canvas

---

## § 12 — The Data Import Interface

This is the highest-leverage UX surface in the platform. It must be excellent.

```
/apps/autonomous-sdr/data
+----------------------------------------------------------------------------+
| Data Sources for "Autonomous SDR"                                           |
|                                                                            |
| Feed this app your company's data and it becomes a specialist in your       |
| specific market, customers, and sales patterns.                             |
|                                                                            |
| Adding more data makes the app measurably better over time.                 |
+----------------------------------------------------------------------------+
| CRM Contact & Deal History                 IMPORTED · 3,247 records         |
|----------------------------------------------------------------------------|
| Your contacts, deals, notes, and won/lost reasons.                          |
| Used for: ICP calibration · objection library · similar-deal retrieval       |
| Formats: CSV · HubSpot Export · Salesforce Export                           |
| How to export: HubSpot > Contacts > Export > All properties as CSV          |
| Imported: May 3, 2026 · 3,247 contacts · 891 deals · 8,431 notes            |
| Impact: +14pp evaluator accuracy vs no CRM import (projected)               |
| [Re-import] [Preview data] [Remove]                                         |
+----------------------------------------------------------------------------+
| Email Archive                              IMPORTED · 12,441 messages       |
|----------------------------------------------------------------------------|
| Approved outbound email history. The app learns your tone, subject line     |
| patterns, and what framing works in your specific market.                   |
| [Re-import] [Preview] [Remove]                                             |
+----------------------------------------------------------------------------+
| Competitor Database                       NOT IMPORTED                      |
|----------------------------------------------------------------------------|
| Competitor product info, positioning docs, and battle cards.                |
| Used for: competitor-aware framing in outreach                              |
| Formats: CSV · PDF · Notion export · Markdown ZIP                           |
|                                                                            |
| [Import data]                                                               |
|                                                                            |
|   +------------------------------------------------------+                 |
|   |                                                      |                 |
|   |             Drop files here, or browse               |                 |
|   |                                                      |                 |
|   |        CSV · PDF · Notion export · Markdown ZIP      |                 |
|   |                                                      |                 |
|   +------------------------------------------------------+                 |
|                                                                            |
| Estimated processing time after upload: ~3 min for <1,000 records           |
+----------------------------------------------------------------------------+
```

**During import (live progress):**
```
  CRM History                           ████████████████░░░░ 78%
  Parsing rows...                       2,541 / 3,247 contacts
  Phase: embedding                      ETA: ~45 seconds
  
  Recent: "Contact: Sarah Chen at Acme Corp (Series B, Fintech)"
          "Deal: Enterprise — won — $84k ARR — 47 day cycle"
```

**Post-import summary:**
```
  ✓ Import complete!
  
  3,247 contacts indexed  ·  891 deals  ·  8,431 notes
  
  Impact on this app:
  → ICP pattern library: 127 new patterns extracted
  → Objection library: 43 objection/response pairs identified
  → Evaluator rubric: confidence increased from 62% → 78%
  → Estimated outreach quality improvement: +19pp
  
  [View knowledge base] [View rubric update]
```

---

## § 13 — Export

> **Status — V1+ side feature (not the primary use case).** The primary value of Agentis is building and running apps in your own workspace. Export is a secondary utility for users who want to back up or migrate their apps. It is not required to get value from the platform.

Agentis apps can be exported as `.agentis` files — a self-contained snapshot: graph structure, agents, skills, integration definitions, credential slot declarations, dataset specs, and intelligence seeds.

Use it for:
- **Backup** — snapshot a known-good state before major changes
- **Workspace migration** — move an app to a different local/self-hosted Agentis workspace
- **Environment promotion** — export from a staging workspace, load into production

```bash
# Export the current app structure
agentis export autonomous-sdr

# Export with accumulated intelligence (rubrics, prompt variants, memory seeds)
agentis export autonomous-sdr --include-trained-data
```

When `--include-trained-data` is used, the export pipeline runs LLM distillation over the embedded corpus to extract high-signal patterns as compact seeds. Raw database records are never included — only the distilled patterns that represent the most valuable knowledge.

The resulting `.agentis` file can be loaded into any Agentis workspace:
```bash
agentis load ./autonomous-sdr.agentis
```

> **Future roadmap:** Public discovery and cross-team sharing are outside the V1 build-and-run scope.

---

## § 14 — The App Setup Wizard

When activating an app you built on the canvas, a setup wizard walks through credentials and data before the app runs. Four steps, designed to minimize time-to-running:

**Step 1 — Overview**
- What the app does in plain language
- What it replaces and approximate cost saved
- What seeds are already configured
- What data it can absorb from your stack
- Estimated setup time by complexity

**Step 2 — Connect your credentials**
- Each `credentialSlot` rendered as a card with service icon
- OAuth slots: "Connect with HubSpot" button triggers OAuth flow inline
- API key slots: input field with live validation
- Progress bar: N of M credentials configured
- "Continue without X" option for optional credentials

**Step 3 — Import your data** *(the key differentiating step)*
- Each `datasetSpec` rendered as a card
- Required specs highlighted in amber: "App will work but won't be optimized without this"
- Optional specs shown with "Recommended" tag where `optional: false`
- Import CTA: drag & drop or connect data source
- Real-time ingestion progress per dataset
- "Import later" option — skip and come back to /apps/:slug/data
- Estimated impact shown per dataset: "+18pp evaluator accuracy with CRM import"

**Step 4 — Review & activate**
- Summary: N agents · M workflows · K knowledge entries · J rubrics
- Data status: N datasets imported · M pending
- [Activate app →] — creates the app instance and starts eligible triggers
- After activation: redirect to App Detail `/apps/:appSlug` with success toast

---

## PART VI — The 12 Example Apps

These are 12 autonomous apps you can build on Agentis. They demonstrate what becomes possible when Agentis's unique primitives are combined with domain data. Each one is an example of what to build — not templates to install.

---

Each app spec below includes a `datasetSpecs` section — what data the app can absorb, in what format, and what the effect is. This is the data architecture declaration that lives in the manifest and drives the DataIngestionPipeline.

---

### 01 — `autonomous-sdr`

**Replaces:** Apollo ($99/mo) + Outreach ($100/mo/seat) + 40+ hrs/mo SDR time  
**Category:** Sales  
**Credential slots:** `GMAIL_OAUTH`, `HUBSPOT_API_KEY` or `SALESFORCE_API_KEY`, `GOOGLE_SHEETS_ID`

**Database imports:**
- **CRM History** (CSV / HubSpot / Salesforce export) — contacts, deals, notes, won/lost reasons → ICP calibration, similar-deal retrieval, objection library
- **Email Archive** (mbox / CSV) — approved outbound emails → tone calibration, subject line patterns, framing that works
- **ICP Guidelines** (PDF / markdown) — any existing ICP documents → immediate strategic context
- **Competitor Battle Cards** (CSV / markdown) — existing battle cards → competitor-aware framing

**What it does:**  
Cron or webhook fires on new lead list. For each lead: three parallel research agents execute simultaneously — company news + recent events, LinkedIn profile signals, technology stack + funding indicators. Merge node combines all context. Evaluator scores outreach opportunity: ICP fit (vs. imported CRM patterns), timing signals, personalization potential. Below threshold: skip and log reason (feeds knowledge base). Above threshold: agent drafts personalized email using all research + similar past deals from imported CRM. Second evaluator gates quality before send — no email leaves without passing both gates. Wait node holds for follow-up timing (calibrated from import). No reply → follow-up sequence. Replies → human-in-the-loop routing. Positive → calendar booking + CRM update. Every outcome written back to knowledge and memory.

**Key primitives:** `parallel` ×3, `evaluator` ×2, `wait`, `human_in_the_loop`, `checkpoint`, `knowledge`, `memory`  
**Why n8n can't build this:** No evaluator gates, no knowledge-driven retrieval of similar past deals, no rubric calibrated to your CRM history.

---

### 02 — `competitive-intel-os`

**Replaces:** Crayon / Klue ($2,000–$5,000/mo)  
**Category:** Strategy  
**Credential slots:** `NOTION_API_KEY`, `SLACK_WEBHOOK_URL`, `GOOGLE_SHEETS_ID`

**Database imports:**
- **Market Research Corpus** (PDF / markdown ZIP) — analyst reports, competitor case studies, industry data → day-one strategic context
- **Existing Battle Cards** (Notion export / markdown) — previous competitive work → starting point instead of blank slate
- **Product Positioning Docs** (PDF / markdown) — your own positioning → enables gap analysis

**What it does:**  
Monitors 10–50 competitors permanently. Cron every 6 hours. For each competitor: parallel agents on pricing pages, changelogs, job postings (hiring signals), press releases, G2/Capterra reviews. Evaluator scores: strategic significance (1–10) × confidence (1–10). Score ≥ 7: agent synthesizes impact analysis against your positioning from knowledge base. Routes to human-in-the-loop. Approved: updates battlecard in Notion + Slack alert. < 7: archived silently. Weekly: executive synthesis of all significant changes. Quarterly: scheduled cron triggers an agent that synthesizes accumulated knowledge into a competitive landscape report.

**Key primitives:** `parallel`, `evaluator`, `router`, `knowledge`, `human_in_the_loop`  
**Cross-app benefit:** `executive-intelligence` queries this app's knowledge for its daily brief.

---

### 03 — `engineering-copilot`

**Replaces:** LinearB ($400/mo) + CodeClimate ($200/mo) + ~30% of senior review time  
**Category:** Engineering  
**Credential slots:** `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `LINEAR_API_KEY` or `JIRA_API_KEY`

**Database imports:**
- **GitHub Repositories** (GitHub API — configured by token) — all functions, classes, PR history, review comments → codebase-specific risk understanding, architectural boundaries
- **PR Review History** (CSV or GitHub export) — past reviews, merge decisions → risk calibration against what your team actually blocks
- **Architecture Decision Records** (markdown) — ADRs → architectural pattern enforcement
- **Code Style Guide** (markdown / PDF) — style rules → automated style gate in reviews

**What it does:**  
GitHub webhook on new PR. Three parallel review agents: (1) code diff analyzer — complexity, security surface, test coverage, architectural impact; (2) critical path checker — compares against high-risk files and architectural boundaries from imported codebase knowledge; (3) author history reviewer — reads memory for this author's patterns, test habits, common mistakes. Evaluator: composite risk score. Low (1–3): auto-comment + approve. Medium (4–6): assign reviewer with full brief. High (7–10): block + page on-call + incident. Monthly: scheduled cron triggers an agent that audits all PRs for recurring patterns and proposes rubric updates.

**Key primitives:** `parallel` ×3, `evaluator`, `knowledge` (codebase), `human_in_the_loop`

---

### 04 — `content-machine`

**Replaces:** Jasper ($99/mo) + Buffer ($100/mo) + content audit tools ($200/mo)  
**Category:** Marketing  
**Credential slots:** `CMS_API_KEY`, `GOOGLE_SHEETS_ID`, `SLACK_WEBHOOK_URL`

**Database imports:**
- **Brand Guidelines** (PDF) — voice, tone, off-limits topics → enforced in every piece via guardrails
- **Content Performance History** (CSV) — past articles with engagement metrics → learn what performs for your audience
- **Competitor Content** (URL list) — scrape and ingest competitor content → gap identification
- **SEO Keywords** (CSV) — keyword library with volume/difficulty → topic selection optimization

**What it does:**  
Weekly cron. Research agent pulls trending keywords + competitor gaps from knowledge. Proposes 5 topics with rationale. Human-in-the-loop selects 1–3. Parallel drafting agents write each. Evaluator: SEO relevance, readability, brand voice, factual completeness. Score < 7 on any dimension → rewrite loop (up to 3 iterations, specific feedback per dimension). Guardrails: brand safety check (brand guidelines from import). Human-in-the-loop final approval. Integration publishes to CMS + scheduler. Performance fed back weekly → knowledge base → improves next topic selection.

**Key primitives:** `evaluator`, `guardrails`, `parallel`, `loop`, `human_in_the_loop`, `knowledge`

---

### 05 — `customer-success-autopilot`

**Replaces:** Gainsight ($1,000+/mo) + manual CS manager time  
**Category:** Customer Success  
**Credential slots:** `CRM_API_KEY`, `GMAIL_OAUTH`, `SLACK_WEBHOOK_URL`, `DATABASE_URL`

**Database imports:**
- **Support Ticket History** (Zendesk / Intercom export) — full ticket history → churn signal calibration, intervention playbooks
- **Churn Data** (CSV) — past churned customers with reasons → leading indicator patterns
- **NPS Survey History** (CSV) — historical NPS responses → score-to-churn correlation
- **Product Usage Logs** (CSV / JSON) — feature adoption, session data → health score inputs

**What it does:**  
Daily cron processes all accounts. Per account: pulls usage from DB, NPS, support history, payment status, renewal date. `context_compress` collapses history for large accounts. Agent generates health score + risk narrative. Evaluator validates. Router branches: healthy → CRM update. At-risk → intervention email via human-in-the-loop. Churned signals → executive escalation. New customer → a scheduled workflow monitors onboarding milestones via checkpoints at day 1/7/14/30.

**Key primitives:** `context_compress`, `evaluator`, `router`, `checkpoint`, `human_in_the_loop`, `batch`

---

### 06 — `recruiting-pipeline`

**Replaces:** Greenhouse ($2,000+/mo) + 20 hrs/week HR screening  
**Category:** People Ops  
**Credential slots:** `GMAIL_OAUTH`, `CALENDAR_API_KEY`, `ATS_API_KEY`

**Database imports:**
- **Past Hired Candidates** (CSV) — profiles of successful hires with tenure and performance outcomes → what "good" looks like for each role
- **Job Descriptions Archive** (markdown) — past JDs → criteria vocabulary
- **Interview Feedback Archive** (CSV) — past structured feedback → rubric calibration for evaluation quality

**What it does:**  
New application webhook. Agent reads resume against knowledge base (job criteria + past hired profiles). Evaluator: skills match, experience calibration, red flag detection. Below threshold → personalized rejection email. Above → parallel research agents (LinkedIn, GitHub if applicable, portfolio). Research synthesis → candidate brief. Human-in-the-loop advance/decline. Advance → calendar invite with prep. Post-interview: feedback webhooks → agent synthesizes → evaluator → human final decision. Accepted hires written to knowledge base → continuously improves hiring rubric.

---

### 07 — `bi-narrator`

**Replaces:** ThoughtSpot Sage / narrative BI ($500+/mo) + analyst briefing time  
**Category:** Analytics  
**Credential slots:** `DATABASE_URL`, `GMAIL_OAUTH`, `SLACK_WEBHOOK_URL`

**Database imports:**
- **Historical Metric Exports** (CSV / JSON) — 2+ years of business metrics → baseline calibration, seasonality patterns, anomaly thresholds
- **Analytics Incident Log** (CSV) — past anomalies and their root causes → cause-effect pattern library
- **Business Context Doc** (markdown / PDF) — company strategy, product roadmap → relevance filtering for what changes matter

**What it does:**  
Hourly cron pulls key metrics. Compares to baselines from imported history. Significant deviation (>2σ) triggers parallel hypothesis agents: (1) traffic/acquisition change?, (2) conversion?, (3) product change?, (4) external/seasonal?. Evaluator ranks hypotheses. Winner + evidence → narrative paragraph. Daily 7am: `context_compress` aggregates all findings. Agent writes executive brief: 3 things that changed, 2 things trending well, 1 recommended action. Evaluator: brevity, signal-to-noise, action-ability. Monthly: scheduled cron triggers a forward-forecast synthesis.

---

### 08 — `soc-triage`

**Replaces:** L1 SOC analyst function ($60,000–$120,000/yr)  
**Category:** Security  
**Credential slots:** `SIEM_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `JIRA_API_KEY`, `PAGERDUTY_API_KEY`

**Database imports:**
- **Historical Alert Log** (SIEM export / CSV) — past alerts and resolutions → false positive pattern library, severity calibration
- **Asset Inventory** (CSV / JSON) — servers, services, owners, criticality → risk context per alert
- **Threat Intelligence Reports** (PDF / markdown) — MITRE ATT&CK mappings, threat actor profiles → attack pattern library
- **Incident Playbooks** (markdown) — existing runbooks → containment procedure automation

**What it does:**  
Security alert webhook. Agent investigates: IP reputation (http_request), affected asset (knowledge), similar historical alerts (memory), threat patterns (knowledge). Evaluator: severity × confidence matrix. < 3×3 → close as false positive + update knowledge. 3–6 → enrich, create ticket, assign analyst. 7+ → parallel containment: isolate asset, page on-call, create incident, notify CISO. Human-in-the-loop incident commander. All actions logged via `agentis.audit_trail`. Memory updated with resolution for future pattern matching.

**Key primitives:** `evaluator`, `parallel`, `knowledge`, `memory`, `human_in_the_loop`, `skill_task` (audit_trail)

---

### 09 — `product-feedback-loop`

**Replaces:** Productboard ($800+/mo) + manual product discovery  
**Category:** Product  
**Credential slots:** `INTERCOM_API_KEY`, `SLACK_WEBHOOK_URL`, `LINEAR_API_KEY`, `NOTION_API_KEY`

**Database imports:**
- **Support Ticket History** (Zendesk / Intercom export) — full historical ticket corpus → theme vocabulary, known pain points
- **NPS Survey History** (CSV) — scores + verbatim comments → customer voice calibration
- **Past User Interview Notes** (markdown) — interview transcripts and notes → qualitative context
- **Churn Survey Responses** (CSV) — exit survey data → highest-priority pain points

**What it does:**  
Continuous webhook ingestion. Per item: agent classifies by theme + customer segment + sentiment + severity → knowledge base. Weekly cron: cluster all new items. Evaluator: frequency × customer tier × strategic fit × urgency. Top 5 themes → parallel spec drafting. Evaluator quality-gates each spec. Human-in-the-loop: PM selects which to advance. Accepted → Linear/Jira epics. Quarterly: scheduled cron triggers a roadmap synthesis agent across all accumulated feedback intelligence.

---

### 10 — `legal-compliance-monitor`

**Replaces:** Ironclad CLM ($2,000+/mo) + outside counsel review hours  
**Category:** Legal  
**Credential slots:** `EMAIL_WEBHOOK_URL` or `DOCUSIGN_WEBHOOK`, `SLACK_WEBHOOK_URL`, `NOTION_API_KEY`

**Database imports:**
- **Contract Library** (PDF batch / ZIP) — all past contracts → standard terms baseline, deviation pattern library
- **Legal Playbook** (markdown / PDF) — negotiation positions, acceptable deviations → policy enforcement
- **Regulatory Library** (PDF) — relevant regulations for your industry → compliance obligation extraction
- **Past Redlines Archive** (docx / markdown) — accepted/rejected redlines → precedent for future negotiations

**What it does:**  
Contract upload webhook. Three parallel agents: (1) non-standard clause detector (vs. imported contract library + legal playbook); (2) liability/indemnity exposure scorer; (3) data privacy obligation extractor (GDPR/CCPA/HIPAA). Evaluator: combined risk report. Low → auto-approve with notes. Medium → send to legal. High → block + human-in-the-loop. Regulatory monitoring cron: watches for regulatory changes, checks gaps against imported policy library, drafts required updates, routes for approval.

---

### 11 — `executive-intelligence`

**Replaces:** Executive assistant + news monitoring ($3,000+/mo total)  
**Category:** Executive  
**Credential slots:** `GMAIL_OAUTH`, `SLACK_WEBHOOK_URL`, `CALENDAR_API_KEY`, `DATABASE_URL`

**Database imports:**
- **Company Strategy Doc** (markdown / PDF) — current strategy, OKRs, priorities → relevance filtering for all intelligence
- **Key Relationships** (CSV) — board members, key clients, strategic partners → priority alerting rules
- **Historical Briefings** (markdown) — past executive briefs → tone and format calibration

**Cross-app intelligence:** Automatically queries `competitive-intel-os` knowledge if that app is running in the same workspace. Pulls CS signals from `customer-success-autopilot` if running. The more apps running in the workspace, the richer the executive intelligence.

**What it does:**  
6am daily: five parallel agents — (1) market/industry news filtered by imported strategy; (2) competitor signals from last 24h; (3) internal metrics delta vs targets; (4) team standup summaries from Slack; (5) today's calendar with imported relationship context. `context_compress` collapses all five streams. Agent writes brief: 3 things needing attention, 2 trending positively, 1 strategic question. Evaluator: brevity + signal-to-noise + action-ability (max 400 words). Critical signal detection triggers immediate notification.

---

### 12 — `knowledge-curator`

**Replaces:** Guru / Confluence maintenance (20+ hrs/month curation)  
**Category:** Knowledge Management  
**Credential slots:** `SLACK_WEBHOOK_URL`, `NOTION_API_KEY` or `CONFLUENCE_API_KEY`, `GITHUB_TOKEN`

**Database imports:**
- **Full Documentation Export** (Confluence export / Notion export / markdown ZIP) — entire existing wiki → eliminates cold start; app starts with full knowledge base
- **GitHub Repos** (GitHub API) — codebase and README files → technical documentation context, staleness detection
- **Support Ticket Archive** (export) — past tickets → identifies existing knowledge coverage gaps

**What it does:**  
Continuous trigger on new support ticket, Slack #help question, GitHub issue. Agent checks if answered by knowledge. Answered: surface link + increment hit count. Not answered: log gap. Weekly: gap batch → agent drafts missing docs → evaluator quality gate → human-in-the-loop SME approval → publish via integration. Monthly: scheduled cron triggers a staleness audit — reads all docs, compares against recent GitHub commits, flags outdated references, proposes updates. Quarterly: scheduled cron triggers a coverage gap analysis by support category.

---

## PART VII — Competitive Positioning

---

## § 15 — The Capability Matrix

| Capability | Zapier | Make | n8n | Agentis |
|---|---:|---:|---:|---:|
| Multi-step deterministic automation | yes | yes | yes | yes |
| LLM calls in workflows | no | partial | yes | yes |
| Parallel agent orchestration | no | no | no | yes |
| Evaluator nodes — output quality gates | no | no | no | yes |
| Guardrails — safety and brand enforcement | no | no | no | yes |
| Goal-driven autonomous tasks | no | no | no | V2 |
| Human-in-the-loop as a workflow primitive | no | no | partial | yes |
| Semantic routing (`llm_route`) | no | no | no | yes |
| Context compression for long runs | no | no | no | yes |
| Subflows + multi-agent composition | no | no | no | yes |
| Living knowledge base as workflow primitive | no | no | no | yes |
| Persistent agent memory across runs | no | no | no | yes |
| Whole-database import as trained data | no | no | no | yes |
| Apps that get smarter over time | no | no | no | yes |
| Workspace-local app manifests | no | no | no | yes |
| Cross-app intelligence network | no | no | no | yes |
| Canvas-first app build experience | no | no | no | yes |

**The key rows are the bottom five.** Every platform above can add more connectors. None of them can close the gap on "Whole-database import as trained data," "Apps that get smarter over time," or "workspace-local app manifests." These require the evaluator calibration model, the knowledge node primitive, the DataIngestionPipeline, and the app activation model to be designed together from first principles. Retrofitting them into n8n would require rebuilding the execution model.

Agentis is the platform that turns domain expertise and proprietary data into autonomous software. That's what no other automation platform offers.

---

## PART VIII — Implementation Roadmap

---

## § 16 — Implementation Phases

### Phase 1: Schema Foundation

| Task | File | Notes |
|---|---|---|
| Rename `bundle` → `agentis` in `packageKindSchema` | `packages/core/src/types/package.ts` | Update discriminated union |
| Write full `agentisPackageContentsSchema` | `packages/core/src/types/package.ts` | See § 4 — includes `datasetSpecs` |
| Add `datasetSpecSchema` | `packages/core/src/types/package.ts` | New export |
| Add `'agentis_package'` to `RegistryEntryType` | `packages/core/src/types/registry.ts` | |
| Add `'agentis_package'` to `RegistryArtifactType` | `packages/core/src/types/registry.ts` | |
| Add metadata fields to registry entries | `packages/core/src/types/registry.ts` | `datasetSpecCount`, `rubricCount`, `category`, `replaces`, `activationCount` |
| `pnpm --filter @agentis/core typecheck` | — | Must pass before proceeding |

### Phase 2: DataIngestionPipeline

| Task | File | Notes |
|---|---|---|
| `DataIngestionService` — parse, chunk, embed, index | `apps/api/src/services/dataIngestion.ts` | New service |
| `DataIngestionJob` DB table | `packages/db/src/` | Track job state |
| Format parsers (CSV, markdown-zip, PDF, GitHub) | `apps/api/src/services/dataIngestion/parsers/` | One module per format |
| Chunking strategies (per-row, per-doc, sliding-window) | `apps/api/src/services/dataIngestion/chunkers/` | |
| SSE progress stream | `apps/api/src/routes/apps.ts` | `GET /v1/apps/:slug/data/:key/progress` |
| Import routes (start, status, delete, preview) | `apps/api/src/routes/apps.ts` | |

### Phase 3: Activation + Optional Export Pipeline

| Task | File | Notes |
|---|---|---|
| `PackagerService.activateApp()` | `apps/api/src/services/packager.ts` | Creates app instance; seeds knowledge, memory, rubrics, baselines on activation |
| Activation API | `apps/api/src/routes/apps.ts` | Create/list/pause/resume app instances in the workspace |
| App setup wizard submit handler | `apps/api/src/routes/apps.ts` | Persists credentials, dataset plan, initial trigger state |
| Optional `agentis export <slug> [--include-trained-data]` | `packages/cli/src/commands/export.ts` | Serialize rubrics, variants, memory as seeds for backup/migration |
| Optional exported-file load | `packages/cli/src/commands/load.ts` | V1+ side feature; not required for core build-and-run |
| Optional export: LLM distillation of imported databases → seeds | `apps/api/src/services/packager.ts` | Top-N pattern extraction from full corpus |

### Phase 4: Builder-First UI

| Task | File | Notes |
|---|---|---|
| New `/apps` route → `AppsPage` | `apps/web/src/App.tsx` + new page | Runtime home |
| New `/apps/:slug` route → `AppDetailPage` | `apps/web/src/App.tsx` + new page | Per-app dashboard |
| New `/apps/:slug/data` tab → `AppDataPage` | `apps/web/src/pages/AppDetailPage.tsx` | Data import interface |
| Update nav: Canvas as primary, Apps/Approvals/Ledger as runtime | `apps/web/src/components/shell/Sidebar.tsx` | |
| App setup wizard component (4-step) | `apps/web/src/components/apps/AppSetupWizard.tsx` | Shown when activating a new app |
| Data import drop zone + SSE progress | `apps/web/src/components/apps/DataImportPanel.tsx` | |
| App card component | `apps/web/src/components/apps/AppCard.tsx` | |

### Phase 5: The 12 App Blueprints

> **Status — Implemented.** The twelve starter definitions live in `packages/cli/app-blueprints/*.agentis.ts` and can be imported with `agentis build <file>`.

| Blueprint | Location | Content |
|---|---|---|
| `autonomous-sdr` | `packages/cli/app-blueprints/` | Starter app definition with `agentis` kind |
| `competitive-intel-os` | `packages/cli/app-blueprints/` | |
| `engineering-copilot` | `packages/cli/app-blueprints/` | |
| `customer-success-autopilot` | `packages/cli/app-blueprints/` | |
| `content-machine` | `packages/cli/app-blueprints/` | |
| `recruiting-pipeline` | `packages/cli/app-blueprints/` | |
| `bi-narrator` | `packages/cli/app-blueprints/` | |
| `soc-triage` | `packages/cli/app-blueprints/` | |
| `product-feedback-loop` | `packages/cli/app-blueprints/` | |
| `legal-compliance-monitor` | `packages/cli/app-blueprints/` | |
| `executive-intelligence` | `packages/cli/app-blueprints/` | |
| `knowledge-curator` | `packages/cli/app-blueprints/` | |

### Phase 6: Two New Builtin Skills

| Skill | File | Behavior |
|---|---|---|
| `agentis.audit_trail` | `apps/api/src/services/builtinSkills.ts` | Reads `ledger_events` + `blockData` + approvals → compliance log |
| `agentis.build_workflow` | `apps/api/src/services/builtinSkills.ts` | Calls `draft-from-prompt` logic, optionally persists |

---

## PART IX — The README Story

---

## § 17 — How We Tell This Story

The public README and onboarding copy:

```
## Agentis

Build and run your own agentic apps.

An Agentis app is not a workflow template.
It's not an agent configuration.
It's not an automation.

It's autonomous software — a complete system that runs a business function
permanently, escalates to you when it needs a decision, and gets measurably
smarter as it processes more of your data.

You build it on the canvas.
Wire parallel agents, evaluator gates, human checkpoints, knowledge nodes.
Activate it in your workspace. Feed it your data.

─────────────────────────────────────────

Your app starts capable.
Feed it your data and it becomes a specialist.

    # After building your autonomous SDR app,
    # import your company's history:

    CRM export:         3,247 contacts · 8 years of deals
    Email archive:      25,000 approved outbound messages
    ICP document:       your positioning and target profiles
    Call transcripts:   2,000 recorded sales calls

    # Agentis processes it all into retrieval-ready knowledge:

    ICP pattern library:    127 patterns from your actual wins
    Objection library:       43 objection/response pairs from real calls
    Evaluator calibration:   confidence 62% → 78% on Day 1

Now it knows your ICP. It knows your objections.
It knows what tone works in your market.

It doesn't just automate your sales process — it understands it.

─────────────────────────────────────────

Every run makes it better.

Human approvals refine the evaluator rubric.
Outcomes tracked in the knowledge base improve retrieval.
Prompt variants A/B test against real decisions in production.

No maintenance required. It compounds on its own.

─────────────────────────────────────────

The canvas has everything you need to build any autonomous app:

    parallel          — run multiple agents simultaneously
    evaluator         — quality gates on any output
    guardrails        — safety and policy enforcement
    human_in_the_loop — escalation as a first-class primitive
    knowledge         — retrieval-augmented generation built in
    memory            — persistent context via agentis.memory.* skills
    context_compress  — long-running workflows without context limits
```

---

## Appendix — Builtin Skills That Power Agentis Apps

> **Status — Implemented.** Builtins now include `agentis.audit_trail` and `agentis.build_workflow`, alongside `echo`, `http_fetch`, `agentis.memory.read`, `agentis.memory.write`, and `agentis.team.design`.

### `agentis.audit_trail`

**Used by:** `soc-triage`, `legal-compliance-monitor`

```typescript
// Input
{
  runId: string,
  workflowId: string,
  format?: 'json' | 'markdown'   // default: 'json'
}

// Behavior: reads ledger_events for the run + blockData from workflow_runs.runState
// + approval_requests + their resolutions
// Synthesizes: which nodes ran, in what order, what data was touched,
// what decisions were made at router/evaluator nodes, any failures/retries,
// who approved what and when, total cost

// Output
{
  log: ComplianceEntry[],   // one entry per significant event
  summary: string,           // natural language paragraph
  runId: string,
  workflowId: string,
  generatedAt: string
}
```

Extends the existing pattern of `agentis.memory.read/write` and `agentis.team.design`. (`agentis.plan`, `agentis.evaluate`, `agentis.reflect` are also planned but not yet implemented.)

### `agentis.build_workflow`

**Used by:** `knowledge-curator`, `executive-intelligence`

```typescript
// Input
{
  goal: string,              // "Build a workflow that monitors Slack for keywords and creates Jira tickets"
  title?: string,
  constraints?: string[],    // ["must include human_in_the_loop", "no external API calls"]
  create?: boolean           // if true, persists workflow via workflowGraphStore (default: false)
}

// Behavior: calls POST /v1/workflows/draft-from-prompt logic internally
// If create: true — persists via workflowGraphStore, returns workflowId
// Otherwise returns draft for human canvas review

// Output
{
  graph: WorkflowGraph,
  workflowId?: string,       // only if create: true
  requiresReview: boolean    // true when create: true (human should inspect before activating)
}
```

---

## PART X — Platform Completeness: The Best Place to Build AND Run

The goal is not to be the best place to *run* agentic apps. It's to be the best place to *build* them too. That distinction matters. Run-only is a runtime. Build+Run is a platform.

This section cross-references a strategic platform audit against the actual codebase. Every item below is verified against the code that exists today.

---

## § 18 — What Agentis Already Has (Codebase-Verified)

These are genuine strengths — things that exist in the code and that no single competitor combines:

| Strength | Codebase Evidence | Status |
|---|---|---|
| **Self-hosted, no cloud dependency** | `install.sh` / `install.ps1`, SQLite + `apps/api/src/db.ts`, `.agentis/secrets.json` | ✅ Shipped |
| **Deterministic workflow engine** | `WorkflowEngine.ts` — retry, cache, concurrency caps, stale recovery, event chaining | ✅ Shipped |
| **Framework-agnostic adapters** | `OpenClawAdapter`, `HermesAdapter`, `ClaudeCodeAdapter`, `HttpAdapter` in `apps/api/src/adapters/` | ✅ Shipped |
| **Living canvas** (60fps overlays, photons, retry ripples) | `AgentFocusOverlayManager`, `PRESENCE_EVENT_THROTTLE_MS=50`, `WorkflowNode.tsx` | ✅ Shipped |
| **Approval chain + HITL as first-class primitive** | `human_in_the_loop` node type, `approval_requests` table, `ApprovalInboxService` | ✅ Shipped |
| **Budget caps and spend tracking** | `BudgetService.checkAndReserve()`, `costMicros` on runs | ✅ Shipped |
| **Skill registry with install pipeline** | `builtinSkills.ts`, skill tier dispatch (builtin/node_worker/docker_sandbox), `registryScanner.ts` | ✅ Shipped |
| **Guardrails node** (per-workflow safety enforcement) | `guardrails` case in `WorkflowEngine.#dispatchNode()` L683 | ✅ Shipped |
| **Parallel agent orchestration** | `parallel` node type, `#executeParallel()` | ✅ Shipped |
| **Evaluator nodes** (output quality gates) | `evaluator` node type, `#executeEvaluator()` | ✅ Shipped |
| **Subflows + multi-agent composition** | `SubflowExecutor`, `subflow` node type | ✅ Shipped |
| **Context compression** | `context_compress` node, extractive + key_filter strategies | ✅ Shipped |
| **Event chaining across workflows** | `workflow_event_subscriptions` table, `SchedulerService` | ✅ Shipped |
| **Partial replay** (surgical retry from failed node) | `PartialReplayService`, 4 replay modes | ✅ Shipped |
| **Structured audit + ledger** | `ledger_events` table (append-only, sequence-numbered), `LedgerService` | ✅ Shipped |
| **OTel telemetry foundation** | `apps/api/src/telemetry/index.ts`, `AGENTIS_OTEL_ENDPOINT` env, spans on engine tick + dispatch (D38) | ✅ Shipped (opt-in) |
| **MCP tool injection for agents** | `config.mcpServerIds` in `agent_task` dispatch, `WorkflowEngine.ts` L824 | ✅ Partial |

---

## § 19 — Tier 1: Critical Build Targets

These are the gaps that prevent Agentis from credibly claiming "the best place to *build*." The run side is strong. The build side needs these three.

---

### 19.1 — `@agentis/sdk`: Code-First Agent & Workflow Definitions

> **Status — Implemented.** `packages/sdk` provides `defineAgentisApp`, `defineDataset`, `defineWorkflow`, package manifest builders, and a lightweight Agentis API client.

**The gap:** Every serious builder version-controls, unit-tests, and CI/CD their infrastructure. Drag-and-drop is the *monitoring surface*. Code is the *building surface*. LangGraph and CrewAI live entirely in this gap.

**What to build:**

```typescript
// @agentis/sdk — thin TypeScript DSL that compiles to Agentis app definitions

import { defineAgent, defineWorkflow, skill } from '@agentis/sdk';

const researcher = defineAgent({
  name: 'Hermes',
  adapter: 'claude_code',
  model: 'claude-opus-4-5',
  playbook: `You are Hermes, a Research Engineer...`,
  capabilities: ['research', 'web_search'],
});

const pipeline = defineWorkflow('research-pipeline', {
  trigger: { type: 'cron', schedule: '0 9 * * 1-5' },
  nodes: [
    skill('web_search', { query: '{{run.topic}}' }),
    researcher.task('Analyze and summarize findings'),
    skill('slack_post', { channel: '#research' }),
  ],
});

export default pipeline;
```

**How it fits the existing architecture:**
- `defineWorkflow()` → compiles to `WorkflowGraph` (already defined in `packages/core/src/types/workflow.ts`)
- `defineAgent()` → compiles to `AgentManifest` (already defined in `packages/core/src/types/`)
- `export default pipeline` → produces an Agentis app definition that can be activated in the workspace
- The SDK is a **compiler target** on top of existing types — not a new execution model

**Implementation path:**

| Task | File | Notes |
|---|---|---|
| New workspace package `@agentis/sdk` | `packages/sdk/` | TypeScript DSL layer |
| `defineAgent()` builder | `packages/sdk/src/agent.ts` | Returns `AgentContents` via fluent API |
| `defineWorkflow()` builder | `packages/sdk/src/workflow.ts` | Returns `WorkflowGraph` |
| `skill()` helper | `packages/sdk/src/skill.ts` | Typed shorthand for `skill_task` nodes |
| `agentis build ./my-app.ts` CLI command | `packages/cli/src/index.ts` | Runs tsx for TS modules, captures default export, imports the package |
| `agentis activate <packageId>` command | `packages/cli/src/index.ts` | Activates a built/imported package in the local workspace |
| TypeScript types auto-generated from Zod schemas | `packages/sdk/src/types/` | Re-export from `@agentis/core` |

---

### 19.2 — Evaluation Framework: Agent Quality Gates

> **Status — Implemented.** `eval_suites`, `eval_cases`, `eval_results`, `EvalService`, `/v1/evals`, app-level eval UI, and `agentis eval` CLI support are present. The first scorer is deterministic expected-output matching; LLM-as-judge remains a future scorer mode.

**The gap:** Builders have no way to define what "good output" looks like, run their workflows against test cases, or detect regressions before activating a prompt change. Braintrust, LangSmith, and Langfuse are entire companies built around this gap.

**What to build:**

```typescript
// Eval suite definition — stored in new `eval_suites` table
{
  suiteId: string,
  workflowId: string,
  name: string,
  cases: Array<{
    caseId: string,
    inputs: Record<string, unknown>,    // run trigger inputs
    expectedOutputShape?: z.ZodSchema,  // structural check
    scoringCriteria?: string,           // LLM-as-judge prompt
    scoreThreshold?: number,            // 0–1, minimum acceptable
  }>,
  passThreshold: number,   // fraction of cases that must pass
}

// After running: eval_results table
{
  suiteId, runId, caseId,
  score: number,
  passed: boolean,
  judgeReasoning: string,
  blockData: RunBlockData,   // reuse existing observability structure
  runAt: string,
}
```

**CLI integration:**
```bash
agentis eval run ./my-app --suite regression
# → Runs 10 test cases, scores outputs via LLM judge
# → Pass: 9/10 (90%) · Threshold: 80% · ✓
# → Case 3 failed: score 0.31 (expected >0.8)
# →   Reason: "Response missing source citations (criteria: ≥3 sources)"
```

**Implementation path:**

| Task | File | Notes |
|---|---|---|
| `eval_suites` DB table | `packages/db/src/` | `{suiteId, workflowId, name, cases JSON}` |
| `eval_results` DB table | `packages/db/src/` | Links to `workflow_runs`, stores scores |
| `EvalService.runSuite()` | `apps/api/src/services/evals.ts` | Triggers workflow for each case and stores summary metrics |
| Deterministic scorer | `apps/api/src/services/evals.ts` | Expected-output matching; LLM judge can be added as another mode |
| `POST /v1/evals` | `apps/api/src/routes/evals.ts` | Create/manage suites |
| `POST /v1/evals/:id/run` | `apps/api/src/routes/evals.ts` | Trigger suite run |
| `GET /v1/evals/:id/results` | `apps/api/src/routes/evals.ts` | Results with trend |
| App-level "Evals" panel | `apps/web/src/components/apps/EvalsPanel.tsx` | Smoke suite creation and run controls |
| `agentis eval <suiteId>` CLI command | `packages/cli/src/index.ts` | API-backed eval execution |

---

### 19.3 — MCP Integration: Client + Server

> **Status — Implemented.** Agent task MCP access remains, `mcp_tool` is now a canvas-droppable workflow node, consume-server catalog discovery exists, and expose-mode servers publish tools through the MCP protocol routes.

**The gap:** MCP is the emerging standard connector protocol. Every major tool vendor (Supabase, GitHub, Firebase, Stripe) ships an MCP server. Without native canvas support, builders must manually wrap each one. Without Agentis-as-MCP-server, external AI systems (Claude, GPT, Cursor) can't call into Agentis workflows.

**What to build:**

**Part A — MCP Client (canvas skill node):**

| Task | File | Notes |
|---|---|---|
| `mcp_tool` skill type in `WorkflowNodeType` | `packages/core/src/types/workflow.ts` | New node kind |
| `MCP_TOOL_CONFIG_SCHEMA` | `packages/core/src/schemas/workflow.ts` | `{ serverId, toolName, arguments, outputKey }` |
| `#executeMcpTool()` in WorkflowEngine | `apps/api/src/engine/WorkflowEngine.ts` | Connects to MCP server, calls tool, returns output |
| MCP server discovery endpoint | `apps/api/src/routes/mcp.ts` | `GET /v1/mcp/servers/:id/catalog` — introspects available tools |
| Canvas palette entry + inspector form | `apps/web/src/components/canvas/ContextInspector.tsx` | Server URL input + tool picker from introspection |

**Part B — MCP Server (Agentis-as-MCP):**

| Task | File | Notes |
|---|---|---|
| `GET /mcp` — MCP server manifest | `apps/api/src/routes/mcp.ts` | Exposes workspace workflows as MCP tools |
| `POST /mcp/tools/:workflowSlug` — tool call handler | `apps/api/src/routes/mcp.ts` | Triggers workflow, returns response |
| Auth: MCP API key issuance | `apps/api/src/routes/auth.ts` | Separate from JWT flow |

> **Network-effect multiplier:** Every MCP server in the ecosystem becomes an Agentis integration for free. Every Agentis workflow becomes callable from Claude Desktop, Cursor, and any MCP client.

---

## § 20 — Tier 2: High-Priority Build Targets

---

### 20.1 — Workflow Versioning & Rollback

> **Status — Implemented.** Graph saves create `workflow_graph_revisions`, consecutive identical graphs are deduped, `/v1/workflows/:id/revisions` lists snapshots, `/v1/workflows/:id/revisions/:revisionId/restore` restores them, and the canvas inspector includes a Version History tab.

**What to build:**

| Task | File | Notes |
|---|---|---|
| Auto-snapshot graph on every canvas save | `apps/api/src/routes/workflows.ts` (`PATCH /:id`) | Dedup by content hash; store in new `workflow_versions` table |
| `workflow_versions` DB table | `packages/db/src/` | `{versionId, workflowId, graph JSON, hash, savedAt, label?}` |
| `GET /v1/workflows/:id/versions` | `apps/api/src/routes/workflows.ts` | List versions with diff summary |
| `POST /v1/workflows/:id/versions/:vId/restore` | `apps/api/src/routes/workflows.ts` | Restores graph; creates new version entry |
| "Version History" tab in canvas inspector | `apps/web/src/components/canvas/ContextInspector.tsx` | Timeline + one-click restore |

---

### 20.2 — Interactive Agent Playground

> **Status — Implemented.** Agent task nodes can run through from-node test mode, skill task nodes call isolated skill execution, `POST /v1/skills/:id/test` exists, and Agent Detail includes a side-by-side prompt/model comparison playground.

**What to build:**

| Task | File | Notes |
|---|---|---|
| "Test" button on agent task nodes in canvas | `apps/web/src/components/canvas/ContextInspector.tsx` | Opens conversation thread seeded with node context |
| "Test skill" button on skill_task nodes | `apps/web/src/components/canvas/ContextInspector.tsx` | Calls `POST /v1/skills/:id/test` with sample inputs |
| `POST /v1/skills/:id/test` — isolated skill execution | `apps/api/src/routes/skills.ts` | Runs skill, returns output + cost |
| Side-by-side prompt comparison in agent config | `apps/web/src/pages/AgentDetailPage.tsx` | A/B two prompt variants, same input |

---

### 20.3 — OTel: Promote from Opt-In to First-Class

> **Status — Implemented.** `apps/api/src/telemetry/index.ts` keeps the dynamic OTel SDK path, `AGENTIS_OTEL_ENDPOINT` enables export, development mode falls back to a console exporter, run trace IDs propagate into ledger events, and `/v1/traces/:runId/export` returns a downloadable trace bundle.

**What to build:**

| Task | File | Notes |
|---|---|---|
| Propagate `traceId` through `ledger_events` | `packages/db/src/`, `apps/api/src/services/ledger.ts` | Link run traces to OTLP spans |
| `GET /v1/traces/:runId/export` | `apps/api/src/routes/runs.ts` | Returns JSON trace for download |
| Document `AGENTIS_OTEL_ENDPOINT` in README | `README.md` | Jaeger/Grafana/Datadog instructions |
| Default-on console exporter (dev mode) | `apps/api/src/telemetry/index.ts` | Useful without a backend |

---

## § 21 — Tier 3: Trust & Governance

---

### 21.1 — Policy Engine (Cross-Cutting Guardian Layer)

> **Status — Implemented foundation.** `guardrails` remains the per-node primitive. Cross-cutting policy persistence, evaluation, decision audit, and `/v1/policies` CRUD/evaluate routes are now present; deeper automatic enforcement hooks can expand from this foundation.

**The distinction:**
- `guardrails` node = "don't let this agent's output leave the node if it violates policy" (opt-in per workflow)
- `PolicyEngine` = "no agent in this workspace may make outbound HTTP calls to non-allowlisted domains, regardless of which workflow it's in" (always-on)

**What to build:**

| Task | File | Notes |
|---|---|---|
| `policies` DB table | `packages/db/src/` | `{policyId, workspaceId, kind, rule JSON, enforcement, enabled}` |
| `PolicyService.evaluate(context)` | `apps/api/src/services/policies.ts` | Safe-condition based policy decisions with audit rows |
| Hook into WorkflowEngine at enforcement points | `apps/api/src/engine/WorkflowEngine.ts` | Future expansion from the persisted policy foundation |
| `GET/POST /v1/policies` | `apps/api/src/routes/policies.ts` | CRUD + evaluate + decision history |
| Policy config UI | `apps/web/src/pages/SettingsPage.tsx` | Toggle policies, define allowlists |

**Built-in policy kinds to start:**
- `domain_allowlist` — blocks outbound HTTP to non-allowlisted domains
- `spend_cap_per_agent` — rate-limits LLM spend per agent per hour
- `output_pattern_flag` — flags outputs matching specified regex patterns

---

### 21.2 — Signed Agent Provenance

> **Status — Implemented.** Ledger entries store stable payload hashes, optional HMAC signatures via `AGENTIS_PROVENANCE_HMAC_KEY`, trace IDs, `/v1/runs/:id/provenance` exports run trace/ledger proof data, and `/v1/agents/:id/.well-known/agent.json` exposes a signed agent identity manifest backed by the JWKS key material.

**The long-term goal:** When Hermes posts to Slack on behalf of an operator, the recipient can verify: (a) it was Agentis, (b) it was the specific agent `Hermes`, (c) it was authorized by workspace `acme-corp`, (d) it ran workflow `autonomous-sdr` run `abc123`.

**What to design now, ship incrementally:**

| Task | File | Notes |
|---|---|---|
| `signaturePem` field on `ledger_events` | `packages/db/src/` | Optional initially; sign high-stakes entries (approvals, outbound sends) |
| `AgentIdentity.sign(entry)` helper | `apps/api/src/security/agentIdentity.ts` | Uses existing JWT private key material |
| `GET /v1/agents/:id/.well-known/agent.json` | `apps/api/src/routes/agents.ts` | Public key + agent identity manifest |
| Compliance export format | `apps/api/src/routes/runs.ts` | `agentis audit_trail` → signed JSON bundle |

---

*Last updated: May 6, 2026*  
*Implementation status: Local/self-hosted Agentis app runtime implemented end to end; verification tracked by workspace typechecks and tests.*  
*Reference implementations: `docs/V1-SPEC.md`, `packages/core/src/types/package.ts`, `apps/api/src/services/builtinSkills.ts`*

