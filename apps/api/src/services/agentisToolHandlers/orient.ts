/**
 * agentis.orient — the platform describes itself (Agent-Native Platform Plan §F7 / Part 4).
 *
 * The #1 reason agents get lost building INSIDE Agentis: the object model was never
 * re-queryable. Guidance arrived once at `initialize` (and was withheld entirely
 * from mcp_native harnesses), so a cold agent inferred what an App vs Workflow vs
 * Subject vs Connection is from ~70 verb-named tools. `orient` fixes that: it returns
 * the six-primitive model, the caller's CURRENT inventory (so it binds to what exists
 * instead of minting duplicates — grounded generation), and the disclosed v1 ceilings.
 * Re-callable any time; safe (read-only).
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { readResidency } from '../residency.js';

/** The six primitives — the canonical ontology, kept in sync with the platform plan. */
const OBJECT_MODEL = {
  overview:
    'Agentis is one Durable Entity spine projected into six primitives. Build systems by composing these — never by minting a separate app per workflow.',
  primitives: {
    Agent:
      'A persistent worker. Identity + memory that outlive any run. Opt it into `config.residency` to wake on its own clock and act; it carries plan/observations across wakes (save them with agentis.residency.remember). It owns scoped Connections and supervises Subjects.',
    Subject:
      'A durable per-entity actor (a lead, ticket, order, host…). Holds its own long-lived state + inbox; waits days, receives events out of order, drives its own lifecycle independent of any single run. Authored today via conversation scripts (agentis.conversation.define/.enroll) over App datastore rows.',
    Connection:
      'A channel/credential/mcp mount an agent uses to act on the world. OWNED + SCOPED: a connection is open until its first grant, then only its owner agent + granted agents may use it. Discover with agentis.connection.grants; ask for access with agentis.connection.request; operator approves with agentis.connection.grant.',
    Orchestration:
      'How work runs: a workflow graph (build_workflow / evolve) with deterministic nodes where a step is proven and agent nodes where judgment is needed. Conversations, workflows, and listeners are declarations over the same durable core.',
    Experiment:
      'Measurement: variants + success metrics over outcomes. (Substrate landing incrementally — see ceilings.)',
    Interface:
      'The App surface(s): a live declarative view tree (agentis.ui.render) over the App datastore — pipeline boards, inboxes, dashboards. One App can host many workflows + collections + surfaces + agents.',
  },
  relationships: [
    'An App OWNS workflows + collections (datastore) + surfaces + members (agents). It is the grouping entity — put related workflows in ONE App, do not create an App per workflow.',
    'A Connection is bound to an owner Agent (inbound routing) and governed by per-agent grants (outbound authority).',
    'A Subject spans many runs over its life; a run is the transient thing a wake spawns.',
  ],
  creationOrder: [
    '1. Find-or-reuse: call orient (this tool) and check `inventory` — bind to an existing App/agent/connection instead of creating a duplicate.',
    '2. Build the workflow(s) into the App (build_workflow; attach to an existing appId when one fits).',
    '3. Give it data + interface (agentis.data.define_collection, agentis.ui.render).',
    '4. For continuous operation: make the owning agent resident (config.residency) and/or add a cron/listener trigger.',
    '5. For messaging: ensure the agent has a Connection grant (agentis.connection.request → operator grant).',
  ],
  ceilings: [
    'Experiment/variant substrate is partial — variant-tagged success rates are landing incrementally (Agent-Native §3.5).',
    'The general Subject actor is currently scoped to conversation scripts; arbitrary subject types + arbitrary inbox events are being generalized (§3.2).',
    'Residency acting requires the autonomy double-switch (AGENTIS_COMMAND_AUTONOMY + per-workspace opt-in).',
    'Durable-wake recovery covers wait timers, parked sessions, and subflows; other mid-flight executions re-dispatch with an idempotency key, not exact resume.',
  ],
} as const;

export function registerOrientTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.orient',
        family: 'inspect',
        mcpExposed: true,
        description:
          'Orient yourself before building. Returns Agentis\'s object model (the six primitives — Agent, Subject, Connection, Orchestration, Experiment, Interface), the canonical build order, the disclosed platform ceilings, AND your workspace\'s CURRENT inventory (existing apps, workflows, agents, connections) — so you bind to what already exists instead of creating duplicates. Call this first, and again whenever you\'re unsure what exists or how a primitive works.',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
      },
      handler: (_args, ctx) => {
        const ws = ctx.workspaceId;
        const apps = deps.db.select({ id: schema.apps.id, name: schema.apps.name, slug: schema.apps.slug, status: schema.apps.status, ownerAgentId: schema.apps.ownerAgentId })
          .from(schema.apps).where(eq(schema.apps.workspaceId, ws)).all().slice(0, 100);
        const workflows = deps.db.select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
          .from(schema.workflows).where(eq(schema.workflows.workspaceId, ws)).all().slice(0, 200);
        const agents = deps.db.select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, config: schema.agents.config })
          .from(schema.agents).where(eq(schema.agents.workspaceId, ws)).all().slice(0, 100);
        const connections = deps.db.select({ id: schema.channelConnections.id, kind: schema.channelConnections.kind, name: schema.channelConnections.name, ownerAgentId: schema.channelConnections.agentId, status: schema.channelConnections.status })
          .from(schema.channelConnections).where(eq(schema.channelConnections.workspaceId, ws)).all().slice(0, 100);

        return {
          model: OBJECT_MODEL,
          inventory: {
            apps: apps.map((a) => ({ id: a.id, name: a.name, slug: a.slug, status: a.status, ownerAgentId: a.ownerAgentId })),
            workflows: workflows.map((w) => ({ id: w.id, title: w.title, appId: w.appId })),
            agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, resident: readResidency(a.config) != null })),
            connections: connections.map((c) => ({ id: c.id, kind: c.kind, name: c.name, ownerAgentId: c.ownerAgentId, status: c.status })),
            counts: { apps: apps.length, workflows: workflows.length, agents: agents.length, connections: connections.length },
          },
          next: apps.length === 0
            ? 'No apps yet. Build your first workflow into a new App with build_workflow, then give it data + an interface.'
            : 'Apps exist — before building, decide whether your new workflow belongs in an EXISTING app (attach via its appId) rather than a new one.',
        };
      },
    },
  ]);
}
