# MCP CAPABILITY PLANE — mount once, use everywhere

> **Status:** PLAN → implementing · **Date:** 2026-07-02 · **Owner:** platform
> **Trigger:** operator hit "upload to Supabase" with no integration available and had to paste keys into an agent prompt. Reference UI (n8n/Gumloop-class) shows provider-logo nodes + typed outputs. Mandate: don't bolt on a Supabase connector — design the general organ.
> **Thesis:** external capability enters Agentis **exactly once** — as a **mounted MCP server** with **vault-held secrets** — and is then usable from **every plane** with zero re-configuration: deterministic workflow nodes, every agent's own reasoning loop, chat, and the authoring grammar. Supabase is just the first tenant (mount `supabase-mcp`; done).

---

## 0. Ground truth (verified 2026-07-02)

What already exists — this plan is mostly **wiring, not building** ([[feedback_no_duplication]]):

| Piece | State |
|---|---|
| Mount a server | ✅ `POST /v1/mcp-servers` (workspace_kv `mcp:servers`), live `tools/list` + `call` via `McpClient` |
| Agent loop reach | ✅ `McpToolBridge` bridges every server's tools (`mcp__*`) into in-process sessions; `agentis.mcp.list`/`agentis.mcp.call` are **mcpExposed** so chat + external harnesses reach them too |
| Deterministic node | ✅ **`mcp` node kind is fully implemented in the engine** (`#executeMcp` → bridge.call, activeExecutions, template-resolved args, outputKey) |
| Authoring | ❌ ZERO wiring: not in the palette, no sidebar form, not in the node-kind grammar — neither humans nor agents can author it |
| Secrets | ❌ server auth headers live **in plaintext** workspace_kv (redacted on read, but at rest unencrypted, and the alternative operators used was worse: keys pasted into agent prompts) |
| Node UI | ❌ nodes are glyph-only; no provider identity (reference-UI gap); agent outputs (`outputKeys`) have no editor |

## 1. The four planes (the design)

1. **Secrets plane** — a mounted server references a **vault credential** (`credentialId`). At call time the credential is decrypted and merged into headers (JSON object → headers verbatim; bare string → `Authorization: Bearer <v>`). Inline headers remain supported (back-compat) but the vault is the paved road. Keys never appear in prompts, node configs, or plaintext KV.
2. **Deterministic plane** — the `mcp` node: one tool, template-mapped `arguments`, `outputKey`. "Insert row into Supabase" is a *node*, subject to the same gates/dry-run/couplings as everything else — not an agent errand.
3. **Agentic plane** — the *same* mounted tools ride every agent loop (bridged `mcp__*` in sessions; `agentis.mcp.list/call` everywhere else), so an agent can *decide* mid-task to query Supabase for context. Deterministic when the step is known; agentic when judgment is needed — same mount, no second config.
4. **Authoring plane** — the grammar advertises the `mcp` kind + the workspace's mounted servers, so `build_workflow` synthesis and agents author mcp nodes deterministically (Iron-Rule "determinism first" now has a universal escape hatch for any service with an MCP server — which today is nearly everything).

## 2. Implementation slices (this wave)

