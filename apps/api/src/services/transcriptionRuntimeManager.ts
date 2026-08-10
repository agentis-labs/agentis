import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

export type TranscriptionRuntimeStatus = 'uninitialized' | 'downloading' | 'verifying' | 'prepared' | 'loading' | 'ready' | 'degraded';

export interface ManagedTranscriptionArtifact {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ManagedTranscriptionManifest {
  model: string;
  revision: string;
  dtype: 'q8';
  license: 'Apache-2.0';
  sourceUrl: string;
  artifacts: ManagedTranscriptionArtifact[];
}

export interface TranscriptionRuntimeSnapshot {
  status: TranscriptionRuntimeStatus;
  model: string;
  revision: string | null;
  dtype: string;
  source: 'managed' | 'custom';
  progress: number;
  artifacts: Array<ManagedTranscriptionArtifact & { downloadedBytes: number; ready: boolean }>;
  startedAt: string | null;
  updatedAt: string;
  readyAt: string | null;
  retryAt: string | null;
  errorCode: string | null;
  error: string | null;
}

export interface TranscriptionRuntimeRunOptions {
  cacheDir: string;
  model?: string;
  localModelPath?: string;
  offline?: boolean;
  force?: boolean;
  load: (options: { model: string; cacheDir: string; localFilesOnly: boolean }) => Promise<unknown>;
}

export interface TranscriptionRuntimePrepareOptions {
  cacheDir: string;
  model?: string;
  localModelPath?: string;
  offline?: boolean;
  force?: boolean;
}

/** Immutable files used by Transformers.js for `automatic-speech-recognition`. */
export const DEFAULT_TRANSCRIPTION_MANIFEST: ManagedTranscriptionManifest = {
  model: 'Xenova/whisper-base',
  revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
  dtype: 'q8',
  license: 'Apache-2.0',
  sourceUrl: 'https://huggingface.co/Xenova/whisper-base',
  artifacts: [
    { file: 'config.json', bytes: 2_248, sha256: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b' },
    { file: 'generation_config.json', bytes: 3_776, sha256: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05' },
    { file: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
    { file: 'tokenizer.json', bytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { file: 'tokenizer_config.json', bytes: 282_683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
    { file: 'onnx/decoder_model_merged_quantized.onnx', bytes: 53_707_539, sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861' },
    { file: 'onnx/encoder_model_quantized.onnx', bytes: 23_200_850, sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9' },
  ],
};

const STATE_FILE = 'transcription-runtime.json';
const READY_FILE = 'READY.json';
const GENERATIONS_DIR = '.agentis-generations';
const STAGING_DIR = '.agentis-staging';
const QUARANTINE_DIR = 'quarantine';
const RETRIES_MS = [0, 1_000, 3_000];
const COOLDOWN_MS = 60_000;

function now(): string { return new Date().toISOString(); }

function blank(manifest: ManagedTranscriptionManifest): TranscriptionRuntimeSnapshot {
  return {
    status: 'uninitialized', model: manifest.model, revision: manifest.revision, dtype: manifest.dtype,
    source: 'managed', progress: 0,
    artifacts: manifest.artifacts.map((item) => ({ ...item, downloadedBytes: 0, ready: false })),
    startedAt: null, updatedAt: now(), readyAt: null, retryAt: null, errorCode: null, error: null,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 2_000);
}

function runtimeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code) return code;
  const message = safeError(error);
  if (/checksum/i.test(message)) return 'TRANSCRIPTION_CHECKSUM_MISMATCH';
  if (/size mismatch/i.test(message)) return 'TRANSCRIPTION_SIZE_MISMATCH';
  if (/offline/i.test(message)) return 'TRANSCRIPTION_OFFLINE_CACHE_MISS';
  return 'TRANSCRIPTION_RUNTIME_UNAVAILABLE';
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

function modelFile(root: string, model: string, file: string): string {
  return resolve(root, ...model.split('/'), ...file.split('/'));
}

function artifactUrl(manifest: ManagedTranscriptionManifest, file: string): string {
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${encoded}`;
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export class TranscriptionRuntimeManager {
  readonly #manifest: ManagedTranscriptionManifest;
  #snapshot: TranscriptionRuntimeSnapshot;
  #cacheDir: string | null = null;
  #operation: Promise<unknown> | null = null;
  #pipeline: unknown | null = null;
  #pipelineKey: string | null = null;
  #progressSink: (message: string) => void = (message) => process.stdout.write(`${message}\n`);
  #progressSteps = new Map<string, number>();

  constructor(manifest: ManagedTranscriptionManifest = DEFAULT_TRANSCRIPTION_MANIFEST) {
    this.#manifest = manifest;
    this.#snapshot = blank(manifest);
  }

  setProgressSink(sink: (message: string) => void): void { this.#progressSink = sink; }

  snapshot(cacheDir?: string): TranscriptionRuntimeSnapshot {
    if (cacheDir) this.#bindCache(cacheDir);
    return structuredClone(this.#snapshot);
  }

  async run(options: TranscriptionRuntimeRunOptions): Promise<unknown> {
    const cacheDir = resolve(options.cacheDir);
    this.#bindCache(cacheDir);
    const model = options.model?.trim() || this.#manifest.model;
    const key = `${model}@q8:${options.localModelPath ?? cacheDir}`;
    if (!options.force && this.#snapshot.status === 'ready' && this.#pipeline && this.#pipelineKey === key) return this.#pipeline;
    if (this.#operation) {
      try { await this.#operation; } catch { /* this run gets its own attempt/cooldown result */ }
      return this.run(options);
    }
    const retryAt = this.#snapshot.retryAt ? Date.parse(this.#snapshot.retryAt) : 0;
    if (!options.force && this.#snapshot.status === 'degraded' && retryAt > Date.now()) {
      throw Object.assign(new Error(`Transcription runtime is cooling down; retry in ${Math.ceil((retryAt - Date.now()) / 1_000)}s.`), { code: 'TRANSCRIPTION_MODEL_UNAVAILABLE' });
    }
    this.#operation = this.#run({ ...options, cacheDir, model, key }).finally(() => { this.#operation = null; });
    return this.#operation;
  }

  /** Download and verify managed bytes without loading ONNX into memory. */
  async prepare(options: TranscriptionRuntimePrepareOptions): Promise<void> {
    const cacheDir = resolve(options.cacheDir);
    this.#bindCache(cacheDir);
    const model = options.model?.trim() || this.#manifest.model;
    if (options.localModelPath) {
      this.#set({
        status: 'prepared', model: options.localModelPath, revision: null, source: 'custom',
        progress: 100, readyAt: now(), retryAt: null, errorCode: null, error: null,
      });
      return;
    }
    if (model !== this.#manifest.model) return; // non-managed models remain lazy/provider-owned
    if (!options.force && (this.#snapshot.status === 'prepared' || this.#snapshot.status === 'ready')
      && this.#snapshot.artifacts.every((artifact) => artifact.ready)) return;
    if (this.#operation) {
      await this.#operation;
      return;
    }
    this.#operation = (async () => {
      this.#set({
        status: 'verifying', model, revision: this.#manifest.revision, source: 'managed',
        startedAt: this.#snapshot.startedAt ?? now(), retryAt: null, errorCode: null, error: null,
      });
      try {
        await this.#prepareManaged(cacheDir, Boolean(options.offline));
        this.#set({ status: 'prepared', readyAt: now(), retryAt: null, errorCode: null, error: null });
        this.#writeReady(cacheDir);
      } catch (error) {
        this.#set({
          status: 'degraded', retryAt: new Date(Date.now() + COOLDOWN_MS).toISOString(),
          errorCode: runtimeErrorCode(error), error: safeError(error),
        });
        throw Object.assign(new Error(`Transcription runtime preparation failed: ${safeError(error)}`), {
          code: 'TRANSCRIPTION_MODEL_UNAVAILABLE', cause: error,
        });
      }
    })().finally(() => { this.#operation = null; });
    await this.#operation;
  }

  async repair(options: Omit<TranscriptionRuntimeRunOptions, 'force'>): Promise<{ backupDir: string | null; pipeline: unknown }> {
    if (this.#operation) try { await this.#operation; } catch { /* repair below */ }
    const cacheDir = resolve(options.cacheDir);
    let backupDir: string | null = null;
    if (existsSync(cacheDir)) {
      backupDir = `${cacheDir}-broken-${now().replace(/[:.]/g, '-')}`;
      renameSync(cacheDir, backupDir);
    }
    mkdirSync(cacheDir, { recursive: true });
    this.#pipeline = null;
    this.#pipelineKey = null;
    this.#cacheDir = null;
    this.#bindCache(cacheDir);
    const pipeline = await this.run({ ...options, cacheDir, force: true });
    return { backupDir, pipeline };
  }

  async #run(options: TranscriptionRuntimeRunOptions & { cacheDir: string; model: string; key: string }): Promise<unknown> {
    const managed = options.model === this.#manifest.model && !options.localModelPath;
    this.#set({
      status: managed ? 'verifying' : 'loading', model: options.model,
      revision: managed ? this.#manifest.revision : null, source: managed ? 'managed' : 'custom',
      startedAt: this.#snapshot.startedAt ?? now(), retryAt: null, errorCode: null, error: null,
    });
    try {
      if (managed) await this.#prepareManaged(options.cacheDir, Boolean(options.offline));
      this.#set({ status: 'loading', progress: 100 });
      const pipeline = await options.load({
        model: options.localModelPath || options.model,
        cacheDir: options.cacheDir,
        localFilesOnly: managed || Boolean(options.offline || options.localModelPath),
      });
      this.#pipeline = pipeline;
      this.#pipelineKey = options.key;
      this.#set({ status: 'ready', readyAt: now(), retryAt: null, errorCode: null, error: null });
      this.#writeReady(options.cacheDir);
      return pipeline;
    } catch (error) {
      this.#set({
        status: 'degraded', retryAt: new Date(Date.now() + COOLDOWN_MS).toISOString(),
        errorCode: runtimeErrorCode(error), error: safeError(error),
      });
      throw Object.assign(new Error(`Transcription runtime unavailable: ${safeError(error)}`), {
        code: 'TRANSCRIPTION_MODEL_UNAVAILABLE', cause: error,
      });
    }
  }

  async #prepareManaged(cacheDir: string, offline: boolean): Promise<void> {
    const generation = resolve(cacheDir, GENERATIONS_DIR, `${this.#manifest.revision}-${this.#manifest.dtype}`);
    const total = this.#manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0);
    let completed = 0;
    for (const artifact of this.#manifest.artifacts) {
      const generated = modelFile(generation, this.#manifest.model, artifact.file);
      let valid = await this.#valid(generated, artifact);
      if (!valid) {
        const adopted = modelFile(cacheDir, this.#manifest.model, artifact.file);
        if (await this.#valid(adopted, artifact)) {
          await mkdir(dirname(generated), { recursive: true });
          await copyFile(adopted, generated);
          valid = true;
        }
      }
      if (!valid) {
        if (offline) throw new Error(`Offline cache miss for ${artifact.file}.`);
        await this.#download(cacheDir, generation, artifact, completed, total);
      }
      completed += artifact.bytes;
      this.#artifactProgress(artifact, artifact.bytes, true, completed, total);
    }
    this.#set({ status: 'verifying', progress: 100 });
    await this.#activate(cacheDir, generation);
  }

  async #download(cacheDir: string, generation: string, artifact: ManagedTranscriptionArtifact, completed: number, total: number): Promise<void> {
    this.#set({ status: 'downloading' });
    const part = resolve(cacheDir, STAGING_DIR, `${this.#manifest.revision}-${this.#manifest.dtype}`, `${artifact.file}.part`);
    await mkdir(dirname(part), { recursive: true });
    for (let attempt = 0; attempt < RETRIES_MS.length; attempt += 1) {
      if (RETRIES_MS[attempt]) await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRIES_MS[attempt]));
      try {
        let offset = 0;
        try { offset = Math.min((await stat(part)).size, artifact.bytes); } catch { /* fresh */ }
        if (offset < artifact.bytes) {
          const response = await fetch(artifactUrl(this.#manifest, artifact.file), { headers: offset ? { range: `bytes=${offset}-` } : {} });
          if (!response.ok || !response.body) throw new Error(`Download ${artifact.file} returned ${response.status}.`);
          const append = offset > 0 && response.status === 206;
          if (append) {
            const contentRange = response.headers.get('content-range');
            if (contentRange && !contentRange.startsWith(`bytes ${offset}-`)) {
              throw new Error(`Resume range mismatch for ${artifact.file}: requested ${offset}, received ${contentRange}.`);
            }
          }
          if (!append) offset = 0;
          const output = createWriteStream(part, { flags: append ? 'a' : 'w' });
          const body = Readable.fromWeb(response.body as never);
          body.on('data', (chunk: Buffer) => this.#artifactProgress(artifact, Math.min(artifact.bytes, offset + output.bytesWritten + chunk.length), false, completed + offset + output.bytesWritten + chunk.length, total));
          await streamPipeline(body, output);
        }
        const size = (await stat(part)).size;
        if (size !== artifact.bytes) throw new Error(`Size mismatch for ${artifact.file}: expected ${artifact.bytes}, received ${size}.`);
        this.#set({ status: 'verifying' });
        const digest = await hashFile(part);
        if (digest !== artifact.sha256) throw new Error(`Checksum mismatch for ${artifact.file}: expected ${artifact.sha256}, received ${digest}.`);
        const target = modelFile(generation, this.#manifest.model, artifact.file);
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true });
        await rename(part, target);
        return;
      } catch (error) {
        if (attempt === RETRIES_MS.length - 1) throw error;
        if (/checksum mismatch/i.test(safeError(error))) await rm(part, { force: true });
        this.#progressSink(`[transcription] ${artifact.file} interrupted (${safeError(error)}); resuming.`);
      }
    }
  }

  async #activate(cacheDir: string, generation: string): Promise<void> {
    if (!isInside(resolve(cacheDir, GENERATIONS_DIR), generation)) throw new Error(`Unsafe transcription generation path: ${generation}`);
    for (const artifact of this.#manifest.artifacts) {
      const source = modelFile(generation, this.#manifest.model, artifact.file);
      if (!await this.#valid(source, artifact)) throw new Error(`Generation artifact failed verification: ${artifact.file}.`);
      const target = modelFile(cacheDir, this.#manifest.model, artifact.file);
      if (await this.#valid(target, artifact)) continue;
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.agentis-promote.${process.pid}`;
      await copyFile(source, temp);
      if (existsSync(target)) {
        const quarantine = resolve(cacheDir, QUARANTINE_DIR, new Date().toISOString().slice(0, 10), relative(cacheDir, target));
        if (!isInside(cacheDir, quarantine)) throw new Error(`Unsafe transcription quarantine path: ${quarantine}`);
        await mkdir(dirname(quarantine), { recursive: true });
        await rename(target, `${quarantine}.${Date.now()}`);
      }
      await rename(temp, target);
    }
  }

  async #valid(file: string, artifact: ManagedTranscriptionArtifact): Promise<boolean> {
    try { return (await stat(file)).size === artifact.bytes && await hashFile(file) === artifact.sha256; } catch { return false; }
  }

  #artifactProgress(artifact: ManagedTranscriptionArtifact, downloadedBytes: number, ready: boolean, aggregate: number, total: number): void {
    const artifacts = this.#snapshot.artifacts.map((item) => item.file === artifact.file ? { ...item, downloadedBytes, ready } : item);
    const progress = Math.min(100, Math.round((aggregate / Math.max(1, total)) * 100));
    this.#set({ artifacts, progress });
    if (!ready && downloadedBytes > 0) {
      const step = Math.floor((downloadedBytes / artifact.bytes) * 4) * 25;
      if (step > (this.#progressSteps.get(artifact.file) ?? -1)) {
        this.#progressSteps.set(artifact.file, step);
        this.#progressSink(`[transcription] downloading ${artifact.file}: ${Math.min(100, step)}%`);
      }
    }
  }

  #bindCache(cacheDir: string): void {
    const target = resolve(cacheDir);
    if (this.#cacheDir === target) return;
    this.#cacheDir = target;
    this.#snapshot = blank(this.#manifest);
    try {
      const persisted = JSON.parse(readFileSync(resolve(target, STATE_FILE), 'utf8')) as TranscriptionRuntimeSnapshot;
      this.#snapshot = { ...blank(this.#manifest), ...persisted, status: persisted.status === 'ready' ? 'prepared' : persisted.status };
    } catch { /* fresh cache */ }
  }

  #set(patch: Partial<TranscriptionRuntimeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch, updatedAt: now() };
    if (!this.#cacheDir) return;
    mkdirSync(this.#cacheDir, { recursive: true });
    this.#writeJson(resolve(this.#cacheDir, STATE_FILE), this.#snapshot);
  }

  #writeReady(cacheDir: string): void {
    this.#writeJson(resolve(cacheDir, READY_FILE), {
      version: 1, model: this.#snapshot.model, revision: this.#snapshot.revision,
      dtype: this.#snapshot.dtype, license: this.#manifest.license, sourceUrl: this.#manifest.sourceUrl,
      verifiedAt: this.#snapshot.readyAt, artifacts: this.#snapshot.artifacts,
    });
  }

  #writeJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp.${process.pid}`;
    const previous = `${file}.previous.${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    let preserved = false;
    try {
      rmSync(previous, { force: true });
      if (existsSync(file)) {
        renameSync(file, previous);
        preserved = true;
      }
      renameSync(temp, file);
      if (preserved) rmSync(previous, { force: true });
    } catch (error) {
      rmSync(temp, { force: true });
      if (preserved && !existsSync(file) && existsSync(previous)) {
        try { renameSync(previous, file); } catch { /* retain the original error */ }
      }
      throw error;
    }
  }
}

export const transcriptionRuntimeManager = new TranscriptionRuntimeManager();

export function transcriptionRuntimeState(cacheDir: string): TranscriptionRuntimeSnapshot {
  return transcriptionRuntimeManager.snapshot(cacheDir);
}
