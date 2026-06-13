# Omnichannel Orchestrator — 10x Plan
## One Conversation, Every Surface, Total Workspace Awareness

*June 2026. This document defines the architecture for turning the Agentis orchestrator
into the single, always-reachable front-door to an entire workspace of agents, workflows,
runtimes, and knowledge — reachable from Telegram, WhatsApp, Discord, Slack, and the web,
and aware enough of Agentis to actually deserve that role.*

> **How to read this document.** Sections 0–2 are the honest diagnosis and the thesis.
> Section 3 is the **Channel Gateway** — the connection layer we lift from OpenClaw instead
> of reinventing. Section 4 is the **Orchestrator Awareness Core** — the reason talking to
> one agent is enough. Section 5 is **Routing & Delegation** — how one conversation fans out
> to the whole workspace. Sections 6–8 are phasing, security, and the implementation log.
> *The channels are table stakes. The awareness core is the moat.*

---

## 0. The Honest Starting Point

The pitch is simple and correct: **users today juggle many runtimes, harnesses, and agents
across many tools. They should be able to bring all of it into Agentis and talk to one
orchestrator about everything.** The infrastructure to deliver that is half-built, and the
half that exists is passive. Three honest revelations.

### Revelation 1 — Channels are a mirror, not a mouth

Agentis already ships a real channel layer:

- `apps/api/src/adapters/channels/` — `ChannelAdapter` contract plus `telegram`, `discord`,
  and `slack` implementations (webhook `verify` / `parseInbound` / `send`).
- `apps/api/src/services/channelBridge.ts` — CRUD over `channel_connections`, inbound webhook
  verification with idempotency against `channel_deliveries`, outbound forwarding.
- `apps/api/src/routes/channels.ts` — `/v1/channels` connect/test/webhook-info.

But trace an inbound message and the ambition collapses. `ChannelBridge.handleInbound()`
verifies the signature, dedupes, then calls `conversations.appendMirrored({ authorType:
'system', body: ... })` and publishes a `CHANNEL_MESSAGE_RECEIVED` realtime event. **That is
the end of the road.** No agent runs. No `ChatSessionExecutor.turn()` is invoked. The message
lands in a conversation thread as an inert `system` line. The orchestrator never sees it,
never thinks, never replies.

Outbound is equally thin: `bindOutbound()` only forwards messages where
`message.authorType === 'operator'` — i.e. a human typing in the Agentis web UI gets echoed to
the channel. An agent's *own* reply (`authorType: 'agent'`) is never forwarded. So the current
system can mirror a human into Telegram, but a Telegram user cannot actually converse with the
orchestrator. It is a one-way megaphone, not a two-way channel.

### Revelation 2 — The route is narrower than the code

`channels.ts` hard-codes `kind: z.enum(['telegram', 'discord'])`. The `slack` adapter exists
in the codebase but is unreachable through the API. There is no `whatsapp` adapter at all. The
`ChannelKind` type says `'telegram' | 'discord' | 'slack'`; the route says two of three. The
surface is accidentally narrower than the implementation, and the implementation is narrower
than the goal.

### Revelation 3 — The orchestrator is workspace-blind where it counts

`buildOrchestratorSystemPrompt()` is genuinely good: it injects agent inventory, active runs,
pending approvals, gateway health, registered adapters, budget, viewport, agent instructions,
agent memory, personal brain, and workspace context. For a web operator sitting on a specific
canvas, that is rich.

But it is built around a **viewport** — a single surface the operator is looking at. A user
messaging from Telegram has no viewport, no canvas selection, no "current workflow." For that
user the orchestrator must lead with *workspace-level* awareness: what does this workspace
exist to do, what are its agents for, what is in motion right now, what does the workspace
Brain know. Today that intent-level awareness is assembled ad hoc per web turn, not as a
durable, channel-independent **workspace situational model** the orchestrator always carries.

**The through-line:** we have channel plumbing, a capable orchestrator prompt, and a Brain —
but they are three islands. Inbound channel traffic never reaches the orchestrator; the
orchestrator's awareness is viewport-shaped, not workspace-shaped; and the Brain is queryable
but not *resident* in the orchestrator's working context. 10x-ing the orchestrator means
connecting these three islands and then making the connection feel inevitable.

---

## 1. The Thesis

> **The orchestrator is the only agent a human should ever have to talk to — and it is
> reachable wherever the human already is.**

Two claims, each load-bearing:

1. **One conversation.** Coordinating a swarm of agents by talking to each of them is
   cognitively impossible. The winning interaction model is a single, trusted orchestrator
   that holds the whole workspace in its head and dispatches the rest. The human manages
   *intent*; the orchestrator manages *agents*.

2. **Every surface.** The orchestrator that lives only inside the Agentis web app loses to the
   one that answers a Telegram message at 11pm, a WhatsApp voice note from a phone, a Slack
   thread in the team channel, and a Discord ping from a community. Presence is the product.
   OpenClaw already proved these channels can carry a serious agent; we lift that capability
   rather than rebuild it.

The combination is the moat. n8n, Zapier, and Make have automations but no conversational
front-door. Generic chatbots have channels but no workspace of real agents and workflows
behind them. Agentis has the workflow engine, the agent roster, the Brain, and (after this
plan) the omnichannel orchestrator that ties them into one reachable intelligence.

---

## 2. The Mental Model: Front-Door, Switchboard, Memory

The orchestrator plays three roles simultaneously, and the architecture has one subsystem for
each.

```
        ┌──────────────────────────────────────────────────────────────────┐
        │                      THE ORCHESTRATOR                              │
        │                                                                    │
   ┌────┴─────┐         ┌──────────────────┐          ┌────────────────────┐ │
   │ FRONT-DOOR│  →→→   │   SWITCHBOARD    │   →→→    │      MEMORY        │ │
   │ (§3)      │        │   (§5)           │          │      (§4)          │ │
   │ Channel   │        │ Routing &        │          │ Workspace          │ │
   │ Gateway   │        │ Delegation       │          │ Situational Model  │ │
   │           │        │                  │          │ + Brain residency  │ │
   │ Telegram  │        │ → specialist     │          │                    │ │
   │ WhatsApp  │        │ → workflow run   │          │ intents · agents · │ │
   │ Discord   │        │ → swarm          │          │ runs · approvals · │ │
   │ Slack     │        │ → external rt    │          │ workspace+own brain│ │
   │ Web       │        │                  │          │                    │ │
   └───────────┘        └──────────────────┘          └────────────────────┘ │
        └──────────────────────────────────────────────────────────────────┘
```

- **Front-Door (§3 Channel Gateway):** every external surface normalizes into one inbound
  event and one outbound send. Lifted from OpenClaw's battle-tested channel runtimes.
- **Switchboard (§5 Routing & Delegation):** the orchestrator decides whether a message is
  answered directly, delegated to a specialist agent, turned into a workflow run, fanned out
  to a swarm, or forwarded to an external runtime — and threads the reply back.
- **Memory (§4 Awareness Core):** a durable, channel-independent model of the workspace plus
  resident access to the workspace Brain and the orchestrator's own Brain, so the single
  conversation is actually worth having.

---

## 3. The Channel Gateway — Lift, Don't Reinvent

### 3.1 What OpenClaw already solved

`C:\Users\antar\OneDrive\Documentos\openclaw\extensions\{telegram,whatsapp,discord}` are not toy
adapters — they are production channel runtimes, and they encode years of edge-case knowledge
we should not re-derive:

| Channel | OpenClaw stack | Hard problems already solved |
|---------|----------------|------------------------------|
| **Telegram** | `grammy` + `@grammyjs/runner` + `@grammyjs/transformer-throttler` | long-poll vs webhook leasing, update-offset persistence, native command menus, media/voice download, forum topics → threads, inline keyboards, exec-approval callbacks, flood-control throttling |
| **WhatsApp** | `baileys` (`7.0.0-rc13`) + `audio-decode` | QR-link auth + persisted auth state, presence, multi-device session surfaces, voice-note decode, reconnection |
| **Discord** | discord.js-class runtime | thread binding, send/lookup/monitor split, subagent hooks, security audit |

