/**
 * Templated HTTP connectors — the "80% solution" from the n8n-inspired plan §1.3.
 *
 * Most `manifest_only` services are simple REST+token APIs. Rather than writing a
 * bespoke `ConnectorModule` per service, we declare each operation as a small
 * spec (method + URL template + auth convention) and render it at runtime. This
 * makes a bound bearer/api-key credential actually WORK end-to-end — previously
 * these services fell through to `genericHttpConnector`, which throws unless the
 * caller hand-supplies a full `params.url`.
 *
 * Operations a service hasn't templated yet fall back to the generic connector,
 * so partial coverage never regresses a previously-reachable path.
 */

import { AgentisError } from '@agentis/core';
import type { ConnectorExecuteOptions, ConnectorModule, ConnectorOperationContract } from '../types.js';
import { executeHttpRequest, stringValue } from './http.js';
import { genericHttpConnector } from './apiConnectors.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface OperationTemplate {
  method: HttpMethod;
  /** Full URL template; `{name}` placeholders are filled from params (URL-encoded). */
  url: string;
  /** Placeholder names inserted raw, for trusted URL bases stored in credentials. */
  rawParams?: readonly string[];
  /** Param names to forward as query string instead of body. */
  query?: readonly string[];
  /**
   * Body strategy for write operations:
   *  - 'passthrough' (default for POST/PUT/PATCH): send the remaining params as a
   *    JSON object (after path + query params are consumed).
   *  - 'none': send no body.
   * GET/DELETE never send a body.
   */
  body?: 'passthrough' | 'none' | ((params: Record<string, unknown>) => unknown);
  bodyEncoding?: 'json' | 'form';
}

interface ServiceTemplate {
  auth: {
    scheme: 'bearer' | 'header' | 'basic' | 'query' | 'none';
    /** Header name for `scheme: 'header'` (e.g. `x-api-key`). */
    headerName?: string;
    /** Token prefix. Defaults to `'Bearer '` for bearer, `''` for header. */
    prefix?: string;
    /** Preferred credential field for bearer/header token extraction. */
    tokenField?: string;
    /** Also send the same token as `Authorization: Bearer ...` for APIs like Supabase. */
    alsoBearer?: boolean;
    /** Expose the extracted token as a URL-template/query param. */
    tokenParamName?: string;
    /** Basic-auth credential fields. */
    usernameField?: string;
    passwordField?: string;
    /** Query param name -> credential field name. */
    queryParams?: Record<string, string>;
  };
  staticHeaders?: Record<string, string>;
  operations: Record<string, OperationTemplate>;
}

/** Control keys that are never forwarded into a passthrough JSON body. */
const RESERVED_PARAM_KEYS = new Set(['url', 'baseUrl', 'path', 'method', 'headers', 'query', 'responseMode', 'throwOnHttpError']);

function linearCreateIssueBody(params: Record<string, unknown>): Record<string, unknown> {
  return {
    query: 'mutation AgentisCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id title url } } }',
    variables: {
      input: params.input ?? pickDefined(params, ['teamId', 'title', 'description', 'assigneeId', 'projectId', 'priority', 'labelIds']),
    },
  };
}

function linearUpdateIssueBody(params: Record<string, unknown>): Record<string, unknown> {
  return {
    query: 'mutation AgentisUpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id title url } } }',
    variables: {
      id: params.issueId ?? params.id,
      input: params.input ?? pickDefined(params, ['title', 'description', 'assigneeId', 'projectId', 'priority', 'labelIds', 'stateId']),
    },
  };
}

function linearAddCommentBody(params: Record<string, unknown>): Record<string, unknown> {
  return {
    query: 'mutation AgentisCreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }',
    variables: {
      input: params.input ?? {
        issueId: params.issueId ?? params.id,
        body: params.body ?? params.comment,
      },
    },
  };
}

