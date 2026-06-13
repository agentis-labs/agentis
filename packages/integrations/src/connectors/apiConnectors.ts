import { AgentisError } from '@agentis/core';
import type { ConnectorModule } from '../types.js';
import { bearerToken, executeHttpRequest, jsonRecordOf, requiredString, stringValue } from './http.js';
import { normalizeEmailContent } from './emailContent.js';

export const slackConnector: ConnectorModule = {
  service: 'slack',
  operations: ['send_message', 'add_reaction'],
  operationContracts: {
    send_message: {
      required: ['channel', 'text'],
      aliases: { text: ['body', 'content', 'message', 'markdown', 'markdownBody', 'digest'] },
    },
    add_reaction: { required: ['channel', 'timestamp', 'name'] },
  },
  async execute({ operation, params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    if (operation === 'send_message') {
      return slackApi('chat.postMessage', token, {
        channel: requiredString(params.channel, 'channel'),
        text: requiredString(params.text, 'text'),
        ...(params.blocks ? { blocks: params.blocks } : {}),
      }, timeoutMs);
    }
    return slackApi('reactions.add', token, {
      channel: requiredString(params.channel, 'channel'),
      timestamp: requiredString(params.timestamp, 'timestamp'),
      name: requiredString(params.name, 'name'),
    }, timeoutMs);
  },
};

export const githubConnector: ConnectorModule = {
  service: 'github',
  operations: ['create_issue', 'comment_issue', 'trigger_workflow', 'get_run_status'],
  operationContracts: {
    create_issue: {
      required: ['owner', 'repo', 'title'],
      aliases: { title: ['subject'], body: ['text', 'content', 'message', 'markdown', 'markdownBody', 'digest'] },
    },
    comment_issue: {
      required: ['owner', 'repo', 'issueNumber', 'body'],
      aliases: { body: ['text', 'content', 'message', 'markdown', 'markdownBody', 'digest'] },
    },
    trigger_workflow: { required: ['owner', 'repo', 'workflowId', 'ref'] },
    get_run_status: { required: ['owner', 'repo', 'runId'] },
  },
  async execute({ operation, params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    const owner = requiredString(params.owner, 'owner');
    const repo = requiredString(params.repo, 'repo');
    const headers = githubHeaders(token);
    if (operation === 'create_issue') {
      return executeHttpRequest({
        url: `https://api.github.com/repos/${owner}/${repo}/issues`,
        method: 'POST',
        headers,
        body: { title: requiredString(params.title, 'title'), body: stringValue(params.body) ?? '' },
      }, null, timeoutMs);
    }
    if (operation === 'comment_issue') {
      return executeHttpRequest({
        url: `https://api.github.com/repos/${owner}/${repo}/issues/${requiredString(params.issueNumber, 'issueNumber')}/comments`,
        method: 'POST',
        headers,
        body: { body: requiredString(params.body, 'body') },
      }, null, timeoutMs);
    }
    if (operation === 'trigger_workflow') {
      return executeHttpRequest({
        url: `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${requiredString(params.workflowId, 'workflowId')}/dispatches`,
        method: 'POST',
        headers,
        body: { ref: requiredString(params.ref, 'ref'), inputs: jsonRecordOf(params.inputs) },
        responseMode: 'text',
        throwOnHttpError: true,
      }, null, timeoutMs);
    }
    return executeHttpRequest({
      url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${requiredString(params.runId, 'runId')}`,
      method: 'GET',
      headers,
    }, null, timeoutMs);
  },
};

export const gmailConnector: ConnectorModule = {
  service: 'gmail',
  operations: ['send_email'],
  operationContracts: {
    send_email: {
      required: ['to', 'subject'],
      requiredAny: [['text', 'html', 'markdown', 'body']],
      aliases: emailAliases(),
    },
  },
  async execute({ params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    const content = normalizeEmailContent(params);
    const raw = base64Url(
      buildMimeMessage([
        `To: ${requiredString(params.to, 'to')}`,
        `Subject: ${requiredString(params.subject, 'subject')}`,
        'MIME-Version: 1.0',
      ], content),
    );
    return executeHttpRequest({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { raw },
    }, null, timeoutMs);
  },
};

/**
 * AgentMail — an email API built for agents. Unlike Gmail (which needs the
 * operator's OAuth), each agent gets its OWN inbox, so "send an email" works
 * with just an API key — no user sign-in. We auto-resolve a stable inbox (by
 * client_id) on first send, then send from it. Docs: https://docs.agentmail.to.
 */
const AGENTMAIL_BASE_URL = (process.env.AGENTMAIL_BASE_URL ?? 'https://api.agentmail.to/v0').replace(/\/+$/, '');

export const agentMailConnector: ConnectorModule = {
  service: 'agentmail',
  operations: ['send_message', 'create_inbox', 'list_inboxes', 'list_messages'],
  operationContracts: {
    send_message: {
      required: ['to', 'subject'],
      requiredAny: [['text', 'html', 'markdown', 'body']],
      aliases: emailAliases(),
    },
    list_messages: { aliases: { inbox_id: ['inboxId', 'from'] } },
  },
  async execute({ operation, params, credential, timeoutMs }) {
    const headers = { authorization: `Bearer ${agentMailToken(credential)}`, 'content-type': 'application/json' };

    if (operation === 'create_inbox') {
      return executeHttpRequest({
        url: `${AGENTMAIL_BASE_URL}/inboxes`,
        method: 'POST',
        headers,
        body: {
          ...(stringValue(params.client_id) ? { client_id: stringValue(params.client_id) } : {}),
          ...(stringValue(params.display_name) ? { display_name: stringValue(params.display_name) } : {}),
        },
      }, null, timeoutMs);
    }
    if (operation === 'list_inboxes') {
      return executeHttpRequest({ url: `${AGENTMAIL_BASE_URL}/inboxes`, method: 'GET', headers }, null, timeoutMs);
    }
    if (operation === 'list_messages') {
      const inboxId = await resolveAgentMailInbox(params, headers, timeoutMs);
      return executeHttpRequest({ url: `${AGENTMAIL_BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages`, method: 'GET', headers }, null, timeoutMs);
    }

    // send_message (default): from the agent's inbox to the recipient.
    const to = params.to;
    if (to == null || (typeof to === 'string' && !to.trim()) || (Array.isArray(to) && to.length === 0)) {
      throw new AgentisError('VALIDATION_FAILED', 'to is required');
    }
    const content = normalizeEmailContent(params);
    const inboxId = await resolveAgentMailInbox(params, headers, timeoutMs);
    return executeHttpRequest({
      url: `${AGENTMAIL_BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
      method: 'POST',
      headers,
      body: {
        to,
        subject: requiredString(params.subject, 'subject'),
        // AgentMail recommends multipart content; rich inputs receive a
        // generated plain-text fallback for clients that cannot render HTML.
        text: content.text,
        ...(content.html ? { html: content.html } : {}),
        ...(params.cc ? { cc: params.cc } : {}),
        ...(params.bcc ? { bcc: params.bcc } : {}),
        ...(params.reply_to ? { reply_to: params.reply_to } : {}),
      },
    }, null, timeoutMs);
  },
};

/** The AgentMail API key, from the bound credential or the AGENTMAIL_API_KEY env. */
function agentMailToken(credential: Record<string, unknown> | null): string {
  const token = stringValue(credential?.token ?? credential?.value ?? credential?.apiKey ?? credential?.access_token)
    ?? stringValue(process.env.AGENTMAIL_API_KEY);
  if (!token) throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', 'AgentMail requires an API key (bind a credential or set AGENTMAIL_API_KEY)');
  return token;
}

/** Use an explicit inbox, or create/reuse a stable default inbox (by client_id). */
async function resolveAgentMailInbox(
  params: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs?: number,
): Promise<string> {
  const explicit = stringValue(params.inbox_id ?? params.inboxId ?? params.from);
  if (explicit) return explicit;
  const clientId = stringValue(params.client_id) ?? 'agentis-default';
  const created = await executeHttpRequest({
    url: `${AGENTMAIL_BASE_URL}/inboxes`,
    method: 'POST',
    headers,
    body: { client_id: clientId },
  }, null, timeoutMs);
  const body = (created.body ?? created) as Record<string, unknown>;
  const inbox = stringValue(body.inbox_id) ?? stringValue(body.email) ?? stringValue(body.id);
  if (!inbox) throw new AgentisError('INTEGRATION_OPERATION_FAILED', 'AgentMail did not return an inbox id');
  return inbox;
}

export const googleSheetsConnector: ConnectorModule = {
  service: 'google_sheets',
  operations: ['append_row', 'read_range', 'update_range', 'clear_range'],
  operationContracts: {
    append_row: { required: ['spreadsheetId', 'range'], requiredAny: [['values', 'row']] },
    read_range: { required: ['spreadsheetId', 'range'] },
    update_range: { required: ['spreadsheetId', 'range'], requiredAny: [['values', 'row']] },
    clear_range: { required: ['spreadsheetId', 'range'] },
  },
  async execute({ operation, params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    const spreadsheetId = requiredString(params.spreadsheetId, 'spreadsheetId');
    const range = encodeURIComponent(requiredString(params.range, 'range'));
    const headers = { authorization: `Bearer ${token}` };
    if (operation === 'read_range') {
      return executeHttpRequest({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
        method: 'GET',
        headers,
      }, null, timeoutMs);
    }
    if (operation === 'clear_range') {
      return executeHttpRequest({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`,
        method: 'POST',
        headers,
        body: {},
      }, null, timeoutMs);
    }
    const values = Array.isArray(params.values) ? params.values : [Array.isArray(params.row) ? params.row : [params.row]];
    const url = operation === 'append_row'
      ? `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`
      : `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;
    return executeHttpRequest({ url, method: operation === 'append_row' ? 'POST' : 'PUT', headers, body: { values } }, null, timeoutMs);
  },
};

function emailAliases(): Record<string, readonly string[]> {
  return {
    to: ['recipient', 'recipients', 'email', 'emails'],
    subject: ['title'],
    text: ['plainText'],
    markdown: ['markdownBody'],
    html: ['htmlBody'],
  };
}

function buildMimeMessage(headers: string[], content: ReturnType<typeof normalizeEmailContent>): string {
  if (!content.html) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', '', content.text].join('\r\n');
  }
  const boundary = `agentis_${Math.random().toString(36).slice(2)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    content.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    content.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function unavailableConnector(service: string, operations: readonly string[], reason: string): ConnectorModule {
  return {
    service,
    operations,
    async execute({ operation }) {
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `${service}.${operation} is not implemented in this build: ${reason}`);
    },
  };
}

export function genericHttpConnector(service: string, operations: readonly string[]): ConnectorModule {
  return {
    service,
    operations,
    async execute({ operation, params, credential, timeoutMs }) {
      const url = genericUrl(params, credential);
      const method = stringValue(params.method)?.toUpperCase() ?? defaultMethod(operation);
      return executeHttpRequest(
        {
          url,
          method,
          query: params.query,
          headers: {
            ...jsonRecordOf(params.headers),
            'x-agentis-service': service,
            'x-agentis-operation': operation,
          },
          body: params.body ?? omitGenericParams(params),
          responseMode: params.responseMode,
          throwOnHttpError: params.throwOnHttpError,
        },
        credential,
        timeoutMs,
      );
    },
  };
}

function genericUrl(params: Record<string, unknown>, credential: Record<string, unknown> | null): string {
  const direct = stringValue(params.url);
  if (direct) return direct;
  const baseUrl = stringValue(params.baseUrl ?? credential?.baseUrl ?? credential?.apiBaseUrl ?? credential?.endpoint);
  const path = stringValue(params.path) ?? '';
  if (!baseUrl) {
    throw new AgentisError('VALIDATION_FAILED', 'Generic integration execution requires params.url or credential.baseUrl');
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//u, ''), base).toString();
}

function defaultMethod(operation: string): string {
  if (/^(get|list|read|search|query|find)/iu.test(operation)) return 'GET';
  if (/^(delete|remove|clear)/iu.test(operation)) return 'DELETE';
  if (/^(update|patch|transition|resolve|assign|block|deactivate|cancel)/iu.test(operation)) return 'PATCH';
  return 'POST';
}

function omitGenericParams(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (['url', 'baseUrl', 'path', 'method', 'query', 'headers', 'responseMode', 'throwOnHttpError'].includes(key)) continue;
    body[key] = value;
  }
  return body;
}

async function slackApi(method: string, token: string, body: Record<string, unknown>, timeoutMs?: number) {
  const result = await executeHttpRequest({
    url: `https://slack.com/api/${method}`,
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  }, null, timeoutMs);
  const responseBody = result.body as { ok?: boolean; error?: string } | null;
  if (responseBody && responseBody.ok === false) {
    throw new AgentisError('INTEGRATION_OPERATION_FAILED', `Slack API error: ${responseBody.error ?? 'unknown error'}`);
  }
  return result;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agentis-integrations',
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