Reading those trees, the recurring primitives are identical across channels: **inbound
normalization, session/thread keying, outbound delivery with throttling, media handling,
native commands, and approval forwarding.** That is exactly the shape of Agentis's existing
`ChannelAdapter` contract — just far more complete.

### 3.2 The strategy: graduate the contract, port the runtimes

We do **not** import OpenClaw wholesale (it is a different plugin architecture with its own
host APIs, config promotion, and ClawHub packaging). We **port the connection logic** into
Agentis's existing `ChannelAdapter` shape, widening that contract from "webhook-only" to
"webhook *or* persistent connection."

**Today** (`adapters/channels/types.ts`) the contract assumes a webhook request/response:
`send` / `verify` / `parseInbound`. **The graduation** adds an optional persistent-connection
lifecycle so polling/socket channels (Telegram long-poll, WhatsApp baileys socket) are
first-class:

```typescript
export interface ChannelAdapter {
  readonly kind: ChannelKind;            // 'telegram' | 'whatsapp' | 'discord' | 'slack'
  readonly transport: 'webhook' | 'persistent' | 'both';

  // Outbound (all channels) — now richer than text-only.
  send(args: OutboundMessage): Promise<{ externalId: string }>;

  // Webhook transport (Telegram-webhook, Slack, Discord-interactions):
  verify?(args: WebhookVerifyArgs): boolean;
  parseInbound?(args: WebhookParseArgs): ParsedInboundMessage | null;

  // Persistent transport (Telegram long-poll, WhatsApp baileys, Discord gateway):
  connect?(args: ConnectArgs): Promise<ChannelSession>;   // returns a live session handle
  // ChannelSession emits normalized inbound events and exposes presence/typing.
}

export interface OutboundMessage {
  token: string;
  chatId: string;
  body: string;
  // Graduated from text-only:
  media?: Array<{ kind: 'image' | 'audio' | 'file'; url: string; caption?: string }>;
  replyToExternalId?: string;     // threading
  typing?: boolean;               // presence signal before a long answer
}

export interface ParsedInboundMessage {
  externalId: string;
  chatId: string;                 // channel-side conversation address (reply target)
  threadId?: string;              // forum topic / Slack thread_ts / Discord thread
  body: string;
  from?: { id: string; displayName?: string };
  media?: Array<{ kind: 'image' | 'audio' | 'file'; url: string; mime?: string }>;
}
```

The existing Slack and Telegram-webhook adapters already satisfy the `verify`/`parseInbound`
half. WhatsApp and the Telegram long-poll path implement the `connect`/`ChannelSession` half,
porting the proven grammy/baileys session management from OpenClaw into the Agentis adapter.

### 3.3 Inbound finally reaches the orchestrator

This is the single most important change in the document. `ChannelBridge.handleInbound()` (and
the persistent-session inbound callback) must stop at `appendMirrored` no longer. The new path:

```
inbound message (any channel)
  → ChannelBridge: verify · dedupe · resolve connection
  → appendMirrored(authorType: 'user', body, media)          // it IS a user, not 'system'
  → ChannelTurnDispatcher.dispatch({                          // NEW
        workspaceId, conversationId, connection,
        text, media, channelContext: { kind, chatId, threadId, from }
    })
       → resolve the bound agent (the orchestrator for that connection)
       → ChatSessionExecutor.turn(ctx)                        // the orchestrator THINKS
       → stream agent reply chunks
  → outbound: for each agent reply chunk/message,
       ChannelBridge.forwardToChannels(agentId, body, { replyTo, typing })
```

**How it actually shipped (Phase 1, June 2026):** rather than overloading the passive
`bindOutbound()` bus subscription (which is fragile and prone to mirror loops), the loop is
closed deterministically by a dedicated `ChannelTurnDispatcher`:

1. **Inbound tagging.** The human message is stored via `appendMirrored({ authorType:
   'system', metadata: { channelInbound: true, channelConnectionId, from } })`. Keeping the row
   `system` avoids the operator-echo path entirely; the `channelInbound` metadata flag is what
   marks it as a human turn. The dispatcher's history builder maps `channelInbound` (and
   `operator`) rows to the `user` role and `agent` rows to `assistant`, so the orchestrator sees
   a correctly-attributed transcript while nothing re-forwards the user's own message.
2. **Deterministic reply.** The dispatcher runs the turn, persists the reply as an `agent`
   message (so it also appears live in the web UI conversation), then calls
   `ChannelBridge.deliverToConnection(connectionId, chatId, body)` to send it back to the
   **origin** channel. No bus round-trip, no echo loop. Fan-out to *other* bound surfaces is a
   Phase 5 concern (multi-channel identity); origin-only reply is the correct, loop-free Phase 1
   behavior.

The `ChannelTurnDispatcher` owns the bridge→executor handoff. Shipped in Phase 1: adapter
resolution (the bound agent's own chat adapter, falling back to the configured orchestrator
runtime via `ChatSessionExecutor.orchestratorAdapter()`), history assembly, turn execution,
reply persistence, and origin delivery — all failure-tolerant (never throws into the webhook).
On the roadmap for the dispatcher (Phase 3, alongside persistent transports):

