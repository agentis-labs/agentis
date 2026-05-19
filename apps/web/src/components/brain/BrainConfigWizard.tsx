import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Cpu, Loader2, Lock, Radio, Server, Settings2, Zap } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

type ProviderType = 'hashing' | 'ollama' | 'openai';

interface IntelligenceConfig {
  embeddingProviderType: ProviderType;
  embeddingProviderConfig: {
    endpoint?: string;
    model?: string;
    dimension?: number;
    apiKeySet?: boolean;
  };
  auxiliaryAdapterConfig: Record<string, unknown> | null;
  activeAtomCount: number;
  degraded: boolean;
  migration: unknown;
  auxiliaryUsedBy: string[];
}

interface VerifyResult {
  ok: boolean;
  degraded: boolean;
  providerType: ProviderType;
  dimension?: number;
  latencyMs: number;
  error?: string;
}

interface PendingMigration {
  activeAtomCount: number;
  estimateSeconds: number;
  message: string;
}

interface BrainConfigWizardProps {
  embedded?: boolean;
  onFinished?: () => void;
}

export function BrainConfigWizard({ embedded = false, onFinished }: BrainConfigWizardProps = {}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [config, setConfig] = useState<IntelligenceConfig | null>(null);
  const [provider, setProvider] = useState<ProviderType>('ollama');
  const [endpoint, setEndpoint] = useState('http://localhost:11434');
  const [model, setModel] = useState('nomic-embed-text');
  const [apiKey, setApiKey] = useState('');
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [backgroundMode, setBackgroundMode] = useState<'main' | 'lighter'>('main');
  const [pendingMigration, setPendingMigration] = useState<PendingMigration | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<IntelligenceConfig>('/v1/workspace/intelligence');
      setConfig(data);
      const initialProvider = data.embeddingProviderType === 'hashing' ? 'ollama' : data.embeddingProviderType;
      setProvider(initialProvider);
      setEndpoint(data.embeddingProviderConfig.endpoint ?? (initialProvider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:11434'));
      setModel(data.embeddingProviderConfig.model ?? (initialProvider === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text'));
    } catch (err) {
      toast.error('Could not load Brain config', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerConfig = useMemo(() => {
    if (provider === 'hashing') return {};
    return {
      endpoint: endpoint.trim(),
      model: model.trim(),
      ...(provider === 'openai' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
  }, [apiKey, endpoint, model, provider]);

  async function testConnection() {
    setTesting(true);
    setVerify(null);
    try {
      const result = await api<VerifyResult>('/v1/workspace/intelligence/embedding/verify', {
        method: 'POST',
        body: JSON.stringify({ embeddingProviderType: provider, embeddingProviderConfig: providerConfig }),
      });
      setVerify(result);
      result.ok ? toast.success('Embedding connection works', `${result.latencyMs}ms round trip`) : toast.error('Embedding test failed', result.error ?? 'Unknown error');
    } catch (err) {
      const message = apiErrorMessage(err);
      setVerify({ ok: false, degraded: true, providerType: provider, latencyMs: 0, error: message });
      toast.error('Embedding test failed', message);
    } finally {
      setTesting(false);
    }
  }

  async function save(confirmMigration = false) {
    setSaving(true);
    setPendingMigration(null);
    try {
      const result = await api<(IntelligenceConfig & { migrationQueued?: boolean }) | (PendingMigration & { requiresConfirmation: true })>('/v1/workspace/intelligence', {
        method: 'PATCH',
        body: JSON.stringify({
          embeddingProviderType: provider,
          embeddingProviderConfig: providerConfig,
          auxiliaryAdapterConfig: backgroundMode === 'main'
            ? { mode: 'main_adapter' }
            : { mode: 'lighter_model', provider, providerConfig: { ...providerConfig, apiKey: undefined } },
          confirmMigration,
        }),
      });
      if ('requiresConfirmation' in result) {
        setPendingMigration(result);
        return;
      }
      setConfig(result);
      toast.success(result.migrationQueued ? 'Embedding migration queued' : 'Brain config saved');
      await load();
      onFinished?.();
    } catch (err) {
      const shaped = err as { code?: string; details?: unknown; activeAtomCount?: number; estimateSeconds?: number; message?: string };
      if (shaped?.code === 'VALIDATION_FAILED') {
        toast.error('Could not save Brain config', apiErrorMessage(err));
      } else if (typeof shaped?.activeAtomCount === 'number') {
        setPendingMigration({
          activeAtomCount: shaped.activeAtomCount,
          estimateSeconds: typeof shaped.estimateSeconds === 'number' ? shaped.estimateSeconds : 120,
          message: shaped.message ?? 'Changing embedding provider requires re-embedding existing atoms.',
        });
      } else {
        const maybe = err as { message?: string; activeAtomCount?: number; estimateSeconds?: number };
        if (typeof maybe.activeAtomCount === 'number') {
          setPendingMigration({
            activeAtomCount: maybe.activeAtomCount,
            estimateSeconds: maybe.estimateSeconds ?? 120,
            message: maybe.message ?? 'Changing embedding provider requires re-embedding existing atoms.',
          });
        } else {
          toast.error('Could not save Brain config', apiErrorMessage(err));
        }
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    const content = (
        <div className="mx-auto max-w-6xl space-y-4">
          <Skeleton height={92} />
          <Skeleton height={420} />
        </div>
    );
    return embedded
      ? <section className="px-5 py-4">{content}</section>
      : <main className="h-full overflow-y-auto px-6 py-5">{content}</main>;
  }

  const content = (
      <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-4">
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Brain Config</div>
                <h2 className="mt-2 text-[24px] font-semibold text-text-primary">Memory retrieval setup</h2>
                <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-text-muted">
                  Configure the embedding model that turns Brain atoms into searchable memory. Local Ollama is the fastest safe default for a workstation.
                </p>
              </div>
              <StatusPill degraded={config?.degraded ?? true} provider={config?.embeddingProviderType ?? 'hashing'} />
            </div>
          </div>

          <div className="rounded-card border border-line bg-surface">
            <div className="grid border-b border-line md:grid-cols-2">
              <StepButton active={step === 1} index="1" title="Embedding model" detail="Memory retrieval" onClick={() => setStep(1)} />
              <StepButton active={step === 2} index="2" title="Background model" detail="Dreaming and learning" onClick={() => setStep(2)} />
            </div>

            {step === 1 ? (
              <div className="space-y-5 p-5">
                <ProviderOption
                  active={provider === 'ollama'}
                  icon={<Server size={17} />}
                  title="Ollama"
                  detail="Local, free, recommended for private workspaces"
                  onClick={() => {
                    setProvider('ollama');
                    setEndpoint('http://localhost:11434');
                    setModel('nomic-embed-text');
                    setVerify(null);
                  }}
                />
                {provider === 'ollama' && (
                  <ProviderFields
                    endpoint={endpoint}
                    model={model}
                    onEndpoint={setEndpoint}
                    onModel={setModel}
                    testing={testing}
                    verify={verify}
                    onTest={() => void testConnection()}
                  />
                )}

                <ProviderOption
                  active={provider === 'openai'}
                  icon={<Zap size={17} />}
                  title="OpenAI"
                  detail="Hosted semantic embeddings for cloud-first teams"
                  onClick={() => {
                    setProvider('openai');
                    setEndpoint('https://api.openai.com/v1');
                    setModel('text-embedding-3-small');
                    setVerify(null);
                  }}
                />
                {provider === 'openai' && (
                  <div className="space-y-4 pl-9">
                    <ProviderFields endpoint={endpoint} model={model} onEndpoint={setEndpoint} onModel={setModel} testing={testing} verify={verify} onTest={() => void testConnection()} />
                    <Field label="API key" helper={config?.embeddingProviderConfig.apiKeySet ? 'A saved key exists. Enter a new key only if you want to replace it.' : 'Stored server-side; never returned to the browser.'}>
                      <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="sk-..." className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent" />
                    </Field>
                  </div>
                )}

                <ProviderOption
                  active={provider === 'hashing'}
                  icon={<Cpu size={17} />}
                  title="Skip for now"
                  detail="Use degraded keyword matching until an embedding model is configured"
                  onClick={() => {
                    setProvider('hashing');
                    setVerify(null);
                  }}
                />

                <div className="flex justify-end">
                  <Button variant="primary" size="md" onClick={() => setStep(2)}>
                    Next
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-5 p-5">
                <ProviderOption
                  active={backgroundMode === 'main'}
                  icon={<Settings2 size={17} />}
                  title="Same as my main adapter"
                  detail="Recommended now. Zero extra config; background intelligence will use the runtime you already trust."
                  onClick={() => setBackgroundMode('main')}
                />
                <ProviderOption
                  active={backgroundMode === 'lighter'}
                  icon={<Cpu size={17} />}
                  title="Lighter model"
                  detail="Prepared for Dreaming Phase 4 and auto-dispute resolution. Form is reserved until the auxiliary client ships."
                  onClick={() => setBackgroundMode('lighter')}
                />
                {backgroundMode === 'lighter' && (
                  <div className="rounded-card border border-dashed border-line bg-surface-2/40 p-4 text-[13px] text-text-muted">
                    Used by: Dreaming (Phase 4), Auto-dispute resolution. The backend auxiliary adapter client is still gated, so this mode is saved as intent only.
                  </div>
                )}

                {pendingMigration && (
                  <div className="rounded-card border border-amber-400/30 bg-amber-500/10 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={17} className="mt-0.5 text-amber-300" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-amber-100">Provider switch needs re-embedding</div>
                        <p className="mt-1 text-[13px] leading-relaxed text-amber-100/80">
                          {pendingMigration.message} Brain retrieval pauses during the migration and resumes when {pendingMigration.activeAtomCount} atoms finish.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="primary" loading={saving} onClick={() => void save(true)}>Confirm switch</Button>
                          <Button size="sm" variant="ghost" onClick={() => setPendingMigration(null)}>Cancel</Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <Button variant="ghost" size="md" iconLeft={<ArrowLeft size={13} />} onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button variant="primary" size="md" loading={saving} onClick={() => void save(false)}>
                    Finish setup
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
              <Lock size={13} /> Current State
            </div>
            <dl className="mt-4 space-y-3 text-[13px]">
              <Metric label="Provider" value={config?.embeddingProviderType ?? 'hashing'} />
              <Metric label="Atoms" value={String(config?.activeAtomCount ?? 0)} />
              <Metric label="Quality" value={config?.degraded ? 'Degraded' : 'Semantic'} tone={config?.degraded ? 'warn' : 'ok'} />
            </dl>
          </div>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">What This Unlocks</div>
            <ul className="mt-3 space-y-2 text-[13px] text-text-secondary">
              <li>Semantic atom retrieval instead of keyword-only matching.</li>
              <li>Higher-quality peer representation dreaming.</li>
              <li>Cleaner ability and memory ranking for dispatch.</li>
            </ul>
          </div>
        </aside>
      </div>
  );
  return embedded
    ? <section className="px-5 py-4">{content}</section>
    : <main className="h-full overflow-y-auto px-6 py-5">{content}</main>;
}

function StatusPill({ degraded, provider }: { degraded: boolean; provider: string }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium ${degraded ? 'bg-amber-500/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-200'}`}>
      {degraded ? <AlertTriangle size={13} /> : <Check size={13} />}
      {degraded ? 'Degraded' : provider}
    </span>
  );
}

function StepButton({ active, index, title, detail, onClick }: { active: boolean; index: string; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-3 px-5 py-4 text-left transition-colors ${active ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-primary'}`}>
      <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-semibold ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line'}`}>{index}</span>
      <span>
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12px] text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function ProviderOption({ active, icon, title, detail, onClick }: { active: boolean; icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-start gap-3 rounded-card border p-4 text-left transition ${active ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface-2/30 hover:border-text-muted/40'}`}>
      <span className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full ${active ? 'bg-accent text-accent-contrast' : 'bg-surface text-text-muted'}`}>{active ? <Check size={15} /> : icon}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-text-primary">{title}</span>
        <span className="mt-1 block text-[12px] leading-relaxed text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function ProviderFields(props: {
  endpoint: string;
  model: string;
  onEndpoint: (value: string) => void;
  onModel: (value: string) => void;
  testing: boolean;
  verify: VerifyResult | null;
  onTest: () => void;
}) {
  return (
    <div className="space-y-4 pl-9">
      <Field label="Endpoint">
        <input value={props.endpoint} onChange={(event) => props.onEndpoint(event.target.value)} className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary outline-none focus:border-accent" />
      </Field>
      <Field label="Model">
        <input value={props.model} onChange={(event) => props.onModel(event.target.value)} className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary outline-none focus:border-accent" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" loading={props.testing} iconLeft={props.testing ? <Loader2 size={13} /> : <Radio size={13} />} onClick={props.onTest}>
          Test
        </Button>
        {props.verify && (
          <span className={`text-[12px] ${props.verify.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
            {props.verify.ok ? `${props.verify.dimension ?? 'Unknown'} dimensions, ${props.verify.latencyMs}ms` : props.verify.error}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, helper, children }: { label: string; helper?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
      {helper && <span className="block text-[11px] text-text-muted">{helper}</span>}
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className={tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-text-primary'}>{value}</dd>
    </div>
  );
}
