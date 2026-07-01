# DATA SOVEREIGNTY 10X — Own Your Own Data

> Status: PROPOSED (2026-06-29). Operator: serve **both** individual and company/team from
> one spine; company-deepening features come later but the architecture must not preclude them.
> Extends [BRAIN-10X-MASTERPLAN](brain/BRAIN-10X-MASTERPLAN.md), the `.agentis` bundle work,
> and AGENT-TRANSITION-IMPORT-10X. This is the reformulation doc, not an impl log — §10 is the log.

---

## 0. The reframe

Models are commoditizing; **context is not**. The durable asset in the AI economy is the
accumulated, corrected, structured knowledge — personal and organizational — that makes any
model useful *to you specifically*. Today that asset is harvested into vendor silos one prompt
at a time: your ChatGPT memory can't move to Claude, your Copilot context can't be audited,
your company's hard-won judgment becomes *their* moat. Every interaction makes the vendor
smarter about you and leaves you owning nothing.

**The inversion:** Agentis becomes the context layer *you* own. The Brain is the spine; models
become interchangeable, stateless renters of it. The knowledge accretes on your side of the
boundary; the model only ever sees an ephemeral, minimal, optionally-redacted slice — and every
byte that crosses the boundary is logged, attributable, and revocable.

This is not a new subsystem bolted on. ~60% of the foundation already exists (§2). The work is
to **re-root the product around the Brain** and add the four organs that turn "memory storage"
into "data sovereignty": Reclaim, the Context Firewall, the Egress Ledger, and the
Provenance/Forget spine — all on the portable, signed `.agentis` substrate that already proves
you can leave (even leave *us*).

---

## 1. Doctrine

The non-negotiable principles every phase is checked against.

1. **The Brain is the root, workspaces are lenses.** Ownership is the first surface a user
   lands on, not a tab inside a workspace. Workspaces are scoped projections over one spine.
2. **No knowledge leaves except as a slice we assembled.** Your accumulated memory enters a
   model request only through the Firewall's minimal-slice retrieval. The Brain is never shipped
   wholesale to a vendor.
3. **Every egress is on the record.** Every outbound context payload — which facts, to which
   runtime/model, on which request — is captured in an append-only ledger. "Show me everything
   we sent OpenAI last month" is a query, not a research project.
4. **Forget means forget.** Deleting a fact removes it from the Brain *and* from all future
   injections, and is provable. Right-to-be-forgotten is a first-class operation, not a support
   ticket.
5. **No lock-in, even from us.** The whole spine exports as a signed, open, re-importable
   `.agentis` bundle. Trust to centralize comes from the guaranteed ability to leave.
6. **No parallel stores; extend the canonical seams.** Reclaim writes through
   `EpisodicMemoryStore` + the formation pipeline like every other memory. The Firewall sits on
   the existing recall seam. The Ledger decorates the existing `AgentAdapter` boundary. (See
   `feedback_no_duplication`.)
7. **Honest boundaries.** Where Agentis genuinely cannot see a vendor's internal augmentation
   (harness CLIs make their own provider calls), the product says so and shows exactly what *it*
   sent — it never fakes total visibility (§8).

---

## 2. Current state — what already exists (code-grounded)

The reformulation is mostly *promotion and connection* of shipped seams, not greenfield.

