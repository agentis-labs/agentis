/**
 * McpConnectionsPanel — bilateral MCP + A2A surface (UNIVERSAL-HARNESS §5/§8;
 * MCP-CAPABILITY-PLANE wave 2: mounts ARE integrations).
 *
 *  • Consume: mount / list / remove external MCP servers, with VAULT-held
 *    secrets (pick an existing credential — incl. OAuth-minted ones — or
 *    create one inline; never plaintext) and a per-tool ALLOWLIST manager
 *    (least privilege: only checked tools reach agents, `mcp` nodes, REST).
 *  • Expose:  show the endpoints external agents use to reach Agentis
 *             (MCP JSON-RPC + A2A Agent Card), copyable.
 *
 * Self-contained (no Toast/Confirm context) so it renders in isolation tests.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2, Copy, Check, Server, Boxes, RefreshCw, Lock, Plug, AlertTriangle, Loader2 } from 'lucide-react';
import {
  listMcpServers, addMcpServer, updateMcpServer, deleteMcpServer, listMcpServerTools, verifyMcpServer, listMcpCatalog, beginMcpOAuth, getMcpServerCard,
  type McpServer, type McpTool, type McpServerCard, type McpCatalogEntry,
} from '../../lib/connections';
import { api, apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';

type VerifyState = { status: 'idle' | 'checking' | 'ok' | 'failed'; toolCount?: number; error?: string };

/** The provider-specific token field label (never a generic "Secret value"). */
function tokenFieldLabel(entry: McpCatalogEntry): string {
  if (entry.authType === 'header') return `${entry.name} header (JSON)`;
  return `${entry.name} token`;
}

