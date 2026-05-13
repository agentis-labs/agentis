# HARNESS-CONFIG -- V1 Harness Specification

## Table of Contents

1. [Product Position](#1-product-position)
2. [V1 Harnesses](#2-v1-harnesses)
3. [Adapter Type Map](#3-adapter-type-map)
4. [Backend Contracts](#4-backend-contracts)
5. [Config Schemas](#5-config-schemas)
6. [Detection And Test Flow](#6-detection-and-test-flow)
7. [Frontend Contracts](#7-frontend-contracts)
8. [Credential Rules](#8-credential-rules)
9. [Verification Checklist](#9-verification-checklist)

---

## 1. Product Position

Agentis is an orchestration control plane for existing agent harnesses. The harness owns its model, reasoning loop, tool execution, and local/remote runtime. Agentis owns assignment, configuration, normalized events, history, workflow state, and operator UX.

Agentis does not download models, host models, route model-provider tokens for Kind A harnesses, or expose raw model endpoints in the V1 setup path.

All V1 harness integrations run in relay mode: Agentis dispatches a task to the harness and records the harness output as `NormalizedAgentEvent`.

## 2. V1 Harnesses

V1 must expose exactly these six user-facing choices:

| Harness | Internal `adapterType` | Transport | UI status |
|---|---|---|---|
| OpenClaw | `openclaw` | WebSocket gateway | Visible |
| Hermes Agent | `hermes_agent` | Local CLI subprocess | Visible |
| Claude Code | `claude_code` | Local CLI subprocess | Visible |
| Codex | `codex` | Local CLI subprocess | Visible |
| Cursor | `cursor` | Local CLI subprocess | Visible |
| HTTP / Webhook | `http` | HTTP(S) webhook | Visible |

Backend-only adapter types such as `hermes` and `local_llm` are Kind B direct-model adapters. They must not appear in V1 onboarding, agent creation, package detail views, or runtime settings.

Unavailable harnesses are not part of this spec. The V1 selector contains only the six visible harness choices listed above.

## 3. Adapter Type Map

The database and server use `adapterType`; the UI uses harness names and icons. Raw adapter strings must not be rendered to users.

| `adapterType` | User-facing label | Icon component |
|---|---|---|
| `openclaw` | OpenClaw | `OpenClawIcon` |
| `hermes_agent` | Hermes Agent | `HermesIcon` |
| `claude_code` | Claude Code | `ClaudeIcon` |
| `codex` | Codex | `CodexIcon` |
| `cursor` | Cursor | `CursorIcon` |
| `http` | HTTP / Webhook | `HttpIcon` |

Canonical type definitions live in [packages/core/src/types/adapter.ts](../packages/core/src/types/adapter.ts). The API allow-list lives in [apps/api/src/routes/agentMutations.ts](../apps/api/src/routes/agentMutations.ts). The web allow-list and labels live in [apps/web/src/components/agents/RuntimePicker.tsx](../apps/web/src/components/agents/RuntimePicker.tsx).

## 4. Backend Contracts

### 4.1 Agent Create And Update

Agent create/update uses:

```ts
{
  adapterType: 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http';
  config: Record<string, unknown>;
  runtimeModel?: string | null;
}
```

The `adapterType` is stored on the agent row. The `config` object stores adapter-specific fields only. On create and on config update, the API unregisters any existing adapter instance for that agent and registers the selected V1 adapter with the current config.

### 4.2 Normalized Events

Adapters emit only `NormalizedAgentEvent` values from `@agentis/core`:

| Event | Meaning |
|---|---|
| `task.started` | Harness accepted execution |
| `task.progress` | Text/progress line from the harness |
| `agent.thinking` | Structured thinking/status output |
| `agent.tool_call` | Harness reported a tool/function call |
| `task.completed` | Harness completed the task |
| `task.failed` | Harness failed or exited non-zero |
| `agent.session_message` | Mirrored OpenClaw session message |
| `agent.approval_requested` | OpenClaw execution approval request |
| `agent.status` | Harness status change |
| `agent.heartbeat` | OpenClaw connectivity heartbeat |

### 4.3 Adapter Implementations

| Adapter | File | Required behavior |
|---|---|---|
| OpenClaw | [apps/api/src/adapters/OpenClawAdapter.ts](../apps/api/src/adapters/OpenClawAdapter.ts) | Connect to `ws://`/`wss://`, send auth headers when configured, respond to `connect.challenge`, dispatch `task.dispatch`, include `agentName`, `sessionKey`, and payload template fields, normalize gateway events. |
| Hermes Agent | [apps/api/src/adapters/HermesAgentAdapter.ts](../apps/api/src/adapters/HermesAgentAdapter.ts) | Spawn `hermes`, pass model/max turns/session/extra args/env/timeout, parse JSON/JSONL/plain stdout, capture session id, emit normalized events, support cancellation. |
| Claude Code | [apps/api/src/adapters/ClaudeCodeAdapter.ts](../apps/api/src/adapters/ClaudeCodeAdapter.ts) | Spawn `claude --print --output-format=stream-json`, pass max turns/model/allowed tools/resume/extra args/env/timeout, use unattended permissions mode, capture session id, emit normalized events. |
| Codex | [apps/api/src/adapters/CodexAdapter.ts](../apps/api/src/adapters/CodexAdapter.ts) | Spawn `codex --json`, pass max turns/model/reasoning effort/fast mode/bypass/extra args/env/timeout, parse JSON events, emit normalized events. |
| Cursor | [apps/api/src/adapters/CursorAdapter.ts](../apps/api/src/adapters/CursorAdapter.ts) | Spawn `cursor --output-format stream-json`, pass model/resume/extra args/env/timeout, capture session id, emit normalized events. |
| HTTP | [apps/api/src/adapters/HttpAdapter.ts](../apps/api/src/adapters/HttpAdapter.ts) | Dispatch to HTTP(S), support method/headers/payload template/bearer auth/shared-secret HMAC/cancel URL/health URL/callback verification. |

## 5. Config Schemas

### 5.1 OpenClaw

```ts
{
  gatewayUrl: string;
  gatewayId?: string;
  deviceTokenCredentialId?: string;
  authCredentialId?: string;
  authToken?: string;
  headers?: Record<string, string>;
  password?: string;
  agentName?: string;
  sessionKeyStrategy?: 'issue' | 'fixed' | 'run';
  sessionKey?: string;
  disableDeviceAuth?: boolean;
  timeoutSec?: number;
  payloadTemplate?: Record<string, unknown>;
}
```

`sessionKeyStrategy` defaults to `issue`. The issue key falls back to `runId` when no `issueId` exists in task input data.

### 5.2 Hermes Agent

```ts
{
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
}
```

### 5.3 Claude Code

```ts
{
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}
```

### 5.4 Codex

```ts
{
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fastMode?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}
```

`dangerouslyBypassApprovalsAndSandbox` defaults to enabled for unattended relay execution unless explicitly set to `false`.

### 5.5 Cursor

```ts
{
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}
```

### 5.6 HTTP / Webhook

```ts
{
  baseUrl?: string;
  dispatchPath?: string;
  dispatchUrl?: string;
  cancelPath?: string;
  cancelUrl?: string;
  healthPath?: string;
  healthUrl?: string;
  authCredentialId?: string;
  sharedSecretCredentialId?: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  payloadTemplate?: Record<string, unknown>;
  dispatchTimeoutMs?: number;
}
```

The API accepts either `dispatchUrl` or `baseUrl + dispatchPath`. `cancelUrl` and `healthUrl` follow the same direct-or-derived pattern.

## 6. Detection And Test Flow

### 6.1 Detect Harnesses

Endpoint: `GET /v1/harness/detect`

Implementation: [apps/api/src/routes/harness.ts](../apps/api/src/routes/harness.ts) and [apps/api/src/services/harnessProbe.ts](../apps/api/src/services/harnessProbe.ts)

Response shape:

```ts
{
  harnesses: Array<{
    adapterType: 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http';
    harness: string;
    status: 'found' | 'not_found' | 'error';
    detail?: string;
    installCommand?: string;
  }>;
}
```

Probe rules:

| Harness | Probe |
|---|---|
| Claude Code | `claude --version`, then `where/which claude` |
| Codex | `codex --version`, then `where/which codex` |
| Cursor | `cursor --version`, then `where/which cursor` |
| Hermes Agent | `hermes --version`, then `where/which hermes` |
| OpenClaw | `AGENTIS_OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_URL`, or `OPENCLAW_GATEWAY` |
| HTTP / Webhook | Manual configuration only |

### 6.2 Test Harness

Endpoint: `POST /v1/agents/:id/test-harness`

Response shape:

```ts
interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
    detail?: string;
  }>;
}
```

Checks:

| Harness | Checks |
|---|---|
| OpenClaw | URL scheme is `ws`/`wss`, WebSocket connects, challenge is acknowledged when the gateway sends `connect.challenge`. |
| Hermes Agent | Binary probe succeeds. |
| Claude Code | Binary probe succeeds. |
| Codex | Binary probe succeeds. |
| Cursor | Binary probe succeeds. |
| HTTP / Webhook | Health/dispatch URL is valid HTTP(S), endpoint responds to `HEAD` or `GET`; `401` is treated as reachable with auth required. |

## 7. Frontend Contracts

### 7.1 Runtime Picker

Implementation: [apps/web/src/components/agents/RuntimePicker.tsx](../apps/web/src/components/agents/RuntimePicker.tsx)

Rules:

- Show `Detected on this machine` only when one or more probes return `found`.
- Always show `Connect a harness` with all six V1 choices.
- Keep adapter tiles compact and icon-first.
- Do not expose Kind B adapter types.
- Convert UI state to `{ adapterType, config, runtimeModel }` with `runtimeConfigToAdapterConfig()` and `runtimeModelFor()`.
- Convert stored agent config back to form state with `configToRuntimeConfig()`.

### 7.2 Agent Creation

Implementation: [apps/web/src/components/agents/AgentCreateWizard.tsx](../apps/web/src/components/agents/AgentCreateWizard.tsx) and [apps/web/src/components/agents/CommissionFlow.tsx](../apps/web/src/components/agents/CommissionFlow.tsx)

Create payloads must use real V1 adapter types only. Do not send `openai`, `anthropic`, `openai-compat`, `gateway`, `hermes`, or `local_llm` from V1 creation flows.

### 7.3 Agent Runtime Settings

Implementation: [apps/web/src/components/agents/AgentConfigPanel.tsx](../apps/web/src/components/agents/AgentConfigPanel.tsx)

Runtime settings lock the adapter type for existing agents. Operators can edit config, save runtime, and run `Test connection`.

### 7.4 User-Facing Labels

Any agent card, package detail, picker, settings panel, or list must use friendly harness labels. Use the shared RuntimePicker helpers where available; otherwise map unknown values to `Harness`.

## 8. Credential Rules

The UI stores credential references, not secret values. V1 runtime forms expose credential ID fields for OpenClaw, HTTP bearer auth, and HTTP shared-secret HMAC. API callers may pass compatibility fields such as `authToken` for OpenClaw, but server responses must not reveal secret material.

Credential-backed fields:

| Harness | Field |
|---|---|
| OpenClaw | `deviceTokenCredentialId`, `authCredentialId` |
| HTTP / Webhook | `authCredentialId`, `sharedSecretCredentialId` |

## 9. Verification Checklist

V1 is considered aligned with this spec when all items below are true:

- `AdapterType` and `AgentAdapterConfig` include all six V1 harnesses.
- API create/update allow exactly the six V1 harnesses.
- API registers `OpenClawAdapter`, `HermesAgentAdapter`, `ClaudeCodeAdapter`, `CodexAdapter`, `CursorAdapter`, and `HttpAdapter`.
- `GET /v1/harness/detect` is mounted under `/v1/harness`.
- `POST /v1/agents/:id/test-harness` returns `HarnessTestResult`.
- RuntimePicker shows all six V1 choices and hides Kind B adapters.
- Agent creation and commission flows use RuntimePicker config helpers.
- Agent config panel can save runtime config and test connection.
- Icon components exist under `apps/web/src/components/icons/` and are used in RuntimePicker.
- User-facing UI never prints raw adapter type strings.