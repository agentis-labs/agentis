/**
 * Zero-config web search provider — backs the `web_search` agent tool.
 *
 * Closes a platform hole: `web_search` is advertised in every specialist's
 * toolbox (DEFAULT_SPECIALIST_TOOLS), yet no provider was ever wired, so every
 * agent that reached for it failed with "web_search provider is not configured".
 * Discovery tasks ("find clothing stores on Instagram") were therefore impossible
 * even though the agent correctly chose to search.
 *
 * Design: NO API key required (agentis DNA — zero-config). It drives DuckDuckGo's
 * HTML endpoint, which is scrape-tolerant, and returns a compact, model-friendly
 * result list. An operator who wants a premium engine can set WEB_SEARCH_API_URL
 * (an OpenAI/Brave-style JSON endpoint) + WEB_SEARCH_API_KEY and we use that
 * instead. Either way the agent's `web_search` tool now actually works.
 */

import type { Logger } from '../logger.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  provider: 'duckduckgo' | 'api';
}

export type WebSearchProvider = (query: string) => Promise<WebSearchResponse>;

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_RESULTS = 8;

/**
 * Build the provider the engine wires into AgentToolRuntime. Prefers a configured
 * JSON search API (env), else the zero-config DuckDuckGo HTML scrape.
 */
export function createWebSearchProvider(logger?: Logger): WebSearchProvider {
  const apiUrl = process.env.WEB_SEARCH_API_URL?.trim();
  const apiKey = process.env.WEB_SEARCH_API_KEY?.trim();
  return async (query: string): Promise<WebSearchResponse> => {
    const q = (query ?? '').trim();
    if (!q) return { query: q, results: [], provider: apiUrl ? 'api' : 'duckduckgo' };
    if (apiUrl) {
      try {
        return await searchViaApi(apiUrl, apiKey, q);
      } catch (err) {
        logger?.warn?.('webSearch.api_failed', { error: (err as Error).message });
        // fall through to the zero-config engine rather than failing the tool
      }
    }
    return await searchViaDuckDuckGo(q);
  };
}

async function searchViaDuckDuckGo(query: string): Promise<WebSearchResponse> {
  const res = await fetch(`${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
  const html = await res.text();
  return { query, results: parseDuckDuckGoHtml(html).slice(0, MAX_RESULTS), provider: 'duckduckgo' };
}

async function searchViaApi(apiUrl: string, apiKey: string | undefined, query: string): Promise<WebSearchResponse> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ query, max_results: MAX_RESULTS }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`web search API HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const results: WebSearchResult[] = (body.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: String(r.title ?? r.name ?? ''),
    url: String(r.url ?? r.link ?? ''),
    snippet: String(r.snippet ?? r.description ?? r.content ?? ''),
  }));
  return { query, results, provider: 'api' };
}

/**
 * Parse DuckDuckGo HTML results into a clean list. Exposed for unit testing —
 * the HTML shape is the brittle part, so it gets direct coverage.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const linkRe = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (let sm = snippetRe.exec(html); sm; sm = snippetRe.exec(html)) snippets.push(decodeText(sm[1]!));

  const results: WebSearchResult[] = [];
  let index = 0;
  for (let m = linkRe.exec(html); m; m = linkRe.exec(html)) {
    const url = decodeDdgHref(m[1]!);
    const title = decodeText(m[2]!);
    if (url && title) results.push({ title, url, snippet: snippets[index] ?? '' });
    index += 1;
  }
  return results;
}

/** DuckDuckGo wraps result URLs in a redirect: `//duckduckgo.com/l/?uddg=<encoded>&…`. */
function decodeDdgHref(href: string): string {
  const trimmed = href.trim();
  const uddg = trimmed.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith('http')) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return '';
}

/**
 * Decode entities FIRST, then strip tags — DDG escapes the term-highlight markup
 * inside snippets as `&lt;b&gt;…&lt;/b&gt;`, so decoding before stripping removes
 * those (and any real markup) instead of leaving a literal `<b>` behind.
 */
function decodeText(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
