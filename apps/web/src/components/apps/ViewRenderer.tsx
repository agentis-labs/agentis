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
import { Activity, AlertTriangle, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Code2, Copy, Download, ExternalLink, FileText, Globe2, Image as ImageIcon, Loader2, MapPin, MessageSquare, Pin, Play, Search, Send, Sparkles, Trash2, Workflow, Wrench, X } from 'lucide-react';
import clsx from 'clsx';
import {
  APP_CLIENT_MESSAGE_SOURCE,
  APP_CLIENT_PROTOCOL_VERSION,
  type AgentisAppClient,
  type AppClientMessage,
  type AppClientResponse,
} from '@agentis/app-client';
import type { AccentName, ActionRef, AppAgentActivity, AppPresenceUpdate, AppPresenceViewer, AppWorkflowSummary, DataBind, SurfaceAction, Tone, ViewNode } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { tokens } from '../../lib/api';
import { appsApi, type AppConversation, type AppConversationMessage } from '../../lib/appsApi';
import { pathsEqual, pathKey } from './viewTree';
import { CHART_PALETTE, ThemeProvider, accentColor, resolveTheme, useTheme, type ResolvedTheme } from './theme';
import { containerClasses, textClasses, toneFillClass, toneFromStatus, toneSoftClass } from './styleIntent';
import { DataChart, Sparkline as SparkSvg, type ChartSeries } from './charts';
import { CODE_SURFACE_KIT, CODE_SURFACE_TOKENS } from './codeSurfaceKit';
import { registerBlock, getBlock, type BlockContext, type ResolveScope } from './blocks/registry';

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
/** True when rendering inside an elevated (boxed) container — nested boxes flatten. */
const BoxedCtx = createContext(false);

