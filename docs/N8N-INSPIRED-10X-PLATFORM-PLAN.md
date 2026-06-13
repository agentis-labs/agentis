# Agentis 10× Platform Strategy: Lessons From n8n

> **Research basis:** Deep codebase audit of `C:\Users\antar\OneDrive\Documentos\n8n` (307 integration nodes, 48 `@n8n` scoped packages) against the current Agentis stack (`apps/api`, `apps/web`, `packages/{core,db,integrations,sdk}`).
>
> **Authorship rule:** Everything proposed here is re-engineered as a native Agentis capability. n8n is the *inspiration source*, not a dependency or a brand name. Zero external runtime couplings.

---

## Part 0 — Current State Diagnosis

### 0.1 What Is Working

| Area | Status |
|------|--------|
| `packages/integrations` — 70 manifests, 4 live connectors (Slack, GitHub, Gmail, Google Sheets, AgentMail) | ✅ Solid foundation |
| `OAuthService` + `/v1/oauth/:provider/callback` popup flow | ✅ Code is correct |
| `ConnectorRegistry` — typed, minimal, extensible | ✅ Architecture is clean |
| `CredentialVault` — encrypted at rest, timing-safe comparisons | ✅ Secure |
| Workflow engine (`WorkflowEngine.ts`, `LedgerService`, `PartialReplayService`) | ✅ Durable, journaled |
| Multi-agent chat, canvas, node palette | ✅ Functional |

### 0.2 What Is Broken / Missing — RECONCILED AGAINST REAL CODE (2026-06-05)

> ⚠️ **The original draft of this section was largely wrong.** A direct audit of the
> current `apps/api`, `apps/web`, and `packages/integrations` shows the engine and
> canvas are far ahead of the "diagnosis" the user (correctly) suspected was off.
> Most of the seven "problems" below are already built. The table corrects each,
> and the rest of the document is re-scoped to the *actual* remaining gaps.

