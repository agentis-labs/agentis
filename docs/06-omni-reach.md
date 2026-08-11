# 06 · Omni-Reach

Omni-Reach is Agentis's connection surface: the channels, protocol servers, and integrations
agents use to reach people and systems. A **Connection** is one of the six primitives; all
projections share one registry so there is no protocol drift between channels, MCP, and A2A.

## Messaging channels

`apps/api/src/adapters/channels/`, tables `channel_connections`, `channel_peer_identities`,
`channel_deliveries`, `channel_auth_state`, `channel_turn_queue`. Routes: `/v1/channels`.

| Channel | Direction | Notes |
|---------|-----------|-------|
| Discord | outbound (V1) | multipart attachments |
| Slack | bidirectional | threads, file upload via external-upload flow |
| Telegram | bidirectional | webhook or polling; full inbound |
| WhatsApp | bidirectional | Baileys (QR link); media transcription |
| Voice | webhook ingress | transcription in, TTS reply buffer out |

Channel health checks are read-only: pressing **Test connection** validates credentials,
transport, routing, inbound readiness, and runtime availability without sending a message.
An actual outbound test is an explicit channel send.

For WhatsApp QR sessions, the id returned by `sendMessage()` is initially only a client
correlation id. Agentis records that attempt as `queued` and does not report `sent:true`
or advance workflow state until a WhatsApp server acknowledgement arrives. Later server,
delivery, and read receipts promote the durable journal to `accepted`, `delivered`, and
`read`. Requested, provider-resolved, and provider-echoed recipients remain separate in
the receipt so canonical number resolution is visible without being mistaken for proof.
Rich attachments and per-channel access control are supported; peer identity is resolved
across channels. Inbound messages are durably queued (`channel_turn_queue`) and dispatched to
the responsible agent/subject.

### Channel conversation and authority invariants

- `defaultChatId` is a routing fallback only. An explicit `to` always wins, and an omitted
  destination inside an inbound channel turn means that current conversation—not the
  connection-wide default.
- Owner authority requires the exact `channel_peer_identities` handle to be explicitly linked
  to the connection/workspace owner. Matching the default recipient alone never grants owner
  tools, private diagnostics, or owner-grade memory authority.
- The verified channel origin travels with the turn's revocable capability lease, including
  through an adapter-owned MCP loop. An unverified peer can reply only in its originating
  connection/conversation; it cannot initiate a cross-recipient or cross-connection send.
- When the inbound request explicitly names another recipient, the server records that intent
  on the turn. A channel tool call that omits `to`, falls back to the requester, or substitutes
  a different recipient is rejected instead of silently misrouting the message.
- Plain agent text is delivered automatically to the current conversation. A verified
  `agentis.channel.send` to that same peer is reconciled as the final delivery unless it is
  explicitly marked `deliveryRole:"progress"`; this prevents tool delivery plus final-text
  duplication across caller-loop and MCP-native adapters. The provider-backed delivery is
  mirrored into conversation history without being sent again. A send to a different recipient
  does not suppress the natural acknowledgement to the requester.
- Internal strategy state, tool/runtime events, JIDs, connection settings, routing diagnostics,
  and provider receipts remain Agentis telemetry. Channel users receive the natural response;
  the only optional external status is the generic, identity-verified owner reasoning indicator.
- WhatsApp `fromMe` events from the primary phone or another companion are mirrored into the
  channel conversation even when Baileys reports them as `append`. Historical inbound `append`
  events remain silent and never activate an agent turn.

Inbound voice notes are understood by default. Agentis first uses a workspace transcription
provider when configured, then a pinned Apache-2.0 local Whisper q8 fallback. The fallback is
channel-scoped: `agentis up` does not globally acquire it. WhatsApp/Telegram startup prepares
its immutable revision and SHA-256-verified artifacts without loading ONNX into memory; the
pipeline loads on first audio. `agentis setup --channels` or `agentis warmup --transcription`
prepares it explicitly, `--repair` preserves the previous cache, and
`AGENTIS_TRANSCRIPTION_OFFLINE=true` forbids network acquisition. OGG/Opus and common channel
audio containers use the packaged portable decoder; system FFmpeg is only a compatibility
fallback for containers outside that decoder set.

### Audio decoder contract and transcript admission

