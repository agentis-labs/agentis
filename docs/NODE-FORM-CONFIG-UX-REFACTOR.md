# Agentis Node Configuration UX Refactor

> **Status:** Proposed implementation spec - June 2, 2026
> **Scope:** Workflow canvas node forms, connection setup, model selection, validation, testing, and configuration architecture
> **Primary surface:** `apps/web/src/components/canvas/ContextInspector.tsx`
> **North star:** Every node should be configurable in place without asking the operator to understand internal slugs, raw JSON, or where a hidden setting lives.

---

## 0. Why This Document Exists

The broad UI/UX documents correctly called for "proper form-based editing" and an editable advanced JSON view. That work started, but the node inspector is still halfway between a developer scaffold and an operator-ready product.

The current experience exposes implementation details before user intent:

- Integration nodes ask for connector and operation slugs as plain text.
- Missing credentials still send the operator toward Settings for some paths.
- Agent nodes show a model chooser only after a specific agent is bound. Role-routed tasks have no visible model policy.
- Some palette nodes do not have a dedicated form and silently fall back to generic key/value or JSON editing.
- Complex structures such as branches, store operations, guardrail rules, mappings, and HTTP auth are still JSON textareas or raw fields.
- The panel gives every node the same visual rhythm, even when one node needs two fields and another needs a complete configuration flow.

This spec replaces that partial system with a complete node configuration workbench.

---

## 1. Existing Docs Audit

No current `/docs` file fully describes a complete node-form redesign.

Relevant existing docs:

| Document | What it covers | What remains missing |
|---|---|---|
| `docs/UIUX-REFACTOR.md` | Broad platform redesign | No node-by-node form architecture |
| `docs/WORKFLOW-10X-MASTERPLAN.md` | Engine capabilities, implementation log, integration wiring history | Records shipped fields, but not a coherent UX system |
| Deleted `docs/UIUX-REPLAN.md` in Git history | Calls for form editing and advanced JSON | No component model, coverage matrix, validation model, or finish criteria |
| Deleted `docs/UIUX-refactor/WORKFLOW-PAGE-REDESIGN.md` in Git history | Canvas / Runs / Output tabs | Explicitly leaves canvas internals mostly unchanged |

This document becomes the source of truth for workflow node forms.

---

## 2. Current-State Audit

### 2.1 Monolithic inspector

`ContextInspector.tsx` owns fetching, shell layout, all per-kind forms, connection setup, JSON mode, testing, and reusable field primitives in one file of more than 1,600 lines.

That makes form quality drift inevitable:

- New palette nodes can ship without a real form.
- Shared behavior is copied rather than standardized.
- Validation is inconsistent and usually deferred until execution.
- Reference data is loaded ad hoc by kind.
- UX fixes for one node do not improve the others.

### 2.2 Palette-to-form coverage gap

The canvas palette exposes 28 first-class node types. The inspector does not offer a first-class form for all of them.

| Node kind | Current dedicated form | Current gap |
|---|---:|---|
| `trigger` | Yes | Cron is still power-user-first |
| `router` | Partial | Branch list requires JSON |
| `merge` | No | Generic fallback |
| `wait` | Yes | Good baseline |
| `loop` | Yes | Paths should use pickers |
| `parallel` | Yes | Good baseline |
| `subflow` | Partial | Missing mapping builder and preview |
| `transform` | Yes | Needs expression feedback |
| `filter` | Yes | Needs expression feedback |
| `integration` | Partial | Raw slug, raw operation, raw mapping |
| `http_request` | Partial | Headers JSON, no auth builder, no response mapping builder |
| `workflow_store` | Partial | Operations JSON textarea |
| `workspace_store` | No | Falls back despite matching workflow store semantics |
| `scratchpad` | Yes | Paths should use pickers |
| `agent_task` | Partial | Model hidden for role routing; many config fields absent |
| `agent_session` | No | Generic fallback |
| `extension_task` | No | Generic fallback |
| `agent_swarm` | Partial | Missing model, role, agent, requirements |
| `dynamic_swarm` | No | Generic fallback |
| `planner` | No | Generic fallback |
| `evaluator` | Partial | Model policy hidden; rubric not editable |
| `guardrails` | Partial | Rules JSON textarea |
| `knowledge` | Partial | Dynamic source asks for node ID manually |
| `artifact_collect` | Partial | Accepted types missing |
| `return_output` | Yes | Good baseline |
| `artifact_save` | Partial | Paths should use pickers |
| `browser` | Partial | Structured operation-specific fields still incomplete |
| `checkpoint` | Yes | Good baseline |

