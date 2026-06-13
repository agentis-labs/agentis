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
  adapterCapabilities?: { toolForwarding?: string | null } | null;
}

interface ConversationRole {
  role: string;
  envModel: string | null;
  effectiveModel: string | null;
  override: { model: string; baseUrl: string | null; hasApiKey: boolean } | null;
}

// A CLI harness (Codex / Claude Code) doesn't answer chat with its own model —
// the platform transparently routes conversation turns through the orchestrator's
// `conversation` runtime (OrchestratorModelRouter). For those agents, the model
// that actually replies is the conversation-role model, so the picker must drive
// THAT, not the agent's config.model (which only affects workflow tasks).
const ROUTER_SERVED = new Set(['marker_protocol', 'mcp_native']);

export function AgentModelSelector({
  agentId,
  compact = false,
}: {
  agentId: string;
  compact?: boolean;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState<AgentRuntimeShape | null>(null);
  const [conversation, setConversation] = useState<ConversationRole | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    void api<{ agent: AgentRuntimeShape }>(`/v1/agents/${agentId}`)
      .then((data) => {
        if (!cancelled) setAgent(data.agent);
      })
      .catch(() => {
        if (!cancelled) setAgent(null);
      });
    return () => { cancelled = true; };
  }, [agentId]);

  // The conversation-role config is workspace-wide (not per agent), so load it
  // once; it tells us both whether a runtime is configured and the current
  // override. Refetched on the model-updated event so the label stays in sync.
  useEffect(() => {
    let cancelled = false;
    function load() {
      void api<{ roles: ConversationRole[] }>('/v1/orchestrator/models')
        .then((data) => {
          if (cancelled) return;
          setConversation(data.roles?.find((r) => r.role === 'conversation') ?? null);
        })
        .catch(() => { if (!cancelled) setConversation(null); });
    }
    load();
    return () => { cancelled = true; };
  }, [agentId]);

  if (!agent) return null;

  const forwarding = agent.adapterCapabilities?.toolForwarding ?? '';
  const runtimeConfigured = Boolean(conversation?.effectiveModel);
  const routerServed = ROUTER_SERVED.has(forwarding) && runtimeConfigured;

  // Catalog source: a router-served agent runs on the orchestrator endpoint, so
  // list the full model family for its harness (no agentId — that would pin the
  // catalog to the agent's one configured model). A self-serving agent lists its
  // own runtime's models.
  const adapterType: AdapterType = isV1AdapterType(agent.adapterType ?? '')
    ? (agent.adapterType as AdapterType)
    : 'http';

  if (routerServed) {
    const selected = conversation?.override?.model ?? '';
    const updateConversationModel = async (nextModel: string) => {
      setSaving(true);
      try {
        if (nextModel) {
          await api('/v1/orchestrator/models/conversation', {
            method: 'PUT',
            body: JSON.stringify({ model: nextModel }),
          });
        } else {
          await api('/v1/orchestrator/models/conversation', { method: 'DELETE' });
        }
        setConversation((current) => current
          ? {
              ...current,
              effectiveModel: nextModel || current.envModel,
              override: nextModel ? { model: nextModel, baseUrl: null, hasApiKey: false } : null,
            }
          : current);
        window.dispatchEvent(new CustomEvent('agentis:agent-model-updated', {
          detail: { agentId, model: nextModel || conversation?.envModel || null },
        }));
        toast.success(nextModel ? 'Conversation model updated' : 'Reverted to default model');
      } catch (error) {
        toast.error('Model update failed', apiErrorMessage(error));
      } finally {
        setSaving(false);
      }
    };

    return (
      <ModelChooser
        adapterType={adapterType}
        value={selected}
        onChange={(next) => void updateConversationModel(next)}
        disabled={saving}
        variant={compact ? 'compact' : 'full'}
        align="right"
        openDirection={compact ? 'up' : 'down'}
      />
    );
  }

  // Self-serving agent (native function-calling): the agent's own model answers.
  if (!isV1AdapterType(agent.adapterType ?? '')) return null;

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
      agentId={agentId}
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
