import { describe, it, expect } from 'vitest';
import { parseDuckDuckGoHtml } from '../../src/services/webSearch.js';

// A trimmed but representative slice of DuckDuckGo's HTML result markup.
const SAMPLE = `
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fmodadahora%2F&rut=abc">Moda da Hora &amp; Co</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fmodadahora%2F">Loja de roupas femininas em &lt;b&gt;São Paulo&lt;/b&gt;. WhatsApp na bio.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstore">Example Store</a>
    </h2>
    <a class="result__snippet">A second result without a redirect wrapper on the snippet.</a>
  </div>
</div>`;

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, decoded URL, and snippet from DDG result markup', () => {
    const results = parseDuckDuckGoHtml(SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Moda da Hora & Co',
      url: 'https://www.instagram.com/modadahora/',
      snippet: 'Loja de roupas femininas em São Paulo. WhatsApp na bio.',
    });
    expect(results[1]!.title).toBe('Example Store');
    expect(results[1]!.url).toBe('https://example.com/store');
  });

  it('returns [] for markup with no results (never throws)', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>')).toEqual([]);
  });
});