export function SurfaceEditProvider({ value, children }: { value: SurfaceEditContext; children: React.ReactNode }) {
  return <EditCtx.Provider value={value}>{children}</EditCtx.Provider>;
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

/** The binding path of a bindable, for the unbound marker. */
function bindablePath(value: unknown): string {
  if (isRecord(value)) {
    if ('$bind' in value) return String(value.$bind);
    if ('$row' in value) return `row.${String(value.$row)}`;
    if ('$state' in value) return `state.${String(value.$state)}`;
  }
  return '?';
}

function displayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Resolve a value for DISPLAY. Returns the text PLUS the binding path when a
 * binding that was supposed to resolve came back empty — so the renderer surfaces
 * a visible "unbound" marker instead of silently rendering nothing (the silent
 * data-binding failure that made broken apps look merely empty).
 */
function resolveDisplay(value: unknown, scope: ResolveScope): { text: string; unbound: string | null } {
  if (isBindableObject(value)) {
    const resolved = resolveBindable(value, scope);
    if (resolved === undefined || resolved === null) return { text: '', unbound: bindablePath(value) };
    return { text: displayString(resolved), unbound: null };
  }
  return { text: value == null ? '' : displayString(value), unbound: null };
}

/** A visible, non-breaking marker for a binding that did not resolve. */
function UnboundMarker({ path }: { path: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-danger"
      title={`Unbound data: "${path}" did not resolve. Check that the source node/field exists and ran.`}
    >
      ⚠ unbound: {path}
    </span>
  );
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
  const inherited = useTheme();
  const boxed = useContext(BoxedCtx);
  const isRoot = path.length === 0;
  // At the root the surface is self-contained: use its own theme/design/density and
  // let resolveTheme apply the theme's preset design when none is set (so e.g. a
  // `product` theme leads with `soft`, not the context default). Don't fall back to
  // the inherited (context-default) design here — that would override the theme.
  const effective = isRoot
    ? resolveTheme(node.style?.theme, node.style?.design, node.style?.density)
    : inherited;

  let content = renderContent();
  if (isRoot) {
    content = (
      <ThemeProvider value={effective}>
        <div
          className="@container mx-auto w-full"
          data-design={effective.design.id}
          style={{ maxWidth: effective.contentWidth, ...effective.design.vars }}
        >
          {content}
        </div>
      </ThemeProvider>
    );
  }
  if (!edit || !editable) return content;
  return (
    <EditNodeWrapper node={node} path={path} edit={edit}>
      {content}
    </EditNodeWrapper>
  );

  function renderContent(): React.ReactNode {
    // Dispatch through the open block registry (see ./blocks/registry). Built-in
    // blocks register at module load; an unregistered kind renders a visible
    // UnknownBlock instead of silently returning null. Children recurse through
    // ctx.renderChild so blocks never import the renderer.
    const ctx: BlockContext = {
      scope,
      resolvedScope,
      path,
      theme: effective,
      boxed,
      renderChild: (child, childPath, childScope) => (
        <ViewRenderer key={pathKey(childPath)} node={child} scope={childScope} path={childPath} />
      ),
    };
    const renderer = getBlock(node.type);
    return renderer ? renderer(node, ctx) : <UnknownBlock node={node} />;
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
    <div className="s-panel overflow-hidden">
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
          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
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
      <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3">
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

// ── Sandboxed surfaces (CustomView + CodeSurface) — one hardened boundary ─────
//
// Both render agent-authored code in a null-origin `sandbox="allow-scripts"`
// iframe with CSP `connect-src 'none'` (zero network egress). Data + actions
// flow ONLY through the postMessage bridge below, which the parent authz-checks
// server-side against the surface's collection/action allowlists. The bridge
// holds no secrets. This is the security boundary; CodeSurface adds the design
// tokens + component/chart kit on top of it (no new egress).

const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";

/** In-frame bridge: window.agentis forwards to the parent over postMessage. */
const BRIDGE_SCRIPT = `
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
      data: { query: (collection, query) => request('data.query', { collection, query: query || {} }) },
      actions: { invoke: (name, args) => request('actions.invoke', { name, args: args || {} }) },
      state: { get: (key) => request('state.get', { key }), set: (key, value) => request('state.set', { key, value }), subscribe: () => () => {} },
      realtime: { subscribe: () => () => {} },
      navigation: { go: (surface, params) => request('navigation.go', { surface, params: params || {} }) },
      files: { upload: () => Promise.reject(new Error('files.upload is not available in a sandboxed surface')) },
      query: (collection, query) => request('data.query', { collection, query: query || {} }),
      action: (name, args) => request('actions.invoke', { name, args: args || {} }),
    };
  <\/script>`;

/** Neutralize any `</script>` in agent code so it can't break out of its <script> host. */
function neutralizeScriptClose(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Parent-side bridge handler shared by CustomView + CodeSurface. Forwards the
 * frame's calls to the runtime client, enforcing the collection + action
 * allowlists. Wired only when the app policy allows custom code.
 */
function useSandboxBridge(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  allowedCollections: Set<string>,
  allowedActions: Set<string>,
  enabled: boolean,
) {
  const { client } = useRuntime();
  const onMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data as AppClientMessage | undefined;
      if (!message || message.source !== APP_CLIENT_MESSAGE_SOURCE || message.version !== APP_CLIENT_PROTOCOL_VERSION) return;
      const reply = (response: Omit<AppClientResponse, 'source' | 'version' | 'id'>) => {
        (event.source as Window | null)?.postMessage(
          { source: APP_CLIENT_MESSAGE_SOURCE, version: APP_CLIENT_PROTOCOL_VERSION, id: message.id, ...response } satisfies AppClientResponse,
          '*',
        );
      };
      try {
        switch (message.op) {
          case 'data.query': {
            const { collection, query } = message.payload as { collection: string; query?: Record<string, unknown> };
            if (!allowedCollections.has(collection)) return reply({ ok: false, error: 'collection not allowed' });
            return reply({ ok: true, result: await client.data.query(collection, query) });
          }
          case 'actions.invoke': {
            const { name, args } = message.payload as { name: string; args?: Record<string, unknown> };
            if (!allowedActions.has(name)) return reply({ ok: false, error: 'action not allowed' });
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
            return reply({ ok: false, error: `${message.op} is not available in a sandboxed surface` });
        }
      } catch (err) {
        return reply({ ok: false, error: err instanceof Error ? err.message : 'bridge call failed' });
      }
    },
    [allowedCollections, allowedActions, client, frameRef],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [enabled, onMessage]);
}

function SandboxBlocked({ label }: { label: string }) {
  return <div className="rounded-card border border-line bg-canvas px-3 py-2 text-[12px] text-text-muted">{label}</div>;
}

function CustomViewFrame({ node }: { node: Extract<ViewNode, { type: 'CustomView' }> }) {
  const { allowCustomCode, surfaceActions } = useRuntime();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const allowed = useMemo(() => new Set(node.collections ?? []), [node.collections]);
  const allowedActions = useMemo(() => new Set(surfaceActions.map((a) => a.name)), [surfaceActions]);
  useSandboxBridge(frameRef, allowed, allowedActions, allowCustomCode);

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"></head><body style="margin:0;font-family:system-ui;color:#111">${node.html}${BRIDGE_SCRIPT}</body></html>`,
    [node.html],
  );

  if (!allowCustomCode) return <SandboxBlocked label="Custom view blocked by app policy." />;
  return <iframe title="Custom view" ref={frameRef} sandbox="allow-scripts" srcDoc={srcDoc} className="w-full rounded-card border border-line bg-white" style={{ height: node.height ?? 320 }} />;
}

/** The full-power tier: agent JS + the Agentis kit, in the same hardened sandbox. */
function CodeSurfaceFrame({ node }: { node: Extract<ViewNode, { type: 'CodeSurface' }> }) {
  const { allowCustomCode, surfaceActions } = useRuntime();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const allowed = useMemo(() => new Set(node.collections ?? []), [node.collections]);
  const allowedActions = useMemo(() => new Set(surfaceActions.map((a) => a.name)), [surfaceActions]);
  useSandboxBridge(frameRef, allowed, allowedActions, allowCustomCode);

  const srcDoc = useMemo(() => {
    const body = `
      <div id="agentis-root"></div>
      <script>${CODE_SURFACE_KIT}<\/script>
      ${BRIDGE_SCRIPT}
      <script>
        (async function(){
          var root = document.getElementById('agentis-root');
          var ui = window.ui, agentis = window.agentis;
          try { ${neutralizeScriptClose(node.code)} }
          catch (err) { root.innerHTML = '<pre style="white-space:pre-wrap;color:#ef4444;font:12px/1.5 monospace">' + String(err && err.stack || err) + '<\\/pre>'; }
        })();
      <\/script>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><style>${CODE_SURFACE_TOKENS}</style></head><body>${body}</body></html>`;
  }, [node.code]);

  if (!allowCustomCode) return <SandboxBlocked label="Code surface blocked by app policy — enable custom-coded views in the App engine." />;
  return <iframe title="Code surface" ref={frameRef} sandbox="allow-scripts" srcDoc={srcDoc} className="w-full rounded-card border border-line bg-canvas" style={{ height: node.height ?? 360 }} />;
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
  const cls = variant === 'danger' ? 'bg-danger text-white' : variant === 'secondary' ? 'border border-line bg-surface text-text-primary' : 'bg-accent text-on-accent';
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

/** Column keys whose values read as a status — auto-rendered as a toned pill. */
function isStatusKey(key: string): boolean {
  return /^(status|stage|state|priority|severity|tier|phase)$/i.test(key);
}
/** First textual column → gets an avatar + emphasis (the row's identity). */
function isNameKey(key: string): boolean {
  return /^(name|title|account|company|customer|user|client|agent|owner|label)$/i.test(key);
}

/** Sort comparator that understands numbers (even numeric strings) and falls back to locale text. */
function compareCells(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a).localeCompare(String(b));
}

const TABLE_PAGE_SIZE = 10;

function BoundTable({ node }: { node: Extract<ViewNode, { type: 'Table' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  // Client-side over the bound rows: click a header to sort (asc → desc → off),
  // a filter box, and pagination — all kick in only for sizeable tables.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => sign * compareCells(a[sort.key], b[sort.key]));
  }, [rows, sort]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((row) => node.columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(q)));
  }, [sorted, query, node.columns]);
  const toggleSort = (key: string) => setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));
  if (loading) return <SkeletonRows />;
  const identityCol = node.columns.find((c) => isNameKey(c.key))?.key ?? node.columns[0]?.key;
  const filterable = rows.length > 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const paginate = filtered.length > TABLE_PAGE_SIZE;
  const visible = paginate ? filtered.slice(current * TABLE_PAGE_SIZE, current * TABLE_PAGE_SIZE + TABLE_PAGE_SIZE) : filtered;
  const colCount = node.columns.length + (node.rowActions?.length ? 1 : 0);
  return (
    <div className="s-panel overflow-hidden">
      {filterable ? (
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder="Filter…"
            className="w-full bg-transparent text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none"
            aria-label="Filter rows"
          />
          {query ? <span className="shrink-0 text-[11px] text-text-muted">{filtered.length} of {rows.length}</span> : null}
        </div>
      ) : null}
      <table className="w-full text-left text-[12px]">
        <thead className="bg-canvas/60 text-text-muted">
          <tr>
            {node.columns.map((col) => (
              <th key={col.key} className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-wide">
                <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-text-secondary" aria-label={`Sort by ${col.label ?? col.key}`}>
                  {col.label ?? col.key}
                  {sort?.key === col.key ? (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : null}
                </button>
              </th>
            ))}
            {node.rowActions?.length ? <th className="px-3 py-2.5" /> : null}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr><td colSpan={colCount}><EmptyState label={query ? 'No matches' : 'No records yet'} hint={query ? 'Try a different filter.' : 'Rows the agent or a form adds will appear here.'} /></td></tr>
          ) : visible.map((row, i) => (
            <tr key={(row.id as string) ?? i} className="border-t border-line transition-colors odd:bg-surface/30 hover:bg-surface-2/60">
              {node.columns.map((col) => {
                const isId = col.key === identityCol;
                const asStatus = col.format === 'badge' || (!col.format && isStatusKey(col.key));
                const raw = row[col.key];
                return (
                  <td key={col.key} className={clsx('px-3.5 py-2.5', isId ? 'text-text-primary' : 'text-text-secondary')}>
                    {asStatus && raw != null && raw !== '' ? (
                      <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', toneSoftClass(toneFromStatus(String(raw))))}>
                        <span className={clsx('h-1.5 w-1.5 rounded-full', toneFillClass(toneFromStatus(String(raw))))} />
                        {String(raw)}
                      </span>
                    ) : isId ? (
                      <span className="inline-flex items-center gap-2 font-medium">
                        <AvatarChip name={String(raw ?? '')} />
                        <span className="truncate">{formatCell(raw, col.format)}</span>
                      </span>
                    ) : formatCell(raw, col.format)}
                  </td>
                );
              })}
              {node.rowActions?.length ? (
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-1">
                    {node.rowActions.map((a, j) => <ActionButton key={j} label={prettifyAction(a.action)} action={a.action} args={a.args} scope={row} variant="secondary" />)}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {paginate ? (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-text-muted">
          <span className="tabular-nums">{current * TABLE_PAGE_SIZE + 1}–{Math.min((current + 1) * TABLE_PAGE_SIZE, filtered.length)} of {filtered.length}</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="inline-flex h-6 w-6 items-center justify-center rounded-btn border border-line text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-40" aria-label="Previous page"><ChevronLeft size={13} /></button>
            <span className="px-1 tabular-nums">{current + 1} / {pageCount}</span>
            <button type="button" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)} className="inline-flex h-6 w-6 items-center justify-center rounded-btn border border-line text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-40" aria-label="Next page"><ChevronRight size={13} /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A tiny initials chip for the identity column (no image source needed). */
function AvatarChip({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '·';
  return <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[9px] font-semibold text-accent">{initials}</span>;
}

/** A designed empty state — intentional, not an error. Used by tables/boards/lists. */
function EmptyState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-text-muted"><Sparkles size={16} /></span>
      <div className="text-[12px] font-medium text-text-secondary">{label}</div>
      {hint ? <div className="max-w-xs text-[11px] text-text-muted">{hint}</div> : null}
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
  const { design } = useTheme();
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  const series: ChartSeries[] = node.series && node.series.length > 0 ? node.series : [{ y: node.y }];
  return (
    <DataChart
      rows={rows}
      x={node.x}
      series={series}
      chartType={node.chartType}
      stacked={node.stacked}
      area={node.area}
      height={node.height}
      legend={node.legend}
      curve={node.curve}
      gradientFill={design.policy.gradientCharts}
    />
  );
}

/** Shared field styling — consistent height, hover + accent focus ring, tokenized. */
const FORM_INPUT = 'w-full rounded-btn border border-line bg-canvas px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-muted transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft';

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
      {node.fields.map((f) => {
        if (f.type === 'checkbox') {
          return (
            <label key={f.key} className="inline-flex items-center gap-2 text-[12px] text-text-secondary">
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} className="h-4 w-4 rounded border border-line bg-canvas accent-accent" />
              <span>{f.label ?? f.key}{f.required ? ' *' : ''}</span>
            </label>
          );
        }
        return (
          <label key={f.key} className="flex flex-col gap-1.5 text-[12px] text-text-secondary">
            <span className="font-medium">{f.label ?? f.key}{f.required ? <span className="text-accent"> *</span> : null}</span>
            {f.type === 'textarea' ? (
              <textarea required={f.required} placeholder={f.placeholder} rows={3} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} className={FORM_INPUT} />
            ) : f.type === 'select' ? (
              <select required={f.required} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} className={FORM_INPUT}>
                <option value="">Select…</option>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} required={f.required} placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} className={FORM_INPUT} />
            )}
          </label>
        );
      })}
      <button type="submit" disabled={busy} className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-btn bg-accent px-3.5 py-2 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : null}{busy ? 'Saving…' : node.submitLabel ?? 'Submit'}</button>
    </form>
  );
}

// ── Agent-native composites — the agentic core of a surface ──────────────────

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
      return { icon: <Wrench size={13} />, tone: 'default', label: `Tool - ${field(p, 'tool') ?? field(p, 'name') ?? 'call'}` };
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
      return { icon: <AlertTriangle size={13} />, tone: 'danger', label: `Run failed${field(p, 'error') ? ` - ${field(p, 'error')}` : ''}` };
    case REALTIME_EVENTS.NODE_STARTED:
      return { icon: <Activity size={13} />, tone: 'default', label: `Step - ${field(p, 'nodeTitle') ?? field(p, 'title') ?? field(p, 'nodeId') ?? ''}` };
    case REALTIME_EVENTS.NODE_COMPLETED:
      return { icon: <Check size={13} />, tone: 'success', label: `Done - ${field(p, 'nodeTitle') ?? field(p, 'title') ?? ''}` };
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return { icon: <AlertTriangle size={13} />, tone: 'warning', label: `Awaiting approval - ${field(p, 'summary') ?? field(p, 'title') ?? ''}` };
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

