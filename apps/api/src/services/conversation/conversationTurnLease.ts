import { randomUUID } from 'node:crypto';
import { AgentisError } from '@agentis/core';

export interface TurnToolObservation {
  index: number;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  mutating: boolean;
  repeats: number;
  durationMs: number;
}

export interface ConversationTurnExperience {
  toolCalls: number;
  observations: TurnToolObservation[];
  recalledAtomIds: string[];
  efficiency: {
    uniqueObservations: number;
    coalescedReads: number;
    mutatingCalls: number;
    argumentCharsObserved: number;
    resultCharsObserved: number;
    repeatedResultChars: number;
  };
}

interface ActiveTurnLease {
  workspaceId: string;
  token: string;
  controller: AbortController;
  toolCalls: number;
  stateVersion: number;
  observations: Array<TurnToolObservation & { argsKey: string; resultKey: string; stateVersion: number }>;
  recalledAtomIds: Set<string>;
  coalescedReads: number;
  mutatingCalls: number;
  argumentCharsObserved: number;
  resultCharsObserved: number;
  repeatedResultChars: number;
}

/**
 * Server-side capability for one interactive conversation turn.
 *
 * A CLI harness may outlive the HTTP/SSE request that launched it. An AbortSignal
 * is therefore necessary but not sufficient: a late MCP request can arrive after
 * the operator pressed Stop. Every harness-owned MCP call carries this opaque
 * lease and is rejected before dispatch when the lease is no longer current.
 */
export class ConversationTurnLeaseRegistry {
  readonly #active = new Map<string, ActiveTurnLease>();

  issue(workspaceId: string, conversationId: string): string {
    this.#active.get(conversationId)?.controller.abort(new Error('turn_superseded'));
    const token = randomUUID();
    this.#active.set(conversationId, {
      workspaceId,
      token,
      controller: new AbortController(),
      toolCalls: 0,
      stateVersion: 0,
      observations: [],
      recalledAtomIds: new Set(),
      coalescedReads: 0,
      mutatingCalls: 0,
      argumentCharsObserved: 0,
      resultCharsObserved: 0,
      repeatedResultChars: 0,
    });
    return token;
  }

  complete(workspaceId: string, conversationId: string, token: string): void {
    const active = this.#active.get(conversationId);
    if (active?.workspaceId === workspaceId && active.token === token) {
      active.controller.abort(new Error('turn_completed'));
      this.#active.delete(conversationId);
    }
  }

  revoke(workspaceId: string, conversationId: string): boolean {
    const active = this.#active.get(conversationId);
    if (!active || active.workspaceId !== workspaceId) return false;
    active.controller.abort(new Error('operator_stop_all'));
    this.#active.delete(conversationId);
    return true;
  }

  assertActive(workspaceId: string, conversationId: string, token: string): AbortSignal {
    const active = this.#active.get(conversationId);
    if (active?.workspaceId === workspaceId && active.token === token && !active.controller.signal.aborted) {
      return active.controller.signal;
    }
    throw new AgentisError(
      'TURN_CANCELLED',
      'This conversation turn was stopped or superseded. The tool was not executed. Do not retry from this turn.',
      {
        remediation: 'Start a new operator turn if more work is required; never reuse the canceled turn lease.',
        details: { conversationId },
      },
    );
  }

  /**
   * Record compact, evidence-bearing experience without limiting the harness.
   * Exact repeated reads at the same mutation frontier are coalesced so the
   * model can reuse the observation already in context instead of ingesting it
   * again. Calls still execute; intelligence and reach are never capped.
   */
  recordToolResult(args: {
    workspaceId: string;
    conversationId: string;
    token: string;
    name: string;
    toolArgs: unknown;
    result: unknown;
    ok: boolean;
    mutating: boolean;
    durationMs: number;
  }): { repeated: boolean; observationIndex: number; stateVersion: number } {
    this.assertActive(args.workspaceId, args.conversationId, args.token);
    const active = this.#active.get(args.conversationId)!;
    active.toolCalls += 1;
    const compactArgs = compactExperienceValue(args.toolArgs);
    const compactResult = compactExperienceValue(args.result);
    const argsKey = stableJson(compactArgs);
    const resultKey = stableJson(compactResult);
    active.argumentCharsObserved += argsKey.length;
    active.resultCharsObserved += resultKey.length;
    if (args.mutating) active.mutatingCalls += 1;
    const prior = [...active.observations].reverse().find((entry) =>
      !args.mutating
      && entry.stateVersion === active.stateVersion
      && entry.name === args.name
      && entry.argsKey === argsKey
      && entry.resultKey === resultKey,
    );
    if (prior) {
      prior.repeats += 1;
      prior.durationMs += Math.max(0, Math.round(args.durationMs));
      active.coalescedReads += 1;
      active.repeatedResultChars += resultKey.length;
      return { repeated: true, observationIndex: prior.index, stateVersion: active.stateVersion };
    }

    if (args.mutating && args.ok) active.stateVersion += 1;
    const observation = {
      index: active.toolCalls,
      name: args.name,
      args: compactArgs,
      result: compactResult,
      ok: args.ok,
      mutating: args.mutating,
      repeats: 1,
      durationMs: Math.max(0, Math.round(args.durationMs)),
      argsKey,
      resultKey,
      stateVersion: active.stateVersion,
    };
    // This is a learning/diagnostic working set, not a capability limit. Keep a
    // bounded representative tail while the actual harness may continue freely.
    active.observations.push(observation);
    if (active.observations.length > 160) active.observations.splice(0, active.observations.length - 160);
    return { repeated: false, observationIndex: observation.index, stateVersion: active.stateVersion };
  }

  experience(workspaceId: string, conversationId: string, token: string): ConversationTurnExperience {
    this.assertActive(workspaceId, conversationId, token);
    const active = this.#active.get(conversationId)!;
    return {
      toolCalls: active.toolCalls,
      observations: active.observations.map(({ argsKey: _args, resultKey: _result, stateVersion: _version, ...entry }) => entry),
      recalledAtomIds: [...active.recalledAtomIds],
      efficiency: {
        uniqueObservations: active.observations.length,
        coalescedReads: active.coalescedReads,
        mutatingCalls: active.mutatingCalls,
        argumentCharsObserved: active.argumentCharsObserved,
        resultCharsObserved: active.resultCharsObserved,
        repeatedResultChars: active.repeatedResultChars,
      },
    };
  }

  recordRecalledAtoms(workspaceId: string, conversationId: string, token: string, atomIds: string[]): void {
    this.assertActive(workspaceId, conversationId, token);
    const active = this.#active.get(conversationId)!;
    for (const atomId of atomIds) if (atomId) active.recalledAtomIds.add(atomId);
  }

}

function compactExperienceValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= 600 ? value : `${value.slice(0, 600)}…`;
  if (depth >= 4) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const rows = value.slice(0, 16).map((entry) => compactExperienceValue(entry, depth + 1));
    return value.length > rows.length ? [...rows, `[+${value.length - rows.length} more]`] : rows;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
    return Object.fromEntries(entries.map(([key, entry]) => [key, compactExperienceValue(entry, depth + 1)]));
  }
  return String(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
