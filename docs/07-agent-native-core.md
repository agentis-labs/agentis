# 07 · Agent-Native Core

The whole platform is exposed to agents as a single typed SDK they operate *as code*. This is
what makes Agentis agent-native rather than agent-adjacent: agents compose behavior in a
language they are fluent in, not by choreographing dozens of discrete tool calls.

## The `agentis.*` tool registry

`services/agentisToolRegistry.ts` + `services/agentisToolHandlers/`. One registry, dispatched
through a single path to chat, the workflow engine, MCP, and code-mode. **132 tools**; every
result is `{ ok, result | error, costCents, durationMs }` — errors are data, never thrown, and
every settled state carries `compass.next` (the Paved Road: an actionable next call).

Families (representative, not exhaustive):

- **Build & prove** — `build_workflow`, `workflow.{create,patch,validate,dry_run,scope,test,harden,restore_blueprint,bless,deliver}`, `plan_workflow`, `evaluate`, `reflect`, `workflow.{patterns,learn}`.
- **Run & observe** — `run.{await,status,diagnose,cancel,replay,inspect}`, `workflow.{status,list}`, `run.query`, `trace.inspect`, `ephemeral.run`.
- **Data & apps** — `app.{create,list,archive,delete,adopt_workflow,scaffold,plan}`, `data.{define_collection,insert,update,upsert,delete,query,promote_memory}`.
- **UI** — `ui.{render,patch,compose,perform_region,action_schema,lint}`.
- **Memory & knowledge** — `brain.search`, `memory.{write,read,delete}`, `knowledge.{write,search,archive}`, `skill.{load,promote_example}`.
- **Media & assets** — `media.generate`, `assets.{list,search,read,save}`, `browser.{screenshot,navigate,extract_text}`.
- **Channels & conversations** — `channel.{list,send}`, `connection.{request,grant,grants}`, `conversation.{define,enroll,flag_needs_attention}`.
- **Agents & specialists** — `agents.{list,create}`, `agent.{spawn,dispatch}`, `specialist.{create,request}`, `routing.preview`.
- **Extensions & capabilities** — `extension.{create,test,resolve,inspect}`, `extensions.list`, `capability.{search,load,invoke}`.
- **Experiments, tasks, subjects** — `experiment.{define,assign,record,results}`, `task.{accept,set_steps,advance_step,record_decision,flag_deviation,bind_run}`, `subject.{enroll,post,get,list}`.
- **Inspect & govern** — `orient`, `space.summary`, `audit_trail`, `approval.{list,resolve}`, `command.{review,note}`, `gateways.status`.

Most tools are `mcpExposed`, so external CLI/IDE harnesses (Claude Code, Codex, Cursor) call
the same surface. Plan-mode blocks mutating tools at the registry.

## Code-mode

`services/codeMode.ts`. Agents write async JavaScript against the whole registry as one
`agentis.*` object (`await agentis.workflow.run({...})`, loops, conditionals,
find-or-create-then-wire). Composition happens in code — where LLMs are strongest — instead of
in 70-tool JSON choreography (the Anthropic/Cloudflare result: ~150k → ~2k tokens).

Executed in a locked-down `node:vm` context: no ambient globals, a call cap, and a wall-clock
timeout (defaults: 30 calls, 20s). It is a capability surface + resource governor for the
operator's own trusted agents, **not** a hard security boundary. Returns
`{ ok, result, calls[], logs, error }` — never throws. `agentis.code.api()` returns the
callable surface for discovery. Tools: `agentis.code.{execute,api}`.

## Extensions

Agent-authored operations in a sandbox (`apps/api/src/extensions/`, `services/extensionRuntime.ts`):

- **Runtimes** — `node:vm` fallback (default, not a security boundary), `isolated-vm` V8
  isolate when installed (auto-downgrades otherwise), or opt-in Docker
  (`AGENTIS_EXTENSION_DOCKER`, `AGENTIS_EXTENSION_REQUIRE_ISOLATE`).
- **Permissions** — granular gates: `network`, `network.unrestricted`, `listener`,
  `listener.emit`, `database`. Injected `fetch` is SSRF-checked and IP-pinned.
- **State** — listener sources hook `ctx.emit()`, `ctx.cursor` / `ctx.setCursor`, and
  `ctx.kv` (workspace-scoped, `extension_kv`).
- **Build loop** — `agentis.extension.test` dry-runs an operation with sample inputs and
  returns real output + `durationMs`, catching contract violations before wiring it into a
  workflow. Tables: `extensions`, `agent_packages`, `extension_executions`. Routes:
  `/v1/extensions`, `/v1/packages`, `/v1/capabilities`, `/v1/tools`.

## Media, vision, assets

- `services/mediaService.ts` — `agentis.media.generate`: one capability that dispatches by
  modality (image / audio / speech / video) to a configured, provider-pluggable backend
  (OpenAI-compatible default, no vendor lock-in); supports generation and reference-image edit;
  outputs persist to the asset store.
- `services/visionService.ts` — image understanding; `services/transcriptionService.ts` —
  audio→text; `services/documentExtractionService.ts` — PDF/doc structure extraction.
- `services/assetStore.ts` — content-addressed, deduped by SHA-256; tracks origin (agent / app
  / workflow / channel / manual). Agents persist via `agentis.assets.save` rather than writing
  to disk.

---

Back to the [Agentis README](../README.md) · start over at [00 · Foundation](./00-foundation.md).
