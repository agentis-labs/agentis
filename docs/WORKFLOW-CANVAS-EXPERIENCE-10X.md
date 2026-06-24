# Workflow Canvas Experience — 10x Plan

> **Shipped 2026-06-02 — ALL EIGHT FRONTS (in two waves):**
> - **F1** fit-to-canvas zoom + shared layered auto-layout (`@agentis/core`
>   `layoutWorkflowGraph`, applied on build + a "Tidy" button).
> - **F2** complete node taxonomy (`nodeKindMeta` — glyph/label/category color rail).
> - **F3** config-specific node explainers + OAuth-first connector form ("Vault
>   secret" → "Advanced: API key" disclosure).
> - **F4** connector catalog with **brand logos** (`connectorLogo`, Simple Icons),
>   ~50 categorized connectors, OAuth-first connect. *(External managed-auth
>   broker — Composio/Nango — remains an adopt-vs-build decision; the catalog +
>   `/v1/oauth` seam is broker-ready.)*
> - **F5** zero-config self-delivery (an "email me" request auto-fills the
>   operator's own address).
> - **F6** one-living-workflow (conversation-latched workflowId — no duplicates).
> - **F7** **real cast materialization**: build commissions a real specialist
>   agent per `agentRole` (`SpecialistAgentService.ensureRole`) and pins it to the
>   node, so the team is real + visible in the workspace; swarm node kinds
>   (`agent_swarm`/`dynamic_swarm`) are cast the same way.
> - **F8** pre-run **cost + time estimates** and a **delivery preview** ("Delivers
>   to: Gmail → you@acme.com") surfaced before the first run. *(A side-effect-free
>   engine dry-run MODE remains a deferred follow-up; per-node Test already gives
>   isolated dry-runs.)*
>
> **Status:** design / north-star. Companion to
> [`WORKFLOW-10X-MASTERPLAN.md`](./WORKFLOW-10X-MASTERPLAN.md),
> [`ORCHESTRATOR-CREATION-10X.md`](./ORCHESTRATOR-CREATION-10X.md),
> [`10X-CREATION-SWARM-PLAN.md`](./10X-CREATION-SWARM-PLAN.md).
>
> The build **engine** now works — with a capable model (gpt-5.5) the synthesized
> graphs are good; structural self-repair (cycles, dangling edges) and
> self-correction keep weak models from emitting garbage. **The engine is no
> longer the bottleneck — the experience around it is.** This doc is about the
> 5 minutes a human spends *reading, trusting, fixing, and shipping* a workflow.

---

## 0. The core realization

A user typed "search AI news and email me," and Agentis produced an
architecturally correct graph. Then the experience asked them to:

- zoom into a canvas they couldn't see all of,
- read nodes with no label saying what they are,
- decode a config form full of words like *"Vault secret"*,
- hand-configure a Gmail OAuth app to email **themselves**,
- notice a duplicate workflow was silently left behind,
- and trust that "specialists" exist when no agent was ever created.

Every one of these is a **trust leak**. The model did the hard part; the chrome
undid it. **A workflow you can't read, you won't run. A connector you can't
connect, you won't keep.** This plan closes the leaks and then pushes past them.

## 1. Design principles (the lens for every decision)

1. **Legibility over density.** If a human can't glance at the canvas and say
   "ah, it fetches, dedupes, and emails me," the layout failed — not the user.
2. **Zero-config defaults, progressive power.** The 80% case ("email *me*")
   must need **zero** setup. Power (custom SMTP, a shared mailbox) is one click
   deeper, never the front door.
3. **Managed auth, never raw secrets.** Users connect accounts by *signing in*,
   not by pasting tokens into a field called "Vault secret." Secrets are an
   escape hatch, not the default.
4. **One intent = one living workflow.** Asking for a change *revises* the
   workflow you're looking at. It never spawns a twin.
5. **Real cast, visible work.** When Agentis says "the researcher specialist
   will fetch this," that specialist must be a real, inspectable thing — with a
   model, tools, and a status — not a role string that secretly runs on the
   orchestrator.
6. **Teach in place.** Every node, field, and empty state explains itself in
   plain language, in context — not in docs the user will never open.

---

## 2. The eight fronts

Each front: **Symptom** (what the user hit) → **Current behavior** (grounded in
code) → **10x target** → **Concrete steps**.

### F1 — Canvas legibility: see the whole thing, always

**Symptom.** Max zoom-out doesn't reveal the full workflow; wide graphs run off
the edges.

**Current behavior.**
- [`WorkflowCanvasPage.tsx:1075`](../apps/web/src/pages/WorkflowCanvasPage.tsx) —
  `fitViewOptions={{ padding: 0.1, minZoom: 0.62, maxZoom: 1 }}`. `fitView`
  refuses to zoom below **0.62**, so a wide horizontal graph literally cannot be
  framed.
- [`CanvasEngine.tsx`](../apps/web/src/components/canvas/CanvasEngine.tsx) never
  sets the ReactFlow `minZoom`, so manual zoom-out is capped at the default 0.5.
- Node X positions come straight from the model, which spreads them far apart;
  there's no tidy pass.

**10x target.** Opening or finishing a build *always* frames the entire graph,
centered, with breathing room — like every diagram tool you trust.

**Concrete steps.**
- Lower the fit floor: `minZoom: 0.2` (or compute from node bounds) and set
  `minZoom={0.15}` on the ReactFlow instance.
- **Auto-layout on build + on demand.** Run a deterministic layout (dagre/elk,
  left-to-right) over AI graphs before persisting, and expose a "Tidy" control.
  This fixes legibility *and* the zoom problem at the source (compact bounds).
  Apply it in the build pipeline (post-`repairGraph`) so the persisted graph is
  already tidy, and on the canvas as a button.
- `fitView` on mount, on `CANVAS_BUILD_COMPLETE`, and on "Tidy."
- Show the **minimap by default** for graphs over ~8 nodes.

### F2 — Node identity: every node says what it is

**Symptom.** A `parallel` node shows its title but no type label; the previous
node had the dark-grey subtitle. Inconsistent.

**Current behavior.**
- [`AgentisNode` — `WorkflowCanvasPage.tsx:2222`](../apps/web/src/pages/WorkflowCanvasPage.tsx)
  renders the subtitle from `data.type`, mapped from `n.type`
  ([:489-490](../apps/web/src/pages/WorkflowCanvasPage.tsx)). When the model sets
  `type:"default"` (kind lives in `config.kind`), the subtitle is wrong/blank.
- [`NODE_GLYPH` in `WorkflowNode.tsx`](../apps/web/src/components/canvas/WorkflowNode.tsx)
  is missing `parallel`, `loop`, `wait`, `http_request`, `integration`,
  `transform`, `filter`, `evaluator`, `workflow_store` → those all fall back to
  the `•` bullet glyph.

**10x target.** Every node, every kind, has a **consistent icon + human label +
category color**. You can read the node taxonomy at a glance.

**Concrete steps.**
- One source of truth: `NODE_KIND_META: Record<kind, { glyph; label; category; color }>`
  in core/shared, covering **all** node kinds. Drive the glyph, the subtitle,
  the palette, and the minimap color from it.
- Subtitle = `META[config.kind].label` (never raw `data.type`).
- **Category color rail** down the left edge of each node: *Trigger / Fetch /
  Think / Transform / Deliver / Control / Knowledge*. The eye groups by color.

### F3 — Node comprehension: user-friendly, not dumbed-down

**Symptom.** "I still find some nodes extremely hard to understand… the form is
too confusing."

**Current behavior.** [`ContextInspector.tsx`](../apps/web/src/components/canvas/ContextInspector.tsx)
renders a per-kind `NodeForm` with terse one-line hints and raw field names. The
synthesis already computes a *why* for each node (`nodeReason`, `castingReason`
in [`build.ts`](../apps/api/src/services/agentisToolHandlers/build.ts)) — but it's
only emitted to the build timeline, never shown on the node or in the inspector.

**10x target.** Selecting a node answers three questions instantly: **What does
this do? What does it need from me? What will it produce?** — in plain language,
with a live data preview.

**Concrete steps.**
- **Node explainer header** in the inspector: a generated, context-specific
  sentence ("Fetches the Hacker News front page so the next step can rank it").
  Persist `nodeReason` on the node config and render it; fall back to a
  per-kind template.
- **Guided fields, not raw fields.** Group into "What it does" (config) and
  "Needs setup" (credentials/recipients). Each field gets an example and a
  plain-language label ("Where should results go?" not "credentialId").
- **Live data preview.** Show the resolved value of templated fields against the
  last run / sample input (the `VariablePicker` + `TemplatedTextField` machinery
  already exists). Seeing `to: you@acme.com` resolved kills most confusion.
- **Per-node Test.** `NodeTestRunner` exists — surface a one-click "Test this
  step" with visible inputs → outputs, so the node explains itself by *doing*.

### F4 — Connectors: a Composio-grade managed integration layer

**Symptom.** "Send me a Gmail" asked for a **Gmail integration**, a **Vault
secret**, and didn't know which address — "I'm almost sure it doesn't connect to
Gmail like that." Look at n8n (OAuth login) / Zapier (9k+ connectors, logos).

**Current behavior.**
- OAuth exists but only for **6 providers** —
  `['google','slack','github','notion','linkedin','twitter_x']`
  ([`oauthService.ts:21`](../apps/api/src/services/oauthService.ts)) — and only
  when the operator has set that provider's client id/secret on the server.
- [`IntegrationForm` (`ContextInspector.tsx:1103`)](../apps/web/src/components/canvas/ContextInspector.tsx)
  shows "Sign in with X" **only if** a configured `provider` matches the slug
  ([:1214](../apps/web/src/components/canvas/ContextInspector.tsx)); otherwise it
  degrades to a bare **"Vault secret → paste secret value"** box ([:1231](../apps/web/src/components/canvas/ContextInspector.tsx)).
  That's the confusing screen.
- The connector registry ([`integrationRegistry.ts`](../apps/api/src/services/integrationRegistry.ts))
  has **no icon/logo field**, a small workspace-seeded set, and `auth.type`
  enum — but no managed-auth broker behind it.

**10x target.** A **connector catalog** that feels like Zapier/Composio: hundreds
of services with **logos**, categories, search; **OAuth-first** ("Sign in with
Google" opens the real consent screen and mints the credential); raw keys only
as an advanced fallback. The phrase "Vault secret" never appears in the default
path.

**Concrete steps.**
- **Adopt a managed-auth broker** (Composio / Nango / Paragon-style) rather than
  hand-rolling every OAuth app. One integration → hundreds of connectors with
  hosted consent + token refresh. This is the highest-leverage move in the whole
  doc — it turns "integrations" from a feature into a platform.
  - Wrap it behind our existing `integration` node + `/v1/oauth` seam so the
    graph contract doesn't change; the broker becomes the credential source.
- **Catalog UX** (mirror the Zapier grid): logo, name, one-line description,
  category, search/filter. Add `iconUrl` to the manifest + a CDN/icon set.
- **Connect = sign in.** Default the IntegrationForm to the OAuth button; demote
  the secret field behind an "Advanced: use an API key" disclosure.
- **"Request a connector"** for the long tail, and a clean "bring your own
  OpenAPI/HTTP" path (we already have `http_request`).

### F5 — Zero-config delivery: "email me" must just work

**Symptom.** To email **themselves**, the user was asked to configure Gmail and
specify a recipient. That's backwards.

**Current behavior.** Delivery is modeled as a generic `integration` node needing
a credential + a `to`. "Email me" and "email the team a report" are treated
identically — both demand setup.

**10x target.** "Email me / notify me" needs **zero** configuration. Agentis
already knows who you are (your verified login email) and where you live
(your chat, your connected Slack/Telegram).

**Concrete steps.**
- A first-class **`notify_me` / built-in delivery** that routes to the signed-in
  user's verified email via a **built-in transactional sender** (or to their
  active channel). Recipient defaults to `auth.me`. No connector, no token.
- Synthesis maps "email me / send me / notify me / DM me" → `notify_me`, and only
  emits a `gmail`/`slack` connector node when the user names an *external*
  recipient. (Today everything becomes a pending Gmail node.)
- Pending external delivery still shows the guided connect flow from F4 — but the
  self-directed case is invisible plumbing.

### F6 — One living workflow: revise, don't duplicate

**Symptom.** Asking for an improvement created a **second** workflow; the first
was left behind.

**Current behavior.** `agentis.build_workflow` *accepts* an optional `workflowId`
to update in place ([`build.ts:132-160`](../apps/api/src/services/agentisToolHandlers/build.ts)),
but the orchestrator doesn't thread the just-built id into the revision call, so
`existingWorkflowId` is null → a fresh `randomUUID()` →  a twin
([`build.ts:283-284`](../apps/api/src/services/agentisToolHandlers/build.ts)).

**10x target.** A build conversation is bound to **one** workflow. "Make it run
hourly" edits *that* graph, with a visible diff and undo. No twins, ever.

**Concrete steps.**
- **Thread the active build id** in the chat/loop session state. After a build,
  remember `workflowId` for the thread; the orchestrator's revision calls pass it
  automatically. Update the `build_workflow` tool description to say so.
- **Server-side safety net:** if no `workflowId` is given but this thread already
  built one and the new description is a refinement (not a clearly new intent),
  *update* the last one and surface "Updated **Morning AI News Digest**" instead
  of creating. Heuristic + explicit "build a *new* workflow" override.
- **Revisions are versions.** Each build of the same id snapshots a version;
  offer a diff ("+2 nodes, delivery changed") and one-click rollback.

### F7 — Real cast & swarms: commission specialists on demand

**Symptom.** "It doesn't create agents or subagents — probably the orchestrator
runs everything himself. What about the agent-creation config we planned —
workers/specialists on demand, swarms?"

**Current behavior.** `agent_task.agentRole` resolves to a **built-in** specialist
(`planner|researcher|coder|reviewer|analyst|writer|monitor|architect|debugger|deployer`
— [`build.ts:1284`](../apps/api/src/services/agentisToolHandlers/build.ts)).
`buildTeamRoster` ([:386](../apps/api/src/services/agentisToolHandlers/build.ts))
announces a cast, but no real workspace agent is commissioned — the role is
effectively an execution profile, not an inspectable teammate.

**10x target.** When a workflow needs a researcher, Agentis **materializes a real
specialist** — its own identity, model, role-scoped tools, status — visible in
the workspace, reusable, and **parallelizable into a swarm** under a `parallel`
node. This is the agent-creation vision in
[`10X-CREATION-SWARM-PLAN.md`](./10X-CREATION-SWARM-PLAN.md) made literal.

**Concrete steps.**
- **Cast materialization.** During build, for each distinct `agentRole`,
  commission an agent (ephemeral or persistent, user's choice) from the
  role-scoped tool manifests already in the repo (commit *"specialist agent
  definitions and role-scoped tool manifests"*). Bind it to the node.
- **Cast panel** on the canvas: who's on the team, their model/tools/online
  status; let the user pin a specific existing agent or accept the auto-cast.
- **Swarms.** `parallel` over N identical specialists (e.g. one researcher per
  source) = a swarm, joined by `merge`. Surface "fan out to N workers" as a
  first-class option for the independent-fetch pattern.
- **Never silently run-on-orchestrator.** If no specialist/model resolves, say so
  (honest-error principle), don't quietly collapse the work onto the orchestrator.

### F8 — Setup & trust: guided, dry-run-first, estimated

**Symptom (latent).** "1 node needs setup" drops you into a raw form; the first
real run could email a stranger before you've seen it.

**10x target.** Setup is a **stepper**, the first run is a **dry run**, and you
see **cost/time** before you commit.

**Concrete steps.**
- **Setup stepper.** "1 node needs setup" → an ordered, focused flow (connect →
  pick recipient → done), not the full inspector.
- **Dry-run-first delivery.** The first run of a delivery workflow previews
  ("This will email **you@acme.com**: *Morning AI News Digest*") and asks to
  confirm before sending for real. Rule 6 (guard delivery) made human.
- **Estimate before run.** Show projected latency + token/credit cost (the run
  panel already shows `421.1s`); add a pre-run estimate.

---

## 3. Beyond the brief — higher-leverage bets

Things not asked for that would move the experience furthest:

- **The connector broker *is* the moat.** F4 isn't a feature, it's positioning.
  "Agentis + a managed connector layer + an orchestrator that builds the graph
  for you" is a category most no-code tools can't touch. Prioritize it as
  strategy, not chrome.
- **Data-flow legibility.** Let users *see the data* moving on edges — hover an
  edge to see the payload shape, click to see the last run's value. Most "I don't
  understand this node" confusion is really "I can't see what flows where."
- **Simulation / sample-data mode.** Run the whole graph against synthetic or
  last-real inputs with no external side effects. Builds trust before the first
  live run and makes nodes self-explanatory by showing real I/O.
- **Explain mode (the "why" layer).** A toggle that overlays each node's
  generated rationale and each edge's purpose — turning the canvas into a
  narrated diagram. We already compute the rationale; we just hide it.
- **First-run "it just works" guarantee.** Measure and protect the path from
  prompt → runnable workflow with **zero** required setup for the self-directed
  case (notify-me, scheduled, no external creds). That number is the product.
- **Naming & semantics pass.** Audit user-facing strings for jargon ("Vault
  secret," "credentialId," "predicate," "fire policy"). Plain language is a
  feature.
- **Templates & "remix."** One good generated workflow → save as a starting
  point; let others remix. The catalog of *workflows* compounds like the catalog
  of *connectors*.
- **Observability of the cast.** When specialists are real (F7), show their
  per-step work, cost, and decisions — the "swarm" becomes legible, not magic.

---

## 4. Sequencing

**Quick wins (days) — ship these first; they're high-trust, low-risk:**

| Win | Files | Effort |
| --- | --- | --- |
| Fit-to-canvas zoom (`minZoom` 0.2 + fit on build/mount) | `WorkflowCanvasPage.tsx:1075`, `CanvasEngine.tsx` | XS |
| Complete node icon+label taxonomy (`NODE_KIND_META`) | `WorkflowNode.tsx`, `WorkflowCanvasPage.tsx:2222` | S |
| Auto-layout (dagre/elk) on build + "Tidy" button | build pipeline, canvas | S–M |
| Thread `workflowId` → no duplicate workflows | chat/loop state, `build.ts:132` | S |
| Node explainer header (surface `nodeReason`) | `ContextInspector.tsx`, `build.ts` | S |
| OAuth-first IntegrationForm (demote "Vault secret") | `ContextInspector.tsx:1211` | S |

**Platform bets (weeks) — the real 10x:**

| Bet | Why it matters |
| --- | --- |
| **F4 managed connector broker** (Composio/Nango) + catalog w/ logos | Turns integrations into a platform; kills the #1 friction |
| **F5 zero-config `notify_me`** delivery | "Email me" needs zero setup — the headline demo |
| **F7 cast materialization + swarms** | Delivers the agent-creation vision; specialists become real |
| **F3 guided forms + data preview + per-node test** | Makes every workflow self-explanatory |
| **F8 dry-run-first + estimates + setup stepper** | Trust before the first live side effect |

---

## 5. The first PR (do now)

A tight, shippable bundle that removes the most visible trust leaks:

1. **Zoom:** `minZoom: 0.2` in `fitViewOptions` + `minZoom={0.15}` on the engine;
   `fitView` on mount and on `CANVAS_BUILD_COMPLETE`.
2. **Node labels:** introduce `NODE_KIND_META` covering every kind; render the
   subtitle from `config.kind`, not `data.type`; complete the glyph set.
3. **No duplicates:** thread the active `workflowId` through the build
   conversation so a revision updates in place.
4. **De-jargon the connector form:** lead with "Sign in with…", move "Vault
   secret" behind an "Advanced" disclosure, and rename it "API key."

Each is independently valuable, low-risk, and directly answers something the user
pointed at.

---

## 6. Open decisions (need a call)

- **Connector broker:** build vs. adopt (Composio / Nango / Paragon)? Adoption is
  faster to hundreds of connectors; building keeps everything in-house. *Strong
  recommendation: adopt, wrap behind our `integration` + `/v1/oauth` seam.*
- **`notify_me` transport:** built-in transactional email (e.g. Resend/SES) vs.
  routing to the user's active chat channel by default? (Could be both: email +
  in-app.)
- **Cast default:** ephemeral specialists (spun up per run, garbage-collected)
  vs. persistent workspace agents the user accumulates? Likely a per-workflow
  toggle, defaulting to ephemeral for one-shots and persistent for recurring.
- **Auto-layout engine:** dagre (light) vs. elk (richer, heavier). Start dagre.

---

## Implementation log — 2026-06-15 · Readability & phase redesign (minimalism + clarity)

User report: an attempt to make node labels readable degenerated the canvas into a
ribbon of detached "phase cards" floating across the top, and node text was still
illegible. Root causes confirmed in code:

- `PhaseLayer.tsx` packed every phase header into one top-left `Panel` row via a
  `nextAvailableX` accumulator → labels detached from their bands into a meaningless ribbon.
- One fit-to-everything zoom (`fitViewOptions.minZoom: 0.2`) + no level-of-detail →
  a wide 13-node/7-phase graph framed at ~0.2, rendering 13px node text at ~3px.

Shipped:

1. **Semantic zoom (level-of-detail)** — `AgentisNode` (`WorkflowCanvasPage.tsx`) reads
   live scale via `useStore((s) => s.transform[2])` and renders three tiers:
   `far` (<0.5) a counter-scaled recognition chip (glyph + name kept legible on screen),
   `mid` (<0.92) the trimmed card, `near` the full detail (capabilities/tool preview).
   This is the actual readability fix — the card no longer shrinks to mush.
2. **Phases dock to their band** — rewrote `PhaseLayer` header placement: each label
   anchors to its own band's top-left (clamped into the viewport), no horizontal packing,
   and hides when the band is too narrow on screen to read (the rail names it instead).
3. **Phase rail** — new `PhaseRail.tsx` + `CanvasLeftRail.tsx`: one left panel, two modes
   (Phases | Nodes) via `SegmentedControl`; opens structure-first when phases exist.
   Numbered phases with rolled-up status + counts; click frames that band at a readable
   zoom (`focusPhase`) and dims the rest. `NodePalette` gained a `bare` mode to embed.
   Shared `derivePhaseStatus` helper exported from `PhaseLayer` (no duplicated health logic).
4. **Readable default framing** — `fitViewOptions.minZoom` 0.2 → 0.55 so the editor lands
   legible; engine `minZoom={0.12}` retained so manual zoom-out still works (now backed by
   the far-LOD chips). `clearPhaseFocus` refits the whole graph.

Verification: `apps/web` `tsc --noEmit` clean; canvas suite green (PhaseLayer + WorkflowCanvas,
8 tests) including a new far-zoom label-suppression test. No live browser pass — the canvas
sits behind auth + seeded multi-phase data.

Deferred: a dedicated zoomed-out "Overview" mode; edge-routing legibility at low zoom.

### Round 2 — 2026-06-15 · Kill the bands, rebuild the node card

User feedback on round 1: the on-canvas phase bands+pills covered the graph and
looked terrible at every zoom ("take this to garbage"). Decision: remove the
on-canvas phase layer entirely and rebuild the node card from scratch.

- **Removed `<PhaseLayer>` from the canvas** (`WorkflowCanvasPage.tsx`). Phases are
  now navigated solely from the left rail; focusing one dims the rest of the graph
  (`node.data.phaseDimmed`). The band/pill overlay is gone. `PhaseLayer.tsx` is kept
  only for its exported `derivePhaseStatus` helper + types used by the rail.
- **New `AgentisNode` card** — clean, minimal, modern:
  - Color now lives in a tinted **icon tile** (`${accent}1f` bg, accent glyph), not a
    garish left rail strip.
  - Title (13px medium) + one subtitle line (kind, or extension operation in mono).
  - **Calm states**: thin colored border + soft glow; the only animated element is a
    small header status pip (`StatusPip`: spinner/check/alert/pause/retry). No more
    full-border `animate-pulse` twitching on idle/pending nodes.
  - Pending-config is a quiet amber footer strip ("Needs setup" → full message at
    near zoom), not a thick pulsing ring.
  - Quieter handles (brighten on hover; error handle fades in on hover).
  - Detail (tool preview, capability/agent-match chips) only renders at near zoom
    (`>1.05`); the default mid card stays clean.
- LOD thresholds retuned: `far <0.45`, `near >1.05`, `mid` between (the hero card).

Verification: `tsc --noEmit` clean; canvas suite green (8 tests).

### Round 3 — 2026-06-15 · Reshape to the user's 6 points

1. **Initial zoom == fit view** — `fitViewOptions` floor removed (`{ padding: 0.16, maxZoom: 1 }`); `clearPhaseFocus` matches. Opening a workflow now frames the whole graph exactly like the fit-view control.
2. **Faded phase bands are back (no pills)** — `PhaseLayer` rewritten as purely decorative, pointer-events-none, zIndex-behind-nodes faded dark-tinted regions with a quiet inline label (number + name + setup count). The floating pill ribbon that covered the graph is gone for good. Bands read the workflow shape at fit-view; navigation stays in the rail.
3. **Monochrome node icons** — `AgentisNode` icon is now a neutral `bg-surface` + `text-text-secondary` glyph matching the node palette; the colored icon tile was removed. Phase color lives only in the band behind the card.
4. **"Phase N ·" prefix stripped** — shared `stripPhasePrefix()` (exported from `PhaseLayer`) applied to node titles, band labels, and rail rows.
5. **Selection toolbar is clickable** — added `nopan nodrag` to `CanvasSelectionToolbar`; previously a pointerdown was captured by the pane first and cleared the selection before the button fired.
6. **Minimal rail** — `PhaseRail` de-childified: dropped the saturated numbered circles for a muted number + a tiny color tick + name + small status glyph; active row gets a thin inset color accent. Monochrome, quiet.

Verification: `tsc --noEmit` clean; canvas suite green (9 tests, incl. new decorative-band + prefix-strip tests).

  - Follow-up: `stripPhasePrefix` also applied in `PhaseInspector` (heading + Nodes list). `focusPhase` now defers the fit and uses `maxZoom: 1.6` so clicking a phase genuinely zooms IN to it rather than holding the whole-graph fit.

### Round 4 — 2026-06-15 · Readability at fit-view (layout + counter-scaling)

Problem: even at fit-view nodes were ~1px tall because `computePhaseAwareLayout`
laid all phases left-to-right → a ~38:1-wide strip → fit zoom ~0.1.

- **Compact vertical-phase layout** — `computePhaseAwareLayout` now stacks phase
  lanes top-to-bottom (within a lane: dependency columns L→R, siblings stacked).
  Bounding box goes from one long strip to near-square, so fit-view lands far
  higher. Node dims retuned to the new card (252×76, tighter gaps). `PhaseLane`
  gained `y`/`height`.
- **Auto-heal on open** — `WorkflowCanvasPage` detects a legacy wide-strip graph
  (aspect > 2.4) once per workflow id and re-flows it to the compact layout +
  persists; idempotent afterwards. Existing workflows fix themselves on open.
- **Per-phase bands** — `PhaseLayer` now derives each band's vertical extent from
  its own members (lanes stack), instead of one shared global height.
- **Counter-scaled labels** — node titles and band labels scale toward a constant
  on-screen size below ~0.7 zoom (capped ~24px); node title wraps to 2 lines and
  drops its subtitle when zoomed out. Titles stay legible at fit-view.

Verification: core 20/20, API layout/phase 7/7, web canvas 10/10; `tsc` clean in
core + web. Test updated: vertical lanes mean the unassigned lane sits *below* the
work lane (`M.y > B.y`) rather than to its right.

### Round 5 — 2026-06-15 · Back to left-to-right flow

User preferred the original left-to-right reading direction over the Round 4
vertical stack. Reverted `computePhaseAwareLayout` to LEFT-TO-RIGHT lanes (phase 1,
then phase 2 to its right). Kept everything else from Round 4 (retuned node dims,
per-phase bands, counter-scaled labels, click-to-zoom). Auto-heal flipped: it now
re-flows any non-canonical (tall/near-square) saved graph back to the wide
left-to-right layout once, then stays put. Core/API/web tests green; the lane test
asserts `M.x > B.x` again.

Tradeoff noted: a wide left-to-right graph frames small at full fit-view. Reading
is via click-to-zoom on a phase (works well) — if readable-at-fit is also wanted,
the lever is stacking nodes vertically *within* each phase to narrow the strip.

### Round 5.1 — 2026-06-15 · Remove auto-relayout (it broke autosave)

The Round 4/5 "normalize layout on open" effect mutated the graph and fired a save
at mount, racing hydration → `Auto-save failed: VALIDATION_FAILED`. Removed it
entirely. The left-to-right layout still applies via the **Tidy** button and new
builds; opening a workflow no longer triggers any save. Existing graphs saved in
the old orientation are re-flowed by clicking Tidy once (a normal, validated save).
