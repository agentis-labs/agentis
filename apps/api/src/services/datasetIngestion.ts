/**
 * DatasetIngestion — Class 2 ingestion pipeline.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §6 + §10.
 *
 * Pipeline:
 *
 *   parse(format)
 *     → chunk(strategy)
 *     → route(targetStore)
 *     → recordImpact()
 *
 * Formats (V1.1+):
 *   - text/csv     — RFC4180 with quoted fields, header row required
 *   - json         — array or single object
 *   - jsonl/ndjson — one JSON object per line
 *   - text/md      — raw text treated as one document
 *   - pdf          — text extraction from FlateDecode content streams (Agentis 1.1.1)
 *   - markdown-zip — zip archive containing .md files (Agentis 1.1.1)
 *
 * Chunking strategies:
 *   per-row / per-document / per-function — 1 item → 1 chunk
 *   sliding-window — overlapping 220-token windows, 160-token stride
 *   semantic       — paragraph splits (V1 approximation; LLM split is future)
 *
 * Per-item tracking (Agentis 1.1.1):
 *   Each parsed item gets a row in `dataset_import_items` (status: pending →
 *   completed|failed). Items are dedup-keyed by SHA-256 content hash so the
 *   `resume()` method can skip already-completed rows when the operator
 *   re-uploads the same file.
 *
 * Job lifecycle:
 *
 *   pending → parsing → chunking → indexing → completed
 *                                          \→ failed
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  AgentisError,
  type DatasetSpec,
  type DatasetImpactPreview,
  type DatasetIngestionJob,
  type DatasetIngestionStatus,
  type IngestionTargetStore,
  type ChunkingStrategy,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { AppMemoryStore } from './appMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';

// ────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────

export type IngestionFormat = 'csv' | 'json' | 'jsonl' | 'text' | 'pdf' | 'markdown-zip';

export interface StartIngestionArgs {
  workspaceId: string;
  appId: string;
  /** The DatasetSpec the operator is fulfilling. */
  spec: DatasetSpec;
  /**
   * Raw upload payload.
   *   - `string`  — text-based formats (CSV, JSON, JSONL, TXT, MD).
   *   - `Buffer`  — binary formats (PDF, markdown-zip). Agentis 1.1.1+.
   */
  payload: string | Buffer;
  /** Optional source name (file name shown in UI). */
  fileName?: string;
}

export interface ResumeIngestionArgs {
  workspaceId: string;
  appId: string;
  jobId: string;
  /** Spec (re-loaded from the app manifest by the caller). */
  spec: DatasetSpec;
  /** Re-uploaded payload — same file as the original job. */
  payload: string | Buffer;
  fileName?: string;
}

export interface DatasetPreviewResult {
  recordCount: number;
  columns: string[];
  previewRows: Array<{ title: string; fields: Record<string, unknown> }>;
  warnings: string[];
  sourceHash: string;
  byteSize: number;
}

// ────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────

/** One parsed item before chunking. */
interface ParsedItem {
  content: string;
  meta?: Record<string, unknown>;
}

