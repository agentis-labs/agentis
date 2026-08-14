/**
 * Public progress is intentionally much smaller than an answer. It exists to
 * keep an operator oriented while a turn runs, not to become a second answer or
 * a verbose reasoning transcript.
 */
export const PUBLIC_PROGRESS_MAX_CHARS = 220;

export function compactPublicProgress(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  // Prefer one complete sentence when a runtime emits a paragraph. This keeps
  // the transcript calm even when a harness ignores the prompt-level limit.
  const firstSentence = normalized.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? normalized;
  if (firstSentence.length <= PUBLIC_PROGRESS_MAX_CHARS) return firstSentence;
  return `${firstSentence.slice(0, PUBLIC_PROGRESS_MAX_CHARS - 1).trimEnd()}…`;
}
