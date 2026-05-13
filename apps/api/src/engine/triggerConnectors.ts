import { createHmac, timingSafeEqual } from 'node:crypto';
import { AgentisError, CONSTANTS } from '@agentis/core';

export type TriggerConnectorId =
  | 'generic'
  | 'github'
  | 'slack'
  | 'linear'
  | 'stripe'
  | 'typeform'
  | 'gmail';

export interface ConnectorVerificationInput {
  connector: TriggerConnectorId;
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
}

export interface ConnectorVerificationResult {
  deliveryId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export function verifyConnectorWebhook(input: ConnectorVerificationInput): ConnectorVerificationResult {
  const parsed = parseBody(input.rawBody);
  switch (input.connector) {
    case 'github':
      verifyPrefixedHexHmac({
        secret: input.secret,
        rawBody: input.rawBody,
        header: input.headers['x-hub-signature-256'],
        prefix: 'sha256=',
      });
      return {
        deliveryId: requiredHeader(input.headers, 'x-github-delivery'),
        eventType: input.headers['x-github-event'] ?? 'github.event',
        payload: parsed,
      };
    case 'slack': {
      const timestamp = requiredHeader(input.headers, 'x-slack-request-timestamp');
      assertFreshSeconds(timestamp);
      const expected = `v0=${hmacHex(input.secret, `v0:${timestamp}:${input.rawBody}`)}`;
      safeCompare(expected, requiredHeader(input.headers, 'x-slack-signature'));
      const event = recordFrom(parsed.event);
      return {
        deliveryId: stringFrom(parsed.event_id ?? event.client_msg_id ?? `${timestamp}:${input.headers['x-slack-retry-num'] ?? '0'}`),
        eventType: stringFrom(parsed.type ?? event.type ?? 'slack.event'),
        payload: parsed,
      };
    }
    case 'linear':
      safeCompare(hmacHex(input.secret, input.rawBody), requiredHeader(input.headers, 'linear-signature'));
      return {
        deliveryId: stringFrom(parsed.webhookTimestamp ?? parsed.id ?? parsed.action ?? Date.now()),
        eventType: stringFrom(parsed.type ?? parsed.action ?? 'linear.event'),
        payload: parsed,
      };
    case 'stripe': {
      const parts = parseStripeSignature(requiredHeader(input.headers, 'stripe-signature'));
      assertFreshSeconds(parts.timestamp);
      const expected = hmacHex(input.secret, `${parts.timestamp}.${input.rawBody}`);
      if (!parts.signatures.some((sig) => compareHex(expected, sig))) {
        throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid Stripe signature');
      }
      return {
        deliveryId: stringFrom(parsed.id ?? `${parts.timestamp}:${expected.slice(0, 12)}`),
        eventType: stringFrom(parsed.type ?? 'stripe.event'),
        payload: parsed,
      };
    }
    case 'typeform':
      verifyBase64Hmac({
        secret: input.secret,
        rawBody: input.rawBody,
        header: requiredHeader(input.headers, 'typeform-signature'),
        prefix: 'sha256=',
      });
      const formResponse = recordFrom(parsed.form_response);
      return {
        deliveryId: stringFrom(parsed.event_id ?? formResponse.token ?? formResponse.landing_id ?? Date.now()),
        eventType: stringFrom(parsed.event_type ?? 'typeform.response'),
        payload: parsed,
      };
    case 'gmail': {
      const token = input.headers['x-goog-channel-token'] ?? bearerToken(input.headers.authorization);
      safeCompare(input.secret, token ?? '');
      const message = recordFrom(parsed.message);
      return {
        deliveryId: stringFrom(input.headers['x-goog-message-number'] ?? message.messageId ?? Date.now()),
        eventType: stringFrom(Object.keys(message).length > 0 ? 'gmail.pubsub' : 'gmail.notification'),
        payload: parsed,
      };
    }
    case 'generic':
      throw new AgentisError('TRIGGER_INVALID_CONFIG', 'generic connector must use Agentis HMAC verification');
  }
}

export function connectorFromConfig(config: Record<string, unknown>): TriggerConnectorId {
  const raw = String(config.connector ?? config.provider ?? 'generic').toLowerCase();
  if (['github', 'slack', 'linear', 'stripe', 'typeform', 'gmail'].includes(raw)) {
    return raw as TriggerConnectorId;
  }
  return 'generic';
}

function parseBody(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: rawBody };
  }
}

function requiredHeader(headers: Record<string, string | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  if (!value) throw new AgentisError('VALIDATION_FAILED', `webhook header missing (${name})`);
  return value;
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function verifyPrefixedHexHmac(args: { secret: string; rawBody: string; header: string | undefined; prefix: string }): void {
  const header = args.header ?? '';
  if (!header.startsWith(args.prefix)) {
    throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'missing webhook signature prefix');
  }
  const signature = header.slice(args.prefix.length);
  if (!compareHex(hmacHex(args.secret, args.rawBody), signature)) {
    throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid webhook signature');
  }
}

function verifyBase64Hmac(args: { secret: string; rawBody: string; header: string; prefix: string }): void {
  if (!args.header.startsWith(args.prefix)) {
    throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'missing webhook signature prefix');
  }
  const expected = createHmac('sha256', args.secret).update(args.rawBody).digest('base64');
  safeCompare(expected, args.header.slice(args.prefix.length));
}

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const pairs = header.split(',').map((part) => part.split('='));
  const timestamp = pairs.find(([key]) => key === 't')?.[1];
  const signatures = pairs.filter(([key]) => key === 'v1').map(([, value]) => value).filter(Boolean) as string[];
  if (!timestamp || signatures.length === 0) {
    throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid Stripe-Signature header');
  }
  return { timestamp, signatures };
}

function assertFreshSeconds(timestamp: string): void {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 'missing/invalid timestamp header');
  }
  const skew = Math.abs(Date.now() - seconds * 1000);
  if (skew > CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', `timestamp skew ${skew}ms exceeds tolerance`);
  }
}

function compareHex(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actualHex) || expectedHex.length !== actualHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch {
    return false;
  }
}

function safeCompare(expected: string, actual: string): void {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid webhook signature');
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : String(value);
}
