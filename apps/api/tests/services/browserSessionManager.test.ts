/**
 * BrowserSessionManager — persistent session lifecycle (BROWSERPOOL-10X).
 *
 * Uses fake pool/context/page so the behavior under test (keying, persistence
 * across calls, owner isolation, caps + LRU eviction, reaper, abort, auth save)
 * is verified without a real Chromium install.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentisError } from '@agentis/core';
import { createLogger } from '../../src/logger.js';
import { BrowserSessionManager, resolveSessionOwner, renderOpenSessionsBlock, type SessionOwner, type BrowserAuthStore } from '../../src/services/browser/browserSessionManager.js';
import type { BrowserPool, PWPage, PWStorageState } from '../../src/services/browserPool.js';

const logger = createLogger({ level: 'error' });

class FakePage {
  #url = 'about:blank';
  goto = vi.fn(async (u: string) => { this.#url = u; });
  url = () => this.#url;
  title = async () => 'Fake Title';
  innerText = async () => 'fake body text';
}

class FakeContext {
  closed = false;
  page = new FakePage();
  state: PWStorageState = { cookies: [{ name: 's', value: 'v' }], origins: [] };
  newPage = async () => this.page as unknown as PWPage;
  storageState = async () => this.state;
  close = vi.fn(async () => { this.closed = true; });
}

function fakePool(): { pool: BrowserPool; contexts: FakeContext[]; opens: Array<Record<string, unknown>> } {
  const contexts: FakeContext[] = [];
  const opens: Array<Record<string, unknown>> = [];
  const pool = {
    // Mirrors BrowserPool.openSessionSurface: returns a normalized {page, storageState, close}.
    openSessionSurface: vi.fn(async (opts: Record<string, unknown>) => {
      opens.push(opts);
      const ctx = new FakeContext();
      contexts.push(ctx);
      const page = await ctx.newPage();
      return { page, storageState: () => ctx.storageState(), close: () => ctx.close() };
    }),
    resolveSafeNavUrl: vi.fn(async (u: string) => u),
    withConcurrencySlot: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  } as unknown as BrowserPool;
  return { pool, contexts, opens };
}

const run = (id: string): SessionOwner => ({ kind: 'run', id });
const agent = (id: string): SessionOwner => ({ kind: 'agent', id });

describe('BrowserSessionManager', () => {
  it('keeps a session alive across separate calls (same key ⇒ same session)', async () => {
    const { pool, contexts } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });

    const s1 = await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'sess' });
    const nav = await s1.navigate('https://example.com/login');
    expect(nav.snapshot.url).toBe('https://example.com/login');

    const s2 = await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'sess' });
    expect(s2).toBe(s1); // re-attach, not a new context
    expect(contexts).toHaveLength(1);
    expect(mgr.size).toBe(1);
  });

  it('isolates sessions by owner and workspace (mismatch ⇒ RESOURCE_NOT_FOUND)', async () => {
    const { pool } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'sess' });

    expect(() => mgr.getSession('ws', agent('a1'), 'sess')).toThrow(AgentisError);
    expect(() => mgr.getSession('other-ws', run('r1'), 'sess')).toThrow(/not found/i);
    // the real owner still resolves
    expect(mgr.getSession('ws', run('r1'), 'sess')).toBeDefined();
  });

  it('enforces the per-owner cap', async () => {
    const { pool } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger }, { perOwner: 2, global: 100, ttlMs: 60_000 });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'a' });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'b' });
    await expect(mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'c' })).rejects.toThrow(/limit reached/i);
  });

  it('evicts the global LRU session when the global cap is hit', async () => {
    const { pool } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger }, { perOwner: 100, global: 2, ttlMs: 60_000 });
    const first = await mgr.openSession({ workspaceId: 'ws', owner: run('o1'), sessionId: 's' });
    await new Promise((r) => setTimeout(r, 2)); // make o1 strictly older
    await mgr.openSession({ workspaceId: 'ws', owner: run('o2'), sessionId: 's' });
    await mgr.openSession({ workspaceId: 'ws', owner: run('o3'), sessionId: 's' }); // evicts o1 (LRU)

    expect(mgr.size).toBe(2);
    expect(first.isClosing).toBe(true);
    expect(() => mgr.getSession('ws', run('o1'), 's')).toThrow();
    expect(mgr.getSession('ws', run('o3'), 's')).toBeDefined();
  });

  it('closeOwner closes every session for that owner and frees the slots', async () => {
    const { pool, contexts } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'a' });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'b' });
    expect(mgr.size).toBe(2);

    await mgr.closeOwner(run('r1'));
    expect(mgr.size).toBe(0);
    expect(contexts.every((c) => c.closed)).toBe(true);
  });

  it('closes the session immediately when the abort signal fires', async () => {
    const { pool } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    const ac = new AbortController();
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', signal: ac.signal });
    expect(mgr.size).toBe(1);
    ac.abort();
    await Promise.resolve();
    expect(mgr.size).toBe(0);
  });

  it('saves auth state via the injected store using the live storageState', async () => {
    const { pool } = fakePool();
    const save = vi.fn(async () => {});
    const authStore: BrowserAuthStore = { load: async () => null, save };
    const mgr = new BrowserSessionManager(pool, { logger, authStore });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's' });

    await mgr.saveAuthState('ws', 'u-1', run('r1'), 's', 'olx');
    expect(save).toHaveBeenCalledWith('ws', 'u-1', 'olx', { cookies: [{ name: 's', value: 'v' }], origins: [] });
  });

  it('restores a saved profile into a new session', async () => {
    const { pool } = fakePool();
    const state: PWStorageState = { cookies: [{ name: 'restored', value: '1' }], origins: [] };
    const authStore: BrowserAuthStore = { load: async () => state, save: async () => {} };
    const mgr = new BrowserSessionManager(pool, { logger, authStore });

    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', restoreAuthName: 'olx' });
    expect(pool.openSessionSurface).toHaveBeenCalledWith(expect.objectContaining({ storageState: state }));
  });

  it('forwards visibility mode + profileName to the pool surface', async () => {
    const { pool, opens } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', mode: 'visible', profileName: 'olx' });
    expect(opens[0]).toMatchObject({ mode: 'visible', profileName: 'olx' });
  });

  it('defaults to headless mode when none is given', async () => {
    const { pool, opens } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's' });
    expect(opens[0]).toMatchObject({ mode: 'headless' });
  });

  it('delegates teardown to the surface close (mode-correct cleanup)', async () => {
    const { pool, contexts } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', mode: 'attach' });
    await mgr.closeSession('ws', run('r1'), 's');
    // The manager never reaches past the surface — it only calls the injected close.
    expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('throws when restoring a non-existent profile', async () => {
    const { pool } = fakePool();
    const authStore: BrowserAuthStore = { load: async () => null, save: async () => {} };
    const mgr = new BrowserSessionManager(pool, { logger, authStore });
    await expect(
      mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', restoreAuthName: 'missing' }),
    ).rejects.toThrow(/not found/i);
  });

  it('shutdown closes all sessions and clears the registry', async () => {
    const { pool, contexts } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'a' });
    await mgr.openSession({ workspaceId: 'ws', owner: agent('a1'), sessionId: 'b' });
    await mgr.shutdown();
    expect(mgr.size).toBe(0);
    expect(contexts.every((c) => c.closed)).toBe(true);
  });

  // ── Per-turn awareness (the "stops restarting" fix) ──
  it('listForOwner returns the owner\'s open sessions with their current url', async () => {
    const { pool } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger });
    const s = await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 'sess' });
    await s.navigate('https://youtube.com/results?q=bts');

    const listed = mgr.listForOwner('ws', run('r1'));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sessionId: 'sess', url: 'https://youtube.com/results?q=bts' });
    // Not visible to a different owner or workspace.
    expect(mgr.listForOwner('ws', agent('a1'))).toHaveLength(0);
    expect(mgr.listForOwner('other', run('r1'))).toHaveLength(0);
  });

  it('the OPEN owner and the AWARENESS owner agree (a session opened for a conversation is listed for it)', () => {
    // This is the invariant that makes the fix work: same derivation on both sides.
    const owner = resolveSessionOwner({ conversationId: 'conv-9', agentId: 'agent-x' });
    expect(owner).toEqual({ kind: 'agent', id: 'conv-9' }); // conversation wins for chat continuity
    expect(resolveSessionOwner({ runId: 'r', conversationId: 'conv-9' })).toEqual({ kind: 'run', id: 'r' });
    expect(resolveSessionOwner({ agentId: 'agent-x' })).toEqual({ kind: 'agent', id: 'agent-x' });
    expect(resolveSessionOwner({})).toBeNull();
  });

  it('forwards the resolved real-Chrome allow decision to the pool on attach', async () => {
    const { pool, opens } = fakePool();
    const mgr = new BrowserSessionManager(pool, { logger, resolveRealChromeAllowed: () => true });
    await mgr.openSession({ workspaceId: 'ws', owner: run('r1'), sessionId: 's', mode: 'attach' });
    expect(opens[0]).toMatchObject({ mode: 'attach', allowCdp: true });

    const denied = fakePool();
    const mgr2 = new BrowserSessionManager(denied.pool, { logger, resolveRealChromeAllowed: () => false });
    await mgr2.openSession({ workspaceId: 'ws', owner: run('r2'), sessionId: 's2', mode: 'attach' });
    expect(denied.opens[0]).toMatchObject({ mode: 'attach', allowCdp: false });
  });

  it('renderOpenSessionsBlock tells the agent to continue + read, and is empty when nothing is open', () => {
    expect(renderOpenSessionsBlock([])).toBe('');
    const block = renderOpenSessionsBlock([{ sessionId: 'sess', url: 'https://youtube.com/results?q=bts' }]);
    expect(block).toMatch(/Open browser sessions/);
    expect(block).toMatch(/sess/);
    expect(block).toMatch(/youtube\.com\/results/);
    expect(block).toMatch(/CONTINUE|read|Never re-run/i);
  });
});
