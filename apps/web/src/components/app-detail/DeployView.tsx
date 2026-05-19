/**
 * DeployView — the app's Deploy layer tab (AGENTIS-PLATFORM-10X §Layer 5).
 *
 * Shows the deployment target, exposed API routes, webhook bindings, and the
 * api-key control. Every target here runs on infrastructure the operator
 * owns — `local`, `always_on`, `scheduled`, or `api_server`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Rocket, Globe, Webhook, KeyRound, Copy, Signal } from 'lucide-react';
import { api } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';

interface SurfaceStatusItem {
  type: string;
  label: string;
  configured: boolean;
  live: boolean;
  activityToday: number;
  activityUnit: string;
  lastActivityAt: string | null;
}

interface DeployInfo {
  deployTarget: string;
  deployStatus: string;
  hasApiKey: boolean;
  surfaces: Array<{ type: string; label?: string }>;
  surfaceEndpoints: Array<{ type: string; label: string; url: string }>;
  surfaceStatus: SurfaceStatusItem[];
  apiRoutes: Array<{ method: string; path: string; handler: string; auth: string }>;
  deployConfig: unknown;
  baseUrl: string;
  webhookUrl: string | null;
}

const TARGETS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'local', label: 'Local', hint: 'Runs while this server is running' },
  { value: 'always_on', label: 'Always-on', hint: 'Persistent — restarts on failure' },
  { value: 'scheduled', label: 'Scheduled', hint: 'Wakes on trigger, sleeps between' },
  { value: 'api_server', label: 'API server', hint: 'Stable HTTP endpoint, always listening' },
];

export function DeployView({ appId }: { appId: string }) {
  const [info, setInfo] = useState<DeployInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setInfo(await api<DeployInfo>(`/v1/apps/${appId}/deploy`));
    } catch {
      setInfo(null);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setTarget(target: string) {
    setBusy(true);
    try {
      await api(`/v1/apps/${appId}/deploy`, {
        method: 'PUT',
        body: JSON.stringify({ target }),
      });
      await load();
      toast.success(`Deploy target set to ${target}`);
    } catch {
      toast.error('Could not change deploy target');
    } finally {
      setBusy(false);
    }
  }

  async function mintKey() {
    setBusy(true);
    try {
      const res = await api<{ apiKey: string }>(`/v1/apps/${appId}/deploy/api-key`, {
        method: 'POST',
      });
      setMintedKey(res.apiKey);
      await load();
    } catch {
      toast.error('Could not mint API key');
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={120} />
        <Skeleton height={200} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Surface connections — compact live-status strip */}
      <section>
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
          <Signal size={15} /> Surface connections
        </div>
        <div className="space-y-1 rounded-lg border border-line p-3">
          {(info.surfaceStatus ?? []).map((s) => (
            <SurfaceRow key={s.type} item={s} />
          ))}
        </div>
      </section>

      {/* Deployment target */}
      <section>
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
          <Rocket size={15} /> Deployment target
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TARGETS.map((t) => (
            <button
              key={t.value}
              disabled={busy}
              onClick={() => void setTarget(t.value)}
              className={
                'rounded-lg border p-3 text-left transition ' +
                (info.deployTarget === t.value
                  ? 'border-accent bg-accent/10'
                  : 'border-line hover:border-text-muted')
              }
            >
              <div className="text-[13px] font-medium text-text-primary">{t.label}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-text-muted">{t.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-2 text-[12px] text-text-muted">
          Status: <span className="text-text-secondary">{info.deployStatus}</span>
        </div>
      </section>

      {/* Endpoints */}
      <section>
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
          <Globe size={15} /> Endpoints
        </div>
        <div className="space-y-1.5 rounded-lg border border-line p-3 text-[12px]">
          {(info.surfaceEndpoints ?? []).map((s) => (
            <EndpointRow key={s.type} label={s.label} value={s.url} onCopy={copy} />
          ))}
          {(info.surfaceEndpoints ?? []).length === 0 && (
            <EndpointRow label="API base" value={info.baseUrl} onCopy={copy} />
          )}
          {info.surfaceEndpoints?.some((s) => s.type === 'api') && (
            <EndpointRow label="Data layer" value={`${info.baseUrl}/data/:table`} onCopy={copy} />
          )}
        </div>
      </section>

      {/* API routes */}
      {info.apiRoutes.length > 0 && (
        <section>
          <div className="mb-2 text-[13px] font-semibold text-text-primary">Declared API routes</div>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-[12px]">
              <thead className="bg-surface-raised text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Method</th>
                  <th className="px-3 py-2 text-left font-medium">Path</th>
                  <th className="px-3 py-2 text-left font-medium">Handler</th>
                  <th className="px-3 py-2 text-left font-medium">Auth</th>
                </tr>
              </thead>
              <tbody>
                {info.apiRoutes.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-1.5 font-mono text-text-primary">{r.method}</td>
                    <td className="px-3 py-1.5 font-mono text-text-secondary">{r.path}</td>
                    <td className="px-3 py-1.5 text-text-secondary">{r.handler}</td>
                    <td className="px-3 py-1.5 text-text-muted">{r.auth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Webhook surface badge */}
      {info.surfaces.some((s) => s.type === 'webhook_receiver') && (
        <section className="flex items-center gap-2 rounded-lg border border-line p-3 text-[12px] text-text-secondary">
          <Webhook size={14} /> This app exposes a webhook receiver — external systems can POST events
          to it.
        </section>
      )}

      {/* API key */}
      <section>
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
          <KeyRound size={15} /> API key
        </div>
        {mintedKey ? (
          <div className="rounded-lg border border-accent bg-accent/10 p-3">
            <div className="text-[12px] text-text-secondary">
              Copy this key now — it cannot be retrieved again.
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-surface-raised px-2 py-1 font-mono text-[12px] text-text-primary">
                {mintedKey}
              </code>
              <Button size="sm" variant="ghost" onClick={() => copy(mintedKey)}>
                <Copy size={13} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-[12px] text-text-muted">
            <span>{info.hasApiKey ? 'An API key is set.' : 'No API key yet.'}</span>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void mintKey()}>
              {info.hasApiKey ? 'Rotate key' : 'Generate key'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );

  function copy(value: string) {
    void navigator.clipboard?.writeText(value);
    toast.success('Copied');
  }
}

function EndpointRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-text-muted">{label}</span>
      <code className="flex-1 truncate font-mono text-text-secondary">{value}</code>
      <button className="text-text-muted hover:text-text-primary" onClick={() => onCopy(value)}>
        <Copy size={12} />
      </button>
    </div>
  );
}

/**
 * One row in the compact surface-connections strip.
 * ● thread   live · 3 messages today
 * ○ webhook_receiver   not configured
 */
function SurfaceRow({ item }: { item: SurfaceStatusItem }) {
  const dotClass = item.live
    ? 'bg-accent'
    : item.configured
      ? 'bg-text-muted'
      : 'bg-surface-3 border border-line';

  let meta = '';
  if (!item.configured) {
    meta = 'not configured';
  } else if (item.live) {
    meta = `live${item.activityToday > 0 ? ` · ${item.activityToday} ${item.activityUnit}${item.activityToday !== 1 ? 's' : ''} today` : ''}`;
    if (item.lastActivityAt) meta += ` · last ${surfaceRelTime(item.lastActivityAt)}`;
  } else {
    meta = 'configured · not running';
  }

  return (
    <div className="flex items-center gap-2.5 py-0.5 text-[12px]">
      <span className={`mt-px h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span className="w-32 shrink-0 text-text-primary">{item.label}</span>
      <span className={item.live ? 'text-accent' : 'text-text-muted'}>{meta}</span>
    </div>
  );
}

function surfaceRelTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
