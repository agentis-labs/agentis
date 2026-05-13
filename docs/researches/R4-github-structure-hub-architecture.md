# R4 — GitHub Structure Deep Analysis for Hub Architecture

> **Purpose:** Map every structural GitHub primitive to its exact equivalent in the Agentis Hub architecture. Identify which concepts translate directly, which require adaptation, and which do not apply at all. The output is a build reference — when engineers design the Hub API, data model, and UI, this document is the spec source for "what is the GitHub analogue."
>
> **Sources audited:** GitHub Docs (Packages, Marketplace, Actions, Organizations, Teams, Dependency Review, Releases, OIDC), GitHub Marketplace live catalog. April 2026.

---

## 1. Framing: Why the GitHub Model?

GitHub is the only platform in software development that has successfully unified:
1. **Distribution** (packages, releases)
2. **Discovery** (search, marketplace, stars, trending)
3. **Social proof** (stars, forks, contributors, contribution graph)
4. **Automated trust** (Actions CI, CodeQL, dependency review, OSSF Scorecard)
5. **Commerce** (paid marketplace listings, publisher verification, billing)
6. **Community** (issues, PRs, code review, discussions)
7. **Identity** (profile, org membership, contribution history)

The Hub needs all seven of these for agent artifacts (skills, flows, agent packages). The GitHub model gives us a battle-tested vocabulary and interaction pattern that users already understand. This document maps each GitHub primitive to its Hub equivalent, adapting where the agent domain requires different semantics.

---

## 2. Core Artifact Types

### 2.1 GitHub Repositories → Hub Artifact Types

A GitHub repository is a versioned container for code. In the Hub, there is no single "repo" concept — instead there are three distinct artifact types, each with different semantics:

| GitHub Repository | Hub Artifact | Semantics |
|---|---|---|
| A runnable application repo | **Agent Package** | Complete deployable agent: system prompt, tools, memory config, model binding, ELO starting seed |
| A library / module repo | **Skill** | Atomic unit of capability — one function + tool schema + usage examples + test cases. Agents can load skills at runtime. |
| A workflow definition repo | **Flow** | Named multi-agent orchestration pattern: sequence, handoff tree, consensus vote, supervisory loop. Parameterized and reusable. |

**Why three types instead of one?**

A skill is stateless and composable (like an npm library). A flow is structural (like a Docker Compose file). An agent package is the fully configured runtime unit (like a Docker image). Conflating them into a single "repo" would obscure the dependency model and make the marketplace catalog incoherent.

**Artifact structure (analogous to repo contents):**

```
my-skill/
├── skill.json          ← manifest (name, version, description, author, license, tags)
├── tool.ts             ← the function implementation + schema
├── tests/              ← input/output test fixtures
├── README.md           ← usage docs
└── CHANGELOG.md        ← version history
```

```
my-agent-package/
├── agent.json          ← manifest (name, skills[], system_prompt, memory_config, model_config)
├── persona.md          ← the agent's character / tone / constraints
├── evals/              ← benchmark test suites
└── README.md
```

```
my-flow/
├── flow.json           ← manifest (name, agents[], routing_logic, termination_condition)
├── README.md
└── examples/           ← example trace outputs
```

### 2.2 GitHub Packages → Hub Registry

GitHub Packages is a versioned artifact registry (npm, PyPI, containers). Hub has its own registry semantics:

| GitHub Packages | Hub Registry |
|---|---|
| npm registry | Hub Skill registry (`hub install @author/skill-name@1.2.0`) |
| Container registry | Hub Agent Package registry (pull a full agent configuration) |
| Package versioning (semver) | Skill/Flow/Package versioning (semver enforced at publish time) |
| Package README / metadata | Skill card in catalog |
| `GITHUB_TOKEN` auth for publish | Hub API key scoped to publisher namespace |
| Package visibility (public/private) | Artifact visibility (public / private / org-only) |
| Package linked to repository | Artifact linked to author profile and optionally a source repo |
| Free for public packages | Free tier for open skills; paid listing requires publisher verification |

**Key difference:** GitHub Packages stores arbitrary binary artifacts alongside source code. Hub registry stores **declarative JSON manifests** — the skills/flows themselves are mostly code + schemas, not compiled binaries. The runtime that actually executes them lives in Agentis, not in the package.

---

## 3. Organizations and Teams

### 3.1 GitHub Organizations → Hub Publisher Namespaces