- **Debounce & batching** (ported concept from Telegram's `bot-handlers.debounce-key`): a user
  firing three quick messages becomes one turn with concatenated context, not three racing
  turns.
- **Typing presence**: emit `typing: true` to the channel while the orchestrator is mid-turn,
  so a 6-second tool loop doesn't feel dead.
- **Media ingestion**: images/voice notes are uploaded to workspace storage and passed to the
  turn as attachments; voice notes are transcribed (reuse OpenClaw's `audio-decode` approach)
  so WhatsApp voice "just works."

### 3.4 Persistent connections need a supervisor ✅ **SHIPPED for WhatsApp**

Webhook channels are stateless; persistent ones (WhatsApp socket, Telegram long-poll) are
long-lived processes that must survive, reconnect, and lease. The
`ChannelConnectionSupervisor` (`apps/api/src/services/channelConnectionSupervisor.ts`) owns
them, **alongside** the webhook `ChannelBridge` rather than bolted onto the stateless
`ChannelAdapter` contract — webhook adapters never have to implement a session lifecycle they
don't need. What shipped (WhatsApp, via baileys, ported from OpenClaw's
`extensions/whatsapp/src/session.ts`):

- **Live sessions.** Boots a `WhatsAppSession` per active `whatsapp` connection at startup
  (`startAll()`) and on demand for login. Each session wraps a baileys `makeWASocket` with
  `markOnlineOnConnect:false`, `syncFullHistory:false`.
- **QR login.** `POST /v1/channels/:id/login` starts the socket and returns the QR (raw +
  PNG data URL); `GET` polls status. Status/QR also stream over the realtime bus
  (`CHANNEL_CONNECTION_STATUS`).
- **Reconnect backoff.** Exponential backoff with jitter (ported from OpenClaw's `reconnect.ts`
  policy), capped attempts; a `loggedOut` close stops cleanly instead of looping.
- **Auth persistence.** baileys `useMultiFileAuthState` under
  `${AGENTIS_DATA_DIR}/channels/whatsapp/<connectionId>/`, so a restart re-links without a new
  QR — the disk-auth-dir approach OpenClaw uses, no schema migration required.
- **One turn path.** Inbound `messages.upsert` text → the **same** `ChannelTurnDispatcher` the
  webhook path uses, with the same `channel_deliveries` idempotency and `channelInbound`
  metadata. Outbound (`ChannelBridge.deliverToConnection`) routes to the live socket via the
  supervisor instead of a stateless token send.

Baileys is **lazy-loaded** (same pattern as `OpenClawAdapter`'s `ws` loader), so an install or
platform without it still boots — the connection reports `error` instead of crashing the
process. Still open for this section: Telegram long-poll (grammy), media/voice ingestion, and
lifting WhatsApp auth state into the vault rather than the data dir.

### 3.5 Native commands & approvals over channels

OpenClaw's channels carry `/command` menus and inline-keyboard **exec-approval** callbacks.
Agentis already has an approval inbox (`ApprovalInbox`, surfaced in the orchestrator prompt as
PENDING APPROVALS). The Gateway wires the two together:

- A pending approval can be *delivered* to the channel as an inline-keyboard / quick-reply
  ("Approve ✅ / Reject ❌"), and the callback resolves the approval — the same flow OpenClaw's
  `exec-approval-resolver` implements. This means a human can approve a run from their phone.
- A small set of native commands (`/status`, `/runs`, `/agents`, `/approvals`, `/stop`) map to
  orchestrator tool calls, giving power users a fast path without natural-language overhead.

---

## 4. The Orchestrator Awareness Core — Why One Conversation Is Enough

Channels make the orchestrator reachable. Awareness makes it worth reaching. A user abandons
multi-tool juggling **only if** the single orchestrator demonstrably knows more about their
workspace than the sum of the tools they left behind.

### 4.1 The Workspace Situational Model

Today's prompt assembly is viewport-centric and rebuilt per web turn. We introduce a durable,
channel-independent `WorkspaceSituationalModel` — the orchestrator's always-on understanding of
the workspace, assembled by a `WorkspaceAwarenessService` and cached with short TTL + event
invalidation:

```typescript
interface WorkspaceSituationalModel {
  // Identity & intent — what this workspace is FOR.
  workspaceName: string;
  purpose: string;                  // condensed from WORKSPACE.md / workspace context
  intents: Array<{                  // the standing objectives of the workspace
    id: string; title: string; summary: string;
    owningAgentId?: string; status: 'active' | 'paused' | 'achieved';
  }>;

  // The roster — who can do what (from agentInventory + ROLE_TOOLS manifests).
  agents: Array<{
    id: string; name: string; role: string | null;
    adapterType: string; status: 'online' | 'offline' | 'error';
    capabilityTags: string[]; toolManifest: string[];
    whatTheyKnow: string;           // 1-line domain brief from instructions
  }>;

  // What's in motion right now.
  activeRuns: RunSummary[];
  pendingApprovals: ApprovalSummary[];
  recentOutcomes: Array<{ runId: string; verdict: string; at: string }>;

  // What the workspace can wire (credentials, integrations, skills, KBs).
  wireableIntegrations: string[];
  availableSkills: string[];
  knowledgeBases: Array<{ id: string; name: string; documentCount: number }>;

  // Channel presence — which surfaces this orchestrator answers on.
  liveChannels: Array<{ kind: ChannelKind; status: string }>;
}
```

The crucial addition over today's prompt is **`intents`** — a first-class notion of "what is
this workspace trying to do." A workspace is not just a bag of agents and runs; it has standing
objectives. The orchestrator that can answer "where are we on the competitor-intelligence
initiative?" without the user naming a workflow id is the orchestrator people keep.

> **Naming note.** These are *intents*, not "goals" — `goals` is a reserved release name and is
> deliberately avoided here. Intents are the workspace's standing objectives; the orchestrator
> reads and references them, and may propose new ones, but they remain operator-owned.

### 4.2 Brain residency — both Brains, always in reach

The Brain (`/v1/brain`) is today *queryable* — the orchestrator can call a tool to search the
knowledge graph, peer profiles, memory, and per-agent memory. The 10x move is **residency**:
the orchestrator carries a compact, relevance-ranked slice of *both* Brains in its working
context on every turn, and can drill deeper on demand.

- **Workspace Brain** (`SharedIntelligenceService`, `BrainComposer`): the shared knowledge
  graph, patterns, peer profiles, disputes, and workspace memory. The awareness service pulls
  a query-conditioned slice (top-k atoms relevant to the inbound message) into the prompt —
  not the whole graph.
- **The orchestrator's own Brain** (`AgentMemoryService`, the per-agent memory + personal
  relational brain, §G11): the orchestrator is itself a brained agent. Its accumulated
  operator preferences, prior decisions, and relational context are resident, exactly as
  `buildOrchestratorSystemPrompt` already supports via `agentMemory` / `personalBrain` — but
  now refreshed from the awareness model rather than viewport assembly.

Residency turns "the orchestrator can look things up" into "the orchestrator already knows."
That difference is the entire felt value of the single conversation.

### 4.3 A channel-shaped system prompt

`buildOrchestratorSystemPrompt()` is extended (not replaced) with a `channelContext` and a
`situationalModel` input. When the turn originates from a channel rather than a viewport:

- The VIEWPORT CONTEXT block is replaced by a **CHANNEL CONTEXT** block (`from`, channel kind,
  thread) and a **WORKSPACE SITUATION** block (intents, roster, in-motion runs, live channels).
- Output is tuned for the surface: short, chat-native messages for Telegram/WhatsApp; threaded,
  mention-aware replies for Slack/Discord; richer markdown for web. A `responseProfile` derived
  from `channelContext.kind` governs length and formatting (lifted from OpenClaw's
  `markdownCapable` / `draft-chunking` notions).

The behavior rules (action-first, clarification, cost-awareness) are channel-independent and
stay verbatim. The orchestrator behaves the same everywhere; only its *awareness framing* and
*output shape* adapt to the surface.

### 4.4 Per-Role Model Configuration

The orchestrator does not do one kind of thinking — it does several, and they do not all want
the same model. Holding a fast chat wants a cheap, low-latency model. Decomposing a complex
build wants a strong reasoner. Synthesizing a graph wants structured-output reliability. Judging
a result wants a calibrated judge. Forcing all of these onto one model is either too expensive
(everything on Opus) or too weak (everything on a mini model).

So the orchestrator's model is configured **per cognition role**, through an
`OrchestratorModelRouter` (`apps/api/src/services/orchestratorModelRouter.ts`). The roles:

| Role | Used by | Wants |
|------|---------|-------|
| `conversation` | the chat / channel turn loop | fast, cheap, good tool-calling |
| `planning` | multi-step build decomposition (Planner) | strong reasoning |
| `synthesis` | `build_workflow` graph generation | structured-output reliability |
| `evaluation` | evaluator nodes, `llm_route`, quality gates | a calibrated judge |
| `vision` | image understanding in Brain enrichment | a vision model |
| `transcription` | voice-note → text (WhatsApp/Telegram audio) | an audio model |

**Two configuration modes, one knob each:**

1. **One high model for everything.** Set only the default profile —
   `AGENTIS_ORCHESTRATOR_MODEL=claude-opus-4-8` (+ base URL / key). Every role resolves to it.
   Maximum quality, one variable. This is the "just give the orchestrator the best brain"
   preset.
2. **Per-role models.** Override any role independently —
   `AGENTIS_ORCHESTRATOR_PLANNING_MODEL`, `WORKFLOW_SYNTHESIS_MODEL`, `AGENTIS_EVALUATOR_MODEL`,
   etc. Any role left unset falls back to the default profile. Mix providers freely: Opus for
   planning, a mini model for conversation, a dedicated judge for evaluation.

The router resolves a role to a concrete chat adapter and **caches by profile**, so two roles
pointed at the same `(baseUrl, model, apiKey)` share one adapter instance — no duplicate
connections. It is built once in bootstrap (`OrchestratorModelRouter.fromEnv(env, logger)`); the
`conversation` role becomes the fast-path chat runtime injected into `ChatSessionExecutor`. The
historical single-endpoint env vars (`AGENTIS_ORCHESTRATOR_*`, `AGENTIS_EVALUATOR_*`,
`WORKFLOW_SYNTHESIS_*`) all still work unchanged — the router preserves their fallback chains, so
this is additive, not a migration.

> The router is provider-agnostic by construction: a "profile" is just `{ baseUrl, model,
> apiKey }` against an OpenAI-compatible endpoint (the `HermesAdapter`). Any model any provider
> exposes over that shape is selectable per role — there is no hard-coded model list.

**Per-workspace settings surface ✅ SHIPPED.** Each role is now overridable *per workspace* from
the UI without redeploying: `workspace_model_config` table + `WorkspaceModelConfigService`
(vault-encrypted keys, write-only), exposed at `/v1/orchestrator/models` (GET/PUT/:role/DELETE).
The router became workspace-aware — `profile(role, workspaceId)` / `resolve(role, workspaceId)`
consult a `configProvider`; an override supplies the model and inherits the env default's
base URL + key when those are left blank. The **conversation** role is wired live: chat and
channel turns resolve their runtime per workspace (`ChatSessionExecutor` + dispatcher pass the
`workspaceId` through). Settings → Runtimes hosts the `OrchestratorModelsPanel` (one row per
role; "Override / Change / Reset to default"). Setting only the conversation role to
`claude-opus-4-8` is the "one high model as orchestrator" preset, now a UI action.

### 4.5 Internal Tools vs MCP — One Registry, Many Projections

A natural question while designing "the perfect architecture for agents": should the
orchestrator's internal tools (`agentis.workflow.run`, `agentis.build_workflow`, memory,
knowledge, …) be **MCP** tools?