| Capability | Where it lives today | Gap to close |
|---|---|---|
| Memory spine (4 scopes, real ONNX embeddings, semantic recall) | `memory_episodes`, `knowledge_chunks`, `EpisodicMemoryStore`, `embeddingProvider.ts` (local multilingual-e5-small) | Re-root as product center; add user-level (cross-workspace) scope |
| User-level store (cross-workspace) | `user_notes` (keyed by `userId`), `PersonalBrainService`, `routes/personalBrain.ts`, `personal_brain_grants` | Thin (notes only) → elevate to the "global brain before workspaces" |
| Harness memory import | `harnessImport/` (5 sources) + `HarnessMemoryIngestionService` | Imports **authored notes only**, deterministic distill — no transcripts (§3.B) |
| Runtime swap keeps identity | `switchRuntime`, model-agnostic `AgentAdapter` | Already the "models are renters" primitive; needs the Firewall in front |
| Audit sink w/ token usage | `audit_entries` (v105: `tokens_in/out`, per terminal node), `runAnalytics.ts` | Per-node, run-scoped → Egress Ledger needs per-*call*, all paths incl. chat |
| Forget scaffolding | `brain_forget_requests`, `brain_quality_events` tables | Wire to a real provable delete + injection-time exclusion |
| Portable/signed bundle | `.agentis` bundle (PackagerService, `backup.ts`, RSA-sign + scrub) | Already the sovereignty guarantee; extend to carry Brain + ledger |
| Universal model boundary | `AgentAdapter.chat(history, tools, opts)` + `dispatchTask(task)` (`packages/core/src/types/adapter.ts:172`) | The single conceptual chokepoint to decorate for egress capture |

**Critical architectural truth discovered while grounding this plan:** there is **no single HTTP
chokepoint** for all model traffic. Many runtimes are *harnesses* (Claude Code, Codex, Antigravity
CLIs) that make their own provider calls in their own process. Therefore the sovereignty boundary
is **not the wire** — it is the **context-assembly + `AgentAdapter` boundary**, where Agentis
decides what context to inject. That is the correct boundary regardless: your knowledge enters a
request when *we* assemble it, no matter which runtime ultimately ships it. The plan is built on
this seam, and §8 states honestly what we can and cannot see past it.

---

## 3. Architecture — the Sovereign Spine + four organs

```
                 ┌──────────────────────────────────────────────┐
   You / company │            SOVEREIGN BRAIN  (you own)         │
        │        │  user scope ─ workspace scope ─ agent scope   │  ← Organ A
        ▼        │  episodes · knowledge · provenance · embeds   │
   ┌─────────┐   └───────────────┬──────────────────────────────┘
   │ Reclaim │  Organ B           │ recall (minimal slice)
   │ basic / │ ─────────────────► │
   │ profound│   imports back     ▼
   └─────────┘   OUT of silos  ┌──────────────────┐  policy: slice + redact + route
                               │ CONTEXT FIREWALL │  ← Organ C
                               └────────┬─────────┘
                                        │ gated context
                                        ▼
                 ┌──────────────── EGRESS LEDGER ────────────────┐  ← Organ D
                 │ append-only: what facts · to whom · when · why │
                 └────────────────────┬──────────────────────────┘
                                      │ AgentAdapter.chat(history) / dispatchTask(task)
                       ┌──────────────┼───────────────┬───────────────┐
                       ▼              ▼               ▼               ▼
                  local model    frontier model   harness CLI     remote gateway
                  (sensitive)    (redacted)       (we see inject) (we see inject)
                                      │
                                      ▼  compute returns; memory stays home
                            Provenance & Forget (Organ E) governs every atom's lifecycle
                            Signed portable export (Organ F) guarantees exit
```

### Organ A — The Sovereign Brain (re-root + global scope)

The spine exists; this organ **promotes it to the product's center** and adds the missing
**user-level (cross-workspace) scope** the operator intuited ("a global brain before workspaces").

- **Scope ladder.** Today: `workspace` and `agent` scopes (both inside a workspace) + thin
  `user_notes`. Add a true **`user` brain scope** that spans every workspace the owner has,
  backed by the same `memory_episodes`/`knowledge_chunks` machinery (not a parallel store) with
  `scope = 'user'`, `scopeId = userId`. `user_notes` becomes one *source* into this scope, not
  the whole thing. Recall resolves `user ⊇ workspace ⊇ agent` (the floor pattern from
  `resolveAgentTaskTools`).
- **"My Data" root surface.** A pre-workspace home: what you own (counts by scope/source),
  where each piece came from (provenance), what's leaving your boundary right now (live egress
  feed, Organ D), and what's still trapped in silos waiting to be reclaimed (Organ B). Workspaces
  render *below* this as lenses.