### 2.3 Integration setup is still implementation-shaped

The integration API already returns manifests with:

- Connector identity: `service`, `name`, `category`, `description`, `icon`
- Supported `operations`
- `credentialSchema`
- Optional `operationSpecs` and parameter schemas for custom connectors
- Optional docs URL

The inspector currently discards this structure and renders:

```text
Integration  [ gmail        ]
Operation    [ send_email   ]
```

This is the main reason the form still feels unfinished. The platform knows enough to render a guided experience but does not use that data.

There is also a correctness bug in the UI model: `isPendingConfig()` treats every integration without `credentialId` as incomplete, even when the connector declares no credential requirement, such as `rss_feed`.

### 2.4 Model controls are fragmented

There are three model-related concepts in the product:

1. Agent runtime model: configured on an agent.
2. Orchestrator role model: configured in Settings > Runtimes.
3. Workflow node model override: configured on an agent task.

The existing `ModelChooser` is useful, but the node inspector renders it only when `agentId` resolves to a bound agent with an `adapterType`.

That means the most important default creation path, specialist role routing, cannot expose a model selector. Evaluator, router `llm_route`, planner, swarm, and session nodes also lack a consistent visible model policy.

### 2.5 Configuration is split between the form and elsewhere

An operator should not be told:

> Create one in Settings, then return here.

Node configuration must finish inside the node inspector whenever the missing item is node-scoped:

- Bind or create a credential.
- Connect via OAuth.
- Pick a model policy.
- Select an integration operation.
- Map operation inputs.
- Add a branch.
- Define a guardrail.
- Configure a store operation.
- Pick an upstream value.

Settings remains the place to manage shared resources globally, not a required detour to finish a node.

---

## 3. Design Direction

### 3.1 Product posture

The inspector is a configuration workbench, not a property dump.

It should feel like a compact, precise instrument panel:

- Dark neutral surfaces with one restrained accent.
- Clear grouping through spacing and thin dividers rather than nested cards everywhere.
- Human labels first; IDs and slugs only in Advanced.
- Progressive disclosure for uncommon controls.
- Always-visible readiness state.
- One primary action at a time.

### 3.2 Panel geometry

The current fixed `w-80` panel is too narrow for complex node forms.

New behavior:

| State | Width | Use |
|---|---:|---|
| Default | 400px | Most nodes |
| Wide | 520px | Mappings, branch builders, HTTP, rules |
| Full editor | `min(760px, 70vw)` | Code editor, raw JSON, large test results |

The inspector can be resized between 360px and 640px. Complex sub-editors open as an in-panel wide state or a focused drawer. They do not route away from the canvas.

### 3.3 Inspector anatomy

```text
+--------------------------------------------------+
| Integration                         [ready state] |
| Send an email through Gmail                 [x]  |
| gmail.send_email                                 |
+--------------------------------------------------+
| [Configure] [Test] [History]              [...] |
+--------------------------------------------------+
| CONNECTION                                       |
| Gmail                                  Connected |
| Marketing account                      [Change]  |
|                                                  |
| ACTION                                           |
| Send email                              [Change]  |
| Sends an email from the connected Gmail account. |
|                                                  |
| MESSAGE                                          |
| To *       [ Pick a value ]                      |
| Subject *  [ Pick a value ]                      |
| Body *     [ Pick a value ]                      |
|                                                  |
| OUTPUT                                           |
| [ ] Use as workflow output                       |
|                                                  |
| ADVANCED                                    [>]  |
+--------------------------------------------------+
| Draft saved                        [Test node]    |
+--------------------------------------------------+
```

