/**
 * Archetype composite blocks (APP-INTERFACE-10X §2.4) — the interactive
 * workhorses that make an App Interface fit any operation, registered on the
 * open block seam:
 *
 *   Kanban       — a REAL board: drag a card across columns to write the
 *                  groupBy field back through the declared `update` data action.
 *   RecordMaster — CRM/ERP master-detail: searchable list + record page with
 *                  field sections, related child collections, record actions.
 *   Roadmap      — time lanes from date fields (roadmaps, releases, campaigns).
 *   PipelineFlow — staged funnel with counts/values + stage conversion.
 *
 * All bind through the SAME datastore path as Table/List/Chart (useBoundRows →
 * client.data.query, live on DATA_CHANGED); writes go through declared surface
 * actions only — the blocks never invent a data path.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Archive, Check, ChevronRight, Columns3, Edit3, ExternalLink, GanttChartSquare, MoreHorizontal, MoveRight, Pause, Play, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { RecordActionRef, RecordCondition, RecordPredicate, Tone, ViewNode } from '@agentis/core';
import { registerBlock } from './registry';
import { EmptyState, PanelShell, SkeletonRows, resolveActionArgs, useActionInvoker, useBoundRows, useRuntime } from '../ViewRenderer';
import { toneFillClass, toneFromStatus, toneSoftClass } from '../styleIntent';
import { seriesColor } from '../theme';
import { displayLabel, isIdLike } from '../../../lib/prettyRef';

type Row = Record<string, unknown>;

function rowId(row: Row): string {
  return String(row.id ?? '');
}

function fieldText(row: Row, key: string | undefined, fallbacks: string[] = []): string {
  for (const k of [key, ...fallbacks]) {
    if (!k) continue;
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/**
 * Common human-name field slugs an agent might use for a record's display name,
 * beyond the generic title/name. Kept broad on purpose — a board card should
 * show the store/brand/person, not a `#id`, regardless of the exact column name.
 */
const NAME_FALLBACK_FIELDS = [
  'title', 'name', 'subject', 'label', 'display_name', 'displayName',
  'full_name', 'fullName', 'brand_name', 'brandName', 'store_name', 'storeName',
  'company_name', 'companyName', 'brand', 'store', 'company', 'headline', 'summary',
];

/** A field is name-ish if its key reads like a human label rather than an id/meta field. */
const NAME_KEY_RE = /(^|_)(title|name|label|subject|brand|store|company|headline|display|full)($|_)/i;

/**
 * Last-resort title: scan the row for the first readable string value — one whose
 * key looks like a name and whose value isn't id-like/overly long — so a card
 * shows something meaningful even when no declared title field matches. Skips the
 * grouping/stage field so a Kanban card doesn't just echo its own column.
 */
function scanForTitle(row: Row, skipKeys: Array<string | undefined>): string {
  const skip = new Set(skipKeys.filter(Boolean).map((k) => String(k).toLowerCase()));
  skip.add('id');
  let firstReadable = '';
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key.toLowerCase())) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (!text || text.length > 80 || isIdLike(text)) continue;
    if (NAME_KEY_RE.test(key)) return text; // strongest signal — a name-ish column
    if (!firstReadable) firstReadable = text; // remember the first plausible value
  }
  return firstReadable;
}

/**
 * The card title for a record — the chosen field (plus a broad fallback list),
 * unless it is empty or is itself an identifier (agents sometimes store a UUID as
 * the name). Falls back to scanning the row for a readable name-ish field, and
 * only then to a clean `#ref`. Never renders a raw UUID.
 */
function recordTitle(row: Row, key: string | undefined, fallbacks: string[], empty: string, skipKeys: Array<string | undefined> = []): string {
  const direct = fieldText(row, key, [...fallbacks, ...NAME_FALLBACK_FIELDS]);
  if (direct && !isIdLike(direct)) return direct;
  const scanned = scanForTitle(row, [key, ...fallbacks, ...skipKeys]);
  if (scanned) return scanned;
  return displayLabel(direct, rowId(row), empty);
}

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ── Kanban ────────────────────────────────────────────────────

