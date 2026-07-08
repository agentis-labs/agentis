/**
 * Utility & data-primitive node handlers (WORKFLOW-UPDATE — n8n-inspired).
 *
 * These are PURE node kinds: their output is a function of (config, inputData)
 * with no run-state mutation and no external network. They plug into the same
 * NodeHandlerRegistry seam as transform/filter, so the engine dispatch switch
 * stays untouched. The deterministic conversions (markdown, XML, HTML extract,
 * JSON-Schema validation) are exported standalone so they can be unit-tested
 * directly without the engine.
 *
 * Dependency-free by design: no markdown/XML/HTML libraries are installed, so we
 * implement the practical subset each node needs with Node built-ins only.
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import type {
  CryptoUtilNodeConfig,
  DateTimeNodeConfig,
  HtmlExtractNodeConfig,
  JsonSchemaValidateNodeConfig,
  MarkdownNodeConfig,
  StickyNoteNodeConfig,
  XmlParseNodeConfig,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { getPath } from '../listener/jsonpath.js';
import type { NodeHandlerRegistry, PureNodeHandler } from './NodeHandler.js';

/** Read a dot/bracket path from the node input; whole input when the path is empty. */
function readInput(inputData: Record<string, unknown>, path?: string): unknown {
  if (!path || !path.trim()) return inputData;
  return getPath(inputData, path);
}

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function wrap(outputKey: string | undefined, fallbackKey: string, value: unknown): Record<string, unknown> {
  return { [outputKey ?? fallbackKey]: value };
}

// ── datetime ────────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  months: 2_592_000_000, // 30d approximation for diff/add
  years: 31_536_000_000, // 365d approximation
};

export function runDateTime(config: DateTimeNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  const key = config.outputKey ?? 'datetime';
  if (config.operation === 'now') {
    const d = new Date();
    return { [key]: formatDate(d, config.outputFormat) };
  }
  const raw = readInput(inputData, config.inputPath);
  const base = parseDate(raw);
  if (Number.isNaN(base.getTime())) {
    throw new AgentisError('VALIDATION_FAILED', `datetime: could not parse date from ${JSON.stringify(raw)}`);
  }
  switch (config.operation) {
    case 'parse':
      return { [key]: base.toISOString() };
    case 'format':
      return { [key]: formatDate(base, config.outputFormat) };
    case 'add':
    case 'subtract': {
      const unit = config.unit ?? 'days';
      const amount = (config.amount ?? 0) * (config.operation === 'subtract' ? -1 : 1);
      const result = addToDate(base, amount, unit);
      return { [key]: formatDate(result, config.outputFormat) };
    }
    case 'diff': {
      const other = config.comparePath ? parseDate(readInput(inputData, config.comparePath)) : new Date();
      const unit = config.diffUnit ?? 'seconds';
      const diff = (other.getTime() - base.getTime()) / (UNIT_MS[unit] ?? 1000);
      return { [key]: Math.trunc(diff) };
    }
    default:
      throw new AgentisError('VALIDATION_FAILED', `datetime: unknown operation ${(config as { operation: string }).operation}`);
  }
}

function parseDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'number') return new Date(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return new Date(Number(trimmed));
    return new Date(trimmed);
  }
  return new Date(NaN);
}

function addToDate(date: Date, amount: number, unit: string): Date {
  const d = new Date(date.getTime());
  switch (unit) {
    case 'months': d.setUTCMonth(d.getUTCMonth() + amount); return d;
    case 'years': d.setUTCFullYear(d.getUTCFullYear() + amount); return d;
    default: return new Date(date.getTime() + amount * (UNIT_MS[unit] ?? UNIT_MS.days!));
  }
}

function formatDate(date: Date, format?: string): string {
  if (!format || format === 'iso') return date.toISOString();
  if (format === 'unix') return String(Math.floor(date.getTime() / 1000));
  if (format === 'date') return date.toISOString().slice(0, 10);
  // Token-based formatting (UTC): YYYY MM DD HH mm ss
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return format
    .replace(/YYYY/g, String(date.getUTCFullYear()))
    .replace(/MM/g, pad(date.getUTCMonth() + 1))
    .replace(/DD/g, pad(date.getUTCDate()))
    .replace(/HH/g, pad(date.getUTCHours()))
    .replace(/mm/g, pad(date.getUTCMinutes()))
    .replace(/ss/g, pad(date.getUTCSeconds()));
}

