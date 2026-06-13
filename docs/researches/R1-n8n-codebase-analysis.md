# R1 â€” n8n Execution Engine: Deep Codebase Analysis

> **Purpose:** Extract the precise internal mechanics of n8n's execution engine, trigger system, extension model, and canvas live-update architecture. Use this to understand what Agentis must replicate, improve, or completely replace.
>
> **Source commit window:** n8n monorepo, `master` branch, mid-2025.

---

## 1. RunExecutionData â€” The Execution State Shape

Everything about a single workflow run lives in `IRunExecutionData` (`packages/workflow/src/run-execution-data/run-execution-data.v1.ts`):

```typescript
interface IRunExecutionDataV1 {
  version: 1;

  startData?: {
    startNodes?: StartNodeData[];
    destinationNode?: IDestinationNode;   // { nodeName: string; mode: 'inclusive' }
    originalDestinationNode?: IDestinationNode;
    runNodeFilter?: string[];             // Only these nodes are allowed to run
  };

  resultData: {
    runData: { [nodeName: string]: ITaskData[] }; // Completed node output, by node name + runIndex
    pinData?: { [nodeName: string]: INodeExecutionData[] };
    lastNodeExecuted?: string;
    error?: ExecutionError;
    metadata?: Record<string, string>;
  };

  executionData?: {
    contextData: IExecuteContextData;          // $flow / $node context values
    nodeExecutionStack: IExecuteData[];        // THE WORK QUEUE â€” nodes pending execution
    waitingExecution: IWaitingForExecution;    // Multi-input buffer: node â†’ runIndex â†’ connections
    waitingExecutionSource: IWaitingForExecutionSource;
    metadata: { [nodeName: string]: ITaskMetadata[] };
  };

  waitTill?: Date;    // When set: execution is paused until this timestamp
  resumeToken?: ...;
}
```

### Key data units

**`IExecuteData`** â€” one item on the work queue:
```typescript
{
  node: INode;
  data: ITaskDataConnections;   // { main: INodeExecutionData[][] }
  source: ITaskDataConnectionsSource | null;
  metadata?: ITaskMetadata;
}
```

**`ITaskData`** â€” what gets written to `resultData.runData[nodeName][runIndex]` after a node completes:
```typescript
{
  startTime: number;
  executionIndex: number;       // Global order counter across the run
  executionTime: number;        // ms
  executionStatus: ExecutionStatus; // 'new' | 'running' | 'waiting' | 'success' | 'error' | 'canceled'
  data?: { main: INodeExecutionData[][] };
  error?: ExecutionError;
  source: Array<ISourceData | null>;
  metadata?: ITaskMetadata;
}
```

**`INodeExecutionData`** â€” one data item passed between nodes:
```typescript
{
  json: IDataObject;            // { [key: string]: any }
  binary?: IBinaryKeyData;
  pairedItem?: IPairedItemData | IPairedItemData[];  // Tracks which input item this came from
  error?: NodeApiError | NodeOperationError;
}
```

> **Agentis implication:** `INodeExecutionData` is the unit of work. Items always carry their lineage (`pairedItem`). There is no concept of agent memory, observations, or tool-call results as first-class objects â€” everything is forced through `json: IDataObject`.

---

## 2. Execution Engine â€” The Main Loop

**File:** `packages/core/src/execution-engine/workflow-execute.ts`  
**Class:** `WorkflowExecute`

### Entry points

| Method | Purpose |
|--------|---------|
| `run(workflow, startNode?, destNode?, pinData?)` | Full execution from trigger |
| `runPartialWorkflow(workflow, runData, startNodes, destNode, ...)` | Re-run from dirty nodes (canvas "run to here") |
| `processRunExecutionData(workflow)` | Core loop â€” called by both above |

### The main loop (`processRunExecutionData`)

The engine runs a `PCancelable` promise wrapping this loop:

```
while (nodeExecutionStack.length > 0) {
  executionData = nodeExecutionStack.pop()  // pop or shift depends on executionOrder
  executionNode = executionData.node

  // Skip if not in runNodeFilter
  if (runNodeFilter && !runNodeFilter.includes(executionNode.name)) continue

  // Validate all required inputs are present
  if (!ensureInputData(workflow, executionNode, executionData)) continue  // re-pushed to stack

  hooks.runHook('nodeExecuteBefore', [executionNode.name, taskStartedData])

  // Retry loop (1â€“5 attempts)
  for tryIndex in [0..maxTries]:
    runNodeData = await runNode(workflow, executionData, ...)
    if (runNodeData.data?.[0]?.[0]?.json?.error) â†’ retry
    else break

  // Write result to resultData.runData[nodeName]
  taskData = { ...startData, data: { main: nodeSuccessData }, executionStatus, executionTime }
  resultData.runData[executionNode.name].push(taskData)

  hooks.runHook('nodeExecuteAfter', [executionNode.name, taskData, runExecutionData])

  // Enqueue successor nodes
  for each outputIndex in connectionsBySourceNode[executionNode.name].main:
    for each connectionData in connections[outputIndex]:
      addNodeToBeExecuted(workflow, connectionData, outputIndex, ...)
        â†’ if destination has 1 input: push directly to nodeExecutionStack
        â†’ if destination has N inputs: accumulate in waitingExecution until all inputs arrive

  // Drain waitingExecution if stack is empty
  if (nodeExecutionStack.length === 0 && waitingExecution has entries):
    find nodes with sufficient inputs â†’ push to stack
}
```

