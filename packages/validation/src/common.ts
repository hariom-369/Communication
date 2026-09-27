import { isId, type Id } from '@tessera/shared';
import { z } from 'zod';

/** A canonical UUIDv7 entity identifier (ADR-028). */
export const idSchema = z
  .string()
  .length(36)
  .refine((value): value is Id => isId(value), { message: 'Must be a UUIDv7' });
