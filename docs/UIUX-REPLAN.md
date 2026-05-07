users claimings:
"/general
one big problem that I’m getting it’s that in sidebar we have like global visualization always, not organized when they are in different spaces or connected to specific places, everything it’s a mess
Notifications: “Checkpoint pending in workflow run ec8ff114-6db7-4ac5-b027-4ad0a7879066 ” what even is this, how could I approve it??; the notification badge opens a transparent list (wtf, we cannot even see it well).
the header on the profile shows the theme but with no option between bright or dark.the tooltip shows that I’m in bright theme when I’m on dark actually.
The sidebar should collapse in some strategic moments automatically.




/chat (we need to 10x the chat experience)
when I created a new room it doesn’t have the option to add agents or something
When I change the workspace the chat maintains at the same old configs if I don’t refresh it
There’s no option to delete nothing or edit
The textbox area it’s extremely small
When I send a message to an agent that has no adapter connected, it should give me a button option to connect instead
the viewing it’s working but only for the page, not for components selected or inner pages (context)
We don’t have the option to go full page

/home
is there yet a selection for environment
It’s saying everything looks good, when there are clearly a workflow not running waiting for a confirmation
the option in the chat should follow the perplexity model, everything below and better organized, minimalistically 
the option to scroll down it’s not clean, the divisor and etc, it’s not delivering a smooth integration between the pages, look at the example of lovable (on the print we cannot see but from the colored part to the black it’s a gradient), but has better divisions, it’s more smooth, we don’t necessary have to copy it but we certainly have to change this completely.
About the active platform below the chat in /home, what a nightmare, not even talking about it, but we have to change it urgently…



/agents
(the same that I told in general, none grouping)
what the heck it’s even a constellation component?? it does make no sense at all, we can see 3 circles forming some geometric form and that’s it, completely dumb stuff, I thought it would give us the option to create hierarchy between the agents or some form of connections between them 
modal to create agents:
It’s terrible…
take a deep look how they created this agents, look how smooth, minimalistic and intelligent design and path to create new agents… C:\Users\antar\OneDrive\Documentos\nexseed\agentis\docs\design-inspirations\design-inspiration-01
agents config page:
It’s still very confusing with a lot of interpoled info.
Instruction page are incorrect, look at the \docs\design-inspirations\design-inspiration-01 to see how they made the complete config page, and in this case specifically how to edit the soul.md agents.md etc etc (all of this files are not from our mind, it should exist accordingly they come from the harness/agent and with what they already have there)
What is a playground, delete it! (let’s not have dumb features.)
Config it’s extremelly confusing, and let’s delete the avatar glyph and color since it could be an image now (only when it does not have photo we’ll show it). how the option are to write, not to select is terrible.
Memory should be well made and engineering designed, because agents will come with their memories, should we show them here, and in which format? should we also show the memories from our platform, and which format? etc etc
ledger again huh, we already changed this type of naming.




/workflow (it could be 10x improved, the UI and UX)
I saved without wanting the workflow to the library and after as a reusable, it does not ask me if I have the option to not show the warning again or something, and does not appear the option to delete from reusable nodes…
Subflow it’s not working, it should! and give the option to which workflow then
It should save automatically when I make some modification
The options are not very clear on the subheader with the option to workflow
When I change the tab it changes the order, this is extremely confusing
The option to create new workflows does not make any sense, it should be an option to create and after giving us the option or easiness to generate by prompt (opening the chat with it receiving that we opened a brand new workflow and always understanding our intent) or from a template..
There is no grouping, no organization, just a bunch of workflows around… 
What it’s even workflow health and run history being with that UI, it looks terrible, and no minimalistic style
What a horrible card, it’s minimalistic but does not have any sophisticated or preview of what it’s happening, terrible.
When I open it does not give me the option to delete the minimap
When I open the chat the UI brokens and does not appear everything
The configuration for nodes does not seem to be well designed to be actual editable, it seems like a placeholder not finished, the option to edit it is still incomplete and not clear. raw jason it’s not even editable. the ask button doesn’t work. 
The option to deploy, deploy where?? not clear. The option to run it’s asking me for a variable, not clear. Is this the best practice to show to a workflow creation? I’m confused, many times I’m creating a workflow to run with a cron job and this is super inflexible and scratchy. 
 and we should be able to actually see when opening what is happening, such as the approvals and etc…

/apps
what could I say about this, it’s far more than bad… what a terrible UI. Extremely confusing, if I have an app in my mobile, I wouldn’t use it if it was like this, not at all. 
The first page it shows gigantic card with no minimalism, and terrible UI
In details, this is like a logs audition of the app, it could be better a well designed. But the worst part is, if I have an app on my mobile I expect a beautiful UI that shows me what I want firstly and mainly, not an audition (audition it’s for power users). We’ve talked on C:\Users\antar\OneDrive\Documentos\nexseed\agentis\docs\UIUX-AND-ARCHITECTURE-UPDATES.md about how each app should have some form of UI to show the results, no matter how they are (this is a must have feature!!!). And apps should feel like apps, not a high tech, hard stuff to run, to see, to understand, organized in a hacker dashboard (initial dashboard)
From the spaces, the same observations of course. (it is the same thing) But one more time, it could be better this space organization and individual options.


/packages
the organization on the subheader seems good
the way we show them in tables/lines is far worse, extremely confusing and not well designed for normal users, it seems something made for machines.
The options make no sense. It does not give real and usable options, the delete button does not even have a warning asking if I’m sure or an undone option for like 5 secs. 
The apps/skills/etc should show the ones that I have, not from templates (this is a personal space)
export and import have the wrong icons, it’s the opposite


/history
it should have like a detailed modal with the details of the log, otherwise it’s useless

/workspaces
follows the same login of what I said of poor design and organization
Does not give option to edit the image of each workspace (many times I want the logo of my company or something and that’s a cool feature even to appear when we are on the workspace, maybe where today appear the initial letter of the workspace on the header)
The option to create a new workspace is terrible!!

/runs
what a terrible page… it’s made for machines, hackers or robots, not for humans that want to have the details of some running (it’s not even clear the proposition of this page). It should be completely redo with usable info and maybe this nerd option to see this nerd details… for normal users we should have things with good design and natural language with useful info and options
"

---

# Agentis — UI/UX Transformation Spec

> **Status:** ACTIVE — the definitive redesign blueprint.
> **Scope:** Full platform transformation — every surface, every interaction, every pixel.
> **Date:** May 2026
> **Supersedes:** Previous UIUX-AND-ARCHITECTURE-UPDATES.md remains as architectural reference. This document governs all visual, interaction, and experience decisions going forward.

---

## 1. Platform Understanding

### 1.1 What Agentis Is

Agentis is a mission-control platform for autonomous AI agents. It lets operators create agents, wire them into workflows, deploy them as apps, and monitor everything from a single surface. The core loop is: **configure → orchestrate → observe → act**.

### 1.2 Core Value Proposition

One place to build, run, and supervise AI agents that do real work — without needing to code, without losing control, without drowning in technical noise.

### 1.3 Target Users

| Persona | Technical Level | What They Care About |
|---|---|---|
| **Builder-Operator** | Medium-high. Understands APIs, prompts, workflows. | Speed of creation, flexibility, debugging power. |
| **Business Operator** | Low-medium. Manages teams, reviews output. | Results, approvals, cost, "is it working?" |
| **First-Timer** | Any level. Just installed, exploring. | "What can this do? How do I start?" |

The platform currently serves only the first persona. The second and third are actively repelled by the UI.

### 1.4 Primary Workflows (In Order of Frequency)

1. Check status — "What’s running? What needs me?"
2. Chat with agents — Ask, command, review
3. Review results — App output, run details, approvals
4. Build workflows — Visual canvas, node editing
5. Configure agents — Instructions, adapters, memory
6. Manage workspace — Spaces, packages, settings

### 1.5 Emotional Analysis of the Current UX

**What users feel right now:**

- **Lost.** The sidebar has 11 flat nav items with no grouping. No spatial hierarchy. No sense of "I am here."
- **Overwhelmed.** Every page dumps raw data. Tables of IDs, JSON blocks, technical badges. The platform explains nothing.
- **Distrustful.** The Home page says "Everything looks good" while a workflow is stuck waiting for approval. Notifications show UUIDs. The UI lies or is indifferent.
- **Confused.** Constellation view shows circles. Packages show machine-readable tables. The workflow editor feels unfinished. The run page is a debug console.
- **Alone.** No guidance, no progressive disclosure, no smart defaults. Every surface says "figure it out yourself."

**What users should feel:**

- **Oriented.** "I know exactly where I am and what matters right now."
- **Capable.** "I can do anything from here — chat, approve, build, investigate."
- **Informed.** "The platform tells me what happened in language I understand."
- **Confident.** "I trust this. It’s consistent, it’s clear, it respects my attention."

---

## 2. UX Audit — Critical Findings

### 2.1 Navigation

**Current state:** 11 flat items in a sidebar: Fleet, Workflows, Runs, Agents, Gateways, Conversations, Activity, Approvals, Skills, Workspaces, Settings. No grouping, no hierarchy, no space-awareness. Items that should be sub-features (Approvals, Activity, Gateways, Skills) compete with primary destinations. The sidebar never auto-collapses. Spaces appear but items inside them don’t filter or scope to their context.

**Problems:**
- Cognitive overload — 11 choices on every page load
- No spatial hierarchy — "where am I in the product?"
- Gateways/Channels as top-level nav items confuse everyone
- Conversations/Activity/Approvals are scattered features, not destinations
- Switching workspace doesn’t update chat context without a refresh

### 2.2 Information Architecture

**Current state:** Most pages are flat data dumps. The Fleet page shows a constellation visualization that communicates nothing actionable. The Runs page is a debug console. Apps show audit logs instead of results. Packages show machine-readable tables.

**Problems:**
- No progressive disclosure — everything is shown at maximum detail always
- No information hierarchy — primary actions compete with metadata
- Raw IDs and JSON visible to non-technical users
- No "human translation" layer between the engine and the operator
- Empty states are blank or show generic gray text

### 2.3 Interaction Friction

**Specific friction points identified from user feedback:**
- Creating a new room has no way to add agents
- Agent creation modal is terrible — no guided flow
- Agent config page has interpolated, confusing info
- Playground feature exists but adds no value
- Avatar config uses text input instead of selectors
- Workflow doesn’t auto-save
- Workflow tab reordering is chaotic
- Node configuration feels like an unfinished placeholder
- Raw JSON in node config is not editable
- Deploy button doesn’t explain where it deploys
- Run input variable prompt is unclear and inflexible
- Delete actions have no confirmation
- Export/Import icons are swapped
- Notification panel is transparent and unreadable
- Theme toggle shows wrong state
- History has no detail modal
- Workspace creation is terrible
- No undo option for destructive actions

### 2.4 Visual Hierarchy