function pickDefined(params: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

export const SERVICE_TEMPLATES: Record<string, ServiceTemplate> = {
  notion: {
    auth: { scheme: 'bearer' },
    staticHeaders: { 'notion-version': '2022-06-28' },
    operations: {
      create_page: { method: 'POST', url: 'https://api.notion.com/v1/pages' },
      update_page: { method: 'PATCH', url: 'https://api.notion.com/v1/pages/{pageId}' },
      query_database: { method: 'POST', url: 'https://api.notion.com/v1/databases/{databaseId}/query' },
      append_block: { method: 'PATCH', url: 'https://api.notion.com/v1/blocks/{blockId}/children' },
    },
  },
  airtable: {
    auth: { scheme: 'bearer' },
    operations: {
      create_record: { method: 'POST', url: 'https://api.airtable.com/v0/{baseId}/{tableName}' },
      update_record: { method: 'PATCH', url: 'https://api.airtable.com/v0/{baseId}/{tableName}/{recordId}' },
      query: { method: 'GET', url: 'https://api.airtable.com/v0/{baseId}/{tableName}', query: ['view', 'maxRecords', 'pageSize', 'offset', 'filterByFormula'] },
      delete_record: { method: 'DELETE', url: 'https://api.airtable.com/v0/{baseId}/{tableName}/{recordId}' },
    },
  },
  telegram: {
    auth: { scheme: 'none', tokenField: 'token', tokenParamName: 'botToken' },
    operations: {
      send_message: { method: 'POST', url: 'https://api.telegram.org/bot{botToken}/sendMessage' },
      send_photo: { method: 'POST', url: 'https://api.telegram.org/bot{botToken}/sendPhoto' },
    },
  },
  discord: {
    auth: { scheme: 'bearer', prefix: 'Bot ' },
    operations: {
      send_message: { method: 'POST', url: 'https://discord.com/api/v10/channels/{channelId}/messages' },
      create_thread: { method: 'POST', url: 'https://discord.com/api/v10/channels/{channelId}/threads' },
    },
  },
  linear: {
    auth: { scheme: 'bearer' },
    operations: {
      create_issue: { method: 'POST', url: 'https://api.linear.app/graphql', body: linearCreateIssueBody },
      update_issue: { method: 'POST', url: 'https://api.linear.app/graphql', body: linearUpdateIssueBody },
      add_comment: { method: 'POST', url: 'https://api.linear.app/graphql', body: linearAddCommentBody },
    },
  },
  stripe: {
    auth: { scheme: 'bearer' },
    operations: {
      create_payment_intent: { method: 'POST', url: 'https://api.stripe.com/v1/payment_intents', bodyEncoding: 'form' },
      create_customer: { method: 'POST', url: 'https://api.stripe.com/v1/customers', bodyEncoding: 'form' },
      create_invoice: { method: 'POST', url: 'https://api.stripe.com/v1/invoices', bodyEncoding: 'form' },
      retrieve_subscription: { method: 'GET', url: 'https://api.stripe.com/v1/subscriptions/{subscriptionId}' },
    },
  },
  trello: {
    auth: { scheme: 'query', queryParams: { key: 'apiKey', token: 'token' } },
    operations: {
      create_card: { method: 'POST', url: 'https://api.trello.com/1/cards', bodyEncoding: 'form' },
      update_card: { method: 'PUT', url: 'https://api.trello.com/1/cards/{cardId}', bodyEncoding: 'form' },
      move_card: { method: 'PUT', url: 'https://api.trello.com/1/cards/{cardId}', bodyEncoding: 'form' },
      add_comment: { method: 'POST', url: 'https://api.trello.com/1/cards/{cardId}/actions/comments', bodyEncoding: 'form' },
    },
  },
  jira: {
    auth: { scheme: 'basic', usernameField: 'email', passwordField: 'apiToken' },
    staticHeaders: { accept: 'application/json' },
    operations: {
      create_issue: { method: 'POST', url: '{siteUrl}/rest/api/3/issue', rawParams: ['siteUrl'] },
      update_issue: { method: 'PUT', url: '{siteUrl}/rest/api/3/issue/{issueIdOrKey}', rawParams: ['siteUrl'] },
      add_comment: { method: 'POST', url: '{siteUrl}/rest/api/3/issue/{issueIdOrKey}/comment', rawParams: ['siteUrl'] },
      transition: { method: 'POST', url: '{siteUrl}/rest/api/3/issue/{issueIdOrKey}/transitions', rawParams: ['siteUrl'] },
    },
  },
  hubspot: {
    auth: { scheme: 'bearer' },
    operations: {
      create_contact: { method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/contacts' },
      update_contact: { method: 'PATCH', url: 'https://api.hubapi.com/crm/v3/objects/contacts/{contactId}' },
      create_deal: { method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/deals' },
      add_note: { method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/notes' },
    },
  },
  zendesk: {
    auth: { scheme: 'basic', usernameField: 'email', passwordField: 'apiToken' },
    operations: {
      create_ticket: { method: 'POST', url: 'https://{subdomain}.zendesk.com/api/v2/tickets.json' },
      update_ticket: { method: 'PUT', url: 'https://{subdomain}.zendesk.com/api/v2/tickets/{ticketId}.json' },
      add_comment: { method: 'PUT', url: 'https://{subdomain}.zendesk.com/api/v2/tickets/{ticketId}.json' },
      close_ticket: { method: 'PUT', url: 'https://{subdomain}.zendesk.com/api/v2/tickets/{ticketId}.json' },
    },
  },
  twilio: {
    auth: { scheme: 'basic', usernameField: 'accountSid', passwordField: 'authToken' },
    operations: {
      send_sms: { method: 'POST', url: 'https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json', bodyEncoding: 'form' },
      send_whatsapp: { method: 'POST', url: 'https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json', bodyEncoding: 'form' },
      make_call: { method: 'POST', url: 'https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Calls.json', bodyEncoding: 'form' },
    },
  },
  supabase: {
    auth: { scheme: 'header', headerName: 'apikey', tokenField: 'apiKey', alsoBearer: true },
    staticHeaders: { prefer: 'return=representation' },
    operations: {
      select: { method: 'GET', url: '{projectUrl}/rest/v1/{table}', rawParams: ['projectUrl'], query: ['select', 'limit', 'offset', 'order'] },
      insert: { method: 'POST', url: '{projectUrl}/rest/v1/{table}', rawParams: ['projectUrl'] },
      update: { method: 'PATCH', url: '{projectUrl}/rest/v1/{table}', rawParams: ['projectUrl'], query: ['id', 'eq', 'filter'] },
      delete: { method: 'DELETE', url: '{projectUrl}/rest/v1/{table}', rawParams: ['projectUrl'], query: ['id', 'eq', 'filter'] },
    },
  },
  shopify: {
    auth: { scheme: 'header', headerName: 'x-shopify-access-token' },
    operations: {
      get_order: { method: 'GET', url: 'https://{shop}.myshopify.com/admin/api/2024-01/orders/{orderId}.json' },
      create_order: { method: 'POST', url: 'https://{shop}.myshopify.com/admin/api/2024-01/orders.json' },
      update_product: { method: 'PUT', url: 'https://{shop}.myshopify.com/admin/api/2024-01/products/{productId}.json' },
      get_customer: { method: 'GET', url: 'https://{shop}.myshopify.com/admin/api/2024-01/customers/{customerId}.json' },
    },
  },
  typeform: {
    auth: { scheme: 'bearer' },
    operations: {
      get_responses: { method: 'GET', url: 'https://api.typeform.com/forms/{formId}/responses', query: ['pageSize', 'since', 'until', 'after'] },
      get_form: { method: 'GET', url: 'https://api.typeform.com/forms/{formId}' },
      list_forms: { method: 'GET', url: 'https://api.typeform.com/forms', query: ['page', 'pageSize', 'search'] },
    },
  },
  wordpress: {
    auth: { scheme: 'basic', usernameField: 'username', passwordField: 'applicationPassword' },
    operations: {
      get_post: { method: 'GET', url: '{siteUrl}/wp-json/wp/v2/posts/{postId}', rawParams: ['siteUrl'] },
      create_post: { method: 'POST', url: '{siteUrl}/wp-json/wp/v2/posts', rawParams: ['siteUrl'] },
      update_post: { method: 'POST', url: '{siteUrl}/wp-json/wp/v2/posts/{postId}', rawParams: ['siteUrl'] },
    },
  },
  auth0: {
    auth: { scheme: 'bearer' },
    operations: {
      get_user: { method: 'GET', url: 'https://{domain}/api/v2/users/{userId}' },
      create_user: { method: 'POST', url: 'https://{domain}/api/v2/users' },
      update_user: { method: 'PATCH', url: 'https://{domain}/api/v2/users/{userId}' },
      assign_role: { method: 'POST', url: 'https://{domain}/api/v2/users/{userId}/roles' },
      block_user: { method: 'PATCH', url: 'https://{domain}/api/v2/users/{userId}' },
    },
  },
  paddle: {
    auth: { scheme: 'bearer' },
    operations: {
      create_transaction: { method: 'POST', url: 'https://api.paddle.com/transactions' },
      get_subscription: { method: 'GET', url: 'https://api.paddle.com/subscriptions/{subscriptionId}' },
      cancel_subscription: { method: 'POST', url: 'https://api.paddle.com/subscriptions/{subscriptionId}/cancel' },
    },
  },
  openai: {
    auth: { scheme: 'bearer' },
    operations: {
      chat_completion: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions' },
      embedding: { method: 'POST', url: 'https://api.openai.com/v1/embeddings' },
      image_gen: { method: 'POST', url: 'https://api.openai.com/v1/images/generations' },
    },
  },
  anthropic: {
    auth: { scheme: 'header', headerName: 'x-api-key' },
    staticHeaders: { 'anthropic-version': '2023-06-01' },
    operations: {
      messages: { method: 'POST', url: 'https://api.anthropic.com/v1/messages' },
      count_tokens: { method: 'POST', url: 'https://api.anthropic.com/v1/messages/count_tokens' },
    },
  },
};

function credentialToken(credential: Record<string, unknown> | null, preferredField?: string): string {
  const preferred = preferredField ? credentialValue(credential, [preferredField]) : undefined;
  const token = preferred ?? stringValue(
    credential?.access_token ?? credential?.accessToken ?? credential?.bot_token ?? credential?.botToken ?? credential?.authToken
      ?? credential?.token ?? credential?.apiToken ?? credential?.apiKey ?? credential?.key ?? credential?.value,
  );
  if (!token) {
    throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', 'connector requires an API key or token credential');
  }
  return token;
}

function credentialValue(credential: Record<string, unknown> | null, names: readonly string[]): string | undefined {
  if (!credential) return undefined;
  for (const name of names) {
    const value = stringValue(credential[name]);
    if (value) return value;
  }
  return undefined;
}

function renderUrl(
  template: string,
  params: Record<string, unknown>,
  credential: Record<string, unknown> | null,
  spec: OperationTemplate,
): { url: string; consumed: Set<string> } {
  const consumed = new Set<string>();
  const source = { ...(credential ?? {}), ...params };
  const rawParams = new Set(spec.rawParams ?? []);
  const url = template.replace(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = source[name];
    if (value === undefined || value === null || value === '') {
      throw new AgentisError('VALIDATION_FAILED', `${name} is required`);
    }
    consumed.add(name);
    const rendered = String(value).trim();
    return rawParams.has(name) ? rendered.replace(/\/+$/u, '') : encodeURIComponent(rendered);
  });
  return { url, consumed };
}

function buildQuery(template: ServiceTemplate, spec: OperationTemplate, params: Record<string, unknown>, credential: Record<string, unknown> | null): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const name of spec.query ?? []) {
    const value = params[name];
    if (value !== undefined && value !== null && value !== '') query[name] = value;
  }
  if (template.auth.scheme === 'query') {
    for (const [queryName, credentialField] of Object.entries(template.auth.queryParams ?? {})) {
      const value = credentialValue(credential, [credentialField]);
      if (!value) throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `${credentialField} is required`);
      query[queryName] = value;
    }
  }
  return query;
}

