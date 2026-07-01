import { describe, it, expect } from 'vitest';
import { resolveChannelAccess, normalizeHandle, buildAccessAddendum } from '../../src/services/channelAccess.js';

describe('normalizeHandle', () => {
  it('reduces phone/jids to digits regardless of formatting', () => {
    expect(normalizeHandle('+55 31 9 5975237')).toBe('553195975237');
    expect(normalizeHandle('553195975237@s.whatsapp.net')).toBe('553195975237');
    expect(normalizeHandle('553195975237:16@s.whatsapp.net')).toBe('553195975237');
    expect(normalizeHandle('8271269949')).toBe('8271269949');
  });
  it('keeps usernames as lowercased text', () => {
    expect(normalizeHandle('@Robson')).toBe('robson');
    expect(normalizeHandle('U01ABC23')).toBe('u01abc23');
  });
});

describe('resolveChannelAccess', () => {
  const owner = '553195975237@s.whatsapp.net';

  it('is open when no access is configured (back-compat)', () => {
    const d = resolveChannelAccess({ senderHandle: 'anyone@s.whatsapp.net' });
    expect(d.allow).toBe(true);
    expect(d.isOwner).toBe(false);
  });

  it('treats the default recipient as the owner — full trust, no rules', () => {
    const d = resolveChannelAccess({
      access: { recipients: [], answerAnyone: false },
      defaultChatId: owner,
      senderHandle: owner,
      senderName: 'Robson',
    });
    expect(d.allow).toBe(true);
    expect(d.isOwner).toBe(true);
    expect(buildAccessAddendum(d)).toBeNull();
  });

  it('applies a listed recipient’s rules', () => {
    const d = resolveChannelAccess({
      access: { recipients: [{ handle: '+55 11 98888 7777', name: 'Maria', rules: 'Assistant. No money.' }] },
      defaultChatId: owner,
      senderHandle: '5511988887777@s.whatsapp.net',
    });
    expect(d.allow).toBe(true);
    expect(d.isOwner).toBe(false);
    expect(d.rules).toBe('Assistant. No money.');
    expect(buildAccessAddendum(d)).toContain('Maria');
    expect(buildAccessAddendum(d)).toContain('No money');
  });

  it('answers strangers with anyoneRules when answerAnyone is on', () => {
    const d = resolveChannelAccess({
      access: { recipients: [], answerAnyone: true, anyoneRules: 'Take a message.' },
      defaultChatId: owner,
      senderHandle: '999@s.whatsapp.net',
      senderName: 'Stranger',
    });
    expect(d.allow).toBe(true);
    expect(d.rules).toBe('Take a message.');
    expect(buildAccessAddendum(d)).toContain('Take a message');
  });

  it('blocks unknown senders when answerAnyone is off (decline by default)', () => {
    const d = resolveChannelAccess({
      access: { recipients: [], answerAnyone: false },
      defaultChatId: owner,
      senderHandle: '999@s.whatsapp.net',
    });
    expect(d.allow).toBe(false);
    expect(d.deny).toBe('decline');
  });

  it('honors ignore as the unknown-sender policy', () => {
    const d = resolveChannelAccess({
      access: { recipients: [], answerAnyone: false, unknownReply: 'ignore' },
      defaultChatId: owner,
      senderHandle: '999@s.whatsapp.net',
    });
    expect(d.allow).toBe(false);
    expect(d.deny).toBe('ignore');
  });

  it('falls back to a conservative default when an allowed stranger has no rules', () => {
    const d = resolveChannelAccess({
      access: { recipients: [], answerAnyone: true },
      defaultChatId: owner,
      senderHandle: '999@s.whatsapp.net',
    });
    expect(d.allow).toBe(true);
    expect(buildAccessAddendum(d)).toContain('do not reveal private');
  });
});
