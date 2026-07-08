# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Report privately via
GitHub Security Advisories ("Report a vulnerability" on the repo's Security tab),
or email the maintainers. We aim to acknowledge within 72 hours and to ship a fix
or mitigation for confirmed high-severity issues before public disclosure.

## Threat model — read this before running Agentis

Agentis is an **agentic workflow engine that runs locally and executes code on
your host**. That is its purpose, and it shapes the threat model:

- Workflows can run agent CLIs (Claude Code, Codex, Cursor, …) and extensions.
  Agent CLIs are launched with their approval gates bypassed so Agentis can drive
  approvals itself — meaning **a workflow can run commands and touch files with
  your user's privileges**.
- Extensions execute code. With `isolated-vm` or Docker they are sandboxed; the
  built-in `node:vm` fallback is **not** a security boundary (see below).
- Data an agent ingests from the web, files, or channels is **untrusted** and can
  contain indirect prompt-injection payloads that try to steer the agent.

**Run Agentis as you would run untrusted code you are supervising.** Do not point
it at credentials or a host you are not willing to expose to the workflows you run,
and be deliberate about which extensions and agent tools you enable.

### Hardening the runtime (recommended for anything beyond local experimentation)

| Control | Env / action | Why |
|---|---|---|
| Hardened extension sandbox | `pnpm add -w isolated-vm` **or** `AGENTIS_EXTENSION_DOCKER=true` | The `node:vm` fallback is escapable — a determined extension can reach host globals via the constructor chain. Install a real isolate for untrusted/registry/agent-authored extensions. |
| Fail-closed on weak sandbox | `AGENTIS_EXTENSION_REQUIRE_ISOLATE=true` | Refuses to run `node_worker` extensions unless a hardened isolate is present, instead of silently falling back to `node:vm`. |
| Bind to loopback only | `AGENTIS_HTTP_HOST=127.0.0.1` (default) | Never expose the API on `0.0.0.0` without an authenticating reverse proxy. |
| Encrypt data at rest | OS full-disk encryption on `AGENTIS_DATA_DIR` | The credential-vault master key (`secrets.json`) lives beside the SQLite DB; at-rest security equals your file permissions on the data dir. **Do not** place the data dir or backups in a synced/shared folder (OneDrive, NAS). |
| Keep private-network egress off | leave `AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE` unset | Outbound HTTP from extensions/agents is SSRF-guarded and pinned to the validated IP; only opt into private-network access if you truly need it. |

## What's built in

- **Credential vault** — AES-256-GCM authenticated encryption for secrets at rest,
  with key rotation. No plaintext-storage fallback.
- **SSRF guard + IP pinning** — outbound HTTP on agent/extension paths is validated
  (RFC-1918 / loopback / link-local / IMDS blocked) and the connection is pinned to
  the checked IP, with every redirect hop re-validated (defeats DNS rebinding).
- **Secret-scoped child environments** — Agentis-internal secrets (vault key, JWT
  private key, orchestrator/synthesis API keys, deploy tokens, OAuth client
  secrets) are stripped from every spawned child process's environment. Generic
  provider keys the agent needs (e.g. `ANTHROPIC_API_KEY`) still pass through.
- **Prompt-injection gate** — tool results in a chat turn are scanned for injection
  carriers (invisible/bidi characters, fake system/role headers, override and
  exfiltration phrasing, embedded tool-call markers). A hit taints the turn: the
  content is sanitized and re-presented as untrusted data, and any high-impact tool
  (`extension.create`/`test`, `channel.send`, `deploy`, `command.*`, `workflow.*`,
  any mutating tool) then requires operator confirmation **even in `auto` mode**.
- **Log redaction** — the logger masks secret-shaped values (Bearer tokens,
  `sk-…`/`ghp_…` keys, JWTs) and secret-named fields before any log line or event
  is emitted.
- **Sandbox execution cap** — concurrent `node_worker`/Docker extension executions
  are bounded (`AGENTIS_EXTENSION_MAX_CONCURRENT`, default 8) to prevent resource
  exhaustion from a runaway or injected extension loop.
- **Expression sandbox** — `code`/transform expressions run in a VM realm with code
  generation from strings disabled and a static token guard; no host I/O callables
  are exposed. Covered by adversarial escape tests in CI.
- **Auth** — bearer JWT + hashed API keys; per-IP and per-credential login rate
  limiting; loopback bind and CORS/WS origin allowlist by default.
- **CI security rails** — `pnpm lint` runs architectural + security invariant
  checks; the `security` workflow runs dependency audit, secret scanning, and
  CodeQL on every PR.
