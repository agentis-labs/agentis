import { constants, existsSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
  remediation?: string[];
}

interface SqliteDatabaseLike {
  prepare(sql: string): { get(): unknown };
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

type SqliteConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => SqliteDatabaseLike;

export type SqliteLoader = () => Promise<unknown>;

export interface HostDoctorOptions {
  dataDir: string;
  packageRoot: string;
  loadSqlite?: SqliteLoader;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conciseNativeError(error: unknown): string {
  const message = errorMessage(error);
  if (/could not locate the bindings file/i.test(message)) {
    return `native binding is missing for Node ${process.versions.node} (${process.platform}-${process.arch}, ABI ${process.versions.modules})`;
  }
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) {
    return `native binding does not match Node ${process.versions.node} (ABI ${process.versions.modules})`;
  }
  return message.split(/\r?\n/, 1)[0] ?? message;
}

function sqliteConstructor(moduleValue: unknown): SqliteConstructor {
  const candidate = moduleValue && typeof moduleValue === 'object' && 'default' in moduleValue
    ? (moduleValue as { default: unknown }).default
    : moduleValue;
  if (typeof candidate !== 'function') {
    throw new Error('better-sqlite3 did not export a database constructor');
  }
  return candidate as SqliteConstructor;
}

function sqliteRepairSteps(packageRoot: string): string[] {
  return [
    'Check whether npm lifecycle scripts are disabled: npm config get ignore-scripts',
    `Rebuild the binding: npm rebuild better-sqlite3 --prefix ${JSON.stringify(packageRoot)} --foreground-scripts`,
    'If the rebuild reports node-gyp errors, install Python 3 and Visual Studio Build Tools with Desktop development with C++.',
  ];
}

export function checkNodeRuntime(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > 20 || (major === 20 && minor >= 10);
  return {
    id: 'node-runtime',
    label: 'Node.js runtime',
    ok,
    required: true,
    detail: `${process.versions.node} (${process.platform}-${process.arch}, ABI ${process.versions.modules})`,
    ...(!ok ? { remediation: ['Install Node.js 20.10 or newer; an active LTS release is recommended.'] } : {}),
  };
}

export async function checkDataDirectory(dataDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.R_OK | constants.W_OK);
    return {
      id: 'data-directory',
      label: 'Data directory',
      ok: true,
      required: true,
      detail: `${dataDir} (readable and writable)`,
    };
  } catch (error) {
    return {
      id: 'data-directory',
      label: 'Data directory',
      ok: false,
      required: true,
      detail: `${dataDir}: ${errorMessage(error)}`,
      remediation: ['Set AGENTIS_DATA_DIR to a directory the current user can read and write.'],
    };
  }
}

export async function checkSqliteRuntime(options: HostDoctorOptions): Promise<DoctorCheck[]> {
  const loadSqlite = options.loadSqlite ?? (async () => {
    const requireFromPackage = createRequire(join(options.packageRoot, 'package.json'));
    return requireFromPackage('better-sqlite3') as unknown;
  });
  let Database: SqliteConstructor;
  let probe: SqliteDatabaseLike | undefined;

  try {
    Database = sqliteConstructor(await loadSqlite());
    // The wrapper imports without loading the native `.node` file. Constructing
    // and querying a database catches missing and ABI-mismatched bindings.
    probe = new Database(':memory:');
    const row = probe.prepare('SELECT 1 AS value').get() as { value?: unknown } | undefined;
    if (row?.value !== 1) throw new Error('SQLite smoke query returned an unexpected result');
    probe.close();
    probe = undefined;
  } catch (error) {
    try {
      probe?.close();
    } catch {
      // Preserve the original load/query error.
    }
    return [{
      id: 'sqlite-native',
      label: 'SQLite native runtime',
      ok: false,
      required: true,
      detail: conciseNativeError(error),
      remediation: sqliteRepairSteps(options.packageRoot),
    }];
  }

  const checks: DoctorCheck[] = [{
    id: 'sqlite-native',
    label: 'SQLite native runtime',
    ok: true,
    required: true,
    detail: 'better-sqlite3 loaded and completed an in-memory query',
  }];

  const databasePath = join(options.dataDir, 'data.db');
  if (!existsSync(databasePath)) {
    checks.push({
      id: 'sqlite-database',
      label: 'Agentis database',
      ok: true,
      required: true,
      detail: 'not created yet (first boot will initialize it)',
    });
    return checks;
  }

  let database: SqliteDatabaseLike | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check returned ${String(integrity)}`);
    database.close();
    database = undefined;
    checks.push({
      id: 'sqlite-database',
      label: 'Agentis database',
      ok: true,
      required: true,
      detail: `${databasePath} (integrity check passed)`,
    });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original database error.
    }
    checks.push({
      id: 'sqlite-database',
      label: 'Agentis database',
      ok: false,
      required: true,
      detail: `${databasePath}: ${errorMessage(error)}`,
      remediation: ['Back up the data directory before attempting database recovery or replacement.'],
    });
  }
  return checks;
}

export async function runHostDoctor(options: HostDoctorOptions): Promise<DoctorCheck[]> {
  const [dataDirectory, sqlite] = await Promise.all([
    checkDataDirectory(options.dataDir),
    checkSqliteRuntime(options),
  ]);
  return [checkNodeRuntime(), dataDirectory, ...sqlite];
}

export function requiredChecksPassed(checks: DoctorCheck[]): boolean {
  return checks.every((check) => !check.required || check.ok);
}
