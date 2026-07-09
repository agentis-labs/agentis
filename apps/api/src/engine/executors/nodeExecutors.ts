/**
 * Node-kind executors (extracted from WorkflowEngine — Phase A).
 *
 * Deterministic + IO/compute node handlers: data query/mutate, aggregate,
 * http, code, spreadsheet, graphql, integration/connector, mcp, browser,
 * router, guardrails, workflow/workspace store. The engine dispatch switch
 * delegates here; handlers reach engine state only through the typed
 * NodeExecutorHost facade.
 */
import { BrowserPool } from '../../services/browserPool.js';
import { CredentialVault } from '../../services/credentialVault.js';
import { getCustomIntegrationManifest } from '../../services/integrationRegistry.js';
import { assertSafeUrl } from '../../services/safeUrl.js';
import { WorkflowStoreService } from '../../services/workflow/workflowStore.js';
import { WorkspaceStoreService } from '../../services/workspace/workspaceStore.js';
import { evalCondition } from '../SafeConditionParser.js';
import { readDotPath } from '../dotPath.js';
import { evaluateExpression } from '../safeExpression.js';
import { resolveTemplate, type TemplateContext } from '../templateResolver.js';
import { AgentisError, type AggregateWindowNodeConfig, type BrowserNodeConfig, type CodeNodeConfig, type DataMutateNodeConfig, type DataQueryNodeConfig, type GraphQlNodeConfig, type GuardrailsNodeConfig, type HttpRequestNodeConfig, type IntegrationNodeConfig, type McpNodeConfig, type RouterNodeConfig, type SpreadsheetNodeConfig, type WorkflowNode, type WorkflowStoreNodeConfig, type WorkspaceStoreNodeConfig } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { manifestHttpConnector, type ConnectorRegistry } from '@agentis/integrations';
import { and, eq } from 'drizzle-orm';
import { sleep, backoffMs, redactUrl, asString, coerceJson, parseCsv, buildCsv, worksheetToRows, extractInputHtml, parseJsonOrString, checkGuardrail } from '../executorHelpers.js';
import type { RunningContext, EngineDeps } from '../WorkflowEngine.js';
import type { EvaluationRuntime } from '../../services/structuredEvaluatorRuntime.js';

export interface NodeExecutorHost {
  readonly deps: EngineDeps;
  buildConditionScope(ctx: RunningContext, currentData: Record<string, unknown>): Record<string, unknown>;
  enforceSpecConstraints(ctx: RunningContext, service: string, callRef: string, ...aliases: string[]): void;
  persistArtifact(
    ctx: RunningContext,
    node: WorkflowNode,
    args: { name: string; title?: string; type: 'html' | 'image' | 'document' | 'code' | 'data'; content: string; savedBy: string },
  ): { id: string; name: string; title: string; type: string; contentType: string; size: number };
  persistRun(ctx: RunningContext): Promise<void>;
  recordEvaluationTokens(ctx: RunningContext, nodeId: string, usage: { tokensIn: number; tokensOut: number } | null | undefined, agentId: string | null): void;
  resolveEvaluationRuntime(ctx: RunningContext, node: WorkflowNode, targetPath?: string): { runtime: EvaluationRuntime; agentId: string | null } | undefined;
}

export class NodeExecutorController {
  constructor(private readonly host: NodeExecutorHost) {}

  executeRouter(
    ctx: RunningContext,
    config: RouterNodeConfig,
    inputData: Record<string, unknown>,
  ): string[] {
    // P0.1: real per-id `nodes` + real `trigger` (previously both aliased to
    // `inputData`, so `nodes["other"].x` / `trigger.x` silently re-read the
    // router's own input). Shared with edge conditions + the build validator.
    const scope = this.host.buildConditionScope(ctx, inputData);
    const matches: string[] = [];
    for (const branch of config.branches) {
      if (config.routingMode === 'space_route') {
        const targetSpace = String(inputData.spaceId ?? '');
        if (targetSpace && branch.condition === targetSpace) {
          matches.push(branch.branchId);
          break;
        }
      } else if (evalCondition(branch.condition, scope)) {
        matches.push(branch.branchId);
        if (config.routingMode === 'first_match') break;
      }
    }
    return matches;
  }

