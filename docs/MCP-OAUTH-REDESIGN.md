# MCP CONNECT — spec-compliant OAuth + per-provider auth

> **Status:** PLAN → implementing · **Date:** 2026-07-02 · **Owner:** platform
> **Trigger (operator):** "what's the sense of having MCP and need to create an integration… the default 'Secret name / Secret value' is not serious engineering. Every MCP should have their own specific camps… I tried to insert supabase and didn't work, it does not have the right form or an oauth redirection."
> **All true.** The generic secret box + reusing integration credentials + no OAuth = wrong. This redesigns MCP connect to the actual MCP Authorization spec (2025-06-18).

---

## 0. What the MCP spec actually requires (researched 2026-07-02)

MCP servers are OAuth 2.1 **resource servers**. The client flow ([modelcontextprotocol.io/specification/2025-06-18/basic/authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)):

1. Hit the server unauthenticated → **`401` with `WWW-Authenticate`** pointing to the **Protected Resource Metadata** (PRM, RFC9728) — or fall back to `{origin}/.well-known/oauth-protected-resource`.
2. Fetch PRM → `authorization_servers[]`.
3. Fetch **Authorization Server Metadata** (RFC8414, `/.well-known/oauth-authorization-server`) → `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.
4. **Dynamic Client Registration** (RFC7591) at `registration_endpoint` → a `client_id`, *no pre-made OAuth app*.
5. **Authorization Code + PKCE** (RFC7636, mandatory) with **Resource Indicator** (RFC8707 = the server URL) → redirect → callback → exchange code → `access_token`.
6. `Authorization: Bearer <token>` on every request.

**So for an OAuth server the operator types NOTHING** — clicks "Connect with Supabase", approves in a popup, done. Only token-auth servers (GitHub PAT, Stripe key) take a value — and then a **provider-specific labeled field**, never generic "Secret value".

---

## 1. Redesign

**Per-provider auth, driven by the catalog `authType`:**
| authType | Form | Backend |
|---|---|---|
| `oauth` | **"Connect with {Name}"** button — popup, no fields | full spec flow: discover→DCR→PKCE→callback→vault token, auto-linked to the mount |
| `token` | ONE field, provider-labeled (`GitHub Personal Access Token`) + a "get it here" link | vault secret `mcp_token_<id>` → Bearer, auto-linked |
| `header` | provider-labeled header field(s) | vault JSON-headers, auto-linked |
| `none` | nothing | — |

**Kill the confusion:** no more "pick an integration credential (AgentMail…)" dropdown for a catalog mount. MCP credentials are their own type (`mcp_oauth_*` / `mcp_token_*`), minted by the mount flow, never shared with the connector catalog. The generic name/value box survives ONLY behind an explicit "Custom (advanced)" server.

---

## 2. Slices

- **O1 Backend OAuth service** `mcpOAuthService.ts`: `discover(url)` (401→PRM→AS-metadata, with well-known fallbacks), DCR (RFC7591, public client, `token_endpoint_auth_method:none`), PKCE + state (single-use, TTL, carries code_verifier/client_id/token_endpoint/resource/serverId/ws), `exchange(state, code)`.
- **O2 Route** `/v1/mcp-oauth`: `POST /:serverId/authorize` (auth → `{ url }`), `GET /callback` (public → exchange, mint `mcp_oauth_<serverId>` vault credential, set `server.credentialId`, close-popup HTML postMessage). Reuses the `closePage` pattern from `routes/oauth.ts`.
- **O3 McpClient 401 surfacing**: capture `WWW-Authenticate` / status so `discover` and `verify` report "needs authorization" distinctly from "unreachable".
- **O4 Frontend**: mount form becomes catalog-driven — `oauth`→Connect button (mounts unauthed, then runs O2 in a popup, re-verifies on return); `token`/`header`→provider-labeled field(s) that auto-mint the vault secret; `none`→nothing. Custom stays as the escape hatch. Remove the integration-credential dropdown.
- **O5 Fences**: discovery (mock 401+PRM+AS metadata + DCR + token exchange end-to-end with an injected fetch); state single-use/TTL; catalog-driven form logic.

**Deferred (honest):** confidential-client (secret) DCR; refresh-token auto-rotation on 401; stdio transport; servers that implement neither PRM nor well-known (surfaced as a clear "this server doesn't advertise OAuth — use a token or Custom").

---

## 3. Implementation Log
*(Append per shipped slice — [[feedback_masterplan_log]].)*
- **2026-07-02 — PLAN authored** after researching the MCP 2025-06-18 auth spec (PRM/RFC9728, AS-metadata/RFC8414, DCR/RFC7591, PKCE/RFC7636, Resource Indicators/RFC8707). Existing `oauthService` is pre-registered-provider only; MCP needs discovery+DCR, so a dedicated service — reusing vault + close-popup + state patterns.
- **2026-07-02 — O1–O5 SHIPPED** (api+web tsc clean; web build green; 4 OAuth-flow + 9 MCP route/secret tests green).
  - **O1 `services/mcpOAuthService.ts`** — the full spec flow: `discover(url)` (POST-probe → `401`+`WWW-Authenticate resource_metadata` → PRM, else `/.well-known/oauth-protected-resource{path}` fallback → `authorization_servers` → AS metadata at `/.well-known/oauth-authorization-server` | `openid-configuration`), DCR (RFC7591, `token_endpoint_auth_method:none` public client), PKCE (S256) + single-use/TTL state carrying code_verifier/client_id/token_endpoint/resource, `exchangeCode` (with `code_verifier` + `resource` RFC8707). SSRF-guarded + timeouts throughout; returns `null` (not a throw) when a server doesn't advertise OAuth so the UI can steer to token/Custom.
  - **O2 `routes/mcpOAuth.ts`** — `POST /v1/mcp-oauth/:serverId/authorize` (auth → `{ url }`), `GET /v1/mcp-oauth/callback` (public → exchange → mint `mcp_oauth_<serverId>` vault credential → set `server.credentialId` → close-popup `postMessage`). Wired in bootstrap with `AGENTIS_PUBLIC_URL` as the redirect base.
  - **O4 Frontend** — the mount form is now catalog-driven per `authType`: **oauth** → "Connect & mount" (mounts then runs the popup, re-verifies on return, zero fields); **token/header** → ONE provider-labeled field (`Supabase token`, "Where do I get this? →") that auto-mints a `mcp_token_*`/`mcp_header_*` vault secret; **none** → nothing; **Custom** → free name/url + generic secret (the only place the generic box survives). The confusing integration-credential dropdown (AgentMail…) is GONE — MCP credentials are their own type, never shared with the connector catalog.
  - **O5 Fences** — `mcpOAuthService.test.ts`: PRM→AS discovery, DCR→PKCE authorize URL bound to the resource, single-use state, code→token exchange, and the no-OAuth→null path.
  - Deferred (documented): refresh-token auto-rotation, stdio, servers with neither PRM nor well-known (surfaced as a clear error, not a guess).
- **2026-07-02 — Streamable-HTTP session handshake** (operator: OAuth succeeded but "MCP server returned 400 for tools/list"; api tsc clean; mcpClient 5 tests green incl. the new handshake case): per the transport spec, a server MAY return `Mcp-Session-Id` on the `initialize` response and then **400s any later request lacking it**, and `MCP-Protocol-Version` is required on every post-init request. `McpClient` fired `tools/list` standalone — no init, no session, no version header → Supabase 400. Rewrote it session-aware: lazy `#ensureSession` (POST `initialize` → capture `Mcp-Session-Id` + negotiated `protocolVersion` → send `notifications/initialized`), and `#send` now stamps `mcp-protocol-version` on every request + `mcp-session-id` on all post-init ones; 4xx bodies are surfaced (not a bare status). `initialize`/`listTools`/`callTool` all establish the session first. (Confirmed against modelcontextprotocol.io/specification/2025-06-18/basic/transports §Session Management + §Protocol Version Header.)
- **2026-07-02 — two live-flow fixes** (api tsc clean; 10 OAuth tests green):
  - **Callback auth-scope bug** (operator: "AUTH_TOKEN_INVALID: Missing bearer token"): the public `/callback` was caught by a wildcard `use('*', requireAuth)` sub-app mounted at `/`, so the provider's browser redirect (no bearer) 401'd. Switched to PER-ROUTE middleware like `oauth.ts` — `/:serverId/authorize` authed, `/callback` public. Fence `tests/routes/mcpOAuth.test.ts` (4): callback public / provider-error / authorize-401 / authorize-404.
  - **Confidential-client 422** (operator: "token endpoint returned 422"): researched → Supabase's DCR returns a `client_secret` while omitting `token_endpoint_auth_method`, so a public-client token exchange (no secret) gets 422 "Required parameter: client_secret". `#registerClient` now returns `{ clientId, clientSecret? }`, the state carries the secret, and `exchangeCode` sends `client_secret` (client_secret_post) when present. Also `tokenErrorMessage` now reads non-standard bodies (GoTrue `msg`/`error_code`/`message`, raw text) so a failure shows the REAL reason, never a bare status. Fences: confidential-client exchange + non-standard-error-body.
