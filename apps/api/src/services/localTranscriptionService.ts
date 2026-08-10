/**
 * Zero-configuration inbound speech recognition.
 *
 * Channel media comprehension is an input concern, not media generation. A
 * workspace therefore gets a managed local Whisper fallback by default. The
 * model is downloaded once into Agentis' data directory and reused; a remotely
 * configured transcription profile may still take precedence.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import type { TranscriptionInput } from './transcriptionService.js';
import {
  DEFAULT_TRANSCRIPTION_MANIFEST,
  transcriptionRuntimeManager,
  transcriptionRuntimeState,
  type TranscriptionRuntimeSnapshot,
} from './transcriptionRuntimeManager.js';

const DEFAULT_MODEL = DEFAULT_TRANSCRIPTION_MANIFEST.model;
const SAMPLE_RATE = 16_000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_PCM_BYTES = SAMPLE_RATE * 4 * 60 * 20; // 20 minutes, mono float32.

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | Array<{ text?: string }>>;

export interface LocalTranscriptionServiceDeps {
  dataDir: string;
  logger?: Logger;
  model?: string;
  ffmpegPath?: string;
  loadPipeline?: () => Promise<AsrPipeline>;
  decodeAudio?: (bytes: Buffer) => Promise<Float32Array>;
}

export class LocalTranscriptionService {
  readonly model: string;
  readonly #cacheDir: string;
  #pipelinePromise: Promise<AsrPipeline> | undefined;
  #transcriptionTail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  constructor(private readonly deps: LocalTranscriptionServiceDeps) {
    this.model = deps.model?.trim() || process.env.AGENTIS_LOCAL_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL;
    this.#cacheDir = transcriptionCacheDir(deps.dataDir);
    transcriptionRuntimeManager.setProgressSink((message) => deps.logger?.info?.('transcription.model_download', { message }));
  }

  /** Explicit/channel-scoped preparation. `agentis up` never calls this globally. */
  async warmup(options: { repair?: boolean } = {}): Promise<{ backupDir: string | null }> {
    if (this.deps.loadPipeline) {
      await this.#pipeline();
      return { backupDir: null };
    }
    if (options.repair) {
      this.#pipelinePromise = undefined;
      const result = await transcriptionRuntimeManager.repair(this.#runtimeOptions());
      this.#pipelinePromise = Promise.resolve(result.pipeline as AsrPipeline);
      return { backupDir: result.backupDir };
    }
    await this.#pipeline();
    return { backupDir: null };
  }

  /** Acquire verified model files without loading ONNX; safe beside normal boot. */
  async prepare(): Promise<void> {
    if (this.deps.loadPipeline) return;
    await transcriptionRuntimeManager.prepare({
      model: this.model,
      cacheDir: this.#cacheDir,
      localModelPath: process.env.AGENTIS_TRANSCRIPTION_MODEL_PATH?.trim(),
      offline: transcriptionOfflineOnly(),
    });
  }

  runtimeState(): TranscriptionRuntimeSnapshot { return transcriptionRuntimeState(this.#cacheDir); }

  async transcribe(input: TranscriptionInput): Promise<string | null> {
    if (!input.bytes.length || input.bytes.length > MAX_AUDIO_BYTES) return null;
    if (this.#pending >= 8) {
      this.deps.logger?.warn?.('transcription.local_queue_full', { pending: this.#pending });
      return null;
    }
    this.#pending += 1;
    const operation = this.#transcriptionTail.then(() => this.#transcribeOne(input));
    this.#transcriptionTail = operation.catch(() => null);
    try {
      return await operation;
    } finally {
      this.#pending -= 1;
    }
  }

  async #transcribeOne(input: TranscriptionInput): Promise<string | null> {
    try {
      const [pipeline, audio] = await Promise.all([
        this.#pipeline(),
        this.deps.decodeAudio?.(input.bytes) ?? decodeAudioPortable(
          input.bytes,
          this.deps.ffmpegPath ?? (process.env.AGENTIS_FFMPEG_PATH?.trim() || 'ffmpeg'),
        ),
      ]);
      if (!audio.length) return null;
      const language = transcriptionLanguage();
      const output = await pipeline(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language,
        task: 'transcribe',
      });
      const item = Array.isArray(output) ? output[0] : output;
      const text = item?.text?.trim();
      if (text && !isPlausibleTranscript(text, audio.length)) {
        this.deps.logger?.warn?.('transcription.local_rejected_implausible', {
          model: this.model,
          characters: text.length,
          audioSamples: audio.length,
        });
        return null;
      }
      return text || null;
    } catch (error) {
      this.deps.logger?.warn?.('transcription.local_failed', {
        model: this.model,
        error: (error as Error).message,
      });
      return null;
    }
  }

  #pipeline(): Promise<AsrPipeline> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = (this.deps.loadPipeline?.() ?? transcriptionRuntimeManager.run(this.#runtimeOptions()) as Promise<AsrPipeline>).catch((error) => {
        this.#pipelinePromise = undefined; // a transient download/load failure may recover later
        throw error;
      });
    }
    return this.#pipelinePromise;
  }

  #runtimeOptions() {
    return {
      model: this.model,
      cacheDir: this.#cacheDir,
      localModelPath: process.env.AGENTIS_TRANSCRIPTION_MODEL_PATH?.trim(),
      offline: transcriptionOfflineOnly(),
      load: ({ model, cacheDir, localFilesOnly }: { model: string; cacheDir: string; localFilesOnly: boolean }) => this.#loadPipeline(model, cacheDir, localFilesOnly),
    };
  }

  async #loadPipeline(model: string, cacheDir: string, localFilesOnly: boolean): Promise<AsrPipeline> {
    await mkdir(cacheDir, { recursive: true });
    const mod = await import('@huggingface/transformers');
    mod.env.cacheDir = cacheDir;
    mod.env.allowRemoteModels = !localFilesOnly;
    mod.env.allowLocalModels = true;
    this.deps.logger?.info?.('transcription.local_model_loading', {
      model,
      cacheDir,
      localFilesOnly,
    });
    const loaded = await mod.pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'cpu',
      local_files_only: localFilesOnly,
    });
    this.deps.logger?.info?.('transcription.local_model_ready', { model });
    return loaded as unknown as AsrPipeline;
  }
}

