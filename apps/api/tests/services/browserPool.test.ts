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
});
