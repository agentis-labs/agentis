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
    // Best effort; auth still works without persistence.
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
