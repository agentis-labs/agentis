# Deployment

Agentis V1 deploys as a single Node process that serves the API, WebSocket bridge, workflow engine, and built web dashboard. The production path is embedded SQLite plus file-backed secrets in `AGENTIS_DATA_DIR`.

## Supported Runtime

- Node.js 20.10 or newer.
- A persistent writable data directory for `data.db`, `secrets.json`, backups, and local runtime files.
- SQLite is the supported V1 database. Postgres standard mode has schema/driver scaffolding, but the API and engine still use the SQLite handle internally and will reject standard mode at boot.

## Local CLI

```bash
npm install -g @agentis-ai/cli
agentis up
```

The CLI opens the dashboard and prints the first operator credential once. For a predictable data location, set:

```bash
AGENTIS_DATA_DIR=/var/lib/agentis agentis up
```

## Docker Compose

```bash
docker compose up --build
```

The compose file maps the app to `http://127.0.0.1:3737` and stores data in the `agentis_data` Docker volume. For server use, keep that volume persistent and back it up.

## Single Container

```bash
docker build -t agentis .
docker run --rm -p 3737:3737 -v agentis_data:/data agentis
```

The image sets:

```bash
AGENTIS_DATA_DIR=/data
AGENTIS_HTTP_HOST=0.0.0.0
AGENTIS_HTTP_PORT=3737
```

## Railway

The repository includes `railway.toml` and a README deploy button that build from the Dockerfile. Attach persistent storage for `/data` before relying on it for real work. Without a persistent volume, the SQLite database and generated secrets can be lost when the container is replaced.

Recommended variables:

```bash
AGENTIS_DATA_DIR=/data
AGENTIS_HTTP_HOST=0.0.0.0
AGENTIS_HTTP_PORT=${PORT}
AGENTIS_SEED_USERNAME=operator
AGENTIS_SEED_PASSWORD=<set once for first boot>
```

If the platform injects `PORT`, map it to `AGENTIS_HTTP_PORT`. Do not set `AGENTIS_TEST_MODE` outside automated tests.

## Environment Variables

| Variable | Default | Notes |
|---|---:|---|
| `AGENTIS_DATA_DIR` | `.agentis` | Persistent data and generated secrets. |
| `AGENTIS_HTTP_HOST` | `127.0.0.1` | Use `0.0.0.0` in containers. |
| `AGENTIS_HTTP_PORT` | `3737` | HTTP and WebSocket server port. |
| `AGENTIS_SEED_USERNAME` | `operator` | Used only when the first user is seeded. |
| `AGENTIS_SEED_PASSWORD` | random | Printed once when omitted. Set explicitly for non-interactive server boot. |
| `AGENTIS_JWT_PRIVATE_KEY` / `AGENTIS_JWT_PUBLIC_KEY` | generated | Optional env overrides for file-backed JWT keys. |
| `AGENTIS_CREDENTIAL_KEY` | generated | Optional env override for the AES-256-GCM vault key. |
| `AGENTIS_SKILL_DOCKER` | `false` | Enables docker-sandbox skill execution. |
| `AGENTIS_WORKFLOW_PARALLELISM` | `auto` | Engine parallelism setting. |
| `AGENTIS_DATABASE_URL` | unset | Reserved for future Postgres standard mode; not supported by the V1 runtime path. |

## Backups

Use the CLI backup command when running from a local install:

```bash
agentis backup --out ./agentis-backup
```

For containers, also back up the whole `AGENTIS_DATA_DIR` volume while the process is stopped or after taking an application-level backup. The important files are `data.db`, SQLite WAL/SHM files if present, and `secrets.json`.

## Health Check

The API exposes:

```text
GET /healthz
```

Use it for container or platform readiness checks.
