/**
 * Residency — an agent that wakes on its own clock (Agent-Native Platform Plan §3.1).
 *
 * Pure helpers only; the wake is driven by the EXISTING CommandHeartbeat sweep
 * (no new scheduler — Part 7 "no ninth subsystem"). Residency is opt-in per agent
 * via `agents.config.residency`, so a plain worker/specialist — the kind the
 * manager-only heartbeat could never wake — becomes a persistent agent that
 * discovers, follows up, and drains a queue on a cadence, carrying working memory
 * (plan/observations blocks of its resident session) from one wake to the next.
 */

export interface ResidencyConfig {
  enabled: boolean;
  /** How often to wake, in minutes. Floored to 1 (a 60s sweep is the finest cadence). */
  intervalMinutes: number;
  /** The standing instruction handed to the agent on each wake. */
  wake: string;
}

const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_WAKE =
  'Standing wake: review your queue and standing objective, do the next useful thing through your tools, '
  + 'then call agentis.residency.remember to record where you left off. If nothing needs doing, remember that and stop.';

/** Parse an agent's residency config from its freeform `config` JSON. Returns null when off. */
export function readResidency(config: unknown): ResidencyConfig | null {
  if (!config || typeof config !== 'object') return null;
  const r = (config as Record<string, unknown>).residency;
  if (!r || typeof r !== 'object') return null;
  const obj = r as Record<string, unknown>;
  if (obj.enabled !== true) return null;
  const rawInterval = typeof obj.intervalMinutes === 'number' && Number.isFinite(obj.intervalMinutes)
    ? obj.intervalMinutes
    : DEFAULT_INTERVAL_MINUTES;
  return {
    enabled: true,
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(rawInterval)),
    wake: typeof obj.wake === 'string' && obj.wake.trim() ? obj.wake.trim() : DEFAULT_WAKE,
  };
}

/** Has enough time elapsed since the last wake to wake again? Never-woken ⇒ due now. */
export function residencyDue(lastWokeAtIso: string | null, cfg: ResidencyConfig, nowMs: number): boolean {
  if (!lastWokeAtIso) return true;
  const last = Date.parse(lastWokeAtIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= cfg.intervalMinutes * 60_000;
}

/** Compose the wake turn: the standing instruction + the working state carried from the prior wake. */
export function buildResidencyWake(cfg: ResidencyConfig, carried: { plan?: string; observations?: string }): string {
  const parts = [`[Scheduled residency wake] ${cfg.wake}`];
  const plan = carried.plan?.trim();
  const obs = carried.observations?.trim();
  if (plan) parts.push(`Your current plan: ${plan}`);
  if (obs) parts.push(`Where you left off last time: ${obs}`);
  return parts.join('\n');
}
