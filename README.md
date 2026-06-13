# Agentis

**Self-hostable, multi-agent orchestration with a workflow canvas, a ledger,
and an inbox.** Agentis runs on your laptop or your server with zero external
dependencies. It speaks to OpenClaw fleets, Claude Code sessions, Codex,
Cursor, Hermes Agent, and local HTTP models through the same NormalizedTask
contract.

> Status: **V1 — pre-release (0.1.x).** Spec 1.4.0 implementation is complete
> and typechecks cleanly across the workspace. The CLI is published as
> [`@agentis-ai/cli`](https://www.npmjs.com/package/@agentis-ai/cli). 1.0.0
> ships after the full test pass. See [DECISIONS.md](docs/DECISIONS.md) for
> the design ledger.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fnexseed%2Fagentis)

## Quickstart

### 60-second local start

```bash
# macOS / Linux / WSL
curl -fsSL https://get.agentis.dev/install.sh | sh

# Windows PowerShell
iwr -useb https://get.agentis.dev/install.ps1 | iex

# Or, with Docker
docker compose up
```

Both flows boot the API on `127.0.0.1:3737` and print the seeded operator
password **once** to the console.

### As an operator (npm)

Install once, run anywhere:

```bash
npm install -g @agentis-ai/cli
agentis up
```

Then open <http://127.0.0.1:3737>. The first boot prints the operator
username and password **once** — copy them now.

Or try without installing:

```bash
npx @agentis-ai/cli up
```

From a clone:

```bash
pnpm install
pnpm --filter @agentis-ai/cli start up
```

The first boot:

1. Generates an RSA-2048 keypair for JWTs and an AES-256 key for the credential
   vault. Both are written to `.agentis/secrets.json` with `chmod 0o600`.
2. Initialises an embedded SQLite database in `.agentis/agentis.db` with WAL
   mode and foreign keys enabled.
3. Seeds an `operator` user (random base64url password, **printed once** to
   the console — copy it now), a `Personal` workspace, a `Local` ambient,
   and the `echo` + `http_fetch` builtin skills.
4. Starts the HTTP + WebSocket server on `127.0.0.1:3737`.

Open the dashboard at `http://127.0.0.1:5173` (in dev) and sign in.

### As a contributor

```bash
pnpm install
pnpm -r typecheck             # validates every package
pnpm -r test                  # vitest across packages
pnpm doctor                   # preflight: Node, ports, sqlite, secrets
pnpm dev:full                 # api on :3737 + web on :5173 in one terminal
```

## Architecture map

```
apps/
  api/            Headless backend (Hono + socket.io + WorkflowEngine)
  web/            React + Vite SPA (canvas + ledger + inbox)
packages/
  core/           Shared types, error codes, Zod schemas, constants
  db/             Drizzle schema (sqlite + pg dialects), embedded init SQL
  cli/            `agentis up` entrypoint
docs/
  V1-SPEC.md            The contract this code implements
  AGENTISHUB-SPEC.md    Future Hub product (separate codebase)
  DECISIONS.md          Design ledger
  researches/           Background research that informed the spec
```

### The engine in one paragraph

`WorkflowEngine` owns a `ReadyQueue` and a `WaitingInputBuffer` per active run.
Each tick drains the ready queue up to a configurable parallelism, dispatches
each node by its `config.kind` (skill, agent, router, merge, checkpoint,
scratchpad, subflow, trigger), and either completes the node synchronously
(builtin skills, scratchpad ops, routers) or registers an active-execution
record for asynchronous completion (agent tasks, checkpoints). Every state
transition appends a monotonic ledger event and publishes a realtime envelope
on the `EventBus`. The engine snapshots run state every 50 events so partial
replay can resume from a recent point — see D16.

### The realtime spine

`EventBus` is a single interface (`publish(room, event, payload)` +
`subscribe(listener)`). The default implementation wraps Node's `EventEmitter`.
A WebSocket bridge subscribes once and forwards envelopes to socket.io rooms.
Clients subscribe to `subscribe:workspace`, `subscribe:run`, or
`subscribe:workflow` after handshake-time JWT validation; ownership is
re-checked server-side before any room is joined.

### The validation contract

Every external boundary parses through Zod. Workflow node configs are a
discriminated union on `kind`, which makes the engine's dispatch switch
exhaustive at the type level. Conditional expressions (router branches,
checkpoint guards) parse through a hand-written recursive-descent grammar —
not `eval`, not `expr-eval`. See D07.

## What's in V1

- ✅ Multi-tenant data layer with workspace/ambient isolation enforced at
  every route via `requireWorkspace` middleware.
- ✅ Auth: bcrypt passwords, RS256 JWTs (access + refresh, with `kind`
  claim), credential vault with AES-256-GCM.
- ✅ Workflow engine: ready queue, waiting buffer, snapshots, ledger,
  realtime, eight node kinds, live graph patches, partial replay.
- ✅ Skill runtime: `builtin` (echo + http_fetch), `node_isolate`
  (vm sandbox), `docker_sandbox` (opt-in).
- ✅ Adapters: OpenClaw, Claude Code, Codex, Cursor, Hermes Agent, and HTTP — normalised through
  `AdapterManager` + `CircuitBreaker`.
- ✅ Trigger runtime: manual, cron, webhook, persistent listener.
- ✅ Subflows, conversation continuity, channel bridge
  (Discord + webhook + HTTP).
- ✅ Approval inbox, activity feed, dashboard fleet overview, command
  palette (Cmd/Ctrl-K), conversations dock, onboarding strip.
- ✅ React Flow canvas with the design-locked node card styling.
- ✅ Static-serve dashboard from the backend in production builds (D21).
- ✅ Skill registry: scan, install, hash + permission gating (D18).

## Roadmap (post-V1)

Tracked in [DECISIONS.md](docs/DECISIONS.md):

- Distributed run sharding for horizontally-scaled deployments
- AgentisHub: external skill + workflow registry product (separate codebase)
- Optional managed control plane

## Security posture

- OWASP A01: workspace isolation re-checked on every authenticated request.
- OWASP A02: AES-256-GCM with auth-tag verification on the credential vault.
- OWASP A03: discriminated-union validation on every workflow node; safe
  expression parser with no `eval`.
- OWASP A05: secrets file is `chmod 0o600` on first write; no secrets in
  logs.
- OWASP A07: bcrypt cost 12; refresh tokens carry a `kind` claim that
  rejects refresh-as-access replay (D04).
- OWASP A09: structured logger with JSON output in production; no stack
  traces leak from the error middleware.
- OWASP A10: `http_fetch` enforces a `http`/`https` protocol allowlist
  (host allowlist is DEBT — see D11).

## Layout of this repo

```
agentis/
  apps/api/src/
    bootstrap.ts         Composition root
    engine/              WorkflowEngine + SafeConditionParser + graph validator
    services/            Auth, ledger, scratchpad, activity, approvals, skills, vault
    routes/              /v1/{auth,workspaces,workflows,runs,...}
    middleware/          requireAuth, requireWorkspace, errorHandler
    websocket/           socket.io bridge over the in-process EventBus
  apps/web/src/
    pages/               LoginPage, FleetOverviewPage, WorkflowCanvasPage, ...
    lib/                 api.ts (auth-aware fetch), realtime.ts (socket hook)
  packages/core/         Types, schemas, errors, constants, event names
  packages/db/sqlite/    Drizzle schema + embedded init SQL
  packages/cli/          `agentis up`
```

See `docs/V1-SPEC.md` for the full product contract this code is built to.
