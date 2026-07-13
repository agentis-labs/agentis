# @agentis-labs/cli

[![npm](https://img.shields.io/npm/v/@agentis-labs/cli.svg)](https://www.npmjs.com/package/@agentis-labs/cli)
[![license](https://img.shields.io/npm/l/@agentis-labs/cli.svg)](https://github.com/agentis-labs/agentis/blob/main/LICENSE)

## Own the agents. Rent the models.

Agentis is the open-source, self-hosted command center for agents you own. Import the
agents you already run, give them a permanent Brain of memory and skills, swap the model
underneath them anytime, and ship what they build as real apps, workflows, and channels
from your own machine.

Agents should not disappear when a vendor changes, a subscription ends, or a local process
restarts. Agentis gives them durable identity, memory, orchestration, tools, approvals,
and a live product surface they can operate with you.

> **Status: pre-release (0.2.x).** Agentis is already usable, but APIs may still change
> before 1.0.

This package launches the whole local runtime: API, WebSocket bridge, workflow engine,
embedded SQLite, credential vault, and bundled React dashboard.

## Start in one line

```sh
npx @agentis-labs/cli@latest up
```

Works on macOS, Linux, and Windows PowerShell with Node.js >= 20.10 installed.
Agentis boots at `http://127.0.0.1:3737`, creates local secrets, initializes SQLite,
seeds the first operator user, and serves the dashboard from the same process.

Prefer a persistent binary?

```sh
npm install -g @agentis-labs/cli
agentis up
```

## Why Agentis

- Permanent Brain: local semantic memory, knowledge bases, living skills, cited answers.
- Agentic apps: typed data, generated interfaces, actions, run monitors, approvals.
- Self-healing workflows: durable graphs, replay, checkpoints, verdicts, honest repair.
- Runtime freedom: Claude Code, Codex, Cursor, Antigravity, Hermes, OpenClaw, local models.
- Omni-Reach: Slack, Telegram, WhatsApp, email, webhooks, MCP, A2A, and integrations.
- Sovereignty: SQLite, secrets, assets, logs, and memories stay under your data directory.

## What You Can Build

- Agent-run internal tools with durable data, live ops, approvals, and memory.
- Self-healing workflows that replay, diagnose, and improve from real outcomes.
- Specialist fleets that use Claude Code, Codex, Cursor, local models, or custom HTTP agents.
- Agentic apps that package workflows, interfaces, collections, and tests into `.agentisapp`.
- Channel-native agents that respond across Slack, Telegram, WhatsApp, email, MCP, and A2A.

## First Boot

1. An RSA-2048 keypair for JWTs and an AES-256 key for the credential vault.
2. An embedded SQLite database at `.agentis/agentis.db`.
3. A seeded `operator` user, `Personal` workspace, and `Local` ambient.
4. The dashboard served from `http://127.0.0.1:3737`.

Everything runtime lives under `AGENTIS_DATA_DIR` by default.

## Commands

```text
agentis up                         Start Agentis (default if no command is given).
agentis bootstrap ...              Commission an orchestrator, manager, or specialist.
agentis create <dir>               Scaffold a code-authored Agentic App.
agentis app <pack|validate|install|test|export> ...   Work with .agentisapp packages.
agentis backup [--out <dir>]       Snapshot the data dir.
agentis restore <dir> [--force]    Restore a backup directory into the data dir.
agentis help                       Show the full command reference.
```

## Requirements

- Node.js >= 20.10.0
- A modern browser

## Learn more

- Project: <https://github.com/agentis-labs/agentis>
- Technical guide: <https://github.com/agentis-labs/agentis/tree/main/docs>
- Issues: <https://github.com/agentis-labs/agentis/issues>

## License

Apache-2.0
