/**
 * McpConnectionsPanel — bilateral MCP + A2A surface (UNIVERSAL-HARNESS §5/§8).
 *
 *  • Consume: register / list / remove external MCP servers and peek their tools.
 *  • Expose:  show the endpoints external agents use to reach Agentis
 *             (MCP JSON-RPC + A2A Agent Card), copyable.
 *
 * Self-contained (no Toast/Confirm context) so it renders in isolation tests.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2, Copy, Check, Server, Boxes, RefreshCw } from 'lucide-react';
import {
  listMcpServers, addMcpServer, deleteMcpServer, listMcpServerTools, getMcpServerCard,
  type McpServer, type McpTool, type McpServerCard,
} from '../../lib/connections';
import { apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';

export function McpConnectionsPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [card, setCard] = useState<McpServerCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [toolsFor, setToolsFor] = useState<{ id: string; tools: McpTool[] } | null>(null);

  async function refresh() {
    try {
      const [s, c] = await Promise.allSettled([listMcpServers(), getMcpServerCard()]);
      if (s.status === 'fulfilled') setServers(s.value.servers);
      if (c.status === 'fulfilled') setCard(c.value);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function submit() {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await addMcpServer({ name: name.trim(), url: url.trim() });
      setName(''); setUrl(''); setAdding(false);
      await refresh();
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

  async function peekTools(id: string) {
    try { const res = await listMcpServerTools(id); setToolsFor({ id, tools: res.tools }); }
    catch (e) { setError(apiErrorMessage(e)); }
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
          Connect MCP servers (Context7, Playwright, GitHub…). Their tools become callable from Agentis.
        </p>

        {adding && (
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3">
            <label className="flex-1 min-w-[140px] text-caption text-text-muted">
              Name
              <input className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 text-[13px] text-text-primary" value={name} onChange={(e) => setName(e.target.value)} placeholder="context7" />
            </label>
            <label className="flex-[2] min-w-[200px] text-caption text-text-muted">
              URL
              <input className="mt-1 w-full rounded border border-line bg-bg px-2 py-1 text-[13px] text-text-primary" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/rpc" />
            </label>
            <Button size="sm" onClick={() => void submit()} disabled={busy || !name.trim() || !url.trim()}>Save</Button>
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
                    <div className="truncate text-[13px] font-medium text-text-primary">{s.name}</div>
                    <div className="truncate font-mono text-[11px] text-text-muted">{s.url}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void peekTools(s.id)} aria-label={`View tools for ${s.name}`}><Boxes size={14} /> Tools</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(s.id)} disabled={busy} aria-label={`Remove ${s.name}`}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {toolsFor?.id === s.id && (
                  <div className="mt-2 border-t border-line pt-2">
                    {toolsFor.tools.length === 0
                      ? <p className="text-[12px] text-text-muted">No tools reported.</p>
                      : <ul className="flex flex-wrap gap-1.5">{toolsFor.tools.map((t) => (
                          <li key={t.name} className="rounded bg-bg px-2 py-0.5 font-mono text-[11px] text-text-secondary" title={t.description}>{t.name}</li>
                        ))}</ul>}
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
