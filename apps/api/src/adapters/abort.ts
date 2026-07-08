export function linkAbortSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => controller.abort();
  if (source.aborted) {
    abort();
    return () => {};
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}
