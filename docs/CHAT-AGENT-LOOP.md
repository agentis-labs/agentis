# Chat Agentic Loop — Architecture Plan

> Status: **SPEC** — Not yet implemented.
> Owner: platform track. Touches `apps/api/src/adapters/**`, `apps/api/src/services/**`, `apps/api/src/routes/conversations.ts`, `packages/core/src/types/**`, `apps/web/src/components/ChatPanel/**`.
> Goal: Make the chat thread the primary control surface and intelligence layer of the Agentis platform. Every tool, every workflow, every agent on the platform is accessible and orchestrable from a single conversation with the orchestrator agent.

---

## 0. The Vision: Chat as Platform Brain

The Agentis platform has two runtimes today:

| Runtime | What it is | Trigger | Latency | Auditability |
|---|---|---|---|---|
| **Workflow Engine** | State-machine graph executor | NewTaskModal / scheduler / trigger | Seconds to hours | Full ledger, run history |
| **Chat Loop** (this doc) | Turn-by-turn interactive loop | Composer message | Milliseconds | Conversation thread |

Today only the Workflow Engine knows how to call tools. Chat is a dumb relay — it appends a string to `ConversationStore` and forwards it to the adapter raw. No skill execution. No platform control. No loop.

**The goal:** Chat becomes the platform brain. The orchestrator agent sitting in chat has every platform capability available as a tool. It can run workflows, inspect runs, manage approvals, search memory, design teams — all in one fluid, streaming, real-time conversation. The Workflow Engine becomes the autonomous background layer; chat is the interactive foreground.

Two runtimes. One shared executor. Zero new database tables.

---

## 1. State of the Art — What the Industry Has Converged On

Before designing anything, look at what every major LLM provider and framework has independently arrived at. The convergence is striking.

### 1.1 ReAct (Yao et al., 2022)

> Reasoning + Acting interleaved in thought chains.

```
Thought: I need to find the current workflow status.
Action: agentis.workflow.status({ runId: "run_abc123" })
Observation: { status: "RUNNING", progress: 0.6, currentNode: "email_node" }
Thought: The workflow is 60% done. I should tell the user.
Answer: Your workflow is running — 60% complete, currently processing the email node.
```

Key insight: the LLM narrates its own reasoning before each tool call. This makes tool use predictable, debuggable, and dramatically improves accuracy. Agentis should emit these `Thought:` blocks as a streaming `thinking` delta type so the UI can render them live.

### 1.2 OpenAI Tool Use Protocol

```
Request:
  messages: [...history]
  tools: [{ type: "function", function: { name, description, parameters } }]
  tool_choice: "auto"

Response (finish_reason: "tool_calls"):
  message.tool_calls: [{ id, type: "function", function: { name, arguments } }]

Inject result:
  { role: "tool", tool_call_id: <id>, content: JSON.stringify(result) }

Loop: POST again with updated messages array.
```

### 1.3 Anthropic Tool Use Protocol

```
Request:
  tools: [{ name, description, input_schema: { type: "object", properties } }]

Response (stop_reason: "tool_use"):
  content: [
    { type: "text", text: "I'll check the workflow status." },
    { type: "tool_use", id, name, input: {...} }
  ]

Inject result:
  { role: "user", content: [{ type: "tool_result", tool_use_id, content: "..." }] }
```

### 1.4 Gemini Function Calling

```
tools: [{ functionDeclarations: [{ name, description, parameters }] }]

Response: candidates[0].content.parts[].functionCall: { name, args }

Inject:
  { role: "user", parts: [{ functionResponse: { name, response } }] }
```

### 1.5 The Universal Loop Shape

Every system above — regardless of vendor or framework — resolves to the same shape:

```
while true:
  response = llm(system, history, tools)
  if response.stop_reason == "done":
    stream text to user; break
  if response.stop_reason == "tool_calls":
    for each tool_call in response.tool_calls:
      result = execute(tool_call.name, tool_call.args)
    history.push(assistant_turn, tool_results_turn)
    continue   // next LLM call with results injected
```

This is the **only loop we need to implement**. The Agentis Chat Agentic Loop is this loop, with Agentis platform tools as the tool catalog, and adapters as the LLM driver.

### 1.6 Key Lessons from Anthropic's "Building Effective Agents" (2024)

- **Simplest solution first.** The loop above is ~30 lines of code. No framework needed.
- **Invest in tool documentation.** Tool descriptions are as important as system prompts. Each tool needs: what it does, when to use it, parameter explanations, example inputs.
- **Transparency over magic.** Show the model's reasoning steps. Show tool calls happening. The user should feel like they're watching an expert work, not waiting for a black box.
- **Fail early, clearly.** Tool errors should return structured `{ error, message }` — never throw. The LLM handles errors better with a result than an exception.
- **Guard against compounding errors.** Set a `maxTurns` cap (default: 10). If the loop exceeds it, surface the partial result and stop.

---

## 2. The Architecture

### 2.1 System Overview

```
User (Composer)
      │
      ▼
POST /v1/conversations/:agentId/send
      │
      ▼
ChatSessionExecutor.turn(agentId, history, userMessage, ctx)
      │  ┌─────────────────────────────────────────┐
      │  │         AGENTIC LOOP                    │
      │  │                                         │
      │  │  history.push(user message)             │
      │  │        │                                │
      │  │        ▼                                │
      │  │  adapter.chat(history, TOOL_CATALOG)    │
      │  │        │                                │
      │  │        ▼                                │
      │  │  AsyncIterable<ChatDelta>               │
      │  │   ├─ { type: 'thinking', delta }  ──► SSE
      │  │   ├─ { type: 'text', delta }      ──► SSE
      │  │   └─ { type: 'tool_call', ... }        │
      │  │              │                          │
      │  │              ▼                          │
      │  │  ChatToolExecutor.run(name, args, ctx)  │
      │  │  (calls BUILTIN_REGISTRY[name] directly)│
      │  │              │                          │
      │  │              ▼                          │
      │  │  history.push(assistant + tool_result)  │
      │  │        │                                │
      │  │        └──────── loop ─────────────────┘
      │  │
      │  └─────────────────────────────────────────┘
      │
      ▼
ConversationStore.appendMirrored(finalText)
```

