/**
 * AvatarMenu — header dropdown with operator info, theme toggle, settings, sign out.
 *
 * Replaces the bare logout button. Uses initials when no avatar image
 * is available. Closes on click-outside and Escape.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { ThemeToggle } from './ThemeToggle';

interface AvatarMenuProps {
  name: string;
  email?: string;
  imageUrl?: string;
  onLogout: () => void;
}

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

export function AvatarMenu({ name, email, imageUrl, onLogout }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open profile menu"
        className={clsx(
          'inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-[12px] font-semibold text-text-primary transition-colors hover:bg-surface-3',
          open && 'bg-surface-3',
        )}
      >
        {imageUrl ? (
          <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          <span>{initials(name)}</span>
        )}
      </button>

      {open && (
        <div
          className="animate-fade-in absolute right-0 top-full z-40 mt-2 w-64 rounded-card border border-line bg-surface shadow-dropdown"
          role="menu"
          aria-label="Profile menu"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2">
                {imageUrl ? (
                  <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[14px] font-semibold text-text-primary">
                    {initials(name)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-subheading text-text-primary">{name}</div>
                {email && <div className="truncate text-[12px] text-text-muted">{email}</div>}
              </div>
            </div>
          </div>

          <div className="border-b border-line px-3 py-3">
            <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
              Theme
            </div>
            <ThemeToggle variant="full" />
          </div>

          <div className="p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); nav('/settings'); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <SettingsIcon size={14} />
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onLogout(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
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
