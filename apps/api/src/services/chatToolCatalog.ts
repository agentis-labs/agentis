/**
 * CHAT_TOOL_CATALOG — CHAT-AGENT-LOOP.md §3.
 *
 * JSON schema descriptors passed to the LLM tool-calling protocol.
 * These schemas tell the model what each tool does, when to use it,
 * and what parameters it accepts. Every entry here should map to a
 * corresponding executor in BUILTIN_REGISTRY or ChatToolExecutor.
 */

import type { ToolDefinition } from '@agentis/core';

export const CHAT_TOOL_CATALOG: ToolDefinition[] = [
  // ─── Platform Control ────────────────────────────────────────────────────
  {
    name: 'agentis.workflow.run',
    description:
      'Start a workflow by its ID with optional input data. Use this when the user asks to ' +
      'run, trigger, or execute a workflow. Returns the runId and initial status so you ' +
      'can follow up with agentis.workflow.status. Always pass a real workflowId, never a workflow title; use agentis.workflow.list or agentis.canvas.context first if needed. Example input: {"workflowId":"8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12","inputs":{"text":"hello"}}.',
    examples: [
      {
        description: 'Run a workflow by UUID with structured trigger input.',
        input: { workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12', inputs: { text: 'hello' } },
        expectedOutput: { runId: 'run_...', workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12', status: 'started' },
      },
      {
        description: 'Run a workflow with no inputs after resolving its ID from context.',
        input: { workflowId: '0b2b16f4-8c70-4e2d-9b4f-4dd6ebf7ec32' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'The ID of the workflow to run.',
        },
        input: {
          type: 'string',
          description: 'JSON-encoded input data to pass to the workflow trigger node.',
        },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'agentis.ephemeral.run',
    description:
      'Run a temporary workflow graph once without saving it to the workflow library. Use for exploratory one-off automations after the operator confirms the graph or intent. Returns the ephemeral runId and stream URL. The run can be promoted later if it proves useful.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the temporary run.' },
        graph: { type: 'object', description: 'Agentis WorkflowGraph JSON to execute once. Trigger nodes are stripped before execution.' },
        inputs: { type: 'object', description: 'Initial input object for root nodes.' },
        maxDurationMs: { type: 'number', description: 'Execution cap in milliseconds, max 300000.' },
      },
      required: ['graph'],
    },
  },
  {
    name: 'agentis.workflow.status',
    description:
      'Get the current execution status of a workflow run. Use this when the user asks about ' +
      'a running workflow, wants to know if it finished, or asks for progress updates. ' +
      'Returns status (PENDING/RUNNING/COMPLETED/FAILED/CANCELLED), progress (0–1), ' +
      'currentNode name, and a summary of completed nodes.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The ID of the workflow run to check. Format: run_<uuid>.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'agentis.workflow.list',
    description:
      'List recent workflow runs for the workspace. Use this when the user asks what ' +
      'workflows have run recently, wants an overview of activity, or needs to find a runId. ' +
      'Returns up to 20 recent runs with status, workflow name, start time, and duration.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status. One of: RUNNING, COMPLETED, FAILED, PENDING, CANCELLED.',
          enum: ['RUNNING', 'COMPLETED', 'FAILED', 'PENDING', 'CANCELLED'],
        },
        limit: {
          type: 'string',
          description: 'Maximum number of runs to return. Default 20, max 50.',
        },
      },
    },
  },
  {
    name: 'agentis.run.cancel',
    description:
      'Cancel a running workflow run by runId. Use this when the user explicitly asks to stop, cancel, or abort a run. Returns the cancelled runId and status.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The workflow run ID to cancel.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'agentis.workflow.patch',
    description:
      'Patch a workflow graph. Use workflowId + graph for an at-rest workflow, or runId + patch for a live run graph patch after diagnosing a concrete issue.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID for at-rest graph replacement.' },
        graph: { type: 'object', description: 'Complete replacement workflow graph.' },
        runId: { type: 'string', description: 'Run ID for live graph patching.' },
        patch: { type: 'object', description: 'WorkflowGraphPatch payload for a live run.' },
      },
    },
  },
  {
    name: 'agentis.apps.status',
    description:
      'Check the health status of all connected agent gateways (apps). Use this when the user ' +
      'asks if agents are connected, asks about gateway health, or troubleshoots connectivity. ' +
      'Returns a list of gateways with their online/offline status and last seen time.',
    parameters: {
      type: 'object',
      properties: {
        gatewayId: {
          type: 'string',
          description: 'Check a specific gateway by ID. Omit to check all gateways.',
        },
      },
    },
  },
  {
    name: 'agentis.agents.list',
    description:
      'List all agents registered in the workspace. Use this when the user asks which agents ' +
      'are available, wants agent names or IDs, or needs to route a task to the right agent. ' +
      'Returns agent id, name, status, team, and adapter type.',
    parameters: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'Filter agents by team ID. Omit to list all agents.',
        },
        status: {
          type: 'string',
          description: 'Filter by agent status. One of: idle, busy, offline, paused.',
          enum: ['idle', 'busy', 'offline', 'paused'],
        },
      },
    },
  },
  {
    name: 'agentis.agents.create',
    description:
      'Create a new configured agent. Use when the user asks to add an agent and has provided enough name/role/runtime detail. If no harness config is provided, the agent is created offline and must be configured before dispatch.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name.' },
        instructions: { type: 'string', description: 'System instructions for the agent.' },
        role: { type: 'string', description: 'Role such as agent, orchestrator, reviewer, or critic.' },
        adapterType: { type: 'string', description: 'Harness adapter type.', enum: ['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http'] },
        runtimeModel: { type: 'string', description: 'Optional runtime model label.' },
        capabilityTags: { type: 'array', description: 'Capability tags for matching work.', items: { type: 'string' } },
        config: { type: 'object', description: 'Adapter-specific harness config.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agentis.agent.spawn',
    description:
      'Spawn a new specialist agent from a role brief. Prefer reusing existing agents when one already matches the task; use this only after the user confirms a new agent is wanted.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name.' },
        instructions: { type: 'string', description: 'Instructions defining the specialist behavior.' },
        role: { type: 'string', description: 'Agent role.' },
        adapterType: { type: 'string', description: 'Harness adapter type.', enum: ['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http'] },
        runtimeModel: { type: 'string', description: 'Optional runtime model label.' },
        capabilityTags: { type: 'array', description: 'Capability tags.', items: { type: 'string' } },
        config: { type: 'object', description: 'Adapter-specific harness config.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agentis.agent.dispatch',
    description:
      'Send a concrete task to an existing agent. Use after selecting a real agentId from agentis.agents.list. Never pass an agent name as agentId. Returns either a chat response or a dispatched task id. Example input: {"agentId":"agent_9d2...","task":"Inspect the failing onboarding workflow and summarize the blocker."}.',
    examples: [
      {
        description: 'Dispatch a bounded analysis task to a real agent ID.',
        input: { agentId: 'agent_9d25f3', task: 'Inspect the failing onboarding workflow and summarize the blocker.', input: { workflowId: 'wf_123' } },
      },
      {
        description: 'Ask an existing worker to produce a draft artifact.',
        input: { agentId: 'agent_researcher_1', task: 'Draft a concise competitor brief from the indexed market research documents.' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent ID.' },
        task: { type: 'string', description: 'Concrete task to perform.' },
        input: { type: 'object', description: 'Optional structured task input.' },
      },
      required: ['agentId', 'task'],
    },
  },

  // ─── Memory & Knowledge ──────────────────────────────────────────────────
  {
    name: 'agentis.memory.read',
    description:
      'Search the workspace persistent memory for notes, learnings, decisions, and facts ' +
      'recorded by agents or operators. Use this when the user references past work, asks ' +
      'what the team has learned, or wants context from previous sessions. ' +
      'Returns matching memory entries sorted by importance.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword or phrase to search for in memory titles, content, and tags.',
        },
        kind: {
          type: 'string',
          description: 'Filter by memory kind. Examples: note, decision, fact, task, learning.',
        },
        agentId: {
          type: 'string',
          description: 'Restrict to memories written by a specific agent.',
        },
        teamId: {
          type: 'string',
          description: 'Restrict to memories scoped to a specific team.',
        },
        limit: {
          type: 'string',
          description: 'Maximum entries to return (1–100, default 20).',
        },
      },
    },
  },
  {
    name: 'agentis.memory.write',
    description:
      'Store a new memory entry in the workspace persistent memory. Use this when you ' +
      'want to remember something important for the future: decisions made, key facts, ' +
      'learnings from a task, or instructions to preserve. Memory persists across sessions.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, descriptive title for this memory entry.',
        },
        content: {
          type: 'string',
          description: 'The full content to store.',
        },
        kind: {
          type: 'string',
          description: 'Memory category. Examples: note, decision, fact, task, learning.',
        },
        importance: {
          type: 'string',
          description: 'Importance score from 1 (low) to 10 (critical). Default 5.',
        },
        tags: {
          type: 'string',
          description: 'JSON array of string tags for filtering. Example: ["workflow","sdr"].',
        },
        agentId: {
          type: 'string',
          description: 'Associate this memory with a specific agent.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'agentis.knowledge.search',
    description:
      'Full-text search across workspace documents, indexed URLs, and knowledge base entries. ' +
      'Use this when the user asks factual questions, wants to look up a document, or ' +
      'references a previously indexed resource. Returns matching excerpts with source metadata. Prefer short keyword-first queries over verbose paragraphs. Example input: {"query":"Agentis workflow node types","limit":"5"}.',
    examples: [
      {
        description: 'Search for architecture notes with a compact keyword query.',
        input: { query: 'Agentis workflow node types', limit: '5' },
      },
      {
        description: 'Find a decision record by a few distinctive terms.',
        input: { query: 'chat orchestrator confirmation policy', limit: '3' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use natural language or keywords.',
        },
        limit: {
          type: 'string',
          description: 'Maximum results to return (default 5, max 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'agentis.knowledge.write',
    description:
      'Index a document, URL, or text snippet into the workspace knowledge base so it can ' +
      'be found by future knowledge.search calls. Use this to preserve research, onboarding ' +
      'docs, or reference material that agents and operators need.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title for this knowledge entry.',
        },
        content: {
          type: 'string',
          description: 'The document text or HTML content to index.',
        },
        url: {
          type: 'string',
          description: 'Source URL if the content was fetched from a URL.',
        },
        tags: {
          type: 'string',
          description: 'JSON array of string tags.',
        },
      },
      required: ['title', 'content'],
    },
  },

  // ─── Decisions & Approvals ───────────────────────────────────────────────
  {
    name: 'agentis.skills.list',
    description:
      'List available workspace skills with real skillIds, runtime, entrypoint, capability tags, and input/output schemas. Use this before building a workflow with skill_task nodes or when the user asks what built-in/custom skills are available. Never invent a skillId; call this tool first. Example input: {"query":"http","limit":10}.',
    examples: [
      {
        description: 'Find built-in or installed skills that can fetch HTTP data.',
        input: { query: 'http', limit: 10 },
        expectedOutput: { skills: [{ id: '...', slug: 'http_fetch', runtime: 'builtin', entrypoint: 'http_fetch' }] },
      },
      {
        description: 'List deterministic in-process skills for cheap workflow steps.',
        input: { runtime: 'builtin', limit: 20 },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword filter across name, slug, entrypoint, runtime, and tags.' },
        runtime: {
          type: 'string',
          description: 'Filter by skill runtime.',
          enum: ['builtin', 'node_worker', 'docker_sandbox'],
        },
        capabilityTag: { type: 'string', description: 'Filter by a capability tag such as builtin, extraction, scoring, or formatting.' },
        limit: { type: 'number', description: 'Maximum skills to return. Default 50, max 200.' },
      },
    },
  },
  {
    name: 'agentis.skill.inspect',
    description:
      'Inspect a single skill by skillId, slug, or builtin entrypoint. Returns the manifest and whether it is usable in workflow skill_task nodes. Use this when you need exact schemas before wiring inputMapping/outputMapping. Example input: {"slug":"http_fetch"}.',
    examples: [
      {
        description: 'Inspect a skill by slug before wiring a skill_task node.',
        input: { slug: 'http_fetch' },
        expectedOutput: { found: true, usableInWorkflows: true, skill: { id: '...', inputSchema: { type: 'object' } } },
      },
      {
        description: 'Inspect by real skill ID returned from agentis.skills.list.',
        input: { skillId: 'skill_123' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'Workspace skill ID. Preferred when known.' },
        slug: { type: 'string', description: 'Workspace skill slug, for example http_fetch.' },
        entrypoint: { type: 'string', description: 'Builtin or package entrypoint, for example echo.' },
      },
    },
  },
  {
    name: 'agentis.approval.list',
    description:
      'List pending approvals waiting for operator decision in the workspace. Use this when ' +
      'the user asks what needs their attention, wants to see pending approvals, or asks ' +
      'what agents are waiting on. Returns approvals with title, summary, and requester.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'Maximum approvals to return (default 10, max 50).',
        },
      },
    },
  },
  {
    name: 'agentis.approval.resolve',
    description:
      'Approve or reject a pending approval by ID. Use this when the user says "approve" or ' +
      '"reject" in response to an approval request, or explicitly instructs you to resolve one. ' +
      'Always confirm the approval title and action with the user before calling this tool ' +
      'unless they have already provided explicit direction. Use agentis.approval.list first if the approvalId is not already known. Example input: {"approvalId":"apr_2f4...","decision":"approve","reason":"Operator approved in chat."}.',
    examples: [
      {
        description: 'Approve a known pending approval after explicit user direction.',
        input: { approvalId: 'apr_2f45c1', decision: 'approve', reason: 'Operator approved in chat.' },
      },
      {
        description: 'Reject a known approval with a short reason.',
        input: { approvalId: 'apr_7ab103', decision: 'reject', reason: 'Incorrect recipient list.' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        approvalId: {
          type: 'string',
          description: 'The ID of the approval to resolve.',
        },
        decision: {
          type: 'string',
          description: 'The decision to apply.',
          enum: ['approve', 'reject'],
        },
        reason: {
          type: 'string',
          description: 'Optional reason or note for this decision.',
        },
      },
      required: ['approvalId', 'decision'],
    },
  },

  // ─── Observability ───────────────────────────────────────────────────────
  {
    name: 'agentis.audit_trail',
    description:
      'Read the ledger events for a specific workflow run. Use this when the user asks what ' +
      'happened during a run, wants to debug a workflow, or asks for a step-by-step trace. ' +
      'Returns ordered ledger events with node names, durations, inputs, and outputs.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The run ID to inspect. Format: run_<uuid>.',
        },
        limit: {
          type: 'string',
          description: 'Maximum events to return (default 100, max 500).',
        },
      },
    },
  },
  {
    name: 'agentis.run.query',
    description:
      'Query run history with filters. Use this to find runs by workflow, status, date range, ' +
      'or agent. Useful when the user wants historical data, metrics, or to find a specific ' +
      'past execution. Returns run summaries with status, duration, and workflow name.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'Filter by workflow ID.',
        },
        status: {
          type: 'string',
          description: 'Filter by status. One of: RUNNING, COMPLETED, FAILED, PENDING, CANCELLED.',
          enum: ['RUNNING', 'COMPLETED', 'FAILED', 'PENDING', 'CANCELLED'],
        },
        since: {
          type: 'string',
          description: 'ISO 8601 date string. Only return runs started after this time.',
        },
        limit: {
          type: 'string',
          description: 'Maximum runs to return (default 20, max 100).',
        },
      },
    },
  },
  {
    name: 'agentis.run.diagnose',
    description:
      'Diagnose why a run failed, stalled, or looks unhealthy. Use this before proposing a patch or retry. Returns failed nodes, recent failure ledger events, and suggested actions.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The run ID to diagnose.',
        },
      },
      required: ['runId'],
    },
  },

  // ─── Builder & Planner ───────────────────────────────────────────────────
  {
    name: 'agentis.build_workflow',
    description:
      'Generate or update a workflow graph from a natural-language description. Use this when ' +
      'the user asks to create, design, build, add, or modify a workflow. Call this tool immediately for clear build requests; do not show JSON for the operator to paste. The tool saves the workflow, emits live canvas build events, and returns workflowId/runId. Example input: {"title":"Hello World","description":"Create a manual workflow that returns { text: \\"Workflow is working\\" }."}.',
    examples: [
      {
        description: 'Build the minimal Hello World workflow directly.',
        input: {
          title: 'Hello World',
          description: 'Create a manual workflow that returns the fixed object { text: "Workflow is working" }.',
        },
        expectedOutput: { workflowId: '...', runId: 'build_...', nodeCount: 2, edgeCount: 1 },
      },
      {
        description: 'Update an existing workflow by ID from a natural-language change request.',
        input: {
          workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12',
          title: 'Weekly Research Digest',
          description: 'Add a human review checkpoint before the Slack notification step.',
        },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Natural-language description of what the workflow should do.',
        },
        title: {
          type: 'string',
          description: 'Desired workflow name.',
        },
        workflowId: {
          type: 'string',
          description: 'Existing workflow ID to update. Omit to create a new one.',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'agentis.app.create',
    description:
      'Create a deployed Agentis app from a natural-language goal. Use this after the operator confirms an app plan. ' +
      'If workflowId is omitted, the tool creates a sensible entry workflow and app canvas automatically.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'What the app should do for the operator.',
        },
        name: {
          type: 'string',
          description: 'Human-facing app name.',
        },
        description: {
          type: 'string',
          description: 'One-line app description.',
        },
        workflowId: {
          type: 'string',
          description: 'Optional existing workflow ID to use as the app entry workflow.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'agentis.app.compose',
    description:
      'Complete or update an existing draft Agentis app. Use this during the app builder flow after the operator describes what the app should do. ' +
      'Updates the app identity, surfaces, entry workflow, worker agents, and app canvas instead of creating a duplicate app.',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'Existing draft app id to complete.',
        },
        slug: {
          type: 'string',
          description: 'Existing draft app slug if appId is unavailable.',
        },
        goal: {
          type: 'string',
          description: 'What the app should do for the operator.',
        },
        name: {
          type: 'string',
          description: 'Updated human-facing app name.',
        },
        description: {
          type: 'string',
          description: 'One-line app description.',
        },
        workflowId: {
          type: 'string',
          description: 'Optional existing workflow ID to use as the app entry workflow.',
        },
        workflowTitle: {
          type: 'string',
          description: 'Title for a generated entry workflow when workflowId is omitted.',
        },
        surfaces: {
          type: 'array',
          description: 'Declared app surfaces such as thread, dashboard, api, webhook_receiver, stream, artifact, page, or embed.',
          items: { type: 'object' },
        },
        agents: {
          type: 'array',
          description: 'Optional worker agents to create for this app. Each item may include name, description, role, adapterType, capabilityTags, and instructions.',
          items: { type: 'object' },
        },
        appGraph: {
          type: 'object',
          description: 'Optional complete App Canvas graph. If omitted, Agentis creates a compact entry workflow to output graph.',
        },
      },
    },
  },
  {
    name: 'agentis.team.design',
    description:
      'Propose an agent team structure for a given objective. Use this when the user asks ' +
      'to design a team, wants to know which agents to create for a task, or asks for a ' +
      'team blueprint. Returns a proposed list of agents with roles, skills, and coordination rules.',
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'Description of the objective this team should accomplish.',
        },
        teamName: {
          type: 'string',
          description: 'Name for the proposed team.',
        },
        teamId: {
          type: 'string',
          description: 'Existing team ID to redesign. Omit for a new team.',
        },
      },
      required: ['brief'],
    },
  },
  {
    name: 'agentis.plan',
    description:
      'Break a complex goal into an ordered list of concrete, executable steps. Use this ' +
      'when the user presents a multi-part objective and you need to organize your approach ' +
      'before acting. Returns a numbered plan with each step described in plain language. ' +
      'Show the plan to the user and proceed step by step.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The goal or objective to plan for.',
        },
        context: {
          type: 'string',
          description: 'Any relevant context about current state, constraints, or available resources.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'agentis.evaluate',
    description:
      'Score an artifact, plan, or output against a set of criteria. Use this to assess ' +
      'quality, completeness, or correctness before presenting something to the user, or ' +
      'when the user asks you to review or rate something. Returns a score and reasoning.',
    parameters: {
      type: 'object',
      properties: {
        artifact: {
          type: 'string',
          description: 'The content to evaluate (text, JSON, plan, workflow description, etc.).',
        },
        criteria: {
          type: 'string',
          description: 'What to evaluate against. Examples: "correctness", "clarity", "completeness".',
        },
      },
      required: ['artifact', 'criteria'],
    },
  },
  {
    name: 'agentis.reflect',
    description:
      'Self-critique the current approach and suggest improvements or alternative strategies. ' +
      'Use this after completing a task that did not go as expected, when stuck in a loop, ' +
      'or when the user asks you to reconsider. Returns a critique and a recommended next action.',
    parameters: {
      type: 'object',
      properties: {
        situation: {
          type: 'string',
          description: 'What has happened so far and why you want to reflect.',
        },
        goal: {
          type: 'string',
          description: 'The original goal you were trying to accomplish.',
        },
      },
      required: ['situation', 'goal'],
    },
  },
  {
    name: 'agentis.canvas.context',
    description:
      'Read the operator\'s current Agentis viewport context and related resource state. Use this when the user asks about "this workflow", "this run", "the canvas", the selected agent, or anything visible on screen. Returns the active surface, resource id/kind, selected items, and relevant workflow/run/agent details when available.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: 'Optional explicit resource id to inspect. Defaults to the active viewport resource.',
        },
        resourceKind: {
          type: 'string',
          description: 'Optional resource kind. Examples: workflow, run, agent.',
          enum: ['workflow', 'run', 'agent', 'team', 'app', 'artifact', 'unknown'],
        },
      },
    },
  },

  // ─── Raw HTTP ────────────────────────────────────────────────────────────
  {
    name: 'http_fetch',
    description:
      'Make an HTTP request to an external URL. Use this when the user wants to fetch data ' +
      'from a website or API, check a URL, or retrieve content from the internet. ' +
      'Returns the response status, headers, and body. Respects workspace HTTP policy.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch. Must be http:// or https://.',
        },
        method: {
          type: 'string',
          description: 'HTTP method. Default GET.',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        },
        headers: {
          type: 'string',
          description: 'JSON object of request headers.',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT/PATCH). Will be sent as JSON.',
        },
      },
      required: ['url'],
    },
  },
  // ─── Spaces ──────────────────────────────────────────────────────────────
  {
    name: 'agentis.space.summary',
    description:
      'Aggregate semantic outcomes (outputLabels) across all apps in a Space over a window. ' +
      'Use this when the user asks how a Space is performing, e.g. "how is sales doing this week?". ' +
      'Returns per-app counts of declared output labels (leads_qualified, meetings_booked, etc.), ' +
      'success rate, run totals, and pending approvals for the workspace.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The ID of the Space to summarize.',
        },
        window: {
          type: 'string',
          description: 'Time window for the aggregate. Default "7d".',
          enum: ['24h', '7d', '30d'],
        },
      },
      required: ['spaceId'],
    },
  },

  // ─── Apps Output surface (APP-OUTPUT-REPLAN.md §10) ─────────────────────
  {
    name: 'agentis.apps.run_status',
    description:
      'Cross-app run status overview. Use at /chat when the operator asks "what are all my apps doing?" or wants a fleet view. Returns one row per installed app with current run status, last result summary, and 7-day run count. Different from agentis.apps.status (which checks gateway connectivity).',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'Maximum apps to return (default 50, max 200).',
        },
      },
    },
  },
  {
    name: 'agentis.app.thread.open',
    description:
      "Hand off the operator from /chat to a specific App Thread. Use when the operator's intent at /chat names or implies one specific app (e.g. 'reschedule the demo' → CRM app). The chat surface receives this tool result and navigates the operator to the App Thread, pre-filling the composer with the carried message. Does NOT mutate state — only signals navigation.",
    parameters: {
      type: 'object',
      properties: {
        appSlug: {
          type: 'string',
          description: 'Slug or id of the target installed app.',
        },
        carriedMessage: {
          type: 'string',
          description: "The operator's original message to pre-fill in the App Thread composer.",
        },
        reason: {
          type: 'string',
          description: 'Short explanation displayed at /chat before navigation.',
        },
      },
      required: ['appSlug'],
    },
  },
];