// ── crypto_util ───────────────────────────────────────────────────────────────

export function runCryptoUtil(config: CryptoUtilNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  const key = config.outputKey ?? 'crypto';
  if (config.operation === 'uuid') {
    return { [key]: randomUUID() };
  }
  const input = asString(readInput(inputData, config.inputPath));
  switch (config.operation) {
    case 'hash':
      return { [key]: createHash(config.algorithm ?? 'sha256').update(input).digest('hex') };
    case 'hmac': {
      const secret = asString(readInput(inputData, config.secretPath));
      if (!secret) throw new AgentisError('VALIDATION_FAILED', 'crypto_util hmac requires a non-empty secret');
      return { [key]: createHmac(config.algorithm ?? 'sha256', secret).update(input).digest('hex') };
    }
    case 'base64_encode':
      return { [key]: Buffer.from(input, 'utf8').toString('base64') };
    case 'base64_decode':
      return { [key]: Buffer.from(input, 'base64').toString('utf8') };
    default:
      throw new AgentisError('VALIDATION_FAILED', `crypto_util: unknown operation ${(config as { operation: string }).operation}`);
  }
}

// ── markdown ──────────────────────────────────────────────────────────────────

export function markdownToHtml(md: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    escape(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (bullet) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1]!)}</li>`);
    } else if (line.trim() === '') {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara(); closeList();
  return out.join('\n');
}

export function htmlToMarkdown(html: string): string {
  let s = html.replace(/\r\n/g, '\n');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div)>/gi, '\n\n');
  s = s.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_m, lvl: string, inner: string) => `${'#'.repeat(Number(lvl))} ${inner.trim()}\n\n`);
  s = s.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gis, '**$2**');
  s = s.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gis, '*$2*');
  s = s.replace(/<code[^>]*>(.*?)<\/code>/gis, '`$1`');
  s = s.replace(/<a [^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, '[$2]($1)');
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gis, '- $1\n');
  s = stripHtmlTags(s);
  s = decodeBasicHtmlEntities(s);
  return collapseBlankLines(s).trim();
}

function stripHtmlTags(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '<') {
      out += value[i];
      continue;
    }
    const end = value.indexOf('>', i + 1);
    if (end < 0) {
      out += value.slice(i);
      break;
    }
    i = end;
  }
  return out;
}

function decodeBasicHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
  };
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '&') {
      out += value[i];
      continue;
    }
    const semi = value.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 8) {
      out += value[i];
      continue;
    }
    const key = value.slice(i + 1, semi);
    const decoded = entities[key];
    if (decoded === undefined) {
      out += value.slice(i, semi + 1);
    } else {
      out += decoded;
    }
    i = semi;
  }
  return out;
}

function collapseBlankLines(value: string): string {
  let out = '';
  let newlines = 0;
  for (const ch of value) {
    if (ch === '\n') {
      newlines += 1;
      if (newlines <= 2) out += ch;
    } else {
      newlines = 0;
      out += ch;
    }
  }
  return out;
}

export function runMarkdown(config: MarkdownNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  const input = asString(readInput(inputData, config.inputPath));
  const value = config.operation === 'to_html' ? markdownToHtml(input) : htmlToMarkdown(input);
  return wrap(config.outputKey, config.operation === 'to_html' ? 'html' : 'markdown', value);
}

// ── xml_parse ──────────────────────────────────────────────────────────────────

/** Minimal XML → JSON. Attributes become `@_name`, text becomes `#text` when mixed. */
export function xmlToJson(xml: string): unknown {
  let i = 0;
  const src = xml.trim();

  function parseNode(): Record<string, unknown> {
    const node: Record<string, unknown> = {};
    while (i < src.length) {
      // skip prolog / comments
      if (src.startsWith('<?', i)) { i = src.indexOf('?>', i) + 2; continue; }
      if (src.startsWith('<!--', i)) { i = src.indexOf('-->', i) + 3; continue; }
      if (src.startsWith('</', i)) return node; // caller handles close
      const lt = src.indexOf('<', i);
      if (lt === -1) break;
      // text before tag
      const text = src.slice(i, lt).trim();
      if (text) appendChild(node, '#text', decodeEntities(text));
      i = lt;
      if (src.startsWith('</', i)) return node;
      parseElement(node);
    }
    return node;
  }

  function parseElement(parent: Record<string, unknown>): void {
    i += 1; // skip <
    const nameMatch = /[^\s/>]+/.exec(src.slice(i));
    if (!nameMatch) { i = src.length; return; }
    const tag = nameMatch[0];
    i += tag.length;
    const el: Record<string, unknown> = {};
    // attributes
    while (i < src.length && src[i] !== '>' && !src.startsWith('/>', i)) {
      const attr = /\s*([^\s=/>]+)\s*=\s*"([^"]*)"/y;
      attr.lastIndex = i;
      const m = attr.exec(src);
      if (m) {
        el[`@_${m[1]}`] = decodeEntities(m[2]!);
        i = attr.lastIndex;
      } else {
        i += 1;
      }
    }
    if (src.startsWith('/>', i)) {
      i += 2;
      appendChild(parent, tag, Object.keys(el).length ? el : '');
      return;
    }
    i += 1; // skip >
    const inner = parseNode();
    // expect </tag>
    if (src.startsWith('</', i)) {
      i = src.indexOf('>', i) + 1;
    }
    const merged = mergeInner(el, inner);
    appendChild(parent, tag, merged);
  }

  function mergeInner(el: Record<string, unknown>, inner: Record<string, unknown>): unknown {
    const keys = Object.keys(inner);
    if (Object.keys(el).length === 0) {
      if (keys.length === 1 && keys[0] === '#text') return inner['#text'];
      if (keys.length === 0) return '';
      return inner;
    }
    return { ...el, ...inner };
  }

  function appendChild(node: Record<string, unknown>, key: string, value: unknown): void {
    if (key in node) {
      const existing = node[key];
      if (Array.isArray(existing)) existing.push(value);
      else node[key] = [existing, value];
    } else {
      node[key] = value;
    }
  }

  return parseNode();
}

