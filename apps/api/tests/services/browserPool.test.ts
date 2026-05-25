/**
 * BrowserPool — native Playwright runtime (Layer 3 §3.2).
 *
 * Exercises a real headless Chromium render. Chromium is installed on demand by
 * ensureReady(); the generous timeout covers a cold first-run install.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserPool } from '../../src/services/browserPool.js';
import { createLogger } from '../../src/logger.js';

const pool = new BrowserPool(createLogger({ level: 'error' }));

afterAll(async () => {
  await pool.shutdown();
});

describe('BrowserPool', () => {
  it('renders inline HTML to a PNG screenshot', async () => {
    const png = await pool.screenshot({ html: '<h1>Hello World</h1>', fullPage: true });
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
    // PNG magic bytes: 89 50 4E 47.
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  }, 180_000);

  it('extracts visible text from inline HTML', async () => {
    const text = await pool.navigate({ html: '<main><h1>Title</h1><p>Body copy.</p></main>' });
    expect(text.title).toBeDefined();
    expect(text.text).toMatch(/Body copy/);
  }, 60_000);

  it('extracts a table into row objects', async () => {
    const html = '<table><tr><th>Name</th><th>Score</th></tr><tr><td>Ada</td><td>99</td></tr><tr><td>Linus</td><td>87</td></tr></table>';
    const rows = await pool.extractTable({ html });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: 'Ada', Score: '99' });
    expect(rows[1]!.Name).toBe('Linus');
  }, 60_000);

  it('fills a form and reads the value back', async () => {
    const html = '<form><input id="email" value="" /></form>';
    const r = await pool.fillForm({ html, formData: { '#email': 'ada@lovelace.dev' } });
    expect(r.values['#email']).toBe('ada@lovelace.dev');
  }, 60_000);
});
