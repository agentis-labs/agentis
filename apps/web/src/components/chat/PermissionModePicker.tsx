import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ChatPermissionMode } from '@agentis/core';
import { Check, ChevronDown, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';

/**
 * Per-conversation permission mode selector, shown in the composer next to the
 * model + thinking-effort pickers (same RuntimeMenu dropdown pattern). Mirrors the
 * Ask uses risk-aware escalation, Plan proposes before acting, and Auto runs
 * freely. Also reachable over channels via /ask /plan /auto.
 */
const MODES: Array<{ value: ChatPermissionMode; label: string; hint: string }> = [
  { value: 'ask', label: 'Ask', hint: 'Confirm consequential actions' },
  { value: 'plan', label: 'Plan', hint: 'Propose a plan and wait for approval before acting' },
  { value: 'auto', label: 'Full access', hint: 'Act without stopping to confirm' },
];

interface Props {
  value: ChatPermissionMode;
  onChange: (mode: ChatPermissionMode) => void;
}

export function PermissionModePicker({ value, onChange }: Props) {
  const active = MODES.find((m) => m.value === value) ?? MODES[0]!;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Permission mode"
          className={clsx(
            'inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium outline-none transition hover:bg-surface-3 focus-visible:ring-1 focus-visible:ring-accent/50',
            value === 'auto' ? 'text-warn' : 'text-text-secondary hover:text-text-primary',
          )}
        >
          <ShieldCheck size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{active.label}</span>
          <ChevronDown size={10} className="shrink-0 text-text-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[90] w-64 rounded-lg border border-line bg-[#2A2A2B] p-1.5 shadow-modal outline-none"
        >
          <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Permission
          </div>
          {MODES.map(({ value: mode, label, hint }) => (
            <DropdownMenu.Item
              key={mode}
              onSelect={(event) => {
                event.preventDefault();
                onChange(mode);
              }}
              className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 text-text-secondary outline-none hover:bg-surface-2 hover:text-text-primary"
            >
              <span className="min-w-0">
                <span className="block text-[11px] font-medium">{label}</span>
                <span className="block text-[10px] leading-snug text-text-muted">{hint}</span>
              </span>
              {mode === value ? <Check size={12} className="mt-0.5 shrink-0 text-accent" /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
