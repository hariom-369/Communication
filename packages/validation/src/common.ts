import { isId, type Id } from '@tessera/shared';
import { z } from 'zod';

/** A canonical UUIDv7 entity identifier (ADR-028). */
export const idSchema = z
  .string()
  .length(36)
  .refine((value): value is Id => isId(value), { message: 'Must be a UUIDv7' });

/**
 * The same UUIDv7 check without the branded type: for ids that arrive from other parties and
 * become keys of client state (message references, sender ids — security review F-13), where
 * the code handles them as plain strings.
 */
export const idStringSchema = z
  .string()
  .length(36)
  .refine((value): boolean => isId(value), { message: 'Must be a UUIDv7' });
