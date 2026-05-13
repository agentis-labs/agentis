/**
 * AvatarDropdown — header user menu (AGENTIS-UX-V2 §2.4).
 *
 * Replaces the standalone LogOut button. Contains: profile link (Settings),
 * theme toggle placeholder (deferred to v1.5 light mode), Sign out.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings as SettingsIcon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { useAgentisStore } from '../store/agentisStore';

export function AvatarDropdown({ onLogout }: { onLogout: () => void }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useAgentisStore((s) => s.currentWorkspace);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const initial = (workspace?.name || 'A').slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Account"
        aria-label="Account menu"
        className={clsx(
          'inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-2 text-[11px] font-medium text-text-primary transition hover:border-accent/40 hover:text-accent',
          open && 'border-accent/40 text-accent',
        )}
      >
        {initial}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 w-52 overflow-hidden rounded-lg border border-line bg-surface shadow-card"
        >
          <div className="border-b border-line px-3 py-2 text-[11px] text-text-muted">
            <div className="truncate font-medium text-text-primary">{workspace?.name || 'Workspace'}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav('/settings');
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <SettingsIcon size={14} />
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            disabled
            title="Light theme — v1.5"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-muted/60"
          >
            <Sun size={14} />
            Theme
            <span className="ml-auto rounded border border-line px-1 text-[9px]">v1.5</span>
          </button>
          <div className="border-t border-line">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
