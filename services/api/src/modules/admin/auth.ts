import { AppError, type Logger } from '@tessera/platform';

import type { AdminPrincipal } from '../../platform/http/admin-routes.js';

import type { AdminDirectory } from './admins.js';
import type { AdminKeys } from './keys.js';
import type { AdminOidc } from './oidc.js';
import type { AdminSessions } from './sessions.js';

/**
 * Staff sign-in (docs/admin.md §1): identity provider first (who you are, still employed), then
 * your security key (proof of possession, phishing-resistant). Only after both is the session
 * active. There are no admin passwords and no way around either step.
 */
export class AdminAuthService {
  readonly #oidc: AdminOidc | null;
  readonly #directory: AdminDirectory;
  readonly #keys: AdminKeys;
  readonly #sessions: AdminSessions;
  readonly #logger: Logger;

  constructor(deps: {
    oidc: AdminOidc | null;
    directory: AdminDirectory;
    keys: AdminKeys;
    sessions: AdminSessions;
    logger: Logger;
  }) {
    this.#oidc = deps.oidc;
    this.#directory = deps.directory;
    this.#keys = deps.keys;
    this.#sessions = deps.sessions;
    this.#logger = deps.logger;
  }

  #requireOidc(): AdminOidc {
    if (this.#oidc === null)
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Sign-in is not configured on this server.',
      });
    return this.#oidc;
  }

  start(): Promise<{ url: string; flowId: string }> {
    return this.#requireOidc().start();
  }

  /** Identity provider done: a half-signed-in session that can only complete the key step. */
  async callback(
    flowId: string | undefined,
    code: string,
    state: string,
    client: { ip: string; userAgent: string | undefined },
  ): Promise<{
    adminId: string;
    token: string;
    expiresAt: Date;
    stage: 'key_setup' | 'key';
  }> {
    const identity = await this.#requireOidc().finish(flowId, code, state);
    const admin = await this.#directory.forIdentity(identity);
    if (admin === null) {
      this.#logger.warn('admin.sign_in_refused', { component: 'admin' });
      throw new AppError('FORBIDDEN', { detail: 'This account cannot use the admin console.' });
    }
    const session = await this.#sessions.create(admin.id, client);
    const keys = await this.#keys.count(admin.id);
    return {
      adminId: admin.id,
      token: session.token,
      expiresAt: session.expiresAt,
      stage: keys === 0 ? 'key_setup' : 'key',
    };
  }

  async keyOptions(principal: AdminPrincipal): Promise<{ flowId: string; options: unknown }> {
    const admin = await this.#directory.byId(principal.adminId);
    if (admin === null) throw new AppError('UNAUTHENTICATED');
    if ((await this.#keys.count(admin.id)) === 0)
      return this.#keys.registrationOptions(
        { id: admin.id, email: admin.email },
        principal.sessionId,
      );
    return this.#keys.authenticationOptions(admin.id, principal.sessionId, 'login');
  }

  /** Registers the first key or verifies a key; then the session becomes active (new token). */
  async keyVerify(
    principal: AdminPrincipal,
    input: { flowId: string; response: Record<string, unknown>; name?: string | undefined },
  ): Promise<{ token: string; expiresAt: Date }> {
    const expected = { adminId: principal.adminId, sessionId: principal.sessionId };
    if ((await this.#keys.count(principal.adminId)) === 0)
      await this.#keys.register(
        input.flowId,
        expected,
        input.name ?? 'Security key',
        input.response,
      );
    else await this.#keys.authenticate(input.flowId, 'login', expected, input.response);
    return this.#sessions.activate(principal.sessionId);
  }

  reauthOptions(principal: AdminPrincipal): Promise<{ flowId: string; options: unknown }> {
    return this.#keys.authenticationOptions(principal.adminId, principal.sessionId, 'reauth');
  }

  async reauthVerify(
    principal: AdminPrincipal,
    input: { flowId: string; response: Record<string, unknown> },
  ): Promise<void> {
    await this.#keys.authenticate(
      input.flowId,
      'reauth',
      { adminId: principal.adminId, sessionId: principal.sessionId },
      input.response,
    );
    await this.#sessions.markReauthenticated(principal.sessionId);
  }

  logout(principal: AdminPrincipal): Promise<void> {
    return this.#sessions.revoke(principal.sessionId, 'logout');
  }
}