The stable layout has five layers:

1. **Header:** human label, one-line purpose, readiness.
2. **Tabs:** Configure, Test, History. JSON lives under the overflow menu or Advanced.
3. **Primary configuration:** intent-level controls only.
4. **Output and advanced:** output declaration, IDs, raw config, uncommon options.
5. **Sticky footer:** validation summary and the most useful next action.

---

## 4. Interaction Rules

### 4.1 Never ask for a slug when a selector exists

Bad:

```text
Integration: gmail
Operation: send_email
```

Good:

```text
Integration: Gmail
Action: Send email
```

The raw values remain visible in Advanced:

```text
Connector slug: gmail
Operation id: send_email
```

### 4.2 Keep draft editing permissive, but make readiness explicit

The operator can save incomplete drafts. The UI distinguishes:

| State | Meaning | Behavior |
|---|---|---|
| `ready` | Can run | Neutral success indicator |
| `needs_setup` | Missing connection or shared resource | Amber indicator with inline CTA |
| `incomplete` | Missing required node field | Amber validation summary |
| `invalid` | Field value is malformed | Inline danger message; block save for malformed data |
| `testing` | Isolated node test running | Skeleton matching the result layout |
| `failed` | Test or run failed | Inline explanation and repair CTA |

Save should not be the first time the operator learns something is wrong. Run and Publish perform graph preflight and link directly to each incomplete node.

### 4.3 Ask for technical details only when needed

Every form has:

- A short default view for the common path.
- An Advanced disclosure for IDs, custom paths, timeouts, retries, and raw config.
- Editable JSON as a power-user escape hatch.

Raw JSON must never be the only way to finish a first-class palette node.

### 4.4 Use upstream value pickers everywhere

Paths and templates should use the same `VariablePicker` and `TemplatedTextField` system.

Never ask the operator to memorize:

```text
nodes.fetch.output.items[0].email
```

Offer:

```text
Fetch contacts > results > first item > email
```

Then write the underlying template or path automatically.

### 4.5 In-place resource creation

Resource selectors support:

- Search
- Empty state
- Create or connect inline
- Refresh after creation
- Manage in Settings as a secondary link

Examples:

- Credential selector: `[Connect Gmail]`
- Knowledge selector: `[Create knowledge base]`
- Agent selector: `[Create or connect agent]`
- Subflow selector: `[Create reusable workflow]`

---

## 5. New Configuration Architecture

### 5.1 Replace the switch with a node definition registry

Create a typed registry that is the single frontend source of truth for node editing:

```ts
interface NodeFormDefinition<TConfig> {
  kind: WorkflowNodeType;
  label: string;
  description: string;
  icon: IconComponent;
  category: NodeCategory;
  complexity: 'simple' | 'standard' | 'advanced';
  defaultConfig: () => TConfig;
  readiness: (ctx: ReadinessContext<TConfig>) => NodeReadiness;
  ConfigForm: ComponentType<NodeConfigFormProps<TConfig>>;
  summary: (ctx: NodeSummaryContext<TConfig>) => NodeSummary;
}
```

Use this registry for:

- Node palette entries
- Command palette entries
- Canvas node summaries
- Inspector headings
- Draft defaults
- Readiness checks
- Preflight errors
- Dedicated forms

This prevents palette, canvas, schema, and inspector drift.

### 5.2 Use structured fields, not a universal schema renderer

Do not generate every form directly from Zod. Zod describes validity, not a high-quality interaction.

Use reusable field blocks for predictable structures:

