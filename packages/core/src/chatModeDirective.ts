import type { ChatPermissionMode } from './types/chat.js';

const MODE_TOKEN = '(ask|plan|auto|bypass|act|chat)';

function permissionMode(command: string): ChatPermissionMode {
  const normalized = command.toLowerCase();
  if (normalized === 'plan') return 'plan';
  if (normalized === 'auto' || normalized === 'bypass') return 'auto';
  return 'ask';
}

/**
 * Reads a permission directive at either edge of a message. Supporting a final
 * standalone line matters in the composer: users commonly write the task first
 * and choose `/plan` last.
 */
export function parseChatPermissionDirective(message: string): { mode: ChatPermissionMode; rest: string } | null {
  const leading = message.match(new RegExp(`^\\s*\\/${MODE_TOKEN}\\b\\s*([\\s\\S]*)$`, 'i'));
  if (leading) {
    return { mode: permissionMode(leading[1] ?? ''), rest: (leading[2] ?? '').trim() };
  }

  const trailing = message.match(new RegExp(`^(.*?)\\r?\\n\\s*\\/${MODE_TOKEN}\\s*$`, 'is'));
  if (!trailing) return null;
  return { mode: permissionMode(trailing[2] ?? ''), rest: (trailing[1] ?? '').trim() };
}