function ActivityStreamView({ node }: { node: Extract<ViewNode, { type: 'ActivityStream' }> }) {
  const items = useActivityFeed(node.limit ?? 12);
  return (
    <div className="s-panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Activity size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-text-primary">{node.title ?? 'Live activity'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> live
        </span>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-text-muted">Waiting for activity...</div>
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
        const tone = toneFromStatus(key);
        return (
          <div key={key} className="s-round flex w-60 shrink-0 flex-col bg-canvas/40 ring-1 ring-line">
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', toneFillClass(tone))} />
                <span className="truncate text-[12px] font-semibold capitalize text-text-primary">{key}</span>
              </span>
              <span className={clsx('rounded-full px-1.5 text-[10px] font-medium', toneSoftClass(tone))}>{groupRows.length}</span>
            </div>
            <div className="flex min-h-[40px] flex-col gap-2 px-2 pb-2">
              {groupRows.length === 0 ? (
                <div className="rounded-btn border border-dashed border-line/70 px-2 py-3 text-center text-[11px] text-text-muted">Empty</div>
              ) : groupRows.map((row, i) => (
                <div key={(row.id as string) ?? i} className="s-panel cursor-default px-2.5 py-2 text-[12px] text-text-secondary transition-transform hover:-translate-y-0.5">
                  <div className="font-medium text-text-primary">{String(row[node.titleField ?? 'title'] ?? row.name ?? row.id ?? 'Untitled')}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── GenUI Renaissance — layout, content & viz nodes ──────────────────────────

function prettifyAction(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function MetricView({ node, scope }: { node: Extract<ViewNode, { type: 'Metric' }>; scope: ResolveScope }) {
  const { density } = useTheme();
  const value = resolveDisplay(node.value, scope);
  return (
    <div className={containerClasses(node.style, density, { defaultElevation: 'inset', defaultPad: 'sm' })}>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{node.label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        {value.unbound ? (
          <UnboundMarker path={value.unbound} />
        ) : (
          <span className={clsx('text-[19px] font-semibold leading-none text-text-primary', textClasses({ tone: node.style?.tone }))}>
            {value.text || '—'}
          </span>
        )}
        {node.delta != null ? <span className="text-[11px] text-text-secondary">{String(resolveBindable(node.delta, scope) ?? '')}</span> : null}
      </div>
    </div>
  );
}

function CalloutView({ node }: { node: Extract<ViewNode, { type: 'Callout' }> }) {
  const tone = node.style?.tone ?? 'info';
  return (
    <div className={clsx('flex items-start gap-2 rounded-card px-3 py-2.5 text-[12px]', toneSoftClass(tone))}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        {node.title ? <div className="font-semibold">{node.title}</div> : null}
        <div className="leading-relaxed">{node.value}</div>
      </div>
    </div>
  );
}

/**
 * AgentRegion (Phase M3 / G12) — a stable slot the operator places once; the
 * agent PERFORMS a transient ViewNode into it live over the realtime bus. The
 * frame never moves; performed content is explainable (a `reason`), dismissable,
 * and pinnable. Un-pinned performances are ephemeral (not stored); pinning freezes
 * the child into the surface so it survives a reload.
 */
type PerformedRegion = { view: ViewNode | null; reason?: string; pinned: boolean };

function AgentRegionView({ node, scope, path }: { node: Extract<ViewNode, { type: 'AgentRegion' }>; scope?: Record<string, unknown>; path: number[] }) {
  const { appId, surface } = useRuntime();
  // Seed from the stored slot (a pinned region rehydrates here); live pushes override.
  const [performed, setPerformed] = useState<PerformedRegion | null>(
    node.child ? { view: node.child, reason: node.reason, pinned: node.pinned === true } : null,
  );
  const [busy, setBusy] = useState(false);

  const onRender = useCallback(
    (env: RealtimeEnvelope) => {
      const p = env.payload as { appId?: string; surface?: string; region?: string; view?: ViewNode | null; reason?: string; pinned?: boolean } | undefined;
      if (!p?.region || p.region !== node.region) return;
      if (p.appId && p.appId !== appId) return;
      if (p.surface && p.surface !== surface) return;
      setPerformed(p.view ? { view: p.view, reason: p.reason, pinned: p.pinned === true } : null);
    },
    [appId, surface, node.region],
  );
  useRealtime(useMemo(() => [REALTIME_EVENTS.SURFACE_RENDER], []), onRender);

  const act = useCallback(
    async (body: { pin?: boolean; clear?: boolean }) => {
      setBusy(true);
      try {
        await appsApi.performRegion(appId, surface, { region: node.region, ...body });
        if (body.clear) setPerformed(null);
        else if (body.pin) setPerformed((prev) => (prev ? { ...prev, pinned: true } : prev));
      } catch {
        // best-effort operator control; surface stays as-is on failure
      } finally {
        setBusy(false);
      }
    },
    [appId, surface, node.region],
  );

  // Empty, un-performed slot: render nothing in production; a quiet placeholder in edit mode.
  if (!performed || !performed.view) {
    return (
      <div className="rounded-card border border-dashed border-line/70 px-3 py-2 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5"><Sparkles size={12} /> {node.title ?? 'Agent region'} · {node.placeholder ?? 'the agent composes here'}</span>
      </div>
    );
  }

  return (
    <div className={clsx('rounded-card border bg-surface', performed.pinned ? 'border-line' : 'border-accent/40')}>
      <div className="flex items-start justify-between gap-2 border-b border-line/60 px-3 py-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <Sparkles size={13} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-text-primary">{node.title ?? 'Agent attention'}</div>
            {performed.reason ? <div className="truncate text-[11px] text-text-muted">added because {performed.reason}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ pin: !performed.pinned })}
            title={performed.pinned ? 'Pinned — click to keep performing live' : 'Pin (freeze into the surface)'}
            className={clsx('rounded p-1 hover:bg-surface-2', performed.pinned ? 'text-accent' : 'text-text-muted')}
          >
            <Pin size={13} />
          </button>
          <button type="button" disabled={busy} onClick={() => void act({ clear: true })} title="Dismiss" className="rounded p-1 text-text-muted hover:bg-surface-2">
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="p-3">
        {/* Performed content is transient (not part of the editable stored tree),
            so it renders inert in edit mode — keep the region's own path. */}
        <ViewRenderer node={performed.view} scope={scope} path={path} editable={false} />
      </div>
    </div>
  );
}

function AvatarView({ node, scope }: { node: Extract<ViewNode, { type: 'Avatar' }>; scope: ResolveScope }) {
  const name = node.name != null ? String(resolveBindable(node.name, scope) ?? '') : '';
  const src = node.src != null ? String(resolveBindable(node.src, scope) ?? '') : '';
  const size = node.size === 'lg' ? 'h-12 w-12 text-[16px]' : node.size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-9 w-9 text-[13px]';
  if (src) return <img src={src} alt={name} className={clsx('rounded-full object-cover', size)} />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';
  return <span className={clsx('inline-flex items-center justify-center rounded-full bg-surface-2 font-semibold text-text-primary', size)}>{initials}</span>;
}

function ProgressBarView({ node, scope }: { node: Extract<ViewNode, { type: 'ProgressBar' }>; scope: ResolveScope }) {
  const value = Number(resolveBindable(node.value, scope)) || 0;
  const max = node.max ?? 100;
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
        <span>{node.label ?? ''}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
        <div className={clsx('h-full rounded-full', toneFillClass(node.style?.tone))} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BoundSparkline({ bind, yKey, accent }: { bind: DataBind; yKey: string; accent?: AccentName }) {
  const { rows, loading } = useBoundRows(bind);
  if (loading) return <div className="h-8 animate-pulse rounded bg-canvas" />;
  return <SparkSvg points={rows.map((r) => Number(r[yKey]) || 0)} accent={accent} />;
}

function SparklineView({ node }: { node: Extract<ViewNode, { type: 'Sparkline' }> }) {
  if (node.bind) return <BoundSparkline bind={node.bind} yKey={node.y ?? ''} accent={node.style?.accent} />;
  return <SparkSvg points={node.points ?? []} accent={node.style?.accent} />;
}

function KpiStripView({ node, scope }: { node: Extract<ViewNode, { type: 'KPIStrip' }>; scope: ResolveScope }) {
  const { design } = useTheme();
  // Auto-fit so wide screens pack more KPIs per row (denser dashboards).
  return (
    <div className="grid" style={{ gap: 'var(--s-gap, 12px)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
      {node.items.map((item, i) => {
        // In multi-palette languages each tile gets a rotating accent edge + spark hue.
        const paletteAccent = design.policy.multiPalette ? CHART_PALETTE[i % CHART_PALETTE.length] : undefined;
        const sparkAccent = item.tone && item.tone !== 'neutral'
          ? item.tone
          : (paletteAccent as AccentName | undefined);
        return (
          <div key={i} className="s-tile relative overflow-hidden px-4 py-3">
            {paletteAccent ? (
              <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accentColor(paletteAccent) }} />
            ) : null}
            <div className="break-words text-[10px] font-medium uppercase tracking-wide text-text-muted">{item.label}</div>
            {/* wrap (not clip): values/deltas can be long phrases, and tiles narrow as the surface shrinks. */}
            <div className="mt-1 flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
              {(() => {
                const v = resolveDisplay(item.value, scope);
                return v.unbound ? (
                  <UnboundMarker path={v.unbound} />
                ) : (
                  <span
                    className="min-w-0 break-words font-semibold leading-tight text-text-primary"
                    style={{ fontSize: 'var(--s-kpi-size, 22px)' }}
                  >
                    {v.text || '—'}
                  </span>
                );
              })()}
              {item.delta != null ? (
                <span className={clsx('min-w-0 break-words text-[11px] font-medium', item.tone ? textClasses({ tone: item.tone }) : 'text-success')}>
                  {String(resolveBindable(item.delta, scope) ?? '')}
                </span>
              ) : null}
            </div>
            {item.spark && item.spark.length > 1 ? <div className="mt-2"><SparkSvg points={item.spark} accent={sparkAccent} height={28} /></div> : null}
          </div>
        );
      })}
    </div>
  );
}

function HeroView({ node, scope }: { node: Extract<ViewNode, { type: 'Hero' }>; scope?: Record<string, unknown> }) {
  const resolved = useResolvedScope(scope);
  const accent = accentColor(node.style?.accent);
  const media = node.media != null ? String(resolveBindable(node.media, resolved) ?? '') : '';
  return (
    <div
      className="s-round relative overflow-hidden border border-line"
      style={{
        padding: 'var(--s-pad, 22px)',
        background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 16%, var(--color-surface)) 0%, var(--color-surface) 62%)`,
      }}
    >
      <div className="relative z-10 max-w-2xl">
        {node.eyebrow ? <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: accent }}>{node.eyebrow}</div> : null}
        <h1 className="font-semibold leading-tight text-text-primary" style={{ fontSize: 'calc(var(--s-heading-size, 18px) + 6px)' }}>{node.title}</h1>
        {node.subtitle ? <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">{node.subtitle}</p> : null}
        {node.actions?.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {node.actions.map((a, i) => <ActionButton key={i} label={prettifyAction(a.action)} action={a.action} args={a.args} scope={scope} variant={i === 0 ? 'primary' : 'secondary'} />)}
          </div>
        ) : null}
      </div>
      {media ? <img src={media} alt="" className="pointer-events-none absolute -right-6 top-1/2 z-0 h-[150%] -translate-y-1/2 object-contain opacity-90" /> : null}
    </div>
  );
}

function ToolbarView({ node, scope, path }: { node: Extract<ViewNode, { type: 'Toolbar' }>; scope?: Record<string, unknown>; path: number[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2">
      {node.title ? <span className="mr-auto text-[13px] font-semibold text-text-primary">{node.title}</span> : null}
      {node.children.map((c, i) => <ViewRenderer key={i} node={c} scope={scope} path={[...path, i]} />)}
    </div>
  );
}

function TabsView({ node, scope, path }: { node: Extract<ViewNode, { type: 'Tabs' }>; scope?: Record<string, unknown>; path: number[] }) {
  const [active, setActive] = useState(0);
  const current = node.tabs[active] ?? node.tabs[0];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist">
        {node.tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === active}
            onClick={(event) => { event.stopPropagation(); setActive(i); }}
            className={clsx(
              '-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium',
              i === active ? 'border-accent text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3 pt-3">
        {(current?.children ?? []).map((c, j) => <ViewRenderer key={j} node={c} scope={scope} editable={false} path={[...path, j]} />)}
      </div>
    </div>
  );
}

function AccordionView({ node, scope, path }: { node: Extract<ViewNode, { type: 'Accordion' }>; scope?: Record<string, unknown>; path: number[] }) {
  const [open, setOpen] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    node.sections.forEach((section, i) => { if (section.defaultOpen) initial.add(i); });
    return initial;
  });
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  return (
    <div className="flex flex-col gap-2">
      {node.sections.map((section, i) => {
        const isOpen = open.has(i);
        return (
          <div key={i} className="s-round overflow-hidden border border-line">
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); toggle(i); }}
              className="flex w-full items-center justify-between px-3 py-2 text-[13px] font-medium text-text-primary hover:bg-surface-2"
            >
              <span>{section.title}</span>
              {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {isOpen ? (
              <div className="flex flex-col gap-3 border-t border-line p-3">
                {section.children.map((c, j) => <ViewRenderer key={j} node={c} scope={scope} editable={false} path={[...path, i, j]} />)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SplitView({ node, scope, path }: { node: Extract<ViewNode, { type: 'Split' }>; scope?: Record<string, unknown>; path: number[] }) {
  // Clamp the ratio so neither side becomes an unreadable sliver; stack on narrow screens;
  // cap the rail so it can't balloon. The main pane keeps a readable minimum.
  const ratio = Math.min(2.5, Math.max(1, node.ratio ?? 2));
  return (
    <div className="flex flex-col gap-4 @2xl:flex-row">
      <div className="min-w-0 @2xl:min-w-[320px]" style={{ flex: ratio }}><ViewRenderer node={node.left} scope={scope} editable={false} path={[...path, 0]} /></div>
      <div className="min-w-0 @2xl:min-w-[260px] @2xl:max-w-[440px]" style={{ flex: 1 }}><ViewRenderer node={node.right} scope={scope} editable={false} path={[...path, 1]} /></div>
    </div>
  );
}

interface TimelineRow { title: string; detail?: string; at?: string; tone?: Tone }

function TimelineList({ title, items }: { title?: string; items: TimelineRow[] }) {
  return (
    <div>
      {title ? <div className="mb-2 text-[12px] font-semibold text-text-primary">{title}</div> : null}
      <ol className="relative ml-1 border-l border-line">
        {items.length === 0 ? (
          <li className="py-2 pl-4 text-[12px] text-text-muted">No events yet</li>
        ) : items.map((item, i) => (
          <li key={i} className="relative py-1.5 pl-4">
            <span className={clsx('absolute -left-[5px] top-[11px] h-2 w-2 rounded-full', toneFillClass(item.tone))} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-text-primary">{item.title}</span>
              {item.at ? <span className="shrink-0 text-[10px] text-text-muted">{item.at}</span> : null}
            </div>
            {item.detail ? <div className="text-[11px] text-text-secondary">{item.detail}</div> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function BoundTimeline({ node }: { node: Extract<ViewNode, { type: 'Timeline' }> & { bind: DataBind } }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;
  const items: TimelineRow[] = rows.map((row) => ({
    title: String(row[node.titleField ?? 'title'] ?? row.name ?? row.id ?? 'Event'),
    ...(node.detailField ? { detail: String(row[node.detailField] ?? '') } : {}),
    ...(node.atField ? { at: String(row[node.atField] ?? '') } : {}),
  }));
  return <TimelineList title={node.title} items={items} />;
}

function TimelineView({ node }: { node: Extract<ViewNode, { type: 'Timeline' }> }) {
  if (node.bind) return <BoundTimeline node={{ ...node, bind: node.bind }} />;
  return <TimelineList title={node.title} items={node.items ?? []} />;
}

// ── Domain composites — conversational, media, marketing, scheduling ─────────

function ChatBubble({ role, content, at }: { role: string; content: string; at?: string }) {
  const mine = role === 'user';
  return (
    <div className={clsx('max-w-[85%] rounded-card border border-line px-3 py-2 text-[12px]', mine ? 'ml-auto bg-accent-soft text-accent' : 'bg-canvas text-text-secondary')}>
      <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        <span>{role}</span>{at ? <span>· {at}</span> : null}
      </div>
      <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
    </div>
  );
}

interface ChatMsg { role: string; content: string; at?: string }

function Composer({ placeholder, label, onSend, extraArgs }: { placeholder?: string; label: string; onSend: (text: string) => Promise<void>; extraArgs?: Record<string, unknown> }) {
  const editing = useContext(EditCtx);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  void extraArgs;
  return (
    <form
      className="flex items-center gap-2 border-t border-line p-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value || busy || editing) return;
        setBusy(true);
        try { await onSend(value); setText(''); } finally { setBusy(false); }
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        placeholder={placeholder ?? 'Type a message…'}
        disabled={Boolean(editing)}
        className="h-9 flex-1 rounded-btn border border-line bg-canvas px-3 text-[13px] text-text-primary outline-none focus:border-accent disabled:opacity-60"
      />
      <button type="submit" disabled={Boolean(editing) || !text.trim() || busy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-on-accent disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} {label}
      </button>
    </form>
  );
}

function ChatShell({ title, channel, messages, send, placeholder, sendArgs }: { title?: string; channel?: string; messages: ChatMsg[]; send?: ActionRef; placeholder?: string; sendArgs?: Record<string, unknown> }) {
  const invoke = useActionInvoker();
  const resolvedScope = useResolvedScope();
  return (
    <div className="s-panel flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <MessageSquare size={14} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-primary">{title ?? 'Conversation'}</span>
        {channel ? <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] capitalize text-text-muted">{channel}</span> : null}
      </div>
      <div className="flex max-h-96 min-h-40 flex-col gap-2 overflow-auto p-3">
        {messages.length === 0 ? <div className="m-auto text-[12px] text-text-muted">No messages yet</div> : messages.map((m, i) => <ChatBubble key={i} role={m.role} content={m.content} at={m.at} />)}
      </div>
      {send ? (
        <Composer
          label="Send"
          placeholder={placeholder}
          onSend={(text) => invoke(send.action, { content: text, ...(sendArgs ?? {}), ...resolveArgs(send.args, resolvedScope) })}
        />
      ) : null}
    </div>
  );
}

// ── Live conversations (Living Apps Phase 1) ────────────────────
// Hooks over the REAL conversations spine (App-scoped), refreshed on the same
// realtime events the dispatcher emits — so the operator watches threads live.
const LIVE_EVENTS = [
  REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
  REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
  REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
];

function useLiveConversations(appId: string) {
  const [rows, setRows] = useState<AppConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    appsApi.conversations(appId).then((r) => { setRows(r); setLoading(false); }).catch(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  useRealtime(useMemo(() => LIVE_EVENTS, []), useCallback(() => load(), [load]));
  return { rows, loading, reload: load };
}

function useLiveMessages(appId: string, conversationId: string | null) {
  const [messages, setMessages] = useState<AppConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!conversationId) { setMessages([]); setLoading(false); return; }
    appsApi.conversationMessages(appId, conversationId).then((m) => { setMessages(m); setLoading(false); }).catch(() => setLoading(false));
  }, [appId, conversationId]);
  useEffect(() => { setLoading(true); load(); }, [load]);
  useRealtime(useMemo(() => LIVE_EVENTS, []), useCallback(() => load(), [load]));
  return { messages, loading };
}

// ── Live co-presence (Living Apps G9) ───────────────────────────
// Ephemeral, over the EXISTING realtime bus. `usePresence` heartbeats while the
// console is open (and which thread it focuses) and listens for the broadcast
// roster; `useAgentActivity` surfaces the resident agent's live thinking/typing.

/** Decode the operator's own userId from the access JWT, to filter self out of the roster. */
function selfUserId(): string | null {
  try {
    const token = tokens.access();
    if (!token) return null;
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

const PRESENCE_HEARTBEAT_MS = 8_000;

function usePresence(appId: string, conversationId: string | null): AppPresenceViewer[] {
  const [viewers, setViewers] = useState<AppPresenceViewer[]>([]);
  const editing = useContext(EditCtx);
  const meId = useMemo(() => selfUserId(), []);
  useEffect(() => {
    // Presence is for the live operator console, not the edit-mode preview.
    if (editing) return;
    let active = true;
    const beat = () => { void appsApi.presence(appId, conversationId).then((v) => { if (active) setViewers(v); }).catch(() => {}); };
    beat();
    const timer = window.setInterval(beat, PRESENCE_HEARTBEAT_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      void appsApi.leavePresence(appId).catch(() => {});
    };
  }, [appId, conversationId, editing]);
  const onUpdate = useCallback((env: RealtimeEnvelope) => {
    const payload = env.payload as AppPresenceUpdate | undefined;
    if (!payload || payload.appId !== appId) return;
    setViewers(payload.viewers ?? []);
  }, [appId]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.APP_PRESENCE_UPDATED], []), onUpdate);
  // Filter self out so the row reads "who ELSE is here".
  return viewers.filter((v) => v.userId !== meId);
}

/** The resident agent's live state for one thread (thinking/typing), or null when idle. */
function useAgentActivity(appId: string, conversationId: string | null): AppAgentActivity['state'] | null {
  const [state, setState] = useState<AppAgentActivity['state'] | null>(null);
  useEffect(() => { setState(null); }, [conversationId]);
  const onActivity = useCallback((env: RealtimeEnvelope) => {
    const payload = env.payload as AppAgentActivity | undefined;
    if (!payload || payload.appId !== appId || !conversationId || payload.conversationId !== conversationId) return;
    setState(payload.state === 'idle' ? null : payload.state);
  }, [appId, conversationId]);
  useRealtime(useMemo(() => [REALTIME_EVENTS.APP_AGENT_ACTIVITY], []), onActivity);
  return state;
}

/** A subtle "N viewing" row — calm co-presence, not a dashboard. */
function PresenceRow({ viewers }: { viewers: AppPresenceViewer[] }) {
  if (viewers.length === 0) return null;
  const label = viewers.length === 1
    ? `${viewers[0]!.name} is also viewing`
    : `${viewers.length} others viewing`;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-text-muted" title={viewers.map((v) => v.name).join(', ')}>
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="truncate">{label}</span>
    </div>
  );
}

/** A calm "agent is thinking/typing…" line, shown only while a turn runs. */
function AgentActivityLine({ state }: { state: AppAgentActivity['state'] | null }) {
  if (!state) return null;
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] italic text-accent">
      <Loader2 size={11} className="animate-spin" />
      <span>{state === 'thinking' ? 'Agent is thinking…' : 'Agent is typing…'}</span>
    </div>
  );
}

function LiveChatThread({ node }: { node: Extract<ViewNode, { type: 'ChatThread' }> }) {
  const { appId } = useRuntime();
  const { rows } = useLiveConversations(appId);
  const convId = rows[0]?.id ?? null;
  const { messages, loading } = useLiveMessages(appId, convId);
  const presence = usePresence(appId, convId);
  const activity = useAgentActivity(appId, convId);
  if (loading && !convId) return <SkeletonRows />;
  const msgs: ChatMsg[] = messages.map((m) => ({ role: m.role === 'user' ? 'user' : m.role, content: m.content, ...(m.at ? { at: m.at } : {}) }));
  return (
    <div className="flex flex-col gap-1">
      {presence.length > 0 ? <div className="px-1"><PresenceRow viewers={presence} /></div> : null}
      <ChatShell title={node.title ?? rows[0]?.title} channel={node.channel ?? rows[0]?.channel ?? undefined} messages={msgs} placeholder={node.placeholder} />
      <AgentActivityLine state={activity} />
    </div>
  );
}

function LiveInbox({ node }: { node: Extract<ViewNode, { type: 'Inbox' }> }) {
  const { appId } = useRuntime();
  const { rows, loading, reload } = useLiveConversations(appId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selId = selectedId ?? rows[0]?.id ?? null;
  const selConv = rows.find((r) => r.id === selId) ?? null;
  const driving = selConv?.handoffState === 'human';
  const { messages, loading: msgLoading } = useLiveMessages(appId, selId);
  const presence = usePresence(appId, selId);
  const activity = useAgentActivity(appId, selId);
  const [busy, setBusy] = useState(false);
  const editing = useContext(EditCtx);

  const toggleTakeover = useCallback(async () => {
    if (!selId || editing) return;
    setBusy(true);
    try { await appsApi.takeoverConversation(appId, selId, !driving); await reload(); } finally { setBusy(false); }
  }, [appId, selId, driving, editing, reload]);

  const sendOperator = useCallback(async (text: string) => {
    if (!selId || editing) return;
    await appsApi.sendToConversation(appId, selId, text);
  }, [appId, selId, editing]);
  return (
    <div className="flex min-h-[340px] overflow-hidden rounded-card border border-line bg-surface">
      <div className="w-56 shrink-0 overflow-auto border-r border-line">
        {loading ? (
          <div className="p-3"><SkeletonRows /></div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-[12px] text-text-muted">No live conversations yet. Connect a channel to this app.</div>
        ) : rows.map((row) => {
          const active = row.id === selId;
          return (
            <button
              key={row.id}
              type="button"
              onClick={(event) => { event.stopPropagation(); setSelectedId(row.id); }}
              className={clsx('flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left', active ? 'bg-accent-soft' : 'hover:bg-surface-2')}
            >
              <div className="flex items-center gap-2">
                {row.needsAttention ? (
                  <span className="shrink-0 text-warn" title={row.needsAttentionReason ?? 'Needs you'}>◆</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{row.title}</span>
                {row.channel ? <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] capitalize text-text-muted">{row.channel}</span> : null}
                {row.unread > 0 ? <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-on-accent">{row.unread}</span> : null}
              </div>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1">
        {selId ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{selConv?.title ?? 'Conversation'}</span>
              {presence.length > 0 ? <PresenceRow viewers={presence} /> : null}
              {driving ? <span className="shrink-0 rounded-full bg-warn/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warn">You're driving</span> : null}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void toggleTakeover(); }}
                disabled={busy || Boolean(editing)}
                className={clsx('inline-flex h-6 shrink-0 items-center gap-1 rounded-btn border px-2 text-[11px] font-medium transition-colors disabled:opacity-50',
                  driving ? 'border-line text-text-secondary hover:bg-surface-2' : 'border-accent/40 text-accent hover:bg-accent-soft')}
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : null}
                {driving ? 'Hand back' : 'Take over'}
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
              {msgLoading ? <SkeletonRows /> : messages.length === 0 ? <div className="m-auto text-[12px] text-text-muted">No messages</div> : messages.map((m) => (
                <ChatBubble key={m.id} role={m.role} content={m.content} />
              ))}
            </div>
            <AgentActivityLine state={activity} />
            {driving ? <Composer label="Send" onSend={sendOperator} /> : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-text-muted">Select a conversation.</div>
        )}
      </div>
    </div>
  );
}

function ChatThreadView({ node }: { node: Extract<ViewNode, { type: 'ChatThread' }> }) {
  if (node.source === 'conversations') return <LiveChatThread node={node} />;
  if (node.bind) return <BoundChatThread node={node} bind={node.bind} />;
  const messages: ChatMsg[] = (node.messages ?? []).map((m) => ({ role: m.role, content: m.content, ...(m.at ? { at: m.at } : {}) }));
  return <ChatShell title={node.title} channel={node.channel} messages={messages} send={node.send} placeholder={node.placeholder} />;
}

function BoundChatThread({ node, bind }: { node: Extract<ViewNode, { type: 'ChatThread' }>; bind: DataBind }) {
  const { rows, loading } = useBoundRows(bind);
  if (loading) return <SkeletonRows />;
  const messages: ChatMsg[] = rows.map((r) => ({
    role: String(r[node.roleField ?? 'role'] ?? 'agent'),
    content: String(r[node.contentField ?? 'content'] ?? r.text ?? r.message ?? ''),
    ...(node.atField && r[node.atField] != null ? { at: String(r[node.atField]) } : {}),
  }));
  return <ChatShell title={node.title} channel={node.channel} messages={messages} send={node.send} placeholder={node.placeholder} />;
}

function InboxView({ node }: { node: Extract<ViewNode, { type: 'Inbox' }> }) {
  if (node.source === 'conversations') return <LiveInbox node={node} />;
  return <CollectionInbox node={node} bind={node.bind} />;
}

function CollectionInbox({ node, bind }: { node: Extract<ViewNode, { type: 'Inbox' }>; bind?: DataBind }) {
  const { rows, loading } = useBoundRows(bind ?? { collection: '', live: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const firstId = rows[0]?.id != null ? String(rows[0].id) : null;
  const selId = selectedId ?? firstId;
  if (!bind) return <div className="rounded-card border border-dashed border-line p-6 text-center text-[12px] text-text-muted">Bind a collection, or set source:&quot;conversations&quot; for the live inbox.</div>;
  return (
    <div className="flex min-h-[340px] overflow-hidden rounded-card border border-line bg-surface">
      <div className="w-56 shrink-0 overflow-auto border-r border-line">
        {loading ? (
          <div className="p-3"><SkeletonRows /></div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-[12px] text-text-muted">No conversations</div>
        ) : rows.map((row, i) => {
          const id = row.id != null ? String(row.id) : String(i);
          const active = id === selId;
          const channel = node.channelField ? row[node.channelField] : undefined;
          return (
            <button
              key={id}
              type="button"
              onClick={(event) => { event.stopPropagation(); setSelectedId(id); }}
              className={clsx('flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left', active ? 'bg-accent-soft' : 'hover:bg-surface-2')}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{String(row[node.titleField ?? 'title'] ?? row.name ?? 'Conversation')}</span>
                {channel != null ? <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[9px] capitalize text-text-muted">{String(channel)}</span> : null}
              </div>
              {node.subtitleField ? <span className="truncate text-[11px] text-text-muted">{String(row[node.subtitleField] ?? '')}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1">
        {node.messagesBind && selId ? (
          <InboxThread bind={node.messagesBind} convId={selId} matchField={node.matchField ?? 'conversationId'} roleField={node.messageRoleField} contentField={node.messageContentField} send={node.send} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-text-muted">{selId ? 'Bind a messages collection to show this thread.' : 'Select a conversation.'}</div>
        )}
      </div>
    </div>
  );
}

function InboxThread({ bind, convId, matchField, roleField, contentField, send }: { bind: DataBind; convId: string; matchField: string; roleField?: string; contentField?: string; send?: ActionRef }) {
  const invoke = useActionInvoker();
  const resolvedScope = useResolvedScope();
  const filtered: DataBind = { ...bind, query: { ...(bind.query ?? {}), [matchField]: convId } };
  const { rows, loading } = useBoundRows(filtered);
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
        {loading ? <SkeletonRows /> : rows.length === 0 ? <div className="m-auto text-[12px] text-text-muted">No messages</div> : rows.map((r, i) => (
          <ChatBubble key={i} role={String(r[roleField ?? 'role'] ?? 'agent')} content={String(r[contentField ?? 'content'] ?? r.text ?? r.message ?? '')} />
        ))}
      </div>
      {send ? (
        <Composer label="Send" onSend={(text) => invoke(send.action, { conversationId: convId, content: text, ...resolveArgs(send.args, resolvedScope) })} />
      ) : null}
    </div>
  );
}

function MediaGenView({ node, scope }: { node: Extract<ViewNode, { type: 'MediaGen' }>; scope: ResolveScope }) {
  const invoke = useActionInvoker();
  const editing = useContext(EditCtx);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const generate = node.generate;
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <ImageIcon size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-text-primary">{node.title ?? 'Media generator'}</span>
      </div>
      {generate ? (
        <form
          className="mb-3 flex items-center gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = prompt.trim();
            if (!value || busy || editing) return;
            setBusy(true);
            try { await invoke(generate.action, { prompt: value, ...resolveArgs(generate.args, scope) }); setPrompt(''); } finally { setBusy(false); }
          }}
        >
          <input value={prompt} onChange={(event) => setPrompt(event.target.value)} onClick={(event) => event.stopPropagation()} placeholder={node.placeholder ?? 'Describe what to generate…'} disabled={Boolean(editing)} className="h-9 flex-1 rounded-btn border border-line bg-canvas px-3 text-[13px] text-text-primary outline-none focus:border-accent disabled:opacity-60" />
          <button type="submit" disabled={Boolean(editing) || !prompt.trim() || busy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-on-accent disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ImageIcon size={13} />} Generate
          </button>
        </form>
      ) : null}
      {node.bind ? <MediaGenGallery node={node} bind={node.bind} /> : <div className="rounded-btn border border-dashed border-line p-6 text-center text-[12px] text-text-muted">Generated media appears here.</div>}
    </div>
  );
}

function MediaGenGallery({ node, bind }: { node: Extract<ViewNode, { type: 'MediaGen' }>; bind: DataBind }) {
  const { rows, loading } = useBoundRows(bind);
  if (loading) return <SkeletonRows />;
  if (rows.length === 0) return <div className="rounded-btn border border-dashed border-line p-6 text-center text-[12px] text-text-muted">No media yet — generate something above.</div>;
  return (
    <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3">
      {rows.map((row, i) => {
        const src = String(row[node.srcField ?? 'url'] ?? row.src ?? row.image ?? '');
        return (
          <figure key={i} className="overflow-hidden rounded-card border border-line bg-canvas">
            <img src={src} alt="" className="aspect-square w-full object-cover" />
            {node.captionField && row[node.captionField] != null ? <figcaption className="truncate px-2 py-1 text-[10px] text-text-muted">{String(row[node.captionField])}</figcaption> : null}
          </figure>
        );
      })}
    </div>
  );
}

interface FunnelStage { label: string; value: number }

function FunnelShell({ title, stages }: { title?: string; stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      {title ? <div className="mb-2 text-[12px] font-semibold text-text-primary">{title}</div> : null}
      <div className="flex flex-col gap-1.5">
        {stages.length === 0 ? <div className="text-[12px] text-text-muted">No stages</div> : stages.map((stage, i) => {
          const prev = stages[i - 1];
          const conv = i > 0 && prev && prev.value > 0 ? Math.round((stage.value / prev.value) * 100) : null;
          return (
            <div key={i}>
              <div className="mb-0.5 flex items-center justify-between text-[11px]">
                <span className="text-text-secondary">{stage.label}</span>
                <span className="tabular-nums text-text-muted">{stage.value.toLocaleString()}{conv != null ? ` · ${conv}%` : ''}</span>
              </div>
              <div className="mx-auto h-6 rounded-btn bg-accent" style={{ width: `${Math.max(8, (stage.value / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FunnelView({ node }: { node: Extract<ViewNode, { type: 'Funnel' }> }) {
  if (node.bind) return <BoundFunnel node={node} bind={node.bind} />;
  return <FunnelShell title={node.title} stages={node.stages ?? []} />;
}

function BoundFunnel({ node, bind }: { node: Extract<ViewNode, { type: 'Funnel' }>; bind: DataBind }) {
  const { rows, loading } = useBoundRows(bind);
  if (loading) return <SkeletonRows />;
  const stages: FunnelStage[] = rows.map((r) => ({ label: String(r[node.labelField ?? 'label'] ?? r.name ?? ''), value: Number(r[node.valueField ?? 'value']) || 0 }));
  return <FunnelShell title={node.title} stages={stages} />;
}

interface CalEvent { date: string; label: string }

function CalendarShell({ title, events }: { title?: string; events: CalEvent[] }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = new Map<number, string[]>();
  for (const event of events) {
    const d = new Date(event.date);
    if (!Number.isNaN(d.getTime()) && d.getMonth() === month && d.getFullYear() === year) {
      const arr = byDay.get(d.getDate()) ?? [];
      arr.push(event.label);
      byDay.set(d.getDate(), arr);
    }
  }
  const cells: Array<number | null> = [];
  for (let i = 0; i < startDay; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <div className="mb-2 text-[12px] font-semibold text-text-primary">{title ?? first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-text-muted">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const labels = d ? byDay.get(d) ?? [] : [];
          return (
            <div key={i} className={clsx('min-h-14 rounded-btn p-1 text-left', d ? 'border border-line bg-canvas' : '')}>
              {d ? (
                <>
                  <div className={clsx('text-[10px]', d === now.getDate() ? 'font-semibold text-accent' : 'text-text-muted')}>{d}</div>
                  {labels.slice(0, 2).map((label, j) => <div key={j} className="mt-0.5 truncate rounded bg-accent-soft px-1 text-[9px] text-accent">{label}</div>)}
                  {labels.length > 2 ? <div className="text-[9px] text-text-muted">+{labels.length - 2}</div> : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarView({ node }: { node: Extract<ViewNode, { type: 'Calendar' }> }) {
  if (node.bind) return <BoundCalendar node={node} bind={node.bind} />;
  return <CalendarShell title={node.title} events={node.events ?? []} />;
}

function BoundCalendar({ node, bind }: { node: Extract<ViewNode, { type: 'Calendar' }>; bind: DataBind }) {
  const { rows, loading } = useBoundRows(bind);
  if (loading) return <SkeletonRows />;
  const events: CalEvent[] = rows.map((r) => ({ date: String(r[node.dateField ?? 'date'] ?? ''), label: String(r[node.labelField ?? 'title'] ?? r.name ?? '') }));
  return <CalendarShell title={node.title} events={events} />;
}

function GaugeView({ node, scope }: { node: Extract<ViewNode, { type: 'Gauge' }>; scope: ResolveScope }) {
  const value = Number(resolveBindable(node.value, scope)) || 0;
  const max = node.max ?? 100;
  const fraction = Math.max(0, Math.min(1, value / (max || 1)));
  const color = accentColor(node.tone && node.tone !== 'neutral' ? node.tone : undefined);
  const R = 52;
  const cx = 64;
  const cy = 60;
  const point = (angle: number) => `${(cx + R * Math.cos(angle)).toFixed(1)} ${(cy - R * Math.sin(angle)).toFixed(1)}`;
  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-surface p-3">
      <svg viewBox="0 0 128 72" className="w-full" style={{ maxWidth: 168 }}>
        <path d={`M ${point(Math.PI)} A ${R} ${R} 0 0 1 ${point(0)}`} fill="none" stroke="var(--color-line)" strokeWidth={10} strokeLinecap="round" />
        <path d={`M ${point(Math.PI)} A ${R} ${R} 0 0 1 ${point(Math.PI * (1 - fraction))}`} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--color-text-primary)">{Math.round(value)}</text>
      </svg>
      {node.label ? <div className="mt-1 text-[11px] text-text-muted">{node.label}</div> : null}
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

/** Compact relative time ("4m ago", "2h ago", "3d ago") for run timestamps. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Workflow Control Plane (Agentic-Apps, Phase E) — the App's OWN workflows with
 * purpose, order, trigger kind, last run, and a run control per row. App-scoped:
 * it reads the current App from the runtime and loads the E0 control-plane endpoint
 * (`GET /apps/:id/workflows`), so an agent drops it in with no binding. This is the
 * control that was missing: an operator can see why each workflow exists, the order
 * they run, their last status, and start one — without leaving the App.
 */
function WorkflowControlBlock({ node }: { node: Extract<ViewNode, { type: 'WorkflowControl' }> }) {
  const { appId, dataRevision } = useRuntime();
  const [rows, setRows] = useState<AppWorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await appsApi.listWorkflows(appId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load workflows');
    }
  }, [appId]);

  useEffect(() => { void load(); }, [load, dataRevision]);

  const run = useCallback(async (wfId: string) => {
    setBusyId(wfId);
    try {
      await appsApi.runAppWorkflow(appId, wfId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the workflow');
    } finally {
      setBusyId(null);
    }
  }, [appId, load]);

  const icon = <Workflow size={15} className="text-text-secondary" />;
  const title = node.title ?? (rows ? `Workflows · ${rows.length}` : 'Workflows');

  if (error) return <PanelShell title={node.title ?? 'Workflows'} icon={icon}><EmptyState label="Couldn't load workflows" hint={error} /></PanelShell>;
  if (rows === null) return <PanelShell title={node.title ?? 'Workflows'} icon={icon}><SkeletonRows /></PanelShell>;
  if (rows.length === 0) return <PanelShell title={title} icon={icon}><EmptyState label="No workflows yet" hint="Add a workflow to give this app logic." /></PanelShell>;

  return (
    <PanelShell title={title} icon={icon}>
      <div className="flex flex-col">
        {rows.map((wf, i) => {
          const status = wf.lastRun?.status;
          const dot = status === 'running' ? 'bg-accent' : status === 'failed' ? 'bg-danger' : wf.enabled === false ? 'bg-text-disabled' : status === 'completed' ? 'bg-success' : 'bg-text-muted';
          return (
            <div key={wf.id} className={clsx('flex items-center gap-3 py-2.5', i > 0 && 'border-t border-line')}>
              <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] text-text-primary">
                  <span className="truncate">{wf.title}</span>
                  {wf.dependsOn.length > 0 ? <span className="shrink-0 rounded border border-line px-1.5 py-px text-[10px] text-text-muted">after {wf.dependsOn.length}</span> : null}
                  {wf.enabled === false ? <span className="shrink-0 rounded border border-line px-1.5 py-px text-[10px] text-text-muted">paused</span> : null}
                </div>
                {wf.purpose ? <div className="truncate text-[11px] text-text-muted">{wf.purpose}</div> : null}
              </div>
              {wf.triggerKind ? <span className="hidden shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary sm:inline">{wf.triggerKind}</span> : null}
              <span className="hidden w-[72px] shrink-0 text-right text-[11px] text-text-muted md:inline">{wf.lastRun ? relativeTime(wf.lastRun.at) : 'never run'}</span>
              <button
                type="button"
                disabled={busyId === wf.id}
                onClick={() => void run(wf.id)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-btn border border-line text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                aria-label={`Run ${wf.title}`}
              >
                {busyId === wf.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              </button>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
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

// ── Built-in block registry ──────────────────────────────────
// Every ViewNode kind registers its renderer here. This replaces the former
// 52-case `switch` with an OPEN seam (see ./blocks/registry): the same
// `registerBlock` API is public, so an agent/plugin/workspace can add or override
// a block kind. Layout primitives recurse via `ctx.renderChild`; everything else
// delegates to its existing view component (unchanged), so no surface drifts.
//
// Each renderer narrows `node` with a control-flow check on `node.type` — the
// registry already guarantees the kind, but `ViewNode` is `Base & { style? }` (an
// intersection) so `Extract<ViewNode, …>` can't narrow it; CFA is the reliable seam.

/** Visible fallback for an unregistered kind — never silently render nothing. */
function UnknownBlock({ node }: { node: ViewNode }) {
  return (
    <div className="rounded border border-dashed border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted">
      Unknown block: <span className="font-medium text-text-secondary">{node.type}</span>
    </div>
  );
}

/** Layout gap from the design language's `--s-gap`, with the numeric baseline used
 *  only for the Grid min-cell math. Mirrors the former inline computation exactly. */
function gapsFor(theme: ResolvedTheme, node: ViewNode): { layout: string | number; child: string; base: number } {
  const base = theme.density === 'compact' ? 8 : 12;
  const explicit = 'gap' in node && (node as { gap?: number | null }).gap != null ? (node as { gap?: number }).gap! : null;
  const v = `var(--s-gap, ${base}px)`;
  return { base, layout: explicit ?? v, child: v };
}

// Layout primitives — recurse through ctx.renderChild.
registerBlock('Stack', (node, ctx) => {
  if (node.type !== 'Stack') return null;
  const { layout } = gapsFor(ctx.theme, node);
  return (
    <div className={clsx('flex flex-col', containerClasses(node.style, ctx.theme.density))} style={{ gap: layout }}>
      {node.children.map((c, i) => ctx.renderChild(c, [...ctx.path, i], ctx.scope))}
    </div>
  );
});

registerBlock('Row', (node, ctx) => {
  if (node.type !== 'Row') return null;
  const { layout } = gapsFor(ctx.theme, node);
  return (
    <div className={clsx('flex flex-wrap', !node.style?.align && 'items-stretch', containerClasses(node.style, ctx.theme.density))} style={{ gap: layout }}>
      {node.children.map((c, i) => (
        <div key={i} className="min-w-[160px]" style={{ flex: `${node.widths?.[i] ?? 1} 1 0` }}>
          {ctx.renderChild(c, [...ctx.path, i], ctx.scope)}
        </div>
      ))}
    </div>
  );
});

registerBlock('Grid', (node, ctx) => {
  if (node.type !== 'Grid') return null;
  const { layout, base } = gapsFor(ctx.theme, node);
  const cols = node.columns;
  // Intrinsically responsive: auto-fit tracks the grid's CONTAINER width (editor
  // panel, Split pane, …) not the viewport, so it never overflows. With explicit
  // `columns`, size the min cell so the surface's full width yields ~that many
  // columns, collapsing to fewer as the container narrows. `min(100%, …)` guards
  // against containers narrower than one cell (→ single column, no overflow).
  const minCell = cols
    ? Math.max(160, Math.floor((ctx.theme.contentWidth - base * (cols - 1)) / cols))
    : 240;
  return (
    <div
      className={clsx('grid', containerClasses(node.style, ctx.theme.density))}
      style={{ gap: layout, gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minCell}px), 1fr))` }}
    >
      {node.children.map((c, i) => {
        const span = c.style?.span ? Math.min(c.style.span, cols ?? 12) : undefined;
        return (
          <div key={i} style={span ? { gridColumn: `span ${span}` } : undefined}>
            {ctx.renderChild(c, [...ctx.path, i], ctx.scope)}
          </div>
        );
      })}
    </div>
  );
});

registerBlock('Card', (node, ctx) => {
  if (node.type !== 'Card') return null;
  // Nested cards flatten — a box inside a box renders borderless (no triple frames).
  const { child } = gapsFor(ctx.theme, node);
  const elevation = node.style?.elevation ?? (ctx.boxed ? 'flat' : 'raised');
  const isBox = elevation !== 'flat';
  return (
    <div className={containerClasses({ ...node.style, elevation }, ctx.theme.density, { defaultPad: isBox ? 'md' : 'none' })}>
      {node.title ? <div className="mb-3 text-[13px] font-semibold text-text-primary">{node.title}</div> : null}
      <BoxedCtx.Provider value={ctx.boxed || isBox}>
        <div className="flex flex-col" style={{ gap: child }}>
          {node.children.map((c, i) => ctx.renderChild(c, [...ctx.path, i], ctx.scope))}
        </div>
      </BoxedCtx.Provider>
    </div>
  );
});

registerBlock('Section', (node, ctx) => {
  if (node.type !== 'Section') return null;
  const { child } = gapsFor(ctx.theme, node);
  const sectionBoxed = (node.style?.elevation ?? 'flat') !== 'flat';
  return (
    <section className={containerClasses(node.style, ctx.theme.density, { defaultElevation: 'flat', defaultPad: sectionBoxed ? 'md' : 'none' })}>
      {node.title ? <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{node.title}</div> : null}
      <BoxedCtx.Provider value={ctx.boxed || sectionBoxed}>
        <div className="flex flex-col" style={{ gap: child }}>
          {node.children.map((c, i) => ctx.renderChild(c, [...ctx.path, i], ctx.scope))}
        </div>
      </BoxedCtx.Provider>
    </section>
  );
});

// Text leaves — bind through resolveDisplay so an unresolved binding shows a marker.
registerBlock('Heading', (node, ctx) => {
  if (node.type !== 'Heading') return null;
  const { text, unbound } = resolveDisplay(node.value, ctx.resolvedScope);
  return <h2 className={clsx('text-[15px] font-semibold text-text-primary', textClasses(node.style))}>{unbound ? <UnboundMarker path={unbound} /> : text}</h2>;
});
registerBlock('Text', (node, ctx) => {
  if (node.type !== 'Text') return null;
  const { text, unbound } = resolveDisplay(node.value, ctx.resolvedScope);
  return <p className={clsx('text-[13px] leading-relaxed text-text-secondary', textClasses(node.style))}>{unbound ? <UnboundMarker path={unbound} /> : text}</p>;
});
registerBlock('Markdown', (node, ctx) => {
  if (node.type !== 'Markdown') return null;
  const { text, unbound } = resolveDisplay(node.value, ctx.resolvedScope);
  return <p className={clsx('whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary', textClasses(node.style))}>{unbound ? <UnboundMarker path={unbound} /> : text}</p>;
});
registerBlock('Badge', (node, ctx) => {
  if (node.type !== 'Badge') return null;
  const { text, unbound } = resolveDisplay(node.value, ctx.resolvedScope);
  return <span className={clsx('inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px]', toneSoftClass(node.tone ?? node.style?.tone))}>{unbound ? <UnboundMarker path={unbound} /> : text}</span>;
});
registerBlock('Divider', () => <hr className="border-line" />);
registerBlock('Image', (node, ctx) => (node.type === 'Image'
  ? <img src={String(resolveBindable(node.src, ctx.resolvedScope) ?? '')} alt={node.alt ?? ''} className="max-h-72 w-full rounded-card border border-line bg-canvas object-contain" />
  : null));

// Resolved-scope blocks.
registerBlock('Metric', (node, ctx) => (node.type === 'Metric' ? <MetricView node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('Callout', (node) => (node.type === 'Callout' ? <CalloutView node={node} /> : null));
registerBlock('Avatar', (node, ctx) => (node.type === 'Avatar' ? <AvatarView node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('ProgressBar', (node, ctx) => (node.type === 'ProgressBar' ? <ProgressBarView node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('Sparkline', (node) => (node.type === 'Sparkline' ? <SparklineView node={node} /> : null));
registerBlock('KPIStrip', (node, ctx) => (node.type === 'KPIStrip' ? <KpiStripView node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('MapView', (node, ctx) => (node.type === 'MapView' ? <MapViewBlock node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('StatusBoard', (node, ctx) => (node.type === 'StatusBoard' ? <StatusBoardBlock node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('MediaGallery', (node, ctx) => (node.type === 'MediaGallery' ? <MediaGalleryBlock node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('MediaGen', (node, ctx) => (node.type === 'MediaGen' ? <MediaGenView node={node} scope={ctx.resolvedScope} /> : null));
registerBlock('Gauge', (node, ctx) => (node.type === 'Gauge' ? <GaugeView node={node} scope={ctx.resolvedScope} /> : null));

// Raw-scope + path blocks (containers/interactive that recurse internally).
registerBlock('Hero', (node, ctx) => (node.type === 'Hero' ? <HeroView node={node} scope={ctx.scope} /> : null));
registerBlock('Toolbar', (node, ctx) => (node.type === 'Toolbar' ? <ToolbarView node={node} scope={ctx.scope} path={ctx.path} /> : null));
registerBlock('Tabs', (node, ctx) => (node.type === 'Tabs' ? <TabsView node={node} scope={ctx.scope} path={ctx.path} /> : null));
registerBlock('Accordion', (node, ctx) => (node.type === 'Accordion' ? <AccordionView node={node} scope={ctx.scope} path={ctx.path} /> : null));
registerBlock('Split', (node, ctx) => (node.type === 'Split' ? <SplitView node={node} scope={ctx.scope} path={ctx.path} /> : null));
registerBlock('AgentRegion', (node, ctx) => (node.type === 'AgentRegion' ? <AgentRegionView node={node} scope={ctx.scope} path={ctx.path} /> : null));
registerBlock('Button', (node, ctx) => (node.type === 'Button'
  ? <ActionButton label={node.label} action={node.action.action} args={node.action.args} scope={ctx.scope} variant={node.variant} />
  : null));

// Self-contained blocks (data binding + state handled internally).
registerBlock('Timeline', (node) => (node.type === 'Timeline' ? <TimelineView node={node} /> : null));
registerBlock('Table', (node) => (node.type === 'Table' ? <BoundTable node={node} /> : null));
registerBlock('List', (node) => (node.type === 'List' ? <BoundList node={node} /> : null));
registerBlock('Chart', (node) => (node.type === 'Chart' ? <BoundChart node={node} /> : null));
registerBlock('Form', (node) => (node.type === 'Form' ? <ActionForm node={node} /> : null));
registerBlock('ActivityStream', (node) => (node.type === 'ActivityStream' ? <ActivityStreamView node={node} /> : null));
registerBlock('DataBoard', (node) => (node.type === 'DataBoard' ? <BoundBoard node={node} /> : null));
registerBlock('DocumentViewer', (node) => (node.type === 'DocumentViewer' ? <DocumentViewerBlock node={node} /> : null));
registerBlock('WebEmbed', (node) => (node.type === 'WebEmbed' ? <WebEmbedBlock node={node} /> : null));
registerBlock('Narrative', (node) => (node.type === 'Narrative' ? <NarrativeBlock node={node} /> : null));
registerBlock('ConversationThread', (node) => (node.type === 'ConversationThread' ? <ConversationThreadBlock node={node} /> : null));
registerBlock('CodeViewer', (node) => (node.type === 'CodeViewer' ? <CodeViewerBlock node={node} /> : null));
registerBlock('ChatThread', (node) => (node.type === 'ChatThread' ? <ChatThreadView node={node} /> : null));
registerBlock('Inbox', (node) => (node.type === 'Inbox' ? <InboxView node={node} /> : null));
registerBlock('Funnel', (node) => (node.type === 'Funnel' ? <FunnelView node={node} /> : null));
registerBlock('Calendar', (node) => (node.type === 'Calendar' ? <CalendarView node={node} /> : null));
registerBlock('WorkflowControl', (node) => (node.type === 'WorkflowControl' ? <WorkflowControlBlock node={node} /> : null));
registerBlock('CustomView', (node) => (node.type === 'CustomView' ? <CustomViewFrame node={node} /> : null));
registerBlock('CodeSurface', (node) => (node.type === 'CodeSurface' ? <CodeSurfaceFrame node={node} /> : null));