export function transcriptionCacheDir(dataDir?: string): string {
  const configured = process.env.AGENTIS_TRANSCRIPTION_CACHE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const root = dataDir?.trim() || process.env.AGENTIS_DATA_DIR?.trim() || '.agentis';
  return path.resolve(root, 'models', 'transcription');
}

export function transcriptionOfflineOnly(): boolean {
  return String(process.env.AGENTIS_TRANSCRIPTION_OFFLINE ?? '').toLowerCase() === 'true';
}

export async function warmLocalTranscriptionModel(options: {
  dataDir?: string;
  repair?: boolean;
  logger?: Logger;
} = {}): Promise<{ backupDir: string | null }> {
  const dataDir = options.dataDir?.trim() || process.env.AGENTIS_DATA_DIR?.trim() || '.agentis';
  return new LocalTranscriptionService({ dataDir, logger: options.logger }).warmup({ repair: options.repair });
}

function transcriptionLanguage(): string {
  const configured = process.env.AGENTIS_TRANSCRIPTION_LANGUAGE?.trim();
  if (configured) return configured;
  // Transformers.js 4.2 does not implement Whisper language detection and
  // silently defaults to English. Use the host language as the deterministic
  // zero-config hint; multilingual deployments can set the explicit override.
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  const language = locale.split('-', 1)[0] || 'en';
  return language === 'pt' ? 'portuguese'
    : language === 'es' ? 'spanish'
      : language === 'fr' ? 'french'
        : language === 'de' ? 'german'
          : language === 'it' ? 'italian'
            : language === 'ja' ? 'japanese'
              : language === 'zh' ? 'chinese'
                : 'english';
}

