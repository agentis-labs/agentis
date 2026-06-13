/**
 * AbilityCompileConfigDrawer - workspace-level model picker for ability compilation.
 *
 * The compile worker itself calls an OpenAI-compatible chat endpoint. Model
 * choices come from the same runtime catalog used by agent commissioning, so
 * this screen does not maintain a separate hand-written list.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Cpu, Loader2, Search, Sparkles, Zap } from 'lucide-react';
import { Drawer } from '../shared/Drawer';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import {
  abilitiesApi,
  estimateCompileTokens,
  type CompileConfigResponse,
} from '../../lib/abilities';
import { api, apiErrorMessage } from '../../lib/api';
import type { RuntimeModelOption } from '../agents/ModelChooser';
import type { AdapterType } from '../agents/RuntimePicker';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type CompileMode = 'template' | 'semantic_api';

interface RuntimeModelCatalog {
  adapterType: AdapterType;
  defaultModel: string | null;
  defaultLabel: string;
  supportsManual: boolean;
  models: RuntimeModelOption[];
}

const MODEL_CATALOGS: Array<{ value: AdapterType; label: string; detail: string }> = [
  { value: 'codex', label: 'Codex / OpenAI', detail: 'Models exposed by the Codex runtime and OpenAI account.' },
  { value: 'claude_code', label: 'Claude Code', detail: 'Models exposed by the Claude Code runtime.' },
  { value: 'cursor', label: 'Cursor', detail: 'Models exposed by Cursor Agent.' },
  { value: 'hermes_agent', label: 'Hermes', detail: 'Models exposed by Hermes Agent.' },
  { value: 'openclaw', label: 'OpenClaw', detail: 'Models exposed by the selected gateway.' },
  { value: 'http', label: 'HTTP', detail: 'Models exposed by a configured HTTP endpoint.' },
];

export function AbilityCompileConfigDrawer({ open, onClose, onSaved }: Props) {
  const toast = useToast();
  const [config, setConfig] = useState<CompileConfigResponse | null>(null);
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [mode, setMode] = useState<CompileMode>('template');
  const [adapterType, setAdapterType] = useState<AdapterType>('codex');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    abilitiesApi.getCompileConfig().then((cfg) => {
      setConfig(cfg);
      const ws = cfg.workspace;
      const nextAdapter = normalizeAdapter(ws?.adapterType ?? cfg.catalog.adapterType ?? 'codex');
      setMode(cfg.hasModel ? 'semantic_api' : 'template');
      setAdapterType(nextAdapter);
      setBaseUrl(ws?.baseUrl ?? cfg.env?.baseUrl ?? 'https://api.openai.com/v1');
      setModel(ws?.model ?? cfg.env?.model ?? '');
      setApiKey('');
      setApiKeyTouched(false);
      setModelQuery('');
    }).catch((err) => {
      toast.error('Could not load compile config', apiErrorMessage(err));
    }).finally(() => setLoading(false));
  }, [open, toast]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalogLoading(true);
    api<RuntimeModelCatalog>(`/v1/harness/models/${adapterType}`)
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog({
            adapterType,
            defaultModel: null,
            defaultLabel: 'Runtime catalog unavailable',
            supportsManual: true,
            models: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [adapterType, open]);

  const cost = estimateCompileTokens();

  const filteredModels = useMemo(() => {
    const models = catalog?.models ?? [];
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((item) => (
      item.id.toLowerCase().includes(q)
      || item.label.toLowerCase().includes(q)
      || item.provider.toLowerCase().includes(q)
    ));
  }, [catalog, modelQuery]);

  const activeModel = (catalog?.models ?? []).find((item) => item.id === model);
  const canSaveSemantic = Boolean(baseUrl.trim() && model.trim());

  async function handleSave() {
    setSaving(true);
    try {
      if (mode === 'template') {
        await abilitiesApi.setCompileConfig({ baseUrl: null, model: null, apiKey: null });
        toast.success('Compile set to template fallback');
      } else {
        await abilitiesApi.setCompileConfig({
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKeyTouched ? apiKey : undefined,
          adapterType,
        });
        toast.success('Semantic compile model saved');
      }
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error('Save failed', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={(
        <span className="flex items-center gap-2">
          <Cpu size={15} className="text-accent" /> Compile model
        </span>
      )}
      subtitle="Choose template fallback or a direct semantic model for ability compilation."
      footer={(
        <div className="flex items-center justify-between gap-2 w-full">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode('template')}
            disabled={saving || loading}
          >
            Use template fallback
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              loading={saving}
              disabled={saving || loading || (mode === 'semantic_api' && !canSaveSemantic)}
              iconLeft={<Check size={13} />}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-5 p-5">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 rounded" />
            <Skeleton className="h-24 rounded" />
            <Skeleton className="h-40 rounded" />
          </div>
        ) : (
          <>
            <section className="rounded-xl border border-accent/30 bg-accent/5 p-4">
              <header className="flex items-center gap-2 mb-2">
                <Sparkles size={13} className="text-accent" />
                <span className="text-[12px] font-bold text-accent uppercase tracking-wider">
                  How this works
                </span>
              </header>
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Compile can run for free with the deterministic template, or call a direct
                OpenAI-compatible chat endpoint to synthesize a richer persona and examples.
                Model choices below come from the same runtime catalogs used by agents.
                Semantic compile spends roughly{' '}
                <span className="font-bold text-text-primary">{cost.min.toLocaleString()}-{cost.max.toLocaleString()} tokens</span>.
              </p>
            </section>

            <section className="grid grid-cols-2 gap-2">
              <ModeButton
                selected={mode === 'template'}
                icon={<Zap size={14} />}
                title="Template fallback"
                body="No model, no API key, no token spend. Uses specs and rules directly."
                onClick={() => setMode('template')}
              />
              <ModeButton
                selected={mode === 'semantic_api'}
                icon={<Cpu size={14} />}
                title="Semantic API"
                body="Calls an OpenAI-compatible endpoint for persona and synthetic examples."
                onClick={() => setMode('semantic_api')}
              />
            </section>

            {config?.env && !config.workspace && mode === 'semantic_api' && (
              <section className="rounded-xl border border-line bg-surface-2/40 p-4 text-[12px] text-text-secondary">
                <header className="flex items-center gap-2 mb-1.5">
                  <AlertCircle size={12} className="text-text-muted" />
                  <span className="font-bold text-text-primary">Currently using server default</span>
                </header>
                <span className="font-mono text-[11px] text-text-muted block">
                  {config.env.model} @ {config.env.baseUrl}
                </span>
              </section>
            )}

            {mode === 'semantic_api' && (
              <>
                <section>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1.5">
                    Model catalog
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {MODEL_CATALOGS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setAdapterType(opt.value);
                          setModelQuery('');
                        }}
                        className={`rounded-input border px-3 py-2 text-left transition-all ${
                          adapterType === opt.value
                            ? 'border-accent bg-accent/10'
                            : 'border-line bg-surface-2 hover:border-line-strong'
                        }`}
                      >
                        <span className={`block text-[12px] font-bold ${adapterType === opt.value ? 'text-accent' : 'text-text-primary'}`}>
                          {opt.label}
                        </span>
                        <span className="mt-0.5 block text-[10.5px] leading-snug text-text-muted">{opt.detail}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1.5">
                    Model
                  </label>
                  <div className="rounded-xl border border-line bg-surface-2/45">
                    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                      <Search size={13} className="text-text-muted" />
                      <input
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder="Search runtime models or type a custom id"
                        className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1.5">
                      {catalogLoading ? (
                        <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-text-muted">
                          <Loader2 size={12} className="animate-spin" /> Loading models...
                        </div>
                      ) : filteredModels.length > 0 ? (
                        filteredModels.map((item) => (
                          <ModelRow
                            key={item.id}
                            model={item}
                            selected={model === item.id}
                            onClick={() => setModel(item.id)}
                          />
                        ))
                      ) : (
                        <div className="px-2 py-3 text-[11px] text-text-muted">
                          No catalog models matched. Use the custom model id field below.
                        </div>
                      )}
                    </div>
                  </div>
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={catalog?.defaultModel || 'gpt-4o-mini'}
                    className="mt-2 h-9 w-full rounded-input border border-line/60 bg-surface-2/60 px-3 text-[11.5px] text-text-secondary placeholder:text-text-muted focus:border-accent focus:outline-none transition-all"
                  />
                  <span className="mt-1 block text-[10px] text-text-muted">
                    Selected: {activeModel?.label ?? (model || 'No model selected')}.
                  </span>
                </section>

                <section>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1.5">
                    OpenAI-compatible base URL
                  </label>
                  <input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all"
                  />
                  <span className="text-[10px] text-text-muted mt-1 block">
                    The compiler calls `/chat/completions` on this endpoint. Use OpenAI or a compatible local/proxy server.
                  </span>
                </section>

                <section>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted block mb-1.5">
                    API key {config?.workspace?.hasApiKey && (
                      <span className="ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-accent/15 text-accent uppercase">stored</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => { setApiKey(event.target.value); setApiKeyTouched(true); }}
                    placeholder={config?.workspace?.hasApiKey ? 'Stored key - leave blank to keep current' : 'Optional for local endpoints'}
                    autoComplete="off"
                    className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[12px] text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all"
                  />
                </section>
              </>
            )}

            {saving && (
              <div className="flex items-center gap-2 text-[11px] text-text-muted">
                <Loader2 size={12} className="animate-spin" /> Saving...
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function ModeButton({
  selected,
  icon,
  title,
  body,
  onClick,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition-all ${
        selected ? 'border-accent bg-accent/10' : 'border-line bg-surface-2/45 hover:border-line-strong'
      }`}
    >
      <span className={`mb-2 flex h-7 w-7 items-center justify-center rounded-lg ${selected ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-text-muted'}`}>
        {icon}
      </span>
      <span className={`block text-[12px] font-bold ${selected ? 'text-accent' : 'text-text-primary'}`}>{title}</span>
      <span className="mt-1 block text-[10.5px] leading-snug text-text-muted">{body}</span>
    </button>
  );
}

function ModelRow({
  model,
  selected,
  onClick,
}: {
  model: RuntimeModelOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
        selected ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent text-accent' : 'border-line text-transparent'}`}>
        <Check size={11} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold">{model.label}</span>
        <span className="block truncate text-[10.5px] text-text-muted">{model.description ?? model.id}</span>
      </span>
      <span className="shrink-0 rounded-full border border-line bg-canvas px-1.5 py-0.5 text-[9px] font-bold uppercase text-text-muted">
        {model.recommended ? 'Recommended' : model.tier ?? model.provider}
      </span>
    </button>
  );
}

function normalizeAdapter(value: string | null | undefined): AdapterType {
  return MODEL_CATALOGS.some((item) => item.value === value) ? value as AdapterType : 'codex';
}
