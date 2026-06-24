# Agentis Workflow Improvements — Inspired by n8n
A side-by-side analysis of n8n's node/trigger/integration model versus Agentis, with concrete proposals for what to adopt.
---
## Background
n8n has ~307 node directories, a rich trigger taxonomy, and a very mature parameter descriptor system.
Agentis already has an excellent agentic execution model (swarms, sessions, planners, etc.) that n8n lacks entirely. The goal is to close **specific gaps** n8n reveals — not clone n8n, but borrow the things it does better.
---
## Gap Analysis: What n8n Does Better
### 1. Trigger Types — Missing in Agentis
|
 n8n has 
|
 Agentis status 
|
 Notes 
|
|
---
|
---
|
---
|
|
**
Error Trigger
**
 — fires when another workflow fails 
|
 ❌ Missing 
|
 Critical for workflow chaining & error recovery 
|
|
**
Workflow Trigger
**
 — fires when another workflow emits an event 
|
 ✅ Exists (
`workflow_event`
 in 
`ListenerConfig`
) 
|
 But not exposed on canvas as a first-class trigger type 
|
|
**
Local File Watch
**
|
 ✅ Exists (
`file_watch`
 source in listener) 
|
 But only as a listener source, not a plain trigger 
|
|
**
Email / IMAP trigger
**
|
 ❌ Missing 
|
 n8n has a full 
`EmailReadImap`
 trigger node 
|
|
**
RSS Feed trigger
**
 (poll, emit on new items) 
|
 ✅ 
`http_poll`
 + cursor 
|
 But no pre-built RSS trigger UI 
|
|
**
Schedule: multi-rule
**
 (n8n allows several independent interval rules per trigger) 
|
 ❌ Missing 
|
 Agentis cron trigger is single-expression 
|
|
**
SSE trigger
**
|
 ✅ 
`sse`
 source 
|
 Exists but not wired as a canvas first-class trigger 
|
|
**
Message Queue trigger
**
 (Kafka, SQS, RabbitMQ, Redis pubsub) 
|
 ✅ 
`message_queue`
 source 
|
 Same — exists in ListenerConfig but not canvas 
|
**Key missing trigger: `error_trigger`** — fires when a workflow or run enters a FAILED state, enabling dedicated error-handling workflows.
---
### 2. Node Types — Missing in Agentis
|
 n8n has 
|
 Agentis status 
|
 Notes 
|
|
---
|
---
|
---
|
|
**
Stop and Error
**
 — explicitly terminates a run with a custom error message 
|
 ❌ Missing 
|
 Agentis has no explicit early-termination node 
|
|
**
No-Op / Note
**
 — documentation node; no execution 
|
 ❌ Missing (has Phases for grouping, but no sticky note node) 
|
 n8n has 
`StickyNote`
 and 
`NoOp`
|
|
**
Crypto
**
 — hash/encrypt/sign primitives 
|
 ❌ Missing 
|
 Pure utility, no LLM needed 
|
|
**
Date & Time
**
 — parse, format, diff dates 
|
 ❌ Missing 
|
 Covered by 
`transform`
 but requires user to write JS 
|
|
**
Markdown
**
 — convert markdown↔HTML 
|
 ❌ Missing 
|
 Useful in content pipeline workflows 
|
|
**
Compression
**
 — zip/unzip 
|
 ❌ Missing 
|
 Needed for file-processing workflows 
|
|
**
XML
**
 — parse/serialize 
|
 ❌ Missing 
|
 Enterprise integration necessity 
|
|
**
JWT
**
 — sign/verify tokens 
|
 ❌ Missing 
|
 Auth workflows 
|
|
**
Set (Rename/Add Keys)
**
 — rename/restructure JSON fields 
|
 ❌ Partially 
|
`transform`
 does this, but without a structured UI 
|
|
**
Code
**
 — arbitrary JS/Python execution with sandboxing 
|
 ❌ Missing 
|
 Agentis has 
`transform`
 (expression only) and 
`extension_task`
 (process), but no inline code node 
