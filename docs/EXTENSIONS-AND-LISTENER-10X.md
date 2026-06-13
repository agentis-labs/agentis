# Extensions & Listener Runtime — 10x Design

> **Status:** Design document — pre-implementation.  
> **Scope:** End-to-end redesign of the Extension runtime and the Persistent Listener trigger system, treated as two halves of one unified capability platform.  
> **North star:** An operator builds a world-class automation platform — monitoring, enrichment, synchronisation, intelligence — without leaving Agentis. Extensions are the reusable code layer. Listeners are the reactive observation layer. Together they are the substrate everything else runs on.

---

## 0. Why These Two Together

Today they are separate:

- **Extensions** are callable from workflow nodes — deterministic code with typed I/O, living in `extension_task`.
- **Persistent listeners** are a trigger type — adapter-coupled, config-invisible, essentially undocumented in the UI, and broken because `onFire` is not threaded through the `TriggerConfig` type.

This document treats them as two sides of one coin.

```
┌────────────────────────────────────────────────────────────────┐
│  OBSERVATION                       EXECUTION                   │
│  ──────────────────────────        ─────────────────────────── │
│  Listener Runtime                  Extension Runtime           │
│                                                                │
│  Watches the world. Knows         Does deterministic work.    │
│  when something matters.          Always returns structured    │
│  Decides whether to fire.         JSON. Fully sandboxed.      │
│                                                                │
│  Sources: websocket, SSE,         Runtimes: builtin,          │
│  HTTP poll, queue, DB,            node_worker, docker         │
│  file, extension, agent           sandbox                     │
│                                                                │
│           \                              /                     │
│            └─────────── Workflow ───────┘                      │
│                         Engine                                 │
└────────────────────────────────────────────────────────────────┘
```

An Extension can be a **Listener Source**. A Listener can use an Extension as its **Predicate**. A Listener fires a Workflow that calls more Extensions. The entire platform becomes composable from these two primitives.

---

## 1. The Listener Runtime — Full Redesign

### 1.1 The Three Layers

Every listener is composed of three independent, swappable layers:

```
EVENT ARRIVES
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 1 — SOURCE                                             │
│  Where does the event come from?                              │
│  websocket / sse / http_poll / queue / db_notify /            │
│  file_watch / extension / agent_event / workflow_event        │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 2 — PREDICATE                                          │
│  Should this event fire the workflow?                         │
│  always / jsonpath / jmespath / extension / agent             │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│  LAYER 3 — FIRE POLICY                                        │
│  How do matching events become workflow runs?                 │
│  immediate / batch / debounce / throttle / leading_edge       │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
                    TriggerRuntime.fire()
                    → WorkflowRun created
                    → Engine executes
```

### 1.2 Source Types

```typescript
export type ListenerSource =
  | {
      kind: 'websocket';
      url: string;
      authCredentialId?: string;
      reconnectBackoffMs?: number;   // default: 1000, max: 60000
      maxReconnects?: number;        // default: unlimited
      messageFormat?: 'json' | 'text' | 'binary_base64';
    }
  | {
      kind: 'sse';
      url: string;
      authCredentialId?: string;
      eventTypes?: string[];         // filter by event type name; empty = all
      reconnectDelayMs?: number;
    }
  | {
      kind: 'http_poll';
      url: string;
      method?: 'GET' | 'POST';
      intervalMs: number;            // min: 5000
      authCredentialId?: string;
      cursor?: CursorConfig;
      adaptiveBackoff?: boolean;     // slow down when no changes, speed up when they spike
      headers?: Record<string, string>;
    }
  | {
      kind: 'message_queue';
      protocol: 'amqp' | 'kafka' | 'redis_pubsub' | 'sqs';
      credentialId: string;
      topic: string;                 // queue name, topic, or channel
      consumerGroup?: string;
      batchSize?: number;
    }
  | {
      kind: 'db_notify';
      credentialId: string;
      channel: string;              // Postgres LISTEN/NOTIFY channel
    }
  | {
      kind: 'file_watch';
      path: string;
      events: ('add' | 'change' | 'unlink')[];
      glob?: string;
      debounceMs?: number;
    }
  | {
      // The power move: an Extension IS the source.
      // The isolate calls context.emit(payload) whenever it detects a condition.
      kind: 'extension';
      extensionId: string;
      operationName: string;        // the operation that acts as the source loop
      config: Record<string, unknown>;
      pollIntervalMs?: number;      // if the operation is polling-style
    }
  | {
      kind: 'agent_event';
      agentId: string;
      eventTypes: string[];         // e.g. ['run.completed', 'task.failed']
    }
  | {
      kind: 'workflow_event';
      workflowId: string;
      onStatus: ('COMPLETED' | 'FAILED' | 'CANCELLED')[];
      sourceNodeId?: string;        // narrow to a specific node's completion
    };
```

The **`extension` source** is the critical design choice. When an operator writes a `node_worker` extension that opens a WebSocket, subscribes to a database, polls an obscure API, or watches any other custom condition — that exact extension can become a listener source. No separate listener code to maintain. No re-implementation. The extension they already built and tested is the source.

### 1.3 Cursor Config — Durable Watermarks

The `http_poll` source (and any extension source that is pagination-based) needs to remember where it left off across restarts.

```typescript
export interface CursorConfig {
  scratchpadKey: string;           // Key under which the cursor is stored in the workflow Scratchpad
  extractPath: string;             // JSONPath or JMESPath to extract the cursor value from a received event
  initialValue?: unknown;          // What to use before the first event (e.g. a start timestamp)
  includeCursorInPayload?: boolean; // Inject the cursor into the request as a query param or body field
  cursorParamName?: string;        // Name of the param (e.g. 'since', 'after', 'page_token')
}
```

After every successful fire, the runtime writes the extracted cursor value to `workflowScratchpad[config.scratchpadKey]`. On restart, it reads it back. The workflow never misses an event, even across process restarts.

### 1.4 Predicate Types