const DRAG_MIME = 'application/agentis-kanban-card';

function valueAt(source: Row, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((value, key) => (
    value != null && typeof value === 'object' ? (value as Row)[key] : undefined
  ), source);
}

function conditionValue(value: unknown, row: Row, state: Row): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const bind = value as { $row?: string; $bind?: string; $state?: string };
  if (bind.$row) return valueAt(row, bind.$row);
  if (bind.$bind) return valueAt(row, bind.$bind);
  if (bind.$state) return valueAt(state, bind.$state);
  return value;
}

function matchesCondition(condition: RecordCondition, row: Row, state: Row): boolean {
  const actual = valueAt(row, condition.field);
  const expected = conditionValue(condition.value, row, state);
  const list = Array.isArray(expected) ? expected : [expected];
  switch (condition.op) {
    case 'neq': return actual !== expected;
    case 'in': return list.includes(actual);
    case 'not_in': return !list.includes(actual);
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected ?? ''));
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'eq':
    default: return actual === expected;
  }
}

function matchesPredicate(predicate: RecordPredicate | undefined, row: Row, state: Row): boolean {
  if (!predicate) return true;
  const all = predicate.all?.every((condition) => matchesCondition(condition, row, state)) ?? true;
  const any = predicate.any?.some((condition) => matchesCondition(condition, row, state)) ?? true;
  return all && any;
}

function visibleRecordActions(actions: RecordActionRef[] | undefined, row: Row, state: Row): RecordActionRef[] {
  return (actions ?? []).filter((action) => matchesPredicate(action.visibleWhen, row, state));
}

function actionIcon(action: RecordActionRef) {
  const props = { size: 14, strokeWidth: 1.8 };
  switch (action.icon) {
    case 'open': return <ExternalLink {...props} />;
    case 'edit': return <Edit3 {...props} />;
    case 'move': return <MoveRight {...props} />;
    case 'play': return <Play {...props} />;
    case 'pause': return <Pause {...props} />;
    case 'retry': return <RotateCcw {...props} />;
    case 'approve': return <Check {...props} />;
    case 'archive': return <Archive {...props} />;
    case 'delete': return <Trash2 {...props} />;
    default: return <MoreHorizontal {...props} />;
  }
}

function actionLabel(action: RecordActionRef): string {
  return action.label ?? humanize(action.action);
}

async function confirmRecordAction(action: RecordActionRef): Promise<boolean> {
  if (!action.confirm) return true;
  return window.confirm(`${action.confirm.title}\n\n${action.confirm.message}`);
}

interface RecordMenuState { row: Row; x: number; y: number }

