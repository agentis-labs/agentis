/**
 * §B5.9 — how much intelligence the Brain is allowed to spend deciding what to
 * remember. One home, read fresh from the DB on every call.
 *
 * WHY THIS IS A TIER AND NOT A BOOLEAN
 *
 * The bundled on-device model (multilingual-e5-small) was measured against a
 * multilingual labelled set and CANNOT judge:
 *
 *   6-class intent classification (rule/preference/fact/lesson/task/noise)  44–63%
 *   REMEMBER-vs-DROP, the decision that actually matters                    48.1%
 *
 * — i.e. worse than a coin flip, because a retrieval embedder encodes TOPIC,
 * not SPEECH ACT: everything about deploying lands in one cone whether it is a
 * standing rule, a one-off command, or chatter. No descriptor tuning fixes
 * that. The same model is genuinely good at RECALL (unrelated text 0.76–0.80 vs
 * duplicates 0.92+, and strong cross-language matching), which is what it is
 * for.
 *
 * So the honest choice offered to the operator is not "smart or dumb" but
 * WHICH WAY THE SYSTEM FAILS:
 *
 *   on_device      keep generously. Deterministic signals (directive polarity,
 *                  cues, structure) act as a confidence BOOST, never a veto, so
 *                  uncertain statements are written at low confidence and shown
 *                  on the canvas rather than silently dropped. High recall, some
 *                  noise, nothing lost. Free, offline, no tokens.
 *   model_assisted a Formation Judge reconciles and prunes (ADD/UPDATE/NOOP) and
 *                  resolves the pairs on_device can only flag. High precision.
 *                  Costs tokens.
 *   off            form nothing.
 *
 * Deliberately NOT derived from `modelAssistedRuntimeEnabled`: that flag also
 * governs evaluation, synthesis, agent sessions, Feynman repair and Brain Ask.
 * An operator who wants a cheap brain but a strong evaluator must be able to say
 * so. It is only the DEFAULT, so existing workspaces keep their behaviour.
 */
import { eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export const MEMORY_FORMATION_TIERS = ['off', 'on_device', 'model_assisted'] as const;
export type MemoryFormationTier = (typeof MEMORY_FORMATION_TIERS)[number];

export function workspaceBrainSettings(db: AgentisSqliteDb, workspaceId: string): Record<string, unknown> {
  const row = db.select({ brainSettings: schema.workspaces.brainSettings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();
  const value = row?.brainSettings;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function coerceTier(value: unknown): MemoryFormationTier | null {
  return typeof value === 'string' && (MEMORY_FORMATION_TIERS as readonly string[]).includes(value)
    ? value as MemoryFormationTier
    : null;
}

/**
 * Resolve the effective tier. Reads the row on every call — the setting must
 * take effect on the next formation pass, never on the next API restart, so
 * callers must hold THIS FUNCTION rather than a value captured at bootstrap.
 */
export function resolveMemoryFormationTier(db: AgentisSqliteDb, workspaceId: string): MemoryFormationTier {
  const settings = workspaceBrainSettings(db, workspaceId);
  const explicit = coerceTier(settings.memoryFormationTier);
  if (explicit) return explicit;
  // Back-compat default: a workspace that never chose a tier keeps the behaviour
  // implied by its existing model-assist flag.
  return settings.modelAssistedRuntimeEnabled === false ? 'on_device' : 'model_assisted';
}

export function memoryFormationConfig(db: AgentisSqliteDb, workspaceId: string): {
  tier: MemoryFormationTier;
  explicit: boolean;
} {
  const settings = workspaceBrainSettings(db, workspaceId);
  return {
    tier: resolveMemoryFormationTier(db, workspaceId),
    explicit: coerceTier(settings.memoryFormationTier) !== null,
  };
}
