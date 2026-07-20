# BRAIN-FORMATION-TRUTH-10X

**Status:** P0 shipped, P1 partial, P2 open. 2026-07-20.
**Trigger:** "the learnings and etc are not appearing as nodes on brain canvas all over (apps and others)."

Companion to [BRAIN-MEMORY-FORMATION-10X](./BRAIN-MEMORY-FORMATION-10X.md) and
[BRAIN-SCALE-10X](./BRAIN-SCALE-10X.md). Those two built the formation pipeline
and the lifecycle machinery. This one is about a different question: **why, with
both of those working as designed, does an operator's canvas stay empty?**

---

## 0. The finding that reframed everything

The 2026-07-14 fix (`commitDurableAtom` + `AppLearningService.onRunSettled`) and
the 2026-06-24 fix (`brainMaintenance.start()` wiring) are **intact and
correctly wired** on `main`. `appBrain` is genuinely injected; scope resolution
(`appId ?? workflowId`) is correct; the web `ScopedBrainMap` does live-subscribe.
There is no broken plumbing.

The canvas is empty for **architectural** reasons. An audit of the whole path
found **84 gates** between "knowledge exists" and "node renders", **40 of which
drop silently** — no log, no event, no user-visible signal — and roughly **90%
of which are English-only regex**.

### The five diseases

1. **A threshold decides what only a judgement can decide.** `EMBED_HIGH_SIMILARITY = 0.88`
   gated all five durable write paths: `score >= 0.88 → reinforce the old atom,
   discard the new text`.
2. **Regex deciding semantic questions.** `scoreStatement` has base 0.35 against
   a 0.5 floor, so **no English cue = mathematically cannot form a memory**.
   Task-command rejection was double-gated with near-identical regexes, so
   fixing one changed nothing. Two gates actively contradicted each other:
   `extractAgentLearningSignal` *required* the phrase "root cause" to capture a
   lesson, while `hygieneVerdict` *penalised* it +2 and auto-archived at 4.
3. **Silence by default.** 40 silent drop sites; 2 instrumented. Chat reported
   "Storing N memories" by counting items *enqueued*, before a judge prompted
   with *"most candidates should be dropped"* ran — and never corrected itself.
4. **Staging was conflated with visibility.** Everything the no-model mining
   path writes is tagged `unconsolidated`, and `loadAtoms` filtered that tag out.
   Without a Formation Judge model, an empty canvas was the *designed* outcome.
5. **Recency windows, not the brain.** Retrieval scored against the **125
   most-recently-updated episodes**; dedup against 500. A rule stated four
   months ago was unreachable at any similarity score — and the judge's
   ADD/UPDATE context came from the same window, so it could not see the atom it
   should have been updating.

Multilingual made all five worse. `dedupeCandidates` keyed on `[^a-z0-9]` and
dropped empty keys, so Cyrillic/Greek/Arabic/CJK statements were **deleted
before any gate examined them**. Portuguese survived mangled
(`"configuração"` → `"configura o"`). `directivePolarity` was English-only, so a
Portuguese correction was swallowed as a reinforcement of the rule it
contradicted.

---

## 1. Measurement (the part that changed the plan)

Weights were located at `%TEMP%/agentis-clean-machine-probe-*/models` (465 MB)
and measured directly, replicating `LocalEmbeddingProvider.embed` exactly
(`query:` prefix, mean-pool, normalize). Cold load 3.3 s; **warm embed 21 ms**.

> Import `dist/transformers.node.mjs`, not `dist/transformers.js` — the latter is
> the web build and fetches local paths, failing with `TypeError: fetch failed`.

### 1.1 Cosine distribution

| band | min | mean | max |
|---|---|---|---|
| unrelated | 0.7627 | 0.7831 | 0.8004 |
| **true duplicates** | 0.9209 | 0.9597 | 0.9739 |
| near-miss (same topic, different rule) | 0.8921 | 0.9381 | 0.9688 |
| **contradictions** | 0.9347 | 0.9558 | **0.9763** |
| cross-language equivalence | 0.8386 | 0.9155 | 0.9506 |