### Execution order modes

`workflow.settings.executionOrder` controls queue discipline:
- **`v0` (legacy):** `push` â€” breadth-first-ish, processes nodes in the order connections were added
- **`v1` (default):** `unshift` + sort by canvas Y-position â†’ top-left nodes execute first (deterministic)

### Multi-input node handling (`addNodeToBeExecuted`)

Nodes with `>1` input connections (e.g. Merge) use `waitingExecution` as a per-node buffer. For each connection that arrives:
1. If no entry for this node yet â†’ allocate slot in `waitingExecution[nodeName][runIndex]`
2. Mark the arriving input slot (`main[connectionIndex] = data`)
3. When all required inputs are present â†’ move entire entry to `nodeExecutionStack`

`requiredInputs` is read from the node type description and can be:
- `undefined` â†’ all inputs
- `number` â†’ at least N inputs
- `number[]` â†’ specific input indexes

### `runNode()` â€” dispatches to implementation

```typescript
runNode(workflow, executionData, ...) {
  node = executionData.node
  nodeType = workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion)

  if (node.disabled)        â†’ handleDisabledNode (pass-through input)
  if (nodeType.execute)     â†’ executeNode(...)      // full execute method
  if (nodeType.poll)        â†’ executePollNode(...)  // in manual mode only
  if (nodeType.trigger)     â†’ executeTriggerNode(...)
  if (nodeType.webhook && !declarative) â†’ pass inputData.main through
  else â†’ executeDeclarativeNodeInTest(...)
}
```

### `executeNode()` â€” the hot path

Instantiates an `ExecuteContext` (provides `getNodeParameter`, `getInputData`, `helpers`, etc.), calls `nodeType.execute.call(context)`. Handles:
- `continueOnFail` / `continueErrorOutput` routing
- `alwaysOutputData` â€” injects an empty item if node produced nothing
- `executeOnce` â€” crops input to single item before calling execute
- `rewireOutputLogTo` â€” re-maps output type in the log for AI tool nodes
- `closeFunctions[]` â€” collected cleanup callbacks, called after execute finishes

---

## 3. Canvas Live Execution State

### Architecture

The canvas does **not** poll. It receives push events from the backend via **Server-Sent Events (SSE)** (or WebSocket in self-hosted). The mechanism is:

```
Backend execution loop
  â†’ hooks.runHook('nodeExecuteBefore', ...) 
  â†’ hooks.runHook('nodeExecuteAfter', ...)
  â†’ hooks.runHook('workflowExecuteAfter', ...)
        â†“
Hook handlers registered at execution start
  â†’ additionalData.sendDataToUI(type, data)
        â†“
Push message to frontend over SSE/WS
        â†“
Frontend usePushConnection composable
  â†’ updates workflowsStore.workflowExecutionData.resultData.runData
        â†“
Canvas reads runData[nodeName][0].executionStatus
  â†’ node color: 'running' (spinner) / 'success' (green) / 'error' (red) / 'waiting' (yellow)
```

### Lifecycle hook events

`ExecutionLifecycleHooks` (`packages/core/src/execution-engine/execution-lifecycle-hooks.ts`) defines:

| Hook | When | Payload |
|------|------|---------|
| `workflowExecuteBefore` | Execution starts | `workflow`, `runExecutionData` |
| `nodeExecuteBefore` | Node starts | `nodeName`, `ITaskStartedData { startTime, executionIndex }` |
| `nodeExecuteAfter` | Node completes | `nodeName`, `ITaskData`, `IRunExecutionData` |
| `workflowExecuteAfter` | Execution ends | `IRun { data, mode, startedAt, stoppedAt, status }` |
| `sendResponse` | Webhook response | `IExecuteResponsePromiseData` |
| `sendChunk` | Streaming output | `StructuredChunk` |
| `nodeFetchedData` | HTTP request made | `workflowId`, `node` |

### Canvas node status mapping

