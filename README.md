# Agentis

## Own the agents. Rent the models.

Agentis is the open-source, self-hosted command center for agents you own. Import the
agents you already run, give them a permanent Brain of memory and skills, swap the model
underneath them anytime, and ship what they build as real apps, workflows, and channels
from your own machine.

Agents should not disappear when a vendor changes, a subscription ends, or a local process
restarts. Agentis gives them durable identity, memory, orchestration, tools, approvals,
and a live product surface they can operate with you.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.10-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9.12-orange.svg)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
![Status](https://img.shields.io/badge/status-pre--release%200.2.x-yellow.svg)

> **Status: pre-release (0.2.x).** Agentis is already usable, but APIs may still change
> before 1.0.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fagentis-labs%2Fagentis)

---

## Start in one line

```bash
npx @agentis-labs/cli@latest up
```

Works on macOS, Linux, and Windows PowerShell with Node.js >= 20.10 installed.
Agentis boots at `http://127.0.0.1:3737`, creates local secrets, initializes SQLite,
seeds the first operator user, and serves the dashboard from the same process.
This one-line command is temporary: it runs Agentis through `npx` and does not install
the `agentis` command permanently.

Prefer a persistent binary?

```bash
npm install -g @agentis-labs/cli
agentis up
```

On Windows, open a new PowerShell after the global install so npm's global command
shims are picked up on `PATH`.

Prefer Docker?

```bash
docker compose up
```

---

## Why Agentis

**A permanent Brain for your agents.** Agentis stores durable memory locally with a bundled
offline embedding model, formation gates, grounded knowledge, living skills, cited answers,
and explicit abstention when it does not know.

**Apps, not chat transcripts.** Agents can define typed data, generate UI surfaces, wire
actions, and operate the product they created. App surfaces include tables, boards, charts,
run monitors, agent feeds, approvals, and public read-only views.

**Self-healing orchestration.** The workflow engine runs typed graphs with 47 node kinds,
durable snapshots, partial replay, checkpoints, subflows, objective verdicts, and repair
paths that recover honestly instead of fabricating success.

**One fabric for every runtime.** Claude Code, Codex, Cursor, Antigravity, Hermes, OpenClaw,
OpenAI-compatible endpoints, and local models sit behind one Runtime Abstraction Layer.
Route by capability, not vendor.

**Reach people and systems.** Slack, Telegram, WhatsApp, email, webhooks, MCP, A2A,
and 90+ integration manifests all use the same connection registry, credential vault,
and policy layer.

**Agent-native by design.** The platform exposes a typed `agentis.*` surface with 132 tools
for building, running, observing, repairing, governing, and shipping. Agents operate Agentis
as code instead of juggling brittle one-off tool calls.

**Sovereign by default.** SQLite, secrets, assets, agent homes, memories, and audit logs live
under `AGENTIS_DATA_DIR` unless you choose otherwise. Models are swappable. Data stays yours.

---

## What You Can Build

- Agent-run internal tools with durable data, live ops, approvals, and memory.
- Self-healing workflows that replay, diagnose, and improve from real outcomes.
- Specialist fleets that use Claude Code, Codex, Cursor, local models, or custom HTTP agents.
- Agentic apps that package workflows, interfaces, collections, and tests into `.agentisapp`.
- Channel-native agents that respond across Slack, Telegram, WhatsApp, email, MCP, and A2A.

---

## First Boot

The first run is self-contained:

1. Generates an RSA-2048 JWT keypair and AES-256 credential-vault key in `.agentis/secrets.json`.
2. Initializes embedded SQLite at `.agentis/agentis.db` with WAL mode and foreign keys.
3. Seeds an `operator` user, a `Personal` workspace, and a `Local` ambient.
4. Starts the HTTP API, WebSocket bridge, workflow engine, and bundled dashboard.

The seeded operator credential is printed once. Everything runtime lives under
`AGENTIS_DATA_DIR` by default, and the source tree stays clean.

---

## Platform Map

Agentis is organized around seven core systems. The full technical guide lives in
[`docs/`](./docs/00-foundation.md):