### 2.2 Core Types

```typescript
// packages/core/src/types/chat.ts

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
  toolCallId?: string;        // for role='tool' messages
  toolCalls?: ChatToolCall[]; // for role='assistant' messages that triggered tools
}

export interface ChatContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ChatDelta =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown; error?: string }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'max_turns' | 'error' };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ChatTurnContext {
  workspaceId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  maxTurns?: number; // default 10
}
```

### 2.3 ChatSessionExecutor

Single file: `apps/api/src/services/chatSessionExecutor.ts`

```typescript
export class ChatSessionExecutor {
  static async *turn(
    adapter: AgentAdapter,
    history: ChatMessage[],
    userMessage: string,
    ctx: ChatTurnContext
  ): AsyncIterable<ChatDelta> {
    const messages: ChatMessage[] = [
      ...history,
      { role: 'user', content: userMessage }
    ];
    const maxTurns = ctx.maxTurns ?? 10;
    let turns = 0;

    while (turns < maxTurns) {
      turns++;
      const pendingToolCalls: ChatToolCall[] = [];
      let assistantText = '';

      for await (const delta of adapter.chat(messages, CHAT_TOOL_CATALOG)) {
        yield delta;

        if (delta.type === 'text') assistantText += delta.delta;
        if (delta.type === 'tool_call') {
          pendingToolCalls.push({ id: delta.id, name: delta.name, arguments: delta.args });
        }
        if (delta.type === 'done' && delta.finishReason === 'stop') {
          // Natural stop — add assistant message to history and return
          messages.push({ role: 'assistant', content: assistantText });
          return;
        }
      }

      if (pendingToolCalls.length === 0) break;

      // Execute tool calls (can be parallel if LLM requested multiple)
      const toolResults = await Promise.all(
        pendingToolCalls.map(async (tc) => {
          const result = await ChatToolExecutor.run(tc.name, tc.arguments, ctx);
          yield { type: 'tool_result' as const, id: tc.id, name: tc.name, ...result };
          return { toolCallId: tc.id, name: tc.name, result };
        })
      );

      // Inject assistant turn + tool results into history
      messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: pendingToolCalls
      });
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(tr.result.data ?? tr.result.error),
          toolCallId: tr.toolCallId
        });
      }
    }

    // Max turns exceeded
    yield { type: 'done', finishReason: 'max_turns' };
  }
}
```

### 2.4 ChatToolExecutor

Single file: `apps/api/src/services/chatToolExecutor.ts`

```typescript
import { BUILTIN_REGISTRY } from './builtinSkills';

export class ChatToolExecutor {
  static async run(
    name: string,
    args: unknown,
    ctx: ChatTurnContext
  ): Promise<{ data?: unknown; error?: string }> {
    const executor = BUILTIN_REGISTRY[name];
    if (!executor) {
      return { error: `Unknown tool: ${name}` };
    }

    try {
      const result = await executor(
        args as Record<string, unknown>,
        null,   // no scratchpad in chat context
        { workspaceId: ctx.workspaceId, runId: undefined, taskId: undefined }
      );
      return { data: result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

**Key design insight:** `ChatToolExecutor.run()` calls `BUILTIN_REGISTRY[name]` directly. No new code paths, no duplication. The same executor functions that power workflow skill nodes also power chat tools. One registry, two runtimes.

### 2.5 CHAT_TOOL_CATALOG

Single file: `apps/api/src/services/chatToolCatalog.ts`

This is a `Record<string, ToolDefinition>` containing JSON schemas for every tool the orchestrator agent can call. It is distinct from `BUILTIN_REGISTRY` — the registry holds *executors*, the catalog holds *schemas for the LLM*.

```typescript
export const CHAT_TOOL_CATALOG: ToolDefinition[] = [
  // Full catalog defined in §3 below
];

export const CHAT_TOOL_CATALOG_MAP = Object.fromEntries(
  CHAT_TOOL_CATALOG.map(t => [t.name, t])
);
```

### 2.6 Adapter Interface Extension

Add `chat()` to the `AgentAdapter` interface in `packages/core/src/types/adapter.ts`:

```typescript
export interface AgentAdapter {
  // existing
  dispatchTask(task: NormalizedTask): Promise<void>;
  onEvent(handler: (event: NormalizedAgentEvent) => void): void;

  // new — optional, checked at runtime
  chat?(
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): AsyncIterable<ChatDelta>;
}
```

Adapters that do not implement `chat()` fall back to the legacy relay path (current behavior). This is backward compatible — nothing breaks.

### 2.7 SSE Streaming to the Client

The conversation `send` route upgrades to SSE when `Accept: text/event-stream` is present:

```
GET  /v1/conversations/:agentId/send  →  (current behavior, returns 200 when relay completes)
POST /v1/conversations/:agentId/send  →  SSE stream when Accept: text/event-stream
```

SSE event format:
```
event: delta
data: {"type":"thinking","delta":"I should check the workflow status first."}

event: delta
data: {"type":"text","delta":"Your workflow is "}

event: delta
data: {"type":"tool_result","id":"tc_1","name":"agentis.workflow.status","result":{...}}

event: delta
data: {"type":"text","delta":"currently 60% done."}

