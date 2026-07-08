import { z } from 'zod';
import { appManifestSchema } from './manifest.js';

export const appEnvironmentKindSchema = z.enum(['dev', 'staging', 'production']);
export type AppEnvironmentKind = z.infer<typeof appEnvironmentKindSchema>;

export const appEnvironmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  appId: z.string(),
  name: z.string().min(1).max(64),
  kind: appEnvironmentKindSchema,
  manifest: appManifestSchema,
  sourceEnvironmentId: z.string().nullable(),
  promotedAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;

export const upsertAppEnvironmentSchema = z.object({
  kind: appEnvironmentKindSchema.default('dev'),
  manifest: appManifestSchema,
});
export type UpsertAppEnvironmentInput = z.infer<typeof upsertAppEnvironmentSchema>;

export const promoteAppEnvironmentSchema = z.object({
  targetName: z.string().min(1).max(64),
  targetKind: appEnvironmentKindSchema,
  applyToRuntime: z.boolean().default(false),
});
export type PromoteAppEnvironmentInput = z.infer<typeof promoteAppEnvironmentSchema>;



