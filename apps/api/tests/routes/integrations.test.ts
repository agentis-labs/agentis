import { describe, it, expect, beforeEach } from 'vitest';
import { buildIntegrationRoutes } from '../../src/routes/integrations.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    { path: '/v1/integrations', app: buildIntegrationRoutes({ db: ctx.db, auth: ctx.auth }) },
  ]);
}

describe('/v1/integrations', () => {
  it('lists built-in manifests plus custom manifests', async () => {
    const list = await app().request('/v1/integrations', { headers: ctx.authHeaders });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { integrations: Array<{ service: string }> };
    expect(body.integrations.some((item) => item.service === 'http_request')).toBe(true);
  });

  it('creates, updates, and deletes a custom HTTP integration manifest', async () => {
    const create = await app().request('/v1/integrations', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        service: 'demo_api',
        name: 'Demo API',
        version: '1.0.0',
        category: 'Custom',
        description: 'Demo custom connector',
        auth: { type: 'none' },
        operationSpecs: [
          {
            name: 'get_item',
            method: 'GET',
            urlTemplate: 'https://example.com/items/{{id}}',
            paramSchema: { type: 'object' },
          },
        ],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { integration: { id: string; service: string } };
    expect(created.integration.service).toBe('demo_api');

    const update = await app().request(`/v1/integrations/${created.integration.id}`, {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        service: 'demo_api',
        name: 'Demo API v2',
        version: '1.0.1',
        category: 'Custom',
        description: 'Updated',
        auth: { type: 'none' },
        operationSpecs: [
          {
            name: 'get_item',
            method: 'GET',
            urlTemplate: 'https://example.com/items/{{id}}',
            paramSchema: { type: 'object' },
          },
        ],
      }),
    });
    expect(update.status).toBe(200);

    const del = await app().request(`/v1/integrations/${created.integration.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(del.status).toBe(200);
  });
});