|
|
**
HTML / HtmlExtract
**
 — parse HTML, extract via CSS selector 
|
 ❌ Missing 
|
 Agentis 
`browser`
 can do this but is heavier 
|
|
**
Compare Datasets
**
 — diff two data streams 
|
 ❌ Missing 
|
 Useful for change detection 
|
|
**
Split in Batches
**
 — chunk an array for sequential batch processing 
|
 ✅ Partially 
|
`loop`
 with 
`chunkSize`
 covers this 
|
|
**
Execute Command
**
|
 ❌ Missing 
|
 n8n runs shell commands as a node 
|
|
**
Read/Write Binary Files
**
|
 ❌ Missing 
|
 File I/O primitives 
|
|
**
Spreadsheet File
**
 — parse/emit .xlsx, .csv 
|
 ❌ Missing 
|
 Very common in automation workflows 
|
|
**
GraphQL
**
 — structured query with variable binding 
|
 ❌ Missing 
|
 Covered by 
`http_request`
 but no structured UI 
|
---
### 3. Integration Trigger Webhooks — Missing in Agentis
Agentis `triggerConnectors.ts` only verifies: `github`, `slack`, `linear`, `stripe`, `typeform`, `gmail`.
n8n supports ~50+ webhook-triggered services natively. Missing Agentis webhook verifiers:
|
 Service 
|
 Priority 
|
|
---
|
---
|
|
**
Shopify
**
|
 High 
|
|
**
HubSpot
**
|
 High 
|
|
**
Intercom
**
|
 Medium 
|
|
**
Zendesk
**
|
 Medium 
|
|
**
Twilio
**
|
 Medium 
|
|
**
SendGrid
**
|
 Low 
|
|
**
PagerDuty
**
|
 Low 
|
|
**
Discord
**
|
 Medium 