event: done
data: {"finishReason":"stop"}
```

The `ThreadView` component subscribes to this SSE stream and renders deltas incrementally, exactly like Perplexity or Claude.ai.

---

## 3. The Tool Catalog (Complete)

Every tool maps 1:1 to either an existing `BUILTIN_REGISTRY` entry or a new executor to be added.

### 3.1 Platform Control

| Tool | Description | Maps to |
|---|---|---|
| `agentis.workflow.run` | Start a workflow by ID with optional input | new executor |
| `agentis.workflow.status` | Get current status of a run by runId | new executor |
| `agentis.workflow.list` | List recent runs for the workspace | new executor |
| `agentis.apps.status` | Health check all connected agent gateways | new executor |
| `agentis.agents.list` | List all agents in the workspace | new executor |

### 3.2 Memory & Knowledge

| Tool | Description | Maps to |
|---|---|---|
| `agentis.memory.read` | Search workspace memory by query/kind | existing builtin |
| `agentis.memory.write` | Store a new memory entry | existing builtin |
| `agentis.knowledge.search` | Full-text search across workspace knowledge base | new executor |
| `agentis.knowledge.write` | Index a document or URL into the knowledge base | new executor |

### 3.3 Decisions & Approvals

| Tool | Description | Maps to |
|---|---|---|
| `agentis.approval.list` | List pending approvals for the workspace | new executor |
| `agentis.approval.resolve` | Approve or reject a pending approval | new executor |

### 3.4 Observability

| Tool | Description | Maps to |
|---|---|---|
| `agentis.audit_trail` | Read ledger events for a run | existing builtin |
| `agentis.run.query` | Query run history with filters | new executor |

### 3.5 Builder & Planner

| Tool | Description | Maps to |
|---|---|---|
| `agentis.build_workflow` | Generate or update a workflow graph | existing builtin |
| `agentis.team.design` | Propose an agent team structure | existing builtin |
| `agentis.plan` | Break a complex goal into ordered steps | new executor |
| `agentis.evaluate` | Score an artifact against criteria | new executor |
| `agentis.reflect` | Self-critique the current approach and suggest improvements | new executor |

### 3.6 Raw

| Tool | Description | Maps to |
|---|---|---|
| `http_fetch` | HTTP GET/POST to external URLs | existing builtin |

### 3.7 Example Tool Definition

```typescript
{
  name: 'agentis.workflow.status',
  description:
    'Get the current execution status of a workflow run. Use this when the user asks about ' +
    'a running workflow, wants to know if it finished, or asks for progress updates. ' +
    'Returns status (PENDING/RUNNING/COMPLETED/FAILED/CANCELLED), progress (0-1), ' +
    'currentNode name, and a summary of completed nodes.',
  parameters: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'The ID of the workflow run to check. Format: run_<uuid>.'
      }
    },
    required: ['runId']
  }
}
```

**Rule:** Every tool description must answer three questions: (1) what does this tool do, (2) when should the model use it, (3) what does it return. A tool description is a micro-docstring for the LLM.

---

## 4. Adapter Implementation Guide

### 4.1 HermesAdapter (Priority 1 — most common)

HermesAdapter already parses `tool_calls` from SSE streams via `extractToolCalls()`. The gap: it never sends a `tools` array to the LLM, and has no loop.

**Changes needed:**

```typescript
// In dispatchTask — existing path, no change
// New method:
async *chat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
  const body = {
    model: this.#config.model,
    stream: true,
    messages: this.#toChatML(messages),
    tools: tools.map(t => ({ type: 'function', function: t })),
    tool_choice: 'auto'
  };

  const response = await fetch(`${this.#config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#config.apiKey}` },
    body: JSON.stringify(body)
  });

  // Stream SSE, yield ChatDelta events
  // When finish_reason === 'tool_calls': yield { type: 'done', finishReason: 'tool_calls' }
  // When finish_reason === 'stop': yield { type: 'done', finishReason: 'stop' }
}
```

`#toChatML()` converts `ChatMessage[]` to OpenAI-compatible `{role, content}[]`, handling the `tool` role as `{ role: 'tool', tool_call_id, content }`.

### 4.2 ClaudeCodeAdapter

ClaudeCode receives tasks via stdin/CLI invocation. For chat mode:
- Convert `ChatMessage[]` to Anthropic messages format
- Include `tools` array in the request JSON
- Parse `tool_use` content blocks from response
- Re-invoke with `tool_result` blocks on next turn

Anthropic's `tool_use` → `tool_result` protocol applies directly.

### 4.3 OpenClawAdapter

OpenClaw already handles `session.tool` events (gateway fires these when the LLM inside OpenClaw calls a tool). The gateway receives tool definitions at session creation time.

**Changes needed:**
- Pass `tools` array in the session creation payload
- On receiving `session.tool` event: execute via `ChatToolExecutor.run()`, send result back via `sendSessionMessage({ kind: 'session.tool_result', ... })`

OpenClaw's existing `session.tool` → `agent.tool_call` event mapping in the adapter is already the right hook.

### 4.4 HttpAdapter

Forward `tools` array in request body if the target endpoint is OpenAI-compatible. If not, graceful fallback: omit tools, operate in relay mode (current behavior). Detect capability via a `supportsTools: boolean` config flag.

### 4.5 LocalLlmAdapter (Ollama / LM Studio)

These are OpenAI-compatible. Same implementation as HermesAdapter. Many local models (Mistral, Llama3, Qwen) support OpenAI-format tool calling when using Ollama or LM Studio.

---

## 5. The Orchestrator Persona

The orchestrator is not just another agent — it is the platform's primary interface. Its system prompt is the most important prompt in the product.

### 5.1 System Prompt Structure

