/**
 * extractWhatsAppText — the text extractor ported from OpenClaw's baileys
 * `extract.ts`. Pure function: no socket, no baileys runtime needed.
 */

import { describe, expect, it } from 'vitest';
import { classifyWhatsAppReconnect, extractWhatsAppText, resolveWhatsAppInboundBody, unwrapAudioMessage, unwrapImageMessage, unwrapDocumentMessage, whatsappMediaContent } from '../../src/adapters/channels/whatsappSession.js';
import type { OutboundAttachment } from '../../src/adapters/channels/types.js';

describe('whatsappMediaContent', () => {
  const base = (kind: OutboundAttachment['kind'], over: Partial<OutboundAttachment> = {}): OutboundAttachment => ({
    kind, filename: `f.${kind}`, mimeType: over.mimeType ?? '', data: Buffer.from('x'), ...over,
  });

  it('builds an image with caption + viewOnce', () => {
    const c = whatsappMediaContent(base('image', { viewOnce: true }), 'hi');
    expect(c.image).toBeInstanceOf(Buffer);
    expect(c.caption).toBe('hi');
    expect(c.viewOnce).toBe(true);
  });

  it('builds a video with gifPlayback', () => {
    const c = whatsappMediaContent(base('video', { gifPlayback: true, seconds: 3 }), 'clip');
    expect(c.video).toBeInstanceOf(Buffer);
    expect(c.gifPlayback).toBe(true);
    expect(c.seconds).toBe(3);
    expect(c.caption).toBe('clip');
  });

  it('builds a voice note as ptt audio with an opus default mimetype', () => {
    const c = whatsappMediaContent(base('voice'));
    expect(c.audio).toBeInstanceOf(Buffer);
    expect(c.ptt).toBe(true);
    expect(c.mimetype).toContain('opus');
  });

  it('builds an audio track (not ptt)', () => {
    const c = whatsappMediaContent(base('audio', { mimeType: 'audio/mpeg' }));
    expect(c.audio).toBeInstanceOf(Buffer);
    expect(c.ptt).toBeUndefined();
    expect(c.mimetype).toBe('audio/mpeg');
  });

  it('builds a sticker (no caption)', () => {
    const c = whatsappMediaContent(base('sticker'), 'ignored');
    expect(c.sticker).toBeInstanceOf(Buffer);
    expect(c.caption).toBeUndefined();
  });

  it('builds a document with filename + caption, falling back to per-attachment caption', () => {
    const c = whatsappMediaContent(base('file', { filename: 'report.pdf', mimeType: 'application/pdf', caption: 'q3' }));
    expect(c.document).toBeInstanceOf(Buffer);
    expect(c.fileName).toBe('report.pdf');
    expect(c.caption).toBe('q3');
  });
});

describe('resolveWhatsAppInboundBody', () => {
  it('describes an image even when it already has a caption', async () => {
    const body = await resolveWhatsAppInboundBody(
      { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'Sabe o que e isto?' } } },
      {
        downloadMedia: async () => Buffer.from('image'),
        describeImage: async (_bytes, _mime, caption) => `A workflow canvas. Sender asks: ${caption}`,
      },
    );
    expect(body).toContain('Caption: Sabe o que e isto?');
    expect(body).toContain('Visual analysis: A workflow canvas.');
  });

  it('keeps a voice note actionable when transcription is unavailable', async () => {
    const body = await resolveWhatsAppInboundBody({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } });
    expect(body).toContain('Voice note received');
    expect(body).toContain('Transcription is unavailable');
  });

  it('passes a downloaded voice note to transcription', async () => {
    const body = await resolveWhatsAppInboundBody(
      { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } },
      {
        downloadMedia: async () => Buffer.from('voice'),
        transcribeAudio: async (bytes, mime) => `${bytes.toString()}:${mime}`,
      },
    );
    expect(body).toBe('[Voice note transcript]\nvoice:audio/ogg; codecs=opus');
  });
});

