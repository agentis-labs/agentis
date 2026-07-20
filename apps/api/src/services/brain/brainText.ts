const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'i', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'were', 'will', 'with', 'you', 'your', 'we', 'our', 'they', 'them', 'these',
  'those', 'do', 'does', 'did', 'if', 'then', 'than', 'so', 'too', 'can', 'could', 'would',
  'should', 'about', 'after', 'before', 'between', 'during', 'over', 'under', 'out', 'off',
]);

export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Scripts with no whitespace word boundaries — segmented per-character. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_GLOBAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** True for a token that is CJK — length policies must exempt these (1 char is a word). */
export function isCjkToken(token: string): boolean {
  return CJK.test(token);
}

/**
 * Split text into word tokens, applying NO length or stop-word policy.
 *
 * This is the one piece every tokenizer in the brain needs to share: the
 * SEGMENTATION. Five call sites each carried their own `[^a-z0-9]` split, so a
 * fix to one never reached the others and non-Latin text was destroyed before
 * any gate could judge it. Filtering policy legitimately differs per call site
 * (chunk matching wants stop-words, memory keys do not), so policy stays with
 * the caller and only segmentation is shared.
 *
 * Unicode-aware: \p{L}/\p{N} cover any script (ASCII a-z0-9 unchanged), so
 * accented/non-Latin words tokenize instead of being dropped. CJK has no word
 * boundaries, so each ideograph/kana/hangul is isolated into its own token —
 * otherwise a whole CJK sentence is one un-tokenizable (or undroppable) blob,
 * which is exactly why CJK personas formed almost no memory.
 */
export function segment(input: string): string[] {
  const spaced = input.toLowerCase().replace(CJK_GLOBAL, (ch) => ` ${ch} `);
  return spaced.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function tokenize(input: string): string[] {
  return segment(input).filter((token) => isCjkToken(token) || (token.length > 2 && !STOP_WORDS.has(token)));
}

export function normalizeTextKey(input: string): string {
  return tokenize(input).slice(0, 16).join(' ');
}

/**
 * §B5.3 — single home for the "this text looks sensitive" guard. Detects emails,
 * common API-key/token shapes, and US SSN-shaped numbers. Was duplicated
 * verbatim in brainFormation + chatMemoryCapture; both now import this.
 */
export function looksSensitive(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_-]{16,}\b/.test(text)
    || /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/.test(text);
}

/**
 * §B6.2 — REDACT personal data instead of dropping the statement.
 *
 * `looksSensitive` is a binary gate: it throws away the whole statement, which
 * is right for an operator's own secret but wrong for an external contact,
 * where the sentence is exactly the thing worth learning from and only the
 * identifiers inside it are hazardous. ("Meu cartão 4111 1111 1111 1111 não
 * passou no checkout" is a valuable payment-failure signal and a card number.)
 *
 * There was no redactor in the codebase at all — only this drop filter — so
 * every phone number, address and card number an external sender typed was
 * stored verbatim in the graph.
 *
 * Conservative by construction: it removes identifiers and keeps prose. It is
 * NOT a compliance boundary — it is defence in depth behind scoping, and new
 * shapes should be added here rather than in a second copy.
 */
export function redactForMemory(text: string): string {
  return text
    // Card numbers. Matched by their 4-digit GROUPING rather than "13–19 digits
    // in a row", which also swallowed international phone numbers
    // ("+55 11 98765 4321" is 13 digits) and reported them as cards. The
    // lookbehind keeps a leading `+` — i.e. a dialling code — out of the match.
    .replace(/(?<![+\d])(?:\d{4}[ -]?){3}\d{1,7}(?![\d])/g, '[redacted:card]')
    // IBAN.
    .replace(/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, '[redacted:iban]')
    // US SSN.
    .replace(/\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g, '[redacted:ssn]')
    // Brazilian CPF / CNPJ.
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[redacted:cpf]')
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[redacted:cnpj]')
    // Email.
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted:email]')
    // API keys / tokens.
    .replace(/\b(?:sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_-]{16,}\b/g, '[redacted:token]')
    // Phone numbers — international or grouped, 9+ digits so years/quantities survive.
    .replace(/\+?\d[\d\s().-]{8,}\d/g, (match) => (
      (match.match(/\d/g) ?? []).length >= 9 ? '[redacted:phone]' : match
    ))
    // Street addresses (number + street-type keyword, EN/PT/ES).
    .replace(
      /\b\d{1,5}\s+[\w\s.]{2,40}?\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|rua|avenida|av|calle|carrera)\b\.?/gi,
      '[redacted:address]',
    );
}