```
resultData.runData[nodeName][runIndex].executionStatus â†’
  'running'  â†’ spinner overlay on node
  'success'  â†’ green border / checkmark
  'error'    â†’ red border / X icon
  'waiting'  â†’ yellow border (waitTill pause)
  'canceled' â†’ grey
```

> **Agentis implication:** n8n's canvas is a status display driven by `ITaskData.executionStatus` streamed per-node. This is the exact model Agentis "living canvas" must use. The critical difference: Agentis canvas must also show **agent observations**, **tool call results**, and **inter-agent messages** â€” none of which have a slot in n8n's data model.

---

## 4. Trigger System Architecture

### Three trigger mechanisms

| Type | Interface | Activation |
|------|-----------|------------|
| **Trigger** | `INodeType.trigger?(this: ITriggerFunctions)` | Persistent listener (SSE, queue, socket) |
| **Poller** | `INodeType.poll?(this: IPollFunctions)` | Cron-scheduled via `ScheduledTaskManager` |
| **Webhook** | `INodeType.webhook?(this: IWebhookFunctions)` | HTTP endpoint registered in `WebhookService` |

### ActiveWorkflows service

`ActiveWorkflows` (`packages/core/src/execution-engine/active-workflows.ts`) is an in-memory registry:

```typescript
private activeWorkflows: { [workflowId: string]: IWorkflowData } = {}

// IWorkflowData:
{
  triggerResponses?: ITriggerResponse[];  // closeFunction handles per trigger
}
```

**Activation flow (`add()`):**
1. `workflow.getTriggerNodes()` â€” finds all trigger-group nodes
2. For each trigger node: `triggersAndPollers.runTrigger(workflow, node, ...)` â†’ calls `nodeType.trigger.call(triggerFunctions)`
3. `ITriggerResponse` returned contains `closeFunction?: () => Promise<void>` (cleanup) and optional `manualTriggerFunction / manualTriggerResponse` (for test runs)
4. `workflow.getPollNodes()` â€” finds all polling nodes
5. For each poll node: `activatePolling()`:
   - Reads `pollTimes.item[]` parameter from node
   - Converts to cron expressions via `toCronExpression()`
   - `scheduledTaskManager.registerCron(ctx, executeTrigger)`

**How a trigger fires an execution:**
```
nodeType.trigger calls:
  triggerFunctions.emit(data: INodeExecutionData[][])
    â†’ (in non-manual mode) resolves directly to execution pipeline
    â†’ (in manual mode) resolves manualTriggerResponse Promise
        â†’ WorkflowExecute.executeTriggerNode() picks up the data
```

**How a poller fires an execution:**
```
ScheduledTaskManager cron tick
  â†’ createPollExecuteFn()
      â†’ triggersAndPollers.runPoll(workflow, node, pollFunctions)
          â†’ nodeType.poll.call(pollFunctions) â†’ INodeExecutionData[][]
      â†’ if result !== null: pollFunctions.__emit(result)
          â†’ triggers new execution via additionalData pipeline
```

**Deactivation (`remove()`):**
1. `scheduledTaskManager.deregisterCrons(workflowId)` â€” removes all crons
2. For each `triggerResponse`: calls `response.closeFunction()` â€” closes the listener

### ITriggerResponse shape

```typescript
{
  closeFunction?: () => Promise<void>;        // Called on deactivation
  manualTriggerFunction?: () => Promise<void>; // Manual test: start listening
  manualTriggerResponse?: Promise<INodeExecutionData[][]>; // Resolves on first emit
}
```

### ITriggerFunctions contract

```typescript
{
  emit(data, responsePromise?, donePromise?): void;
  emitError(error, responsePromise?): void;
  saveFailedExecution(error): void;          // Persist failure, keep workflow active
  getNodeParameter(name, fallback?): value;
  helpers: { httpRequest, httpRequestWithAuthentication, registerCron, ... }
}
```

---

## 5. Extension / Node Architecture (â†’ maps to Agentis Skill model)

### INodeType â€” the extension contract

Every node is an object implementing `INodeType` (or extending `Node` base class):

```typescript
interface INodeType {
  description: INodeTypeDescription;  // STATIC â€” read at load time
  
  // Execution methods (implement exactly ONE of these):
  execute?(this: IExecuteFunctions): Promise<INodeExecutionData[][] | EngineRequest>;
  trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
  poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
  webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
  supplyData?(this: ISupplyDataFunctions): Promise<SupplyData>;  // AI sub-node data
  
  // Dynamic UI helpers (run server-side, called from node config panel):
  methods?: {
    loadOptions?: { [key: string]: (this: ILoadOptionsFunctions) => Promise<INodePropertyOptions[]> };
    listSearch?: { [key: string]: (this, filter?, paginationToken?) => Promise<INodeListSearchResult> };
    credentialTest?: { [fn: string]: ICredentialTestFunction };
    resourceMapping?: { [fn: string]: (this) => Promise<ResourceMapperFields> };
  };
  
  webhookMethods?: {
    [name in WebhookType]?: { checkExists, create, delete }
  };

  customOperations?: {
    [resource: string]: {
      [operation: string]: (this: IExecuteFunctions) => Promise<NodeOutput>;
    };
  };
}
```