```typescript
export type ListenerPredicate =
  | { kind: 'always' }

  | {
      kind: 'jsonpath';
      expression: string;          // e.g. '$.event.type'
      operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'exists' | 'not_exists';
      expected?: unknown;
    }

  | {
      kind: 'jmespath';
      expression: string;          // e.g. "events[?type == 'push']"
      truthy?: boolean;            // assert result is truthy (default: true)
    }

  | {
      kind: 'extension';
      extensionId: string;
      operationName: string;       // The operation is a predicate: (event) => { matched: boolean, reason?: string }
      config?: Record<string, unknown>;
      cacheWindowMs?: number;      // Cache identical event shapes to avoid repeated calls
    }

  | {
      // Semantic judgment — the Agentis-exclusive capability.
      // The event payload is sent to an agent with the given prompt.
      // The agent replies with a structured decision.
      kind: 'agent';
      agentId: string;
      prompt: string;              // e.g. "Does this event represent a meaningful change that needs processing?"
      outputField?: string;        // Field in agent response to check (default: 'decision')
      passValues?: string[];       // Values of outputField that mean "fire" (default: ['yes', 'true', '1'])
      cacheWindowMs?: number;      // Don't re-ask agent for identical payloads within this window
      maxBudgetTokens?: number;    // Cap per-evaluation cost
    };
```

The **`agent` predicate** is the moat. An n8n trigger fires on data. An Agentis listener fires on **meaning**. A deployment pipeline might receive 200 GitHub push events per day. The agent predicate reads each one and decides: "Is this on main? Does it touch production config? Has this been a stable commit for at least 24 hours?" — and only fires the downstream workflow when all three are true. Zero polling, zero missed events, zero false fires.

The **`extension` predicate** is equally powerful for deterministic filtering that would be expensive to write as a JSONPath expression but is trivial as a 10-line JavaScript function in the isolate.

### 1.5 Fire Policy Types

```typescript
export type FirePolicy =
  | { mode: 'immediate' }

  | {
      mode: 'batch';
      size: number;                // Max events per batch
      maxWaitMs: number;           // Fire even if size not reached after this wait
      coalesceKey?: string;        // JSONPath to extract a dedup key; duplicates within the batch are merged
    }

  | {
      mode: 'debounce';
      windowMs: number;            // Reset timer on each new event; fire when quiet
    }

  | {
      mode: 'throttle';
      windowMs: number;            // Fire at most once per window; newest event wins
    }

  | {
      // The most important for agentic workflows.
      // Fire immediately on the first matching event.
      // Suppress all further fires for cooldownMs.
      // When cooldown expires, the next event fires immediately again.
      mode: 'leading_edge';
      cooldownMs: number;
    };
```

**`leading_edge`** is the canonical mode for any workflow that runs an agent. A burst of 50 related GitHub events shouldn't spawn 50 agent workflow runs. `leading_edge` fires once, ignores the storm, then arms again when the storm passes.

### 1.6 The Full ListenerConfig Type

```typescript
export interface ListenerConfig {
  source: ListenerSource;
  predicate?: ListenerPredicate;  // default: { kind: 'always' }
  firePolicy?: FirePolicy;        // default: { mode: 'immediate' }
  cursor?: CursorConfig;          // only relevant for http_poll and extension sources
  payloadTransform?: string;      // optional JMESPath to reshape the event before it becomes workflow inputs
  errorPolicy?: {
    onSourceError: 'pause' | 'continue' | 'deactivate'; // what to do when the source emits an error
    maxConsecutiveErrors?: number; // before deactivating (if onSourceError: 'deactivate')
    alertOnError?: boolean;
  };
}
```

### 1.7 The SourceDriver Interface — The Abstraction

Every source type is a concrete implementation of `SourceDriver`. The runtime instantiates the right driver, connects it to the predicate and fire policy layers, and gives the engine a single clean handle.

```typescript
export interface SourceDriver {
  readonly kind: ListenerSource['kind'];

  /** Start the source. Call onEvent for each incoming event. */
  start(onEvent: (payload: Record<string, unknown>) => void): Promise<void>;

  /** Gracefully close the source connection. */
  close(): Promise<void>;

  /** Runtime diagnostics — surfaced in the trigger health panel. */
  health(): ListenerHealth;
}

export interface ListenerHealth {
  connected: boolean;
  lastEventAt?: string;          // ISO timestamp
  lastFireAt?: string;
  eventCount: number;            // total events received since activation
  fireCount: number;             // total workflow runs fired
  skipCount: number;             // events rejected by predicate or fire policy
  errorCount: number;
  lastError?: string;
}
```

### 1.8 Extension Source — The Sandbox Contract

When `source.kind === 'extension'`, the runtime runs the named operation inside the existing `isolated-vm` isolate, but with an additional `context.emit()` hook:

