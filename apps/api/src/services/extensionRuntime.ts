/**
 * Extension runtime - deterministic sandboxed capability execution.
 *
 * This is the canonical runtime for executable workflow extensions.
 */

import { and, eq } from 'drizzle-orm';
import { CONSTANTS, AgentisError } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest, ExtensionOperation, ExtensionPermission } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { runBuiltin, BUILTIN_LONG_RUNNING_TIMEOUTS } from './builtinExtensions.js';
import { runNodeWorkerExtension } from '../extensions/nodeWorkerRuntime.js';
import { runDockerSandboxExtension } from '../extensions/dockerSandboxRuntime.js';
import type { ExtensionKvStore } from '../extensions/kv.js';

/** Minimal cursor surface the ExtensionSource passes to a listener-source op. */
export interface ListenerSourceCursor {
  read(): unknown;
  write(value: unknown): void;
}

export interface ExecuteListenerSourceArgs {
  workspaceId: string;
  extensionId?: string;
  extensionSlug?: string;
  operationName: string;
  config: Record<string, unknown>;
  cursor?: ListenerSourceCursor;
  onEmit: (payload: Record<string, unknown>) => void;
}

export interface ExtensionExecuteArgs {
  workspaceId: string;
  extensionId?: string;
  extensionSlug?: string;
  operationName?: string;
  version?: string;
  runId?: string;
  taskId?: string;
  input: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
  /**
   * Run-scoped cancellation. Aborting resolves the execution with an honest
   * EXTENSION_ABORTED outcome immediately; the node_worker isolate is disposed
   * (real termination), and other sandboxes remain bounded by their own
   * timeout — cancellation never leaves the caller waiting.
   */
  signal?: AbortSignal;
}

