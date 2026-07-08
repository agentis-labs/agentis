/**
 * EmbeddingProvider — pluggable, real-semantic embedding generation for vector
 * retrieval. Every memory/knowledge write is embedded with the workspace's
 * configured provider so writes and queries live in the same vector space.
 *
 * Providers:
 *   - `LocalEmbeddingProvider` — bundled, offline, free, multilingual ONNX
 *     (`multilingual-e5-small`, 384-dim). The zero-config DEFAULT.
 *   - `OpenAIEmbeddingProvider` — opt-in API embeddings (or any OpenAI-compatible
 *     endpoint, incl. a self-hosted local embedding server).
 *
 * There is no non-semantic / lexical provider: a misconfigured provider fails
 * loud rather than silently degrading recall to keyword matching. (Tests inject
 * a deterministic stub — see `tests/_helpers/stubEmbeddingProvider.ts`.)
 */

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
 * brain with no API key and no data egress. The model (~120 MB INT8) is fetched
 * once and cached by the runtime; inference is CPU-only.
 *
 * The runtime is dynamically imported on first use so startup (and deployments
 * that configure OpenAI instead) never pay the cost of loading onnxruntime.
 * e5 models expect an instruction prefix; we use `query:` uniformly (a standard
 * symmetric simplification — asymmetric query/passage prefixes can be threaded
 * later when call sites distinguish the two).
 */
/** One loaded pipeline per model id, shared across all provider instances. */
const localPipelines = new Map<string, Promise<unknown>>();

export class LocalEmbeddingProvider implements ValidatableEmbeddingProvider {
  readonly type = 'local';
  readonly dimension: number;
  readonly modelId: string;
  readonly #model: string;

  constructor(config: EmbeddingProviderConfig = {}) {
    this.#model = config.model ?? 'Xenova/multilingual-e5-small';
    this.dimension = config.dimension ?? 384;
    this.modelId = `local:${this.#model}`;
  }

  #pipeline(): Promise<unknown> {
    let pipe = localPipelines.get(this.#model);
    if (!pipe) {
      pipe = import('@huggingface/transformers').then(({ pipeline }) =>
        pipeline('feature-extraction', this.#model));
      localPipelines.set(this.#model, pipe);
    }
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
