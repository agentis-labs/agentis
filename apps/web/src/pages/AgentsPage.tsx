/**
 * AgentsPage — V1-SPEC §3.3 spec-named agent fleet page.
 *
 * Uses the spec-named `AgentFleetTable` component for presentation; this
 * page owns fetching, the realtime invalidation, and the register drawer.
 * Replaces the inline-table version in `AgentFleetPage` (kept as a thin
 * re-export for backward compatibility).
 */

import { useEffect, useState } from 'react';
import { api, workspace } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { AgentFleetTable, type AgentFleetRow } from '../components/agents/AgentFleetTable';

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentFleetRow[]>([]);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const ws = workspace.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void api<{ agents: AgentFleetRow[] }>('/v1/agents')
      .then((r) => setAgents(r.agents))
      .catch(() => {});
  }, [tick]);

  useRealtime(
    ['agent.status', 'agent.heartbeat', 'agent.task_started', 'agent.task_finished'],
    () => setTick((t) => t + 1),
  );

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-medium">Agents</h1>
        <span className="text-xs text-text-muted">{agents.length} registered</span>
        <div className="ml-auto">
          <button
            onClick={() => setCreating(true)}
            className="rounded-md border border-line bg-surface-2 px-3 py-1 text-xs hover:text-accent"
          >
            + Register
          </button>
        </div>
      </div>
      <AgentFleetTable agents={agents} />
      {creating && (
        <RegisterAgentDrawer
          onClose={() => {
            setCreating(false);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

function RegisterAgentDrawer({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [adapterType, setAdapterType] = useState<'openclaw' | 'claude_code' | 'http'>('http');
  const [capabilityTags, setTags] = useState('');
  const [config, setConfig] = useState('{}');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-base font-medium">Register agent</h2>
        <div className="space-y-3">
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Adapter">
            <select
              className={inputCls}
              value={adapterType}
              onChange={(e) =>
                setAdapterType(e.target.value as 'openclaw' | 'claude_code' | 'http')
              }
            >
              <option value="http">http</option>
              <option value="openclaw">openclaw</option>
              <option value="claude_code">claude_code</option>
            </select>
          </Field>
          <Field label="Capabilities (comma-separated)">
            <input
              className={inputCls}
              value={capabilityTags}
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
          <Field label="Config JSON">
            <textarea
              className={`${inputCls} h-32 font-mono text-xs`}
              value={config}
              onChange={(e) => setConfig(e.target.value)}
            />
          </Field>
          {err && <div className="text-xs text-danger">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded-md border border-line px-3 py-1 text-xs">
              Cancel
            </button>
            <button
              disabled={busy}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-canvas disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const cfg = JSON.parse(config);
                  await api('/v1/agents', {
                    method: 'POST',
                    body: JSON.stringify({
                      name,
                      adapterType,
                      capabilityTags: capabilityTags
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                      config: cfg,
                    }),
                  });
                  onClose();
                } catch (e) {
                  const msg =
                    e instanceof Error
                      ? e.message
                      : ((e as { message?: string })?.message ?? 'Failed');
                  setErr(msg);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm text-text-primary outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">{label}</span>
      {children}
    </label>
  );
}
