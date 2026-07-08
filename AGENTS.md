# Agentis - Agent Setup Instructions

This file is for AI agents configuring Agentis from inside this repository.
If you are a human, start with README.md.

## Quick start

Installed CLI:

```bash
agentis bootstrap --url http://127.0.0.1:3737 --api-key <key> --name "The Brain" --adapter claude_code
```

Repo-local CLI:

```bash
pnpm exec tsx packages/cli/src/index.ts bootstrap --url http://127.0.0.1:3737 --api-key <key> --name "The Brain" --adapter claude_code
```

## Get an API key

1. Start Agentis: `pnpm exec tsx packages/cli/src/index.ts up`
2. Open the URL printed by the server.
3. Sign in as the operator user.
4. Create an API key in Settings.

## Bootstrap rules

- Check for an existing orchestrator first with `GET /v1/agents?role=orchestrator`.
- Only one orchestrator should exist per workspace.
- If an orchestrator already exists, bootstrap as `--role manager` or `--role specialist` instead.
- The CLI resolves the first available workspace automatically unless `--workspace-id` is provided.
- Valid adapter values are `claude_code`, `codex`, `hermes_agent`, `openclaw`, `cursor`, and `http`.
- Pass channel secrets through environment variables, never hardcode them.

## Reflect an existing setup

Generate a portable config:

```bash
agentis bootstrap generate-config --from claude_code --output ./agentis-config.json
agentis export-config --from codex --output ./agentis-config.json
```

Import that config into Agentis:

```bash
agentis bootstrap --url http://127.0.0.1:3737 --api-key <key> --import ./agentis-config.json
```

## API

Direct bootstrap:

```http
POST /v1/bootstrap
Authorization: Bearer <key>
x-agentis-workspace: <workspace-id>
```

Config import:

```http
POST /v1/bootstrap/import
Authorization: Bearer <key>
x-agentis-workspace: <workspace-id>
```