|
---
### 4. Schedule Trigger — Expressiveness Gap
n8n's schedule trigger supports **multiple independent intervals per trigger** (e.g. "run every Monday at 9am AND every day at midnight"). Agentis cron trigger is a single five-field expression.
**Proposal**: Add a `scheduleRules` array to `TriggerNodeConfig` for multi-rule scheduling, alongside the existing `schedule` string.
---
### 5. Integrations — Missing from Manifests.ts
Agentis currently has 75 integrations. n8n has 307 nodes. High-value gaps in Agentis:
**Communication:**
- `teams` — Microsoft Teams (send message, create channel)
- `whatsapp` — WhatsApp Business API
- `line` — LINE messaging
**CRM / Sales:**
- `zoho_crm` — Zoho CRM
- `monday_com` — Monday.com
- `attio` — Attio (modern CRM gaining traction)
**Productivity / Project:**
- `basecamp` — Basecamp
- `todoist` — Todoist
- `harvest` — Harvest (time tracking)
- `confluence` — Confluence wiki
**Data / Engineering:**
- `snowflake` — Snowflake data warehouse
- `databricks` — Databricks notebooks
- `bigquery` — Google BigQuery
- `dynamodb` — AWS DynamoDB
- `pinecone` — Pinecone vector DB
- `qdrant` — Qdrant vector DB
**DevOps:**
- `pagerduty_webhook` — PagerDuty incoming
- `jenkins` — Jenkins CI
- `circleci` — CircleCI
**Payments / Finance:**
- `chargebee` — Chargebee subscriptions
- `quickbooks` — QuickBooks accounting
**Files:**
- `box` — Box file storage
- `onedrive` — Microsoft OneDrive
- `sharepoint` — SharePoint
**Monitoring / Observability:**
- `grafana` — Grafana (create annotation, get dashboards)
- `splunk` — Splunk event ingest
**Social / Marketing:**
- `hubspot_marketing` — HubSpot Marketing Hub (emails, lists)
- `mailchimp` — Mailchimp campaigns (send, list management)
- `sendgrid_marketing` — SendGrid marketing lists
- `youtube` — YouTube (upload video, get analytics)
- `tiktok` — TikTok (business API)
---
## Proposed Changes
### Priority 1 — Core Node Additions (types + engine handlers)
---
#### [MODIFY] [workflow.ts](file:///C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/workflow.ts)
Add these node types to `WorkflowNodeType` union:
```ts
| 'error_trigger'   // fires on workflow failure
| 'stop_error'      // terminate run with custom error
| 'code'            // sandboxed JS/Python execution
| 'datetime'        // date/time parse, format, diff
| 'crypto_util'     // hash, HMAC, encode/decode
| 'xml_parse'       // XML↔JSON
| 'markdown'        // Markdown↔HTML
| 'json_schema_validate' // validate data against JSON Schema
| 'sticky_note'     // canvas annotation, no execution
| 'spreadsheet'     // parse .csv / .xlsx → rows
| 'html_extract'    // CSS-selector extraction from HTML string
| 'graphql'         // structured GraphQL query
```
Add new `WorkflowNodeConfig` members:
```ts
| ErrorTriggerNodeConfig
| StopErrorNodeConfig
| CodeNodeConfig
| DateTimeNodeConfig
| CryptoUtilNodeConfig
| XmlParseNodeConfig
| MarkdownNodeConfig
| JsonSchemaValidateNodeConfig
| StickyNoteNodeConfig
| SpreadsheetNodeConfig
| HtmlExtractNodeConfig
| GraphQlNodeConfig
```
Extend `TriggerNodeConfig.triggerType`:
```ts
| 'error_trigger'   // fires when a target workflow fails
| 'email_imap'      // IMAP inbox poller
| 'rss_feed'        // RSS/Atom feed poller
```
Add `scheduleRules` field to `TriggerNodeConfig` for multi-rule cron scheduling.
---
#### [NEW] Config interfaces (added to workflow.ts):
```ts
export interface ErrorTriggerNodeConfig {
  kind: 'error_trigger';
  targetWorkflowId?: string; // undefined = any workflow in this workspace
  onStatus: Array<'FAILED' | 'CANCELLED'>;
}
export interface StopErrorNodeConfig {
  kind: 'stop_error';
  errorMessage: string;
  errorCode?: string;
}
export interface CodeNodeConfig {
  kind: 'code';
  language: 'javascript' | 'python';
  code: string;
  inputKeys: string[];
  outputKey?: string;
  timeoutMs?: number;
}
export interface DateTimeNodeConfig {
  kind: 'datetime';
  operation: 'parse' | 'format' | 'diff' | 'add' | 'subtract' | 'now';
  inputPath?: string;
  inputFormat?: string;
  outputFormat?: string;
  timezone?: string;
  diffUnit?: 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
  amount?: number;
  unit?: string;
  outputKey?: string;
}
export interface CryptoUtilNodeConfig {
  kind: 'crypto_util';
  operation: 'hash' | 'hmac' | 'base64_encode' | 'base64_decode' | 'uuid';
  algorithm?: 'sha256' | 'sha512' | 'md5';
  inputPath?: string;
  secretPath?: string;
  outputKey?: string;
}
export interface XmlParseNodeConfig {
  kind: 'xml_parse';
  operation: 'parse' | 'build';
  inputPath?: string;
  outputKey?: string;
}
export interface MarkdownNodeConfig {
  kind: 'markdown';
  operation: 'to_html' | 'from_html';
  inputPath?: string;
  outputKey?: string;
}
export interface JsonSchemaValidateNodeConfig {
  kind: 'json_schema_validate';
  schema: string; // JSON Schema string
  inputPath?: string;
  onViolation: 'block' | 'flag';
}
export interface StickyNoteNodeConfig {
  kind: 'sticky_note';
  content: string;
  color?: string;
  fontSize?: number;
}
export interface SpreadsheetNodeConfig {
  kind: 'spreadsheet';
  operation: 'parse' | 'build';
  format: 'csv' | 'xlsx';
  inputPath?: string;
  sheet?: string; // sheet name or index for xlsx
  hasHeaders?: boolean;
  outputKey?: string;
}
export interface HtmlExtractNodeConfig {
  kind: 'html_extract';
  inputPath?: string;
  selector: string;
  extractAs: 'text' | 'html' | 'attribute';
  attribute?: string;
  multiple?: boolean;
  outputKey?: string;
}
export interface GraphQlNodeConfig {
  kind: 'graphql';
  endpoint: string;
  query: string;
  variables?: Record<string, string>; // {{variable}} templates
  headers?: Record<string, string>;
  credentialId?: string;
  outputKey?: string;
  timeoutMs?: number;
}
```
---
#### [MODIFY] [nodeCapabilities.ts](file:///C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/nodeCapabilities.ts)
Add catalog entries for all new node kinds.
---
### Priority 2 — Trigger Webhook Connectors
#### [MODIFY] [triggerConnectors.ts](file:///C:/Users/antar/OneDrive/Documentos/nexseed/agentis/apps/api/src/engine/triggerConnectors.ts)
Add webhook signature verification for:
- `shopify` (HMAC-SHA256 with `x-shopify-hmac-sha256`)
- `hubspot` (HMAC-SHA256 with `x-hubspot-signature`)
- `intercom` (HMAC-SHA256 with `x-hub-signature`)
- `zendesk` (HMAC-SHA256 with `x-zendesk-webhook-signature`)
- `twilio` (signature validation via `x-twilio-signature`)
- `discord` (Ed25519 public key verification with `x-signature-ed25519`)
- `pagerduty` (HMAC-SHA256 with `x-pagerduty-signature`)
- `sendgrid` (ECDSA / basic secret via `x-twilio-email-event-webhook-signature`)
---
### Priority 3 — Integration Manifests
#### [MODIFY] [manifests.ts](file:///C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/integrations/src/manifests.ts)
Add ~25 high-value integrations organized by category:
**Communication:** `teams`, `whatsapp`, `line`  
**CRM:** `zoho_crm`, `monday_com`, `attio`  
**Data/Engineering:** `snowflake`, `bigquery`, `dynamodb`, `pinecone`, `qdrant`  
**Files:** `box`, `onedrive`, `sharepoint`  
**Monitoring:** `grafana`, `splunk`  
**Marketing:** `mailchimp`, `sendgrid_marketing`, `youtube`  
**DevOps:** `jenkins`, `circleci`  
**Finance:** `chargebee`, `quickbooks`
---
### Priority 4 — TriggerNodeConfig Schedule Expressiveness
#### [MODIFY] [workflow.ts](file:///C:/Users/antar/OneDrive/Documentos/nexseed/agentis/packages/core/src/types/workflow.ts)
```ts
/** Multi-rule schedule (n8n-inspired). Each rule is an independent cron expression. */
export interface ScheduleRule {
  /** Five-field cron expression. */
  expression: string;
  /** IANA timezone; defaults to the trigger's timezone. */
  timezone?: string;
  label?: string;
}
// In TriggerNodeConfig:
scheduleRules?: ScheduleRule[]; // multiple cron rules on one trigger
```
---
## Open Questions
> [!IMPORTANT]
> **Q1 — `code` node sandboxing strategy**: The `code` node (inline JS/Python) is the most powerful addition but also the most dangerous. Options:
> - **Option A**: Use the existing `extension_task` process sandbox (spawns a child process, same as extensions). Consistent but requires the extension runner to be available.
> - **Option B**: Use a VM2/isolated-vm module for JS only (no Python), no extra process. Lighter but limits language support.
> - **Option C**: Defer to a future milestone; add only the type definition now, mark as `runtime: 'not_implemented'`.
>
> **Recommendation**: Option C for now — add the type, no engine handler yet.
> [!IMPORTANT]
> **Q2 — Error trigger scope**: Should `error_trigger` watch the whole workspace or be scoped to a specific workflow ID? n8n scopes to a specific "Error Workflow" set on each workflow's settings. Agentis could do either. What's your preference?
> [!NOTE]
> **Q3 — Spreadsheet parsing runtime**: `.xlsx` parsing requires `xlsx` or `exceljs` as a runtime dependency. Is that acceptable, or should we restrict to CSV-only in V1?
> [!NOTE]
> **Q4 — Discord webhook connector**: Discord uses Ed25519 (not HMAC-SHA256). This requires the `@noble/ed25519` or `tweetnacl` dependency. Include it, or skip Discord for now?
---
## Verification Plan
### Automated Tests
- `pnpm --filter @agentis/core test` — type compilation must pass with new node kinds
- `pnpm --filter @agentis/integrations test` — manifest list length increases, all new entries have required fields
- Add unit tests to `triggerConnectors.ts` for each new webhook verifier
### Manual Verification
- Canvas: new node types appear in the node picker with correct categories
- Engine: `validateGraph.ts` accepts graphs containing new node kinds without throwing `UNSUPPORTED_NODE_KIND`
- Listener: `error_trigger` fires a new workflow run when a target workflow reaches FAILED state
---
## Implementation Order
1. **`workflow.ts`** — add new node types + configs (pure types, no risk)
2. **`nodeCapabilities.ts`** — add catalog entries for new kinds
3. **`triggerConnectors.ts`** — add webhook verifiers (high value, low blast radius)
4. **`manifests.ts`** — add integration entries (additive only)
5. **Engine handlers** — wire new node kinds in `WorkflowEngine.ts` (iterative, highest effort)

