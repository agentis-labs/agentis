import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { ModelChooser } from './ModelChooser';
import {
  configToRuntimeConfig,
  isV1AdapterType,
  runtimeConfigToAdapterConfig,
  runtimeModelFor,
  type AdapterType,
} from './RuntimePicker';
import { runtimeModelValue, withRuntimeModel } from './runtimeModelField';

interface AgentRecord {
  id: string;
  name: string;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
}

type ControlVariant = 'drawer' | 'rail';

export function SelectedAgentModelControl({
  agentId,
  adapterType,
  onUpdated,
  variant = 'drawer',
}: {
  agentId: string;
  adapterType?: string | null;
  onUpdated?: () => void;
  variant?: ControlVariant;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);

  useEffect(() => {
    if (!isV1AdapterType(adapterType ?? '')) {
      setAgent(null);
      setSelectedModel('');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setAgent(null);
    void api<{ agent: AgentRecord }>(`/v1/agents/${agentId}`)
      .then((data) => {
        if (cancelled) return;
        const fullAgent = data.agent;
        setAgent(fullAgent);
        if (!isV1AdapterType(fullAgent.adapterType ?? '')) {
          setSelectedModel('');
          return;
        }
        const fullAdapterType = fullAgent.adapterType as AdapterType;
        const runtimeConfig = configToRuntimeConfig(fullAdapterType, (fullAgent.config ?? {}) as Record<string, unknown>);
        setSelectedModel(runtimeModelValue(runtimeConfig, fullAdapterType));
      })
      .catch(() => {
        if (!cancelled) {
          setAgent(null);
          setSelectedModel('');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentId, adapterType]);

  if (!isV1AdapterType(adapterType ?? '')) return null;
  const requestedAdapterType = adapterType as AdapterType;
  if (agent && !isV1AdapterType(agent.adapterType ?? '')) return null;

  const fetchedAdapterType = isV1AdapterType(agent?.adapterType ?? '')
    ? (agent?.adapterType as AdapterType)
    : null;
  const effectiveAdapterType: AdapterType = fetchedAdapterType ?? requestedAdapterType;

  async function updateModel(nextModel: string) {
    if (!agent || !isV1AdapterType(agent.adapterType ?? '')) return;
    const agentAdapterType = agent.adapterType as AdapterType;
    const previousModel = selectedModel;
    const storedConfig = (agent.config ?? {}) as Record<string, unknown>;
    const runtimeConfig = configToRuntimeConfig(agentAdapterType, storedConfig);
    const nextRuntimeConfig = withRuntimeModel(runtimeConfig, agentAdapterType, nextModel);
    const nextKnownConfig = runtimeConfigToAdapterConfig(agentAdapterType, nextRuntimeConfig);
    const nextConfig = { ...storedConfig, ...nextKnownConfig };
    if (!Object.prototype.hasOwnProperty.call(nextKnownConfig, 'model')) delete nextConfig.model;

    setSaving(true);
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: nextConfig,
          runtimeModel: runtimeModelFor(agentAdapterType, nextRuntimeConfig),
        }),
      });
      setAgent({
        ...agent,
        config: nextConfig,
        runtimeModel: runtimeModelFor(agentAdapterType, nextRuntimeConfig),
      });
      setSelectedModel(nextModel);
      toast.success('Model updated');
      onUpdated?.();
    } catch (error) {
      setSelectedModel(previousModel);
      toast.error('Model update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || catalogLoading || !agent;
  const statusBody = loading
    ? 'Loading the current runtime model and saved adapter settings.'
    : saving
      ? 'Saving the new runtime model now.'
      : null;

  return (
    <section className={variant === 'drawer' ? 'space-y-2' : 'mb-3 border-b border-line/70 pb-3'}>
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Runtime model</div>
        {(loading || saving) && <Loader2 size={12} className="animate-spin text-text-muted" />}
      </div>
      <ModelChooser
        adapterType={effectiveAdapterType}
        agentId={agentId}
        value={selectedModel}
        onChange={(next) => void updateModel(next)}
        disabled={disabled}
        onLoadingChange={setCatalogLoading}
        className={variant === 'rail' ? 'mt-0.5' : undefined}
      />
      {statusBody && <p className="text-[11px] leading-relaxed text-text-muted">{statusBody}</p>}
    </section>
  );
}
