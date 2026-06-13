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

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .match(/[a-z0-9_]+/g)?.filter((token) => token.length > 2 && !STOP_WORDS.has(token)) ?? [];
}

export function normalizeTextKey(input: string): string {
  return tokenize(input).slice(0, 16).join(' ');
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
