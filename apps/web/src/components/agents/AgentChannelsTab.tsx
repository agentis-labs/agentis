/**
 * AgentChannelsTab — manage an agent's messaging channels (AGENTS-PAGE-REDESIGN.md §3.5,
 * OMNICHANNEL-ORCHESTRATOR-10X §3).
 *
 * Channels belong with the agent, not buried in workspace settings. Each
 * provider card shows a connected state (name + chat id + Test + Disconnect) or
 * a not-connected state with an inline connect flow. Two auth styles:
 *   - token  (Telegram / Discord / Slack): paste a bot token.
 *   - qr     (WhatsApp): create the connection, then scan a QR to link a phone.
 *
 * Telegram additionally supports long-polling (no public webhook) via a toggle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

type AuthStyle = 'token' | 'qr';

interface Provider {
  kind: string;
  label: string;
  auth: AuthStyle;
  hint: string;
  /** Optional persistent transport (no public webhook): Telegram long-poll / Discord gateway. */
  persistent?: { value: 'polling' | 'gateway'; label: string };
}

const PROVIDERS: Provider[] = [
  { kind: 'telegram', label: 'Telegram', auth: 'token', hint: 'Bot token from @BotFather', persistent: { value: 'polling', label: 'Use long-polling (no public webhook needed)' } },
  { kind: 'whatsapp', label: 'WhatsApp', auth: 'qr', hint: 'Scan a QR in WhatsApp → Linked Devices' },
  { kind: 'slack', label: 'Slack', auth: 'token', hint: 'Bot token (xoxb-…) from your Slack app' },
  { kind: 'discord', label: 'Discord', auth: 'token', hint: 'Bot token from the Discord developer portal', persistent: { value: 'gateway', label: 'Two-way via gateway (requires the Message Content intent)' } },
];

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
          Connect messaging channels to {agentName}'s inbox. Messages run a real orchestrator turn
          and the reply is delivered back to the channel.
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

interface QrState {
  connectionId: string;
  dataUrl?: string;
  status: string;
}

function ProviderCard({
  provider,
  agentId,
  agentName,
  connection,
  onChanged,
  toast,
}: {
  provider: Provider;
  agentId: string;
  agentName: string;
  connection: ChannelConnection | null;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'save' | 'link' | null>(null);
  const [name, setName] = useState(`${agentName} ${provider.label}`);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [usePersistent, setUsePersistent] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);

  // ── WhatsApp QR login polling ────────────────────────────
  const qrConnId = qr?.connectionId;
  const linked = qr?.status === 'open';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!qrConnId || linked) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const state = await api<{ status: string; qrDataUrl?: string }>(`/v1/channels/${qrConnId}/login`);
          setQr((prev) => (prev && prev.connectionId === qrConnId
            ? { ...prev, status: state.status, dataUrl: state.qrDataUrl ?? prev.dataUrl }
            : prev));
          if (state.status === 'open') {
            toast.success(`${provider.label} linked`);
            setQr(null);
            setConnecting(false);
            await onChanged();
          } else if (state.status === 'logged_out' || state.status === 'error') {
            toast.error(`${provider.label} login failed`, 'Try generating a new QR.');
          }
        } catch {
          /* transient — keep polling */
        }
      })();
    }, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [qrConnId, linked, provider.label, toast, onChanged]);

  async function saveToken() {
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
          ...(provider.persistent && usePersistent ? { transport: provider.persistent.value } : {}),
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

  /** WhatsApp: create the connection (if needed) then start a QR login. */
  async function startQrLogin(existingId?: string) {
    setBusy('save');
    try {
      let connId = existingId;
      if (!connId) {
        const created = await api<{ connection: { id: string } }>('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({ kind: provider.kind, name: name.trim() || `${agentName} ${provider.label}`, agentId }),
        });
        connId = created.connection.id;
      }
      const login = await api<{ status: string; qrDataUrl?: string }>(`/v1/channels/${connId}/login`, { method: 'POST' });
      setQr({ connectionId: connId, status: login.status, dataUrl: login.qrDataUrl });
      setConnecting(true);
    } catch (err) {
      toast.error(`Could not start ${provider.label} login`, String(err));
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
      setQr(null);
      await onChanged();
    } catch (err) {
      toast.error('Could not disconnect', String(err));
    } finally {
      setBusy(null);
    }
  }

  // WhatsApp/QR connections aren't usable until linked (status 'active').
  const isQr = provider.auth === 'qr';
  const connectedAndLive = connection && (!isQr || connection.status === 'active');
  const needsLink = connection && isQr && connection.status !== 'active';

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-text-primary">{provider.label}</span>
        {connectedAndLive ? (
          <span className="flex items-center gap-1 text-[12px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> connected
          </span>
        ) : needsLink ? (
          <span className="flex items-center gap-1 text-[12px] text-amber-500">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> needs linking
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[12px] text-text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted" /> not connected
          </span>
        )}
        {testResult === 'ok' && <span className="ml-auto text-[12px] text-accent">Delivered ✓</span>}
        {testResult === 'fail' && <span className="ml-auto text-[12px] text-danger">Failed ✗</span>}
      </div>

      {/* Active QR login panel (WhatsApp) */}
      {qr ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-input border border-line bg-surface-2 p-4">
          {qr.dataUrl ? (
            <img src={qr.dataUrl} alt={`${provider.label} login QR`} className="h-44 w-44 rounded bg-white p-1" />
          ) : (
            <Loader2 size={28} className="animate-spin text-text-muted" />
          )}
          <p className="text-center text-[12px] text-text-secondary">
            Open {provider.label} → <strong>Linked Devices</strong> → scan this code.
          </p>
          <p className="text-[11px] text-text-muted">Waiting for scan… ({qr.status})</p>
          <Button size="sm" variant="ghost" onClick={() => { setQr(null); setConnecting(false); }}>
            Cancel
          </Button>
        </div>
      ) : connectedAndLive ? (
        <>
          <div className="mt-1 text-[12px] text-text-muted">
            {connection!.name}
            {connection!.defaultChatId ? ` · chat ID: ${connection!.defaultChatId}` : ''}
          </div>
          {connection!.lastError && <div className="mt-1 text-[12px] text-danger">{connection!.lastError}</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {!isQr && (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void test()}>
                {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </>
      ) : needsLink ? (
        <>
          <div className="mt-1 text-[12px] text-text-muted">{connection!.name} · not yet linked</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void startQrLogin(connection!.id)}>
              {busy === 'save' ? 'Starting…' : 'Show QR'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect()}>
              Remove
            </Button>
          </div>
        </>
      ) : connecting && !isQr ? (
        <div className="mt-3 space-y-2">
          <ConnectField label="Connection name">
            <input value={name} onChange={(event) => setName(event.target.value)} className={INPUT_CLS} />
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
          {provider.persistent && (
            <label className="flex items-center gap-2 text-[12px] text-text-secondary">
              <input type="checkbox" checked={usePersistent} onChange={(event) => setUsePersistent(event.target.checked)} />
              {provider.persistent.label}
            </label>
          )}
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void saveToken()}>
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
            disabled={busy !== null}
            aria-label={`Connect ${provider.label} to ${agentName}`}
            onClick={() => (isQr ? void startQrLogin() : setConnecting(true))}
          >
            {busy === 'save' && isQr ? 'Starting…' : `Connect ${provider.label}`}
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
