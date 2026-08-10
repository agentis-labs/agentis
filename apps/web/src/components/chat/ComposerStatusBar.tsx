import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

export interface RuntimeContext {
  provider: string;
  models: { id: string; label: string; recommended?: boolean; legacy?: boolean }[];
  currentModel: string;
  efforts?: { id: string; label: string }[];
  currentEffort?: string;
  fastModeSupported?: boolean;
  fastModeEnabled?: boolean;
  contextWindow?: { text: string; percentage: number };
  usage?: Array<{
    label: string;
    percentage: number;
    resetText?: string;
    valueText?: string;
    color?: 'red' | 'blue' | 'green' | 'default';
  }>;
}

interface AgentRuntimeShape {
  id: string;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
}

export function ComposerStatusBar({ agentId, className }: { agentId: string; className?: string }) {
  const toast = useToast();
  const [context, setContext] = useState<RuntimeContext | null>(null);
  const [agent, setAgent] = useState<AgentRuntimeShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [runtime, agentResult] = await Promise.all([
          api<RuntimeContext>(`/v1/agents/${agentId}/runtime-context`),
          api<{ agent: AgentRuntimeShape }>(`/v1/agents/${agentId}`),
        ]);
        if (!mounted) return;
        setContext(runtime);
        setAgent(agentResult.agent);
      } catch {
        if (mounted) setContext(null);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [agentId]);

  useEffect(() => {
    function refresh(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId !== agentId) return;
      void api<RuntimeContext>(`/v1/agents/${agentId}/runtime-context`).then(setContext).catch(() => {});
    }
    window.addEventListener('agentis:agent-model-updated', refresh);
    return () => window.removeEventListener('agentis:agent-model-updated', refresh);
  }, [agentId]);

  const modelLabel = useMemo(() => {
    if (!context) return '';
    return context.models.find((model) => model.id === context.currentModel)?.label || context.currentModel;
  }, [context]);
  const effortLabel = context?.efforts?.find((effort) => effort.id === context.currentEffort)?.label || context?.currentEffort;

  if (loading && !context) {
    return <div className={clsx('flex items-center gap-1.5 px-1.5 text-[11px] text-text-muted', className)}><Loader2 size={11} className="animate-spin" /><span>Runtime</span></div>;
  }
  if (!context || !agent) return null;

  const runtimeContext = context;
  const runtimeAgent = agent;
  const adapterType = runtimeAgent.adapterType ?? null;
  const config = runtimeAgent.config ?? {};
  const canEditEffort = (adapterType === 'codex' || adapterType === 'antigravity') && Boolean(runtimeContext.efforts?.length);

  async function save(nextConfig: Record<string, unknown>, runtimeModel?: string | null) {
    const previousAgent = runtimeAgent;
    const previousContext = runtimeContext;
    setSaving(true);
    try {
      await api(`/v1/agents/${runtimeAgent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: nextConfig, ...(runtimeModel !== undefined ? { runtimeModel } : {}) }),
      });
      setAgent({ ...runtimeAgent, config: nextConfig, runtimeModel: runtimeModel ?? runtimeAgent.runtimeModel ?? null });
      window.dispatchEvent(new CustomEvent('agentis:agent-model-updated', { detail: { agentId: runtimeAgent.id, model: runtimeModel ?? null } }));
    } catch (error) {
      setAgent(previousAgent);
      setContext(previousContext);
      toast.error('Runtime update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function updateModel(nextModel: string) {
    const previous = runtimeContext.currentModel;
    const nextConfig = { ...config };
    const runtimeModel = adapterType === 'antigravity' && runtimeContext.currentEffort
      ? `${nextModel.replace(/\s*\((?:high|medium|low)\)$/i, '')} (${capitalize(runtimeContext.currentEffort)})`
      : nextModel;
    if (runtimeModel) nextConfig.model = runtimeModel;
    else delete nextConfig.model;
    setContext({ ...runtimeContext, currentModel: nextModel || previous });
    await save(nextConfig, runtimeModel || null);
  }

  async function updateEffort(nextEffort: string) {
    const nextConfig: Record<string, unknown> = { ...config, modelReasoningEffort: nextEffort };
    setContext({ ...runtimeContext, currentEffort: nextEffort });
    if (adapterType === 'antigravity' && runtimeContext.currentModel) {
      const runtimeModel = `${runtimeContext.currentModel.replace(/\s*\((?:high|medium|low)\)$/i, '')} (${capitalize(nextEffort)})`;
      nextConfig.model = runtimeModel;
      await save(nextConfig, runtimeModel);
      return;
    }
    await save(nextConfig);
  }

  async function updateSpeed(fast: boolean) {
    setContext({ ...runtimeContext, fastModeEnabled: fast });
    await save({ ...config, fastMode: fast });
  }

  const trigger = [compactModel(modelLabel), effortLabel].filter(Boolean).join(' · ');
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label="Model and response settings"
          className={clsx(
            'inline-flex max-w-[220px] min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-secondary outline-none transition hover:bg-surface-3 hover:text-text-primary focus-visible:ring-1 focus-visible:ring-accent/45 disabled:opacity-60',
            className,
          )}
        >
          <span className="truncate">{saving ? 'Saving…' : trigger}</span>
          {saving ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} className="shrink-0 text-text-muted" />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="z-[90] w-64 rounded-xl border border-line/80 bg-[#252526] p-1.5 shadow-modal outline-none">
          <SettingSubmenu label="Model" value={compactModel(modelLabel)}>
            {runtimeContext.models.map((model) => (
              <Choice key={model.id} selected={model.id === runtimeContext.currentModel} onSelect={() => void updateModel(model.id)}>
                <span className="min-w-0 truncate">{model.label}</span>
                {model.legacy && <span className="ml-1 text-[9px] text-text-muted">Legacy</span>}
              </Choice>
            ))}
          </SettingSubmenu>

          {canEditEffort && effortLabel && (
            <SettingSubmenu label="Effort" value={effortLabel}>
              {runtimeContext.efforts?.map((effort) => (
                <Choice key={effort.id} selected={effort.id === runtimeContext.currentEffort} onSelect={() => void updateEffort(effort.id)}>
                  {effort.label}
                </Choice>
              ))}
            </SettingSubmenu>
          )}

          {runtimeContext.fastModeSupported && (
            <SettingSubmenu label="Speed" value={runtimeContext.fastModeEnabled ? 'Fast' : 'Standard'}>
              <Choice selected={!runtimeContext.fastModeEnabled} onSelect={() => void updateSpeed(false)}>Standard</Choice>
              <Choice selected={Boolean(runtimeContext.fastModeEnabled)} onSelect={() => void updateSpeed(true)}>Fast</Choice>
            </SettingSubmenu>
          )}

          {(runtimeContext.contextWindow || runtimeContext.usage?.length) && (
            <>
              <DropdownMenu.Separator className="my-1.5 h-px bg-line/60" />
              <div className="space-y-2 px-2 py-1.5">
                {runtimeContext.contextWindow && <Usage label="Context" value={runtimeContext.contextWindow.text} percentage={runtimeContext.contextWindow.percentage} />}
                {runtimeContext.usage?.map((item) => <Usage key={item.label} label={item.label} value={item.valueText ?? item.resetText ?? `${item.percentage}%`} percentage={item.percentage} />)}
              </div>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SettingSubmenu({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-[12px] text-text-primary outline-none data-[state=open]:bg-surface-3 hover:bg-surface-3">
        <span>{label}</span>
        <span className="ml-auto max-w-28 truncate text-text-muted">{value}</span>
        <ChevronRight size={12} className="text-text-muted" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={6} alignOffset={-5} className="z-[91] max-h-[360px] min-w-56 overflow-y-auto rounded-xl border border-line/80 bg-[#252526] p-1.5 shadow-modal outline-none">
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function Choice({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <DropdownMenu.Item
      onSelect={(event) => { event.preventDefault(); onSelect(); }}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-text-secondary outline-none hover:bg-surface-3 hover:text-text-primary"
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <Check size={13} className="shrink-0 text-text-primary" />}
    </DropdownMenu.Item>
  );
}

function Usage({ label, value, percentage }: { label: string; value: string; percentage: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-text-muted"><span>{label}</span><span>{value}</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-black/30"><div className="h-full rounded-full bg-info/75" style={{ width: `${Math.max(2, Math.min(100, percentage))}%` }} /></div>
    </div>
  );
}

function compactModel(value: string): string {
  return value.replace(/^gpt-/i, '').replace(/-codex$/i, ' Codex');
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
