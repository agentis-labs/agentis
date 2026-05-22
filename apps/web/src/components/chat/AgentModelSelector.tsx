import { useEffect, useState } from 'react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { isV1AdapterType, type AdapterType } from '../agents/RuntimePicker';
import { ModelChooser } from '../agents/ModelChooser';

interface AgentRuntimeShape {
  id: string;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
}

export function AgentModelSelector({
  agentId,
  compact = false,
}: {
  agentId: string;
  compact?: boolean;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState<AgentRuntimeShape | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ agent: AgentRuntimeShape }>(`/v1/agents/${agentId}`)
      .then((data) => {
        if (!cancelled) setAgent(data.agent);
      })
      .catch(() => {
        if (!cancelled) setAgent(null);
      });
    return () => { cancelled = true; };
  }, [agentId]);

  if (!agent || !isV1AdapterType(agent.adapterType ?? '')) return null;

  const adapterType = agent.adapterType as AdapterType;
  const config = agent.config ?? {};
  const selectedModel = stringOf(config.model) || agent.runtimeModel || '';

  async function updateModel(nextModel: string) {
    if (!agent) return;
    const nextConfig = { ...(agent.config ?? {}) };
    if (nextModel) nextConfig.model = nextModel;
    else delete nextConfig.model;

    setSaving(true);
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: nextConfig,
          runtimeModel: nextModel || null,
        }),
      });
      setAgent({ ...agent, config: nextConfig, runtimeModel: nextModel || null });
      window.dispatchEvent(new CustomEvent('agentis:agent-model-updated', {
        detail: { agentId: agent.id, model: nextModel || null },
      }));
      toast.success('Model updated');
    } catch (error) {
      toast.error('Model update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModelChooser
      adapterType={adapterType}
      value={selectedModel}
      onChange={(next) => void updateModel(next)}
      disabled={saving}
      variant={compact ? 'compact' : 'full'}
      align="right"
      openDirection={compact ? 'up' : 'down'}
    />
  );
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
