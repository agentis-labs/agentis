import { describe, expect, it } from 'vitest';
import { resolveTelegramInboundBody } from '../../src/adapters/channels/telegramSession.js';

describe('resolveTelegramInboundBody', () => {
  it('persists and understands the largest inbound photo without a second download', async () => {
    let downloads = 0;
    const body = await resolveTelegramInboundBody(
      { photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: 'What is this?' },
      {
        downloadFile: async (id) => { downloads += 1; return Buffer.from(id); },
        persistMedia: async (media) => `artifact:${media.bytes.toString()}`,
        describeImage: async (bytes) => `image ${bytes.toString()}`,
      },
    );
    expect(downloads).toBe(1);
    expect(body).toContain('Attachment: artifact:large');
    expect(body).toContain('Visual analysis: image large');
  });

  it('transcribes voice notes and retains their artifact reference', async () => {
    const body = await resolveTelegramInboundBody(
      { voice: { file_id: 'voice', mime_type: 'audio/ogg' } },
      {
        downloadFile: async () => Buffer.from('audio'),
        persistMedia: async () => 'artifact:voice',
        transcribeAudio: async () => 'hello from voice',
      },
    );
    expect(body).toContain('Transcript:\nhello from voice');
    expect(body).toContain('Attachment: artifact:voice');
  });

  it('normalizes location, venue, contact, poll, GIF, document, and sticker messages', async () => {
    expect(await resolveTelegramInboundBody({ location: { latitude: -19.9, longitude: -43.9 } }))
      .toContain('https://maps.google.com/?q=-19.9,-43.9');
    expect(await resolveTelegramInboundBody({ venue: { title: 'Talki', address: 'BH', location: { latitude: 1, longitude: 2 } } }))
      .toContain('Name: Talki');
    expect(await resolveTelegramInboundBody({ contact: { first_name: 'Bia', phone_number: '+5531' } }))
      .toContain('Phone: +5531');
    expect(await resolveTelegramInboundBody({ poll: { question: 'Choose', options: [{ text: 'A' }] } }))
      .toContain('1. A');
    expect(await resolveTelegramInboundBody(
      { animation: { file_id: 'gif', mime_type: 'video/mp4' } },
      { downloadFile: async () => Buffer.from('gif'), persistMedia: async () => 'artifact:gif' },
    )).toContain('[Animated GIF received]');
    expect(await resolveTelegramInboundBody(
      { document: { file_id: 'doc', mime_type: 'application/pdf', file_name: 'proposal.pdf' } },
      { downloadFile: async () => Buffer.from('pdf'), extractDocument: async () => 'Proposal text' },
    )).toContain('Proposal text');
    expect(await resolveTelegramInboundBody(
      { sticker: { file_id: 'sticker' } },
      { downloadFile: async () => Buffer.from('webp'), persistMedia: async () => 'artifact:sticker' },
    )).toContain('[Sticker received]');
  });
});
