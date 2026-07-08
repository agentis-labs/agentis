/**
 * McpOAuthService — spec-compliant OAuth 2.1 for external MCP servers
 * (MCP Authorization, revision 2025-06-18).
 *
 * Unlike `oauthService.ts` (fixed provider registry with pre-registered client
 * credentials), MCP auth is DISCOVERED and the client registers itself:
 *
 *   1. Probe the server → 401 + `WWW-Authenticate` → Protected Resource
 *      Metadata (PRM, RFC9728), or the `/.well-known/oauth-protected-resource`
 *      fallback → the authorization server(s).
 *   2. Authorization Server Metadata (RFC8414,
 *      `/.well-known/oauth-authorization-server`) → authorize / token /
 *      registration endpoints.
 *   3. Dynamic Client Registration (RFC7591) → a `client_id`, no pre-made app.
 *   4. Authorization Code + PKCE (RFC7636) + Resource Indicator (RFC8707 = the
 *      server URL) → redirect → callback → token exchange.
 *
 * The operator types NOTHING for an OAuth mount — this is the "Connect with X"
 * flow. Every outbound URL passes the SSRF guard. State is single-use + TTL'd.
 */

import { randomBytes, createHash } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import { assertSafeUrl } from '../safeUrl.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const CLIENT_NAME = 'Agentis';

export interface McpAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** The resource identifier to bind the token to (RFC8707) — the server URL. */
  resource: string;
  scopesSupported?: string[];
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
}

interface StateEntry {
  serverId: string;
  workspaceId: string;
  userId: string;
  origin: string;
  codeVerifier: string;
  clientId: string;
  /**
   * Present when DCR minted a CONFIDENTIAL client (returned a secret). Supabase
   * (and others) do this while omitting `token_endpoint_auth_method`; the token
   * exchange MUST then send the secret or the server 422s. See the Supabase MCP
   * "Required parameter: client_secret" issue.
   */
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
  allowPrivateNetwork: boolean;
  createdAt: number;
}

export interface McpOAuthServiceOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class McpOAuthService {
  readonly #states = new Map<string, StateEntry>();
  readonly #fetch: typeof fetch;

  constructor(opts: McpOAuthServiceOptions = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /**
   * Discover a server's OAuth endpoints. Returns null when the server does not
   * advertise OAuth (no 401/PRM/well-known) — the caller then falls back to a
   * token or Custom mount instead of guessing.
   */
  async discover(serverUrl: string, allowPrivateNetwork = false): Promise<McpAuthEndpoints | null> {
    const url = new URL((await assertSafeUrl(serverUrl, { allowPrivate: allowPrivateNetwork })).toString());
    // 1. Probe → the PRM location (WWW-Authenticate `resource_metadata`), else
    //    the well-known fallback at the server origin.
    let prmUrl: string | null = null;
    try {
      const probe = await this.#fetchWithTimeout(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentis', version: '1.0.0' } } }),
      }, allowPrivateNetwork);
      if (probe.status === 401) {
        prmUrl = parseResourceMetadataUrl(probe.headers.get('www-authenticate')) ?? defaultPrmUrl(url);
      }
    } catch { /* fall through to well-known */ }
    if (!prmUrl) prmUrl = defaultPrmUrl(url);

    // 2. PRM (RFC9728) → authorization_servers[].
    const prm = await this.#fetchJson(prmUrl, allowPrivateNetwork).catch(() => null);
    const authServers = Array.isArray(prm?.authorization_servers) ? prm!.authorization_servers as string[] : [];
    const resource = typeof prm?.resource === 'string' ? prm.resource : url.toString();
    const scopesSupported = Array.isArray(prm?.scopes_supported) ? prm!.scopes_supported as string[] : undefined;

    // The authorization server: the PRM's, else the server origin itself (many
    // servers co-locate AS metadata at their own well-known).
    const asBase = authServers[0] ?? url.origin;

