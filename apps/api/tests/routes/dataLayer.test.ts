import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAgentLedgerRoutes } from '../../src/routes/agentLedger.js';
import { buildKnowledgeBaseRoutes } from '../../src/routes/knowledgeBases.js';
import { buildFileRoutes } from '../../src/routes/files.js';
import { AgentLedgerService } from '../../src/services/agentLedger.js';
import { KnowledgeBaseService } from '../../src/services/knowledgeBase.js';
import { FileStorageService } from '../../src/services/fileStorage.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;
let ledgerData: AgentLedgerService;
let knowledge: KnowledgeBaseService;
let files: FileStorageService;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'agentis-data-layer-'));
  ledgerData = new AgentLedgerService(ctx.db);
  knowledge = new KnowledgeBaseService(ctx.db);
  files = new FileStorageService(ctx.db, dataDir);
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function app() {
  return ctx.buildApp([
    { path: '/v1/ledger', app: buildAgentLedgerRoutes({ db: ctx.db, auth: ctx.auth, ledgerData }) },
    { path: '/v1/knowledge-bases', app: buildKnowledgeBaseRoutes({ db: ctx.db, auth: ctx.auth, knowledge }) },
    { path: '/v1/files', app: buildFileRoutes({ db: ctx.db, auth: ctx.auth, files }) },
  ]);
}

describe('Sprint B data layer routes', () => {
  it('creates a ledger table and writes typed rows', async () => {
    const createRes = await app().request('/v1/ledger', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Deals',
        columns: [
          { id: 'summary', name: 'Summary', type: 'text', required: true },
          { id: 'amount', name: 'Amount', type: 'number' },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { table: { id: string } };

    const rowRes = await app().request(`/v1/ledger/${created.table.id}/rows`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ data: { summary: 'ACME renewal', amount: '42' } }),
    });
    expect(rowRes.status).toBe(201);
    const rowBody = (await rowRes.json()) as { row: { data: { amount: number } } };
    expect(rowBody.row.data.amount).toBe(42);

    const queryRes = await app().request(`/v1/ledger/${created.table.id}/rows?q=acme`, {
      headers: ctx.authHeaders,
    });
    const queryBody = (await queryRes.json()) as { rows: Array<{ id: string }> };
    expect(queryBody.rows).toHaveLength(1);
  });

  it('indexes text documents and searches knowledge chunks', async () => {
    const createRes = await app().request('/v1/knowledge-bases', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Ops KB' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { knowledgeBase: { id: string } };

    const docRes = await app().request(`/v1/knowledge-bases/${created.knowledgeBase.id}/documents`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'runbook.md',
        mimeType: 'text/markdown',
        content: 'Escalate payment failures to billing operations before retrying the workflow.',
      }),
    });
    expect(docRes.status).toBe(201);

    const searchRes = await app().request(`/v1/knowledge-bases/${created.knowledgeBase.id}/search`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ query: 'payment retry', topK: 3 }),
    });
    const searchBody = (await searchRes.json()) as { results: Array<{ content: string; score: number }> };
    expect(searchBody.results[0]?.content).toContain('payment failures');
    expect(searchBody.results[0]?.score).toBeGreaterThan(0);
  });

  it('stores and downloads workspace files', async () => {
    const uploadRes = await app().request('/v1/files', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'hello.txt', mimeType: 'text/plain', content: 'hello agentis' }),
    });
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { file: { id: string; checksumSha256: string } };
    expect(uploadBody.file.checksumSha256).toHaveLength(64);

    const listRes = await app().request('/v1/files', { headers: ctx.authHeaders });
    const listBody = (await listRes.json()) as { files: Array<{ name: string }> };
    expect(listBody.files[0]?.name).toBe('hello.txt');

    const downloadRes = await app().request(`/v1/files/${uploadBody.file.id}`, { headers: ctx.authHeaders });
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe('hello agentis');
  });
});
