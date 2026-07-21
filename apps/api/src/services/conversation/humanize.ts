/**
 * humanize — the human-like pacing layer for outbound channel messages.
 *
 * Reliable, non-ban-prone realism primitives (OMNICHANNEL-RICH-MESSAGING §6):
 * a persona controls whether long text is split into a natural burst, how long
 * a "typing…" indicator shows before each piece, and the jitter that keeps the
 * cadence from looking robotic. This is pure/deterministic-shaped logic (the
 * only randomness is the jitter multiplier); the supervisor drives the actual
 * presence + send calls.
 *
 * Personas:
 *   - `instant`  no delays, no chunking (default — behaviour unchanged).
 *   - `human`    types before each message, splits long text, moderate pace.
 *   - `warm`     like `human` but slower/friendlier (a concierge cadence).
 */

export type ChannelPersona = 'instant' | 'human' | 'warm';

export interface HumanizeConfig {
  enabled: boolean;
  /** Floor for the typing delay before a message. */
  minDelayMs: number;
  /** Ceiling for the typing delay before a message. */
  maxDelayMs: number;
  /** Per-character typing time added between floor and ceiling. */
  perCharMs: number;
  /** Split long plain text into multiple messages. */
  chunk: boolean;
  /** Target max characters per chunk. */
  maxChunkChars: number;
  /** Small pause between consecutive messages in a burst. */
  interMessageMs: number;
}

const PERSONAS: Record<ChannelPersona, HumanizeConfig> = {
  instant: { enabled: false, minDelayMs: 0, maxDelayMs: 0, perCharMs: 0, chunk: false, maxChunkChars: 0, interMessageMs: 0 },
  human: { enabled: true, minDelayMs: 600, maxDelayMs: 6_000, perCharMs: 35, chunk: true, maxChunkChars: 600, interMessageMs: 400 },
  warm: { enabled: true, minDelayMs: 900, maxDelayMs: 9_000, perCharMs: 45, chunk: true, maxChunkChars: 500, interMessageMs: 700 },
};

/** Normalize an arbitrary persona value (from connection settings) to a config. */
export function resolveHumanize(persona: unknown): HumanizeConfig {
  const key = typeof persona === 'string' ? persona.trim().toLowerCase() : '';
  if (key === 'human' || key === 'warm') return PERSONAS[key];
  return PERSONAS.instant;
}

/** The parsed persona name (for surfacing/settings), defaulting to instant. */
export function normalizePersona(persona: unknown): ChannelPersona {
  const key = typeof persona === 'string' ? persona.trim().toLowerCase() : '';
  return key === 'human' || key === 'warm' ? key : 'instant';
}

/**
 * Typing delay before a message of `length` characters. Bounded to [min,max]
 * and multiplied by a ±15% jitter so the cadence never looks metronomic.
 * `random` is injectable for deterministic tests.
 */
export function typingDelayMs(length: number, cfg: HumanizeConfig, random: () => number = Math.random): number {
  if (!cfg.enabled) return 0;
  const base = Math.min(cfg.maxDelayMs, Math.max(cfg.minDelayMs, cfg.minDelayMs + cfg.perCharMs * Math.max(0, length)));
  const jitter = 0.85 + random() * 0.3;
  return Math.round(base * jitter);
}

/**
 * Split text into human-sized chunks at paragraph → sentence → hard boundaries,
 * never mid-word when avoidable. Returns the original text as a single chunk
 * when chunking is disabled or the text already fits.
 */
export function chunkText(text: string, cfg: HumanizeConfig): string[] {
  const trimmed = text.trim();
  if (!cfg.enabled || !cfg.chunk || trimmed.length <= cfg.maxChunkChars) {
    return trimmed ? [trimmed] : [];
  }
  const max = cfg.maxChunkChars;
  const chunks: string[] = [];
  // Prefer paragraph boundaries, then sentence boundaries, then whitespace.
  const paragraphs = trimmed.split(/\n{2,}/);
  let buffer = '';
  const flush = () => { if (buffer.trim()) chunks.push(buffer.trim()); buffer = ''; };
  const push = (piece: string) => {
    if (!piece) return;
    if (piece.length > max) {
      // Hard-split an oversized sentence at word boundaries.
      flush();
      const words = piece.split(/\s+/);
      for (const w of words) {
        if ((buffer + ' ' + w).trim().length > max) flush();
        buffer = buffer ? `${buffer} ${w}` : w;
      }
      flush();
      return;
    }
    if ((buffer + '\n\n' + piece).trim().length > max) flush();
    buffer = buffer ? `${buffer}\n\n${piece}` : piece;
  };
  for (const para of paragraphs) {
    if (para.length <= max) { push(para); continue; }
    // Break the paragraph into sentences.
    const sentences = para.match(/[^.!?…]+[.!?…]*\s*/g) ?? [para];
    for (const s of sentences) push(s.trim());
  }
  flush();
  return chunks.length ? chunks : [trimmed];
}

/** A cancellable sleep that never keeps the event loop alive. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}
