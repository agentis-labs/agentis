# CONNECTIONS — one honest surface for external capability

> **Status:** PLAN → implementing · **Date:** 2026-07-02 · **Owner:** platform
> **Trigger (operator, verbatim):** "this whole thing is confusing and no sense… 3 overlapping [surfaces]… the wrong configurations for every type of integration should be individually thought and tested if the connections it's functional actually… it said success without even knowing if it's connected."
> **The operator is right on every point.** This is a cleanup + honesty pass, not a feature.

---

## 0. Ground truth (verified in code 2026-07-02)

**The catalog is ~73% not-runnable-out-of-the-box.** `packages/integrations/src/manifests.ts` ships **98 connectors**. **~27 actually run**: 7 hand-written (`http_request, webhook_send, slack, gmail, agentmail, github, google_sheets`) + **20 templated HTTP** (`SERVICE_TEMPLATES` — real REST calls incl. **supabase, notion, linear, stripe, jira, hubspot, zendesk, twilio, shopify, openai, anthropic…**). The other **~71 fall back to a GENERIC HTTP connector that THROWS unless the caller supplies a URL** — effectively non-functional as a one-click integration. The registry already computes this (`connectorReadiness` → `runnable | needs_setup`) and the API tags it — **but the web UI ignores the tag and renders all 98 identically**, and the workflow build never warns. So an operator drops a `needs_setup` connector, gets "built successfully", and discovers the failure only at run time. Even a *runnable* one (Supabase) can look wrong if the running web build predates the templated-contract wiring — the recurring stale-process trap. That is the reported experience.

**Three overlapping surfaces, no coherent story:**
| Surface | What it is | Verifies connection? |
|---|---|---|
| Settings → **Integrations** + `integration` node | the 98-connector catalog (7 real) | native `/:id/test` exists for the real ones; never surfaced on connect |
| Settings → **Connections** → External MCP servers + `mcp` node | mount an MCP server (URL+secret) | **NO** — save = "success", never handshakes |
| (the two node kinds `integration` vs `mcp`) | two ways to call an external tool | — |

**The MCP client is HTTP-only** (`mcpClient.ts` streamable-HTTP) — no stdio. Fine for hosted servers (Supabase/GitHub/Notion all have HTTP MCP), a real limit for local stdio servers (documented, not fixed here).

---

## 1. The honest model — ONE concept: a Connection

External capability is reachable two ways, and the platform should say which, truthfully:

1. **Native connector** — real code, typed operations, best UX. The 7. (More can graduate over time.)
2. **MCP server** — the general path: any service with an MCP server becomes real, no bespoke code. This is why the MCP plane is the right general answer.

**A `manifest_only` connector is a catalog aspiration, not a capability.** The fix is not to fake-implement 91 connectors (wrong, months) — it is to **tell the truth** and **route to the working path (MCP)**, while making that path (a) pre-populated by a catalog and (b) verified before it ever claims success.

Rules the cleanup enforces:
- **No green without a handshake.** A mount is not "connected" until `tools/list` succeeds; a native connect surfaces its `test` result.
- **The catalog cannot lie.** Every connector card shows its real state: `Native` (works), or `Via MCP` (mount its server), or `Catalog only` (no runtime, no known MCP — honestly greyed).
- **The workflow build cannot lie.** An `integration` node on a `manifest_only` service is a build WARNING that names the real path ("Supabase has no native runtime — connect its MCP server and use an `mcp` node").
- **One home.** "Connections" is the umbrella; native integrations and MCP mounts are two provider types under it, cross-linked (a provider offers "Connect natively" and/or "Connect via MCP").

---

## 2. Slices (this wave — each shippable + TESTED)

- **C1 Verify, don't assume** *(the load-bearing honesty fix)*: `POST /v1/mcp-servers/:id/verify` → really runs `tools/list` (vault-resolved headers, SSRF-guarded) and returns `{ ok, toolCount, tools?, error? }`. The mount UI runs it on mount and on demand; a server row shows a live **Verified ✓ / Failed** state with the tool count or the raw error — never a silent "success".
- **C2 Pre-defined MCP catalog** *(the "predefined options" ask)*: `GET /v1/mcp-servers/catalog` → a curated list of known HTTP MCP servers (Supabase, GitHub, Notion, Linear, Context7, DeepWiki, Hugging Face…) with `{ id, name, url, authType, authHint, docsUrl }`. The mount UI becomes "pick a provider (or Custom)" → URL + auth prefilled, not a blank box.
- **C3 The catalog can't lie**: the integrations list carries each connector's real `runtime` + a `connect` hint (`native` | `mcp:<catalogId>` | `none`). The Integrations panel + node picker render `Native` / `Via MCP` / `Catalog only` honestly.
- **C4 The build can't lie**: `analyzeWorkflowReadiness` (and thus `build_workflow`) emits a warning for an `integration` node whose service is `manifest_only`, naming the MCP path. So "success" is never silent about a dead connector.
- **C5 Fences**: verify endpoint (ok + failure); catalog endpoint; readiness manifest_only warning; the connector-state classifier.

