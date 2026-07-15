/**
 * ErrorBoundary — stops a render exception from unmounting the whole React root
 * (which, on a dark theme, shows as a fully black screen with no chrome).
 *
 * Wrap the routed page content so a single bad page shows a recoverable error
 * card — the app shell (sidebar, topbar) stays mounted so the operator can
 * navigate away instead of being stranded on a black screen. Pass a `resetKey`
 * (e.g. the current pathname) so navigating to a different route clears a
 * previously-caught error automatically.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** When this value changes, a previously-caught error is cleared. */
  resetKey?: unknown;
  /** Optional label for what failed, shown in the fallback. */
  label?: string;
  /** Compact inline fallback — for wrapping a single block, not a whole page. */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    // Clear the caught error when the reset key changes (e.g. route change), so
    // navigating away from the broken view recovers without a full reload.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the real stack in the console for diagnosis — the fallback UI
    // intentionally shows a short message, not the whole trace.
    console.error('[ErrorBoundary] render failure', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.compact) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {this.props.label ?? 'This section failed to render'}
            {error.message ? ` — ${error.message}` : ''}
          </span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="shrink-0 rounded border border-danger/40 px-1.5 py-0.5 text-[11px] font-medium hover:bg-danger/10"
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-canvas px-6 py-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle size={22} />
        </span>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-[15px] font-semibold text-text-primary">
            {this.props.label ?? 'This view hit an error'}
          </h2>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            Something in this page failed to render. The rest of Agentis is still working —
            use the sidebar to go elsewhere, or try again.
          </p>
          <p className="break-words font-mono text-[11px] text-text-muted">{error.message}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="inline-flex h-8 items-center rounded-btn border border-line bg-surface-2 px-3 text-[12px] font-medium text-text-secondary transition-colors hover:border-line-strong hover:text-text-primary"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-8 items-center rounded-btn bg-accent px-3 text-[12px] font-medium text-on-accent transition-opacity hover:opacity-90"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