- `ResourceSelectField`
- `ModelPolicyField`
- `CredentialBindingField`
- `OperationSelectField`
- `DynamicParameterForm`
- `MappingBuilder`
- `TemplateField`
- `PathPickerField`
- `BranchListEditor`
- `RuleListEditor`
- `StoreOperationEditor`
- `RetryPolicyEditor`
- `CapabilityRequirementsEditor`
- `OutputSurfaceField`
- `AdvancedSection`

Node-specific forms compose these blocks.

### 5.3 Proposed file structure

```text
apps/web/src/components/canvas/inspector/
  ContextInspector.tsx
  InspectorHeader.tsx
  InspectorTabs.tsx
  InspectorFooter.tsx
  NodeReadinessBadge.tsx
  nodeFormRegistry.ts
  readiness.ts
  fields/
    AdvancedSection.tsx
    CredentialBindingField.tsx
    DynamicParameterForm.tsx
    MappingBuilder.tsx
    ModelPolicyField.tsx
    PathPickerField.tsx
    ResourceSelectField.tsx
    RetryPolicyEditor.tsx
    RuleListEditor.tsx
    StoreOperationEditor.tsx
  forms/
    AgentTaskForm.tsx
    AgentSessionForm.tsx
    AgentSwarmForm.tsx
    BrowserForm.tsx
    CheckpointForm.tsx
    DynamicSwarmForm.tsx
    EvaluatorForm.tsx
    ExtensionTaskForm.tsx
    FilterForm.tsx
    GuardrailsForm.tsx
    HttpRequestForm.tsx
    IntegrationForm.tsx
    KnowledgeForm.tsx
    LoopForm.tsx
    MergeForm.tsx
    OutputForms.tsx
    ParallelForm.tsx
    PlannerForm.tsx
    RouterForm.tsx
    ScratchpadForm.tsx
    StoreForm.tsx
    SubflowForm.tsx
    TransformForm.tsx
    TriggerForm.tsx
    WaitForm.tsx
```

Keep the existing `NodeTestRunner`, `TemplatedTextField`, and variable-picker primitives, but move them behind the new field blocks.

---

## 6. Model Selection System

### 6.1 Always show a model policy on LLM-backed nodes

Relevant node kinds:

- `agent_task`
- `agent_session`
- `agent_swarm`
- `dynamic_swarm`
- `planner`
- `evaluator`
- `router` when `routingMode === 'llm_route'`

Each gets the same `ModelPolicyField`:

```text
MODEL
(*) Automatic
    Uses the selected agent or specialist default.
( ) Workspace role default
    Planning: Claude Sonnet 4.6
( ) Override for this node
    [ Search models... ]
```

The normal path is Automatic. The selector is still visible so the operator understands that a model choice exists.

### 6.2 Do not require a bound agent to browse models

The current chooser depends on `adapterType`, which only exists after binding an agent. Add a workflow model catalog endpoint that can resolve models from context:

```http
GET /v1/workflow-config/models?nodeKind=agent_task&agentId=&agentRole=writer&modelRole=
```

Response:

```ts
interface WorkflowModelCatalog {
  effective: {
    source: 'node_override' | 'agent' | 'specialist' | 'workspace_role' | 'runtime_default';
    model: string | null;
    label: string;
  };
  groups: Array<{
    provider: string;
    models: RuntimeModelOption[];
  }>;
  supportsManual: boolean;
}
```

The backend can reuse `runtimeModels.ts`, specialist resolution, and orchestrator role config. The UI no longer has to infer model availability from whichever agent happened to be selected.

### 6.3 Keep model concepts understandable

Use user-facing language:

| Internal concept | UI label |
|---|---|
| agent runtime model | Agent default |
| orchestrator model role | Workspace role default |
| `modelOverride` | Override for this node |
| manual model string | Custom model ID |

IDs and provider endpoints belong in Advanced.

---

## 7. Integration Configuration System

### 7.1 Integration flow

```text
1. Pick integration
2. Pick action
3. Connect or bind credential if required
4. Fill action parameters
5. Test node
```

Every step happens inside the node inspector.

