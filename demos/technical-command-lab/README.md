# Agentis Technical Command Lab

This is the first high-signal Agentis demo for technical users. It is deliberately isolated from the product code: it builds a portable `.agentis` workspace bundle, then optionally imports and hydrates it through the public HTTP API.

## Story

One operator asks Agentis to prepare three personal technical projects for public launch this week:

- audit repos and release blockers
- wire recurring automations
- gather research with citations
- prepare launch assets
- track outreach and lightweight budget approvals

Agentis demonstrates a hierarchy of managers and specialists, multiple operational apps, live workflow control, seeded records, approval gates, shared knowledge, and mock integrations.

## Apps

- **Command Center**: cross-project command surface for missions, managers, approvals, runs, and activity.
- **Repo Control**: repo health, release blockers, PR checklist, and engineering run monitor.
- **Automation Lab**: schedules, webhook simulations, retries, and integration health.
- **Research Desk**: sources, claims, citations, and knowledge ingestion.
- **Launch Studio**: scripts, screenshots, changelog, and publish queue.
- **Operator Desk**: contacts, follow-ups, decisions, and budget approvals.

## Build The Bundle

From this directory:

```bash
npm run build:bundle
```

This writes:

```text
bundles/agentis-technical-command-lab.agentis.json
```

## Import And Hydrate A Local Agentis Instance

Start Agentis in an isolated data dir from the repo root:

```bash
AGENTIS_DATA_DIR=.agentis-demo pnpm dev:full
```

Then import the demo bundle:

```bash
AGENTIS_URL=http://127.0.0.1:3737 \
AGENTIS_USERNAME=operator \
AGENTIS_PASSWORD=<printed-password> \
npm run seed
```

You can also use an API key:

```bash
AGENTIS_URL=http://127.0.0.1:3737 \
AGENTIS_WORKSPACE_ID=<workspace-id> \
AGENTIS_API_KEY=<agt_...> \
npm run seed
```

The seed script imports the `.agentis` bundle, inserts deterministic sample records, and patches app workflow bindings for schedules/chains.

## Mock Services

For live-mode demos without real third-party accounts:

```bash
npm run mock
```

The mock server exposes local endpoints for GitHub-like issues, CI, analytics, email, ads, and support events. Use these as safe targets when extending the demo workflows.

## Demo Modes

- **Cinematic mode**: use the seeded records and imported surfaces for screenshots and videos.
- **Live technical mode**: run app workflows from Agentis. They use deterministic nodes and approval gates, so the demo works without paid model keys. Real adapters can be attached to the seeded agents later.

