import { z } from 'zod';
import { CONSTANTS } from '../constants.js';

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z
    .string()
    .min(CONSTANTS.PASSWORD_MIN_LENGTH)
    .max(CONSTANTS.PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(10),
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const authenticatedUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});

export const loginResponseSchema = z.object({
  user: authenticatedUserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
});



