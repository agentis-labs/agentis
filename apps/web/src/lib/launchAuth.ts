import { tokens } from './api';

const LAUNCH_TOKEN_STORAGE_KEY = 'agentis.launchToken';
export const LOCAL_BYPASS_LAUNCH_TOKEN = 'local-bypass';

export interface LaunchAuthSession {
  accessToken: string;
  refreshToken: string;
}

export async function loginWithLaunchToken(token: string): Promise<LaunchAuthSession> {
  const res = await fetch('/v1/auth/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: 'AUTH', message: 'Launch login failed' } }));
    throw body.error;
  }
  const json = (await res.json()) as LaunchAuthSession;
  tokens.set(json.accessToken, json.refreshToken);
  return json;
}

/**
 * §PERF-BOOT — is the API actually up?
 *
 * Auth failures and an API that is still booting used to be indistinguishable:
 * both surfaced as a rejected fetch, and the caller's catch logged the operator
 * out — destroying VALID tokens — and dumped them on the login form whenever
 * the server was merely starting (the API binds its port late, so this window
 * is long on big workspaces). `/healthz` is unauthenticated and dependency-free,
 * and the probe behaves identically behind the dev proxy (ECONNREFUSED → 500)
 * and in production (fetch TypeError): not ok = not reachable.
 */
export async function probeServerReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch('/healthz', { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) return false;
      // A 200 alone is not proof: any SPA-fallback (dev server, reverse proxy)
      // answers unknown paths with index.html 200. Only the API's own JSON
      // body counts as "reachable" — verified live when exactly this misread
      // caused the probe to bless a downed API and destroy valid tokens.
      const body = await res.json().catch(() => null) as { ok?: boolean } | null;
      return body?.ok === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function getLaunchTokenFromUrl(): string | null {
  const token = new URLSearchParams(window.location.search).get('token');
  return token?.trim() || null;
}

export function removeLaunchTokenFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('token');
  const query = url.searchParams.toString();
  window.history.replaceState({}, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`);
}

export function getStoredLaunchToken(): string | null {
  try {
    const token = localStorage.getItem(LAUNCH_TOKEN_STORAGE_KEY);
    return token?.trim() || null;
  } catch {
    return null;
  }
}

export function setStoredLaunchToken(token: string): void {
  if (!isPersistableLaunchToken(token)) return;
  try {
    localStorage.setItem(LAUNCH_TOKEN_STORAGE_KEY, token);
  } catch {
  }
}

export function clearStoredLaunchToken(): void {
  try {
    localStorage.removeItem(LAUNCH_TOKEN_STORAGE_KEY);
  } catch {
    // noop
  }
}

export function isPersistableLaunchToken(token: string): boolean {
  return token.trim() !== '' && token !== LOCAL_BYPASS_LAUNCH_TOKEN;
}

export function isLocalLaunchOrigin(): boolean {
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}



