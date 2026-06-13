/**
 * /v1/abilities — REST surface smoke test.
 * Covers create → patch → add example → request compile → export round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbilityService } from '../../src/services/abilityService.js';
import { AbilityCreationService } from '../../src/services/abilityCreationService.js';
import { buildAbilityRoutes } from '../../src/routes/abilities.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let abilities: AbilityService;
let creation: AbilityCreationService;

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AbilityService(ctx.db, ctx.logger);
  creation = new AbilityCreationService({ db: ctx.db, logger: ctx.logger, abilities, llm: undefined });
});

afterEach(() => {
  ctx.close();
});

describe('/v1/abilities', () => {
  it('CRUDs an ability', async () => {
    const app = ctx.buildApp([
      { path: '/v1/abilities', app: buildAbilityRoutes({ db: ctx.db, auth: ctx.auth, abilities, creation }) },
    ]);

    const createRes = await app.request('/v1/abilities', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Senior UI Engineer',
        domainTag: 'ui_engineering',
        description: 'React + Tailwind component specialist',
        rulesAlways: ['Use semantic HTML'],
        rulesNever: ['Inline styles'],
        specs: { stack: 'React 19 + TypeScript 5.5' },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { ability: { id: string; slug: string; compileStatus: string } };
    expect(created.ability.slug).toBe('senior-ui-engineer');
    expect(created.ability.compileStatus).toBe('pending');

    const listRes = await app.request('/v1/abilities', { headers: ctx.authHeaders });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { abilities: unknown[] };
    expect(list.abilities).toHaveLength(1);

    const patchRes = await app.request(`/v1/abilities/${created.ability.id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ description: 'Updated' }),
    });
    expect(patchRes.status).toBe(200);

    const exampleRes = await app.request(`/v1/abilities/${created.ability.id}/examples`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        inputText: 'Build a pricing table',
        outputText: 'Here is a Tailwind grid ...',
        qualityScore: 0.9,
      }),
    });
    expect(exampleRes.status).toBe(201);

    const compileRes = await app.request(`/v1/abilities/${created.ability.id}/compile`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(compileRes.status).toBe(200);
    const compiled = (await compileRes.json()) as { ability: { compileStatus: string } };
    expect(compiled.ability.compileStatus).toBe('compiling');

    const statusRes = await app.request(`/v1/abilities/${created.ability.id}/compile-status`, {
      headers: ctx.authHeaders,
    });
    expect(statusRes.status).toBe(200);

    const exportRes = await app.request(`/v1/abilities/${created.ability.id}/export`, {
      headers: ctx.authHeaders,
    });
    expect(exportRes.status).toBe(200);
    const pkg = (await exportRes.json()) as { format_version: string; manifest: { name: string }; examples: unknown[] };
    expect(pkg.format_version).toBe('1.0');
    expect(pkg.manifest.name).toBe('Senior UI Engineer');
    expect(pkg.examples).toHaveLength(1);

    const importRes = await app.request('/v1/abilities/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(pkg),
    });
    expect(importRes.status).toBe(201);

    const deleteRes = await app.request(`/v1/abilities/${created.ability.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(deleteRes.status).toBe(200);
  });

  it('rejects creation without auth', async () => {
    const app = ctx.buildApp([
      { path: '/v1/abilities', app: buildAbilityRoutes({ db: ctx.db, auth: ctx.auth, abilities, creation }) },
    ]);
    const res = await app.request('/v1/abilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No auth' }),
    });
    expect(res.status).toBe(401);
  });
});
