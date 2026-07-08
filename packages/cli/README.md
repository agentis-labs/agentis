# @agentis-ai/cli

[![npm](https://img.shields.io/npm/v/@agentis-ai/cli.svg)](https://www.npmjs.com/package/@agentis-ai/cli)
[![license](https://img.shields.io/npm/l/@agentis-ai/cli.svg)](https://github.com/agentis-labs/agentis/blob/main/LICENSE)

The command-line launcher for **Agentis** — the operating system for agentic software.
Self-hostable and local-first: SQLite, an embedded HTTP + WebSocket server, and a bundled
React dashboard all ship in this package, with zero external dependencies.

## Quick start

```sh
npm install -g @agentis-ai/cli
agentis up
```

Then open <http://127.0.0.1:3737>. The first boot prints an operator **username and
password** to the console — copy them; Agentis will not print them again.

Try it without installing:

```sh
npx @agentis-ai/cli up
```

## What you get on first boot

1. An RSA-2048 keypair for JWTs and an AES-256 key for the credential vault, written to
   `.agentis/secrets.json` with `chmod 0o600`.
2. An embedded SQLite database at `.agentis/agentis.db` (WAL mode, foreign keys on).
3. A seeded `operator` user, a `Personal` workspace, and a `Local` ambient.
4. The dashboard served from `http://127.0.0.1:3737`.

Everything runtime lives under `AGENTIS_DATA_DIR` (default `.agentis`).

## Commands

```text
agentis up                         Start Agentis (default if no command is given).
agentis bootstrap ...              Commission an orchestrator/manager/specialist via the API.
agentis create <dir>               Scaffold a code-authored Agentic App.
agentis app <pack|validate|install|test|export> ...   Work with .agentisapp packages.
agentis backup [--out <dir>]       Snapshot the data dir.
agentis restore <dir> [--force]    Restore a backup directory into the data dir.
agentis help                       Show the full command reference.
```

Run `agentis help` for the complete flag reference.

## Environment

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `AGENTIS_DATA_DIR` | SQLite DB, secrets, agent homes, backups. | `.agentis` |
| `AGENTIS_HTTP_PORT` | HTTP + WebSocket port. | `3737` |
| `AGENTIS_HTTP_HOST` | Bind host. | `127.0.0.1` |
| `AGENTIS_SEED_USERNAME` | Operator username on first boot. | `operator` |
| `AGENTIS_SEED_PASSWORD` | Operator password on first boot. | random |

See [`.env.example`](https://github.com/agentis-labs/agentis/blob/main/.env.example) for the full set.

## Requirements

- Node.js **>= 20.10.0**
- A modern browser (Chromium 110+, Firefox 110+, Safari 16.4+)

## Learn more

- Project: <https://github.com/agentis-labs/agentis>
- Technical guide: <https://github.com/agentis-labs/agentis/tree/main/docs>
- Issues: <https://github.com/agentis-labs/agentis/issues>

## License

Apache-2.0