/**
 * Decode common channel audio in portable WASM/JS first. A system FFmpeg is an
 * optional compatibility fallback for containers the small OSS decoder set does
 * not support; npm users do not need FFmpeg for WhatsApp Ogg/Opus voice notes.
 */
export async function decodeAudioPortable(bytes: Buffer, ffmpegPath = 'ffmpeg'): Promise<Float32Array> {
  try {
    const { default: decode } = await import('@audio/decode');
    const audio = await decode(new Uint8Array(bytes)) as unknown as {
      sampleRate: number;
      channelData?: Float32Array[];
      length?: number;
      numberOfChannels?: number;
      getChannelData?(channel: number): Float32Array;
    };
    const channels = Array.isArray(audio.channelData)
      ? audio.channelData
      : typeof audio.getChannelData === 'function' && Number.isInteger(audio.numberOfChannels)
        ? Array.from({ length: audio.numberOfChannels! }, (_, channel) => audio.getChannelData!(channel))
        : [];
    const sampleCount = channels[0]?.length ?? 0;
    if (
      !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || sampleCount <= 0 ||
      channels.length <= 0 || channels.some((channel) => channel.length !== sampleCount)
    ) {
      throw new Error('portable decoder returned invalid audio');
    }
    const durationSeconds = sampleCount / audio.sampleRate;
    if (durationSeconds > 20 * 60) throw new Error('decoded audio exceeds the 20-minute safety limit');
    const mono = new Float32Array(sampleCount);
    for (const data of channels) {
      for (let index = 0; index < mono.length; index += 1) {
        mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / channels.length;
      }
    }
    return audio.sampleRate === SAMPLE_RATE ? mono : resampleLinear(mono, audio.sampleRate, SAMPLE_RATE);
  } catch (portableError) {
    try {
      return await decodeWithFfmpeg(bytes, ffmpegPath);
    } catch (ffmpegError) {
      throw new Error(
        `Portable audio decoding failed (${(portableError as Error).message}); ` +
        `FFmpeg fallback failed (${(ffmpegError as Error).message}).`,
      );
    }
  }
}

/** Reject impossible/pathologically repetitive decoder output before it enters conversation memory. */
function isPlausibleTranscript(text: string, sampleCount: number): boolean {
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const durationSeconds = sampleCount / SAMPLE_RATE;
  // Even very fast speech stays far below this; a 2 s voice note cannot contain thousands of characters.
  if (normalized.length > Math.max(160, Math.ceil(durationSeconds * 35))) return false;
  const words = normalized.split(' ');
  if (words.length < 12) return true;
  const trigrams = new Map<string, number>();
  for (let index = 0; index <= words.length - 3; index += 1) {
    const gram = words.slice(index, index + 3).join(' ');
    trigrams.set(gram, (trigrams.get(gram) ?? 0) + 1);
  }
  return Math.max(...trigrams.values()) / Math.max(1, words.length - 2) < 0.45;
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  if (outputLength * 4 > MAX_PCM_BYTES) throw new Error('resampled audio exceeds the 20-minute safety limit');
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

export async function decodeWithFfmpeg(bytes: Buffer, ffmpegPath = 'ffmpeg'): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('local audio decode timed out'));
    }, 90_000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES) {
        if (!settled) {
          settled = true;
          child.kill();
          clearTimeout(timer);
          reject(new Error('decoded audio exceeds the 20-minute safety limit'));
        }
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((total, item) => total + item.length, 0) < 16_384) errors.push(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg is unavailable for local transcription: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg audio decode failed (${code}): ${Buffer.concat(errors).toString('utf8').trim().slice(0, 500)}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const aligned = pcm.subarray(0, pcm.length - (pcm.length % 4));
      const copied = new Uint8Array(aligned.length);
      copied.set(aligned);
      resolve(new Float32Array(copied.buffer));
    });
    child.stdin.on('error', () => {}); // close/error is authoritative
    child.stdin.end(bytes);
  });
}
