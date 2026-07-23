/**
 * BrowserSessionManager — lifecycle owner for persistent browser sessions
 * (BROWSERPOOL-10X §Design).
 *
 * Holds the registry of live {@link BrowserSession}s, enforces per-owner + global
 * caps, reaps idle sessions, and guarantees cleanup on run-abort / shutdown so a
 * forgotten session never pins Chromium memory. Sessions are keyed by
 * `${workspaceId}::${owner.kind}:${owner.id}::${sessionId}` — workspaceId in the
 * key means workspace A can never reach into B, and an owner mismatch is reported
 * as NOT_FOUND (we don't leak that someone else's session exists).
 *
 * The manager owns *lifecycle*; the session owns *interaction*. Both reuse the
 * pool's SSRF guard + concurrency budget rather than duplicating them.
 */

import { AgentisError } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { BrowserPool, PWStorageState } from '../browserPool.js';
import { BrowserSession } from './browserSession.js';

export interface SessionOwner {
  kind: 'run' | 'agent';
  id: string;
}

/**
 * Single source of truth for who owns a browser session, so the tool that OPENS
 * a session and the awareness that LISTS it always agree (a mismatch would make
 * the agent blind to its own open session and restart from scratch).
 * Precedence: a workflow run owns it; else a chat is scoped to its CONVERSATION
 * (so "the browser for this chat" is continuous and isolated per conversation);
 * else the agent itself.
 */
export function resolveSessionOwner(ids: { runId?: string | null; conversationId?: string | null; agentId?: string | null }): SessionOwner | null {
  if (ids.runId) return { kind: 'run', id: ids.runId };
  if (ids.conversationId) return { kind: 'agent', id: ids.conversationId };
  if (ids.agentId) return { kind: 'agent', id: ids.agentId };
  return null;
}

/**
 * Render the per-turn "you have a live browser open" awareness block. This is
 * the fix for the agent restarting a task instead of continuing: it makes the
 * open session + its current page part of the agent's situation every turn, and
 * tells it to READ before acting rather than searching again from scratch.
 * Returns '' when nothing is open (so callers can omit the section).
 */
export function renderOpenSessionsBlock(sessions: Array<{ sessionId: string; url: string }>): string {
  if (!sessions.length) return '';
  const lines = sessions.map((s) => `- session "${s.sessionId}" is on ${s.url || 'a blank page'}`);
  return [
    '## Open browser sessions',
    'You already have a LIVE browser open — CONTINUE it, do not start over:',
    ...lines,
    'When the user refers to what is on screen ("the option below", "that result", "scroll down"),',
    'first call browser_session with the SAME sessionId (action:"get"/"navigate"/"scroll") and read the',
    'returned snapshot to see the current page, THEN act on it. Never re-run a fresh search when a',
    'relevant session is already open.',
  ].join('\n');
}

export interface OpenSessionRequest {
  workspaceId: string;
  owner: SessionOwner;
  sessionId: string;
  /** Named auth profile to seed cookies/localStorage from ("log in once, reuse"). */
  restoreAuthName?: string;
  viewport?: { width: number; height: number };
  /**
   * Visibility mode:
   *   'headless' (default) — invisible, on the server.
   *   'visible'  — a real window pops up on the machine running the API (watchable).
   *   'attach'   — the user's own running Chrome over CDP (real logins, their window).
   */
  mode?: 'headless' | 'visible' | 'attach';
  /** For `visible`: persistent profile name so logins survive across runs. */
  profileName?: string;
  /** Run-scoped cancellation — abort closes the session. */
  signal?: AbortSignal;
}

/** Encrypted, workspace-scoped auth-state store (implemented in browserAuthStateStore.ts). */
export interface BrowserAuthStore {
  load(workspaceId: string, name: string): Promise<PWStorageState | null>;
  save(workspaceId: string, userId: string | null, name: string, state: PWStorageState): Promise<void>;
}

export interface BrowserSessionCaps {
  perOwner: number;
  global: number;
  ttlMs: number;
}

const REAPER_INTERVAL_MS = 30_000;

