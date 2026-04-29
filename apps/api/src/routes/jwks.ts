/**
 * /.well-known/jwks.json — RS256 public key set (D32).
 *
 * Lets external verifiers (framework adapters, third-party agents)
 * validate Agentis-issued JWTs without round-tripping the auth service.
 * Cache-Control matches V1-SPEC §10: 1-hour shared cache.
 */

import { Hono } from 'hono';
import type { AuthService } from '../services/auth.js';

export function buildJwksRoutes(deps: { auth: AuthService }) {
  const app = new Hono();
  app.get('/jwks.json', async (c) => {
    const jwks = await deps.auth.jwks();
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(jwks);
  });
  return app;
}
