/**
 * extractWhatsAppText — the text extractor ported from OpenClaw's baileys
 * `extract.ts`. Pure function: no socket, no baileys runtime needed.
 */

import { describe, expect, it } from 'vitest';
import { extractWhatsAppText, unwrapAudioMessage, unwrapImageMessage, unwrapDocumentMessage } from '../../src/adapters/channels/whatsappSession.js';

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