### INodeTypeDescription â€” static manifest

```typescript
{
  name: string;           // e.g. 'n8n-nodes-base.httpRequest'
  displayName: string;
  version: number | number[];
  group: NodeGroupType[]; // 'input' | 'output' | 'trigger' | 'transform' | ...
  inputs: Array<NodeConnectionType | INodeInputConfiguration>;
  outputs: Array<NodeConnectionType | INodeOutputConfiguration>;
  properties: INodeProperties[];      // Form fields shown in panel
  credentials?: INodeCredentialDescription[];
  webhooks?: IWebhookDescription[];
  polling?: true;
  requestDefaults?: HttpRequestOptions;  // Declarative nodes: base URL + default headers
  hooks?: { activate?: []; deactivate?: [] };
}
```

### Connection types (NodeConnectionTypes)

```
Main           â€” primary data flow
AiLanguageModel, AiMemory, AiTool, AiDocument, AiEmbedding,
AiVectorStore, AiVectorRetriever, AiChain, AiAgent,
AiOutputParser, AiRetriever, AiTextSplitter
```

AI sub-nodes use `supplyData()` instead of `execute()`. An AI Agent node calls `getInputConnectionData(connectionType, itemIndex)` to pull the AI sub-node's output.

### IExecuteFunctions â€” what execute() receives

```typescript
{
  getNodeParameter(name, itemIndex, fallback?, opts?): value;
  getInputData(inputIndex?, connectionType?): INodeExecutionData[];
  getCredentials<T>(type, itemIndex?): Promise<T>;
  helpers: {
    httpRequest(opts): Promise<any>;
    httpRequestWithAuthentication(credType, opts): Promise<any>;
    normalizeItems(items): INodeExecutionData[];
    constructExecutionMetaData(items, { itemData }): NodeExecutionWithMetadata[];
    // binary, deduplication, SSH, file-system helpers...
  };
  executeWorkflow(workflowInfo, inputData?, ...): Promise<ExecuteWorkflowData>;
  putExecutionToWait(waitTill: Date): Promise<void>;
  sendMessageToUI(message): void;
  addInputData(type, data, runIndex?): { index: number };
  addOutputData(type, runIndex, data, metadata?): void;
}
```

### Credential system

Credentials are node-level. A node declares which credential types it needs in `description.credentials`. At runtime, `getCredentials(type, itemIndex)` is called by the node's `execute()` method. The credential is decrypted, resolved (optionally with OAuth2 refresh), and injected. There is **no cross-node or workflow-wide credential context**.

---

## 6. Where n8n Breaks for Multi-Agent Workflows

These are structural limitations baked into the execution model â€” not configurable:

### 6.1 Single executor, sequential stack

`nodeExecutionStack` is a single LIFO/FIFO queue. There is no parallel execution of branches. When Node A has two output connections to Node B and Node C, B and C are queued sequentially â€” they do not run concurrently. No thread pool, no async fan-out.

**Agentis need:** Agent networks require true concurrent execution. Agent A and Agent B must run simultaneously, not be serialized in a queue.

### 6.2 No agent-to-agent communication primitives

The only inter-node data contract is `INodeExecutionData[] â†’ INodeExecutionData[]`. Nodes cannot:
- Send messages to other nodes while running (only via `sendMessageToUI`)
- Observe what other nodes are doing
- React to another node's intermediate state

`executeWorkflow()` exists but it's a synchronous blocking call â€” the parent node suspends until the child workflow completes. There is no async spawning.

**Agentis need:** Agents must be able to delegate, broadcast, and observe each other. The `executeWorkflow` pattern is too coarse for real-time agent coordination.

### 6.3 No shared scratchpad / memory OS

`staticData` is the only shared mutable state, and it's a flat `IDataObject` scoped to the entire workflow. There is no:
- Per-execution context memory
- Short-term / long-term / working memory tiers
- Agent-specific scratchpad
- Vector store integration in the execution layer (only via node extensions)

**Agentis need:** The memory OS (working memory, episodic, semantic) is a core differentiator. In n8n, memory nodes are just external API calls wrapped in `execute()`.

### 6.4 No dynamic DAG replanning

