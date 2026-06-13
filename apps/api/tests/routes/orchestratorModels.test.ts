/**
 * /v1/orchestrator/models — per-workspace model-role config routes (§4.4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { WorkspaceModelConfigService } from '../../src/services/workspaceModelConfigService.js';
import { OrchestratorModelRouter } from '../../src/services/orchestratorModelRouter.js';
import { buildOrchestratorModelRoutes } from '../../src/routes/orchestratorModels.js';

let ctx: TestContext;
let config: WorkspaceModelConfigService;
let router: OrchestratorModelRouter;

function app() {
  return ctx.buildApp([
    { path: '/v1/orchestrator/models', app: buildOrchestratorModelRoutes({ db: ctx.db, auth: ctx.auth, config, router }) },
  ]);
}

beforeEach(async () => {
  ctx = await createTestContext();
  config = new WorkspaceModelConfigService({ db: ctx.db, vault: ctx.vault, logger: ctx.logger });
  router = OrchestratorModelRouter.fromEnv({
    AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
    AGENTIS_ORCHESTRATOR_MODEL: 'env-default',
  });
  router.setConfigProvider(config.asConfigProvider());
});

afterEach(() => ctx.close());

describe('/v1/orchestrator/models', () => {
  it('GET lists every role with its env default and (no) override', async () => {
    const res = await app().request('/v1/orchestrator/models', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { roles: Array<{ role: string; envModel: string | null; effectiveModel: string | null; override: unknown }> };
    const conversation = body.roles.find((r) => r.role === 'conversation')!;
    expect(conversation.envModel).toBe('env-default');
    expect(conversation.effectiveModel).toBe('env-default');
    expect(conversation.override).toBeNull();
  });

  it('PUT sets an override that the router then resolves; key is never returned', async () => {
    const res = await app().request('/v1/orchestrator/models/conversation', {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({ model: 'claude-opus-4-8', apiKey: 'sk-secret' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { role: { model: string; hasApiKey: boolean; apiKey?: string } };
    expect(body.role.model).toBe('claude-opus-4-8');
    expect(body.role.hasApiKey).toBe(true);
    expect(body.role.apiKey).toBeUndefined();

    // The router now resolves the override for this workspace (env base inherited).
    expect(router.profile('conversation', ctx.workspace.id)).toEqual({
      baseUrl: 'https://api.example.com',
      model: 'claude-opus-4-8',
      apiKey: 'sk-secret',
    });

    // ...and GET reflects it.
    const list = await (await app().request('/v1/orchestrator/models', { headers: ctx.authHeaders })).json() as {
      roles: Array<{ role: string; effectiveModel: string | null; override: { model: string } | null }>;
    };
    const conversation = list.roles.find((r) => r.role === 'conversation')!;
    expect(conversation.effectiveModel).toBe('claude-opus-4-8');
    expect(conversation.override?.model).toBe('claude-opus-4-8');
  });

  it('DELETE clears an override (reverts to env default)', async () => {
    await app().request('/v1/orchestrator/models/planning', {
      method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ model: 'm' }),
    });
    const del = await app().request('/v1/orchestrator/models/planning', { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    expect(config.resolveOverride(ctx.workspace.id, 'planning')).toBeNull();
  });

  it('rejects an unknown role', async () => {
    const res = await app().request('/v1/orchestrator/models/bogus', {
      method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ model: 'm' }),
    });
    expect(res.status).toBe(422);
  });

  it('requires authentication', async () => {
    const res = await app().request('/v1/orchestrator/models');
    expect(res.status).toBe(401);
  });
});
