/**
 * /v1/webhooks/trigger/:triggerId — public webhook ingress.
 *
 * Headers required:
 *   x-agentis-timestamp : unix ms
 *   x-agentis-signature : hex HMAC-SHA256 of `${ts}.${rawBody}` using the
 *                         trigger's webhookSecret
 *   x-agentis-delivery  : idempotency key
 *
 * Verification, replay defense, and idempotency are handled in
 * TriggerRuntime.fireWebhook.
 *
 * /v1/webhooks/channel/:connectionId — Batch 4 channel-bridge ingress.
 *
 * Adapter-specific authentication (e.g. Telegram's
 * `X-Telegram-Bot-Api-Secret-Token`) is verified inside
 * `ChannelBridge.handleInbound`. Idempotency is keyed by the adapter's own
 * external id (e.g. Telegram update_id).
 */

import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { ChannelBridge } from '../services/channelBridge.js';

export function buildWebhookRoutes(deps: { runtime: TriggerRuntime; bridge?: ChannelBridge }) {
  const app = new Hono();
  app.post('/trigger/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const ts = c.req.header('x-agentis-timestamp') ?? '';
    const sig = c.req.header('x-agentis-signature') ?? '';
    const delivery = c.req.header('x-agentis-delivery') ?? '';
    if (!ts || !sig || !delivery) {
      throw new AgentisError('VALIDATION_FAILED', 'webhook headers missing (x-agentis-timestamp, x-agentis-signature, x-agentis-delivery)');
    }
    const rawBody = await c.req.text();
    const result = await deps.runtime.fireWebhook({
      triggerId,
      rawBody,
      signature: sig,
      timestampHeader: ts,
      deliveryId: delivery,
    });
    return c.json(result, result.idempotent ? 200 : 202);
  });

  app.post('/channel/:connectionId', async (c) => {
    if (!deps.bridge) {
      throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    }
    const connectionId = c.req.param('connectionId');
    // Collect headers as a flat record for the adapter contract.
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = await c.req.text();
    const result = await deps.bridge.handleInbound({ connectionId, headers, rawBody });
    if (result.responseBody !== undefined) {
      return c.json(result.responseBody as Record<string, unknown>, 200);
    }
    return c.json(result, result.idempotent ? 200 : 202);
  });

  app.get('/channel/:connectionId', (c) => {
    if (!deps.bridge) {
      throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel bridge not configured');
    }
    const query: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(c.req.query())) query[key] = value;
    const result = deps.bridge.handleWebhookVerification({
      connectionId: c.req.param('connectionId'),
      query,
    });
    return c.body(result.body, 200, { 'content-type': result.contentType ?? 'text/plain; charset=utf-8' });
  });

  return app;
}

