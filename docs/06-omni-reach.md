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

Channel health checks are read-only: pressing **Test connection** validates credentials,
transport, routing, inbound readiness, and runtime availability without sending a message.
An actual outbound test is an explicit channel send.

For WhatsApp QR sessions, the id returned by `sendMessage()` is initially only a client
correlation id. Agentis records that attempt as `queued` and does not report `sent:true`
or advance workflow state until a WhatsApp server acknowledgement arrives. Later server,
delivery, and read receipts promote the durable journal to `accepted`, `delivered`, and
`read`. Requested, provider-resolved, and provider-echoed recipients remain separate in
the receipt so canonical number resolution is visible without being mistaken for proof.
| Voice | webhook ingress | transcription in, TTS reply buffer out |

Rich attachments and per-channel access control are supported; peer identity is resolved
across channels. Inbound messages are durably queued (`channel_turn_queue`) and dispatched to
the responsible agent/subject.

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
