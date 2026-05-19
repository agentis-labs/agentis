/**
 * OpenAPI surface — V1 review feedback.
 *
 * The V1 routes were authored against `Hono` directly (not OpenAPIHono),
 * so to avoid a workspace-wide rewrite we expose OpenAPI in two layers:
 *
 *   - `openApiDocument` — a hand-curated OpenAPI 3.1 doc that names every
 *     V1 route by path/method and references shared Zod schemas converted
 *     to JSON Schema via `zod-openapi-helper`. The doc is the source of
 *     truth for clients today; new routes added via `createRoute()` will
 *     be merged here when the migration completes.
 *
 *   - `mountOpenApi(app)` — registers `/v1/openapi.json` + `/v1/docs`
 *     (Scalar reference renderer) on a parent Hono app.
 *
 * This is intentionally small. The point is to give downstream SDK
 * generators and Postman a stable contract right now, not to bikeshed
 * description prose.
 */

import { Hono } from 'hono';
import { apiReference } from '@scalar/hono-api-reference';

const VERSION = '0.1.0';

/**
 * Minimal hand-curated OpenAPI 3.1 document covering V1 routes. Schemas
 * live as `$ref`s into `components.schemas` so they can be reused.
 */
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Agentis API',
    version: VERSION,
    description:
      'V1 surface for the self-hosted Agentis backend. Authentication uses RS256 JWTs ' +
      'in the `Authorization: Bearer <token>` header. Workspace + ambient context is ' +
      'resolved from the `x-agentis-workspace-id` and `x-agentis-ambient-id` headers.',
  },
  servers: [{ url: 'http://127.0.0.1:3737', description: 'Local dev' }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      AgentisError: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', description: 'AgentisErrorCode (see packages/core/src/errors.ts)' },
          message: { type: 'string' },
          remediation: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string', format: 'password' },
        },
      },
      TokenPair: {
        type: 'object',
        required: ['accessToken', 'refreshToken'],
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          expiresIn: { type: 'integer' },
        },
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/healthz': {
      get: {
        tags: ['health'],
        security: [],
        summary: 'Liveness probe',
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' }, mode: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['auth'],
        security: [],
        summary: 'Exchange username + password for a JWT pair',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          '200': {
            description: 'Issued',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenPair' } } },
          },
          '401': {
            description: 'Invalid credentials',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentisError' } } },
          },
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        tags: ['auth'],
        security: [],
        summary: 'Mint a new access token from a refresh token',
        responses: {
          '200': { description: 'New token pair', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenPair' } } } },
        },
      },
    },
    '/v1/workspaces': {
      get: { tags: ['workspaces'], summary: 'List workspaces visible to the caller', responses: { '200': { description: 'OK' } } },
    },
    '/v1/workspaces/{id}/select': {
      post: {
        tags: ['workspaces'],
        summary: 'Mark a workspace as the active one for the current session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/workflows': {
      get: { tags: ['workflows'], summary: 'List workflows in the active workspace', responses: { '200': { description: 'OK' } } },
      post: { tags: ['workflows'], summary: 'Create a workflow', responses: { '201': { description: 'Created' } } },
    },
    '/v1/workflows/{id}': {
      get: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      patch: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
    },
    '/v1/workflows/{id}/run': {
      post: {
        tags: ['workflows'],
        summary: 'Start a workflow run; emits run.created on the realtime bus',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Run accepted' } },
      },
    },
    '/v1/runs/{id}': {
      get: {
        tags: ['runs'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/runs/{id}/replay': {
      post: {
        tags: ['runs'],
        summary: 'Partial replay from a node id (V1-SPEC §6.7)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Replay accepted' } },
      },
    },
    '/v1/agents': {
      get: { tags: ['agents'], summary: 'List agents', responses: { '200': { description: 'OK' } } },
      post: { tags: ['agents'], summary: 'Register an agent', responses: { '201': { description: 'Created' } } },
    },
    '/v1/gateways': {
      get: { tags: ['gateways'], summary: 'List gateways (OpenClaw + others)', responses: { '200': { description: 'OK' } } },
    },
    '/v1/conversations/{agentId}/messages': {
      get: {
        tags: ['conversations'],
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        tags: ['conversations'],
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Sent' } },
      },
    },
    '/v1/approvals': {
      get: { tags: ['approvals'], responses: { '200': { description: 'OK' } } },
    },
    '/v1/approvals/{id}/approve': {
      post: { tags: ['approvals'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/v1/approvals/{id}/reject': {
      post: { tags: ['approvals'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/v1/skills/registry/status': {
      get: { tags: ['skill-registry'], summary: 'Skill registry client configuration + breaker state', responses: { '200': { description: 'OK' } } },
    },
    '/v1/skills/registry': {
      get: { tags: ['skill-registry'], summary: 'Browse skill registry entries', responses: { '200': { description: 'OK' } } },
    },
    '/v1/skills/registry/install/{slug}': {
      post: {
        tags: ['skill-registry'],
        summary: 'Install a registry entry; verifies SHA-256 + runs the security scanner',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['permissionsAcknowledged'],
                properties: { permissionsAcknowledged: { type: 'boolean', enum: [true] } },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Installed' },
          '422': {
            description: 'Hash mismatch or scanner block',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentisError' } } },
          },
        },
      },
    },
  },
} as const;

export function mountOpenApi(app: Hono): void {
  app.get('/v1/openapi.json', (c) => c.json(openApiDocument));
  app.get(
    '/v1/docs',
    apiReference({
      spec: { url: '/v1/openapi.json' },
      pageTitle: 'Agentis API',
      theme: 'default',
    }),
  );
}
