/**
 * ViewRenderer - renders an agent-authored AG-UI ViewNode tree.
 *
 * Agents emit typed UI intent. The renderer owns pixels, state, navigation,
 * data binding, and the CustomView bridge policy.
 *
 * One renderer, two modes. With no {@link SurfaceEditContext} it renders the
 * live app (the runtime / preview / public share). Inside a `SurfaceEditProvider`
 * it becomes the WYSIWYG builder canvas: every structural node is selectable and
 * hoverable, text nodes edit inline, and interactive elements (buttons/forms) are
 * inert so editing never fires a real action. Data binding still runs, so tables
 * and charts show real rows while you design. The canvas is therefore pixel-true
 * to production — there is no separate "preview" render path to drift from.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, Bot, Check, ChevronDown, ChevronUp, Code2, Copy, Download, ExternalLink, FileText, Globe2, Image as ImageIcon, Loader2, MapPin, MessageSquare, Send, Trash2, Wrench } from 'lucide-react';
import clsx from 'clsx';
import {
  APP_CLIENT_MESSAGE_SOURCE,
  APP_CLIENT_PROTOCOL_VERSION,
  type AgentisAppClient,
  type AppClientMessage,
  type AppClientResponse,
} from '@agentis/app-client';
import type { DataBind, SurfaceAction, ViewNode } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { appsApi, type AppOperator } from '../../lib/appsApi';
import { pathsEqual } from './viewTree';

interface RuntimeCtx {
  appId: string;
  surface: string;
  client: AgentisAppClient;
  surfaceActions: SurfaceAction[];
  uiState: Record<string, unknown>;
  allowCustomCode: boolean;
  dataRevision: number;
}

const Ctx = createContext<RuntimeCtx | null>(null);

const useRuntime = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ViewRenderer used outside an AppRuntime');
  return ctx;
};

export function RuntimeProvider({ value, children }: { value: RuntimeCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── Edit mode (WYSIWYG builder) ─────────────────────────────

/** Wired by the builder canvas. Present == design mode (interactions inert). */
export interface SurfaceEditContext {
  selectedPath: number[];
  onSelect: (path: number[]) => void;
  onMove: (path: number[], dir: -1 | 1) => void;
  onDuplicate: (path: number[]) => void;
  onRemove: (path: number[]) => void;
  onSetValue: (path: number[], value: string) => void;
}

const EditCtx = createContext<SurfaceEditContext | null>(null);

export function SurfaceEditProvider({ value, children }: { value: SurfaceEditContext; children: React.ReactNode }) {
  return <EditCtx.Provider value={value}>{children}</EditCtx.Provider>;
}

interface ResolveScope {
  row?: Record<string, unknown>;
  state: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBindableObject(value: unknown): boolean {
  return isRecord(value) && ('$bind' in value || '$row' in value || '$state' in value);
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), source);
}

function resolveBindable(value: unknown, scope: ResolveScope): unknown {
  if (isRecord(value) && '$bind' in value) {
    const path = String(value.$bind).replace(/^row\./, '').replace(/^\$row\./, '');
    return scope.row ? getPath(scope.row, path) : undefined;
  }
  if (isRecord(value) && '$row' in value) return scope.row ? getPath(scope.row, String(value.$row)) : undefined;
  if (isRecord(value) && '$state' in value) return getPath(scope.state, String(value.$state));
  return value;
}

function resolveDeep(value: unknown, scope: ResolveScope): unknown {
  if (isBindableObject(value)) return resolveBindable(value, scope);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, scope));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v, scope)]));
  return value;
}

function resolveArgs(args: Record<string, unknown> | undefined, scope: ResolveScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [k, resolveDeep(v, scope)]));
}

function useResolvedScope(row?: Record<string, unknown>): ResolveScope {
  const { uiState } = useRuntime();
  return useMemo(() => ({ row, state: uiState }), [row, uiState]);
}

