/**
 * ThemeToggle -- dark/light/system theme switcher.
 *
 * Theme preference is stored in localStorage and applied to the root element
 * through both `data-theme` and `.dark/.light` for compatibility.
 */

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Moon, Sun, Monitor } from 'lucide-react';

export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'agentis.theme';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // ignore
  }
  return 'dark';
}

function resolveEffectiveTheme(t: Theme): 'dark' | 'light' {
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return t;
}

function applyTheme(t: Theme): 'dark' | 'light' {
  const root = document.documentElement;
  const effective = resolveEffectiveTheme(t);

  root.setAttribute('data-theme', effective);
  root.classList.remove('dark', 'light');
  root.classList.add(effective);
  root.style.colorScheme = effective;

  return effective;
}

let listeners: Array<(t: Theme) => void> = [];

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; effective: 'dark' | 'light' } {
  const [theme, setTheme] = useState<Theme>(readStored());
  const [effective, setEffective] = useState<'dark' | 'light'>(() => {
    const t = readStored();
    return t === 'system'
      ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : t;
  });

  useEffect(() => {
    setEffective(applyTheme(theme));
    const handler = (t: Theme) => setTheme(t);
    listeners.push(handler);
    return () => {
      listeners = listeners.filter((l) => l !== handler);
    };
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setEffective(applyTheme('system'));
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [theme]);

  const updateTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
    setEffective(applyTheme(t));
    setTheme(t);
    listeners.forEach((l) => l(t));
  }, []);

  return { theme, setTheme: updateTheme, effective };
}

interface ThemeToggleProps {
  variant?: 'compact' | 'full';
  className?: string;
}

export function ThemeToggle({ variant = 'compact', className }: ThemeToggleProps) {
  const { theme, setTheme, effective } = useTheme();

  if (variant === 'full') {
    return (
      <div className={clsx('flex gap-1 rounded-pill border border-line bg-surface-2 p-0.5', className)}>
        {(['light', 'dark', 'system'] as Theme[]).map((t) => {
          const Icon = t === 'light' ? Sun : t === 'dark' ? Moon : Monitor;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className={clsx(
                'flex h-7 items-center gap-1 rounded-pill px-2.5 text-[12px] font-medium transition-colors',
                theme === t ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Icon size={12} />
              <span className="capitalize">{t}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(effective === 'dark' ? 'light' : 'dark')}
      aria-label={`Switch to ${effective === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${effective === 'dark' ? 'light' : 'dark'} mode (currently ${effective})`}
      className={clsx(
        'inline-flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary',
        className,
      )}
    >
      {effective === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}

if (typeof window !== 'undefined') {
  applyTheme(readStored());
}
