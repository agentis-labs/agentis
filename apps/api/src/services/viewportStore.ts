import type { ViewportContext } from '@agentis/core';

export class ViewportStore {
  readonly #byUser = new Map<string, Map<string, ViewportContext>>();

  set(userId: string, socketId: string, context: ViewportContext): void {
    const bySocket = this.#byUser.get(userId) ?? new Map<string, ViewportContext>();
    bySocket.set(socketId, { ...context });
    this.#byUser.set(userId, bySocket);
  }

  get(userId: string): ViewportContext | null {
    const bySocket = this.#byUser.get(userId);
    if (!bySocket || bySocket.size === 0) return null;
    return Array.from(bySocket.values()).at(-1) ?? null;
  }

  clear(userId: string, socketId?: string): void {
    if (!socketId) {
      this.#byUser.delete(userId);
      return;
    }
    const bySocket = this.#byUser.get(userId);
    if (!bySocket) return;
    bySocket.delete(socketId);
    if (bySocket.size === 0) this.#byUser.delete(userId);
  }
}