- **S1 Secrets**: `McpServerConfig.credentialId` + `resolveMcpServerHeaders(db, vault, server)` in `mcpServerStore`; used by `McpToolBridge` (new optional `vault` dep) and the `/v1/mcp-servers/:id/{tools,call}` routes; registration accepts `credentialId`; bootstrap wires the vault.
- **S2 Discovery for authoring**: `GET /v1/mcp-servers/bridge/tools` — the bridge's namespaced tool list (id + server + description + inputSchema) for the sidebar picker and any client that must construct exact `toolId`s.
- **S3 Grammar**: `mcp` joins the node-kind list in `PLATFORM_KNOWLEDGE`; an Iron-Rule-adjacent clause ("a service without a native connector but with an MCP server = mcp node, never keys-in-prompt"); the MCP server-instructions family map gains the node.
- **S4 Web**: palette + `nodeKindMeta` entry; `McpForm` (server picker → live tool picker → templated args + outputKey); readiness (`toolId` required); **node identity visuals** (`WorkflowNode` shows the MCP tool's server + tool name; extension/integration operation labels stay); **typed outputs editor** — `outputKeys` pill editor with "+ Add output" on agent forms (reference-UI parity).
- **S5 Fence**: engine test — an `mcp` node executes through a fake bridge and lands `outputKey`; vault-resolution unit test; tsc + web build.

**NOT in this wave** (documented): OAuth flows for MCP mounts; per-tool scoping/allowlists on a mount; canvas logos fetched per provider brand (node identity ships as server/tool text + glyph now — the logo pipeline (`connectorLogos.generated.ts`) can join later); marketplace-style server catalog.

## 3. Implementation Log
*(Append per shipped slice — [[feedback_masterplan_log]].)*
- **2026-07-02 — PLAN authored.** Ground truth verified in code; the engine half already existed unwired (the platform-wire-gap class).
- **2026-07-02 — S1–S5 SHIPPED** (core untouched; api+web tsc clean; web build green; new `mcpServerSecrets.test.ts` + existing `WorkflowEngine.mcpNode.test.ts` + `mcpServers` route tests green).
  - **S1 Secrets plane:** `McpServerConfig.credentialId` + `resolveMcpServerHeaders(db, vault, ws, server)` (JSON credential → headers verbatim, vault wins over inline; bare token → `Authorization: Bearer`; failures return a NAMED `credentialError`, never throw). Consumed by `McpToolBridge.#client` (new `vault` dep, wired in bootstrap) and by the `/v1/mcp-servers/:id/{tools,call}` routes (a broken credential throws `INTEGRATION_CREDENTIAL_MISSING` with the server name). Registration accepts `credentialId`.
  - **S2 Discovery:** `GET /v1/mcp-servers/bridge/tools` — the bridge's namespaced list (`mcp__<slug>__<tool>` + inputSchema), registered BEFORE `/:id/*`; bootstrap passes the bridge into the routes.
  - **S3 Grammar:** `mcp` joined the node-kind list in `PLATFORM_KNOWLEDGE`; Iron Rule 3 extended (no-connector-but-MCP-server → mount once + `mcp` node, tools also live in every agent loop, NEVER keys-in-prompt); `AGENTIS_MCP_SERVER_INSTRUCTIONS` gained the `mcp` family line (external harnesses learn it at initialize).
  - **S4 Web:** palette entry ("MCP Tool", Data & logic) + `nodeKindMeta`; `McpForm` in ContextInspector — server-grouped tool picker fed by `/bridge/tools` (exact ids, never hand-assembled), tool description + inputSchema hints (required-arg markers), templated Arguments JSON, outputKey; readiness = `toolId` required; canvas node cards now show **provider identity as the subtitle** — mcp → `server · tool` (parsed from toolId), integration → `service · operation` (data plumbed at the node-build site); **typed Outputs pill editor** (`OutputKeysField`, "+ Add output", Enter/comma/blur commit, dedup, remove-×) on agent_task/agent_session forms — the output contract made visible/editable (reference-builder parity).
  - **S5 Fences:** vault-resolution unit test (JSON/token/merge/missing/no-cred paths). The deterministic-plane engine test already existed (`WorkflowEngine.mcpNode.test.ts`) — verified green with the bridge's new signature.
  - NOT built (per plan): OAuth mounts, per-tool allowlists, brand-logo pipeline on canvas cards (identity ships as text), server catalog UI.

## 4. Wave 2 — mounts ARE integrations (operator ask)

MCP mounts belong to the Integrations surface, managed like any connector. Ground truth: `McpConnectionsPanel` already exists in Settings (name/url/headers only — no vault, no OAuth, no allowlists), `connectorLogo` already bundles real brand SVGs (incl. `supabase`), and OAuth flows already mint `oauth_<slug>` credentials (a JSON token bundle) into the vault.

- **W1 Per-tool allowlists**: `McpServerConfig.allowedTools` — the bridge lists/executes ONLY allowlisted tools when set (empty/absent = all); REST `:id/call` enforces it too; `PATCH /v1/mcp-servers/:id` updates `allowedTools`/`credentialId`/`allowPrivateNetwork`.
- **W2 OAuth mounts**: `resolveMcpServerHeaders` understands OAuth token bundles — a JSON credential carrying `accessToken`/`access_token` resolves to `Authorization: Bearer <token>` (JSON-of-headers behavior unchanged). An "OAuth mount" = connect the provider via the existing OAuth flow, pick that credential on the mount. (Full MCP-spec OAuth discovery/dynamic registration stays out.)
- **W3 Mount management UI**: upgrade `McpConnectionsPanel` — auth section (none / vault credential picker incl. OAuth-minted ones / inline "create secret" via POST /v1/credentials), and a per-server **Tools manager** (live tools → checkboxes → PATCH allowlist).
- **W4 Brand logos on canvas cards**: the node icon tile renders the bundled brand SVG — integration → `connectorLogoUrl(integrationId)`, mcp → logo matched from the server slug in `toolId` (`mcp__supabase__…` → supabase.svg) — glyph fallback, no broken-img flash.
- **W5 Fences**: bridge allowlist filter + call guard; OAuth-bundle resolution; PATCH route.

- **2026-07-02 — W1–W5 SHIPPED** (api+web tsc clean; web build green; 10 MCP-plane tests green: secrets/OAuth/allowlist/PATCH/engine-node/session-bridge).
  - **W1**: `McpServerConfig.allowedTools`; the bridge filters `tools/list` (allowlist in the cache key so a PATCH applies immediately) — a hidden tool "does not exist" for agents, `mcp` nodes, and REST (`:id/call` guard, named error). `PATCH /v1/mcp-servers/:id` updates `allowedTools`/`credentialId`/`allowPrivateNetwork` (null clears); name/url immutable.
  - **W2**: `resolveMcpServerHeaders` understands OAuth token bundles — JSON with `accessToken|access_token` → `Authorization: Bearer` (bundle fields like refreshToken NEVER leak as headers). OAuth mount = connect the provider (existing flow mints `oauth_<slug>` into the vault) → pick that credential on the mount.
  - **W3**: `McpConnectionsPanel` upgraded — mount form gains an Authentication select (none / any vault credential with OAuth-minted ones labeled / inline "create secret" via POST /v1/credentials type `mcp`, password field, JSON-or-token); server rows show a vault lock badge + allowlist count; the Tools view became a **Tools manager**: live checkboxes → Save allowlist (all-checked = no allowlist → future tools included). `lib/connections.ts` gained `updateMcpServer` + the new fields.
  - **W4**: canvas node icon tiles render the **bundled brand SVG** (integration → `connectorLogoUrl(integrationId)`; mcp → the server slug parsed from `toolId`, e.g. `mcp__supabase__…` → supabase.svg) with glyph fallback on missing asset/broken img.
  - Operator notes: the `mcp` node's config form was already wired last wave (`McpForm`) — "no configuration option" reports were the running web/app processes predating the build; both API and web need a restart/rebuild. Mount management lives in **Settings → the MCP/Connections panel** — mounts ARE the integration surface for MCP-class services.
