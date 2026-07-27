/**
 * CustomOAuthProvidersPanel — "bring your own OAuth app" for ANY service
 * (INTEGRATION-CEILING-10X §2). Settings → Integrations.
 *
 * The built-in provider list (Google, Slack, GitHub, …) is a fixed set the
 * platform ships OAuth defs for. This panel is the generic escape hatch: paste
 * any service's authUrl/tokenUrl/client id+secret (found in that service's own
 * developer console) and connect it the same way — no Agentis-core change.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2, Link as LinkIcon } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Button } from '../shared/Button';

interface CustomProvider {
  providerId: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  clientId: string;
  hasClientSecret: boolean;
  updatedAt: string;
}

const inputCls =
  'h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

export function CustomOAuthProvidersPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [providers, setProviders] = useState<CustomProvider[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = await api<{ providers: CustomProvider[] }>('/v1/oauth/custom');
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function remove(p: CustomProvider) {
    if (!(await confirm({ title: `Remove ${p.label}?`, body: 'Any credential already minted from it keeps working; you just can’t reconnect through it.', confirmLabel: 'Remove' }))) return;
    try {
      await api(`/v1/oauth/custom/${p.providerId}`, { method: 'DELETE' });
      toast.success('Removed');
      void refresh();
    } catch (err) {
      toast.error('Could not remove', apiErrorMessage(err));
    }
  }

  function connect(p: CustomProvider) {
    setConnectingId(p.providerId);
    api<{ url: string }>(`/v1/oauth/custom/${p.providerId}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ origin: window.location.origin }),
    }).then(({ url }) => {
      const popup = window.open(url, 'agentis-oauth', 'popup,width=520,height=680');
      const onMessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; ok?: boolean };
        if (message?.type !== 'agentis-oauth') return;
        window.removeEventListener('message', onMessage);
        setConnectingId(null);
        if (message.ok) toast.success(`${p.label} connected`);
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          window.removeEventListener('message', onMessage);
          setConnectingId(null);
        }
      }, 500);
    }).catch((err) => {
      setConnectingId(null);
      toast.error('Could not start OAuth', apiErrorMessage(err));
    });
  }

  return (
    <section className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-text-primary">Custom OAuth connections</h3>
        {!adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus size={14} className="mr-1" /> Add
          </Button>
        )}
      </div>
      <p className="mb-3 text-[12px] text-text-muted">
        Not on the built-in list (Instagram, an ads API, your own internal tool, …)? Paste its OAuth app details from its
        developer console — the redirect URI to register there is shown below.
      </p>

      {adding && (
        <AddProviderForm
          onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); void refresh(); }}
        />
      )}

      {providers === null ? null : providers.length === 0 && !adding ? (
        <p className="rounded-card border border-line bg-surface px-4 py-3 text-[13px] text-text-muted">
          No custom OAuth providers configured yet.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {providers.map((p) => (
            <div key={p.providerId} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
              <LinkIcon size={14} className="text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-text-primary">{p.label}</div>
                <div className="truncate text-[12px] text-text-muted">{p.authUrl}</div>
              </div>
              <Button size="sm" variant="primary" disabled={connectingId === p.providerId} onClick={() => connect(p)}>
                {connectingId === p.providerId ? 'Connecting…' : 'Connect'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(p)}>
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AddProviderForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [pkce, setPkce] = useState(false);
  const [saving, setSaving] = useState(false);

  const redirectPreview = providerId.trim()
    ? `${window.location.origin.replace(/^https?:\/\/[^/]+/, '<your-agentis-server>')}/v1/oauth/custom/${providerId.trim().toLowerCase()}/callback`
    : '<your-agentis-server>/v1/oauth/custom/<id>/callback';

  async function save() {
    if (!providerId.trim() || !label.trim() || !authUrl.trim() || !tokenUrl.trim() || !clientId.trim() || !clientSecret.trim()) {
      toast.error('All fields except scopes are required');
      return;
    }
    setSaving(true);
    try {
      await api(`/v1/oauth/custom/${providerId.trim().toLowerCase()}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: label.trim(),
          authUrl: authUrl.trim(),
          tokenUrl: tokenUrl.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
          pkce,
        }),
      });
      toast.success(`${label} added`);
      onSaved();
    } catch (err) {
      toast.error('Could not save', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-3 space-y-2 rounded-card border border-line bg-surface px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Id (slug)</span>
          <input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="instagram" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Instagram" className={inputCls} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Authorize URL</span>
        <input value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} placeholder="https://api.example.com/oauth/authorize" className={inputCls} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Token URL</span>
        <input value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="https://api.example.com/oauth/token" className={inputCls} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Client ID</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Client secret</span>
          <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" className={inputCls} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">Scopes (comma-separated, optional)</span>
        <input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="user_profile, user_media" className={inputCls} />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-text-secondary">
        <input type="checkbox" checked={pkce} onChange={(e) => setPkce(e.target.checked)} />
        This provider requires PKCE
      </label>
      <p className="text-[11px] text-text-muted">
        Register this redirect URI with the provider: <code className="rounded bg-canvas/70 px-1 font-mono">{redirectPreview}</code>
      </p>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
