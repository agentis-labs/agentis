import { describe, expect, it } from 'vitest';
import { parseFeedItems } from '../../src/engine/listener/sources.js';

describe('parseFeedItems', () => {
  it('parses RSS 2.0 items', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>First</title><link>https://x/1</link><guid>g1</guid><pubDate>Mon, 01 Jan 2026</pubDate></item>
      <item><title>Second</title><link>https://x/2</link><guid>g2</guid></item>
    </channel></rss>`;
    const items = parseFeedItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: 'First', link: 'https://x/1', guid: 'g1', id: 'g1' });
    expect(items[1]!.title).toBe('Second');
  });

  it('parses Atom entries with link href + CDATA', () => {
    const xml = `<feed>
      <entry><title>Hello</title><id>urn:1</id><link href="https://x/a"/><summary><![CDATA[<b>rich</b> text]]></summary></entry>
    </feed>`;
    const items = parseFeedItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Hello', id: 'urn:1', link: 'https://x/a' });
    expect(items[0]!.description).toBe('rich text');
  });

  it('returns an empty array for a feed with no items', () => {
    expect(parseFeedItems('<rss><channel></channel></rss>')).toHaveLength(0);
  });
});
