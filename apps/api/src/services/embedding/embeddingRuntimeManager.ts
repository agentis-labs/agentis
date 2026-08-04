import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type EmbeddingRuntimeStatus =
  | 'uninitialized'
  | 'downloading'
  | 'verifying'
  | 'loading'
  | 'ready'
  | 'degraded';

export interface EmbeddingArtifactStatus {
  file: string;
  expectedBytes: number;
  downloadedBytes: number;
  ready: boolean;
}

export interface EmbeddingRuntimeSnapshot {
  status: EmbeddingRuntimeStatus;
  model: string;
  revision: string | null;
  dtype: string;
  source: 'managed' | 'legacy' | 'custom';
  progress: number;
  artifacts: EmbeddingArtifactStatus[];
  startedAt: string | null;
  updatedAt: string;
  readyAt: string | null;
  retryAt: string | null;
  errorCode: string | null;
  error: string | null;
}

export interface ManagedEmbeddingArtifact {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ManagedEmbeddingManifest {
  model: string;
  revision: string;
  dtype: 'q8';
  artifacts: ManagedEmbeddingArtifact[];
}

/**
 * The default model is pinned to immutable Hub bytes. Transformers.js remains
 * the inference runtime, but it never owns the first-run download transaction.
 */
export const DEFAULT_Q8_EMBEDDING_MANIFEST: ManagedEmbeddingManifest = {
  model: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dtype: 'q8',
  artifacts: [
    { file: 'config.json', bytes: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
    { file: 'tokenizer.json', bytes: 17_082_730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
    { file: 'tokenizer_config.json', bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
    { file: 'onnx/model_quantized.onnx', bytes: 118_308_185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
  ],
};

type Listener = (snapshot: EmbeddingRuntimeSnapshot) => void;

export interface EmbeddingRuntimeRunOptions {
  model: string;
  dtype?: string;
  cacheDir?: string;
  localModelPath?: string;
  offline?: boolean;
  force?: boolean;
  load: (localFilesOnly: boolean) => Promise<unknown>;
}

const STATE_FILE = 'embedding-runtime.json';
const READY_FILE = 'READY.json';
const STAGING_DIR = '.agentis-staging';
const GENERATIONS_DIR = '.agentis-generations';
const QUARANTINE_DIR = 'quarantine';
const DOWNLOAD_RETRIES_MS = [0, 1_000, 3_000];
const RETRY_COOLDOWN_MS = 60_000;

function now(): string {
  return new Date().toISOString();
}

function blankSnapshot(manifest = DEFAULT_Q8_EMBEDDING_MANIFEST): EmbeddingRuntimeSnapshot {
  return {
    status: 'uninitialized',
    model: manifest.model,
    revision: manifest.revision,
    dtype: manifest.dtype,
    source: 'managed',
    progress: 0,
    artifacts: manifest.artifacts.map((artifact) => ({
      file: artifact.file,
      expectedBytes: artifact.bytes,
      downloadedBytes: 0,
      ready: false,
    })),
    startedAt: null,
    updatedAt: now(),
    readyAt: null,
    retryAt: null,
    errorCode: null,
    error: null,
  };
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 2_000);
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code) return code;
  if (/checksum/i.test(safeError(err))) return 'EMBEDDING_CHECKSUM_MISMATCH';
  if (/size/i.test(safeError(err))) return 'EMBEDDING_SIZE_MISMATCH';
  if (/offline/i.test(safeError(err))) return 'EMBEDDING_OFFLINE_CACHE_MISS';
  return 'EMBEDDING_RUNTIME_UNAVAILABLE';
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function artifactUrl(manifest: ManagedEmbeddingManifest, file: string): string {
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${path}`;
}

function modelFile(cacheDir: string, model: string, file: string): string {
  return resolve(cacheDir, ...model.split('/'), ...file.split('/'));
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

export class EmbeddingRuntimeManager {
  readonly #manifest: ManagedEmbeddingManifest;
  #snapshot: EmbeddingRuntimeSnapshot;
  #cacheDir: string | null = null;
  #operation: Promise<unknown> | null = null;
  #operationKey: string | null = null;
  #pipeline: unknown | null = null;
  #pipelineKey: string | null = null;
  #listeners = new Set<Listener>();
  #lastProgressStep = new Map<string, number>();
  #progressSink: (message: string) => void = (message) => process.stdout.write(`${message}\n`);

  constructor(manifest: ManagedEmbeddingManifest = DEFAULT_Q8_EMBEDDING_MANIFEST) {
    this.#manifest = manifest;
    this.#snapshot = blankSnapshot(manifest);
  }

  setProgressSink(sink: (message: string) => void): void {
    this.#progressSink = sink;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(cacheDir?: string): EmbeddingRuntimeSnapshot {
    if (cacheDir) this.#bindCache(cacheDir);
    return structuredClone(this.#snapshot);
  }

  isReady(model = this.#manifest.model): boolean {
    return this.#snapshot.status === 'ready' && this.#snapshot.model === model && this.#pipeline != null;
  }

  async run(options: EmbeddingRuntimeRunOptions): Promise<unknown> {
    const cacheDir = resolve(options.cacheDir ?? '.agentis/models');
    this.#bindCache(cacheDir);
    const dtype = options.dtype ?? 'fp32';
    const key = `${options.model}@${dtype}:${options.localModelPath ?? cacheDir}`;
    if (!options.force && this.#snapshot.status === 'ready' && this.#pipeline != null && this.#pipelineKey === key) return this.#pipeline;
    if (this.#operation) {
      if (this.#operationKey === key) return this.#operation;
      try { await this.#operation; } catch { /* the next runtime gets its own attempt */ }
      return this.run(options);
    }

    const retryAt = this.#snapshot.retryAt ? Date.parse(this.#snapshot.retryAt) : 0;
    if (!options.force && this.#snapshot.status === 'degraded' && retryAt > Date.now()) {
      const seconds = Math.ceil((retryAt - Date.now()) / 1_000);
      throw Object.assign(new Error(`Embedding runtime is cooling down; retry in ${seconds}s.`), {
        code: 'EMBEDDING_MODEL_UNAVAILABLE',
      });
    }

    this.#operationKey = key;
    this.#operation = this.#run({ ...options, cacheDir, dtype, key }).finally(() => {
      this.#operation = null;
      this.#operationKey = null;
    });
    return this.#operation;
  }

  async repair(options: Omit<EmbeddingRuntimeRunOptions, 'force'>): Promise<{ backupDir: string | null; pipeline: unknown }> {
    if (this.#operation) {
      try { await this.#operation; } catch { /* repair the failed generation below */ }
    }
    const cacheDir = resolve(options.cacheDir ?? '.agentis/models');
    let backupDir: string | null = null;
    if (existsSync(cacheDir)) {
      backupDir = `${cacheDir}-broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(cacheDir, backupDir);
    }
    mkdirSync(cacheDir, { recursive: true });
    this.reset(cacheDir);
    const pipeline = await this.run({ ...options, cacheDir, force: true });
    return { backupDir, pipeline };
  }

  reset(cacheDir?: string): void {
    this.#operation = null;
    this.#operationKey = null;
    this.#pipeline = null;
    this.#pipelineKey = null;
    this.#cacheDir = cacheDir ? resolve(cacheDir) : null;
    this.#snapshot = blankSnapshot(this.#manifest);
    this.#lastProgressStep.clear();
    if (this.#cacheDir) this.#persist();
  }

  async #run(options: EmbeddingRuntimeRunOptions & { cacheDir: string; dtype: string; key: string }): Promise<unknown> {
    const managed = options.model === this.#manifest.model
      && options.dtype === this.#manifest.dtype
      && !options.localModelPath;
    this.#set({
      status: managed ? 'verifying' : 'loading',
      model: options.model,
      revision: managed ? this.#manifest.revision : null,
      dtype: options.dtype,
      source: managed ? 'managed' : options.localModelPath ? 'custom' : 'legacy',
      startedAt: this.#snapshot.startedAt ?? now(),
      retryAt: null,
      errorCode: null,
      error: null,
      ...(managed ? {
        progress: 0,
        artifacts: this.#manifest.artifacts.map((artifact) => ({
          file: artifact.file,
          expectedBytes: artifact.bytes,
          downloadedBytes: 0,
          ready: false,
        })),
      } : {}),
    });

    let preparedGeneration: string | null = null;
    const previousGeneration = managed ? this.#readyGeneration(options.cacheDir) : null;
    try {
      let localFilesOnly = Boolean(options.offline || options.localModelPath);
      if (managed) {
        preparedGeneration = await this.#prepareManagedQ8(options.cacheDir, Boolean(options.offline));
        await this.#activateGeneration(options.cacheDir, preparedGeneration);
        localFilesOnly = true;
      }
      this.#set({ status: 'loading', progress: 100 });
      const pipeline = await options.load(localFilesOnly);
      this.#set({ readyAt: now(), retryAt: null, errorCode: null, error: null });
      this.#writeReadyManifest(options.cacheDir, preparedGeneration);
      this.#pipeline = pipeline;
      this.#pipelineKey = options.key;
      this.#set({ status: 'ready' });
      return pipeline;
    } catch (err) {
      const failedPhase = this.#snapshot.status;
      if (managed && previousGeneration) {
        try { await this.#activateGeneration(options.cacheDir, previousGeneration); } catch { /* preserve original failure */ }
      }
      const code = errorCode(err);
      this.#set({
        status: 'degraded',
        retryAt: new Date(Date.now() + RETRY_COOLDOWN_MS).toISOString(),
        errorCode: code,
        error: safeError(err),
      });
      throw Object.assign(new Error(
        `Embedding runtime unavailable during ${failedPhase}: ${safeError(err)}`,
      ), { code: 'EMBEDDING_MODEL_UNAVAILABLE', cause: err });
    }
  }

  async #prepareManagedQ8(cacheDir: string, offline: boolean): Promise<string> {
    await this.#quarantineStaleTemps(cacheDir);
    const manifest = this.#manifest;
    const generation = resolve(cacheDir, GENERATIONS_DIR, `${manifest.revision}-${manifest.dtype}`);
    const total = manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0);
    let completed = 0;
    for (const artifact of manifest.artifacts) {
      const finalPath = modelFile(generation, manifest.model, artifact.file);
      let valid = await this.#validArtifact(finalPath, artifact);
      if (!valid) {
        const legacyPath = modelFile(cacheDir, manifest.model, artifact.file);
        if (await this.#validArtifact(legacyPath, artifact)) {
          await mkdir(dirname(finalPath), { recursive: true });
          await copyFile(legacyPath, finalPath);
          valid = true;
        }
      }
      if (valid) {
        completed += artifact.bytes;
        this.#artifactProgress(artifact.file, artifact.bytes, true, completed, total);
        continue;
      }
      if (offline) throw new Error(`Offline cache miss for ${artifact.file}.`);
      await this.#downloadArtifact(cacheDir, generation, manifest, artifact, completed, total);
      completed += artifact.bytes;
      this.#artifactProgress(artifact.file, artifact.bytes, true, completed, total);
    }
    this.#set({ status: 'verifying', progress: 100 });
    return generation;
  }

  async #downloadArtifact(
    cacheDir: string,
    generation: string,
    manifest: ManagedEmbeddingManifest,
    artifact: ManagedEmbeddingArtifact,
    completedBefore: number,
    totalBytes: number,
  ): Promise<void> {
    this.#set({ status: 'downloading' });
    const staging = resolve(cacheDir, STAGING_DIR, `${manifest.revision}-${manifest.dtype}`, ...artifact.file.split('/'));
    const part = `${staging}.part`;
    await mkdir(dirname(part), { recursive: true });
    for (let attempt = 0; attempt < DOWNLOAD_RETRIES_MS.length; attempt += 1) {
      if (DOWNLOAD_RETRIES_MS[attempt]) await new Promise((resolveDelay) => setTimeout(resolveDelay, DOWNLOAD_RETRIES_MS[attempt]));
      try {
        let offset = 0;
        try { offset = Math.min((await stat(part)).size, artifact.bytes); } catch { /* new download */ }
        if (offset < artifact.bytes) {
          const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
          const response = await fetch(artifactUrl(manifest, artifact.file), { headers });
          if (!response.ok) throw Object.assign(new Error(`Download ${artifact.file} returned ${response.status}.`), { code: `HTTP_${response.status}` });
          const append = offset > 0 && response.status === 206;
          if (append) {
            const contentRange = response.headers.get('content-range');
            if (contentRange && !contentRange.startsWith(`bytes ${offset}-`)) {
              throw new Error(`Resume range mismatch for ${artifact.file}: requested ${offset}, received ${contentRange}.`);
            }
          } else {
            offset = 0;
          }
          if (!response.body) throw new Error(`Download ${artifact.file} returned an empty body.`);
          const output = createWriteStream(part, { flags: append ? 'a' : 'w' });
          const body = Readable.fromWeb(response.body as never);
          body.on('data', (chunk: Buffer) => {
            const downloaded = Math.min(artifact.bytes, offset + output.bytesWritten + chunk.length);
            this.#artifactProgress(artifact.file, downloaded, false, completedBefore + downloaded, totalBytes);
          });
          await streamPipeline(body, output);
        } else {
          this.#artifactProgress(artifact.file, artifact.bytes, false, completedBefore + artifact.bytes, totalBytes);
        }
        const actual = (await stat(part)).size;
        if (actual !== artifact.bytes) throw new Error(`Size mismatch for ${artifact.file}: expected ${artifact.bytes}, received ${actual}.`);
        this.#set({ status: 'verifying' });
        const digest = await hashFile(part);
        if (digest !== artifact.sha256) throw new Error(`Checksum mismatch for ${artifact.file}: expected ${artifact.sha256}, received ${digest}.`);
        await mkdir(dirname(staging), { recursive: true });
        await rename(part, staging).catch(async () => {
          await rm(staging, { force: true });
          await rename(part, staging);
        });
        const finalPath = modelFile(generation, manifest.model, artifact.file);
        await mkdir(dirname(finalPath), { recursive: true });
        if (existsSync(finalPath)) await rm(finalPath, { force: true });
        await rename(staging, finalPath);
        return;
      } catch (err) {
        if (attempt === DOWNLOAD_RETRIES_MS.length - 1) throw err;
        if (/checksum mismatch/i.test(safeError(err))) await rm(part, { force: true });
        this.#progressSink(`[embedding] ${artifact.file} download interrupted (${safeError(err)}); resuming.`);
      }
    }
  }

  async #validArtifact(path: string, artifact: ManagedEmbeddingArtifact): Promise<boolean> {
    try {
      const file = await stat(path);
      if (file.size !== artifact.bytes) return false;
      return (await hashFile(path)) === artifact.sha256;
    } catch {
      return false;
    }
  }

  async #quarantineStaleTemps(cacheDir: string): Promise<void> {
    if (!existsSync(cacheDir)) return;
    const candidates: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (!isInside(cacheDir, path)) continue;
        if (entry.isDirectory()) {
          if (entry.name !== QUARANTINE_DIR && entry.name !== STAGING_DIR) walk(path);
        } else if (/\.tmp\.[^.]+\.[^.]+$/i.test(entry.name)) {
          candidates.push(path);
        }
      }
    };
    walk(cacheDir);
    for (const candidate of candidates) await this.#quarantine(cacheDir, candidate);
  }

  async #quarantine(cacheDir: string, path: string): Promise<void> {
    const target = resolve(cacheDir, QUARANTINE_DIR, new Date().toISOString().slice(0, 10), relative(cacheDir, path));
    if (!isInside(cacheDir, target)) throw new Error(`Unsafe embedding quarantine target: ${target}`);
    await mkdir(dirname(target), { recursive: true });
    await rename(path, target).catch(async () => {
      const unique = `${target}.${Date.now()}`;
      await rename(path, unique);
    });
  }

  async #activateGeneration(cacheDir: string, generation: string): Promise<void> {
    if (!isInside(resolve(cacheDir, GENERATIONS_DIR), generation)) {
      throw new Error(`Unsafe embedding generation path: ${generation}`);
    }
    for (const artifact of this.#manifest.artifacts) {
      const source = modelFile(generation, this.#manifest.model, artifact.file);
      if (!await this.#validArtifact(source, artifact)) {
        throw new Error(`Generation artifact failed verification: ${artifact.file}.`);
      }
      const target = modelFile(cacheDir, this.#manifest.model, artifact.file);
      if (await this.#validArtifact(target, artifact)) continue;
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.agentis-promote.${process.pid}`;
      await copyFile(source, temp);
      if (existsSync(target)) await this.#quarantine(cacheDir, target);
      await rename(temp, target);
    }
  }

  #artifactProgress(file: string, downloadedBytes: number, ready: boolean, aggregate: number, total: number): void {
    const artifacts = this.#snapshot.artifacts.map((item) => item.file === file
      ? { ...item, downloadedBytes, ready }
      : item);
    const progress = total > 0 ? Math.min(100, Math.round((aggregate / total) * 100)) : 0;
    this.#set({ artifacts, progress });
    if (!ready && downloadedBytes > 0) {
      const artifact = artifacts.find((item) => item.file === file);
      const percent = Math.min(100, Math.round((downloadedBytes / (artifact?.expectedBytes ?? 1)) * 100));
      const step = Math.floor(percent / 25) * 25;
      if (step > (this.#lastProgressStep.get(file) ?? -1)) {
        this.#lastProgressStep.set(file, step);
        this.#progressSink(`[embedding] downloading ${file}: ${percent}%`);
      }
    }
  }

  #writeReadyManifest(cacheDir: string, generation: string | null): void {
    const payload = {
      version: 1,
      model: this.#snapshot.model,
      revision: this.#snapshot.revision,
      dtype: this.#snapshot.dtype,
      verifiedAt: this.#snapshot.readyAt,
      generation: generation ? relative(cacheDir, generation).split(sep).join('/') : null,
      artifacts: this.#snapshot.artifacts,
    };
    this.#writeJsonAtomic(resolve(cacheDir, READY_FILE), payload);
  }

  #readyGeneration(cacheDir: string): string | null {
    try {
      const ready = JSON.parse(readFileSync(resolve(cacheDir, READY_FILE), 'utf8')) as { generation?: unknown };
      if (typeof ready.generation !== 'string' || !ready.generation) return null;
      const generation = resolve(cacheDir, ...ready.generation.split('/'));
      return isInside(resolve(cacheDir, GENERATIONS_DIR), generation) ? generation : null;
    } catch {
      return null;
    }
  }

  #bindCache(cacheDir: string): void {
    const resolved = resolve(cacheDir);
    if (this.#cacheDir === resolved) return;
    this.#cacheDir = resolved;
    this.#snapshot = blankSnapshot(this.#manifest);
    try {
      const parsed = JSON.parse(readFileSync(resolve(resolved, STATE_FILE), 'utf8')) as EmbeddingRuntimeSnapshot;
      this.#snapshot = { ...blankSnapshot(this.#manifest), ...parsed, status: parsed.status === 'ready' ? 'uninitialized' : parsed.status };
    } catch {
      // Fresh or legacy cache. Artifact adoption happens during prepare.
    }
  }

  #set(patch: Partial<EmbeddingRuntimeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch, updatedAt: now() };
    this.#persist();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #persist(): void {
    if (!this.#cacheDir) return;
    mkdirSync(this.#cacheDir, { recursive: true });
    this.#writeJsonAtomic(resolve(this.#cacheDir, STATE_FILE), this.#snapshot);
  }

  #writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}`;
    const previous = `${path}.previous.${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    let preservedPrevious = false;
    try {
      rmSync(previous, { force: true });
      if (existsSync(path)) {
        renameSync(path, previous);
        preservedPrevious = true;
      }
      renameSync(temp, path);
      if (preservedPrevious) rmSync(previous, { force: true });
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      if (preservedPrevious && !existsSync(path) && existsSync(previous)) {
        try { renameSync(previous, path); } catch { /* best effort */ }
      }
      throw new Error(`Unable to persist embedding runtime state at ${path}.`);
    }
  }
}

export const embeddingRuntimeManager = new EmbeddingRuntimeManager();

export function embeddingRuntimeState(cacheDir?: string): EmbeddingRuntimeSnapshot {
  return embeddingRuntimeManager.snapshot(cacheDir);
}