/** One chunked item ready to route. */
interface ChunkedItem {
  title: string;
  content: string;
  meta: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB
const LARGE_PAYLOAD_THRESHOLD = 256 * 1024; // 256KB — defer to microtask above this
const ITEM_BATCH_SIZE = 200; // insert item rows in batches of this size

export class DatasetIngestion {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly knowledge: KnowledgeStore,
    private readonly memory: AppMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly logger: Logger,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Begin an ingestion job. Returns the persisted row immediately.
   *
   * Small payloads (< 256KB) run synchronously on the request thread;
   * large payloads are deferred to a microtask so the HTTP response is
   * not blocked.
   *
   * Throws synchronously on validation failures (format unknown, payload too
   * large, missing required fields).
   */
  async start(args: StartIngestionArgs): Promise<DatasetIngestionJob> {
    const payloadSize = typeof args.payload === 'string'
      ? args.payload.length
      : args.payload.byteLength;

    if (payloadSize === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'payload is empty');
    }
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `payload too large (${payloadSize} bytes; cap is ${MAX_PAYLOAD_BYTES})`,
      );
    }

    const format = inferFormat(args.spec, args.fileName, args.payload);
    const id = randomUUID();
    const now = new Date().toISOString();
    const initial: DatasetIngestionJob = {
      id,
      workspaceId: args.workspaceId,
      appId: args.appId,
      datasetKey: args.spec.key,
      status: 'pending',
      sourceMeta: {
        format,
        fileName: args.fileName,
        sizeBytes: payloadSize,
      },
      totalItems: 0,
      processedItems: 0,
      storedItems: 0,
      errors: [],
      startedAt: null,
      completedAt: null,
      createdAt: now,
    };
    this.db.insert(schema.datasetImports).values({
      id,
      workspaceId: args.workspaceId,
      appId: args.appId,
      datasetKey: args.spec.key,
      status: 'pending',
      sourceMeta: initial.sourceMeta,
      totalItems: 0,
      processedItems: 0,
      storedItems: 0,
      errors: [],
      impact: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    }).run();

    const promise = this.#run(id, args, format);
    if (payloadSize < LARGE_PAYLOAD_THRESHOLD) {
      await promise.catch((err) => this.#failJob(id, err));
      return this.byId(args.workspaceId, id) ?? initial;
    } else {
      promise.catch((err) => this.#failJob(id, err));
      return initial;
    }
  }

  /**
   * Resume a failed or cancelled job.
   *
   * The operator re-uploads the same (or corrected) file. Items whose
   * content hash matches an already-completed item row are skipped; only
   * pending/failed items are re-processed.
   *
   * The job is reset to 'pending' before the pipeline runs, so progress
   * counters restart from the point of resumption.
   */
  async resume(args: ResumeIngestionArgs): Promise<DatasetIngestionJob> {
    const job = this.byId(args.workspaceId, args.jobId);
    if (!job) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `job '${args.jobId}' not found`);
    }
    if (!['failed', 'cancelled'].includes(job.status)) {
      throw new AgentisError(
        'RESOURCE_CONFLICT',
        `job '${args.jobId}' is ${job.status}; only failed or cancelled jobs can be resumed`,
      );
    }

    const payloadSize = typeof args.payload === 'string'
      ? args.payload.length
      : args.payload.byteLength;
    if (payloadSize === 0) throw new AgentisError('VALIDATION_FAILED', 'payload is empty');
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new AgentisError('VALIDATION_FAILED', `payload too large (${payloadSize} bytes)`);
    }

    // Load content hashes for already-completed items.
    const completedHashes = new Set(
      this.db
        .select({ contentHash: schema.datasetImportItems.contentHash })
        .from(schema.datasetImportItems)
        .where(
          and(
            eq(schema.datasetImportItems.importJobId, args.jobId),
            eq(schema.datasetImportItems.status, 'completed'),
          ),
        )
        .all()
        .map((r) => r.contentHash),
    );

    // Re-derive format from stored sourceMeta (operator re-uploaded same format).
    const format = (job.sourceMeta.format as IngestionFormat)
      ?? inferFormat(args.spec, args.fileName, args.payload);

    // Reset job status.
    this.#updateStatus(args.jobId, 'pending', {
      startedAt: null,
      completedAt: null,
      errors: [],
    });

    const promise = this.#runResume(args.jobId, args, format, completedHashes);
    if (payloadSize < LARGE_PAYLOAD_THRESHOLD) {
      await promise.catch((err) => this.#failJob(args.jobId, err));
      return this.byId(args.workspaceId, args.jobId) ?? job;
    } else {
      promise.catch((err) => this.#failJob(args.jobId, err));
      return this.byId(args.workspaceId, args.jobId) ?? job;
    }
  }

  /** Public read — used by /v1/apps/:appId/ingestion-jobs. */
  byId(workspaceId: string, jobId: string): DatasetIngestionJob | null {
    const row = this.db
      .select()
      .from(schema.datasetImports)
      .where(
        and(
          eq(schema.datasetImports.workspaceId, workspaceId),
          eq(schema.datasetImports.id, jobId),
        ),
      )
      .get();
    return row ? rowToJob(row) : null;
  }

  list(args: {
    workspaceId: string;
    appId: string;
    datasetKey?: string;
    limit?: number;
  }): DatasetIngestionJob[] {
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    const rows = this.db
      .select()
      .from(schema.datasetImports)
      .where(
        and(
          eq(schema.datasetImports.workspaceId, args.workspaceId),
          eq(schema.datasetImports.appId, args.appId),
          ...(args.datasetKey ? [eq(schema.datasetImports.datasetKey, args.datasetKey)] : []),
        ),
      )
      .orderBy(desc(schema.datasetImports.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToJob);
  }

  preview(args: StartIngestionArgs): DatasetPreviewResult {
    const payloadSize = typeof args.payload === 'string'
      ? args.payload.length
      : args.payload.byteLength;

    if (payloadSize === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'payload is empty');
    }
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `payload too large (${payloadSize} bytes; cap is ${MAX_PAYLOAD_BYTES})`,
      );
    }

    const format = inferFormat(args.spec, args.fileName, args.payload);
    const parsed = parsePayload(format, args.payload);
    const missing = checkRequiredFields(args.spec, parsed);
    const warnings: string[] = [];
    if (missing.length > 0) warnings.push(`Missing required fields: ${missing.join(', ')}`);
    if (parsed.length === 0) warnings.push('No records were detected in this file.');
    if (args.spec.sizeWarningAboveRows && parsed.length > args.spec.sizeWarningAboveRows) {
      warnings.push(`Large import: ${parsed.length} records. This may take longer to index.`);
    }

    const columns = columnsForPreview(parsed);
    const previewRows = parsed.slice(0, 5).map((item, index) => ({
      title: String(item.meta?._title ?? item.meta?.title ?? item.meta?.name ?? `Record ${index + 1}`),
      fields: fieldsForPreview(item, columns),
    }));

    return {
      recordCount: parsed.length,
      columns,
      previewRows,
      warnings,
      sourceHash: hashPayload(args.payload),
      byteSize: payloadSize,
    };
  }

  /** Manual cancel — flips status when the job is still queued. */
  cancel(workspaceId: string, jobId: string): boolean {
    const row = this.byId(workspaceId, jobId);
    if (!row) return false;
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return false;
    this.#updateStatus(jobId, 'cancelled', { completedAt: new Date().toISOString() });
    return true;
  }

  // ────────────────────────────────────────────────────────────
  // Pipeline — initial run
  // ────────────────────────────────────────────────────────────

  async #run(jobId: string, args: StartIngestionArgs, format: IngestionFormat): Promise<void> {
    this.#updateStatus(jobId, 'parsing', { startedAt: new Date().toISOString() });

    let parsed: ParsedItem[];
    try {
      parsed = parsePayload(format, args.payload);
    } catch (err) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `parse failed (${format}): ${(err as Error).message}`,
      );
    }

    if (parsed.length === 0) {
      this.#updateStatus(jobId, 'failed', {
        completedAt: new Date().toISOString(),
        errors: [{ at: new Date().toISOString(), code: 'EMPTY_PAYLOAD', message: 'no items found in payload' }],
      });
      return;
    }

    const missing = checkRequiredFields(args.spec, parsed);
    if (missing.length > 0) {
      this.#updateStatus(jobId, 'failed', {
        completedAt: new Date().toISOString(),
        errors: [{ at: new Date().toISOString(), code: 'REQUIRED_FIELDS_MISSING',
          message: `dataset spec requires fields: ${missing.join(', ')}` }],
      });
      return;
    }

    this.#updateStatus(jobId, 'chunking', { totalItems: parsed.length });

    // ── Bulk-insert item rows (all pending) ──────────────────
    this.#bulkInsertItems(jobId, args.workspaceId, parsed);

    // ── Chunk + index ────────────────────────────────────────
    const chunks: Array<{ chunk: ChunkedItem; itemIndex: number }> = [];
    let processed = 0;
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i]!;
      const itemChunks = chunkItem(args.spec.chunkingStrategy, item);
      for (const c of itemChunks) chunks.push({ chunk: c, itemIndex: i });
      processed += 1;
      if (processed % 100 === 0) this.#patch(jobId, { processedItems: processed });
    }
    this.#patch(jobId, { processedItems: parsed.length });

    this.#updateStatus(jobId, 'indexing');

    let stored = 0;
    const errors: DatasetIngestionJob['errors'] = [];
    // Track first storedId per itemIndex for the item table.
    const itemStoredIds: Map<number, string> = new Map();
    const itemErrors: Map<number, string> = new Map();

    for (let ci = 0; ci < chunks.length; ci++) {
      const { chunk, itemIndex } = chunks[ci]!;
      try {
        const storedId = this.#routeChunk(args.workspaceId, args.appId, args.spec, chunk, jobId);
        if (!itemStoredIds.has(itemIndex)) itemStoredIds.set(itemIndex, storedId);
        stored += 1;
      } catch (err) {
        const msg = (err as Error).message;
        errors.push({ at: new Date().toISOString(), code: 'ROUTE_FAILED', message: msg, itemIndex });
        itemErrors.set(itemIndex, msg);
      }
      if (stored % 200 === 0) this.#patch(jobId, { storedItems: stored });
    }

    // ── Update item rows ─────────────────────────────────────
    this.#finaliseItems(jobId, parsed, itemStoredIds, itemErrors);

    const impact = this.#buildImpactPreview(args.spec, stored);
    this.#updateStatus(jobId, errors.length > 0 && stored === 0 ? 'failed' : 'completed', {
      storedItems: stored,
      errors,
      impact,
      completedAt: new Date().toISOString(),
    });

    this.logger.info('dataset.ingestion.complete', {
      jobId, workspaceId: args.workspaceId, appId: args.appId,
      datasetKey: args.spec.key, stored, errors: errors.length,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Pipeline — resume
  // ────────────────────────────────────────────────────────────

  async #runResume(
    jobId: string,
    args: ResumeIngestionArgs,
    format: IngestionFormat,
    completedHashes: Set<string>,
  ): Promise<void> {
    this.#updateStatus(jobId, 'parsing', { startedAt: new Date().toISOString() });

    let parsed: ParsedItem[];
    try {
      parsed = parsePayload(format, args.payload);
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `parse failed (${format}): ${(err as Error).message}`);
    }
    if (parsed.length === 0) {
      this.#updateStatus(jobId, 'failed', {
        completedAt: new Date().toISOString(),
        errors: [{ at: new Date().toISOString(), code: 'EMPTY_PAYLOAD', message: 'no items found in payload' }],
      });
      return;
    }

    this.#updateStatus(jobId, 'chunking', { totalItems: parsed.length });

    // Separate: items to process (hash not in completed set) vs skip.
    const toProcess: Array<{ item: ParsedItem; itemIndex: number }> = [];
    let skipped = 0;
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i]!;
      const hash = hashContent(item.content);
      if (completedHashes.has(hash)) {
        skipped += 1;
        // Mark as skipped in item table (upsert).
        this.#upsertItemStatus(jobId, args.workspaceId, i, hash, 'skipped', null, null);
      } else {
        toProcess.push({ item, itemIndex: i });
      }
    }

    this.logger.info('dataset.ingestion.resume', { jobId, total: parsed.length, skipped, toProcess: toProcess.length });

    // Chunk + index only the non-skipped items.
    const chunks: Array<{ chunk: ChunkedItem; itemIndex: number; itemHash: string }> = [];
    let processed = skipped;
    for (const { item, itemIndex } of toProcess) {
      const itemChunks = chunkItem(args.spec.chunkingStrategy, item);
      const hash = hashContent(item.content);
      for (const c of itemChunks) chunks.push({ chunk: c, itemIndex, itemHash: hash });
      processed += 1;
      if (processed % 100 === 0) this.#patch(jobId, { processedItems: processed });
    }
    this.#patch(jobId, { processedItems: parsed.length });

    this.#updateStatus(jobId, 'indexing');

    let stored = 0;
    const errors: DatasetIngestionJob['errors'] = [];
    const itemStoredIds: Map<number, string> = new Map();
    const itemErrors: Map<number, string> = new Map();

    for (const { chunk, itemIndex, itemHash } of chunks) {
      try {
        const storedId = this.#routeChunk(args.workspaceId, args.appId, args.spec, chunk, jobId);
        if (!itemStoredIds.has(itemIndex)) itemStoredIds.set(itemIndex, storedId);
        stored += 1;
        this.#upsertItemStatus(jobId, args.workspaceId, itemIndex, itemHash, 'completed', storedId, null);
      } catch (err) {
        const msg = (err as Error).message;
        errors.push({ at: new Date().toISOString(), code: 'ROUTE_FAILED', message: msg, itemIndex });
        if (!itemErrors.has(itemIndex)) {
          itemErrors.set(itemIndex, msg);
          this.#upsertItemStatus(jobId, args.workspaceId, itemIndex, itemHash, 'failed', null, msg);
        }
      }
      if (stored % 200 === 0) this.#patch(jobId, { storedItems: stored });
    }

    const impact = this.#buildImpactPreview(args.spec, stored + skipped);
    this.#updateStatus(jobId, errors.length > 0 && stored === 0 && skipped === 0 ? 'failed' : 'completed', {
      storedItems: stored + skipped,
      errors,
      impact,
      completedAt: new Date().toISOString(),
    });

    this.logger.info('dataset.ingestion.resume.complete', {
      jobId, stored, skipped, errors: errors.length,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Routing
  // ────────────────────────────────────────────────────────────

  /**
   * Route one chunk to the correct store. Returns the stored entity's id
   * (knowledge chunk id, memory episode id, etc.) for item tracking.
   */
  #routeChunk(
    workspaceId: string,
    appId: string,
    spec: DatasetSpec,
    chunk: ChunkedItem,
    jobId: string,
  ): string {
    const provenance = {
      kind: 'dataset_import',
      datasetKey: spec.key,
      ingestionJobId: jobId,
      ...chunk.meta,
    };
    switch (spec.targetStore as IngestionTargetStore) {
      case 'knowledge': {
        return this.knowledge.write({
          workspaceId, appId,
          title: chunk.title,
          content: chunk.content,
          source: 'import',
          tags: spec.embeddingHint ? [spec.embeddingHint] : [],
          provenance,
          trust: 0.85,
        });
      }
      case 'memory': {
        return this.memory.write({
          workspaceId, appId,
          kind: 'fact',
          source: 'operator',
          title: chunk.title,
          content: chunk.content,
          trust: 0.85,
          importance: 0.5,
          provenance,
        });
      }
      case 'evaluator_examples': {
        return this.evaluators.write({
          workspaceId, appId,
          evaluatorKey: (chunk.meta.evaluatorKey as string) ?? spec.key,
          source: 'import',
          input: chunk.meta.input ?? chunk.title,
          expected: chunk.meta.expected ?? chunk.content,
          verdict: ((chunk.meta.verdict as string) === 'fail' ? 'fail' : 'pass') as 'pass' | 'fail',
          score: typeof chunk.meta.score === 'number' ? (chunk.meta.score as number) : undefined,
          reason: typeof chunk.meta.reason === 'string' ? (chunk.meta.reason as string) : undefined,
        });
      }
      case 'baseline_inputs': {
        return this.knowledge.write({
          workspaceId, appId,
          title: `[baseline] ${chunk.title}`,
          content: chunk.content,
          source: 'import',
          tags: ['baseline_inputs'],
          provenance,
          trust: 0.85,
        });
      }
      default: {
        throw new AgentisError('VALIDATION_FAILED', `unknown targetStore: ${spec.targetStore}`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Impact preview
  // ────────────────────────────────────────────────────────────

  #buildImpactPreview(spec: DatasetSpec, stored: number): DatasetImpactPreview {
    const newKnowledgeClusters =
      spec.targetStore === 'knowledge' ? Math.max(1, Math.round(stored / 50)) : 0;
    const memoryRegionsStrengthened: string[] = [];
    if (spec.targetStore === 'memory') memoryRegionsStrengthened.push(spec.key);
    const evaluatorConfidenceDelta: DatasetImpactPreview['evaluatorConfidenceDelta'] = [];
    if (spec.targetStore === 'evaluator_examples') {
      const delta = 1 - Math.exp(-stored / 10);
      evaluatorConfidenceDelta.push({ evaluatorKey: spec.key, delta });
    }
    const notes: string[] = [];
    notes.push(`Stored ${stored} item(s) in target store '${spec.targetStore}'.`);
    if (spec.expectedImpact?.note) notes.push(spec.expectedImpact.note);
    if (spec.wedgeRole === 'primary_specialization' && stored > 0) {
      notes.push('This is a primary specialization dataset — the app should now feel domain-shaped.');
    }
    return {
      newKnowledgeClusters,
      evaluatorConfidenceDelta,
      memoryRegionsStrengthened,
      workflowBaselinesAffected: [],
      notes,
    };
  }

  // ────────────────────────────────────────────────────────────
  // dataset_import_items helpers
  // ────────────────────────────────────────────────────────────

  /** Bulk-insert item rows in batches to respect SQLite variable limits. */
  #bulkInsertItems(jobId: string, workspaceId: string, items: ParsedItem[]): void {
    const now = new Date().toISOString();
    for (let start = 0; start < items.length; start += ITEM_BATCH_SIZE) {
      const batch = items.slice(start, start + ITEM_BATCH_SIZE);
      this.db.insert(schema.datasetImportItems).values(
        batch.map((item, i) => ({
          id: randomUUID(),
          workspaceId,
          importJobId: jobId,
          itemIndex: start + i,
          status: 'pending' as const,
          contentHash: hashContent(item.content),
          storedId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        })),
      ).run();
    }
  }

  /**
   * After routing, update each item row with 'completed' or 'failed'.
   * Uses a single UPDATE per item (SQLite WAL makes this fast for ≤10k items).
   */
  #finaliseItems(
    jobId: string,
    items: ParsedItem[],
    storedIds: Map<number, string>,
    errors: Map<number, string>,
  ): void {
    const now = new Date().toISOString();
    // Collect hashes for items that were processed (non-pending).
    const processedHashes = new Set([...storedIds.keys(), ...errors.keys()]);

    if (processedHashes.size === 0) return;

    // Build a map of itemIndex → contentHash for the processed items.
    for (const idx of processedHashes) {
      const item = items[idx];
      if (!item) continue;
      const hash = hashContent(item.content);
      if (storedIds.has(idx)) {
        this.db.update(schema.datasetImportItems)
          .set({ status: 'completed', storedId: storedIds.get(idx) ?? null, updatedAt: now })
          .where(
            and(
              eq(schema.datasetImportItems.importJobId, jobId),
              eq(schema.datasetImportItems.contentHash, hash),
            ),
          )
          .run();
      } else if (errors.has(idx)) {
        this.db.update(schema.datasetImportItems)
          .set({ status: 'failed', error: errors.get(idx) ?? null, updatedAt: now })
          .where(
            and(
              eq(schema.datasetImportItems.importJobId, jobId),
              eq(schema.datasetImportItems.contentHash, hash),
            ),
          )
          .run();
      }
    }
  }

  /**
   * Upsert an item row (used during resume where rows may or may not exist).
   * INSERT OR IGNORE then UPDATE — works regardless of row existence.
   */
  #upsertItemStatus(
    jobId: string,
    workspaceId: string,
    itemIndex: number,
    contentHash: string,
    status: string,
    storedId: string | null,
    error: string | null,
  ): void {
    const now = new Date().toISOString();
    // Try to insert (no-op if already exists due to unique index on job+itemIndex).
    this.db.insert(schema.datasetImportItems)
      .values({
        id: randomUUID(),
        workspaceId,
        importJobId: jobId,
        itemIndex,
        status,
        contentHash,
        storedId,
        error,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    // Update the existing row with new status.
    this.db.update(schema.datasetImportItems)
      .set({ status, storedId, error, contentHash, updatedAt: now })
      .where(
        and(
          eq(schema.datasetImportItems.importJobId, jobId),
          eq(schema.datasetImportItems.itemIndex, itemIndex),
        ),
      )
      .run();
  }

  // ────────────────────────────────────────────────────────────
  // DB helpers
  // ────────────────────────────────────────────────────────────

  #updateStatus(
    jobId: string,
    status: DatasetIngestionStatus,
    extras: Partial<{
      startedAt: string | null;
      completedAt: string | null;
      totalItems: number;
      processedItems: number;
      storedItems: number;
      errors: DatasetIngestionJob['errors'];
      impact: DatasetImpactPreview | null;
    }> = {},
  ): void {
    const set: Record<string, unknown> = { status };
    if (extras.startedAt !== undefined) set.startedAt = extras.startedAt;
    if (extras.completedAt !== undefined) set.completedAt = extras.completedAt;
    if (extras.totalItems !== undefined) set.totalItems = extras.totalItems;
    if (extras.processedItems !== undefined) set.processedItems = extras.processedItems;
    if (extras.storedItems !== undefined) set.storedItems = extras.storedItems;
    if (extras.errors !== undefined) set.errors = extras.errors;
    if (extras.impact !== undefined) set.impact = extras.impact;
    this.db.update(schema.datasetImports).set(set).where(eq(schema.datasetImports.id, jobId)).run();
  }

  #patch(jobId: string, patch: Record<string, unknown>): void {
    this.db.update(schema.datasetImports).set(patch).where(eq(schema.datasetImports.id, jobId)).run();
  }

  #failJob(jobId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : 'unknown ingestion error';
    const code = err instanceof AgentisError ? err.code : 'INTERNAL_ERROR';
    this.logger.warn('dataset.ingestion.failed', { jobId, code, message });
    this.#updateStatus(jobId, 'failed', {
      completedAt: new Date().toISOString(),
      errors: [{ at: new Date().toISOString(), code, message }],
    });
  }
}

