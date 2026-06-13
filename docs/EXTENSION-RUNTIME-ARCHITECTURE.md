# Agentis Extension Runtime Architecture

**Status:** Current architecture  
**Date:** May 2026

Extensions are the deterministic runtime layer of Agentis. They let operators
install or author trusted, sandboxed code that exposes typed operations to
workflows and agents.

## 1. What An Extension Is

An Extension is a sandboxed, versioned capability unit that:

- declares one or more operations
- declares permissions and credential needs
- runs in a controlled local runtime
- returns structured JSON
- is callable from `extension_task` workflow nodes
- can be packaged, installed, tested, and reviewed

Extensions are not agent abilities. Abilities shape behavior and context.
Extensions execute deterministic machine work.

## 2. Runtime Tiers

| Runtime | Use Case | Notes |
|---|---|---|
| `builtin` | Trusted Agentis-provided utilities | Runs in process |
| `node_worker` | Local JavaScript source authored by the operator | Isolated runtime when available |
| `docker_sandbox` | Heavier or registry-installed bundles | Docker required |

The runtime contract is always operation-based:

```ts
{
  extensionId?: string;
  extensionSlug?: string;
  operationName: string;
  input: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
}
```

## 3. Manifest

```ts
interface ExtensionManifest {
  name: string;
  slug: string;
  version: string;
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox';
  operations: ExtensionOperation[];
  permissions?: ExtensionPermission[];
  credentialKeys?: Array<string | ExtensionCredentialKey>;
  allowedDomains?: string[];
  timeoutMs?: number;
  source?: string;
  image?: string;
  entrypoint?: string;
}
```

Each operation declares:

```ts
interface ExtensionOperation {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
```

Operation names must be valid JavaScript export identifiers for `node_worker`
sources.

## 4. Node Worker Authoring

Local source exports one named function per operation:

```js
export async function extract(inputs, ctx) {
  const url = String(inputs.url ?? '');

  return {
    url,
    title: 'Example result',
    extractedAt: new Date().toISOString()
  };
}
```

The runtime resolves `ctx.meta.extension.operationName`, calls the matching
export, and returns a structured outcome.

## 5. Permissions

The current permission vocabulary is:

- `network`
- `credentials`
- `workspace.read`
- `workspace.write`
- `filesystem`
- `spawn`

Network access requires declared `allowedDomains`. Credential access requires
declared credential keys. `spawn` is valid only for `docker_sandbox`.

## 6. Execution Ledger

Every run writes an `extension_executions` record containing:

- workspace id
- extension id
- operation name
- workflow run id
- task id
- status
- duration
- error code and message
- start and finish timestamps

This makes operation-level audit and future usage analytics possible.

## 7. API Surface

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

The test endpoint runs a selected operation with JSON input outside a workflow
run, which gives operators a fast authoring loop from the Packages UI.

## 8. Canvas Contract

`extension_task` nodes require:

- installed Extension reference
- operation name
- input mapping
- output mapping

The canvas displays the Extension glyph `⬡` and the selected operation as a
subtitle. The inspector lists available operations and updates the selected
operation in the node config.

## 9. UI Contract

Packages includes an Extensions filter and treats Extension creation as a
first-class workflow:

- identity
- operation list
- source editor
- permissions
- credentials
- allowed domains
- install acknowledgement
- detail view
- operation test console

The goal is for an operator to move from idea to runnable deterministic workflow
operation without leaving Agentis.

## 10. Quality Gates

The implementation should pass:

- core typecheck
- database typecheck
- API typecheck
- web typecheck
- web production build
- focused API route/runtime tests
- focused Packages UI end-to-end test

The Agentis runtime and UI should not expose the retired deterministic-unit name;
Extensions are the product language everywhere.
