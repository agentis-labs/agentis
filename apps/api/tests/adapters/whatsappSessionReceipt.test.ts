import { describe, expect, it } from 'vitest';
import { whatsappDeliverySignal, whatsappDeliveryStatus, whatsappReachoutRestrictionScope } from '../../src/adapters/channels/whatsappSession.js';

describe('WhatsApp provider acknowledgement mapping', () => {
  it.each([
    [undefined, 'queued'],
    [0, 'queued'],
    [1, 'queued'],
    [2, 'accepted'],
    [3, 'delivered'],
    [4, 'read'],
    [5, 'read'],
  ] as const)('maps provider status %s to %s', (providerStatus, expected) => {
    expect(whatsappDeliveryStatus(providerStatus)).toBe(expected);
  });
});

describe('WhatsApp provider rejection mapping', () => {
  it('preserves a Baileys status=0 provider error instead of treating it as a missing ack', () => {
    expect(whatsappDeliverySignal({ status: 0, messageStubParameters: ['463'] })).toEqual({
      status: 0,
      errorCode: '463',
      error: expect.stringMatching(/restrict/i),
    });
  });

  it('does not invent a rejection for the ordinary pending status', () => {
    expect(whatsappDeliverySignal({ status: 1 })).toEqual({ status: 1 });
    expect(whatsappDeliverySignal({ status: 0 })).toBeNull();
  });

  it('does not mislabel a linked-companion restriction as a primary-phone account block', () => {
    expect(whatsappReachoutRestrictionScope('RESTRICT_ALL_COMPANIONS')).toBe('companion');
    expect(whatsappReachoutRestrictionScope('WEB_COMPANION_ONLY')).toBe('companion');
    expect(whatsappReachoutRestrictionScope('BIZ_QUALITY')).toBe('account_or_business');
    expect(whatsappReachoutRestrictionScope(undefined)).toBe('unknown');
  });
});
