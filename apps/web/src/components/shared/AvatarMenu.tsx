

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Settings as SettingsIcon,
  LogOut,
  Package as PackageIcon,
  Database as DataIcon,
  Star,
  ArrowUpCircle,
  Copy,
  Check,
} from 'lucide-react';
import clsx from 'clsx';
import { ThemeToggle } from './ThemeToggle';
import { useAgentisStore } from '../../store/agentisStore';
import { useVersionUpdate } from '../../lib/useVersionUpdate';

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
  const nav = useNavigate();
  const { setSettingsOpen } = useAgentisStore();
  const version = useVersionUpdate();
  const [copied, setCopied] = useState(false);
  const updateAvailable = Boolean(version?.updateAvailable);

  function copyUpdateCommand() {
    const command = version?.installCommand;
    if (!command) return;
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }

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
      {updateAvailable && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent"
        />
      )}

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

          {updateAvailable && (
            <div className="border-b border-line px-3 py-3">
              <div className="rounded-card border border-accent/30 bg-accent-soft p-3">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-accent">
                  <ArrowUpCircle size={14} />
                  Update available
                </div>
                <div className="mt-1 text-[11px] text-text-secondary">
                  <span className="font-mono">{version?.current}</span>
                  {' → '}
                  <span className="font-mono font-semibold text-text-primary">{version?.latest}</span>
                </div>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
                    {version?.installCommand}
                  </code>
                  <button
                    type="button"
                    onClick={copyUpdateCommand}
                    aria-label="Copy update command"
                    className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                  >
                    {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
                  </button>
                </div>
              </div>
            </div>
          )}

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
              onClick={() => { setOpen(false); nav('/packages'); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <PackageIcon size={14} />
              Packages
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); setSettingsOpen(true, 'data'); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <DataIcon size={14} />
              Your data
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); setSettingsOpen(true, 'workspace'); }}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <SettingsIcon size={14} />
              Settings
            </button>
            <a
              role="menuitem"
              href={version?.github ?? 'https://github.com/agentis-labs/agentis'}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Star size={14} className="text-amber-400" />
              Star us on GitHub
            </a>
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