- **Seams:** `schema.ts` (scope enum + indexes), `EpisodicMemoryStore`/`SharedIntelligenceService`
  (scope resolution), `personalBrain.ts` (fold `user_notes` in), new `routes/sovereignBrain.ts`,
  web `MyDataPage`.

### Organ B — Reclaim (this answers the import-depth question)

A sovereign brain is worthless empty; Reclaim is the cold-start and the emotional wedge ("bring
home everything you've poured into 40 AI tools"). The current importer is the *floor*; Reclaim
adds depth and breadth.

**Two import modes** (directly per the operator's note):

- **Basic (exists, cheap, zero-token).** `HarnessMemoryIngestionService` →
  deterministic markdown distillation of **authored** surfaces only: `CLAUDE.md`/`AGENTS.md`
  instructions and the structured fact files in `~/.claude/projects/<slug>/memory/*.md`. It
  walks lines, scores with `RULE_CUES`/`DECISION_CUES` heuristics, writes atoms ≥ quality through
  the canonical store. **It never reads conversation transcripts** — so it captures the curated
  surface of knowledge and misses the accumulated body of it.

- **Profound (new, token-heavy, far richer).** Ingest the **raw conversation history** the
  harnesses already leave on disk and *mine* durable knowledge from it with an LLM extraction
  pass:
  - Claude Code transcripts: `~/.claude/projects/<slug>/*.jsonl`
  - Antigravity: `~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript_full.jsonl`
    (we already read this file to capture `agy` output — see `project_gemini_cli_adapter`)
  - Codex sessions; Cursor history; **silo exports** (ChatGPT `conversations.json`, Claude export,
    Gemini/Copilot exports) dropped into a watched folder.
  - Pipeline: segment transcript → chunk by topic/episode → run a **transcript-mining extractor**
    (reuse `structuredCompleter` / the formation `promote` judge — *not* a new model client) that
    emits typed candidates (decision / preference / fact / entity / failure / success_pattern) with
    provenance back to the exact turn → dedup against the Brain (the existing exact-hash + semantic
    `findSimilar` path) → operator preview → commit. Budgeted and resumable (this can be tens of
    thousands of turns); a spend ceiling and `AbortSignal` like the build runaway guard.
  - **Same sink, new source.** `distillTranscript()` sits beside `distillContent()`; both write
    through `EpisodicMemoryStore` + formation. No parallel store (Doctrine #6).

- **Silo importers as a `ReclaimSource` registry**, mirroring `HARNESS_IMPORT_SOURCES`: one
  declarative module per silo (`chatgpt`, `claude_export`, `gemini`, `copilot`, `notion_ai`, plus
  email/Slack/Drive later). Each normalizes an export into the transcript/atom shape Profound mode
  consumes. Adding a silo = adding one module; the spine never changes.

- **UI:** "Reclaim" wizard with the mode toggle (Basic = "import my notes", Profound = "mine my
  full history — uses model budget"), a cost estimate, live progress, and the existing
  preview→review→commit gate so the operator stays the final authority.

### Organ C — The Context Firewall

The keystone — the only feature that lets you use frontier models *without* feeding them your
knowledge base. It sits on the **recall→prompt seam** (`SharedIntelligenceService` /
`synthesizePreTaskContext` and the recall calls in `chatSessionExecutor`, `channelTurnDispatcher`,
`orchestratorPrompt`), turning today's implicit injection into a governed gate.

For every request, given the assembled candidate context, the Firewall applies a **policy**
(workspace-default, per-agent override, per-conversation override):

1. **Minimal slice.** Retrieve only the top-k brain atoms the task needs (the recall engine
   already ranks; the Firewall enforces a budget + relevance floor and records what it *withheld*).
2. **Redact / tokenize.** Detector pass over the outbound slice swaps real PII / secrets / named
   entities for stable placeholders (`<PERSON_1>`, `<ACCOUNT_7>`), rehydrating on the return path.
   Deterministic detectors first (emails, keys, configured client names), optional model detector
   for free-text. Reuses the secrets-boundary thinking from the `.agentis` export `profile`.
3. **Route by sensitivity.** A fact tagged sensitive (or matched by policy) is routed to a **local
   model** (the bundled ONNX / a local OpenAI-compatible endpoint); the rest may go to a frontier
   model — *per request, per fact*. This makes "model-agnostic" finally mean *keeps identity +
   context AND never re-leaks*.
4. **Hand off + record.** The gated, redacted slice is what the adapter receives; the Ledger
   (Organ D) records the decision.

Policy object lives on the workspace/agent/conversation (extends the existing
Ask/Plan/Auto sticky-permission pattern, `project_chat_permissions_intelligent_stop`). Default
posture is **disclosed and safe**: redaction on for `user`-scope PII, routing off until configured.

### Organ D — The Egress Ledger

Universal, append-only capture of every outbound context payload, decorating the **one conceptual
boundary** every runtime shares: `AgentAdapter.chat(history, tools, opts)` and `dispatchTask(task)`
(`adapter.ts:172`). Because every runtime — in-process, `mcp_native`, `marker_protocol` CLI,
remote gateway — implements this interface, a decorator applied where adapters are resolved gives
**universal capture** with one seam.

- **What's recorded per call:** runId/conversationId (nullable — chat too), agent, runtime +
  resolved model, `toolForwarding` mode (visibility class), the **fact ids** in the injected slice
  (FK to brain atoms — not necessarily the raw text), redactions applied, a content hash, byte
  count, token usage (already captured for `audit_entries` — reuse the estimator), and the
  Firewall decision id.
- **New table `egress_events`** (sibling to `audit_entries`, not an overload — audit is per
  terminal node; egress is per call). v106.
- **Surfaces:** the live egress feed on "My Data"; a per-vendor rollup ("sent to OpenAI / Anthropic
  / local this month"); export to CSV for compliance. This is simultaneously a privacy guarantee,
  a compliance artifact, and a cost lens.
- **P0 ships this read-only first** (capture + show, no redaction/routing yet) because it *proves
  the entire thesis in one screen* and is mostly wiring into seams that already exist.

### Organ E — Provenance & Right-to-be-forgotten

- **Provenance on every atom.** The Brain already stamps source/harness metadata; extend to a
  uniform `provenance { source, sourceRef, importedAt, reclaimMode, transcriptTurnRef? }` so every
  fact knows where it came from and (via the Ledger) everywhere it has been sent.
- **Provable forget.** Wire `brain_forget_requests` to a real operation: tombstone the atom (+ its
  embedding), exclude it from all future recall/injection, and emit a forget receipt
  (what was deleted, when, which past egress events referenced it). Cascade to derived atoms via
  provenance links. This is the honest counterpart to Doctrine #4.

### Organ F — The sovereignty guarantee (already 80% shipped)

The signed, portable `.agentis` bundle is the proof of sincerity. Extend the existing bundle
(`PackagerService` + `backup.ts`) to carry the **user-scope Brain + provenance + egress ledger**
so a full export is a real "take everything and leave" — including the audit trail of what ever
left. The `sell`/`share` profiles (credential-slot boundary, embedding drop, RSA-sign + scrub
gate) already exist and become the economic on-ramp: once you truly own a curated knowledge base,
you can license or sell it.

---

## 4. Data model (migrations v106 → ~v110)

DB is at **v105**; next is **v106**. (Note the codebase skipped v102.)

- **v106 — `egress_events`** (Organ D): `id, workspace_id, user_id, conversation_id?, run_id?,
  node_id?, agent_id?, runtime_type, model, tool_forwarding, fact_ids (json), redactions (json),
  content_hash, bytes, tokens_in?, tokens_out?, firewall_decision_id?, at`. Indexed by
  `(workspace_id, at)` and `(user_id, model, at)`.
- **v107 — `user` brain scope** (Organ A): scope enum/value on `memory_episodes` +
  `knowledge_chunks` (or a `scope` discriminator if not present) + recall indexes; backfill
  `user_notes` as a source.
- **v108 — provenance columns** (Organ E): normalize `provenance` onto episode/chunk metadata +
  a `reclaim_jobs` table (resumable Profound imports: source, cursor, budget, status).
- **v109 — `firewall_policies`** (Organ C): scope-keyed policy rows (redaction mode, routing
  rules, slice budget) extending the sticky-permission pattern.
- **v110 — forget receipts** (Organ E): extend `brain_forget_requests` with tombstone state +
  receipt payload.

Each migration is additive and reversible-by-design (SQLite single-writer, OSS single-tenant —
`project_postgres_portability`). No destructive rewrites.

---

## 5. Seams — the exact files

| Organ | Primary seam (extend, don't fork) |
|---|---|
| A Sovereign Brain | `packages/db/src/sqlite/schema.ts`, `EpisodicMemoryStore`, `SharedIntelligenceService`, `personalBrain.ts`, new `routes/sovereignBrain.ts`, web `MyDataPage` |
| B Reclaim | `harnessImport/` (+ `sources/` transcripts), `harnessMemoryIngestion.ts` (`distillTranscript`), new `reclaim/` source registry, `structuredCompleter`/formation for mining, web Reclaim wizard |
| C Firewall | recall seam in `SharedIntelligenceService` + `brain/sharedIntelligenceUtils.ts` (`synthesizePreTaskContext`), `chatSessionExecutor`, `channelTurnDispatcher`, `orchestratorPrompt`; new `contextFirewall.ts` + `redaction.ts` |
| D Egress Ledger | adapter resolution point + a `SovereignAdapter` decorator over `AgentAdapter.chat`/`dispatchTask`; reuse `audit`/`runAnalytics` token estimator; new `egressLedger.ts` + `routes` |
| E Provenance/Forget | `brain_forget_requests` wiring, `brainMaintenanceService`, `episodicMemoryStore` recall-exclusion |
| F Export | `PackagerService`, `backup.ts`, `WorkspaceBundleModal` (carry user-scope Brain + ledger) |

Pattern echoes the `evidenceLedger.ts` (grounding) and `auditTrail.ts` ledgers already in the tree
— Organ D is the same shape pointed at egress.

---

## 6. Individual AND company — one spine, two postures

The operator's call: serve both now; deepen company later. The architecture makes this a
**posture toggle over identical machinery**, never a fork:

- **Individual posture (default):** hero = Reclaim + privacy. "Bring your scattered AI life home;
  use any model without feeding it your memory." Firewall defaults to PII redaction on the `user`
  scope; Ledger framed as a personal privacy feed; export framed as "you can always leave."
- **Company posture (config flag, deepened later):** the *same* Firewall + Ledger reframed as
  **governance**: policy is set by an owner/manager and enforced for the team (ties into the
  existing manager-owned org model, `project_subdomains_specialist_responsibility`); the Ledger
  is the compliance artifact ("what left our boundary to which vendor"); forget receipts satisfy
  data-subject requests. No new spine — just policy ownership moving up to the org, and
  org-scope rollups on the Ledger.

Because the Brain scope ladder already includes a `user` (owner) scope above workspace, the
company features land as **org/manager scopes above that** without disturbing the individual path.

---

## 7. Phasing

Each phase is independently shippable and leaves the tree green.

- **P0 — Egress Ledger, read-only (Organ D).** Decorate the adapter boundary; record every
  outbound call into `egress_events`; show the live feed + per-vendor rollup on a first "My Data"
  screen. *Proves the whole thesis in one screen; mostly wiring.* No redaction/routing yet.
  *Accept:* every chat/dispatch/synthesis call appears with model + bytes + token usage; rollup
  reconciles with `audit_entries` token totals.
- **P1 — Reclaim: Profound mode + silo importers (Organ B).** `distillTranscript`, the
  `ReclaimSource` registry, ChatGPT + Claude export sources, resumable budgeted jobs, wizard with
  Basic/Profound toggle. *Accept:* a real ChatGPT export yields typed, deduped, provenance-stamped
  atoms in the Brain via preview→commit; re-run is idempotent.
- **P2 — Sovereign Brain re-root + `user` scope (Organ A).** Cross-workspace user scope; "My Data"
  becomes the pre-workspace root; recall resolves the scope ladder. *Accept:* a fact added at user
  scope recalls in every workspace; workspaces render as lenses.
- **P3 — Context Firewall: redaction + minimal-slice (Organ C).** Redaction/rehydration on the
  recall seam; slice budget; policy object; Ledger records redactions + withheld counts.
  *Accept:* outbound slices to a frontier model carry placeholders not raw PII; rehydration is
  lossless; the Ledger shows what was redacted.
- **P4 — Sensitivity routing + provable forget (Organ C + E).** Per-fact local-vs-frontier
  routing; `brain_forget_requests` → real tombstone + injection exclusion + forget receipt.
  *Accept:* a fact tagged sensitive never appears in a frontier egress event; a forgotten fact
  disappears from recall and yields a receipt.
- **P5 — Sovereign export + company posture (Organ F + §6).** Bundle carries user-scope Brain +
  ledger; org-owned policy + org Ledger rollups behind a posture flag. *Accept:* export→fresh
  import round-trips the full spine; an org policy enforced across two agents shows in the Ledger.

---

## 8. Honest limits & risks

- **Harness egress visibility (the load-bearing honesty).** For `marker_protocol` / harness-CLI
  runtimes (Claude Code, Codex, Antigravity), Agentis controls and records **what it injects**
  (`history`/`task`), but the harness then calls the provider in its own process and may add its
  own context (its local files, its own memory) that we do not see. The product must state this
  plainly: the Ledger shows *what Agentis sent*; full-payload guarantees require routing through
  in-process / `mcp_native` adapters where the Firewall sees everything. Never imply total
  visibility we don't have (Doctrine #7).
- **Profound import cost.** Mining tens of thousands of turns is token-expensive; mitigations are
  the budget ceiling, resumable `reclaim_jobs`, deterministic pre-filtering before the LLM pass,
  and a clear cost estimate before the operator commits.
- **Redaction is best-effort, not a guarantee.** Detectors miss novel PII shapes; the honest
  framing is "reduces leakage + makes it auditable," with the local-routing escape hatch for
  truly sensitive facts. Don't oversell it as airtight.
- **Recall-exclusion must be airtight for forget.** A tombstoned atom leaking back through a
  cached embedding or a derived atom would break Doctrine #4 — forget must cascade via provenance
  and be covered by a regression test.
- **Don't regress chat latency.** The Firewall sits on the hot recall path; it must be a thin,
  budgeted pass (mirror `#preflightHealth` discipline, `project_chat_adapter_authoritative`).

---

## 9. Open decisions (for the operator)

1. **Redaction default for individuals** — on (privacy-first, slightly more friction/cost) or off
   until configured (frictionless, less safe by default)? *Recommendation: on for `user`-scope PII
   only.*
2. **Profound mining model** — the building agent's own runtime (zero extra config, variable cost)
   or a dedicated cheap extractor model? *Recommendation: agent's own by default, with an optional
   cheap override — mirrors `structuredCompleter`.*
3. **First silo to support in P1** — ChatGPT export (largest install base) is the assumed default;
   confirm vs Claude export.
4. **Ledger granularity** — record fact *ids* only (lean, privacy-preserving) vs full injected
   text (maximally auditable, heavier, itself sensitive). *Recommendation: ids + hash by default;
   full-text capture as an opt-in compliance mode (company posture).*

---

## 10. Implementation log

> Append per `feedback_masterplan_log`. Keep reconciled with real code.

- 2026-06-29 — Doc created. Grounded in: `harnessImport/` + `harnessMemoryIngestion.ts` (import is
  authored-notes-only, deterministic distill), `AgentAdapter.chat`/`dispatchTask` as the universal
  egress boundary (`adapter.ts:172`), `audit_entries` v105 token sink, `user_notes`/`personalBrain`
  as the global-scope seam, `brain_forget_requests` forget scaffolding, `.agentis` signed bundle as
  the export guarantee. DB at v105. No code changes yet — awaiting phase go-ahead + §9 decisions.
