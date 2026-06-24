import { randomUUID } from 'node:crypto';
import {
  AgentisError,
  dataQuerySchema,
  registeredCapabilitySchema,
  type AppManifest,
  type CapabilityInvocationRecord,
  type InvokeCtx,
  type RegisteredCapability,
  type SurfaceAction,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { LedgerService } from './ledger.js';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';
import type { AgentToolRuntime } from './agentToolRuntime.js';
import { buildAppStores } from '@agentis/app';

export type CapabilityHandler = (input: Record<string, unknown>, ctx: InvokeCtx) => Promise<unknown> | unknown;

export interface CapabilityRegistryDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  nativeTools?: AgentisToolRegistry;
  toolRuntime?: AgentToolRuntime;
  ledger?: LedgerService;
  recordInvocation?: (record: CapabilityInvocationRecord) => Promise<void> | void;
  callWorkflow?: (args: {
    workspaceId: string;
    ambientId: string | null;
    actingSeatId: string;
    workflowId: string;
    inputs: Record<string, unknown>;
  }) => Promise<unknown>;
}

interface RuntimeCapability {
  capability: RegisteredCapability;
  handler: CapabilityHandler;
}

export class CapabilityRegistry {
  readonly #registered = new Map<string, RuntimeCapability>();
  readonly #deps: CapabilityRegistryDeps;
  readonly #stores: ReturnType<typeof buildAppStores>;

  constructor(deps: CapabilityRegistryDeps) {
    this.#deps = deps;
    this.#stores = buildAppStores({ db: deps.db });
  }

  register(capability: RegisteredCapability, handler: CapabilityHandler): void {
    const parsed = registeredCapabilitySchema.parse(capability);
    if (this.#registered.has(parsed.id) || this.#nativeCapability(parsed.id)) {
      throw new AgentisError('RESOURCE_CONFLICT', `capability '${parsed.id}' is already registered`);
    }
    this.#registered.set(parsed.id, { capability: parsed, handler });
  }

  registerMany(entries: Array<{ capability: RegisteredCapability; handler: CapabilityHandler }>): void {
    for (const entry of entries) this.register(entry.capability, entry.handler);
  }

