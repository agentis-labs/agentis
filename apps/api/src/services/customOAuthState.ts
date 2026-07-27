/**
 * CustomOAuthStateStore — single-use, TTL'd CSRF state for the custom-OAuth
 * authorize→callback flow (INTEGRATION-CEILING-10X §2). Mirrors OAuthService's
 * internal state map exactly, just keyed by (workspaceId, providerId) instead
 * of a fixed provider enum.
 */

import { randomBytes } from 'node:crypto';

export interface CustomOAuthStateEntry {
  workspaceId: string;
  userId: string;
  providerId: string;
  origin: string;
  createdAt: number;
  codeVerifier?: string;
}

const STATE_TTL_MS = 10 * 60_000;

export class CustomOAuthStateStore {
  readonly #states = new Map<string, CustomOAuthStateEntry>();

  create(args: { workspaceId: string; userId: string; providerId: string; origin: string; codeVerifier?: string }): string {
    const state = randomBytes(24).toString('base64url');
    this.#gc();
    this.#states.set(state, { ...args, createdAt: Date.now() });
    return state;
  }

  /** Validate + consume a state (single-use). */
  consume(state: string): CustomOAuthStateEntry | null {
    this.#gc();
    const entry = this.#states.get(state);
    if (!entry) return null;
    this.#states.delete(state);
    if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
    return entry;
  }

  #gc(): void {
    const now = Date.now();
    for (const [k, v] of this.#states) if (now - v.createdAt > STATE_TTL_MS) this.#states.delete(k);
  }
}