**A contradiction is the most similar thing to the rule it overturns.**
`"sempre faça deploy na sexta"` ~ `"nunca faça deploy na sexta"` = **0.9763**,
the highest pair in the set, above every true duplicate. The non-duplicate
ceiling sits **above** the duplicate floor → overlap 0.055 → **no global cosine
threshold can separate them.**

⇒ Recalibrating `EMBED_HIGH_SIMILARITY` was never a fix. At 0.88 it fired
hardest on the writes that mattered most.

### 1.2 Can e5 classify intent? No.

27-case multilingual set, 6 classes (rule/preference/fact/lesson/task/noise):

| descriptors | accuracy |
|---|---|
| keyword-soup (current `PROTOTYPE_DESCRIPTORS` style) | **63.0%** |
| natural-sentence (the "better" rewrite) | **44.4%** |
| **REMEMBER-vs-DROP (the decision that matters)** | **48.1%** |

Worse than a coin flip. It called `"thanks, that works"` a rule and
`"The root cause was a stale cache entry"` a task. Mean argmax margin 0.010–0.024.

**Cause is structural: e5 encodes TOPIC, not SPEECH ACT.** Everything about
deploying lands in one cone whether it is a standing rule, a one-off command, or
chatter. Not a descriptor-tuning problem. **Do not retry with better prompts.**

> The prototype classifier's pre-existing green tests use a lexical
> bag-of-words stub whose input shares literal tokens with the descriptor. It had
> never met a real vector.

### 1.3 Conclusion

**e5 serves RECALL and nothing else.** It is genuinely good at it (0.76–0.80
unrelated vs 0.92+ duplicate; strong cross-language matching). Every semantic
DECISION needs an LLM or a human.

⇒ **The on-device tier must stop deciding and start preserving.** The brain was
not empty because classification is hard; it was empty because the system
resolved every uncertainty by deleting.

---

## 2. What shipped

### P0 — grounded in the measurement

- **`resolveDuplicate`** (`util/brainDedup.ts`) replaces threshold-merging at all
  five write paths. Cosine now only *nominates* a candidate above
  `DEDUP_CANDIDATE_FLOOR = 0.90`; the verdict is `distinct` | `duplicate`
  (provably identical after Unicode segmentation) | `contested`. **Only a
  provable duplicate merges.** Contested pairs are written *and* flagged through
  the existing `flagDispute` machinery — never silently reconciled.
- **Multilingual `directivePolarity`** — EN/PT/ES/FR/IT/DE/RU/CJK, with
  Unicode-safe boundaries (JS `\b` is ASCII-only, so a naive port matches nothing
  in Cyrillic, or matches inside words — "не" inside "неделя"). Polarity is
  checked *before* any merge; it is the only signal that separates a correction
  from a duplicate.
- **One tokenizer.** `brainText.segment()` is now the single segmentation
  primitive; the four ASCII tokenizers delegate to it while keeping their own
  length/stop-word policy. `dedupeCandidates` no longer deletes unsegmentable
  text. Measured: `"部署前请务必备份"` `[]` → 8 tokens; `"Никогда не деплой в пятницу"`
  `[]` → 3; `"configuração"` no longer shatters. ASCII output byte-identical.
- **Windows widened** — `RETRIEVAL_CANDIDATE_CAP = 2000` for both the retrieval
  pool and the dedup pool (was 125 and 500 by recency).
- **Polarity helpers relocated** to `brain/brainText.ts` (pure primitives, needed
  by formation and dedup); re-exported from `memoryReflectionService` so existing
  importers are unaffected.

### P1 — partial

- **Staging no longer means invisible.** `BrainGraphOptions.includeStaged`; the
  graph opts in, recall deliberately does not. Staged atoms keep their TTL and
  their `unconsolidated` tag. The web UI already had a
  "Staged (decays unless reused)" badge that the API could never trigger — it now
  lights up.
- **Standing modality is productive, not enumerated** — `every|each|any <noun>`
  instead of a closed phrase list, plus the other shipped languages. This is what
  broke `"Configure retries to 3 every deploy"`.
- **Language-independent directive boost** in `scoreStatement`: a statement with
  directive polarity earns the standing a matched English cue does, so a
  Portuguese or Chinese rule can clear the threshold without an English cue and
  without a classifier.