// ────────────────────────────────────────────────────────────
// Format inference + parsers
// ────────────────────────────────────────────────────────────

export function inferFormat(
  spec: DatasetSpec,
  fileName?: string,
  payload?: string | Buffer,
): IngestionFormat {
  // 1. Detect binary magic bytes first (most reliable).
  if (payload instanceof Buffer || Buffer.isBuffer(payload)) {
    const buf = payload as Buffer;
    if (buf.length >= 4) {
      // PDF: %PDF
      if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
      // ZIP (PK\x03\x04)
      if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'markdown-zip';
    }
  }

  // 2. Extension hints from the file name.
  const lowerName = (fileName ?? '').toLowerCase();
  if (lowerName.endsWith('.pdf')) return 'pdf';
  if (lowerName.endsWith('.zip')) return 'markdown-zip';
  if (lowerName.endsWith('.csv')) return 'csv';
  if (lowerName.endsWith('.json')) return 'json';
  if (lowerName.endsWith('.jsonl') || lowerName.endsWith('.ndjson')) return 'jsonl';
  if (lowerName.endsWith('.md') || lowerName.endsWith('.txt')) return 'text';

  // 3. Fall back to spec's acceptedFormats.
  const candidate = (spec.acceptedFormats[0] ?? 'text').toLowerCase();
  if (candidate.includes('pdf')) return 'pdf';
  if (candidate.includes('zip')) return 'markdown-zip';
  if (candidate.includes('csv')) return 'csv';
  if (candidate.includes('jsonl')) return 'jsonl';
  if (candidate.includes('json')) return 'json';
  return 'text';
}