### 7.2 Connector selector

```text
INTEGRATION
[ Gmail                                              v ]

Communication
  Gmail             Send email through Google API
  Slack             Post messages and reactions

Productivity
  Google Sheets     Read and update spreadsheet ranges
```

The selector searches connector name, category, description, and slug. Frequently used connectors appear first.

### 7.3 Operation selector

```text
ACTION
[ Send email                                         v ]
Sends a Gmail message from the connected account.
```

Humanize operation IDs by default:

| ID | Label |
|---|---|
| `send_email` | Send email |
| `create_issue` | Create issue |
| `append_row` | Append row |

Connector-specific copy can override generic humanization later.

### 7.4 Auth-aware credential state

Add:

```ts
function integrationRequiresCredential(manifest: IntegrationManifest): boolean
```

Rules:

- `credentialSchema.type === 'none'` means no credential card and no pending-config warning.
- OAuth connectors show the provider CTA first.
- Existing credentials show as selectable bindings.
- Manual-secret connectors expose an inline secure create form based on `credentialSchema.fields`.
- Settings management remains a small secondary link.

The canvas pending state must use the same readiness function as the inspector.

Credential compatibility must be explicit. The current inspector guesses compatibility by checking whether the connector slug appears in a credential's type or name. Add connector/provider metadata to credential summaries and bind against that metadata instead of fuzzy string matching.

### 7.5 Dynamic action parameters

For custom connectors, render `operationSpecs[].paramSchema`.

For built-in connectors, add operation parameter metadata. A connector without parameter metadata may temporarily use a mapping builder, but shipped first-party connectors should not remain raw.

Example:

```text
MESSAGE
To *
[ Pick a value...                                   ]

Subject *
[ Weekly digest for {{trigger.company}}             ]

Body *
[ {{nodes.summary.text}}                             ]
```

The current raw `input key` mapping editor becomes Advanced fallback only.

### 7.6 Inline credential creation

The inspector needs a secure path for non-OAuth credentials:

```text
Connect Slack

Token *
[ **************************************** ]

Name
[ Marketing Slack workspace                ]

[ Save and connect ]
```

This calls the existing credential API and binds the returned credential ID immediately. Secret values are never echoed after save.

---

## 8. Node Family Designs

### 8.1 Agent nodes

Applies to `agent_task`, `agent_session`, `agent_swarm`, `dynamic_swarm`, and `planner`.

Shared sections:

1. **Assignment:** specialist role, specific agent override.
2. **Model:** automatic, workspace role, node override.
3. **Instructions:** prompt or goal with variable picker.
4. **Capabilities:** browser, filesystem, terminal, computer use, MCP.
5. **Execution:** tool loop, max steps, concurrency, merge strategy as relevant.
6. **Reliability:** retry and self-heal policy.
7. **Output:** output keys and output-surface toggle.

Do not force every section open. The common path is Assignment, Model, Instructions.

### 8.2 Router and guardrails

Replace JSON list editing with row builders.

Router:

```text
BRANCHES
1  Qualified lead
   When [ score ] [ is greater than ] [ 0.80 ]
   Route to [ Book meeting ]

2  Needs review
   Otherwise
   Route to [ Manual review ]

[ Add branch ]
```

Guardrails:

```text
RULES
1  [ Must not be empty ] on [ Draft text ]
   Message: Draft is empty

[ Add rule ]
```

Advanced mode exposes expression strings.

### 8.3 HTTP request

Default sections:

- Method and URL
- Authentication builder
- Headers row builder
- Query row builder
- Body editor
- Response extraction builder
- Retry and timeout

No JSON textarea is required for the common path.

### 8.4 Stores

`workflow_store` and `workspace_store` use the same visual editor with scope copy:

```text
OPERATIONS
1  [ Set ] [ weekly_report.last_run ]
   Value [ Pick a value... ]

2  [ Increment ] [ weekly_report.sent_count ] by [ 1 ]

[ Add operation ]
```

