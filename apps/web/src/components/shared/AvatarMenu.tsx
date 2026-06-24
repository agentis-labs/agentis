/**
 * AvatarMenu — header dropdown with operator info, theme toggle, settings, sign out.
 *
 * Replaces the bare logout button. Uses initials when no avatar image
 * is available. Closes on click-outside and Escape.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { ThemeToggle } from './ThemeToggle';
import { useAgentisStore } from '../../store/agentisStore';

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
  const [position, setPosition] = useState({ top: 52, left: 12 });
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setSettingsOpen } = useAgentisStore();

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 256;
      setPosition({
        top: rect.bottom + 8,
        left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
      });
    };
    updatePosition();
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
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

      {open && createPortal(
        <div
          ref={menuRef}
          className="animate-fade-in fixed z-[85] w-64 rounded-card border border-line bg-surface shadow-dropdown"
          style={{ top: position.top, left: position.left }}
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
              onClick={() => { setOpen(false); setSettingsOpen(true, 'workspace'); }}
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
        </div>,
        document.body,
      )}
    </div>
  );
}