```
You are the Agentis Orchestrator — the central intelligence for the [workspace_name] platform.

ROLE
You have complete visibility and control over this platform. You can run workflows,
monitor agents, search memory, manage approvals, and answer any question about
platform activity. You are a trusted colleague with full operator access.

STYLE
- Think out loud before acting. State what you're about to do and why.
- Be concise in text but thorough in actions.
- After a tool call returns, narrate the result in plain language before the next step.
- If a task requires multiple steps, complete them all before summarizing — don't ask for confirmation between steps unless a destructive action is involved.

TOOLS
You have access to platform tools. Use them freely. Prefer structured tool calls
over making up answers. If you don't know something, check it.

CONTEXT
Workspace: [workspace_name]
Agent inventory: [agent list]
Active runs: [run count]
Pending approvals: [approval count]
```

### 5.2 Multi-Step Reasoning Example

User: "Run the lead enrichment workflow for the 3 contacts I just added and tell me the results."

```
Thinking: I need to find the lead enrichment workflow, then run it for the 3 new contacts,
          then wait for results or at least give a status.

[tool_call: agentis.memory.read({ query: "lead enrichment workflow", kind: "workflow" })]
→ { workflowId: "wf_enrich_leads", name: "Lead Enrichment" }

[tool_call: agentis.knowledge.search({ query: "contacts added today" })]
→ [{ name: "Alice Chen", email: "..." }, { name: "Bob Kim", ... }, { name: "Carol Li", ... }]

[tool_call: agentis.workflow.run({ workflowId: "wf_enrich_leads", input: { contacts: [...] } })]
→ { runId: "run_9f3a2b", status: "RUNNING" }

Text: "I've started the Lead Enrichment workflow (run_9f3a2b) for Alice Chen, Bob Kim,
      and Carol Li. It's running now. Want me to check back when it's done, or
      should I monitor it live?"
```

### 5.3 Keeping Context Window Clean

The orchestrator accumulates history fast. Rules:
- Trim to last **20 turns** of conversation before each LLM call
- Keep system prompt + tool catalog **fixed** (not trimmed)
- Tool results are summarized (not stored raw) if longer than 2000 chars
- Long tool results get a `content: "<summarized: N items, first 3: ...>"` summary injected in their place

This keeps every LLM call under 8k tokens in practice, enabling fast, cheap, low-latency turns.

---

## 6. Performance Architecture

### 6.1 Why This Is Fast

| Factor | Impact |
|---|---|
| In-process tool execution | Zero HTTP round-trips for builtin tools. `agentis.memory.read` is a SQLite query — sub-millisecond. |
| Streaming text before tool calls | User sees typing the moment the LLM starts. No wait for tool calls to complete before showing text. |
| Parallel tool execution | If the LLM requests multiple tool calls in one turn, `Promise.all()` runs them concurrently. |
| No state machine overhead | No engine `runState`, no `ledger_events`, no `active_executions` rows. Chat is in-process only. |
| SQLite | Single-file DB, no connection pool, queries complete in <1ms on warm cache. |

### 6.2 Concurrency Model

```
Turn N:
  LLM streams → text deltas → SSE to client
  LLM requests 3 tool calls → Promise.all([tool1, tool2, tool3])
    ├─ tool1: SQLite query (0.3ms)
    ├─ tool2: SQLite query (0.5ms)  ← runs in parallel
    └─ tool3: HTTP fetch (200ms)
  All 3 results inject → next LLM call starts
```

Total overhead for 3 parallel tools with one HTTP call: ~200ms. The HTTP fetch is the bottleneck, not Agentis.

### 6.3 Tool Execution Limits

| Limit | Default | Reason |
|---|---|---|
| `maxTurns` | 10 | Prevent runaway loops |
| `maxToolCallsPerTurn` | 5 | Prevent token explosion from too many parallel results |
| `toolTimeoutMs` | 15000 | HTTP_fetch and slow tools get a hard deadline |
| History trim | 20 turns | Keep context window bounded |

---

## 7. Relationship to CHAT-TASKS.md

Two specs exist for "agents in chat." They are different things:

| | CHAT-TASKS.md | This document |
|---|---|---|
| **What** | Workflow engine multi-turn tasks | Interactive chat agentic loop |
| **Trigger** | NewTaskModal, scheduled, trigger | Composer message |
| **Execution** | Engine state machine, `active_executions` table | In-process, no DB rows |
| **Auditability** | Full ledger, run history, replay | Conversation thread only |
| **Latency** | Seconds (engine dispatch, node scheduling) | Milliseconds (direct) |
| **Tool calling** | Agent inside a workflow node calls tools | Orchestrator in chat calls tools |
| **History storage** | ScratchpadService `turns:<nodeId>` | ConversationStore messages |
| **Use case** | Long-running autonomous task | Real-time interactive Q&A + control |

They are **complementary**. A user might say "run the SDR campaign" in chat (this loop fires `agentis.workflow.run`, returns a runId) and the resulting workflow run executes in the background via the engine (CHAT-TASKS.md path). Chat is the entry point; the engine is the execution layer.

---

## 8. Implementation Phases

### Phase 1 — Foundation (3-5 days)

- [ ] Create `packages/core/src/types/chat.ts` with `ChatMessage`, `ChatDelta`, `ToolDefinition`, `ChatTurnContext`
- [ ] Create `apps/api/src/services/chatToolCatalog.ts` with full `CHAT_TOOL_CATALOG`
- [ ] Create `apps/api/src/services/chatToolExecutor.ts`
- [ ] Add optional `chat?()` method to `AgentAdapter` interface
- [ ] Unit tests: `ChatToolExecutor.run()` for all existing builtin-backed tools

### Phase 2 — HermesAdapter (2-3 days)

- [ ] Implement `HermesAdapter.chat()` with SSE streaming + tool_calls loop
- [ ] Integration test: multi-turn conversation with tool calls on local Ollama
- [ ] Verify `finish_reason: 'tool_calls'` → `'stop'` cycle works end-to-end

### Phase 3 — ChatSessionExecutor + SSE Route (3-4 days)