function parsePayload(format: IngestionFormat, payload: string | Buffer): ParsedItem[] {
  switch (format) {
    case 'csv':   return parseCsv(payloadAsString(payload));
    case 'json':  return parseJson(payloadAsString(payload));
    case 'jsonl': return parseJsonl(payloadAsString(payload));
    case 'text':  return [{ content: payloadAsString(payload) }];
    case 'pdf':   return parsePdf(payloadAsBuffer(payload));
    case 'markdown-zip': return parseMarkdownZip(payloadAsBuffer(payload));
    default:      return [{ content: payloadAsString(payload) }];
  }
}

function payloadAsString(payload: string | Buffer): string {
  if (typeof payload === 'string') return payload;
  return payload.toString('utf8');
}

function payloadAsBuffer(payload: string | Buffer): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(payload, 'utf8');
}

// ────────────────────────────────────────────────────────────
// CSV parser (RFC4180)
// ────────────────────────────────────────────────────────────

function parseCsv(payload: string): ParsedItem[] {
  const rows = parseCsvRows(payload);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  const items: ParsedItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 0 || (row.length === 1 && row[0]!.trim() === '')) continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]!] = row[j] ?? '';
    const title = chooseCsvTitle(obj, headers);
    const content = renderCsvContent(obj, headers, title);
    items.push({ content, meta: { ...obj, _title: title } });
  }
  return items;
}

