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

import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '../logger.js';

export const OAUTH_PROVIDER_IDS = ['google', 'slack', 'github', 'notion', 'linkedin', 'twitter_x'] as const;
export type OAuthProviderId = typeof OAUTH_PROVIDER_IDS[number];

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
  tokenAuth?: 'body' | 'basic';
  tokenBodyFormat?: 'form' | 'json';
  pkce?: boolean;
}

const PROVIDER_DEFS: Record<OAuthProviderId, ProviderDef> = {
  google: {
    id: 'google', label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // `brain_google_drive` is the Workspace Brain read-sync slug (RFC §7.6) —
    // distinct from the workflow `google_drive` connector so it can request
    // read-only access to existing files instead of drive.file.
    slugs: [
      'gmail', 'google_sheets', 'google_calendar', 'google_drive', 'sheets', 'calendar', 'gdrive', 'google', 'brain_google_drive',
      // Rest of the Google product family — same registered OAuth app, just more scopes.
      'google_docs', 'google_forms', 'google_analytics', 'bigquery', 'pubsub', 'youtube', 'google_meet',
    ],
    scopeSeparator: ' ',
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    scopesForSlug: (slug) => {
      const base = ['openid', 'email'];
      if (slug === 'gmail') return [...base, 'https://www.googleapis.com/auth/gmail.send'];
      if (slug === 'google_sheets' || slug === 'sheets') return [...base, 'https://www.googleapis.com/auth/spreadsheets'];
      // Meet links are created through Calendar conference data — no separate Meet scope.
      if (slug === 'google_calendar' || slug === 'calendar' || slug === 'google_meet') return [...base, 'https://www.googleapis.com/auth/calendar.events'];
      if (slug === 'brain_google_drive') return [...base, 'https://www.googleapis.com/auth/drive.readonly'];
      if (slug === 'google_drive' || slug === 'gdrive') return [...base, 'https://www.googleapis.com/auth/drive.file'];
      if (slug === 'google_docs') return [...base, 'https://www.googleapis.com/auth/documents'];
      if (slug === 'google_forms') return [...base, 'https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'];
      if (slug === 'google_analytics') return [...base, 'https://www.googleapis.com/auth/analytics.readonly'];
      if (slug === 'bigquery') return [...base, 'https://www.googleapis.com/auth/bigquery'];
      if (slug === 'pubsub') return [...base, 'https://www.googleapis.com/auth/pubsub'];
      if (slug === 'youtube') return [...base, 'https://www.googleapis.com/auth/youtube'];
      return [...base, 'https://www.googleapis.com/auth/userinfo.profile'];
    },
  },
  slack: {
    id: 'slack', label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    slugs: ['slack', 'brain_slack'],
    scopeSeparator: ',',
    // Brain read-sync needs history + directory; the workflow connector needs write.
    scopesForSlug: (slug) => slug === 'brain_slack'
      ? ['channels:history', 'channels:read', 'users:read']
      : ['chat:write', 'channels:read'],
  },
  github: {
    id: 'github', label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    slugs: ['github', 'brain_github'],
    scopeSeparator: ' ',
    acceptJson: true,
    // `repo` covers reading private repos + issues/PRs (no classic read-only repo scope exists).
    scopesForSlug: () => ['repo', 'read:user'],
  },
  notion: {
    id: 'notion', label: 'Notion',
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    slugs: ['notion'],
    scopeSeparator: ' ',
    authParams: { owner: 'user' },
    tokenAuth: 'basic',
    tokenBodyFormat: 'json',
    scopesForSlug: () => [],
  },
  linkedin: {
    id: 'linkedin', label: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    slugs: ['linkedin'],
    scopeSeparator: ' ',
    scopesForSlug: () => ['openid', 'profile', 'email', 'w_member_social'],
  },
  twitter_x: {
    id: 'twitter_x', label: 'X / Twitter',
    authUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    slugs: ['twitter_x', 'twitter'],
    scopeSeparator: ' ',
    tokenAuth: 'basic',
    pkce: true,
    scopesForSlug: () => ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
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
  codeVerifier?: string;
}

const STATE_TTL_MS = 10 * 60_000;

export interface OAuthServiceOptions {
  baseUrl: string;
  clients: Partial<Record<OAuthProviderId, { clientId: string; clientSecret: string }>>;
  oauthProxyUrl?: string | null;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class OAuthService {
  readonly #fetch: typeof fetch;
  readonly #states = new Map<string, StateEntry>();
  /**
   * BYOC credentials pasted into Settings → Integrations (see
   * OAuthAppCredentialStore) instead of env vars. Hydrated at boot and kept
   * live by the app-credentials routes — no restart needed to pick up a
   * change. `opts.clients` (env vars) still wins when both are set, so an
   * operator's deployment-level config can't be silently overridden by a
   * value pasted into the UI.
   */
  readonly #dbClients = new Map<OAuthProviderId, { clientId: string; clientSecret: string }>();

  constructor(private readonly opts: OAuthServiceOptions) {
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  setDbClient(provider: OAuthProviderId, credential: { clientId: string; clientSecret: string }): void {
    this.#dbClients.set(provider, credential);
  }

  clearDbClient(provider: OAuthProviderId): void {
    this.#dbClients.delete(provider);
  }

  /** Whether an env var (not a DB-pasted credential) configures this provider — env always wins. */
  hasEnvClient(provider: OAuthProviderId): boolean {
    const c = this.opts.clients[provider];
    return !!(c && c.clientId && c.clientSecret);
  }

  /** Providers that are actually configured (client id + secret present). */
  configuredProviders(): Array<{ id: OAuthProviderId; label: string; slugs: string[] }> {
    return OAUTH_PROVIDER_IDS
      .filter((id) => this.#client(id) != null)
      .map((id) => ({ id, label: PROVIDER_DEFS[id].label, slugs: PROVIDER_DEFS[id].slugs }));
  }

  /**
   * Every known provider with a `configured` flag. The canvas needs this so it
   * can render the correct "Sign in with X" affordance for an OAuth-only service
   * (e.g. Gmail) even on an instance where the operator hasn't set the client
   * credentials yet — instead of falling back to a meaningless API-key field.
   */
  allProviders(): Array<{ id: OAuthProviderId; label: string; slugs: string[]; configured: boolean; mode: 'self' | 'proxy' | 'disabled' }> {
    return OAUTH_PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_DEFS[id].label,
      slugs: PROVIDER_DEFS[id].slugs,
      configured: this.isConfigured(id),
      mode: this.#client(id) ? 'self' : this.#proxyUrl() ? 'proxy' : 'disabled',
    }));
  }

  isConfigured(provider: OAuthProviderId): boolean {
    return this.#client(provider) != null || this.#proxyUrl() != null;
  }

  /** Create a single-use CSRF state and return the provider authorize URL. */
  startAuthorization(args: { provider: OAuthProviderId; workspaceId: string; userId: string; integrationSlug: string; origin: string }): string {
    const client = this.#client(args.provider);
    if (!client) return this.#startProxyAuthorization(args);
    const def = PROVIDER_DEFS[args.provider];
    const codeVerifier = def.pkce ? randomBytes(32).toString('base64url') : undefined;
    const state = this.#createState(args, codeVerifier);

    const scopes = def.scopesForSlug(args.integrationSlug.toLowerCase());
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.#redirectUri(args.provider),
      response_type: 'code',
      state,
      ...(def.authParams ?? {}),
    });
    if (scopes.length > 0) params.set('scope', scopes.join(def.scopeSeparator));
    if (codeVerifier) {
      params.set('code_challenge', pkceChallenge(codeVerifier));
      params.set('code_challenge_method', 'S256');
    }
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
  async exchangeCode(provider: OAuthProviderId, code: string, opts: { codeVerifier?: string } = {}): Promise<OAuthTokenBundle> {
    const client = this.#client(provider);
    if (!client) throw new Error(`OAuth provider '${provider}' is not configured`);
    const def = PROVIDER_DEFS[provider];
    const bodyValues: Record<string, string> = {
      code,
      redirect_uri: this.#redirectUri(provider),
      grant_type: 'authorization_code',
    };
    if (opts.codeVerifier) bodyValues.code_verifier = opts.codeVerifier;
    if (def.tokenAuth !== 'basic') {
      bodyValues.client_id = client.clientId;
      bodyValues.client_secret = client.clientSecret;
    }
    const headers: Record<string, string> = {
      'content-type': def.tokenBodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (def.tokenAuth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
    }
    const body = def.tokenBodyFormat === 'json'
      ? JSON.stringify(bodyValues)
      : new URLSearchParams(bodyValues);
    const res = await this.#fetch(def.tokenUrl, {
      method: 'POST',
      headers,
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
      account: typeof json.email === 'string'
        ? json.email
        : typeof json.workspace_name === 'string'
          ? json.workspace_name
          : (json.authed_user as { id?: string } | undefined)?.id,
    };
  }

  #redirectUri(provider: OAuthProviderId): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/oauth/${provider}/callback`;
  }

  #proxyCallbackUri(): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/oauth/proxy/callback`;
  }

  #client(provider: OAuthProviderId): { clientId: string; clientSecret: string } | null {
    const c = this.opts.clients[provider];
    if (c && c.clientId && c.clientSecret) return c;
    return this.#dbClients.get(provider) ?? null;
  }

  #proxyUrl(): string | null {
    const raw = this.opts.oauthProxyUrl?.trim();
    if (!raw) return null;
    return raw.replace(/\/+$/u, '');
  }

  #createState(args: { provider: OAuthProviderId; workspaceId: string; userId: string; integrationSlug: string; origin: string }, codeVerifier?: string): string {
    const state = randomBytes(24).toString('base64url');
    this.#gc();
    this.#states.set(state, { ...args, codeVerifier, createdAt: Date.now() });
    return state;
  }

  #startProxyAuthorization(args: { provider: OAuthProviderId; workspaceId: string; userId: string; integrationSlug: string; origin: string }): string {
    const proxyUrl = this.#proxyUrl();
    if (!proxyUrl) throw new Error(`OAuth provider '${args.provider}' is not configured`);
    const def = PROVIDER_DEFS[args.provider];
    const state = this.#createState(args);
    const url = new URL(`${proxyUrl}/v1/oauth/${args.provider}/authorize`);
    const scopes = def.scopesForSlug(args.integrationSlug.toLowerCase());
    url.searchParams.set('state', state);
    url.searchParams.set('provider', args.provider);
    url.searchParams.set('integration_slug', args.integrationSlug);
    url.searchParams.set('callback_url', this.#proxyCallbackUri());
    url.searchParams.set('instance_url', this.opts.baseUrl.replace(/\/+$/, ''));
    url.searchParams.set('origin', args.origin);
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(def.scopeSeparator));
    return url.toString();
  }

  #gc(): void {
    const now = Date.now();
    for (const [k, v] of this.#states) if (now - v.createdAt > STATE_TTL_MS) this.#states.delete(k);
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
