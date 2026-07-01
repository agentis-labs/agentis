import type { ExtensionOperation, ExtensionPermission } from '@agentis/core';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { normalizeExtensionIdentity } from '../extensionLibrary.js';
import { ExtensionRuntime } from '../extensionRuntime.js';

export function registerCapabilityTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.register(
    {
      id: 'agentis.extension.test',
      family: 'inspect',
      description:
        'TEST an installed extension operation with sample inputs BEFORE wiring it into a workflow — runs it for real in the sandbox and returns { ok, output, producedKeys, error, durationMs }. Use this to PROVE an extension_task node will emit what the next node reads (closes the build loop for extensions the way agentis.workflow.dry_run does for graphs). Pass extensionId or extensionSlug (from agentis.extension.resolve/create), the operationName, and a sample input object.',
      inputSchema: {
        type: 'object',
        properties: {
          extensionId: { type: 'string', description: 'Extension ID (from resolve/create).' },
          extensionSlug: { type: 'string', description: 'Extension slug (alternative to extensionId).' },
          operationName: { type: 'string', description: "Operation to run. Defaults to the extension's first operation." },
          input: { type: 'object', description: 'Sample input object the operation would receive at run time.' },
        },
        required: [],
      },
      mutating: false,
      mcpExposed: true,
    },
    async (args, ctx) => {
      const extensionId = stringArg(args.extensionId);
      const extensionSlug = stringArg(args.extensionSlug);
      if (!extensionId && !extensionSlug) throw new Error('extensionId or extensionSlug is required');
      const operationName = stringArg(args.operationName);
      // A throwaway runtime built from the deps we already hold (db + logger) —
      // node_worker extensions run in the in-process sandbox, no DI/bootstrap needed.
      const runtime = new ExtensionRuntime(deps.db, deps.logger, {
        dockerEnabled: String(process.env.AGENTIS_EXTENSION_DOCKER ?? '').toLowerCase() === 'true',
      });
      const outcome = await runtime.execute({
        workspaceId: ctx.workspaceId,
        ...(extensionId ? { extensionId } : {}),
        ...(extensionSlug ? { extensionSlug } : {}),
        ...(operationName ? { operationName } : {}),
        input: isRecord(args.input) ? args.input : {},
        scratchpadSnapshot: {},
      });
      if (outcome.ok) {
        return { ok: true, output: outcome.output, producedKeys: Object.keys(outcome.output), durationMs: outcome.durationMs };
      }
      return { ok: false, errorCode: outcome.errorCode, error: outcome.message, durationMs: outcome.durationMs };
    },
  );
  registry.register(
    {
      id: 'agentis.extension.resolve',
      family: 'inspect',
      description:
        'Resolve an extension requirement against installed workspace capabilities before creating anything. Returns ranked reusable candidates, listener suitability, and whether to reuse, update, or create.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Capability intent or extension name.' },
          requiresListenerSource: { type: 'boolean' },
          capabilityTags: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
      },
      mutating: false,
      mcpExposed: true,
    },
    async (args, ctx) => {
      const query = stringArg(args.query);
      if (!query) throw new Error('query is required');
      const requiresListenerSource = args.requiresListenerSource === true;
      const requestedTags = stringArray(args.capabilityTags).map((tag) => tag.toLowerCase());
      const queryTokens = tokenize(query);
      const candidates = deps.db
        .select()
        .from(schema.extensions)
        .where(eq(schema.extensions.workspaceId, ctx.workspaceId))
        .all()
        .map((row) => {
          const manifest = isRecord(row.manifest) ? row.manifest : {};
          const operations = normalizeOperations(manifest.operations);
          const tags = stringArray(manifest.capabilityTags);
          const listenerOperations = operations
            .filter((operation) => operation.isListenerSource)
            .map((operation) => operation.name);
          const permissions = normalizePermissions(manifest.permissions);
          const text = [
            row.name,
            row.slug,
            stringArg(manifest.description) ?? '',
            ...tags,
            ...operations.map((operation) => `${operation.name} ${operation.description ?? ''}`),
          ].join(' ');
          const candidateTokens = new Set(tokenize(text));
          const tokenMatches = queryTokens.filter((token) => candidateTokens.has(token)).length;
          const identityMatch = normalizeExtensionIdentity(row.name) === normalizeExtensionIdentity(query)
            || normalizeExtensionIdentity(row.slug) === normalizeExtensionIdentity(query);
          const tagMatches = requestedTags.filter((tag) =>
            tags.some((candidate) => candidate.toLowerCase() === tag),
          ).length;
          const listenerReady = listenerOperations.length > 0
            && permissions.includes('listener')
            && permissions.includes('listener.emit');
          const score = (identityMatch ? 100 : 0)
            + tokenMatches * 12
            + tagMatches * 16
            + (requiresListenerSource && listenerReady ? 30 : 0);
          const gaps = [
            ...(requiresListenerSource && listenerOperations.length === 0
              ? ['No operation is marked as a listener source.']
              : []),
            ...(requiresListenerSource && !permissions.includes('listener')
              ? ['Missing listener permission.']
              : []),
            ...(requiresListenerSource && !permissions.includes('listener.emit')
              ? ['Missing listener.emit permission.']
              : []),
          ];
          return {
            extensionId: row.id,
            name: row.name,
            slug: row.slug,
            score,
            reusable: gaps.length === 0,
            listenerOperations,
            operations: operations.map((operation) => operation.name),
            capabilityTags: tags,
            gaps,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      const best = candidates[0];
      return {
        query,
        found: Boolean(best),
        recommendation: !best ? 'create' : best.reusable ? 'reuse' : 'update',
        selectedExtensionId: best?.extensionId ?? null,
        candidates,
      };
    },
  );

  registry.register(
    {
      id: 'agentis.ability.create',
      family: 'build',
      description:
        'Create a reusable Agentis ability. Choose an ON-RAMP: describe it (intent), POINT AT EXAMPLES (examples: input/output pairs it should reproduce), or POINT AT MATERIAL (material: a doc/spec/source to distill). The ability is materialized immediately and queued for compilation.',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'The specialist behavior or reusable capability to create.' },
          examples: { type: 'array', description: 'Examples on-ramp: [{ inputText, outputText }] pairs the ability should learn to reproduce.', items: { type: 'object' } },
          material: { type: 'string', description: 'Material on-ramp: a document/spec/source to distill the ability from.' },
          materialTitle: { type: 'string', description: 'Optional title for the material.' },
          name: { type: 'string', description: 'Optional ability name.' },
          domainTag: { type: 'string', description: 'Optional routing domain such as research, monitoring, or email.' },
        },
        required: ['intent'],
      },
      mutating: true,
      autoExecute: true,
      mcpExposed: true,
    },
    async (args, ctx) => {
      if (!deps.abilityCreation) throw new Error('Ability creation service is unavailable');
      const intent = stringArg(args.intent);
      if (!intent) throw new Error('intent is required');
      // Pick the richest on-ramp the caller supplied (material > examples > intent)
      // so an agent can POINT AT work, not just describe it (P5).
      const examples = Array.isArray(args.examples)
        ? (args.examples as Array<Record<string, unknown>>)
            .map((e) => ({ inputText: String(e?.inputText ?? e?.input ?? ''), outputText: String(e?.outputText ?? e?.output ?? '') }))
            .filter((e) => e.inputText || e.outputText)
        : undefined;
      const material = stringArg(args.material);
      const hasExamples = Boolean(examples && examples.length > 0);
      const result = await deps.abilityCreation.draft({
        workspaceId: ctx.workspaceId,
        authorId: ctx.userId,
        from: material ? 'material' : hasExamples ? 'examples' : 'intent',
        intent,
        ...(hasExamples ? { examples } : {}),
        ...(material ? { material } : {}),
        ...(stringArg(args.materialTitle) ? { materialTitle: stringArg(args.materialTitle)! } : {}),
        ...(stringArg(args.name) ? { name: stringArg(args.name)! } : {}),
        ...(stringArg(args.domainTag) ? { domainTag: stringArg(args.domainTag)! } : {}),
      });
      return {
        abilityId: result.ability?.id,
        name: result.ability?.name,
        slug: result.ability?.slug,
        compileStatus: result.ability?.compileStatus,
        synthesized: result.synthesized,
        notes: result.notes,
      };
    },
  );

  registry.register(
    {
      id: 'agentis.extension.create',
      family: 'build',
      description:
        'Create or update a workspace node-worker extension from JavaScript source and an explicit operation contract. Call agentis.extension.resolve first. Pass extensionId when updating a matched capability; do not create a renamed duplicate.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable extension name.' },
          extensionId: { type: 'string', description: 'Existing extension ID returned by agentis.extension.resolve when updating or upgrading a capability.' },
          slug: { type: 'string', description: 'Optional stable extension slug.' },
          description: { type: 'string', description: 'What the extension does.' },
          source: {
            type: 'string',
            description: 'JavaScript source: declare a TOP-LEVEL async function per operation — `async function <operationName>(inputs, ctx) { ... }`. Do NOT use module.exports, exports, require, or import (all blocked by the sandbox); use `ctx.http.fetch(url, opts)` for network. Return the operation output object.',
          },
          operations: {
            type: 'array',
            description: 'Operation manifests with name, description, inputSchema, outputSchema, and optional listener fields.',
            items: { type: 'object' },
          },
          permissions: {
            type: 'array',
            description: 'Required extension permissions.',
            items: { type: 'string' },
          },
          capabilityTags: { type: 'array', items: { type: 'string' } },
          allowedDomains: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number' },
          listenerSourceOperation: {
            type: 'string',
            description: 'Operation name that acts as the persistent listener source. This marks the operation and grants the required listener permissions.',
          },
        },
        required: ['name', 'source', 'operations'],
      },
      mutating: true,
      autoExecute: true,
      mcpExposed: true,
    },
    async (args, ctx) => {
      if (!deps.extensionLibrary) throw new Error('Extension library is unavailable');
      const name = stringArg(args.name);
      const source = stringArg(args.source);
      const operations = normalizeOperations(args.operations);
      if (!name || !source || operations.length === 0) {
        throw new Error('name, source, and at least one operation are required');
      }
      const permissions = normalizePermissions(args.permissions);
      const capabilityTags = stringArray(args.capabilityTags);
      const listenerSourceOperation = stringArg(args.listenerSourceOperation);
      const listenerIntent = listenerSourceOperation
        || capabilityTags.some((tag) => tag.toLowerCase() === 'listener')
        || permissions.some((permission) => permission.startsWith('listener'));
      const contractedOperations = operations.map((operation) =>
        listenerSourceOperation === operation.name
          ? {
              ...operation,
              isListenerSource: true,
              listenerConfig: {
                emitsEvents: true,
                ...(operation.listenerConfig ?? {}),
              },
            }
          : operation,
      );
      if (listenerSourceOperation && !contractedOperations.some((operation) => operation.name === listenerSourceOperation)) {
        throw new Error(`listenerSourceOperation "${listenerSourceOperation}" does not match a declared operation`);
      }
      if (listenerIntent && !contractedOperations.some((operation) => operation.isListenerSource)) {
        throw new Error('Listener extensions must identify a listenerSourceOperation or mark an operation with isListenerSource');
      }
      const effectivePermissions = [...permissions];
      if (contractedOperations.some((operation) => operation.isListenerSource)) {
        if (!effectivePermissions.includes('listener')) effectivePermissions.push('listener');
        if (!effectivePermissions.includes('listener.emit')) effectivePermissions.push('listener.emit');
        if (
          contractedOperations.some((operation) => operation.listenerConfig?.cursorSupported)
          && !effectivePermissions.includes('listener.cursor')
        ) effectivePermissions.push('listener.cursor');
      }
      const allowedDomains = stringArray(args.allowedDomains);
      const timeoutMs = numberArg(args.timeoutMs);
      const created = await deps.extensionLibrary.createNodeWorkerExtension(
        { workspaceId: ctx.workspaceId, ambientId: ctx.ambientId ?? null, userId: ctx.userId },
        {
          name,
          source,
          operations: contractedOperations,
          ...(stringArg(args.extensionId) ? { extensionId: stringArg(args.extensionId)! } : {}),
          ...(stringArg(args.slug) ? { slug: stringArg(args.slug)! } : {}),
          ...(stringArg(args.description) ? { description: stringArg(args.description)! } : {}),
          ...(effectivePermissions.length ? { permissions: effectivePermissions } : {}),
          ...(capabilityTags.length ? { capabilityTags } : {}),
          ...(allowedDomains.length ? { allowedDomains } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      );
      return {
        extensionId: created.id,
        name: created.manifest.name,
        slug: created.manifest.slug,
        runtime: created.manifest.runtime,
        operations: created.manifest.operations.map((operation) => operation.name),
        listenerOperations: created.manifest.listenerOperations ?? [],
        created: created.created,
        matchedBy: created.matchedBy,
        path: created.path,
      };
    },
  );
}

