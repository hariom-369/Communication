import { createHash } from 'node:crypto';

import type { Logger } from '@tessera/platform';

/**
 * Breached-password check (docs/authentication.md §2.1): is this password in a corpus of
 * passwords known from data breaches? The strength estimator catches guessable passwords; this
 * catches the ones credential-stuffing lists are made of, however random they look.
 */
export interface BreachedPasswords {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Asks a mirror of the Pwned Passwords range API (`GET <base>/range/<first 5 hex of SHA-1>` →
 * lines `SUFFIX:COUNT`) — run by us, so no third party learns even the 5-character prefix
 * (k-anonymity holds anyway: one prefix covers hundreds of passwords). The mirror is a static set
 * of 16^5 files, e.g. in object storage behind an internal endpoint (docs/deployment.md).
 *
 * Fails open: if the mirror cannot answer within the timeout, the password is checked by the
 * strength estimator alone and a warning is logged — a mirror outage must not stop sign-ups.
 */
export class RangeApiBreachedPasswords implements BreachedPasswords {
  readonly #base: string;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #onUnavailable: () => void;

  constructor(options: {
    baseUrl: string;
    logger: Logger;
    timeoutMs?: number;
    fetch?: typeof fetch;
    /** Called each time the check fails open (a metric; alerts watch it). */
    onUnavailable?: () => void;
  }) {
    this.#base = options.baseUrl.replace(/\/$/, '');
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#fetch = options.fetch ?? fetch;
    this.#onUnavailable = options.onUnavailable ?? (() => undefined);
  }

  async isBreached(password: string): Promise<boolean> {
    // As typed: the corpus holds passwords as their owners typed them (no normalisation).
    const digest = createHash('sha1').update(password, 'utf8').digest('hex');
    const prefix = digest.slice(0, 5).toUpperCase();
    const suffix = digest.slice(5).toUpperCase();
    try {
      const response = await this.#fetch(`${this.#base}/range/${prefix}`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`breach mirror answered ${String(response.status)}`);
      for (const line of (await response.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':');
        // Padding entries (count 0) are not breached passwords.
        if (candidate?.toUpperCase() === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (error) {
      this.#logger.warn('auth.breach_check_unavailable', this.#logger.errorFields(error));
      this.#onUnavailable();
      return false;
    }
  }
}