- [ ] Implement `ChatSessionExecutor.turn()` with `maxTurns` guard
- [ ] Upgrade `POST /v1/conversations/:agentId/send` to SSE when `Accept: text/event-stream`
- [ ] SSE heartbeat (every 15s) to prevent connection timeout on long tool chains
- [ ] `ThreadView` client: subscribe to SSE, render streaming deltas
- [ ] Show tool calls as "thinking" collapsed blocks in UI (tool name + result summary)

### Phase 4 — New Platform Tools (3-4 days)

- [ ] `agentis.workflow.run` executor (calls engine `WorkflowService.start()`)
- [ ] `agentis.workflow.status` executor (reads `active_executions` + `workflow_runs`)
- [ ] `agentis.workflow.list` executor
- [ ] `agentis.apps.status` executor (polls adapter health)
- [ ] `agentis.agents.list` executor
- [ ] `agentis.approval.list` / `agentis.approval.resolve` executors
- [ ] `agentis.knowledge.search` / `agentis.knowledge.write` executors
- [ ] `agentis.plan` / `agentis.evaluate` / `agentis.reflect` executors

### Phase 5 — Remaining Adapters (2-3 days)

- [ ] `OpenClawAdapter.chat()` — tool definitions at session creation, `session.tool_result` response
- [ ] `ClaudeCodeAdapter.chat()` — Anthropic tool use protocol
- [ ] `HttpAdapter.chat()` — OpenAI-compat forwarding with `supportsTools` flag
- [ ] `LocalLlmAdapter.chat()` — same as HermesAdapter (OpenAI-compat)

### Phase 6 — Orchestrator Persona + Polish (2-3 days)

- [ ] Orchestrator system prompt template in `apps/api/src/services/orchestratorPrompt.ts`
- [ ] Platform knowledge block embedded in system prompt (§11.2 vocabulary + §11.3 API model)
- [ ] Context injection: workspace name, agent list, active run count, pending approvals
- [ ] Context window trimming (20 turns, 2000-char tool result summaries)
- [ ] Slash commands migrated to tool catalog (backward compat: `/run → agentis.workflow.run`)
- [ ] `@mention` in composer → injects agent context into system prompt
- [ ] `#resource` in composer → prefetches and injects resource content

### Phase 7 — Viewport Awareness (2-3 days)

- [ ] `ViewportContext` type in `packages/core/src/types/chat.ts`
- [ ] `useViewportContext()` hook in `apps/web/src/lib/viewportContext.ts` — reads `useLocation()` + active store selectors
- [ ] `Socket.emit('viewport_context', ctx)` on every meaningful route/selection change (debounced 100ms)
- [ ] API socket handler stores `ViewportContext` in per-userId in-memory map
- [ ] `ChatSessionExecutor.turn()` accepts optional `viewportCtx` and injects as system context block
- [ ] Awareness pill UI in `Composer.tsx`: `[ Viewing: X · run Y running ] ×`
- [ ] `agentis.canvas.context` tool executor
- [ ] All 8 surface types emitting correct signals (canvas node selection, run status, agent detail, etc.)

### Phase 8 — Channel Loop Bridge (2-3 days)

- [ ] `agentic: boolean` column on `channel_connections` schema (default `false`)
- [ ] `ChannelBridge` accepts `ChatSessionExecutor` as optional dep
- [ ] `handleInbound()` branches on `connection.agentic` → runs loop → calls `adapter.send()`
- [ ] Outbound response stored in `ConversationStore` for web UI mirroring
- [ ] `ChannelKind` gains `'slack'` + `SlackChannelAdapter` implementation
- [ ] Outbound rate-limit queue for Discord (200ms spacing)
- [ ] Settings page: toggle `agentic` flag per channel connection

### Phase 9 — Observability (1-2 days)

- [ ] `chat_turns` lightweight append-only log (optional, not a new DB table — use structured logs)
- [ ] Tool call metrics: p50/p95 latency per tool in `/v1/admin/metrics`
- [ ] Error rate per tool for reliability tracking

---

## 9. Anti-Patterns to Avoid

| Anti-Pattern | Why Bad | Alternative |
|---|---|---|
| Running ChatSessionExecutor inside the Workflow Engine | Two runtimes cross-contaminating. Chat becomes slow and audited. | Keep runtimes separate. Chat is always in-process, no engine. |
| New DB table for chat tool calls | Adds write overhead on every tool call. Chat latency doubles. | Use ConversationStore messages (already exists). |
| Framework (LangChain, LangGraph, etc.) | Hides the loop, hard to debug, wrong abstraction for a product. | 30 lines of `while` loop + `Promise.all`. You own the code. |
| Streaming tool results before execution | Client shows a pending tool call that fails → confusing UX. | Emit `tool_result` delta only after execution completes. |
| One giant system prompt | Costs tokens on every call, hard to maintain. | Compose from template parts: persona + workspace context + tool guidance. |
| Blocking tool calls in text stream | Text stops while tool runs → user sees frozen typing indicator. | Keep text streaming; collect tool_calls; execute after `finish_reason: tool_calls`. |

---

## 10. Full-Application Awareness — The Chat That Sees Everything

The ChatPanel is mounted in `Shell` — it is **always on screen**, on every route. This is not a coincidence. It is the architectural statement: the chat is not a page, it is a persistent layer over the entire application. That means it can — and must — know everything the user is looking at, at all times, without being asked.

### 10.1 The Principle

There is no "current page" concept from the orchestrator's point of view. There is only "the entire Agentis application, with a current focus." The orchestrator has full read access to all of it. The user typing "why is this failing?" should get a correct answer regardless of whether they said which workflow or run they meant — because the chat already knows.

This is not about a cursor or selection. It is about continuous ambient awareness of the application state, enriching every turn automatically.

