import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/sqlite/index.js';

describe('workflow revision persistence', () => {
  it('installs immutable revisions, proof, experience, and repair-attempt storage on a fresh database', () => {
    const { sqlite } = openSqlite({ path: ':memory:' });
    try {
      const tables = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'workflow_graph_revisions',
          'workflow_revision_proofs',
          'workflow_experiences',
          'workflow_repair_attempts'
        )
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        'workflow_experiences',
        'workflow_graph_revisions',
        'workflow_repair_attempts',
        'workflow_revision_proofs',
      ]);

      const workflowColumns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{ name: string }>;
      expect(workflowColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'active_revision_id',
        'candidate_revision_id',
        'trust_state',
      ]));

      const runColumns = sqlite.prepare("PRAGMA table_info('workflow_runs')").all() as Array<{ name: string }>;
      expect(runColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'graph_snapshot',
        'workflow_revision_id',
        'repaired_from_revision_id',
      ]));

      const indexes = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'uq_workflow_revision_proof_gate',
          'uq_workflow_repair_attempt_fingerprint',
          'idx_workflow_experiences_scope'
        )
      `).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        'uq_workflow_revision_proof_gate',
        'uq_workflow_repair_attempt_fingerprint',
        'idx_workflow_experiences_scope',
      ]));
    } finally {
      sqlite.close();
    }
  });
});
