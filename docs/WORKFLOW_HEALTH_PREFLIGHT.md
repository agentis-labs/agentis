# Workflow Health Preflight

Agentis validates workflow health while a workflow is built, before a manual run,
and before a trigger is published. The preflight is side-effect free and uses the
same deterministic node handlers and expression sandbox as production execution.

## Health levels

- `healthy`: all reachable deterministic nodes executed with representative input
  AND every extension's source statically verified against the sandbox contract.
- `unverified`: checks passed, but external or agentic boundaries were mocked (only
  a real run proves them). The canvas surfaces this as **"Unverified · N steps need
  a real run"** — never "Ready", which previously read as a false green light.
- `blocked`: a structural, reference, contract, template, deterministic-execution,
  or **extension-source** error is known.

External services and model output are never presented as guaranteed. Their nodes
remain explicitly mocked or unverified until a real run verifies them.

## Modes (input parity with the engine)

- `canvas` (default): design-time "is this graph shaped right?" preview. Fabricates
  a representative sample from the input contract so structure can be checked before
  real input exists.
- `run-gate`: used by `POST /:id/run` and the build save gate. Uses the **exact**
  input the engine will use — empty stays empty — so a missing required input is
  `blocked` here (naming the field) instead of dead-ending mid-run with a raw
  expression error. Preflight and the engine must never disagree on input.

## Extension verification

Extension nodes are no longer blind-mocked. Preflight resolves the bound extension's
stored source and runs the shared `validateExtensionSource` gate
(`apps/api/src/extensions/validateSource.ts`): it rejects module syntax the sandbox
cannot provide (`require`, bare `import`, `module.exports`, `process.*`), compile
errors, and a missing entrypoint — the exact `ReferenceError: require is not defined`
class that used to pass preflight and crash the live run. The same gate runs at
extension creation (`ExtensionLibraryService.createNodeWorkerExtension`), so a broken
extension can never be persisted in the first place.

## Execution model

`workflowPreflight.ts`:

1. Runs `validateWorkflowGraph` and `validateGraphReferences`.
2. Generates representative input from required workflow contract fields unless
   explicit preflight input is supplied.
3. Topologically propagates outputs through the graph.
4. Executes transform and filter nodes through the production handler registry.
5. Resolves templates with the production template resolver.
6. Statically verifies each `extension_task`'s real source (see "Extension
   verification") and uses in-memory pass-through or mock outputs for the remaining
   boundary nodes; it performs no network, model, credential, deployment, or
   persistent-store writes.
7. The cache key includes the mode, so a `canvas` preview and a `run-gate` check of
   the same graph never alias.
8. Returns per-node evidence and actionable issues, each with a `remediation`.

Reports are cached for five minutes by workspace, workflow, canonical graph hash,
and scenario input hash. Pure graphs skip credential inventory queries entirely.
Cached preflights are expected to return in under 10 ms; ordinary cold preflights
remain under 500 ms in the focused test environment.

## Enforcement

- `agentis.build_workflow` preflights the final repaired graph before persistence.
  A blocked graph is not saved or announced as complete.
- Manual workflow runs preflight in `run-gate` mode with their real trigger input
  (no fabricated sample) and reject known deterministic and missing-input failures
  before the engine starts.
- Trigger publishing rejects blocked graphs.
- The canvas runs a debounced preflight and shows a compact health indicator with
  measured duration and node-level findings.

## API

- `GET /v1/workflows/:id/health` uses contract-derived representative input.
- `POST /v1/workflows/:id/preflight` accepts `{ "inputs": { ... } }`.

The response includes status, confidence, graph hash, scenario source, duration,
cache state, node results, and structured issues.

## Adding node kinds

Deterministic node kinds should be registered in the existing node handler registry.
Preflight will execute them through that shared handler automatically.

Side-effecting node kinds should expose configuration and output contracts. Preflight
must validate configuration and produce a schema-compatible mock without executing
the side effect. Do not copy production business logic into the preflight service.
