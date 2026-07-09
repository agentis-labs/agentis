/**
 * App Datastore — typed collections + records (AGENTIC-APPS-10X-MASTERPLAN §5).
 *
 * Explicitly NOT the Brain (no embeddings/decay/promotion) and NOT a raw-SQL
 * surface. A collection is a typed table; a record is a schema-validated row.
 *
 * Schema is expressed with a constrained field DSL (mirrors `WorkflowContract`)
 * rather than arbitrary JSON Schema — it validates with zod, needs no new
 * dependency, and stays portable to Postgres (§10.4). Each field maps to a
 * json_extract-addressable path in `app_records.data_json`.
 */

import { z } from 'zod';

export const fieldTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'json']);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const collectionFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'field key must be an identifier'),
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  /** Hint that this field is queried often. V1 filters via json_extract; a later pass projects indexed fields into generated columns. */
  indexed: z.boolean().default(false),
  description: z.string().max(280).optional(),
});
export type CollectionField = z.infer<typeof collectionFieldSchema>;

export const collectionSchemaSchema = z.object({
  fields: z.array(collectionFieldSchema).min(1).max(100),
  /**
   * When true, writes are CLOSED: unknown keys are rejected instead of stored
   * untyped. Default (false) keeps the permissive passthrough for compatibility,
   * but a typed collection can opt into a real guarantee.
   */
  strict: z.boolean().optional(),
});
export type CollectionSchema = z.infer<typeof collectionSchemaSchema>;

const collectionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'collection name must be a lowercase identifier');

export interface CollectionRecord {
  id: string;
  appId: string;
  collectionId: string;
  name: string; // collection name, denormalized for convenience
  data: Record<string, unknown>;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionInfo {
  id: string;
  appId: string;
  name: string;
  schema: CollectionSchema;
  /** Number of records currently stored in the collection (populated by listCollections). */
  recordCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Query model ─────────────────────────────────────────────


export const queryFilterSchema = z.record(
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({
      op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']),
      value: z.unknown(),
    }),
  ]),
);
export type QueryFilter = z.infer<typeof queryFilterSchema>;

export const querySortSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type QuerySort = z.infer<typeof querySortSchema>;

export const dataQuerySchema = z.object({
  filter: queryFilterSchema.optional(),
  sort: z.array(querySortSchema).optional(),
  limit: z.number().int().positive().max(500).default(50),
  cursor: z.string().optional(),
});
export type DataQuery = z.infer<typeof dataQuerySchema>;

// ── Tool / route input payloads ─────────────────────────────

export const defineCollectionSchema = z.object({
  name: collectionNameSchema,
  schema: collectionSchemaSchema,
});
export type DefineCollectionInput = z.infer<typeof defineCollectionSchema>;

export const insertRecordSchema = z.object({ record: z.record(z.unknown()) });
export const updateRecordSchema = z.object({ patch: z.record(z.unknown()) });
export const upsertRecordSchema = z.object({
  match: z.record(z.unknown()),
  record: z.record(z.unknown()),
});



