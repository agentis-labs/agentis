/**
 * WorkspaceHarnessRuntime - the connected orchestrator is a real cognitive
 * runtime even when it is a CLI harness rather than an HTTP model endpoint.
 */
import { eq } from 'drizzle-orm';
import type { AgentAdapter } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import {
  AdapterStructuredCompleter,
  type CompletionUsage,
  type StructuredCompleter,
  type StructuredCompletionArgs,
} from '../structuredCompleter.js';

export interface WorkspaceHarnessRuntime {
  agentId: string;
  agentName: string;
  adapterType: string;
  model: string | null;
  adapter: AgentAdapter;
}

/** Finds the workspace's live cognitive default: orchestrator first, then another connected agent. */
export class WorkspaceHarnessRuntimeResolver {
  constructor(private readonly deps: { db: AgentisSqliteDb; adapters: AdapterManager }) {}

  resolve(workspaceId: string | undefined): WorkspaceHarnessRuntime | null {
    if (!workspaceId) return null;
    const rows = this.deps.db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        role: schema.agents.role,
        status: schema.agents.status,
        isPaused: schema.agents.isPaused,
        runtimeModel: schema.agents.runtimeModel,
        config: schema.agents.config,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all()
      .filter((agent) => !agent.isPaused && agent.status !== 'paused')
      .sort((left, right) => rank(left) - rank(right));

    for (const agent of rows) {
      const adapter = this.deps.adapters.get(agent.id)?.adapter;
      if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) continue;
      return {
        agentId: agent.id,
        agentName: agent.name?.trim() || agent.role || agent.id,
        adapterType: adapter.adapterType,
        model: stringValue(agent.runtimeModel) ?? configuredModel(agent.config),
        adapter,
      };
    }
    return null;
  }

  available(workspaceId: string | undefined): boolean {
    return Boolean(this.resolve(workspaceId));
  }
}

/** Resolves the harness lazily for each call, so boot can finish before agents hydrate. */
export class WorkspaceHarnessStructuredCompleter implements StructuredCompleter {
  readonly label = 'workspace orchestrator harness';
  lastError: string | null = null;
  lastUsage: CompletionUsage | null = null;

  constructor(private readonly resolver: WorkspaceHarnessRuntimeResolver) {}

  async completeStructured<T extends Record<string, unknown>>(args: StructuredCompletionArgs): Promise<T | null> {
    const runtime = this.resolver.resolve(args.workspaceId);
    if (!runtime) {
      this.lastError = 'no connected workspace orchestrator harness is available';
      return null;
    }
    const delegate = new AdapterStructuredCompleter(
      runtime.adapter,
      `workspace orchestrator harness:${runtime.agentId}`,
      runtime.model ?? undefined,
    );
    const result = await delegate.completeStructured<T>(args);
    this.lastError = delegate.lastError;
    this.lastUsage = delegate.lastUsage;
    return result;
  }
}

function rank(agent: { role: string | null; status: string }): number {
  const role = agent.role?.toLowerCase();
  const roleRank = role === 'orchestrator' ? 0 : role === 'manager' ? 1 : 2;
  const statusRank = agent.status === 'online' ? 0 : 1;
  return roleRank * 10 + statusRank;
}

function configuredModel(raw: unknown): string | null {
  try {
    const config = typeof raw === 'string'
      ? JSON.parse(raw) as Record<string, unknown>
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
    return stringValue(config?.model);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