  /**
   * Project an installed App's declared actions/capabilities into the registry.
   * Re-running this method refreshes that app's capabilities in place.
   */
  registerAppCapabilities(args: { workspaceId: string; appId: string; manifest?: AppManifest }): RegisteredCapability[] {
    this.#stores.store.get(args.workspaceId, args.appId);
    this.#unregisterApp(args.appId);
    const projected: RuntimeCapability[] = [];
    const actions = this.#stores.surfaces
      .list(args.workspaceId, args.appId)
      .flatMap((surface) => surface.actions.map((action) => ({ surface: surface.name, action })));

    for (const { surface, action } of actions) {
      projected.push(this.#appActionCapability(args.appId, surface, action));
    }

    for (const decl of args.manifest?.capabilities ?? []) {
      const action = actions.find((candidate) => candidate.action.name === decl.target || candidate.action.name === decl.name);
      const cap: RegisteredCapability = {
        id: appCapabilityId(args.appId, decl.name),
        name: decl.name,
        ...(decl.description ? { description: decl.description } : {}),
        inputSchema: decl.inputSchema ?? action?.action.inputSchema ?? { type: 'object' },
        outputSchema: decl.outputSchema,
        source: { kind: 'app', appId: args.appId },
        scopes: decl.scopes,
        tags: decl.tags,
        auth: 'none',
        mutating: true,
      };
      projected.push({
        capability: registeredCapabilitySchema.parse(cap),
        handler: (input, ctx) => action
          ? this.#invokeAppAction(args.appId, action.action, input, ctx)
          : this.#invokeAppTarget(args.appId, decl.target, input, ctx),
      });
    }

    for (const entry of projected) this.#registered.set(entry.capability.id, entry);
    return projected.map((entry) => entry.capability).sort(compareCapability);
  }

  list(filter: { source?: RegisteredCapability['source']['kind']; tag?: string } = {}): RegisteredCapability[] {
    const caps = [
      ...this.#nativeCapabilities(),
      ...Array.from(this.#registered.values()).map((entry) => entry.capability),
    ];
    return caps
      .filter((cap) => !filter.source || cap.source.kind === filter.source)
      .filter((cap) => !filter.tag || cap.tags.includes(filter.tag))
      .sort(compareCapability);
  }

  resolve(intent: string): RegisteredCapability[] {
    const q = intent.toLowerCase().trim();
    if (!q) return [];
    return this.list().filter((cap) =>
      cap.id.toLowerCase() === q
      || cap.name.toLowerCase() === q
      || cap.name.toLowerCase().includes(q)
      || cap.tags.some((tag) => tag.toLowerCase() === q),
    );
  }

  async invoke(id: string, input: unknown, ctx: InvokeCtx): Promise<unknown> {
    const native = this.#nativeCapability(id);
    if (native) return this.#invokeWithLedger(native.capability, input, ctx, native.handler);
    const registered = this.#registered.get(id);
    if (!registered) throw new AgentisError('RESOURCE_NOT_FOUND', `capability '${id}' is not registered`);
    return this.#invokeWithLedger(registered.capability, input, ctx, registered.handler);
  }

  async #invokeWithLedger(
    capability: RegisteredCapability,
    input: unknown,
    ctx: InvokeCtx,
    handler: CapabilityHandler,
  ): Promise<unknown> {
    if (ctx.executionMode === 'plan' && capability.mutating) {
      throw new AgentisError('VALIDATION_FAILED', `capability '${capability.id}' cannot mutate state in Plan mode`);
    }
    const args = coerceArgs(input);
    const validation = validateArgs(capability.inputSchema, args);
    if (!validation.ok) throw new AgentisError('VALIDATION_FAILED', validation.reason);
    const startedAt = Date.now();
    try {
      const output = await handler(args, ctx);
      await this.#record({ capability, ctx, ok: true, durationMs: Date.now() - startedAt });
      return output;
    } catch (err) {
      const error = err instanceof AgentisError
        ? err
        : new AgentisError('INTERNAL_ERROR', err instanceof Error ? err.message : 'capability invocation failed');
      await this.#record({
        capability,
        ctx,
        ok: false,
        durationMs: Date.now() - startedAt,
        errorCode: error.code,
        errorMessage: error.message,
      });
      this.#deps.logger.warn('capability.invoke_failed', {
        capabilityId: capability.id,
        source: capability.source,
        workspaceId: ctx.workspaceId,
        error: error.message,
      });
      throw error;
    }
  }

  async #record(args: {
    capability: RegisteredCapability;
    ctx: InvokeCtx;
    ok: boolean;
    durationMs: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const record: CapabilityInvocationRecord = {
      capabilityId: args.capability.id,
      source: args.capability.source,
      workspaceId: args.ctx.workspaceId,
      actingSeatId: args.ctx.actingSeatId,
      ...(args.ctx.callerAgentId ? { callerAgentId: args.ctx.callerAgentId } : {}),
      ...(args.ctx.appId ? { callingAppId: args.ctx.appId } : {}),
      ...(args.ctx.runId ? { runId: args.ctx.runId } : {}),
      ok: args.ok,
      durationMs: args.durationMs,
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    };
    await this.#deps.recordInvocation?.(record);
    if (this.#deps.ledger && args.ctx.runId) {
      await this.#deps.ledger.append({
        workspaceId: args.ctx.workspaceId,
        ambientId: args.ctx.ambientId ?? null,
        runId: args.ctx.runId,
        eventType: 'capability.invoke',
        payload: record as unknown as Record<string, unknown>,
      }).catch(() => {});
    }
  }

  #nativeCapabilities(): RegisteredCapability[] {
    return (this.#deps.nativeTools?.catalog().tools ?? []).map((tool) =>
      registeredCapabilitySchema.parse({
        id: nativeCapabilityId(tool.id),
        name: tool.id,
        description: tool.description,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
        outputSchema: tool.outputSchema,
        source: { kind: 'native' },
        scopes: tool.requires ?? [],
        tags: [tool.family],
        mutating: tool.mutating,
        latency: 'fast',
      }),
    );
  }

  #nativeCapability(id: string): RuntimeCapability | undefined {
    if (!this.#deps.nativeTools || !id.startsWith('native.')) return undefined;
    const toolId = id.slice('native.'.length);
    const tool = this.#deps.nativeTools.get(toolId);
    if (!tool) return undefined;
    const capability = registeredCapabilitySchema.parse({
      id,
      name: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
      outputSchema: tool.outputSchema,
      source: { kind: 'native' },
      scopes: tool.requires ?? [],
      tags: [tool.family],
      mutating: tool.mutating,
      latency: 'fast',
    });
    return {
      capability,
      handler: async (input, ctx) => {
        const result = await this.#deps.nativeTools!.execute(
          { id: randomUUID(), toolId, arguments: input },
          {
            workspaceId: ctx.workspaceId,
            userId: ctx.actingSeatId,
            ambientId: ctx.ambientId ?? null,
            ...(ctx.callerAgentId ? { agentId: ctx.callerAgentId } : {}),
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            executionMode: ctx.executionMode,
            caller: 'system',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        );
        if (!result.ok) {
          throw new AgentisError('VALIDATION_FAILED', result.errorMessage ?? `native tool '${toolId}' failed`);
        }
        return result.output;
      },
    };
  }

  #appActionCapability(appId: string, surface: string, action: SurfaceAction): RuntimeCapability {
    const capability = registeredCapabilitySchema.parse({
      id: appCapabilityId(appId, action.name),
      name: action.name,
      description: `App action '${action.name}' on surface '${surface}'`,
      inputSchema: action.inputSchema ?? { type: 'object' },
      source: { kind: 'app', appId },
      scopes: [action.target],
      tags: ['app', action.kind],
      mutating: true,
      latency: action.kind === 'workflow' ? 'batch' : 'fast',
    });
    return { capability, handler: (input, ctx) => this.#invokeAppAction(appId, action, input, ctx) };
  }

  async #invokeAppAction(appId: string, action: SurfaceAction, input: Record<string, unknown>, ctx: InvokeCtx): Promise<unknown> {
    this.#stores.store.get(ctx.workspaceId, appId);
    if (action.kind === 'data') return this.#invokeDataTarget(appId, action.target, input, ctx);
    if (action.kind === 'tool') return this.#invokeToolTarget(appId, action.target, input, ctx);
    if (action.kind === 'workflow') {
      if (!this.#deps.callWorkflow) throw new AgentisError('VALIDATION_FAILED', 'workflow capability actions are not wired in this runtime');
      return this.#deps.callWorkflow({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId ?? null,
        actingSeatId: ctx.actingSeatId,
        workflowId: action.target,
        inputs: input,
      });
    }
    throw new AgentisError('VALIDATION_FAILED', `unknown action kind: ${(action as { kind: string }).kind}`);
  }

  async #invokeAppTarget(appId: string, target: string, input: Record<string, unknown>, ctx: InvokeCtx): Promise<unknown> {
    const action = this.#stores.surfaces
      .list(ctx.workspaceId, appId)
      .flatMap((surface) => surface.actions)
      .find((candidate) => candidate.name === target);
    if (action) return this.#invokeAppAction(appId, action, input, ctx);
    if (target.startsWith('agentis.')) return this.#invokeToolTarget(appId, target, input, ctx);
    if (target.includes('.')) return this.#invokeDataTarget(appId, target, input, ctx);
    throw new AgentisError('RESOURCE_NOT_FOUND', `app capability target '${target}' was not found`);
  }

  #invokeDataTarget(appId: string, target: string, input: Record<string, unknown>, ctx: InvokeCtx): unknown {
    const [collection, op] = target.split('.');
    if (!collection || !op) throw new AgentisError('VALIDATION_FAILED', `data capability target must be "collection.op": ${target}`);
    switch (op) {
      case 'insert':
        return this.#stores.data.insert(ctx.workspaceId, appId, collection, asRecord(input.record) ?? input, ctx.callerAgentId ?? ctx.actingSeatId);
      case 'update':
        return this.#stores.data.update(ctx.workspaceId, appId, collection, str(input.id, 'id'), asRecord(input.patch) ?? {});
      case 'upsert':
        return this.#stores.data.upsert(
          ctx.workspaceId,
          appId,
          collection,
          asRecord(input.match) ?? {},
          asRecord(input.record) ?? {},
          ctx.callerAgentId ?? ctx.actingSeatId,
        );
      case 'delete':
        this.#stores.data.delete(ctx.workspaceId, appId, collection, str(input.id, 'id'));
        return { ok: true };
      case 'query':
        return this.#stores.data.query(ctx.workspaceId, appId, collection, dataQuerySchema.parse(input));
      default:
        throw new AgentisError('VALIDATION_FAILED', `unknown data capability op: ${op}`);
    }
  }

  async #invokeToolTarget(appId: string, target: string, input: Record<string, unknown>, ctx: InvokeCtx): Promise<unknown> {
    if (this.#deps.nativeTools?.has(target)) {
      return this.invoke(nativeCapabilityId(target), input, { ...ctx, appId });
    }
    if (this.#deps.toolRuntime) {
      const result = await this.#deps.toolRuntime.execute(ctx.workspaceId, target as never, input, undefined, {
        appId,
        agentId: ctx.callerAgentId ?? ctx.actingSeatId,
      });
      if (!result.ok) throw new AgentisError('VALIDATION_FAILED', result.error ?? `tool '${target}' failed`);
      return result.result;
    }
    throw new AgentisError('VALIDATION_FAILED', `tool capability target '${target}' is not wired`);
  }

  #unregisterApp(appId: string): void {
    for (const [id, entry] of this.#registered) {
      if (entry.capability.source.kind === 'app' && entry.capability.source.appId === appId) this.#registered.delete(id);
    }
  }
}

export function nativeCapabilityId(toolId: string): string {
  return `native.${toolId}`;
}

export function appCapabilityId(appId: string, name: string): string {
  return `app.${appId}.${name}`;
}

export function pluginCapabilityId(service: string, name: string): string {
  return `plugin.${service}.${name}`;
}

function coerceArgs(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentisError('VALIDATION_FAILED', 'capability input must be an object');
  }
  return input as Record<string, unknown>;
}

function validateArgs(schema: unknown, args: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (!schema || typeof schema !== 'object') return { ok: true };
  const s = schema as { type?: unknown; required?: unknown };
  if (s.type === 'object' || Array.isArray(s.required)) {
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === 'string' && !(key in args)) return { ok: false, reason: `missing required argument '${key}'` };
      }
    }
  }
  return { ok: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentisError('VALIDATION_FAILED', `argument '${name}' must be a non-empty string`);
  return value;
}

function compareCapability(left: RegisteredCapability, right: RegisteredCapability): number {
  return left.id.localeCompare(right.id);
}
