/**
 * EmbeddingProvider — pluggable, real-semantic embedding generation for vector
 * retrieval. Every memory/knowledge write is embedded with the workspace's
 * configured provider so writes and queries live in the same vector space.
 *
 * Providers:
 *   - `LocalEmbeddingProvider` — self-hosted, free, multilingual ONNX
 *     (`multilingual-e5-small`, 384-dim). The zero-config DEFAULT.
 *     NOT bundled: the ~450 MB weights are downloaded once on first use and
 *     cached under `<data-dir>/models`. Inference is local (no data egress), but
 *     the FIRST run needs network unless the cache is pre-populated — see
 *     `AGENTIS_EMBEDDING_MODEL_PATH` / `AGENTIS_EMBEDDING_OFFLINE`.
 *   - `OpenAIEmbeddingProvider` — opt-in API embeddings (or any OpenAI-compatible
 *     endpoint, incl. a self-hosted local embedding server).
 *
 * There is no non-semantic / lexical provider: a misconfigured provider fails
 * loud rather than silently degrading recall to keyword matching. (Tests inject
 * a deterministic stub — see `tests/_helpers/stubEmbeddingProvider.ts`.)
 */

import { resolve } from 'node:path';

// ────────────────────────────────────────────────────────────
// Interface
// ────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Output dimension (all vectors must have exactly this length). */
  readonly dimension: number;
  /**
   * Stable identity of the model that produces these vectors. Stamped onto every
   * row at write time (Brain 10x §B1.2) so retrieval can compare (model,dims)
   * instead of length alone — a 512-dim hash vector and a 512-dim truncated
   * semantic vector must never be treated as comparable.
   * Examples: `hashing-v1-512`, `openai:text-embedding-3-small`.
   */
  readonly modelId: string;
  /**
   * Embed `text` and return a float[] of length `dimension`.
   *
   * The returned vector MUST be L2-normalised so that cosine similarity
   * reduces to a dot product (the fast path in `KnowledgeStore.search()`).
   * If your provider returns un-normalised embeddings, wrap it:
   *
   *   embed: async (text) => l2Normalize(await rawEmbed(text))
   */
  embed(text: string): number[] | Promise<number[]>;
}

// ────────────────────────────────────────────────────────────
// Built-in: HashingEmbeddingProvider
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Math helpers (exported for use by KnowledgeStore and tests)
// ────────────────────────────────────────────────────────────

/**
 * Dot product of two equal-length vectors.
 *
 * When both vectors are L2-normalised this equals cosine similarity. Clamps
 * to [-1, 1] to absorb floating-point rounding errors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(-1, Math.min(1, dot));
}

/**
 * L2-normalise a float array in place. Returns the same array.
 * Exported for providers that return raw (un-normalised) embeddings.
 */
export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

// ────────────────────────────────────────────────────────────
// Real semantic providers — Brain & Abilities Replan §B4 + Appendix A.
//
// The HashingEmbeddingProvider is lexical at heart: "machine learning" and
// "neural network" score near zero. Real embeddings fix BL4 (the brain
// densifying with paraphrase duplicates). Providers are user-selectable per
// workspace; the factory degrades to hashing when a provider is unreachable
// so a misconfiguration never blocks startup.
// ────────────────────────────────────────────────────────────

/** Validation contract — `validate()` throws if the provider is unreachable. */
export interface ValidatableEmbeddingProvider extends EmbeddingProvider {
  readonly type: string;
  validate(): Promise<void>;
}

export type EmbeddingProviderType = 'openai' | 'local';

export interface EmbeddingProviderConfig {
  /** Provider endpoint URL. */
  endpoint?: string;
  /** Provider model id. */
  model?: string;
  /** OpenAI API key. */
  apiKey?: string;
  /** Expected dimension — used for sanity checks. */
  dimension?: number;
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`embedding request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI embedding provider — `text-embedding-3-small`. For cloud-first teams
 * already on OpenAI. Cost is negligible (Appendix A cost analysis).
 */
export class OpenAIEmbeddingProvider implements ValidatableEmbeddingProvider {
  readonly type = 'openai';
  readonly dimension: number;
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: EmbeddingProviderConfig = {}) {
    this.endpoint = (config.endpoint ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = config.model ?? 'text-embedding-3-small';
    this.apiKey = config.apiKey ?? '';
    this.dimension = config.dimension ?? 1536;
    this.modelId = `openai:${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) throw new Error('OpenAI embedding provider missing apiKey');
    const json = (await fetchJson(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8000) }),
    })) as { data?: Array<{ embedding?: number[] }> };
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('OpenAI returned an empty embedding');
    }
    return l2Normalize(vec.slice());
  }

  async validate(): Promise<void> {
    const probe = await this.embed('connection test');
    if (probe.length === 0) throw new Error('OpenAI embedding probe returned no dimensions');
  }
}

