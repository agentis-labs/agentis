/**
 * OAuthService — inline "Sign in with X" credential minting (ORCHESTRATOR-CREATION §7).
 *
 * The operator clicks an amber integration node → "Sign in with Google", a popup
 * runs the standard authorization-code flow, and the resulting tokens are stored
 * as an encrypted credential bound to the workspace — without ever leaving the
 * canvas. This service owns the provider registry, the short-lived CSRF `state`
 * store, the authorize-URL construction, and the code→token exchange.
 *
 * Security:
 *  - `state` is random, single-use, 10-minute TTL, and carries the workspace /
 *    user / slug / opener-origin so the unauthenticated callback can be trusted.
 *  - Tokens are handed to the caller (the route) which encrypts them via the
 *    CredentialVault — this service never persists plaintext.
 *  - A provider is only exposed when its client id + secret are configured.
 */

import { randomBytes } from 'node:crypto';
import type { Logger } from '../logger.js';

export type OAuthProviderId = 'google' | 'slack' | 'github';

interface ProviderDef {
  id: OAuthProviderId;
  label: string;
  authUrl: string;
  tokenUrl: string;
  /** Integration slugs this provider can authenticate. */
  slugs: string[];
  /** Scopes per integration slug; falls back to `defaultScopes`. */
  scopesForSlug: (slug: string) => string[];
  /** Extra authorize-URL params (e.g. Google's offline access). */
  authParams?: Record<string, string>;
  /** Slack/GitHub need an Accept header or comma-joined scopes. */
  scopeSeparator: ' ' | ',';
  acceptJson?: boolean;
}

const PROVIDER_DEFS: Record<OAuthProviderId, ProviderDef> = {
  google: {
    id: 'google', label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    slugs: ['gmail', 'sheets', 'calendar', 'gdrive', 'google'],
    scopeSeparator: ' ',
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    scopesForSlug: (slug) => {
      const base = ['openid', 'email'];
      if (slug === 'gmail') return [...base, 'https://www.googleapis.com/auth/gmail.send'];
      if (slug === 'sheets') return [...base, 'https://www.googleapis.com/auth/spreadsheets'];
      if (slug === 'calendar') return [...base, 'https://www.googleapis.com/auth/calendar.events'];
      if (slug === 'gdrive') return [...base, 'https://www.googleapis.com/auth/drive.file'];
      return [...base, 'https://www.googleapis.com/auth/userinfo.profile'];
    },
  },
  slack: {
    id: 'slack', label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    slugs: ['slack'],
    scopeSeparator: ',',
    scopesForSlug: () => ['chat:write', 'channels:read'],
  },
  github: {
    id: 'github', label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    slugs: ['github'],
    scopeSeparator: ' ',
    acceptJson: true,
    scopesForSlug: () => ['repo', 'read:user'],
  },
};

/** slug → the provider that can authenticate it. */
export function providerForSlug(slug: string): OAuthProviderId | null {
  const s = slug.toLowerCase();
  for (const def of Object.values(PROVIDER_DEFS)) if (def.slugs.includes(s)) return def.id;
  return null;
}

export interface OAuthTokenBundle {
  provider: OAuthProviderId;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  account?: string;
}

interface StateEntry {
  workspaceId: string;
  userId: string;
  provider: OAuthProviderId;
  integrationSlug: string;
  origin: string;
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60_000;

export interface OAuthServiceOptions {
  baseUrl: string;
  clients: Partial<Record<OAuthProviderId, { clientId: string; clientSecret: string }>>;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class OAuthService {
  readonly #fetch: typeof fetch;
  readonly #states = new Map<string, StateEntry>();

  constructor(private readonly opts: OAuthServiceOptions) {
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** Providers that are actually configured (client id + secret present). */
  configuredProviders(): Array<{ id: OAuthProviderId; label: string; slugs: string[] }> {
    return (Object.keys(PROVIDER_DEFS) as OAuthProviderId[])
      .filter((id) => this.#client(id) != null)
      .map((id) => ({ id, label: PROVIDER_DEFS[id].label, slugs: PROVIDER_DEFS[id].slugs }));
  }

  isConfigured(provider: OAuthProviderId): boolean {
    return this.#client(provider) != null;
  }

  /** Create a single-use CSRF state and return the provider authorize URL. */
  startAuthorization(args: { provider: OAuthProviderId; workspaceId: string; userId: string; integrationSlug: string; origin: string }): string {
    const client = this.#client(args.provider);
    if (!client) throw new Error(`OAuth provider '${args.provider}' is not configured`);
    const def = PROVIDER_DEFS[args.provider];
    const state = randomBytes(24).toString('base64url');
    this.#gc();
    this.#states.set(state, { ...args, createdAt: Date.now() });

    const scopes = def.scopesForSlug(args.integrationSlug.toLowerCase());
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.#redirectUri(args.provider),
      response_type: 'code',
      scope: scopes.join(def.scopeSeparator),
      state,
      ...(def.authParams ?? {}),
    });
    return `${def.authUrl}?${params.toString()}`;
  }

  /** Validate + consume a state (single-use). */
  consumeState(state: string): StateEntry | null {
    this.#gc();
    const entry = this.#states.get(state);
    if (!entry) return null;
    this.#states.delete(state);
    if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
    return entry;
  }

  /** Exchange an authorization code for tokens (provider-normalized). */
  async exchangeCode(provider: OAuthProviderId, code: string): Promise<OAuthTokenBundle> {
    const client = this.#client(provider);
    if (!client) throw new Error(`OAuth provider '${provider}' is not configured`);
    const def = PROVIDER_DEFS[provider];
    const body = new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: this.#redirectUri(provider),
      grant_type: 'authorization_code',
    });
    const res = await this.#fetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
    const json = (await res.json()) as Record<string, unknown>;
    // Slack wraps the result and signals failure with ok=false.
    if (provider === 'slack' && json.ok === false) throw new Error(`slack oauth error: ${String(json.error)}`);
    const accessToken = String(json.access_token ?? (json.authed_user as { access_token?: string } | undefined)?.access_token ?? '');
    if (!accessToken) throw new Error('token exchange returned no access_token');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined;
    return {
      provider,
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      scope: typeof json.scope === 'string' ? json.scope : undefined,
      tokenType: typeof json.token_type === 'string' ? json.token_type : undefined,
      account: typeof json.email === 'string' ? json.email : (json.authed_user as { id?: string } | undefined)?.id,
    };
  }

  #redirectUri(provider: OAuthProviderId): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/oauth/${provider}/callback`;
  }

  #client(provider: OAuthProviderId): { clientId: string; clientSecret: string } | null {
    const c = this.opts.clients[provider];
    return c && c.clientId && c.clientSecret ? c : null;
  }

  #gc(): void {
    const now = Date.now();
    for (const [k, v] of this.#states) if (now - v.createdAt > STATE_TTL_MS) this.#states.delete(k);
  }
}