  /**
   * LLM-routed router. Asks the configured evaluator-tier model to pick exactly
   * one branch by id, given the branch labels + the current input. Falls back
   * to `first_match` semantics if the evaluator runtime isn't wired or if the
   * LLM response can't be parsed.
   */
  async executeRouterLlm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: RouterNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<string[]> {
    const resolved = this.host.resolveEvaluationRuntime(ctx, node);
    const evaluator = resolved?.runtime;
    if (!evaluator) {
      this.host.deps.logger.warn('engine.router.llm_route.no_runtime', { nodeId: node.id });
      return this.executeRouter(ctx, { ...config, routingMode: 'first_match' }, inputData);
    }
    try {
      const branchIds = config.branches.map((b) => b.branchId);
      const decision = await evaluator.routeBranch({
        workspaceId: ctx.workspaceId,
        input: inputData,
        branches: config.branches.map((b) => ({ branchId: b.branchId, label: b.label, condition: b.condition })),
      });
      // Meter + attribute the routing model's spend (same sink as agents/evaluators).
      this.host.recordEvaluationTokens(ctx, node.id, evaluator.lastUsage, resolved?.agentId ?? null);
      if (decision && branchIds.includes(decision)) {
        return [decision];
      }
      this.host.deps.logger.warn('engine.router.llm_route.bad_decision', { nodeId: node.id, decision });
    } catch (err) {
      this.host.deps.logger.warn('engine.router.llm_route.failed', { nodeId: node.id, err: (err as Error).message });
    }
    return this.executeRouter(ctx, { ...config, routingMode: 'first_match' }, inputData);
  }