/** Quick lookup by tool name. */
export const CHAT_TOOL_CATALOG_MAP: Record<string, ToolDefinition> = Object.fromEntries(
  CHAT_TOOL_CATALOG.map((t) => [t.name, t]),
);

/**
 * Build the workspace-scoped tool catalog: the static base PLUS one discrete
 * tool per reusable workflow. Surfacing each reusable workflow as its own
 * named tool (`workflow.<id>`) lets the orchestrator invoke them directly with
 * typed parameters drawn from the workflow's inputContract — far more reliable
 * than asking the model to remember a workflowId and call agentis.workflow.run.
 *
 * The ChatToolExecutor rewrites `workflow.<id>` calls back to
 * agentis.workflow.run, so no new handler is needed.
 */
export interface ReusableWorkflowSummary {
  id: string;
  title: string;
  summary?: string | null;
  inputContract?: {
    fields?: Array<{ key: string; type?: string; required?: boolean; description?: string }>;
  } | null;
}

export function buildWorkspaceToolCatalog(workflows: ReusableWorkflowSummary[]): ToolDefinition[] {
  const dynamic: ToolDefinition[] = [];
  for (const wf of workflows) {
    const fields = wf.inputContract?.fields ?? [];
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const f of fields) {
      const jsonType = f.type === 'number' ? 'number'
        : f.type === 'boolean' ? 'boolean'
        : f.type === 'array' ? 'array'
        : f.type === 'object' ? 'object'
        : 'string';
      properties[f.key] = { type: jsonType, ...(f.description ? { description: f.description } : {}) };
      if (f.required) required.push(f.key);
    }
    dynamic.push({
      name: `workflow.${wf.id}`,
      description:
        `Run the "${wf.title}" workflow.` +
        (wf.summary ? ` ${wf.summary}` : '') +
        ' Inputs map to the workflow trigger. Returns the runId so you can follow up with agentis.workflow.status.',
      parameters: {
        type: 'object',
        properties: fields.length > 0 ? properties : { inputs: { type: 'object', description: 'Free-form inputs for the workflow trigger.' } },
        ...(required.length > 0 ? { required } : {}),
      },
    });
  }
  return [...CHAT_TOOL_CATALOG, ...dynamic];
}
