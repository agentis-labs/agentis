# @agentis-ai/cli

The Agentis CLI — a one-command launcher for the Agentis proactive ambient agent dashboard.

## Quick start

Install once, run any time:

```sh
npm install -g @agentis-ai/cli
agentis up
```

Then open <http://127.0.0.1:3737>. The first boot prints an operator username and password — save them; Agentis will not print them again.

After a reboot, just run `agentis up` again.

> **Try it without installing:**
> ```sh
> npx @agentis-ai/cli up
> ```

## Commands

```text
agentis up                              Start Agentis (default if no command given).
agentis backup [--out <dir>]            Snapshot the data dir into <dir>.
agentis restore <dir> [--force]         Restore a backup directory into the data dir.
                [--data-dir <dir>]      --force overwrites an existing data.db.
agentis help                            Show the help message.
```

## Environment

| Variable | Purpose | Default |
| -------- | ------- | ------- |
| `AGENTIS_DATA_DIR` | Where to store data and secrets. | `.agentis` |
| `AGENTIS_HTTP_PORT` | HTTP port. | `3737` |
| `AGENTIS_SEED_USERNAME` | Operator username on first boot. | `operator` |
| `AGENTIS_SEED_PASSWORD` | Operator password on first boot. | random |
| `AGENTIS_DATABASE_URL` | *(optional)* PostgreSQL connection URL. Omit to use the built-in SQLite database — no setup required. | — |

## Requirements

- Node.js >= 20.10.0

## License

Apache-2.0
