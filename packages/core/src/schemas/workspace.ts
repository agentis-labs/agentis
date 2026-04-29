import { z } from 'zod';

export const ambientKindSchema = z.enum(['local', 'dev', 'staging', 'prod', 'fleet', 'custom']);

export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be kebab-case lowercase alphanumeric');

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slugSchema,
});

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  defaultAmbientId: z.string().uuid().nullable().optional(),
});

export const createAmbientSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  kind: ambientKindSchema.default('local'),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateAmbientSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  kind: ambientKindSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
