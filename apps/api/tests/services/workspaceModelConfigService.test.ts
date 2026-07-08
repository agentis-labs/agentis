/**
 * WorkspaceModelConfigService — per-workspace model-role overrides (§4.4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { WorkspaceModelConfigService } from '../../src/services/workspace/workspaceModelConfigService.js';

describe('WorkspaceModelConfigService', () => {
  let ctx: TestContext;
  let svc: WorkspaceModelConfigService;
  beforeEach(async () => {
    ctx = await createTestContext();
    svc = new WorkspaceModelConfigService({ db: ctx.db, vault: ctx.vault, logger: ctx.logger });
  });
  afterEach(() => ctx.close());

  it('sets, lists (key-redacted), and resolves an override', () => {
    const saved = svc.set({ workspaceId: ctx.workspace.id, role: 'conversation', model: 'claude-opus-4-8', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' });
    expect(saved.model).toBe('claude-opus-4-8');
    expect(saved.hasApiKey).toBe(true);

    const list = svc.list(ctx.workspace.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ role: 'conversation', model: 'claude-opus-4-8', baseUrl: 'https://api.example.com/v1', hasApiKey: true });
    // The key is never exposed in the public projection.
    expect((list[0] as Record<string, unknown>).apiKey).toBeUndefined();

    const override = svc.resolveOverride(ctx.workspace.id, 'conversation');
    expect(override).toEqual({ model: 'claude-opus-4-8', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' });
  });

  it('encrypts the API key at rest', () => {
    svc.set({ workspaceId: ctx.workspace.id, role: 'planning', model: 'm', apiKey: 'plaintext-key' });
    const row = ctx.db
      .select()
      .from(schema.workspaceModelConfig)
      .where(eq(schema.workspaceModelConfig.role, 'planning'))
      .get()!;
    expect(row.apiKeyEncrypted).toBeTruthy();
    expect(row.apiKeyEncrypted).not.toContain('plaintext-key');
    expect(ctx.vault.decrypt(row.apiKeyEncrypted!)).toBe('plaintext-key');
  });

  it('keeps the existing key when apiKey is omitted, clears on null', () => {
    svc.set({ workspaceId: ctx.workspace.id, role: 'conversation', model: 'm1', apiKey: 'k1' });
    svc.set({ workspaceId: ctx.workspace.id, role: 'conversation', model: 'm2' }); // omit key
    expect(svc.resolveOverride(ctx.workspace.id, 'conversation')).toEqual({ model: 'm2', apiKey: 'k1' });
    svc.set({ workspaceId: ctx.workspace.id, role: 'conversation', model: 'm3', apiKey: null }); // clear key
    expect(svc.resolveOverride(ctx.workspace.id, 'conversation')).toEqual({ model: 'm3' });
  });

  it('clear() removes the override', () => {
    svc.set({ workspaceId: ctx.workspace.id, role: 'evaluation', model: 'm' });
    svc.clear(ctx.workspace.id, 'evaluation');
    expect(svc.resolveOverride(ctx.workspace.id, 'evaluation')).toBeNull();
    expect(svc.list(ctx.workspace.id)).toHaveLength(0);
  });
});
