/**
 * appContractRuntime — AGENT-FIRST-ARCHITECTURE.md Plane 1.
 *
 * Owns the app runtime contract during a run:
 *   - Snapshots the contract at run start (immutable for the run's lifetime)
 *   - Validates terminal outputs against output declarations + JSON schemas
 *   - Provides budget reservation + spend tracking
 *   - Provides degradation hints when costMode='adaptive'
 *
 * Spec: docs/AGENTIS-APP-FORMAT.md §3, §4.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  AgentisError,
  DEFAULT_RUNTIME_CONTRACT,
  type AppRuntimeContract,
  type AppOutputDeclaration,
} from '@agentis/core';
import type { Logger } from '../logger.js';

export interface ContractSnapshotArgs {
  workspaceId: string;
  packageId?: string;
  packageVersion?: string;
  contract: AppRuntimeContract;
}

export interface ContractValidationResult {
  ok: boolean;
  missingRequired: string[];
  schemaErrors: Array<{ key: string; message: string }>;
  partialCovered: string[];
}

export class AppContractRuntime {
  /** In-memory cache: runId → contract snapshot. */
  readonly #byRun = new Map<string, AppRuntimeContract>();
  /** Spend tally per run, in cents. */
  readonly #spend = new Map<string, number>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /**
   * Persist a snapshot of the contract for the run. The same contract is
   * cached in memory so hot-path checks avoid the DB round-trip.
   */
  snapshotForRun(runId: string, args: ContractSnapshotArgs): AppRuntimeContract {
    const contract = this.#withDefaults(args.contract);
    this.#byRun.set(runId, contract);
    this.#spend.set(runId, 0);
    const id = randomUUID();
    const json = JSON.stringify(contract);
    const hash = createHash('sha256').update(json).digest('hex');
    this.db
      .insert(schema.appRuntimeContracts)
      .values({
        id,
        workspaceId: args.workspaceId,
        packageId: args.packageId ?? null,
        packageVersion: args.packageVersion ?? null,
        contract,
        contractHash: hash,
      })
      .run();
    return contract;
  }

  /** Look up the contract for a run. Falls back to defaults if none was set. */
  forRun(runId: string): AppRuntimeContract {
    return this.#byRun.get(runId) ?? DEFAULT_RUNTIME_CONTRACT;
  }

  /**
   * Validate terminal outputs against the contract.
   * Pure: no side effects, safe to call multiple times.
   */
  validateTerminal(runId: string, outputs: Record<string, unknown>): ContractValidationResult {
    const contract = this.forRun(runId);
    const result: ContractValidationResult = {
      ok: true,
      missingRequired: [],
      schemaErrors: [],
      partialCovered: [],
    };
    for (const decl of contract.outputs) {
      const present = decl.key in outputs;
      if (decl.required && !present) {
        result.missingRequired.push(decl.key);
        result.ok = false;
        continue;
      }
      if (present) {
        result.partialCovered.push(decl.key);
        const err = this.#shapeCheck(decl, outputs[decl.key]);
        if (err) {
          result.schemaErrors.push({ key: decl.key, message: err });
          result.ok = false;
        }
      }
    }

    // Degradation policy may permit a partial run with the minOutputSet only.
    if (
      !result.ok &&
      contract.degradationPolicy.allowPartialOutputs &&
      contract.degradationPolicy.minOutputSet
    ) {
      const minMissing = contract.degradationPolicy.minOutputSet.filter(
        (k) => !(k in outputs),
      );
      if (minMissing.length === 0 && result.schemaErrors.length === 0) {
        // Promote to acceptable degraded success.
        result.ok = true;
      }
    }
    return result;
  }

  /** Reserve budget on dispatch. Returns false when the reservation would exceed cap. */
  reserveSpend(runId: string, addCents: number): { ok: boolean; spent: number; cap?: number } {
    const contract = this.forRun(runId);
    const next = (this.#spend.get(runId) ?? 0) + addCents;
    const cap = contract.budgetPolicy.maxCostCentsPerRun;
    if (cap !== undefined && next > cap) {
      if (contract.budgetPolicy.costMode === 'strict') {
        return { ok: false, spent: this.#spend.get(runId) ?? 0, cap };
      }
      this.logger.warn('budget.over_cap', { runId, next, cap, mode: contract.budgetPolicy.costMode });
    }
    this.#spend.set(runId, next);
    return { ok: true, spent: next, cap };
  }

  /** Read-only spend snapshot. */
  spendFor(runId: string): { spent: number; cap?: number; mode: 'strict' | 'warn' | 'adaptive' } {
    const contract = this.forRun(runId);
    return {
      spent: this.#spend.get(runId) ?? 0,
      cap: contract.budgetPolicy.maxCostCentsPerRun,
      mode: contract.budgetPolicy.costMode,
    };
  }

  /** Drop in-memory state for a finished run. */
  dispose(runId: string): void {
    this.#byRun.delete(runId);
    this.#spend.delete(runId);
  }

  // ── helpers ────────────────────────────────────────────────

  #withDefaults(contract: AppRuntimeContract): AppRuntimeContract {
    return {
      outputs: contract.outputs ?? DEFAULT_RUNTIME_CONTRACT.outputs,
      successPolicy: { ...DEFAULT_RUNTIME_CONTRACT.successPolicy, ...contract.successPolicy },
      budgetPolicy: { ...DEFAULT_RUNTIME_CONTRACT.budgetPolicy, ...contract.budgetPolicy },
      reliabilityPolicy: { ...DEFAULT_RUNTIME_CONTRACT.reliabilityPolicy, ...contract.reliabilityPolicy },
      escalationPolicy: { ...DEFAULT_RUNTIME_CONTRACT.escalationPolicy, ...contract.escalationPolicy },
      degradationPolicy: { ...DEFAULT_RUNTIME_CONTRACT.degradationPolicy, ...contract.degradationPolicy },
    };
  }

  #shapeCheck(decl: AppOutputDeclaration, value: unknown): string | null {
    if (!decl.schema) return null;
    const schema = decl.schema as { type?: string; required?: string[] };
    if (schema.type === 'string' && typeof value !== 'string') return `expected string, got ${typeof value}`;
    if (schema.type === 'number' && typeof value !== 'number') return `expected number, got ${typeof value}`;
    if (schema.type === 'boolean' && typeof value !== 'boolean') return `expected boolean, got ${typeof value}`;
    if (schema.type === 'object' && (typeof value !== 'object' || value === null)) return `expected object, got ${typeof value}`;
    if (schema.type === 'array' && !Array.isArray(value)) return `expected array, got ${typeof value}`;
    if (schema.type === 'object' && Array.isArray(schema.required)) {
      const obj = value as Record<string, unknown>;
      for (const required of schema.required) {
        if (!(required in obj)) return `missing required field '${required}'`;
      }
    }
    return null;
  }
}