### P3 — the tier

`memoryFormationTier` ∈ `off | on_device | model_assisted`, stored as a key in
the shared `brainSettings` blob (spread-merged), surfaced as a minimal card in
**Settings → Runtimes** beside the model-assist switch. Resolved **fresh per
call** inside `SharedIntelligence` — deliberately not injected at bootstrap, so
it can never degrade into a silent restart requirement. Defaults from
`modelAssistedRuntimeEnabled` so existing workspaces keep their behaviour.

The tier is honest about the trade-off the measurement forced:
*on-device = keep generously, prune later; model-assisted = the judge decides.*

### Instrumentation

`embedText` is the single chokepoint for every brain embedding, so the meter
lives there: ring buffer + cumulative counters, surfaced as
`intelligence.embedLatency` on the brain-health snapshot (count, mean, p50, p95,
max, slow count, error count). The **first** embed is attributed to `coldStartMs`
separately so the model load never skews the percentiles.

Deliberately **not** logged per embed — a previous shipped regression flooded
logs with per-row embedding errors every 1–2 s, so this reports on demand rather
than on every write.

### Tests

`tests/brain/brainDedupCalibration.test.ts` encodes the measured bands as
assertions, so any future "score >= X → merge" rule fails CI. Plus 4 route tests
for the tier (including sibling-key preservation) and updated
`brainFormationPipeline` expectations — those had encoded the bug.

**Verified:** api + web typecheck clean; 13 brain suites / 121 tests green;
orchestrator routes 10/10; boundary lint 0 violations; API boots.

---

## 2b. Channel identity (§B6) — a live hole, found while answering a feature question

The question was "do we learn from channels?" The answer was **yes, and as the
operator.**

Channel ingress stamps every turn with the CONNECTION OWNER's account id
(`channelBridge.ts:807`, `channelConnectionSupervisor.ts:368` both pass
`userId: row.userId`), so `userId` could not distinguish the operator from a
stranger. `channelTurnDispatcher` *resolved* the real answer at `:390`
(`access.isOwner`) and **discarded it** before capture. Every channel turn was
therefore labelled `operator_chat` — the one authoritative surface — written at
`scopeId: null`, and run through `captureImmediateCorrection`, which writes
`kind:'rule'`, `source:'operator'`, trust **0.98** → `governing: true` →
injected into every agent, every dispatch, permanently.

**Anyone who could message a connected WhatsApp/Telegram/Slack could author
workspace constitution.** The payload only had to match the correction regex —
and "from now on" is phrasing a customer uses naturally, while
`STANDING_MODALITY` explicitly *rescues* such text from the task-command filter.

Fixed:
- **`senderTrust: 'owner' | 'external'`** on `CaptureChatTurnArgs`, defaulting to
  `owner` so the authenticated web path is unchanged. The dispatcher now passes
  `access.isOwner` — the value it already had.
- `captureImmediateCorrection` **returns null for external senders**: a governing
  rule is the highest-authority write in the system and only the operator makes one.
- External turns get `originSurface: 'external_contact'` (new) and are scoped to
  the counterparty (`contact:<kind>:<handle>`), **never `scopeId: null`** — so one
  customer's words also cannot surface inside another customer's conversation.
- Peer profiling attributes the **speaker**, not the connection owner. Previously
  every customer's words were filed into the operator's own profile and the
  reflection engine compounded strangers' statements into inferred traits.

### Reading ≠ believing (§B6.1) — and this is the feature, not just the fix

Containment alone broke the thing it was protecting: with the surface no longer
`operator_chat`, `promote()` mined only the agent's own reply, so **an external
conversation formed no memory at all** — caught by a test that asserted a customer
statement produced *something*.

The two decisions were one flag. They are now separate: `minesInboundText`
decides what is **read** (an external contact is worth learning from — their
questions, constraints and objections are the entire point of a support channel),
while `operatorChat` alone decides what is **believed**. External statements flow
to the staging path, decay unless reinforced, and stay in the counterparty's
scope. `external_contact` carries an `evidence` PACER prior — the opposite of
`operator_chat`'s `procedural`.

Also fixed: `agent_chat_learning` was being emitted but was **not a member of
`SourceSurface`** — it type-checked only because the queue widens the field to
`string` and casts back, so it silently missed its PACER prior.

