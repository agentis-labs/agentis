import type { ChatDelta } from './types/chat.js';

/** The `activity` variant of `ChatDelta` — a single narratable step of agent work. */
export type ChatActivityDelta = Extract<ChatDelta, { type: 'activity' }>;

/**
 * Turn a raw agent `activity` delta into a short, human-readable one-line
 * label — "Reading context", "Using `web_search`", "Writing the reply" — the
 * SAME vocabulary the web chat's live activity trace (`AgentTurnTrace`) and
 * the channel dispatcher's progress narration both use, so a user sees
 * identical wording whether they're watching the in-app trace or a
 * Telegram/WhatsApp/Slack thread. Returns null for activity that isn't worth
 * narrating on its own (e.g. a bare "request received"/"response ready"
 * bookend) — callers should skip narration for a null label.
 */
export function compactActivityLabel(activity: ChatActivityDelta): string | null {
  const label = activity.label.trim();
  if (!label) return null;
  if (/response ready|request received/i.test(label)) return null;
  if (/loading workspace context|collecting viewport|memory|instructions/i.test(label)) return 'Reading context';
  if (/invoking agent runtime/i.test(label)) return 'Starting up';
  if (/streaming the turn/i.test(label)) return 'Writing the reply';
  return label.replace(/^Run Tool:\s*/i, 'Using ');
}
