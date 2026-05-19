import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { buildAppRoutes } from '../../src/routes/apps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/apps',
      app: buildAppRoutes({
        db: ctx.db,
        auth: ctx.auth,
        bus: ctx.bus,
      } as never),
    },
  ]);
}

describe('/v1/apps draft creation', () => {
  it('creates an orchestrated draft app with image metadata and canvas build path', async () => {
    const iconUrl = 'data:image/png;base64,aGVsbG8=';

    const response = await app().request('/v1/apps', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Autonomous SDR',
        goal: 'Build a zero-inbox autonomous SDR app.',
        appKind: 'sales',
        creationMode: 'orchestrated_draft',
        iconGlyph: 'AS',
        iconColor: '#16a34a',
        iconUrl,
        surfaces: [{ type: 'thread' }, { type: 'dashboard', label: 'Pipeline' }],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as {
      appId: string;
      app: {
        slug: string;
        iconUrl: string | null;
        creationMode: string;
        path: string;
        surfaces: Array<{ type: string; label?: string }>;
      };
    };

    expect(body.app.iconUrl).toBe(iconUrl);
    expect(body.app.creationMode).toBe('orchestrated_draft');
    expect(body.app.path).toBe(`/apps/${body.app.slug}?layer=canvas&build=1`);
    expect(body.app.surfaces).toEqual([{ type: 'thread' }, { type: 'dashboard', label: 'Pipeline' }]);

    const row = ctx.db.select().from(schema.appInstances).where(eq(schema.appInstances.id, body.appId)).get();
    expect(row).toBeTruthy();
    const contents = row!.packageContents as Record<string, unknown>;
    expect(contents.iconUrl).toBe(iconUrl);
    expect(contents.creationMode).toBe('orchestrated_draft');

    const libraryPackage = ctx.db
      .select()
      .from(schema.libraryPackages)
      .where(eq(schema.libraryPackages.id, row!.packageId!))
      .get();
    expect(libraryPackage?.tags).toContain('orchestrated-draft');
  });
});
