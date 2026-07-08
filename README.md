# Agentis

**The operating system for agentic software.** Agents don't just answer — they build,
run, and operate real applications, and the platform gets measurably smarter every time
they do. Self-hostable, local-first, and harness-agnostic: it drives Claude Code, Codex,
Cursor, Antigravity, Hermes, OpenClaw fleets, and local HTTP models through one contract.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.10-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9.12-orange.svg)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
![Status](https://img.shields.io/badge/status-pre--release%200.1.x-yellow.svg)

> **Status: pre-release (0.1.x).** APIs may still change before 1.0.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fagentis-labs%2Fagentis)

---

## Table of contents

- [Quickstart](#quickstart)
- [Concepts](#concepts)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Quickstart

### Run it (operator)

```bash
# npm (global)
npm install -g @agentis-ai/cli
agentis up

# or without installing
npx @agentis-ai/cli up

# or with Docker
docker compose up
```

The API boots on `http://127.0.0.1:3737` and prints the seeded operator password **once** —
copy it. First boot is self-contained:

1. Generates an RSA-2048 JWT keypair and an AES-256 credential-vault key, written to
   `.agentis/secrets.json` (`chmod 0600`).
2. Initialises an embedded SQLite database at `.agentis/agentis.db` (WAL mode, foreign keys
   on).
3. Seeds an `operator` user, a `Personal` workspace, and a `Local` ambient.
4. Starts the HTTP + WebSocket server.

Everything runtime — database, secrets, per-agent home directories, generated assets — lives
under `AGENTIS_DATA_DIR` (default `./.agentis`, git-ignored). Nothing personal is ever
written into the source tree.

### Develop it (contributor)

```bash
pnpm install
pnpm -r typecheck        # tsc across every package
pnpm -r test             # vitest across every package
pnpm doctor              # preflight: Node, ports, sqlite, secrets
pnpm dev:full            # api on :3737 + web on :5173
```

Requires **Node ≥ 20.10** and **pnpm 9.12** (`packageManager` is pinned).

---

## Concepts

Agentis is organised around seven gravitational concepts. The full technical guide lives in
[`docs/`](./docs/00-foundation.md):

| Concept | What it is |
|---------|-----------|
| [The Durable Spine & Six Primitives](./docs/00-foundation.md) | One restart-durable entity model; six primitives (Agent · Subject · Connection · Orchestration · Experiment · Interface). |
| [The Brain](./docs/01-the-brain.md) | Durable, local semantic memory with formation gating, grounding, knowledge/RAG, and living skills. |
| [Agentic Applications](./docs/02-agentic-applications.md) | Apps with typed data + agent-authored interfaces that agents both build and operate. |
| [Self-Healing Orchestration](./docs/03-orchestration.md) | A 47-node workflow engine with self-repair, objectives, and replay. |
| [The Agent Fabric (RAL)](./docs/04-agent-fabric.md) | A Runtime Abstraction Layer: any agent runtime behind one contract, matched by capability. |
| [Sovereignty](./docs/05-sovereignty.md) | Own the agents, data, and intelligence; swap runtimes/models; portable, self-hosted, governed. |
| [Omni-Reach](./docs/06-omni-reach.md) | Channels, MCP, integrations, and agent-to-agent messaging. |
| [Agent-Native Core](./docs/07-agent-native-core.md) | The 132-tool `agentis.*` SDK and code-mode: the platform is operable by agents as code. |

---

## Architecture

```
apps/
  api/     Headless backend — Hono (HTTP) + socket.io (realtime) + WorkflowEngine
  web/     React + Vite SPA — canvas, brain, apps, chat, ledger, inbox
packages/
  core/          Shared types, Zod schemas, error codes, event names, RAL affordances
  db/            Drizzle schema (SQLite + Postgres dialects) + embedded init SQL
  runtime/       Shared runtime primitives
  integrations/  Connector manifests + templated HTTP connectors
  app/           App package format (pack/validate/install)
  app-client/    Client for embedding App surfaces
  sdk/           @agentis/sdk — programmatic build/validate/test
  cli/           @agentis-ai/cli — `agentis up`, bootstrap, backup/restore
```

**The engine.** `WorkflowEngine` owns a `ReadyQueue` and a `WaitingInputBuffer` per active
run. Each tick drains the ready queue up to a configured parallelism, dispatches each node by
its `config.kind` (one of 47 node types), and either completes it synchronously
(deterministic/data nodes) or registers an async execution record (agent tasks, checkpoints,
subflows). Every transition appends a monotonic **ledger** event and publishes a realtime
envelope on the `EventBus`; run state is snapshotted periodically so partial replay can resume
from a recent point.

**Realtime.** `EventBus` (`publish(room, event, payload)` + `subscribe`) wraps Node's
`EventEmitter`; a WebSocket bridge forwards envelopes to socket.io rooms. Clients subscribe to
`workspace`, `run`, or `workflow` rooms after handshake-time JWT validation, with ownership
re-checked server-side.

**Validation.** Every external boundary parses through Zod. Workflow node configs are a
discriminated union on `kind`, making the engine's dispatch switch exhaustive at the type
level. Conditional expressions parse through a hand-written recursive-descent grammar — never
`eval`.

**Persistence.** Embedded SQLite by default (single-writer, WAL). All state — runs, ledger,
memory, apps, durable entities — lives on one spine, so agents and workflows can see and reach
each other. A hosted Postgres dialect exists but is a stub; SQLite is the supported target.

---

## Configuration

All configuration is via environment variables; every value has a sane default. See
[`.env.example`](./.env.example) for the complete set. Common ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTIS_DATA_DIR` | `./.agentis` | Data root: SQLite DB, secrets, agent homes, backups. |
| `AGENTIS_ASSETS_DIR` | `{DATA_DIR}/assets` | Content-addressed blob store (deduped by SHA-256). Point it off-repo. |
| `AGENTIS_HTTP_PORT` | `3737` | API port. |
| `AGENTIS_HTTP_HOST` | `127.0.0.1` | API bind host. |
| `AGENTIS_EXTENSION_REQUIRE_ISOLATE` | unset | Fail closed instead of using the weak `node:vm` fallback for untrusted extension code. |
| `AGENTIS_EXTENSION_DOCKER` | unset | Enable the Docker extension sandbox. |
| `AGENTIS_ORCHESTRATOR_BASE_URL` / `_API_KEY` / `_MODEL` | unset | Optional OpenAI-compatible model endpoint for the orchestrator. |

---

## Development

```bash
pnpm -r typecheck        # type-check all packages
pnpm -r test             # unit tests (vitest)
pnpm test:e2e            # Playwright e2e (Playwright must be installed)
pnpm lint                # import-boundary + security-invariant + file-budget checks, then per-package lint
pnpm build               # build packages, then web, then api
pnpm db:generate         # regenerate Drizzle migrations
pnpm db:migrate          # apply migrations
```

The API is the composition root (`apps/api/src/bootstrap.ts`). Routes live under
`apps/api/src/routes/*` and mount at `/v1/*`. The web SPA is served statically by the backend
in production builds.

---

## Repository layout

```
apps/api/src/
  bootstrap.ts     Composition root
  engine/          WorkflowEngine, ReadyQueue, self-heal, triggers, executors, validators
  adapters/        Runtime adapters (Claude Code, Codex, Cursor, Antigravity, Hermes, …) + channels
  services/        Brain, grounding, apps, agentis.* tool registry, MCP, media, budgets, …
  grounding/       Claims, evidence ledger, identity, investigations
  routes/          /v1/{agents,workflows,runs,brain,apps,channels,mcp,…}
  middleware/      requireAuth, requireWorkspace, error handler
  websocket/       socket.io bridge over the in-process EventBus
apps/web/src/
  pages/           Canvas, Brain, Apps, Chat, Home, Knowledge, Artifacts, …
  components/      Canvas, brain, apps, chat, settings, shared
  lib/             api.ts (auth-aware fetch), realtime.ts (socket hook)
packages/core/     Types, schemas, errors, constants, event names, RAL affordances
packages/db/       Drizzle schema (sqlite + pg) + embedded init SQL
```

---

## Security

- **Isolation** — every authenticated request re-checks workspace/user ownership
  (`requireWorkspace`).
- **Secrets** — AES-256-GCM credential vault with auth-tag verification; secrets file is
  `chmod 0600` on first write; no secrets in logs.
- **Auth** — bcrypt passwords, RS256 JWTs with a `kind` claim that rejects refresh-as-access
  replay.
- **Injection** — discriminated-union validation on every node; safe expression parser (no
  `eval`).
- **SSRF** — outbound HTTP from agents/extensions is IP-pinned and blocks private ranges by
  default.
- **Sandboxing** — extension code runs in `node:vm` (a capability surface, not a hard
  boundary); install `isolated-vm` or enable Docker for untrusted code, and set
  `AGENTIS_EXTENSION_REQUIRE_ISOLATE=true` to fail closed.

Report vulnerabilities per [SECURITY.md](./SECURITY.md).

---

## Contributing

Issues and PRs are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and
please keep security reports private per [SECURITY.md](./SECURITY.md).

Before opening a PR:

```bash
pnpm -r typecheck && pnpm -r test && pnpm lint
```

The technical guide in [`docs/`](./docs/00-foundation.md) is the reference for how the
platform is structured.

---

## License

Agentis is licensed under the **Apache License 2.0** — see [LICENSE](./LICENSE).