### 10.2 ViewportContext — The Awareness Signal

A new type captures what surface the user is on and what they have focused:

```typescript
// packages/core/src/types/chat.ts (addition)

export type AgentisSurface =
  | 'home'
  | 'canvas'           // /workflows/:id
  | 'run_detail'       // /runs/:id
  | 'agent_detail'     // /agents/:id
  | 'app_detail'       // /apps/:slug
  | 'history'          // /history
  | 'ledger'           // /data
  | 'skills'           // /skills
  | 'packages'         // /packages
  | 'artifacts'        // /artifacts
  | 'settings'         // /settings
  | 'chat';            // /chat

export interface ViewportContext {
  surface: AgentisSurface;

  // Canvas-specific
  workflowId?: string;
  workflowName?: string;
  selectedNodeId?: string;
  selectedNodeKind?: string;    // 'skill' | 'agent' | 'trigger' | 'condition'
  activeRunId?: string;
  activeRunStatus?: string;     // 'RUNNING' | 'FAILED' | 'COMPLETED'

  // Run-specific
  runId?: string;
  runWorkflowName?: string;
  runStatus?: string;

  // Agent-specific
  agentId?: string;
  agentName?: string;

  // App-specific
  appSlug?: string;
  appName?: string;

  // Generic enrichment (loaded entity title for any page)
  pageTitle?: string;

  // What the user has selected / highlighted in the UI (free text, optional)
  selectionHint?: string;
}
```

### 10.3 Signal Flow — Frontend to Orchestrator

The signal is emitted via the existing socket.io connection — no new HTTP endpoint needed.

```
Frontend (React Router)
  useEffect on location.pathname change
    + page-specific store selectors (selected node, active run)
    → socket.emit('viewport_context', ctx: ViewportContext)

API (socket.io handler)
  on('viewport_context')
    → store in per-session Map<userId, ViewportContext>
    → no DB write, ephemeral only

ChatSessionExecutor.turn()
  → load viewportCtx from session map
  → prepend as a context block in the system prompt (not the conversation history)
```

The viewport context block is **injected fresh on every turn**, not stored in history. It is always current, never stale, and costs zero tokens after the turn completes.

### 10.4 What Every Surface Provides

| Surface | Signals emitted |
|---|---|
| `/home` | `surface: 'home'`, active run count, pending approvals count |
| `/workflows/:id` | `surface: 'canvas'`, workflowId, workflowName, selectedNodeId, selectedNodeKind, activeRunId, activeRunStatus |
| `/runs/:id` | `surface: 'run_detail'`, runId, runWorkflowName, runStatus, failedNodeId |
| `/agents/:id` | `surface: 'agent_detail'`, agentId, agentName, adapter type |
| `/apps/:slug` | `surface: 'app_detail'`, appSlug, appName |
| `/history` | `surface: 'history'`, filter state (last 7d, status, agentId) |
| `/data` | `surface: 'ledger'`, time range |
| `/skills` | `surface: 'skills'` |
| `/chat` | `surface: 'chat'` |
| Any modal open | `selectionHint: 'approval modal open for approval_id X'` |

### 10.5 System Prompt Injection Format

On each turn, `ChatSessionExecutor` prepends a context block:

```
[PLATFORM CONTEXT — current view]
Surface: Workflow Canvas
Workflow: Lead Enrichment (wf_abc123)
Active run: run_9f3a2b — RUNNING
Selected node: email_node (skill: http_fetch)

[END PLATFORM CONTEXT]
```

The orchestrator uses this block to answer questions like:
- "why is this node slow?" → knows email_node + run → calls `agentis.audit_trail({ runId: 'run_9f3a2b' })`
- "what inputs does this take?" → knows selectedNodeId → calls `agentis.canvas.context`
- "stop this" → knows activeRunId → calls `agentis.workflow.cancel({ runId: 'run_9f3a2b' })`

No disambiguation. No "which workflow did you mean?" The answer is implicit in the viewport.

### 10.6 Full Application Access — Beyond the Current View

The viewport context shows the *focus*, but the orchestrator is not *limited* to it. It has tools that can query any part of the application regardless of what's currently on screen:

| What | Tool |
|---|---|
| Any workflow, any run | `agentis.workflow.status`, `agentis.workflow.list` |
| Any agent | `agentis.agents.list` |
| Any ledger event | `agentis.audit_trail` |
| Any memory entry | `agentis.memory.read` |
| Any approval | `agentis.approval.list` |
| Any skill | query via `agentis.knowledge.search` |
| Any run log | `agentis.run.query` |

The viewport narrows the default context. The tools give unrestricted access when the user explicitly asks about something else. "Show me all failed runs from last week" works regardless of what page they're on.

### 10.7 New Tool: agentis.canvas.context

A dedicated tool for deep inspection of a workflow node when the user is on the canvas:

```typescript
{
  name: 'agentis.canvas.context',
  description:
    'Fetch full detail for a workflow node: its configuration, skill/agent binding, ' +
    'retry policy, recent execution history, and input/output schema. Use when the user ' +
    'asks about a specific node on the canvas, its settings, or why it behaved a certain way.',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: 'The workflow containing the node.' },
      nodeId: { type: 'string', description: 'The node ID to inspect.' },
      includeHistory: { type: 'boolean', description: 'Whether to include last 5 executions.' }
    },
    required: ['workflowId', 'nodeId']
  }
}
```

### 10.8 UI — Showing the Orchestrator's Awareness

The ChatPanel composer should show a subtle "awareness pill" when viewport context is active:

```
[ Viewing: Lead Enrichment canvas · run_9f3a2b running ] ×
```

Clicking `×` clears the viewport injection for that turn (the user wants to ask about something unrelated). This is the only UI surface for this feature. No other chrome needed.

---

## 11. Platform Knowledge — What the Model Knows About Agentis