function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

function normalizeOperations(value: unknown): ExtensionOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = stringArg(entry.name);
    if (!name) return [];
    const listenerConfig = isRecord(entry.listenerConfig)
      ? {
          ...(typeof entry.listenerConfig.emitsEvents === 'boolean'
            ? { emitsEvents: entry.listenerConfig.emitsEvents }
            : {}),
          ...(typeof entry.listenerConfig.cursorSupported === 'boolean'
            ? { cursorSupported: entry.listenerConfig.cursorSupported }
            : {}),
          ...(stringArg(entry.listenerConfig.description)
            ? { description: stringArg(entry.listenerConfig.description)! }
            : {}),
        }
      : undefined;
    return [{
      name,
      ...(stringArg(entry.description) ? { description: stringArg(entry.description)! } : {}),
      inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : {},
      outputSchema: isRecord(entry.outputSchema) ? entry.outputSchema : {},
      ...(entry.isListenerSource === true ? { isListenerSource: true } : {}),
      ...(listenerConfig && Object.keys(listenerConfig).length > 0 ? { listenerConfig } : {}),
    }];
  });
}

const EXTENSION_PERMISSIONS = new Set<ExtensionPermission>([
  'network',
  'network.unrestricted',
  'credentials',
  'workspace.read',
  'workspace.write',
  'filesystem',
  'spawn',
  'listener',
  'listener.emit',
  'listener.cursor',
  'kv.read',
  'kv.write',
]);

function normalizePermissions(value: unknown): ExtensionPermission[] {
  return stringArray(value).filter((permission): permission is ExtensionPermission =>
    EXTENSION_PERMISSIONS.has(permission as ExtensionPermission),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}
