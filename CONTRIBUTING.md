# Contributing to Agentis

Thanks for helping make Agentis better. This repository is early, ambitious, and
security-sensitive, so the best contributions are small, well-scoped, and easy to
review.

## Before You Start

- Open an issue for substantial behavior changes, new runtimes, or new workflow
  primitives.
- Keep secrets, local databases, generated assets, and `.agentis/` data out of
  commits.
- Report vulnerabilities privately through GitHub Security Advisories. Do not
  open public security issues.

## Development Setup

```bash
pnpm install
pnpm doctor
pnpm dev:full
```

Agentis requires Node.js 20.10 or newer and pnpm 9.12.

## Pull Request Checklist

Before opening a PR, run the checks that match your change:

```bash
pnpm -r typecheck
pnpm -r test
pnpm lint
pnpm build
```

Use focused commits and describe the user-visible behavior, test coverage, and
any security implications in the PR body.

## Project Boundaries

- `apps/api` owns the backend, workflow engine, runtime adapters, routes, and
  services.
- `apps/web` owns the React application.
- `packages/core` owns shared types, schemas, constants, and contracts.
- `packages/db` owns schema and migrations.
- `packages/cli` owns the installable `agentis` command.

Prefer existing contracts and validation paths over adding parallel abstractions.
