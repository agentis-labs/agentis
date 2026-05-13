/**
 * LiveNodeTailService — in-memory ring buffer of per-node activity used
 * by canvas hover-peek (ENGINE-10X §12.1).
 *
 * Buffer is keyed by `runId + nodeId`. Maximum 32 entries per key. Cleared
 * when a run completes/fails/cancels. The service registers (taskId →
 * nodeId) bindings so adapter-emitted events (which carry taskId) can be
 * routed to the right node bucket.
 */

const MAX_TAIL = 32;
const MAX_KEYS = 4_096;

function key(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

export interface LiveNodeTailEntry {
  at: string;
  kind: 'thinking' | 'tool_call' | 'progress' | 'log' | 'cache' | 'retry';
  text: string;
}

export class LiveNodeTailService {
  readonly #tails = new Map<string, LiveNodeTailEntry[]>();
  readonly #taskToNode = new Map<string, string>(); // runId:taskId → nodeId

  bind(runId: string, taskId: string, nodeId: string): void {
    this.#taskToNode.set(`${runId}:${taskId}`, nodeId);
  }

  unbind(runId: string, taskId: string): void {
    this.#taskToNode.delete(`${runId}:${taskId}`);
  }

  append(runId: string, nodeId: string, entry: LiveNodeTailEntry): void {
    const k = key(runId, nodeId);
    const buf = this.#tails.get(k) ?? [];
    buf.push(entry);
    if (buf.length > MAX_TAIL) buf.splice(0, buf.length - MAX_TAIL);
    this.#tails.set(k, buf);
    if (this.#tails.size > MAX_KEYS) {
      const first = this.#tails.keys().next().value;
      if (first) this.#tails.delete(first);
    }
  }

  appendByTask(runId: string, taskId: string, entry: LiveNodeTailEntry): void {
    const nodeId = this.#taskToNode.get(`${runId}:${taskId}`);
    if (!nodeId) return;
    this.append(runId, nodeId, entry);
  }

  getTail(runId: string, nodeId: string): LiveNodeTailEntry[] {
    return this.#tails.get(key(runId, nodeId)) ?? [];
  }

  clearRun(runId: string): void {
    const prefix = `${runId}:`;
    for (const k of this.#tails.keys()) {
      if (k.startsWith(prefix)) this.#tails.delete(k);
    }
    for (const k of this.#taskToNode.keys()) {
      if (k.startsWith(prefix)) this.#taskToNode.delete(k);
    }
  }
}
