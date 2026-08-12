import { AgentisError, type ExtensionPermission } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { BrowserQueryField, BrowserSession } from '../services/browser/browserSession.js';
import type { BrowserSessionManager, SessionOwner } from '../services/browser/browserSessionManager.js';
import type { ExtensionBrowserCheckpointStore } from './browserCheckpointStore.js';

const MAX_BRIDGE_JSON_BYTES = 1_000_000;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ExtensionBrowserInvocationContext {
  workspaceId: string;
  extensionId: string;
  runId?: string;
  taskId?: string;
  permissions: ExtensionPermission[];
  allowedDomains: string[];
  signal?: AbortSignal;
}

export interface ExtensionBrowserInvocation {
  call(action: string, args: unknown[]): Promise<unknown>;
  finish(): Promise<void>;
}

/** Backend-neutral contract injected into the extension runtime. */
export interface ExtensionBrowserBackend {
  createInvocation(context: ExtensionBrowserInvocationContext): ExtensionBrowserInvocation;
  refreshExtension(workspaceId: string, extensionId: string): Promise<void>;
  cleanupExtension(workspaceId: string, extensionId: string): Promise<void>;
  health(workspaceId?: string): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}

interface PersistentSessionRef {
  workspaceId: string;
  extensionId: string;
  sessionName: string;
  viewport?: { width: number; height: number };
}

/** Local implementation backed by the existing BrowserPool/BrowserSessionManager. */
export class LocalExtensionBrowserBackend implements ExtensionBrowserBackend {
  readonly #persistent = new Map<string, PersistentSessionRef>();

  constructor(
    private readonly sessions: BrowserSessionManager,
    private readonly checkpoints: ExtensionBrowserCheckpointStore,
    private readonly logger: Logger,
  ) {
    this.sessions.setBeforeCloseHook(async ({ workspaceId, owner, sessionId, session }) => {
      if (owner.kind !== 'extension') return;
      const ref = this.#persistent.get(this.#key({ workspaceId, extensionId: owner.id, sessionName: sessionId }));
      if (!ref) return;
      this.checkpoints.save(workspaceId, owner.id, sessionId, {
        storageState: await session.exportStorageState(),
        lastUrl: session.currentUrl(),
        ...(ref.viewport ? { viewport: ref.viewport } : {}),
      });
      this.#persistent.delete(this.#key(ref));
    });
  }

  createInvocation(context: ExtensionBrowserInvocationContext): ExtensionBrowserInvocation {
    return new LocalInvocation(this, context);
  }