```javascript
// Inside the extension isolate when used as a listener source:
export async function watchPriceChanges(inputs, ctx) {
  // ctx.emit() sends an event to the listener runtime
  // ctx.config is the ListenerSource.config object
  // ctx.cursor is the current cursor value (if CursorConfig is set)
  // ctx.setCursor(value) persists a new cursor value to Scratchpad

  const response = await fetch(`https://api.example.com/prices?since=${ctx.cursor ?? '0'}`);
  const data = await response.json();

  for (const item of data.items) {
    if (item.priceChange > ctx.config.threshold) {
      ctx.emit({
        symbol: item.symbol,
        oldPrice: item.oldPrice,
        newPrice: item.newPrice,
        changePercent: item.changePercent,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  // Update cursor to the latest timestamp
  ctx.setCursor(data.latestTimestamp);
}
```

The extension isolate's `ctx` object is extended with three new methods when running as a listener source:

| Method | Purpose |
|---|---|
| `ctx.emit(payload)` | Send an event to the listener runtime for predicate + fire policy evaluation |
| `ctx.setCursor(value)` | Persist the cursor to Scratchpad for resumability |
| `ctx.cursor` | Read-only: the current cursor value from Scratchpad |

This means any operator who knows how to write an Extension already knows how to build a Listener source. The same mental model, the same code editor, the same sandboxing guarantees.

---

## 2. Extensions — Runtime Rearchitecture

### 2.1 New Runtime Tiers

The existing three tiers are kept and a fourth is added:

| Tier | Use case | Execution | Isolation |
|---|---|---|---|
| `builtin` | Agentis-provided utilities | In-process | Trusted |
| `node_worker` | Operator JavaScript — any complexity | `isolated-vm` V8 isolate | Full sandbox |
| `docker_sandbox` | Heavy operations, arbitrary languages | Docker container | Container-level |
| `wasm` | **New** — portable, ultra-fast utility operations | WASM runtime (wasmtime) | Capability model |

The `wasm` tier is primarily for extensions that need to be very fast (sub-millisecond) and portable across environments where Docker is not available. Think: data parsing, encoding/decoding, cryptographic operations, regex engines, custom data formats. A WASM extension compiles once and runs everywhere.

### 2.2 Extended Permission Vocabulary

The current permissions are expanded:

```typescript
export type ExtensionPermission =
  // Existing
  | 'network'                // HTTP/HTTPS to declared allowedDomains
  | 'network.unrestricted'   // HTTP/HTTPS to any domain (requires explicit operator grant)
  | 'credentials'            // Read named secrets from workspace vault
  | 'workspace.read'         // Read workflow scratchpad context
  | 'workspace.write'        // Write workflow scratchpad context
  | 'filesystem'             // Use the extension sandbox temp directory
  | 'spawn'                  // docker_sandbox only: spawn child processes

  // New
  | 'listener'               // Extension can be used as a Listener source
  | 'listener.emit'          // Extension can call ctx.emit() (required for listener sources)
  | 'listener.cursor'        // Extension can read/write the Listener cursor
  | 'subagent'               // Extension can send messages to other agents via Agentis bus
  | 'browser'                // Extension can use a headless Chromium session (via Playwright)
  | 'kv.read'                // Read from the workspace KV store (first-class, not scratchpad)
  | 'kv.write'               // Write to the workspace KV store
  | 'emit'                   // Extension can fire workflow_event / agent_event on the bus
  ;
```

The `listener` and `listener.emit` permissions are what the UI shows in the "This extension can be used as a trigger source" disclosure. No extension becomes a listener source silently.

### 2.3 Enhanced Manifest

```typescript
export interface ExtensionManifest {
  // Existing fields — unchanged
  name: string;
  slug: string;
  version: string;
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox' | 'wasm';
  operations: ExtensionOperation[];
  permissions?: ExtensionPermission[];
  credentialKeys?: Array<string | ExtensionCredentialKey>;
  allowedDomains?: string[];
  source?: string;
  image?: string;
  entrypoint?: string;
  timeoutMs?: number;

  // New fields
  description?: string;
  author?: string;
  homepage?: string;
  icon?: string;                    // emoji or URL
  categories?: ExtensionCategory[];
  capabilityTags?: string[];        // free-form searchable tags

  // Listener capability declaration
  listenerOperations?: string[];    // operation names that are valid Listener sources

  // KV store schema
  kvSchema?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    default?: unknown;
  }>;

  // Version history (populated by registry, not by the author)
  changelog?: { version: string; notes: string; date: string }[];

  // Extension dependencies (other extensions this one requires)
  extensionDependencies?: { slug: string; version: string }[];
}

export type ExtensionCategory =
  | 'data'
  | 'communication'
  | 'ai'
  | 'infrastructure'
  | 'monitoring'
  | 'security'
  | 'productivity'
  | 'finance'
  | 'developer'
  | 'custom';
```

### 2.4 Per-Operation Extended Schema

```typescript
export interface ExtensionOperation {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;

  // New
  examples?: Array<{
    label: string;
    input: Record<string, unknown>;
    expectedOutput?: Record<string, unknown>;
  }>;
  cachePolicy?: {
    defaultTtlSeconds?: number;
    keyParts?: string[];
  };
  isListenerSource?: boolean;       // Marks this operation as a valid Listener source
  listenerConfig?: {
    emitsEvents?: boolean;
    cursorSupported?: boolean;
    description?: string;           // "Polls the API every N seconds and emits price change events"
  };
  requiredPermissions?: ExtensionPermission[];  // Subset of manifest permissions needed for THIS operation
  estimatedCostPerCall?: {
    tokensIn?: number;
    tokensOut?: number;
    computeMs?: number;
  };
}
```

### 2.5 The Extension KV Store

Beyond the workflow Scratchpad (which is per-run), extensions now have access to a **workspace-scoped KV store** with the `kv.read` / `kv.write` permissions. This is critical for listener sources that need to maintain rolling state across many workflow runs:

```javascript
export async function watchNewGitHubPRs(inputs, ctx) {
  // Read the last seen PR number from KV — persists across ALL workflow runs
  const lastSeen = await ctx.kv.get('lastSeenPrNumber') ?? 0;
  
  const prs = await fetch(`https://api.github.com/repos/${inputs.repo}/pulls?since=${lastSeen}`);
  
  for (const pr of prs) {
    if (pr.number > lastSeen) {
      ctx.emit({ pr });
    }
  }
  
  if (prs.length > 0) {
    await ctx.kv.set('lastSeenPrNumber', Math.max(...prs.map(p => p.number)));
  }
}
```

The KV store is implemented as a dedicated `extension_kv` table with `(workspace_id, extension_id, key, value, updated_at)`. TTL is supported. The schema is declared in `manifest.kvSchema` and validated on write.

---

## 3. Extensions — The Studio Redesign

The current extension creation experience in `PackagesPage.tsx` is a long drawer form with raw JSON schema editors. It works. It does not delight. This section rearchitects the entire creation, management, and discovery surface.

### 3.1 The Extension Hub — A Dedicated Page

Extensions graduate from a filter tab on `PackagesPage` to their own top-level page: **`/extensions`**.

```
/extensions                 → Extension Hub (gallery + creation + management)
/extensions/:slug           → Extension Detail (operations, executions, tests, KV store)
/extensions/:slug/edit      → Extension Studio (full-screen code editor + manifest editor)
/extensions/:slug/history   → Execution history with operation-level drill-down
```

The `PackagesPage` retains the Extensions filter tab as a summary view, but clicking "View all extensions" navigates to `/extensions`. The Hub is the canonical home.

### 3.2 Extension Hub Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  EXTENSIONS                                        [+ New Extension]  │
│  Sandboxed capability units for your workspace.                       │
├──────────────────────────────────────────────────────────────────────┤
│  [Search extensions...]   [Category ▾]  [Runtime ▾]  [Sort: Recent ▾]│
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─────────────────────┐ ┌─────────────────────┐ ┌────────────────┐  │
│  │ ⬡ GitHub Scraper    │ │ ⬡ Slack Notifier    │ │ ⬡ Stripe Sync  │  │
│  │ node_worker · v1.3  │ │ node_worker · v2.0  │ │ docker · v0.9  │  │
│  │                     │ │                     │ │                │  │
│  │ 3 operations        │ │ 1 operation         │ │ 5 operations   │  │
│  │ 🌐 network          │ │ 🌐 network          │ │ 🌐 network     │  │
│  │ 🔑 credentials      │ │ 🔑 credentials      │ │ 🔑 credentials │  │
│  │                     │ │                     │ │                │  │
│  │ 12 runs today       │ │ 3 runs today        │ │ 0 runs today   │  │
│  │ ● Listener source   │ │                     │ │                │  │
│  │                     │ │                     │ │                │  │
│  │ [Open] [Test] [···] │ │ [Open] [Test] [···] │ │ [Open] [···]   │  │
│  └─────────────────────┘ └─────────────────────┘ └────────────────┘  │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐│
│  │ ✦ REGISTRY                                          [Browse all] ││
│  │ Verified community extensions available to install                ││
│  │ [⬡ PDF Extractor]  [⬡ SendGrid]  [⬡ Twilio]  [⬡ OpenAI]        ││
│  └───────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

**Extension cards** surface everything a workflow builder needs to evaluate an extension at a glance:
- Name, slug, version, runtime tier
- Operation count
- Permission chips (coloured by permission type)
- **Run count today** — usage is visible without clicking
- **● Listener source** badge — immediately clear this extension can be used as a trigger
- Usage count in workflows (e.g. "Used in 4 workflows")

### 3.3 Extension Studio — Full-Screen Author Experience

When an operator clicks **New Extension** or **Edit**, they enter the Extension Studio — a full-screen, IDE-grade editing experience. No more drawer with a textarea.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Extension Studio                                    [Save] [Test] [···] │
├──────────────────┬─────────────────────────────────────────────────────┤
│  MANIFEST        │  CODE EDITOR                                         │
│  ──────────      │  ──────────────────────────────────────────────────  │
│  Name            │  export async function scrape_profile(inputs, ctx) { │
│  [GitHub ...]    │    const url = String(inputs.url ?? '');             │
│                  │    // ctx.http.fetch() — sandboxed, domain-checked   │
│  Slug            │    const resp = await ctx.http.fetch(url);           │
│  [github-...]    │    return { url, title: resp.body.substring(0, 100) }│
│                  │  }                                                   │
│  Version         │                                                      │
│  [1.0.0]         │  export async function search_people(inputs, ctx) {  │
│                  │    // ...                                             │
│  Runtime         │  }                                                   │
│  ◉ node_worker   │                                                      │
│  ○ builtin       ├──────────────────────────────────────────────────────│
│  ○ docker        │  OPERATIONS                            [+ Add]        │
│  ○ wasm          │                                                      │
│                  │  ┌─────────────────────────────────────────────────┐ │
│  PERMISSIONS     │  │ scrape_profile                                  │ │
│  ────────────    │  │ Input: { url: string }                          │ │
│  ☑ network       │  │ Output: { url, title, extractedAt }             │ │
│  ☑ credentials   │  │ [Listener source ●]  [Examples: 2]  [▼ Expand] │ │
│  ☐ filesystem    │  └─────────────────────────────────────────────────┘ │
│  ☐ kv.read       │  ┌─────────────────────────────────────────────────┐ │
│  ☐ kv.write      │  │ search_people                                   │ │
│  ☐ listener      │  │ Input: { query: string, limit: number }         │ │
│  ☐ browser       │  │ Output: Person[]                                │ │
│                  │  │ [▼ Expand]                                      │ │
│  DOMAINS         │  └─────────────────────────────────────────────────┘ │
│  linkedin.com ×  │                                                      │
│  [+ Add domain]  ├──────────────────────────────────────────────────────│
│                  │  LISTENER CONFIG                                      │
│  CREDENTIALS     │  ──────────────────────────────────────────────────  │
│  li_session ×    │  ● scrape_profile marked as listener source         │
│  [+ Add key]     │  This operation can be used as a persistent trigger  │
│                  │  source. Callers must also grant: listener.emit      │
│  CATEGORIES      │                                                      │
│  ☑ data          │  Description for workflow builders:                 │
│  ☑ developer     │  [Monitors LinkedIn profiles for changes. Emits...] │
│                  │                                                      │
│  [SAVE DRAFT]    │  Cursor support: ● Yes ○ No                        │
└──────────────────┴─────────────────────────────────────────────────────┘
```

**Key improvements over the current drawer:**

1. **Real code editor** — Monaco (already a transitive dep via the canvas templated fields) with TypeScript intelligence, autocomplete for `ctx.http.fetch`, `ctx.kv`, `ctx.emit`, `ctx.cursor`, and the full `ctx.meta` type.

2. **Visual schema builder** — Operations get a schema builder with field-level type pickers, descriptions, and examples. Raw JSON is still available for advanced users but is not the default.

3. **Listener declaration is first-class** — Not a checkbox buried under "advanced settings." It's a visible section of the Studio that explains the implications and requires explicit permission grants.

4. **Live test console** — Every operation has a test pane. You type input JSON, click Run, and see output + logs in real time. Errors are highlighted with line references. The test runs against the real sandbox with the extension's declared permissions.

5. **Operation examples** — Each operation can declare input/output example pairs. These are used in the test console, surfaced in canvas autocompletion, and shown to agents using the extension in their context.

### 3.4 Extension Detail Page

The detail page for an installed extension has three tabs:

**Operations tab:**
```
scrape_profile                                    [Test this operation]
─────────────────────────────────────────────────────────────────────
Input schema:
  url (string, required) — The LinkedIn profile URL to scrape

Output schema:
  url (string) — Echo of input
  title (string) — First 100 chars of the page title
  extractedAt (string) — ISO timestamp

Listener source: YES
  This operation can be the source for a persistent listener trigger.
  Operations executed as sources receive ctx.emit() and ctx.cursor.

2 examples — [View all]
─────────────────────────────────────────────────────────────────────
Cache policy: TTL 300s, keyed on: url

Estimated cost: ~50ms compute, 0 tokens
```

**Execution history tab:**
```
Last 50 executions           [Filter by operation] [Filter by status]

scrape_profile    ✓ 142ms   workflow: LinkedIn Monitor  3 mins ago
search_people     ✗ TIMEOUT  workflow: Prospect Finder  12 mins ago
scrape_profile    ✓ 88ms    workflow: LinkedIn Monitor  18 mins ago
...

[Load more]
```

**KV Store tab** (only if `kv.read` or `kv.write` permission granted):
```
Workspace KV store for this extension

lastSeenPrNumber   1847   Updated 2 mins ago
watchedProfiles    {...}  Updated 14 mins ago
rateLimitState     {...}  Updated 3 mins ago

[View raw]  [Clear all]
```

---

## 4. The Listener Trigger — Full UI Redesign

### 4.1 Current State of the Art

The persistent listener today has two problems:

1. **Technical**: `onFire` is not threaded through `TriggerConfig`. The adapter has no way to fire the workflow. This is a bug.
2. **UX**: The trigger config inspector for `persistent_listener` in `ContextInspector.tsx` is a plain JSON text area. There is no structured UI. Operators cannot configure it. No one can tell what it does.

### 4.2 The New Trigger Configuration UI

The workflow canvas trigger node inspector for `persistent_listener` becomes a three-panel wizard:

```
TRIGGER — Persistent Listener
────────────────────────────────────────────────────

  [SOURCE]  →  [PREDICATE]  →  [FIRE POLICY]

  Step 1 of 3: What should Agentis listen to?

  ┌────────────────────────────────────────────────┐
  │ SOURCE TYPE                                     │
  │                                                │
  │ ○ WebSocket                                    │
  │   Connect to a WebSocket URL and receive       │
  │   JSON messages.                               │
  │                                                │
  │ ○ Server-Sent Events (SSE)                     │
  │   Subscribe to an SSE stream.                  │
  │                                                │
  │ ○ HTTP Poll                                    │
  │   Poll an HTTP endpoint on an interval.        │
  │                                                │
  │ ○ Message Queue                                │
  │   AMQP, Kafka, Redis Pub/Sub, or SQS.          │
  │                                                │
  │ ○ Database Notify                              │
  │   PostgreSQL LISTEN/NOTIFY channel.            │
  │                                                │
  │ ● Extension Source                             │
  │   Use a custom Extension operation as the      │
  │   source. Full sandbox, any logic.             │
  │   [github-scraper · watchNewPRs ▾]             │
  │                                                │
  │ ○ Agent Event                                  │
  │   Fire when another agent emits an event.      │
  │                                                │
  │ ○ Workflow Event                               │
  │   Fire when another workflow completes.        │
  └────────────────────────────────────────────────┘

                           [Next: Predicate →]
```

Step 2 shows the predicate options, with the agent predicate behind a "Semantic filter (uses AI)" label. Step 3 shows the fire policy options with a plain English description of each mode and an input for the relevant parameter.

### 4.3 Listener Health Panel

Every active listener trigger displays a health card in the workflow canvas sidebar:

```
LISTENER HEALTH                              ● Connected
──────────────────────────────────────────────────────
Source: Extension — github-scraper · watchNewPRs
Predicate: Extension — pr-filter · isSignificant
Fire policy: leading_edge (cooldown: 5 min)

Last event:    2 minutes ago
Last fire:     47 minutes ago
Events today:  1,247
Fires today:   3
Skipped today: 1,244  (predicate rejected)
Errors today:  0

[Pause]  [Fire now]  [View event log]
```

This is the diagnostic surface that currently doesn't exist. Operators can see exactly why their listener is or isn't firing, view the last N raw events it received, and see which were rejected by the predicate.

### 4.4 Event Log

A new endpoint `GET /v1/triggers/:id/events` returns the last N events received by a listener, with their predicate result:

```json
{
  "events": [
    {
      "id": "evt_01jf8x...",
      "receivedAt": "2026-05-29T21:04:22Z",
      "payload": { "pr": { "number": 1847, "title": "..." } },
      "predicateResult": { "matched": false, "reason": "Draft PR" },
      "firedRun": null
    },
    {
      "id": "evt_01jf8w...",
      "receivedAt": "2026-05-29T21:03:11Z",
      "payload": { "pr": { "number": 1846, "title": "..." } },
      "predicateResult": { "matched": true },
      "firedRun": { "id": "run_01jf8v...", "status": "COMPLETED" }
    }
  ]
}
```

This event log is stored in memory with a configurable TTL (default: 1 hour, max: 24 hours). It is NOT persisted to the DB by default — it is a live diagnostic surface, not a permanent audit log.

---

## 5. The Integration — Extensions as Listeners

The full power of the system emerges when these two features are designed to work together. Here are the patterns this enables:

### Pattern 1: Monitoring Platform

An operator builds a suite of extensions:
- `metrics-fetcher` with operations: `getServerMetrics`, `getErrorRate`, `getP99Latency`
- `anomaly-detector` with operation: `detectAnomaly(baseline, current) → { isAnomaly, severity, reason }`

They create a listener trigger on their SRE workflow:
- Source: extension `metrics-fetcher · getServerMetrics` (polls every 60s)
- Predicate: extension `anomaly-detector · detectAnomaly`
- Fire policy: `leading_edge(cooldownMs: 300_000)`

The workflow fires when and only when there's an actual anomaly. The agent in the workflow gets the full context and decides what action to take. Zero polling overhead when everything is healthy. Zero false positives from threshold-based rules that don't understand context.

### Pattern 2: Competitive Intelligence

An operator builds:
- `web-watcher` with `watchPage(url, selector) → { content, hash }` as a listener source
- `diff-analyzer` with `analyzeDiff(old, new) → { significantChanges, summary }`

Listener trigger on their intelligence workflow:
- Source: extension `web-watcher · watchPage` (polls competitor pricing pages every hour)
- Predicate: agent (prompt: "Are these changes significant enough to notify the team? Reply YES or NO.")
- Fire policy: `batch(size: 10, maxWaitMs: 3600000)` — collect changes for an hour then process together

The agent gets a full batch of changes, reasons about which ones are significant, and generates a comprehensive briefing. No noise, no spam, no missed signals.

### Pattern 3: Multi-Step Enrichment

An operator builds:
- `crm-poller` with `getNewLeads() → Lead[]` as a listener source
- `lead-enricher` with operations: `getLinkedInProfile`, `getCompanyData`, `scoreLead`

Listener fires a workflow that calls the enricher extensions as `extension_task` nodes. The enriched leads are written back to the CRM using another extension.

The entire pipeline — observation, enrichment, action — is built from extensions and listeners. No external code execution environment needed. No custom infrastructure. Just Agentis.

---

## 6. New API Surface

### 6.1 Listener API

```
GET    /v1/listeners                               List all listener triggers
GET    /v1/listeners/:id                           Get listener config and health
PATCH  /v1/listeners/:id                           Update listener config (reactivates)
POST   /v1/listeners/:id/pause                     Pause the listener
POST   /v1/listeners/:id/resume                    Resume a paused listener
POST   /v1/listeners/:id/fire-now                  Manually fire the trigger
GET    /v1/listeners/:id/health                    Real-time health metrics
GET    /v1/listeners/:id/events                    Recent event log
DELETE /v1/listeners/:id/events                    Clear event log
```

### 6.2 Extension API Additions

```
GET    /v1/extensions/:id/kv                       List KV store entries
GET    /v1/extensions/:id/kv/:key                  Get a KV value
PUT    /v1/extensions/:id/kv/:key                  Set a KV value
DELETE /v1/extensions/:id/kv/:key                  Delete a KV entry
DELETE /v1/extensions/:id/kv                       Clear the entire KV store

GET    /v1/extensions/:id/executions               Execution history (operation-level)
GET    /v1/extensions/listener-sources             List all extensions with listener-capable operations
```

### 6.3 Trigger Config Schema Addition

The `triggers.config` JSON column is backward-compatible. A new `listenerConfig` sub-object is recognised alongside the existing adapter-coupled `agentId` field:

```typescript
// Existing (still valid for backward compat)
{
  triggerType: 'persistent_listener',
  config: { agentId: 'xxx' }
}

// New — full ListenerConfig
{
  triggerType: 'persistent_listener',
  config: {
    source: { kind: 'extension', extensionId: '...', operationName: 'watchNewPRs', config: { ... } },
    predicate: { kind: 'agent', agentId: '...', prompt: '...', cacheWindowMs: 60000 },
    firePolicy: { mode: 'leading_edge', cooldownMs: 300000 }
  }
}
```

The `#activatePersistentListener` method in `TriggerRuntime.ts` detects which config format is present and routes accordingly. Adapter-coupled listeners continue to work until explicitly migrated.

---

## 7. New Files

The implementation requires these new modules (all under `apps/api/src/`):

| File | Purpose |
|---|---|
| `engine/ListenerRuntime.ts` | `SourceDriver` interface + coordinator that connects source → predicate → fire policy |
| `engine/sources/WebSocketSource.ts` | WebSocket source driver |
| `engine/sources/SseSource.ts` | SSE source driver |
| `engine/sources/HttpPollSource.ts` | HTTP poll source driver with cursor support |
| `engine/sources/QueueSource.ts` | AMQP / Kafka / Redis / SQS source driver |
| `engine/sources/DbNotifySource.ts` | Postgres LISTEN/NOTIFY source driver |
| `engine/sources/ExtensionSource.ts` | Extension-as-source driver — wraps the isolate with ctx.emit / ctx.cursor |
| `engine/sources/AgentEventSource.ts` | Agent event bus subscriber |
| `engine/sources/WorkflowEventSource.ts` | Workflow event bus subscriber |
| `engine/ListenerPredicate.ts` | `evaluate(event, predicate) → Promise<boolean>` with all backends |
| `engine/ListenerFirePolicy.ts` | Fire policy implementations: immediate, batch, debounce, throttle, leading_edge |
| `engine/ListenerCursor.ts` | Read/write cursor from Scratchpad + extraction via JSONPath/JMESPath |
| `engine/ListenerHealthStore.ts` | In-memory health metrics store + event log ring buffer |
| `extensions/kv.ts` | Extension KV store read/write + TTL sweep |
| `extensions/wasmRuntime.ts` | WASM runtime driver (wasmtime via Node FFI or WASM-in-Node) |

The web additions:

| File | Purpose |
|---|---|
| `pages/ExtensionsPage.tsx` | New Extension Hub page at `/extensions` |
| `pages/ExtensionDetailPage.tsx` | Detail page at `/extensions/:slug` |
| `pages/ExtensionStudioPage.tsx` | Full-screen editor at `/extensions/:slug/edit` |
| `components/canvas/ListenerInspector.tsx` | The three-panel wizard for `persistent_listener` trigger config |
| `components/canvas/ListenerHealthPanel.tsx` | Real-time health card for active listeners |
| `components/extensions/ExtensionCard.tsx` | Standalone card component (extracted from PackagesPage) |
| `components/extensions/OperationSchemaBuilder.tsx` | Visual schema editor (no raw JSON) |
| `components/extensions/OperationTestConsole.tsx` | Live sandbox test console |
| `components/extensions/ListenerSourcePicker.tsx` | Extension picker filtered to listener-capable operations |

---

## 8. DB Schema Additions

All additions are non-breaking. New columns have defaults.

```sql
-- Extension KV store
CREATE TABLE extension_kv (
  workspace_id  TEXT NOT NULL,
  extension_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,         -- JSON
  updated_at    TEXT NOT NULL,
  expires_at    TEXT,                  -- NULL = no TTL
  PRIMARY KEY (workspace_id, extension_id, key),
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE CASCADE
);
CREATE INDEX idx_extension_kv_expiry ON extension_kv(expires_at) WHERE expires_at IS NOT NULL;

-- Listener health (in-memory but backed by DB for persistence across restarts)
CREATE TABLE listener_health (
  trigger_id        TEXT PRIMARY KEY,
  connected         INTEGER NOT NULL DEFAULT 0,
  last_event_at     TEXT,
  last_fire_at      TEXT,
  event_count       INTEGER NOT NULL DEFAULT 0,
  fire_count        INTEGER NOT NULL DEFAULT 0,
  skip_count        INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE
);

-- Extend triggers with the new config shape (backward compatible — config is already JSON)
-- No DDL needed: the config column already accepts arbitrary JSON.
-- The new ListenerConfig shape is a superset of the existing { agentId } shape.
```

---

## 9. Realtime Events (additions)

```typescript
// New events emitted on the EventBus and forwarded to WebSocket clients
LISTENER_CONNECTED       { triggerId, sourceKind }
LISTENER_DISCONNECTED    { triggerId, sourceKind, reason }
LISTENER_EVENT_RECEIVED  { triggerId, eventId, payloadSummary }   // throttled
LISTENER_PREDICATE_PASS  { triggerId, eventId }
LISTENER_PREDICATE_FAIL  { triggerId, eventId, reason? }
LISTENER_FIRE_SUPPRESSED { triggerId, eventId, policy, nextWindowAt? }
LISTENER_FIRED           { triggerId, eventId, runId }
LISTENER_ERROR           { triggerId, errorCode, message }
```

These events power the real-time health card in the canvas. The `LISTENER_EVENT_RECEIVED` event is throttled to `PRESENCE_EVENT_THROTTLE_MS=50` and coalesced — the UI shows a live counter, not a firehose.

---

## 10. The North Star

When this ships, an Agentis operator can:

1. Open the Extension Hub, click **New Extension**, and author a production-grade data scraper in a Monaco editor with TypeScript autocompletion — in 10 minutes.

2. Mark one of its operations as a **Listener source** — checking a box and writing a two-sentence description for workflow builders.

3. Open a workflow canvas, drag in a trigger node, select **Persistent Listener**, pick their extension from the source picker, add an agent predicate with a natural-language prompt, set a fire policy — all through a structured wizard that does not require knowing what JSON looks like.

4. See their listener become alive on the canvas: connection indicator, live event counter, skip rate, last fire timestamp — all without opening a terminal or reading a log file.

5. Click "Fire now" to test it, see a run start, inspect the inputs the listener delivered, and tune the predicate prompt if the agent is filtering too aggressively or not aggressively enough.

6. Build a monitoring platform, an intelligence pipeline, a real-time data sync, or a world-class customer workflow — using the same two primitives throughout.

That is what 10x looks like. Not a feature. A platform.

---

## 11. Open Questions

- **WASM runtime**: wasmtime requires a native Node addon. Should we add it as an optional peer dep like `isolated-vm`, or ship it as part of a Docker-only deployment profile?

- **Browser permission**: The `browser` permission adds a Playwright dependency. This is heavy. Should it be a separate add-on install (`agentis install-addon browser`) rather than shipping in the core image?

- **Event log persistence**: The in-memory event log (last N events per listener) helps debugging but is lost on restart. Should we offer an opt-in persistent event log (written to SQLite) with a configurable retention period? Default: off.

- **Agent predicate cost control**: Agent predicates cost tokens. Should we add a per-trigger monthly token budget cap at the workspace level? The `maxBudgetTokens` per-call limit is a start, but a monthly cap prevents runaway cost in high-volume listeners.

- **Multi-source fan-in**: Can a single listener trigger have multiple sources? (e.g., "fire when EITHER this WebSocket OR this poll detects X"). This is powerful but adds significant complexity to the `ListenerRuntime`. Proposal: defer to v2, allow array notation in config to future-proof the schema.

- **Extension registry provenance**: When an extension is used as a listener source, it runs continuously in the process (unlike a one-shot extension_task call). Should registry extensions require additional vetting before they can declare `listenerOperations`? Proposal: yes — `listener` permission is operator-grant-only and never auto-granted from the registry.

---

## 12. Implementation Log — 2026-05-29

> Status reconciled with shipped code. This section is the source of truth for
> what actually exists vs. what the design above proposes. Built as one coherent
> vertical slice; everything below typechecks (`@agentis/core`, `@agentis/db`,
> `@agentis/api`, `@agentis/web`) and the runtime core is unit + integration
> tested (24 passing).

### 12.1 Architectural decisions (and where I diverged from the plan)

The doc proposes a broad surface, some of which bets on native dependencies that
are **not installed** on the current host (`ws`, `jsonpath`, `jmespath`,
`isolated-vm`, `node-cron`, Kafka/AMQP/SQS clients, `wasmtime`, Playwright). As
the architect I built the **dependency-free substrate that runs on Node 24
today** and made the rest degrade gracefully behind clean interfaces rather than
ship brittle code or force heavy installs:

- **Zero new dependencies.** WebSocket / SSE / HTTP-poll drivers use Node 24
  globals (`WebSocket`, `fetch`, `ReadableStream`, `TextDecoder`). JSONPath /
  JMESPath are a small in-repo evaluator (`jsonpath.ts`) covering the practical
  subset (dotted/bracket paths, `[*]`, `items[?f == 'v']` filters) instead of
  pulling two libraries.
- **Graceful unavailability.** `message_queue` and `db_notify` resolve to an
  `UnavailableSource` that fails activation with a structured
  `LISTENER_SOURCE_UNAVAILABLE` error — the schema, UI, and config are all
  future-proofed; only the transport is missing.
- **Cursor reuses existing infra.** Rather than the run-scoped scratchpad (which
  is disposed at run end and cannot survive restarts), the durable cursor is
  persisted in the existing `workflow_kv_entries` table via
  `WorkflowStoreService`, namespaced per trigger (`__listener_cursor__:<id>:…`).
- **Agent predicate decoupled.** The semantic predicate is injected as an
  `agentJudge` function (`engine/listener/agentJudge.ts`) wired to the adapter
  `chat()` stream, so `ListenerRuntime` has no dependency on chat internals and
  fails closed (never silently fires) when an agent has no chat capability.
- **Backward compatibility preserved.** `TriggerRuntime.#activatePersistentListener`
  routes config with a `source` key to the new `ListenerRuntime`; the legacy
  adapter-coupled `{ agentId }` listener still uses `createPersistentListener`.
  Detection is `isListenerConfigV2()` in `@agentis/core`.

### 12.2 Built — backend

| Area | Files |
|---|---|
| Core types | `packages/core/src/types/listener.ts` (ListenerConfig, ListenerSource, ListenerPredicate, FirePolicy, CursorConfig, ListenerHealth, ListenerEventLogEntry, SourceDriver, `isListenerConfigV2`); extended `ExtensionPermission` (+`listener`, `listener.emit`, `listener.cursor`, `kv.read`, `kv.write`) and `ExtensionOperation`/`ExtensionManifest` (isListenerSource, listenerConfig, listenerOperations); `LISTENER_*` realtime events; `LISTENER_*` error codes |
| Coordinator | `apps/api/src/engine/ListenerRuntime.ts` — wires source → predicate → fire-policy → `fire()`, health, realtime events, pause/resume/fire-now/error-policy |
| Source drivers | `apps/api/src/engine/listener/sources.ts` — http_poll (cursor + adaptive backoff), websocket (reconnect/backoff), sse (stream parse + reconnect), extension (the power move), agent_event, workflow_event, file_watch, UnavailableSource |
| Predicate | `apps/api/src/engine/listener/predicate.ts` — always / jsonpath / jmespath / extension / agent, with a TTL result cache; `agentJudge.ts` |
| Fire policy | `apps/api/src/engine/listener/firePolicy.ts` — immediate / batch (coalesce) / debounce / throttle / leading_edge |
| Cursor / health / paths | `cursor.ts`, `health.ts` (in-memory health + 100-entry event ring buffer), `jsonpath.ts` |
| Extension KV | `apps/api/src/extensions/kv.ts` + `extension_kv` table (schema + migration **v50**) |
| Isolate contract | `nodeWorkerRuntime.ts` — `ctx.emit` / `ctx.cursor` / `ctx.setCursor` / `ctx.kv` exposed via permission-gated `isolated-vm` references; `ExtensionRuntime.executeListenerSource()` |
| API | `apps/api/src/routes/listeners.ts` (`GET /v1/listeners`, `/:id`, `/:id/health`, `/:id/events`, `DELETE /:id/events`, `POST /:id/pause|resume|fire-now`, `PATCH /:id`); extended `routes/extensions.ts` (`GET /listener-sources`, `GET /:id/executions`, full `/:id/kv` CRUD) |
| Wiring | `bootstrap.ts` constructs `ExtensionKvStore`, `ListenerHealthStore`, `ListenerRuntime` (late-bound `fire` to break the cycle with `TriggerRuntime`), mounts `/v1/listeners`, passes `kv` to extensions routes |
| Tests | `apps/api/tests/engine/ListenerRuntime.test.ts` — jsonpath-lite, predicate ops, all 5 fire policies (fake timers), cursor, and a bus-driven end-to-end (agent_event → jsonpath predicate → immediate fire → health) |

### 12.3 Built — frontend

- `components/canvas/ListenerInspector.tsx` — the three-layer wizard (SOURCE →
  PREDICATE → FIRE POLICY) replacing the old plain-text placeholder in the
  trigger node inspector. Pulls listener-source extensions from
  `/v1/extensions/listener-sources`, and **debounce-persists the structured
  config to the trigger row** when the node has a `triggerId` (so the runtime
  reads it). Falls back to round-tripping on the graph node otherwise.
- `components/canvas/ListenerHealthPanel.tsx` — live health card (connection dot,
  event/fire/skip/error counters, last-fire, **Fire now** button) polling
  `/v1/listeners/:id/health`.
- `pages/PackagesPage.tsx` Extension Studio — per-operation **"Use as a Listener
  source"** toggle (auto-grants `listener`+`listener.emit`), plus the five new
  permission chips (listener / listener.emit / listener.cursor / kv.read /
  kv.write). `install-local` now carries `isListenerSource` + `listenerOperations`.

### 12.4 Deliberately deferred (clean stubs / interfaces in place)

- **Queue + DB-notify drivers** — `UnavailableSource` today; need broker / pg
  add-ons. Schema + UI already accept them.
- **WASM runtime tier (§2.1)** and **`browser` permission (§2.2)** — not added;
  both are heavy native bets. The permission vocabulary stays the live subset.
- **DB-persisted event log (§11)** — event log is in-memory ring buffer only
  (the doc's stated default). `listener_health` table not created; health is
  in-memory and rebuilt on activate.
- **Full-screen Monaco Extension Studio + dedicated `/extensions` Hub (§3.1–3.4)**
  — kept the existing drawer-based Studio in PackagesPage and extended it; the
  Hub/route split and Monaco are a follow-up UI track.
- **Credential resolution for source auth** (`authCredentialId`) — accepted in
  the schema; headers are passed through but the credential vault lookup is not
  yet wired into the drivers.

### 12.5 How to use it today

1. Extension Studio → author a `node_worker` extension, mark an operation
   **"Use as a Listener source"** (grants `listener`/`listener.emit`; add
   `listener.cursor` + `kv.*` as needed). The op calls `ctx.emit(payload)`.
2. Canvas → trigger node → **Persistent listener** → wizard: pick the extension
   source (or http_poll/websocket/sse/agent_event/workflow_event/file_watch),
   add a predicate (try the **Semantic (AI)** agent predicate), choose a fire
   policy (**leading_edge** for agent workflows).
3. Register/activate the trigger (`POST /v1/triggers` then activate, or the
   canvas autosaves config to the linked trigger row). Watch the health panel;
   hit **Fire now** to test.

### 12.6 Addendum — isolated-vm made optional + in-canvas creation

Two follow-ups after the first pass:

- **`isolated-vm` is no longer a gate.** A built-in `node:vm` fallback runtime
  (`apps/api/src/extensions/vmRuntime.ts`, zero dependencies) runs operator
  extensions out of the box — same `ctx` surface (`http`/`kv`/`emit`/`cursor`),
  same permission checks, same SSRF guard, sync-timeout + async Promise.race
  bound. `isolated-vm` is now **auto-detected hardening**: present → used;
  absent → vm fallback with a one-shot warning. Set
  `AGENTIS_EXTENSION_REQUIRE_ISOLATE=true` to refuse execution without a real
  isolate (untrusted/registry deployments). Security note: `node:vm` is not a
  hard boundary — appropriate for an operator's own workspace code, which is the
  default value path. Proven by `tests/extensions/vmRuntime.test.ts` (pure op,
  network-denied, and the full listener `ctx.emit`/`ctx.kv`/`ctx.cursor`
  contract) — all green with isolated-vm **not installed**.

- **One "Build extension" surface, everywhere.** New shared
  `components/extensions/ExtensionStudioModal.tsx` (two-pane: code + manifest /
  operations / permissions, first-class listener-source toggle). Wired into:
  (a) the **workflow canvas** — a "Build new extension" button in
  `ExtensionCombobox` (every `extension_task` node) that creates and
  auto-selects the extension without leaving the canvas, and a "Build a
  listener-source extension" button in the `ListenerInspector` empty state;
  (b) the **Packages library** — the old `ExtensionStudioDrawer` (~400 lines)
  was removed and its create buttons now open the same modal. Creating an
  extension is now the identical fast flow from the canvas or the library.