### 8.5 Trigger

Use intent-first controls:

```text
Start this workflow:
(*) Manually
( ) On a schedule
( ) When a webhook arrives
( ) From a persistent listener
```

For schedule:

```text
Every [ Monday ] at [ 09:00 ] [ UTC v ]
Advanced cron: 0 9 * * 1
Next runs: ...
```

Cron remains editable under Advanced.

### 8.6 Knowledge

Dynamic query source uses a value picker, not a node ID input.

```text
Search for
(*) Fixed query
( ) Value from workflow

Knowledge base [ All workspace knowledge v ]
Query          [ Pick a value...             ]
Mode           [ Contextual                  ]
Results        [ 5                           ]
```

Keep the existing retrieval test, but render results as a stable test panel.

### 8.7 Extension task

Extensions need a dedicated form:

- Extension selector
- Operation selector from manifest
- Dynamic input form or mapping builder
- Output mapping
- Timeout in Advanced
- Install-extension action inline

### 8.8 Output nodes

`return_output`, `artifact_save`, and `artifact_collect` should clearly communicate the operator-facing result.

Use `OutputSurfaceField` consistently. Avoid showing the generic "Use as workflow output" checkbox on nodes where output behavior is intrinsic, such as `return_output`.

---

## 9. Validation and Preflight

### 9.1 One readiness engine

Create a shared readiness evaluator used by:

- Inspector header badge
- Canvas node status
- Toolbar incomplete-config count
- Run preflight
- Publish preflight
- Chat build completion summary

```ts
interface NodeReadiness {
  state: 'ready' | 'needs_setup' | 'incomplete' | 'invalid';
  issues: Array<{
    code: string;
    field?: string;
    message: string;
    action?: NodeReadinessAction;
  }>;
}
```

Delete ad hoc checks such as `isPendingConfig()` once every first-class node has a registry readiness function.

### 9.2 Inline errors

Every field block supports:

- Label
- Optional helper text
- Required marker
- Error message below the field
- Warning message below the field
- Success state where useful

Do not hide validation in toast messages.

### 9.3 Graph-level preflight

Before Run or Publish:

```text
3 steps need attention

1. Send weekly email
   Connect Gmail to continue.
   [ Connect Gmail ]

2. Route qualified leads
   Add at least one branch.
   [ Edit branches ]

3. Writer task
   Add instructions.
   [ Add prompt ]
```

Clicking an action selects the node and focuses the exact field.

---

## 10. API Work

### 10.1 Reuse existing APIs

Already available:

| API | Use |
|---|---|
| `GET /v1/integrations` | Connector manifests |
| `GET /v1/integrations/:id` | Connector details |
| `POST /v1/integrations/:id/test` | Integration test |
| `GET /v1/credentials` | Existing credential bindings |
| Credential CRUD routes | Inline secure credential creation |
| `GET /v1/oauth/providers` | OAuth availability |
| OAuth authorize callback flow | Inline OAuth bind |
| `GET /v1/harness/models/:adapterType` | Existing runtime catalogs |
| `GET /v1/orchestrator/models` | Workspace role defaults |

### 10.2 Add or enrich APIs

| API | Purpose |
|---|---|
| `GET /v1/workflow-config/models` | Context-aware node model catalog without requiring a bound agent |
| `GET /v1/workflow-config/catalog` | Optional single bootstrap payload: integrations, agents, roles, knowledge bases, workflows, OAuth providers |
| `POST /v1/workflows/:id/preflight` | Canonical graph readiness for Run and Publish |

Also enrich built-in integration manifests with action-level parameter metadata. The frontend cannot render high-quality action forms from operation IDs alone.

Credential summaries returned by `GET /v1/credentials` should also include explicit connector/provider metadata so the integration form can list compatible bindings without string heuristics.

### 10.3 Schema follow-through

The editor currently permits broad fallback config at save time. Keep permissive draft storage, but add explicit execution schemas or validators for all first-class palette nodes.

