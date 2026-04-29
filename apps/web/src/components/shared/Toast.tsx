/**
 * Toast — lightweight ephemeral feedback.
 *
 * Replaces `alert()` for transient async results. Toasts auto-dismiss
 * after a tone-dependent duration and stack bottom-right above the live
 * strip. `useToast()` returns a plain function so callers can write
 * `toast.success('Test message sent.')` from anywhere.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';

export type ToastTone = 'success' | 'warn' | 'danger' | 'info';

export interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (t: ToastInput) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  warn: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((arr) => arr.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++idRef.current;
      const tone = t.tone ?? 'info';
      const duration = t.durationMs ?? (tone === 'danger' ? 8000 : 4500);
      setItems((arr) => [...arr, { ...t, tone, id }]);
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api: ToastApi = {
    push,
    success: (title, body) => push({ title, body, tone: 'success' }),
    error: (title, body) => push({ title, body, tone: 'danger' }),
    warn: (title, body) => push({ title, body, tone: 'warn' }),
    info: (title, body) => push({ title, body, tone: 'info' }),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-12 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = item.tone ?? 'info';
  return (
    <div
      role="status"
      className={clsx(
        'pointer-events-auto flex items-start gap-2 rounded-xl border bg-surface px-3 py-2.5 text-xs shadow-card',
        tone === 'success' && 'border-accent/30',
        tone === 'warn' && 'border-warn/30',
        tone === 'danger' && 'border-danger/30',
        tone === 'info' && 'border-line',
      )}
    >
      <ToastIcon tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text-primary">{item.title}</div>
        {item.body && <div className="mt-0.5 text-text-muted">{item.body}</div>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  const cls = clsx(
    'mt-0.5 shrink-0',
    tone === 'success' && 'text-accent',
    tone === 'warn' && 'text-warn',
    tone === 'danger' && 'text-danger',
    tone === 'info' && 'text-text-muted',
  );
  if (tone === 'success') return <CheckCircle2 size={14} className={cls} />;
  if (tone === 'warn') return <AlertTriangle size={14} className={cls} />;
  if (tone === 'danger') return <AlertOctagon size={14} className={cls} />;
  return <Info size={14} className={cls} />;
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (ctx) return ctx;
  // Fallback no-ops when rendered outside the provider (page-level
  // unit tests). Logs only at warn/error levels so tests stay quiet.
  const noop = () => {};
  return {
    push: noop,
    success: noop,
    info: noop,
    warn: (title: string, body?: string) => {
      if (typeof console !== 'undefined') console.warn(title, body ?? '');
    },
    error: (title: string, body?: string) => {
      if (typeof console !== 'undefined') console.error(title, body ?? '');
    },
  } satisfies ToastApi;
}
