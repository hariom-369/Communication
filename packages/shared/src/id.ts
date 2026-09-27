import { v7 as uuidv7, validate, version } from 'uuid';

/**
 * Entity identifier: a UUIDv7 (ADR-028). Time-ordered, index-friendly and safe to generate on
 * clients for idempotency. The brand prevents passing arbitrary strings where an ID is expected.
 */
export type Id = string & { readonly __brand: 'Id' };

/** Generates a new UUIDv7 using the platform CSPRNG. */
export function newId(): Id {
  return uuidv7() as Id;
}

/** True when `value` is a canonical, lower-case UUIDv7. */
export function isId(value: string): value is Id {
  return value === value.toLowerCase() && validate(value) && version(value) === 7;
}
