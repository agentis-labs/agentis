import { AgentisError } from '@agentis/core';
import type { ConnectorModule } from '../types.js';
import { bearerToken, executeHttpRequest, jsonRecordOf, requiredString, stringValue } from './http.js';

export const slackConnector: ConnectorModule = {
  service: 'slack',
  operations: ['send_message', 'add_reaction'],
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
  async execute({ params, credential, timeoutMs }) {
    const token = bearerToken(credential);
    const raw = base64Url(
      [
        `To: ${requiredString(params.to, 'to')}`,
        `Subject: ${requiredString(params.subject, 'subject')}`,
        'MIME-Version: 1.0',
        params.html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
        '',
        String(params.html ?? params.text ?? ''),
      ].join('\r\n'),
    );
    return executeHttpRequest({
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { raw },
    }, null, timeoutMs);
  },
};

export const googleSheetsConnector: ConnectorModule = {
  service: 'google_sheets',
  operations: ['append_row', 'read_range', 'update_range', 'clear_range'],
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