export class ExtensionRuntime {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly options: { dockerEnabled: boolean },
    private readonly kv?: ExtensionKvStore,
  ) {}

  /**
   * Run an extension operation under the Listener source contract
   * (EXTENSIONS-AND-LISTENER-10X §1.8). The operation receives `ctx.emit`,
   * `ctx.cursor`, `ctx.setCursor`, and `ctx.kv` and is expected to call
   * `ctx.emit(payload)` for each event it detects. Only node_worker extensions
   * that declare the `listener` permission and mark the operation as a listener
   * source are eligible.
   */
  async executeListenerSource(args: ExecuteListenerSourceArgs): Promise<void> {
    const extension = this.#resolveExtension({
      workspaceId: args.workspaceId,
      extensionId: args.extensionId,
      extensionSlug: args.extensionSlug,
      input: {},
      scratchpadSnapshot: {},
      operationName: args.operationName,
    });
    const manifest = normalizeExtensionManifest(extension.manifest, extension);
    validateExtensionManifest(manifest, { install: false });
    const permissions = manifest.permissions ?? [];
    if (!permissions.includes('listener')) {
      throw new AgentisError('EXTENSION_PERMISSION_DENIED', `Extension ${manifest.slug} does not grant the \`listener\` permission`);
    }
    const operation = manifest.operations.find((o) => o.name === args.operationName);
    if (!operation) {
      throw new AgentisError('EXTENSION_OPERATION_NOT_FOUND', `Extension ${manifest.slug} has no operation ${args.operationName}`);
    }
    const isSource = operation.isListenerSource || (manifest.listenerOperations ?? []).includes(operation.name);
    if (!isSource) {
      throw new AgentisError('EXTENSION_PERMISSION_INVALID', `Operation ${args.operationName} is not declared as a listener source`);
    }
    if (manifest.runtime !== 'node_worker') {
      throw new AgentisError('EXTENSION_PERMISSION_INVALID', 'Only node_worker extensions can be listener sources');
    }
    const source = typeof manifest.source === 'string' ? manifest.source : '';
    if (!source) throw new AgentisError('VALIDATION_FAILED', 'node_worker extension is missing inline source');

    const kv = this.kv;
    const outcome = await runNodeWorkerExtension({
      manifest,
      operationName: args.operationName,
      source,
      input: args.config,
      scratchpad: {},
      allowedDomains: Array.isArray(manifest.allowedDomains) ? manifest.allowedDomains : [],
      permissions,
      allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
      timeoutMs: clampTimeout(manifest.timeoutMs),
      logger: this.logger,
      listenerHooks: {
        emit: args.onEmit,
        getCursor: () => args.cursor?.read(),
        setCursor: (value) => args.cursor?.write(value),
        kvGet: (key) => kv?.get(args.workspaceId, extension.id, key),
        kvSet: (key, value, ttlSeconds) => kv?.set(args.workspaceId, extension.id, key, value, ttlSeconds),
      },
    });
    if (!outcome.ok) {
      throw new AgentisError(
        outcome.errorCode === 'EXTENSION_PERMISSION_DENIED' ? 'EXTENSION_PERMISSION_DENIED' : 'EXTENSION_INTERNAL',
        outcome.message,
      );
    }
  }

  async execute(args: ExtensionExecuteArgs): Promise<ExtensionExecutionOutcome> {
    const extension = this.#resolveExtension(args);
    const manifest = normalizeExtensionManifest(extension.manifest, extension);
    validateExtensionManifest(manifest, { install: false });
    const operationName = args.operationName ?? manifest.operations[0]?.name ?? 'execute';
    const operation = manifest.operations.find((candidate) => candidate.name === operationName);
    if (!operation) {
      throw new AgentisError('EXTENSION_OPERATION_NOT_FOUND', `Extension ${manifest.slug} has no operation named ${operationName}`);
    }

    const startedAt = Date.now();
    // Builtin entrypoints that shell out to real host work (harvest/curate/seed/
    // deploy) need a large execution budget. When the stored manifest carries no
    // explicit timeoutMs, fall back to the per-entrypoint long-running budget
    // instead of the 30s default — otherwise a real Vercel deploy (pnpm install
    // + two project builds + HTTP probes) is killed mid-flight at 30s.
    const builtinBudget =
      manifest.runtime === 'builtin' && (!manifest.timeoutMs || manifest.timeoutMs <= 0)
        ? BUILTIN_LONG_RUNNING_TIMEOUTS[manifest.entrypoint ?? operationName]
        : undefined;
    const timeoutMs = clampTimeout(manifest.timeoutMs || builtinBudget);
    let outcome: ExtensionExecutionOutcome;

    // Run-scoped cancellation: settle immediately with an honest ABORTED
    // outcome when the run is stopped mid-execution. The sandbox itself stays
    // bounded by its own timeout, so nothing leaks.
    const raceAbort = async (work: Promise<ExtensionExecutionOutcome>): Promise<ExtensionExecutionOutcome> => {
      const signal = args.signal;
      if (!signal) return work;
      if (signal.aborted) {
        work.catch(() => {});
        throw new Error('__ABORTED__');
      }
      return await new Promise<ExtensionExecutionOutcome>((resolve, reject) => {
        const onAbort = () => reject(new Error('__ABORTED__'));
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
          (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
          (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
      });
    };

    try {
      if (args.signal?.aborted) throw new Error('__ABORTED__');
      switch (manifest.runtime) {
        case 'builtin':
          outcome = await raceAbort(withTimeout(
            runBuiltin(manifest, operationName, args.input, args.scratchpadSnapshot),
            timeoutMs,
          ));
          break;
        case 'node_worker': {
          const source = typeof manifest.source === 'string' ? manifest.source : '';
          if (!source) {
            outcome = {
              ok: false,
              errorCode: 'VALIDATION_FAILED',
              message: 'node_worker extension manifest is missing inline `source` field',
              durationMs: Date.now() - startedAt,
              operationName,
            };
            break;
          }
          outcome = await raceAbort(runNodeWorkerExtension({
            manifest,
            operationName,
            source,
            input: args.input,
            scratchpad: args.scratchpadSnapshot,
            allowedDomains: Array.isArray(manifest.allowedDomains) ? manifest.allowedDomains : [],
            permissions: manifest.permissions ?? [],
            allowPrivateNetwork:
              String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
            timeoutMs,
            logger: this.logger,
            ...(args.signal ? { signal: args.signal } : {}),
          }));
          break;
        }
        case 'docker_sandbox':
          if (!this.options.dockerEnabled) {
              outcome = {
                ok: false,
                errorCode: 'EXTENSION_DOCKER_UNAVAILABLE',
                message: 'Docker is not enabled on this host (set AGENTIS_EXTENSION_DOCKER=true)',
                durationMs: Date.now() - startedAt,
                operationName,
              };
          } else {
            const bundleDir = typeof manifest.bundleDir === 'string' ? manifest.bundleDir : '';
            if (!bundleDir) {
              outcome = {
                ok: false,
                errorCode: 'VALIDATION_FAILED',
                message: 'docker_sandbox extension manifest is missing `bundleDir`',
                durationMs: Date.now() - startedAt,
                operationName,
              };
              break;
            }
            outcome = await raceAbort(runDockerSandboxExtension({
              manifest,
              operationName,
              bundleDir,
              input: args.input,
              scratchpad: args.scratchpadSnapshot,
              allowedDomains: Array.isArray(manifest.allowedDomains) ? manifest.allowedDomains : [],
              timeoutMs,
              logger: this.logger,
            }));
          }
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === '__TIMEOUT__';
      const isAborted = message === '__ABORTED__';
      outcome = {
        ok: false,
        errorCode: isTimeout ? 'EXTENSION_TIMEOUT' : isAborted ? 'EXTENSION_ABORTED' : 'EXTENSION_INTERNAL',
        message: isTimeout
          ? `Extension timed out after ${timeoutMs}ms`
          : isAborted
            ? 'Extension cancelled (run aborted)'
            : message,
        durationMs: Date.now() - startedAt,
        operationName,
      };
    }

    try {
      this.db
        .insert(schema.extensionExecutions)
        .values({
          id: crypto.randomUUID(),
          workspaceId: args.workspaceId,
          extensionId: extension.id,
          operationName,
          runId: args.runId ?? null,
          taskId: args.taskId ?? null,
          status: outcome.ok ? 'completed' : 'failed',
          durationMs: outcome.durationMs,
          errorCode: outcome.ok ? null : outcome.errorCode,
          errorMessage: outcome.ok ? null : outcome.message,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
        })
        .run();
    } catch (err) {
      this.logger.warn('extension.execution.persist_failed', {
        extensionId: extension.id,
        err: (err as Error).message,
      });
    }

    return outcome;
  }

  #resolveExtension(args: ExtensionExecuteArgs): typeof schema.extensions.$inferSelect {
    if (args.extensionId) {
      const row = this.db
        .select()
        .from(schema.extensions)
        .where(eq(schema.extensions.id, args.extensionId))
        .get();
      if (!row || row.workspaceId !== args.workspaceId) {
        throw new AgentisError('EXTENSION_NOT_FOUND', `Extension ${args.extensionId} not found`);
      }
      return row;
    }
    if (!args.extensionSlug) {
      throw new AgentisError('VALIDATION_FAILED', 'extensionId or extensionSlug is required');
    }
    const row = this.db
      .select()
      .from(schema.extensions)
      .where(and(eq(schema.extensions.workspaceId, args.workspaceId), eq(schema.extensions.slug, args.extensionSlug)))
      .get();
    if (!row) {
      throw new AgentisError('EXTENSION_NOT_FOUND', `Extension ${args.extensionSlug} not found`);
    }
    if (args.version && args.version !== row.version) {
      throw new AgentisError('EXTENSION_NOT_FOUND', `Extension ${args.extensionSlug}@${args.version} is not installed`);
    }
    return row;
  }
}

export function normalizeExtensionManifest(
  value: unknown,
  row?: Pick<typeof schema.extensions.$inferSelect, 'name' | 'slug' | 'version' | 'runtime'>,
): ExtensionManifest {
  const source = value && typeof value === 'object' ? value as Partial<ExtensionManifest> : {};
  const operations = normalizeOperations(source);
  return {
    name: String(source.name ?? row?.name ?? ''),
    slug: String(source.slug ?? row?.slug ?? ''),
    version: String(source.version ?? row?.version ?? '1.0.0'),
    runtime: (source.runtime ?? row?.runtime ?? 'node_worker') as ExtensionManifest['runtime'],
    entrypoint: String(source.entrypoint ?? 'index.js'),
    description: typeof source.description === 'string' ? source.description : undefined,
    author: typeof source.author === 'string' ? source.author : undefined,
    homepage: typeof source.homepage === 'string' ? source.homepage : undefined,
    icon: typeof source.icon === 'string' ? source.icon : undefined,
    operations,
    permissions: normalizePermissions(source.permissions),
    credentialKeys: normalizeCredentialKeys(source.credentialKeys),
    categories: Array.isArray(source.categories) ? source.categories.filter((v): v is string => typeof v === 'string') : undefined,
    capabilityTags: Array.isArray(source.capabilityTags) ? source.capabilityTags.filter((v): v is string => typeof v === 'string') : [],
    timeoutMs: typeof source.timeoutMs === 'number' ? source.timeoutMs : undefined,
    allowedDomains: Array.isArray(source.allowedDomains) ? source.allowedDomains.filter((v): v is string => typeof v === 'string') : undefined,
    source: typeof source.source === 'string' ? source.source : undefined,
    bundleDir: typeof source.bundleDir === 'string' ? source.bundleDir : undefined,
    listenerOperations: Array.isArray(source.listenerOperations)
      ? source.listenerOperations.filter((v): v is string => typeof v === 'string')
      : operations.filter((o) => o.isListenerSource).map((o) => o.name),
  };
}

export function validateExtensionManifest(manifest: ExtensionManifest, opts: { install: boolean }): void {
  const permissions = manifest.permissions ?? [];
  const listenerOperations = manifest.operations.filter((operation) =>
    operation.isListenerSource || (manifest.listenerOperations ?? []).includes(operation.name),
  );
  if (!manifest.name.trim() || !manifest.slug.trim()) {
    throw new AgentisError('EXTENSION_MANIFEST_INVALID', 'Extension name and slug are required');
  }
  if (!manifest.operations.length) {
    throw new AgentisError('EXTENSION_MANIFEST_INVALID', `Extension ${manifest.slug} must declare at least one operation`);
  }
  for (const operation of manifest.operations) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operation.name)) {
      throw new AgentisError('EXTENSION_MANIFEST_INVALID', `Extension operation "${operation.name}" must be a valid JavaScript export name`);
    }
  }
  const unknownListenerOperations = (manifest.listenerOperations ?? []).filter((name) =>
    !manifest.operations.some((operation) => operation.name === name),
  );
  if (unknownListenerOperations.length > 0) {
    throw new AgentisError(
      'EXTENSION_MANIFEST_INVALID',
      `Extension ${manifest.slug} declares unknown listener operation(s): ${unknownListenerOperations.join(', ')}`,
    );
  }
  if (permissions.includes('listener') && listenerOperations.length === 0) {
    throw new AgentisError(
      'EXTENSION_MANIFEST_INVALID',
      `Extension ${manifest.slug} declares listener permission but no operation is marked as a listener source`,
    );
  }
  if (listenerOperations.length > 0 && !permissions.includes('listener')) {
    throw new AgentisError(
      'EXTENSION_PERMISSION_INVALID',
      `Extension ${manifest.slug} has listener source operations but is missing listener permission`,
    );
  }
  if (listenerOperations.length > 0 && !permissions.includes('listener.emit')) {
    throw new AgentisError(
      'EXTENSION_PERMISSION_INVALID',
      `Extension ${manifest.slug} has listener source operations but is missing listener.emit permission`,
    );
  }
  if (
    listenerOperations.some((operation) => operation.listenerConfig?.cursorSupported)
    && !permissions.includes('listener.cursor')
  ) {
    throw new AgentisError(
      'EXTENSION_PERMISSION_INVALID',
      `Extension ${manifest.slug} uses a listener cursor but is missing listener.cursor permission`,
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new AgentisError('EXTENSION_VERSION_INVALID', `Extension ${manifest.slug} version must be SemVer`);
  }
  if (permissions.includes('network') && (!manifest.allowedDomains || manifest.allowedDomains.length === 0)) {
    throw new AgentisError('EXTENSION_MANIFEST_INVALID', `Extension ${manifest.slug} declares network but has no allowedDomains`);
  }
  if (permissions.includes('credentials') && (!manifest.credentialKeys || manifest.credentialKeys.length === 0)) {
    throw new AgentisError('EXTENSION_MANIFEST_INVALID', `Extension ${manifest.slug} declares credentials but has no credentialKeys`);
  }
  if (permissions.includes('spawn') && manifest.runtime !== 'docker_sandbox') {
    throw new AgentisError('EXTENSION_PERMISSION_INVALID', 'spawn permission is only valid for docker_sandbox extensions');
  }
  if (opts.install && permissions.includes('network.unrestricted')) {
    const enabled = String(process.env.AGENTIS_EXTENSION_ALLOW_UNRESTRICTED_NETWORK ?? '').toLowerCase() === 'true';
    if (!enabled) {
      throw new AgentisError('EXTENSION_UNRESTRICTED_NETWORK_DISABLED', 'network.unrestricted requires AGENTIS_EXTENSION_ALLOW_UNRESTRICTED_NETWORK=true');
    }
  }
}

