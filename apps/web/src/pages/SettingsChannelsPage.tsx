/**
 * Settings → Channels — Telegram/Discord connection management.
 *
 * Each connection routes inbound channel messages into one agent's
 * conversation thread (via ChannelBridge.handleInbound on the backend) and
 * forwards in-app operator outbound to the channel.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ConnectionForm } from '../components/channels/ConnectionForm';
import { ConnectionRow } from '../components/channels/ConnectionRow';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { useToast } from '../components/shared/Toast';

interface Connection {
  id: string;
  kind: string;
  name: string;
  agentId: string;
  status: string;
  defaultChatId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}
interface Agent {
  id: string;
  name: string;
}

export function SettingsChannelsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    id: string;
    webhookSecret: string;
    webhookUrl: string;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const confirmDialog = useConfirm();
  const toast = useToast();

  useEffect(() => {
    void api<{ connections: Connection[] }>('/v1/channels').then((r) => setConnections(r.connections));
    void api<{ agents: Agent[] }>('/v1/agents').then((r) => setAgents(r.agents)).catch(() => setAgents([]));
  }, [tick]);

  async function handleCreate(input: {
    kind: 'telegram' | 'discord';
    name: string;
    agentId: string;
    token: string;
    defaultChatId?: string;
  }) {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{
        connection: Connection;
        webhookSecret: string;
        webhookUrl: string;
      }>('/v1/channels', { method: 'POST', body: JSON.stringify(input) });
      setRevealed({
        id: res.connection.id,
        webhookSecret: res.webhookSecret,
        webhookUrl: res.webhookUrl,
      });
      setAdding(false);
      setTick((t) => t + 1);
    } catch (e) {
      setErr((e as Error).message ?? 'Failed to create connection');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: 'Delete this channel connection?',
      body: 'Inbound messages from this channel will stop being routed to the linked agent.',
      confirmLabel: 'Delete connection',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/channels/${id}`, { method: 'DELETE' });
      toast.success('Channel connection deleted');
      setTick((t) => t + 1);
    } catch (e) {
      toast.error('Could not delete connection', (e as Error).message);
    }
  }

  async function handleTest(id: string) {
    try {
      await api(`/v1/channels/${id}/test`, { method: 'POST', body: JSON.stringify({}) });
      toast.success('Test message sent');
    } catch (e) {
      toast.error('Test failed', (e as Error).message);
    }
  }

  async function handleShowWebhook(id: string) {
    try {
      const r = await api<{ webhookSecret: string; webhookUrl: string }>(
        `/v1/channels/${id}/webhook-info`,
      );
      setRevealed({ id, webhookSecret: r.webhookSecret, webhookUrl: r.webhookUrl });
    } catch (e) {
      toast.error('Could not fetch webhook info', (e as Error).message);
    }
  }

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-lg font-medium">Channel bridge</h1>
      <p className="text-xs text-text-muted">
        Route Telegram or Discord conversations into one of your agents. Bot tokens are encrypted at
        rest with the credential vault and never returned over the wire.
      </p>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-medium">Connections</h2>
          <button
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
            className="ml-auto rounded-md border border-line px-3 py-1 text-xs hover:text-accent"
          >
            + Connect
          </button>
        </div>
        {connections.length === 0 ? (
          <div className="py-4 text-xs text-text-muted">No channels connected yet.</div>
        ) : (
          <div>
            {connections.map((c) => (
              <ConnectionRow
                key={c.id}
                connection={c}
                agentName={agentNameById.get(c.agentId)}
                onTest={handleTest}
                onDelete={handleDelete}
                onShowWebhook={handleShowWebhook}
              />
            ))}
          </div>
        )}
      </section>

      {adding && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5">
            <h2 className="mb-3 text-sm font-medium">Connect a channel</h2>
            <ConnectionForm
              agents={agents}
              busy={busy}
              error={err}
              onCancel={() => setAdding(false)}
              onSubmit={(i) => void handleCreate(i)}
            />
          </div>
        </div>
      )}

      {revealed && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md space-y-3 rounded-2xl border border-line bg-surface p-5 text-sm">
            <h2 className="text-sm font-medium">Webhook details</h2>
            <p className="text-xs text-text-muted">
              Configure your bot to deliver updates to this URL. Telegram operators must include
              the secret as the <code>secret_token</code> parameter when calling{' '}
              <code>setWebhook</code>.
            </p>
            <div>
              <div className="text-[11px] text-text-muted">Webhook URL</div>
              <div className="mt-1 break-all rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs">
                {revealed.webhookUrl}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-text-muted">Secret</div>
              <div className="mt-1 break-all rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-xs">
                {revealed.webhookSecret}
              </div>
            </div>
            <button
              onClick={() => setRevealed(null)}
              className="rounded-md border border-line px-3 py-1.5 text-xs hover:text-accent"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
