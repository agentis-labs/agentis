import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyConnectorWebhook } from '../../src/engine/triggerConnectors.js';

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

describe('verifyConnectorWebhook', () => {
  it('verifies GitHub signatures and extracts event metadata', () => {
    const secret = 'github-secret';
    const rawBody = JSON.stringify({ action: 'opened' });
    const result = verifyConnectorWebhook({
      connector: 'github',
      secret,
      rawBody,
      headers: {
        'x-hub-signature-256': `sha256=${hmac(secret, rawBody)}`,
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
      },
    });

    expect(result).toMatchObject({
      deliveryId: 'delivery-1',
      eventType: 'issues',
      payload: { action: 'opened' },
    });
  });

  it('rejects invalid Slack signatures', () => {
    const rawBody = JSON.stringify({ type: 'event_callback' });
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(() =>
      verifyConnectorWebhook({
        connector: 'slack',
        secret: 'slack-secret',
        rawBody,
        headers: {
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': 'v0=bad',
        },
      }),
    ).toThrow(/invalid webhook signature/i);
  });
});