function buildBody(spec: OperationTemplate, params: Record<string, unknown>, consumed: Set<string>): unknown {
  if (spec.method === 'GET' || spec.method === 'DELETE' || spec.body === 'none') return undefined;
  if (typeof spec.body === 'function') return spec.body(params);
  const queryKeys = new Set(spec.query ?? []);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (consumed.has(key) || queryKeys.has(key) || RESERVED_PARAM_KEYS.has(key)) continue;
    if (value === undefined) continue;
    body[key] = value;
  }
  if (spec.bodyEncoding === 'form') return toFormBody(body);
  return Object.keys(body).length > 0 ? body : {};
}

function toFormBody(body: Record<string, unknown>): string {
  const form = new URLSearchParams();
  appendFormValues(form, '', body);
  return form.toString();
}

function appendFormValues(form: URLSearchParams, prefix: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValues(form, `${prefix}[]`, item);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      appendFormValues(form, prefix ? `${prefix}[${key}]` : key, nested);
    }
    return;
  }
  form.append(prefix, String(value));
}

function applyAuthHeaders(template: ServiceTemplate, headers: Record<string, string>, credential: Record<string, unknown> | null): void {
  const { auth } = template;
  if (auth.scheme === 'none' || auth.scheme === 'query') return;
  if (auth.scheme === 'bearer') {
    headers.authorization = `${auth.prefix ?? 'Bearer '}${credentialToken(credential, auth.tokenField)}`;
    return;
  }
  if (auth.scheme === 'header') {
    const name = (auth.headerName ?? 'authorization').toLowerCase();
    const token = credentialToken(credential, auth.tokenField);
    headers[name] = `${auth.prefix ?? ''}${token}`;
    if (auth.alsoBearer && !headers.authorization) headers.authorization = `Bearer ${token}`;
    return;
  }
  const username = credentialValue(credential, [auth.usernameField ?? 'username', 'email', 'accountSid']);
  const password = credentialValue(credential, [auth.passwordField ?? 'password', 'apiToken', 'authToken', 'applicationPassword']);
  if (!username || !password) throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', 'basic auth requires username and password credentials');
  headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Build a connector whose known operations render from a declarative template,
 * and whose unknown operations delegate to the generic HTTP connector.
 */
export function templatedHttpConnector(
  service: string,
  operations: readonly string[],
  template: ServiceTemplate,
): ConnectorModule {
  const fallback = genericHttpConnector(service, operations);
  return {
    service,
    operations,
    operationContracts: operationContractsFromTemplate(template),
    async execute(opts: ConnectorExecuteOptions): Promise<Record<string, unknown>> {
      const spec = template.operations[opts.operation];
      if (!spec) return fallback.execute(opts);

      const params = { ...(opts.params ?? {}) };
      if (template.auth.tokenParamName) {
        params[template.auth.tokenParamName] = credentialToken(opts.credential, template.auth.tokenField);
      }
      const { url, consumed } = renderUrl(spec.url, params, opts.credential, spec);
      const headers: Record<string, string> = { ...(template.staticHeaders ?? {}) };
      if (spec.bodyEncoding === 'form') headers['content-type'] = 'application/x-www-form-urlencoded';
      applyAuthHeaders(template, headers, opts.credential);

      return executeHttpRequest(
        {
          url,
          method: spec.method,
          headers,
          query: buildQuery(template, spec, params, opts.credential),
          body: buildBody(spec, params, consumed),
        },
        // Auth is already injected above; pass null so executeHttpRequest doesn't
        // re-derive a (possibly wrong-scheme) Authorization header.
        null,
        opts.timeoutMs,
      );
    },
  };
}

function operationContractsFromTemplate(template: ServiceTemplate): Record<string, ConnectorOperationContract> {
  return Object.fromEntries(
    Object.entries(template.operations).map(([operation, spec]) => {
      const required = [...templateParamRequirements(template, spec)];
      return [
        operation,
        {
          ...(required.length > 0 ? { required } : {}),
          aliases: inferredAliases(required),
        },
      ];
    }),
  );
}

function templateParamRequirements(template: ServiceTemplate, spec: OperationTemplate): Set<string> {
  const required = new Set<string>();
  const credentialBacked = new Set<string>([
    ...(spec.rawParams ?? []),
    template.auth.tokenField ?? '',
    template.auth.tokenParamName ?? '',
    template.auth.usernameField ?? '',
    template.auth.passwordField ?? '',
    ...Object.values(template.auth.queryParams ?? {}),
  ].filter(Boolean));
  for (const match of spec.url.matchAll(/\{(\w+)\}/gu)) {
    const name = match[1];
    if (name && !credentialBacked.has(name)) required.add(name);
  }
  return required;
}

function inferredAliases(fields: readonly string[]): Record<string, readonly string[]> {
  const aliases: Record<string, readonly string[]> = {};
  for (const field of fields) {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('title') || normalized.includes('subject')) aliases[field] = ['title', 'subject'];
    if (
      normalized.includes('body')
      || normalized.includes('text')
      || normalized.includes('content')
      || normalized.includes('message')
      || normalized.includes('markdown')
      || normalized.includes('description')
    ) {
      aliases[field] = ['body', 'text', 'content', 'message', 'markdown', 'markdownBody', 'description', 'digest'];
    }
  }
  return aliases;
}

/** Services that have at least one templated operation. */
export function hasServiceTemplate(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_TEMPLATES, service);
}
