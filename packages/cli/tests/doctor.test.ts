import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkSqliteRuntime, requiredChecksPassed } from '../src/doctor.js';

class HealthyDatabase {
  constructor(_filename: string, _options?: { readonly?: boolean; fileMustExist?: boolean }) {}

  prepare(_sql: string) {
    return { get: () => ({ value: 1 }) };
  }

  pragma(source: string) {
    return source === 'integrity_check' ? 'ok' : undefined;
  }

  close() {}
}

test('executes a query so lazy native binding failures are detected', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentis-doctor-'));
  try {
    const checks = await checkSqliteRuntime({
      dataDir,
      packageRoot: 'C:\\agentis-cli',
      loadSqlite: async () => ({ default: HealthyDatabase }),
    });

    assert.equal(requiredChecksPassed(checks), true);
    assert.deepEqual(checks.map((check) => check.id), ['sqlite-native', 'sqlite-database']);
    assert.match(checks[0]!.detail, /completed an in-memory query/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('turns a missing lazy binding into an actionable failed check', async () => {
  class MissingBindingDatabase {
    constructor() {
      throw new Error('Could not locate the bindings file. Tried: node-v137-win32-x64');
    }
  }
  const checks = await checkSqliteRuntime({
    dataDir: 'C:\\Users\\operator\\.agentis',
    packageRoot: 'C:\\npm\\node_modules\\@agentis-labs\\cli',
    loadSqlite: async () => ({ default: MissingBindingDatabase }),
  });

  assert.equal(requiredChecksPassed(checks), false);
  assert.equal(checks[0]?.id, 'sqlite-native');
  assert.match(checks[0]!.detail, /native binding is missing/);
  assert.match(checks[0]!.remediation?.join('\n') ?? '', /npm config get ignore-scripts/);
  assert.match(checks[0]!.remediation?.join('\n') ?? '', /npm rebuild better-sqlite3/);
});

test('checks an existing Agentis database for corruption', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentis-doctor-'));
  await writeFile(join(dataDir, 'data.db'), 'test fixture');
  class CorruptDatabase extends HealthyDatabase {
    override pragma(source: string) {
      return source === 'integrity_check' ? 'database disk image is malformed' : undefined;
    }
  }

  try {
    const checks = await checkSqliteRuntime({
      dataDir,
      packageRoot: '/agentis-cli',
      loadSqlite: async () => ({ default: CorruptDatabase }),
    });

    assert.equal(requiredChecksPassed(checks), false);
    assert.equal(checks.at(-1)?.id, 'sqlite-database');
    assert.match(checks.at(-1)?.detail ?? '', /integrity_check returned/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