function decodeEntities(s: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    apos: "'",
  };
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '&') {
      out += s[i];
      continue;
    }
    const semi = s.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 12) {
      out += s[i];
      continue;
    }
    const key = s.slice(i + 1, semi);
    out += entities[key] ?? s.slice(i, semi + 1);
    i = semi;
  }
  return out;
}

function encodeEntities(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else out += ch;
  }
  return out;
}

/** Minimal JSON → XML. */
export function jsonToXml(value: unknown): string {
  function build(key: string, val: unknown): string {
    if (Array.isArray(val)) return val.map((v) => build(key, v)).join('');
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const attrs = Object.entries(obj)
        .filter(([k]) => k.startsWith('@_'))
        .map(([k, v]) => ` ${k.slice(2)}="${encodeEntities(asString(v))}"`)
        .join('');
      const children = Object.entries(obj)
        .filter(([k]) => !k.startsWith('@_') && k !== '#text')
        .map(([k, v]) => build(k, v))
        .join('');
      const text = '#text' in obj ? encodeEntities(asString(obj['#text'])) : '';
      const inner = `${text}${children}`;
      return inner ? `<${key}${attrs}>${inner}</${key}>` : `<${key}${attrs}/>`;
    }
    return `<${key}>${encodeEntities(asString(val))}</${key}>`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => build(k, v)).join('');
  }
  return build('root', value);
}

export function runXmlParse(config: XmlParseNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  if (config.operation === 'build') {
    const obj = readInput(inputData, config.inputPath);
    return wrap(config.outputKey, 'xml', jsonToXml(obj));
  }
  const xml = asString(readInput(inputData, config.inputPath));
  return wrap(config.outputKey, 'json', xmlToJson(xml));
}

// ── json_schema_validate ────────────────────────────────────────────────────

export interface SchemaViolation {
  path: string;
  message: string;
}

