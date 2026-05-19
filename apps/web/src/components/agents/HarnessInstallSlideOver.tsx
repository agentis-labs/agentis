import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { api, apiErrorMessage, streamSse } from '../../lib/api';
import type { AdapterType } from './RuntimePicker';

interface HarnessInstallOption {
  adapterType: AdapterType;
  canAutoInstall: boolean;
  installCommand?: string;
  manualUrl?: string;
  manualInstructions?: string;
}

interface InstallStep {
  index: number;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

interface HarnessInstallSlideOverProps {
  adapterType: AdapterType;
  onInstalled: (result: { binaryPath?: string; detectedVersion?: string; detectedModel?: string }) => void;
  onClose: () => void;
}

export function HarnessInstallSlideOver({ adapterType, onInstalled, onClose }: HarnessInstallSlideOverProps) {
  const [option, setOption] = useState<HarnessInstallOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<{ adapters: HarnessInstallOption[] }>('/v1/harness/install-options')
      .then((result) => {
        if (cancelled) return;
        setOption(result.adapters.find((entry) => entry.adapterType === adapterType) ?? null);
      })
      .catch((installError) => {
        if (!cancelled) setError(apiErrorMessage(installError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adapterType]);

  const title = useMemo(() => {
    if (adapterType === 'claude_code') return 'Claude Code';
    if (adapterType === 'codex') return 'Codex';
    if (adapterType === 'cursor') return 'Cursor';
    if (adapterType === 'hermes_agent') return 'Hermes Agent';
    if (adapterType === 'openclaw') return 'OpenClaw';
    return 'HTTP';
  }, [adapterType]);

  async function runInstall() {
    setRunning(true);
    setError(null);
    setSteps([]);
    setLogs([]);
    try {
      await streamSse('/v1/harness/install', {
        method: 'POST',
        body: JSON.stringify({ adapterType }),
      }, {
        onEvent(event, data) {
          if (event === 'step' && data && typeof data === 'object') {
            const step = data as InstallStep;
            setSteps((current) => {
              const next = current.filter((entry) => entry.index !== step.index);
              next.push(step);
              next.sort((left, right) => left.index - right.index);
              return next;
            });
            return;
          }
          if (event === 'log' && data && typeof data === 'object' && typeof (data as { line?: unknown }).line === 'string') {
            const line = (data as { line: string }).line;
            setLogs((current) => [...current.slice(-199), line]);
            return;
          }
          if (event === 'complete' && data && typeof data === 'object') {
            onInstalled(data as { binaryPath?: string; detectedVersion?: string; detectedModel?: string });
            return;
          }
          if (event === 'error' && data && typeof data === 'object') {
            setError(apiErrorMessage(data));
          }
        },
      });
    } catch (installError) {
      setError(apiErrorMessage(installError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <aside className="flex h-full w-full max-w-[460px] flex-col border-l border-line bg-surface shadow-modal">
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">Install {title}</h3>
            <p className="mt-1 text-xs text-text-muted">Run the install here and re-detect the harness automatically when it completes.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close installer" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-3 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading install options...
            </div>
          ) : error ? (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-3 text-sm text-danger">{error}</div>
          ) : option ? (
            <>
              {option.installCommand && (
                <div className="rounded-lg border border-line bg-surface-2 p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Command</div>
                  <code className="block overflow-x-auto rounded-md bg-canvas px-3 py-2 text-[12px] text-text-primary">{option.installCommand}</code>
                </div>
              )}

              {option.canAutoInstall ? (
                <>
                  <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
                    <div className="text-xs font-medium uppercase tracking-wider text-text-muted">Steps</div>
                    {steps.length === 0 ? (
                      <div className="text-[12px] text-text-muted">The installer will verify Node.js, verify npm, install the package globally, then re-run detection.</div>
                    ) : (
                      <div className="space-y-2">
                        {steps.map((step) => (
                          <div key={step.index} className="flex items-start gap-3">
                            <span className={clsxStep(step.status)}>
                              {step.status === 'done' ? <Check size={12} /> : step.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : '!' }
                            </span>
                            <div>
                              <div className="text-[12px] text-text-primary">{step.label}</div>
                              {step.detail ? <div className="mt-0.5 text-[11px] text-text-muted">{step.detail}</div> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
                    <div className="text-xs font-medium uppercase tracking-wider text-text-muted">Install log</div>
                    <div className="max-h-52 overflow-y-auto rounded-md bg-canvas px-3 py-2 font-mono text-[11px] text-text-muted">
                      {logs.length === 0 ? 'Waiting for installer output...' : logs.join('\n')}
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-sm text-text-muted">
                  <p>{option.manualInstructions ?? 'Manual setup is required for this harness.'}</p>
                  {option.manualUrl && (
                    <a href={option.manualUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                      Open setup guide <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-3 text-sm text-text-muted">No install path found for this harness.</div>
          )}
        </main>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-btn border border-line px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary">
            Close
          </button>
          {option?.canAutoInstall && (
            <button
              type="button"
              onClick={() => void runInstall()}
              disabled={running}
              className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? 'Installing...' : 'Run install'}
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

function clsxStep(status: InstallStep['status']): string {
  if (status === 'done') return 'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 text-accent';
  if (status === 'running') return 'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-accent/40 text-accent';
  return 'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-danger/15 text-danger';
}