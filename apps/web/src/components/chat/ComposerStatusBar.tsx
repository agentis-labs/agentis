import { useEffect, useState, type ReactNode } from 'react';
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
      } catch {
        if (mounted) setLoading(false);
      }
    }

    void fetchContext();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchContext();
    }, 60000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
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

  if (loading && !context) {
    return (
      <div className={clsx('flex min-w-0 items-center gap-2 text-[11px] text-text-muted', className)}>
        <Loader2 size={12} className="animate-spin" />
        <span>Loading runtime...</span>
      </div>
    );
  }

  if (!context) return null;

  const modelLabel = context.models.find((model) => model.id === context.currentModel)?.label || context.currentModel;
  const effortLabel = context.efforts?.find((effort) => effort.id === context.currentEffort)?.label || context.currentEffort;
  const config = agent?.config ?? {};
  const adapterType = agent?.adapterType ?? null;
  const canEditModel = Boolean(agent && !saving);
  const canEditEffort = adapterType === 'codex' && Boolean(context.efforts?.length) && !saving;
  const canEditFastMode = adapterType === 'codex' && context.fastModeSupported && !saving;
  const showUsage = Boolean(context.usage?.length || context.contextWindow);

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
      setContext((current) => current ? {
        ...current,
        currentModel: runtimeModel === undefined ? current.currentModel : (runtimeModel || current.currentModel),
      } : current);
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
  }

  async function updateEffort(nextEffort: string) {
    const nextConfig = { ...config, modelReasoningEffort: nextEffort };
    setContext((current) => current ? { ...current, currentEffort: nextEffort } : current);
    await patchRuntimeConfig(nextConfig);
  }

  async function toggleFastMode() {
    if (!context) return;
    const nextFastMode = !(context.fastModeEnabled ?? false);
    const nextConfig = { ...config, fastMode: nextFastMode };
    setContext((current) => current ? { ...current, fastModeEnabled: nextFastMode } : current);
    await patchRuntimeConfig(nextConfig);
  }

  return (
    <div className={clsx('flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-secondary', className)}>
      <RuntimeMenu label={modelLabel} disabled={!canEditModel} busy={saving} ariaLabel="Select model">
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          Models
        </div>
        {context.models.map((model) => (
          <DropdownMenu.Item
            key={model.id}
            disabled={saving}
            onSelect={(event) => {
              event.preventDefault();
              void updateModel(model.id);
            }}
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[11px] text-text-secondary outline-none hover:bg-surface-2 hover:text-text-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
          >
            <span className="min-w-0 truncate">
              {model.label}
              {model.legacy ? <span className="ml-1 text-text-muted">Legacy</span> : null}
            </span>
            {model.id === context.currentModel ? <Check size={12} className="shrink-0 text-accent" /> : null}
          </DropdownMenu.Item>
        ))}
        {context.fastModeSupported ? (
          <>
            <DropdownMenu.Separator className="my-1 h-px bg-line/60" />
            <DropdownMenu.Item
              disabled={!canEditFastMode}
              onSelect={(event) => {
                event.preventDefault();
                void toggleFastMode();
              }}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[11px] text-text-secondary outline-none hover:bg-surface-2 hover:text-text-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
            >
              <span>Enable fast mode</span>
              <span className={clsx('relative h-3 w-6 rounded-full transition-colors', context.fastModeEnabled ? 'bg-accent' : 'bg-surface-3')}>
                <span className={clsx('absolute top-0 h-3 w-3 rounded-full bg-white transition-transform', context.fastModeEnabled ? 'translate-x-3' : 'translate-x-0')} />
              </span>
            </DropdownMenu.Item>
          </>
        ) : null}
      </RuntimeMenu>

      {effortLabel ? (
        <RuntimeMenu label={effortLabel} disabled={!canEditEffort} ariaLabel="Select reasoning effort" widthClass="w-64">
          <div className="mb-2 flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-semibold text-text-primary">Effort</span>
            <span className="text-[10px] text-text-muted">Faster to smarter</span>
          </div>
          <div className="grid gap-1">
            {context.efforts?.map((effort) => (
              <DropdownMenu.Item
                key={effort.id}
                disabled={!canEditEffort || saving}
                onSelect={(event) => {
                  event.preventDefault();
                  void updateEffort(effort.id);
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[11px] text-text-secondary outline-none hover:bg-surface-2 hover:text-text-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
              >
                <span>{effort.label}</span>
                {effort.id === context.currentEffort ? <Check size={12} className="text-accent" /> : null}
              </DropdownMenu.Item>
            ))}
          </div>
        </RuntimeMenu>
      ) : null}

      {showUsage ? (
        <RuntimeIconMenu ariaLabel="Usage and limits">
          {context.contextWindow ? (
            <UsageMeter
              label="Context window"
              value={context.contextWindow.text}
              percentage={context.contextWindow.percentage}
              colorClass="bg-info"
            />
          ) : null}
          {context.contextWindow && context.usage?.length ? <DropdownMenu.Separator className="my-2 h-px bg-line/60" /> : null}
          {context.usage?.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1 text-[11px] text-text-muted">
                <span>Plan usage</span>
                <ChevronRight size={11} />
              </div>
              {context.usage.map((usage) => (
                <UsageMeter
                  key={usage.label}
                  label={usage.label}
                  value={usage.valueText || (usage.resetText ? `${usage.percentage}% - ${usage.resetText}` : `${usage.percentage}%`)}
                  percentage={usage.percentage}
                  colorClass={usageColorClass(usage.color)}
                />
              ))}
            </div>
          ) : null}
        </RuntimeIconMenu>
      ) : null}
    </div>
  );
}

function RuntimeMenu({
  label,
  disabled,
  busy,
  ariaLabel,
  widthClass = 'w-52',
  children,
}: {
  label: string;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel: string;
  widthClass?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-busy={busy}
          aria-label={ariaLabel}
          className="inline-flex max-w-32 min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-text-secondary outline-none hover:bg-surface-3 hover:text-text-primary focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="min-w-0 truncate">{busy ? 'Saving...' : label}</span>
          {busy ? (
            <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
          ) : (
            <ChevronDown size={10} className="shrink-0 text-text-muted" />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className={clsx('z-[90] max-h-[320px] overflow-y-auto rounded-lg border border-line bg-[#2A2A2B] p-1.5 shadow-modal outline-none', widthClass)}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RuntimeIconMenu({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="ml-1 grid h-4 w-4 place-items-center rounded-full border-2 border-info/60 outline-none hover:bg-info/10 focus-visible:ring-1 focus-visible:ring-accent/50"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[90] w-72 rounded-lg border border-line bg-[#2A2A2B] p-2 shadow-modal outline-none"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UsageMeter({
  label,
  value,
  percentage,
  colorClass,
}: {
  label: string;
  value: string;
  percentage: number;
  colorClass: string;
}) {
  return (
    <div className="space-y-1.5 px-1">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="min-w-0 truncate text-text-primary">{label}</span>
        <span className="shrink-0 text-text-secondary">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
        <div className={clsx('h-full rounded-full', colorClass)} style={{ width: `${Math.max(2, percentage)}%` }} />
      </div>
    </div>
  );
}

function usageColorClass(color?: NonNullable<RuntimeContext['usage']>[number]['color']) {
  switch (color) {
    case 'red':
      return 'bg-danger';
    case 'blue':
      return 'bg-info';
    case 'green':
      return 'bg-success';
    default:
      return 'bg-accent';
  }
}