The graph (`workflow.connections`) is static. It cannot be modified during execution. Partial execution (`runPartialWorkflow`) can re-run subgraphs, but the graph shape itself is fixed at execution start.

`DirectedGraph.fromWorkflow(workflow)` builds the graph once. `findSubgraph()`, `findStartNodes()`, `recreateNodeExecutionStack()` are all pre-execution operations.

**Agentis need:** A Repair Agent that restructures a failing flow mid-execution, or a meta-agent that spawns new sub-agents dynamically, requires a mutable execution graph â€” impossible in n8n's model.

### 6.5 Blocking `waitTill` pause model

`putExecutionToWait(date)` sets `runExecutionData.waitTill = date`, which causes `processRunExecutionData` to exit the loop and store state to DB. The entire execution is frozen â€” no other part of the workflow continues. There is no concept of "pause this agent while others continue."

**Agentis need:** When one agent is waiting for a human response, other agents in the same session should continue unblocked.

### 6.6 No routing or ELO dispatch

n8n has no mechanism to route work to the "most capable" node for a given task. The workflow graph is deterministic â€” connections are hard-coded at design time. There is no skill-match scoring, capability registry, or load-based routing.

**Agentis need:** The ELO routing layer scores agents by capability and routes tasks to best-fit agents at runtime.

### 6.7 `INodeExecutionData[]` is too thin for agent payloads

The data unit is `{ json: IDataObject, binary?, pairedItem? }`. There is no slot for:
- Agent observations / reasoning traces
- Tool call request/response history
- Confidence scores or metadata from LLM calls (partially added via `ITaskMetadata.tokenUsage`)
- Intermediate thoughts (chain-of-thought)

The `EngineRequest` / `EngineResponse` pattern (recently added for AI Agent tools) is a workaround â€” it allows a node to request the engine to execute sub-nodes and return results. But it's still synchronous and limited to tool-call patterns.

### 6.8 Credentials are node-local

There is no workflow-level credential context. If 10 agent nodes in a workflow all use the same LLM provider, each must declare and resolve credentials independently. There is no "session-level API key" concept.

**Agentis need:** A shared credential/context layer for all agents in a run.

---

## 7. Summary: n8n's Model vs. Agentis Needs

| Dimension | n8n | Agentis |
|-----------|-----|---------|
| Execution unit | `INodeExecutionData` item | Agent message + observation |
| Graph topology | Static DAG, fixed at build time | Dynamic, can be replanned |
| Concurrency | None â€” sequential stack | True concurrent agent branches |
| Inter-node comms | Output â†’ Input only | Broadcast, delegation, observation |
| Memory | `staticData` flat KV | 3-tier memory OS |
| Pause model | `waitTill` freezes whole execution | Per-agent wait, others continue |
| Routing | Hard-wired graph edges | ELO skill-match dispatch |
| Triggers | Cron, webhook, persistent listener | Same (reuse n8n pattern) |
| Node/Skill contract | `INodeType.execute()` â†’ items | Skill.run() â†’ structured output |
| Canvas updates | `nodeExecuteAfter` hook â†’ SSE | Same hook pattern, richer payload |

The trigger system, lifecycle hooks, and `INodeType` extension contract are the parts of n8n worth directly mapping to Agentis. The execution stack model, data unit, graph immutability, and lack of concurrency are what Agentis must replace entirely.

---

## 8. n8n's AI Layer â€” Website + Docs Audit (Addendum, April 2026)

> **Context:** After R1 sections 1â€“7 were written (execution engine focus), n8n has shipped a substantial AI layer. This section documents that layer and explains why the structural gaps in Â§6 still hold despite it. This also resolves the "n8n for agents" positioning question directly.

### 8.1 What n8n shipped: the AI node registryue

n8n's AI features are implemented as **cluster nodes** â€” a `root node` plus one or more `sub-nodes` that plug into it. This is their extension pattern for composed functionality.

**Root nodes (agents + chains):**

| Node | Pattern |
|---|---|
| `AI Agent` | ReAct, Tools, Conversational, Plan-Execute, SQL, OpenAI Functions variants |
| `Basic LLM Chain` | Single prompt â†’ LLM â†’ output |
| `Question and Answer Chain` | Retrieval + LLM answer |
| `Summarization Chain` | Map-reduce summarization |
| `Information Extractor` | Structured extraction from text |
| `Text Classifier` | Multi-class LLM classifier |
| `Sentiment Analysis` | Polarity scoring |
| `LangChain Code` | Raw JS LangChain code inside a node |

**Memory sub-nodes:**

| Sub-node | Backend |
|---|---|
| Simple Memory | In-process window buffer |
| Redis Chat Memory | Redis |
| Postgres Chat Memory | Postgres |
| MongoDB Chat Memory | MongoDB |
| Motorhead | Motorhead server |
| Xata | Xata |
| Zep | Zep |

