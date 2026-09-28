import { randomBytes } from 'node:crypto';

import { BACKUP_VERSIONS_KEPT, backupStatusSchema } from '@tessera/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';

/** Encrypted backups: the server stores ciphertext and wrapped keys only (docs/encrypted-backups.md). */

let env: IntegrationApp;
beforeAll(async () => {
  env = await startIntegrationApp();
});
afterAll(async () => {
  await env.close();
});

async function user() {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  return { ...created, id: me.id };
}

const wrap = () => randomBytes(72).toString('base64');
const upload = (version: number, size = 1000) => ({
  version,
  manifest: JSON.stringify({ version }),
  mac: randomBytes(32).toString('base64'),
  blob: randomBytes(size).toString('base64'),
});

async function staleStepUp(userId: string): Promise<void> {
  await env.db
    .updateTable('sessions')
    .set({ reauthenticated_at: new Date(Date.now() - 11 * 60_000) })
    .where('user_id', '=', userId)
    .execute();
}

describe("'backups.status', 'backups.add_key', 'backups.upload' and 'backups.latest'", () => {
  it('stores versioned ciphertext once a key can unlock it, keeping the last versions', async () => {
    const alice = await user();
    expect(backupStatusSchema.parse((await alice.client.get('/api/v1/backups')).json())).toEqual({
      latest: null,
      wraps: [],
    });
    // Without a way to unlock it, a backup would be useless: refused.
    expect((await alice.client.post('/api/v1/backups/versions', upload(1))).json()).toMatchObject({
      code: 'CONFLICT',
    });
    const recoveryWrap = wrap();
    const added = await alice.client.post('/api/v1/backups/keys', {
      kind: 'recovery',
      wrap: recoveryWrap,
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(env.mailer.to(alice.email).map((m) => m.subject)).toContain(
      'Tessera security notice: A new recovery key can unlock your message backups',
    );

    expect((await alice.client.post('/api/v1/backups/versions', upload(1))).statusCode).toBe(201);
    // Versions must advance one at a time (two devices racing: the loser retries).
    expect((await alice.client.post('/api/v1/backups/versions', upload(1))).statusCode).toBe(409);
    expect((await alice.client.post('/api/v1/backups/versions', upload(3))).statusCode).toBe(409);
    for (const version of [2, 3, 4]) {
      expect(
        (await alice.client.post('/api/v1/backups/versions', upload(version))).statusCode,
      ).toBe(201);
    }
    const kept = await env.db
      .selectFrom('backups')
      .select('version')
      .where('user_id', '=', alice.id)
      .orderBy('version')
      .execute();
    expect(kept.map((row) => Number(row.version))).toEqual([2, 3, 4].slice(-BACKUP_VERSIONS_KEPT));

    const latest = (await alice.client.get('/api/v1/backups/latest')).json<{
      version: number;
      wraps: { kind: string; wrap: string }[];
    }>();
    expect(latest.version).toBe(4);
    expect(latest.wraps).toEqual([
      expect.objectContaining({ kind: 'recovery', wrap: recoveryWrap }),
    ]);
    expect(
      backupStatusSchema.parse((await alice.client.get('/api/v1/backups')).json()).latest,
    ).toMatchObject({
      version: 4,
      size: 1000,
      manifest: JSON.stringify({ version: 4 }),
    });

    // Another account sees none of it.
    const bob = await user();
    expect((await bob.client.get('/api/v1/backups/latest')).statusCode).toBe(404);
  });

  it('keeps one recovery key and any number of passkeys, validating wrap sizes', async () => {
    const alice = await user();
    await alice.client.post('/api/v1/backups/keys', { kind: 'recovery', wrap: wrap() });
    const replacement = wrap();
    await alice.client.post('/api/v1/backups/keys', { kind: 'recovery', wrap: replacement });
    const passkey = await alice.client.post('/api/v1/backups/keys', {
      kind: 'passkey',
      wrap: wrap(),
      credentialId: 'Y3JlZGVudGlhbA',
      prfSalt: randomBytes(32).toString('base64'),
    });
    expect(passkey.statusCode, passkey.body).toBe(201);
    const status = backupStatusSchema.parse((await alice.client.get('/api/v1/backups')).json());
    expect(status.wraps.map((w) => w.kind)).toEqual(['recovery', 'passkey']);
    expect(
      (
        await alice.client.post('/api/v1/backups/keys', {
          kind: 'recovery',
          wrap: randomBytes(40).toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await alice.client.post('/api/v1/backups/keys', { kind: 'passkey', wrap: wrap() }))
        .statusCode,
    ).toBe(400);
  });
});

describe("'backups.remove_key' and 'backups.disable'", () => {
  it('require step-up, are audited, alert the owner, and delete everything on disable', async () => {
    const alice = await user();
    const { id } = (
      await alice.client.post('/api/v1/backups/keys', { kind: 'recovery', wrap: wrap() })
    ).json<{
      id: string;
    }>();
    await alice.client.post('/api/v1/backups/versions', upload(1));
    await staleStepUp(alice.id);
    expect((await alice.client.delete(`/api/v1/backups/keys/${id}`)).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect((await alice.client.delete('/api/v1/backups')).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    // Adding a key also needs recent authentication (an attacker with a stolen cookie cannot).
    expect(
      (await alice.client.post('/api/v1/backups/keys', { kind: 'recovery', wrap: wrap() })).json(),
    ).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await alice.client.post('/api/v1/auth/reauth/password', { password: alice.password });
    expect((await alice.client.delete(`/api/v1/backups/keys/${id}`)).statusCode).toBe(200);
    expect((await alice.client.delete(`/api/v1/backups/keys/${id}`)).statusCode).toBe(404);
    expect((await alice.client.delete('/api/v1/backups')).statusCode).toBe(200);
    expect(backupStatusSchema.parse((await alice.client.get('/api/v1/backups')).json())).toEqual({
      latest: null,
      wraps: [],
    });
    const actions = await env.db
      .selectFrom('audit_log')
      .select('action')
      .where('actor_id', '=', alice.id)
      .where('action', 'like', 'backups.%')
      .orderBy('seq')
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      'backups.key_added',
      'backups.key_removed',
      'backups.disabled',
    ]);
    expect(env.mailer.to(alice.email).map((m) => m.subject)).toContain(
      'Tessera security notice: Message backups were turned off and deleted',
    );
  });
});