export function McpConnectionsPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [card, setCard] = useState<McpServerCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  // The picked catalog provider (drives the auth form). null = Custom.
  const [pending, setPending] = useState<McpCatalogEntry | null>(null);
  // For token/header providers + Custom: the single provider-labeled secret.
  const [secretValue, setSecretValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [toolsFor, setToolsFor] = useState<{ id: string; tools: McpTool[]; checked: Set<string> } | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [verify, setVerify] = useState<Record<string, VerifyState>>({});
  const authType: 'none' | 'oauth' | 'token' | 'header' | 'custom' = pending ? pending.authType : 'custom';

  async function refresh() {
    try {
      const [s, c, cat] = await Promise.allSettled([
        listMcpServers(),
        getMcpServerCard(),
        listMcpCatalog(),
      ]);
      if (s.status === 'fulfilled') setServers(s.value.servers);
      if (c.status === 'fulfilled') setCard(c.value);
      if (cat.status === 'fulfilled') setCatalog(cat.value.catalog ?? []);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  // Verify every mounted server on load — no server shows "connected" without
  useEffect(() => {
    for (const s of servers) {
      if (verify[s.id]) continue;
      setVerify((v) => ({ ...v, [s.id]: { status: 'checking' } }));
      void verifyMcpServer(s.id)
        .then((r) => setVerify((v) => ({ ...v, [s.id]: r.ok ? { status: 'ok', toolCount: r.toolCount } : { status: 'failed', error: r.error } })))
        .catch((e) => setVerify((v) => ({ ...v, [s.id]: { status: 'failed', error: apiErrorMessage(e) } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  async function recheck(id: string) {
    setVerify((v) => ({ ...v, [id]: { status: 'checking' } }));
    try {
      const r = await verifyMcpServer(id);
      setVerify((v) => ({ ...v, [id]: r.ok ? { status: 'ok', toolCount: r.toolCount } : { status: 'failed', error: r.error } }));
    } catch (e) {
      setVerify((v) => ({ ...v, [id]: { status: 'failed', error: apiErrorMessage(e) } }));
    }
  }

  function pickCatalog(entry: McpCatalogEntry) {
    setPending(entry);
    setName(entry.name);
    setUrl(entry.url);
    setSecretValue('');
    setError(null);
    setAdding(true);
  }

  function pickCustom() {
    setPending(null);
    setName(''); setUrl(''); setSecretValue('');
    setError(null);
    setAdding(true);
  }

  function resetForm() {
    setName(''); setUrl(''); setSecretValue(''); setPending(null); setAdding(false);
  }

  /**
   * Run the spec-compliant "Connect with X" popup for an OAuth mount, then
   * re-verify. Resolves after the callback posts back (or the popup closes).
   */
  async function runOAuth(serverId: string): Promise<void> {
    const { url: authorizeUrl } = await beginMcpOAuth(serverId, window.location.origin);
    const popup = window.open(authorizeUrl, 'agentis-mcp-oauth', 'width=600,height=760');
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; window.removeEventListener('message', onMsg); clearInterval(poll); resolve(); };
      const onMsg = (e: MessageEvent) => {
        if (e.origin === window.location.origin && (e.data as { type?: string })?.type === 'agentis-mcp-oauth') finish();
      };
      window.addEventListener('message', onMsg);
      const poll = setInterval(() => { if (popup?.closed) finish(); }, 500);
      setTimeout(finish, 5 * 60 * 1000);
    });
  }

  async function submit() {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // For token/header/Custom: mint the provider-specific vault secret first.
      let credentialId: string | undefined;
      if ((authType === 'token' || authType === 'header' || authType === 'custom') && secretValue.trim()) {
        const created = await api<{ id: string }>('/v1/credentials', {
          method: 'POST',
          body: JSON.stringify({ name: `MCP — ${name.trim()}`, credentialType: `mcp_${authType}`, value: secretValue }),
        });
        credentialId = created.id;
      }
      const { server } = await addMcpServer({ name: name.trim(), url: url.trim(), ...(credentialId ? { credentialId } : {}) });
      // OAuth: run the redirect flow now that the mount exists (it needs a serverId).
      if (authType === 'oauth') {
        await runOAuth(server.id);
      }
      resetForm();
      await refresh();
      void recheck(server.id);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try { await deleteMcpServer(id); await refresh(); }
    catch (e) { setError(apiErrorMessage(e)); }
    finally { setBusy(false); }
  }

  async function peekTools(server: McpServer) {
    try {
      const res = await listMcpServerTools(server.id);
      const active = new Set((server.allowedTools?.length ? server.allowedTools : res.tools.map((t) => t.name)));
      setToolsFor({ id: server.id, tools: res.tools, checked: active });
    } catch (e) { setError(apiErrorMessage(e)); }
  }

  async function saveAllowlist(server: McpServer) {
    if (!toolsFor || toolsFor.id !== server.id) return;
    setBusy(true);
    try {
      const all = toolsFor.tools.map((t) => t.name);
      const picked = all.filter((t) => toolsFor.checked.has(t));
      // Everything checked = no allowlist (all tools, incl. ones added later).
      await updateMcpServer(server.id, { allowedTools: picked.length === all.length ? null : picked });
      await refresh();
    } catch (e) { setError(apiErrorMessage(e)); }
    finally { setBusy(false); }
  }


  if (loading) return <div className="space-y-3"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>;

  return (
    <div className="space-y-6">
      {error && <p className="text-[13px] text-danger">{error}</p>}

      {/* Consume: external MCP servers */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-accent" />
            <h2 className="text-subheading text-text-primary">External MCP servers</h2>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)} aria-label="Add MCP server">
            <Plus size={14} /> Add server
          </Button>
        </div>
        <p className="mb-3 text-[12px] text-text-muted">
          Mount MCP servers (Supabase, Context7, Playwright, GitHub…). Their tools become deterministic <span className="font-mono">mcp</span> workflow
          nodes AND live tools in every agent&apos;s own loop. Secrets stay in the encrypted vault — never in prompts or node configs.
        </p>

        {/* Pre-defined catalog: pick a provider (URL + auth prefilled) instead
            of pasting a URL. */}
        {catalog.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 text-caption text-text-muted">Quick connect</div>
            <div className="flex flex-wrap gap-1.5">
              {catalog.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => pickCatalog(entry)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
                  title={`${entry.description} · ${entry.authHint}`}
                >
                  <Plug size={12} className="text-accent" /> {entry.name}
                  <span className="text-[10px] text-text-muted">
                    {entry.authType === 'none' ? 'no auth' : entry.authType}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={pickCustom}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] text-text-muted hover:text-text-primary"
              >
                <Plus size={12} /> Custom
              </button>
            </div>
          </div>
        )}

        {adding && (
          <div className="mb-3 space-y-2.5 rounded-lg border border-line bg-surface p-3">
            {/* A catalog provider prefills name + URL (read-only); Custom is free-form. */}
            {pending ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-text-primary">{pending.name}</span>
                <span className="truncate font-mono text-[11px] text-text-muted">{pending.url}</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[140px] flex-1 text-caption text-text-muted">
                  Name
                  <input className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 text-[13px] text-text-primary" value={name} onChange={(e) => setName(e.target.value)} placeholder="context7" />
                </label>
                <label className="min-w-[200px] flex-[2] text-caption text-text-muted">
                  URL
                  <input className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[13px] text-text-primary" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                </label>
              </div>
            )}

            {}
            {authType === 'oauth' ? (
              <p className="text-[12px] leading-4 text-text-muted">
                {pending?.authHint ?? 'Sign in with the provider — no secret to paste.'} You&apos;ll approve access in a popup after mounting.
              </p>
            ) : authType === 'none' ? (
              <p className="text-[12px] text-text-muted">{pending?.authHint ?? 'Public server — no authentication needed.'}</p>
            ) : (
              <label className="block text-caption text-text-muted">
                {pending ? tokenFieldLabel(pending) : 'Secret (token, or a JSON header map)'}
                <input
                  type="password"
                  className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 font-mono text-[13px] text-text-primary"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  placeholder={pending?.authType === 'header' ? '{"x-api-key":"…"}' : 'paste the token'}
                />
                {pending?.docsUrl && (
                  <a href={pending.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-accent hover:underline">
                    Where do I get this? →
                  </a>
                )}
              </label>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy}>Cancel</Button>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={busy || !name.trim() || !url.trim() || ((authType === 'token' || authType === 'header') && !secretValue.trim())}
              >
                {authType === 'oauth' ? <><Plug size={13} /> Connect &amp; mount</> : 'Mount server'}
              </Button>
            </div>
          </div>
        )}

        {servers.length === 0 ? (
          <p className="text-[13px] text-text-muted">No external MCP servers connected.</p>
        ) : (
          <ul className="space-y-2">
            {servers.map((s) => (
              <li key={s.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-primary">
                      {s.name}
                      {s.credentialId && (
                        <span title="Secrets resolved from the encrypted vault at call time"><Lock size={11} className="text-success" /></span>
                      )}
                      {s.allowedTools && s.allowedTools.length > 0 && (
                        <span className="rounded-full border border-line px-1.5 text-[10px] text-text-muted" title="Per-tool allowlist active (least privilege)">
                          {s.allowedTools.length} tool{s.allowedTools.length === 1 ? '' : 's'} allowed
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-text-muted">{s.url}</div>
                    <VerifyBadge state={verify[s.id]} onRecheck={() => void recheck(s.id)} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void peekTools(s)} aria-label={`Manage tools for ${s.name}`}><Boxes size={14} /> Tools</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(s.id)} disabled={busy} aria-label={`Remove ${s.name}`}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {toolsFor?.id === s.id && (
                  <div className="mt-2 border-t border-line pt-2">
                    {toolsFor.tools.length === 0
                      ? <p className="text-[12px] text-text-muted">No tools reported.</p>
                      : (
                        <>
                          <p className="mb-1.5 text-[11px] text-text-muted">
                            Uncheck tools to hide them from agents, workflow nodes, and the API (least privilege). All checked = everything allowed, including tools the server adds later.
                          </p>
                          <ul className="flex flex-wrap gap-1.5">
                            {toolsFor.tools.map((t) => (
                              <li key={t.name}>
                                <label className="flex cursor-pointer items-center gap-1 rounded bg-bg px-2 py-0.5 font-mono text-[11px] text-text-secondary" title={t.description}>
                                  <input
                                    type="checkbox"
                                    className="accent-accent"
                                    checked={toolsFor.checked.has(t.name)}
                                    onChange={(e) => {
                                      const next = new Set(toolsFor.checked);
                                      if (e.target.checked) next.add(t.name); else next.delete(t.name);
                                      setToolsFor({ ...toolsFor, checked: next });
                                    }}
                                  />
                                  {t.name}
                                </label>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-2 flex justify-end">
                            <Button size="sm" onClick={() => void saveAllowlist(s)} disabled={busy || toolsFor.checked.size === 0}>
                              Save allowlist
                            </Button>
                          </div>
                        </>
                      )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Expose: Agentis as an MCP/A2A provider */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <RefreshCw size={16} className="text-accent" />
          <h2 className="text-subheading text-text-primary">Expose Agentis</h2>
        </div>
        <p className="mb-3 text-[12px] text-text-muted">
          Point external agents (Claude Code, Cursor, Codex) at these endpoints to use this workspace's tools and skills.
          {card ? ` ${card.toolCount} tool${card.toolCount === 1 ? '' : 's'} exposed.` : ''}
        </p>
        <div className="space-y-2">
          <CopyRow label="MCP (JSON-RPC)" value="/v1/mcp/rpc" />
          <CopyRow label="A2A Agent Card" value="/v1/a2a/agent-card.json" />
        </div>
      </section>
    </div>
  );
}

/** The truthful connection state — a real tools/list handshake, or the error. */
function VerifyBadge({ state, onRecheck }: { state?: VerifyState; onRecheck: () => void }) {
  if (!state || state.status === 'idle') return null;
  if (state.status === 'checking') {
    return <div className="mt-0.5 flex items-center gap-1 text-[11px] text-text-muted"><Loader2 size={11} className="animate-spin" /> Verifying connection…</div>;
  }
  if (state.status === 'ok') {
    return (
      <button type="button" onClick={onRecheck} className="mt-0.5 flex items-center gap-1 text-[11px] text-success hover:underline" title="Re-verify">
        <Check size={11} /> Connected · {state.toolCount ?? 0} tool{state.toolCount === 1 ? '' : 's'}
      </button>
    );
  }
  return (
    <button type="button" onClick={onRecheck} className="mt-0.5 flex items-start gap-1 text-left text-[11px] text-danger hover:underline" title="Re-verify">
      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
      <span className="min-w-0">Not connected — {state.error ?? 'handshake failed'}</span>
    </button>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
      <div>
        <div className="text-caption text-text-muted">{label}</div>
        <div className="font-mono text-[12px] text-text-primary">{value}</div>
      </div>
      <button
        className="flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
        onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      </button>
    </div>
  );
}