The orchestrator's effectiveness depends not just on tools, but on its *embedded understanding* of the Agentis platform. This is baked into the system prompt and updated as the platform evolves. It is the difference between a generic assistant with tools and a true platform expert.

### 11.1 The Knowledge Problem

Without platform knowledge, the orchestrator will:
- Confuse "workflow" (the graph definition) with "run" (an execution instance)
- Not know what an "ambient" is or how it relates to an agent
- Not know the difference between a `skill_task` node and an `agent_task` node
- Not understand why a run might be in `PAUSED_FOR_APPROVAL` state
- Not know what gateways are vs. channels
- Not know the workspace isolation model

The system prompt must teach these concepts once, so the model never has to guess.

### 11.2 Platform Vocabulary (Mandatory System Prompt Section)

This section is a fixed part of every orchestrator system prompt. It is the Agentis conceptual model in ~400 tokens:

```
AGENTIS PLATFORM CONCEPTS

Workspace
  The top-level isolation unit. All agents, workflows, runs, memory, and credentials
  belong to a single workspace. The current workspace is always set in your context.

Ambient
  A named environment context (e.g. "production", "staging"). Agents can be scoped
  to an ambient to isolate execution environments within a workspace.

Agent
  A configured AI actor. Has a name, an adapter (how it connects to an LLM/harness),
  and a system prompt. Agents appear in: workflows as nodes, chat threads, and channels.

Adapter (Harness)
  The protocol bridge between Agentis and an LLM. Types:
  - HermesAdapter: OpenAI-compatible endpoint (local or cloud)
  - OpenClawAdapter: WebSocket gateway for stateful sessions
  - ClaudeCodeAdapter: Anthropic Claude via CLI
  - HttpAdapter: Custom HTTP endpoint
  - LocalLlmAdapter: Ollama / LM Studio

Gateway
  A running OpenClaw instance. Agents connect to gateways to get persistent sessions.
  Gateway health = whether the WebSocket connection is live.

Skill
  A reusable capability unit. Three tiers:
  - builtin: in-process executors (memory, http_fetch, build_workflow, etc.)
  - node_worker: sandboxed JS in an isolated V8 context
  - docker_sandbox: containerized execution for registry-installed skills

Workflow
  A directed acyclic graph of nodes. Node types:
  - skill_task: executes a skill
  - agent_task: dispatches a task to an agent
  - condition: branches execution based on a JS expression
  - trigger: the entry point (manual, scheduled, or event-driven)

Run
  A single execution instance of a workflow. Has a status:
  - PENDING → RUNNING → COMPLETED | FAILED | CANCELLED
  - PAUSED_FOR_APPROVAL: waiting for a human approval before continuing

Approval
  A gate node in a workflow run. An operator must approve or reject before
  the run continues. Visible in /data and queryable via agentis.approval.list.

Memory
  Structured key-value store scoped to workspace/agent/team. Used by agents to
  persist knowledge across runs. Importance score 1-10 (agents capped at 7).

Ledger
  Append-only event log. Every significant platform event is a ledger entry.
  Source of truth for audit trails, replays, and debugging.

Channel
  An external messaging integration (Telegram, Discord, Slack). Connects an agent
  to a messaging platform. Inbound messages create conversation thread entries.
  Outbound messages are forwarded when the agent responds in its thread.

Conversation
  A per-agent thread of operator ↔ agent messages. One conversation per agent.
  Messages can originate from the web UI, a channel, or the platform itself.

Team
  A named group of agents with defined roles, used for multi-agent coordination.
```

### 11.3 API Mental Model

The orchestrator should know the shape of the Agentis REST API surface so it can answer "can we do X?" accurately:

```
KEY API SURFACES

/v1/workflows         → CRUD on workflow definitions
/v1/runs              → start, list, get, cancel runs
/v1/agents            → CRUD on agent configurations
/v1/skills            → list skills, get schema
/v1/gateways          → OpenClaw gateway management
/v1/channels          → Telegram/Discord/Slack connections
/v1/conversations     → per-agent thread messages
/v1/memory            → workspace memory entries
/v1/approvals         → list and resolve pending approvals
/v1/ledger            → read-only event log
/v1/credentials       → encrypted credential vault
/v1/knowledgeBases    → document/embedding storage
/v1/triggers          → scheduled and event-driven workflow triggers
/v1/teams             → multi-agent team definitions
```

### 11.4 Common States and What They Mean

The orchestrator should interpret platform states correctly before offering advice:

| State | What it means | What to suggest |
|---|---|---|
| Run `PAUSED_FOR_APPROVAL` | A node requires human approval. Run is blocked. | `agentis.approval.list`, then `agentis.approval.resolve` |
| Gateway `disconnected` | OpenClaw session lost. Agents on this gateway are offline. | Check gateway config, re-test connection |
| Agent adapter `null` | Agent has no harness configured. Cannot execute tasks. | Direct user to agent settings |
| Skill `status: 'error'` | Last execution failed. | `agentis.audit_trail` to see the error |
| Run `FAILED`, node `condition` | Branch logic rejected. | Inspect node config + input data |
| Memory `importance >= 8` | System-level memory (not agent-written). Do not overwrite. | Read only |

### 11.5 What the Model Should Never Do

These are hard constraints embedded in the system prompt:

```
CONSTRAINTS

- Never fabricate run IDs, workflow IDs, or agent IDs. Always call a tool to get real IDs.
- Never tell the user a workflow "completed successfully" without calling agentis.workflow.status.
- Never create or modify workflow definitions without explicit user confirmation.
- Never call agentis.approval.resolve with action='reject' unless the user explicitly said to reject.
- Never expose token values, credentials, or webhook secrets — these are encrypted and the tools
  do not return plaintext values. If asked for a token, explain it cannot be retrieved.
- Never run a workflow more than once for the same request without confirming with the user.
```

