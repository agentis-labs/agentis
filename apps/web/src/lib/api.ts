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

function emitLocalEvent(name: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name));
}

export const tokens = {
  access: () => localStorage.getItem(ACCESS),
  refresh: () => localStorage.getItem(REFRESH),
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS, access);
    localStorage.setItem(REFRESH, refresh);
    emitLocalEvent('agentis:auth-changed');
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
    emitLocalEvent('agentis:auth-changed');
  },
};

export const workspace = {
  get: () => localStorage.getItem(WORKSPACE),
  set: (id: string) => {
    if (localStorage.getItem(WORKSPACE) === id) return;
    localStorage.setItem(WORKSPACE, id);
    emitLocalEvent('agentis:workspace-changed');
  },
  clear: () => {
    localStorage.removeItem(WORKSPACE);
    emitLocalEvent('agentis:workspace-changed');
  },
};

export const ambient = {
  get: () => localStorage.getItem(AMBIENT),
  set: (id: string) => {
    if (localStorage.getItem(AMBIENT) === id) return;
    localStorage.setItem(AMBIENT, id);
    emitLocalEvent('agentis:ambient-changed');
  },
  clear: () => {
    localStorage.removeItem(AMBIENT);
    emitLocalEvent('agentis:ambient-changed');
  },
};

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const shaped = error as { message?: unknown; code?: unknown };
    const message = typeof shaped.message === 'string' && shaped.message.trim()
      ? shaped.message.trim()
      : null;
    const code = typeof shaped.code === 'string' && shaped.code.trim() ? shaped.code.trim() : null;
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function rawFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const body = init.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBinary =
    (typeof Blob !== 'undefined' && body instanceof Blob)
    || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer);
  if (!headers.has('content-type') && body && !isFormData && !isBinary) headers.set('content-type', 'application/json');
  const access = tokens.access();
  if (access) headers.set('authorization', `Bearer ${access}`);
  const ws = workspace.get();
  if (ws) headers.set('x-agentis-workspace', ws);
  const amb = ambient.get();
  if (amb) headers.set('x-agentis-ambient', amb);

  // Agentis API reads are operational state, not cacheable documents. A stale
  // GET can otherwise leave listeners, runs, approvals, and monitors showing a
  // previous lifecycle state after the server has already transitioned.
  const res = await fetch(path, { cache: 'no-store', ...init, headers });
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

/**
 * Stale-while-revalidate cache for GET responses.
 *
 * Agentis GETs are still `no-store` and still revalidate on every page mount â€”
 * operational state must never be served stale. This cache only removes the
 * blank-spinner flash on *revisits*: a page seeds its initial render from the
 * last-known value (via `peekCached`) so navigation feels immediate, then the
 * background `apiCached` refetch swaps in fresh data (and realtime keeps it
 * live). The cache is keyed per workspace; a workspace switch hard-reloads the
 * app, so cross-workspace bleed is impossible.
 */
interface CacheEntry { data: unknown; ts: number }
const responseCache = new Map<string, CacheEntry>();

function cacheKey(path: string): string {
  return `${workspace.get() ?? ''}|${path}`;
}

/** Synchronous read of the last cached response for a GET path, if any. */
export function peekCached<T = unknown>(path: string): T | undefined {
  return responseCache.get(cacheKey(path))?.data as T | undefined;
}

/** How long ago (ms) the cached value for `path` was stored, or Infinity. */
export function cachedAge(path: string): number {
  const entry = responseCache.get(cacheKey(path));
  return entry ? Date.now() - entry.ts : Infinity;
}

/** Drop cached responses (all, or those whose path includes `match`). */
export function invalidateCache(match?: string): void {
  if (!match) { responseCache.clear(); return; }
  for (const key of responseCache.keys()) {
    if (key.includes(match)) responseCache.delete(key);
  }
}

/**
 * `api()` plus SWR caching: on success the response is stored so the next mount
 * can paint it instantly via `peekCached`. Use for GETs that back a page view.
 */
export async function apiCached<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const data = await api<T>(path, init);
  responseCache.set(cacheKey(path), { data, ts: Date.now() });
  return data;
}

/** Fetch a non-JSON API response while preserving the normal auth/refresh flow. */
export async function apiText(path: string, init: RequestInit = {}): Promise<string> {
  const res = await rawFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'INTERNAL_ERROR', message: res.statusText } }));
    throw body.error as ApiError;
  }
  return res.text();
}

/** Fetch a binary API response (e.g. an asset blob) with the normal auth flow. */
export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const res = await rawFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'INTERNAL_ERROR', message: res.statusText } }));
    throw body.error as ApiError;
  }
  return res.blob();
}

export async function streamSse(
  path: string,
  init: RequestInit = {},
  handlers: { onEvent?: (event: string, data: unknown) => void } = {},
): Promise<void> {
  const headers = new Headers(init.headers ?? {});
  headers.set('accept', 'text/event-stream');
  const res = await rawFetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'INTERNAL_ERROR', message: res.statusText } }));
    throw body.error as ApiError;
  }
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      emitSseEvent(rawEvent, handlers.onEvent);
      separator = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) emitSseEvent(buffer, handlers.onEvent);
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
  invalidateCache();
}

function emitSseEvent(raw: string, onEvent?: (event: string, data: unknown) => void): void {
  if (!onEvent) return;
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  const dataText = dataLines.join('\n');
  if (!dataText) {
    onEvent(event, null);
    return;
  }
  try {
    onEvent(event, JSON.parse(dataText) as unknown);
  } catch {
    onEvent(event, dataText);
  }
}