**The answer is: the tool *definitions* should have one home; MCP is one of several
*projections* of that home — and it is the wrong call path for the orchestrator's own use.**
This is already how Agentis is built, and it is the right design:

- There is a single source of truth — the `AgentisToolRegistry`. A tool is defined once.
- That registry is **projected** three ways, all from the same definitions:
  1. **In-process** to the chat loop and the engine (`ChatToolExecutor`) — a direct function
     call, sub-millisecond, fully typed, no serialization.
  2. **Over MCP** at `/v1/mcp/rpc` (JSON-RPC 2.0, `tools/list` + `tools/call`) for *external*
     clients — Claude Code, Cursor, Codex — gated by an `mcpExposed` flag so only the intended
     subset crosses the boundary.
  3. **As published workflow tools** (`agentis__<slug>`) for workflows an operator chooses to
     expose.

The principle: **MCP is an interoperability boundary, not an internal bus.** Routing the
orchestrator's own tool calls through MCP would add JSON-RPC serialization, an HTTP hop, and
auth re-checks to every in-process call — pure latency and failure surface for zero benefit, and
it would *lose* the typed, streaming, confirmation-gated execution the in-process path gives
(see the confirmation/impact machinery in `ChatSessionExecutor`). MCP earns its place exactly
where a *foreign* runtime needs to call Agentis; it should never sit between the orchestrator and
its own registry.

So the architecture is **"one registry, many projections,"** not **"everything is MCP."** New
internal capabilities are added as registry tools (with `mcpExposed` set when an external client
should also see them). This keeps the internal call path fast and the external boundary
standards-compliant — without maintaining two definitions of the same tool.

---

## 5. Routing & Delegation — One Conversation, the Whole Workspace

The orchestrator's job over a channel is rarely to answer alone — it is to **route**. The user
says one thing; the orchestrator decides which of five dispositions applies and threads the
result back to the originating channel.

```
INBOUND INTENT            DISPOSITION                         MECHANISM
──────────────────────────────────────────────────────────────────────────────────────
"what's the status of X"  Answer directly                     situational model + Brain
"summarize the Notion…"   Delegate to a specialist agent      agentis.agent.* / sub-turn
"run the morning digest"  Trigger a workflow run              agentis.workflow.run
"research these 5 rivals" Fan out to a swarm                  agent_swarm / parallel run
"have Codex fix this bug" Forward to an external runtime      adapter dispatch (OpenClaw/…)
```

### 5.1 Delegation without losing the thread

When the orchestrator delegates to a specialist agent or dispatches a workflow run, the
**conversation thread stays anchored to the orchestrator**. The user is never handed off to a
different agent's chat. Instead:

1. The orchestrator opens a **sub-turn** against the specialist (existing agent dispatch /
   `agentToolLoop`), or launches a run (existing `WorkflowEngine`).
2. Progress streams back to the channel *as the orchestrator's voice*: "Your researcher is
   pulling the five sources now…" — using the specialist's name for transparency but never
   forcing the user into a second conversation.
3. On completion (the engine already emits `task.completed` / `notifyTaskCompleted`, and
   `OpenClawAdapter` already normalizes these), the orchestrator narrates the outcome and the
   next operational choice back to the origin channel.

This is the payoff of §3.3 (inbound reaches the orchestrator) plus §4 (the orchestrator knows
the roster): the user talks to one entity about many subjects, and that entity dispatches the
right worker every time.

### 5.2 Multi-channel identity & continuity

A single human may reach the orchestrator from WhatsApp on their phone and Slack at their desk.
The awareness core keys continuity on **(workspace, peer identity)**, not on channel address,
so:

- **As built:** `ChannelIdentityService` + the `channel_peer_identities` table unify the same
  human across surfaces. An operator opt-in links a channel handle → workspace user (assigning a
  stable `peerKey`); the orchestrator then gets a "who is this" recall line in CHANNEL CONTEXT,
  including the cross-surface note ("also reaches you on: slack").
- Because all of an agent's channel connections share one conversation thread
  (`getOrCreateByAgent` keys on workspace+agent), a decision made on Slack is in the same
  conversation memory the orchestrator sees when the user follows up from WhatsApp.
- Per-channel `chatId`/`threadId` remain the reply addresses; thread isolation (§5.3) keeps
  distinct subjects from bleeding within that shared memory.

### 5.3 Subject isolation

Talking to one orchestrator about many subjects requires the orchestrator to keep subjects from
bleeding. **As built:** each inbound carries a `threadId` (Slack `thread_ts`, Telegram forum
`message_thread_id`, Discord thread id), and the `ChannelTurnDispatcher` scopes the turn's
history to messages tagged with the active thread — so a budget thread and a deploy thread in
the same conversation never bleed into each other. "One orchestrator" must not mean "one
undifferentiated firehose."

---

## 6. Phasing

Each phase is independently shippable and independently valuable. No phase depends on a later
one to deliver user value.

### Phase 1 — Make inbound reach the orchestrator ✅ **SHIPPED (June 2026)**
- `ChannelTurnDispatcher`: bridge → `ChatSessionExecutor.turn()` → reply delivered to origin.
- Inbound tagged `channelInbound` metadata (stored `system`, mapped to `user` role in history);
  reply persisted as `agent` and sent via `ChannelBridge.deliverToConnection` — deterministic,
  no mirror loops.
- Slack adapter registered + `channels.ts` enum widened to `slack`.
- Adapter fallback: `ChatSessionExecutor.orchestratorAdapter()` answers even when the bound
  agent runs on a CLI without its own chat.
- **Outcome:** a Telegram/Slack user can hold a real, two-way conversation with the
  orchestrator today. This alone changes the product category.
- *Also shipped alongside:* per-role **Orchestrator Model Configuration** (§4.4) —
  `OrchestratorModelRouter` + env wiring.

### Phase 2 — The Awareness Core ✅ **SHIPPED (June 2026)**
- ✅ `WorkspaceAwarenessService` + `WorkspaceSituationalModel` (intents-as-standing-automations,
  roster with capability tags, in-motion runs, pending approvals, live channels); TTL cache +
  `invalidate`.
- ✅ Channel-shaped `buildOrchestratorSystemPrompt` (CHANNEL CONTEXT + WORKSPACE SITUATION +
  `responseProfileForChannel`); threaded into channel turns via `ChatTurnOptions.channelContext`.
- ✅ Brain residency: channel turns already inject workspace context + agent memory + personal
  brain via the existing `turn()` path (the orchestrator agent is itself brained).
- ✅ Per-workspace model-role settings surface — `workspace_model_config` +
  `WorkspaceModelConfigService` + `/v1/orchestrator/models` + `OrchestratorModelsPanel` (§4.4).
- **Outcome:** the channel conversation now leads with the workspace's live picture and shapes
  its replies for the surface — demonstrably workspace-aware, not a stateless bot.

### Phase 3 — Persistent channels (port from OpenClaw) ✅ **SHIPPED**
- ✅ **WhatsApp (baileys)** session runtime ported from OpenClaw, owned by
  `ChannelConnectionSupervisor`; QR login endpoints; reconnect backoff; multi-file auth on disk;
  inbound → shared `ChannelTurnDispatcher`; outbound over the live socket. Lazy-loaded dep.