/**
 * Local, self-hosted semantic embeddings via ONNX (transformers.js). Default
 * model `multilingual-e5-small` (384-dim, ~100 languages) — a real semantic
 * brain with no API key and no data egress at query time. The weights are
 * fetched ONCE on first use and cached under `<data-dir>/models`; inference is
 * CPU-only. Boot warms them in the background (see `warmLocalEmbeddingModel`) so
 * the download never lands mid-chat-turn.
 *
 * Size: the default fp32 `model.onnx` is ~450 MB (measured). Set
 * `AGENTIS_EMBEDDING_DTYPE=q8` for the ~4x smaller quantized weights and faster
 * CPU inference — see `configuredDtype` for why that is not the default.
 *
 * The runtime is dynamically imported on first use so startup (and deployments
 * that configure OpenAI instead) never pay the cost of loading onnxruntime.
 * e5 models expect an instruction prefix; we use `query:` uniformly (a standard
 * symmetric simplification — asymmetric query/passage prefixes can be threaded
 * later when call sites distinguish the two).
 */
/** One loaded pipeline per model id, shared across all provider instances. */
const localPipelines = new Map<string, Promise<unknown>>();
const loadedLocalModels = new Set<string>();

/**
 * Raised whenever the local model cannot be loaded. Callers that sweep many rows
 * (re-embed backfills) MUST detect this and stop the whole cycle rather than
 * retrying per row — see `isEmbeddingModelUnavailable`.
 */
export class EmbeddingModelUnavailableError extends Error {
  readonly code = 'EMBEDDING_MODEL_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingModelUnavailableError';
  }
}

/** True when an error means "the embedding model isn't loadable right now". */
export function isEmbeddingModelUnavailable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'EMBEDDING_MODEL_UNAVAILABLE';
}

/**
 * Circuit breaker for model loading.
 *
 * Not memoising failures (so a transient blip can recover) is right, but on its
 * own it is a trap: a genuinely missing model then re-attempts a ~450 MB load on
 * EVERY call, and every background sweep re-prints the full multi-line remedy.
 * Observed in the wild as an endless console flood that made the product look
 * hung. So: remember the failure, fail fast and QUIETLY for a cooldown, then let
 * exactly one attempt through to recover on its own if the cause was temporary.
 */
/**
 * ESCALATING cooldown. A flat 60s still meant a permanently-unreachable model
 * produced log lines forever (a real attempt every minute, and background sweeps
 * complaining in between). Back off hard so a genuinely dead model costs one line
 * every half hour, while a transient blip still recovers within a minute.
 */
const MODEL_FAILURE_COOLDOWN_STEPS_MS = [60_000, 300_000, 1_800_000];
let lastModelFailure: { at: number; streak: number } | null = null;

function cooldownMsFor(streak: number): number {
  const index = Math.min(Math.max(streak, 1) - 1, MODEL_FAILURE_COOLDOWN_STEPS_MS.length - 1);
  return MODEL_FAILURE_COOLDOWN_STEPS_MS[index]!;
}

/**
 * True while the model is in a failure cooldown. Background sweeps should check
 * this and skip their cycle SILENTLY — attempting (and logging) per cycle is what
 * turned one dead model into an endless console flood.
 */
export function isEmbeddingModelCoolingDown(provider?: EmbeddingProvider): boolean {
  // A local-model outage must never pause a workspace configured to use an API
  // provider. Callers with a resolved provider pass it so the guard stays local.
  if (provider && !provider.modelId.startsWith('local:')) return false;
  const failure = lastModelFailure;
  return !!failure && Date.now() - failure.at < cooldownMsFor(failure.streak);
}

/** Default model — kept here so the warmer and the provider can never diverge. */
export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

/** True only after transformers has fully loaded the requested model. */
export function isLocalEmbeddingModelReady(model = DEFAULT_LOCAL_EMBEDDING_MODEL): boolean {
  return loadedLocalModels.has(model);
}

/**
 * Where the ONNX weights live on disk.
 *
 * transformers.js otherwise picks its own default, which on a global `npm i -g`
 * can land inside `node_modules` — a directory the user may not be able to write
 * to, and which is wiped on every upgrade (re-downloading ~450 MB). Anchor it to
 * the Agentis data dir so the cache is writable, survives upgrades, and can be
 * pre-populated for air-gapped installs.
 */