export function scoreText(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenize(text));
  if (textTokens.size === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) hits += 1;
  }
  return hits / Math.max(1, Math.min(queryTokens.size, textTokens.size));
}
/**
 * Prohibition markers. Multilingual (§B5.5) because polarity is the ONLY signal
 * that separates a correction from a duplicate — embeddings cannot do it.
 * Measured: "sempre faça deploy na sexta" vs "nunca faça deploy na sexta" scores
 * cosine 0.9763, the HIGHEST pair in the calibration set — above every true
 * duplicate. While this list was English-only, a Portuguese correction was
 * swallowed as a reinforcement of the very rule it overturned.
 */
const NEGATIVE_DIRECTIVES = [
  // English
  'never', 'avoid', 'do not', "don't", 'dont', 'must not', 'should not', 'stop', 'disallow', 'forbid',
  // Portuguese / Spanish
  'nunca', 'jamais', 'jamás', 'não', 'nao', 'evite', 'evitar', 'proibido', 'prohibido', 'evita',
  // French / Italian
  'ne pas', 'éviter', 'interdit', 'mai', 'evitare', 'vietato',
  // German
  'nie', 'niemals', 'nicht', 'vermeiden', 'untersagt',
  // Russian
  'никогда', 'не', 'нельзя', 'запрещено',
  // Chinese / Japanese / Korean
  '不要', '禁止', '切勿', '勿', '别', '不得', 'しない', 'ないで', '決して', '하지', '금지', '절대',
];

/**
 * Positive directive markers. Deliberately NOT the generic "do"/"use" — too
 * noisy ("do it off-peak" is not a positive directive about the subject).
 */
const POSITIVE_DIRECTIVES = [
  'always', 'must', 'ensure', 'require', 'prefer', 'should',
  'sempre', 'siempre', 'deve', 'debe', 'garanta', 'prefira', 'obrigatório', 'obligatorio',
  'toujours', 'doit', 'obligatoire', 'assicurati', 'obbligatorio',
  'immer', 'muss', 'erforderlich',
  'всегда', 'должен', 'обязательно',
  '必须', '务必', '总是', '始终', '必ず', '常に', '항상', '반드시',
];

const CJK_MARKER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count marker occurrences with Unicode-safe boundaries.
 *
 * `\b` in JS is ASCII-word based, so it never fires correctly around Cyrillic or
 * accented Latin — the reason a naive port of the English list to other scripts
 * silently matches nothing (or matches inside unrelated words, e.g. Russian "не"
 * inside "неделя"). CJK has no word boundaries at all, so those markers are
 * matched as plain substrings.
 */
function countMarkers(lower: string, markers: string[]): number {
  let count = 0;
  for (const marker of markers) {
    const pattern = CJK_MARKER.test(marker)
      ? escapeRe(marker)
      : `(?<![\\p{L}\\p{N}])${escapeRe(marker)}(?![\\p{L}\\p{N}])`;
    count += (lower.match(new RegExp(pattern, 'gu')) ?? []).length;
  }
  return count;
}

/**
 * §C3 — directive polarity of a rule: +1 = positive directive (always/must/
 * prefer/ensure), −1 = prohibition (never/avoid/do not/don't/stop), 0 = none or
 * mixed (ambiguous). Two same-topic rules with opposite polarity contradict.
 */
export function directivePolarity(text: string): -1 | 0 | 1 {
  const lower = text.toLowerCase();
  // Prohibitions first (so "do not"/"must not" aren't double-counted as positive).
  const neg = countMarkers(lower, NEGATIVE_DIRECTIVES);
  const pos = countMarkers(lower, POSITIVE_DIRECTIVES)
    - countMarkers(lower, ['must not', 'should not']);
  if (pos > neg) return 1;
  if (neg > pos) return -1;
  return 0;
}

/**
 * Topic signature for comparing directives after polarity has been classified.
 * Modal/prohibition tokens describe whether a rule permits or forbids an action;
 * retaining them in the topic signature makes opposite rules look artificially
 * unrelated (for example, "always escalate" versus "do not escalate").
 */
export function directiveTopicSignature(text: string): Set<string> {
  // Multilingual (§B5.5) — matching NEGATIVE/POSITIVE_DIRECTIVES so a Portuguese
  // "sempre X" and "nunca X" reduce to the same topic and are recognised as the
  // same subject, exactly as the English pair already was.
  const polarityTokens = new Set([
    'always', 'never', 'avoid', 'not', 'dont', 'must', 'should', 'ensure',
    'require', 'prefer', 'stop', 'disallow', 'forbid',
    'sempre', 'siempre', 'nunca', 'jamais', 'jamás', 'não', 'nao', 'evite', 'evitar',
    'proibido', 'prohibido', 'evita', 'deve', 'debe', 'garanta', 'prefira',
    'toujours', 'jamais', 'doit', 'éviter', 'interdit', 'mai', 'evitare', 'vietato',
    'immer', 'nie', 'niemals', 'nicht', 'muss', 'vermeiden',
    'всегда', 'никогда', 'не', 'нельзя', 'должен', 'обязательно', 'запрещено',
  ]);
  return new Set(tokenize(text).filter((token) => !polarityTokens.has(token)).slice(0, 24));
}