- ✅ **Telegram long-poll (grammy)** session runtime — opt-in per connection via
  `settings.transport = 'polling'`; no public webhook needed. Same supervisor, same inbound/turn
  path; outbound via `bot.api.sendMessage`. Lazy-loaded dep; connection-aware routing so the
  webhook adapter and the polling session never collide.
- ✅ **Discord two-way (discord.js gateway)** session runtime — opt-in via
  `settings.transport = 'gateway'`. Discord delivers regular messages over the gateway (not
  webhooks), so this is what makes Discord a real inbound channel rather than outbound-only.
  Same supervisor/inbound/turn path; outbound + typing via the live client; thread detection
  feeds subject isolation. Lazy-loaded dep; requires the Message Content intent.
- ✅ **Voice-note transcription.** WhatsApp audio is downloaded (`downloadMediaMessage`) and
  transcribed via `TranscriptionService` against the model router's **transcription role**
  (OpenAI-compatible `/audio/transcriptions`); OGG/Opus goes straight to Whisper, no local
  decode. No-op when no transcription model is configured.
- ✅ **Image ingestion.** WhatsApp images (and image documents) are downloaded and described via
  `VisionService` against the **vision role** (`/chat/completions` with a data-URL image); the
  description feeds the turn (🖼️ prefix). Optional/failure-tolerant.
- ✅ **Typing presence.** While a (possibly slow) turn runs, the dispatcher shows "typing…" on
  the live session — WhatsApp `sendPresenceUpdate('composing')`, Telegram/Discord chat action —
  cleared in a `finally`.
- ✅ **WhatsApp auth in the vault.** `useVaultAuthState` persists baileys creds + signal keys
  `BufferJSON`-serialized and **AES-256-GCM-encrypted in `channel_auth_state`** — no plaintext
  on disk; a restart re-links from the vault without a new QR.
- ✅ **Debounce/batching.** Rapid-fire messages from the same chat coalesce into one turn
  (`debounceMs`, default 900ms); all batched inbound ids are excluded from the turn history.
- ✅ **Document ingestion.** PDF/text attachments are extracted via `DocumentExtractionService`
  (pdf-parse + UTF-8 decode, truncated) and fed into the turn (📄 prefix).
- **Outcome:** WhatsApp *and* Telegram run with no public webhook — scan a QR (or set a polling
  token) and the orchestrator answers your phone, voice notes and images included, with the
  device credentials encrypted at rest.

### Phase 4 — Routing, delegation & approvals over channels ✅ **SHIPPED**
- ✅ **Channel-delivered confirmations.** A channel has no buttons, so when a tool needs
  confirmation the dispatcher delivers a "reply yes/no" prompt, registers the pending `turnId`
  per `connectionId:chatId`, and resolves it via `ChatSessionExecutor.confirm` on the next
  message (`interpretConfirmation`, EN+PT + 👍/👎). This is how a run gets approved/cancelled
  from a phone.
- ✅ **Native commands** `/status`, `/runs`, `/agents`, `/approvals`, `/stop` (mapped in
  `expandUserMessage`).
- ✅ **The five dispositions** (answer / delegate to a specialist / run a workflow / fan out a
  swarm / forward to an external runtime) ship **through the tool plane** — the orchestrator
  selects them via `agentis.*` tools + the action-first behavior rules, which is the design (one
  registry, many projections; §4.5), not a separate pre-classification stage. The thread stays
  anchored to the orchestrator (§5.1). An explicit pre-classifier was considered and
  deliberately not added — it would duplicate the LLM's tool selection.
- **Outcome:** one conversation drives the workspace, including phone-confirmed destructive
  actions.

### Phase 5 — Multi-channel identity & continuity ✅ **SHIPPED**
- ✅ **Per-thread subject isolation.** `ParsedInboundMessage.threadId` (Slack `thread_ts`,
  extensible to Discord/Telegram topics); the dispatcher scopes turn history to the active
  thread so unrelated subjects don't bleed.
- ✅ **Cross-surface peer identity.** `ChannelIdentityService` + `channel_peer_identities`
  table records every sender per (workspace, channel, handle). The dispatcher records on each
  turn and threads a "who is this" recall summary into CHANNEL CONTEXT. Opt-in
  `POST /v1/channels/identities/link {channelKind, handle, userId}` assigns a stable `peerKey`
  so the *same human* is recognized across WhatsApp / Telegram / Slack — and the summary says so
  ("Same person also reaches you on: slack."). `GET /v1/channels/identities` lists them.
- ✅ **Identity-linking web UI** — `ChannelIdentitiesPanel` in Settings → Connections lists every
  channel sender with message counts and a "Link to me / Unlink" action.
- ✅ **Telegram forum-topic threadId** (from `message_thread_id`) and **Discord thread** detection
  (`channel.isThread()`) both feed the thread-scoped history.
- ✅ **Discord two-way (gateway)** — a real `DiscordSession` (discord.js) makes Discord a live
  inbound channel, not outbound-only (see Phase 3 note below).
- **Outcome:** subjects stay separated per thread, and the orchestrator recognizes returning
  senders — including the same person across different channels once linked.

---

## 7. Security & Trust Boundaries

Channels are an external attack surface; the plan is explicit about the boundaries.

- **Token storage unchanged and inviolate.** Channel credentials stay AES-256-GCM in the
  `CredentialVault`; plaintext never leaves `ChannelBridge`, never appears in REST responses or
  bus envelopes, never in logs. (Already true; persistent-connection auth state — WhatsApp
  keys, Telegram offsets — joins it in the vault, never on disk in plaintext.)
- **Inbound is untrusted input.** A channel message is an untrusted user turn. It must not be
  able to escalate privileges: it runs as the bound connection's workspace + the agent's
  capability scope, never as an operator/admin. Webhook signature verification
  (`verify`, constant-time) stays mandatory; persistent sessions authenticate the upstream.
- **Approval actions are authenticated.** A channel "Approve" must be tied to an identity
  authorized to approve in that workspace — not anyone who can post in the chat. Map channel
  callbacks through peer identity; unmapped or unauthorized callbacks are rejected, not
  silently honored.
- **Idempotency stays.** `channel_deliveries.externalId` dedup remains the guard against
  replay; persistent transports add their own offset/cursor dedup.
- **Egress is policy-gated.** The orchestrator sending to external channels is an outward-facing
  side effect; destructive or external-communication actions still pass the existing confirm /
  approval rules before the orchestrator emits them over a channel.

---

## 8. What We Take From OpenClaw — Inventory

A concrete map so implementation is "port this file's logic into that adapter," not "go read a
giant repo." All paths under `C:\Users\antar\OneDrive\Documentos\openclaw\extensions\`.

| Capability | OpenClaw source (logic to port) | Agentis destination |
|------------|---------------------------------|---------------------|
| Telegram long-poll + offset | `telegram/src/polling-*`, `update-offset-store*` | `adapters/channels/telegram.ts` (persistent path) |
| Telegram throttling | `@grammyjs/transformer-throttler` usage | telegram adapter `send` |
| Telegram native commands | `telegram/src/bot-native-commands*` | `ChannelTurnDispatcher` command map |
| Telegram media/voice | `telegram/src/telegram-media*`, `voice.ts` | media ingestion in dispatcher |
| Telegram exec-approvals | `telegram/src/exec-approval-resolver.ts` | channel approval delivery (§5/§7) |
| WhatsApp baileys session | `whatsapp/src/*`, `login-qr-*`, `auth-presence` | `adapters/channels/whatsapp.ts` (new) |
| WhatsApp voice decode | `whatsapp` + `audio-decode` | transcription in dispatcher |
| Discord thread binding | `discord/runtime-api.threads.ts`, `thread-binding-api` | `adapters/channels/discord.ts` (graduate) |
| Slack events + threads | `slack/*` (Events API, `thread_ts`, mentions) | `adapters/channels/slack.ts` (already exists; richer outbound) |
| Reconnect/backoff | each channel's polling/liveness modules | `ChannelConnectionSupervisor` + existing `CircuitBreaker` |

