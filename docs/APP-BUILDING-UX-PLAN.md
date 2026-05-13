# Agentis — App Building UX Plan
## How building apps, workflows, and packages fit together

> **Status:** Active plan — V1 scope locked, post-V1 extensions noted
> **Date:** May 2026
> **Scope:** Navigation model · App canvas UX · Workflow page purpose · Packages redesign · Language and copy decisions · Node inspector quality · Canvas engine parity · Output schema UX · Run-time variable prompt · Workflow collections · Section label audit · App identity
> **Builds on:** `APP-CANVAS-ARCHITECTURE.md`, `AGENTIS-APP-FORMAT.md`, `AGENTIS-UX-V2.md`

---

## The single question this document answers

**How does a user go from "I want to build something" to a running app — and how do the Workflows page, the App canvas, and Packages all fit together without confusion?**

---

## 1. The mental model: three things, one purpose

There are three distinct surfaces in Agentis for building. They are not the same thing and should never feel like the same thing.

```
Workflows   →   where you build autonomous routines
Apps        →   where you compose those routines into a running system
Packages    →   where everything you've built is stored and organized
```

Each has a distinct job. Each has a distinct user.

---

## 2. Workflows — the builder's workbench

### What it is

The Workflows page is a dedicated builder for autonomous routines. A routine is a sequence of steps — agents working, decisions branching, tools executing, outputs collecting — that does one specific thing.

A routine can be:
- a standalone process you run independently ("research this company")
- something you reuse inside multiple apps
- something you publish to AgentisHub later (post-V1)

The Workflows page is where you focus on **how something gets done** without worrying about what system it belongs to.

### Who it's for

**Power users.** Operators who want explicit control, want to organize routines independently, or are building libraries of reusable logic. They prefer the abstraction because they think in steps, branches, and execution flow.

The Workflows page will also be the contribution surface for AgentisHub — when we open the hub, users will commit their workflows from here.

### What it is not

It is not required to build an app. A new user can create and run an app without ever visiting the Workflows page — they can build routines inline, directly on the app canvas. The Workflows page becomes relevant when they want more control or want to reuse logic across multiple apps.

---

## 3. Apps — the system builder

### What an app is

An app is a running system. It has:
- one or more routines that do the work
- agents that execute inside those routines
- data it knows about and learns from
- outputs it produces
- optionally: approvals, channels, scheduled triggers

An app runs continuously or on demand. It improves over time as it processes data.

### The canvas is the build surface

When you open or create an app, you land on the canvas. The canvas shows the system at a high level: what routines are connected, where data enters, where outputs emerge, where agents live. It answers "what is this app made of and how do the pieces connect" — not "what happens inside step 4 of the routine."

### Creating an app: what happens

When you click "New app" you should not land on a blank canvas. You answer two questions first:

1. **What should this app do?** (free text, one sentence)
2. **What kind of app?** (Research / Automation / Conversational / Pipeline)

The system creates a starting canvas for you based on those answers. You modify what's there rather than building from zero.

---

## 4. The connection between apps and workflows: no forced detour

### The current problem

Right now, creating an app requires leaving the app canvas to build a workflow separately, then coming back and connecting it. This is a forced context switch that breaks the building experience.

### The fix: build inline or link

When you click the entry workflow node on the app canvas (see §5 for naming), you get two options:

**Option A — Link a routine you already built**
Opens a picker showing your existing routines from the Workflows page. Select one and it connects.

**Option B — Build it here**
The node expands into a sub-canvas. You define the routine's steps directly inside the app context. You never leave the app canvas.

Both paths create the same underlying object. A routine built inline on the app canvas appears in the Workflows page automatically. There is no separate "save to workflows" action.

This is the critical bridge. The Workflows page and the app canvas are not competitors — they are two views of the same library. The Workflows page gives you a full-screen editor and organizational tools. The app canvas gives you inline editing without losing context.

---

## 5. Language: replacing technical node names

The current node taxonomy uses technical identifiers. These need to become plain language that describes what the thing does, not what it is internally.

### Renamed nodes