### PII (§B6.2)

`scrubForMemory` did not exist — grep returned zero hits despite an internal note
claiming it shipped. `looksSensitive` was a binary **drop** (3 regexes: email, 6
API-key prefixes, US SSN), so customer phone numbers, addresses and card numbers
stored verbatim. Added `redactForMemory`: redacts card/IBAN/SSN/CPF/CNPJ/email/
token/phone/address and **keeps the sentence**, because for an external contact
the statement is the thing worth learning and only the identifiers are hazardous.
Applied on the external path only.

> Card detection matches 4-digit grouping rather than "13–19 digits in a row" —
> the naive version swallowed international phone numbers (`+55 11 98765 4321`
> is 13 digits) and mislabelled them as cards.

## 3. Open

- **P2 — observability (seam shipped, coverage partial).** `MemoryDropLog`
  generalises `feynmanReflection`'s quality-event pattern: a typed `gate`, the
  dropped text, and a reason, stored as `memory_dropped` rows and summarised as
  `formation.dropsByGate` on brain health. Sampled (25 per gate) so a busy
  channel cannot flood, never persists text dropped for looking sensitive, and
  never throws into the path it observes. **Wired at the two highest-traffic
  sites so far** (tier-off, and "nothing cleared extraction"); the remaining ~38
  gates still drop silently and should adopt `#drops?.record(...)` as they are
  touched. Still open: the "Storing N memories" claim is made before the judge
  runs, and `brainQualityEvents` are hard-deleted at 120 days while being the
  only forensic trail — now more costly, since drops live there too.
- ~~P1 remainder~~ **closed 2026-07-20 (second pass):** the `hygieneVerdict`
  "root cause" self-contradiction is fixed (the phrase capture REQUIRES is no
  longer penalised by hygiene) and its word count is Unicode-aware (CJK text no
  longer auto-scores as a fragment); `extractAgentLearningSignal` now recognises
  PT/ES learning shapes ("causa raiz", "descobri que", "la solución fue", …).
  **Deliberate non-change:** `FORMATION_MIN_SCORE` remains a veto for RUN OUTPUT.
  Full keep-generously inversion there would stage every non-rejectable sentence
  an agent emits — with no judge, that floods the canvas with exactly the noise
  the operator asked to avoid ("we need a clean brain"). Operator text already
  has no score veto, and directive polarity now clears the bar in any language;
  run output keeps the quality bar and relies on the judge tier for recall.
- **Dispute resolution must actually converge.** Contested pairs are now
  preserved and flagged; the guarantee that they get *resolved* (judge when
  available, reflection, or operator) is what keeps "keep generously" from
  becoming a junk heap. Not yet closed.
- ~~`#applyEmbedding` never clears `needsReembed`~~ **fixed 2026-07-20:** it now
  stamps the full embedding identity (model + dims) and clears the flag. The bug
  was worse than double cost — the unstamped inline vector failed
  `vectorIsComparable`, so it was DEAD to scoring until the sweep re-embedded it.
- ~~"Storing N memories" lie~~ **fixed:** the chat activity now says
  "Reviewing N memory candidates" with an honest description of the judge.
- **No backfill.** Historical atoms keep whatever the old gates did to them.

---

## Implementation log

- **2026-07-20** — Audit (84 gates). Real-model calibration: cosine bands + the
  duplicate/contradiction overlap; prototype-argmax refuted at 48.1% on
  remember-vs-drop. P0 shipped (resolveDuplicate, multilingual polarity, one
  tokenizer, widened windows). P1 partial (staged atoms render, productive
  standing modality, polarity boost). P3 shipped (tier + settings card + routes).
  P2 not started. Typecheck + 131 tests green.
- **2026-07-20 (follow-up)** — Embed-latency instrumentation added at `embedText`
  with cold-start separated from steady state; surfaced on brain health; 5 tests.
  Docs site: new page `the-brain/what-the-brain-remembers` covering the
  duplicate-vs-contradiction measurement, what the on-device model can and
  cannot do, the tier, staged-but-visible memory, and multilingual formation
  (136 pages build, 0 broken links).
