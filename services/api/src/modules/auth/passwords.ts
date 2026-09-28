import { hash, verify } from '@node-rs/argon2';
import { AppError } from '@tessera/platform';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary as commonDictionary } from '@zxcvbn-ts/language-common';
import { dictionary as enDictionary, translations } from '@zxcvbn-ts/language-en';

import { hmacSha256, randomToken } from '../../platform/secrets.js';

/**
 * Password storage (docs/authentication.md §2.1, OWASP Password Storage Cheat Sheet):
 * input = HMAC-SHA-256(pepper, NFKC(password)); stored = Argon2id(input).
 * Parameters are above the OWASP minimum (m=19 MiB, t=2) and recorded in the PHC string, so
 * they can be raised later with transparent rehash-on-login.
 */
export const ARGON2_PARAMS = {
  // `Algorithm.Argon2id` is an ambient const enum (not importable with verbatimModuleSyntax).
  algorithm: 2,
  memoryCost: 64 * 1024, // KiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** Minimum zxcvbn score (0–4) for new passwords. */
const MIN_STRENGTH_SCORE = 3;
/** Concurrent hash operations per process; excess requests queue (hash-flooding defence). */
const MAX_CONCURRENT_HASHES = 4;

export interface Pepper {
  readonly id: string;
  readonly key: Buffer;
}

export function parsePepper(spec: string): Pepper {
  const [id, encoded, ...rest] = spec.split(':');
  const key = Buffer.from(encoded ?? '', 'base64');
  if (id === undefined || !/^[a-z0-9]{1,16}$/.test(id) || rest.length > 0 || key.length !== 32) {
    throw new Error('PASSWORD_PEPPER must look like "<id>:<base64 32 bytes>"');
  }
  return { id, key };
}

class Semaphore {
  #available: number;
  readonly #waiters: (() => void)[] = [];

  constructor(size: number) {
    this.#available = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#available > 0) this.#available -= 1;
    else await new Promise<void>((resolve) => this.#waiters.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiters.shift();
      if (next !== undefined) next();
      else this.#available += 1;
    }
  }
}

const strength = new ZxcvbnFactory({
  dictionary: { ...commonDictionary, ...enDictionary },
  graphs: adjacencyGraphs,
  translations,
});

export class PasswordHasher {
  readonly #peppers: ReadonlyMap<string, Buffer>;
  readonly #current: Pepper;
  readonly #semaphore = new Semaphore(MAX_CONCURRENT_HASHES);
  #dummyHash: Promise<string> | undefined;

  constructor(current: Pepper, previous: readonly Pepper[] = []) {
    this.#current = current;
    this.#peppers = new Map([current, ...previous].map((pepper) => [pepper.id, pepper.key]));
  }

  get currentPepperId(): string {
    return this.#current.id;
  }

  #prepare(password: string, pepperKey: Buffer): string {
    return hmacSha256(pepperKey, password.normalize('NFKC')).toString('base64');
  }

  hash(password: string): Promise<{ hash: string; pepperId: string }> {
    return this.#semaphore.run(async () => ({
      hash: await hash(this.#prepare(password, this.#current.key), ARGON2_PARAMS),
      pepperId: this.#current.id,
    }));
  }

  /** Returns whether it matches and whether the stored hash should be upgraded. */
  async verify(
    password: string,
    stored: { hash: string; pepperId: string },
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    const pepper = this.#peppers.get(stored.pepperId);
    if (pepper === undefined) return { valid: false, needsRehash: false };
    const valid = await this.#semaphore.run(() =>
      verify(stored.hash, this.#prepare(password, pepper)).catch(() => false),
    );
    const outdated =
      stored.pepperId !== this.#current.id ||
      !stored.hash.startsWith(
        `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`,
      );
    return { valid, needsRehash: valid && outdated };
  }

  /**
   * Performs a full verification against a throw-away hash so that requests for unknown
   * accounts take as long as requests for real ones (no user enumeration via timing).
   */
  async burn(password: string): Promise<void> {
    this.#dummyHash ??= this.hash(randomToken()).then((result) => result.hash);
    const dummy = await this.#dummyHash;
    await this.verify(password, { hash: dummy, pepperId: this.#current.id });
  }
}

/**
 * Rejects passwords that are guessable: zxcvbn score below 3 (includes common-password and
 * dictionary lists and keyboard patterns) or containing the user's own identifiers.
 */
export function assertStrongPassword(password: string, userInputs: readonly string[]): void {
  const result = strength.check(password.normalize('NFKC'), [...userInputs]);
  const lower = password.toLowerCase();
  const containsIdentifier = userInputs
    .map((input) => input.toLowerCase().split('@')[0] ?? '')
    .some((token) => token.length >= 4 && lower.includes(token));
  if (result.score < MIN_STRENGTH_SCORE || containsIdentifier) {
    const suggestion = result.feedback.warning ?? result.feedback.suggestions[0];
    throw new AppError('WEAK_PASSWORD', {
      detail:
        suggestion === undefined || suggestion === ''
          ? 'Choose a longer, less predictable password.'
          : `${suggestion} Choose a longer, less predictable password.`,
    });
  }
}
