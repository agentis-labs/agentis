/**
 * RunOutputCard — renders the final node's output of a workflow run.
 *
 * The shape rendered depends on the node kind (WORKFLOW-PAGE-REDESIGN.md §Tab 3):
 *   response     → plain text card
 *   agent_task   → agent output card (text when available, else JSON)
 *   data_write   → "wrote N records to {table}" notice
 *   scratchpad   → raw JSON inspector
 *   checkpoint   → "paused at checkpoint" notice
 *   router       → "branched to {target}" notice
 *   anything else → raw JSON code block
 */

import { useState } from 'react';
import clsx from 'clsx';
import { Bot, Database, FileText, GitBranch, PauseCircle, Braces, Globe, Monitor, Tablet, Smartphone, ExternalLink } from 'lucide-react';
import { ChatMarkdown } from '../chat/ChatMarkdown';

export type OutputRenderAs = 'html' | 'markdown' | 'table' | 'json' | 'text';

export interface FinalNodeOutput {
  nodeId: string;
  nodeTitle: string;
  kind: string;
  value: unknown;
  /** Viewer hint from a `return_output` node (Layer 6). */
  renderAs?: OutputRenderAs;
}

const TEXT_KEYS = ['text', 'content', 'output', 'result', 'message', 'response', 'answer', 'summary', 'description', 'body', 'details', 'markdown'];
const TITLE_KEYS = ['title', 'name', 'label', 'headline'];
const COLLECTION_KEYS = ['records', 'rows', 'items', 'apps'];
const WRAPPED_VALUE_KEYS = ['app', 'result', 'output', 'data', 'payload', 'value'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Pull a human-readable string out of an arbitrary node output, if present. */
function extractText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return null;
  for (const key of TEXT_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const key of WRAPPED_VALUE_KEYS) {
    const nested = extractText(value[key]);
    if (nested) return nested;
  }
  return null;
}

/** Pull an HTML string out of a return_output value: a string, or `{content|html|body}`. */
function extractHtml(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (!isRecord(value)) return null;
  for (const key of ['content', 'html', 'body', 'text']) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function looksLikeHtml(value: unknown): boolean {
  if (isRecord(value) && value.type === 'html' && typeof value.content === 'string') return true;
  const html = extractHtml(value);
  return Boolean(html && /<[a-z!][\s\S]*>/i.test(html));
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

function humanizeLabel(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function truncateText(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return 'No items';
    const preview = value.slice(0, 3).map((item) => formatValue(item));
    return preview.join(', ') + (value.length > 3 ? ` +${value.length - 3} more` : '');
  }
  if (isRecord(value)) {
    const text = extractText(value);
    if (text) return truncateText(text, 80);
    return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}`;
  }
  return String(value);
}

function unwrapDisplayValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of COLLECTION_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const key of WRAPPED_VALUE_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return value;
}

function isRecordArray(value: unknown[]): value is Array<Record<string, unknown>> {
  return value.length > 0 && value.every(isRecord);
}

function rowsFromValue(value: unknown): Array<Record<string, unknown>> {
  const displayValue = unwrapDisplayValue(value);
  if (Array.isArray(displayValue) && isRecordArray(displayValue)) return displayValue;
  if (!isRecord(displayValue)) return [];
  for (const key of COLLECTION_KEYS) {
    const candidate = displayValue[key];
    if (Array.isArray(candidate) && isRecordArray(candidate)) return candidate;
  }
  return [];
}

function listFromValue(value: unknown): unknown[] {
  const displayValue = unwrapDisplayValue(value);
  if (Array.isArray(displayValue)) return displayValue;
  if (!isRecord(displayValue)) return [];
  for (const key of COLLECTION_KEYS) {
    const candidate = displayValue[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function documentFields(value: Record<string, unknown>) {
  return {
    title: firstString(value, TITLE_KEYS),
    body: firstString(value, TEXT_KEYS),
  };
}

function summaryEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value)
    .filter(([key, item]) => !WRAPPED_VALUE_KEYS.includes(key) && item !== undefined && item !== null)
    .slice(0, 8);
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-input border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-text-primary">
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded-input border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-text-primary">
      {text}
    </div>
  );
}

const DEVICE_WIDTHS = { desktop: '100%', tablet: '768px', mobile: '375px' } as const;
type DeviceMode = keyof typeof DEVICE_WIDTHS;

/**
 * LiveHTMLRenderer — renders HTML output in a sandboxed iframe (Layer 6).
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` keeps the page
 * origin-isolated: no access to the parent DOM, cookies, or localStorage.
 */
function LiveHTMLRenderer({ html }: { html: string }) {
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const openInTab = () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
        <Globe size={13} className="text-text-muted" />
        <span className="mr-auto text-[11px] font-medium text-text-muted">Rendered HTML</span>
        {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([mode, Icon]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setDevice(mode)}
            aria-label={`${mode} preview`}
            aria-pressed={device === mode}
            className={clsx(
              'rounded p-1 hover:bg-surface-2',
              device === mode ? 'text-accent' : 'text-text-muted',
            )}
          >
            <Icon size={14} />
          </button>
        ))}
        <button
          type="button"
          onClick={openInTab}
          aria-label="Open in new tab"
          className="rounded p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="flex justify-center bg-white p-2">
        <iframe
          title="HTML output preview"
          sandbox="allow-scripts"
          srcDoc={html}
          className="h-[420px] rounded border border-line bg-white transition-[width]"
          style={{ width: DEVICE_WIDTHS[device] }}
        />
      </div>
    </div>
  );
}