function resolveCaps(override?: Partial<BrowserSessionCaps>): BrowserSessionCaps {
  const num = (raw: string | undefined, fallback: number, max: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  return {
    perOwner: override?.perOwner ?? num(process.env.AGENTIS_BROWSER_SESSION_PER_OWNER, 4, 32),
    global: override?.global ?? num(process.env.AGENTIS_BROWSER_SESSION_MAX, 20, 128),
    ttlMs: override?.ttlMs ?? num(process.env.AGENTIS_BROWSER_SESSION_TTL_MS, 5 * 60_000, 60 * 60_000),
  };
}

export class BrowserSessionManager {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #byOwner = new Map<string, Set<string>>();
  readonly #caps: BrowserSessionCaps;
  #reaper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: BrowserPool,
    private readonly deps: {
      logger: Logger;
      authStore?: BrowserAuthStore;
      /** Per-workspace policy for attaching to the user's real Chrome (Settings → Governance opt-in). */
      resolveRealChromeAllowed?: (workspaceId: string) => boolean;
    },
    caps?: Partial<BrowserSessionCaps>,
  ) {
    this.#caps = resolveCaps(caps);
  }

  /** Open (or re-attach to) a named session for an owner. Idempotent per key. */
  async openSession(req: OpenSessionRequest): Promise<BrowserSession> {
    this.#requireStr(req.workspaceId, 'workspaceId');
    this.#requireStr(req.sessionId, 'sessionId');
    const key = this.#key(req.workspaceId, req.owner, req.sessionId);

    const existing = this.#sessions.get(key);
    if (existing && !existing.isClosing) {
      this.#wireAbort(existing, req.signal);
      return existing;
    }

    this.#enforceCaps(req.owner);

    let storageState: PWStorageState | undefined;
    if (req.restoreAuthName) {
      if (!this.deps.authStore) {
        throw new AgentisError('VALIDATION_FAILED', 'browser auth store not wired — cannot restore auth profile');
      }
      storageState = (await this.deps.authStore.load(req.workspaceId, req.restoreAuthName)) ?? undefined;
      if (!storageState) {
        throw new AgentisError('RESOURCE_NOT_FOUND', `browser auth profile "${req.restoreAuthName}" not found`);
      }
    }

    const surface = await this.pool.openSessionSurface({
      mode: req.mode ?? 'headless',
      ...(storageState ? { storageState } : {}),
      ...(req.viewport ? { viewport: req.viewport } : {}),
      ...(req.profileName ? { profileName: req.profileName } : {}),
      // Real-Chrome attach is gated by the per-workspace opt-in (env master wins).
      ...(req.mode === 'attach' && this.deps.resolveRealChromeAllowed
        ? { allowCdp: this.deps.resolveRealChromeAllowed(req.workspaceId) }
        : {}),
    });
    const session = new BrowserSession(
      key,
      req.workspaceId,
      req.sessionId,
      this.pool,
      surface.page,
      { close: surface.close, storageState: surface.storageState },
      Date.now(),
    );

    this.#sessions.set(key, session);
    this.#ownerSet(req.owner).add(key);
    this.#ensureReaper();
    this.#wireAbort(session, req.signal);
    this.deps.logger.info('browser.session.opened', { workspaceId: req.workspaceId, sessionId: req.sessionId, owner: `${req.owner.kind}:${req.owner.id}`, mode: req.mode ?? 'headless' });
    return session;
  }

  /**
   * List an owner's live sessions (with current url) — feeds the orchestrator's
   * per-turn awareness so the agent CONTINUES an open session instead of
   * restarting from scratch. Cheap: url is read synchronously.
   */
  listForOwner(workspaceId: string, owner: SessionOwner): Array<{ sessionId: string; url: string; lastUsedAt: number }> {
    const keys = this.#byOwner.get(this.#ownerKey(owner)) ?? new Set<string>();
    const out: Array<{ sessionId: string; url: string; lastUsedAt: number }> = [];
    for (const key of keys) {
      const s = this.#sessions.get(key);
      if (s && !s.isClosing && s.workspaceId === workspaceId) {
        out.push({ sessionId: s.sessionId, url: s.currentUrl(), lastUsedAt: s.lastUsedAt });
      }
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Resolve a live session or throw NOT_FOUND (also used to reject owner mismatches). */
  getSession(workspaceId: string, owner: SessionOwner, sessionId: string): BrowserSession {
    const session = this.#sessions.get(this.#key(workspaceId, owner, sessionId));
    if (!session || session.isClosing) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `browser session "${sessionId}" not found or expired`);
    }
    return session;
  }

  /** Persist a session's live auth state under a reusable workspace-scoped name. */
  async saveAuthState(workspaceId: string, userId: string | null, owner: SessionOwner, sessionId: string, name: string): Promise<void> {
    if (!this.deps.authStore) {
      throw new AgentisError('VALIDATION_FAILED', 'browser auth store not wired — cannot save auth profile');
    }
    this.#requireStr(name, 'name');
    const session = this.getSession(workspaceId, owner, sessionId);
    const state = await session.exportStorageState();
    await this.deps.authStore.save(workspaceId, userId, name, state);
    this.deps.logger.info('browser.session.auth_saved', { workspaceId, sessionId, name });
  }

  async closeSession(workspaceId: string, owner: SessionOwner, sessionId: string): Promise<void> {
    await this.#closeKey(this.#key(workspaceId, owner, sessionId), owner);
  }

  /** Close every session belonging to an owner — called on run settle/abort. */
  async closeOwner(owner: SessionOwner): Promise<void> {
    const ownerKey = this.#ownerKey(owner);
    const keys = [...(this.#byOwner.get(ownerKey) ?? [])];
    for (const key of keys) await this.#closeKey(key, owner);
    this.#byOwner.delete(ownerKey);
  }

  async shutdown(): Promise<void> {
    if (this.#reaper) {
      clearInterval(this.#reaper);
      this.#reaper = null;
    }
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#byOwner.clear();
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }

  /** Live session count — for tests/observability. */
  get size(): number {
    return this.#sessions.size;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #enforceCaps(owner: SessionOwner): void {
    const ownerCount = this.#byOwner.get(this.#ownerKey(owner))?.size ?? 0;
    if (ownerCount >= this.#caps.perOwner) {
      throw new AgentisError('VALIDATION_FAILED', `browser session limit reached for this owner (max ${this.#caps.perOwner}) — close a session first`);
    }
    if (this.#sessions.size >= this.#caps.global) {
      // Evict the globally least-recently-used session to make room.
      const lru = [...this.#sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (lru) {
        void this.#closeKey(lru.key, null);
      }
      if (this.#sessions.size >= this.#caps.global) {
        throw new AgentisError('VALIDATION_FAILED', `global browser session limit reached (max ${this.#caps.global})`);
      }
    }
  }

  async #closeKey(key: string, owner: SessionOwner | null): Promise<void> {
    const session = this.#sessions.get(key);
    if (!session) return;
    this.#sessions.delete(key);
    if (owner) {
      this.#byOwner.get(this.#ownerKey(owner))?.delete(key);
    } else {
      for (const set of this.#byOwner.values()) set.delete(key);
    }
    await session.close().catch(() => {});
  }

  #wireAbort(session: BrowserSession, signal?: AbortSignal): void {
    if (!signal) return;
    if (signal.aborted) {
      void this.#closeKey(session.key, null);
      return;
    }
    signal.addEventListener('abort', () => { void this.#closeKey(session.key, null); }, { once: true });
  }

  #ensureReaper(): void {
    if (this.#reaper) return;
    this.#reaper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.#sessions.values()]) {
        if (now - session.lastUsedAt > this.#caps.ttlMs) {
          this.deps.logger.info('browser.session.reaped_idle', { sessionId: session.sessionId, idleMs: now - session.lastUsedAt });
          void this.#closeKey(session.key, null);
        }
      }
    }, REAPER_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  #ownerSet(owner: SessionOwner): Set<string> {
    const k = this.#ownerKey(owner);
    let set = this.#byOwner.get(k);
    if (!set) {
      set = new Set<string>();
      this.#byOwner.set(k, set);
    }
    return set;
  }

  #ownerKey(owner: SessionOwner): string {
    return `${owner.kind}:${owner.id}`;
  }

  #key(workspaceId: string, owner: SessionOwner, sessionId: string): string {
    return `${workspaceId}::${owner.kind}:${owner.id}::${sessionId}`;
  }

  #requireStr(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AgentisError('VALIDATION_FAILED', `browser session requires a non-empty "${field}"`);
    }
    return value.trim();
  }
}
