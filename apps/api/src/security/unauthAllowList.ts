/**
 * Single source of truth for endpoints mounted OUTSIDE `requireAuth`.
 *
 * Per V1-SPEC §10 and DECISIONS.md D32, the unauthenticated surface area
 * MUST be auditable. Adding any path here is a security review trigger.
 *
 * Tests in `tests/security/unauthAllowList.test.ts` pin the contract: every
 * path declared here must respond non-401 unauthenticated, and every other
 * `/v1/*` route the bootstrap mounts must respond 401 unauthenticated.
 */

export interface UnauthEntry {
  /** Exact pathname (or pathname prefix when `prefix:true`). */
  path: string;
  /** Allowed HTTP methods. */
  methods: ReadonlyArray<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>;
  /** Match anything starting with `path` (e.g. webhook trigger ids). */
  prefix?: boolean;
  /** One-line justification used by the audit test. */
  reason: string;
}

export const UNAUTH_ALLOW_LIST: ReadonlyArray<UnauthEntry> = [
  { path: '/healthz', methods: ['GET'], reason: 'Liveness probe (Docker/Railway).' },
  { path: '/v1/openapi.json', methods: ['GET'], reason: 'Public schema for SDK generators.' },
  { path: '/v1/docs', methods: ['GET'], prefix: true, reason: 'Scalar UI for the public schema.' },
  { path: '/.well-known/jwks.json', methods: ['GET'], reason: 'RS256 public key for JWT verifiers.' },
  { path: '/v1/auth/login', methods: ['POST'], reason: 'Bootstrap: must be reachable pre-token.' },
  { path: '/v1/auth/refresh', methods: ['POST'], reason: 'Refresh tokens are presented in the body, not as bearer.' },
  {
    path: '/v1/webhooks/trigger/',
    methods: ['POST'],
    prefix: true,
    reason: 'Third-party webhook ingress is authenticated via per-trigger HMAC, not JWT.',
  },
  {
    path: '/v1/webhooks/channel/',
    methods: ['POST'],
    prefix: true,
    reason: 'Channel-bridge ingress (Telegram/Discord) is authenticated by adapter-specific shared secret in ChannelBridge.handleInbound.',
  },
  { path: '/v1/_test/reset', methods: ['POST'], reason: 'Playwright harness — gated by AGENTIS_TEST_MODE && NODE_ENV!==production (D29/D31).' },
];
