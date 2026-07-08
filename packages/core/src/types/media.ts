/**
 * Media capability — a small, PROVIDER-PLUGGABLE seam for generative modalities
 * (image / audio / speech / video …).
 *
 * The whole point is no vendor lock-in and no node-per-task: a modality is a
 * property of a PROVIDER, resolved at call time, so any model — a hosted
 * multimodal model, a specialized image API, a local model, or a future
 * home-grown harness — is brought in by implementing {@link MediaProvider} and
 * registering it. The platform exposes ONE generic capability
 * (`agentis.media.generate`) that dispatches by modality; adding a modality is a
 * new provider, never a new node kind.
 *
 * Deliberately portable: references are base64 strings (no Buffer / Node types),
 * so a provider can live anywhere.
 */

export type MediaModality = 'image' | 'audio' | 'speech' | 'video';

/** A resolved reference input for edit/variation (already fetched to bytes). */
export interface MediaReferenceImage {
  /** Base64-encoded bytes (no `data:` prefix). */
  b64: string;
  mime: string;
}

export interface MediaGenerateRequest {
  modality: MediaModality;
  prompt: string;
  /** Reference inputs — present ⇒ an EDIT/variation of them, absent ⇒ pure generation. */
  images?: MediaReferenceImage[];
  /** Provider-agnostic size hint, e.g. "1024x1024". */
  size?: string;
  /** How many outputs to produce (default 1). */
  n?: number;
  /** Escape hatch for provider-specific knobs (quality, style, voice, …). */
  options?: Record<string, unknown>;
}

/** One produced item — either inline bytes (b64) or a URL the caller fetches. */
export interface GeneratedMedia {
  b64?: string;
  url?: string;
  mime: string;
}

/**
 * The ONE seam. Implement it + register it to add a model/provider/modality.
 * `id` is for diagnostics; `modalities` drives dispatch.
 */
export interface MediaProvider {
  readonly id: string;
  readonly modalities: readonly MediaModality[];
  generate(req: MediaGenerateRequest): Promise<GeneratedMedia[]>;
}