/** Validate a value against a practical subset of JSON Schema (draft-07-ish). */
export function validateJsonSchema(value: unknown, schema: Record<string, unknown>, path = '$'): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  const declaredType = schema.type as string | string[] | undefined;
  if (declaredType) {
    const types = Array.isArray(declaredType) ? declaredType : [declaredType];
    if (!types.some((t) => matchesType(value, t))) {
      violations.push({ path, message: `expected type ${types.join('|')}, got ${jsType(value)}` });
      return violations; // type mismatch — further checks are noise
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    violations.push({ path, message: `value not in enum` });
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) violations.push({ path: `${path}.${req}`, message: 'missing required property' });
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, subSchema] of Object.entries(props)) {
      if (k in obj) violations.push(...validateJsonSchema(obj[k], subSchema, `${path}.${k}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push({ path, message: `expected at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push({ path, message: `expected at most ${schema.maxItems} items` });
    }
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      value.forEach((item, idx) => violations.push(...validateJsonSchema(item, itemSchema, `${path}[${idx}]`)));
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      violations.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      violations.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      violations.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      violations.push({ path, message: `number below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      violations.push({ path, message: `number above maximum ${schema.maximum}` });
    }
  }

  return violations;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function runJsonSchemaValidate(config: JsonSchemaValidateNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(config.schema) as Record<string, unknown>;
  } catch {
    throw new AgentisError('VALIDATION_FAILED', 'json_schema_validate: schema is not valid JSON');
  }
  const target = readInput(inputData, config.inputPath);
  const violations = validateJsonSchema(target, schema);
  if (violations.length > 0 && config.onViolation === 'block') {
    throw new AgentisError('VALIDATION_FAILED', `json_schema_validate: ${violations.map((v) => `${v.path} ${v.message}`).join('; ')}`);
  }
  return { valid: violations.length === 0, violations, input: inputData };
}

// ── html_extract ────────────────────────────────────────────────────────────

interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlElement[];
  text: string;
  html: string;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Parse HTML into a lightweight element tree (best-effort; tolerant of bad markup). */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [], text: '', html: '' };
  const stack: HtmlElement[] = [root];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const text = html.slice(lastIndex, m.index);
    if (text.trim()) stack[stack.length - 1]!.text += text;
    lastIndex = tagRe.lastIndex;
    const whole = m[0];
    const tag = m[1]!.toLowerCase();
    const isClose = whole.startsWith('</');
    if (whole.startsWith('<!')) continue;
    if (isClose) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.tag === tag) { stack.length = s; break; }
      }
      continue;
    }
    const el: HtmlElement = { tag, attrs: parseAttrs(m[2] ?? ''), children: [], text: '', html: '' };
    stack[stack.length - 1]!.children.push(el);
    if (!VOID_TAGS.has(tag) && !whole.endsWith('/>')) stack.push(el);
  }
  return root;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1]!.toLowerCase();
    attrs[name] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

function textOf(el: HtmlElement): string {
  let out = el.text;
  for (const c of el.children) out += textOf(c);
  return out.replace(/\s+/g, ' ').trim();
}

function innerHtml(el: HtmlElement): string {
  let out = el.text;
  for (const c of el.children) out += outerHtml(c);
  return out;
}

function outerHtml(el: HtmlElement): string {
  const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  if (VOID_TAGS.has(el.tag)) return `<${el.tag}${attrs}>`;
  return `<${el.tag}${attrs}>${innerHtml(el)}</${el.tag}>`;
}

interface SimpleSelector { tag?: string; id?: string; classes: string[]; attr?: { name: string; value?: string }; }

function parseSelector(selector: string): SimpleSelector[] {
  // Descendant combinator only (whitespace). Each token → simple selector.
  return selector.trim().split(/\s+/).map((token) => {
    const sel: SimpleSelector = { classes: [] };
    const attrM = token.match(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/);
    let rest = token;
    if (attrM) {
      sel.attr = { name: attrM[1]!, value: attrM[2] };
      rest = token.slice(0, attrM.index) + token.slice(attrM.index! + attrM[0].length);
    }
    const idM = rest.match(/#([\w-]+)/);
    if (idM) sel.id = idM[1];
    for (const cm of rest.matchAll(/\.([\w-]+)/g)) sel.classes.push(cm[1]!);
    const tagM = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagM) sel.tag = tagM[1]!.toLowerCase();
    return sel;
  });
}

function matchesSimple(el: HtmlElement, sel: SimpleSelector): boolean {
  if (sel.tag && el.tag !== sel.tag) return false;
  if (sel.id && el.attrs.id !== sel.id) return false;
  if (sel.classes.length) {
    const classList = (el.attrs.class ?? '').split(/\s+/);
    if (!sel.classes.every((c) => classList.includes(c))) return false;
  }
  if (sel.attr) {
    if (!(sel.attr.name in el.attrs)) return false;
    if (sel.attr.value !== undefined && el.attrs[sel.attr.name] !== sel.attr.value) return false;
  }
  return true;
}

/** Find all elements matching a (descendant-combinator) selector. */
export function queryAll(root: HtmlElement, selector: string): HtmlElement[] {
  const chain = parseSelector(selector);
  const results: HtmlElement[] = [];
  const walk = (el: HtmlElement, depth: number) => {
    // match the chain ending at el
    if (matchesChain(el, chain)) results.push(el);
    for (const c of el.children) walk(c, depth + 1);
  };
  for (const c of root.children) walk(c, 0);
  return results;
}

function matchesChain(el: HtmlElement, chain: SimpleSelector[]): boolean {
  if (!matchesSimple(el, chain[chain.length - 1]!)) return false;
  // ancestors must satisfy the rest (in order, allowing gaps)
  let parentChain = chain.slice(0, -1);
  if (parentChain.length === 0) return true;
  // Without parent pointers we approximate: a chain match requires the element
  // itself to match the final selector; ancestor selectors are validated during
  // the recursive descent by re-querying from root. For the common single and
  // two-level cases we do an ancestor check via a flattened search.
  return ancestorsSatisfy(el, parentChain);
}

// Ancestor tracking via a parent map computed lazily per query.
const PARENT = new WeakMap<HtmlElement, HtmlElement>();
function indexParents(root: HtmlElement): void {
  for (const c of root.children) { PARENT.set(c, root); indexParents(c); }
}
function ancestorsSatisfy(el: HtmlElement, chain: SimpleSelector[]): boolean {
  let idx = chain.length - 1;
  let cur = PARENT.get(el);
  while (cur && idx >= 0) {
    if (matchesSimple(cur, chain[idx]!)) idx -= 1;
    cur = PARENT.get(cur);
  }
  return idx < 0;
}

export function runHtmlExtract(config: HtmlExtractNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  const html = asString(readInput(inputData, config.inputPath));
  const root = parseHtml(html);
  indexParents(root);
  const matches = queryAll(root, config.selector);
  const extract = (el: HtmlElement): string => {
    if (config.extractAs === 'html') return innerHtml(el).trim();
    if (config.extractAs === 'attribute') return el.attrs[(config.attribute ?? '').toLowerCase()] ?? '';
    return textOf(el);
  };
  const values = matches.map(extract);
  const value = config.multiple ? values : (values[0] ?? null);
  return wrap(config.outputKey, 'extracted', value);
}

// ── sticky_note ───────────────────────────────────────────────────────────────

export function runStickyNote(_config: StickyNoteNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
  // Annotation node: never alters data, just passes input through.
  return inputData;
}

// ── registry wiring ─────────────────────────────────────────────────────────

const datetimeHandler: PureNodeHandler<DateTimeNodeConfig> = {
  kind: 'datetime',
  execute: (config, { inputData }) => runDateTime(config, inputData),
};
const cryptoHandler: PureNodeHandler<CryptoUtilNodeConfig> = {
  kind: 'crypto_util',
  execute: (config, { inputData }) => runCryptoUtil(config, inputData),
};
const xmlHandler: PureNodeHandler<XmlParseNodeConfig> = {
  kind: 'xml_parse',
  execute: (config, { inputData }) => runXmlParse(config, inputData),
};
const markdownHandler: PureNodeHandler<MarkdownNodeConfig> = {
  kind: 'markdown',
  execute: (config, { inputData }) => runMarkdown(config, inputData),
};
const jsonSchemaHandler: PureNodeHandler<JsonSchemaValidateNodeConfig> = {
  kind: 'json_schema_validate',
  execute: (config, { inputData }) => runJsonSchemaValidate(config, inputData),
};
const htmlExtractHandler: PureNodeHandler<HtmlExtractNodeConfig> = {
  kind: 'html_extract',
  execute: (config, { inputData }) => runHtmlExtract(config, inputData),
};
const stickyNoteHandler: PureNodeHandler<StickyNoteNodeConfig> = {
  kind: 'sticky_note',
  execute: (config, { inputData }) => runStickyNote(config, inputData),
};

export function registerUtilityNodeHandlers(registry: NodeHandlerRegistry): void {
  registry.register(datetimeHandler as PureNodeHandler);
  registry.register(cryptoHandler as PureNodeHandler);
  registry.register(xmlHandler as PureNodeHandler);
  registry.register(markdownHandler as PureNodeHandler);
  registry.register(jsonSchemaHandler as PureNodeHandler);
  registry.register(htmlExtractHandler as PureNodeHandler);
  registry.register(stickyNoteHandler as PureNodeHandler);
}
