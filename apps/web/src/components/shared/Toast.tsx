/**
 * Toast — ephemeral feedback notifications.
 *
 * Position: top-right, max 3 visible, slide-in animation. Supports
 * undo variant with action button + countdown for destructive operations.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, AlertTriangle, XCircle, Info, Undo2, X } from 'lucide-react';

export type ToastTone = 'success' | 'warn' | 'danger' | 'info' | 'undo';

export interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  durationMs?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  success: (title: string, body?: string) => number;
  error:   (title: string, body?: string) => number;
  warn:    (title: string, body?: string) => number;
  info:    (title: string, body?: string) => number;
  undo:    (title: string, onUndo: () => void, body?: string) => number;
}

const ToastCtx = createContext<ToastApi | null>(null);

const DURATIONS: Record<ToastTone, number> = {
  success: 3000,
  warn:    4000,
  danger:  5000,
  info:    3000,
  undo:    5000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timerRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timerRef.current.get(id);
    if (t) { window.clearTimeout(t); timerRef.current.delete(id); }
    setItems((arr) => arr.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++idRef.current;
      const tone = t.tone ?? 'info';
      const duration = t.durationMs ?? DURATIONS[tone];
      setItems((arr) => {
        // Cap at 3 visible — drop oldest
        const next = [...arr, { ...t, tone, id }];
        return next.length > 3 ? next.slice(next.length - 3) : next;
      });
      const handle = window.setTimeout(() => dismiss(id), duration);
      timerRef.current.set(id, handle);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({
    push,
    dismiss,
    success: (title, body) => push({ title, body, tone: 'success' }),
    error:   (title, body) => push({ title, body, tone: 'danger' }),
    warn:    (title, body) => push({ title, body, tone: 'warn' }),
    info:    (title, body) => push({ title, body, tone: 'info' }),
    undo:    (title, onUndo, body) =>
      push({ title, body, tone: 'undo', action: { label: 'Undo', onClick: onUndo } }),
  }), [dismiss, push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 top-16 z-[70] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
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
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx(
        'pointer-events-auto animate-slide-in-right relative flex items-start gap-2.5 overflow-hidden rounded-card border border-line bg-surface px-4 py-3 shadow-dropdown',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute inset-y-0 left-0 w-1',
          tone === 'success' && 'bg-accent',
          tone === 'warn'    && 'bg-warn',
          tone === 'danger'  && 'bg-danger',
          tone === 'info'    && 'bg-info',
          tone === 'undo'    && 'bg-accent',
        )}
      />
      <ToastIcon tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text-primary">{item.title}</div>
        {item.body && <div className="mt-0.5 text-[12px] text-text-muted">{item.body}</div>}
        {item.action && (
          <button
            type="button"
            onClick={() => { item.action!.onClick(); onDismiss(); }}
            className="mt-2 inline-flex items-center gap-1 rounded-btn bg-surface-2 px-2 py-1 text-[11px] font-medium text-accent hover:bg-surface-3"
          >
            <Undo2 size={11} /> {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-m-1 shrink-0 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
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
    tone === 'warn'    && 'text-warn',
    tone === 'danger'  && 'text-danger',
    tone === 'info'    && 'text-info',
    tone === 'undo'    && 'text-accent',
  );
  if (tone === 'success') return <CheckCircle2 size={16} className={cls} />;
  if (tone === 'warn')    return <AlertTriangle size={16} className={cls} />;
  if (tone === 'danger')  return <XCircle      size={16} className={cls} />;
  if (tone === 'undo')    return <Undo2        size={16} className={cls} />;
  return <Info size={16} className={cls} />;
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (ctx) return ctx;
  // Fallback no-ops for tests / contexts without provider
  const noop = () => 0;
  const api: ToastApi = {
    push: noop,
    dismiss: () => {},
    success: noop,
    info: noop,
    warn: (title: string, body?: string) => {
      if (typeof console !== 'undefined') console.warn(title, body ?? '');
      return 0;
    },
    error: (title: string, body?: string) => {
      if (typeof console !== 'undefined') console.error(title, body ?? '');
      return 0;
    },
    undo: noop,
  };
  return api;
}