function RecordContextMenu({ menu, actions, state, busy, onRun, onClose }: {
  menu: RecordMenuState;
  actions: RecordActionRef[];
  state: Row;
  busy: string | null;
  onRun: (action: RecordActionRef, row: Row) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [onClose]);
  const visible = visibleRecordActions(actions, menu.row, state);
  const left = Math.min(menu.x, window.innerWidth - 248);
  const top = Math.min(menu.y, window.innerHeight - Math.max(72, visible.length * 48 + 16));
  return (
    <div
      role="menu"
      aria-label="Record actions"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      className="fixed z-50 w-60 overflow-hidden rounded-card border border-line bg-surface p-1.5 shadow-floating"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {visible.length === 0 ? <div className="px-2.5 py-3 text-[12px] text-text-muted">No actions are available in this state.</div> : visible.map((action) => {
        const disabled = matchesPredicate(action.disabledWhen, menu.row, state);
        return (
          <button
            key={action.action}
            type="button"
            role="menuitem"
            disabled={disabled || busy === action.action}
            title={disabled ? action.disabledReason : action.description}
            onClick={() => onRun(action, menu.row)}
            className={clsx(
              'flex w-full items-start gap-2.5 rounded-btn px-2.5 py-2 text-left transition-colors',
              action.tone === 'danger' ? 'text-danger hover:bg-danger/10' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
              'disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            <span className="mt-0.5 shrink-0">{actionIcon(action)}</span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium">{actionLabel(action)}</span>
              {action.description || (disabled && action.disabledReason) ? <span className="mt-0.5 block text-[10.5px] leading-snug text-text-muted">{disabled ? action.disabledReason : action.description}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function KanbanView({ node }: { node: Extract<ViewNode, { type: 'Kanban' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  const invoke = useActionInvoker();
  // Optimistic column overrides: recordId → column, cleared when fresh rows arrive.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<Row | null>(null);
  const [menu, setMenu] = useState<RecordMenuState | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { uiState } = useRuntime();
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; setOverrides({}); }, [rows]);

  if (loading) return <SkeletonRows />;

  const columnOf = (row: Row): string => overrides[rowId(row)] ?? String(row[node.groupBy] ?? 'Unassigned');
  const order: string[] = [...(node.columns ?? [])];
  for (const row of rows) {
    const key = columnOf(row);
    if (!order.includes(key)) order.push(key);
  }
  if (order.length === 0) order.push('Unassigned');
  const byColumn = new Map<string, Row[]>(order.map((k) => [k, []]));
  for (const row of rows) byColumn.get(columnOf(row))?.push(row);

  const draggable = Boolean(node.update);
  const canMove = (row: Row, to: string): boolean => {
    const from = columnOf(row);
    if (from === to) return false;
    if (!node.transitions?.length) return true;
    return node.transitions.some((transition) => (
      (!transition.from || transition.from.includes(from))
      && transition.to.includes(to)
      && matchesPredicate(transition.when, row, uiState)
    ));
  };
  const moveCard = async (id: string, to: string) => {
    if (!node.update || !id) return;
    const current = rowsRef.current.find((r) => rowId(r) === id);
    if (!current || !canMove(current, to)) return;
    setOverrides((prev) => ({ ...prev, [id]: to }));
    try {
      await invoke(node.update.action, { ...resolveActionArgs(node.update.args, { row: current, state: uiState }), id, patch: { [node.groupBy]: to } });
    } catch {
      setOverrides((prev) => { const next = { ...prev }; delete next[id]; return next; });
    }
  };
  const runRecordAction = async (action: RecordActionRef, row: Row) => {
    if (matchesPredicate(action.disabledWhen, row, uiState) || !(await confirmRecordAction(action))) return;
    setBusyAction(action.action);
    try {
      await invoke(action.action, { ...resolveActionArgs(action.args, { row, state: uiState }), id: rowId(row) });
      setMenu(null);
    } finally { setBusyAction(null); }
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-1.5">
      {order.map((key, colIndex) => {
        const cards = byColumn.get(key) ?? [];
        const tone = toneFromStatus(key);
        return (
          <div
            key={key}
            className={clsx(
              's-round flex w-[276px] shrink-0 flex-col bg-canvas/40 ring-1 transition-shadow',
              dragOver === key ? 'ring-accent/60 shadow-[0_0_0_1px_var(--color-accent)]' : 'ring-line',
            )}
            onDragOver={(e) => {
              const row = rows.find((candidate) => rowId(candidate) === draggingId);
              if (draggable && row && canMove(row, key)) { e.preventDefault(); setDragOver(key); }
            }}
            onDragLeave={() => setDragOver((cur) => (cur === key ? null : cur))}
            onDrop={(e) => {
              if (!draggable) return;
              e.preventDefault();
              setDragOver(null);
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) void moveCard(id, key);
            }}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', toneFillClass(tone))} />
                <span className="truncate text-[13px] font-semibold capitalize text-text-primary">{node.columnLabels?.[key] ?? humanize(key)}</span>
              </span>
              <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', toneSoftClass(tone))}>{cards.length}</span>
            </div>
            <div className="flex min-h-[48px] flex-1 flex-col gap-2 px-2 pb-2">
              {cards.length === 0 ? (
                <div className={clsx('rounded-btn border border-dashed px-2 py-4 text-center text-[11px] text-text-muted', dragOver === key ? 'border-accent/50 text-accent' : 'border-line/70')}>
                  {dragOver === key ? 'Release to move' : (node.emptyLabel ?? (draggable ? 'Drop records here' : 'No records'))}
                </div>
              ) : cards.map((row) => {
                const id = rowId(row);
                const title = recordTitle(
                  row,
                  node.titleField,
                  ['title', 'name', 'subject', 'label'],
                  'Untitled',
                  [node.groupBy, node.subtitleField, node.badgeField, node.valueField],
                );
                const subtitle = fieldText(row, node.subtitleField);
                const badge = fieldText(row, node.badgeField);
                const value = node.valueField != null ? row[node.valueField] : undefined;
                return (
                  <div
                    key={id || title}
                    role="button"
                    tabIndex={0}
                    draggable={draggable}
                    aria-grabbed={draggingId === id}
                    onDragStart={(e) => { setDraggingId(id); e.dataTransfer.setData(DRAG_MIME, id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                    onClick={() => setOpenCard(row)}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ row, x: e.clientX, y: e.clientY }); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setOpenCard(row);
                      if (e.key === 'F10' && e.shiftKey) {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenu({ row, x: rect.right - 16, y: rect.top + 16 });
                      }
                    }}
                    className={clsx(
                      's-panel s-panel-hover px-3 py-2.5 text-[13px]',
                      draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words font-medium text-text-primary">{title}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {typeof value === 'number' ? <span className="text-[11px] font-semibold tabular-nums text-text-secondary">{value.toLocaleString()}</span> : null}
                        {(node.contextActions?.length || node.cardActions?.length) ? (
                          <button
                            type="button"
                            aria-label={`Actions for ${title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              setMenu({ row, x: rect.right, y: rect.bottom + 4 });
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"
                          ><MoreHorizontal size={14} /></button>
                        ) : null}
                      </span>
                    </div>
                    {subtitle ? <div className="mt-1 line-clamp-2 text-[12px] text-text-muted">{subtitle}</div> : null}
                    {badge ? (
                      <span className={clsx('mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium', toneSoftClass(toneFromStatus(badge)))}>{badge}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {openCard ? (
        <RecordDrawer
          row={openCard}
          title={recordTitle(openCard, node.titleField, ['title', 'name', 'subject', 'label'], 'Record')}
          actions={node.cardActions}
          onClose={() => setOpenCard(null)}
        />
      ) : null}
      {menu ? (
        <RecordContextMenu
          menu={menu}
          actions={node.contextActions ?? node.cardActions ?? []}
          state={uiState}
          busy={busyAction}
          onRun={(action, row) => { void runRecordAction(action, row); }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

/** Slide-over record detail shared by Kanban cards + RecordMaster on narrow screens. */
function RecordDrawer({ row, title, actions, onClose }: { row: Row; title: string; actions?: RecordActionRef[]; onClose: () => void }) {
  const invoke = useActionInvoker();
  const { uiState } = useRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const entries = Object.entries(row).filter(([k]) => k !== 'id');
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-overlay-soft" role="presentation" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-floating"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text-primary">{title}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            {entries.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="s-label">{humanize(k)}</dt>
                <dd className="mt-1 break-words text-[13.5px] text-text-primary">{formatValue(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
        {visibleRecordActions(actions, row, uiState).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-3">
            {visibleRecordActions(actions, row, uiState).map((a) => {
              const disabled = matchesPredicate(a.disabledWhen, row, uiState);
              return (
              <button
                key={a.action}
                type="button"
                disabled={disabled || busy === a.action}
                title={disabled ? a.disabledReason : a.description}
                onClick={async () => {
                  if (!(await confirmRecordAction(a))) return;
                  setBusy(a.action);
                  try { await invoke(a.action, { ...resolveActionArgs(a.args, { row, state: uiState }), id: rowId(row) }); } finally { setBusy(null); }
                }}
                className={clsx('inline-flex h-7 items-center gap-1.5 rounded-btn border px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-50', a.tone === 'danger' ? 'border-danger/30 text-danger hover:bg-danger/10' : 'border-line text-text-secondary hover:bg-surface-2 hover:text-text-primary')}
              >
                {actionIcon(a)} {actionLabel(a)}
              </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── RecordMaster (CRM / ERP master-detail) ────────────────────

function RecordMasterView({ node }: { node: Extract<ViewNode, { type: 'RecordMaster' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const keys = node.searchFields && node.searchFields.length > 0
      ? node.searchFields
      : Object.keys(rows[0] ?? {}).filter((k) => typeof (rows[0] ?? {})[k] === 'string');
    return rows.filter((row) => keys.some((k) => String(row[k] ?? '').toLowerCase().includes(q)));
  }, [rows, search, node.searchFields]);

  const selected = useMemo(
    () => filtered.find((r) => rowId(r) === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  if (loading) return <SkeletonRows />;
  if (rows.length === 0) {
    return <EmptyState label="No records yet" hint="Rows the agent (or a form) adds to this collection appear here as a full record workspace." />;
  }

  return (
    <div className="s-panel flex min-h-[380px] overflow-hidden p-0">
      {/* Master list */}
      <div className="flex w-[272px] shrink-0 flex-col border-r border-line/70">
        <div className="border-b border-line p-2">
          <div className="flex h-8 items-center gap-1.5 rounded-btn border border-line bg-canvas px-2 focus-within:border-accent/50">
            <Search size={13} className="shrink-0 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-text-muted">No matches</div>
          ) : filtered.map((row) => {
            const id = rowId(row);
            const active = selected != null && rowId(selected) === id;
            const title = recordTitle(row, node.titleField, ['name', 'title', 'subject', 'label', 'email'], 'Untitled', [node.subtitleField, node.statusField]);
            const subtitle = fieldText(row, node.subtitleField, ['email', 'company', 'phone']);
            const status = node.statusField ? fieldText(row, node.statusField) : '';
            return (
              <button
                key={id || title}
                type="button"
                onClick={() => setSelectedId(id)}
                className={clsx(
                  'flex w-full flex-col gap-0.5 border-b border-line/60 px-3 py-2.5 text-left transition-colors',
                  active ? 'bg-accent-soft/60' : 'hover:bg-surface-2/70',
                )}
                aria-current={active ? 'true' : undefined}
              >
                <span className="flex items-center gap-2">
                  <span className={clsx('min-w-0 flex-1 truncate text-[13.5px] font-medium', active ? 'text-text-primary' : 'text-text-secondary')}>{title}</span>
                  {status ? <span className={clsx('shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-medium', toneSoftClass(toneFromStatus(status)))}>{status}</span> : null}
                </span>
                {subtitle && subtitle !== title ? <span className="truncate text-[12px] text-text-muted">{subtitle}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="border-t border-line/70 px-3.5 py-2 text-[11px] tabular-nums text-text-muted">{filtered.length} of {rows.length}</div>
      </div>
      {/* Record page */}
      <div className="min-w-0 flex-1 overflow-auto">
        {selected ? <RecordPage node={node} row={selected} /> : <EmptyState label="Select a record" />}
      </div>
    </div>
  );
}

function RecordPage({ node, row }: { node: Extract<ViewNode, { type: 'RecordMaster' }>; row: Row }) {
  const invoke = useActionInvoker();
  const { uiState } = useRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const title = recordTitle(row, node.titleField, ['name', 'title', 'subject', 'label', 'email'], 'Record');
  const status = node.statusField ? fieldText(row, node.statusField) : '';
  const sections = node.sections && node.sections.length > 0
    ? node.sections
    : [{ title: 'Details', fields: Object.keys(row).filter((k) => k !== 'id') }];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">
          {title.split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '·'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold tracking-[-0.01em] text-text-primary">{title}</div>
          {status ? <span className={clsx('mt-0.5 inline-flex rounded-full px-1.5 py-px text-[10px] font-medium', toneSoftClass(toneFromStatus(status)))}>{status}</span> : null}
        </div>
        {visibleRecordActions(node.recordActions, row, uiState).map((a) => {
          const disabled = matchesPredicate(a.disabledWhen, row, uiState);
          return (
          <button
            key={a.action}
            type="button"
            disabled={disabled || busy === a.action}
            title={disabled ? a.disabledReason : a.description}
            onClick={async () => {
              if (!(await confirmRecordAction(a))) return;
              setBusy(a.action);
              try { await invoke(a.action, { ...resolveActionArgs(a.args, { row, state: uiState }), id: rowId(row) }); } finally { setBusy(null); }
            }}
            className={clsx('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-btn border px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-50', a.tone === 'danger' ? 'border-danger/30 text-danger hover:bg-danger/10' : 'border-line text-text-secondary hover:bg-surface-2 hover:text-text-primary')}
          >
            {actionIcon(a)} {actionLabel(a)}
          </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-4 px-4 py-3.5">
        {sections.map((section, i) => (
          <section key={section.title ?? i}>
            {section.title ? <h4 className="s-label mb-2.5">{section.title}</h4> : null}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 @lg:grid-cols-2">
              {section.fields.map((key) => (
                <div key={key} className="min-w-0">
                  <dt className="s-label">{humanize(key)}</dt>
                  <dd className="mt-1 break-words text-[13.5px] text-text-primary">{formatValue(row[key])}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {(node.related ?? []).map((rel) => (
          <RelatedList key={`${rel.collection}:${rel.foreignKey}`} rel={rel} parentId={rowId(row)} />
        ))}
      </div>
    </div>
  );
}

function RelatedList({ rel, parentId }: { rel: { collection: string; foreignKey: string; title?: string; titleField?: string }; parentId: string }) {
  const { client, dataRevision } = useRuntime();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    client.data.query(rel.collection, { filter: { [rel.foreignKey]: parentId }, limit: 25 })
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [client, rel.collection, rel.foreignKey, parentId, dataRevision]);

  return (
    <section>
      <h4 className="s-label mb-2.5 flex items-center gap-2">
        {rel.title ?? humanize(rel.collection)}
        {rows ? <span className="rounded-full bg-surface-2 px-1.5 text-[9.5px] tabular-nums">{rows.length}</span> : null}
      </h4>
      {rows === null ? <SkeletonRows /> : rows.length === 0 ? (
        <div className="rounded-btn border border-dashed border-line px-3 py-3 text-[11px] text-text-muted">No {humanize(rel.collection).toLowerCase()} linked yet</div>
      ) : (
        <ul className="overflow-hidden rounded-btn border border-line">
          {rows.map((r, i) => (
            <li key={rowId(r) || i} className={clsx('flex items-center gap-2 px-3 py-2 text-[12px] text-text-secondary', i > 0 && 'border-t border-line/60')}>
              <ChevronRight size={12} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{recordTitle(r, rel.titleField, ['title', 'name', 'subject', 'label'], '')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Roadmap (time lanes) ──────────────────────────────────────

const DAY_MS = 86_400_000;

function RoadmapView({ node }: { node: Extract<ViewNode, { type: 'Roadmap' }> }) {
  const { rows, loading } = useBoundRows(node.bind);
  if (loading) return <SkeletonRows />;

  const items = rows.flatMap((row) => {
    const start = Date.parse(String(row[node.startField] ?? ''));
    if (Number.isNaN(start)) return [];
    const endRaw = node.endField ? Date.parse(String(row[node.endField] ?? '')) : Number.NaN;
    const end = Number.isNaN(endRaw) ? start + 7 * DAY_MS : Math.max(endRaw, start + DAY_MS);
    return [{
      row,
      label: fieldText(row, node.labelField, ['title', 'name']) || 'Item',
      lane: node.laneField ? (fieldText(row, node.laneField) || 'General') : 'Timeline',
      status: node.statusField ? fieldText(row, node.statusField) : '',
      start, end,
    }];
  });

  if (items.length === 0) {
    return <EmptyState label="Nothing scheduled yet" hint={`Add rows with a "${node.startField}" date to draw the roadmap.`} />;
  }

  const min = Math.min(...items.map((i) => i.start));
  const max = Math.max(...items.map((i) => i.end));
  const pad = Math.max((max - min) * 0.04, DAY_MS);
  const t0 = min - pad;
  const t1 = max + pad;
  const span = t1 - t0;
  const pct = (t: number) => `${(((t - t0) / span) * 100).toFixed(2)}%`;
  const widthPct = (a: number, b: number) => `${Math.max(((b - a) / span) * 100, 1.5).toFixed(2)}%`;

  // Month tick marks across the window.
  const ticks: Array<{ t: number; label: string }> = [];
  const cursor = new Date(t0);
  cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor.getTime() < t1 && ticks.length < 24) {
    ticks.push({ t: cursor.getTime(), label: cursor.toLocaleDateString(undefined, { month: 'short', ...(cursor.getUTCMonth() === 0 ? { year: 'numeric' } : {}) }) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const lanes = [...new Set(items.map((i) => i.lane))];
  const now = Date.now();

  return (
    <PanelShell title={node.title ?? 'Roadmap'} icon={<GanttChartSquare size={14} />}>
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          {/* time header */}
          <div className="relative ml-[132px] h-5 border-b border-line/70">
            {ticks.map((tick) => (
              <span key={tick.t} className="absolute top-0 -translate-x-1/2 text-[9.5px] uppercase tracking-wide text-text-muted" style={{ left: pct(tick.t) }}>{tick.label}</span>
            ))}
          </div>
          <div className="relative">
            {/* grid lines + today marker overlay the lane area only */}
            <div className="pointer-events-none absolute inset-y-0 left-[132px] right-0">
              {ticks.map((tick) => <span key={tick.t} className="absolute inset-y-0 w-px bg-line/50" style={{ left: pct(tick.t) }} />)}
              {now > t0 && now < t1 ? <span className="absolute inset-y-0 w-px bg-accent/70" style={{ left: pct(now) }} title="Today" /> : null}
            </div>
            {lanes.map((lane, laneIndex) => {
              const laneItems = items.filter((i) => i.lane === lane).sort((a, b) => a.start - b.start);
              return (
                <div key={lane} className={clsx('flex items-stretch', laneIndex > 0 && 'border-t border-line/50')}>
                  <div className="w-[132px] shrink-0 py-2 pr-3">
                    <span className="line-clamp-2 text-[12.5px] font-medium text-text-secondary">{humanize(lane)}</span>
                  </div>
                  <div className="relative min-h-[34px] flex-1 py-1.5">
                    {laneItems.map((item, i) => {
                      const tone: Tone = item.status ? toneFromStatus(item.status) : 'neutral';
                      const color = tone === 'neutral' ? seriesColor(laneIndex) : undefined;
                      return (
                        <div
                          key={`${rowId(item.row)}-${i}`}
                          className={clsx('group relative mb-1 flex h-6 items-center overflow-hidden rounded-full px-2 last:mb-0', tone !== 'neutral' && toneSoftClass(tone))}
                          style={{ marginLeft: pct(item.start), width: widthPct(item.start, item.end), ...(color ? { background: `color-mix(in srgb, ${color} 16%, transparent)` } : {}) }}
                          title={`${item.label}${item.status ? ` · ${item.status}` : ''}`}
                        >
                          <span className={clsx('absolute inset-y-0 left-0 w-1 rounded-full', tone !== 'neutral' && toneFillClass(tone))} style={color ? { background: color } : undefined} />
                          <span className="truncate pl-1.5 text-[11.5px] font-medium text-text-primary">{item.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

// ── PipelineFlow (staged funnel with conversion) ──────────────

function PipelineFlowView({ node }: { node: Extract<ViewNode, { type: 'PipelineFlow' }> }) {
  const bind = node.bind ?? null;
  const { rows, loading } = useBoundRows(bind ?? { collection: '__none', live: false });
  const effectiveRows = bind ? rows : [];
  if (bind && loading) return <SkeletonRows />;

  const stageField = node.stageField ?? 'stage';
  const declared = (node.stages ?? []).map((s) => ({ key: s.key, label: s.label ?? humanize(s.key), description: s.description }));
  const order = [...declared];
  for (const row of effectiveRows) {
    const key = String(row[stageField] ?? '');
    if (key && !order.some((s) => s.key === key)) order.push({ key, label: humanize(key), description: undefined });
  }
  if (order.length === 0) {
    return <EmptyState label="No stages yet" hint="Declare stages or add rows with a stage field to draw the pipeline." />;
  }

  const stats = order.map((stage) => {
    const inStage = effectiveRows.filter((r) => String(r[stageField] ?? '') === stage.key);
    const value = node.valueField
      ? inStage.reduce((sum, r) => sum + (typeof r[node.valueField!] === 'number' ? (r[node.valueField!] as number) : 0), 0)
      : null;
    return { ...stage, count: inStage.length, value };
  });
  const maxCount = Math.max(1, ...stats.map((s) => s.count));

  return (
    <PanelShell title={node.title ?? 'Pipeline'} icon={<Columns3 size={14} />}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {stats.map((stage, i) => {
          const prev = i > 0 ? stats[i - 1] : null;
          const conversion = prev && prev.count > 0 ? Math.round((stage.count / prev.count) * 100) : null;
          const color = seriesColor(i);
          return (
            <div key={stage.key} className="flex min-w-[148px] flex-1 items-stretch gap-2">
              {i > 0 ? (
                <div className="flex shrink-0 flex-col items-center justify-center text-text-muted">
                  <ChevronRight size={13} />
                  {conversion !== null ? <span className="text-[9.5px] font-medium tabular-nums">{conversion}%</span> : null}
                </div>
              ) : null}
              <div className="s-round flex min-w-0 flex-1 flex-col justify-between bg-canvas/40 p-3 ring-1 ring-line">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    <span className="s-label truncate">{stage.label}</span>
                  </div>
                  {stage.description ? <div className="mt-1 line-clamp-2 text-[11.5px] text-text-muted">{stage.description}</div> : null}
                </div>
                <div className="mt-2">
                  <div className="text-[22px] font-semibold leading-none tabular-nums text-text-primary" style={{ fontSize: 'var(--s-kpi-size, 22px)' }}>{stage.count.toLocaleString()}</div>
                  {stage.value !== null ? <div className="mt-1 text-[11.5px] tabular-nums text-text-muted">{stage.value.toLocaleString()}</div> : null}
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full" style={{ width: `${Math.round((stage.count / maxCount) * 100)}%`, background: color }} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelShell>
  );
}

// ── registrations (open block seam) ───────────────────────────

registerBlock('Kanban', (node) => (node.type === 'Kanban' ? <KanbanView node={node} /> : null));
registerBlock('RecordMaster', (node) => (node.type === 'RecordMaster' ? <RecordMasterView node={node} /> : null));
registerBlock('Roadmap', (node) => (node.type === 'Roadmap' ? <RoadmapView node={node} /> : null));
registerBlock('PipelineFlow', (node) => (node.type === 'PipelineFlow' ? <PipelineFlowView node={node} /> : null));