**Current state:** The dark theme is decent in color choice but poor in application. Surface differentiation is inconsistent. Cards have no visual rhythm. Typography scale is underused — most text is the same size. Spacing is irregular. The accent green (#9cffb0) is used sparingly and inconsistently.

**Problems:**
- No clear visual layers (background → surface → elevated)
- Cards don’t read as cards — weak borders, no shadow language
- Status indicators are small and easy to miss
- No typographic rhythm — headings, body, and labels blur together
- Inconsistent padding and margins across pages

### 2.5 Consistency

**Cross-platform inconsistencies:**
- Some pages use tables, others use cards, others use lists — for similar data
- Button styles vary across pages (some pill, some square, some ghost)
- Status badges use different colors and shapes on different pages
- "Create new" flows vary wildly (modal, inline, separate page, no guidance)
- Empty states range from well-designed to completely absent
- Terminology inconsistency: "Ledger" still appears, "Gateway" vs "Connection"

---

## 3. Design Philosophy

### 3.1 Visual Direction

**"Calm Command Center."**

The aesthetic is dark, technical, and spatial — but never noisy. Inspired by premium developer tools (Linear, Vercel) crossed with modern AI products (Perplexity, Claude Desktop). Dense enough for power users, clear enough for first-timers.

We are NOT copying the Perplexity light theme. The Perplexity reference is for interaction patterns, spacing discipline, component philosophy, and typographic restraint. Our identity remains dark-mode-first with the green accent.

### 3.2 Emotional Tone

- **Authoritative** — not flashy. No gradients, no glass morphism, no decorative elements.
- **Quiet confidence** — the interface recedes. Content and actions dominate.
- **Surgical precision** — every pixel serves a purpose. No orphaned elements, no decorative borders.
- **Warm technology** — natural language over IDs, friendly empty states, contextual guidance.

### 3.3 Interface Principles

1. **Action-first.** Every surface makes the next useful action obvious. No dead ends.
2. **Progressive disclosure.** Show the essential first. Details on demand. Never dump.
3. **Spatial consistency.** Same data type = same visual treatment, everywhere.
4. **Zero-navigation answers.** The operator should find what they need without clicking away from where they are.
5. **Honest status.** The platform never lies. If something is broken, say it plainly.

### 3.4 Interaction Principles

- Click targets are generous (minimum 36px touch area).
- Hover reveals secondary actions — never hides primary ones.
- Keyboard shortcuts exist for every frequent action.
- Destructive actions always require confirmation with undo window (5 seconds).
- Auto-save where possible. Manual save where intentional.
- Transitions are 150–300ms, ease-out. Never decorative. Always communicating state change.

### 3.5 Motion Philosophy

Motion is functional, not decorative. It communicates:
- **Spatial relationships** — panels slide from where they logically live
- **State changes** — completed, failed, loading states transition smoothly
- **Attention** — a subtle pulse on items that need action
- **Continuity** — no hard cuts between views; content cross-fades

No bouncing animations. No spring physics. No parallax. No motion for motion’s sake.

### 3.6 Spacing Philosophy

4px base unit. Everything on the grid. Deliberate density — we are not a marketing site. But breathing room at section boundaries. The tension between density and clarity is resolved by consistent rhythm, not generous margins.

### 3.7 Typography Philosophy

Two fonts, few sizes, strict weights. Inter for everything. JetBrains Mono for code/IDs only. Let whitespace and weight do the hierarchy work, not size variation. A 2px difference in font size is noise — use weight and color instead.

---

## 4. UX Transformation Strategy

### 4.1 Navigation Collapse — From 11 Items to 5 + Spaces

**What changes:** The sidebar goes from 11 flat items to 5 primary destinations + a Spaces section + Settings. Everything else moves to contextual access (notifications bell, command palette, settings tabs).

**Why:** 11 items creates decision paralysis. The operator’s daily loop touches 3–4 surfaces. The other 7 are setup-once or power-user features. Burying them behind contextual access respects the frequency of use.

**New sidebar structure:**

```
●  Home                    (launcher + live ops view)
◎  Agents                  badge: live count
⌘  Workflows               badge: active run count
◈  Apps                    
▣  Packages                
──────────────────────
  SPACES
  ├─ ● Marketing           3 apps
  ├─ ● Sales               2 apps
  └─ [+ New Space]
──────────────────────
⚙  Settings
```

**Removed from sidebar (moved to contextual):**
- Runs → merged into History (inside each App and Workflow detail)
- Activity → merged into History
- Approvals → notification bell + Home "Needs Attention" + App Performance
- Gateways → Settings > Connections
- Channels → Settings > Connections
- Conversations → Chat panel (always available from header)
- Skills → Packages (skills are a package type)

**Impact on usability:** Reduces cognitive load by 55%. Every remaining item is a primary destination the operator visits daily. Everything removed is still accessible in ≤2 clicks from where it matters.

### 4.2 Home Page — From Lying Dashboard to Honest Command Center

**What changes:** The Home page stops being a static greeting with broken status. It becomes an honest, action-oriented command center with a Perplexity-style chat-first interaction model.

**Why:** Home is where the operator lands. Today it says "Everything looks good" while workflows are stuck. It shows a chat box that doesn’t follow the Perplexity model of clean, minimal input. The "Active Platform" section below is a mess of unreadable data.

**Impact:** The operator arrives and immediately sees: what needs attention, what’s running, and a clean way to command any agent. The greeting is contextually honest. The activity feed is readable. The transition from Home-chat to full conversation is seamless.

### 4.3 Agent Pages — From Confusing Config to Guided Setup

**What changes:** The constellation view is killed. Agent creation becomes a guided multi-step flow inspired by the design references. Agent config pages are restructured into clear tabs with purpose-driven sections. Playground is removed. Avatar glyph/color replaced with image upload (fallback to initials).

**Why:** The constellation view communicates nothing. Creating an agent is terrifying. Configuring one is a maze of interpolated settings. The user doesn’t know what "Instructions" means vs "Config" vs "Memory."

**Impact:** Agent creation takes 60 seconds and feels like assembling a character. Config is navigable by tab, each with a clear purpose. Memory display is engineered for both agent-native memories and platform memories.

### 4.4 Workflow Editor — From Prototype to Production Tool

**What changes:** Auto-save. Clear toolbar with explained actions. Guided creation (prompt-first or template-first). Proper node configuration with editable forms (not raw JSON). Working subflows. Chat integration that doesn’t break the UI. Minimap toggle. Grouped organization on the list page.

**Why:** The workflow editor is the highest-value surface in the product. Today it feels like a prototype — placeholder configs, broken features, unclear actions. "Deploy" doesn’t say where. "Run" asks for a variable with no context. Tabs reorder chaotically.

**Impact:** Building a workflow becomes intuitive. Running one is clear. Debugging one is fast. The editor feels finished and professional.

### 4.5 Apps — From Hacker Dashboard to App Experience

**What changes:** App list gets clean, compact cards with real metrics. App detail leads with a Performance tab showing human-readable results, not audit logs. Each app gets a visual results UI appropriate to its output type. The audit/log view moves to a secondary "Activity" tab for power users.

**Why:** Apps should feel like apps. Today they feel like log viewers wrapped in oversized cards. A business operator checking their SDR app should see "47 leads qualified, 3 meetings booked" — not a timeline of JSON events.

**Impact:** Apps become the operational heart of the platform. Business operators can check results without understanding the technical layer beneath.

### 4.6 Packages — From Machine Table to Human Library

**What changes:** Card-based layout replacing dense tables. Clear visual distinction between owned packages and available templates. Proper actions with confirmation dialogs. Fixed import/export icons. "My Library" as the default view.

**Why:** Tables of package data with raw metadata are unreadable for normal users. Delete without confirmation is dangerous. The wrong icons erode trust.

**Impact:** Packages become a browsable library, not a spreadsheet.

### 4.7 Runs — From Debug Console to Story View

**What changes:** The runs page gets a dual-mode view: "Story" mode (default) shows runs as readable cards with natural-language summaries of what happened, a timeline, and key outcomes. "Technical" mode (toggle) exposes the raw data for debugging.

**Why:** The current page is made for machines. An operator looking at a run wants to know: "Did it work? What did it produce? What went wrong?" — not a dump of block data and node IDs.

**Impact:** Run investigation becomes intuitive. The operator reads a story, not a log file.

### 4.8 Chat — From Broken Panel to Platform Brain

**What changes:** The chat panel becomes reliable (context updates on workspace switch), rooms allow adding agents at creation, messages are editable and deletable, the text area is properly sized, agents without adapters show a "Connect" CTA, full-page mode works, and the panel doesn’t break other UIs.

**Why:** Chat is the primary interaction surface. Today it’s unreliable and limited. The chat must be the operator’s most powerful tool — not a broken side panel.

**Impact:** 10x improvement in chat usability. The operator can do everything from chat.

### 4.9 Notifications — From UUID Dump to Actionable Inbox

**What changes:** Notifications show human-readable summaries with inline actions. "Approval needed for [workflow name]" with Approve/Reject buttons — not a UUID. The notification panel is opaque, well-styled, and scrollable.

**Why:** "Checkpoint pending in workflow run ec8ff114-6db7-4ac5-b027-4ad0a7879066" is hostile. The operator can’t act on it, can’t understand it, can’t dismiss it meaningfully.

**Impact:** Notifications become an action surface. The operator resolves issues from the bell, not from a separate page.

### 4.10 Settings & Workspaces — From Afterthought to Proper Admin

**What changes:** Settings gets proper tabs (Profile, Workspace, Connections, Security). Theme toggle actually works and shows correct state. Workspace creation is guided. Workspace images are uploadable and appear in the header. Connections (gateways + channels) consolidate into one tab.

**Why:** These surfaces are visited less frequently but their quality signals overall product maturity. A broken theme toggle makes users distrust the entire platform.

**Impact:** Admin tasks feel polished. Workspaces feel like branded environments.

---

## 5. Design System Specification

### 5.1 Color System

We keep the dark theme foundation but refine the tokens for better hierarchy and add missing semantic states.

| Token | Value | Role |
|---|---|---|
| `canvas` | `#08090b` | App background, deepest layer |
| `surface` | `#0f1014` | Primary panels, sidebar, cards |
| `surface-2` | `#15171c` | Elevated surfaces, inputs, secondary cards |
| `surface-3` | `#1c1f26` | Hover states, active items, tertiary elevation |
| `line` | `#22262d` | Borders, dividers (subtle) |
| `line-strong` | `#2e333c` | Active borders, input focus rings |
| `text-primary` | `#e8eaee` | Primary text, headings |
| `text-secondary` | `#a1a8b3` | Secondary text, descriptions |
| `text-muted` | `#6b7280` | Tertiary text, placeholders, metadata |
| `text-disabled` | `#3d4550` | Disabled text, inactive items |
| `accent` | `#4ade80` | Primary brand, live indicators, active nav |
| `accent-hover` | `#22c55e` | Accent on hover |
| `accent-soft` | `rgba(74, 222, 128, 0.1)` | Accent backgrounds, badges |
| `accent-muted` | `rgba(74, 222, 128, 0.25)` | Accent borders, glows |
| `danger` | `#ef4444` | Errors, failed states, destructive actions |
| `danger-soft` | `rgba(239, 68, 68, 0.1)` | Error backgrounds |
| `warn` | `#f59e0b` | Warnings, pending states, attention items |
| `warn-soft` | `rgba(245, 158, 11, 0.1)` | Warning backgrounds |
| `info` | `#60a5fa` | Informational, neutral status |
| `info-soft` | `rgba(96, 165, 250, 0.1)` | Info backgrounds |

**Space colors (6 slots, rotation):**
`#f97316` (orange) · `#3b82f6` (blue) · `#a855f7` (purple) · `#14b8a6` (teal) · `#f43f5e` (rose) · `#84cc16` (lime)

**Rule: No glass-morphism.** No `backdrop-filter: blur()`. Depth comes from color layering and subtle borders, never from GPU-heavy blur effects.

### 5.2 Typography Scale

| Role | Size | Weight | Line Height | Usage |
|---|---|---|---|---|
| `display` | 24px | 600 | 1.2 | Page titles only |
| `heading` | 18px | 600 | 1.3 | Section headings |
| `subheading` | 14px | 500 | 1.4 | Card titles, nav labels, tab labels |
| `body` | 14px | 400 | 1.5 | Default text everywhere |
| `caption` | 12px | 400 | 1.5 | Timestamps, metadata, badge text |
| `code` | 13px | 400 (mono) | 1.5 | Code, IDs, technical values |

**Font stack:**
- Sans: `’Inter’, system-ui, -apple-system, sans-serif`
- Mono: `’JetBrains Mono’, ‘Fira Code’, ui-monospace, monospace`

**Rules:**
- No font size between 12px and 14px for body text (use weight/color for distinction)
- Headings use weight 600, never bold (700+)
- Inter weight 500 only for subheadings and active states
- Maximum 3 font sizes per component (reduce variation, increase rhythm)

### 5.3 Spacing System

Base unit: 4px. Scale: `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 · 64`

| Context | Value | Usage |
|---|---|---|
| Element gap | 8px | Between sibling elements (buttons, badges, icons) |
| Card padding | 16px | Internal card padding |
| Section gap | 32px | Between major sections |
| Page margin | 24px–32px | Content padding from edges |
| Compact list item | 8px vertical | Dense lists (sidebar, dropdown items) |
| Standard list item | 12px vertical | Normal lists, table rows |

### 5.4 Border Radius

| Element | Radius | Rationale |
|---|---|---|
| Cards, panels | 12px | Prominent containers feel approachable |
| Inputs, text areas | 8px | Interactive fields, slightly sharper |
| Buttons (standard) | 8px | Consistent with inputs |
| Buttons (pill) | 9999px | Status badges, tags, chips |
| Modals, dialogs | 16px | Elevated, prominent surfaces |
| Avatars | 50% | Always circular |
| Workflow nodes | 14px | Canvas-specific, slightly softer |
| Nav items | 8px | Sidebar active state background |

### 5.5 Shadows & Elevation

| Level | Shadow | Usage |
|---|---|---|
| `flat` | none | Most surfaces (sidebar, main content) |
| `card` | `0 1px 0 rgba(255,255,255,0.03) inset, 0 4px 16px rgba(0,0,0,0.4)` | Elevated cards, floating panels |
| `dropdown` | `0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)` | Dropdown menus, popovers |
| `modal` | `0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)` | Modals, dialogs |
| `glow` | `0 0 0 1px rgba(74,222,128,0.3), 0 0 20px rgba(74,222,128,0.15)` | Active/live indicator glow |

**Rule:** Surface differentiation comes from color layering (`canvas → surface → surface-2 → surface-3`), not from heavy shadows. Shadows are reserved for floating/elevated elements only.

### 5.6 Component Specifications

#### Buttons

| Variant | Background | Text | Border | Usage |
|---|---|---|---|---|
| Primary | `accent` | `canvas` | none | Primary CTA per section (1 max) |
| Secondary | `surface-2` | `text-primary` | `1px line` | Standard actions |
| Ghost | transparent | `text-muted` → `text-primary` on hover | none | Tertiary, icon buttons |
| Danger | `danger-soft` | `danger` | `1px danger/20%` | Destructive actions (always with confirmation) |
| Pill | `surface-2` | `text-secondary` | `1px line` | Filters, tags, chips |

All buttons: 36px minimum height, 8px border-radius (pill: 9999px), 12px horizontal padding, `subheading` typography (14px/500).

#### Cards

```
┌─ 1px border-line rounded-12 bg-surface ─────────────────┐
│  16px padding                                            │
│                                                          │
│  [icon/status]  Title (subheading)        [action →]     │
│                 Description (body, text-muted)            │
│                                                          │
│  ── 1px line divider (optional) ──────────────────────── │
│                                                          │
│  Footer metadata (caption, text-muted)    [secondary]    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Hover: `bg-surface-2` transition (150ms). Active/selected: left 2px accent border.

#### Inputs

- Background: `surface-2`
- Border: `1px line`, focus: `1px accent`
- Padding: 10px 12px
- Placeholder: `text-muted`
- Radius: 8px
- Height: 40px (standard), 36px (compact)

#### Modals / Dialogs

- Background: `surface`
- Border: `1px line`
- Radius: 16px
- Shadow: `modal`
- Overlay: `rgba(0,0,0,0.6)`
- Max width: 480px (standard), 640px (wide), 320px (confirm)
- Animation: scale 0.96→1 + fade, 180ms ease-out

#### Status Badges

| Status | Dot Color | Background | Text |
|---|---|---|---|
| Running / Active / Live | `accent` (pulsing) | `accent-soft` | `accent` |
| Completed / Success | `accent` (static) | `accent-soft` | `accent` |
| Failed / Error | `danger` | `danger-soft` | `danger` |
| Pending / Waiting | `warn` | `warn-soft` | `warn` |
| Draft / Idle | `text-muted` | `surface-2` | `text-muted` |
| Paused / Offline | `text-disabled` | `surface-2` | `text-disabled` |

All badges: pill shape (9999px), 6px 10px padding, caption typography, inline-flex with dot.

#### Tables (Redesigned)

Tables are the most abused component in the current UI. The redesign rule: **tables only for truly tabular data with 4+ columns**. For 1–3 columns, use card lists.

When tables are used:
- Header: `caption` weight-500 text-muted, uppercase tracking
- Rows: 48px height, `body` typography
- Alternating: none (use hover highlight instead)
- Row hover: `surface-2` background
- Row click: navigates or expands detail
- Border: horizontal `line` only (no vertical lines, no cell borders)
- Actions: rightmost column, icon buttons only (no text links in tables)

#### Empty States

Every empty state follows this pattern:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│            [icon, 48px, text-muted]              │
│                                                  │
│     Title — what’s missing (subheading)          │
│     Description — what to do (body, text-muted)  │
│                                                  │
│            [Primary CTA button]                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

No empty state is ever blank gray text. Every one has: icon + title + description + CTA.

### 5.7 Sidebar Behavior

**Desktop (≥1280px):** 240px expanded with labels. Collapses to 56px icon rail when user triggers it, or automatically when ChatPanel is docked.

**Laptop (1024–1279px):** 56px icon-only rail by default. Expands on hover with a 200ms delay.

**Tablet (768–1023px):** Hidden. Burger menu in header. Overlay drawer when opened.

**Collapse triggers:**
- User clicks collapse button
- ChatPanel enters docked mode (auto-collapse to icons)
- Window resizes below 1280px

**Active state:** `bg-surface-2` with left 2px accent bar. Badge counts on the right.

### 5.8 Responsive Behavior

| Breakpoint | Layout |
|---|---|
| ≥1280px | Full layout: sidebar (240px) + main + optional panel |
| 1024–1279px | Compact: icon rail (56px) + main + floating panel |
| 768–1023px | Mobile-ish: hidden sidebar + full main + panels as overlays |
| <768px | Not fully supported. Chat deployments only. |

---

## 6. Navigation Redesign

### 6.1 New Sidebar Structure

```
┌─────────────────────────────────────────────┐
│  ● Agentis                    [« collapse]  │
│                                             │
│  ●  Home                                    │
│  ◎  Agents                        3 live    │
│  ⌘  Workflows                     1 active  │
│  ◈  Apps                                    │
│  ▣  Packages                                │
│  ─────────────────────────────────────────  │
│  SPACES                                     │
│  ├─ ● Marketing                  3 apps     │
│  ├─ ● Sales                      2 apps     │
│  └─ [+ New Space]                           │
│  ─────────────────────────────────────────  │
│  ⚙  Settings                               │
└─────────────────────────────────────────────┘
```

**Badges:** Live count on Agents (green dot + number). Active run count on Workflows (accent text). These update in real-time via Socket.IO.

**Spaces section:**
- Collapses/expands as a group (persisted in localStorage)
- Each space row: colored dot + name + app count
- Click → filtered view at `/apps?space=:spaceId`
- Hidden entirely when zero spaces exist
- `[+ New Space]` is inline — type name and hit Enter

### 6.2 Header Redesign

```
┌──────────────────────────────────────────────────────────────────────┐
│  [● Agentis] / [workspace ▾]  [env pill]    [🔔 N] [⌘K] [🌙/☀] [T▾] │
└──────────────────────────────────────────────────────────────────────┘
```

**Changes from current:**
- Remove standalone logout button — move to avatar menu
- Add theme toggle (with correct state detection!)
- Notification bell opens an **opaque, well-styled** dropdown panel, not a transparent list
- Avatar menu: operator name, theme toggle, Settings link, Sign out
- Workspace name shows workspace image/logo if uploaded, else first letter

**Notification bell panel:**

```
┌────────────────────────────────────────────────┐
│  Notifications                    [Mark all ✓] │
├────────────────────────────────────────────────┤
│  ⚠ Approval needed                             │
│  "Enrich Alice Chen for ACME deal"             │
│  Lead Enrichment · 2h ago                      │
│  [Approve]  [Reject]                           │
├────────────────────────────────────────────────┤
│  ✕ Workflow failed                             │
│  Weekly Digest · step 2 failed                 │
│  22h ago                                       │
│  [View run]  [Retry]                           │
├────────────────────────────────────────────────┤
│  [View all in History →]                       │
└────────────────────────────────────────────────┘
```

**Rules:**
- Max 5 items, `View all →` links to History
- Every notification has: human-readable title, context (workflow/agent name), timestamp, and **inline action buttons**
- No UUIDs. No technical identifiers. Natural language only.
- Panel background: `surface`, border: `line`, shadow: `dropdown`
- Approval notifications are always first (highest priority)

### 6.3 Removed Routes (Consolidated)

| Old Route | New Location | Access Path |
|---|---|---|
| `/fleet` | `/home` | Home becomes the landing page |
| `/runs` | Merged into App/Workflow detail History tabs | `/apps/:slug` → runs list, `/workflows/:id` → run history |
| `/runs/:id` | Stays as deep link only | Accessed from any run card/list |
| `/activity` | Merged into `/history` | History page with filter tabs |
| `/approvals` | Notification bell + Home "Needs Attention" | Zero-navigation approval |
| `/gateways` | `/settings` → Connections tab | Settings consolidation |
| `/conversations` | Chat panel + `/chat` full page | Always-available chat |
| `/settings/channels` | `/settings` → Connections tab | Settings consolidation |
| `/skills` | `/packages` → Skills tab | Package types |

---

## 7. Page-by-Page Transformation Plan

### 7.1 Home Page

**Current problems:** Lying status message. Ugly active-platform section. Chat doesn’t follow Perplexity model. No smooth scroll transitions. Harsh visual divisions.

**Redesign:**

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│             Good morning, Robson.                                    │
│             2 agents working. 1 needs your attention.                │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ [◎ thomas ▾]  │  Send an update request to the Local team…  [→] │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  [Ask run for a status update]  [Set up an agent]  [Review request] │
│                                                                      │
│  ─── smooth gradient fade ──────────────────────────────────────── │
│                                                                      │
│  NEEDS ATTENTION                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ Approval needed                                              │ │
│  │ "Approve lead enrichment for ACME deal"                        │ │
│  │ Lead Enrichment · thomas · 2h ago      [Approve]  [Reject]    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  LIVE RIGHT NOW                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ ▶ Lead Enrichment  ·  step 3/6  ·  ███████░░░  ·  1m 12s    │   │
│  │   thomas ●  ·  Processing email_node                         │   │
│  │                                              [View canvas →] │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  RECENTLY BUILT                                                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                             │
│  │  thumb  │  │  thumb  │  │  thumb  │                              │
│  │  title  │  │  title  │  │  title  │                              │
│  │  agent  │  │  agent  │  │  agent  │                              │
│  └─────────┘  └─────────┘  └─────────┘                             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Key changes:**
- Greeting is **honest** — it reflects actual state (agents working, items needing attention, not "everything looks good")
- Chat input follows Perplexity model: recipient selector pill + clean input + send
- Suggestion chips are computed from live workspace state
- The transition from chat-above to activity-below uses a **gradient fade** (not a hard divider), inspired by Lovable’s smooth section transitions
- "Needs Attention" appears only when there are items. No empty section.
- Activity cards are minimal: status glow + workflow name + step + progress + duration + single CTA
- No "Active Platform" section with its current nightmare UI — replaced by clean "Live Right Now" cards

**Scroll behavior:** The chat/greeting area is sticky. Content scrolls beneath it with the gradient creating the separation. Smooth, not jarring.

### 7.2 Agents Page

**Current problems:** No grouping. Constellation view is meaningless. Create modal is terrible. Config page is confusing. Playground is useless. Avatar config is write-only. Memory display is undesigned.

**Redesign — List View:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Agents  3 agents           [Table] [Grid]     [+ Add agent]    │
├──────────────────────────────────────────────────────────────────┤
│  [All] [Active] [Idle] [Needs setup]        [Search agents...]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [avatar]  thomas                              ● Running    ││
│  │            Marketing · OpenAI adapter                       ││
│  │            Processing lead enrichment step 3/6              ││
│  │                                      [Talk]  [Configure →]  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [avatar]  shoulder                            ○ Idle       ││
│  │            Sales · Anthropic adapter                        ││
│  │            Last active: 2h ago                              ││
│  │                                      [Talk]  [Configure →]  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Kill the constellation view.** Replace with Grid/Table toggle. Grid shows agent cards (like above). Table shows a clean sortable table for workspaces with many agents.

**Agent card shows:** Avatar (image if uploaded, else initials on color) + name + space membership + adapter type + status with live activity text + quick actions.

**Create Agent — Guided Multi-Step Flow:**

Inspired by the design reference screenshots. A clean modal with steps:

```
Step 1: Identity
  ┌──────────────────────────────────────────────────┐
  │  Create an agent                                  │
  │                                                  │
  │  [upload photo]  or auto-generate from name       │
  │                                                  │
  │  Name ___________________________________         │
  │  Description ____________________________         │
  │                                                  │
  │  Space  [Marketing ▾]  (optional)                │
  │                                                  │
  │                              [Cancel]  [Next →]  │
  └──────────────────────────────────────────────────┘

Step 2: Connection
  ┌──────────────────────────────────────────────────┐
  │  How should this agent think?                     │
  │                                                  │
  │  ┌───────────────┐  ┌───────────────┐            │
  │  │  OpenAI       │  │  Anthropic    │            │
  │  │  GPT-4o, etc  │  │  Claude, etc  │            │
  │  └───────────────┘  └───────────────┘            │
  │  ┌───────────────┐  ┌───────────────┐            │
  │  │  Custom       │  │  Gateway      │            │
  │  │  OpenAI-compat│  │  Self-hosted  │            │
  │  └───────────────┘  └───────────────┘            │
  │                                                  │
  │  Model ____________________________________       │
  │                                                  │
  │                         [← Back]  [Create →]     │
  └──────────────────────────────────────────────────┘
```

**No step 3.** Create the agent immediately. Instructions, memory, and advanced config happen on the agent detail page, not during creation. Keep the creation flow to ≤30 seconds.

**Agent Detail Page — Tab Restructure:**

```
/agents/:id
  [Overview]  [Instructions]  [Memory]  [Connections]  [History]

  Overview:     Status, current task, recent messages, key metrics
  Instructions: soul.md / agents.md style instruction files
                (pulled from the harness/agent, shown as they actually exist)
                Clean markdown editor with syntax highlighting
  Memory:       Agent-native memories (from the agent’s harness)
                + Platform memories (from Agentis interactions)
                Displayed as browsable cards with source, date, content
  Connections:  Adapter config, gateway pairing, channel links
  History:      Recent runs, conversations, activity for this agent
```

**What’s removed:**
- Playground tab (useless)
- Avatar glyph + color pickers (replaced by image upload with initials fallback)
- "Config" as a catch-all tab (broken into purpose-driven tabs)
- "Ledger" naming (use "History")

### 7.3 Workflows Page

**Current problems:** No grouping, chaotic tab reordering, terrible card design, no previews, unclear create flow, no auto-save, confusing subheader, broken subflows, node config is placeholder-quality, deploy/run unclear.

**Redesign — List View:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Workflows  5 workflows                        [+ New workflow]  │
├──────────────────────────────────────────────────────────────────┤
│  [All] [Active] [Scheduled] [Draft] [Broken]  [Search...]       │
├──────────────────────────────────────────────────────────────────┤
│  MARKETING (space)                                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ▶ Lead Enrichment          ⟳ Running · step 3/6 · 1m 14s  ││
│  │   Webhook trigger          Last: success 2h ago    [Open →] ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ● Daily Briefing           Idle · next run at 09:00        ││
│  │   Cron trigger             Last: success 6h ago    [Open →] ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  UNGROUPED                                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ✕ Weekly Digest            Failed · step 2 · yesterday     ││
│  │   Cron trigger             Last: failed 22h ago    [Retry]  ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ○ Draft: Slack notifier    Not published                   ││
│  │                            Created 3d ago          [Open →] ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

**Key changes:**
- Grouped by Space (with "Ungrouped" for unassigned)
- Status is the **first visual signal** — color-coded status indicators
- Last run result inline — success/failed/never
- Single-action affordance: `[Open]` for healthy, `[Retry]` for failed
- Cards show: name, trigger type, status, last run, timing info
- Tab order is **fixed** (creation order, not reorderable)

**Create New Workflow — Dual Path:**

```
┌──────────────────────────────────────────────────┐
│  New workflow                                     │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  ✨ Describe what it should do            │    │
│  │  "Monitor HN and email me a digest..."   │    │
│  │                                    [→]   │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  or                                              │
│                                                  │
│  [Start from scratch]   [Use a template →]       │
│                                                  │
└──────────────────────────────────────────────────┘
```

Prompt-first: opens canvas with the chat-in-canvas creation flow (§6.2 from UIUX-AND-ARCHITECTURE-UPDATES.md). Scratch: opens empty canvas. Template: opens template browser.

**Canvas Improvements:**
- **Auto-save** every 30 seconds. "Saved ·" indicator, dot when unsaved.
- **Minimap toggle** — off by default, toggle button in toolbar
- **Tab stability** — tabs maintain fixed creation order, never reorder
- **Node config** — proper form-based editing. No raw JSON by default. "View JSON" as an advanced toggle that IS editable.
- **Subflow support** — working dropdown to select which workflow to embed
- **Chat integration** — when opened, chat panel compresses main gracefully, never breaks layout
- **Clear toolbar:**

```
[← Workflows]  Workflow Name (editable)          [⟲] [⟳]  [Variables]  [Test run]  [Publish ▾]  [Saved ·]
```

- **"Publish" dropdown** explains options: Deploy to schedule, Deploy to webhook, Publish to library
- **"Test run" button** runs with current variables or opens a clean input form (not a confusing variable prompt)
- **Run input form:**

```
┌──────────────────────────────────────────────────┐
│  Test this workflow                               │
│                                                  │
│  The trigger expects these inputs:               │
│                                                  │
│  email  _____________________________________     │
│  name   _____________________________________     │
│                                                  │
│  Or leave empty to use defaults.                 │
│                                                  │
│                         [Cancel]  [Run →]        │
└──────────────────────────────────────────────────┘
```

### 7.4 Apps Page

**Current problems:** Gigantic cards with terrible UI. Detail view is an audit log, not an app experience. No result visualization. Feels like hacker infrastructure, not an app.

**Redesign — List View:**

Clean, compact cards showing operational state:

```
┌──────────────────────────────────────────────────────────────────┐
│  Apps  Your deployed AI applications                             │
├──────────────────────────────────────────────────────────────────┤
│  [All] [Active] [Setup needed] [Paused]        [Search apps...]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ ◈  Autonomous SDR    │  │ ◈  Content Pipeline  │             │
│  │    ● Active · v1.2   │  │    ● Active · v2.0   │             │
│  │    47 leads · 7d     │  │    12 posts · 7d     │             │
│  │    [Open →]          │  │    [Open →]          │             │
│  └──────────────────────┘  └──────────────────────┘             │
│                                                                  │
│  ┌──────────────────────┐                                       │
│  │ ◈  Legal Review      │                                       │
│  │    ⚠ Setup needed    │                                       │
│  │    Connect creds     │                                       │
│  │    [Continue setup]  │                                       │
│  └──────────────────────┘                                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**App Detail — Redesigned Tabs:**

```
/apps/:slug
  [Performance]  [Results UI]  [Configuration]  [Activity]

  Performance:    Stat bar + Needs Attention + Recent Runs
                  (per §21.4 of UIUX-AND-ARCHITECTURE-UPDATES.md)
  Results UI:     Visual representation of app output
                  (THIS IS THE MUST-HAVE FEATURE)
                  Each app type gets an appropriate UI:
                  - SDR app: lead table with status, score, actions
                  - Content app: preview cards of generated content
                  - Research app: summary reports with sources
                  - Custom: adaptive JSON → card renderer
  Configuration:  Workflows, agents, settings, output labels
  Activity:       Run history + audit log (the "power user" view)
```

**Results UI (§21.4 from user claimings — MUST HAVE):**

The killer insight from user feedback: apps should **show results as an app would**, not as a log viewer. An app on your phone shows you what you want to see. Agentis apps must do the same.

The Results UI tab auto-generates from the `outputLabels` schema:
- Numbers → metric cards with trend
- Lists → browsable, filterable tables
- Text → rendered documents
- Mixed → adaptive layout

When `outputLabels` are not configured, show a helpful prompt: "Configure output labels to unlock the Results UI."

### 7.5 Packages Page

**Current problems:** Machine-readable tables. Useless options. Delete without warning. Wrong icons for import/export. Shows templates instead of owned packages.

**Redesign:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Packages                                        [Import] [+ New]│
├──────────────────────────────────────────────────────────────────┤
│  [My Library] [Apps] [Skills] [Workflows] [Templates]            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐       │
│  │ ▣  SDR Pipeline         │  │ ▣  Content Templates    │       │
│  │    App · v1.2.0         │  │    Skill · v2.0.1       │       │
│  │    3 workflows, 2 agents│  │    5 templates          │       │
│  │    [Open]  [Export]  [···]│ │    [Open]  [Export]  [···]│     │
│  └─────────────────────────┘  └─────────────────────────┘       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Key changes:**
- **Default view: "My Library"** — shows what the user owns, not templates
- Card-based layout, not tables
- Fix import/export icons (import = arrow-down-to-tray, export = arrow-up-from-tray)
- `[···]` menu: Rename, Duplicate, Export, Delete
- **Delete requires confirmation** with 5-second undo toast
- Templates tab is a separate browse experience

### 7.6 Runs Page (When Accessed Directly)

**Current problems:** Made for machines. Debug console. No human-readable summary.

**Redesign — Dual Mode:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Run: Lead Enrichment  #9f3a2b                                   │
│  ✓ Completed  ·  1m 32s  ·  $0.03  ·  2h ago                    │
│                                            [Story]  [Technical]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STORY VIEW (default):                                           │
│                                                                  │
│  This workflow ran successfully in 1 minute 32 seconds.          │
│                                                                  │
│  What happened:                                                  │
│  1. Triggered manually                                           │
│  2. Fetched 52 leads from the source                            │
│  3. Enriched and evaluated 602 data points                      │
│  4. Qualified 47 leads (pass rate: 7.8%)                        │
│  5. Booked 1 meeting                                            │
│                                                                  │
│  Key results:                                                    │
│  ┌───────────┬──────────────┬───────────┬────────────┐          │
│  │ 47 Leads  │ 1 Meeting    │ 7.8% Pass │ $0.03 Cost │          │
│  │ Qualified │ Booked       │ Rate      │            │          │
│  └───────────┴──────────────┴───────────┴────────────┘          │
│                                                                  │
│  Timeline:                                                       │
│  ● trigger     ·  0ms                                            │
│  ✓ fetch_leads ·  440ms  ·  "52 leads fetched"                  │
│  ✓ enrichment  ·  58s    ·  "47 qualified, 555 rejected"        │
│  ✓ response    ·  2ms    ·  "1 meeting booked"                  │
│                                                                  │
│  Click any step to inspect its inputs and outputs.               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Technical view:** Same timeline but with raw I/O, block data, node IDs, JSON inspector — the full debug surface. Toggle between views with a clean toggle in the header.

### 7.7 History Page

**Current problems:** No detail modal, just useless log lines.

**Redesign:**

```
┌──────────────────────────────────────────────────────────────────┐
│  History                                                         │
├──────────────────────────────────────────────────────────────────┤
│  [All] [Workflow runs] [Agent activity] [Audit]                  │
│  [Search...]  [Date range ▾]  [Status ▾]  [Agent ▾]             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Today                                                           │
│  ├─ 11:42  ✓  thomas completed "Research task"       [View →]   │
│  ├─ 11:30  ✓  Lead Enrichment completed              [View →]   │
│  ├─ 11:15  ⚠  thomas sent approval request           [Review]   │
│  └─ 09:02  ✕  Weekly digest failed at step 3        [Retry]    │
│                                                                  │
│  Yesterday                                                       │
│  └─ ...                                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Click any row → detail panel slides in from the right.** Shows full event details: what happened, who was involved, inputs/outputs, duration, cost. This is the missing piece that makes History useful.

### 7.8 Workspaces Page

**Current problems:** Poor design. No image upload. Terrible creation flow.

**Redesign:**

```
┌──────────────────────────────────────────────────────────────────┐
│  Workspaces                                    [+ New workspace]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [logo/img]  Personal                        ● Active       ││
│  │              3 agents · 5 workflows · 2 apps                ││
│  │              Created May 2026                               ││
│  │                                    [Manage]  [Switch to]    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  [logo/img]  test02                          ○ Inactive     ││
│  │              1 agent · 2 workflows                          ││
│  │                                    [Manage]  [Switch to]    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Image upload:** Each workspace can have a logo/image. Shown in the header next to the workspace name. Click to upload or drag-and-drop on the workspace card.

**Create workspace:** Clean modal with name, slug (auto-generated), optional image upload, optional description. Not a complex form.

### 7.9 Settings Page

**Redesign tabs:**

```
/settings
  [Profile]  [Workspace]  [Connections]  [Security]

  Profile:      Display name, email, password change, avatar
  Workspace:    Name, slug, image, danger zone (delete)
  Connections:  Gateways + Channels unified
                - OpenClaw gateways with status
                - Telegram/Discord/Slack integrations
                - Each connection shows: type, status, connected agents
  Security:     API keys, JWT settings
```

**Theme toggle:** In the avatar menu AND in Profile settings. Shows correct current state. Switches immediately without refresh.

---

## 8. Humanization Layer

### 8.1 Natural Language Over Technical Jargon

| Before (Current) | After (Redesign) |
|---|---|
| `Checkpoint pending in workflow run ec8ff114-6db7-4ac5-b027-4ad0a7879066` | `Approval needed: "Enrich Alice Chen for ACME deal"` |
| `run_9f3a2b COMPLETED` | `Lead Enrichment completed successfully · 1m 32s` |
| `WAITING` status badge | `Waiting for your approval` with context |
| `agent_task_pollycrawl has no agentId bound` | `This workflow step needs an agent. Assign one to continue.` |
| `node.completed` event | `Finished processing leads (47 qualified)` |
| `MANUAL` source badge | *(removed — no badge for normal operator messages)* |

### 8.2 Progressive Disclosure Pattern

Every complex surface follows this pattern:

1. **Glance:** The card/row shows status + name + key metric. 2 seconds to understand.
2. **Read:** Click to expand or navigate. See description, timeline, actions. 10 seconds.
3. **Investigate:** Click deeper for I/O data, JSON, logs, technical details. As long as needed.

No surface starts at level 3. The default view is always level 1 or 2.

### 8.3 Smart Defaults

- New agent: pre-select the most common adapter type, pre-fill a helpful system prompt template
- New workflow: suggest prompt-first creation, not blank canvas
- New room: auto-suggest adding the workspace’s most active agent
- Run input: show example values as placeholders, use defaults when available
- Filters: default to "All" with smart sorting (active/failed first, completed last)
- Time ranges: default to "7 days" on all metric views

### 8.4 Contextual Guidance

- **First-time surfaces:** Show a single-line tip below the page title. Dismissible. Example: "Workflows are visual automations. Create one from a prompt or start from scratch."
- **Empty states:** Always suggest the next action with a primary CTA button.
- **Error states:** Explain what went wrong in plain language + offer a fix path. Never show only an error code.
- **Agent without adapter:** Show a prominent "Connect" button instead of failing silently.

### 8.5 Destructive Action Safety

Every destructive action (delete, remove, disconnect) follows this pattern:

1. Click delete → **Confirmation dialog** appears: "Delete [name]? This action cannot be undone."
2. For high-impact actions (workspace, agent): require typing the name to confirm
3. After confirmation → **5-second undo toast:** "Deleted [name]. [Undo]"
4. If undo clicked → restore immediately, show success toast

---

## 9. Implementation Priorities

### Phase 1 — Critical Fixes (Immediate)

These are broken things that actively hurt trust and usability:

| Priority | Change | Impact |
|---|---|---|
| P0 | Fix notification panel — opaque bg, human-readable text, inline actions | Users can’t act on notifications |
| P0 | Fix theme toggle — correct state detection, actual toggle in avatar menu | Trust-breaking bug |
| P0 | Fix Home status — honest greeting reflecting actual state | Platform lies to user |
| P0 | Fix chat workspace switching — context reloads on workspace change | Stale data |
| P0 | Delete confirmation on all destructive actions | Data safety |
| P0 | Fix import/export icons (swap them) | Trust erosion |

### Phase 2 — Navigation & Layout (High Impact)

| Priority | Change | Impact |
|---|---|---|
| P1 | Sidebar collapse to 5 items + Spaces | Reduces cognitive load 55% |
| P1 | Header redesign — avatar menu, notification bell | Professional, functional header |
| P1 | Consolidate routes — remove Runs/Activity/Approvals/Gateways/Conversations from nav | Cleaner architecture |
| P1 | Settings consolidation — Connections tab with Gateways + Channels | One place for connections |

### Phase 3 — Core Surface Redesign (High Impact)

| Priority | Change | Impact |
|---|---|---|
| P2 | Home page redesign — honest status, Perplexity-style chat, gradient transitions | First impression transformation |
| P2 | Agent creation — guided multi-step flow | Agent setup from terrifying to 30-second flow |
| P2 | Agent detail — restructured tabs (Instructions/Memory/Connections/History) | Agent management clarity |
| P2 | Kill constellation view, add Grid/Table toggle | Remove confusing feature |
| P2 | Workflow list — grouped by space, status-first cards | Workflow findability |
| P2 | Workflow canvas — auto-save, proper node config, working subflows | Builder reliability |

### Phase 4 — App Experience (Transformative)

| Priority | Change | Impact |
|---|---|---|
| P3 | App list — compact cards with metrics | Operational overview |
| P3 | App Performance tab — stat bar + attention items + run cards | Glass floor starts here |
| P3 | App Results UI — visual output display | **Must-have feature** |
| P3 | Run detail — Story mode + Technical mode | Human-readable run investigation |

### Phase 5 — Polish & Completeness

| Priority | Change | Impact |
|---|---|---|
| P4 | Packages — card layout, "My Library" default, fixed icons | Library experience |
| P4 | History — detail modal on row click | Usable audit trail |
| P4 | Workspaces — image upload, clean creation | Professional workspace management |
| P4 | Chat panel — full feature set (add agents, delete, edit, full page) | Chat as platform brain |
| P4 | All empty states — follow the pattern (icon + title + description + CTA) | No dead ends |
| P4 | All skeleton states — proper loading skeletons | Perceived performance |
| P4 | All destructive actions — confirmation + 5s undo toast | Safety net |

---

## 10. Final Vision

### What Agentis Will Feel Like After Transformation

**Landing on Home:**
You see a clean greeting that tells you the truth. 2 agents are working. 1 thing needs your approval. The chat bar invites you to command. You approve the pending request with one click, right there. You ask thomas for a status update. The response streams in. You’re done. 45 seconds.

**Building a workflow:**
You click "+ New workflow." A clean modal offers: describe it in words, start from scratch, or pick a template. You type "Monitor HN and email me a daily digest at 9am." An agent builds it on the canvas, node by node, with a progress log. You click "Test run." It works. You click "Publish → Deploy to schedule." Done. 3 minutes.

**Checking your SDR app:**
You open the SDR app. The Performance tab shows: 47 leads qualified, 3 meetings booked, 98% success rate, $1.24 cost. One approval is pending — you approve it inline. You click "47 leads" and see the run that produced them. You click a run to see the story: what happened, what it produced, how long each step took. You click the enrichment step to see exactly which leads were qualified and why. Every number is drillable. No dead ends.

**The emotional arc:**
- **Oriented.** The sidebar has 5 items. You know where everything is.
- **Capable.** You approved, commanded, investigated, and built — all without confusion.
- **Informed.** Every status is honest. Every metric is real. Every message is in language you understand.
- **Confident.** The interface is consistent, calm, and precise. It never surprises you. It never lies.
- **Impressed.** This feels like Linear, Vercel, and Perplexity had a baby that runs AI agents.

### The North Star Metric

**Time from login to "I know what’s happening and I’ve done what I need to":** under 60 seconds.

Today it’s probably 5–10 minutes of confused clicking. After this transformation, the operator lands, glances, acts, and moves on. The platform is invisible. The work is what matters.

---

## APPENDIX A — Exact Tailwind Configuration

The new `apps/web/tailwind.config.js` (drop-in replacement):

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas:           '#08090b',
        surface:          '#0f1014',
        'surface-2':      '#15171c',
        'surface-3':      '#1c1f26',
        line:             '#22262d',
        'line-strong':    '#2e333c',
        'text-primary':   '#e8eaee',
        'text-secondary': '#a1a8b3',
        'text-muted':     '#6b7280',
        'text-disabled':  '#3d4550',
        accent:           '#4ade80',
        'accent-hover':   '#22c55e',
        'accent-soft':    'rgba(74, 222, 128, 0.10)',
        'accent-muted':   'rgba(74, 222, 128, 0.25)',
        danger:           '#ef4444',
        'danger-soft':    'rgba(239, 68, 68, 0.10)',
        warn:             '#f59e0b',
        'warn-soft':      'rgba(245, 158, 11, 0.10)',
        info:             '#60a5fa',
        'info-soft':      'rgba(96, 165, 250, 0.10)',
        // Space colors
        'space-orange':   '#f97316',
        'space-blue':     '#3b82f6',
        'space-purple':   '#a855f7',
        'space-teal':     '#14b8a6',
        'space-rose':     '#f43f5e',
        'space-lime':     '#84cc16',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display':    ['24px', { lineHeight: '1.2',  fontWeight: '600' }],
        'heading':    ['18px', { lineHeight: '1.3',  fontWeight: '600' }],
        'subheading': ['14px', { lineHeight: '1.4',  fontWeight: '500' }],
        'body':       ['14px', { lineHeight: '1.5',  fontWeight: '400' }],
        'caption':    ['12px', { lineHeight: '1.5',  fontWeight: '400' }],
        'code':       ['13px', { lineHeight: '1.5',  fontWeight: '400' }],
      },
      spacing: {
        // Augment the 4px-based scale with gaps Tailwind doesn't name
        '4.5': '18px',
        '5.5': '22px',
        '7.5': '30px',
        '13':  '52px',
        '15':  '60px',
        '18':  '72px',
      },
      borderRadius: {
        'card':    '12px',
        'input':   '8px',
        'btn':     '8px',
        'pill':    '9999px',
        'modal':   '16px',
        'node':    '14px',
        'nav':     '8px',
      },
      boxShadow: {
        'card':     '0 1px 0 rgba(255,255,255,0.03) inset, 0 4px 16px rgba(0,0,0,0.4)',
        'dropdown': '0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        'modal':    '0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)',
        'glow':     '0 0 0 1px rgba(74,222,128,0.3), 0 0 20px rgba(74,222,128,0.15)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.4' },
        },
        'slide-in-right': {
          '0%':   { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-out-right': {
          '0%':   { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%':   { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'pulse-dot':       'pulse-dot 1.5s ease-in-out infinite',
        'slide-in-right':  'slide-in-right 250ms ease-out',
        'slide-out-right': 'slide-out-right 200ms ease-in',
        'fade-in':         'fade-in 150ms ease',
        'scale-in':        'scale-in 180ms ease-out',
      },
      transitionDuration: {
        '150': '150ms',
        '200': '200ms',
        '250': '250ms',
        '300': '300ms',
      },
    },
  },
  plugins: [],
};
```

---

## APPENDIX B — Complete Route Map (New App.tsx)

### Routes to implement:

```
/                           → redirect to /home
/home                       → HomePage (replaces FleetOverviewPage)
/agents                     → AgentsPage (redesigned — grid/table, no constellation)
/agents/:id                 → AgentDetailPage (redesigned tabs)
/workflows                  → WorkflowsPage (redesigned — grouped, status-first)
/workflows/:id              → WorkflowCanvasPage (enhanced — auto-save, proper config)
/apps                       → AppsPage (redesigned — compact cards, space grouping)
/apps/:slug                 → AppDetailPage (new — Performance/Results/Config/Activity tabs)
/packages                   → PackagesPage (redesigned — card layout, "My Library" default)
/history                    → HistoryPage (merges runs + activity + audit)
/runs/:id                   → RunDetailPage (redesigned — Story + Technical modes)
/chat                       → ChatPage (full-screen chat, ChatPanel suppressed)
/chat/agent/:agentId        → ChatPage (pre-selected agent)
/workspaces                 → WorkspacesPage (redesigned — image upload, clean creation)
/settings                   → SettingsPage (4 tabs: Profile/Workspace/Connections/Security)
/login                      → LoginPage (no shell)
*                           → redirect to /home
```

### Routes to REMOVE (and where their content moves):

| Old Route | Delete? | Content Moves To |
|---|---|---|
| `/fleet` | Yes — redirect to `/home` for back-compat | HomePage replaces FleetOverviewPage |
| `/runs` (list) | Yes | Merged into `/history` with filter tabs |
| `/activity` | Yes | Merged into `/history` |
| `/approvals` | Yes | Notification bell + Home "Needs Attention" |
| `/gateways` | Yes | `/settings` → Connections tab |
| `/conversations` | Yes | Chat panel + `/chat` full-page |
| `/conversations/:agentId` | Yes | `/chat/agent/:agentId` |
| `/settings/channels` | Yes | `/settings` → Connections tab |
| `/skills` | Yes | `/packages` → Skills filter tab |

### Redirect shims (backward compatibility for 1 release cycle):

```tsx
<Route path="/fleet" element={<Navigate to="/home" replace />} />
<Route path="/runs" element={<Navigate to="/history?tab=runs" replace />} />
<Route path="/activity" element={<Navigate to="/history?tab=activity" replace />} />
<Route path="/approvals" element={<Navigate to="/home" replace />} />
<Route path="/gateways" element={<Navigate to="/settings?tab=connections" replace />} />
<Route path="/conversations" element={<Navigate to="/chat" replace />} />
<Route path="/conversations/:agentId" element={<Navigate to="/chat/agent/:agentId" replace />} />
<Route path="/settings/channels" element={<Navigate to="/settings?tab=connections" replace />} />
<Route path="/skills" element={<Navigate to="/packages?tab=skills" replace />} />
```

---

## APPENDIX C — Component State Matrix

### C.1 Buttons

| Variant | Default | Hover | Active/Pressed | Focus | Disabled | Loading |
|---|---|---|---|---|---|---|
| **Primary** | bg-accent text-canvas | bg-accent-hover text-canvas | bg-accent-hover/90 scale(0.98) | ring-2 ring-accent-muted ring-offset-2 ring-offset-canvas | bg-accent/40 text-canvas/50 cursor-not-allowed | bg-accent text-canvas + spinner icon replacing left icon |
| **Secondary** | bg-surface-2 text-text-primary border-line | bg-surface-3 text-text-primary border-line-strong | bg-surface-3/90 scale(0.98) | ring-2 ring-accent-muted ring-offset-2 ring-offset-canvas | bg-surface-2/50 text-text-disabled border-line/50 cursor-not-allowed | same + spinner |
| **Ghost** | bg-transparent text-text-muted | bg-surface-2 text-text-primary | bg-surface-3 text-text-primary | ring-2 ring-accent-muted | text-text-disabled cursor-not-allowed | same + spinner |
| **Danger** | bg-danger-soft text-danger border-danger/20 | bg-danger/20 text-danger border-danger/30 | bg-danger/30 scale(0.98) | ring-2 ring-danger/40 ring-offset-2 ring-offset-canvas | bg-danger-soft/50 text-danger/40 cursor-not-allowed | same + spinner |
| **Pill** | bg-surface-2 text-text-secondary border-line rounded-pill | bg-surface-3 text-text-primary border-line-strong | bg-accent-soft text-accent border-accent-muted | ring-2 ring-accent-muted | bg-surface-2/50 text-text-disabled cursor-not-allowed | N/A |

All buttons: height 36px (standard) / 32px (compact) / 40px (large). Padding: 12px horizontal (16px for large). Transition: 150ms ease-out for all state changes. Min-width: 64px (prevents narrow buttons).

### C.2 Inputs

| State | Background | Border | Text | Placeholder |
|---|---|---|---|---|
| Default | surface-2 | 1px line | text-primary | text-muted |
| Hover | surface-2 | 1px line-strong | text-primary | text-muted |
| Focus | surface-2 | 1px accent | text-primary | text-muted/50 (fades) |
| Filled | surface-2 | 1px line | text-primary | (hidden) |
| Error | surface-2 | 1px danger | text-primary | text-muted |
| Disabled | surface/50 | 1px line/50 | text-disabled | text-disabled |

Error state: red border + caption-sized error message below input in `text-danger`. Error message uses `animate-fade-in`.

### C.3 Cards

| State | Background | Border | Shadow |
|---|---|---|---|
| Default | surface | 1px line | none |
| Hover | surface-2 | 1px line-strong | shadow-card (subtle) |
| Selected/Active | surface-2 | 1px accent-muted + left 2px accent | shadow-card |
| Disabled | surface/50 | 1px line/50 | none |

### C.4 Nav Items (Sidebar)

| State | Background | Text | Icon | Left Bar |
|---|---|---|---|---|
| Default | transparent | text-muted | text-muted | none |
| Hover | surface-2 | text-primary | text-primary | none |
| Active | surface-2 | text-primary | accent | 2px accent bar, rounded-r |
| Badge present | (any of above) | (any) | (any) | + colored badge pill right-aligned |

### C.5 Status Badges

| Status | Dot | Background | Text | Animation |
|---|---|---|---|---|
| Running / Live | accent | accent-soft | accent | dot pulses (1.5s) |
| Completed | accent (static) | accent-soft | accent | none |
| Failed | danger | danger-soft | danger | none |
| Pending / Waiting | warn | warn-soft | warn | dot pulses (2s) |
| Draft / Idle | text-muted | surface-2 | text-muted | none |
| Paused | text-disabled | surface-2 | text-disabled | none |

### C.6 Tabs

| State | Background | Text | Border | |
|---|---|---|---|---|
| Inactive | transparent | text-muted | none | |
| Hover | transparent | text-primary | none | |
| Active | transparent | text-primary | bottom 2px accent | |
| Disabled | transparent | text-disabled | none | cursor-not-allowed |

Tab bar: bottom border `1px line` full width. Active tab indicator is `2px accent` bottom border. Transition: indicator slides with 200ms ease-out.

---

## APPENDIX D — Icon Map

### D.1 Navigation Icons (Lucide)

| Nav Item | Lucide Icon | Size | Notes |
|---|---|---|---|
| Home | `Home` | 16px | Replaces `LayoutDashboard` |
| Agents | `Bot` | 16px | Keep |
| Workflows | `Workflow` | 16px | Keep |
| Apps | `AppWindow` | 16px | New — replaces grid icon |
| Packages | `Package` | 16px | New |
| Settings | `Settings` | 16px | Keep |
| Collapse button | `ChevronsLeft` / `ChevronsRight` | 14px | Keep |

### D.2 Header Icons

| Element | Lucide Icon | Size |
|---|---|---|
| Notification bell | `Bell` | 16px |
| Search/Command | `Search` | 12px |
| Theme toggle (dark) | `Moon` | 14px |
| Theme toggle (light) | `Sun` | 14px |
| Avatar menu | (user avatar image or initials) | 28px circle |

### D.3 Action Icons

| Action | Lucide Icon | Size | Context |
|---|---|---|---|
| Create/Add | `Plus` | 16px | All "new" buttons |
| Edit | `Pencil` | 14px | Inline edit triggers |
| Delete | `Trash2` | 14px | Destructive actions (always with confirm) |
| More actions | `MoreHorizontal` | 16px | Overflow menus `[···]` |
| Close | `X` | 16px | Panels, modals, dismissibles |
| Back | `ArrowLeft` | 16px | Navigation back |
| External link | `ExternalLink` | 14px | Opens new tab |
| Download | `Download` | 14px | File export |
| Upload/Import | `Upload` | 14px | File import (FIX: currently swapped!) |
| Export | `Share` or `ArrowUpFromLine` | 14px | Package export |
| Import | `ArrowDownToLine` | 14px | Package import |
| Copy | `Copy` | 14px | Copy to clipboard |
| Refresh | `RefreshCw` | 14px | Manual refresh |
| Filter | `Filter` | 14px | Filter controls |
| Search | `Search` | 14px | Search inputs |
| Send | `Send` | 16px | Chat send button |
| Approve | `Check` | 16px | Approval actions |
| Reject | `X` | 16px | Rejection actions |
| Retry | `RotateCcw` | 14px | Failed run retry |
| View/Open | `Eye` | 14px | View details |
| Expand | `ChevronDown` | 14px | Expandable sections |
| Collapse | `ChevronUp` | 14px | Collapsible sections |

### D.4 Status Icons

| Status | Lucide Icon | Color |
|---|---|---|
| Running | `Loader2` (animated spin) | accent |
| Completed | `CheckCircle2` | accent |
| Failed | `XCircle` | danger |
| Pending | `Clock` | warn |
| Draft | `Circle` (outline) | text-muted |
| Paused | `PauseCircle` | text-disabled |
| Idle | `MinusCircle` | text-muted |

### D.5 Empty State Icons

All empty state icons use size 48px, color `text-muted`.

| Page | Lucide Icon |
|---|---|
| No workflows | `Workflow` |
| No agents | `Bot` |
| No apps | `AppWindow` |
| No packages | `Package` |
| No runs/history | `Clock` |
| No notifications | `Bell` |
| No results | `SearchX` |
| No artifacts | `Layers` |
| No spaces | `FolderOpen` |

---

## APPENDIX E — Animation & Transition Spec

| Component / Interaction | Duration | Easing | Property | Details |
|---|---|---|---|---|
| Sidebar expand/collapse | 150ms | ease-out | width | 56px ↔ 224px |
| Panel slide in (right) | 250ms | ease-out | transform | translateX(100%) → 0 |
| Panel slide out (right) | 200ms | ease-in | transform | 0 → translateX(100%) |
| Modal open | 180ms | ease-out | opacity, transform | scale(0.96) → 1 + fade |
| Modal close | 150ms | ease-in | opacity, transform | 1 → scale(0.96) + fade |
| Dropdown open | 120ms | ease-out | opacity, transform | translateY(-4px) → 0 + fade |
| Dropdown close | 100ms | ease-in | opacity | fade out |
| Toast enter | 200ms | ease-out | transform, opacity | translateY(16px) → 0 + fade |
| Toast exit | 150ms | ease-in | transform, opacity | 0 → translateY(-8px) + fade |
| Button hover | 150ms | ease-out | background, color, border | color transitions |
| Button press | 100ms | ease-out | transform | scale(0.98) |
| Card hover | 150ms | ease-out | background, border, shadow | surface → surface-2 |
| Tab indicator slide | 200ms | ease-out | left, width | indicator position |
| Badge count change | 200ms | ease-out | transform | scale(1.2) → 1 (bounce) |
| Status dot pulse | 1500ms | ease-in-out | opacity | 1 → 0.4 → 1 (infinite) |
| Pending dot pulse | 2000ms | ease-in-out | opacity | 1 → 0.4 → 1 (infinite) |
| Skeleton shimmer | 1500ms | ease-in-out | background-position | -200% → 200% (infinite) |
| Progress bar fill | 300ms | ease-out | width | 0% → N% |
| Notification bell ring | 300ms | ease-out | transform | rotate(-15deg → 15deg → 0) |
| Live strip show | 200ms | ease-out | height, opacity | 0 → 28px + fade |
| Live strip hide | 200ms | ease-in | height, opacity | 28px → 0 + fade |
| Typewriter text | 40ms/char | linear | — | Character-by-character reveal |
| Auto-save indicator | 2000ms | — | opacity | "Saving..." → "Saved ·" fade transition |

**Performance rules:**
- All animations use CSS transitions or `@motionone/dom` (2KB). Never Framer Motion (31KB).
- Canvas overlays (agent presence, 20+ events/sec): `useRef` + `element.style.transform` via `requestAnimationFrame`. Never React state.
- Never animate layout properties (`width`, `height`) on elements with many children — use `transform` instead.
- `will-change` only on actively animating elements, removed after animation completes.
- Respect `prefers-reduced-motion: reduce` — skip all non-essential animations.

---

## APPENDIX F — Z-Index System

| Layer | z-index | Elements |
|---|---|---|
| Base content | 0 | Page content, cards, tables |
| Sticky elements | 10 | Sticky headers, tab bars |
| Sidebar | 20 | Sidebar rail (always visible) |
| Live strip | 25 | Bottom live-run bar |
| Floating panels | 30 | ChatPanel (floating mode), detail panels |
| Docked panels | 30 | ChatPanel (docked mode), artifact panel |
| Dropdowns | 40 | Notification bell panel, recipient picker, context menus |
| Command palette | 50 | ⌘K palette overlay |
| Modals | 60 | All modal dialogs, confirm dialogs |
| Modal overlay | 59 | Dark overlay behind modals |
| Toast notifications | 70 | Toast stack (top-right) |
| Tooltip | 80 | Hover tooltips |

**Rule:** Never use arbitrary z-index values. Every layer must be in this table. New components must use one of these levels.

---

## APPENDIX G — Keyboard Shortcuts

### G.1 Global (Available everywhere)

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open command palette |
| `⌘/` / `Ctrl+/` | Toggle chat panel |
| `⌘B` / `Ctrl+B` | Toggle sidebar collapse |
| `Escape` | Close topmost overlay (modal > dropdown > panel > palette) |
| `⌘.` / `Ctrl+.` | Open notification bell panel |

### G.2 Navigation

| Shortcut | Action |
|---|---|
| `G then H` | Go to Home |
| `G then A` | Go to Agents |
| `G then W` | Go to Workflows |
| `G then P` | Go to Apps |
| `G then K` | Go to Packages |
| `G then S` | Go to Settings |
| `G then I` | Go to History |

### G.3 Page-specific

| Context | Shortcut | Action |
|---|---|---|
| Agents list | `C` | Create new agent |
| Workflows list | `C` | Create new workflow |
| Workflow canvas | `⌘S` / `Ctrl+S` | Force save (auto-save is on, but manual trigger) |
| Workflow canvas | `⌘Z` / `Ctrl+Z` | Undo |
| Workflow canvas | `⌘⇧Z` / `Ctrl+Shift+Z` | Redo |
| Workflow canvas | `Delete` / `Backspace` | Delete selected node/edge |
| Any list page | `/` | Focus search input |
| Any list page | `F` | Toggle filter panel |
| Chat composer | `Enter` | Send message |
| Chat composer | `Shift+Enter` | New line |
| Chat composer | `↑` | Edit last sent message |
| Chat composer | `Escape` | Close suggestions/autocomplete |
| Modal | `Enter` | Confirm (when confirm button is focused) |
| Modal | `Escape` | Cancel/close |
| Confirm dialog | `Enter` | Confirm |
| Confirm dialog | `Escape` | Cancel |

---

## APPENDIX H — Toast Notification Spec

### H.1 Position & Stacking

- Position: top-right, 16px from viewport edge
- Max visible: 3 toasts. Additional queue behind.
- Stack direction: downward (newest on top)
- Width: 360px max, min-content width

### H.2 Toast Types

| Type | Left Accent | Icon | Duration |
|---|---|---|---|
| Success | accent (green) | `CheckCircle2` | 3000ms auto-dismiss |
| Error | danger (red) | `XCircle` | 5000ms auto-dismiss (or manual) |
| Warning | warn (amber) | `AlertTriangle` | 4000ms auto-dismiss |
| Info | info (blue) | `Info` | 3000ms auto-dismiss |
| Undo | accent (green) | `Undo2` | 5000ms (with undo CTA) |

### H.3 Toast Anatomy

```
┌── 4px left accent bar ──────────────────────────────┐
│  [icon]  Title text (subheading)            [× close]│
│          Description text (caption, text-muted)      │
│          [Undo] (only for undo-type)                 │
└──────────────────────────────────────────────────────┘
```

Background: `surface`. Border: `1px line`. Shadow: `dropdown`. Radius: `12px`.

Enter: `animate-slide-in-right` (from right edge). Exit: fade out + slide right.

### H.4 Undo Toast Pattern (Destructive Actions)

1. User clicks "Delete"
2. Confirm dialog: "Delete [name]? This cannot be undone."
3. User confirms → item is soft-deleted immediately
4. Undo toast appears: "Deleted [name]. [Undo]" — 5 second countdown
5. If "Undo" clicked → restore immediately, show success toast "Restored [name]"
6. If toast expires → hard delete fires

---

## APPENDIX I — Form Validation Patterns

### I.1 Validation Timing

| Context | When to validate |
|---|---|
| Required fields | On blur (first time) + on change (after first error) |
| Format validation (email, URL) | On blur |
| Async validation (slug uniqueness) | On blur + 300ms debounce |
| Submit | Validate all fields, scroll to first error |

### I.2 Error Display

- **Per-field:** 12px `text-danger` below the input. Input border changes to `danger`. Error appears with `animate-fade-in`.
- **Form-level:** Danger-toned banner at top of form: `bg-danger-soft border-danger/20 text-danger`.
- **Toast:** Only for server-side errors that can't be attributed to a specific field.

### I.3 Validation States

```
Default:      [input border-line]
              (no message)

