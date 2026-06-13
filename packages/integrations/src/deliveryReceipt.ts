import type { IntegrationDeliveryReceipt } from '@agentis/core';
import { normalizeEmailContent } from './connectors/emailContent.js';

const MESSAGE_OPERATIONS = /(?:send|message|post|publish|notify|deliver)/i;
const EMAIL_SERVICES = new Set(['agentmail', 'gmail']);

/**
 * Build a presentation-safe snapshot of what a communication integration sent.
 * Credentials and arbitrary connector parameters are intentionally excluded.
 */
export function buildIntegrationDeliveryReceipt(
  integrationId: string,
  operationId: string,
  params: Record<string, unknown>,
): IntegrationDeliveryReceipt | null {
  const service = integrationId.trim().toLowerCase();
  const hasContent = ['html', 'htmlBody', 'markdown', 'markdownBody', 'body', 'text', 'message', 'content']
    .some((key) => nonEmptyString(params[key]));
  if (!hasContent || !MESSAGE_OPERATIONS.test(operationId)) return null;

  const recipient = recipientValue(
    params.to ?? params.recipient ?? params.recipients ?? params.channelId ?? params.channel,
  );
  const subject = nonEmptyString(params.subject ?? params.title);

  if (EMAIL_SERVICES.has(service)) {
    const normalized = normalizeEmailContent(params);
    return {
      integrationId,
      operationId,
      ...(recipient ? { recipient } : {}),
      ...(subject ? { subject } : {}),
      contentType: normalized.html ? 'html' : 'text',
      content: normalized.html ?? normalized.text,
      ...(normalized.html ? { text: normalized.text } : {}),
    };
  }

  const html = nonEmptyString(params.html ?? params.htmlBody);
  const markdown = nonEmptyString(params.markdown ?? params.markdownBody);
  const text = nonEmptyString(params.text ?? params.message ?? params.content ?? params.body);
  if (html) {
    return { integrationId, operationId, ...(recipient ? { recipient } : {}), ...(subject ? { subject } : {}), contentType: 'html', content: html };
  }
  if (markdown) {
    return { integrationId, operationId, ...(recipient ? { recipient } : {}), ...(subject ? { subject } : {}), contentType: 'markdown', content: markdown };
  }
  if (!text) return null;
  return { integrationId, operationId, ...(recipient ? { recipient } : {}), ...(subject ? { subject } : {}), contentType: 'text', content: text };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function recipientValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const recipients = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return recipients.length > 0 ? recipients.join(', ') : undefined;
  }
  return nonEmptyString(value);
}