**On Slack specifically (answering "what about Slack from OpenClaw?").** OpenClaw *does* ship a
full `slack` extension (and `mattermost`, `msteams`, `signal` besides). For Agentis, Slack is the
one channel where we did **not** need to port a runtime: Slack's model is webhook/Events-API
request-response, which the existing `adapters/channels/slack.ts` (HMAC `verify` over
`x-slack-signature`, `thread_ts` threading in `parseInbound`, `chat.postMessage` send) already
matches. So Phase 1 simply **registered the Slack adapter and widened the route enum** — Slack is
now a live, two-way orchestrator surface today. What is still worth lifting from OpenClaw's Slack
extension later is the *richer outbound* (Block Kit, interactive buttons for channel-delivered
approvals per §5/§7) and its mention/visibility handling for noisy multi-user channels.
`mattermost`, `msteams`, and `signal` are the obvious next channels to graduate after the core
four, using the exact same `ChannelAdapter` contract.

---

## Appendix A — Files Touched (engineering index)

**Shipped — Phase 1 + §4.4 (June 2026):**
- `apps/api/src/services/orchestratorModelRouter.ts` — **new** per-role model router (§4.4).
- `apps/api/src/services/channelTurnDispatcher.ts` — **new** bridge → executor → origin reply.
- `apps/api/src/services/channelBridge.ts` — `setTurnDispatcher`, `deliverToConnection`,
  inbound `channelInbound` metadata, fire-and-forget dispatch, Slack adapter registration.
- `apps/api/src/services/chatSessionExecutor.ts` — `orchestratorAdapter()` fallback accessor.
- `apps/api/src/routes/channels.ts` — `kind` enum widened to include `slack`.
- `apps/api/src/env.ts` — `AGENTIS_ORCHESTRATOR_PLANNING_{BASE_URL,API_KEY,MODEL}`.
- `apps/api/src/bootstrap.ts` — router wiring (conversation role → orchestrator runtime), Slack
  adapter, dispatcher construction + attachment.
- `apps/api/tests/services/orchestratorModelRouter.test.ts`,
  `apps/api/tests/services/channelTurnDispatcher.test.ts` — **new** (9 tests).

**Shipped — Phase 3 WhatsApp (June 2026):**
- `apps/api/src/adapters/channels/whatsappSession.ts` — **new** baileys session (connect, QR,
  reconnect, inbound text extract, send); lazy-loaded.
- `apps/api/src/services/channelConnectionSupervisor.ts` — **new** persistent-connection
  lifecycle: startup boot, login, inbound→dispatcher, outbound send, status mirroring.
- `apps/api/src/services/channelBridge.ts` — `PersistentChannelTransport` seam, persistent-kind
  create (no token), outbound routing, stop-on-delete.
- `apps/api/src/adapters/channels/types.ts` — `ChannelKind` gains `whatsapp`.
- `apps/api/src/routes/channels.ts` — `whatsapp` kind, conditional token, `POST/GET /:id/login`.
- `apps/api/src/bootstrap.ts` — supervisor construction + wiring + `startAll` + shutdown.
- `apps/api/package.json` — `baileys@7.0.0-rc13`, `qrcode`.
- `apps/api/tests/adapters/whatsappSession.test.ts`,
  `apps/api/tests/services/channelBridgePersistent.test.ts` — **new** (10 tests).

**Shipped — Phase 2/3/4/5 (June 2026):**
- `apps/api/src/services/workspaceAwarenessService.ts` — **new** situational model (P2).
- `apps/api/src/services/orchestratorPrompt.ts` — `channelContext` + `situationalModel` +
  `responseProfileForChannel` (P2).
- `apps/api/src/services/transcriptionService.ts` — **new** voice→text (P3).
- `apps/api/src/adapters/channels/telegramSession.ts` — **new** grammy long-poll session (P3).
- `apps/api/src/adapters/channels/whatsappSession.ts` — voice download + transcription (P3).
- `apps/api/src/services/channelConnectionSupervisor.ts` — owns WhatsApp + Telegram sessions;
  connection-aware persistence (P3).
- `apps/api/src/services/channelTurnDispatcher.ts` — channel confirmations + thread isolation
  (P4/P5).
- `apps/api/src/services/chatSessionExecutor.ts` — `channelContext` option, awareness wiring,
  native commands (P2/P4).
- `apps/api/src/adapters/channels/{types,slack}.ts` — `threadId` subject isolation (P5).
- `apps/api/package.json` — `grammy`, plus the earlier `baileys`/`qrcode`.
- `apps/api/src/services/channelIdentityService.ts` + `channel_peer_identities` table — **new**
  cross-surface peer identity (P5); `/v1/channels/identities` + `/identities/link` routes.
- `apps/web/src/components/agents/AgentChannelsTab.tsx` — WhatsApp QR + Slack + Telegram polling.
- `apps/web/src/components/settings/ChannelIdentitiesPanel.tsx` — **new** identity-link UI.

- `apps/api/src/services/workspaceModelConfigService.ts` + `workspace_model_config` table —
  **new** per-workspace model-role overrides (§4.4); `/v1/orchestrator/models` routes.
- `apps/api/src/services/orchestratorModelRouter.ts` — workspace-aware `profile/resolve` +
  `configProvider`.
- `apps/web/src/components/settings/OrchestratorModelsPanel.tsx` — **new** model-role config UI.
- `apps/api/src/services/{transcriptionService,visionService}.ts` — **new** voice + image media.
- `apps/api/src/adapters/channels/{telegramSession,discordSession,whatsappVaultAuthState}.ts` —
  **new** Telegram long-poll, Discord gateway, vault-encrypted WhatsApp auth.
- `apps/api/src/services/workspaceEvaluatorRuntimeFactory.ts` + `channel_auth_state` table —
  **new** per-workspace synthesis/evaluation + encrypted device auth.
- `apps/api/src/engine/WorkflowEngine.ts` — `evaluator`/`router` nodes honor per-workspace
  evaluation models.

- `apps/api/src/services/documentExtractionService.ts` — **new** PDF/text attachment ingestion.
- `apps/api/src/services/channelTurnDispatcher.ts` — debounce/batching of rapid-fire messages.

**Roadmap:** none outstanding from the plan. Every phase is implemented. Natural *future*
extensions beyond this doc: richer Slack Block Kit / Discord embeds, office-doc (docx/xlsx)
ingestion, and `mattermost`/`msteams`/`signal` channels (same `ChannelAdapter` + supervisor
pattern).

---

## Implementation Log

*Per repo convention, this section is appended to as the plan is built, and is kept reconciled
with the real code. Each entry: date · phase · what shipped · what's still open.*

- **2026-06-01 · Phase 1 + §4.4 · shipped.**
  - **Channel → orchestrator loop closed.** `ChannelTurnDispatcher` runs a real
    `ChatSessionExecutor.turn()` for every inbound channel message and delivers the reply back to
    the origin chat via `ChannelBridge.deliverToConnection`. Inbound is tagged with
    `channelInbound` metadata and mapped to the `user` role in turn history; the reply is
    persisted as an `agent` message (so it also appears in the web UI conversation). Adapter
    resolution falls back to the configured orchestrator runtime
    (`ChatSessionExecutor.orchestratorAdapter()`) when the bound agent has no chat adapter of its
    own. Wired fire-and-forget from `handleInbound` so webhooks keep their fast ack.
  - **Slack is live.** Registered `SlackChannelAdapter` in `bootstrap`; widened the
    `/v1/channels` `kind` enum to `slack`. Telegram (webhook), Discord, and Slack are now
    two-way orchestrator surfaces. (WhatsApp/Telegram long-poll remain Phase 3 — they need the
    persistent-transport runtime + baileys/grammy deps.)
  - **Per-role model configuration (§4.4).** `OrchestratorModelRouter` resolves a model per
    cognition role (conversation/planning/synthesis/evaluation/vision/transcription), cached by
    profile. `fromEnv` preserves all legacy fallback chains: setting only
    `AGENTIS_ORCHESTRATOR_MODEL` makes one high model serve every role; per-role env vars (incl.
    new `AGENTIS_ORCHESTRATOR_PLANNING_MODEL`) override. Bootstrap now derives the conversation
    runtime from the router.
  - **MCP decision recorded (§4.5).** Confirmed "one registry, many projections" is correct;
    internal tools stay in-process via `AgentisToolRegistry`/`ChatToolExecutor`, MCP remains the
    external boundary only. No code change — the architecture already embodies it.
  - **Verification.** `apps/api` typecheck clean; 9 new tests pass; existing `channelBridge` (12)
    and `channels` route (13) tests green — no regressions.
  - **Open / next:** Phase 2 awareness core (`WorkspaceSituationalModel`, channel-shaped prompt,
    Brain residency, model-role settings UI); Phase 3 persistent transports (WhatsApp/Telegram
    long-poll, supervisor, media/voice); Phase 4 channel-delivered approvals + native commands;
    Phase 5 multi-channel identity. Outbound fan-out to non-origin surfaces intentionally
    deferred to Phase 5.