function parseCsvRows(payload: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (inQuotes) {
      if (ch === '"') {
        if (payload[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { current.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        current.push(field); field = '';
        rows.push(current); current = [];
        if (ch === '\r' && payload[i + 1] === '\n') i += 1;
      } else { field += ch; }
    }
  }
  if (field.length > 0 || current.length > 0) { current.push(field); rows.push(current); }
  return rows;
}

function chooseCsvTitle(obj: Record<string, string>, headers: string[]): string {
  const preferred = ['title', 'name', 'subject', 'summary', 'id'];
  for (const p of preferred) {
    const match = headers.find((h) => h.toLowerCase() === p);
    if (match && obj[match]) return obj[match]!;
  }
  for (const h of headers) if (obj[h]?.trim()) return obj[h]!;
  return '(untitled row)';
}

function renderCsvContent(obj: Record<string, string>, headers: string[], title: string): string {
  const lines: string[] = [];
  for (const h of headers) {
    const v = obj[h];
    if (!v || v === title) continue;
    lines.push(`${h}: ${v}`);
  }
  return lines.length > 0 ? lines.join('\n') : title;
}

// ────────────────────────────────────────────────────────────
// JSON / JSONL parsers
// ────────────────────────────────────────────────────────────

function parseJson(payload: string): ParsedItem[] {
  const v = JSON.parse(payload);
  if (Array.isArray(v)) return v.map(itemFromJsonEntry);
  if (v && typeof v === 'object') return [itemFromJsonEntry(v)];
  return [{ content: String(v) }];
}

function parseJsonl(payload: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  for (const line of payload.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(itemFromJsonEntry(JSON.parse(trimmed))); } catch { /* skip bad lines */ }
  }
  return out;
}

function itemFromJsonEntry(entry: unknown): ParsedItem {
  if (typeof entry === 'string') return { content: entry };
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const rec = entry as Record<string, unknown>;
    const title = (rec.title as string) ?? (rec.name as string) ?? (rec.id as string) ?? '(untitled)';
    let content = (rec.content as string) ?? (rec.body as string) ?? (rec.text as string);
    if (!content) {
      content = Object.entries(rec)
        .filter(([k]) => k !== 'title' && k !== 'name')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
    }
    return { content, meta: { ...rec, _title: title } };
  }
  return { content: JSON.stringify(entry) };
}

