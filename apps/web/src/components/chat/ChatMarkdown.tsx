import { Fragment, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';

/**
 * ChatMarkdown â€” a tiny, dependency-free Markdown renderer for assistant
 * messages. Covers the constructs an LLM actually emits in chat: headings,
 * bold/italic, inline code, fenced code blocks, ordered/unordered lists,
 * blockquotes, and links. Everything renders through React elements (never
 * `dangerouslySetInnerHTML`), so user/model text is escaped by default and
 * link hrefs are sanitized to http(s)/mailto/relative only.
 *
 * Deliberately not a full CommonMark engine â€” adding `react-markdown` would
 * pull a transitive tree we don't need for chat. Incomplete syntax mid-stream
 * (e.g. an unclosed ``` fence or `**bold`) degrades to literal text rather than
 * throwing, which is exactly what we want while tokens are still arriving.
 */
function PremiumCodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const parts = lang.split(':');
  const rawLang = parts[0]?.trim() || '';
  const filePath = parts[1]?.trim() || '';

  const displayLang = rawLang || 'code';
  const isShell = ['bash', 'sh', 'shell', 'zsh', 'powershell', 'cmd'].includes(rawLang.toLowerCase());
  const isDiff = rawLang.toLowerCase().startsWith('diff');
  const lines = content.split('\n');
  const isLong = lines.length > 28 || content.length > 2600;
  const visibleLines = isLong && !expanded ? lines.slice(0, 28) : lines;
  const visibleContent = isLong && !expanded ? visibleLines.join('\n') : content;

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  if (isDiff) {
    return (
      <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_24px_rgba(0,0,0,0.12)]">
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted">
          <div className="flex min-w-0 items-center gap-1.5 font-semibold text-text-primary">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="uppercase tracking-wider">Diff</span>
            {filePath && <span className="truncate opacity-60">Â· {filePath}</span>}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded bg-canvas px-2 py-0.5 transition hover:bg-surface-3 hover:text-text-primary"
          >
            {copied ? (
              <>
                <Check size={12} className="text-success" />
                <span className="text-success font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <div className="overflow-x-auto bg-canvas/40 p-2 font-mono text-[11px] leading-5">
          {visibleLines.map((line, idx) => {
            let lineCls = 'text-text-secondary px-2';
            if (line.startsWith('+')) {
              lineCls = 'bg-[rgba(34,197,94,0.12)] text-[rgb(34,197,94)] border-l-2 border-green-500 px-2 font-semibold';
            } else if (line.startsWith('-')) {
              lineCls = 'bg-[rgba(239,68,68,0.12)] text-[rgb(239,68,68)] border-l-2 border-red-500 px-2 opacity-90';
            } else if (line.startsWith('@@')) {
              lineCls = 'text-[rgb(59,130,246)] bg-blue-500/5 px-2 font-semibold';
            }
            return (
              <div key={idx} className={`${lineCls} whitespace-pre break-all`}>
                {line}
              </div>
            );
          })}
        </div>
        {isLong && <CodeBlockExpander expanded={expanded} lineCount={lines.length} onToggle={() => setExpanded((value) => !value)} />}
      </div>
    );
  }

  return (
    <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_24px_rgba(0,0,0,0.12)]">
      <div className={`flex min-w-0 items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted ${
        isShell ? 'bg-[color:var(--color-terminal-header)] border-b-[color:var(--color-terminal-header-border)]' : ''
      }`}>
        <div className="flex min-w-0 items-center gap-1.5">
          {isShell ? (
            <>
              <div className="flex gap-1">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
              </div>
              <span className="ml-1 font-semibold uppercase tracking-wider text-[color:var(--color-terminal-label)]">Terminal</span>
            </>
          ) : (
            <>
              <span className="rounded bg-canvas/80 px-1.5 py-0.5 font-bold text-accent uppercase tracking-wider text-[9px]">{displayLang}</span>
              {filePath && <span className="truncate font-semibold text-text-primary text-[11px]">{filePath}</span>}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className={`flex items-center gap-1 rounded bg-canvas px-2 py-0.5 transition hover:bg-surface-3 hover:text-text-primary ${
            isShell
              ? 'bg-[color:var(--color-terminal-button)] text-[color:var(--color-terminal-button-text)] hover:bg-[color:var(--color-terminal-button-hover)] hover:text-[color:var(--color-terminal-button-hover-text)]'
              : ''
          }`}
        >
          {copied ? (
            <>
              <Check size={12} className="text-success" />
              <span className="text-success font-semibold">Copied!</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className={`overflow-x-auto p-3 text-[11.5px] leading-relaxed ${
        isShell ? 'bg-[color:var(--color-terminal-body)] font-mono text-[color:var(--color-terminal-text)]' : 'bg-canvas/40'
      }`}>
        <code className={`font-mono ${isShell ? 'text-[color:var(--color-terminal-text)]' : 'text-text-secondary'}`}>{visibleContent}</code>
      </pre>
      {isLong && <CodeBlockExpander expanded={expanded} lineCount={lines.length} onToggle={() => setExpanded((value) => !value)} />}
    </div>
  );
}

function CodeBlockExpander({
  expanded,
  lineCount,
  onToggle,
}: {
  expanded: boolean;
  lineCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-surface-2 px-3 py-2 text-[11px] font-medium text-text-secondary transition hover:bg-surface-3 hover:text-text-primary"
    >
      {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      {expanded ? 'Show less' : `Show all ${lineCount} lines`}
    </button>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return <div className="min-w-0 max-w-full space-y-2 break-words [overflow-wrap:anywhere]">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}

type Block =
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; headers: string[]; alignments: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { kind: 'task-list'; items: { checked: boolean; text: string }[] }
  | { kind: 'hr' }
  | { kind: 'p'; lines: string[] };

function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1]!.trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // consume closing fence (or EOF)
      blocks.push({ kind: 'code', lang, content: body.join('\n') });
      continue;
    }

    // Horizontal rule (---, ***, ___ with 3+ chars)
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Blank line â€” block separator
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // GFM Table
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:]*-+[\s:]*/.test(lines[i + 1]!)
    ) {
      const headerCells = parseTableRow(line);
      const sepLine = lines[i + 1]!;
      const alignments = parseTableAlignments(sepLine);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: 'table', headers: headerCells, alignments, rows });
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    // Task list (must check before generic unordered list)
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const taskItems: { checked: boolean; text: string }[] = [];
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i]!)) {
        const tm = lines[i]!.match(/^\s*[-*+]\s+\[([xX ])\]\s+(.*)$/);
        if (tm) {
          taskItems.push({ checked: tm[1] !== ' ', text: tm[2]! });
        }
        i += 1;
      }
      blocks.push({ kind: 'task-list', items: taskItems });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    // Paragraph â€” accumulate until a blank line or a block-starting line
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*\|/.test(lines[i]!) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'p', lines: para });
  }

  return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'code':
      return <PremiumCodeBlock key={key} lang={block.lang} content={block.content} />;
    case 'heading': {
      const sizes: Record<number, string> = {
        1: 'text-[15px] font-semibold',
        2: 'text-[14px] font-semibold',
        3: 'text-[13px] font-semibold',
      };
      return (
        <div key={key} className={`mt-1 text-text-primary ${sizes[block.level] ?? 'text-[13px] font-semibold'}`}>
          {renderInline(block.text, `h${key}`)}
        </div>
      );
    }
    case 'ul':
      return (
        <ul key={key} className="list-disc space-y-1 pl-5 marker:text-text-muted">
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ul${key}-${idx}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="list-decimal space-y-1 pl-5 marker:text-text-muted">
          {block.items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol${key}-${idx}`)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={key} className="border-l-2 border-accent/40 pl-2.5 text-text-secondary">
          {renderInline(block.lines.join('\n'), `q${key}`)}
        </blockquote>
      );
    case 'table':
      return (
        <div key={key} className="my-3 max-w-full overflow-x-auto rounded-xl border border-line shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
          <table className="w-full border-collapse text-[11.5px] font-mono">
            <thead>
              <tr className="bg-surface-2">
                {block.headers.map((h, idx) => (
                  <th
                    key={idx}
                    className="whitespace-nowrap border-b border-line px-3 py-1.5 text-left font-bold uppercase tracking-wider text-text-primary text-[10.5px]"
                    style={{ textAlign: block.alignments[idx] ?? 'left' }}
                  >
                    {renderInline(h.trim(), `th${key}-${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx} className="even:bg-surface/40">
                  {row.map((cell, cIdx) => (
                    <td
                      key={cIdx}
                      className="border-b border-line/50 px-3 py-1.5 text-text-secondary"
                      style={{ textAlign: block.alignments[cIdx] ?? 'left' }}
                    >
                      {renderInline(cell.trim(), `td${key}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'task-list':
      return (
        <ul key={key} className="space-y-1 pl-1">
          {block.items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={item.checked}
                disabled
                className="mt-1 h-3.5 w-3.5 rounded border-line accent-accent cursor-default"
              />
              <span className={item.checked ? 'text-text-muted line-through' : ''}>
                {renderInline(item.text, `tl${key}-${idx}`)}
              </span>
            </li>
          ))}
        </ul>
      );
    case 'hr':
      return (
        <div key={key} className="py-2">
          <div className="h-px bg-gradient-to-r from-transparent via-line to-transparent" />
        </div>
      );
    case 'p':
    default:
      return (
        <p key={key} className="whitespace-pre-wrap leading-relaxed">
          {renderInline((block as { lines: string[] }).lines.join('\n'), `p${key}`)}
        </p>
      );
  }
}

/** Inline pass: code spans first (literal), then links/bold/italic. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const codeRe = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = codeRe.exec(text))) {
    if (match.index > last) {
      out.push(...renderEmphasis(text.slice(last, match.index), `${keyPrefix}-x${n}`));
    }
    out.push(
      <code key={`${keyPrefix}-code${n}`} className="break-all rounded bg-canvas/70 px-1 py-0.5 font-mono text-[11.5px] text-text-secondary">
        {match[1]}
      </code>,
    );
    last = match.index + match[0].length;
    n += 1;
  }
  if (last < text.length) out.push(...renderEmphasis(text.slice(last), `${keyPrefix}-x${n}`));
  return out;
}

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) out.push(<Fragment key={`${keyPrefix}-f${n}`}>{text.slice(last, match.index)}</Fragment>);
    if (match[1] !== undefined) {
      // Strikethrough ~~text~~
      out.push(
        <del key={`${keyPrefix}-s${n}`} className="text-text-muted line-through">
          {renderEmphasis(match[1], `${keyPrefix}-s${n}i`)}
        </del>,
      );
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const href = sanitizeHref(match[3]);
      out.push(
        href ? (
          <a
            key={`${keyPrefix}-a${n}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {match[2]}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-a${n}`}>{match[0]}</Fragment>
        ),
      );
    } else if (match[4] !== undefined || match[5] !== undefined) {
      const inner = match[4] ?? match[5]!;
      out.push(
        <strong key={`${keyPrefix}-b${n}`} className="font-semibold text-text-primary">
          {renderEmphasis(inner, `${keyPrefix}-b${n}i`)}
        </strong>,
      );
    } else {
      const inner = match[6] ?? match[7]!;
      out.push(
        <em key={`${keyPrefix}-i${n}`}>{renderEmphasis(inner, `${keyPrefix}-i${n}i`)}</em>,
      );
    }
    last = match.index + match[0].length;
    n += 1;
  }
  if (last < text.length) out.push(<Fragment key={`${keyPrefix}-f${n}`}>{text.slice(last)}</Fragment>);
  return out;
}

/** Parse a GFM table row into an array of cell strings. */
function parseTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Parse the separator line to extract column alignments. */
function parseTableAlignments(line: string): ('left' | 'center' | 'right' | null)[] {
  return parseTableRow(line).map((cell) => {
    const trimmed = cell.trim().replace(/\s/g, '');
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function sanitizeHref(href: string): string | null {
  const value = href.trim();
  const artifactId = artifactIdFromApiHref(value);
  // Artifact API endpoints require an Authorization header. A normal anchor
  // navigation cannot provide one, so route these links through the app's
  // authenticated artifact viewer instead of opening a misleading 401 page.
  if (artifactId) return `/artifacts?open=${encodeURIComponent(artifactId)}`;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('#')) return value;
  return null;
}

function artifactIdFromApiHref(href: string): string | null {
  const match = href.match(/^(?:https?:\/\/[^/]+)?\/v1\/artifacts\/([0-9a-f-]{36})(?:[/?#].*)?$/i);
  return match?.[1] ?? null;
}



