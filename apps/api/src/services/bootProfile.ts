/**
 * §PERF-BOOT — boot-phase instrumentation.
 *
 * Until this existed the boot sequence had NO timing at all — only ad-hoc info
 * logs with ISO timestamps — so a 49-second start was diagnosable only by
 * hand-diffing log lines, and the one log that mattered (`agentis.listening`)
 * fired ~31s AFTER the port actually bound. Every phase now records when it
 * completed relative to process start, and the whole profile is served on
 * `/healthz`, so "why is boot slow?" is answerable from a running instance
 * with one curl — no profiler, no rebuild.
 *
 * Module-level on purpose: one process, one boot; threading a recorder through
 * bootstrap's dependency graph would touch dozens of constructors for zero
 * benefit. `performance.now()` is relative to process start, which is exactly
 * the origin an operator cares about (it includes module-graph load — measured
 * at 7–10s under tsx, invisible to any in-code timestamp diff).
 */

export interface BootPhase {
  phase: string;
  /** ms since process start when this phase COMPLETED. */
  atMs: number;
  /** ms since the previous recorded phase — the phase's own cost. */
  deltaMs: number;
}

const phases: BootPhase[] = [];
let ready = false;

export function markBootPhase(phase: string): void {
  const atMs = Math.round(performance.now());
  const prev = phases[phases.length - 1];
  phases.push({ phase, atMs, deltaMs: atMs - (prev?.atMs ?? 0) });
}

/** The final mark: the API considers itself fully warm. */
export function markBootReady(): void {
  if (ready) return;
  ready = true;
  markBootPhase('ready');
}

export function bootProfileSnapshot(): { ready: boolean; phases: BootPhase[] } {
  return { ready, phases: [...phases] };
}