| GitHub Organization | Hub Publisher Namespace |
|---|---|
| `github.com/langchain-ai` | `hub.agentis.io/@langchain-ai` |
| Org owns repos (`langchain-ai/langsmith`) | Namespace owns artifacts (`@langchain-ai/eval-skill`) |
| Org members get repo access roles | Namespace members can publish under the namespace |
| Org profile (bio, pinned repos, member count) | Publisher profile (bio, published artifacts, install count, verified badge) |
| Org billing (seats, storage, Actions minutes) | Namespace billing (revenue share from paid skills) |
| Organization-wide Actions policies | Namespace-wide publish pipeline policies |
| Org-level CODEOWNERS | Namespace-level skill maintainers list |
| Transfer repo between orgs | Transfer artifact ownership (with audit log) |

**Verification tier:** Analogous to GitHub's "verified creator" badge on Marketplace. Hub publishers who complete identity verification + quality bar review get a `✓ Verified Publisher` badge on their namespace, which gates the ability to list paid artifacts.

### 3.2 GitHub Teams → Hub Author Groups

| GitHub Teams | Hub Author Groups |
|---|---|
| Team with read/write/admin repo access | Author group with publish/maintain/admin artifact access |
| Nested teams (Engineering > Backend > Identity) | Skill domain groups (Agent Skills > Tool Integrations > API Connectors) |
| `@org/team-name` mention for review requests | `@org/skill-team` tag on repair patches for routing to maintainers |
| Team visibility: visible / secret | Group visibility: public / private (secret groups for enterprise clients) |
| CODEOWNERS designates teams as owners of paths | Skill MAINTAINERS file designates groups for specific skill categories |
| Team synchronization via IdP (SCIM/SSO) | Author group sync via enterprise SSO (for Enterprise Hub tiers) |

**What maps awkwardly:** GitHub Teams are primarily about **access control**. Hub author groups are primarily about **review routing and community identity**. A Hub "team" is less about who can push code and more about who gets notified of repair patch proposals and who can approve new versions.

---

## 4. Social Proof Signals

### 4.1 Stars → Hub Saves / Endorsements

| GitHub Stars | Hub Endorsements |
|---|---|
| Single action (star / unstar) | Two-tier: **Save** (add to library) + **Endorse** (public quality signal) |
| Star count shown on repo card | Endorsement count + Save count shown on skill card |
| No semantic differentiation | Endorsements are categorized: `reliable`, `well-documented`, `creative`, `fast` |
| Stars feed "Trending" page | Endorsements + installs feed "Trending Skills" algorithm |
| Cannot rescind easily | Endorsements can be updated or retracted |

**Why two-tier?** A save is private intent ("I want to use this"). An endorsement is public social proof ("I can vouch for this"). Mixing them collapses the signal — GitHub stars are ambiguous (does a star mean "bookmarked" or "this is excellent"?). Hub separates the two.

### 4.2 Forks → Hub Derivatives

| GitHub Forks | Hub Derivatives |
|---|---|
| Fork = copy of repo with attribution link to original | Derivative = new artifact based on an existing skill, with attribution chain |
| Forker can submit PRs upstream | Derivative author can submit repair patches upstream |
| Fork count shown on repo card | Derivative count shown on skill card |
| Fork graph shows dependency tree | Derivative lineage panel shows skill evolution chain |
| GitHub shows "forked from X" on the fork's header | Hub shows "derived from @author/skill@version" in manifest |
| Forks inherit no special runtime relationship | Derivatives can optionally "track" the upstream skill (get notified of upstream updates) |

**Key addition:** Hub derivatives support **upstream tracking**. If you derive a skill and opt-in to tracking, you get a notification when the upstream skill releases a new version — analogous to Dependabot alerts but for skill derivations, not dependency version bumps.

### 4.3 Contributors → Hub Co-Authors

