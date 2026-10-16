import { newId } from '@tessera/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startIntegrationApp, type IntegrationApp } from '../../test/integration-app.js';
import { AuditLog } from './audit-log.js';

/** The hash-chain check used after restores (cli/verify-audit.ts), across page boundaries. */
let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

describe('audit chain verification', () => {
  it('accepts an intact chain read in pages and finds a row altered behind the triggers', async () => {
    const audit = new AuditLog(env.db);
    for (let i = 0; i < 7; i += 1)
      await audit.record({
        actorKind: 'system',
        actorId: null,
        action: 'test.entry',
        targetKind: 'test',
        targetId: newId(),
        details: { n: i },
      });
    expect(await audit.verifyChain(3)).toBeNull();
    const rows = await audit.count();
    expect(rows).toBeGreaterThanOrEqual(7);

    // Someone with database superuser rights edits history (the table's own trigger refuses
    // UPDATE, so they disable it first): the check names the first altered row, even when it
    // is in a later page.
    const target = await env.db
      .selectFrom('audit_log')
      .select('seq')
      .orderBy('seq', 'desc')
      .offset(1)
      .limit(1)
      .executeTakeFirstOrThrow();
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`.execute(env.db);
    await sql`UPDATE audit_log SET details = '{"n": 99}' WHERE seq = ${target.seq}`.execute(env.db);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`.execute(env.db);
    expect(await audit.verifyChain(3)).toBe(target.seq);
    expect(await audit.verifyChain(1000)).toBe(target.seq);
  });
});
