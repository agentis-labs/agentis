/**
 * Lossless cold storage for high-volume operational history.
 *
 * The hot SQLite database remains small and fast; gzip archives retain the
 * original JSON verbatim under AGENTIS_DATA_DIR/archives. Writes are atomic and
 * idempotent, so hot rows are deleted/compacted only after their archive exists.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface ColdArchiveRef {
  kind: 'run_state' | 'ledger' | 'observability';
  path: string;
  sha256: string;
  originalBytes: number;
  compressedBytes: number;
  recordCount: number;
  archivedAt: string;
}

export interface ArchivedRunState {
  version: 1;
  runId: string;
  workspaceId: string;
  status: string;
  runState: unknown;
  graphSnapshot: unknown;
  archivedAt: string;
}

type JsonRecord = Record<string, unknown>;

export class ColdArchiveStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  archiveRunState(input: Omit<ArchivedRunState, 'version' | 'archivedAt'>): ColdArchiveRef {
    const payload: ArchivedRunState = { version: 1, ...input, archivedAt: new Date().toISOString() };
    return this.#write(`runs/${safeId(input.workspaceId)}/${safeId(input.runId)}.json.gz`, 'run_state', payload, 1);
  }

  readRunState(ref: ColdArchiveRef): ArchivedRunState | null {
    return this.#read<ArchivedRunState>(ref);
  }

  hydrateRunState(state: unknown): unknown {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
    const compact = state as Record<string, unknown>;
    if (compact._compacted !== true || !compact._archive || typeof compact._archive !== 'object') return state;
    const archived = this.readRunState(compact._archive as unknown as ColdArchiveRef);
    return archived?.runState ?? state;
  }

  archiveLedgerEvents(workspaceId: string, runId: string, events: JsonRecord[]): ColdArchiveRef {
    const path = `ledger/${safeId(workspaceId)}/${safeId(runId)}.json.gz`;
    const merged = mergeById(this.#readPath<JsonRecord[]>(path) ?? [], events);
    return this.#write(path, 'ledger', merged, merged.length);
  }

  readLedgerEvents(workspaceId: string, runId: string): JsonRecord[] {
    return this.#readPath<JsonRecord[]>(`ledger/${safeId(workspaceId)}/${safeId(runId)}.json.gz`) ?? [];
  }

  archiveObservabilityEvents(workspaceId: string, day: string, events: JsonRecord[]): ColdArchiveRef {
    const normalizedDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown-date';
    const path = `observability/${safeId(workspaceId)}/${normalizedDay}.json.gz`;
    const merged = mergeById(this.#readPath<JsonRecord[]>(path) ?? [], events);
    return this.#write(path, 'observability', merged, merged.length);
  }

  readObservabilityDay(workspaceId: string, day: string): JsonRecord[] {
    return this.#readPath<JsonRecord[]>(`observability/${safeId(workspaceId)}/${day}.json.gz`) ?? [];
  }

  listObservabilityEvents(workspaceId: string): JsonRecord[] {
    const relativeDir = `observability/${safeId(workspaceId)}`;
    const dir = this.#target(relativeDir);
    if (!existsSync(dir)) return [];
    const rows: JsonRecord[] = [];
    for (const name of readdirSync(dir).filter((entry) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(entry)).sort()) {
      rows.push(...(this.#readPath<JsonRecord[]>(`${relativeDir}/${name}`) ?? []));
    }
    return rows.sort((a, b) => Number(a.sequenceNumber ?? 0) - Number(b.sequenceNumber ?? 0));
  }

  #write(relativePath: string, kind: ColdArchiveRef['kind'], value: unknown, recordCount: number): ColdArchiveRef {
    const target = this.#target(relativePath);
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    const compressed = gzipSync(json, { level: 9 });
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temp, compressed, { flag: 'wx' });
      renameSync(temp, target);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
    return {
      kind,
      path: relativePath.replace(/\\/g, '/'),
      sha256,
      originalBytes: json.byteLength,
      compressedBytes: compressed.byteLength,
      recordCount,
      archivedAt: new Date().toISOString(),
    };
  }

  #read<T>(ref: ColdArchiveRef): T | null {
    const target = this.#target(ref.path);
    if (!existsSync(target)) return null;
    const compressed = readFileSync(target);
    const actual = createHash('sha256').update(compressed).digest('hex');
    if (actual !== ref.sha256) throw new Error(`Cold archive checksum mismatch: ${ref.path}`);
    return JSON.parse(gunzipSync(compressed).toString('utf8')) as T;
  }

  #readPath<T>(relativePath: string): T | null {
    const target = this.#target(relativePath);
    if (!existsSync(target)) return null;
    return JSON.parse(gunzipSync(readFileSync(target)).toString('utf8')) as T;
  }

  #target(relativePath: string): string {
    const target = resolve(this.rootDir, relativePath);
    if (target !== this.rootDir && !target.startsWith(`${this.rootDir}\\`) && !target.startsWith(`${this.rootDir}/`)) {
      throw new Error(`Unsafe cold archive path: ${relativePath}`);
    }
    return target;
  }
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Invalid cold archive identifier');
  return safe;
}

function mergeById(existing: JsonRecord[], incoming: JsonRecord[]): JsonRecord[] {
  const rows = new Map<string, JsonRecord>();
  for (const row of [...existing, ...incoming]) {
    const id = typeof row.id === 'string' ? row.id : createHash('sha256').update(JSON.stringify(row)).digest('hex');
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => {
    const left = typeof a.sequenceNumber === 'number' ? a.sequenceNumber : 0;
    const right = typeof b.sequenceNumber === 'number' ? b.sequenceNumber : 0;
    return left - right;
  });
}