| System | What it gives you |
|--------|-------------------|
| [Durable Spine & Six Primitives](./docs/00-foundation.md) | One restart-durable entity model for Agent, Subject, Connection, Orchestration, Experiment, and Interface. |
| [The Brain](./docs/01-the-brain.md) | Local semantic memory, grounding, knowledge bases, skills, citations, and learning from outcomes. |
| [Agentic Applications](./docs/02-agentic-applications.md) | Typed data, agent-authored UI, actions, orchestration, subjects, and app packaging. |
| [Self-Healing Orchestration](./docs/03-orchestration.md) | A 47-node workflow engine with replay, objectives, verdicts, and repair. |
| [The Agent Fabric](./docs/04-agent-fabric.md) | Runtime-neutral routing across Claude Code, Codex, Cursor, Antigravity, Hermes, OpenClaw, local, and HTTP agents. |
| [Sovereignty](./docs/05-sovereignty.md) | Local-first data, encrypted secrets, portable backups, budgets, approvals, and audit. |
| [Omni-Reach](./docs/06-omni-reach.md) | Channels, MCP, A2A, webhooks, email, integrations, and outbound policy. |
| [Agent-Native Core](./docs/07-agent-native-core.md) | The typed `agentis.*` tool surface agents use to build and operate the platform as code. |

---

## Architecture Snapshot

```text
apps/
  api/     Headless backend: Hono HTTP, socket.io realtime, workflow engine, Brain
  web/     React + Vite dashboard: canvas, brain, apps, chat, ledger, inbox
packages/
  core/          Shared types, schemas, errors, event names, RAL affordances
  db/            Drizzle schema for SQLite and Postgres dialects
  runtime/       Shared runtime primitives
  integrations/  Connector manifests and templated HTTP connectors
  app/           App package format
  app-client/    Client for embedding App surfaces
  sdk/           Programmatic build, validate, and test
  cli/           @agentis-labs/cli: up, bootstrap, backup, restore, app tooling
```

The API is the composition root. In production, the CLI serves the built web dashboard from
the same Node process that owns the API, WebSocket bridge, workflow engine, local database,
memory, apps, and agent runtime adapters.

---

## Configuration

All configuration is via environment variables, and every common value has a local default.
See [`.env.example`](./.env.example) for the complete set.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTIS_DATA_DIR` | `./.agentis` | SQLite DB, secrets, agent homes, backups. |
| `AGENTIS_ASSETS_DIR` | `{DATA_DIR}/assets` | Content-addressed blob store, deduped by SHA-256. |
| `AGENTIS_HTTP_PORT` | `3737` | API and dashboard port. |
| `AGENTIS_HTTP_HOST` | `127.0.0.1` | Bind host. |
| `AGENTIS_EXTENSION_REQUIRE_ISOLATE` | unset | Fail closed instead of using `node:vm` for untrusted extension code. |
| `AGENTIS_EXTENSION_DOCKER` | unset | Enable the Docker extension sandbox. |
| `AGENTIS_ORCHESTRATOR_BASE_URL` / `_API_KEY` / `_MODEL` | unset | Optional OpenAI-compatible model endpoint for the orchestrator. |

---

## Develop

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm doctor
pnpm dev:full
```

Requires Node.js >= 20.10 and pnpm 9.12.

Useful contributor commands:

```bash
pnpm lint
pnpm build
pnpm test:e2e
pnpm db:generate
pnpm db:migrate
```

---

## Security

- Every authenticated request re-checks workspace and user ownership.
- Secrets are stored in an AES-256-GCM credential vault and never returned decrypted.
- Passwords use bcrypt; JWTs use RS256 with access/refresh kind separation.
- Workflow configs are validated through discriminated unions and safe parsers, not `eval`.
- Agent and extension HTTP is IP-pinned and blocks private ranges by default.
- Extension code defaults to `node:vm`; use `isolated-vm` or Docker for untrusted code.

Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

---

## Contributing

Issues and PRs are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and keep security
reports private per [SECURITY.md](./SECURITY.md).

Before opening a PR:

```bash
pnpm -r typecheck && pnpm -r test && pnpm lint
```

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