function embeddingCacheDir(): string | undefined {
  const explicit = process.env.AGENTIS_EMBEDDING_CACHE_DIR?.trim();
  // MUST be absolute. `resolveDefaultDataDir()` returns a bare relative
  // `.agentis` whenever the process is not inside an Agentis workspace — i.e.
  // every global npm install. Handing transformers.js a relative cacheDir makes
  // it fail with "Unable to get model file path or buffer", so the model could
  // never download and the Brain stayed permanently empty. `resolve()` is a
  // no-op for a path that is already absolute.
  if (explicit) return resolve(explicit);
  const dataDir = process.env.AGENTIS_DATA_DIR?.trim();
  return dataDir ? resolve(dataDir, 'models') : undefined;
}

/** True when the operator has pinned this install to local-only model files. */
function offlineOnly(): boolean {
  return String(process.env.AGENTIS_EMBEDDING_OFFLINE ?? '').toLowerCase() === 'true';
}

/**
 * Optional weight precision (`q8`, `fp16`, …). Default is the library's own —
 * fp32, which for multilingual-e5-small is a **449 MB** download. `q8` cuts that
 * to roughly a quarter and speeds up CPU inference, at a negligible recall cost.
 *
 * NOT changed by default: existing installs already hold fp32 vectors, and
 * quietly switching precision would mix two slightly different vector spaces.
 * When it IS set, the precision is folded into `modelId` (below) so stored
 * vectors stay self-describing and the existing (model, dims) comparability +
 * re-embed machinery handles the transition instead of silently mismatching.
 */
function configuredDtype(): string | undefined {
  return process.env.AGENTIS_EMBEDDING_DTYPE?.trim() || undefined;
}

/**
 * Configure the transformers runtime BEFORE the first pipeline load.
 *
 * `AGENTIS_EMBEDDING_MODEL_PATH` points at a directory of already-downloaded
 * model files; combined with `AGENTIS_EMBEDDING_OFFLINE=true` this makes an
 * air-gapped install work with no network at all.
 */
function configureTransformersEnv(mod: Record<string, unknown>): void {
  const env = mod.env as
    | { cacheDir?: string; localModelPath?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean }
    | undefined;
  if (!env) return;
  const cacheDir = embeddingCacheDir();
  if (cacheDir) env.cacheDir = cacheDir;
  const localPath = process.env.AGENTIS_EMBEDDING_MODEL_PATH?.trim();
  if (localPath) {
    env.localModelPath = localPath;
    env.allowLocalModels = true;
  }
  if (offlineOnly()) env.allowRemoteModels = false;
}

/**
 * Turn a model-load failure into something an operator can act on.
 *
 * The weights are NOT bundled — they are fetched once (~450 MB) on first use. On
 * a fresh, offline, or firewalled install that first fetch fails deep inside a
 * chat turn, and the raw transformers error ("Could not locate file…") gives no
 * hint that the fix is network access or a pre-populated cache. There is
 * deliberately no lexical fallback (that would silently degrade recall), so this
 * message is the operator's only signal — make it carry the remedy.
 */
/**
 * Flatten an error's `cause` chain into one line.
 *
 * Node's `fetch` rejects with a bare `TypeError: fetch failed` and puts the real
 * reason — certificate rejection, DNS, ECONNRESET — in `.cause`. Printing only
 * `.message` cost us hours on a live install: the operator saw "fetch failed"
 * while curl reached the same URL fine, and the actual cause was never shown.
 */
function describeCauseChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(code ? `${current.message} [${code}]` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

function describeModelLoadFailure(model: string, err: unknown): EmbeddingModelUnavailableError {
  const cacheDir = embeddingCacheDir() ?? '(transformers default)';
  const detail = describeCauseChain(err);
  return new EmbeddingModelUnavailableError(
    `Could not load the local embedding model "${model}" — the Brain cannot store or recall memories until it loads.\n` +
      `  cache dir: ${cacheDir}\n` +
      `  cause: ${detail}\n` +
      'Fix one of:\n' +
      '  • Allow network access on first run — the model (~450 MB) is downloaded once and cached.\n' +
      '  • Pre-download it, then set AGENTIS_EMBEDDING_MODEL_PATH=<dir> and AGENTIS_EMBEDDING_OFFLINE=true.\n' +
      '  • Or configure an API embedding provider instead of the local one.',
  );
}

/**
 * Load (and cache) the local model ahead of first use.
 *
 * Called in the background at boot so the ~450 MB first fetch happens while the
 * operator is still setting up, instead of stalling — or failing — inside their
 * first chat turn. Safe to call repeatedly: the pipeline promise is memoised.
 */
export async function warmLocalEmbeddingModel(model = DEFAULT_LOCAL_EMBEDDING_MODEL): Promise<void> {
  await new LocalEmbeddingProvider({ model }).embed('warmup');
}

export class LocalEmbeddingProvider implements ValidatableEmbeddingProvider {
  readonly type = 'local';
  readonly dimension: number;
  readonly modelId: string;
  readonly #model: string;

  constructor(config: EmbeddingProviderConfig = {}) {
    this.#model = config.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
    this.dimension = config.dimension ?? 384;
    const dtype = configuredDtype();
    // Precision is part of the vector's identity: q8 and fp32 vectors of the same
    // model are close but not identical, so they must never be silently pooled.
    this.modelId = dtype ? `local:${this.#model}@${dtype}` : `local:${this.#model}`;
  }

  #pipeline(): Promise<unknown> {
    const cached = localPipelines.get(this.#model);
    if (cached) return cached;

    // Inside the cooldown, fail fast with a ONE-LINE error. The full remedy was
    // already logged when the breaker tripped; repeating it per row is the flood.
    const failure = lastModelFailure;
    if (failure && Date.now() - failure.at < cooldownMsFor(failure.streak)) {
      const retryInSec = Math.ceil((cooldownMsFor(failure.streak) - (Date.now() - failure.at)) / 1000);
      return Promise.reject(
        new EmbeddingModelUnavailableError(
          `Embedding model unavailable — retrying in ${retryInSec}s (see the earlier embedding model error for how to fix it).`,
        ),
      );
    }

    const pipe = import('@huggingface/transformers')
      .then((mod) => {
        // Must happen before the first pipeline() call — cacheDir/localModelPath
        // are read at load time.
        configureTransformersEnv(mod as unknown as Record<string, unknown>);
        const dtype = configuredDtype();
        return mod.pipeline('feature-extraction', this.#model, ...(dtype ? [{ dtype } as never] : []));
      })
      .then((loaded) => {
        loadedLocalModels.add(this.#model);
        lastModelFailure = null; // recovered — reset the breaker
        return loaded;
      })
      .catch((err) => {
        // Don't memoise the PIPELINE (a transient blip must be able to recover),
        // but do trip the breaker so the retry storm is bounded.
        localPipelines.delete(this.#model);
        loadedLocalModels.delete(this.#model);
        lastModelFailure = { at: Date.now(), streak: (lastModelFailure?.streak ?? 0) + 1 };
        throw describeModelLoadFailure(this.#model, err);
      });
    localPipelines.set(this.#model, pipe);
    return pipe;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = (await this.#pipeline()) as (
      input: string,
      options: { pooling: 'mean'; normalize: boolean },
    ) => Promise<{ data: ArrayLike<number> }>;
    const output = await extractor(`query: ${text}`.slice(0, 8000), { pooling: 'mean', normalize: true });
    return Array.from(output.data as ArrayLike<number>, (value) => Number(value));
  }

  async validate(): Promise<void> {
    const probe = await this.embed('connection test');
    if (probe.length === 0) throw new Error('local embedding probe returned no dimensions');
  }
}

/**
 * Factory — instantiate a provider from the workspace's configured type.
 * `local` (bundled semantic ONNX, multilingual-e5-small) is the default. There
 * is intentionally NO non-semantic / lexical fallback: a misconfigured or
 * unreachable provider must fail loud, never silently degrade recall to keyword
 * matching.
 */
export function selectEmbeddingProvider(
  type: string,
  config: EmbeddingProviderConfig = {},
): EmbeddingProvider {
  switch (type) {
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'local':
    default:
      return new LocalEmbeddingProvider(config);
  }
}

/** Embedding provenance stamp — what to record on a row at write time (§B1.2). */
export interface EmbeddingIdentity {
  model: string;
  dims: number;
}

/** The identity a provider stamps onto rows it embeds. */
export function providerIdentity(provider: EmbeddingProvider): EmbeddingIdentity {
  return { model: provider.modelId, dims: provider.dimension };
}

/**
 * True when a stored vector (with its recorded identity) is comparable to the
 * given provider. Length-equality is necessary but NOT sufficient: a 512-dim
 * hash vector and a 512-dim truncated semantic vector are both length-512 yet
 * meaningless to compare. We require the model id to match too. Rows written
 * before §B1.2 (no recorded model) fall back to a length check so the upgrade is
 * non-breaking — they are flagged for re-embed on first mismatch.
 */
export function vectorIsComparable(
  storedModel: string | null | undefined,
  storedDims: number | null | undefined,
  provider: EmbeddingProvider,
): boolean {
  if (storedModel == null || storedDims == null) {
    // Legacy row with no identity — comparable only if the length matches.
    return storedDims == null ? false : storedDims === provider.dimension;
  }
  return storedModel === provider.modelId && storedDims === provider.dimension;
}

/** Normalise any provider return value (sync or async) to a resolved vector. */
export async function embedText(provider: EmbeddingProvider, text: string): Promise<number[]> {
  const raw = provider.embed(text);
  return Array.isArray(raw) ? raw : await raw;
}
