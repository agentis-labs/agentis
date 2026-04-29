/**
 * createTestContext — shared fixture for route + service integration tests.
 *
 * Spins up an in-memory SQLite database with the embedded schema, an
 * `AuthService` bound to a freshly-generated RS256 keypair, an in-process
 * event bus, and a seeded operator user + Personal workspace + Local
 * ambient. Returns helpers to mount any `buildXxxRoutes(...)` builder onto
 * a Hono app and issue authenticated requests via `app.request()`.
 *
 * Why a single helper: route tests must hit the same composition root the
 * production bootstrap uses (errorHandler, requireAuth, requireWorkspace),
 * otherwise a regression in any one of those middlewares slips through.
 */

import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema, openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type Database from 'better-sqlite3';
import { AuthService } from '../../src/services/auth.js';
import { createInProcessEventBus, type EventBus, type BusMessage } from '../../src/event-bus.js';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { errorHandler } from '../../src/middleware/error.js';
import { createLogger, type Logger } from '../../src/logger.js';
import type { AgentisSecrets } from '../../src/secrets.js';

export interface TestContext {
  db: AgentisSqliteDb;
  sqlite: Database.Database;
  auth: AuthService;
  bus: EventBus;
  vault: CredentialVault;
  logger: Logger;
  secrets: AgentisSecrets;
  /** Seeded user. */
  user: { id: string; username: string; displayName: string };
  /** Seeded workspace. */
  workspace: { id: string; slug: string };
  /** Seeded ambient. */
  ambient: { id: string };
  /** Pre-issued bearer access token for the seeded user. */
  accessToken: string;
  /** Pre-issued refresh token for the seeded user. */
  refreshToken: string;
  /** Default authenticated headers (Bearer + workspace + ambient). */
  authHeaders: Record<string, string>;
  /**
   * Build a Hono app pre-wired with `errorHandler` and mount one or more
   * route builders. Returns the assembled app for direct `app.request()` use.
   */
  buildApp(mounts: Array<{ path: string; app: Hono }>): Hono;
  /**
   * Capture every event the in-process bus publishes. Returns a snapshot
   * array that grows as events fire, plus an unsubscribe function.
   */
  captureBus(): { events: BusMessage[]; stop: () => void };
  /** Tear down the SQLite handle. */
  close(): void;
}

export interface CreateTestContextOptions {
  /** Disable foreign keys so synthetic FK references work. Default: false. */
  foreignKeysOff?: boolean;
  /** Override the seeded username. Default: `operator`. */
  username?: string;
}

export async function createTestContext(
  options: CreateTestContextOptions = {},
): Promise<TestContext> {
  const { db, sqlite } = openSqlite({ path: ':memory:' });
  if (options.foreignKeysOff) {
    sqlite.pragma('foreign_keys = OFF');
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const secrets: AgentisSecrets = {
    jwtPrivateKeyPem: privateKey,
    jwtPublicKeyPem: publicKey,
    credentialKeyB64: randomBytes(32).toString('base64'),
  };
  const auth = new AuthService(secrets);
  const bus = createInProcessEventBus();
  const vault = new CredentialVault(secrets.credentialKeyB64);
  const logger = createLogger({ level: 'error' });

  const username = options.username ?? 'operator';
  const userId = randomUUID();
  const passwordHash = await auth.hashPassword('hunter2-very-secure');
  db.insert(schema.users)
    .values({
      id: userId,
      username,
      displayName: 'Operator',
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

  const tokens = await auth.issueTokens(userId, username);

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'x-agentis-workspace': workspaceId,
    'x-agentis-ambient': ambientId,
    'content-type': 'application/json',
  };

  return {
    db,
    sqlite,
    auth,
    bus,
    vault,
    logger,
    secrets,
    user: { id: userId, username, displayName: 'Operator' },
    workspace: { id: workspaceId, slug: 'personal' },
    ambient: { id: ambientId },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    authHeaders,
    buildApp(mounts) {
      const app = new Hono();
      app.onError(errorHandler(logger));
      for (const { path, app: routeApp } of mounts) {
        app.route(path, routeApp);
      }
      return app;
    },
    captureBus() {
      const events: BusMessage[] = [];
      const stop = bus.subscribe((m) => {
        events.push(m);
      });
      return { events, stop };
    },
    close() {
      sqlite.close();
    },
  };
}
