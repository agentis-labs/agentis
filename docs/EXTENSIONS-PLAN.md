# Agentis Extensions - Implemented Architecture

**Status:** Implemented  
**Date:** May 2026  
**Scope:** Deterministic, local-first Extension runtime, Packages UI, and workflow canvas integration.

## 1. Product Direction

Extensions are the deterministic execution layer in Agentis. They are named,
versioned, sandboxed capability units that can expose one or more typed
operations under a single installable identity.

An Extension answers a clear user question: "What reusable machine capability
can my agent or workflow call without spending reasoning tokens?"

Example:

```text
Extension: LinkedIn Scraper
  version: 1.2.0
  credentials: li_session_cookie
  permissions: network, credentials

  operations:
    scrape_profile(url) -> ProfileData
    search_people(query, limit) -> Person[]
    get_company(domain) -> CompanyData
```

The Extension owns the shared manifest, runtime, permissions, credentials, and
source. Each operation remains deterministic and stateless. Any persistence must
be explicit through workflow scratchpad or future workspace APIs.

## 2. Design Principles

- **One capability, many operations.** Related runtime actions stay together so
  operators can reason about permissions, ownership, versioning, and usage.
- **Local-first execution.** Code runs inside the operator's Agentis instance
  using `builtin`, `node_worker`, or `docker_sandbox` runtimes.
- **Typed boundaries.** Operations declare input and output schemas, making
  canvas configuration and testing understandable.
- **Visible trust.** Permissions, credentials, allowed domains, runtime, and
  source are visible before install and during review.
- **Workflow-native.** `extension_task` is a first-class workflow node with an
  explicit `operationName`.
- **Authorable by operators.** Packages now includes an Extension studio for
  creating source-backed local Extensions without leaving the app.

## 3. Core Contract

`packages/core/src/types/extension.ts` is the canonical contract.

```ts
export interface ExtensionOperation {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ExtensionManifest {
  name: string;
  slug: string;
  version: string;
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox';
  operations: ExtensionOperation[];
  permissions?: ExtensionPermission[];
  credentialKeys?: Array<string | ExtensionCredentialKey>;
  allowedDomains?: string[];
  source?: string;
  image?: string;
  entrypoint?: string;
}
```

The workflow config is:

```ts
{
  kind: 'extension_task',
  extensionId?: string,
  extensionSlug?: string,
  operationName: string,
  version?: string,
  inputMapping: Record<string, string>,
  outputMapping: Record<string, string>,
  timeoutMs?: number
}
```

## 4. Runtime Behavior

`apps/api/src/services/extensionRuntime.ts` resolves the Extension row, normalizes
the manifest, finds the requested operation, validates install-time safety, and
dispatches to the selected runtime.

Operation lookup is strict. If the requested operation is absent, execution fails
with `EXTENSION_OPERATION_NOT_FOUND`.

The `node_worker` runtime expects named exports:

```js
export async function scrape_profile(inputs, ctx) {
  return {
    url: inputs.url,
    extractedAt: new Date().toISOString()
  };
}
```

The runtime passes operation metadata through `ctx.meta.extension.operationName`,
records the operation in `extension_executions`, and returns it in the execution
outcome.

## 5. Database

SQLite and Postgres schemas define:

- `extensions`
- `extension_executions`

`extension_executions.operation_name` is required so a workflow run can be audited
at operation granularity.

The embedded SQLite startup drift guard adds `operation_name` when an existing
local database needs it.

## 6. API

The workspace API surface is:

```text
GET    /v1/extensions
GET    /v1/extensions/:id
POST   /v1/extensions/install-local
POST   /v1/extensions/:id/test
DELETE /v1/extensions/:id
GET    /v1/extensions/registry
POST   /v1/extensions/registry/install/:slug
POST   /v1/extensions/registry/suggest
GET    /v1/extensions/registry/status
```

`install-local` accepts an `ExtensionManifest` with `operations[]`, source,
permissions, credential declarations, and allowed domains. The route writes both
the executable database row and the editable workspace volume document under
`extensions/<slug>.md`.

## 7. Workflow Canvas

The node palette exposes `Extension` with the `extension_task` kind and the
distinct `⬡` glyph.

The inspector supports:

- Extension picker
- Operation picker
- Operation summary
- Input mapping
- Output mapping
- Runtime reference metadata

Canvas nodes display the selected operation as a subtitle so users can scan a
workflow without opening configuration panels.

## 8. Packages UI

Packages is now the unified library for:

- All
- Abilities
- Workflows
- Extensions

The Extensions filter includes:

- Designed intro panel explaining deterministic Extensions
- Extension cards with operation counts, runtime, permissions, and source hints
- New Extension drawer with identity, operations, source, permissions,
  credentials, allowed domains, and install acknowledgement
- Detail drawer with operation list, source preview, schema preview, delete, and
  an inline operation test console

The UI intentionally treats Extensions as a creation surface, not merely an
import list. Operators can create a new local Extension from the first screen.

## 9. Package Import and Export

Agentis packages support `extension` content and preserve Extension manifests,
source, permissions, operations, and workflow references. Import installs
Extensions before workflows so `extension_task` references can be rewritten to
workspace-local ids.

## 10. Implementation Checklist

- Core Extension manifest and execution outcome types
- Workflow schema and runtime config for `extension_task`
- SQLite and Postgres Extension tables
- Extension runtime service with operation dispatch
- Builtin, node-worker, and Docker runtime wiring
- Workspace API routes
- Workflow engine dispatch and graph validation
- Packages filter, cards, builder, detail drawer, and test console
- Canvas palette, glyph, inspector, operation picker, and node subtitle
- Focused web, API, and end-to-end coverage

## 11. Future Work

- Rich schema field editor instead of raw JSON for operation schemas
- Draft execution endpoint before install
- Extension usage index for "Used in workflows"
- Registry provenance and signed bundles
- Per-operation examples and fixtures
- Version pinning and upgrade diff UI
