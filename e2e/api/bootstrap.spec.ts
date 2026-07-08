/**
 * Documented setup path: issue an API key, then bootstrap through the fully
 * composed running API using that key and the workspace header.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/bootstrap', () => {
  test('accepts a settings-issued API key and preserves one orchestrator', async ({ request }) => {
    const keyResponse = await request.post('/v1/auth/api-keys', {
      headers: ctx.headers,
      data: { name: 'CLI bootstrap' },
    });
    expect(keyResponse.status()).toBe(201);
    const keyBody = await keyResponse.json();
    const apiKey = keyBody.key.secret as string;
    const apiKeyHeaders = {
      Authorization: `Bearer ${apiKey}`,
      'x-agentis-workspace': ctx.workspace.id,
    };

    const payload = {
      agent: {
        name: 'The Brain',
        adapterType: 'http',
        role: 'orchestrator',
        config: { url: 'http://127.0.0.1:9' },
      },
      channels: [],
    };
    const created = await request.post('/v1/bootstrap', { headers: apiKeyHeaders, data: payload });
    expect(created.status()).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.existed).toBe(false);

    const second = await request.post('/v1/bootstrap', { headers: apiKeyHeaders, data: payload });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.existed).toBe(true);
    expect(secondBody.agentId).toBe(createdBody.agentId);

    const agents = await request.get('/v1/agents?role=orchestrator', { headers: apiKeyHeaders });
    expect(agents.ok()).toBeTruthy();
    const agentBody = await agents.json();
    expect(agentBody.agents).toHaveLength(1);
    expect(agentBody.agents[0].id).toBe(createdBody.agentId);
  });
});
