import { Fragment, useState, type ReactNode } from 'react';

/**
 * ChatMarkdown — a tiny, dependency-free Markdown renderer for assistant
 * messages. Covers the constructs an LLM actually emits in chat: headings,
 * bold/italic, inline code, fenced code blocks, ordered/unordered lists,
 * blockquotes, and links. Everything renders through React elements (never
 * `dangerouslySetInnerHTML`), so user/model text is escaped by default and
 * link hrefs are sanitized to http(s)/mailto/relative only.
 *
 * Deliberately not a full CommonMark engine — adding `react-markdown` would
 * pull a transitive tree we don't need for chat. Incomplete syntax mid-stream
 * (e.g. an unclosed ``` fence or `**bold`) degrades to literal text rather than
 * throwing, which is exactly what we want while tokens are still arriving.
 */
function PremiumCodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const parts = lang.split(':');
  const rawLang = parts[0]?.trim() || '';
  const filePath = parts[1]?.trim() || '';

  const displayLang = rawLang || 'code';
  const isShell = ['bash', 'sh', 'shell', 'zsh', 'powershell', 'cmd'].includes(rawLang.toLowerCase());
  const isDiff = rawLang.toLowerCase().startsWith('diff');

  function handleCopy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  if (isDiff) {
    const lines = content.split('\n');
    return (
      <div className="my-3 overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_24px_rgba(0,0,0,0.12)]">
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted">
          <div className="flex items-center gap-1.5 font-semibold text-text-primary">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="uppercase tracking-wider">Diff</span>
            {filePath && <span className="opacity-60">· {filePath}</span>}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded bg-canvas px-2 py-0.5 transition hover:bg-surface-3 hover:text-text-primary"
          >
            {copied ? (
              <>
                <svg className="h-3 w-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-success font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <div className="overflow-x-auto bg-canvas/40 p-2 font-mono text-[11px] leading-5">
          {lines.map((line, idx) => {
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
      </div>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_24px_rgba(0,0,0,0.12)]">
      <div className={`flex items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted ${
        isShell ? 'bg-black/95 border-b border-white/10' : ''
      }`}>
        <div className="flex items-center gap-1.5">
          {isShell ? (
            <>
              <div className="flex gap-1">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
              </div>
              <span className="font-semibold text-white/80 uppercase ml-1 tracking-wider">Terminal</span>
            </>
          ) : (
            <>
              <span className="rounded bg-canvas/80 px-1.5 py-0.5 font-bold text-accent uppercase tracking-wider text-[9px]">{displayLang}</span>
              {filePath && <span className="font-semibold text-text-primary text-[11px]">{filePath}</span>}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className={`flex items-center gap-1 rounded bg-canvas px-2 py-0.5 transition hover:bg-surface-3 hover:text-text-primary ${
            isShell ? 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white' : ''
          }`}
        >
          {copied ? (
            <>
              <svg className="h-3 w-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-success font-semibold">Copied!</span>
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className={`overflow-x-auto p-3 text-[11.5px] leading-relaxed ${
        isShell ? 'bg-black/90 font-mono text-green-400' : 'bg-canvas/40'
      }`}>
        <code className={`font-mono ${isShell ? 'text-green-400' : 'text-text-secondary'}`}>{content}</code>
      </pre>
    </div>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return <div className="space-y-2 break-words">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}

type Block =
  | { kind: 'code'; lang: string; content: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
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

    // Blank line — block separator
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
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

    // Paragraph — accumulate until a blank line or a block-starting line
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
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
      <code key={`${keyPrefix}-code${n}`} className="rounded bg-canvas/70 px-1 py-0.5 font-mono text-[11.5px] text-text-secondary">
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
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) out.push(<Fragment key={`${keyPrefix}-f${n}`}>{text.slice(last, match.index)}</Fragment>);
    if (match[1] !== undefined && match[2] !== undefined) {
      const href = sanitizeHref(match[2]);
      out.push(
        href ? (
          <a
            key={`${keyPrefix}-a${n}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {match[1]}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-a${n}`}>{match[0]}</Fragment>
        ),
      );
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const inner = match[3] ?? match[4]!;
      out.push(
        <strong key={`${keyPrefix}-b${n}`} className="font-semibold text-text-primary">
          {renderEmphasis(inner, `${keyPrefix}-b${n}i`)}
        </strong>,
      );
    } else {
      const inner = match[5] ?? match[6]!;
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

function sanitizeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('#')) return value;
  return null;
}