function useBoundRows(bind: DataBind): { rows: Record<string, unknown>[]; loading: boolean } {
  const { client, dataRevision, uiState } = useRuntime();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify({ collection: bind.collection, query: bind.query, sort: bind.sort, limit: bind.limit, state: uiState });

  useEffect(() => {
    let cancelled = false;
    const filter = resolveDeep(bind.query ?? {}, { state: uiState }) as Record<string, unknown>;
    setLoading(true);
    client.data
      .query(bind.collection, { filter, sort: bind.sort, limit: bind.limit ?? 50 })
      .then((nextRows) => {
        if (!cancelled) setRows(nextRows);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bind.collection, bind.limit, bind.sort, client, dataRevision, key, uiState]);

  return { rows, loading };
}

function useActionInvoker() {
  const { client, surfaceActions } = useRuntime();
  return useCallback(
    async (action: string, args: Record<string, unknown>) => {
      const declared = surfaceActions.find((candidate) => candidate.name === action);

      if (action === 'setState' || declared?.kind === 'setState') {
        if (declared?.target) {
          await client.state.set(declared.target, Object.prototype.hasOwnProperty.call(args, 'value') ? args.value : args);
          return;
        }
        const key = typeof args.key === 'string' ? args.key : undefined;
        if (key) {
          await client.state.set(key, Object.prototype.hasOwnProperty.call(args, 'value') ? args.value : undefined);
          return;
        }
        await Promise.all(Object.entries(args).map(([k, v]) => client.state.set(k, v)));
        return;
      }

      if (action === 'navigate' || declared?.kind === 'navigate') {
        const target = declared?.target || String(args.surface ?? args.to ?? '');
        if (!target) return;
        const params = isRecord(args.params)
          ? args.params
          : Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'surface' && k !== 'to'));
        await client.navigation.go(target, params);
        return;
      }

      await client.actions.invoke(action, args);
    },
    [client, surfaceActions],
  );
}

export function ViewRenderer({
  node,
  scope,
  path = [],
  editable = true,
}: {
  node: ViewNode;
  scope?: Record<string, unknown>;
  /** Index path from the surface root — used by the builder for selection. */
  path?: number[];
  /** False inside data-bound row templates, where children are not editable. */
  editable?: boolean;
}) {
  const resolvedScope = useResolvedScope(scope);
  const edit = useContext(EditCtx);

  const content = renderContent();
  if (!edit || !editable) return content;
  return (
    <EditNodeWrapper node={node} path={path} edit={edit}>
      {content}
    </EditNodeWrapper>
  );

  function renderContent(): React.ReactNode {
    switch (node.type) {
      case 'Stack':
        return <div className="flex flex-col" style={{ gap: node.gap ?? 12 }}>{node.children.map((c, i) => <ViewRenderer key={i} node={c} scope={scope} path={[...path, i]} />)}</div>;
      case 'Row':
        return (
          <div className="flex flex-wrap items-stretch" style={{ gap: node.gap ?? 12 }}>
            {node.children.map((c, i) => (
              <div key={i} className="min-w-[180px]" style={{ flex: `${node.widths?.[i] ?? 1} 1 0` }}>
                <ViewRenderer node={c} scope={scope} path={[...path, i]} />
              </div>
            ))}
          </div>
        );
      case 'Grid':
        return <div className="grid grid-cols-2 md:grid-cols-3" style={{ gap: node.gap ?? 12 }}>{node.children.map((c, i) => <ViewRenderer key={i} node={c} scope={scope} path={[...path, i]} />)}</div>;
      case 'Card':
      case 'Section':
        return (
          <div className="rounded-card border border-line bg-surface p-4 shadow-card">
            {node.title ? <div className="mb-3 text-[13px] font-semibold text-text-primary">{node.title}</div> : null}
            <div className="flex flex-col gap-3">{node.children.map((c, i) => <ViewRenderer key={i} node={c} scope={scope} path={[...path, i]} />)}</div>
          </div>
        );
      case 'Heading':
        return <h2 className="text-[15px] font-semibold text-text-primary">{node.value}</h2>;
      case 'Text':
        return <p className="text-[13px] leading-relaxed text-text-secondary">{node.value}</p>;
      case 'Markdown':
        return <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">{node.value}</p>;
      case 'Divider':
        return <hr className="border-line" />;
      case 'Metric':
        return (
          <div className="rounded-btn border border-line bg-canvas px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-text-muted">{node.label}</div>
            <div className="text-[20px] font-semibold text-text-primary">{String(resolveBindable(node.value, resolvedScope) ?? '-')}</div>
            {node.delta != null ? <div className="text-[11px] text-text-secondary">{String(resolveBindable(node.delta, resolvedScope))}</div> : null}
          </div>
        );
      case 'Badge': {
        const tone = node.tone ?? 'neutral';
        const cls = tone === 'success' ? 'bg-accent-soft text-accent' : tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'warning' ? 'bg-warn-soft text-warn' : 'bg-canvas text-text-secondary';
        return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{String(resolveBindable(node.value, resolvedScope) ?? '')}</span>;
      }
      case 'Image':
        return <img src={String(resolveBindable(node.src, resolvedScope) ?? '')} alt={node.alt ?? ''} className="max-h-64 rounded-card border border-line object-cover" />;
      case 'Button':
        return <ActionButton label={node.label} action={node.action.action} args={node.action.args} scope={scope} variant={node.variant} />;
      case 'Table':
        return <BoundTable node={node} />;
      case 'List':
        return <BoundList node={node} />;
      case 'Chart':
        return <BoundChart node={node} />;
      case 'Form':
        return <ActionForm node={node} />;
      case 'AgentConsole':
        return <AgentConsoleView node={node} />;
      case 'ActivityStream':
        return <ActivityStreamView node={node} />;
      case 'DataBoard':
        return <BoundBoard node={node} />;
      case 'DocumentViewer':
        return <DocumentViewerBlock node={node} />;
      case 'MapView':
        return <MapViewBlock node={node} scope={resolvedScope} />;
      case 'StatusBoard':
        return <StatusBoardBlock node={node} scope={resolvedScope} />;
      case 'WebEmbed':
        return <WebEmbedBlock node={node} />;
      case 'Narrative':
        return <NarrativeBlock node={node} />;
      case 'ConversationThread':
        return <ConversationThreadBlock node={node} />;
      case 'CodeViewer':
        return <CodeViewerBlock node={node} />;
      case 'MediaGallery':
        return <MediaGalleryBlock node={node} scope={resolvedScope} />;
      case 'CustomView':
        return <CustomViewFrame node={node} />;
      default:
        return null;
    }
  }
}