  async cleanupExtension(workspaceId: string, extensionId: string): Promise<void> {
    await this.sessions.closeOwner(this.#owner(extensionId));
    this.checkpoints.removeExtension(workspaceId, extensionId);
    for (const [key, ref] of this.#persistent) {
      if (ref.workspaceId === workspaceId && ref.extensionId === extensionId) this.#persistent.delete(key);
    }
  }

  /** Apply new permissions/domain policy without discarding resumable state. */
  async refreshExtension(workspaceId: string, extensionId: string): Promise<void> {
    const refs = [...this.#persistent.values()].filter(
      (ref) => ref.workspaceId === workspaceId && ref.extensionId === extensionId,
    );
    for (const ref of refs) await this.checkpoint(ref).catch(() => {});
    await this.sessions.closeOwner(this.#owner(extensionId));
    for (const ref of refs) this.#persistent.delete(this.#key(ref));
  }

  async health(workspaceId?: string): Promise<Record<string, unknown>> {
    return {
      available: await this.sessions.available(),
      backend: 'local',
      activeSessions: this.sessions.size,
      capacity: this.sessions.capacity,
      trackedPersistentSessions: [...this.#persistent.values()].filter((ref) => !workspaceId || ref.workspaceId === workspaceId).length,
      checkpoints: this.checkpoints.count(workspaceId),
      checkpointing: true,
    };
  }

  async shutdown(): Promise<void> {
    for (const ref of this.#persistent.values()) await this.checkpoint(ref).catch(() => {});
  }

  session(context: ExtensionBrowserInvocationContext, sessionName: string): BrowserSession {
    return this.sessions.getSession(context.workspaceId, this.#owner(context.extensionId), sessionName);
  }

  async open(
    context: ExtensionBrowserInvocationContext,
    opts: Record<string, unknown>,
  ): Promise<{ session: string; opened: true; resumed: boolean; url: string }> {
    this.#require(context, 'browser');
    const sessionName = validSession(opts.session);
    const resume = opts.resume === true;
    if (resume) this.#require(context, 'browser.session.persist');
    const authProfile = stringValue(opts.authProfile);
    if (authProfile) this.#require(context, 'browser.auth');
    const viewport = viewportValue(opts.viewport);
    const checkpoint = resume ? this.checkpoints.load(context.workspaceId, context.extensionId, sessionName) : null;
    const session = await this.sessions.openSession({
      workspaceId: context.workspaceId,
      owner: this.#owner(context.extensionId),
      sessionId: sessionName,
      mode: 'headless',
      allowedDomains: context.allowedDomains,
      ...(viewport ? { viewport } : checkpoint?.viewport ? { viewport: checkpoint.viewport } : {}),
      ...(checkpoint?.storageState ? { storageState: checkpoint.storageState } : {}),
      ...(!checkpoint && authProfile ? { restoreAuthName: authProfile } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (resume) {
      const ref = { workspaceId: context.workspaceId, extensionId: context.extensionId, sessionName, ...(viewport ? { viewport } : checkpoint?.viewport ? { viewport: checkpoint.viewport } : {}) };
      this.#persistent.set(this.#key(ref), ref);
    }
    if (checkpoint?.lastUrl && session.currentUrl() === 'about:blank') await session.navigate(checkpoint.lastUrl);
    return { session: sessionName, opened: true, resumed: Boolean(checkpoint), url: session.currentUrl() };
  }

  async checkpoint(ref: PersistentSessionRef): Promise<void> {
    const session = this.sessions.getSession(ref.workspaceId, this.#owner(ref.extensionId), ref.sessionName);
    const storageState = await session.exportStorageState();
    this.checkpoints.save(ref.workspaceId, ref.extensionId, ref.sessionName, {
      storageState,
      lastUrl: session.currentUrl(),
      ...(ref.viewport ? { viewport: ref.viewport } : {}),
    });
  }

  markPersistent(context: ExtensionBrowserInvocationContext, sessionName: string): PersistentSessionRef {
    this.#require(context, 'browser.session.persist');
    const ref = { workspaceId: context.workspaceId, extensionId: context.extensionId, sessionName };
    this.#persistent.set(this.#key(ref), ref);
    return this.#persistent.get(this.#key(ref))!;
  }

  persistentRef(context: ExtensionBrowserInvocationContext, sessionName: string): PersistentSessionRef | undefined {
    return this.#persistent.get(this.#key({ workspaceId: context.workspaceId, extensionId: context.extensionId, sessionName }));
  }

  forget(ref: PersistentSessionRef): void {
    this.#persistent.delete(this.#key(ref));
  }

  removeCheckpoint(ref: PersistentSessionRef): void {
    this.checkpoints.remove(ref.workspaceId, ref.extensionId, ref.sessionName);
  }

  close(context: ExtensionBrowserInvocationContext, sessionName: string): Promise<void> {
    return this.sessions.closeSession(context.workspaceId, this.#owner(context.extensionId), sessionName);
  }

  logAction(
    context: ExtensionBrowserInvocationContext,
    action: string,
    session: string,
    durationMs: number,
    domain?: string,
    failure?: unknown,
  ): void {
    const capacity = this.sessions.capacity;
    const message = failure instanceof Error ? failure.message : failure ? String(failure) : '';
    this.logger.info('extension.browser.action', {
      workspaceId: context.workspaceId,
      extensionId: context.extensionId,
      runId: context.runId,
      taskId: context.taskId,
      action,
      session,
      durationMs,
      status: failure ? 'failed' : 'completed',
      timedOut: /timeout/i.test(message),
      operationQueueDepth: capacity.operations.queued,
      activeOperations: capacity.operations.active,
      ...(domain ? { domain } : {}),
    });
  }

  require(context: ExtensionBrowserInvocationContext, permission: ExtensionPermission): void {
    this.#require(context, permission);
  }

  #require(context: ExtensionBrowserInvocationContext, permission: ExtensionPermission): void {
    if (!context.permissions.includes(permission)) {
      throw new AgentisError('EXTENSION_PERMISSION_DENIED', `ctx.browser requires the \`${permission}\` permission`);
    }
    if (permission === 'browser' && context.allowedDomains.length === 0) {
      throw new AgentisError('EXTENSION_NETWORK_VIOLATION', 'ctx.browser requires at least one allowedDomains entry');
    }
  }

  #owner(extensionId: string): SessionOwner {
    return { kind: 'extension', id: extensionId };
  }

  #key(ref: Pick<PersistentSessionRef, 'workspaceId' | 'extensionId' | 'sessionName'>): string {
    return `${ref.workspaceId}::${ref.extensionId}::${ref.sessionName}`;
  }
}

class LocalInvocation implements ExtensionBrowserInvocation {
  readonly #touched = new Set<string>();
  #finished = false;

  constructor(
    private readonly backend: LocalExtensionBrowserBackend,
    private readonly context: ExtensionBrowserInvocationContext,
  ) {}

  async call(action: string, args: unknown[]): Promise<unknown> {
    if (this.#finished) throw new AgentisError('VALIDATION_FAILED', 'browser invocation has already finished');
    ensureJsonBounded(args, 'ctx.browser arguments');
    const startedAt = Date.now();
    const sessionName = action === 'open' ? validSession(recordValue(args[0]).session) : validSession(args[0]);
    let domain: string | undefined;
    let failure: unknown;
    try {
      let result: unknown;
      if (action === 'open') {
        result = await this.backend.open(this.context, recordValue(args[0]));
      } else {
        this.backend.require(this.context, 'browser');
        const session = this.backend.session(this.context, sessionName);
        const payload = args[1];
        switch (action) {
          case 'navigate': {
            const url = requiredString(payload, 'url');
            domain = hostname(url);
            result = await session.navigate(url);
            break;
          }
          case 'click': result = await session.click(requiredString(payload, 'selector')); break;
          case 'fill': result = await session.fill(requiredString(payload, 'selector'), requiredString(args[2], 'value')); break;
          case 'type': result = await session.type(requiredString(payload, 'selector'), requiredString(args[2], 'text'), numberValue(args[3])); break;
          case 'press': result = await session.press(requiredString(payload, 'key'), stringValue(args[2])); break;
          case 'selectOption': result = await session.selectOption(requiredString(payload, 'selector'), stringOrStrings(args[2], 'value')); break;
          case 'hover': result = await session.hover(requiredString(payload, 'selector')); break;
          case 'scroll': result = await session.scroll(scrollValue(payload)); break;
          case 'waitFor': result = await session.waitFor(waitValue(payload)); break;
          case 'get': result = await session.get(getValue(payload)); break;
          case 'queryAll': result = await session.queryAll(queryAllValue(payload)); break;
          case 'evaluate':
            this.backend.require(this.context, 'browser.evaluate');
            result = await session.evaluate(requiredString(payload, 'expression'), true);
            break;
          case 'checkpoint': {
            const ref = this.backend.persistentRef(this.context, sessionName) ?? this.backend.markPersistent(this.context, sessionName);
            await this.backend.checkpoint(ref);
            result = { checkpointed: true, session: sessionName };
            break;
          }
          case 'close': {
            const opts = recordValue(payload);
            const persist = opts.persist === true;
            let ref = this.backend.persistentRef(this.context, sessionName);
            if (persist) {
              ref ??= this.backend.markPersistent(this.context, sessionName);
              await this.backend.checkpoint(ref);
            } else if (ref) {
              this.backend.removeCheckpoint(ref);
            }
            if (ref) this.backend.forget(ref);
            await this.backend.close(this.context, sessionName);
            result = { closed: true, persisted: persist, session: sessionName };
            break;
          }
          default: throw new AgentisError('VALIDATION_FAILED', `Unknown ctx.browser action ${action}`);
        }
      }
      const persistent = this.backend.persistentRef(this.context, sessionName);
      if (persistent) this.#touched.add(sessionName);
      ensureJsonBounded(result, 'ctx.browser result');
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.backend.logAction(this.context, action, sessionName, Date.now() - startedAt, domain, failure);
    }
  }

  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    for (const sessionName of this.#touched) {
      const ref = this.backend.persistentRef(this.context, sessionName);
      if (ref) await this.backend.checkpoint(ref);
    }
  }
}

function validSession(value: unknown): string {
  const session = requiredString(value, 'session');
  if (!SESSION_NAME.test(session)) throw new AgentisError('VALIDATION_FAILED', 'ctx.browser session must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}');
  return session;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentisError('VALIDATION_FAILED', `ctx.browser requires non-empty ${field}`);
  return value.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrStrings(value: unknown, field: string): string | string[] {
  if (Array.isArray(value) && value.length > 0) return value.map((entry) => requiredString(entry, field));
  return requiredString(value, field);
}

function viewportValue(value: unknown): { width: number; height: number } | undefined {
  const raw = recordValue(value);
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return undefined;
  return {
    width: Math.max(320, Math.min(Math.floor(raw.width), 3840)),
    height: Math.max(240, Math.min(Math.floor(raw.height), 2160)),
  };
}

function scrollValue(value: unknown): { dx?: number; dy?: number; toBottom?: boolean } {
  const raw = recordValue(value);
  return {
    ...(numberValue(raw.dx) !== undefined ? { dx: numberValue(raw.dx) } : {}),
    ...(numberValue(raw.dy) !== undefined ? { dy: numberValue(raw.dy) } : {}),
    ...(raw.toBottom === true ? { toBottom: true } : {}),
  };
}

function waitValue(value: unknown): { selector?: string; state?: 'attached' | 'detached' | 'visible' | 'hidden'; navigation?: boolean; timeoutMs?: number } {
  const raw = recordValue(value);
  const state = stringValue(raw.state);
  if (state && !['attached', 'detached', 'visible', 'hidden'].includes(state)) throw new AgentisError('VALIDATION_FAILED', `Invalid waitFor state ${state}`);
  return {
    ...(stringValue(raw.selector) ? { selector: stringValue(raw.selector) } : {}),
    ...(state ? { state: state as 'attached' | 'detached' | 'visible' | 'hidden' } : {}),
    ...(raw.navigation === true ? { navigation: true } : {}),
    ...(numberValue(raw.timeoutMs) !== undefined ? { timeoutMs: numberValue(raw.timeoutMs) } : {}),
  };
}

function getValue(value: unknown): { selector: string; what: 'text' | 'value' | 'attribute' | 'innerHTML'; attribute?: string } {
  const raw = recordValue(value);
  const what = stringValue(raw.what) ?? 'text';
  if (!['text', 'value', 'attribute', 'innerHTML'].includes(what)) throw new AgentisError('VALIDATION_FAILED', `Invalid get mode ${what}`);
  return {
    selector: requiredString(raw.selector, 'selector'),
    what: what as 'text' | 'value' | 'attribute' | 'innerHTML',
    ...(stringValue(raw.attribute) ? { attribute: stringValue(raw.attribute) } : {}),
  };
}

function queryAllValue(value: unknown): { selector: string; fields: Record<string, BrowserQueryField>; limit?: number } {
  const raw = recordValue(value);
  const fieldsRaw = recordValue(raw.fields);
  const fields: Record<string, BrowserQueryField> = {};
  for (const [name, candidate] of Object.entries(fieldsRaw).slice(0, 100)) {
    const field = recordValue(candidate);
    const what = stringValue(field.what) ?? 'text';
    if (!['text', 'value', 'attribute', 'innerHTML'].includes(what)) throw new AgentisError('VALIDATION_FAILED', `Invalid queryAll field mode ${what}`);
    fields[name] = {
      ...(stringValue(field.selector) ? { selector: stringValue(field.selector) } : {}),
      what: what as BrowserQueryField['what'],
      ...(stringValue(field.attribute) ? { attribute: stringValue(field.attribute) } : {}),
    };
  }
  if (Object.keys(fields).length === 0) throw new AgentisError('VALIDATION_FAILED', 'queryAll requires at least one field');
  return {
    selector: requiredString(raw.selector, 'selector'),
    fields,
    ...(numberValue(raw.limit) !== undefined ? { limit: numberValue(raw.limit) } : {}),
  };
}

function hostname(raw: string): string | undefined {
  try { return new URL(raw).hostname; } catch { return undefined; }
}

function ensureJsonBounded(value: unknown, label: string): void {
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new AgentisError('VALIDATION_FAILED', `${label} must be JSON serializable`); }
  if (Buffer.byteLength(json ?? '', 'utf8') > MAX_BRIDGE_JSON_BYTES) {
    throw new AgentisError('VALIDATION_FAILED', `${label} exceeds ${MAX_BRIDGE_JSON_BYTES} bytes`);
  }
}
