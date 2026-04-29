# @agentis-ai/cli

[![npm](https://img.shields.io/npm/v/@agentis-ai/cli.svg)](https://www.npmjs.com/package/@agentis-ai/cli)
[![license](https://img.shields.io/npm/l/@agentis-ai/cli.svg)](https://github.com/nexseed/agentis/blob/main/LICENSE)

The Agentis CLI — a one-command launcher for the **Agentis** proactive
ambient agent dashboard. Self-hostable, multi-agent orchestration with a
workflow canvas, an event ledger, and an approval inbox. Zero external
dependencies — SQLite, an embedded HTTP + WebSocket server, and a bundled
React SPA all ship in this package.

## Quick start

Install once, run anywhere:

```sh
npm install -g @agentis-ai/cli
agentis up
```

Then open <http://127.0.0.1:3737>. The first boot prints an operator
**username and password** to the console — copy them; Agentis will not print
them again.

After install, `agentis up` is always available — no internet, no
re-download, identical UX every reboot.

### Try it without installing

```sh
npx @agentis-ai/cli up
```

`npx` is the kick-the-tires path: it works offline-after-cache, but every
cold cache will redownload the package. Use the global install above for the
persistent always-available experience.

## What you get on first boot

1. An RSA-2048 keypair for JWTs and an AES-256 key for the credential vault,
   written to `.agentis/secrets.json` with `chmod 0o600`.
2. An embedded SQLite database at `.agentis/agentis.db` with WAL mode and
   foreign keys enabled.
3. A seeded `operator` user, a `Personal` workspace, a `Local` ambient,
   and the `echo` + `http_fetch` builtin skills.
4. The dashboard served from `http://127.0.0.1:3737` — workflow canvas,
   run inspector, approvals inbox, activity feed, command palette,
   conversations dock.

## Commands

```text
agentis up                              Start Agentis (default if no command given).
agentis backup [--out <dir>]            Snapshot the data dir into <dir>.
agentis restore <dir> [--force]         Restore a backup directory into the data dir.
                [--data-dir <dir>]      --force overwrites an existing agentis.db.
agentis help                            Show the help message.
```

## Environment

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `AGENTIS_DATA_DIR` | Where to store the SQLite DB and `secrets.json`. | `.agentis` |
| `AGENTIS_HTTP_PORT` | HTTP + WebSocket port. | `3737` |
| `AGENTIS_SEED_USERNAME` | Operator username on first boot. | `operator` |
| `AGENTIS_SEED_PASSWORD` | Operator password on first boot. | random |
| `AGENTIS_DATABASE_URL` | Postgres URL for "standard" mode (otherwise embedded SQLite). | — |
| `AGENTIS_WORKFLOW_PARALLELISM` | Max concurrent node dispatches per run (`auto`, `unbounded`, or an integer). | `8` |

## Requirements

- Node.js **>= 20.10.0**
- A modern browser (Chromium 110+, Firefox 110+, Safari 16.4+)

## What's in V1

- Workflow engine with eight node kinds (trigger, agent task, skill task,
  router, merge, checkpoint, subflow, scratchpad), partial replay, live
  graph patches, and a deterministic ledger.
- Multi-tenant data layer with per-workspace + per-ambient isolation
  enforced on every authenticated route.
- Bundled adapters: **OpenClaw**, **Claude Code**, **HTTP**.
- Skill runtime: builtin, `node_isolate` (vm sandbox), `docker_sandbox`
  (opt-in).
- Channels: Discord + webhook + outbound HTTP bridge.
- Approval inbox, activity feed, command palette (Cmd/Ctrl-K), conversations
  dock.
- Realtime UI over a single socket.io WebSocket.

See [V1-SPEC.md](https://github.com/nexseed/agentis/blob/main/docs/V1-SPEC.md)
for the full product contract this CLI is built to.

## Links

- Source: <https://github.com/nexseed/agentis>
- Issues: <https://github.com/nexseed/agentis/issues>
- Decisions ledger: <https://github.com/nexseed/agentis/blob/main/docs/DECISIONS.md>

## License

Apache-2.0
