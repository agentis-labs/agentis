/**
 * Agent instructions — two fixes:
 *  1. Changing an agent's role regenerates the platform `agentis.md` (when it's an
 *     unedited role default), for every role — and never clobbers a custom one.
 *  2. The canonical runtime instruction file is surfaced (creatable) for every
 *     runtime even when it doesn't exist on disk yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { buildAgentMutationRoutes } from '../../src/routes/agentMutations.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { defaultInstructionsForRole } from '../../src/data/playbook-library.js';
import {
  listAgentInstructionFiles,
  resolveWritableInstructionFile,
  writeInstructionFile,
} from '../../src/services/agent/agentInstructionFiles.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;
let conversations: ConversationStore;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
});
afterEach(() => ctx.close());

function mutationApp() {
  return ctx.buildApp([{ path: '/v1/agents', app: buildAgentMutationRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault, adapters, logger: ctx.logger, conversations }) }]);
}

function seedAgent(role: string, instructions: string, name = 'CO') {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'http', capabilityTags: [], config: {}, status: 'offline', role, instructions,
  }).run();
  return id;
}

function loadInstructions(id: string): string | null {
  return ctx.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get()?.instructions ?? null;
}

describe('role change → agentis.md regeneration', () => {
  it('regenerates the default instructions when the role changes (manager → orchestrator)', async () => {
    const id = seedAgent('manager', defaultInstructionsForRole('manager', 'CO')!);
    const res = await mutationApp().request(`/v1/agents/${id}`, {
      method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ role: 'orchestrator' }),
    });
    expect(res.status).toBe(200);
    expect(loadInstructions(id)).toBe(defaultInstructionsForRole('orchestrator', 'CO'));
  });

  it('never overwrites operator-customized instructions on a role change', async () => {
    const custom = 'You are my bespoke agent. Do exactly X.';
    const id = seedAgent('manager', custom);
    await mutationApp().request(`/v1/agents/${id}`, {
      method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ role: 'worker' }),
    });
    expect(loadInstructions(id)).toBe(custom);
  });
});

describe('runtime instruction files — surfaced + creatable for every runtime', () => {
  let codexHome: string;
  const prev = process.env.CODEX_HOME;

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(tmpdir(), 'agentis-codexhome-'));
    process.env.CODEX_HOME = codexHome;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    await rm(codexHome, { recursive: true, force: true });
  });

  it('surfaces the canonical AGENTS.md even though it does not exist yet, then creates it on write', async () => {
    const agent = { adapterType: 'codex', config: {}, instructions: '' };
    const files = listAgentInstructionFiles(agent);
    const runtime = files.find((f) => f.source === 'runtime' && f.name.endsWith('AGENTS.md'));
    expect(runtime).toBeTruthy();
    expect(runtime!.content).toBe('');
    expect(existsSync(path.join(codexHome, 'AGENTS.md'))).toBe(false);

    const target = resolveWritableInstructionFile(agent, runtime!.key);
    expect(target).toEqual({ kind: 'file', path: path.resolve(codexHome, 'AGENTS.md') });
    writeInstructionFile(target as { kind: 'file'; path: string }, 'codex rules here');
    expect(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8')).toBe('codex rules here');

    const after = listAgentInstructionFiles(agent).find((f) => f.source === 'runtime' && f.name.endsWith('AGENTS.md'));
    expect(after!.content).toBe('codex rules here');
  });
});