**Vector store root nodes (for RAG):** Azure AI Search, Simple (in-memory), Milvus, MongoDB Atlas, PGVector, Chroma, Pinecone, Qdrant, Redis, Supabase, Weaviate, Zep.

**Tool sub-nodes:** Calculator, Custom Code Tool, MCP Client Tool, SearXNG, SerpApi, Wikipedia, Wolfram Alpha, Vector Store Q&A, Call n8n Workflow, Think Tool, AI Agent Tool (nested agent as tool).

**LLM sub-nodes (chat models):** OpenAI, Anthropic, Azure OpenAI, Google Gemini, Google Vertex, AWS Bedrock, Groq, OpenAI-compatible local provider, Mistral, Cohere, DeepSeek, xAI Grok, OpenRouter, Vercel AI Gateway, Moonshot Kimi, Lemonade, Alibaba Cloud.

**Embeddings sub-nodes:** OpenAI, Azure OpenAI, Bedrock, Google Gemini/PaLM/Vertex, Cohere, HuggingFace, OpenAI-compatible local provider, Mistral, Lemonade.

**Other AI capabilities:**
- `Evaluation` + `Evaluation Trigger` nodes: metric-based LLM eval against test datasets
- `Guardrails` node: policy checking on LLM outputs
- `MCP Server Trigger`: expose n8n workflows as MCP endpoints (callable by Claude, Lovable, etc.)
- `MCP Client Tool`: call MCP-enabled external tools from within a workflow
- **AI Workflow Builder** (beta): describe a workflow in natural language â†’ get a working workflow back
- **Chat Skill registry** (beta): company AI control center â€” give org members access to multiple LLMs + agentic workflows through a single chat interface

### 8.2 How the AI Agent node actually works inside the execution engine

This is the critical section. The AI Agent node is a cluster root node. Its sub-nodes (memory, tools, LLM) are plugged into it as dependencies. When the workflow engine reaches an AI Agent node in `nodeExecutionStack`, here is what happens:

1. `runNode()` dispatches to `executeNode()` as normal.
2. `executeNode()` calls `nodeType.execute(context)` on the `@n8n/n8n-nodes-langchain.agent` node class.
3. The LangChain agent loop runs **inside that single `execute()` call** â€” it is entirely contained within the node's execution context.
4. Tool calls from the agent use the `EngineRequest` / `EngineResponse` pattern: the tool sub-node sends an `EngineRequest` back to the engine, which synchronously executes the sub-workflow for that tool and returns the result. This is a blocking call.
5. Memory sub-nodes are also invoked synchronously within the same `execute()` call.
6. When `execute()` returns, the AI Agent node's output (`INodeExecutionData[]`) is written to `runData`, and the next node in `nodeExecutionStack` is processed.

**The implication:** The AI Agent node does not change the execution model in any way. It is still one item on a sequential stack. The LangChain ReAct loop runs synchronously inside `execute()`. Multiple AI Agent nodes in the same workflow still run one at a time, serialized by the same `processRunExecutionData` loop documented in Â§2.

This means every structural gap in Â§6 applies identically to AI Agent nodes:

| Â§6 Gap | Effect on AI Agent node |
|---|---|
| Sequential stack (Â§6.1) | Two AI Agent nodes in a workflow execute serially, not concurrently |
| No agent-to-agent comms (Â§6.2) | One AI Agent node cannot observe or message another while both "run" â€” they cannot both run simultaneously |
| Memory is node-local (Â§6.3) | Memory sub-nodes are wired per-node; no shared runtime memory OS across the workflow |
| Static graph (Â§6.4) | The AI Agent node cannot spawn new nodes or restructure the DAG mid-execution |
| `waitTill` freeze (Â§6.5) | If an agent waits for human approval, the entire workflow freezes |
| No routing (Â§6.6) | Which AI Agent node handles a task is determined by hard-wired graph edges at build time |
| No persistent identity (implicit) | The AI Agent node has no name, soul, ELO score, or state that survives beyond the current workflow execution |

### 8.3 Independent evaluation score

n8n's AI capabilities were formally evaluated in an independent enterprise AI agent tooling report (Q1 2025, analyst: Andrew Green). Evaluated against 12 tools including Dify, LangFlow, Flowise, Vellum, Make, Camunda, Retool, Windmill, Workato, Relay, Stack AI:

- **Codability score: 65%** (highest tied with Vellum; among the workflow-automation-turned-AI tools, clear leader)
- **Integrability score: 84%** (highest of all 12 tools)

