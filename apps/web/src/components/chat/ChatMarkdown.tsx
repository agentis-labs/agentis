import { Fragment, type ReactNode } from 'react';

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
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md border border-line/60 bg-canvas/80 p-2.5 text-[11.5px] leading-relaxed"
        >
          <code className="font-mono text-text-secondary">{block.content}</code>
        </pre>
      );
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