function Notice({ icon, title, body }: { icon: React.ReactNode; title: string; body?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-input border border-line bg-surface-2 p-4">
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        {body && <div className="mt-0.5 text-[12px] text-text-muted">{body}</div>}
      </div>
    </div>
  );
}

function ValueCard({ value }: { value: string | number | boolean }) {
  return (
    <div className="rounded-input border border-line bg-surface-2 px-4 py-3 text-[15px] font-medium text-text-primary">
      {formatValue(value)}
    </div>
  );
}

function SummaryGrid({ value }: { value: Record<string, unknown> }) {
  const entries = summaryEntries(value);
  if (entries.length === 0) return <JsonBlock value={value} />;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, item]) => (
        <div key={key} className="rounded-input border border-line bg-surface-2 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">
            {humanizeLabel(key)}
          </div>
          <div className="mt-1 break-words text-[13px] text-text-primary">
            {formatValue(item)}
          </div>
        </div>
      ))}
    </div>
  );
}

function TableArtifact({ value }: { value: unknown }) {
  const rows = rowsFromValue(value);
  if (rows.length === 0) {
    return <div className="text-[12px] text-text-muted">No rows returned.</div>;
  }
  const columns = Object.keys(rows[0] ?? {}).slice(0, 4);
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-line bg-surface text-[10px] uppercase tracking-wider text-text-muted">
              {columns.map((column) => (
                <th key={column} className="px-3 py-2">
                  {humanizeLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 5).map((row, index) => (
              <tr key={String(row.id ?? index)} className="border-b border-line/60 last:border-b-0">
                {columns.map((column) => (
                  <td key={column} className="max-w-[260px] truncate px-3 py-2 text-text-primary">
                    {formatValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListArtifact({ items }: { items: unknown[] }) {
  if (items.length === 0) {
    return <div className="text-[12px] text-text-muted">No items returned.</div>;
  }
  return (
    <div className="space-y-2">
      {items.slice(0, 5).map((item, index) => {
        const record = isRecord(item) ? item : null;
        const title = record ? firstString(record, TITLE_KEYS) : null;
        const body = record ? firstString(record, TEXT_KEYS) : null;
        return (
          <div key={index} className="rounded-input border border-line bg-surface-2 px-3 py-2.5">
            <div className="text-[13px] font-medium text-text-primary">
              {title ?? formatValue(item)}
            </div>
            {body && body !== title && (
              <div className="mt-1 text-[12px] text-text-muted">{truncateText(body, 160)}</div>
            )}
          </div>
        );
      })}
      {items.length > 5 && (
        <div className="text-[11px] text-text-muted">+ {items.length - 5} more items</div>
      )}
    </div>
  );
}

function LinkArtifact({ value }: { value: Record<string, unknown> }) {
  const href = typeof value.url === 'string' ? value.url : null;
  const title = firstString(value, TITLE_KEYS) ?? href;
  if (!href) return <JsonBlock value={value} />;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[12px] text-accent hover:bg-surface"
    >
      <div className="truncate font-medium">{title}</div>
      <div className="mt-1 truncate text-text-muted">{href}</div>
    </a>
  );
}

function FileArtifact({ value }: { value: Record<string, unknown> }) {
  const href = typeof value.url === 'string' ? value.url : null;
  const name = firstString(value, ['name', 'fileName', 'title']) ?? 'Download file';
  if (!href) return <JsonBlock value={value} />;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[12px] font-medium text-text-primary hover:bg-surface"
    >
      {name}
    </a>
  );
}

function DocumentArtifact({ value }: { value: Record<string, unknown> }) {
  const { title, body } = documentFields(value);
  if (!title && !body) return <SummaryGrid value={value} />;
  return (
    <div className="rounded-input border border-line bg-surface-2 p-4">
      {title && <div className="text-[14px] font-semibold text-text-primary">{title}</div>}
      {body && (
        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary">
          {body}
        </div>
      )}
    </div>
  );
}

function SmartArtifact({ value }: { value: unknown }) {
  const displayValue = unwrapDisplayValue(value);

  if (displayValue == null) {
    return <div className="text-[12px] text-text-muted">This run completed without a structured payload.</div>;
  }
  if (typeof displayValue === 'string') return <TextBlock text={displayValue} />;
  if (typeof displayValue === 'number' || typeof displayValue === 'boolean') {
    return <ValueCard value={displayValue} />;
  }
  if (Array.isArray(displayValue)) {
    if (displayValue.length === 0) {
      return <div className="text-[12px] text-text-muted">No items returned.</div>;
    }
    return isRecordArray(displayValue)
      ? <TableArtifact value={displayValue} />
      : <ListArtifact items={displayValue} />;
  }
  if (!isRecord(displayValue)) return <JsonBlock value={displayValue} />;

  if (typeof displayValue.url === 'string') {
    const isFile = typeof displayValue.name === 'string' || typeof displayValue.fileName === 'string';
    return isFile ? <FileArtifact value={displayValue} /> : <LinkArtifact value={displayValue} />;
  }
  if (rowsFromValue(displayValue).length > 0) return <TableArtifact value={displayValue} />;

  const items = listFromValue(displayValue);
  if (items.length > 0) {
    return isRecordArray(items) ? <TableArtifact value={items} /> : <ListArtifact items={items} />;
  }

  const { title, body } = documentFields(displayValue);
  if (title || body) return <DocumentArtifact value={displayValue} />;

  const summary = summaryEntries(displayValue);
  if (summary.length > 0) return <SummaryGrid value={displayValue} />;

  const text = extractText(displayValue);
  return text ? <TextBlock text={text} /> : <JsonBlock value={displayValue} />;
}

/** Render a value according to an explicit `renderAs` viewer hint (Layer 6). */
function renderByRenderAs(renderAs: OutputRenderAs, value: unknown): React.ReactNode {
  switch (renderAs) {
    case 'html': {
      const html = extractHtml(value);
      return html ? <LiveHTMLRenderer html={html} /> : <SmartArtifact value={value} />;
    }
    case 'markdown': {
      const md = extractText(value);
      return md != null
        ? <div className="rounded-input border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-text-primary"><ChatMarkdown text={md} /></div>
        : <SmartArtifact value={value} />;
    }
    case 'table':
      return <TableArtifact value={value} />;
    case 'text': {
      const t = extractText(value);
      return t != null ? <TextBlock text={t} /> : <JsonBlock value={value} />;
    }
    case 'json':
    default:
      return <JsonBlock value={value} />;
  }
}

const RENDER_AS_GLYPH: Record<OutputRenderAs, React.ReactNode> = {
  html: <Globe size={14} />,
  markdown: <FileText size={14} />,
  table: <Database size={14} />,
  json: <Braces size={14} />,
  text: <FileText size={14} />,
};

export function RunOutputCard({ output }: { output: FinalNodeOutput }) {
  const { kind, value } = output;
  const text = extractText(value);

  let body: React.ReactNode;
  let glyph: React.ReactNode = <Braces size={14} />;

  // Explicit viewer hint from a return_output node wins. Otherwise, auto-detect
  // HTML payloads (legacy `{type:'html',content}` shape) so they render live
  // instead of as raw source.
  const renderAs: OutputRenderAs | null =
    output.renderAs ?? (kind === 'return_output' && looksLikeHtml(value) ? 'html' : null);
  if (renderAs) {
    return (
      <div>
        <div className="mb-2 flex items-center gap-2 text-[12px] text-text-muted">
          <span className="text-text-muted">{RENDER_AS_GLYPH[renderAs]}</span>
          <span className="font-medium text-text-secondary">{output.nodeTitle}</span>
          <span className="font-mono text-[11px] uppercase tracking-wide">{renderAs}</span>
        </div>
        {renderByRenderAs(renderAs, value)}
      </div>
    );
  }

  // No explicit hint: auto-detect a live HTML payload from any node.
  if (looksLikeHtml(value)) {
    const html = extractHtml(value);
    if (html) {
      return (
        <div>
          <div className="mb-2 flex items-center gap-2 text-[12px] text-text-muted">
            <span className="text-text-muted"><Globe size={14} /></span>
            <span className="font-medium text-text-secondary">{output.nodeTitle}</span>
            <span className="font-mono text-[11px] uppercase tracking-wide">html</span>
          </div>
          <LiveHTMLRenderer html={html} />
        </div>
      );
    }
  }

  switch (kind) {
    case 'response': {
      glyph = <FileText size={14} />;
      body = text != null ? <TextBlock text={text} /> : <SmartArtifact value={value} />;
      break;
    }
    case 'agent_task':
    case 'agent_swarm': {
      glyph = <Bot size={14} />;
      body = text != null ? <TextBlock text={text} /> : <SmartArtifact value={value} />;
      break;
    }
    case 'data_write':
    case 'table': {
      glyph = <Database size={14} />;
      const table = isRecord(value) && typeof value.table === 'string' ? value.table : 'table';
      const op = isRecord(value) && typeof value.operation === 'string' ? value.operation : 'wrote';
      body = rowsFromValue(value).length > 0 ? (
        <TableArtifact value={value} />
      ) : (
        <Notice
          icon={<Database size={15} />}
          title={`Record ${op === 'insert' ? 'inserted into' : op === 'update' ? 'updated in' : 'written to'} "${table}"`}
          body="See the Accumulated Records section below for the full table."
        />
      );
      break;
    }
    case 'scratchpad': {
      glyph = <Braces size={14} />;
      body = <JsonBlock value={value} />;
      break;
    }
    case 'checkpoint': {
      glyph = <PauseCircle size={14} />;
      body = (
        <Notice
          icon={<PauseCircle size={15} />}
          title="Run paused at a checkpoint"
          body="This workflow is waiting for approval to continue."
        />
      );
      break;
    }
    case 'router': {
      glyph = <GitBranch size={14} />;
      const routerValue = isRecord(value) ? value : null;
      const branch =
        (routerValue && typeof routerValue.branch === 'string' && routerValue.branch) ||
        (routerValue && typeof routerValue.target === 'string' && routerValue.target) ||
        (routerValue && typeof routerValue.matched === 'string' && routerValue.matched) ||
        null;
      body = (
        <Notice
          icon={<GitBranch size={15} />}
          title={branch ? `Branched to "${branch}"` : 'Routed to a downstream branch'}
        />
      );
      break;
    }
    default: {
      body = text != null ? <TextBlock text={text} /> : <SmartArtifact value={value} />;
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[12px] text-text-muted">
        <span className="text-text-muted">{glyph}</span>
        <span className="font-medium text-text-secondary">{output.nodeTitle}</span>
        <span className="font-mono text-[11px] uppercase tracking-wide">{kind}</span>
      </div>
      {body}
    </div>
  );
}
