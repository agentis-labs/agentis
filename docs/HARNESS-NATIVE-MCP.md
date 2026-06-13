# Harness-Native MCP — the harness IS the brain, Agentis is its tool surface

> **Status:** implemented + unit-tested, **ZERO-CONFIG and ON by default**
> (URL auto-derived, token auto-minted; opt out with `AGENTIS_HARNESS_MCP=false`).
> The one part that needs live binaries to validate is the CLI's own MCP client
> handshake (standard transports). Companion to the harness-first model UX
> (Settings → Runtimes is an *optional* override) — this is its performance half.
>
> **Product rule honored:** the user only adds their agent + harness. No model to
> pick, no URL, no token, no flag. The platform derives the loopback URL, mints a
> workspace-scoped key, and mounts itself as the harness's tool surface.

## The problem it solves

A CLI harness (Codex, Claude Code) authenticates through the tool itself and has
**no streaming function-calling API**. So today, to let it use Agentis tools, the
platform runs the **marker protocol**: it asks the model (in text) to emit
`[[TOOL: …]]` markers, parses them, executes the tool, then **re-spawns the CLI**
with the result appended. An N-step task = **N cold starts** of the CLI, each
re-reading the whole conversation. That is the entire "a single task takes
minutes / it got slower over time" complaint (compounded, separately, by the
per-turn DB scans and prompt growth — both already fixed).

Asking the user to configure a *second*, native model just to get speed violates
the product principle ("the harness you set up is the brain; double-config is
bad"). So the fix must keep the harness as the brain **and** make it fast.

## The design

Agentis already exposes **every chat/engine tool** over a protocol-compliant MCP
endpoint — `POST /v1/mcp/rpc` (`initialize` / `tools/list` / `tools/call`), the
same `AgentisToolRegistry` the chat and engine use ("one registry, many
projections"). Both Codex and Claude Code can **mount an MCP server and call its
tools inside a single invocation**, running their *own* agentic loop.

So: point the harness at Agentis's own MCP server. The harness runs one process,
calls Agentis tools natively over MCP (executed server-side, same registry, full
canvas/realtime side-effects), and returns the final answer. **N re-spawns → 1.**
No second model. The harness stays the brain.

```
  Before (marker_protocol)                 After (mcp_native)
  ─────────────────────────                ──────────────────
  platform → spawn CLI ───┐                platform → spawn CLI (once)
       ↑ tool result      │ markers              │  ⇅ MCP tools/call
  execute tool ←──────────┘                Agentis /v1/mcp/rpc  (same registry)
       ⟳ re-spawn per round                      │
                                           CLI returns final answer
```

## Components (all shipped)

1. **`McpHarnessSessionService`** (`apps/api/src/services/mcpHarnessSession.ts`)
   — resolves, per workspace, the Agentis MCP descriptor the harness mounts:
   `{ name: 'agentis', url: <publicUrl>/v1/mcp/rpc, headers: { authorization,
   x-agentis-workspace, x-agentis-ambient } }`. Feature-flagged + env-driven
   (`AGENTIS_HARNESS_MCP`, `AGENTIS_HARNESS_MCP_URL`/`AGENTIS_PUBLIC_URL`,
   `AGENTIS_HARNESS_MCP_TOKEN`).

2. **`harnessMcpArgs(adapterType, servers)`** — pure, per-CLI transport mapping:
   - **Claude Code** speaks streamable-HTTP MCP natively →
     `--strict-mcp-config --mcp-config '{"mcpServers":{"agentis":{"type":"http","url",…,"headers":…}}}'`.
   - **Codex** mounts MCP over stdio → bridge the remote endpoint with the
     standard `mcp-remote` proxy, injected via `-c mcp_servers.agentis.*` TOML
     overrides (no global config-file mutation).

3. **`toolForwarding: 'mcp_native'`** capability (`packages/core/types/adapter.ts`).
   The Codex/Claude adapters report it when `mcpServers` are wired, and in that
   mode their chat prompt drops the marker instructions entirely (just the
   conversation + "use your `agentis` MCP tools").

4. **Single-shot chat loop** (`ChatSessionExecutor.#executeLoop`). When the
   resolved adapter is `mcp_native`, the platform makes **one** chat pass,
   streams its output (including informational tool-call deltas for the UI), and
   stops — it never drives the marker round-trip or re-executes the harness's
   tools (the harness already ran them over MCP).

5. **Wiring** (`agentCommission.registerAdapter` + `agentRuntimeHydrator` +
   bootstrap). On boot, every CLI harness is (re-)registered with the Agentis MCP
   server when the flag is on. Off by default → existing marker path untouched.

## Security

The harness presents `Authorization: Bearer <token>` + `x-agentis-workspace`.
The harness runs locally (same trust boundary as the API), so a workspace-scoped
operator token is acceptable for self-hosted deployments. Multi-tenant
deployments should mint a **short-lived, session-scoped** token — swap the source
in `McpHarnessConfig.token`, the shape and call sites don't change. The Claude
config uses `--strict-mcp-config` so the chat is hermetic (ignores any user-level
`.mcp.json`).

## Verification

- `mcpHarnessSession.test.ts` — descriptor + per-CLI arg generation + env config.
- `chatSessionExecutor.test.ts` — an `mcp_native` harness is invoked exactly once
  (no re-spawn) and its tool calls are surfaced but not re-executed.
- core/api typecheck clean.
- **Remaining:** live handshake with the installed CLIs (`mcp-remote` for Codex,
  native HTTP for Claude Code) — flag-gated, so it ships dark until validated.

## Why this is the right architecture

It removes the friction at the root: **no second model, no double-config**. The
user configures their harness once; Agentis hands it the platform as a native MCP
tool surface; the harness runs its own loop fast. Settings → Runtimes stays a pure
optional override for power users who want a *different* model per cognition role.
