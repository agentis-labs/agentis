/**
 * harnessAgentHome — the per-agent working directory Agentis manages for a CLI
 * harness chat session.
 *
 * Harnesses like Hermes auto-inject an `AGENTS.md` from their working directory
 * into the system prompt (`hermes --ignore-rules` lists exactly this behavior,
 * and `hermes prompt-size` confirms cwd `AGENTS.md` lands in the "context" tier).
 * So Agentis gives each agent its own home dir and writes the agent's operating
 * instructions to `<home>/AGENTS.md`. The harness then adopts the agent's
 * Agentis-configured identity NATIVELY — no per-turn prompt injection required,
 * and the same file is what the operator edits from the Instructions tab.
 *
 * The dir lives under AGENTIS_DATA_DIR so it is stable across restarts and never
 * pollutes the repo or a real project checkout.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Absolute path to the managed home dir for one agent (not created here). */
export function harnessAgentHomeDir(agentId: string): string {
  const base = process.env.AGENTIS_HARNESS_HOME
    ?? (process.env.AGENTIS_DATA_DIR
      ? path.join(process.env.AGENTIS_DATA_DIR, 'harness-agents')
      : path.join(os.homedir(), '.agentis', 'harness-agents'));
  return path.join(base, sanitizeId(agentId));
}

/** Absolute path to the agent's native instruction file. */
export function harnessAgentInstructionsPath(agentId: string): string {
  return path.join(harnessAgentHomeDir(agentId), 'AGENTS.md');
}

/**
 * Ensure the home dir exists and that `AGENTS.md` reflects the agent's current
 * instructions. Returns the home dir (to use as the session cwd). Writing on a
 * blank instructions string is skipped so we never clobber an operator-authored
 * file with nothing.
 */
export function syncHarnessAgentInstructions(agentId: string, instructions: string | null | undefined): string {
  const home = harnessAgentHomeDir(agentId);
  mkdirSync(home, { recursive: true });
  if (typeof instructions === 'string' && instructions.trim().length > 0) {
    writeFileSync(path.join(home, 'AGENTS.md'), instructions, 'utf8');
  }
  return home;
}

function sanitizeId(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'agent';
}
