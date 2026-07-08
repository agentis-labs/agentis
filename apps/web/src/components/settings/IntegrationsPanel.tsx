import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, ExternalLink, Key, Plus, Search, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Button, IconButton } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { CustomIntegrationDialog } from '../integrations/CustomIntegrationDialog';
import { connectorAccent, connectorLogoUrl } from '../canvas/connectorLogo';
import { humanizeIdentifier, integrationNeedsCredential, type IntegrationManifestLite } from '../canvas/nodeConfigRegistry';

interface CredentialRow {
  id: string;
  name: string;
  credentialType: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OAuthProvider {
  id: string;
  label: string;
  slugs: string[];
  configured?: boolean;
}

const inputCls =
  'h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function IntegrationLogo({ slug, name }: { slug: string; name: string }) {
  const url = connectorLogoUrl(slug);
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return <img src={url} alt="" className="h-8 w-8 shrink-0 rounded-[6px] object-contain" onError={() => setFailed(true)} />;
  }
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-[13px] font-bold text-white"
      style={{ backgroundColor: connectorAccent(slug) }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function credentialMatchesIntegration(credential: CredentialRow, slug: string): boolean {
  const normalized = slug.toLowerCase();
  const type = credential.credentialType.toLowerCase();
  return type === normalized || type === `integration_${normalized}` || type === `oauth_${normalized}`;
}

function credentialFieldsFor(manifest: IntegrationManifestLite): string[] {
  const fields = manifest.credentialSchema?.fields;
  return Array.isArray(fields) && fields.length > 0
    ? fields.map((field) => String(field))
    : ['token'];
}

function isSecretField(field: string) {
  return /token|secret|password|key|credential/i.test(field);
}

export function IntegrationsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [integrations, setIntegrations] = useState<IntegrationManifestLite[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [editing, setEditing] = useState<{ manifest: IntegrationManifestLite; credential?: CredentialRow } | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [integrationRes, credentialRes, providerRes] = await Promise.allSettled([
        api<{ integrations: IntegrationManifestLite[] }>('/v1/integrations'),
        api<{ credentials: CredentialRow[] }>('/v1/credentials'),
        api<{ providers: OAuthProvider[] }>('/v1/oauth/providers'),
      ]);
      setIntegrations(integrationRes.status === 'fulfilled' ? integrationRes.value.integrations ?? [] : []);
      setCredentials(credentialRes.status === 'fulfilled' ? credentialRes.value.credentials ?? [] : []);
      setProviders(providerRes.status === 'fulfilled' ? providerRes.value.providers ?? [] : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return integrations
      .filter((item) => !needle || `${item.name} ${item.service} ${item.category ?? ''}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftConnected = credentials.some((credential) => credentialMatchesIntegration(credential, left.service));
        const rightConnected = credentials.some((credential) => credentialMatchesIntegration(credential, right.service));
        return Number(rightConnected) - Number(leftConnected) || left.name.localeCompare(right.name);
      });
  }, [credentials, integrations, query]);

  async function deleteCredential(credential: CredentialRow) {
    const ok = await confirm({
      title: `Delete "${credential.name}"?`,
      body: 'Workflows using this credential will need another saved credential before they can run.',
      confirmLabel: 'Delete credential',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/credentials/${credential.id}`, { method: 'DELETE' });
      toast.success('Credential deleted');
      void refresh();
    } catch (err) {
      toast.error('Failed to delete credential', apiErrorMessage(err));
    }
  }

  function providerFor(manifest: IntegrationManifestLite) {
    return providers.find((provider) => provider.slugs.includes(manifest.service.toLowerCase()));
  }

  function connectOAuth(manifest: IntegrationManifestLite) {
    const provider = providerFor(manifest);
    if (!provider) {
      toast.error('OAuth provider unavailable');
      return;
    }
    if (provider.configured === false) {
      toast.error(`${provider.label} sign-in is not enabled on this server`);
      return;
    }
    setConnectingSlug(manifest.service);
    api<{ url: string }>(`/v1/oauth/${provider.id}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ integrationSlug: manifest.service, origin: window.location.origin }),
    }).then(({ url }) => {
      const popup = window.open(url, 'agentis-oauth', 'popup,width=520,height=680');
      const onMessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; ok?: boolean };
        if (message?.type !== 'agentis-oauth') return;
        window.removeEventListener('message', onMessage);
        setConnectingSlug(null);
        if (message.ok) {
          toast.success(`${manifest.name} connected`);
          void refresh();
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          window.removeEventListener('message', onMessage);
          setConnectingSlug(null);
        }
      }, 800);
    }).catch((err) => {
      setConnectingSlug(null);
      toast.error('Failed to start OAuth', apiErrorMessage(err));
    });
  }

  if (loading) return <Skeleton height={320} />;

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-subheading text-text-primary">Integrations</h2>
          <p className="mt-1 text-[12px] text-text-muted">Workspace credentials are shared by every workflow.</p>
        </div>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setCustomOpen(true)}>
          New integration
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className={clsx(inputCls, 'pl-9')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search integrations"
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center text-[13px] text-text-muted">
          No integrations match this search.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((manifest) => {
            const saved = credentials.filter((credential) => credentialMatchesIntegration(credential, manifest.service));
            const needsCredential = integrationNeedsCredential(manifest);
            const isOAuth = (manifest.auth?.type ?? manifest.credentialSchema?.type) === 'oauth2';
            return (
              <div key={manifest.service} className="rounded-card border border-line bg-surface p-4">
                <div className="flex items-start gap-3">
                  <IntegrationLogo slug={manifest.icon || manifest.service} name={manifest.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-[14px] font-semibold text-text-primary">{manifest.name}</h3>
                      {saved.length > 0 && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                          <CheckCircle2 size={11} /> Connected
                        </span>
                      )}
                      {(manifest as { readiness?: string }).readiness === 'needs_setup' && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"
                          title="No native runtime yet â€” this connector falls back to a generic HTTP call (needs a raw URL). For a working path, connect its MCP server in Connections and use an mcp node."
                        >
                          Needs setup
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                      <span>{manifest.category ?? 'Connector'}</span>
                      <span className="font-mono">{manifest.service}</span>
                      {manifest.docsUrl && (
                        <a href={manifest.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                          Docs <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                {manifest.description && <p className="mt-3 line-clamp-2 text-[12px] leading-relaxed text-text-muted">{manifest.description}</p>}

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {manifest.operations.slice(0, 5).map((operation) => (
                    <span key={operation} className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary">
                      {humanizeIdentifier(operation)}
                    </span>
                  ))}
                  {manifest.operations.length > 5 && (
                    <span className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-text-muted">
                      +{manifest.operations.length - 5}
                    </span>
                  )}
                </div>

                <div className="mt-4 space-y-2">
                  {saved.map((credential) => (
                    <div key={credential.id} className="flex items-center gap-2 rounded-input border border-line bg-surface-2 px-3 py-2">
                      <Key size={13} className="text-text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-medium text-text-primary">{credential.name}</div>
                        <div className="font-mono text-[10px] text-text-muted">{credential.credentialType}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ manifest, credential })}>Edit</Button>
                      <IconButton icon={<Trash2 size={14} />} label="Delete credential" variant="ghost" size="sm" onClick={() => void deleteCredential(credential)} />
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex justify-end">
                  {!needsCredential ? (
                    <span className="inline-flex h-8 items-center rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] text-text-muted">
                      No credential required
                    </span>
                  ) : isOAuth ? (
                    <Button
                      variant={saved.length > 0 ? 'secondary' : 'primary'}
                      size="sm"
                      iconLeft={<Key size={13} />}
                      loading={connectingSlug === manifest.service}
                      onClick={() => connectOAuth(manifest)}
                    >
                      {saved.length > 0 ? 'Connect another' : 'Connect'}
                    </Button>
                  ) : (
                    <Button
                      variant={saved.length > 0 ? 'secondary' : 'primary'}
                      size="sm"
                      iconLeft={<Key size={13} />}
                      onClick={() => setEditing({ manifest })}
                    >
                      {saved.length > 0 ? 'Add another' : 'Configure'}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CredentialDialog
        entry={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void refresh();
        }}
      />
      <CustomIntegrationDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        onCreated={() => void refresh()}
      />
    </div>
  );
}

function CredentialDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: { manifest: IntegrationManifestLite; credential?: CredentialRow } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setName(entry.credential?.name ?? `${entry.manifest.name} (${entry.manifest.service})`);
    setValues({});
  }, [entry]);

  if (!entry) return null;

  const fields = credentialFieldsFor(entry.manifest);
  const hasSecretValue = Object.values(values).some((value) => value.trim());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!entry || !name.trim()) return;
    const cleanValue = Object.fromEntries(
      fields
        .map((field) => [field, (values[field] ?? '').trim()] as const)
        .filter(([, value]) => value),
    );
    if (!entry.credential && Object.keys(cleanValue).length === 0) {
      toast.error('Add at least one credential field');
      return;
    }
    setSaving(true);
    try {
      if (entry.credential) {
        await api(`/v1/credentials/${entry.credential.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            ...(Object.keys(cleanValue).length > 0 ? { value: JSON.stringify(cleanValue) } : {}),
          }),
        });
      } else {
        await api('/v1/credentials', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            credentialType: `integration_${entry.manifest.service}`,
            value: JSON.stringify(cleanValue),
          }),
        });
      }
      toast.success('Integration credential saved');
      onSaved();
    } catch (err) {
      toast.error('Failed to save credential', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h3 className="text-heading text-text-primary">{entry.manifest.name}</h3>
            <p className="mt-0.5 font-mono text-[10px] text-text-muted">integration_{entry.manifest.service}</p>
          </div>
          <IconButton icon={<X size={16} />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </header>
        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Credential name</span>
            <input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          {entry.credential && (
            <div className="rounded-input border border-line bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
              Leave secret fields blank to keep the saved value.
            </div>
          )}
          <div className="space-y-2">
            {fields.map((field) => (
              <label key={field} className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">{humanizeIdentifier(field)}</span>
                <input
                  className={inputCls}
                  type={isSecretField(field) ? 'password' : 'text'}
                  value={values[field] ?? ''}
                  onChange={(event) => setValues((prev) => ({ ...prev, [field]: event.target.value }))}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" type="submit" loading={saving} disabled={!name.trim() || (!entry.credential && !hasSecretValue)}>
            Save
          </Button>
        </footer>
      </form>
    </div>
  );
}