Error:        [input border-danger]
              ✕ This field is required.

Success:      [input border-accent]   (only on async validation, e.g. "Slug available")
              ✓ Available

Validating:   [input border-line] + small spinner right side
              Checking...
```

---

## APPENDIX J — Real-Time Event → UI Mapping

### J.1 Socket.IO Events That Drive UI

| Event | UI Element Updated | Update Behavior |
|---|---|---|
| `approval.requested` | Sidebar badge (was: Approvals) → now: notification bell badge | Badge count increments |
| `approval.requested` | Home "Needs Attention" section | New approval card appears with slide-in |
| `approval.requested` | Notification bell panel | New item at top |
| `approval.resolved` | All approval surfaces | Card removed with fade-out, badge decrements |
| `run.created` | Workflows sidebar badge | Badge count increments |
| `run.running` | Home "Live Right Now" section | New run card or update existing |
| `run.running` | Live strip (bottom bar) | New run row or update progress |
| `run.completed` | All run-related surfaces | Status badge → Completed, remove from live |
| `run.failed` | Home "Needs Attention" | Failed run card appears |
| `run.failed` | Notification bell | New failure notification |
| `gateway.connected` | Settings > Connections | Status badge → connected (green) |
| `gateway.degraded` | Settings > Connections | Status badge → degraded (amber) |
| `gateway.disconnected` | Settings > Connections | Status badge → disconnected (red) |
| `agent.*` (presence) | Agent cards, sidebar badges | Live status updates |
| `AGENT_WORK_STEP` | Home "Live Right Now" | Step text updates (typewriter) |
| `CANVAS_NODE_PLACED` | Canvas (if viewing) | Node appears with placing animation |
| `CANVAS_BUILD_COMPLETE` | Canvas + chat thread | Build complete state |

### J.2 Badge Computation

| Badge | Location | Computation | Color |
|---|---|---|---|
| Notification bell | Header | `pending_approvals + failed_runs_1h + unread_mentions` | danger (red dot) if > 0 |
| Agents live count | Sidebar | Count of agents with presence status `running` or `active` | accent text |
| Workflows active | Sidebar | Count of runs with status `running` or `pending` | accent text |

---

## APPENDIX K — Error, Loading & Empty States Per Page

### K.1 Loading States (Skeleton Patterns)

| Page | Skeleton Pattern |
|---|---|
| Home | Greeting text block + chat input skeleton + 3 activity card outlines |
| Agents | 2×2 grid of card outlines: circle (avatar) + 2 text lines + badge |
| Agent detail | Left: large avatar circle + 3 text lines. Right: tab bar + 4 section blocks |
| Workflows | 4 row outlines: dot + title line + status badge + action |
| Workflow canvas | Gray node shapes at approximate positions (use cached graph if available) |
| Apps | 2×2 card grid: icon circle + title + metric line + badge |
| App detail | Stat bar: 4 metric blocks. Below: 3 run card outlines |
| Packages | 2×2 card grid: icon + title + 2 metadata lines |
| History | 6 row outlines: timestamp + icon + title + action |
| Run detail | Header block + timeline: 4 node rows with progress bars |
| Settings | Form skeleton: 4 label-input pairs |
| Workspaces | 2 large card outlines: logo circle + title + metadata |

**Rule:** Skeleton minimum display: 150ms (prevent flash). Transition: `animate-fade-in` (100ms).

Skeleton color: `surface-2` base with `surface-3` shimmer. Shimmer animation: 1500ms ease-in-out infinite.

### K.2 Error States

| Scenario | Display | Actions |
|---|---|---|
| API request failed (network) | Inline error banner: "Couldn't load [resource]. Check your connection." | [Retry] button |
| API request failed (server 500) | Inline error banner: "Something went wrong. Our team has been notified." | [Retry] button |
| API request failed (403) | Inline error banner: "You don't have access to this resource." | [Go Home] button |
| API request failed (404) | Inline error banner: "[Resource] not found." | [Go back] button |
| WebSocket disconnected | Persistent subtle banner at top: "Live updates paused. Reconnecting…" + spinner | Auto-reconnect (exponential backoff) |
| WebSocket reconnected | Banner dismisses. Brief success toast: "Connected" | Auto-dismiss 2s |

**Error banner anatomy:**

```
┌── bg-danger-soft border-danger/20 rounded-card p-4 ──────────────────┐
│  [XCircle icon danger]  Error title (subheading)                      │
│                         Description (body, text-secondary)            │
│                         [Retry]  [Go back]                            │
└──────────────────────────────────────────────────────────────────────┘
```

### K.3 Empty States (Complete Per-Page Spec)

| Page / Section | Icon (48px, text-muted) | Title | Description | CTA |
|---|---|---|---|---|
| Home "Needs Attention" | (section hidden) | — | — | — |
| Home "Live Right Now" | `Zap` | No active runs | Your agents are idle. Start a workflow or ask an agent to do something. | [Create workflow] |
| Home "Recently Built" | `Layers` | Nothing built yet | Your agents haven't built anything yet. Try asking one to create something. | [Ask an agent] |
| Agents (empty) | `Bot` | No agents yet | Create your first agent to start automating work. | [+ Add agent] |
| Agents (filtered, no results) | `SearchX` | No matching agents | Try adjusting your search or filters. | [Clear filters] |
| Workflows (empty) | `Workflow` | No workflows yet | Workflows are visual automations that chain AI tasks together. | [+ New workflow] |
| Workflows (filtered) | `SearchX` | No matching workflows | Try adjusting your search or filters. | [Clear filters] |
| Canvas (empty) | `MessageSquare` | Describe what this workflow should do | Your agent will build it for you, step by step. | (in-canvas chat input) |
| Apps (empty) | `AppWindow` | No apps yet | Install an app from Packages or create one from a workflow. | [Browse Packages] |
| App Performance (no runs) | `BarChart3` | No runs this period | This app hasn't been triggered yet. | [Run now] (if entry workflow exists) |
| App Results UI (no labels) | `Tag` | No output labels configured | Configure output labels on this app's workflow to track business metrics. | [Configure →] |
| Packages (empty) | `Package` | Your library is empty | Save agents, workflows, or skills as reusable packages. | [+ New package] |
| History (empty) | `Clock` | No history yet | Workflows you run will appear here with full details. | [View workflows] |
| History (filtered) | `SearchX` | No matching events | Try adjusting your date range, status, or agent filters. | [Clear filters] |
| Chat (no threads) | `MessageCircle` | No conversations yet | Start a conversation with an agent or create a room. | [+ New room] |
| Chat thread (no messages) | — | Send a message to start a conversation with [agent name]. | (no icon, just text above composer) | — |
| Chat thread (unanswered) | — | [agent name] hasn't responded yet. | (subtle text below last message) | — |
| Notifications (none) | `Bell` | All caught up | Nothing needs your attention right now. | — |
| Spaces (none) | (section hidden entirely in sidebar) | — | — | — |
| Settings > Connections (none) | `Plug` | No connections configured | Connect an OpenClaw gateway or messaging integration to bring agents online. | [+ Add connection] |
| Workspaces (only current) | — | (not empty — there's always at least one workspace) | — | — |

---

## APPENDIX L — Accessibility Requirements

### L.1 WCAG AA Compliance Targets

| Requirement | Target | Implementation |
|---|---|---|
| Color contrast (text) | 4.5:1 minimum (AA) | All text-on-bg combinations verified against dark backgrounds |
| Color contrast (large text) | 3:1 minimum | Headings (18px+) verified |
| Color contrast (interactive) | 3:1 minimum | All buttons, links, controls |
| Focus indicators | Visible, 2px minimum | `ring-2 ring-accent-muted ring-offset-2 ring-offset-canvas` |
| Keyboard navigation | Full tab-order | Every interactive element reachable via Tab |
| Screen reader support | ARIA labels | All icons-only buttons have `aria-label` |
| Reduced motion | Respect preference | `prefers-reduced-motion: reduce` → skip all non-essential animation |
| Touch targets | 36px minimum | All clickable areas ≥ 36×36px |

### L.2 ARIA Patterns

| Component | ARIA Role | Key Attributes |
|---|---|---|
| Sidebar | `navigation` | `aria-label="Main navigation"` |
| Sidebar item | `link` (via NavLink) | `aria-current="page"` when active |
| Modal | `dialog` | `aria-modal="true"`, `aria-labelledby` pointing to title |
| Confirm dialog | `alertdialog` | `aria-modal="true"`, `aria-describedby` pointing to message |
| Toast | `alert` | `role="alert"`, `aria-live="polite"` (or `"assertive"` for errors) |
| Dropdown menu | `menu` | `aria-expanded`, items as `menuitem` |
| Tab bar | `tablist` | Tabs as `tab`, panels as `tabpanel`, `aria-selected` |
| Badge | — | `aria-label="N pending approvals"` (not just the number) |
| Command palette | `combobox` | `aria-expanded`, `aria-activedescendant` |
| Status dot | — | `aria-label` with readable status (not just color) |
| Progress bar | `progressbar` | `aria-valuenow`, `aria-valuemin`, `aria-valuemax` |
| Icon-only button | — | `aria-label` always required (e.g., `aria-label="Close panel"`) |

### L.3 Focus Management

| Interaction | Focus Behavior |
|---|---|
| Modal opens | Focus moves to first interactive element inside modal |
| Modal closes | Focus returns to the element that triggered it |
| Dropdown opens | Focus moves to first item |
| Dropdown closes | Focus returns to trigger |
| Panel slides in | Focus moves to panel close button |
| Panel slides out | Focus returns to trigger |
| Toast appears | No focus change (they are non-modal) |
| Page navigation | Focus moves to main content area `<h1>` |
| Error on submit | Focus moves to first error field |

---

## APPENDIX M — Scrollbar & Overflow Behavior

### M.1 Custom Scrollbar (Dark Theme)

```css
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb {
  background: #2e333c;     /* line-strong */
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background: #3d4550; }
::-webkit-scrollbar-track { background: transparent; }

/* Firefox */
* { scrollbar-width: thin; scrollbar-color: #2e333c transparent; }
```

### M.2 Scroll Shadows

When content overflows in a container (panels, sidebars, modals), show subtle gradient shadows at scroll boundaries:

```css
.scroll-shadow-top    { box-shadow: inset 0  12px 8px -8px rgba(0,0,0,0.3); }
.scroll-shadow-bottom { box-shadow: inset 0 -12px 8px -8px rgba(0,0,0,0.3); }
```

Apply via scroll position detection (IntersectionObserver on sentinel elements at top/bottom).

### M.3 Overflow Rules

| Container | Overflow | Behavior |
|---|---|---|
| Main content area | `overflow-y: auto` | Scroll within main, header/sidebar fixed |
| Sidebar nav | `overflow-y: auto` | Scrolls independently if nav items exceed height |
| Chat panel | `overflow-y: auto` on message list, fixed composer at bottom | Messages scroll, input stays |
| Modal body | `overflow-y: auto` if content > 80vh | Header/footer fixed, body scrolls |
| Tables | `overflow-x: auto` on wrapper | Horizontal scroll on narrow viewports |
| Dropdowns | `max-height: 320px; overflow-y: auto` | Scroll within dropdown |
| Command palette results | `max-height: 400px; overflow-y: auto` | Scroll results |

---

## APPENDIX N — Chat Panel Full Spec

> This section details the complete chat panel behavior, augmenting and superseding the chat sections in UIUX-AND-ARCHITECTURE-UPDATES.md.

### N.1 Panel States

| State | Width | Trigger | Main Content Impact |
|---|---|---|---|
| Hidden | 0px | Default. Also when on `/chat` route. | Full width |
| Floating | 360px | User clicks Chat button in header | Panel overlays content (no compression) |
| Docked | 480px | User clicks pin/dock button | Main content compresses. Sidebar auto-collapses to icon rail. |

Persist state in `localStorage: agentis.chatPanel.state` (`hidden` | `floating` | `docked`).

### N.2 Panel Anatomy

```
┌──────────────────────────────────────────────────┐
│  Chat                      [📌 dock]  [× close]  │
├──────────────────────────────────────────────────┤
│  [+ New room]          [🕐 Session history]      │
│                                                  │
│  ROOMS                                           │
│  ● General                               3 new   │
│  💬 Marketing (auto)                              │
│                                                  │
│  DIRECT                                          │
│  ◎ thomas                        ● online        │
│  ◎ shoulder                      ○ offline       │
│                                                  │
│  📢 Fleet broadcast                              │
├──────────────────────────────────────────────────┤
│                                                  │
│  [Thread view when agent/room selected]          │
│  Messages scroll here                            │
│                                                  │
│  ●●● thomas is typing                           │
│                                                  │
├──────────────────────────────────────────────────┤
│  [viewport awareness pill, if active]            │
│  ┌──────────────────────────────────────────┐   │
│  │  Message... / for commands  @ for agents  │   │
│  │                                    [→]   │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### N.3 Room Creation Flow

When user clicks `[+ New room]`:

```
┌──────────────────────────────────────────────────┐
│  Create a room                                    │
│                                                  │
│  Name ___________________________________         │
│                                                  │
│  Add agents (optional)                           │
│  [thomas ×]  [+ Add agent ▾]                     │
│                                                  │
│                         [Cancel]  [Create →]     │
└──────────────────────────────────────────────────┘
```

**Key fix:** Rooms now support adding agents at creation time. The agent picker is a dropdown showing all workspace agents.

### N.4 Message Actions

Each message on hover reveals action icons:

| Action | Icon | Behavior |
|---|---|---|
| Edit | `Pencil` | Inline edit mode — message becomes editable text area |
| Delete | `Trash2` | Confirm dialog → 5s undo toast |
| Copy | `Copy` | Copy message text to clipboard, success toast |
| Reply | `Reply` | Composer pre-fills with quoted message |

### N.5 Composer Features

- **Text area:** Minimum height 40px, auto-grows to max 120px as user types
- **Recipient awareness:** Shows current room/agent name as context
- **Slash commands:** Type `/` → autocomplete popover
- **Agent mentions:** Type `@` → agent picker
- **Resource refs:** Type `#` → workflow/run picker
- **URL paste:** Shows suggestion row below: "Research / Analyze / Import"
- **File drop:** Shows "What should I do with this?" prompt
- **Send:** `Enter` = send, `Shift+Enter` = newline
- **Agent without adapter:** When composing to an unconnected agent, show banner: "This agent has no connection. [Connect →]" — the button navigates to agent settings.

### N.6 Workspace Switch Behavior

**Fix:** When the operator switches workspace via the header dropdown:
1. Chat panel resets to the room list for the new workspace
2. Any open thread is closed
3. Rooms and agents reload from the new workspace context
4. No stale data from previous workspace persists

This requires the ChatPanel to observe workspace changes (via Zustand store subscription on `workspaceId`) and trigger a full re-fetch of rooms + threads.

### N.7 Full-Page Chat (`/chat`)

When navigating to `/chat`:
- The `Shell` suppresses the `ChatPanel` component (no duplicate rendering)
- Full page width is used for chat
- Same thread list + thread view layout, just wider
- `/chat/agent/:agentId` pre-selects the agent thread

---

## APPENDIX O — Workflow Canvas Detail Spec

> Augments canvas specs from UIUX-AND-ARCHITECTURE-UPDATES.md §6.

### O.1 Node Visual Language

| Node Type | Shape | Border Accent | Icon | Size |
|---|---|---|---|---|
| Trigger | Rounded pill (16px radius) | accent (green) | Source-specific: `Webhook`, `Clock`, `Mail` | 140×56px |
| Action | Rectangle (14px radius) | none (line border) | Bold action icon | 160×64px |
| Condition / Router | Diamond-rotated or angled | warn (amber) | `GitBranch` | 140×64px |
| Skill / AI | Rectangle (14px radius) | info (blue) | `Sparkles` | 160×64px |
| Agent Task | Rectangle with avatar (14px radius) | purple `#a855f7` | Agent avatar | 180×72px |
| Subflow | Rectangle with nested icon (14px radius) | teal `#14b8a6` | `Workflow` (nested) | 160×64px |
| Response / End | Rounded pill (16px radius) | text-muted | `Flag` | 120×48px |

### O.2 Node Config Panel

When a node is selected on the canvas, the config panel opens on the right side:

```
┌──────────────────────────────────────────────────┐
│  Node: Email Notification              [× close] │
│  Type: Action                                     │
├──────────────────────────────────────────────────┤
│  [Configure]  [I/O]  [History]                    │
├──────────────────────────────────────────────────┤
│                                                  │
│  CONFIGURE TAB:                                  │
│                                                  │
│  Title _____________________________________      │
│                                                  │
│  Recipient                                       │
│  [Dynamic ▾]  {{ trigger.email }}                │
│                                                  │
│  Subject                                         │
│  [Static ▾]   Weekly Digest                      │
│                                                  │
│  Body                                            │
│  [Dynamic ▾]  {{ enrichment.summary }}           │
│                                                  │
│  ── Advanced ──────────────────────────────────  │
│  [View as JSON]  ← toggle to raw JSON editor     │
│                                                  │
│                              [Apply changes]     │
└──────────────────────────────────────────────────┘
```

**Key fix:** Config uses **form-based editing by default** with labeled fields, dropdowns for input type (static/dynamic), and template syntax highlighting. Raw JSON is available as a toggle under "Advanced" — and when toggled, the JSON IS editable (currently it's read-only, which is broken).

### O.3 Auto-Save

- Trigger: 30 seconds after last change, or on blur/navigation
- Indicator: "Saved ·" in toolbar (muted text). When unsaved: "Unsaved ·" with amber dot
- `⌘S` / `Ctrl+S`: force save immediately
- On error: "Save failed. [Retry]" toast
- Debounced: rapid changes restart the 30s timer

### O.4 Subflow Support

When adding a "Subflow" node:
1. A dropdown appears listing all other workflows in the workspace
2. Selecting one embeds it as a subflow node
3. The node shows the subflow name + a mini preview of its steps
4. Click to expand opens the subflow canvas in a new tab

---

## APPENDIX P — Relationship to UIUX-AND-ARCHITECTURE-UPDATES.md

This spec (UIUX-REPLAN.md) is the **governing document** for all UI/UX decisions. When there is a conflict, this document wins.

### What carries over from UIUX-AND-ARCHITECTURE-UPDATES.md:

| Section | Status | Notes |
|---|---|---|
| §0 North Star | ✅ Carries over | Mental model unchanged |
| §0.2 Vocabulary | ✅ Carries over | "operator", "run", "artifact", "room", "thread", "environment", "history" (not "ledger") |
| §1 Emergency Fixes | ✅ Carries over | Any unfixed items remain valid |
| §2 Shell Architecture | ⚠️ Modified | 3-zone layout valid, but sidebar items and header details per this doc |
| §3 Route Map | ❌ Superseded | Use Appendix B of this doc |
| §4 Home Page | ⚠️ Modified | Launcher concept valid, visual treatment per this doc |
| §5 Chat & Rooms | ⚠️ Modified | Room types valid, panel behavior per Appendix N |
| §6 Canvas | ⚠️ Modified | Agent-assisted creation valid, node visuals per Appendix O |
| §7 Live Strip | ✅ Carries over | Implementation unchanged |
| §8 Artifact System | ✅ Carries over | Panel states, reveal behavior, gallery all valid |
| §9 Viewport Context | ✅ Carries over | Awareness pill, placeholder text, signals all valid |
| §10 Home Ops View | ⚠️ Modified | Content valid, visual treatment per §7.1 of this doc |
| §11 Agents Page | ❌ Superseded | Use §7.2 of this doc |
| §12 Settings | ⚠️ Modified | Tab structure per §7.9 of this doc |
| §13 History Page | ⚠️ Modified | Layout per §7.7 of this doc (adds detail panel) |
| §14 Empty States | ❌ Superseded | Use Appendix K of this doc |
| §15 Loading/Skeleton | ⚠️ Modified | Per-page skeletons per Appendix K |
| §16 Design Tokens | ❌ Superseded | Use §5.1 of this doc + Appendix A |
| §17 Mobile/Responsive | ⚠️ Modified | Breakpoints per §5.8 of this doc |
| §18 Proactive Messages | ✅ Carries over | Card format valid |
| §21 Apps | ⚠️ Modified | Glass floor valid, visual treatment per §7.4 |
| §22 Run Detail | ⚠️ Modified | Inside-Shell rule valid, Story mode added per §7.6 |
| §23 Spaces | ✅ Carries over | Migration plan and sidebar behavior valid |

---

## APPENDIX Q — File-by-File Implementation Guide

### Q.1 Files to CREATE

| File | Purpose |
|---|---|
| `apps/web/src/pages/HomePage.tsx` | New home page (replaces FleetOverviewPage) |
| `apps/web/src/pages/AppsPage.tsx` | App list page (new) |
| `apps/web/src/pages/AppDetailPage.tsx` | App detail with tabs (Performance/Results/Config/Activity) |
| `apps/web/src/pages/PackagesPage.tsx` | Packages page (redesigned) |
| `apps/web/src/pages/HistoryPage.tsx` | Unified history (merges runs + activity + audit) |
| `apps/web/src/pages/ChatPage.tsx` | Full-screen chat page |
| `apps/web/src/components/chat/ChatPanel.tsx` | Persistent chat panel (replaces ConversationDock) |
| `apps/web/src/components/chat/RoomList.tsx` | Room/thread list for chat panel |
| `apps/web/src/components/chat/ThreadView.tsx` | Chat thread message view |
| `apps/web/src/components/chat/Composer.tsx` | Chat input with slash commands, mentions |
| `apps/web/src/components/chat/RoomCreateDialog.tsx` | Room creation with agent selection |
| `apps/web/src/components/agents/AgentCreateWizard.tsx` | Multi-step agent creation |
| `apps/web/src/components/agents/AgentCard.tsx` | Agent grid card |
| `apps/web/src/components/workflows/WorkflowCard.tsx` | Workflow list card (status-first) |
| `apps/web/src/components/workflows/WorkflowCreateDialog.tsx` | Dual-path creation (prompt/scratch/template) |
| `apps/web/src/components/apps/AppCard.tsx` | Compact app card |
| `apps/web/src/components/apps/PerformanceTab.tsx` | App performance with stat bar + run cards |
| `apps/web/src/components/apps/ResultsTab.tsx` | Visual results UI (must-have feature) |
| `apps/web/src/components/home/NeedsAttention.tsx` | Approval/failure inline action cards |
| `apps/web/src/components/home/LiveRightNow.tsx` | Active run cards |
| `apps/web/src/components/home/RecentlyBuilt.tsx` | Artifact thumbnail grid |
| `apps/web/src/components/shared/NotificationPanel.tsx` | Opaque notification dropdown |
| `apps/web/src/components/shared/DetailPanel.tsx` | Reusable right-slide detail panel |
| `apps/web/src/components/shared/AvatarMenu.tsx` | Header avatar dropdown |
| `apps/web/src/components/shared/ThemeToggle.tsx` | Dark/light theme switcher |
| `apps/web/src/components/shared/UndoToast.tsx` | Destructive action undo toast |
| `apps/web/src/components/shared/Skeleton.tsx` | Reusable skeleton components |
| `apps/web/src/components/shared/SearchInput.tsx` | Standardized search input |
| `apps/web/src/components/shared/FilterBar.tsx` | Standardized filter tabs |

### Q.2 Files to HEAVILY MODIFY

| File | Changes |
|---|---|
| `apps/web/src/App.tsx` | New route map (Appendix B), new Shell layout, remove NAV const, remove standalone logout |
| `apps/web/src/components/Sidebar.tsx` | Complete rewrite: 5 items + Spaces + Settings (§6.1) |
| `apps/web/tailwind.config.js` | Replace with Appendix A config |
| `apps/web/src/styles.css` | Update scrollbar styles (Appendix M), add skeleton shimmer keyframes |
| `apps/web/src/pages/AgentsPage.tsx` | Grid/table toggle, kill constellation, space grouping |
| `apps/web/src/pages/AgentDetailPage.tsx` | Restructured tabs (Overview/Instructions/Memory/Connections/History) |
| `apps/web/src/pages/WorkflowsPage.tsx` | Grouped list, status-first cards, new create flow |
| `apps/web/src/pages/WorkflowCanvasPage.tsx` | Auto-save, proper toolbar, minimap toggle, tab stability |
| `apps/web/src/pages/RunDetailPage.tsx` | Dual-mode (Story/Technical), stays inside Shell |
| `apps/web/src/pages/WorkspacesPage.tsx` | Image upload, clean creation modal |
| `apps/web/src/pages/SettingsPage.tsx` | 4 tabs (Profile/Workspace/Connections/Security) |
| `apps/web/src/components/canvas/WorkflowNode.tsx` | Node visual language per Appendix O |
| `apps/web/src/components/canvas/ContextInspector.tsx` | Form-based config, editable JSON toggle |
| `apps/web/src/components/canvas/NodePalette.tsx` | Smart palette with suggestions |
| `apps/web/src/components/shared/ConfirmDialog.tsx` | Add undo-toast pattern integration |
| `apps/web/src/components/shared/Toast.tsx` | Add undo variant, update positioning/styling |
| `apps/web/src/components/shared/EmptyState.tsx` | Enforce icon + title + description + CTA pattern |
| `apps/web/src/components/shared/Drawer.tsx` | Update styling to match new design tokens |
| `apps/web/src/components/TopBarPills.tsx` | Theme toggle, notification bell, avatar menu |
| `apps/web/src/store/agentisStore.ts` | Add chatPanel state, theme state, notification counts |

### Q.3 Files to DELETE

| File | Reason |
|---|---|
| `apps/web/src/components/agents/AgentConstellation.tsx` | Constellation view killed |
| `apps/web/src/components/ConversationDock.tsx` | Replaced by ChatPanel |
| `apps/web/src/pages/AgentFleetPage.tsx` | Merged into AgentsPage |
| `apps/web/src/pages/FleetOverviewPage.tsx` | Replaced by HomePage |
| `apps/web/src/pages/ActivityPage.tsx` | Merged into HistoryPage |
| `apps/web/src/pages/ApprovalsPage.tsx` | Merged into notification bell + Home |
| `apps/web/src/pages/SkillsPage.tsx` | Merged into PackagesPage |
| `apps/web/src/pages/GatewaysPage.tsx` | Moved to Settings > Connections |
| `apps/web/src/pages/SettingsChannelsPage.tsx` | Moved to Settings > Connections |
| `apps/web/src/pages/ConversationsPage.tsx` | Replaced by ChatPanel + ChatPage |
| `apps/web/src/pages/RunHistoryPage.tsx` | Merged into HistoryPage |
| `apps/web/src/components/dashboard/FleetOverview.tsx` | Replaced by Home components |
| `apps/web/src/components/dashboard/GatewayHealthRail.tsx` | Moved to Settings > Connections |
| `apps/web/src/components/dashboard/PendingApprovalsDock.tsx` | Replaced by NeedsAttention |
| `apps/web/src/components/dashboard/RecentActivityStream.tsx` | Replaced by Home components |
| `apps/web/src/components/approvals/ApprovalInbox.tsx` | Replaced by inline approval cards |
| `apps/web/src/components/approvals/ApprovalRequestRow.tsx` | Replaced by inline approval cards |
| `apps/web/src/components/activity/ActivityFeed.tsx` | Merged into HistoryPage |
| `apps/web/src/components/activity/ActivityEventRow.tsx` | Merged into HistoryPage |

### Q.4 Files to KEEP UNCHANGED

| File | Reason |
|---|---|
| `apps/web/src/lib/api.ts` | API client — no UI changes needed |
| `apps/web/src/lib/realtime.ts` | Socket.IO bridge — no UI changes needed |
| `apps/web/src/store/agentisStore.ts` | Will be modified but core structure stays |
| `apps/web/src/components/canvas/WorkflowCanvas.tsx` | React Flow core — modify nodes/config, not the canvas itself |
| `apps/web/src/components/canvas/RunDrawer.tsx` | Styling updates only |
| `apps/web/src/components/canvas/AgentNode.tsx` | Update to match new node visual language |
| `apps/web/src/components/shared/CommandPalette.tsx` | Styling updates only |
| `apps/web/src/components/LiveStrip.tsx` | Styling updates only |
| `apps/web/src/components/gateways/*` | Move to Settings context, minimal changes |
| `apps/web/src/components/channels/*` | Move to Settings context, minimal changes |
| `apps/web/src/components/runs/*` | Integrate into RunDetailPage, keep logic |
| `apps/web/src/pages/LoginPage.tsx` | Separate from shell redesign |

---

## APPENDIX R — API Dependencies

### R.1 UI Changes That Require Backend Changes

| UI Feature | API Change Needed | Priority |
|---|---|---|
| App Results UI | `GET /v1/apps/:slug/results?window=7d` — aggregate outputLabels across runs | P3 |
| App Performance stat bar | Same endpoint as above | P3 |
| Notification bell (human-readable) | `GET /v1/notifications` should return `summary` text field per notification, not just type + runId | P1 |
| Workspace image upload | `PATCH /v1/workspaces/:id` to accept `image` field (base64 or multipart) | P4 |
| Agent image upload | `PATCH /v1/agents/:id` to accept `avatar` image field | P2 |
| Room creation with agents | `POST /v1/rooms` to accept `agentIds` array | P3 |
| History unified endpoint | `GET /v1/history?type=run|activity|audit&...` — merged query across runs + activity tables | P2 |
| Run "Story" mode | `GET /v1/runs/:id/summary` — natural-language summary generated from block data | P3 (can be client-generated as fallback) |
| Space summary in sidebar | `GET /v1/spaces/:id/summary` — already specified in UIUX-AND-ARCHITECTURE-UPDATES.md | P2 |

### R.2 UI Changes That Are Pure Frontend

Everything else — navigation changes, component redesigns, styling updates, animation system, keyboard shortcuts, z-index system, form validation, skeleton states, empty states, confirmation dialogs, toast system, accessibility improvements — is pure frontend work with no API dependencies.

---

*End of transformation spec + implementation appendices. This document is the single source of truth for the Agentis UI/UX redesign. Every implementation decision must trace back to a section in this document.*