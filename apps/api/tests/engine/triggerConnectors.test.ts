import { createHmac, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyConnectorWebhook, connectorFromConfig } from '../../src/engine/triggerConnectors.js';

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}
function hmacB64(secret: string, value: string, algo: 'sha256' | 'sha1' = 'sha256'): string {
  return createHmac(algo, secret).update(value).digest('base64');
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

  // ── WORKFLOW-UPDATE — n8n-inspired connectors ──────────────────────────────

  it('connectorFromConfig recognizes the new connectors', () => {
    for (const c of ['shopify', 'hubspot', 'intercom', 'zendesk', 'twilio', 'discord', 'pagerduty', 'sendgrid']) {
      expect(connectorFromConfig({ connector: c })).toBe(c);
    }
    expect(connectorFromConfig({ connector: 'nope' })).toBe('generic');
  });

  it('verifies Shopify base64 HMAC-SHA256', () => {
    const secret = 's';
    const rawBody = JSON.stringify({ id: 99 });
    const result = verifyConnectorWebhook({
      connector: 'shopify',
      secret,
      rawBody,
      headers: { 'x-shopify-hmac-sha256': hmacB64(secret, rawBody), 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'wh-1' },
    });
    expect(result).toMatchObject({ deliveryId: 'wh-1', eventType: 'orders/create' });
    expect(() => verifyConnectorWebhook({ connector: 'shopify', secret, rawBody, headers: { 'x-shopify-hmac-sha256': 'AAAA' } })).toThrow();
  });

  it('verifies HubSpot hex HMAC-SHA256', () => {
    const secret = 'h';
    const rawBody = JSON.stringify([{ eventId: 1, subscriptionType: 'contact.creation' }]);
    const result = verifyConnectorWebhook({
      connector: 'hubspot',
      secret,
      rawBody,
      headers: { 'x-hubspot-signature': hmac(secret, rawBody) },
    });
    expect(result.eventType).toBe('contact.creation');
    expect(result.payload).toHaveProperty('events');
  });

  it('verifies Intercom sha256= prefixed HMAC', () => {
    const secret = 'i';
    const rawBody = JSON.stringify({ id: 'n1', topic: 'conversation.user.created' });
    const result = verifyConnectorWebhook({
      connector: 'intercom',
      secret,
      rawBody,
      headers: { 'x-hub-signature': `sha256=${hmac(secret, rawBody)}` },
    });
    expect(result).toMatchObject({ deliveryId: 'n1', eventType: 'conversation.user.created' });
  });

  it('verifies Zendesk timestamped base64 HMAC', () => {
    const secret = 'z';
    const rawBody = JSON.stringify({ type: 'ticket.created' });
    const ts = '2026-01-01T00:00:00Z';
    const result = verifyConnectorWebhook({
      connector: 'zendesk',
      secret,
      rawBody,
      headers: { 'x-zendesk-webhook-signature': hmacB64(secret, `${ts}${rawBody}`), 'x-zendesk-webhook-signature-timestamp': ts },
    });
    expect(result.eventType).toBe('ticket.created');
  });

  it('verifies Twilio base64 HMAC-SHA1', () => {
    const secret = 't';
    const rawBody = JSON.stringify({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const result = verifyConnectorWebhook({
      connector: 'twilio',
      secret,
      rawBody,
      headers: { 'x-twilio-signature': hmacB64(secret, rawBody, 'sha1') },
    });
    expect(result).toMatchObject({ deliveryId: 'SM1', eventType: 'delivered' });
  });

  it('verifies PagerDuty v1= HMAC list', () => {
    const secret = 'p';
    const rawBody = JSON.stringify({ event: { event_type: 'incident.triggered', id: 'PD1' } });
    const result = verifyConnectorWebhook({
      connector: 'pagerduty',
      secret,
      rawBody,
      headers: { 'x-pagerduty-signature': `v1=deadbeef,v1=${hmac(secret, rawBody)}` },
    });
    expect(result).toMatchObject({ eventType: 'incident.triggered' });
  });

  it('verifies Discord Ed25519 and rejects tampered bodies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const rawBody = JSON.stringify({ type: 1 });
    const ts = '1700000000';
    const sig = cryptoSign(null, Buffer.from(`${ts}${rawBody}`), privateKey).toString('hex');
    const result = verifyConnectorWebhook({
      connector: 'discord',
      secret: rawPub,
      rawBody,
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
    });
    expect(result.eventType).toBe('discord.type.1');
    expect(() => verifyConnectorWebhook({
      connector: 'discord',
      secret: rawPub,
      rawBody: JSON.stringify({ type: 2 }),
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
    })).toThrow(/Ed25519/i);
  });

  it('verifies SendGrid ECDSA P-256', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const rawBody = JSON.stringify([{ event: 'delivered' }]);
    const ts = '1700000001';
    const sig = cryptoSign('sha256', Buffer.from(`${ts}${rawBody}`), privateKey).toString('base64');
    const result = verifyConnectorWebhook({
      connector: 'sendgrid',
      secret: pubB64,
      rawBody,
      headers: { 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts },
    });
    expect(result.eventType).toBe('sendgrid.events');
    expect(result.payload).toHaveProperty('events');
  });
});
