/**
 * AgentChannelsTab - manage native messaging channels for an agent.
 *
 * The UI mirrors the backend health contract: a channel is only "active" when
 * credentials, transport, outbound, inbound, and runtime checks pass.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plug, Plus, RefreshCcw, Trash2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

type ChannelStatus = 'needs_action' | 'verifying' | 'active' | 'degraded' | 'error' | 'paused' | string;
type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';
type WhatsAppMode = 'qr_local' | 'cloud';

interface HealthCheck {
  name: 'credential' | 'transport' | 'outbound' | 'inbound' | 'runtime';
  ok: boolean;
  code: string;
  message: string;
  remediation?: string;
  checkedAt: string;
}

interface ChannelHealth {
  status: ChannelStatus;
  checks: HealthCheck[];
  lastTestAt?: string;
}

interface ChannelRecipient {
  handle: string;
  name?: string;
  rules?: string;
}
interface ChannelAccess {
  recipients?: ChannelRecipient[];
  answerAnyone?: boolean;
  anyoneRules?: string;
  unknownReply?: 'ignore' | 'decline';
}

interface ChannelConnection {
  id: string;
  agentId: string | null;
  kind: ChannelKind;
  name: string;
  status: ChannelStatus;
  defaultChatId: string | null;
  access?: ChannelAccess | null;
  targetAliases?: Record<string, string>;
  transport?: string | null;
  mode?: string | null;
  transportStatus?: string | null;
  health: ChannelHealth;
  lastError?: string | null;
}

interface Provider {
  kind: ChannelKind;
  label: string;
  hint: string;
  persistent?: { value: 'polling' | 'gateway'; label: string };
}

const PROVIDERS: Provider[] = [
  { kind: 'telegram', label: 'Telegram', hint: 'Bot token from @BotFather', persistent: { value: 'polling', label: 'Use long polling' } },
  { kind: 'whatsapp', label: 'WhatsApp', hint: 'QR local is the easiest setup. Cloud API is available for production/webhook deployments.' },
  { kind: 'slack', label: 'Slack', hint: 'Bot token and signing secret from your Slack app' },
  { kind: 'discord', label: 'Discord', hint: 'Bot token from the Discord Developer Portal', persistent: { value: 'gateway', label: 'Two-way gateway' } },
];

const EMPTY_HEALTH: ChannelHealth = {
  status: 'verifying',
  checks: [],
};

export function AgentChannelsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const toast = useToast();
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null);
  // Workspace-owned (agentless) connections — shared, so THIS agent can send on
  // them too without connecting its own. Shown read-only so the operator sees the
  // "global instance" is already usable here instead of creating a duplicate.
  const [workspaceConnections, setWorkspaceConnections] = useState<ChannelConnection[]>([]);
  // §3.3 — a shared connection CAN be restricted to specific agents (Settings →
  // Channels → Permissions). null = still checking; true = open or this agent is
  // granted; false = restricted and this agent is not on the list.
  const [access, setAccess] = useState<Record<string, boolean | null>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ connections: ChannelConnection[] }>('/v1/channels');
      const all = data.connections ?? [];
      setConnections(all.filter((conn) => conn.agentId === agentId));
      const shared = all.filter((conn) => conn.agentId == null);
      setWorkspaceConnections(shared);
      const results = await Promise.allSettled(
        shared.map((conn) => api<{ grants: Array<{ agentId: string; status: string }> }>(`/v1/channels/${conn.id}/grants`)),
      );
      const next: Record<string, boolean | null> = {};
      shared.forEach((conn, i) => {
        const r = results[i];
        if (r?.status !== 'fulfilled') { next[conn.id] = null; return; }
        const activeGrants = r.value.grants.filter((g) => g.status === 'active');
        next[conn.id] = activeGrants.length === 0 || activeGrants.some((g) => g.agentId === agentId);
      });
      setAccess(next);
    } catch {
      setConnections([]);
      setWorkspaceConnections([]);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (connections === null) return <Skeleton height={360} />;

  return (
    <div className="max-w-2xl space-y-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Channels</div>
        <p className="mt-1 text-[13px] text-text-secondary">
          Give {agentName} its OWN channel (its identity, its inbox), or use a shared workspace channel below.
          Saved channels are verified before they are marked active.
        </p>
      </div>

      {workspaceConnections.length > 0 && (
        <div className="rounded-card border border-line bg-surface-2/40 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Shared workspace channels</div>
          <p className="mt-1 text-[12px] text-text-secondary">
            Connected globally in Settings → Channels — no separate connection needed unless it&apos;s been restricted below.
          </p>
          <div className="mt-2 space-y-1.5">
            {workspaceConnections.map((conn) => {
              const ok = access[conn.id];
              return (
                <div key={conn.id} className="flex items-center gap-2 text-[13px] text-text-primary">
                  <span className="capitalize">{conn.kind}</span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-secondary">{conn.name}</span>
                  <span className={clsx(
                    'ml-auto rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    ok == null ? 'bg-surface-3 text-text-muted'
                      : ok ? 'bg-success-soft text-success'
                      : 'bg-warn-soft text-warn',
                  )}>
                    {ok == null ? 'checking…' : ok ? `${agentName} can send` : 'restricted — no access'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'save' | 'link' | 'target' | null>(null);
  const [name, setName] = useState(`${agentName} ${provider.label}`);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [usePersistent, setUsePersistent] = useState(provider.kind === 'telegram');
  const [whatsappMode, setWhatsappMode] = useState<WhatsAppMode>('qr_local');
  const [signingSecret, setSigningSecret] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [qr, setQr] = useState<QrState | null>(null);
  const [lastHealth, setLastHealth] = useState<ChannelHealth | null>(null);
  const [access, setAccess] = useState<ChannelAccess>({ recipients: [], answerAnyone: false });

  const health = lastHealth ?? connection?.health ?? EMPTY_HEALTH;
  const qrConnId = qr?.connectionId;
  const linked = qr?.status === 'open';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Edge-triggered toast guard: a failed link can sit at logged_out/error for a
  // while before the operator clicks Relink, and the poll ticks every second —
  // without this, that one failure re-toasts every tick ("3 stacked toasts").
  const lastQrStatusRef = useRef<string | null>(null);

  useEffect(() => {
    setLastHealth(null);
    setChatId(connection?.defaultChatId ?? '');
    setAccess(connection?.access ?? { recipients: [], answerAnyone: false });
  }, [connection?.id, connection?.status, connection?.defaultChatId]);

  useEffect(() => {
    if (!qrConnId || linked) {
      if (pollRef.current) clearInterval(pollRef.current);
      lastQrStatusRef.current = null;
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
            toast.success(`${provider.label} transport open`);
            setQr(null);
            setConnecting(false);
            lastQrStatusRef.current = null;
            await onChanged();
          } else if (state.status === 'logged_out' || state.status === 'error') {
            // Edge-triggered — only the tick that TRANSITIONS into the failure
            // toasts, not every tick the poll happens to observe it.
            if (lastQrStatusRef.current !== state.status) {
              toast.error(`${provider.label} login failed`, 'Generate a new QR and relink the device.');
            }
          }
          lastQrStatusRef.current = state.status;
        } catch {
          /* transient polling failure */
        }
      })();
    }, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [qrConnId, linked, provider.label, toast, onChanged]);

  async function saveConnection() {
    const isWhatsAppCloud = provider.kind === 'whatsapp' && whatsappMode === 'cloud';
    const needsToken = provider.kind !== 'whatsapp' || isWhatsAppCloud;
    if (needsToken && token.trim().length < 8) {
      toast.error('Token too short', 'Paste the full provider token.');
      return;
    }
    if (isWhatsAppCloud && (!phoneNumberId.trim() || !appSecret.trim() || !verifyToken.trim())) {
      toast.error('Cloud setup incomplete', 'Add phone number ID, app secret, and verify token.');
      return;
    }
    setBusy('save');
    try {
      const created = await api<{ connection: ChannelConnection; health: ChannelHealth }>('/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: provider.kind,
          name: name.trim() || `${agentName} ${provider.label}`,
          agentId,
          ...(needsToken ? { token: token.trim() } : {}),
          defaultChatId: chatId.trim() || undefined,
          ...(provider.kind === 'whatsapp' ? { mode: whatsappMode } : {}),
          ...(provider.kind === 'slack' && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
          ...(isWhatsAppCloud
            ? {
                phoneNumberId: phoneNumberId.trim(),
                appSecret: appSecret.trim(),
                verifyToken: verifyToken.trim(),
                defaultRecipient: chatId.trim() || undefined,
              }
            : {}),
          ...(provider.persistent && usePersistent ? { transport: provider.persistent.value } : {}),
        }),
      });
      setLastHealth(created.health);
      if (created.health.status === 'active') {
        toast.success(`${provider.label} active`);
      } else {
        toast.error(`${provider.label} needs action`, firstProblem(created.health) ?? 'Open the check details.');
      }
      setConnecting(false);
      setToken('');
      setSigningSecret('');
      setAppSecret('');
      setVerifyToken('');
      await onChanged();
    } catch (err) {
      toast.error(`Could not save ${provider.label}`, String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startQrLogin(existingId?: string) {
    setBusy('save');
    try {
      let connId = existingId;
      if (!connId) {
        const created = await api<{ connection: ChannelConnection; health: ChannelHealth }>('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({
            kind: provider.kind,
            mode: 'qr_local',
            name: name.trim() || `${agentName} ${provider.label}`,
            agentId,
            defaultChatId: chatId.trim() || undefined,
          }),
        });
        connId = created.connection.id;
        setLastHealth(created.health);
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
    try {
      const result = await api<{ ok: boolean; health: ChannelHealth }>(`/v1/channels/${connection.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ body: `Hello from ${agentName}.` }),
      });
      setLastHealth(result.health);
      if (result.ok) toast.success('Channel test passed');
      else toast.error('Channel needs action', firstProblem(result.health) ?? 'Open the check details.');
      await onChanged();
    } catch (err) {
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

  async function saveTargets() {
    if (!connection) return;
    setBusy('target');
    try {
      const result = await api<{ connection: ChannelConnection; health: ChannelHealth }>(`/v1/channels/${connection.id}/targets`, {
        method: 'PATCH',
        body: JSON.stringify({
          defaultChatId: chatId.trim() || null,
          access: {
            recipients: (access.recipients ?? [])
              .map((r) => ({ handle: r.handle.trim(), name: r.name?.trim() || undefined, rules: r.rules?.trim() || undefined }))
              .filter((r) => r.handle.length > 0),
            answerAnyone: Boolean(access.answerAnyone),
            anyoneRules: access.anyoneRules?.trim() || undefined,
          },
        }),
      });
      setLastHealth(result.health);
      toast.success('Default recipient saved');
      await onChanged();
    } catch (err) {
      toast.error('Could not save recipient', String(err));
    } finally {
      setBusy(null);
    }
  }

  const isWhatsApp = provider.kind === 'whatsapp';
  const isQrConnection = isWhatsApp && connection?.mode !== 'cloud';
  const status = connection?.status ?? health.status;
  const active = status === 'active';
  const needsLink = Boolean(connection && isQrConnection && connection.status !== 'active');

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-text-primary">{provider.label}</span>
        <StatusBadge status={status} />
        {isQrConnection && connection?.transportStatus ? (
          <span className="text-[11px] text-text-muted">transport: {connection.transportStatus}</span>
        ) : null}
      </div>

      {qr ? (
        <QrPanel provider={provider} qr={qr} onCancel={() => { setQr(null); setConnecting(false); }} />
      ) : connection ? (
        <>
          <div className="mt-1 text-[12px] text-text-muted">
            {connection.name}
            {connection.mode ? ` · ${connection.mode === 'cloud' ? 'Cloud API' : 'QR local'}` : ''}
            {connection.defaultChatId ? ` · target: ${connection.defaultChatId}` : ''}
          </div>
          {connection.lastError && <div className="mt-1 text-[12px] text-danger">{connection.lastError}</div>}
          <TargetEditor
            provider={provider}
            value={chatId}
            busy={busy === 'target'}
            onChange={setChatId}
            onSave={() => void saveTargets()}
            access={access}
            onAccessChange={setAccess}
          />
          <HealthDetails health={health} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void test()}>
              {busy === 'test' ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
            </Button>
            {needsLink ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void startQrLogin(connection.id)}>
                {busy === 'save' ? 'Starting...' : 'Relink QR'}
              </Button>
            ) : isQrConnection ? (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void startQrLogin(connection.id)}>
                <RefreshCcw size={12} /> Restart link
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
          {!active && <ProblemHint health={health} />}
        </>
      ) : connecting ? (
        <div className="mt-3 space-y-2">
          <ConnectField label="Connection name">
            <input value={name} onChange={(event) => setName(event.target.value)} className={INPUT_CLS} />
          </ConnectField>

          {isWhatsApp && (
            <div className="grid grid-cols-2 gap-2">
              <ModeButton active={whatsappMode === 'qr_local'} onClick={() => setWhatsappMode('qr_local')} title="QR local" detail="Easy setup" />
              <ModeButton active={whatsappMode === 'cloud'} onClick={() => setWhatsappMode('cloud')} title="Cloud API" detail="Production" />
            </div>
          )}

          {(!isWhatsApp || whatsappMode === 'cloud') && (
            <ConnectField label={isWhatsApp ? 'Cloud access token' : 'Bot token'} hint={provider.hint}>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                placeholder="Paste token"
                className={INPUT_CLS}
              />
            </ConnectField>
          )}

          {provider.kind === 'slack' && (
            <ConnectField label="Signing secret" hint="Required for Events API URL verification and signed callbacks">
              <input
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
                type="password"
                placeholder="Slack signing secret"
                className={INPUT_CLS}
              />
            </ConnectField>
          )}

          {isWhatsApp && whatsappMode === 'cloud' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <ConnectField label="Phone number ID">
                <input value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} className={INPUT_CLS} />
              </ConnectField>
              <ConnectField label="Verify token">
                <input value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} type="password" className={INPUT_CLS} />
              </ConnectField>
              <div className="sm:col-span-2">
                <ConnectField label="App secret">
                  <input value={appSecret} onChange={(event) => setAppSecret(event.target.value)} type="password" className={INPUT_CLS} />
                </ConnectField>
              </div>
            </div>
          )}

          <ConnectField label={isWhatsApp ? 'Default recipient' : 'Default chat ID'} hint={targetHint(provider.kind)}>
            <input
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder={targetPlaceholder(provider.kind)}
              className={INPUT_CLS}
            />
          </ConnectField>

          {provider.persistent && (
            <label className="flex items-center gap-2 text-[12px] text-text-secondary">
              <input type="checkbox" checked={usePersistent} onChange={(event) => setUsePersistent(event.target.checked)} />
              {provider.persistent.label}
            </label>
          )}
          {provider.kind === 'discord' && usePersistent && (
            <div className="rounded-input border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-text-secondary">
              Gateway mode requires the Discord Message Content intent.
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {isWhatsApp && whatsappMode === 'qr_local' ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void startQrLogin()}>
                {busy === 'save' ? 'Starting...' : 'Show QR'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void saveConnection()}>
                {busy === 'save' ? 'Verifying...' : `Save ${provider.label}`}
              </Button>
            )}
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
            onClick={() => setConnecting(true)}
          >
            Connect {provider.label}
          </Button>
        </div>
      )}
    </div>
  );
}

function QrPanel({ provider, qr, onCancel }: { provider: Provider; qr: QrState; onCancel: () => void }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-input border border-line bg-surface-2 p-4">
      {qr.dataUrl ? (
        <img src={qr.dataUrl} alt={`${provider.label} login QR`} className="h-44 w-44 rounded bg-white p-1" />
      ) : (
        <Loader2 size={28} className="animate-spin text-text-muted" />
      )}
      <p className="text-center text-[12px] text-text-secondary">
        Open WhatsApp Linked Devices and scan this code.
      </p>
      <p className="text-[11px] text-text-muted">Transport status: {qr.status}</p>
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function StatusBadge({ status }: { status: ChannelStatus }) {
  const tone =
    status === 'active' ? 'text-success' :
    status === 'needs_action' || status === 'verifying' ? 'text-amber-500' :
    status === 'degraded' ? 'text-cyan-400' :
    status === 'error' ? 'text-danger' :
    'text-text-muted';
  const dot =
    status === 'active' ? 'bg-success' :
    status === 'needs_action' || status === 'verifying' ? 'bg-amber-500' :
    status === 'degraded' ? 'bg-cyan-400' :
    status === 'error' ? 'bg-danger' :
    'bg-text-muted';
  const label =
    status === 'active' ? 'active' :
    status === 'needs_action' ? 'needs action' :
    status === 'verifying' ? 'verifying' :
    status === 'degraded' ? 'degraded' :
    status === 'error' ? 'error' :
    status || 'not connected';
  return (
    <span className={clsx('flex items-center gap-1 text-[12px]', tone)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', dot)} /> {label}
    </span>
  );
}

function HealthDetails({ health }: { health: ChannelHealth }) {
  if (!health.checks.length) return null;
  return (
    <div className="mt-3 grid gap-1.5">
      {health.checks.map((check) => (
        <div key={check.name} className="rounded-input border border-line bg-surface-2 px-3 py-2">
          <div className="flex items-start gap-2">
            {check.ok ? <CheckCircle2 size={13} className="mt-0.5 text-accent" /> : <XCircle size={13} className="mt-0.5 text-danger" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-medium capitalize text-text-primary">{check.name}</span>
                <span className="font-mono text-[10px] text-text-muted">{check.code}</span>
              </div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">{check.message}</div>
              {check.remediation ? <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{check.remediation}</div> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProblemHint({ health }: { health: ChannelHealth }) {
  const problem = health.checks.find((check) => !check.ok);
  if (!problem) return null;
  return (
    <div className="mt-3 flex gap-2 rounded-input border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-text-secondary">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
      <span>{problem.remediation ?? problem.message}</span>
    </div>
  );
}

function TargetEditor({
  provider,
  value,
  busy,
  onChange,
  onSave,
  access,
  onAccessChange,
}: {
  provider: Provider;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  access: ChannelAccess;
  onAccessChange: (access: ChannelAccess) => void;
}) {
  const recipients = access.recipients ?? [];
  const setRecipient = (i: number, patch: Partial<ChannelRecipient>) =>
    onAccessChange({ ...access, recipients: recipients.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  const addRecipient = () => onAccessChange({ ...access, recipients: [...recipients, { handle: '' }] });
  const removeRecipient = (i: number) => onAccessChange({ ...access, recipients: recipients.filter((_, idx) => idx !== i) });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-input border border-line bg-surface-2 px-3 py-3">
      <ConnectField
        label={provider.kind === 'whatsapp' ? 'Default recipient (you)' : 'Default target (you)'}
        hint="You — full access, no rules needed."
      >
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={targetPlaceholder(provider.kind)}
          className={INPUT_CLS}
        />
      </ConnectField>

      <div>
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
          People with rules
        </span>
        <div className="flex flex-col gap-2">
          {recipients.map((r, i) => (
            <div key={i} className="rounded-input border border-line bg-surface-1 p-2">
              <div className="flex items-center gap-2">
                <input
                  value={r.handle}
                  onChange={(event) => setRecipient(i, { handle: event.target.value })}
                  placeholder={targetPlaceholder(provider.kind)}
                  className={INPUT_CLS}
                />
                <input
                  value={r.name ?? ''}
                  onChange={(event) => setRecipient(i, { name: event.target.value })}
                  placeholder="Name"
                  className={INPUT_CLS}
                  style={{ maxWidth: '140px' }}
                />
                <button
                  type="button"
                  aria-label="Remove person"
                  onClick={() => removeRecipient(i)}
                  className="shrink-0 px-1 text-text-muted hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                value={r.rules ?? ''}
                onChange={(event) => setRecipient(i, { rules: event.target.value })}
                placeholder="Rules in plain words — e.g. My assistant. Can check my calendar and answer questions, but don't send money or delete anything."
                rows={2}
                className={`${INPUT_CLS} mt-2`}
              />
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" iconLeft={<Plus size={12} />} onClick={addRecipient} className="mt-2">
          Add person
        </Button>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-text-secondary">
        <input
          type="checkbox"
          checked={Boolean(access.answerAnyone)}
          onChange={(event) => onAccessChange({ ...access, answerAnyone: event.target.checked })}
        />
        Reply to anyone else
      </label>
      {access.answerAnyone && (
        <ConnectField label="Rules for anyone not listed" hint="How should the agent behave with people you haven't listed?">
          <textarea
            value={access.anyoneRules ?? ''}
            onChange={(event) => onAccessChange({ ...access, anyoneRules: event.target.value })}
            rows={3}
            placeholder="You're answering on my behalf. Be friendly and helpful, never share my personal details, and don't take any actions — take a message and let me know."
            className={INPUT_CLS}
          />
        </ConnectField>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onSave}>
          {busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-input border px-3 py-2 text-left transition-colors',
        active ? 'border-accent bg-accent/10 text-text-primary' : 'border-line bg-surface-2 text-text-secondary hover:text-text-primary',
      )}
    >
      <span className="block text-[12px] font-medium">{title}</span>
      <span className="text-[11px] text-text-muted">{detail}</span>
    </button>
  );
}

const INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function ConnectField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}

function targetPlaceholder(kind: ChannelKind): string {
  if (kind === 'whatsapp') return '+12345678901 or 12345678901@s.whatsapp.net';
  if (kind === 'slack') return 'Slack channel ID';
  if (kind === 'discord') return 'Discord channel ID';
  if (kind === 'telegram') return 'Human Telegram chat ID';
  return 'Target ID';
}

function targetHint(kind: ChannelKind): string {
  if (kind === 'whatsapp') return 'Optional. Explicit phone numbers still work without this.';
  if (kind === 'telegram') return 'Use the human chat ID after that account sends /start to the bot.';
  return "Used for Test and default recipient.";
}

function firstProblem(health: ChannelHealth): string | null {
  const problem = health.checks.find((check) => !check.ok);
  return problem?.remediation ?? problem?.message ?? null;
}