The palette must not advertise a node as first-class while relying on unknown fallback behavior.

---

## 11. Visual and Accessibility Rules

### 11.1 Visual system

- Use one accent color and neutral layers.
- Use amber for `needs_setup` and `incomplete`.
- Use danger only for malformed values or failed tests.
- Avoid outer glow as a default state. Readiness is communicated by border, small indicator, and copy.
- Use thin dividers and whitespace before adding nested cards.
- Keep labels above controls.
- Keep helper text short and concrete.
- Use monospace only for technical values, paths, expressions, and IDs.

### 11.2 Accessibility

- Inspector tabs use `role="tablist"`.
- Readiness status uses `aria-live="polite"` when changed.
- Errors connect through `aria-describedby`.
- All disclosures are keyboard reachable.
- Resource selectors support arrow keys, Enter, Escape, and search.
- OAuth popup flow retains a visible non-popup fallback link.
- Focus moves to the first invalid field when Save, Run, or Publish is blocked.

---

## 12. Implementation Plan

### Phase 1 - Foundation

- Extract inspector shell from `ContextInspector.tsx`.
- Create `nodeFormRegistry.ts`.
- Centralize defaults and readiness.
- Keep existing forms working behind registry adapters.
- Add preflight panel using the shared readiness evaluator.

### Phase 2 - Fix the two visible failures

- Rebuild `IntegrationForm` around connector and operation selectors.
- Add auth-aware readiness.
- Add inline secure credential creation.
- Add context-aware `ModelPolicyField`.
- Show model policy on role-routed agent tasks.

### Phase 3 - Remove raw JSON dependencies

- Build branch editor.
- Build mapping editor with variable picker.
- Build store operation editor.
- Build guardrail rule editor.
- Build HTTP auth, headers, query, and response mapping editors.

### Phase 4 - Full palette coverage

- Add dedicated forms for `merge`, `workspace_store`, `agent_session`, `extension_task`, `dynamic_swarm`, and `planner`.
- Complete missing agent-family fields.
- Add operation-specific browser fields.
- Complete artifact and knowledge pickers.

### Phase 5 - Polish and verification

- Add node history tab.
- Add loading, empty, test-success, and test-error states.
- Add keyboard focus behavior.
- Add integration and preflight tests.
- Browser-test representative node flows.

---

## 13. Acceptance Criteria

The refactor is complete only when:

1. Every palette node has a dedicated operator-ready form.
2. No first-class node requires JSON editing for its normal configuration path.
3. Adding Gmail means selecting `Gmail`, selecting `Send email`, connecting or binding a credential inline, filling named fields, and testing without leaving the inspector.
4. Role-routed agent tasks show an understandable model policy and allow a node override.
5. All LLM-backed nodes use the shared model-policy component.
6. Authless integrations are not flagged as missing credentials.
7. Canvas readiness, toolbar counts, Run preflight, and Publish preflight use one shared evaluator.
8. Every path-like field uses a value picker where upstream values are valid.
9. Raw slugs, node IDs, and JSON are available only under Advanced.
10. The inspector supports default, loading, empty, incomplete, invalid, testing, success, and failure states.
11. Unit tests cover registry completeness: palette kinds, schemas, readiness evaluators, and dedicated forms cannot drift.
12. Browser tests cover integration setup, role-based model selection, router branch editing, and preflight navigation.

---

## 14. First Implementation Slice

The highest-value first slice is deliberately narrow:

1. Add `nodeFormRegistry.ts` and shared readiness.
2. Replace integration slug and operation text fields with selectors powered by `/v1/integrations`.
3. Make credential requirements auth-aware.
4. Add inline manual credential creation beside the existing OAuth path.
5. Add `ModelPolicyField` and show it for specialist-role agent tasks.
6. Use the readiness engine for canvas amber state and the toolbar count.

That slice directly fixes the screenshots while establishing the architecture needed to finish the rest without another round of partial forms.
