/**
 * API-driven Playwright helpers.
 *
 * These specs treat the running API as a black box reachable through the
 * Vite dev proxy (`/v1/*` → `127.0.0.1:3737`). `apiAuth()` is the workhorse:
 * it resets state, signs the operator in, and returns ready-to-use headers
 * plus the seeded workspace + ambient ids.
 *
 * Why a helper instead of fixtures: each file calls `apiAuth()` in a
 * `beforeAll` so the 9 → 200+ test matrix shares one reset cost per file
 * (Playwright runs files sequentially with `workers:1`).
 */
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

export const TEST_USERNAME = 'operator';
export const TEST_PASSWORD = 'test-password-1234';

export interface ApiAuthCtx {
  /** Bearer access token. */
  token: string;
  /** Refresh token (rotates on `/v1/auth/refresh`). */
  refreshToken: string;
  /** Seeded `personal` workspace. */
  workspace: { id: string; name: string; slug: string; defaultAmbientId: string | null };
  /** Seeded `local` ambient. */
  ambient: { id: string; name: string; kind: string };
  /** Operator user. */
  user: { id: string; username: string };
  /** Headers for the seeded workspace + bearer auth. */
  headers: Record<string, string>;
  /** Build headers with extras (e.g. ambient overrides, content-type). */
  h(extra?: Record<string, string>): Record<string, string>;
}

export async function reset(request: APIRequestContext): Promise<{
  user: { id: string; username: string };
  workspace: { id: string; name: string; slug: string; defaultAmbientId: string | null };
  ambient: { id: string; name: string; kind: string };
}> {
  const res = await request.post('/v1/_test/reset');
  expect(res.ok(), `reset endpoint should return 2xx, got ${res.status()}`).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  return { user: body.user, workspace: body.workspace, ambient: body.ambient };
}

export async function login(
  request: APIRequestContext,
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
): Promise<{ accessToken: string; refreshToken: string; user: { id: string; username: string } }> {
  const res = await request.post('/v1/auth/login', { data: { username, password } });
  expect(res.ok(), `login should succeed, got ${res.status()}`).toBeTruthy();
  return await res.json();
}

export async function apiAuth(request: APIRequestContext): Promise<ApiAuthCtx> {
  const seed = await reset(request);
  const session = await login(request);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'x-agentis-workspace': seed.workspace.id,
  };
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user,
    workspace: seed.workspace,
    ambient: seed.ambient,
    headers,
    h(extra) {
      return { ...headers, ...(extra ?? {}) };
    },
  };
}

/** Like `apiAuth` but skips the state wipe — use after a manual reset. */
export async function apiAuthNoReset(request: APIRequestContext): Promise<ApiAuthCtx> {
  // We still need to know the seeded ids; the cheapest path is to fetch them
  // from /workspaces and the workspace's ambient list.
  const session = await login(request);
  const wsRes = await request.get('/v1/workspaces', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const wsBody = await wsRes.json();
  const workspace = wsBody.workspaces[0];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'x-agentis-workspace': workspace.id,
  };
  const detailRes = await request.get(`/v1/workspaces/${workspace.id}`, { headers });
  const detail = await detailRes.json();
  const ambient = detail.ambients[0] ?? { id: workspace.defaultAmbientId, name: '', kind: 'local' };
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user,
    workspace,
    ambient,
    headers,
    h(extra) {
      return { ...headers, ...(extra ?? {}) };
    },
  };
}

/** Build a syntactically-valid 1-node workflow graph (no edges). */
export function trivialGraph(nodeId = 'start') {
  return {
    version: 1 as const,
    nodes: [
      {
        id: nodeId,
        type: 'trigger' as const,
        title: 'Manual',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger' as const, triggerType: 'manual' as const },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
