/**
 * Tiny REST + auth client.
 *
 * Stores the access/refresh tokens in localStorage. On 401 we attempt one
 * silent refresh; if that fails we drop the tokens and the router redirects
 * to the login page.
 */

const ACCESS = 'agentis.access';
const REFRESH = 'agentis.refresh';
const WORKSPACE = 'agentis.workspace';
const AMBIENT = 'agentis.ambient';

export const tokens = {
  access: () => localStorage.getItem(ACCESS),
  refresh: () => localStorage.getItem(REFRESH),
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS, access);
    localStorage.setItem(REFRESH, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

export const workspace = {
  get: () => localStorage.getItem(WORKSPACE),
  set: (id: string) => localStorage.setItem(WORKSPACE, id),
  clear: () => localStorage.removeItem(WORKSPACE),
};

export const ambient = {
  get: () => localStorage.getItem(AMBIENT),
  set: (id: string) => localStorage.setItem(AMBIENT, id),
  clear: () => localStorage.removeItem(AMBIENT),
};

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

async function rawFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const access = tokens.access();
  if (access) headers.set('authorization', `Bearer ${access}`);
  const ws = workspace.get();
  if (ws) headers.set('x-agentis-workspace', ws);
  const amb = ambient.get();
  if (amb) headers.set('x-agentis-ambient', amb);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return rawFetch(path, init, false);
  }
  return res;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = tokens.refresh();
  if (!refreshToken) return false;
  const res = await fetch('/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    tokens.clear();
    return false;
  }
  const json = (await res.json()) as { accessToken: string; refreshToken: string };
  tokens.set(json.accessToken, json.refreshToken);
  return true;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'INTERNAL_ERROR', message: res.statusText } }));
    throw body.error as ApiError;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function login(username: string, password: string) {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'AUTH', message: 'Login failed' } }));
    throw body.error;
  }
  const json = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; username: string; displayName: string };
  };
  tokens.set(json.accessToken, json.refreshToken);
  return json;
}

export function logout() {
  tokens.clear();
  workspace.clear();
  ambient.clear();
}