**Deferred (documented, honest):** stdio MCP transport; auto-implementing native connectors; a full merged single-tab Connections IA (this wave cross-links + labels rather than physically merging the tabs, to stay low-risk); OAuth-discovery for MCP mounts (wave-2 credential path already covers token/OAuth-credential mounts).

---

## 3. Implementation Log
*(Append per shipped slice — [[feedback_masterplan_log]].)*
- **2026-07-02 — PLAN authored.** Ground truth: ~27/98 connectors runnable (7 hand-written + 20 templated); ~71 generic-HTTP fallbacks that throw; no connection verification for MCP; UI renders all connectors identically; the operator's "success without knowing" is a true, reproducible defect.
- **2026-07-02 — C1–C5 SHIPPED** (api+web tsc clean; web build green; 21 tests green incl. verify/catalog routes + the two honesty-warning cases).
  - **C1 Verify**: `POST /v1/mcp-servers/:id/verify` really runs `tools/list` (vault-resolved, SSRF-guarded), returns `{ ok, toolCount, tools?, error? }` (200 even on a reachable-but-failing server — a UI state). The mount panel verifies every server on load + on mount + on demand; a `VerifyBadge` shows **Connected · N tools** / **Not connected — <error>** / **Verifying…**. No server ever shows healthy without a real handshake.
  - **C2 Catalog**: `services/mcpServerCatalog.ts` (Supabase, GitHub, Notion, Linear, Stripe, Context7, DeepWiki, Hugging Face — real hosted HTTP endpoints, each with url + authType + authHint + docs + `connectorService` cross-link) → `GET /v1/mcp-servers/catalog`. Mount panel gained a **Quick connect** chip row: pick a provider → URL + auth prefilled; "Custom" for anything else.
  - **C3 Can't-lie UI**: the integrations list already carried `readiness` (`runnable | needs_setup`) — the web now RENDERS it (an amber **"Needs setup"** pill with a tooltip steering to the MCP path) on both the Integrations settings cards and (type extended) the node picker. `lib/connections.ts` gained `verifyMcpServer`/`listMcpCatalog`; `lib/integrations` + `IntegrationManifestLite` gained `readiness`.
  - **C4 Can't-lie build**: `analyzeWorkflowReadiness` (→ `build_workflow`) now flags an `integration` node on a CATALOGED-but-`needs_setup` connector — "no native runtime yet — connect its MCP server (Settings → Connections → <Name>) and use an mcp node", or "catalog-only … prefer http_request/mcp". Gated on the connector being a known built-in (unknown/custom take the credential path; runnable ones like supabase are never flagged).
  - **C5 Fences**: catalog route, verify-failure route, and both readiness honesty cases (postgres flagged; supabase not).
  - The 3-surface confusion is now cross-linked + honest (native vs MCP per provider, verified before claiming success) rather than physically merged — the low-risk cleanup. Physically merging the two settings tabs + stdio MCP transport remain documented follow-ups.
- **2026-07-02 — Settings IA split** (web tsc + build green): the old "Connections" tab (gateways + channels + MCP all crammed together) is split. **Channels** (`MessageSquare` icon) = gateways + inbound messaging + channel identities (what it always really was). **MCP** (`Boxes` icon) is its own subpage = `McpConnectionsPanel` alone (mounts are their own concern, not messaging). `SettingsTab` type: `connections`→`channels` + new `mcp`; `LiveStrip` gateway-status links now open `channels`; the in-tab heading is "Gateways & channels". **Node redirect**: the `mcp` node's empty state gained a "Mount an MCP server →" button that opens Settings → MCP (`setSettingsOpen(true, 'mcp')`), mirroring how the integration node links to Settings → Integrations. `AgentDetailPage`'s own `connections` sub-tab is unrelated and untouched.
