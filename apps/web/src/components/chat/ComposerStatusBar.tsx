import { useEffect, useState, useRef } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
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
  contextWindow?: {
    text: string;
    percentage: number;
  };
  usage?: {
    label: string;
    percentage: number;
    resetText?: string;
    valueText?: string;
    color?: 'red' | 'blue' | 'green' | 'default';
  }[];
}

interface Props {
  agentId: string;
  className?: string;
}

interface AgentRuntimeShape {
  id: string;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
}

export function ComposerStatusBar({ agentId, className }: Props) {
  const toast = useToast();
  const [context, setContext] = useState<RuntimeContext | null>(null);
  const [agent, setAgent] = useState<AgentRuntimeShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'usage' | null>(null);
  
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    
    async function fetchContext() {
      try {
        const [data, agentData] = await Promise.all([
          api<RuntimeContext>(`/v1/agents/${agentId}/runtime-context`),
          api<{ agent: AgentRuntimeShape }>(`/v1/agents/${agentId}`),
        ]);
        if (mounted) {
          setContext(data);
          setAgent(agentData.agent);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    
    void fetchContext();
    
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchContext();
      }
    }, 60000); // refresh every minute
    
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [agentId]);

  useEffect(() => {
    function onRuntimeUpdated(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string }>).detail;
      if (!detail?.agentId || detail.agentId !== agentId) return;
      setLoading(true);
      void api<RuntimeContext>(`/v1/agents/${agentId}/runtime-context`)
        .then((data) => setContext(data))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    window.addEventListener('agentis:agent-model-updated', onRuntimeUpdated);
    return () => window.removeEventListener('agentis:agent-model-updated', onRuntimeUpdated);
  }, [agentId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    if (openMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openMenu]);

  if (loading && !context) {
    return (
      <div className={clsx("flex items-center gap-2 text-text-muted text-[11px]", className)}>
        <Loader2 size={12} className="animate-spin" />
        <span>Loading runtime...</span>
      </div>
    );
  }

  if (!context) {
    return null;
  }

  const modelLabel = context.models.find(m => m.id === context.currentModel)?.label || context.currentModel;
  const effortLabel = context.efforts?.find(e => e.id === context.currentEffort)?.label || context.currentEffort;
  const config = agent?.config ?? {};
  const adapterType = agent?.adapterType ?? null;
  const canEditModel = Boolean(agent && !saving);
  const canEditEffort = adapterType === 'codex' && Boolean(context.efforts?.length) && !saving;
  const canEditFastMode = adapterType === 'codex' && context.fastModeSupported && !saving;

  async function patchRuntimeConfig(nextConfig: Record<string, unknown>, runtimeModel?: string | null) {
    if (!agent) return;
    setSaving(true);
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: nextConfig,
          ...(runtimeModel !== undefined ? { runtimeModel } : {}),
        }),
      });
      setAgent({ ...agent, config: nextConfig, runtimeModel: runtimeModel ?? agent.runtimeModel ?? null });
      setContext((current) => {
        if (!current) return current;
        return {
          ...current,
          currentModel: runtimeModel === undefined ? current.currentModel : (runtimeModel || current.currentModel),
        };
      });
      window.dispatchEvent(new CustomEvent('agentis:agent-model-updated', {
        detail: { agentId: agent.id, model: runtimeModel ?? null },
      }));
    } catch (error) {
      toast.error('Runtime update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function updateModel(nextModel: string) {
    const nextConfig = { ...config };
    if (nextModel) nextConfig.model = nextModel;
    else delete nextConfig.model;
    setContext((current) => current ? { ...current, currentModel: nextModel || current.currentModel } : current);
    await patchRuntimeConfig(nextConfig, nextModel || null);
    setOpenMenu(null);
  }

  async function updateEffort(nextEffort: string) {
    const nextConfig = { ...config, modelReasoningEffort: nextEffort };
    setContext((current) => current ? { ...current, currentEffort: nextEffort } : current);
    await patchRuntimeConfig(nextConfig);
    setOpenMenu(null);
  }

  async function toggleFastMode() {
    const nextFastMode = !(context?.fastModeEnabled ?? false);
    const nextConfig = { ...config, fastMode: nextFastMode };
    setContext((current) => current ? { ...current, fastModeEnabled: nextFastMode } : current);
    await patchRuntimeConfig(nextConfig);
  }

  const usageColorClass = (color?: string) => {
    switch (color) {
      case 'red': return 'bg-danger';
      case 'blue': return 'bg-info';
      case 'green': return 'bg-success';
      default: return 'bg-accent';
    }
  };

  return (
    <div ref={barRef} className={clsx("relative flex items-center gap-3 text-[11px] font-medium select-none", className)}>
      
      <div className="flex items-center text-text-secondary">
        <button 
          onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
          disabled={!canEditModel}
          className="hover:text-text-primary hover:bg-surface-3 px-2 py-0.5 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {modelLabel}
        </button>
        
        {effortLabel && (
          <button 
            onClick={() => setOpenMenu(openMenu === 'effort' ? null : 'effort')}
            disabled={!canEditEffort}
            className="hover:text-text-primary hover:bg-surface-3 px-2 py-0.5 rounded transition-colors ml-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {effortLabel}
          </button>
        )}
        
        {(context.usage?.length || context.contextWindow) && (
          <button 
            onClick={() => setOpenMenu(openMenu === 'usage' ? null : 'usage')}
            className={clsx(
              "ml-2 w-4 h-4 rounded-full border-[2px] grid place-items-center transition-colors",
              context.usage?.length ? "border-danger/60 hover:bg-danger/10" : "border-info/60 hover:bg-info/10"
            )}
            title="Usage & Limits"
          >
            {/* Minimalistic circle indicator */}
          </button>
        )}
      </div>

      {/* Model Popover */}
      {openMenu === 'model' && (
        <div className="absolute bottom-full left-0 mb-2 w-48 bg-[#2A2A2B] border border-line shadow-modal rounded-xl overflow-hidden z-50 p-1.5 animate-in fade-in slide-in-from-bottom-2">
          <div className="px-2 py-1.5 text-text-muted text-[10px] font-semibold tracking-wide uppercase flex justify-between">
            <span>Models</span>
            <span className="flex gap-1"><kbd className="bg-surface rounded px-1">Ctrl</kbd><kbd className="bg-surface rounded px-1">M</kbd></span>
          </div>
          <div className="flex flex-col">
            {context.models.map((m, i) => (
              <button 
                key={m.id}
                onClick={() => void updateModel(m.id)}
                disabled={saving}
                className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-surface text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={clsx(m.id === context.currentModel ? "text-text-primary" : "text-text-secondary")}>
                    {m.label} {m.legacy && <span className="text-text-muted font-normal">Legacy</span>}
                  </span>
                </div>
                {m.id === context.currentModel && <span className="text-text-primary">✓</span>}
              </button>
            ))}
          </div>
          {context.fastModeSupported && (
            <div className="mt-1 pt-1 border-t border-line/50">
              <button
                onClick={() => void toggleFastMode()}
                disabled={!canEditFastMode}
                className="flex items-center justify-between w-full px-2 py-1.5 rounded-lg hover:bg-surface text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="text-text-secondary">Enable fast mode</span>
                <div className={clsx("w-6 h-3 rounded-full transition-colors", context.fastModeEnabled ? "bg-accent" : "bg-surface-3")}>
                  <div className={clsx("w-3 h-3 bg-white rounded-full transition-transform", context.fastModeEnabled ? "translate-x-3" : "translate-x-0")} />
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Effort Popover */}
      {openMenu === 'effort' && context.efforts && (
        <div className="absolute bottom-full left-10 mb-2 w-64 bg-[#2A2A2B] border border-line shadow-modal rounded-xl overflow-hidden z-50 p-3 animate-in fade-in slide-in-from-bottom-2">
          <div className="flex justify-between items-center mb-3">
            <span className="text-text-primary font-semibold">Effort <span className="text-text-secondary font-normal ml-1">{effortLabel}</span></span>
            <span className="text-text-muted bg-surface-2 rounded-full w-4 h-4 inline-flex items-center justify-center text-[10px]">?</span>
          </div>
          <div className="flex justify-between text-text-muted text-[10px] mb-1 px-1">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <div className="relative h-6 flex items-center w-full px-2">
            <div className="absolute left-2 right-2 h-1.5 bg-black/40 rounded-full" />
            <div className="relative flex justify-between w-full z-10">
              {context.efforts.map((e) => (
                <div 
                  key={e.id}
                  onClick={() => { if (canEditEffort) void updateEffort(e.id); }}
                  className={clsx("relative group w-4 flex justify-center", canEditEffort ? "cursor-pointer" : "cursor-not-allowed opacity-60")}
                >
                  {e.id === context.currentEffort ? (
                    <div className="w-3 h-5 bg-[#d4d4d8] rounded-[4px] shadow-sm -mt-1.5" />
                  ) : (
                    <div className="w-1 h-1 bg-[#52525b] rounded-full mt-0.5 group-hover:bg-[#a1a1aa] transition-colors" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Usage Popover */}
      {openMenu === 'usage' && (context.usage || context.contextWindow) && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-[#2A2A2B] border border-line shadow-modal rounded-xl overflow-hidden z-50 p-2 animate-in fade-in slide-in-from-bottom-2">
          
          {context.contextWindow && (
            <div className="flex flex-col gap-2 px-2 py-1 mb-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-text-muted">Context window</span>
                <span className="text-text-secondary flex items-center gap-1">
                  {context.contextWindow.text} <span className="text-text-muted">›</span>
                </span>
              </div>
              <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-[#5C8AE6] rounded-full" 
                  style={{ width: `${Math.max(2, context.contextWindow.percentage)}%` }} 
                />
              </div>
            </div>
          )}

          {context.contextWindow && context.usage && context.usage.length > 0 && (
            <div className="h-[1px] w-full bg-line/40 my-2" />
          )}

          {context.usage && context.usage.length > 0 && (
            <>
              <div className="px-2 py-1 text-text-muted text-[11px] flex justify-between items-center mb-2">
                <span>Plan usage</span>
                <button className="text-text-secondary hover:text-text-primary transition-colors p-0.5 border border-line/40 rounded bg-surface">
                  <span className="sr-only">Go to billing</span>
                  →
                </button>
              </div>
              <div className="flex flex-col gap-3 px-2 pb-1">
                {context.usage.map((u, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-text-primary font-medium">{u.label}</span>
                      <span className="text-text-secondary">
                        {u.valueText || (u.resetText ? `${u.percentage}% · ${u.resetText}` : `${u.percentage}%`)}
                      </span>
                    </div>
                    <div className="h-1 w-full bg-black/30 rounded-full overflow-hidden">
                      <div 
                        className={clsx("h-full rounded-full", usageColorClass(u.color))} 
                        style={{ width: `${Math.max(2, u.percentage)}%` }} 
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