function normalizeOperations(source: Partial<ExtensionManifest>): ExtensionOperation[] {
  if (Array.isArray(source.operations)) {
    return source.operations
      .filter((operation): operation is ExtensionOperation =>
        Boolean(operation)
        && typeof operation === 'object'
        && typeof operation.name === 'string'
        && operation.name.trim().length > 0,
      )
      .map((operation) => ({
        name: operation.name.trim(),
        description: typeof operation.description === 'string' ? operation.description : undefined,
        inputSchema: operation.inputSchema && typeof operation.inputSchema === 'object' ? operation.inputSchema : {},
        outputSchema: operation.outputSchema && typeof operation.outputSchema === 'object' ? operation.outputSchema : {},
        isListenerSource: operation.isListenerSource === true ? true : undefined,
        listenerConfig: operation.listenerConfig && typeof operation.listenerConfig === 'object' ? operation.listenerConfig : undefined,
      }));
  }

  const legacy = source as Partial<ExtensionManifest> & {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  };
  return [{
    name: 'execute',
    description: source.description,
    inputSchema: legacy.inputSchema && typeof legacy.inputSchema === 'object' ? legacy.inputSchema : {},
    outputSchema: legacy.outputSchema && typeof legacy.outputSchema === 'object' ? legacy.outputSchema : {},
  }];
}