| Claimed problem | Reality (verified) | What's actually left |
|-----------------|--------------------|----------------------|
| **P1 — OAuth buttons don't appear** | **Now mostly fixed.** `IntegrationForm` is driven by manifest auth type, `/v1/oauth/providers` returns the full provider catalog, and `AGENTIS_OAUTH_PROXY_URL` mode now makes providers report `configured: true` without local `OAUTH_*` env. Self-managed clients still override the proxy per provider. | The public Connect proxy deployment itself (provider secrets, quotas, verification, hardening) remains operational work; the Agentis instance-side flow is shipped. |
| **P2 — Most integrations `manifest_only` → throw** | **Corrected.** `manifest_only` services still fall back to `genericHttpConnector` when unknown, but many common services now have concrete URL/auth/body templates. | Keep expanding templates and bespoke adapters for non-trivial APIs; see §1.3 and Implementation Log. |
| **P3 — No credential flow for API-key integrations** | **False, and now more true than before.** `IntegrationForm` supports inline credential creation, existing-credential reuse, OAuth popup wiring, and multi-field credential schemas (not just the first token field). | Credential UX polish: validation hints per field and service-specific help text. |
| **P4 — No triggers / webhooks** | **False.** `engine/TriggerRuntime.ts`, `engine/triggerConnectors.ts` (HMAC verification for **github, slack, linear, stripe, typeform, gmail**), `engine/ListenerRuntime.ts` + `engine/listener/*` (sources/predicate/firePolicy/cursor/jsonpath/agentJudge/health), and routes `/v1/triggers`, `/v1/webhooks`, `/v1/listeners` all exist. `trigger` is a first-class node kind. | Polling-trigger dedup polish; more connector event maps. Core is built. |
| **P5 — No expression language / data mapping** | **Runtime + inline syntax now exist.** `safeExpression.ts` is a sandboxed evaluator and `templateResolver.ts` now supports `{{= expr }}` in arbitrary fields with `$json`, `$input`, `$nodes`, `$trigger`, `$scratchpad`, `$store`, `$workspace`, `$run`, and `$loop`. Exact expression fields can resolve to typed values. | Monaco/editor ergonomics, autocomplete, and deeper AST validation remain. |
| **P6 — No computer-use / browser automation** | **Partly true.** `browser` is a first-class node kind backed by `services/browserPool.ts` (Playwright pool). | No local-bridge daemon (user's own machine), no standalone browser-MCP server exposing 32 tools. Node-level browser exists. |
| **P7 — No evaluation framework** | **False.** `evaluator` **and** `guardrails` are first-class node kinds; `services/evaluatorRuntime.ts` backs them. | No dataset/metrics harness (`EvalDataset`/`EvalCase`/runner) + `/v1/evals` routes for batch scoring. Inline eval/guardrail nodes exist. |

**Net:** the headline user complaint ("integrations show up but don't actually work") traces to **P2**, not P1/P3. The OAuth UI and inline credential form are already shipped; what was missing was the per-service request templating that turns a bound credential into a working API call. That is the gap closed in this round.

---

## Part 1 — Integrations Overhaul

### 1.1 Fix the OAuth "doesn't appear" bug — Hosted OAuth Proxy

**The core problem:** Requiring operators to register their own OAuth apps with Google, Slack, etc. is a 30-minute setup barrier. n8n Cloud works around this by operating shared OAuth apps on behalf of all users. Agentis (open-source, self-hosted) needs a cleaner path.

**Proposed solution — Two-mode OAuth:**

```
Mode A: Self-Managed (override, power users / air-gapped)
  Operator sets OAUTH_GOOGLE_CLIENT_ID + OAUTH_GOOGLE_CLIENT_SECRET
  → /v1/oauth/providers reports google.configured = true
  → Canvas shows "Sign in with Google" button; instance does its own token exchange

Mode B: Hosted Connect Proxy (DEFAULT for both hosted + open-source)
  AGENTIS_OAUTH_PROXY_URL=https://connect.agentis.dev  (default, opt-out)
  → proxy holds the ~6 shared OAuth apps centrally
  → operator AND end-user need ZERO setup; nothing is ever shown to the user
```

#### 1.1.1 The model — a credential broker, not per-instance config

The headline product requirement (2026-06-05): **Agentis ships as both an
open-source project and a hosted product, and neither should ask the user — or
even the operator — to configure OAuth.** The end user must only ever see
"Sign in with Google."

The only way to deliver that is to move the OAuth *app secrets* out of every
instance and into **one shared "Connect" service** that both the hosted product
and self-hosters point at — the same pattern as n8n Cloud, Composio, and Nango.

```
End user (workspace)            Agentis instance              Connect proxy (1 deploy)
  click "Sign in with Google" ─▶ /oauth/google/start ───────▶ holds the ~6 shared
                                                               OAuth apps' client secrets
        browser ◀── authorize URL (proxy's redirect_uri) ◀────┘
  approve on Google ──────────────────────────────────────▶ proxy /callback
                                                               exchanges code→tokens
  popup closes ◀── encrypted token POSTed back ◀──────────── to instance, vault-stored
```

**Why this collapses the burden:**
- Secrets are set **once, centrally, by whoever runs the proxy** — never per
  instance, never per integration, never shown to end users.
- OAuth is per **provider**, not per connector. One Google app covers Gmail +
  Sheets + Calendar + Drive. The proxy holds **~6 apps total** (`google`, `slack`,
  `github`, `notion`, `linkedin`, `twitter_x`), not 70.
- Every **non-OAuth** service (Notion bearer, Airtable PAT, Stripe key, …)
  already authenticates with an inline API key — zero OAuth, zero env. AgentMail
  is the zero-config email default, so "email me" never needs Gmail OAuth.

#### 1.1.2 Hosted vs open-source — both zero-config

- **Hosted Agentis:** the cloud deploy bakes `AGENTIS_OAUTH_PROXY_URL` → the
  Agentis-operated proxy. Users click and go.
- **Open-source self-host:** `AGENTIS_OAUTH_PROXY_URL` **defaults to the public
  Agentis proxy** (opt-out). A fresh `git clone` gets working OAuth out of the
  box, borrowing the shared apps (like Composio's free tier). A self-hoster who
  wants full independence points it at their own proxy deploy, or sets their own
  `OAUTH_*_CLIENT_ID/SECRET` (Mode A override). No middle state requires user config.

#### 1.1.3 Trust / security rules the proxy MUST enforce

This is a security-critical surface — shared OAuth apps minting tokens that land
on arbitrary instances. Non-negotiable rules:
1. **Signed state + PKCE.** Each handshake is bound to the requesting instance +
   workspace + a one-time nonce; tokens are delivered **only** to the originator.
2. **Instance identity.** Each instance presents a key (hosted instances get one
   automatically; OSS gets a free issued key or runs its own proxy) so third
   parties can't burn the shared provider quota.
3. **Tokens transit the proxy only momentarily**, are returned to the instance
   over an authenticated, encrypted channel, and are stored in **that workspace's**
   vault. The proxy persists **no** user tokens.
4. **Provider verification** (Google OAuth app review, etc.) is a one-time
   operational task for whoever runs the proxy — outside the codebase.

#### 1.1.4 Build plan (what lives in this repo)

| Piece | Where | Status |
|-------|-------|--------|
| Instance-side proxy client: `AGENTIS_OAUTH_PROXY_URL` mode in `OAuthService` (providers report `configured` via proxy; `start` routes to proxy; `/v1/oauth/proxy/callback` receives the token relay). Self-managed env stays as override. | `apps/api/src/services/oauthService.ts`, `routes/oauth.ts`, `env.ts`, `bootstrap.ts` | ✅ Shipped 2026-06-05 |
| `allProviders()` with `configured` flag; `/v1/oauth/providers` returns all providers | `oauthService.ts`, `routes/oauth.ts` | ✅ Shipped 2026-06-05 |
| Canvas: OAuth button driven by manifest credential type (`oauth2`) — never an API-key field for OAuth-only services; drop the config-nag when a proxy is active | `apps/web/.../ContextInspector.tsx` | ✅ Shipped 2026-06-05 |
| The **Connect proxy** itself — small Hono service holding the shared apps + PKCE/state signing + token relay | `apps/oauth-proxy` (new) | **TODO** |

**Defaults:** `AGENTIS_OAUTH_PROXY_URL` defaults to the public Agentis proxy
(opt-out via empty string); when a proxy is active the canvas shows the working
sign-in button with no setup text. Mode A (`OAUTH_*_CLIENT_ID/SECRET`) overrides
the proxy for any provider the operator configures locally.

---

### 1.2 Inline Credential Form (n8n-inspired)

> ✅ **ALREADY SHIPPED** (verified and corrected 2026-06-05). `IntegrationForm` in
> `apps/web/src/components/canvas/ContextInspector.tsx` implements the inline
> credential flow, "use an existing connection" reuse, and the OAuth popup branch.
> Earlier wording overstated this as schema-derived: it only saved the first field.
> That gap is now closed — the form renders every `credentialSchema.fields` entry
> and stores one encrypted JSON credential. The text below is historical context.

n8n's credential node opens an inline modal with fields derived from the credential schema. Currently Agentis sends users to `SettingsPage` to create credentials manually.

**Proposed: Inline Credential Wizard**

When an integration node is selected and has no wired credential:
1. Show **"+ Add credential"** inline in the node inspector
2. For `api_key` / `bearer_token` types → open a small modal form (fields from `credentialSchema` in the manifest)
3. For `oauth2` → open the OAuth popup (existing flow, just needs the button)
4. On save, POST `/v1/credentials` and wire the new credential to the node automatically

This eliminates the #1 friction point: users currently can't complete a workflow without leaving the canvas.

---

### 1.3 Expand Live Connectors: Cover the Top 30

**Priority list** (based on n8n's most-used nodes, cross-referenced with our manifest list):

| Priority | Service | Auth | Missing operations |
|----------|---------|------|--------------------|
| P0 | Notion | Bearer | create_page, update_page, query_database |
| P0 | Airtable | Bearer | create_record, update_record, query |
| P0 | Linear | Bearer | create_issue, update_issue |
| P0 | Discord | Bearer | send_message, create_thread |
| P0 | Telegram | Bearer | send_message, send_photo |
| P1 | Stripe | Bearer | create_payment_intent, create_customer |
| P1 | HubSpot | Bearer | create_contact, create_deal |
| P1 | Shopify | Bearer | get_order, update_product |
| P1 | Jira | API Key | create_issue, transition |
| P1 | Trello | API Key | create_card, move_card |
| P1 | SendGrid | Bearer | send_email, create_template |
| P2 | Zendesk | API Key | create_ticket, add_comment |
| P2 | Salesforce | OAuth | create_record, query |
| P2 | Twilio | API Key | send_sms, send_whatsapp |
| P2 | Postgres / MySQL | Conn String | (already manifested, needs full impl) |
| P2 | MongoDB | Conn String | find, insert, update |
| P2 | Supabase | API Key | select, insert, upsert |
| P2 | S3/R2/MinIO | API Key | put_object, get_object |
| P3 | Google Docs | OAuth | create_doc, append_text |
| P3 | Google Drive | OAuth | upload_file, list_files |
| P3 | Zoom | OAuth | create_meeting |
| P3 | Mailchimp | API Key | subscribe, send_campaign |
| P3 | WordPress | API Key | create_post, get_post |
| P3 | Shopify webhooks | Bearer | (trigger node) |
| P3 | GitHub webhooks | Shared Secret | (trigger node) |

**Architecture: `genericHttpConnector` as the 80% solution**

`apiConnectors.ts` already has `genericHttpConnector()`. For services with simple REST APIs and consistent patterns, use it with a URL template layer instead of writing bespoke connector code. This alone covers ~20 of the above in hours, not weeks.

**Current shipped coverage (2026-06-05):**
- Header/bearer/json templates: Notion, Airtable, Discord, HubSpot, Shopify, OpenAI, Anthropic, Typeform, Auth0, Paddle.
- Token-in-URL/form/basic/query/GraphQL variants: Telegram, Stripe, Linear, Trello, Jira, Zendesk, Twilio, Supabase, WordPress.
- Manifest credential schemas were corrected where the inline UI needs multiple fields (`accountSid`/`authToken`, `siteUrl`/`email`/`apiToken`, etc.).
- Still not covered by this template layer: databases (`postgres`, `mysql`, `mongodb`, `redis`), files with binary/multipart semantics (`s3`, Drive upload/download, Dropbox upload), and provider-specific OAuth operations that need bespoke refresh/body handling.

```typescript
// packages/integrations/src/connectors/genericConnectors.ts
export const notionConnector = genericHttpConnector('notion', [
  'create_page', 'update_page', 'query_database', 'append_block'
]);

// Override URL templates via a thin wrapper when needed:
export const notionConnector: ConnectorModule = {
  service: 'notion',
  operations: ['create_page', 'update_page', 'query_database', 'append_block'],
  async execute({ operation, params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    const headers = {
      authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'content-type': 'application/json',
    };
    // ... operation dispatch
  },
};
```

---

### 1.4 Trigger Nodes — Inbound Webhooks & Polling

> ✅ **LARGELY SHIPPED** (verified 2026-06-05). `trigger` is a first-class node kind;
> `engine/TriggerRuntime.ts` + `engine/triggerConnectors.ts` do real HMAC signature
> verification for github / slack / linear / stripe / typeform / gmail; routes
> `/v1/triggers` and `/v1/webhooks` exist; the `engine/listener/*` subsystem
> (ListenerRuntime) adds source/predicate/firePolicy with `/v1/listeners`. Remaining:
> polling-trigger dedup polish and more per-connector event maps. Original proposal
> retained below.

n8n's trigger architecture: every integration can have a **trigger node** variant that *starts* a workflow on external events, not just execute operations in the middle.

**Agentis trigger node architecture:**

```typescript
// packages/core/src/types/workflow.ts — new node kind
export interface WebhookTriggerNodeConfig {
  kind: 'webhook_trigger';
  integrationService: string;   // 'github' | 'stripe' | 'shopify' | ...
  event: string;                // 'push' | 'payment.succeeded' | 'order.created'
  signatureField?: string;      // header name for HMAC signature (e.g. 'x-hub-signature-256')
  secretCredentialId?: string;  // credential holding the webhook secret
}

export interface ScheduleTriggerNodeConfig {
  kind: 'schedule_trigger';
  cron: string;                 // '0 9 * * 1-5' = weekdays at 9am
  timezone?: string;
}

export interface PollingTriggerNodeConfig {
  kind: 'polling_trigger';
  integrationService: string;
  operation: string;            // list operation to poll
  deduplicateKey: string;       // JSON path to unique ID in results
  pollIntervalSeconds: number;
}
```

**Webhook endpoint (new route):**
```
POST /v1/webhooks/:webhookId
  → validates signature
  → resolves workflowId from webhookId
  → enqueues a workflow run with trigger payload
```

**Webhook Response Modes:**
To handle various webhook consumption patterns (inspired by n8n):
- **`onReceived`**: Immediate 200 OK returned on receipt (default).
- **`lastNode`**: Return payload of the final node executed in the workflow path.
- **`responseNode`**: Blocks HTTP response until a specialized "Webhook Response" node executes, returning its custom payload.

**Polling Trigger Deduplication:**
Polling triggers execute at intervals (e.g. via cron/schedule). To prevent processing duplicate items:
- Integrate a key-value store state layer: `checkProcessedAndRecord(service, id)` to record unique IDs.
- Only enqueue workflow runs for newly discovered IDs.

**Priority trigger implementations:**
- `github` — push, PR, issue events (already have GitHub connector)
- `stripe` — payment.succeeded, customer.created
- `slack` — message events via Events API
- `shopify` — order.created, product.updated
- Generic HTTP webhook (any service)

---

### 1.5 The Integration Marketplace Concept

n8n has a community node system. Agentis should have an **integration package registry**:

```
packages/integrations/src/connectors/
  ├── core/           # Shipped by Agentis (HTTP, Webhook)
  ├── productivity/   # Notion, Airtable, Linear, Jira, Trello
  ├── communication/  # Slack, Discord, Telegram, Email
  ├── crm/            # HubSpot, Salesforce, Pipedrive
  ├── payments/       # Stripe, PayPal, Paddle
  ├── data/           # Postgres, MySQL, MongoDB, Supabase, Redis
  ├── ai/             # OpenAI, Anthropic, Replicate
  └── social/         # Twitter/X, LinkedIn, Instagram
```

Each category ships as a lazy-loaded module. Connectors not used by any workflow in the workspace are never imported, keeping startup time flat.

**Community connector protocol** (future):
```typescript
// @agentis/connector-sdk — to publish
export interface AgentisConnector {
  manifest: IntegrationManifest;
  module: ConnectorModule;
}
// Published to npm as `agentis-connector-<service>`
// Operator: pnpm add agentis-connector-quickbooks
// Agentis: auto-discovers via package.json keywords
```

---

## Part 2 — Expression Engine (Agentis Script)

### 2.1 The Gap

> ✅ **RUNTIME + INLINE SYNTAX SHIPPED** (verified 2026-06-05). `engine/safeExpression.ts`
> is a working sandboxed JS evaluator (`node:vm`, `codeGeneration:{strings,wasm}=false`,
> static blocklist for `__proto__`/`constructor`/`process`/`eval`/`require`/`import`,
> 250ms timeout) consumed by `transform` and `filter`. `templateResolver.ts` now
> supports `{{= expr }}` in arbitrary templated fields with `$json`/`$input`,
> `$nodes`, `$trigger`, `$scratchpad`, `$store`, `$workspace`, `$run`, and `$loop`.
> Remaining gap: Monaco/editor ergonomics + richer AST validation. (n8n uses
> isolated-vm; our `node:vm`-with-codegen-disabled realm is the current lighter choice.)

n8n's expression system (`@n8n/expression-runtime`) allows users to write `{{ $json.user.name.toUpperCase() }}` in any field. It runs in a V8 isolate (via `isolated-vm`) with memory limits and timeouts. This is what makes n8n feel programmable, not just point-and-click.

Agentis has `templateResolver.ts` which handles `{{nodes.X.output}}` references and now `{{= ... }}` expressions. An agent prompt can reference data with `{{nodes.fetch.output.items[0].title}}` or transform it with `{{= $nodes.fetch.output.items[0].title.toUpperCase() }}`.

### 2.2 Proposed: Agentis Script (AScript)

Inspired by n8n's expression runtime architecture, but designed for AI agent contexts:

**Design goals:**
1. Expressions evaluate in a V8 isolate (`isolated-vm`, same choice as n8n)
2. Available globals: `$input` (current node input), `$nodes` (all prior node outputs), `$env` (safe env vars), standard JS + lodash + date-fns
3. **Memory limit:** 64MB per expression (n8n uses 128MB, we can be tighter since expressions are simple)
4. **Timeout:** 2000ms
5. **No network access**, no `require()`, no `process`

**Syntax (backward compatible with existing template resolver):**

```
# Existing (still works):
{{nodes.fetch.output.title}}

# New AScript (curly with = prefix):
{{= $nodes.fetch.output.title.toUpperCase() }}
{{= $nodes.items.output.filter(i => i.active).length }}
{{= new Date($input.timestamp).toISOString() }}
```

**Implementation note:** the first shipped version uses the existing `node:vm`
sandbox rather than adding `isolated-vm`. Keep the conceptual API below as the
future hard-isolation target, but do not treat it as the current code.

**Future implementation plan:**

```typescript
// packages/core/src/engine/AScriptRuntime.ts
import ivm from 'isolated-vm';

export class AScriptRuntime {
  private isolate: ivm.Isolate;
  private context: ivm.Context;

  async init() {
    this.isolate = new ivm.Isolate({ memoryLimit: 64 });
    this.context = await this.isolate.createContext();
    // Inject lodash, date-fns bundles
    await this.context.eval(runtimeBundle);
  }

  async evaluate(expression: string, data: AScriptData): Promise<JsonValue> {
    // Validate: strip leading '=' marker
    const code = expression.startsWith('=') ? expression.slice(1) : expression;
    // Inject $nodes, $input, $env as ivm.ExternalCopy
    // Run with 2000ms timeout
    // Return serialized result
  }

  dispose() { this.isolate.dispose(); }
}
```

**Integration with templateResolver.ts:**
```typescript
// apps/api/src/engine/templateResolver.ts
// Detect {{= ... }} pattern, route to AScriptRuntime
// Fall back to existing reference resolution for {{nodes. ... }}
```

**Canvas integration:**
- Fields that support AScript show a `</>` toggle icon
- When in script mode, show a Monaco editor with autocomplete for `$nodes`, `$input`
- Type-ahead knows the shape of prior node outputs

### 2.3 Expression Security & AST Verification

Even within a V8 isolate (`isolated-vm`), arbitrary JS execution can be vulnerable to prototype pollution or memory exhaustion. 

**Proposed Security Layer (inspired by n8n `@n8n/tournament`):**
Before running any `AScript` code inside the isolate, the expression is parsed into an Abstract Syntax Tree (AST) using a fast parser (like `acorn` or `esprima`):
1. **Forbidden Properties**: Reject ASTs containing access to properties like `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`.
2. **Method Call Restrictions**: Restrict access to global constructor invocations and function generators.
3. **Static Validation**: Any AST that fails security criteria is blocked prior to VM compilation, throwing a compilation error immediately.

---

## Part 3 — Computer Use & Browser Automation

### 3.1 Agentis Computer Gateway

> ⚠️ **NODE-LEVEL BROWSER ALREADY EXISTS** (verified 2026-06-05). `browser` is a
> first-class node kind backed by `services/browserPool.ts` (Playwright pool). The
> gaps are the *local-bridge daemon* (drive the user's own machine) and a standalone
> *browser-MCP server* exposing the 32-tool surface — not browser automation per se.

n8n's `@n8n/computer-use` gives cloud agents access to the user's local machine via a daemon (`npx @n8n/computer-use`). This is one of the most powerful capabilities in the modern agentic stack.

**Proposed: Agentis Local Bridge** (direct adaptation, fully owned)

Architecture: A small TypeScript daemon (`packages/local-bridge`) the user runs locally. The cloud Agentis instance connects to it via secure SSE or WebSocket.

```
[Agentis Cloud / Self-Hosted API]
        ↕  SSE / WebSocket (token-auth)
[Agentis Local Bridge — runs on user's machine]
  ├─ Filesystem (read/write sandboxed to --dir)
  ├─ Shell (configurable, default: deny)
  ├─ Browser automation (Playwright)
  └─ Screenshot + mouse/keyboard (robotjs — optional)
```

**Permission model** (identical philosophy to n8n's):
```
deny → tool not registered; AI doesn't know it exists
ask  → tool registered; user prompted before each execution
allow → tool executes without confirmation
```

**New workflow node kinds:**
```typescript
export type LocalBridgeNodeConfig =
  | { kind: 'local_filesystem'; operation: 'read' | 'write' | 'list' | 'search'; path: string }
  | { kind: 'local_shell'; command: string; workDir?: string; timeoutMs?: number }
  | { kind: 'local_screenshot'; region?: { x: number; y: number; w: number; h: number } }
  | { kind: 'local_browser'; browserOperation: BrowserOperation };
```

**CLI package:**
```bash
# Install
npm install -g @agentis/local-bridge

# Run (connects to your Agentis instance)
agentis-bridge --url https://my.agentis.app --token <your-token>

# With options
agentis-bridge --dir ~/projects --permission-shell ask --permission-write ask
```

**Security design:**
- Token is workspace-scoped, not user-scoped (workspace isolation)
- All file operations are jailed to `--dir`
- Shell commands time out (configurable, default 30s)
- `--allowed-origins` prevents SSRF attacks
- The daemon never calls outbound URLs; only the Agentis API server sends commands

---

### 3.2 Agentis Browser MCP

n8n ships `@n8n/mcp-browser` — an MCP server exposing 32 browser automation tools. We can build the Agentis equivalent.

**`packages/browser-agent`** — Playwright-based browser MCP server:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL, return accessibility tree |
| `browser_click` | Click element by CSS selector or description |
| `browser_type` | Type text into focused input |
| `browser_fill` | Fill form field |
| `browser_select` | Select dropdown option |
| `browser_screenshot` | Take screenshot, return as base64 |
| `browser_wait` | Wait for element / network idle |
| `browser_scroll` | Scroll page |
| `browser_evaluate` | Execute JS in page context (sandboxed) |
| `browser_get_text` | Extract text from page / element |
| `browser_get_links` | Get all links on page |
| `browser_new_tab` | Open new tab |
| `browser_close_tab` | Close tab |

**Usage in Agentis:**
- As an MCP tool automatically available to agents (configure in agent settings)
- As a workflow node: `browser_task` node with natural language instruction
- Via Local Bridge for local browser sessions (user's real Chrome profile)

**Two session modes (same as n8n):**
1. **Ephemeral** — fresh Playwright browser, no cookies/history
2. **Local** — connects to user's installed Chrome via the browser extension bridge

---

## Part 4 — Evaluation Framework (Agentis Evals)

### 4.1 The Gap

> ⚠️ **PARTIALLY EXISTS** (verified 2026-06-05). `evaluator` and `guardrails` are
> first-class node kinds backed by `services/evaluatorRuntime.ts` — you *can* score
> an output inline today. What's missing is the **batch** harness below (datasets +
> metrics + `/v1/evals` runs), not evaluation itself.

n8n's `@n8n/agents` ships a full evaluation framework: `eval.ts` defines datasets and metrics, `evaluate.ts` runs an agent against the dataset, and results are logged. This is essential for iterating on agent quality.

Agentis has inline `evaluator`/`guardrails` nodes but no dataset-level batch harness. You can't yet run a whole dataset and measure whether prompt changes improved a task.

### 4.2 Proposed: Agentis Evals

**Core concepts:**

```typescript
// packages/evals/src/index.ts

export interface EvalDataset {
  id: string;
  name: string;
  cases: EvalCase[];
}

export interface EvalCase {
  id: string;
  input: Record<string, unknown>;      // inputs to the agent or workflow
  expectedOutput?: string;             // for LLM-as-judge
  referenceOutput?: string;            // golden answer for exact match
  tags?: string[];
}

export interface EvalMetric {
  name: string;
  evaluate(output: string, expected: EvalCase): Promise<EvalScore>;
}

export interface EvalScore {
  score: number;     // 0.0–1.0
  reason?: string;   // explanation for LLM-as-judge
  passed: boolean;
}
```

**Built-in metrics:**
- `ExactMatch` — string equality
- `ContainsAll` — all expected substrings present
- `LLMJudge` — use an LLM to score output quality against a rubric
- `JSONSchema` — output validates a JSON schema
- `Latency` — p50/p95 latency within budget

**Eval runner:**
```typescript
export class AgentisEvalRunner {
  async runDataset(
    agent: AgentConfig | WorkflowId,
    dataset: EvalDataset,
    metrics: EvalMetric[],
  ): Promise<EvalReport>;
}
```

**API routes (new):**
```
POST /v1/evals                    → create eval dataset
GET  /v1/evals/:id                → get dataset
POST /v1/evals/:id/run            → run eval (returns run_id)
GET  /v1/evals/runs/:runId        → get results
GET  /v1/evals/runs/:runId/cases  → per-case breakdown
```

**Canvas integration:**
- "Run Eval" button on workflow canvas
- A/B compare two workflow versions against the same dataset
- Show score over time as a sparkline on the workflow card

---

## Part 5 — Node System Expansion

### 5.1 Data Transformation Nodes

> ⚠️ **PARTIALLY EXISTS** (verified 2026-06-05). Real node kinds already present:
> `transform`, `filter`, `merge`, `router`, `wait`, `loop`, `parallel`,
> `workflow_store`, `workspace_store`, `http_request`, `return_output`. So "Agentis
> has almost none" is wrong — the gap is the *remaining* utilities (sort, aggregate,
> split, html_extract, datetime, crypto, xml, markdown, pdf_read, image_edit).

n8n ships 30+ utility nodes for data transformation. Agentis already has the core set; the table below marks what's left.

| Node | Description | n8n equivalent |
|------|-------------|----------------|
| `transform` | JavaScript expression transform on data | `Code` node |
| `filter` | Filter items by condition | `Filter` node |
| `sort` | Sort array by field | `Sort` node |
| `aggregate` | Group by, sum, count | `Aggregate` node |
| `merge` | Join two data streams | `Merge` node |
| `split` | Split array into batches | `SplitInBatches` |
| `html_extract` | CSS selector / XPath extraction | `HtmlExtract` |
| `json_parse` | Parse/validate JSON strings | `Set` node |
| `datetime` | Format, parse, add/subtract dates | `DateTime` |
| `crypto` | Hash, sign, verify, generate UUID | `Crypto` |
| `xml` | Parse/convert XML ↔ JSON | `Xml` |
| `markdown` | Markdown ↔ HTML conversion | `Markdown` |
| `compress` | Zip/unzip data | `Compression` |
| `pdf_read` | Extract text from PDF | `ReadPdf` |
| `image_edit` | Resize, crop, convert image | `EditImage` |

**Implementation approach:** Each maps to a new `NodeHandler` in the handler registry (see `NATIVE-ADVANCEMENT.md` Proposal 4). No integration required — pure data transformation, no credentials.

### 5.2 Flow Control Nodes

| Node | Description |
|------|-------------|
| `wait` | Pause workflow for N seconds/minutes, or until a specific time |
| `loop` | Iterate over array items (already partially exists) |
| `batch` | Process N items at a time with delay |
| `retry` | Retry a subtask up to N times with backoff |
| `human_review` | Block until a human approves or rejects (already have approval mechanism) |
| `stop_on_error` | Halt workflow on any upstream error |
| `compare` | Compare two values, branch A/B |

### 5.3 AI-Native Nodes (Where Agentis Surpasses n8n)

These nodes don't exist in n8n but are natural for an agent platform:

| Node | Description |
|------|-------------|
| `embed` | Generate vector embedding for input text |
| `semantic_search` | Query a vector store with natural language |
| `classify` | Classify text into predefined categories |
| `extract` | Extract structured data from unstructured text (JSON schema output) |
| `summarize` | Summarize long text to N words |
| `translate` | Translate text to target language |
| `moderate` | Run content through moderation check |
| `memory_read` | Query agent's long-term memory store |
| `memory_write` | Write a fact to agent's memory |
| `multi_agent_call` | Delegate a subtask to a specialist agent (already have subflow) |

These make Agentis's workflow canvas genuinely *AI-native*, not just an automation tool with AI bolted on.

### 5.4 Visual Connection Ports & Composable Assembly

In n8n (`@n8n/nodes-langchain`), compound AI structures are built on the canvas visually using distinct connection categories rather than static properties:
- **`Model` port**: Injects LLM provider configurations (OpenAI, Anthropic, Ollama).
- **`Vector Store` port**: Connects embeddings and semantic storage layers.
- **`Memory` port**: Connects memory stores (SQLite, Redis, buffer window).
- **`Tool` port**: Dynamic integration tools list exposed to the agent.

**Proposed Agentis Composition System:**
Rather than setting JSON parameters, the user connects model configurations and vector backends directly as inputs on the canvas to an Agent node. The execution engine compiles these connected sub-graphs at runtime before executing the main node.

---

## Part 6 — The Sandbox Runtime

### 6.1 n8n's Task Runner Architecture

n8n separates code execution into an isolated **task runner** process (`@n8n/task-runner`):
- Code nodes run in a separate Node.js process, never the main server
- Data is passed via IPC (not shared memory)
- Each runner is resource-limited and sandboxed
- Errors in user code can't crash the main process

### 6.2 Proposed: Agentis Code Node Sandbox

For the `transform` (AScript) node, run code in a separate child process, not in the main server:

```typescript
// packages/core/src/engine/sandbox/CodeSandbox.ts
export class CodeSandbox {
  private worker: Worker; // Node.js worker_thread

  async execute(
    code: string,
    data: Record<string, unknown>,
    opts: { timeoutMs: number; memoryLimitMb: number },
  ): Promise<unknown> {
    // Post to worker, await response
    // If timeout → terminate worker, create new one
  }
}
```

**Worker pool design:**
- Pool of 2–4 workers (configurable)
- Each worker handles one task at a time
- Crashed workers are automatically replaced
- Malformed code with infinite loops is killed after `timeoutMs`

This is architecturally identical to n8n's task runner but lighter (worker threads vs separate processes).

### 6.3 Python Code Execution Sandbox

n8n ships `@n8n/task-runner-python` to allow users to write Python script nodes.
- **Adaptation**: Agentis should optionally run Python code nodes.
- **Implementation**: Instantiate a local sandboxed Python runtime daemon. Communication occurs via JSON IPC, executing the script with resource quotas (CPU, RAM) and timeouts.

---

## Part 7 — Agent Intelligence Improvements

### 7.1 Memory Architecture (n8n `@n8n/agents` pattern)

n8n's agents package ships `memory.ts` (builder) and `memory-store.ts` (runtime). The memory system tracks:
- **Conversation history** — message list for the current session
- **Observation log** — structured log of tool calls, results, reasoning steps
- **Long-term memory** — persisted facts that survive across sessions

Agentis already has conversation history in `chatSessionExecutor.ts`. What's missing:
- **Semantic memory retrieval** — find relevant past observations by embedding similarity
- **Cross-session memory** — facts that persist across conversations
- **Memory introspection** — agents can query their own memory store

**Proposed addition to agent config:**
```typescript
export interface AgentMemoryConfig {
  conversationWindowSize: number;     // last N messages in context (existing)
  semanticMemory?: {
    enabled: boolean;
    vectorStore: 'sqlite-vss' | 'supabase' | 'custom';
    topK: number;                     // retrieve top-K similar memories
    decayHalfLifeDays?: number;       // older memories weighted less
  };
  longTermMemory?: {
    maxFacts: number;                 // FIFO-evicted beyond this
    domain: 'workspace' | 'agent';   // scope
  };
}
```

### 7.2 Guardrails

n8n's `@n8n/agents` ships `guardrail.ts` — a pre/post execution hook to validate agent inputs/outputs:

```typescript
// packages/core/src/types/agent.ts — proposed addition
export interface AgentGuardrail {
  name: string;
  type: 'input' | 'output' | 'tool_call';
  rule: string;          // natural language rule (LLM-evaluated) or regex
  action: 'block' | 'warn' | 'redact';
  severity: 'low' | 'medium' | 'high';
}
```

**Pre-built guardrails:**
- `pii_detector` — block/redact SSNs, credit cards, emails in outputs
- `topic_blocker` — block off-topic requests (configurable topic list)
- `prompt_injection_detector` — detect and block injection attempts
- `toxic_content` — detect and block harmful content
- `cost_limit` — stop if token usage exceeds budget for this run

### 7.3 LLM Provider Catalog

n8n's `catalog.ts` fetches a runtime catalog of available model providers. Agentis should have a provider catalog that's workspace-configurable:

```
Workspace settings → Model Providers:
  ✅ Anthropic (API key set)    → Claude 3.5 Sonnet, Claude 3 Haiku
  ✅ OpenAI (API key set)       → GPT-4o, GPT-4o-mini, o3
  ✅ Ollama (local URL set)     → llama3.2, mistral, gemma2
  ⚪ Google (not configured)    → Gemini 1.5 Pro (requires API key)
  ⚪ Groq (not configured)      → llama-3.1-70b-versatile (requires API key)
```

Per-agent model selection becomes a dropdown of *available* models, not a free-text field.

### 7.4 AI Event Telemetry System

n8n records granular `AiEvent` types (such as `ai-tool-called`, `ai-llm-generated-output`, and `ai-messages-retrieved-from-memory`) to construct an observable event bus.

**Proposed Telemetry in Agentis:**
Implement an event-emitter system in the agent execution framework. This emits real-time execution events over WebSockets/SSE to the frontend. The canvas can then render:
- Real-time token usage and latency metrics.
- Intermediate thoughts/thought streams of the agent.
- Precise tool call inputs, outputs, and memory retrieval scores.

---

## Part 8 — MCP Ecosystem Expansion

### 8.1 The Opportunity

n8n ships `@n8n/mcp-apps` — sandboxed UI micro-apps embedded in MCP clients. Agentis already has native MCP support (`HARNESS-NATIVE-MCP.md`). The combination creates something n8n doesn't have: **AI agents that expose their own MCP tools to other AI clients**.

**Agentis as MCP Server** (existing capability, expand it):
Every Agentis agent should auto-generate an MCP endpoint:
```
https://<instance>/mcp/agents/<agentId>
Tools exposed: whatever the agent's abilities are
```

Claude Desktop adds Agentis agents as MCP servers → agent collaboration across AI clients.

**Agentis MCP App Registry** (inspired by n8n `mcp-apps`):
When an agent completes a task, it can return an **MCP App** — a small HTML/React micro-app rendered inside the MCP client. Examples:
- After creating a GitHub issue → show issue preview with "Open in GitHub" button
- After generating a chart → render the chart inline
- After booking a meeting → show calendar widget

```typescript
// packages/mcp-apps/src/apps/
//   issue-preview/     → renders GitHub issue card
//   chart-viewer/      → renders Recharts/D3 chart from data
//   table-viewer/      → renders data table
//   file-diff/         → shows file diff from code operations
```

### 8.2 MCP Tool Auto-Discovery

When a user adds an MCP server to Agentis, auto-import its tools as:
1. Agent abilities (tools the agent can call)
2. Workflow nodes (MCP calls as workflow steps)

This means: add `@n8n/mcp-browser` as an MCP server to Agentis → agents immediately get 32 browser tools without any custom integration work.

---

## Part 9 — Developer Experience

### 9.1 Connector SDK (like n8n's node-dev)

n8n ships `@n8n/node-dev` for developing custom nodes. Agentis should ship:

```bash
npm create agentis-connector

# Scaffolds:
packages/my-connector/
  src/
    manifest.ts        # IntegrationManifest
    connector.ts       # ConnectorModule implementation
    connector.test.ts  # Vitest test with mock credentials
  README.md
  package.json         # name: 'agentis-connector-<service>'
```

**Live testing in canvas:**
```bash
agentis dev-connector packages/my-connector --watch
# Hot-reloads connector into the running Agentis instance
# Canvas shows the new integration immediately
```

### 9.2 Workflow SDK (like n8n's workflow-sdk)

n8n's `@n8n/workflow-sdk` lets you build and deploy workflows programmatically. Agentis should expose:

```typescript
import { AgentisClient } from '@agentis/sdk';

const client = new AgentisClient({ url: '...', apiKey: '...' });

// Deploy a workflow via code
const workflow = await client.workflows.deploy({
  name: 'Daily Digest',
  nodes: [
    scheduleTrigger({ cron: '0 9 * * 1-5' }),
    agentTask({ agentId: 'digest-agent', task: 'Summarize today\'s news' }),
    integration('slack', 'send_message', { channel: '#general', text: '{{nodes.0.output}}' }),
  ],
});
```

This unlocks GitOps-style workflow management and programmatic deployment pipelines.

---

## Part 10 — Execution Reliability

### 10.1 n8n's Reliability Patterns We Should Adopt

> ✅ **PHASE 1 QUEUE ALREADY EXISTS** (verified 2026-06-05). The plan below was
> stale: `packages/db/src/sqlite/schema.ts` defines `workflowRunQueue`,
> `WorkflowEngine.drainWorkflowQueue()` drains pending workflow runs, `SchedulerService`
> enqueues/claims scheduled work, and `/v1/scheduler` exposes queue controls.
> Remaining reliability work is DLQ/manual retry UX, cross-process/external queue
> extraction, and provider-level rate limiting.

n8n ships `@n8n/engine` which handles:
- **Queue-based execution** — workflows run via a job queue (Bull/BullMQ), not in-process
- **Horizontal scaling** — multiple worker processes can consume from the queue
- **Dead letter queue** — failed runs move to DLQ, manually retried from UI
- **Concurrent run limits** — per-workflow concurrency caps
- **Rate limiting** — integration calls are rate-limited per provider

Agentis's `WorkflowEngine.ts` runs workflows in-process with async tasks. This is fine for small scale but becomes a bottleneck.

**Proposed evolution (not a rewrite — additive):**

Phase 1 (shipped): Add a **workflow queue table** in SQLite:
```sql
workflow_run_queue (
  id, workflow_id, run_id, priority, scheduled_at, claimed_at, worker_id
)
```
Workers `SELECT ... FOR UPDATE SKIP LOCKED` to claim runs. This enables:
- **Deferred execution** — "run this workflow in 5 minutes"
- **Priority queuing** — agent-initiated runs can be high priority
- **Observability** — queue depth visible in dashboard

Phase 2 (scale): Extract to an external queue (Redis/BullMQ) for multi-process workers.

### 10.2 Partial Retry (Already in Engine, Surface in UI)

`PartialReplayService` already exists. The UI should surface this:
- When a workflow run fails at node 7 of 12 → show "Resume from node 7" button
- Show which nodes completed (green) vs failed (red) vs skipped (gray)
- Allow re-running just the failed node with modified input

### 10.3 Versioned Nodes & Global Error Workflows

**Versioned Nodes (inspired by `IVersionedNodeType`):**
To ensure updates don't break existing workflows, nodes should support multiple major versions. The engine selects the version specified in the node metadata, allowing developers to deprecate old implementations without breaking active workflows.

**Global Error Workflows (`onError` routing):**
Nodes should have configurable error routing properties (e.g. `continueErrorOutput`). If enabled, execution branches to an alternate output port on failure. Additionally, workspaces can define a global error trigger that launches a fallback notification/cleanup workflow whenever any run crashes.

---

## Implementation Roadmap

```
Quarter 1 — Foundations
  [DONE]     Fix OAuth "doesn't appear" bug + instance proxy mode
  [DONE]     Inline credential form, including multi-field schemas
  [DONE*]    Expand live connectors via templated HTTP coverage
  [DONE*]    AScript inline expressions on existing node:vm runtime
  [DONE*]    Trigger node: webhook + schedule/listener core

Quarter 2 — Power Features
  [HIGH]     Data transformation nodes (filter, sort, merge, etc.)  ~ 3 weeks
  [HIGH]     AI-native nodes (embed, extract, classify, etc.)       ~ 2 weeks
  [HIGH]     Agentis Local Bridge (computer use daemon)             ~ 4 weeks
  [MEDIUM]   Agent evaluation framework (evals)                     ~ 3 weeks
  [MEDIUM]   Guardrails system                                       ~ 2 weeks

Quarter 3 — Ecosystem
  [HIGH]     Browser automation (Playwright-backed MCP server)      ~ 3 weeks
  [HIGH]     MCP App renderer (inline tool results)                 ~ 2 weeks
  [MEDIUM]   Connector SDK + dev workflow                           ~ 2 weeks
  [DONE*]    Workflow queue (SQLite deferred/prioritized execution)
  [LOW]      Community connector registry                           ~ 4 weeks

Quarter 4 — Polish & Scale
  [HIGH]     Provider catalog UI (model selection)                  ~ 1 week
  [HIGH]     Semantic memory for agents                             ~ 3 weeks
  [MEDIUM]   Workflow SDK (TypeScript client)                       ~ 2 weeks
  [MEDIUM]   Horizontal worker scaling (queue-based)               ~ 4 weeks
  [LOW]      GitOps workflow deployment                             ~ 2 weeks
```

`DONE*` means the core runtime path is shipped, but breadth/polish remains.

---

## Appendix A — n8n Package Inventory (What We Studied)

We analyzed the full list of **48 scoped packages** in the n8n monorepo:

| Package | What it does / Purpose | Agentis Equivalent / Adaptation |
|---------|------------------------|---------------------------------|
| `@n8n/agents` | Agent SDK: builder, eval, guardrails, MCP, memory | `chatSessionExecutor.ts` (partial, needs extension) |
| `@n8n/ai-node-sdk` | SDK for building AI-enabled nodes | Inline in engine (needs modularization) |
| `@n8n/ai-utilities` | Shared AI utilities | `apps/api/src/services` (AI services) |
| `@n8n/ai-workflow-builder.ee` | Enterprise AI workflow builder | Visual canvas editor |
| `@n8n/api-types` | Shared API TypeScript types | `packages/core/src/types` |
| `@n8n/backend-common` | Shared backend utilities | `apps/api/src/utils` |
| `@n8n/backend-test-utils` | Test utilities for the backend monorepo | `apps/api/tests` |
| `@n8n/benchmark` | Performance and scale benchmarking suites | Testing harness (Gap) |
| `@n8n/chat-hub` | Real-time chat streaming infrastructure | WebSocket & SSE chat routes |
| `@n8n/cli` | Internal CLI helper utilities | `packages/cli` |
| `@n8n/client-oauth2` | Specialized client wrapper for OAuth2 flows | `oauthService.ts` (already equivalent) |
| `@n8n/codemirror-lang` | Code editor language definition for expressions | Monaco language definition in canvas |
| `@n8n/codemirror-lang-html` | HTML language support for expression editor | Frontend editors |
| `@n8n/codemirror-lang-sql` | SQL autocomplete and highlighting in nodes | ContextInspector query forms |
| `@n8n/computer-use` | Desktop automation client (files, screen, shell) | **Gap** (Proposed Local Bridge daemon) |
| `@n8n/config` | Global configuration schemas and validations | Hono env-based config |
| `@n8n/constants` | Core static constants for types and channels | `packages/core/src/constants` |
| `@n8n/crdt` | Collaborative editing structures for real-time canvas | **Gap** (Single-user lock currently) |
| `@n8n/create-node` | CLI generator to scaffold nodes and credentials | **Gap** (Proposed dev-connector CLI) |
| `@n8n/db` | Database schema definition using TypeORM | SQLite migrations using Drizzle/TypeORM |
| `@n8n/decorators` | TypeScript decorators for node classes | Declarative manifests in TypeScript |
| `@n8n/di` | Dependency injection container for services | Hono Context-based manual registry |
| `@n8n/engine` | Graph traversal and node execution engine | `WorkflowEngine.ts` |
| `@n8n/errors` | Standardized error definitions for executions | `packages/core/src/errors` |
| `@n8n/eslint-config` | Shared linter rules | Workspace ESLint config |
| `@n8n/eslint-plugin-community-nodes` | Audits community nodes for code quality | None |
| `@n8n/expression-runtime` | isolated-vm expression interpreter | `safeExpression.ts` + `templateResolver.ts` `{{= ...}}` inline expressions; Monaco/autocomplete and AST hardening remain |
| `@n8n/extension-sdk` | SDK for loading runtime extensions | `packages/core/src/types/extension.ts` |
| `@n8n/imap` | Low-level IMAP mail client triggers | Email trigger node |
| `@n8n/instance-ai` | Global AI helpers on the server-side | Vision & Document Extract services |
| `@n8n/json-schema-to-zod` | Runtime converter for input/output schema validation | Zod parsing inline |
| `@n8n/local-gateway` | Relay proxy for localhost webhook testing | Local Bridge route proxying |
| `@n8n/mcp-apps` | Sandboxed UI micro-apps for tools | **Gap** (Proposed MCP App Registry) |
| `@n8n/mcp-browser` | Playwright browser control MCP server | **Gap** (Proposed Playwright MCP bridge) |
| `@n8n/mcp-browser-extension` | Chrome extension source for real-profile control | **Gap** (Browser extension source code) |
| `@n8n/node-cli` | Execution launcher for single-node tests | Single node dry run route |
| `@n8n/nodes-langchain` | LangChain composition nodes | Vector store and model integrations |
| `@n8n/permissions` | Role-based access control definition | API middleware |
| `@n8n/scan-community-package` | Auditor for custom npm node packages | Community packages registry verification |
| `@n8n/stylelint-config` | Shared styling linter configurations | Frontend style checks |
| `@n8n/syslog-client` | Telemetry logs destination client | Winston logging system |
| `@n8n/task-runner` | Execution sandbox service for code nodes | **Gap** (Proposed Sandbox Runtime) |
| `@n8n/task-runner-python` | Python runtime sandbox server | **Gap** (Proposed Python Runner) |
| `@n8n/tournament` | Expression parser and security filter | **Gap** (Proposed AST check runtime) |
| `@n8n/typescript-config` | Monorepo tsconfig bases | Workspace standard configs |
| `@n8n/utils` | Common utility library | Shared workspace helpers |
| `@n8n/vitest-config` | Testing harness defaults | Vite/Vitest base config |
| `@n8n/workflow-sdk` | Programmatic workflow builder SDK | Programmatic client SDK (Proposed) |

### Appendix A.2 — Monorepo Architecture: Nodes & Credentials

#### A.2.1 Node Composition & Types
n8n uses `INodeType` declarations to define nodes. Key hooks include:
- `execute()`: Runs standard processing operations (non-trigger nodes).
- `webhook()`: Handles incoming webhooks, parsing routes and executing triggers.
- `trigger()`: Launches long-running listener setups (like WebSockets or message streams).
- `poll()`: Runs periodic state-checks, querying external systems for new events.

Nodes are connected via typed connection ports (`NodeConnectionTypes`) such as:
- **Main**: Flow-control data input/output.
- **Model**: Dynamic AI LLM provider injection.
- **Vector Store**: Semantic database connection.
- **Memory**: Conversation memory provider.
- **Tool**: Tool description list for agents.

#### A.2.2 Webhook Response Modes
- **`onReceived`**: Immediate 200 OK returned on receipt.
- **`lastNode`**: Resolves execution and returns final node payload.
- **`responseNode`**: Resolves custom payload from a specialized "Response" node.

#### A.2.3 Credentials & Authentication (399 files)
n8n separates authentication from node logic, supporting 8 core patterns:
1. **OAuth2**: Dynamic popup authorization with token refresh.
2. **API Key**: Query/Header injection of static credentials.
3. **Basic Auth**: Base64 encoded username/password.
4. **JWT**: JSON Web Token signature authorization.
5. **AWS IAM**: Signature V4 headers for AWS resources.
6. **SSH Key**: Private key configuration for SFTP/Shell nodes.
7. **Client Certificate**: Custom SSL certificate authorization.
8. **Custom HTTP Headers**: Arbitrary header lists.

---

## Appendix B — Agentis Advantages Over n8n

Agentis is not trying to *be* n8n. These are Agentis's structural advantages that differentiate the platform:

| Capability | n8n | Agentis |
|-----------|-----|---------|
| Multi-agent orchestration | Basic AI Agent node | First-class: channels, spawning, delegation |
| Agent-native workflows | LLM nodes inside workflows | Agents *are* the runtime; workflows coordinate them |
| Real-time agent interaction | None | Live chat, approval interrupts, streaming |
| Agent memory | Plugin-based | First-class configurable per agent |
| MCP as first class | MCP integration | MCP server + client native |
| Self-hosting simplicity | Complex (queues, workers, DB) | Single binary, SQLite, zero deps |
| Open governance | Fair-code license | Fully open source |
| Expression security | isolated-vm | Current `node:vm` sandbox with timeouts and no default globals; deeper AST hardening remains |
| Workflow canvas | Mature, polished | Growing, extensible |

The goal is not parity with n8n — it's to take n8n's best automation primitives and embed them into a genuinely agent-first platform that n8n can never become (because it started as a pure workflow tool).

---

*Document written: 2026-06-05. Based on direct code audit of both codebases. All proposals are Agentis-native implementations inspired by n8n patterns.*

---

## Implementation Log

> Append-only. Each entry reconciles the plan against what actually shipped in
> code so future readers trust this doc over the original (partly-wrong) draft.

### 2026-06-05 — Audit + Templated Connectors (closes the real P2)

**Audit findings (corrected Part 0.2 above):** P3, P4, P7 were already built; P1
(OAuth UI) and P5 (sandboxed expression runtime + transform/filter), P6 (browser
node) were already *partly* built. The genuine, user-visible gap was **P2**: every
`manifest_only` connector routed through `genericHttpConnector`, which throws
`requires params.url` because the canvas never supplies a raw URL — so a bound
Notion/Airtable/Discord credential "connects" but fails at run time.

**Shipped:**
- `packages/integrations/src/connectors/templatedConnectors.ts` — declarative
  per-service `SERVICE_TEMPLATES` (method + URL template with `{param}` path
  interpolation + auth convention + static headers) and a `templatedHttpConnector`
  factory. Known operations render and call the real API via the existing
  `executeHttpRequest` (which already does SSRF guarding + auth header injection);
  **unknown operations fall back to `genericHttpConnector`**, so coverage is purely
  additive and never regresses a previously-reachable path.
  - Auth schemes supported: `bearer` (with optional prefix, e.g. Discord `Bot `),
    `header` (custom header name, e.g. Anthropic `x-api-key`).
  - Body strategy: path/query params are consumed, the remaining params become the
    JSON body for write ops; GET/DELETE send none.
  - Services templated (28 operations now work e2e with just a bound credential):
    **notion** (create/update_page, query_database, append_block),
    **airtable** (create/update/delete_record, query),
    **discord** (send_message, create_thread),
    **hubspot** (create/update_contact, create_deal, add_note),
    **shopify** (get/create_order, update_product, get_customer — per-tenant `{shop}` base),
    **openai** (chat_completion, embedding, image_gen),
    **anthropic** (messages, count_tokens).
- `packages/integrations/src/registry.ts` — `manifest_only` services now pick the
  templated connector when a `SERVICE_TEMPLATES[service]` exists, else generic.
- `apps/api/tests/services/templatedConnectors.test.ts` — 7 tests (mocked fetch):
  Notion bearer+version+passthrough body, path-param consumption, Anthropic custom
  header, Discord `Bot ` prefix, Airtable GET→query, missing-path-param error,
  missing-credential error. **All passing.** Integrations `typecheck` clean.

**Verified non-regressions:** `defaultConnectorRegistry.execute()` unchanged for the
7 truly-implemented connectors (slack/gmail/agentmail/github/google_sheets/http/webhook);
those manifests are `runtime: 'implemented'` and never enter the `manifest_only` map.

**Superseded by later pass:** Telegram (token-in-URL), Stripe (form-encoded body),
Linear (GraphQL), Jira/Trello (per-tenant base + basic/key-in-query auth) now have
per-service body/auth adapters in the templated connector layer, alongside
Zendesk, Twilio, Supabase, WordPress, Typeform, Auth0, and Paddle. Remaining
connector gaps are the harder categories: databases, file/binary APIs, multipart
uploads, streaming APIs, and custom OAuth edge cases.

**Next real gaps (re-scoped, in priority order):**
1. Eval dataset/metrics harness + `/v1/evals` (inline `evaluator` node already exists).
2. Monaco expression editor with `$json`/`$nodes` autocomplete plus AST validation.
3. Public Connect proxy deployment and hardening (the instance-side proxy client is now built).
4. Bespoke DB/file/multipart connectors that cannot be safely covered by simple HTTP templates.
5. Local-bridge daemon + standalone browser-MCP (node-level `browser` already exists).

### 2026-06-05 (later) — OAuth button actually appears in the canvas (P1 corrected)

**Trigger:** user screenshot proved my earlier "OAuth UI already shipped" claim was
wrong — Gmail (an OAuth-only service) was rendering an **API-key form**, and no
sign-in button appeared because `/v1/oauth/providers` only returned env-configured
providers (none) so the UI's `provider` lookup was empty.

**Shipped this round:**
- `oauthService.ts` — added `allProviders()` returning every provider with a
  `configured` boolean.
- `routes/oauth.ts` — `/providers` now returns `allProviders()` (was
  `configuredProviders()`), so the canvas can render the right affordance even when
  the operator hasn't set client secrets.
- `apps/web/.../ContextInspector.tsx` `IntegrationForm` — the OAuth button is now
  driven by the **manifest credential type** (`credentialSchema.type === 'oauth2'`),
  not by server config. OAuth-only services show "Sign in with X" and **never** the
  API-key field. When a provider isn't configured yet, a clear inline message replaces
  the (impossible) API-key path. Removed the now-unused `showApiKey` toggle.

**Updated by current pass:** the instance-side `AGENTIS_OAUTH_PROXY_URL` mode now
lands the zero-config client behavior: providers can report `configured: true` via
the proxy and the canvas can show only "Sign in with X". The remaining work is the
public Connect service itself: provider secrets, relay deployment, quotas, abuse
protection, verification, and ops hardening.


Research aside about oauth, just to mention:"To enable multiple OAuth integrations (like Google, GitHub, Slack, etc.) in your platform efficiently without writing custom code for every single provider, you need a unified Identity/Auth Layer.

Instead of building individual OAuth flows, you route everything through a central system that normalizes the authentication process.

Here are the three standard ways to do it shortly:

1. The Managed Identity Provider (Fastest)
Use a third-party Auth-as-a-Service provider. They handle the OAuth handshakes, token refreshes, and security infrastructure. You just connect your app to their SDK.

Top Options: Auth0, Clerk, Firebase Auth, or Supabase Auth.

How it works: You enable "Google" or "GitHub" toggles in their dashboard, input your provider Client IDs, and your app receives a single, unified user object regardless of how they logged in.

2. The Open-Source Auth Library (Maximum Control)
If you want to keep data in-house and avoid vendor lock-in, use a multi-provider open-source library within your existing backend framework.

Top Options: NextAuth.js / Auth.js (for JavaScript/TypeScript), Passport.js (Node), or Lucia.

How it works: These libraries provide pre-built "strategies" or "providers" for hundreds of services. You just drop in the config arrays for the services you want to support.

3. Dedicated Integration Aggregators (For Product Integrations)
If these OAuth connections are not for user login, but rather to let your app pull data from your users' accounts (e.g., syncing their Google Calendar or Slack), use an integration framework.

Top Options: Nango, Apideck, or building a multi-tenant OAuth gateway using an open-source tool like Trallopy.

How it works: They manage the complex token storage, automatic token refreshing (handling expired tokens seamlessly), and rate-limiting across all connected accounts.

💡 Core Architecture Checklist
No matter which route you choose, the underlying database structure requires a One-to-Many relationship between your Users table and their Connected Accounts:

Users Table: Holds the core profile (user_id, email, created_at).

Accounts/Integrations Table: Holds the OAuth details (id, user_id, provider_name (e.g., 'github'), provider_user_id, access_token, refresh_token, expires_at)."

### 2026-06-05 (current pass) - Architecture correction + E2E implementation batch

**Scope:** re-audited the plan against the current Agentis codebase and corrected
overstated claims in the plan. Several items were already present but hidden or
incomplete at the user-facing layer; this pass focused on shipping the missing
runtime/UI connections instead of only describing them.

**Shipped in code:**
- Inline AScript expressions now work inside templates: `{{= ...}}` runs through
  `safeExpression.ts`, supports `$json`, `$input`, `$nodes`, `$trigger`,
  `$scratchpad`, `$store`, `$workspace`, `$run`, and `$loop`, and exact expression
  fields preserve typed values instead of always stringifying.
- Workflow template contexts now pass each item's input payload into the resolver,
  so node parameters can combine incoming data, prior node outputs, trigger data,
  scratchpad/store/workspace/run metadata, and loop metadata.
- `IntegrationForm` now renders all manifest credential fields, not just a single
  token input. Multi-field services such as Twilio, Jira, Trello, Zendesk,
  Supabase, and WordPress can create encrypted credentials from the canvas.
- OAuth now has instance-side proxy mode. `AGENTIS_OAUTH_PROXY_URL` defaults to
  the public proxy URL, provider discovery reports proxy-backed providers as
  configured, `/authorize` routes to the proxy when local `OAUTH_*` clients are
  absent, and `/v1/oauth/proxy/callback` stores the relayed encrypted credential.
- Templated connector coverage expanded beyond the first batch to include
  Telegram, Linear, Stripe, Trello, Jira, Zendesk, Twilio, Supabase, Typeform,
  WordPress, Auth0, and Paddle, including token-in-URL, query auth, basic auth,
  GraphQL bodies, form bodies, raw base URL placeholders, and mixed auth headers.

**Plan corrections made in this file:**
- P1 is now "instance-side shipped, public Connect proxy ops remaining" instead of
  "OAuth missing".
- P2 is now "partly corrected by templated services" instead of "manifest-only
  throws everywhere".
- P3 is now corrected to distinguish already-existing credential storage from the
  newly-shipped multi-field canvas form.
- P5 is now "runtime and inline syntax shipped; Monaco/autocomplete/AST polish
  remaining".
- The roadmap now marks shipped core paths with `DONE*` where the runtime exists
  but breadth/polish still remains.

**Verified:**
- `pnpm --filter @agentis/api test -- tests/engine/safeExpression.test.ts tests/engine/templateResolver.test.ts tests/engine/validateGraphReferences.test.ts tests/services/templatedConnectors.test.ts tests/routes/oauth.test.ts`
- `pnpm --filter @agentis/web test -- tests/components/ContextInspector.integration.test.tsx`
- `pnpm --filter @agentis/integrations typecheck`
- `pnpm --filter @agentis/api typecheck`
- `pnpm --filter @agentis/web typecheck`
- `pnpm --filter @agentis/core typecheck`

**Still not E2E complete:** the public hosted Connect proxy service itself, Monaco
expression editor/autocomplete, AST-level expression validation, eval dataset APIs,
local bridge/browser MCP, and bespoke non-HTTP-template connectors remain open
architecture work. The plan now names these as remaining work instead of implying
they were already user-visible.