// ────────────────────────────────────────────────────────────
// PDF parser — Agentis 1.1.1
// ────────────────────────────────────────────────────────────

/**
 * Extract text from a PDF buffer.
 *
 * Approach:
 *   1. Find content streams (between `stream\r?\n` and `\r?\nendstream`).
 *   2. Try FlateDecode decompression on each stream.
 *   3. From the (possibly decompressed) stream bytes, extract text inside
 *      BT/ET blocks using standard PDF text operators:
 *        `(text) Tj` — show literal string
 *        `[(text)] TJ` — show array string (with kerning offsets)
 *        `<hex> Tj` — show hex-encoded string
 *   4. Collapse adjacent whitespace, split into paragraph-like sections.
 *
 * Limitations:
 *   - Does NOT handle image-only (scanned) PDFs — zero text extracted.
 *   - Does NOT handle Type2 (CFF) or CID fonts with multi-byte encodings.
 *   - Does NOT follow /Contents object references (extracts all streams).
 *
 * Works for: programmatically generated PDFs (Word, LibreOffice, wkhtmltopdf,
 * Puppeteer, Pandoc, most report generators).
 */
function parsePdf(buffer: Buffer): ParsedItem[] {
  // Work in binary so zlib can operate on the raw bytes.
  let text = '';

  // Find all stream/endstream pairs.
  // We can't use a simple regex on the buffer directly (binary data);
  // instead we scan for the ASCII marker bytes.
  const markerStream = Buffer.from('stream');
  const markerEndstream = Buffer.from('endstream');

  let searchFrom = 0;
  while (searchFrom < buffer.length) {
    const streamStart = indexOfBuffer(buffer, markerStream, searchFrom);
    if (streamStart === -1) break;

    // After 'stream' there should be \r\n or \n.
    let dataStart = streamStart + markerStream.length;
    if (buffer[dataStart] === 0x0d) dataStart++; // CR
    if (buffer[dataStart] === 0x0a) dataStart++; // LF
    else { searchFrom = dataStart; continue; } // malformed stream marker

    const endStart = indexOfBuffer(buffer, markerEndstream, dataStart);
    if (endStart === -1) break;

    // Trim trailing \r\n before endstream.
    let dataEnd = endStart;
    if (buffer[dataEnd - 1] === 0x0a) dataEnd--;
    if (buffer[dataEnd - 1] === 0x0d) dataEnd--;

    const streamData = buffer.slice(dataStart, dataEnd);
    let content = '';

    // Try FlateDecode (most common compression).
    try {
      const decompressed = zlib.inflateSync(streamData);
      content = decompressed.toString('utf8');
    } catch {
      try {
        // Some PDFs use raw deflate without zlib header.
        const decompressed = zlib.inflateRawSync(streamData);
        content = decompressed.toString('utf8');
      } catch {
        // Assume uncompressed text stream.
        content = streamData.toString('latin1');
      }
    }

    text += extractPdfText(content);
    searchFrom = endStart + markerEndstream.length;
  }

  text = text.replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];

  // Split into paragraph-like blocks on double-newlines or page breaks.
  const paragraphs = text
    .split(/\n{2,}|\f/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter((p) => p.length > 15); // skip very short fragments

  if (paragraphs.length === 0) return [{ content: text }];
  return paragraphs.map((p, i) => ({
    content: p,
    meta: { _title: `Content block ${i + 1}`, paragraphIndex: i },
  }));
}

