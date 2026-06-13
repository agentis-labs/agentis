/**
 * Codex `service_tier` self-heal (NATIVE-ADVANCEMENT Phase A follow-up).
 *
 * The Codex CLI refuses to start when `~/.codex/config.toml` carries a
 * `service_tier` value its build doesn't recognise:
 *
 *   Error loading config.toml: unknown variant `default`, expected `fast` or `flex`
 *
 * The Codex desktop app writes `service_tier = "default"`, but the bundled CLI
 * only accepts `fast`/`flex` — a version skew that hard-fails every chat turn
 * (finishReason=error, no token). Verified fix: a `-c service_tier="fast"`
 * override makes Codex start and answer normally — the override supersedes the
 * file value, so this is NON-DESTRUCTIVE (no file edits, survives Codex
 * rewriting its own config, preserves auth) and immune to the managed-file race.
 *
 * Applied surgically: only when the configured value is one Codex would reject
 * anyway (not `fast`/`flex`). A deliberate, valid `service_tier` — or no
 * `service_tier` at all — is left untouched, so we never silently change a
 * user's chosen billing tier.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Values the current Codex CLI accepts for `service_tier`. */
const VALID_SERVICE_TIERS = new Set(['fast', 'flex']);
/**
 * The tier we override an invalid value to.
 *
 * `flex` is accepted by the CLI config parser, but it is not available on every
 * account/API route (`Unsupported service_tier: flex`). `fast` is the safer
 * compatibility fallback for Codex Desktop configs that write
 * `service_tier = "default"`.
 */
const FALLBACK_SERVICE_TIER = 'fast';

/** Resolve the Codex config path from an explicit CODEX_HOME or the default. */
export function resolveCodexConfigPath(env?: NodeJS.ProcessEnv): string {
  const home = env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(home, 'config.toml');
}

/** Read the top-level `service_tier` value from a Codex config.toml, or null. */
function readServiceTier(configPath: string): string | null {
  try {
    if (!existsSync(configPath)) return null;
    const text = readFileSync(configPath, 'utf-8');
    // Only the top-level table (before the first `[section]`) holds `service_tier`.
    const firstSection = text.search(/^\s*\[/m);
    const head = firstSection === -1 ? text : text.slice(0, firstSection);
    const match = head.match(/^[ \t]*service_tier[ \t]*=[ \t]*["']?([^"'\r\n]+)["']?[ \t]*$/m);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Codex `-c` args that neutralise an invalid `service_tier`, or `[]` when the
 * config is fine. Best-effort: any failure yields `[]` (never blocks a spawn).
 */
export function codexServiceTierArgs(env?: NodeJS.ProcessEnv): string[] {
  const value = readServiceTier(resolveCodexConfigPath(env));
  if (value && !VALID_SERVICE_TIERS.has(value)) {
    return ['-c', `service_tier="${FALLBACK_SERVICE_TIER}"`];
  }
  return [];
}
