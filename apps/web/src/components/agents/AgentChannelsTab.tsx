/**
 * AgentChannelsTab — manage an agent's messaging channels (AGENTS-PAGE-REDESIGN.md §3.5).
 *
 * Channels belong with the agent, not buried in workspace settings. Each
 * provider card shows a connected state (name + chat id + Test + Disconnect)
 * or a not-connected state with an inline connect form.
 *
 * The channel bridge currently registers Telegram and Discord adapters; Slack
 * and WhatsApp appear once their adapters ship.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

interface ChannelConnection {
  id: string;
  agentId: string;
  kind: string;
  name: string;
  status: string;
  defaultChatId: string | null;
  lastError?: string | null;
}

const PROVIDERS = [
  { kind: 'telegram', label: 'Telegram', hint: 'Bot token from @BotFather' },
  { kind: 'discord', label: 'Discord', hint: 'Bot token from the Discord developer portal' },
] as const;

export function AgentChannelsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const toast = useToast();
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ connections: ChannelConnection[] }>('/v1/channels');
      setConnections((data.connections ?? []).filter((conn) => conn.agentId === agentId));
    } catch {
      setConnections([]);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (connections === null) return <Skeleton height={320} />;

  return (
    <div className="max-w-2xl space-y-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Channels</div>
        <p className="mt-1 text-[13px] text-text-secondary">
          Connect messaging channels to {agentName}'s inbox.
        </p>
      </div>
      {PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.kind}
          provider={provider}
          agentId={agentId}
          agentName={agentName}
          connection={connections.find((conn) => conn.kind === provider.kind) ?? null}
          onChanged={refresh}
          toast={toast}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  agentId,
  agentName,
  connection,
  onChanged,
  toast,
}: {
  provider: (typeof PROVIDERS)[number];
  agentId: string;
  agentName: string;
  connection: ChannelConnection | null;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'save' | null>(null);
  const [name, setName] = useState(`${agentName} ${provider.label}`);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);

  async function save() {
    if (token.trim().length < 8) {
      toast.error('Token too short', 'Paste the full bot token.');
      return;
    }
    setBusy('save');
    try {
      await api('/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: provider.kind,
          name: name.trim() || `${agentName} ${provider.label}`,
          agentId,
          token: token.trim(),
          defaultChatId: chatId.trim() || undefined,
        }),
      });
      toast.success(`${provider.label} connected`);
      setConnecting(false);
      setToken('');
      await onChanged();
    } catch (err) {
      toast.error(`Could not connect ${provider.label}`, String(err));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (!connection) return;
    setBusy('test');
    setTestResult(null);
    try {
      await api(`/v1/channels/${connection.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ body: `Hello from ${agentName}.` }),
      });
      setTestResult('ok');
      toast.success('Test message delivered');
    } catch (err) {
      setTestResult('fail');
      toast.error('Test failed', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!connection) return;
    setBusy('disconnect');
    try {
      await api(`/v1/channels/${connection.id}`, { method: 'DELETE' });
      toast.success(`${provider.label} disconnected`);
      await onChanged();
    } catch (err) {
      toast.error('Could not disconnect', String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-text-primary">{provider.label}</span>
        {connection ? (
          <span className="flex items-center gap-1 text-[12px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> connected
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[12px] text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted" /> not connected
          </span>
        )}
        {testResult === 'ok' && <span className="ml-auto text-[12px] text-accent">Delivered ✓</span>}
        {testResult === 'fail' && <span className="ml-auto text-[12px] text-danger">Failed ✗</span>}
      </div>

      {connection ? (
        <>
          <div className="mt-1 text-[12px] text-text-muted">
            {connection.name}
            {connection.defaultChatId ? ` · chat ID: ${connection.defaultChatId}` : ''}
          </div>
          {connection.lastError && (
            <div className="mt-1 text-[12px] text-danger">{connection.lastError}</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void test()}>
              {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </>
      ) : connecting ? (
        <div className="mt-3 space-y-2">
          <ConnectField label="Connection name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={INPUT_CLS}
            />
          </ConnectField>
          <ConnectField label="Bot token" hint={provider.hint}>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              placeholder="Paste the bot token"
              className={INPUT_CLS}
            />
          </ConnectField>
          <ConnectField label="Default chat ID" hint="Optional — where test + outbound messages go">
            <input
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder="e.g. -100123456789"
              className={INPUT_CLS}
            />
          </ConnectField>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Connecting…' : `Connect ${provider.label}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConnecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<Plug size={12} />}
            aria-label={`Connect ${provider.label} to ${agentName}`}
            onClick={() => setConnecting(true)}
          >
            Connect {provider.label}
          </Button>
        </div>
      )}
    </div>
  );
}

const INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function ConnectField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={clsx('block')}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}