/** Extract text operators from a decompressed PDF content stream. */
function extractPdfText(content: string): string {
  const parts: string[] = [];
  const btEtRe = /BT([\s\S]*?)ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btEtRe.exec(content)) !== null) {
    const block = btMatch[1]!;

    // Literal string: (text) Tj / (text) TJ
    const litRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*T[jJ]/g;
    let m: RegExpExecArray | null;
    while ((m = litRe.exec(block)) !== null) {
      parts.push(decodePdfLiteral(m[1]!));
    }

    // Array string: [(items...)] TJ
    const arrRe = /\[((?:[^[\]]*|\((?:[^)\\]|\\.)*\))*)\]\s*TJ/g;
    while ((m = arrRe.exec(block)) !== null) {
      const arr = m[1]!;
      const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
      let sm: RegExpExecArray | null;
      while ((sm = strRe.exec(arr)) !== null) {
        parts.push(decodePdfLiteral(sm[1]!));
      }
    }

    // Hex string: <hexhex> Tj
    const hexRe = /<([0-9a-fA-F\s]+)>\s*T[jJ]/g;
    while ((m = hexRe.exec(block)) !== null) {
      parts.push(decodePdfHex(m[1]!));
    }

    // Td/Tm usually signal a new text line; add a newline between blocks.
    if (/\bT[dm]\b/.test(block)) parts.push('\n');
  }

  return parts.join('');
}

function decodePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s/g, '');
  let result = '';
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (!Number.isNaN(byte)) result += String.fromCharCode(byte);
  }
  return result;
}

/** Find first occurrence of `needle` in `haystack` starting from `offset`. */
function indexOfBuffer(haystack: Buffer, needle: Buffer, offset = 0): number {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// ────────────────────────────────────────────────────────────
// Markdown-zip parser — Agentis 1.1.1
// ────────────────────────────────────────────────────────────

/**
 * Extract text from a ZIP archive containing .md files.
 *
 * Minimal PKZIP reader:
 *   - Scans for local file header signatures (PK\x03\x04 = 0x04034b50).
 *   - Reads file name and compression method from each header.
 *   - Decompresses DEFLATE (method 8) via `zlib.inflateRawSync`.
 *   - Stored (method 0) files are read directly.
 *   - Only .md files are processed; everything else is skipped.
 *
 * Limitations:
 *   - Does not follow the central directory (uses sequential local headers).
 *   - Does not handle Zip64 (> 4GB files, > 65535 entries).
 *   - Does not handle encryption.
 *   - Streaming zips (compressedSize=0 in local header) are skipped.
 */
function parseMarkdownZip(buffer: Buffer): ParsedItem[] {
  const LOCAL_SIG = 0x04034b50;
  const items: ParsedItem[] = [];
  let offset = 0;

  while (offset < buffer.length - 30) {
    // Scan for local file header signature.
    const sig = buffer.readUInt32LE(offset);
    if (sig !== LOCAL_SIG) { offset++; continue; }

    // Parse local file header fields.
    // const versionNeeded  = buffer.readUInt16LE(offset + 4);
    // const flags          = buffer.readUInt16LE(offset + 6);
    const method         = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen    = buffer.readUInt16LE(offset + 26);
    const extraLen       = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const nameEnd   = nameStart + fileNameLen;
    if (nameEnd > buffer.length) break;

    const fileName  = buffer.slice(nameStart, nameEnd).toString('utf8');
    const dataStart = nameEnd + extraLen;
    const dataEnd   = dataStart + compressedSize;

    if (dataEnd > buffer.length) break;

    // Process .md files only.
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.md') && compressedSize > 0) {
      const compressedData = buffer.slice(dataStart, dataEnd);
      let content = '';
      try {
        if (method === 0) {
          // Stored (no compression).
          content = compressedData.toString('utf8');
        } else if (method === 8) {
          // Deflate — use raw inflate (zip uses raw deflate, not zlib-wrapped).
          const decompressed = zlib.inflateRawSync(compressedData);
          content = decompressed.toString('utf8');
        }
        // method 0 and 8 cover 99%+ of real-world zips.
      } catch {
        // Skip files that fail to decompress.
      }

      if (content.trim()) {
        // Use the base file name (without directory prefix) as the title.
        const baseName = fileName.split('/').pop()?.replace(/\.md$/i, '') ?? fileName;
        items.push({
          content: content.trim(),
          meta: {
            _title: baseName,
            sourceFile: fileName,
            compressionMethod: method,
          },
        });
      }
    }

    // Advance past this entry.
    offset = dataEnd;
  }

  return items;
}