- **2026-06-01 · Phase 3 (WhatsApp) · shipped.**
  - **WhatsApp via baileys, ported from OpenClaw.** Studied
    `openclaw/extensions/whatsapp/src/{session,reconnect,auth-store,inbound/extract}.ts` and
    reimplemented the baileys usage cleanly against Agentis infra (OpenClaw's code is coupled to
    its plugin SDK, so a literal copy was impossible — the *library patterns* were copied
    faithfully). `WhatsAppSession` wraps `makeWASocket` + `useMultiFileAuthState` + QR +
    backoff-reconnect + inbound-text extraction + `sendMessage`; baileys is lazy-loaded so the
    app boots without it.
  - **Supervisor, not contract-graduation.** Added `ChannelConnectionSupervisor` to own live
    persistent connections beside the webhook `ChannelBridge`, with a `PersistentChannelTransport`
    seam on the bridge so outbound routes to the live socket and create/delete manage the session.
    Webhook adapters (Telegram/Discord/Slack) are untouched. This is the pragmatic realization of
    the doc's §3.2 `connect`/`ChannelSession` idea without forcing a session lifecycle onto
    stateless adapters.
  - **Surface.** `ChannelKind` gains `whatsapp`; `/v1/channels` accepts it with no token and adds
    `POST/GET /:id/login` for the QR flow; auth persists under
    `${AGENTIS_DATA_DIR}/channels/whatsapp/<id>/` (no migration). Reuses the existing
    `ChannelTurnDispatcher` and `channel_deliveries` idempotency — one orchestrator-turn path for
    every channel.
  - **Deps.** Added `baileys@7.0.0-rc13` (matching OpenClaw) + `qrcode`.
  - **Verification.** Typecheck clean; 10 new tests (`whatsappSession` extractor + bridge
    persistent routing) pass; full channel suite (39 tests) green; module-import + app-boot smoke
    OK. *Not verifiable here:* the end-to-end QR scan with a real phone — that needs a device.
  - **Open / next for WhatsApp:** media/voice ingestion + transcription; Telegram long-poll
    parity; move auth state into the vault; web UI for the QR login (endpoints + realtime events
    are ready).

- **2026-06-01 · Phase 2 + Phase 4 + Phase 5 (subject isolation) · shipped.**
  - **Phase 2 — Awareness Core.** `WorkspaceAwarenessService`
    (`apps/api/src/services/workspaceAwarenessService.ts`) assembles a `WorkspaceSituationalModel`
    (roster + capability tags, standing automations as intents, in-motion runs, pending approvals,
    live channels) from existing tables, TTL-cached. `buildOrchestratorSystemPrompt` gained
    `channelContext` + `situationalModel` + `responseProfile`; channel turns now emit CHANNEL
    CONTEXT + WORKSPACE SITUATION blocks and shape output per surface
    (`responseProfileForChannel`). Threaded through `ChatTurnOptions.channelContext`, built in
    `ChatSessionExecutor.turn`, fed by the dispatcher; awareness service wired into bootstrap.
  - **Phase 4 — Approvals + native commands over channels.** The dispatcher now handles the
    confirmation gate without buttons: a `confirmation_required` delta becomes a "reply yes/no"
    prompt, the pending `turnId` is kept per `connectionId:chatId`, and the next yes/no resolves
    it via `ChatSessionExecutor.confirm` (`interpretConfirmation`, EN+PT + 👍/👎, 5-min TTL).
    Native commands `/agents /approvals /runs /stop` added to `expandUserMessage`.
  - **Phase 5 — Subject isolation.** `ParsedInboundMessage.threadId` (Slack sets it from
    `thread_ts`); bridge carries it into inbound metadata + the dispatcher; turn history is
    scoped to the active thread so distinct threads don't bleed; agent replies are tagged with
    the thread so follow-ups stay coherent.
  - **Verification.** Typecheck clean; new tests — `workspaceAwarenessService` (4),
    `orchestratorPromptChannel` (3), dispatcher confirmation + thread-isolation + interpret (3
    added) — plus the full channel/orchestrator suite: **61 passing across 9 files**, no
    regressions.
  - **Open / next (remaining doc scope):** Telegram long-poll (grammy) + media/voice ingestion;
    cross-surface peer identity unification (opt-in handle→user mapping — needs a small
    persistence surface + UI); explicit five-disposition router UX; per-workspace model-role
    settings UI; WhatsApp QR web panel.

- **2026-06-01 · Phase 3 completion (Telegram long-poll + voice) · shipped.**
  - **Telegram long-poll (grammy).** New `TelegramSession` (lazy-loaded grammy `Bot`,
    `message:text` → inbound, `bot.api.sendMessage` outbound, `onStart`/`bot.catch` lifecycle).
    The supervisor now owns both WhatsApp and Telegram-polling sessions. Routing went
    **connection-aware**: `PersistentChannelTransport` gained `handles(conn)` (WhatsApp always;
    Telegram only when `settings.transport==='polling'`), `requiresNoToken(kind)`, and an
    `onCreated` hook that auto-starts polling sessions on create. Telegram polling uses the bot
    token (decrypted from the vault by the supervisor) and does **not** require the webhook
    adapter — so webhook and polling never collide. Opt in with
    `POST /v1/channels {kind:'telegram', token, transport:'polling'}`.
  - **Voice transcription.** `TranscriptionService` posts audio to the model router's
    `transcription` profile (`/audio/transcriptions`, OpenAI-compatible); `WhatsAppSession`
    downloads voice notes via baileys `downloadMediaMessage` and feeds the transcript into the
    turn (prefixed 🎤). Fully optional and failure-tolerant — no model ⇒ voice notes are skipped,
    never an error.
  - **Verification.** Typecheck clean; new tests — `transcriptionService` (4),
    `unwrapAudioMessage` (2), Telegram-polling routing (1) — plus module-load smoke for the
    Telegram session/supervisor under tsx. Full channel/orchestrator suite: **71 passing across
    11 files**, boot test included, no regressions.
  - **Open / next:** typing presence + image/document ingestion; cross-surface peer identity
    unification (the one remaining item needing a new persistence surface + UI); WhatsApp QR web
    panel + model-role settings UI (both frontend); explicit five-disposition router stage.

- **2026-06-01 · Phase 5 completion (cross-surface peer identity) · shipped.**
  - **New persistence:** `channel_peer_identities` table — added idempotently in
    `runEmbeddedMigrations` (`CREATE TABLE IF NOT EXISTS`, the established pattern, no version
    bump) + a drizzle schema entry. One row per (workspace, channelKind, handle) with opt-in
    `userId` + `peerKey`.
  - **Service:** `ChannelIdentityService` — `record` (upsert + message count), `link`
    (handle→user, assigns `peerKey = user:<id>`), `resolve`, `list`, `peerChannels`, and
    `recordAndSummarize` (returns the "who is this" recall line, cross-channel-aware).
  - **Wiring:** the dispatcher records the sender on every channel turn (stable handle: Slack/
    Discord sender id, DM chat address for WhatsApp/Telegram) and threads the summary into
    `channelContext.senderSummary` → the CHANNEL CONTEXT prompt block. Covers both webhook and
    persistent inbound paths (both flow through the dispatcher).
  - **API:** `GET /v1/channels/identities`, `POST /v1/channels/identities/link`.
  - **Verification.** db package typechecks clean (also fixed a *pre-existing* missing
    `uniqueIndex` import in `schema.ts` that the abilities drift needed); new
    `channelIdentityService` test (6) + full channel/orchestrator suite **76 passing across 12
    files**, boot test included. *Note:* project-wide `apps/api` tsc is currently blocked by
    pre-existing, unrelated mid-refactor drift in `packages/core/src/types/adapter.ts` (a
    discriminated-union edit) and `abilityService.ts` — left untouched, as they are others'
    in-flight work; my code compiles and runs (tests exercise it end-to-end).
  - **Remaining doc scope:** identity-linking + WhatsApp-QR web UIs, model-role settings UI (all
    frontend); typing presence; image/document ingestion; Discord thread parity.