  /**
   * Native browser node (Layer 3 §3.2). Renders HTML / navigates URLs via the
   * BrowserPool (headless Chromium) and persists screenshots/PDFs as artifacts.
   */
  async executeBrowser(
    ctx: RunningContext,
    node: WorkflowNode,
    config: BrowserNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.host.deps.browserPool) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'browser node present but BrowserPool not wired');
    }
    const html = config.html
      ?? (config.htmlPath ? asString(readDotPath(inputData, config.htmlPath)) : extractInputHtml(inputData));
    const opts = {
      url: config.url,
      html: html || undefined,
      selector: config.selector,
      formData: config.formData,
      submitSelector: config.submitSelector,
      fullPage: config.fullPage,
      headless: config.headless,
      viewport: config.viewport,
      // Bounded like http_request: an uncapped/omitted timeout must never let
      // a browser op hold the node (and the run) open indefinitely.
      timeout: Math.max(1, Math.min(config.timeout ?? 30_000, 120_000)),
      // Run-scoped cancellation: Stop closes the page so in-flight Chromium
      // work rejects immediately instead of running to its timeout.
      ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
    };
    ctx.state.activeExecutions[node.id] = {
      taskId: `browser:${node.id}`,
      nodeId: node.id,
      executorType: 'browser',
      executorRef: config.operation,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the browser op in flight.
    await this.host.persistRun(ctx).catch(() => {});
    try {
      switch (config.operation) {
        case 'serve_html':
        case 'screenshot': {
          const png = await this.host.deps.browserPool.screenshot(opts);
          const name = config.artifactName ?? (config.operation === 'serve_html' ? 'page.png' : 'screenshot.png');
          const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
          const artifact = this.host.persistArtifact(ctx, node, { name, type: 'image', content: dataUrl, savedBy: 'browser' });
          if (config.operation === 'serve_html') {
            // Emit both the live HTML (for a downstream return_output iframe) and
            // the screenshot artifact card.
            return { type: 'html', content: html ?? '', screenshot: artifact, artifactId: artifact.id };
          }
          return { screenshot: artifact, artifactId: artifact.id };
        }
        case 'pdf': {
          const pdf = await this.host.deps.browserPool.pdf(opts);
          const name = config.artifactName ?? 'document.pdf';
          const dataUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
          const artifact = this.host.persistArtifact(ctx, node, { name, type: 'document', content: dataUrl, savedBy: 'browser' });
          return { pdf: artifact, artifactId: artifact.id };
        }
        case 'navigate': {
          const r = await this.host.deps.browserPool.navigate(opts);
          return { title: r.title, text: r.text, html: r.html };
        }
        case 'extract_text': {
          const text = await this.host.deps.browserPool.extractText(opts);
          return { text };
        }
        case 'fill_form': {
          const r = await this.host.deps.browserPool.fillForm(opts);
          return { title: r.title, values: r.values, html: r.html };
        }
        case 'extract_table': {
          const rows = await this.host.deps.browserPool.extractTable(opts);
          return { rows, count: rows.length };
        }
        default:
          throw new AgentisError('VALIDATION_FAILED', `browser: unknown operation ${(config as { operation: string }).operation}`);
      }
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  async executeIntegration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: IntegrationNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!config.integrationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing integrationId');
    }
    if (!config.operationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing operationId');
    }
    this.host.enforceSpecConstraints(ctx, config.integrationId, `${config.integrationId}.${config.operationId}`);
    const credential = this.resolveIntegrationCredential(ctx.workspaceId, config);
    ctx.state.activeExecutions[node.id] = {
      taskId: `integration:${node.id}`,
      nodeId: node.id,
      executorType: 'integration',
      executorRef: `${config.integrationId}.${config.operationId}`,
      startedAt: new Date().toISOString(),
    };
    try {
      return await this.invokeConnector(ctx.workspaceId, config.integrationId, {
        operation: config.operationId,
        params: config.inputs ?? {},
        credential,
        inputData,
      });
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /**
   * Invoke a connector operation, preferring a registered connector, then a
   * workspace custom manifest, then the registry fallback. Shared by the
   * `integration` node path and the agent-facing {@link runIntegrationOperation}
   * so both resolve the same connector the same way.
   */
  async invokeConnector(
    workspaceId: string,
    integrationId: string,
    executeOptions: { operation: string; params: Record<string, unknown>; credential: Record<string, unknown> | null; inputData: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    if (this.host.deps.connectors?.has(integrationId)) {
      return await this.host.deps.connectors.execute(integrationId, executeOptions);
    }
    const customManifest = this.#customIntegrationManifest(workspaceId, integrationId);
    if (customManifest) {
      return await manifestHttpConnector(customManifest).execute(executeOptions);
    }
    if (!this.host.deps.connectors) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration node present but ConnectorRegistry not wired');
    }
    return await this.host.deps.connectors.execute(integrationId, executeOptions);
  }

  /** `mcp` node — call a registered MCP server's tool via the bridge. */
  async executeMcp(ctx: RunningContext, node: WorkflowNode, config: McpNodeConfig): Promise<Record<string, unknown>> {
    if (!this.host.deps.mcpBridge) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'mcp node present but MCP bridge not wired');
    }
    if (!config.toolId) {
      throw new AgentisError('VALIDATION_FAILED', 'mcp node missing toolId');
    }
    // Spec constraint plane: mcp__<slug>__<tool> is in scope when the slug (or
    // its `mcp:<slug>` form) is allowed.
    const mcpSlug = config.toolId.match(/^mcp__([^_]+(?:_[^_]+)*?)__/u)?.[1] ?? config.toolId;
    this.host.enforceSpecConstraints(ctx, mcpSlug, config.toolId, `mcp:${mcpSlug}`);
    ctx.state.activeExecutions[node.id] = {
      taskId: `mcp:${node.id}`,
      nodeId: node.id,
      executorType: 'integration',
      executorRef: config.toolId,
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await this.host.deps.mcpBridge.call(ctx.workspaceId, config.toolId, config.arguments ?? {});
      if (!result.ok) {
        throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP tool ${config.toolId} failed: ${result.error ?? 'unknown error'}`);
      }
      return config.outputKey ? { [config.outputKey]: result.result ?? null } : { result: result.result ?? null };
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /**
   * Resolve the App id for a data node: the node's explicit `appId`, else the
   * App that owns the running workflow (so deterministic persist works without a
   * build-time appId — the App is created after the workflow).
   */
  #resolveDataAppId(ctx: RunningContext, configAppId: string | undefined): string {
    const appId = configAppId ?? this.host.deps.resolveAppIdForWorkflow?.(ctx.workspaceId, ctx.workflowId);
    if (!appId) {
      throw new AgentisError('VALIDATION_FAILED', 'data node requires an appId (none on the node and no owning App resolvable from the running workflow)');
    }
    return appId;
  }

  /** `data_query` node — read or aggregate an Agentic App datastore collection. */
  executeDataQuery(ctx: RunningContext, config: DataQueryNodeConfig): Record<string, unknown> {
    if (!this.host.deps.appData) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'data_query node present but app datastore not wired');
    }
    if (!config.collection) {
      throw new AgentisError('VALIDATION_FAILED', 'data_query node requires a collection');
    }
    const appId = this.#resolveDataAppId(ctx, config.appId);
    if (config.mode === 'aggregate') {
      if (!config.op) throw new AgentisError('VALIDATION_FAILED', 'data_query aggregate requires an op');
      const buckets = this.host.deps.appData.aggregate(ctx.workspaceId, appId, config.collection, {
        op: config.op,
        ...(config.field ? { field: config.field } : {}),
        ...(config.groupBy ? { groupBy: config.groupBy } : {}),
        ...(config.filter ? { filter: config.filter } : {}),
      });
      return { [config.outputKey ?? 'buckets']: buckets };
    }
    if (config.paginate) {
      // Follow the keyset cursor internally and return every matching row.
      const maxRows = Math.min(Math.max(config.maxRows ?? 1000, 1), 10_000);
      const pageSize = Math.min(config.limit && config.limit > 0 ? config.limit : 200, maxRows);
      const all: unknown[] = [];
      let cursor: string | undefined;
      // Bound the page loop too (defensive against a non-advancing cursor).
      for (let page = 0; page < 1000 && all.length < maxRows; page += 1) {
        const res = this.host.deps.appData.query(ctx.workspaceId, appId, config.collection, {
          ...(config.filter ? { filter: config.filter } : {}),
          ...(config.sort ? { sort: config.sort } : {}),
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of res.rows) {
          if (all.length >= maxRows) break;
          all.push(row);
        }
        if (!res.nextCursor || res.rows.length === 0) break;
        cursor = res.nextCursor;
      }
      return { [config.outputKey ?? 'rows']: all, count: all.length };
    }
    const res = this.host.deps.appData.query(ctx.workspaceId, appId, config.collection, {
      ...(config.filter ? { filter: config.filter } : {}),
      ...(config.sort ? { sort: config.sort } : {}),
      ...(config.limit ? { limit: config.limit } : {}),
      ...(config.cursor ? { cursor: config.cursor } : {}),
    });
    return { [config.outputKey ?? 'rows']: res.rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }

  /** `data_mutate` node — write to an Agentic App datastore collection. */
  executeDataMutate(ctx: RunningContext, config: DataMutateNodeConfig): Record<string, unknown> {
    if (!this.host.deps.appData) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'data_mutate node present but app datastore not wired');
    }
    if (!config.collection) {
      throw new AgentisError('VALIDATION_FAILED', 'data_mutate node requires a collection');
    }
    const { workspaceId } = ctx;
    const appId = this.#resolveDataAppId(ctx, config.appId);
    switch (config.operation) {
      case 'insert':
        return { [config.outputKey ?? 'record']: this.host.deps.appData.insert(workspaceId, appId, config.collection, config.record ?? {}) };
      case 'update': {
        if (!config.recordId) throw new AgentisError('VALIDATION_FAILED', 'data_mutate update requires recordId');
        return { [config.outputKey ?? 'record']: this.host.deps.appData.update(workspaceId, appId, config.collection, config.recordId, config.record ?? {}) };
      }
      case 'upsert':
        return { [config.outputKey ?? 'record']: this.host.deps.appData.upsert(workspaceId, appId, config.collection, config.match ?? {}, config.record ?? {}) };
      case 'delete': {
        if (!config.recordId) throw new AgentisError('VALIDATION_FAILED', 'data_mutate delete requires recordId');
        this.host.deps.appData.delete(workspaceId, appId, config.collection, config.recordId);
        return { [config.outputKey ?? 'deleted']: config.recordId };
      }
      default:
        throw new AgentisError('VALIDATION_FAILED', `data_mutate: unknown operation ${String(config.operation)}`);
    }
  }

  /** `aggregate_window` node — buffer events across runs; emit a batch when the window closes. */
  executeAggregateWindow(ctx: RunningContext, node: WorkflowNode, config: AggregateWindowNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
    if (!this.host.deps.workflowStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'aggregate_window node present but workflow store not wired');
    }
    const { workspaceId, workflowId } = ctx;
    const itemsKey = `__aggwin:${node.id}:${config.key ?? 'default'}`;
    const firstAtKey = `${itemsKey}:firstAt`;
    this.host.deps.workflowStore.append(workspaceId, workflowId, itemsKey, inputData);
    const buffered = this.host.deps.workflowStore.get(workspaceId, workflowId, itemsKey);
    const items = Array.isArray(buffered) ? buffered : [];
    let firstAt = Number(this.host.deps.workflowStore.get(workspaceId, workflowId, firstAtKey) ?? 0);
    if (!firstAt) {
      firstAt = Date.now();
      this.host.deps.workflowStore.set(workspaceId, workflowId, firstAtKey, firstAt);
    }
    const countReady = config.maxCount ? items.length >= config.maxCount : false;
    const timeReady = config.windowMs ? Date.now() - firstAt >= config.windowMs : false;
    if (countReady || timeReady) {
      // Flush: reset the buffer and emit the batch downstream.
      this.host.deps.workflowStore.set(workspaceId, workflowId, itemsKey, []);
      this.host.deps.workflowStore.set(workspaceId, workflowId, firstAtKey, 0);
      return { [config.outputKey ?? 'items']: items, count: items.length, ready: true };
    }
    // Window still open — hold: complete the node but fire NO downstream this run.
    return { __hold: true, ready: false, buffered: items.length };
  }

  #customIntegrationManifest(workspaceId: string, service: string): ReturnType<typeof getCustomIntegrationManifest> | null {
    try {
      return getCustomIntegrationManifest(this.host.deps.db, workspaceId, service);
    } catch (err) {
      if (err instanceof AgentisError && err.code === 'RESOURCE_NOT_FOUND') return null;
      throw err;
    }
  }

  resolveIntegrationCredential(workspaceId: string, config: IntegrationNodeConfig): Record<string, unknown> | null {
    const explicitId = config.credentialId?.trim();
    const row = explicitId
      ? this.#credentialRowById(workspaceId, explicitId)
      : this.#credentialRowForIntegration(workspaceId, config.integrationId);
    if (!row) return null;
    if (!this.host.deps.vault) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration credential found but CredentialVault is not wired');
    }
    try {
      const decoded = this.host.deps.vault.decrypt(row.encryptedValue);
      const parsed = parseJsonOrString(decoded);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { value: decoded };
    } catch (err) {
      throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `failed to decrypt credential: ${(err as Error).message}`);
    }
  }

  #credentialRowById(workspaceId: string, credentialId: string): typeof schema.credentials.$inferSelect {
    const row = this.host.deps.db
      .select()
      .from(schema.credentials)
      .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.workspaceId, workspaceId)))
      .get();
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${credentialId}' not found`);
    }
    return row;
  }

  #credentialRowForIntegration(workspaceId: string, integrationId: string): typeof schema.credentials.$inferSelect | null {
    const slug = integrationId.toLowerCase();
    const candidates = this.host.deps.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.workspaceId, workspaceId))
      .all()
      .filter((row) => {
        const type = row.credentialType.toLowerCase();
        return type === slug || type === `integration_${slug}` || type === `oauth_${slug}`;
      });
    return candidates.sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)))[0] ?? null;
  }

  async executeHttpRequest(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HttpRequestNodeConfig,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    if (!config.url) throw new AgentisError('VALIDATION_FAILED', 'http_request node missing url');
    const requestUrl = await assertSafeUrl(config.url, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const method = (config.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? 30_000, 120_000));
    const maxRetries = Math.max(0, Math.min(config.maxRetries ?? 0, 5));
    const retryOn = new Set((config.retryOn ?? []).map((c) => Number(c)));
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    // AEJ (NATIVE-ADVANCEMENT Proposal 1): on a crash-recovery re-dispatch the
    // node carries a stable idempotency key. Send it as a standard
    // `Idempotency-Key` header so a request that may already have been sent
    // before the crash is deduped server-side — turning the retry into
    // effectively once. Never override an operator-supplied header.
    if (idempotencyKey && !Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    if (config.auth && config.auth.type !== 'none') {
      const credentialId = (config.auth as { credentialId?: string }).credentialId;
      if (!credentialId) {
        throw new AgentisError('VALIDATION_FAILED', 'http_request auth requires credentialId; inline secrets are not allowed');
      }
      if (!this.host.deps.vault) {
        throw new AgentisError('VALIDATION_FAILED', 'http_request auth requires the credential vault');
      }
      const row = this.host.deps.db
        .select()
        .from(schema.credentials)
        .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.workspaceId, ctx.workspaceId)))
        .get();
      if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${credentialId}' not found`);
      const secret = this.host.deps.vault.decrypt(row.encryptedValue);
      switch (config.auth.type) {
        case 'bearer':
          headers['authorization'] = `Bearer ${secret}`;
          break;
        case 'api_key':
          headers[config.auth.header.toLowerCase()] = secret;
          break;
        case 'basic':
          headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`;
          break;
        default:
          break;
      }
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `http:${node.id}`,
      nodeId: node.id,
      executorType: 'http',
      executorRef: `${method} ${redactUrl(requestUrl.toString())}`,
      startedAt: new Date().toISOString(),
    };
    try {
      let attempt = 0;
      let lastError: Error | null = null;
      while (attempt <= maxRetries) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Honor run-scoped cancellation: a cancelRun() aborts the outbound
        // request instead of letting it finish after the run was cancelled.
        const runSignal = ctx.abortController?.signal;
        const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
        try {
          const res = await fetch(requestUrl, {
            method,
            headers,
            body: method === 'GET' || method === 'DELETE' ? undefined : config.body,
            signal,
            redirect: 'manual',
          });
          clearTimeout(timer);
          const text = await res.text();
          let parsed: unknown = text;
          if (text && res.headers.get('content-type')?.includes('json')) {
            try {
              parsed = JSON.parse(text);
            } catch {
              /* keep text */
            }
          }
          if (!res.ok) {
            if (retryOn.has(res.status) && attempt < maxRetries) {
              attempt += 1;
              await sleep(backoffMs(attempt));
              continue;
            }
            return {
              ok: false,
              status: res.status,
              body: parsed,
            };
          }
          const out: Record<string, unknown> = {
            ok: true,
            status: res.status,
            body: parsed,
          };
          if (config.responseMapping) {
            const key = config.responseMapping.outputKey;
            if (config.responseMapping.bodyPath) {
              out[key] = readDotPath(parsed, config.responseMapping.bodyPath);
            } else {
              out[key] = parsed;
            }
          }
          return out;
        } catch (err) {
          clearTimeout(timer);
          lastError = err as Error;
          if (attempt >= maxRetries) break;
          attempt += 1;
          await sleep(backoffMs(attempt));
        }
      }
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `http_request failed: ${lastError?.message ?? 'unknown error'}`);
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /**
   * `code` node. JavaScript runs in the engine's guarded VM realm (same sandbox
   * as transform/filter — no Node globals, no require/import). Python is
   * best-effort via a child `python3` process; if Python is not on PATH the node
   * fails with a clean, actionable error.
   */
  async executeCode(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CodeNodeConfig,
    inputData: Record<string, unknown>,
    tctx?: TemplateContext,
  ): Promise<Record<string, unknown>> {
    const input = config.inputKeys && config.inputKeys.length > 0
      ? Object.fromEntries(config.inputKeys.map((k) => [k, inputData[k]]))
      : inputData;
    const wrapResult = (result: unknown): Record<string, unknown> => {
      if (config.outputKey) return { [config.outputKey]: result };
      if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
      return { value: result };
    };

    if (config.language === 'javascript') {
      // Unified Expression Contract: `code` bodies get the SAME scope as
      // transform/filter (nodes/trigger/scratchpad/store/workspace/run/loop) —
      // previously only `input` was bound, so the other names resolved to a
      // silent empty object.
      const scope = tctx
        ? {
            trigger: tctx.trigger,
            nodes: tctx.nodes,
            scratchpad: tctx.scratchpad,
            store: tctx.store,
            ...(tctx.workspace ? { workspace: tctx.workspace } : {}),
            ...(tctx.run ? { run: tctx.run } : {}),
            ...(tctx.loop ? { loop: tctx.loop } : {}),
          }
        : undefined;
      const result = evaluateExpression<unknown>(config.code, { input, ...(scope ? { ctx: scope } : {}) }, { timeoutMs: config.timeoutMs });
      return wrapResult(result);
    }

    if (config.language === 'python') {
      const result = await this.#runPython(ctx, config.code, input, config.timeoutMs);
      return wrapResult(result);
    }

    throw new AgentisError('VALIDATION_FAILED', `code: unsupported language ${(config as { language: string }).language}`);
  }

  async #runPython(
    ctx: RunningContext,
    code: string,
    input: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const { spawn } = await import('node:child_process');
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    // Cap raised to 15min so `code`(python) nodes can shell out to long-running
    // project helper scripts via subprocess when a workflow truly needs them.
    const timeout = Math.max(1, Math.min(timeoutMs ?? 15_000, 900_000));
    // The user code reads `input` (a dict) and assigns `output`; we print it as JSON.
    const program = [
      'import sys, json',
      'input = json.loads(sys.stdin.read())',
      'output = None',
      'def _main():',
      '    global output',
      ...code.split('\n').map((line) => `    ${line}`),
      '_main()',
      'sys.stdout.write(json.dumps(output))',
    ].join('\n');

    let lastErr = 'python runtime not found';
    for (const bin of candidates) {
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          const child = spawn(bin, ['-c', program], { stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          const runSignal = ctx.abortController?.signal;
          const onAbort = () => child.kill('SIGKILL');
          runSignal?.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`python execution timed out after ${timeout}ms`)); }, timeout);
          child.on('error', (e) => { clearTimeout(timer); reject(e); });
          child.stdout.on('data', (d) => { out += String(d); });
          child.stderr.on('data', (d) => { err += String(d); });
          child.on('close', (codeNum) => {
            clearTimeout(timer);
            runSignal?.removeEventListener('abort', onAbort);
            if (codeNum !== 0) { reject(new Error(err.trim() || `python exited with code ${codeNum}`)); return; }
            try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(out); }
          });
          child.stdin.write(JSON.stringify(input));
          child.stdin.end();
        });
        return result;
      } catch (e) {
        lastErr = (e as Error).message;
        // ENOENT → try the next candidate; a real execution error → surface it.
        if (!/ENOENT|not found|not recognized/i.test(lastErr)) {
          throw new AgentisError('INTEGRATION_OPERATION_FAILED', `code (python) failed: ${lastErr}`);
        }
      }
    }
    throw new AgentisError('EXTENSION_RUNTIME_UNAVAILABLE', `code (python) requires a python interpreter on PATH: ${lastErr}`);
  }

  /** `spreadsheet` node. CSV is built-in; XLSX uses the bundled exceljs. */
  async executeSpreadsheet(
    node: WorkflowNode,
    config: SpreadsheetNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const key = config.outputKey ?? (config.operation === 'parse' ? 'rows' : 'content');
    const source = config.inputPath ? readDotPath(inputData, config.inputPath) : inputData;
    const hasHeaders = config.hasHeaders !== false;

    if (config.operation === 'parse') {
      if (config.format === 'csv') {
        const rows = parseCsv(asString(source), hasHeaders);
        return { [key]: rows };
      }
      // xlsx parse — source is a base64 string or Buffer.
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const buf = Buffer.isBuffer(source) ? source : Buffer.from(asString(source), 'base64');
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = config.sheet ? wb.getWorksheet(config.sheet) ?? wb.worksheets[0] : wb.worksheets[0];
      const rows = worksheetToRows(ws, hasHeaders);
      return { [key]: rows };
    }

    // build
    const records = Array.isArray(source) ? (source as Array<Record<string, unknown>>) : [];
    if (config.format === 'csv') {
      return { [key]: buildCsv(records, hasHeaders) };
    }
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(typeof config.sheet === 'string' ? config.sheet : 'Sheet1');
    const headers = records.length > 0 ? Object.keys(records[0]!) : [];
    if (hasHeaders && headers.length) ws.addRow(headers);
    for (const rec of records) ws.addRow(headers.map((h) => rec[h] as unknown));
    const out = await wb.xlsx.writeBuffer();
    return { [key]: Buffer.from(out).toString('base64'), encoding: 'base64' };
  }

  /** `graphql` node — POSTs a structured query to the configured endpoint. */
  async executeGraphQl(
    ctx: RunningContext,
    node: WorkflowNode,
    config: GraphQlNodeConfig,
  ): Promise<Record<string, unknown>> {
    if (!config.endpoint) throw new AgentisError('VALIDATION_FAILED', 'graphql node missing endpoint');
    const endpoint = await assertSafeUrl(config.endpoint, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? 30_000, 120_000));
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(config.headers ?? {}) };
    if (config.credentialId) {
      if (!this.host.deps.vault) throw new AgentisError('VALIDATION_FAILED', 'graphql credential requires the credential vault');
      const row = this.host.deps.db
        .select()
        .from(schema.credentials)
        .where(and(eq(schema.credentials.id, config.credentialId), eq(schema.credentials.workspaceId, ctx.workspaceId)))
        .get();
      if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${config.credentialId}' not found`);
      headers['authorization'] = `Bearer ${this.host.deps.vault.decrypt(row.encryptedValue)}`;
    }
    const variables: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config.variables ?? {})) variables[k] = coerceJson(v);

    ctx.state.activeExecutions[node.id] = {
      taskId: `graphql:${node.id}`,
      nodeId: node.id,
      executorType: 'http',
      executorRef: `GraphQL ${redactUrl(endpoint.toString())}`,
      startedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const runSignal = ctx.abortController?.signal;
    const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: config.query, variables }),
        signal,
        redirect: 'manual',
      });
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      const errors = (body as { errors?: unknown[] })?.errors;
      if (!res.ok || (Array.isArray(errors) && errors.length > 0)) {
        throw new AgentisError('INTEGRATION_OPERATION_FAILED', `graphql request failed (status ${res.status}): ${JSON.stringify(errors ?? body).slice(0, 500)}`);
      }
      const data = (body as { data?: unknown })?.data ?? body;
      return config.outputKey ? { [config.outputKey]: data } : { data, ok: true, status: res.status };
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `graphql request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      delete ctx.state.activeExecutions[node.id];
    }
  }

  async executeWorkflowStore(
    ctx: RunningContext,
    config: WorkflowStoreNodeConfig,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!this.host.deps.workflowStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workflow_store node present but WorkflowStoreService not wired');
    }
    if (!ctx.workflowId) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workflow_store node requires a persistent workflow id (ephemeral runs are not supported)');
    }
    const out: Record<string, unknown> = {};
    for (const op of config.operations ?? []) {
      const key = op.key ? resolveTemplate(op.key, tctx) : undefined;
      const outKey = op.outputKey ?? key ?? op.op;
      switch (op.op) {
        case 'get': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.get requires a key');
          out[outKey] = this.host.deps.workflowStore.get(ctx.workspaceId, ctx.workflowId, key);
          break;
        }
        case 'set': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.set requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.host.deps.workflowStore.set(ctx.workspaceId, ctx.workflowId, key, value);
          break;
        }
        case 'delete': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.delete requires a key');
          out[outKey] = this.host.deps.workflowStore.delete(ctx.workspaceId, ctx.workflowId, key);
          break;
        }
        case 'increment': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.increment requires a key');
          out[outKey] = this.host.deps.workflowStore.increment(ctx.workspaceId, ctx.workflowId, key, op.incrementBy ?? 1);
          break;
        }
        case 'append': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.append requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.host.deps.workflowStore.append(ctx.workspaceId, ctx.workflowId, key, value);
          break;
        }
        case 'get_all': {
          out[outKey] = this.host.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId);
          break;
        }
        default:
          throw new AgentisError('VALIDATION_FAILED', `workflow_store: unknown op ${(op as { op: string }).op}`);
      }
    }
    return out;
  }

  async executeWorkspaceStore(
    ctx: RunningContext,
    config: WorkspaceStoreNodeConfig,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!this.host.deps.workspaceStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workspace_store node present but WorkspaceStoreService not wired');
    }
    const ws = ctx.workspaceId;
    const out: Record<string, unknown> = {};
    for (const op of config.operations ?? []) {
      const key = op.key ? resolveTemplate(op.key, tctx) : undefined;
      const outKey = op.outputKey ?? key ?? op.op;
      switch (op.op) {
        case 'get':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.get requires a key');
          out[outKey] = this.host.deps.workspaceStore.get(ws, key);
          break;
        case 'set': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.set requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.host.deps.workspaceStore.set(ws, key, value);
          break;
        }
        case 'delete':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.delete requires a key');
          out[outKey] = this.host.deps.workspaceStore.delete(ws, key);
          break;
        case 'increment':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.increment requires a key');
          out[outKey] = this.host.deps.workspaceStore.increment(ws, key, op.incrementBy ?? 1);
          break;
        case 'append': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.append requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.host.deps.workspaceStore.append(ws, key, value);
          break;
        }
        case 'get_all':
          out[outKey] = this.host.deps.workspaceStore.snapshot(ws);
          break;
        default:
          throw new AgentisError('VALIDATION_FAILED', `workspace_store: unknown op ${(op as { op: string }).op}`);
      }
    }
    return out;
  }

  executeGuardrails(
    config: GuardrailsNodeConfig,
    inputData: Record<string, unknown>,
  ): { shouldFail: boolean; message: string; output: Record<string, unknown> } {
    const violations: Array<{ rule: string; target: string; message: string }> = [];
    for (const rule of config.rules ?? []) {
      const value = readDotPath(inputData, rule.target);
      const ok = checkGuardrail(rule.type, value, rule);
      if (!ok) {
        violations.push({
          rule: rule.type,
          target: rule.target,
          message: rule.message ?? `guardrail '${rule.type}' failed for '${rule.target}'`,
        });
      }
    }
    const block = (config.onViolation ?? 'block') === 'block' && violations.length > 0;
    return {
      shouldFail: block,
      message: violations.map((v) => v.message).join('; ') || 'guardrails violated',
      output: { ...inputData, guardrailViolations: violations },
    };
  }
}
