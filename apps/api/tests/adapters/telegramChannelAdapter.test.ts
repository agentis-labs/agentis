/**
 * TelegramChannelAdapter — unit tests (Batch 4 / D35).
 *
 * Exercises verify() constant-time secret_token check, parseInbound() parsing
 * of Telegram update shapes, and send() URL/body construction via a stubbed
 * fetch (no network).
 */
import { describe, it, expect } from 'vitest';
import { TelegramChannelAdapter, resolveTelegramTransport } from '../../src/adapters/channels/telegram.js';

describe('resolveTelegramTransport()', () => {
  it('defaults to long polling on a local install with no public URL (zero-config)', () => {
    expect(resolveTelegramTransport({ hasPublicUrl: false })).toBe('polling');
    expect(resolveTelegramTransport({ explicit: null, hasPublicUrl: false })).toBe('polling');
  });

  it('defaults to webhook when a public URL is configured', () => {
    expect(resolveTelegramTransport({ hasPublicUrl: true })).toBe('webhook');
  });

  it('honours an explicit operator choice regardless of public URL', () => {
    expect(resolveTelegramTransport({ explicit: 'webhook', hasPublicUrl: false })).toBe('webhook');
    expect(resolveTelegramTransport({ explicit: 'polling', hasPublicUrl: true })).toBe('polling');
  });
});

describe('TelegramChannelAdapter', () => {
  describe('verify()', () => {
    it('fails closed when no secret is configured (unauthenticated inbound is rejected)', () => {
      const a = new TelegramChannelAdapter();
      expect(a.verify({ headers: {}, rawBody: '', secret: null })).toBe(false);
      // Even with an attacker-supplied header, no configured secret = reject.
      expect(a.verify({ headers: { 'x-telegram-bot-api-secret-token': 'anything' }, rawBody: '', secret: null })).toBe(false);
    });

    it('returns true when the X-Telegram-Bot-Api-Secret-Token header matches', () => {
      const a = new TelegramChannelAdapter();
      expect(
        a.verify({
          headers: { 'x-telegram-bot-api-secret-token': 'shh' },
          rawBody: '',
          secret: 'shh',
        }),
      ).toBe(true);
    });

    it('returns false on mismatch / missing header', () => {
      const a = new TelegramChannelAdapter();
      expect(
        a.verify({ headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, rawBody: '', secret: 'shh' }),
      ).toBe(false);
      expect(a.verify({ headers: {}, rawBody: '', secret: 'shh' })).toBe(false);
    });
  });

  describe('parseInbound()', () => {
    it('extracts text + chat id + from-name from a typical message update', () => {
      const a = new TelegramChannelAdapter();
      const body = JSON.stringify({
        update_id: 100,
        message: {
          text: 'hi',
          chat: { id: 999 },
          from: { id: 7, first_name: 'Alice', last_name: 'Liddell' },
        },
      });
      const result = a.parseInbound({ rawBody: body, headers: {} });
      expect(result).toEqual({
        externalId: 'telegram:100',
        chatId: '999',
        body: 'hi',
        from: 'Alice Liddell',
      });
    });

    it('returns null for non-text updates (e.g. status pings)', () => {
      const a = new TelegramChannelAdapter();
      expect(a.parseInbound({ rawBody: JSON.stringify({ update_id: 1 }), headers: {} })).toBeNull();
    });

    it('throws VALIDATION_FAILED on non-JSON body', () => {
      const a = new TelegramChannelAdapter();
      expect(() => a.parseInbound({ rawBody: 'not json', headers: {} })).toThrow(/VALIDATION_FAILED|JSON/i);
    });
  });

  describe('send()', () => {
    it('POSTs to api.telegram.org/bot<token>/sendMessage with chat_id+text', async () => {
      const a = new TelegramChannelAdapter();
      const calls: Array<{ url: string; init: RequestInit }> = [];
      a.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response('{"ok":true,"result":{"message_id":42}}', { status: 200 });
      }) as typeof fetch;
      await a.send({ token: 'bot123', chatId: '999', body: 'hello' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.telegram.org/botbot123/sendMessage');
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ chat_id: '999', text: 'hello' });
    });

    it('throws CHANNEL_SEND_FAILED on non-2xx', async () => {
      const a = new TelegramChannelAdapter();
      a.fetchImpl = (async () => new Response('{"ok":false}', { status: 401 })) as typeof fetch;
      await expect(a.send({ token: 'x', chatId: '1', body: 'h' })).rejects.toMatchObject({
        code: 'CHANNEL_SEND_FAILED',
      });
    });

    it('turns Telegram "chat not found" into an actionable message', async () => {
      const a = new TelegramChannelAdapter();
      a.fetchImpl = (async () =>
        new Response('{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}', {
          status: 400,
        })) as typeof fetch;
      await expect(a.send({ token: 'x', chatId: '7905735992', body: 'h' })).rejects.toMatchObject({
        code: 'CHANNEL_SEND_FAILED',
        message: expect.stringMatching(/chat not found[\s\S]*7905735992[\s\S]*bot first/i),
      });
    });
  });
});