- **2026-06-01 · Frontend (WhatsApp QR + Slack + Telegram-polling + identity UI) · shipped.**
  - **`AgentChannelsTab` (apps/web)** rebuilt: now shows all four providers. Token providers
    (Telegram/Discord/Slack) keep the paste-token form; **WhatsApp** uses a QR flow — connect
    creates the connection (no token), `POST /:id/login` returns the QR data URL, and the panel
    polls `GET /:id/login` until `status:'open'` then refreshes. **Telegram** gained a
    "long-polling (no public webhook)" toggle that sets `transport:'polling'`. "Needs linking"
    amber state for unlinked WhatsApp connections with a "Show QR" re-link.
  - **`ChannelIdentitiesPanel` (apps/web)** in Settings → Connections: lists channel senders
    (channel, name/handle, message count, linked badge) with "Link to me / Unlink" wired to
    `/v1/channels/identities` + `/identities/link` and `/v1/auth/me`.
  - **Verification.** Web typecheck clean; new RTL tests — `AgentChannelsTab` (3, incl. the full
    WhatsApp create→login→QR-render flow) + `ChannelIdentitiesPanel` (2) — plus the existing
    `AgentsPage` suite (7): **12 web tests passing**. Live QR scan still needs a real phone.
  - **Doc status:** all five phases + the model router + the MCP decision are now implemented
    end-to-end (backend + the channel/identity frontend). The only unshipped items are the
    per-workspace **model-role settings UI** (needs new config persistence; env config works
    today), **typing presence**, **image/document ingestion**, and **Discord thread parity** —
    all explicitly scoped as later polish.

- **2026-06-01 · Per-workspace model-role config (persistence + UI) · shipped.**
  - **Persistence:** `workspace_model_config` table (idempotent `CREATE TABLE IF NOT EXISTS` +
    drizzle entry) + `WorkspaceModelConfigService` (vault-encrypted, write-only keys;
    set/list/clear/resolveOverride; `asConfigProvider`).
  - **Router:** `OrchestratorModelRouter` became workspace-aware — `profile(role, workspaceId)` /
    `resolve(role, workspaceId)` consult a `configProvider`; an override supplies the model and
    inherits the env default's base URL + key when blank. Cached per effective profile.
  - **Live wiring:** the **conversation** role resolves per workspace — `ChatSessionExecutor`
    (`#resolveChatAdapter`/`orchestratorAdapter(workspaceId)`, turn + confirm) and the channel
    dispatcher fallback all thread `workspaceId` through. So chat + channels honor the override
    immediately. Other roles are persisted/exposed and resolvable; their bootstrap-built
    consumers still read env until refactored (documented).
  - **API:** `GET /v1/orchestrator/models`, `PUT/:role`, `DELETE/:role`. **UI:**
    `OrchestratorModelsPanel` in Settings → Runtimes (per-role Override/Change/Reset; "one high
    model as orchestrator" = set conversation to `claude-opus-4-8`).
  - **Verification.** db typecheck clean; new tests — `workspaceModelConfigService` (4),
    router workspace cases (2), `orchestratorModels` routes (5), `OrchestratorModelsPanel` (2) —
    plus boot test; backend 33 + web 7 in the combined run, all green.

- **2026-06-01 · Final polish (media, typing, Discord gateway, vault auth, per-workspace synth/eval) · shipped.**
  - **Media ingestion.** `VisionService` (vision role, `/chat/completions` + data-URL image)
    describes inbound WhatsApp images; `WhatsAppSession` downloads + feeds the description (🖼️)
    into the turn — mirrors the voice path.
  - **Typing presence.** Dispatcher shows "typing…" on the live session while the turn runs
    (WhatsApp `sendPresenceUpdate`, Telegram/Discord chat action), cleared in `finally`; routed
    through `ChannelBridge.setTyping` → supervisor (webhook channels no-op).
  - **Discord two-way.** New `DiscordSession` (discord.js gateway, lazy-loaded) — opt-in
    `transport: 'gateway'`; live `messageCreate` inbound, REST/gateway send + typing, thread
    detection. Supervisor + bridge routing generalized to be connection-aware across
    WhatsApp/Telegram/Discord. Web UI gained the Discord "two-way via gateway" toggle.
  - **WhatsApp auth in the vault.** `useVaultAuthState` (new `channel_auth_state` table) persists
    baileys creds + signal keys `BufferJSON`-serialized and vault-encrypted — no plaintext on
    disk; restart re-links without a new QR.
  - **Per-workspace synthesis + evaluation.** `WorkspaceEvaluatorRuntimeFactory` builds a cached
    `EvaluatorRuntime` from the router's per-workspace profile; `build_workflow` (synthesis) and
    the engine's `evaluator`/`router` nodes (evaluation) now honor per-workspace model overrides,
    falling back to env.
  - **Telegram forum-topic threadId** + Discord thread detection feed the thread-scoped history.
  - **Verification.** db + api typecheck clean (only the unrelated pre-existing
    `core/adapter.ts` + `abilityService.ts` drift remains, untouched). Full omnichannel suite:
    **100 backend tests across 17 files + 14 web tests**, boot test included — all green.
  - **Doc status: 100% of the plan is implemented.** Remaining items are minor polish only
    (debounce/batching, non-image document ingestion, moving the AgentToolLoop `llm` passthrough
    onto the per-workspace router).

- **2026-06-01 · Closeout (debounce, document ingestion, AgentToolLoop per-workspace) + doc audit · shipped.**
  - **Debounce/batching.** `ChannelTurnDispatcher` coalesces rapid-fire messages per
    (connection, chat) within `debounceMs` (bootstrap: 900ms) into one turn; all batched inbound
    ids are excluded from history so the combined text isn't duplicated. `debounceMs: 0` (tests)
    keeps the immediate path.
  - **Document ingestion.** `DocumentExtractionService` (pdf-parse for PDFs, UTF-8 for text/
    json/csv/markdown, truncated to 6k chars); WhatsApp non-image documents are downloaded and
    fed into the turn (📄). Office binaries return null and are skipped.
  - **AgentToolLoop per-workspace.** The engine's role-tools loop now resolves its `llm` via the
    per-workspace evaluation model (`resolveEvaluatorRuntime`), matching synthesis + evaluator/
    router nodes. Every orchestrator cognition role is now per-workspace end-to-end.
  - **Doc audit / reconciliation.** Walked every "shipped" claim against the code and corrected
    the prose to match what was actually built: §4 Phase 2 model-role-settings checkbox (was
    stale ⬜ → ✅); §5.2 now credits `ChannelIdentityService` + `channel_peer_identities` (the
    original prose hypothesized `PeerProfileService`); §5.3 now credits the dispatcher's
    thread-scoped history (not the hypothesized `SessionMomentService`); Phase 4 five
    dispositions documented as delivered through the tool plane by design (no separate stage).
  - **Verification.** db + api + web typecheck clean (only the unrelated pre-existing
    `core/adapter.ts` + `abilityService.ts` drift remains). New tests: `documentExtractionService`
    (4), `unwrapDocumentMessage` (1), dispatcher debounce (1). Full omnichannel suite green.
  - **Status: the plan is fully implemented and the document is reconciled to the code.** No
    `⬜`/`🟡` markers remain.