The analyst's note on n8n specifically:
> *"It is the only workflow automation-turned AI development tool that offers good capabilities for Support for Retrieval-Augmented Generation, LLM Parameter customization, and Agentic system building. However, n8n is not the simplest product to use for writing AI agents from scratch â€” some tools can make it easier to write agents."*

Key data point: **MCP, AI Workflow Builder, and Chat Skill registry were explicitly out of scope in that evaluation** (noted in Annex 2). n8n's actual capabilities in 2026 are broader than those scores reflect.

### 8.4 What this means for Agentis positioning

**"n8n for agents" is a broken claim.** n8n already is an agent platform with 65/84 scores, 6 agent archetypes, full RAG pipeline, 10+ vector stores, evaluation/guardrails, and MCP support. A technical prospect will immediately recognise the claim as factually wrong.

The correct frame is a **runtime model distinction**, not a feature comparison:

| Axis | n8n | Agentis |
|---|---|---|
| **When does an agent exist?** | During a workflow execution only | Persistently â€” named, with identity, ELO, history |
| **Who dispatches to agents?** | Hard-wired graph edges at build time | ELO skill-match router at runtime |
| **Can agents run concurrently?** | No â€” sequential `nodeExecutionStack` | Yes â€” true concurrent agent branches |
| **Can agents communicate mid-run?** | No â€” only outputâ†’input at node boundary | Yes â€” broadcast, delegation, observation |
| **Memory ownership** | Per-node sub-node config | Shared runtime memory OS (working/episodic/semantic) |
| **Framework flexibility** | LangChain only | Multi-adapter (OpenClaw, LangGraph, CrewAI, raw) |
| **Canvas model** | Static DAG workflow | Constellation â€” live physics, agent presence, ELO rings |
| **Mission model** | A workflow run | Named mission with scoped agent population and lifecycle |

**Candidate positioning lines:**

- *"n8n routes data through AI. Agentis is where agents live."*
- *"n8n workflows call agents. Agentis agents persist, route themselves, and build memory across missions."*
- *"If n8n is a pipeline that can invoke an agent, Agentis is the runtime where agents are citizens."*

The anchor sentence that will land with technical audiences: **n8n's AI Agent node runs inside a sequential execution stack. It has no identity outside a workflow run. Agentis agents have names, ELO scores, persistent memory, and concurrent execution â€” the agent is the unit, not the workflow.**

### 8.5 What Agentis should not try to replicate

n8n's moat is **integrability at scale**: 1604 integrations, mature trigger system, SOC2, SAML/LDAP, RBAC, Git-based environments, 220 executions/sec queue mode, Docker/K8s deployment, enterprise audit logs. Building that takes a decade.

Agentis should not compete on integrations. The play is to expose Agentis sessions as **MCP endpoints** (n8n supports calling MCP tools) â€” making Agentis agents callable *from within n8n workflows*. This turns n8n's integrability into a distribution channel for Agentis, not a competitive threat.

**Agentis as an MCP server** = n8n users get persistent, ELO-routed, multi-framework agents as tools they can call from their existing n8n workflows. This is the integration story, not the replacement story.



Observations:
"n8n has managed to scale to over 1,600 integrations by moving away from "hard-coding" every connection. Instead, they use a plug-and-play architecture that allows both their internal team and a massive open-source community to build nodes using standardized templates.Here is the breakdown of how they build and maintain such a high volume of integrations:1. The Two Development Approachesn8n uses two distinct "styles" to create nodes, choosing the one that fits the complexity of the service being integrated.Declarative Style (The Fast Lane):Most standard REST APIs are built this way. Instead of writing custom logic for every request, the developer writes a JSON-like configuration (TypeScript) that describes the API endpoints, methods, and parameters. n8nâ€™s core engine then automatically handles the HTTP requests, error handling, and UI rendering.Programmatic Style (The Custom Lane):For services with complex authentication (like OAuth2 with weird quirks), non-standard data formats (like SOAP or XML), or custom logic (like the "Code" node), developers write an execute() function in TypeScript. This gives them full control over how data is processed before it leaves the node.2. Standardized Component ArchitectureEvery integration follows a strict folder structure that makes them modular and easy to review:ComponentFunction.node.tsDefines the UI (fields, dropdowns) and the execution logic..credentials.tsHandles security. Separating this allows the same API key to be used across multiple nodes (e.g., Google Drive and Google Sheets).icons/Contains the brand's SVG logo to maintain the high-branding visual identity.Description.ts(Optional) Contains helper objects to keep the main node file clean.3. Community Nodes (The Force Multiplier)A significant portion of those 1,600+ integrations aren't built by n8n employees. They created a Community Node system that allows any developer to:Clone a Starter Kit repository.Build their node using the n8n SDK.Publish it to npm with the keyword n8n-community-node-package.Users can then install these directly into their n8n instance via the UI.4. The "Radical Efficiency" of the Core Enginen8n uses a Directed Acyclic Graph (DAG) model. The core engine doesn't care what a node does; it only cares that the node accepts an "Array of Objects" (items) and returns an "Array of Objects."Because the input/output contract is so simple, they can swap out a basic "HTTP Request" node for a complex "Salesforce" node without changing how the data flows through the system. This abstraction is what allows them to add dozens of new integrations every month without breaking the core platform.5. Automated Testing and CI/CDTo manage 1,600+ nodes without constant regressions, n8n utilizes:Workflow Tests: Instead of just unit testing code, they run actual n8n workflows that use the nodes to verify they still work against live or mocked APIs.Type Safety: Since everything is written in TypeScript, many bugs are caught during the build process before the node is even deployed.Technical Note: If you are looking into building your own for a project like CentralFood, the n8n-workflow library is the secret sauce. It provides the interfaces (INodeType, IExecuteFunctions) that make your custom logic compatible with their visual editor."

