import {
  AgentisError,
  appManifestSchema,
  dataQuerySchema,
  type AppManifest,
  type DataQuery,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppDatastore } from './appDatastore.js';
import { AppPackager } from './appPackager.js';
import { AppSurfaceStore } from './appSurfaceStore.js';

export interface AppHarnessAction {
  surface: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface AppHarnessAssertion {
  collection: string;
  query?: DataQuery;
  count?: number;
  includes?: Record<string, unknown>;
}

export interface AppHarnessCase {
  manifest: AppManifest;
  actions?: AppHarnessAction[];
  assertions?: AppHarnessAssertion[];
}

export interface AppHarnessResult {
  appId: string;
  surfaces: string[];
  assertions: Array<{ collection: string; count: number }>;
}

class HarnessRollback extends Error {}

/**
 * Executes an AppManifest against the same stores used by the runtime, then
 * rolls the transaction back. V1 intentionally supports deterministic data
 * actions only; workflow/tool execution belongs in engine integration tests.
 */
export class AppTestHarness {
  constructor(private readonly db: AgentisSqliteDb) {}

  runIsolated(workspaceId: string, userId: string, testCase: AppHarnessCase): AppHarnessResult {
    let result: AppHarnessResult | undefined;
    try {
      this.db.transaction((tx) => {
        result = new AppTestHarness(tx as AgentisSqliteDb).run(workspaceId, userId, testCase);
        throw new HarnessRollback();
      });
    } catch (error) {
      if (!(error instanceof HarnessRollback)) throw error;
    }
    if (!result) throw new AgentisError('INTERNAL_ERROR', 'App test harness did not produce a result');
    return result;
  }

  private run(workspaceId: string, userId: string, testCase: AppHarnessCase): AppHarnessResult {
    const manifest = appManifestSchema.parse(testCase.manifest);
    const { appId } = new AppPackager(this.db).fromManifest(workspaceId, userId, manifest);
    const surfaces = new AppSurfaceStore({ db: this.db });
    const datastore = new AppDatastore(this.db);

    for (const actionCall of testCase.actions ?? []) {
      const surface = surfaces.get(workspaceId, appId, actionCall.surface);
      const action = surface.actions.find((candidate) => candidate.name === actionCall.name);
      if (!action) throw new AgentisError('RESOURCE_NOT_FOUND', `action not declared: ${actionCall.surface}.${actionCall.name}`);
      if (action.kind !== 'data') {
        throw new AgentisError('VALIDATION_FAILED', `App test harness supports deterministic data actions only: ${action.kind}`);
      }
      this.invokeDataAction(datastore, workspaceId, userId, appId, action.target, actionCall.args ?? {});
    }

    const assertions = (testCase.assertions ?? []).map((assertion) => {
      const rows = datastore.query(
        workspaceId,
        appId,
        assertion.collection,
        dataQuerySchema.parse(assertion.query ?? {}),
      ).rows;
      if (assertion.count !== undefined && rows.length !== assertion.count) {
        throw new AgentisError('VALIDATION_FAILED', `Expected ${assertion.count} ${assertion.collection} records, received ${rows.length}`);
      }
      if (assertion.includes && !rows.some((row) => objectIncludes(row.data, assertion.includes!))) {
        throw new AgentisError('VALIDATION_FAILED', `Expected ${assertion.collection} records to include the asserted values`);
      }
      return { collection: assertion.collection, count: rows.length };
    });

    return {
      appId,
      surfaces: surfaces.list(workspaceId, appId).map((surface) => surface.name),
      assertions,
    };
  }

  private invokeDataAction(
    datastore: AppDatastore,
    workspaceId: string,
    userId: string,
    appId: string,
    target: string,
    args: Record<string, unknown>,
  ): void {
    const [collection, op] = target.split('.');
    if (!collection || !op) throw new AgentisError('VALIDATION_FAILED', `data action target must be "collection.op": ${target}`);
    switch (op) {
      case 'insert':
        datastore.insert(workspaceId, appId, collection, (args.record as Record<string, unknown>) ?? args, userId);
        return;
      case 'update':
        datastore.update(workspaceId, appId, collection, String(args.id), (args.patch as Record<string, unknown>) ?? {});
        return;
      case 'upsert':
        datastore.upsert(
          workspaceId,
          appId,
          collection,
          (args.match as Record<string, unknown>) ?? {},
          (args.record as Record<string, unknown>) ?? {},
          userId,
        );
        return;
      case 'delete':
        datastore.delete(workspaceId, appId, collection, String(args.id));
        return;
      default:
        throw new AgentisError('VALIDATION_FAILED', `unknown data action: ${target}`);
    }
  }
}

function objectIncludes(record: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => Object.is(record[key], value));
}