---

## Implementation Log — 2026-06-19 (SHIPPED, end-to-end)

Everything in this doc is implemented and tested. Decisions on the Open Questions:
**Q1 — `code` sandbox**: went beyond the Option-C recommendation. JavaScript runs in the engine's existing guarded VM realm (`safeExpression.evaluateExpression` — no Node globals, no `require`/`import`); Python is best-effort via a child `python3`/`python` process and returns a clean `EXTENSION_RUNTIME_UNAVAILABLE` when no interpreter is on PATH. **Q2 — error_trigger scope**: supports both — a specific `targetWorkflowId` *or* `'*'` (any workflow in the workspace), with a self-skip loop guard so an error-handler never fires on its own failure. **Q3 — spreadsheet**: full CSV (built-in RFC-4180-ish tokenizer) **and** XLSX (the already-bundled `exceljs`). **Q4 — Discord Ed25519**: implemented with Node's built-in `crypto` (raw 32-byte key wrapped in a DER SPKI envelope) — no new dependency. SendGrid ECDSA P-256 likewise uses built-in `crypto`.

### What shipped
- **Types** (`packages/core/src/types/workflow.ts`): 12 node kinds + configs (`error_trigger`, `stop_error`, `code`, `datetime`, `crypto_util`, `xml_parse`, `markdown`, `json_schema_validate`, `sticky_note`, `spreadsheet`, `html_extract`, `graphql`); 3 trigger types (`error_trigger`, `email_imap`, `rss_feed`); `ScheduleRule` + `scheduleRules`. New error code `WORKFLOW_STOPPED`. Zod (`schemas/workflow.ts`) trigger enum + `scheduleRules` widened.
- **Capabilities** (`types/nodeCapabilities.ts`): catalog entries for all 12; graphql endpoint host extraction.
- **Validation** (`engine/validateGraph.ts`): all 12 kinds added to `SUPPORTED_NODE_KINDS` + per-kind config checks; new trigger-type checks; cron accepts `scheduleRules`-only.
- **Engine handlers**: the 7 deterministic pure kinds (`datetime`, `crypto_util`, `xml_parse`, `markdown`, `json_schema_validate`, `html_extract`, `sticky_note`) live in `engine/handlers/utilityHandlers.ts` behind the existing `NodeHandlerRegistry` seam (dependency-free converters, all exported for unit tests). `stop_error`, `code`, `spreadsheet`, `graphql`, `error_trigger` wired into the `WorkflowEngine` dispatch + isolation (`testNode`) switches.
- **Webhook verifiers** (`engine/triggerConnectors.ts`): `shopify`, `hubspot`, `intercom`, `zendesk`, `twilio`, `discord` (Ed25519), `pagerduty`, `sendgrid` (ECDSA) + `connectorFromConfig`.
- **Manifests** (`packages/integrations/src/manifests.ts`): +23 integrations (teams, whatsapp, line, zoho_crm, monday_com, attio, snowflake, bigquery, dynamodb, pinecone, qdrant, box, onedrive, sharepoint, grafana, splunk, mailchimp, sendgrid_marketing, youtube, jenkins, circleci, chargebee, quickbooks).
- **Triggers**: the 3 new canvas trigger types map to `persistent_listener` at deploy time (`workflowTriggerDeployment.ts`), reusing the whole ListenerRuntime. `rss_feed` → new `rss` source driver (real RSS/Atom poller, primes-then-emits new items); `error_trigger` → `workflow_event` source (extended with `'*'` wildcard + workspace scoping + self-skip); `email_imap` → honest `UnavailableSource` (matches the repo's message_queue/db_notify convention). Multi-rule `scheduleRules` → one cron job per rule in `TriggerRuntime`.

### Tests (all green)
`apps/api/tests/engine/utilityHandlers.test.ts` (22), `WorkflowEngine.utilityNodes.test.ts` (8, incl. XLSX round-trip via `testNode`), `triggerConnectors.test.ts` (+8 verifiers incl. real Ed25519/ECDSA key signing), `rssSource.test.ts` (3), `ListenerRuntime.test.ts` (+error_trigger wildcard/self-skip e2e), `validateGraph.test.ts` (+new kinds & trigger types). `@agentis/core`, `@agentis/integrations`, and the api trigger/listener suites pass; core + api typecheck clean.

---

## Addendum — 2026-06-19 (`knowledge_ingest` node — files/content into the workspace Brain)

Workflows could *read* the Brain (the `knowledge` node) but had no write path — anything a workflow produced (a fetched doc, a parsed spreadsheet, a transform result) could not be made recallable. Closed that gap with **no new ingestion subsystem**: a `knowledge_ingest` node that is the write-side twin of `knowledge`, delegating to the same `KnowledgeBaseService` (already wired into the engine as `deps.knowledgeBases`) via its existing `addDocument()` — the same path the Brain UI uses. Read and write now share one store, so an ingested document is immediately retrievable by a downstream `knowledge` node or any agent.

### What shipped
- **Types** (`packages/core/src/types/workflow.ts`): node kind `knowledge_ingest` + `KnowledgeIngestNodeConfig` (`knowledgeBaseId?`, `knowledgeBaseName?`, `content?`, `contentPath?`, `documentName?`, `documentNamePath?`, `mimeType?`); added to `WorkflowNodeConfig` union. Zod schema (`schemas/workflow.ts`) `knowledgeIngestConfigSchema` added to the node union.
- **Capabilities** (`types/nodeCapabilities.ts`): catalog entry mirroring `knowledge` (embedding-provider credential, `user-data`).
- **Validation** (`engine/validateGraph.ts`): added to `SUPPORTED_NODE_KINDS`; requires a content source (`content` or `contentPath`).
- **Engine** (`WorkflowEngine.ts`): `#executeKnowledgeIngestNode` resolves content (path or static, non-strings JSON-serialized), resolves a target base with no friction (explicit id → first existing → create `Workflow Knowledge`), then `addDocument`. Wired into both the live dispatch and `testNode` isolation switches. No bespoke chunking/embedding — all reused.
- **Canvas** (`NodePalette.tsx`, `nodeConfigRegistry.ts`): "Save to Brain" node in the Brain section + inspector meta + readiness check.

### Tests (all green)
`apps/api/tests/engine/WorkflowEngine.knowledgeIngest.test.ts` (4): base-on-demand + read-back symmetry via `search()`, explicit-base targeting, non-string→JSON serialization, empty-content failure. `validateGraph` + utility-node suites still green; core + api + web typecheck clean.