function isTextNode(node: ViewNode): node is Extract<ViewNode, { type: 'Text' | 'Heading' | 'Markdown' }> {
  return node.type === 'Text' || node.type === 'Heading' || node.type === 'Markdown';
}

function EditNodeWrapper({
  node,
  path,
  edit,
  children,
}: {
  node: ViewNode;
  path: number[];
  edit: SurfaceEditContext;
  children: React.ReactNode;
}) {
  const selected = pathsEqual(path, edit.selectedPath);
  const isRoot = path.length === 0;
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);
  const editingText = selected && editing && isTextNode(node);
  return (
    <div
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        edit.onSelect(path);
      }}
      onDoubleClick={(event) => {
        if (!isTextNode(node)) return;
        event.stopPropagation();
        edit.onSelect(path);
        setEditing(true);
      }}
      className={clsx(
        'relative rounded-[7px] transition-shadow',
        selected ? 'shadow-[0_0_0_2px_var(--color-accent)]' : 'hover:shadow-[0_0_0_1px_var(--color-line-strong)]',
        isRoot && 'min-h-full',
      )}
    >
      {selected && !isRoot ? <NodeToolbar path={path} edit={edit} /> : null}
      {editingText && isTextNode(node) ? (
        <InlineTextEditor
          value={node.value}
          heading={node.type === 'Heading'}
          onChange={(value) => edit.onSetValue(path, value)}
          onDone={() => setEditing(false)}
        />
      ) : (
        children
      )}
    </div>
  );
}

function NodeToolbar({ path, edit }: { path: number[]; edit: SurfaceEditContext }) {
  const btn = 'flex h-6 w-6 items-center justify-center text-text-secondary hover:bg-surface-2 hover:text-text-primary';
  return (
    <div
      className="absolute -top-3 right-2 z-10 flex items-center overflow-hidden rounded-btn border border-line bg-surface shadow-card"
      onClick={(event) => event.stopPropagation()}
      role="presentation"
    >
      <button type="button" className={btn} title="Move up" aria-label="Move block up" onClick={() => edit.onMove(path, -1)}><ChevronUp size={13} /></button>
      <button type="button" className={btn} title="Move down" aria-label="Move block down" onClick={() => edit.onMove(path, 1)}><ChevronDown size={13} /></button>
      <button type="button" className={btn} title="Duplicate" aria-label="Duplicate block" onClick={() => edit.onDuplicate(path)}><Copy size={12} /></button>
      <button type="button" className={clsx(btn, 'hover:bg-danger-soft hover:text-danger')} title="Delete" aria-label="Delete block" onClick={() => edit.onRemove(path)}><Trash2 size={12} /></button>
    </div>
  );
}

function InlineTextEditor({
  value,
  heading,
  onChange,
  onDone,
}: {
  value: string;
  heading: boolean;
  onChange: (value: string) => void;
  onDone: () => void;
}) {
  return (
    <textarea
      autoFocus
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && heading)) {
          event.preventDefault();
          onDone();
        }
      }}
      rows={heading ? 1 : 2}
      aria-label="Edit text"
      className={clsx(
        'w-full resize-none rounded-md border border-accent/40 bg-canvas px-2 py-1 text-text-primary outline-none',
        heading ? 'text-[15px] font-semibold' : 'text-[13px] leading-relaxed',
      )}
    />
  );
}

function PanelShell({ title, icon, children, action }: { title?: string; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      {(title || action) ? (
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-accent">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-primary">{title}</span>
          {action}
        </div>
      ) : null}
      <div className="p-3">{children}</div>
    </div>
  );
}

