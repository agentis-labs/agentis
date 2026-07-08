import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

export interface NormalizedEmailContent {
  text: string;
  html?: string;
  sourceFormat: 'text' | 'markdown' | 'html';
}

/**
 * Normalize provider-neutral email content at the delivery boundary.
 *
 * Workflows can carry content as typed fields (`markdown`, `html`, `text`) or
 * as a generic body with an explicit `format`/`contentType`. Delivery adapters
 * should not reinterpret plain text heuristically, but they must preserve
 * declared rich-content semantics.
 */
export function normalizeEmailContent(params: Record<string, unknown>): NormalizedEmailContent {
  const format = normalizeFormat(params.format ?? params.contentType ?? params.mimeType);
  const explicitHtml = stringValue(params.html ?? params.htmlBody);
  const explicitMarkdown = stringValue(params.markdown ?? params.markdownBody);
  const explicitText = emailTextValue(params.text ?? params.plainText, format === 'text');
  const genericBody = stringValue(params.body ?? params.content ?? params.message ?? params.digest);

  if (explicitHtml || format === 'html') {
    const html = sanitizeEmailHtml(explicitHtml ?? genericBody ?? explicitText ?? '');
    return {
      text: explicitText ?? htmlToPlainText(html),
      html,
      sourceFormat: 'html',
    };
  }

  if (explicitMarkdown || format === 'markdown') {
    const markdown = explicitMarkdown ?? genericBody ?? explicitText ?? '';
    const html = markdownToEmailHtml(markdown);
    return {
      text: explicitText && explicitText !== markdown ? explicitText : htmlToPlainText(html),
      html,
      sourceFormat: 'markdown',
    };
  }

  return {
    text: explicitText ?? genericBody ?? '',
    sourceFormat: 'text',
  };
}

function normalizeFormat(value: unknown): 'text' | 'markdown' | 'html' | null {
  const format = stringValue(value)?.toLowerCase().split(';', 1)[0]?.trim();
  if (!format) return null;
  if (['markdown', 'md', 'text/markdown'].includes(format)) return 'markdown';
  if (['html', 'text/html'].includes(format)) return 'html';
  if (['text', 'plain', 'text/plain'].includes(format)) return 'text';
  return null;
}

function markdownToEmailHtml(markdown: string): string {
  const rendered = marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: true,
  });
  return sanitizeEmailHtml(typeof rendered === 'string' ? rendered : '');
}

function sanitizeEmailHtml(html: string): string {
  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'del', 's', 'blockquote',
      'ul', 'ol', 'li', 'a', 'code', 'pre',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'style'],
      p: ['style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      h4: ['style'],
      h5: ['style'],
      h6: ['style'],
      blockquote: ['style'],
      code: ['class', 'style'],
      pre: ['style'],
      table: ['style'],
      th: ['style'],
      td: ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i],
        'font-family': [/^[a-z0-9 ,.'"-]+$/i],
        'font-size': [/^\d+(?:\.\d+)?(?:px|rem|em|%)$/],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/],
        'line-height': [/^\d+(?:\.\d+)?$/],
        margin: [/^[\d .-]+(?:px|rem|em|%)?(?: [\d .-]+(?:px|rem|em|%)?){0,3}$/],
        padding: [/^[\d .-]+(?:px|rem|em|%)?(?: [\d .-]+(?:px|rem|em|%)?){0,3}$/],
        border: [/^\d+px solid #[0-9a-f]{3,8}$/i],
        'border-collapse': [/^collapse$/],
        'background-color': [/^#[0-9a-f]{3,8}$/i],
        'text-align': [/^(?:left|center|right)$/],
        'text-decoration': [/^(?:none|underline)$/],
        'word-break': [/^break-word$/],
      },
    },
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: 'a',
        attribs: {
          ...attrs,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: appendStyle(attrs.style, 'color:#2563eb;text-decoration:underline'),
        },
      }),
      table: (_tag, attrs) => ({
        tagName: 'table',
        attribs: {
          ...attrs,
          style: appendStyle(attrs.style, 'width:100%;border-collapse:collapse;margin:16px 0'),
        },
      }),
      th: (_tag, attrs) => ({
        tagName: 'th',
        attribs: {
          ...attrs,
          style: appendStyle(attrs.style, 'border:1px solid #d1d5db;padding:8px;text-align:left;background-color:#f3f4f6'),
        },
      }),
      td: (_tag, attrs) => ({
        tagName: 'td',
        attribs: {
          ...attrs,
          style: appendStyle(attrs.style, 'border:1px solid #d1d5db;padding:8px;text-align:left'),
        },
      }),
      blockquote: (_tag, attrs) => ({
        tagName: 'blockquote',
        attribs: {
          ...attrs,
          style: appendStyle(attrs.style, 'margin:16px 0;padding:8px 16px;border:1px solid #d1d5db'),
        },
      }),
      pre: (_tag, attrs) => ({
        tagName: 'pre',
        attribs: {
          ...attrs,
          style: appendStyle(attrs.style, 'padding:12px;background-color:#f3f4f6;word-break:break-word'),
        },
      }),
    },
  });

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827">${sanitized}</div>`;
}

function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text,
  })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendStyle(current: string | undefined, addition: string): string {
  return current ? `${current.replace(/;?$/, ';')}${addition}` : addition;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function emailTextValue(value: unknown, explicitlyPlain: boolean): string | undefined {
  const text = stringValue(value);
  if (!text || explicitlyPlain) return text;
  const stripped = stripJsonFence(text);
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && ['subject', 'text', 'body', 'content', 'html', 'htmlBody', 'markdown', 'markdownBody']
        .some((key) => key in parsed)
    ) {
      return undefined;
    }
  } catch {
    // Ordinary text is not a structured envelope.
  }
  return text;
}

function stripJsonFence(raw: string): string {
  let text = raw.trim();
  if (!text.startsWith('```')) return text;
  const firstLineEnd = text.indexOf('\n');
  if (firstLineEnd < 0) return text;
  const info = text.slice(3, firstLineEnd).trim().toLowerCase();
  if (info && info !== 'json') return text;
  text = text.slice(firstLineEnd + 1);
  const closingFence = text.lastIndexOf('```');
  if (closingFence >= 0 && text.slice(closingFence + 3).trim() === '') {
    text = text.slice(0, closingFence);
  }
  return text.trim();
}