### 11.6 Versioning the Platform Knowledge

The platform knowledge block is stored in `apps/api/src/services/orchestratorPrompt.ts` as a string constant. When a major new capability lands (new node type, new adapter, new channel), the constant is updated. This is the only place it needs to change — every new conversation gets the current version automatically.

Version header in the prompt for model-facing debugging:
```
[AGENTIS PLATFORM KNOWLEDGE v1.4 — May 2026]
```

---

## 12. Channel Loop Bridge

The `ChannelBridge` and `ChannelAdapter` system for Telegram and Discord is already fully built and shipped. Tokens encrypted, webhook verification, idempotency checks, `ConversationStore.appendMirrored()` — all working. The one missing piece: inbound messages do not trigger the Chat Agentic Loop. They arrive, get stored, and nothing responds intelligently.

### 12.1 The Gap

```
Current flow:
  Telegram → webhook → ChannelBridge.handleInbound()
    → ConversationStore.appendMirrored(text)
    → SILENCE (no response generated)

Target flow:
  Telegram → webhook → ChannelBridge.handleInbound()
    → ConversationStore.appendMirrored(text)
    → ChatSessionExecutor.turn(agentId, history, text, ctx)
      → tool calls execute in-process
      → final text assembled
    → ChannelAdapter.send(token, chatId, finalText)
```

The loop runs entirely in-process. The Telegram user gets a real orchestrator response. The web UI also shows the exchange in the conversation thread (both the inbound mirror and the outbound response are stored).

### 12.2 The Bridge Decision

Not every channel connection should run the agentic loop. Some agents are "relay" agents — they just mirror messages without autonomous response. The decision is per-connection, controlled by an `agentic: boolean` flag on `channel_connections`:

```
connection.agentic = true  → run ChatSessionExecutor.turn()
connection.agentic = false → mirror only (current behavior)
```

Default for new connections: `false` (safe). Explicitly enabling it opts into the loop.

The orchestrator agent's channel connections should default to `true`. Workflow-level agents that receive task results via Telegram should default to `false`.

### 12.3 Updated handleInbound() Flow

```typescript
// ChannelBridge.handleInbound() — addition after appendMirrored()

if (row.agentic && this.deps.chatExecutor) {
  const history = this.deps.conversations.messages(conversation.id, 20)
    .map(m => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.body }));

  let reply = '';
  for await (const delta of this.deps.chatExecutor.turn(
    this.deps.adapters.get(row.kind),   // the agent's LLM adapter
    history,
    parsed.text,
    { workspaceId: row.workspaceId, agentId: row.agentId, userId: row.userId, conversationId: conversation.id }
  )) {
    if (delta.type === 'text') reply += delta.delta;
  }

  if (reply) {
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    const chatId = parsed.chatId ?? settings.defaultChatId;
    await adapter.send({ token, chatId, body: reply });
    await this.deps.conversations.appendOutbound({ ... body: reply ... });
  }
}
```

No new DB tables. The response appears in the web conversation thread and in the messaging app simultaneously.

### 12.4 Channel Support Matrix

| Channel | Status | Notes |
|---|---|---|
| **Telegram** | Built — loop bridge needed | Webhook + polling both work. Best channel for personal orchestrator access. |
| **Discord** | Built — loop bridge needed | Bot token + guild permissions. Good for team-shared orchestrator. |
| **Slack** | Spec — add `ChannelKind = 'slack'` | Slack Events API + OAuth. Best for operator teams already in Slack. Requires Slack app registration. |
| **WhatsApp** | Deferred | Meta Cloud API / Twilio. Real value, but WABA approval + phone number adds ops friction. V2. |

### 12.5 Slack Implementation Notes

Slack differs from Telegram/Discord in one important way: **threads**. Slack messages live in channels and threads, not in a one-to-one bot conversation. The `SlackChannelAdapter` needs to:
- Register for `app_mention` and `message.im` events (direct messages to the bot)
- Use `thread_ts` to reply in the same thread, not the channel root
- Support Slack's block kit for rich responses (tool results as expandable blocks)
- Handle the OAuth 3-legged flow for workspace installation

The `ChannelAdapter` interface already supports per-adapter settings JSON — Slack settings would carry `{ channelId, threadMode: 'reply_in_thread' | 'new_thread' }`.

### 12.6 Rate Limits and Queuing

Channel APIs have rate limits that the in-process loop does not. Rules:
- Telegram: 30 messages/second per bot. Not a concern for conversational use.
- Discord: 5 messages/second per channel. Use a per-connection outbound queue with 200ms spacing.
- Slack: Tier 3 = 50 msg/min. Fine for orchestrator use cases.
- All: If `adapter.send()` throws a rate limit error, retry with exponential backoff (same policy as workflow engine retries, cap at 3 attempts).

---

## 13. Success Criteria

The Chat Agentic Loop is complete when:

1. A user can type "run my SDR workflow for these 3 leads" and the orchestrator executes `agentis.workflow.run` and responds with the run ID and status — in under 2 seconds from Enter to first text delta.
2. A user can ask "what's running right now?" and the orchestrator calls `agentis.workflow.list` + `agentis.apps.status` in parallel and gives a natural language summary — in under 1 second.
3. A user can say "approve the pending approval for the marketing campaign" and the orchestrator calls `agentis.approval.list` → `agentis.approval.resolve` with full confirmation — no UI navigation needed.
4. A developer can add a new platform tool in under 30 minutes: (a) add executor to `BUILTIN_REGISTRY`, (b) add schema to `CHAT_TOOL_CATALOG`, (c) write one unit test. Done.
5. HermesAdapter, ClaudeCodeAdapter, and OpenClawAdapter all pass the same `chat()` integration test suite, proving the interface is truly adapter-agnostic.