function DocumentViewerBlock({ node }: { node: Extract<ViewNode, { type: 'DocumentViewer' }> }) {
  const href = `data:text/plain;charset=utf-8,${encodeURIComponent(node.content)}`;
  return (
    <PanelShell
      title={node.title ?? 'Document'}
      icon={<FileText size={14} />}
      action={(
        <a href={href} download={node.downloadName ?? 'document.txt'} className="inline-flex h-6 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-canvas">
          <Download size={12} /> Download
        </a>
      )}
    >
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-btn bg-canvas p-3 text-[12px] leading-relaxed text-text-secondary">
        {node.content}
      </pre>
    </PanelShell>
  );
}

function MapViewBlock({ node, scope }: { node: Extract<ViewNode, { type: 'MapView' }>; scope: ResolveScope }) {
  const pins = node.pins ?? [];
  return (
    <PanelShell title={node.title ?? 'Map'} icon={<MapPin size={14} />}>
      <div className="relative min-h-52 overflow-hidden rounded-btn border border-line bg-canvas">
        <div className="absolute inset-0 opacity-70 [background-image:linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="relative flex min-h-52 flex-col justify-between p-3">
          <div className="text-[12px] font-medium text-text-primary">{node.region ?? 'Global'}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {pins.length === 0 ? (
              <div className="rounded-btn border border-line bg-surface/90 px-3 py-2 text-[12px] text-text-muted">No pins configured</div>
            ) : pins.map((pin, index) => (
              <div key={`${pin.label}-${index}`} className="rounded-btn border border-line bg-surface/90 px-3 py-2">
                <div className="text-[12px] font-medium text-text-primary">{pin.label}</div>
                <div className="text-[11px] text-text-muted">
                  {pin.lat != null && pin.lng != null ? `${pin.lat}, ${pin.lng}` : 'Location'}
                  {pin.value != null ? ` · ${String(resolveBindable(pin.value, scope) ?? '-')}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function StatusBoardBlock({ node, scope }: { node: Extract<ViewNode, { type: 'StatusBoard' }>; scope: ResolveScope }) {
  return (
    <PanelShell title={node.title ?? 'Status board'} icon={<Activity size={14} />}>
      <div className="grid gap-2">
        {node.items.map((item, index) => {
          const status = String(resolveBindable(item.status, scope) ?? 'unknown');
          const tone = /fail|error|down|risk/i.test(status) ? 'text-danger bg-danger-soft'
            : /wait|warn|review|pending/i.test(status) ? 'text-warn bg-warn-soft'
              : 'text-accent bg-accent-soft';
          return (
            <div key={`${item.label}-${index}`} className="flex items-center gap-3 rounded-btn border border-line bg-canvas px-3 py-2">
              <span className={`h-2.5 w-2.5 rounded-full ${tone.split(' ')[1]}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-text-primary">{item.label}</div>
                {item.detail != null ? <div className="truncate text-[11px] text-text-muted">{String(resolveBindable(item.detail, scope) ?? '')}</div> : null}
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>{status}</span>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

function safeEmbedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function WebEmbedBlock({ node }: { node: Extract<ViewNode, { type: 'WebEmbed' }> }) {
  const src = safeEmbedUrl(node.url);
  return (
    <PanelShell
      title={node.title ?? 'Web embed'}
      icon={<Globe2 size={14} />}
      action={src ? <a href={src} target="_blank" rel="noreferrer" className="text-text-muted hover:text-text-primary"><ExternalLink size={13} /></a> : null}
    >
      {src ? (
        <iframe title={node.title ?? 'Web embed'} src={src} sandbox="allow-scripts allow-forms allow-popups" className="w-full rounded-btn border border-line bg-white" style={{ height: node.height ?? 320 }} />
      ) : (
        <div className="rounded-btn border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">Only HTTPS embeds are allowed.</div>
      )}
    </PanelShell>
  );
}

function NarrativeBlock({ node }: { node: Extract<ViewNode, { type: 'Narrative' }> }) {
  return (
    <PanelShell title={node.title ?? 'Narrative'} icon={<FileText size={14} />}>
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">{node.value}</div>
    </PanelShell>
  );
}

function ConversationThreadBlock({ node }: { node: Extract<ViewNode, { type: 'ConversationThread' }> }) {
  const messages = node.messages ?? [
    { role: 'agent' as const, content: 'Ready to capture the next exchange.' },
  ];
  return (
    <PanelShell title={node.title ?? 'Conversation'} icon={<MessageSquare size={14} />}>
      <div className="flex max-h-96 flex-col gap-2 overflow-auto">
        {messages.map((message, index) => (
          <div key={index} className={clsx('max-w-[92%] rounded-card border border-line px-3 py-2 text-[12px]', message.role === 'user' ? 'ml-auto bg-accent-soft text-accent' : 'bg-canvas text-text-secondary')}>
            <div className="mb-1 text-[10px] font-semibold uppercase text-text-muted">{message.role}</div>
            <div className="whitespace-pre-wrap">{message.content}</div>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

function CodeViewerBlock({ node }: { node: Extract<ViewNode, { type: 'CodeViewer' }> }) {
  return (
    <PanelShell title={node.title ?? 'Code'} icon={<Code2 size={14} />}>
      <div className="mb-2 flex items-center justify-between text-[11px] text-text-muted">
        <span>{node.language ?? 'text'}{node.diff ? ' · diff' : ''}</span>
      </div>
      <pre className="max-h-96 overflow-auto rounded-btn border border-line bg-canvas p-3 font-mono text-[12px] leading-relaxed text-text-secondary">
        {node.code}
      </pre>
    </PanelShell>
  );
}

function MediaGalleryBlock({ node, scope }: { node: Extract<ViewNode, { type: 'MediaGallery' }>; scope: ResolveScope }) {
  return (
    <PanelShell title={node.title ?? 'Media'} icon={<ImageIcon size={14} />}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {node.items.length === 0 ? (
          <div className="col-span-full rounded-btn border border-line bg-canvas px-3 py-6 text-center text-[12px] text-text-muted">No media yet</div>
        ) : node.items.map((item, index) => {
          const src = String(resolveBindable(item.src, scope) ?? '');
          const kind = item.kind ?? 'image';
          return (
            <figure key={`${src}-${index}`} className="overflow-hidden rounded-card border border-line bg-canvas">
              {kind === 'image' ? (
                <img src={src} alt={item.alt ?? ''} className="aspect-video w-full object-cover" />
              ) : (
                <a href={src} target="_blank" rel="noreferrer" className="flex aspect-video items-center justify-center text-text-muted hover:text-text-primary">
                  <FileText size={22} />
                </a>
              )}
              {item.caption ? <figcaption className="truncate px-2 py-1.5 text-[11px] text-text-muted">{item.caption}</figcaption> : null}
            </figure>
          );
        })}
      </div>
    </PanelShell>
  );
}

function CustomViewFrame({ node }: { node: Extract<ViewNode, { type: 'CustomView' }> }) {
  const { allowCustomCode, client } = useRuntime();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const allowed = useMemo(() => new Set(node.collections ?? []), [node.collections]);

  const srcDoc = useMemo(() => {
    const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";
    const bridge = `
      <script>
        const SOURCE = '${APP_CLIENT_MESSAGE_SOURCE}';
        const VERSION = ${APP_CLIENT_PROTOCOL_VERSION};
        const pending = new Map();
        let nextId = 0;
        window.addEventListener('message', (event) => {
          const message = event.data || {};
          if (message.source !== SOURCE || message.version !== VERSION || !pending.has(message.id)) return;
          const entry = pending.get(message.id);
          pending.delete(message.id);
          message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error || 'Agentis bridge request failed'));
        });
        function request(op, payload) {
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            parent.postMessage({ source: SOURCE, version: VERSION, id, op, payload }, '*');
          });
        }
        window.agentis = {
          data: {
            query: (collection, query) => request('data.query', { collection, query: query || {} }),
          },
          actions: {
            invoke: (name, args) => request('actions.invoke', { name, args: args || {} }),
          },
          state: {
            get: (key) => request('state.get', { key }),
            set: (key, value) => request('state.set', { key, value }),
            subscribe: () => () => {},
          },
          realtime: { subscribe: () => () => {} },
          navigation: {
            go: (surface, params) => request('navigation.go', { surface, params: params || {} }),
          },
          files: {
            upload: () => Promise.reject(new Error('files.upload is not available in CustomView')),
          },
          query: (collection, query) => request('data.query', { collection, query: query || {} }),
          action: (name, args) => request('actions.invoke', { name, args: args || {} }),
        };
      <\/script>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0;font-family:system-ui;color:#111">${node.html}${bridge}</body></html>`;
  }, [node.html]);

  const onMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data as AppClientMessage | undefined;
      if (!message || message.source !== APP_CLIENT_MESSAGE_SOURCE || message.version !== APP_CLIENT_PROTOCOL_VERSION) return;
      const reply = (response: Omit<AppClientResponse, 'source' | 'version' | 'id'>) => {
        (event.source as Window | null)?.postMessage(
          {
            source: APP_CLIENT_MESSAGE_SOURCE,
            version: APP_CLIENT_PROTOCOL_VERSION,
            id: message.id,
            ...response,
          } satisfies AppClientResponse,
          '*',
        );
      };

      try {
        switch (message.op) {
          case 'data.query': {
            const { collection, query } = message.payload as { collection: string; query?: Record<string, unknown> };
            if (!allowed.has(collection)) return reply({ ok: false, error: 'collection not allowed' });
            return reply({ ok: true, result: await client.data.query(collection, query) });
          }
          case 'actions.invoke': {
            const { name, args } = message.payload as { name: string; args?: Record<string, unknown> };
            return reply({ ok: true, result: await client.actions.invoke(name, args) });
          }
          case 'state.get': {
            const { key } = message.payload as { key?: string };
            return reply({ ok: true, result: await client.state.get(key) });
          }
          case 'state.set': {
            const { key, value } = message.payload as { key: string; value: unknown };
            await client.state.set(key, value);
            return reply({ ok: true });
          }
          case 'navigation.go': {
            const { surface, params } = message.payload as { surface: string; params?: Record<string, unknown> };
            await client.navigation.go(surface, params);
            return reply({ ok: true });
          }
          default:
            return reply({ ok: false, error: `${message.op} is not available in CustomView` });
        }
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : 'bridge call failed' });
      }
    },
    [allowed, client],
  );

  useEffect(() => {
    if (!allowCustomCode) return undefined;
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [allowCustomCode, onMessage]);

  if (!allowCustomCode) {
    return (
      <div className="rounded-card border border-line bg-canvas px-3 py-2 text-[12px] text-text-muted">
        Custom view blocked by app policy.
      </div>
    );
  }

  return (
    <iframe
      title="Custom view"
      ref={frameRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="w-full rounded-card border border-line bg-white"
      style={{ height: node.height ?? 320 }}
    />
  );
}

function ActionButton({
  label,
  action,
  args,
  scope,
  variant,
}: {
  label: string;
  action: string;
  args?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const resolvedScope = useResolvedScope(scope);
  const invoke = useActionInvoker();
  const editing = useContext(EditCtx);
  const [busy, setBusy] = useState(false);
  const cls = variant === 'danger' ? 'bg-danger text-white' : variant === 'secondary' ? 'border border-line bg-surface text-text-primary' : 'bg-accent text-white';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (editing) return; // inert in the builder canvas — selection is handled by the wrapper
        setBusy(true);
        try {
          await invoke(action, resolveArgs(args, resolvedScope));
        } finally {
          setBusy(false);
        }
      }}
      className={`inline-flex w-fit items-center rounded-btn px-3 py-1.5 text-[12px] font-medium disabled:opacity-50 ${cls}`}
    >
      {busy ? '...' : label}
    </button>
  );
}

function BoundTable({ node }: { node: Extract<ViewNode, { type: 'Table' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-canvas text-text-muted">
          <tr>
            {node.columns.map((col) => <th key={col.key} className="px-3 py-2 font-medium">{col.label ?? col.key}</th>)}
            {node.rowActions?.length ? <th className="px-3 py-2" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={node.columns.length + 1} className="px-3 py-6 text-center text-text-muted">No records</td></tr>
          ) : rows.map((row, i) => (
            <tr key={(row.id as string) ?? i} className="border-t border-line">
              {node.columns.map((col) => <td key={col.key} className="px-3 py-2 text-text-secondary">{formatCell(row[col.key], col.format)}</td>)}
              {node.rowActions?.length ? (
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {node.rowActions.map((a, j) => <ActionButton key={j} label={a.action} action={a.action} args={a.args} scope={row} variant="secondary" />)}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoundList({ node }: { node: Extract<ViewNode, { type: 'List' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => <ViewRenderer key={(row.id as string) ?? i} node={node.item} scope={row} editable={false} />)}
    </div>
  );
}

function BoundChart({ node }: { node: Extract<ViewNode, { type: 'Chart' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  const max = Math.max(1, ...rows.map((r) => Number(r[node.y]) || 0));
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-3">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-24 truncate text-[11px] text-text-secondary">{String(row[node.x] ?? '')}</div>
          <div className="h-3 flex-1 rounded-full bg-canvas">
            <div className="h-3 rounded-full bg-accent" style={{ width: `${((Number(row[node.y]) || 0) / max) * 100}%` }} />
          </div>
          <div className="w-10 text-right text-[11px] text-text-muted">{String(row[node.y] ?? 0)}</div>
        </div>
      ))}
    </div>
  );
}

function ActionForm({ node }: { node: Extract<ViewNode, { type: 'Form' }> }) {
  const resolvedScope = useResolvedScope();
  const invoke = useActionInvoker();
  const editing = useContext(EditCtx);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setValues((prev) => ({ ...prev, [k]: v }));
  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (editing) return; // inert in the builder canvas
        setBusy(true);
        try {
          await invoke(node.submit.action, { record: values, ...resolveArgs(node.submit.args, resolvedScope) });
          setValues({});
        } finally {
          setBusy(false);
        }
      }}
    >
      {node.fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-[12px] text-text-secondary">
          <span>{f.label ?? f.key}{f.required ? ' *' : ''}</span>
          {f.type === 'textarea' ? (
            <textarea required={f.required} placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} className="rounded-btn border border-line bg-canvas px-2 py-1.5 text-text-primary" />
          ) : f.type === 'select' ? (
            <select required={f.required} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} className="rounded-btn border border-line bg-canvas px-2 py-1.5 text-text-primary">
              <option value="">Select...</option>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'checkbox' ? (
            <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
          ) : (
            <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} required={f.required} placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} className="rounded-btn border border-line bg-canvas px-2 py-1.5 text-text-primary" />
          )}
        </label>
      ))}
      <button type="submit" disabled={busy} className="inline-flex w-fit rounded-btn bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50">{busy ? '...' : node.submitLabel ?? 'Submit'}</button>
    </form>
  );
}

// ── Agent-native composites — the agentic core of a surface ──────────────────

/** The operator agent: presence, live status, and a command line to direct it. */
function AgentConsoleView({ node }: { node: Extract<ViewNode, { type: 'AgentConsole' }> }) {
  const { appId } = useRuntime();
  const editing = useContext(EditCtx);
  const [operator, setOperator] = useState<AppOperator | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    appsApi.operator(appId).then((op) => { if (!cancelled) setOperator(op); }).catch(() => {});
    return () => { cancelled = true; };
  }, [appId]);

  const onStatus = useCallback((env: RealtimeEnvelope) => {
    const p = env.payload;
    if (isRecord(p) && operator && p.agentId === operator.agentId && typeof p.status === 'string') setLiveStatus(p.status);
  }, [operator]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.AGENT_STATUS_CHANGED], []), onStatus);

  const status = liveStatus ?? operator?.status ?? 'offline';
  const canCommand = Boolean(operator?.canCommand) && !editing;
  const name = operator?.name ?? 'Operator';

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const text = command.trim();
    if (!text || busy || !canCommand) return;
    setBusy(true);
    setNote(null);
    try {
      await appsApi.runOperatorCommand(appId, text);
      setCommand('');
      setNote('Sent to the operator — watch the activity below.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not reach the operator');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[15px] font-semibold text-white"
          style={{ background: operator?.colorHex ?? '#6366f1' }}
        >
          {operator?.name ? operator.name.charAt(0).toUpperCase() : <Bot size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text-primary">{name}</span>
            <StatusPill status={status} />
          </div>
          <div className="text-[11px] text-text-muted">{node.title ?? 'Operator — the agent running this app'}</div>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)} className="mt-3 flex items-center gap-2">
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder={node.prompt ?? 'Tell the operator what to do…'}
          aria-label="Direct the operator"
          disabled={!canCommand}
          className="h-9 flex-1 rounded-btn border border-line bg-canvas px-3 text-[13px] text-text-primary outline-none focus:border-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canCommand || !command.trim() || busy}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send
        </button>
      </form>
      {!operator ? (
        <p className="mt-2 text-[11px] text-text-muted">No operator assigned yet — add an agent to this app in its settings.</p>
      ) : !operator.canCommand ? (
        <p className="mt-2 text-[11px] text-text-muted">Add a workflow so the operator can act on commands.</p>
      ) : note ? (
        <p className="mt-2 text-[11px] text-text-secondary">{note}</p>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === 'online' ? 'bg-accent-soft text-accent'
    : status === 'busy' ? 'bg-warn-soft text-warn'
    : status === 'error' ? 'bg-danger-soft text-danger'
    : 'bg-canvas text-text-muted';
  const label = status === 'online' ? 'Ready' : status === 'busy' ? 'Working' : status === 'error' ? 'Error' : 'Offline';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

interface ActivityItem { id: string; icon: ReactNode; label: string; tone: 'default' | 'accent' | 'success' | 'danger' | 'warning'; at: string; }

const ACTIVITY_EVENTS: string[] = [
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.NODE_STARTED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
];

function field(payload: unknown, key: string): string | undefined {
  return isRecord(payload) && typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
}

function mapActivity(env: RealtimeEnvelope): Omit<ActivityItem, 'id' | 'at'> | null {
  const p = env.payload;
  switch (env.event) {
    case REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL:
      return { icon: <Wrench size={13} />, tone: 'default', label: `Tool · ${field(p, 'tool') ?? field(p, 'name') ?? 'call'}` };
    case REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE: {
      const message = field(p, 'message') ?? field(p, 'token');
      return message ? { icon: <Bot size={13} />, tone: 'default', label: message } : null;
    }
    case REALTIME_EVENTS.AGENT_WORK_STEP:
      return { icon: <Activity size={13} />, tone: 'accent', label: field(p, 'title') ?? field(p, 'detail') ?? field(p, 'phase') ?? 'Working' };
    case REALTIME_EVENTS.RUN_RUNNING:
      return { icon: <Activity size={13} />, tone: 'accent', label: 'Run started' };
    case REALTIME_EVENTS.RUN_COMPLETED:
      return { icon: <Check size={13} />, tone: 'success', label: 'Run completed' };
    case REALTIME_EVENTS.RUN_FAILED:
      return { icon: <AlertTriangle size={13} />, tone: 'danger', label: `Run failed${field(p, 'error') ? ` · ${field(p, 'error')}` : ''}` };
    case REALTIME_EVENTS.NODE_STARTED:
      return { icon: <Activity size={13} />, tone: 'default', label: `Step · ${field(p, 'nodeTitle') ?? field(p, 'title') ?? field(p, 'nodeId') ?? ''}` };
    case REALTIME_EVENTS.NODE_COMPLETED:
      return { icon: <Check size={13} />, tone: 'success', label: `Done · ${field(p, 'nodeTitle') ?? field(p, 'title') ?? ''}` };
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return { icon: <AlertTriangle size={13} />, tone: 'warning', label: `Awaiting approval · ${field(p, 'summary') ?? field(p, 'title') ?? ''}` };
    default:
      return null;
  }
}

function useActivityFeed(limit: number): ActivityItem[] {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const seq = useRef(0);
  const events = useMemo(() => ACTIVITY_EVENTS, []);
  const handler = useCallback((env: RealtimeEnvelope) => {
    const base = mapActivity(env);
    if (!base) return;
    setItems((prev) => [{ ...base, id: `a${seq.current++}`, at: env.emittedAt }, ...prev].slice(0, limit));
  }, [limit]);
  useRealtime(events, handler);
  return items;
}

function activityToneClass(tone: ActivityItem['tone']): string {
  return tone === 'accent' ? 'text-accent' : tone === 'success' ? 'text-accent' : tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warn' : 'text-text-muted';
}

function activityTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A live feed of the operator's work, streamed over realtime. */
function ActivityStreamView({ node }: { node: Extract<ViewNode, { type: 'ActivityStream' }> }) {
  const items = useActivityFeed(node.limit ?? 12);
  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Activity size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-text-primary">{node.title ?? 'Live activity'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> live
        </span>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-text-muted">Waiting for the operator to act…</div>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-auto">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 px-3 py-2 text-[12px]">
              <span className={`mt-0.5 shrink-0 ${activityToneClass(item.tone)}`}>{item.icon}</span>
              <span className="min-w-0 flex-1 break-words text-text-secondary">{item.label}</span>
              <span className="shrink-0 text-[10px] text-text-muted">{activityTime(item.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A kanban board over a collection, grouped by a status/stage field. */
function BoundBoard({ node }: { node: Extract<ViewNode, { type: 'DataBoard' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  const order: string[] = [];
  const byGroup = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row[node.groupBy] ?? 'Unassigned');
    let bucket = byGroup.get(key);
    if (!bucket) { bucket = []; byGroup.set(key, bucket); order.push(key); }
    bucket.push(row);
  }
  if (order.length === 0) order.push('Unassigned');
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {order.map((key) => {
        const groupRows = byGroup.get(key) ?? [];
        return (
          <div key={key} className="w-56 shrink-0 rounded-card border border-line bg-canvas/40">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="truncate text-[12px] font-semibold capitalize text-text-primary">{key}</span>
              <span className="rounded-full bg-surface px-1.5 text-[10px] text-text-muted">{groupRows.length}</span>
            </div>
            <div className="flex flex-col gap-2 p-2">
              {groupRows.length === 0 ? (
                <div className="px-1 py-2 text-[11px] text-text-muted">Empty</div>
              ) : groupRows.map((row, i) => (
                <div key={(row.id as string) ?? i} className="rounded-btn border border-line bg-surface px-2.5 py-2 text-[12px] text-text-secondary">
                  {String(row[node.titleField ?? 'title'] ?? row.name ?? row.id ?? 'Untitled')}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatCell(value: unknown, format?: string): React.ReactNode {
  if (value == null) return '-';
  if (format === 'boolean') return value ? 'Yes' : 'No';
  if (format === 'badge') return <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px]">{String(value)}</span>;
  if (format === 'date') return new Date(String(value)).toLocaleString();
  return String(value);
}

function SkeletonRows() {
  return <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded-btn bg-canvas" />)}</div>;
}

export function useDataRevision(appId: string): number {
  const [rev, setRev] = useState(0);
  const handler = useCallback((env: RealtimeEnvelope) => {
    const payload = env.payload as { appId?: string } | undefined;
    if (payload?.appId && payload.appId !== appId) return;
    setRev((r) => r + 1);
  }, [appId]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.DATA_CHANGED], []), handler);
  return rev;
}