function normalizeCredentialKeys(value: unknown): ExtensionManifest['credentialKeys'] {
  if (!Array.isArray(value)) return undefined;
  const normalized: NonNullable<ExtensionManifest['credentialKeys']> = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      normalized.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { key?: unknown; label?: unknown; required?: unknown };
    if (typeof candidate.key !== 'string' || !candidate.key.trim()) continue;
    normalized.push({
      key: candidate.key.trim(),
      label: typeof candidate.label === 'string' ? candidate.label : undefined,
      required: typeof candidate.required === 'boolean' ? candidate.required : true,
    });
  }
  return normalized;
}

export function normalizePermissions(value: unknown): ExtensionPermission[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<ExtensionPermission>([
    'network',
    'network.unrestricted',
    'credentials',
    'workspace.read',
    'workspace.write',
    'filesystem',
    'spawn',
    'listener',
    'listener.emit',
    'listener.cursor',
    'kv.read',
    'kv.write',
  ]);
  return [...new Set(value.filter((v): v is ExtensionPermission => typeof v === 'string' && allowed.has(v as ExtensionPermission)))];
}

function clampTimeout(requested?: number): number {
  const max = CONSTANTS.EXTENSION_EXECUTION_MAX_TIMEOUT_MS;
  if (!requested || requested <= 0) return CONSTANTS.EXTENSION_EXECUTION_TIMEOUT_MS;
  return Math.min(requested, max);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('__TIMEOUT__')), ms).unref?.(),
    ),
  ]);
}
