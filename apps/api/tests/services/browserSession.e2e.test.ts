/**
 * BrowserSession — real Chromium end-to-end (BROWSERPOOL-10X).
 *
 * Proves the whole point of persistent sessions: a cookie set on one call is
 * still present on a SEPARATE later call, and a saved auth profile re-hydrates a
 * brand-new session ("log in once, reuse"). Uses a tiny loopback server, so the
 * SSRF private-network guard is opened for this test only.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { BrowserPool, type PWStorageState } from '../../src/services/browserPool.js';
import { BrowserSessionManager, type BrowserAuthStore } from '../../src/services/browser/browserSessionManager.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'error' });
let server: Server;
let base: string;
let pool: BrowserPool;
const prevAllowPrivate = process.env.AGENTIS_BROWSER_ALLOW_PRIVATE;

beforeAll(async () => {
  process.env.AGENTIS_BROWSER_ALLOW_PRIVATE = 'true';
  server = createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', 'sid=abc123; Path=/');
      res.end('<h1>home</h1>');
      return;
    }
    // /whoami reflects whether the auth cookie survived to this request.
    const authed = (req.headers.cookie ?? '').includes('sid=abc123');
    res.end(`<h1>${authed ? 'logged-in' : 'anon'}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pool = new BrowserPool(logger);
});

afterAll(async () => {
  await pool.shutdown().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevAllowPrivate === undefined) delete process.env.AGENTIS_BROWSER_ALLOW_PRIVATE;
  else process.env.AGENTIS_BROWSER_ALLOW_PRIVATE = prevAllowPrivate;
});

describe('BrowserSession — real Chromium statefulness', () => {
  it('keeps a login cookie across separate tool calls within one session', async () => {
    const mgr = new BrowserSessionManager(pool, { logger });
    const session = await mgr.openSession({ workspaceId: 'ws', owner: { kind: 'run', id: 'r1' }, sessionId: 's' });

    // Call 1: log in (server sets the cookie).
    const login = await session.navigate(`${base}/login`);
    expect(login.snapshot.text).toMatch(/home/);

    // Call 2 (separate invocation): the cookie must still be there.
    const who = await session.navigate(`${base}/whoami`);
    expect(who.snapshot.text).toMatch(/logged-in/);

    await mgr.shutdown();
  }, 180_000);

  it('re-hydrates a brand-new session from a saved auth profile, while a fresh session stays anonymous', async () => {
    let saved: PWStorageState | null = null;
    const authStore: BrowserAuthStore = {
      load: async () => saved,
      save: async (_ws, _uid, _name, state) => { saved = state; },
    };
    const mgr = new BrowserSessionManager(pool, { logger, authStore });

    // Log in on session A, then persist its auth.
    const a = await mgr.openSession({ workspaceId: 'ws', owner: { kind: 'run', id: 'rA' }, sessionId: 'a' });
    await a.navigate(`${base}/login`);
    await mgr.saveAuthState('ws', 'u1', { kind: 'run', id: 'rA' }, 'a', 'profile');
    expect(saved).not.toBeNull();

    // Session B restores the profile → already logged in without hitting /login.
    const b = await mgr.openSession({ workspaceId: 'ws', owner: { kind: 'run', id: 'rB' }, sessionId: 'b', restoreAuthName: 'profile' });
    const bWho = await b.navigate(`${base}/whoami`);
    expect(bWho.snapshot.text).toMatch(/logged-in/);

    // Session C is fresh (no restore) → anonymous, proving the cookie came from the profile.
    const c = await mgr.openSession({ workspaceId: 'ws', owner: { kind: 'run', id: 'rC' }, sessionId: 'c' });
    const cWho = await c.navigate(`${base}/whoami`);
    expect(cWho.snapshot.text).toMatch(/anon/);

    await mgr.shutdown();
  }, 180_000);

  // Opt-in: needs a real display, so it's skipped in headless CI. Run locally with
  // AGENTIS_TEST_HEADED=1 to watch a real browser window pop up and get driven.
  it.skipIf(process.env.AGENTIS_TEST_HEADED !== '1')('opens a VISIBLE window and drives it live', async () => {
    const mgr = new BrowserSessionManager(pool, { logger });
    const session = await mgr.openSession({
      workspaceId: 'ws',
      owner: { kind: 'run', id: 'rVis' },
      sessionId: 'vis',
      mode: 'visible',
      profileName: 'test-visible',
    });
    const who = await session.navigate(`${base}/whoami`);
    expect(who.snapshot.text).toMatch(/anon|logged-in/);
    await mgr.shutdown();
  }, 180_000);
});