    // 3. AS metadata (RFC8414). Try OAuth then OIDC well-knowns.
    const asMeta = await this.#fetchFirstJson([
      wellKnown(asBase, 'oauth-authorization-server'),
      wellKnown(asBase, 'openid-configuration'),
    ], allowPrivateNetwork);
    if (!asMeta) return null;
    const authorizationEndpoint = str(asMeta.authorization_endpoint);
    const tokenEndpoint = str(asMeta.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) return null;

    return {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: str(asMeta.registration_endpoint) ?? undefined,
      resource,
      ...(scopesSupported ? { scopesSupported } : {}),
    };
  }

  /**
   * Begin an OAuth mount: discover, register a client (DCR), mint PKCE + state,
   * and return the authorize URL for the operator's popup. Throws a clear,
   * actionable error when the server doesn't advertise OAuth.
   */
  async beginAuthorization(args: {
    serverId: string;
    serverUrl: string;
    workspaceId: string;
    userId: string;
    origin: string;
    redirectUri: string;
    allowPrivateNetwork?: boolean;
  }): Promise<string> {
    const allowPrivate = args.allowPrivateNetwork ?? false;
    const endpoints = await this.discover(args.serverUrl, allowPrivate);
    if (!endpoints) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED',
        'This server does not advertise OAuth (no protected-resource metadata). Use a token or a Custom mount instead.');
    }
    // Dynamic Client Registration (RFC7591). We request a public client, but
    // honor a confidential registration if the server returns a secret.
    const client = await this.#registerClient(endpoints.registrationEndpoint, args.redirectUri, allowPrivate);

    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    this.#gc();
    this.#states.set(state, {
      serverId: args.serverId,
      workspaceId: args.workspaceId,
      userId: args.userId,
      origin: args.origin,
      codeVerifier,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      tokenEndpoint: endpoints.tokenEndpoint,
      resource: endpoints.resource,
      redirectUri: args.redirectUri,
      allowPrivateNetwork: allowPrivate,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: args.redirectUri,
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
      resource: endpoints.resource, // RFC8707
    });
    if (endpoints.scopesSupported?.length) params.set('scope', endpoints.scopesSupported.join(' '));
    const authorizeUrl = new URL(endpoints.authorizationEndpoint);
    for (const [k, v] of params) authorizeUrl.searchParams.set(k, v);
    return authorizeUrl.toString();
  }

  /** Validate + consume a state (single-use). */
  consumeState(state: string): StateEntry | null {
    const entry = this.#states.get(state);
    if (!entry) return null;
    this.#states.delete(state);
    if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
    return entry;
  }

  /** Exchange the authorization code for tokens at the discovered token endpoint. */
  async exchangeCode(entry: StateEntry, code: string): Promise<McpOAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: entry.redirectUri,
      client_id: entry.clientId,
      code_verifier: entry.codeVerifier,
      resource: entry.resource, // RFC8707 — same resource as the authorize step
    });
    // Confidential client (DCR returned a secret): authenticate via
    // `client_secret_post` — the shape Supabase et al. expect.
    if (entry.clientSecret) body.set('client_secret', entry.clientSecret);
    const res = await this.#fetchWithTimeout(entry.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    }, entry.allowPrivateNetwork);
    const raw = await res.text();
    const json = safeJson(raw);
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP OAuth token exchange failed — ${tokenErrorMessage(json, raw, res.status)}`);
    }
    return {
      accessToken: json.access_token,
      ...(typeof json.refresh_token === 'string' ? { refreshToken: json.refresh_token } : {}),
      ...(typeof json.expires_in === 'number' ? { expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString() } : {}),
      ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
      ...(typeof json.token_type === 'string' ? { tokenType: json.token_type } : {}),
    };
  }


  /** DCR (RFC7591): register a client for our callback. We ask for a public
   *  client, but some servers (Supabase) mint a CONFIDENTIAL one and return a
   *  `client_secret` — we honor whatever they return. Throws if the server
   *  offers no registration endpoint (spec-compliant servers do). */
  async #registerClient(registrationEndpoint: string | undefined, redirectUri: string, allowPrivate: boolean): Promise<{ clientId: string; clientSecret?: string }> {
    if (!registrationEndpoint) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED',
        'This server does not support Dynamic Client Registration — a manual OAuth client is required (not yet supported); use a token mount.');
    }
    const res = await this.#fetchWithTimeout(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // request a public client (PKCE)
      }),
    }, allowPrivate);
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || typeof json.client_id !== 'string') {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP client registration failed (${res.status})`);
    }
    return {
      clientId: json.client_id,
      ...(typeof json.client_secret === 'string' && json.client_secret.length > 0 ? { clientSecret: json.client_secret } : {}),
    };
  }

  async #fetchJson(target: string, allowPrivate: boolean): Promise<Record<string, unknown> | null> {
    const res = await this.#fetchWithTimeout(target, { headers: { accept: 'application/json' } }, allowPrivate);
    if (!res.ok) return null;
    return await res.json().catch(() => null) as Record<string, unknown> | null;
  }

  async #fetchFirstJson(targets: string[], allowPrivate: boolean): Promise<Record<string, unknown> | null> {
    for (const t of targets) {
      const json = await this.#fetchJson(t, allowPrivate).catch(() => null);
      if (json) return json;
    }
    return null;
  }

  async #fetchWithTimeout(target: string, init: RequestInit, allowPrivate: boolean): Promise<Response> {
    const safe = await assertSafeUrl(target, { allowPrivate });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await this.#fetch(safe.toString(), { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  #gc(): void {
    const now = Date.now();
    for (const [state, entry] of this.#states) {
      if (now - entry.createdAt > STATE_TTL_MS) this.#states.delete(state);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Parse the `resource_metadata="…"` param from a WWW-Authenticate header. */
function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const m = /resource_metadata="?([^",\s]+)"?/i.exec(header);
  return m ? m[1]! : null;
}

/** The well-known PRM location for a server URL (RFC9728 §3.1). */
function defaultPrmUrl(url: URL): string {
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

function wellKnown(base: string, name: string): string {
  const b = base.replace(/\/$/, '');
  return `${b}/.well-known/${name}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function safeJson(text: string): Record<string, unknown> {
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { return {}; }
}

/**
 * The real, human-readable reason a token exchange failed. Handles the standard
 * OAuth shape (`error` / `error_description`) AND non-standard bodies like
 * Supabase/GoTrue's (`msg` / `error_code` / `message`) so we never surface a
 * bare "returned 422".
 */
function tokenErrorMessage(json: Record<string, unknown>, raw: string, status: number): string {
  const parts: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()); };
  push(json.error_description);
  push(json.error);
  push(json.error_code);
  push(json.msg);
  push(json.message);
  if (parts.length === 0 && raw && !raw.trim().startsWith('{')) push(raw.slice(0, 200));
  return parts.length > 0 ? `${parts.join(' — ')} (HTTP ${status})` : `token endpoint returned ${status}`;
}