---

## 9. The 10x Platform: Agents as Citizens, Not Passengers

> *To build better lighting, we didn't evolve the candle â€” we created the electric light bulb.*

Everything documented above â€” the sequential stack, the frozen `waitTill`, the static graph, the thin data unit â€” is not a bug list. It is a **worldview**. n8n believes the world is made of **workflows**. Agents, when they appear at all, are passengers carried by a path that was already decided before they woke up.

That worldview was correct for 2019. It is the wrong foundation for what you are building today.

Agentis starts from the opposite belief: **the world is made of agents**. The platform was designed from day one knowing what an agent is â€” not retrofitted to support them. That single decision is where the 10x comes from. Everything else follows.

---

### You have already felt the friction. You just didn't know it had a name.

If you have ever done any of these, you know exactly what this solves:

- Ended a Claude Code system prompt with *"then POST the result to this n8n webhook atâ€¦"*
- Tried to make two AI agents share context through a Merge node and a `staticData` workaround
- Watched a human-approval step freeze your entire run while three other agents could have kept going
- Hard-wired *"if Agent A fails, route to Agent B"* â€” and then ran out of routes
- Opened the execution log to debug an agent and found only `executionStatus: error` with no reasoning, no trace, no chain of thought â€” just a verdict

You were not doing it wrong. You were using a tool designed for data pipelines, trying to coordinate intelligence. The friction was never configurable. It was architectural.

---

### What you can finally do

**Your Claude Code agent has teammates â€” not webhooks.**
Describe the team: a researcher, a validator, a writer. They spin up concurrently, share context natively, and escalate to each other when stuck. You don't wire coordination â€” the platform understands that agents coordinate. Zero webhook spaghetti, zero `Execute Workflow` blocking the thread.

**The canvas shows what your agents are deciding â€” not just whether they finished.**
Not `success`. Not `error`. The actual reasoning trace, the tool call that returned nothing useful, the moment an agent reconsidered its approach. You watch cognition happen in real time. Debugging stops being archaeology.

**One agent waits. The rest of the team doesn't.**
Human approval pending on Agent 3? It pauses. Agents 1, 2, and 4 keep running. When the approval comes through, Agent 3 picks up exactly where it stopped. The mission never freezes because one thread needs a signature.

**Agents find the right help at runtime â€” not at build time.**
No hard-wired edges. No "if this fails, call that." Agents advertise what they are capable of. The platform routes each task to the most capable available agent. An agent that cannot complete something doesn't return an error â€” it delegates. The platform knows who to ask.

**Memory is the air agents breathe â€” not a node you configure.**
Working memory, episodic recall, shared mission context â€” built into the runtime. Every agent in a mission inherits and updates a shared memory layer automatically. Not a vector store sub-node you wire up per agent. Not `staticData`. The platform holds it, and your agents just know.

---

### The one thing that makes it 10x â€” not 2x

Every capability above is a consequence of a single architectural decision: **the agent is the unit, not the workflow**.

In n8n, a workflow is the thing that exists. Agents live inside it temporarily and dissolve when it ends. They have no name outside a run, no capability history, no awareness that other agents exist.

In Agentis, an agent is a persistent runtime citizen. It has an identity. It has memory that survives across runs. It has a capability score that sharpens with use. It knows what other agents are doing and can delegate to them mid-mission. The workflow â€” the execution path â€” is just the trail an agent leaves behind. Not the container it lives in.

This is the light bulb. Not a brighter candle. The model is different at the root.

---

> **You should never have to write a webhook to make two agents talk to each other.**
> That should just work â€” because the platform was born knowing what an agent is.

---

*Agentis is not n8n with an agent mode. It is what you would have built n8n as, if agents had existed first.*