describe('classifyWhatsAppReconnect', () => {
  it('uses stable, reason-specific recovery classes without exposing provider details to chat', () => {
    expect(classifyWhatsAppReconnect(408)).toBe('connection_lost');
    expect(classifyWhatsAppReconnect(440)).toBe('session_conflict');
    expect(classifyWhatsAppReconnect(503)).toBe('service_unavailable');
    expect(classifyWhatsAppReconnect(515)).toBe('restart_required');
    expect(classifyWhatsAppReconnect(undefined)).toBe('connection_closed');
  });
});

describe('extractWhatsAppText', () => {
  it('reads a plain conversation message', () => {
    expect(extractWhatsAppText({ conversation: 'hello there' })).toBe('hello there');
  });

  it('reads extendedTextMessage text', () => {
    expect(extractWhatsAppText({ extendedTextMessage: { text: 'with link https://x.com' } }))
      .toBe('with link https://x.com');
  });

  it('reads an image caption', () => {
    expect(extractWhatsAppText({ imageMessage: { caption: 'look at this' } })).toBe('look at this');
  });

  it('unwraps ephemeral wrappers', () => {
    expect(extractWhatsAppText({ ephemeralMessage: { message: { conversation: 'secret' } } })).toBe('secret');
  });

  it('unwraps viewOnce wrappers', () => {
    expect(extractWhatsAppText({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'once' } } } })).toBe('once');
  });

  it('returns undefined for non-text / empty messages', () => {
    expect(extractWhatsAppText(undefined)).toBeUndefined();
    expect(extractWhatsAppText({})).toBeUndefined();
    expect(extractWhatsAppText({ audioMessage: { seconds: 3 } })).toBeUndefined();
    expect(extractWhatsAppText({ conversation: '   ' })).toBeUndefined();
  });
});

describe('unwrapAudioMessage', () => {
  it('finds an audio message directly and through wrappers', () => {
    expect(unwrapAudioMessage({ audioMessage: { mimetype: 'audio/ogg' } })?.mimetype).toBe('audio/ogg');
    expect(unwrapAudioMessage({ ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } } })?.mimetype)
      .toBe('audio/ogg; codecs=opus');
  });

  it('returns undefined when there is no audio', () => {
    expect(unwrapAudioMessage({ conversation: 'hi' })).toBeUndefined();
    expect(unwrapAudioMessage(undefined)).toBeUndefined();
  });
});

describe('unwrapImageMessage', () => {
  it('finds an image directly, through wrappers, and image-mime documents', () => {
    expect(unwrapImageMessage({ imageMessage: { mimetype: 'image/jpeg', caption: 'hi' } })?.caption).toBe('hi');
    expect(unwrapImageMessage({ ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png' } } } })?.mimetype).toBe('image/png');
    expect(unwrapImageMessage({ documentMessage: { mimetype: 'image/webp' } })?.mimetype).toBe('image/webp');
  });

  it('ignores non-image documents and text', () => {
    expect(unwrapImageMessage({ documentMessage: { mimetype: 'application/pdf' } })).toBeUndefined();
    expect(unwrapImageMessage({ conversation: 'hi' })).toBeUndefined();
  });
});

describe('unwrapDocumentMessage', () => {
  it('finds non-image documents (incl. through wrappers) and ignores images', () => {
    expect(unwrapDocumentMessage({ documentMessage: { mimetype: 'application/pdf', fileName: 'r.pdf' } })?.fileName).toBe('r.pdf');
    expect(unwrapDocumentMessage({ ephemeralMessage: { message: { documentMessage: { mimetype: 'text/plain' } } } })?.mimetype).toBe('text/plain');
    // An image-mime document is handled by the image path, not here.
    expect(unwrapDocumentMessage({ documentMessage: { mimetype: 'image/png' } })).toBeUndefined();
    expect(unwrapDocumentMessage({ conversation: 'hi' })).toBeUndefined();
  });
});