| Current name (technical) | New name (plain) | What it means to the user |
|---|---|---|
| `entry_workflow` | **Entry workflow** | The core sequence of steps this app runs |
| `workflow_module` | **Routine** | A connected sequence of steps (reusable) |
| `agent_group` | **Agent team** | The agents assigned to do the work |
| `memory_surface` | **Memory** | What this app remembers and learns |
| `integration_surface` | **Integration** | Connected external tools and services |
| `approval_surface` | **Approval** | A point where a human reviews before continuing |
| `output_surface` | **Output** | What this app produces |
| `knowledge_source` | **Data source** | Data this app reads from and learns with |
| `channel_surface` | **Channel** | Inbound and outbound communication |
| `brain_surface` | **Brain** | The app's deep knowledge and intelligence layer |
| `app_core` | **App core** | The central identity of the app (keeps this name — it's clear) |

### Language rules going forward

- Avoid "workflow" in user-facing canvas labels. Use "routine" instead.
- Avoid "bound", "unbound", "surface", "module" in user-facing copy.
- Warning messages must tell the user what to do, not describe the system state.

**Example correction:**
- Before: `[UNBOUND_WORKFLOW] Node 'Entry workflow' has no workflowId bound yet.`
- After: `Connect a routine to get started →` (with a direct action button)

---

## 6. Packages — your personal library (V1)

### What Packages is in V1

Packages is where everything you build is automatically stored. You don't save things to Packages manually. Building something anywhere in Agentis means it appears in Packages.

The library is yours. In V1, you only see what you've created yourself.

```
Packages
└── Yours
      ├── Apps           — complete apps you've built and activated
      ├── Routines       — standalone workflows you've built
      ├── Agents         — agent configurations you've created
      └── Skills         — skill definitions you've set up
```

### No template section

There is no "Templates" section in Packages. Templates imply starting from someone else's structure. Agentis is a build platform — the starting point is always what you want to build, not a pre-made version of it.

If starter patterns are ever needed, they belong in the guided onboarding flow (the two questions at app creation time), not as a browsable library of templates.

### Post-V1: AgentisHub publishing

In a future version, users will be able to publish their packages to AgentisHub — making their routines, agents, and complete apps available to the community or their organization. When that happens, a "Saved" section will appear in Packages for things they've installed or saved from the hub.

Users will discover this capability naturally as the platform grows. For V1, they don't need to know the hub exists.

### Packages is the hub's source of truth

When AgentisHub launches, every committed item comes directly from a user's Packages library. The versioning, the content structure, the metadata — it all comes from what's already there. Users won't need to do anything special to publish; the infrastructure is already in place from the moment they start building.

---

## 7. Navigation model: what the sidebar guides you toward

The sidebar should guide a user toward answering "what do I want to build and run" — not toward understanding the platform's architecture.

### Proposed sidebar order and framing

```
Home
---
Apps          ← start here: build and run your systems
Workflows     ← build standalone routines (power users)
Agents        ← manage your agent configurations
---
Packages      ← everything you've built, organized
Brain         ← knowledge and memory across your workspace
---
Settings
```

### Why Apps comes before Workflows

Apps is the answer to "what do I want to accomplish." Workflows is the answer to "how do I want a specific thing to be done." Most users begin with intent, not implementation. The sidebar should match that.

A first-time user clicking "Apps → New App" lands in a guided creation flow and builds their first app without needing to understand what a workflow is. A returning power user clicking "Workflows" knows exactly what they're doing.

---

## 8. What this does not change

The underlying technical architecture is correct and stays as-is:

- Workflows are execution DAGs. That model is right.
- Apps are composition graphs that reference workflows. That model is right.
- The distinction between app-level and workflow-level exists for good reasons.
- The engine, ledger, and runtime are not affected by any of this.

The changes here are entirely in language, navigation order, the guided creation flow, and the inline-build bridge. None of this requires changing what the system does — only how users interact with what it does.

---

## 9. UX Audit: eight problems that prove the gap

This section captures critical UX failures observed in the current product. Each problem is analyzed at root cause — not as a feature request but as a diagnostic of where the system is working against the operator rather than for them. These are the things that need to be fixed for the product to feel like a real product.

---

### P1. Node configuration panels are not built for humans

**What is happening**

When you click a node on the app canvas to configure it, you get a form that looks like it was generated from a JSON schema. Field labels are internal identifiers. Type selectors have no explanations. There are no defaults explained, no hints about what the field does, and no sense of flow from "empty node" to "configured and working node."

The lived experience: `agentIds: []` with a generic add button. No context for why you're adding agents, how many you should add, what they'll do, or whether you've done it correctly.

**Root cause**

The inspector was built for flexibility — one generic form component that works for every node type — at the cost of purpose. Generic forms are fast to build and nearly impossible to use without documentation. Building one form that works for everything means building a form that works for nothing in particular.

**What it should be**

Every node type needs a purpose-built configuration experience. The data model does not change. What changes is the UI layer: the inspector becomes a focused, guided form specific to what that node is.

The "Entry workflow" node inspector should say:

> "Which workflow runs when this app is triggered?"  
> `[ Pick an existing workflow ]` or `[ Build one here ]`

The "Agent team" node inspector should say:

> "Who does the work? Add the agents assigned to this step."  
> `[ + Add agent ]`

The fields are identical underneath. The presentation makes the operator feel capable rather than confused.

**Scope of fix:** All node inspector panels in the app canvas. Pure UI work — the data model does not change.

---

### P2. The app canvas and workflow canvas feel like different products

**What is happening**

The workflow canvas is smooth, responsive, and feels native. It has years of iteration behind it. The app canvas was added later and reuses some but not all of the same infrastructure. The seam is visible and felt: panning behaves slightly differently, nodes style inconsistently, selection has different affordances, the overall interaction quality is lower. A user who spends time in the workflow canvas and then opens an app canvas immediately notices the downgrade.

**Root cause**

The two canvases share some React components but were not built from a unified engine. The workflow canvas got more iteration cycles because it was the original product. The app canvas carries implementation debt from being built faster, primarily for visualization rather than editing.

**What it should be**

Both surfaces must run on the same interaction engine: identical pan/zoom behavior, identical selection and multi-select, identical edge drawing, identical keyboard shortcuts, identical snapping, identical empty states, identical focus rings. A user should not be able to tell which canvas they're on by how it *feels* — only by what the nodes *mean*.

The fix requires extracting a shared `<CanvasEngine>` that both the workflow builder and the app canvas consume as a dependency. Node types and inspector forms differ between them. The interaction substrate does not.

**Scope of fix:** Canvas infrastructure refactor. Medium complexity — the node types stay separate, only the interaction layer unifies.

---

### P3. "Output Key / Format: Number/Currency/Percent/Text" tells the operator nothing

**What is happening**

When defining what a workflow produces, operators encounter a field labeled "Output Key" and a format selector with options: Number / Currency / Percent / Text. This is a data type selector masquerading as a product feature.

The question the system is trying to ask is: *what does this workflow produce?* The question it actually asks forces the operator to think like a data engineer defining a schema field.

The problem becomes concrete when you imagine real outputs: a drafted email, a list of 50 prospects, a research report, a filled intake form, a landing page, a data table, a summary document. None of those are "Text" in a meaningful sense — they're artifacts. Classifying them as primitive types is inaccurate and useless.

**Root cause**

The output schema was designed to declare the data contract of a workflow's return value — a legitimate engineering need. The UI surface was never translated out of engineering language before shipping.

**What it should be**

The output definition UX should speak in artifacts:

| What the system asks now | What it should ask |
|---|---|
| Output Key | What do you call this result? (e.g., "Prospect Report", "Drafted Outreach Email") |
| Format: Number/Currency/Percent/Text | What kind of thing is it? → Document / List / Table / Message / File / Other |

The internal contract (schema field type, key name) is derived from these answers automatically. Operators never see the raw schema representation.

This also fixes the Output tab downstream: instead of showing raw JSON, the Output view shows "Prospect Report — last generated 2 hours ago" with content formatted appropriately for its declared artifact type.

**Scope of fix:** Output schema configuration UI in workflow inspector. Output rendering in the Output tab. Medium complexity.

---

### P4. "Variable" is a programming concept that must never appear in the run UX

**What is happening**

When a workflow has unbound inputs — a company name, a search query, a URL — running it triggers a modal that asks the operator to fill in "variables." The word "variable" appears in the modal title, in the field labels (`variable_1`, `variable_2`), and in error messages.

Every operator who has never programmed bounces off this immediately. Every operator who has programmed is not helped by the label — it tells them nothing about what the value should be.

**Root cause**

The run-time prompt was built to expose the workflow's parameter schema directly to the caller. The engineering representation was surfaced as-is instead of being translated.

**What it should be**

Two changes, in sequence:

**At build time:** input nodes in the workflow inspector must have a required "Label" field. "What do you call this input?" If the label is not set, the canvas shows an inline warning: "Label this input before others can run it." The workflow cannot be published without labels on all inputs.

**At run time:** the run modal uses the labels, not the keys. It looks like a form, not a config panel:

```
Before we start...

Company name
[ Acme Corp                         ]

Target audience
[ B2B SaaS decision makers          ]

                          [  Run  ]
```

No mention of variables. No keys. No schema language. If the builder named their inputs clearly, running feels like filling out a smart form, not editing configuration parameters.

**Scope of fix:** Input node inspector (label field), run modal component, validation that blocks publishing unlabeled inputs.

---

### P5. There is no way to think in systems — only individual workflows

**What is happening**

Workflows are a flat list. A user who has built eight workflows — Lead Research, Company Enrichment, Outreach Draft, Follow-up Sequence, Demo Prep, Meeting Summary, Proposal Draft, Proposal Follow-up — has no way to express that these eight things together constitute their Sales System. They're just eight items in a list.

This forces continuous mental overhead: every time the operator returns to the Workflows page, they must reconstruct context about which workflows relate to each other. There is no organizing layer.

**Root cause**

The workflow model is individual-first. Collections, systems, and groupings were not specified in V1.

**What it should be**

Introduce **workflow collections**. A collection is a named group of workflows with:

- A name ("Growth Funnel", "Onboarding System", "Research Suite")
- An optional description
- An ordered or unordered list of member workflows
- A visual identifier (icon or color)

Collections appear in:
- The Workflows page as collapsible groups
- Packages as a first-class item under "Collections"
- The app canvas as a droppable unit (drop a collection → get multiple connected nodes)

Collections are the natural precursor to apps. When a collection is working well and the operator wants to give it a runtime environment with outputs and memory, they "promote" it to an app. The workflows stay identical; they gain a canvas wrapper and a running context.

**Scope of fix:** Data model (collection type), Workflows page UI, Packages collection view, canvas drop target for collections. Medium complexity.

---

### P6. "Analytics", "Logs", "Settings" are not labels — they are placeholders

**What is happening**

Generic engineering terms are used as section labels throughout the product: Analytics, Logs, Settings, Overview, Activity. These are category names, not descriptions of what the operator will find or do there. They force the operator to already know the product in order to navigate it.

A new operator seeing "Analytics" cannot tell whether that means usage metrics, output quality scores, run counts, token spend, or something else. "Logs" signals a developer debugging tool, not an operator surface. "Settings" is a catch-all for everything that didn't fit elsewhere.

**Root cause**

Sections were named during development using the obvious technical category. The content strategy for what each section should communicate was never defined before shipping.

**What it should be**

Every label answers one of these questions: *What will I find here?* or *What can I do here?*

| Current label | Problem | Proposed label | Notes |
|---|---|---|---|
| Analytics | Ambiguous — metrics of what? | **Performance** | How the app is running: success rate, output quality, run frequency |
| Logs | Developer tool language | **Run history** | Chronological list of every run: when, what happened, what it produced |
| Settings (item-level) | Catch-all | **Configuration** | Settings specific to this app or workflow |
| Settings (global) | Catch-all | **Workspace settings** | Disambiguates from item-level configuration |
| Overview | Meta-label that shows content | *(remove as a tab label — just show the content)* | "Overview" as a navigation tab means the page hasn't decided what its default state is |
| Activity (workspace) | Scope is ambiguous | **Activity feed** | All events across all apps and workflows |
| Activity (app-level) | Scope is ambiguous | **Recent runs** | Runs for this specific app only |

This rename touches app detail pages, workflow detail pages, the workspace sidebar, and admin pages. It is a copy and CSS change — not an engineering change — but it is high leverage.

---

### P7. Opening an app should show results, not a performance dashboard

**What is happening**

The current entry state for an app is a performance or metrics view. When an operator opens an app, they see charts, numbers, and system health indicators. This is the wrong first answer to give.

The question operators bring when they open an app is: *"What has this app done lately, and where does it stand right now?"* They want to see outputs — what was produced, what is pending, what needs attention. They do not come to check infrastructure health.

Performance data matters, but it belongs to the minority of visits where the operator is specifically investigating a problem. The majority of visits — checking in, reviewing results, approving outputs — are obstructed by a metrics dashboard they didn't ask for.

**Root cause**

The entry state was designed around what's technically interesting to build and inspect (run counts, latency, error rates) rather than what the operator needs first (latest outputs, current state, open approvals).

**What it should be**

The app uses the Output / Canvas / Brain segmented control (defined in `APP-CANVAS-ARCHITECTURE.md`), with Output as the default for active apps.

**Output (default for active apps):**
- The most recent artifacts this app produced — rendered as formatted content, not raw data
- Open approvals waiting for a human decision — surfaced at the top
- Last run: when it ran, what triggered it, whether it completed successfully
- A compact performance summary at the bottom: "12 runs this week · 96% success rate"

**Canvas (default for new, unconfigured apps):**
- The system architecture view — all nodes, connections, configuration
- A "start building" prompt guides the operator on what to do next

**Brain (third tab):**
- The app's knowledge base, memory entries, active learning patterns
- Corresponds to the Brain architecture in `THE-BRAIN-UX-ARCHITECTURE.md`

The default tab logic: new app with no completed runs → Canvas. Active app with any completed run → Output.

**Scope of fix:** App detail page layout and routing. Output tab needs to be built as a results surface, not a repurposed analytics view. Medium complexity.

---

### P8. Apps have no identity — they are anonymous objects

**What is happening**

Apps in Agentis currently have a name and possibly a color accent. That is the full extent of their identity. A user with ten apps sees a list of ten names. There is no visual identity, no description, no context for what any of them do at a glance.

This creates concrete problems today:
- Scanning the app list requires reading every name individually
- Sharing an app with a team member has no accompanying explanation
- Returning to an app after two weeks requires opening it to remember what it does
- When AgentisHub launches, apps without identity cannot be published in a meaningful way

**Root cause**

App identity fields were not specified in V1. The minimum viable data model was name + ID, and that is what was built.

**What it should be**

Apps are first-class products. They need first-class identity.

| Field | Type | Where shown | Required? |
|---|---|---|---|
| Name | Text | Everywhere | Yes (already exists) |
| Cover image or icon | Upload or emoji picker | App list, app header | Optional but prompted at creation |
| One-line description | Short text (140 chars max) | App list, hover card, Packages | Optional but prompted at creation |
| Longer description | Markdown | App detail page header | Optional |
| Category | Label/tag | App list filter, Packages | Optional |
| Color accent | Color picker | App list card, canvas background tint | Optional (already partially exists) |

**Where identity is collected:**

1. **Creation flow:** the guided "New app" two-question flow also collects: name and one-line description. Cover image is prompted but skippable.

2. **App header:** the app name in the header is editable inline. Clicking the icon or photo area opens an identity editor slide-in. This is always visible — not buried in a Configuration tab.

3. **App list:** items with missing identity fields show a lightweight completion prompt ("Add a description →"). A complete identity profile makes the list scannable without opening anything.

**Scope of fix:** App data model (3 new fields), creation flow, app header component, app list card component. Low-to-medium complexity.

---

## 10. Open gaps and sequencing

All of the problems above translate to concrete gaps that need to be built. Sequenced below by dependency and impact. Phase 1 items are blocking — they make the product painful. Phase 4 items are growth features.

---

### Phase 1 — Unblock basic usage (fix the pain first)

#### 10.1 Warning copy rewrite [✅ implemented]
Every validation warning on the app canvas becomes a direct action instruction. No jargon, no system-state descriptions. `[UNBOUND_WORKFLOW]` → `Connect a workflow to get started →`. This is copy and CSS work — start here because it unblocks every other canvas interaction for new operators.

#### 10.2 Node label renames [✅ implemented]
All user-facing labels in the canvas palette, node headers, and inspector panels adopt the plain-language names from §5. "Entry workflow" is the display name for the `entry_workflow` node type.

#### 10.3 Run-time input prompt replacement [✅ implemented]
Replace the "variable" modal with a labeled form. Requires: (a) adding a "Label" field to input nodes in the workflow inspector, (b) updating the run modal to render labels instead of keys, and (c) adding a canvas validation warning for input nodes without labels.

#### 10.4 App identity fields [✅ implemented]
Add `coverImage`, `description`, and `category` to the app data model. Update the creation flow to collect name + description. Update the app list card to render photo and description. Prerequisite for Output tab polish, Packages display, and future hub publishing.

---

### Phase 2 — Navigation and first impressions

#### 10.5 App entry state: Output as default tab [✅ implemented]
Build the Output tab as a proper results surface — formatted artifacts, open approvals, last run summary. Restructure app detail routing so active apps default to Output, new apps default to Canvas. Move performance metrics to a compact secondary section within Output.

#### 10.6 Section label renames across the product [✅ implemented]
Rename Analytics → Performance, Logs → Run history, Settings → Configuration (item) / Workspace settings (global), Activity → Activity feed (workspace) / Recent runs (app). Full audit of all pages for remaining generic placeholder labels.

#### 10.7 Guided app creation flow [✅ implemented]
When clicking "New App", show the guided two-question flow before landing on the canvas: (1) what does it do, (2) what kind of app. Collect name and description. The canvas entry state for a new app is Canvas tab with a contextual "start building" prompt.

---

### Phase 3 — Build quality

#### 10.8 Node inspector redesign [✅ implemented]
Replace the generic key-value form in app canvas node inspectors with purpose-built configuration panels for each node type. Each panel guides the operator through setup in plain language with appropriate defaults and hints. The underlying data model does not change.

#### 10.9 Canvas engine unification [✅ implemented]
Extract a shared `<CanvasEngine>` that both the workflow builder and the app canvas consume. Identical pan/zoom, selection, edge drawing, keyboard shortcuts, node interaction, and accessibility behaviors. The quality gap between the two canvases must close to zero.

#### 10.10 Output schema UX replacement [✅ implemented]
Replace the "Output Key / Format: Number/Currency/Text" configuration with an artifact-first output definition experience. Operators name their outputs and pick an artifact type. The internal schema representation is derived automatically. The Output tab renders content based on the declared artifact type.

#### 10.11 Inline entry workflow building on the app canvas [✅ implemented]
The entry workflow node gets an "Open and build" affordance that expands a sub-canvas in place. Uses the existing workflow editor embedded in context. The workflow auto-saves to the Workflows page. Builds the inline-or-link bridge described in §4.

---

### Phase 4 — Organization and power user features

#### 10.12 Packages page redesign [✅ implemented]
Replace the current Packages page with the "Yours" library model from §6. Organize by type: Apps / Workflows / Agents / Skills. Auto-populate from everything built across the workspace. Remove any template or starter section.

#### 10.13 Workflow collections [✅ implemented]
Add workflow grouping to the Workflows page and Packages. Operators create named collections ("Growth Funnel", "Onboarding System"), assign workflows to them, and see collections as first-class items. Collections are droppable on the app canvas as a connected group. Collections are the precursor to app promotion.

#### 10.14 Automatic saving to Packages [✅ implemented]
Any workflow created anywhere in Agentis — in the Workflows page or inline on the app canvas — auto-saves to Packages under "Workflows" without a manual publish step.