// ────────────────────────────────────────────────────────────
// Chunkers
// ────────────────────────────────────────────────────────────

const SLIDING_WINDOW_TOKENS = 220;
const SLIDING_WINDOW_STRIDE = 160;

function chunkItem(strategy: ChunkingStrategy, item: ParsedItem): ChunkedItem[] {
  const titleFromMeta = (item.meta?._title as string) ?? '(untitled)';
  const baseMeta = item.meta ?? {};
  switch (strategy) {
    case 'per-row':
    case 'per-document':
    case 'per-function': {
      return [{ title: titleFromMeta, content: item.content, meta: baseMeta }];
    }
    case 'sliding-window': {
      const tokens = item.content.split(/\s+/).filter(Boolean);
      if (tokens.length <= SLIDING_WINDOW_TOKENS) {
        return [{ title: titleFromMeta, content: item.content, meta: baseMeta }];
      }
      const chunks: ChunkedItem[] = [];
      let start = 0, part = 0;
      while (start < tokens.length) {
        const slice = tokens.slice(start, start + SLIDING_WINDOW_TOKENS);
        if (slice.length === 0) break;
        chunks.push({
          title: `${titleFromMeta} (window ${part + 1})`,
          content: slice.join(' '),
          meta: { ...baseMeta, windowStart: start, windowEnd: start + slice.length },
        });
        if (start + SLIDING_WINDOW_TOKENS >= tokens.length) break;
        start += SLIDING_WINDOW_STRIDE;
        part += 1;
      }
      return chunks;
    }
    case 'semantic': {
      const parts = item.content
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length <= 1) return [{ title: titleFromMeta, content: item.content, meta: baseMeta }];
      return parts.map((content, idx) => ({
        title: `${titleFromMeta} (section ${idx + 1})`,
        content,
        meta: { ...baseMeta, sectionIndex: idx, sectionCount: parts.length },
      }));
    }
  }
}

// ────────────────────────────────────────────────────────────
// Required-field check
// ────────────────────────────────────────────────────────────

function checkRequiredFields(spec: DatasetSpec, items: ParsedItem[]): string[] {
  if (!spec.requiredFields || spec.requiredFields.length === 0) return [];
  if (items.length === 0) return [];
  const sample = items[0]!.meta ?? {};
  return spec.requiredFields.filter((f) => sample[f] === undefined);
}

function columnsForPreview(items: ParsedItem[]): string[] {
  const columns = new Set<string>();
  for (const item of items.slice(0, 20)) {
    for (const key of Object.keys(item.meta ?? {})) {
      if (key.startsWith('_')) continue;
      columns.add(key);
    }
  }
  if (columns.size === 0) columns.add('content');
  return [...columns].slice(0, 12);
}

function fieldsForPreview(item: ParsedItem, columns: string[]): Record<string, unknown> {
  const meta = item.meta ?? {};
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = column === 'content' ? item.content.slice(0, 240) : meta[column];
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Content hashing (dedup key for resume)
// ────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function hashPayload(payload: string | Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

// ────────────────────────────────────────────────────────────
// Row → DTO
// ────────────────────────────────────────────────────────────

function rowToJob(row: typeof schema.datasetImports.$inferSelect): DatasetIngestionJob {
  const job: DatasetIngestionJob = {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    datasetKey: row.datasetKey,
    status: row.status as DatasetIngestionStatus,
    sourceMeta: parseSourceMeta(row.sourceMeta),
    totalItems: row.totalItems,
    processedItems: row.processedItems,
    storedItems: row.storedItems,
    errors: parseErrors(row.errors),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
  if (row.impact) job.impact = parseImpact(row.impact);
  return job;
}

function parseSourceMeta(raw: unknown): DatasetIngestionJob['sourceMeta'] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    return {
      format: typeof r.format === 'string' ? r.format : 'text',
      fileName: typeof r.fileName === 'string' ? r.fileName : undefined,
      sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : undefined,
      rowCount: typeof r.rowCount === 'number' ? r.rowCount : undefined,
    };
  }
  if (typeof raw !== 'string') return { format: 'text' };
  try { return parseSourceMeta(JSON.parse(raw)); } catch { return { format: 'text' }; }
}

function parseErrors(raw: unknown): DatasetIngestionJob['errors'] {
  if (Array.isArray(raw)) return raw as DatasetIngestionJob['errors'];
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as DatasetIngestionJob['errors']) : [];
  } catch { return []; }
}

function parseImpact(raw: unknown): DatasetImpactPreview | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as DatasetImpactPreview;
  if (typeof raw !== 'string') return undefined;
  try { return JSON.parse(raw) as DatasetImpactPreview; } catch { return undefined; }
}
