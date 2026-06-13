import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Cpu, Image, Loader2, Mic, Radio, Sparkles, Zap } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

type ProviderType = 'hashing' | 'openai';
interface IntelligenceConfig {
  embeddingProviderType: ProviderType;
  embeddingProviderConfig: { endpoint?: string; model?: string; apiKeySet?: boolean };
  enrichmentConfig?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    apiKeySet?: boolean;
    visualDescriptions?: boolean;
    visionModel?: string;
    audioTranscription?: boolean;
    transcriptionModel?: string;
  };
  activeAtomCount: number;
  degraded: boolean;
}
interface VerifyResult { ok: boolean; dimension?: number; latencyMs: number; error?: string }
interface PendingMigration { activeAtomCount: number; estimateSeconds: number; message: string }

export function BrainConfigWizard({ embedded = false, onFinished }: { embedded?: boolean; onFinished?: () => void } = {}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingEmbedding, setTestingEmbedding] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [config, setConfig] = useState<IntelligenceConfig | null>(null);
  const [pendingMigration, setPendingMigration] = useState<PendingMigration | null>(null);
  const [provider, setProvider] = useState<ProviderType>('hashing');
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('text-embedding-3-small');
  const [embeddingKey, setEmbeddingKey] = useState('');
  const [embeddingTest, setEmbeddingTest] = useState<VerifyResult | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiEndpoint, setAiEndpoint] = useState('https://api.openai.com/v1');
  const [aiModel, setAiModel] = useState('gpt-4o-mini');
  const [aiKey, setAiKey] = useState('');
  const [aiTest, setAiTest] = useState<VerifyResult | null>(null);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModel, setVisionModel] = useState('gpt-4o-mini');
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioModel, setAudioModel] = useState('gpt-4o-mini-transcribe');

  async function load() {
    setLoading(true);
    try {
      const data = await api<IntelligenceConfig>('/v1/workspace/intelligence');
      setConfig(data);
      setProvider(data.embeddingProviderType);
      setEndpoint(data.embeddingProviderConfig.endpoint ?? 'https://api.openai.com/v1');
      setModel(data.embeddingProviderConfig.model ?? 'text-embedding-3-small');
      const ai = data.enrichmentConfig ?? {};
      setAiEnabled(Boolean(ai.enabled));
      setAiEndpoint(ai.baseUrl ?? 'https://api.openai.com/v1');
      setAiModel(ai.model ?? 'gpt-4o-mini');
      setVisionEnabled(Boolean(ai.visualDescriptions));
      setVisionModel(ai.visionModel ?? 'gpt-4o-mini');
      setAudioEnabled(Boolean(ai.audioTranscription));
      setAudioModel(ai.transcriptionModel ?? 'gpt-4o-mini-transcribe');
    } catch (error) {
      toast.error('Could not load Brain settings', apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const embeddingConfig = useMemo(() => provider === 'hashing' ? {} : {
    endpoint: endpoint.trim(),
    model: model.trim(),
    ...(provider === 'openai' && embeddingKey.trim() ? { apiKey: embeddingKey.trim() } : {}),
  }, [embeddingKey, endpoint, model, provider]);
  const enrichmentConfig = {
    enabled: aiEnabled,
    ...(aiEnabled ? {
      baseUrl: aiEndpoint.trim(),
      model: aiModel.trim(),
      ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {}),
      visualDescriptions: visionEnabled,
      ...(visionEnabled ? { visionModel: visionModel.trim() } : {}),
      audioTranscription: audioEnabled,
      ...(audioEnabled ? { transcriptionModel: audioModel.trim() } : {}),
    } : { visualDescriptions: false, audioTranscription: false }),
  };

  async function testEmbedding() {
    setTestingEmbedding(true);
    try {
      const result = await api<VerifyResult>('/v1/workspace/intelligence/embedding/verify', {
        method: 'POST',
        body: JSON.stringify({ embeddingProviderType: provider, embeddingProviderConfig: embeddingConfig }),
      });
      setEmbeddingTest(result);
      result.ok ? toast.success('Retrieval model connected') : toast.error('Retrieval model failed', result.error ?? 'Unknown error');
    } catch (error) {
      setEmbeddingTest({ ok: false, latencyMs: 0, error: apiErrorMessage(error) });
    } finally {
      setTestingEmbedding(false);
    }
  }

  async function testAi() {
    setTestingAi(true);
    try {
      const result = await api<VerifyResult>('/v1/workspace/intelligence/enrichment/verify', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: aiEndpoint.trim(), model: aiModel.trim(), ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {}) }),
      });
      setAiTest(result);
      result.ok ? toast.success('AI enhancements connected') : toast.error('AI test failed', result.error ?? 'Unknown error');
    } catch (error) {
      setAiTest({ ok: false, latencyMs: 0, error: apiErrorMessage(error) });
    } finally {
      setTestingAi(false);
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
          embeddingProviderConfig: embeddingConfig,
          enrichmentConfig,
          confirmMigration,
        }),
      });
      if ('requiresConfirmation' in result) {
        setPendingMigration(result);
        return;
      }
      toast.success(result.migrationQueued ? 'Brain saved; re-indexing started' : 'Brain settings saved');
      await load();
      onFinished?.();
    } catch (error) {
      toast.error('Could not save Brain settings', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="space-y-4 p-5"><Skeleton height={100} /><Skeleton height={480} /></section>;
  const content = (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-semibold text-text-primary">Brain capabilities</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-muted">Retrieval works alone. AI enhancements are optional and apply immediately after saving.</p>
          </div>
          <Status degraded={config?.degraded ?? true} />
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface p-4">
        <Header title="Semantic retrieval" description="Find related memories even when the words differ." />
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Choice active={provider === 'hashing'} icon={<Cpu size={14} />} title="Keyword" onClick={() => setProvider('hashing')} />
          <Choice active={provider === 'openai'} icon={<Zap size={14} />} title="OpenAI" onClick={() => { setProvider('openai'); setEndpoint('https://api.openai.com/v1'); setModel('text-embedding-3-small'); }} />
        </div>
        {provider !== 'hashing' && (
          <div className="mt-3 space-y-2">
            <TextField label="Endpoint" value={endpoint} onChange={setEndpoint} />
            <TextField label="Embedding model" value={model} onChange={setModel} />
            {provider === 'openai' && <SecretField label="API key" value={embeddingKey} onChange={setEmbeddingKey} saved={Boolean(config?.embeddingProviderConfig.apiKeySet)} />}
            <TestRow loading={testingEmbedding} result={embeddingTest} onTest={() => void testEmbedding()} />
          </div>
        )}
      </section>

      <section className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <Header title="AI enhancements" description="Grounded summaries, exploratory expansion, and typed relationships." icon={<Sparkles size={14} />} />
          <Toggle checked={aiEnabled} onChange={setAiEnabled} />
        </div>
        {aiEnabled && (
          <div className="mt-3 space-y-2">
            <TextField label="Model endpoint" value={aiEndpoint} onChange={setAiEndpoint} />
            <TextField label="Generation model" value={aiModel} onChange={setAiModel} />
            <SecretField label="API key" value={aiKey} onChange={setAiKey} saved={Boolean(config?.enrichmentConfig?.apiKeySet)} />
            <TestRow loading={testingAi} result={aiTest} onTest={() => void testAi()} />
            <Capability icon={<Image size={15} />} title="Image descriptions" detail="Only when a user selects image description during upload." checked={visionEnabled} onChange={setVisionEnabled}>
              {visionEnabled && <TextField label="Vision model" value={visionModel} onChange={setVisionModel} />}
            </Capability>
            <Capability icon={<Mic size={15} />} title="Audio transcription" detail="Transcribe uploaded recordings into searchable text." checked={audioEnabled} onChange={setAudioEnabled}>
              {audioEnabled && <TextField label="Transcription model" value={audioModel} onChange={setAudioModel} />}
            </Capability>
          </div>
        )}
      </section>

      {pendingMigration && (
        <section className="rounded-card border border-amber-400/30 bg-amber-500/10 p-4 text-[12px] text-amber-100">
          <div className="flex gap-2"><AlertTriangle size={15} className="shrink-0 text-amber-300" /><span>{pendingMigration.message} {pendingMigration.activeAtomCount} atoms will be re-indexed.</span></div>
          <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" loading={saving} onClick={() => void save(true)}>Confirm and save</Button><Button size="sm" variant="ghost" onClick={() => setPendingMigration(null)}>Cancel</Button></div>
        </section>
      )}
      <div className="sticky bottom-0 flex items-center justify-between border-t border-line bg-canvas/95 py-3 backdrop-blur">
        <span className="text-[12px] text-text-muted">{config?.activeAtomCount ?? 0} indexed atoms</span>
        <Button variant="primary" loading={saving} onClick={() => void save(false)}>Save settings</Button>
      </div>
    </div>
  );
  return embedded ? <section className="p-5">{content}</section> : <main className="h-full overflow-y-auto px-6 py-5">{content}</main>;
}

function Header({ title, description, icon }: { title: string; description: string; icon?: React.ReactNode }) {
  return <div><h3 className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">{icon}{title}</h3><p className="mt-1 text-[12px] text-text-muted">{description}</p></div>;
}
function Status({ degraded }: { degraded: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[11px] font-medium ${degraded ? 'bg-amber-500/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-300'}`}>{degraded ? <AlertTriangle size={12} /> : <Check size={12} />}{degraded ? 'Keyword' : 'Semantic'}</span>;
}
function Choice({ active, icon, title, onClick }: { active: boolean; icon: React.ReactNode; title: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex h-10 items-center justify-center gap-1.5 rounded-input border text-[12px] ${active ? 'border-accent bg-accent-soft text-text-primary' : 'border-line bg-surface-2 text-text-muted'}`}>{icon}{title}</button>;
}
function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-text-muted">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[12px] text-text-primary outline-none focus:border-accent" /></label>;
}
function SecretField({ label, value, onChange, saved }: { label: string; value: string; onChange: (value: string) => void; saved: boolean }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-text-muted">{label}{saved ? ' - saved; leave blank to keep' : ''}</span><input type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={saved ? 'Saved key' : 'Optional for local endpoints'} className="h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary outline-none focus:border-accent" /></label>;
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'left-6' : 'left-1'}`} /></button>;
}
function TestRow({ loading, result, onTest }: { loading: boolean; result: VerifyResult | null; onTest: () => void }) {
  return <div className="flex items-center gap-3 py-1"><Button size="sm" variant="secondary" iconLeft={loading ? <Loader2 size={12} /> : <Radio size={12} />} loading={loading} onClick={onTest}>Test connection</Button>{result && <span className={`text-[11px] ${result.ok ? 'text-emerald-300' : 'text-danger'}`}>{result.ok ? `Connected - ${result.latencyMs}ms` : result.error}</span>}</div>;
}
function Capability({ icon, title, detail, checked, onChange, children }: { icon: React.ReactNode; title: string; detail: string; checked: boolean; onChange: (value: boolean) => void; children?: React.ReactNode }) {
  return <div className="mt-3 rounded-input border border-line bg-surface-2 p-3"><div className="flex items-start justify-between gap-3"><div><p className="flex items-center gap-2 text-[13px] font-medium text-text-primary">{icon}{title}</p><p className="mt-1 text-[11px] leading-4 text-text-muted">{detail}</p></div><Toggle checked={checked} onChange={onChange} /></div>{checked && <div className="mt-3">{children}</div>}</div>;
}
