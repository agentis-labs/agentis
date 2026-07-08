import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { RuntimeProfileService } from '../../src/services/runtime/runtimeProfileService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let home: string;

beforeEach(async () => {
  ctx = await createTestContext();
  home = mkdtempSync(join(tmpdir(), 'agentis-hermes-profile-'));
});

afterEach(() => {
  ctx.close();
  rmSync(home, { recursive: true, force: true });
});

describe('RuntimeProfileService', () => {
  it('discovers actual Hermes files, redacts secrets, and detects the profile model', async () => {
    seedHermesProfile();
    const agent = seedAgent();
    const service = new RuntimeProfileService(ctx.db, new AdapterManager(ctx.logger), ctx.logger);

    const resources = service.listResources(agent);
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(home, 'SOUL.md'), kind: 'identity', editable: true }),
      expect.objectContaining({ path: join(home, 'config.yaml'), kind: 'config', editable: false }),
      expect.objectContaining({ path: join(home, '.env'), kind: 'secret_reference', sensitive: true }),
      expect.objectContaining({ path: join(home, 'memories', 'operator.md'), kind: 'memory' }),
      expect.objectContaining({ path: join(home, 'skills', 'research', 'SKILL.md'), kind: 'skill' }),
    ]));

    const secret = resources.find((resource) => resource.path === join(home, '.env'));
    expect(secret).toBeDefined();
    expect(service.readResource(agent, secret!.id).content).toBe('[redacted]');

    const runtime = await service.describe(agent);
    expect(runtime.currentModel).toEqual(expect.objectContaining({
      value: 'stepfun/step-3.7-flash:free',
      source: 'profile',
      verified: true,
    }));
    expect(runtime.home).toEqual(expect.objectContaining({ value: home, verified: true }));
  });

  it('writes editable native files atomically and rejects stale checksums', () => {
    seedHermesProfile();
    const agent = seedAgent();
    const service = new RuntimeProfileService(ctx.db, new AdapterManager(ctx.logger), ctx.logger);
    const soul = service.listResources(agent).find((resource) => resource.path === join(home, 'SOUL.md'));
    expect(soul?.checksum).toBeTruthy();

    const updated = service.writeResource(agent, soul!.id, '# Updated identity', soul!.checksum);
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('# Updated identity');
    expect(updated.resource.checksum).not.toBe(soul!.checksum);

    expect(() => service.writeResource(agent, soul!.id, '# Stale overwrite', soul!.checksum))
      .toThrow('changed outside Agentis');
  });
});

function seedHermesProfile(): void {
  mkdirSync(join(home, 'memories'), { recursive: true });
  mkdirSync(join(home, 'skills', 'research'), { recursive: true });
  writeFileSync(join(home, 'SOUL.md'), '# Native Hermes identity', 'utf8');
  writeFileSync(
    join(home, 'config.yaml'),
    'model:\n  default: stepfun/step-3.7-flash:free\n',
    'utf8',
  );
  writeFileSync(join(home, '.env'), 'HERMES_API_KEY=super-secret\n', 'utf8');
  writeFileSync(join(home, 'memories', 'operator.md'), '# Operator memory', 'utf8');
  writeFileSync(join(home, 'skills', 'research', 'SKILL.md'), '# Research skill', 'utf8');
}

function seedAgent() {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Hermes Native',
    adapterType: 'hermes_agent',
    capabilityTags: [],
    config: { env: { HERMES_HOME: home } },
    status: 'offline',
  }).run();
  return ctx.db.select().from(schema.agents).get()!;
}
