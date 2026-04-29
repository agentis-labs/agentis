/**
 * First-boot seed.
 *
 * Creates the operator user, a Personal workspace, a Local ambient, and
 * registers the builtin `echo` and `http_fetch` skills. Idempotent — re-runs
 * skip rows that already exist (matched by username/slug).
 *
 * The seed password comes from `AGENTIS_SEED_PASSWORD`. If unset, we generate
 * a random one and log it ONCE on first boot. This is the single point in the
 * lifecycle where Agentis ever prints a credential to stdout — by design,
 * because there is no other way for the operator to bootstrap themselves.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SkillManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AuthService } from './auth.js';
import type { AgentisEnv } from '../env.js';
import { BUILTIN_SKILL_ENTRYPOINTS } from './builtinSkills.js';

export interface SeedResult {
  user: { id: string; username: string };
  workspace: { id: string; slug: string };
  ambient: { id: string };
  generatedPassword?: string;
}

export async function seedIfEmpty(args: {
  db: AgentisSqliteDb;
  env: AgentisEnv;
  auth: AuthService;
  logger: Logger;
}): Promise<SeedResult | null> {
  const { db, env, auth, logger } = args;
  const existing = db.select().from(schema.users).all();
  if (existing.length > 0) {
    return null;
  }

  const username = env.AGENTIS_SEED_USERNAME;
  // Test mode: deterministic password if none was provided, so Playwright
  // specs can sign in without scraping stdout.
  const testDefault = env.AGENTIS_TEST_MODE ? 'test-password-1234' : undefined;
  const explicit = env.AGENTIS_SEED_PASSWORD ?? testDefault;
  const generatedPassword = explicit ? undefined : randomBytes(18).toString('base64url');
  const password = explicit ?? generatedPassword!;

  const userId = randomUUID();
  const passwordHash = await auth.hashPassword(password);

  db.insert(schema.users)
    .values({
      id: userId,
      username,
      displayName: env.AGENTIS_SEED_DISPLAY_NAME,
      passwordHash,
      isAdmin: true,
    })
    .run();

  const workspaceId = randomUUID();
  db.insert(schema.workspaces)
    .values({
      id: workspaceId,
      userId,
      name: 'Personal',
      slug: 'personal',
    })
    .run();

  const ambientId = randomUUID();
  db.insert(schema.ambients)
    .values({
      id: ambientId,
      workspaceId,
      userId,
      name: 'Local',
      kind: 'local',
      settings: {},
    })
    .run();

  db.update(schema.workspaces)
    .set({ defaultAmbientId: ambientId })
    .where(eq(schema.workspaces.id, workspaceId))
    .run();

  // Register builtin skills.
  for (const entrypoint of BUILTIN_SKILL_ENTRYPOINTS) {
    const manifest: SkillManifest = {
      name: entrypoint,
      slug: entrypoint,
      version: '1.0.0',
      runtime: 'builtin',
      entrypoint,
      capabilityTags: ['builtin'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    };
    db.insert(schema.skills)
      .values({
        id: randomUUID(),
        workspaceId,
        ambientId,
        userId,
        name: entrypoint,
        slug: entrypoint,
        version: '1.0.0',
        runtime: 'builtin',
        manifest,
      })
      .run();
  }

  if (generatedPassword) {
    logger.warn('seed.generated_password', {
      username,
      password: generatedPassword,
      hint: 'This is the only time the operator password is printed. Save it now.',
    });
  } else {
    logger.info('seed.completed', { username });
  }

  return {
    user: { id: userId, username },
    workspace: { id: workspaceId, slug: 'personal' },
    ambient: { id: ambientId },
    ...(generatedPassword ? { generatedPassword } : {}),
  };
}
