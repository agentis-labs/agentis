import type { ComponentType, SVGProps } from 'react';
import { ClaudeIcon, CodexIcon, CursorIcon, HermesIcon, HttpIcon, OpenClawIcon } from '../icons';

export type HarnessIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Shared harness identity (logo + label) for every surface that shows where an
 * imported agent came from — the import wizard, the Agents-page sync banner, and
 * the per-agent Provider→Brain header. One source of truth.
 */
export const HARNESS: Record<string, { label: string; Icon: HarnessIcon }> = {
  claude_code: { label: 'Claude Code', Icon: ClaudeIcon },
  codex: { label: 'Codex', Icon: CodexIcon },
  cursor: { label: 'Cursor', Icon: CursorIcon },
  hermes_agent: { label: 'Hermes', Icon: HermesIcon },
  openclaw: { label: 'OpenClaw', Icon: OpenClawIcon },
  http: { label: 'HTTP', Icon: HttpIcon },
};

export function harnessOf(type: string): { label: string; Icon: HarnessIcon } {
  return HARNESS[type] ?? { label: type, Icon: HttpIcon };
}