`@audio/decode` v3 returns an `AudioData`-shaped object (`sampleRate` plus
`channelData: Float32Array[]`), not a Web Audio `AudioBuffer`. Channel code must derive the
sample count from `channelData[0].length`, validate equal channel lengths, then mix and resample
from those real samples. It must not infer sample count from an optional `length` property or
cast an external decoder result unchecked: doing so can turn a valid OGG/Opus voice note into a
near-zero silent buffer and make speech recognition hallucinate text.

Transcript admission is part of the input trust boundary. Empty, impossible-for-duration, or
pathologically repetitive output is rejected before it becomes a channel message, conversation
context, or memory input. Preserve the original attachment and emit structured diagnostics, but
never replace an uncertain transcript with invented content.

### OSS release invariant for channel media

The dependency contract must be tested against the version shipped in the npm tarball, not only a
hand-written mock. The media release gate is: decode a real OGG/Opus fixture through the packaged
dependency, confirm non-zero PCM duration and resampling, execute a local Whisper transcription,
then `npm pack` and install the tarball into a clean directory before exercising the same decoder.
Do not commit private customer voice notes as fixtures; generate or license a small public fixture
for CI. The bundle guard must keep the decoder as an exact runtime dependency so a global npm
install has its codec assets as well as the JavaScript import.

## Email

Four providers: **Gmail** (OAuth), **SMTP** (custom), **Outlook** (OAuth), and **AgentMail**
(agent-native, API-key only — the zero-config "email me" default).

## MCP capability plane (bilateral)

`services/mcp/`. Routes: `/v1/mcp`, `/v1/mcp-servers`, `/v1/mcp-oauth`.

- **Consumer** — mount MCP servers (40+ preconfigured: Supabase, GitHub, Notion, Linear,
  Vercel, Stripe, …). Full OAuth discovery (RFC 9728 / 8414 / 7591 / 7636) with dynamic client
  registration (`mcpOAuthService.ts`). Tools are namespaced `mcp__<slug>__<tool>`, cached, and
  can grant a RAL affordance when tagged (`mcpToolBridge.ts`).
- **Provider** — publish any workflow as an MCP tool over JSON-RPC 2.0 Streamable HTTP; the
  published surface is the same one the engine and chat use.

- Tools: `agentis.mcp.{list,call}`, `agentis.capability.{search,load,invoke}`.

## Integrations

`services/integrationRegistry.ts`, `packages/integrations/`. Routes: `/v1/integrations`.
~95 connectors across three implementations:

- **Hand-written** — HTTP, Webhook, Slack, Gmail, GitHub, Google Sheets, AgentMail.
- **Templated HTTP** — ~40 connectors auto-rendered from manifests (Supabase, Stripe, Notion,
  …).
- **Generic HTTP fallback** — caller supplies the URL.
- **Custom** — workspace-authored JSON-Schema manifests.

Auth types: none / bearer / api_key / basic / oauth2 / custom-headers. Operation repair
(`integrationOperationRepair.ts`) heals drifted operations. Used from the `integration`
workflow node and `agentis.integration.{list,call}`.

## Agent-to-agent (A2A)

Published workflows are exposed as A2A skills; task reception and invocation run over the same
execution path as MCP (no separate protocol). Route: `/v1/a2a`.

## Webhooks & gateways

Routes: `/v1/webhooks`, `/v1/gateways`. Table `webhook_deliveries`.

- `/v1/webhooks/trigger/:triggerId` — signed inbound trigger (HMAC-SHA256, timestamp +
  idempotency replay defense).
- `/v1/webhooks/connector/:triggerId` — native SaaS connector webhooks (GitHub, Stripe, …).
- `/v1/webhooks/channel/:connectionId` — adapter-specific channel webhooks.
- Outbound deliveries are logged with retry state.

## Safety

- **Credential vault** — per-connection secrets encrypted (see [Sovereignty](./05-sovereignty.md)).
- **Outbound policy** (`services/outboundPolicy.ts`) — gates agent-initiated outreach with
  rate limits, quiet hours, and claim guards; not-allowed sends are held pending approval.
- **SSRF guards** — outbound HTTP is IP-pinned and blocks private ranges by default.

---

**Next:** [07 · Agent-Native Core →](./07-agent-native-core.md)