| GitHub Contributors | Hub Co-Authors |
|---|---|
| Contributor list based on git commits | Co-author list declared in skill manifest + PR-equivalent contributions accepted by maintainer |
| Contribution count (# commits) | Contribution count (# accepted repair patches + version contributions) |
| Contributor graph on repo | Co-author panel on skill card |
| Organization member vs outside collaborator | Namespace member vs guest contributor (no namespace access, can still contribute patches) |
| No formal "credit" for reviewing PRs | Hub credits reviewers who approve repair patches as "review contributors" |

### 4.4 Releases → Hub Versioned Artifacts

| GitHub Releases | Hub Versions |
|---|---|
| Semantic versioning (`v1.2.3`) | Semver enforced by publish pipeline (`1.2.3` — no `v` prefix) |
| Release notes (markdown body) | Changelog entry (required field at publish time, linked to `CHANGELOG.md`) |
| Release assets (binary attachments) | No binary assets — artifacts are declarative manifests |
| Pre-release tag | Beta / experimental tag (not served to production installs by default) |
| Draft release | Private draft version (visible only to namespace members) |
| Latest release shown on repo | Latest stable version shown on skill card |
| Pinning to a specific release tag | Pin to version in agent package manifest: `"skill": "@author/name@1.2.0"` |
| Release subscriptions (watch → notify on releases) | Version subscriptions (subscribe to a skill to get notified of new versions) |
| Yanked / retracted releases (via deletion) | **Deprecated** version flag (versions are never deleted — Hub is an append-only registry; deprecated versions are hidden but still fetchable for pinned consumers) |

**Append-only registry** is a deliberate deviation from GitHub. Deleting a released package causes supply chain disruptions (left-pad incident). Hub versions are **immutable and append-only**. A deprecated version shows a warning in the catalog but remains installable if pinned.

---

## 5. GitHub Actions → Hub Publish Pipeline

### 5.1 What GitHub Actions does for supply chain security

When a package is published on GitHub Actions, the following security checks are possible:
- **CodeQL / SAST**: static analysis for code vulnerabilities
- **Dependency review action**: blocks PRs introducing vulnerable dependencies
- **OSSF Scorecard**: computes a supply chain security score (branch protection, signed commits, SAST, CI, etc.)
- **Secrets scanning**: detects accidentally committed API keys / tokens
- **License scanning**: checks SPDX license compliance of dependencies
- **SBOM generation**: produces a software bill of materials

### 5.2 Hub Publish Pipeline (automated security scan on publish)

Every artifact submitted to Hub runs through a publish pipeline before it becomes visible in the catalog. This is non-optional — there is no way to bypass it.

```
Publish trigger
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  STAGE 1: Manifest Validation                                │
│  • skill.json / agent.json / flow.json schema validation    │
│  • Required fields check (name, version, description,       │
│    author, license, spdx_license_id)                        │
│  • Semver format enforcement                                 │
│  • Changelog entry required for versions > 0.1.0            │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  STAGE 2: Static Security Analysis                           │
│  • Prompt injection pattern scan (known jailbreak strings   │
│    in system prompts / personas)                            │
│  • Dangerous tool call detection (shell exec, arbitrary     │
│    code eval, unrestricted file system access)              │
│  • Hardcoded secrets scanner (API keys, tokens, passwords   │
│    embedded in skill code or manifests)                     │
│  • Outbound URL allowlist check (skill should not phone     │
│    home to unknown endpoints without declaration)           │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  STAGE 3: Dependency Audit                                   │
│  • npm/pip dependency CVE scan (via OSV database)           │
│  • License compatibility check (SPDX license against        │
│    allowed license policy)                                  │
│  • Pinned vs unpinned dependency check (unpinned deps       │
│    get a warning, not a block — author's choice)            │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  STAGE 4: Trust Score Computation                            │
│  • Hub Trust Score (0–100): weighted sum of                 │
│    - Test coverage (test fixtures present and passing)      │
│    - Security scan pass rate                                 │
│    - Changelog completeness                                  │
│    - Author reputation (previous publish history)           │
│    - Community endorsements on previous versions            │
│  • Score stamped on the published version                   │
└─────────────────────────────────────────────────────────────┘
      │
      ├── PASS → Version published, visible in catalog
      └── FAIL → Publish blocked, author receives report
```

**GitHub Actions → Hub Pipeline mapping:**

| GitHub Actions concept | Hub Publish Pipeline equivalent |
|---|---|
| Workflow YAML (`.github/workflows/publish.yml`) | Non-configurable publish pipeline (hardcoded by Hub) |
| `on: push` / `on: release` trigger | `on: hub publish` — triggered by the Hub CLI `hub publish` command |
| Job matrix | Sequential fixed stages (manifest → security → deps → trust score) |
| Action marketplace (e.g., `actions/codeql-action`) | Hub uses internal pipeline modules (no external action dependencies) |
| Status checks blocking PR merge | Trust score + security scan gates blocking catalog visibility |
| `GITHUB_TOKEN` short-lived credential | Hub publish API key scoped to namespace + short-lived per-publish JWT |
| OSSF Scorecard | Hub Trust Score (adapted for agent artifact context, not source code context) |
| Secrets scanning | Hardcoded secrets scanner in Stage 2 |
| Dependency review action | Dependency audit in Stage 3 |

**What GitHub Actions does that Hub pipeline does not:**

- **Build artifacts from source** — Hub artifacts are not compiled; they're declarative. There is no "build" step.
- **Deploy to cloud** — Hub publishes to the catalog, not to a cloud provider. Deployment to a runtime is a separate Agentis feature.
- **Custom workflow logic** — Hub pipeline is intentionally not configurable by publishers. This is a trust model decision: the security scan must be uniform and non-bypassable.
- **Self-hosted runners** — Hub pipeline runs on Hub infrastructure only.

---

## 6. Marketplace → Hub Catalog

### 6.1 GitHub Marketplace structure

GitHub Marketplace has two listing types:
1. **Actions**: anyone can publish, some verified creator organizations
2. **Apps**: anyone can list for free; only verified publisher organizations can sell (paid plans require financial onboarding)

Discovery: search, categories (code quality, CI/CD, deployment, etc.), featured collections, trending.

Monetization: per-unit pricing or per-seat, billing via GitHub. GitHub takes a revenue share.

### 6.2 Hub Catalog structure

The Hub Catalog mirrors this architecture but with agent-domain categories:

**Listing tiers:**

| Tier | Who can publish | What they can do |
|---|---|---|
| **Free / Open** | Any registered author | Publish skills, flows, agent packages for free install |
| **Community Paid** | Verified publisher (individual) | Sell skills with one-time or per-use pricing |
| **Organization Paid** | Verified publisher namespace | Sell agent packages, flows, and skill bundles with seat licensing |
| **Enterprise** | Verified enterprise publisher | Private catalog listing, custom pricing, SLA |

**Verification for paid listings** (mirrors GitHub's publisher verification):
1. Identity verification (name, legal entity for organizations)
2. Quality bar: minimum Trust Score ≥ 70 on all published versions
3. Financial onboarding (banking, tax information)
4. Agreement to Hub Marketplace Terms (equivalent to GitHub Marketplace Developer Agreement)

**Category taxonomy:**

| Hub Category | What it contains | GitHub Marketplace analogue |
|---|---|---|
| Tool Integrations | Skills that wrap external APIs (Slack, Notion, Jira, Stripe) | CI / Deployment category |
| Memory & Retrieval | Skills for RAG, vector search, embedding | Code Quality / Analysis |
| Orchestration Flows | Multi-agent routing patterns | Project Management apps |
| Persona Packs | Curated agent personalities + system prompts | N/A (no analogue) |
| Evaluation Suites | Evals + benchmark datasets for specific domains | Code Review apps |
| Full Agent Packages | Fully configured agents for specific use cases | N/A (closest: Copilot Extensions) |
| Model Adapters | Skills that normalize LLM API calls | N/A (no analogue) |

**Discovery mechanics:**

| GitHub Marketplace | Hub Catalog |
|---|---|
| Search by keyword | Search by keyword + skill domain + tag + compatible model |
| Category browse | Category browse (7 categories above) |
| Verified creator badge | Verified Publisher badge |
| "Featured" section | Curated collections (Hub editorial team or community-voted) |
| Trending (not explicit) | Trending: install velocity + endorsement velocity in trailing 7 days |
| No "compatibility" filter | Compatibility filter: compatible with LangGraph / CrewAI / Agentis native / all |
| Pricing filter | Pricing filter: free / paid / open source |
| No quality score | Trust Score shown on every card |

---

## 7. Profile + Contribution Graph → Hub Author Profile

### 7.1 GitHub Profile components

- Avatar, display name, bio, location, pronouns
- Pinned repositories (up to 6)
- Contribution heatmap (365 days, color-coded by activity density)
- Activity: repos, stars, followers/following, organizations
- Achievements (activity badges)
- Profile README (custom markdown section)

### 7.2 Hub Author Profile equivalent

| GitHub Profile element | Hub Author Profile equivalent |
|---|---|
| Avatar + display name + bio | Author avatar + display name + bio |
| Pinned repositories (6 max) | Pinned artifacts (skills/flows/packages the author wants featured) |
| Contribution heatmap | **Publish activity graph**: publishes, patch approvals, and endorsements given over the trailing 365 days |
| Follower / following count | Follower count (follow an author to get notified of new publishes) |
| Organization memberships | Publisher namespace memberships |
| GitHub Achievements | **Hub Badges**: `First Publish`, `100 Installs`, `Verified Publisher`, `1000 Endorsements`, `Top Skill (by category)`, `Prolific Reviewer` |
| Profile README | Author statement (markdown, displayed at top of profile) |
| Stars received | Total installs across all artifacts |
| Star count per repo | Install count per artifact |
| N/A | **Specialization tags** (displayed under bio): auto-computed from artifact category distribution — e.g., "Tool Integration Expert", "Flow Architect", "Memory Specialist" |
| N/A | **Author Trust Rating**: weighted average of Trust Scores across all published artifacts |
| N/A | **ELO contribution history**: how agents using this author's skills have performed (opt-in telemetry feed) |

**Publish activity graph vs. contribution heatmap:**

GitHub's heatmap counts commits, PRs, issues, and code reviews. Hub's equivalent counts:
- `publish` events (new artifact or new version)
- `patch_approved` events (author accepted a community repair patch)
- `patch_submitted` events (author submitted a repair patch to another skill)
- `endorsement_given` events

This makes the Hub activity graph richer — it captures both creation and maintenance behavior, which are equally valued.

---

## 8. Issues / PRs → Skill Repair Patches + Community Review

### 8.1 GitHub Issues → Hub Bug Reports

| GitHub Issues | Hub Bug Reports |
|---|---|
| Anyone can open an issue on a public repo | Anyone with a Hub account can file a bug report on a public skill |
| Issue labels (bug, feature, help wanted, good first issue) | Report categories: `broken-tool-call`, `incorrect-output`, `security-concern`, `documentation-gap`, `feature-request` |
| Issue assignees | Skill maintainer(s) assigned automatically |
| Linked PRs | Linked repair patches |
| Milestone tracking | Version target (which upcoming version will address this) |
| Issue templates | Structured report form (reproduction input, expected output, actual output, model/runtime context) |
| Close with comment | Close with resolution note + linked version that fixed it |
| Issue reactions (👍 upvotes) | Report upvotes (surface most-impactful issues to maintainer) |
| `wontfix` / `duplicate` labels | `by-design` / `duplicate` / `environment-issue` dispositions |

**What issues don't map:**
- **Feature requests** exist in Hub but carry lower weight — skills are intentionally atomic; a feature request that significantly expands scope should be a derivative skill, not an addition to the existing one.
- **Security issues** in Hub are routed through a separate **private security disclosure channel** (analogous to GitHub's private vulnerability reporting). Public issues cannot be filed for security concerns — they go through the secure channel and are embargoed until patched.

### 8.2 GitHub Pull Requests → Hub Repair Patches

| GitHub Pull Request | Hub Repair Patch |
|---|---|
| Fork the repo, make changes, open a PR | Fork the skill (create a derivative), make changes, submit a repair patch to the upstream |
| PR diff (file-level, line-level) | Patch diff: manifest changes + tool function changes shown side-by-side |
| Required reviewers / code owners | Skill maintainer must approve; for Verified Publisher skills, a second Hub reviewer is required |
| CI status checks must pass | Publish pipeline (all 4 stages) must pass on the patched version before it can be approved |
| Branch protection prevents merge if checks fail | Patch cannot be applied if pipeline fails |
| PR reviews (approve / request changes / comment) | Patch review (accept / request changes / reject with reason) |
| Merged PR creates a commit | Accepted patch creates a new version of the skill (semver bump determined by patch type: patch/minor) |
| PR assignees | Patch routed to skill maintainers |
| Draft PR | Draft patch (visible to maintainers only, not community) |
| `@mention` in PR | `@mention` in patch comments routes notifications to the mentioned author |
| PR linked to issue (closes #123) | Patch linked to bug report (resolves report #X; linked in the new version changelog) |

**The semver bump logic:**

| Patch type | Semver impact | Example |
|---|---|---|
| Bug fix (tool call correction, output format fix) | Patch (`1.2.3 → 1.2.4`) | Fixed Slack API endpoint URL |
| Behavioral change (output schema change) | Minor (`1.2.3 → 1.3.0`) | Changed output to include additional field |
| Breaking change (input schema change, tool removed) | Major (`1.2.3 → 2.0.0`) | Renamed required input parameter |

Maintainers declare the semver type when accepting a patch. Hub validates it: a change that modifies the tool's input schema cannot be accepted as a patch bump — it must be minor or major.

### 8.3 GitHub Discussions → Hub Community Comments

GitHub Discussions are repo-level asynchronous conversation threads (separate from Issues). Hub equivalent:

| GitHub Discussions | Hub Community Comments |
|---|---|
| Q&A category (question + accepted answer) | Skill usage Q&A thread (question + accepted answer, surfaced in skill card) |
| Ideas category | Feature proposal thread |
| Show and tell | "Deployed with this skill" showcase thread |
| General discussion | General skill discussion |
| Discussion reactions | Thread reactions |
| Discussion announcements (pinned by maintainer) | Maintainer announcements (pinned at top of skill's community tab) |

---

## 9. Precise Mapping Table (Master Reference)

| GitHub Primitive | Hub Equivalent | Mapping Type |
|---|---|---|
| Repository | Skill / Flow / Agent Package | **Adapted** (three types, not one) |
| GitHub Packages registry | Hub Artifact Registry | **Direct** |
| Semver release tagging | Semver version (publish pipeline enforced) | **Direct** |
| Release notes | Changelog entry (required field) | **Direct, stricter** |
| Release assets (binaries) | Not applicable — Hub artifacts are declarative | **Does not apply** |
| GitHub organization | Publisher namespace | **Direct** |
| Organization member | Namespace member | **Direct** |
| Organization-owned app (for paid Marketplace) | Verified Publisher namespace (required for paid listings) | **Direct** |
| GitHub Teams | Author groups | **Adapted** (less access-control, more review-routing) |
| Nested teams | Skill domain groups | **Adapted** |
| CODEOWNERS | Skill MAINTAINERS file | **Direct** |
| Stars | Saves + Endorsements (two-tier) | **Adapted** |
| Fork | Derivative (with attribution chain + upstream tracking) | **Adapted, richer** |
| Contributors list | Co-authors list | **Direct** |
| Releases page | Version history panel | **Direct** |
| Version pinning | Manifest pin syntax `@author/skill@1.2.0` | **Direct** |
| Yanked release (deletion) | Deprecated version flag (append-only, never deleted) | **Adapted, safer** |
| GitHub Actions workflow | Hub publish pipeline (fixed, non-configurable) | **Adapted, locked** |
| CodeQL / SAST | Static security analysis (Stage 2) | **Adapted for agent artifacts** |
| Dependency review action | Dependency audit (Stage 3) | **Direct analogue** |
| Secrets scanning | Hardcoded secrets scanner | **Direct** |
| OSSF Scorecard | Hub Trust Score (0–100) | **Adapted for agent artifacts** |
| Status checks blocking merge | Pipeline gates blocking catalog visibility | **Direct** |
| GitHub Marketplace listing | Hub Catalog listing | **Direct** |
| Free app listing | Free skill listing (open publish) | **Direct** |
| Paid app (verified publisher org) | Paid artifact (verified publisher namespace) | **Direct** |
| Marketplace categories | Hub Catalog categories (7 types) | **Adapted** |
| Marketplace pricing plans | Artifact pricing: per-install, per-use, per-seat | **Adapted, more granular** |
| Marketplace financial onboarding | Hub payment onboarding (identity + banking) | **Direct** |
| Profile avatar + bio | Author profile avatar + bio | **Direct** |
| Pinned repositories | Pinned artifacts | **Direct** |
| Contribution heatmap | Publish activity graph | **Adapted** |
| Followers / following | Followers / following | **Direct** |
| GitHub Achievements | Hub Badges | **Direct** |
| Profile README | Author statement | **Direct** |
| N/A | Specialization tags (auto-computed) | **Hub-native** |
| N/A | Author Trust Rating | **Hub-native** |
| GitHub Issues | Hub Bug Reports | **Direct** |
| Issue labels | Report categories + dispositions | **Adapted** |
| Private vulnerability reporting | Hub security disclosure channel (private, embargoed) | **Direct** |
| Pull Requests | Repair Patches | **Adapted** |
| PR diff | Patch diff (manifest + tool function) | **Adapted** |
| Required reviewers | Skill maintainer approval + Hub reviewer (for verified) | **Adapted, stricter** |
| PR CI gates | Pipeline gate on patch version | **Direct** |
| PR merge → commit | Patch acceptance → new version | **Adapted** |
| GitHub Discussions | Hub Community Comments | **Direct** |
| Branch protection rules | Not applicable — Hub artifacts are immutable versioned releases | **Does not apply** |
| Git history / commits | Not applicable — no line-level source code history | **Does not apply** |
| Codespaces | Not applicable — no dev environment in Hub | **Does not apply** |
| GitHub Pages | Not applicable — no static hosting | **Does not apply** |
| Merge conflicts | Not applicable — skills are declarative artifacts, not merged text | **Does not apply** |
| `git blame` | Not applicable | **Does not apply** |
| Dependabot auto-PRs | **Derivative tracking notifications** (opt-in upstream version alerts) | **Hub-native, no exact analogue** |
| Self-hosted runners | Not applicable — publish pipeline is Hub-infrastructure only | **Does not apply** |
| GitHub Copilot integration | Not applicable (separate product concern) | **Out of scope** |

---

## 10. What Doesn't Apply — Summary

The following GitHub concepts have **no valid mapping** in Hub and should not be included in Hub's design:

| GitHub concept | Why it doesn't apply |
|---|---|
| **Branch protection rules** | Hub artifacts are released versions, not branches. The "protection" equivalent is the publish pipeline gate — there is no branching model. |
| **Git history (commits, blame)** | Hub artifacts are declarative manifests and tool functions. They have **version history**, not commit history. There is no line-by-line authorship — the patch system tracks contribution at the version level, not the line level. |
| **Codespaces / dev containers** | Hub is a distribution and community platform, not a development environment. Authors develop skills locally and publish to Hub. Hub does not provide hosted compute for skill development. |
| **GitHub Pages** | Hub does not host static websites. Skill README documentation is rendered within the Hub catalog UI. Authors who want a dedicated website host it themselves and link it from their profile. |
| **Merge conflicts** | Manifests and tool schemas are structured JSON/YAML. Two patches that modify the same field are not "conflicted" — the maintainer simply accepts one, rejects the other, or accepts both in sequence (the second patch sees the post-first-patch state). |
| **Fork network graph (full)** | Hub shows a linear attribution chain (`derived from → derived from → original`), not a full tree of all active forks. The derivative tracking feature only shows registered active derivatives, not abandoned ones. |
| **Release binaries / assets** | Skills are code + schemas. There are no binary executables, compiled artifacts, or static files to attach to a version. (Agent Packages that bundle trained LoRA adapters may introduce this in the future — out of scope for V1.) |
| **Dependabot automated PRs** | Hub has no automated patch submission. Derivative tracking sends a notification; it does not automatically submit a repair patch on the author's behalf. Authors decide whether and how to update. |
| **Self-hosted runners** | The publish pipeline is Hub-controlled and uniform. Authors cannot run their own pipeline or skip any stage. This is intentional — the pipeline is the trust foundation. |

---

## 11. Hub-Native Concepts (No GitHub Analogue)

These are concepts Hub needs that GitHub does not provide, because GitHub is for code, not for live agent operations:

| Hub-native concept | Description | Why GitHub has no analogue |
|---|---|---|
| **ELO contribution history** | Opt-in telemetry: how agents using an author's skills have performed across missions (win rate, user satisfaction) | GitHub has no concept of a repo's runtime performance across deployed instances |
| **Author Trust Rating** | Weighted average of Trust Scores across all of an author's published artifacts | GitHub's Scorecard is per-repo; there is no author-level quality signal |
| **Specialization tags** | Auto-computed from publish history: "Tool Integration Expert", "Flow Architect" | GitHub has no role inference from repo content |
| **Compatibility matrix** | Which agent frameworks (LangGraph, CrewAI, Agentis native) each skill is tested against | GitHub has no concept of a library's compatibility with agent runtimes |
| **Derivative upstream tracking** | Subscribe to upstream skill updates when you've derived from it | GitHub's fork network has no active "watch for updates" on the upstream |
| **Hub security disclosure embargo** | Security patches that are embargoed until the fix version is released, then disclosed | GitHub has this for CVEs in its Advisory Database, but not at the artifact level for app developers |
| **Trust Score** | Aggregate quality + security signal stamped on every published version | GitHub Scorecard exists but is repo-level and developer-computed, not platform-enforced |
| **Community endorsement categories** | `reliable`, `well-documented`, `creative`, `fast` — typed quality signals | GitHub stars are untyped |
