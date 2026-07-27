/**
 * Generic OAuth2 authorization-code flow mechanics (INTEGRATION-CEILING-10X §2).
 *
 * Extracted from OAuthService so the SAME authorize-URL construction, PKCE
 * challenge, and code→token exchange logic serves both the built-in provider
 * list (google/slack/github/…) and a user-configured custom provider — "bring
 * your own OAuth app" for any service, not a fixed enum. Neither caller
 * duplicates this; both call these pure functions with their own provider def.
 */

import { createHash } from 'node:crypto';

export interface GenericOAuthProviderDef {
  authUrl: string;
  tokenUrl: string;
  scopeSeparator: ' ' | ',';
  authParams?: Record<string, string>;
  tokenAuth?: 'body' | 'basic';
  tokenBodyFormat?: 'form' | 'json';
  pkce?: boolean;
}

export interface OAuthClientCreds {
  clientId: string;
  clientSecret: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Build the provider authorize URL for one authorization attempt. */
export function buildAuthorizeUrl(args: {
  def: GenericOAuthProviderDef;
  client: OAuthClientCreds;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeVerifier?: string;
}): string {
  const { def, client, redirectUri, state, scopes, codeVerifier } = args;
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
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

export interface GenericTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  /** Best-effort account label (email / workspace name / user id), when the provider's response includes one. */
  account?: string;
}

/** Exchange an authorization code for tokens against ANY OAuth2 token endpoint. */
export async function exchangeCodeGeneric(args: {
  def: GenericOAuthProviderDef;
  client: OAuthClientCreds;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchImpl?: typeof fetch;
}): Promise<GenericTokenBundle> {
  const { def, client, code, redirectUri, codeVerifier } = args;
  const doFetch = args.fetchImpl ?? fetch;
  const bodyValues: Record<string, string> = {
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };
  if (codeVerifier) bodyValues.code_verifier = codeVerifier;
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
  const body = def.tokenBodyFormat === 'json' ? JSON.stringify(bodyValues) : new URLSearchParams(bodyValues);
  const res = await doFetch(def.tokenUrl, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok === false) throw new Error(`oauth error: ${String(json.error)}`);
  const accessToken = String(json.access_token ?? (json.authed_user as { access_token?: string } | undefined)?.access_token ?? '');
  if (!accessToken) throw new Error('token exchange returned no access_token');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined;
  return {
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
