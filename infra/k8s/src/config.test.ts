import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadApiConfig } from '@tessera/api/config';
import { loadFetcherConfig } from '@tessera/api/fetcher-config';
import { loadMigrateConfig } from '@tessera/api/migrate-config';
import { loadRealtimeConfig } from '@tessera/realtime/config';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_SECRET_KEYS,
  API_SECRET_KEYS,
  FETCHER_SECRET_KEYS,
  MIGRATE_SECRET_KEYS,
  OPTIONAL_API_SECRET_KEYS,
  REALTIME_SECRET_KEYS,
} from './manifests.js';
import {
  ENVIRONMENTS,
  REPO_ROOT,
  containerConfig,
  named,
  ofKind,
  rendered,
  type Workload,
} from './test-support.js';

/**
 * The rendered settings plus secrets of the documented shape (generated here, never real) must
 * pass each service's own configuration loader with NODE_ENV=production — the loaders refuse
 * insecure production settings, so this ties the manifests to those checks.
 */
const b64 = (bytes: number) => randomBytes(bytes).toString('base64');
const p256 = () => {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return key;
};
const vapid = p256();
const moderation = p256();
const SECRETS: Record<string, string> = {
  DATABASE_URL: 'postgres://tessera_app:pw@db.internal:5432/tessera?sslmode=verify-full',
  VALKEY_URL: 'rediss://:token@cache.internal:6379',
  SMTP_URL: 'smtps://user:pw@email-smtp.ap-south-1.amazonaws.com:465',
  PASSWORD_PEPPER: `p1:${b64(32)}`,
  SECRET_BOX_KEYS: `k1:${b64(32)}`,
  TURN_SHARED_SECRET: 't'.repeat(48),
  LIVEKIT_API_KEY: 'APIprod1',
  LIVEKIT_API_SECRET: 's'.repeat(48),
  VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()])
    .subarray(-32)
    .toString('base64url'),
  FRANKING_KEYS: `f1:${b64(32)}`,
  MODERATION_HPKE_PUBLIC_KEY: moderation.getPublicKey().toString('base64url'),
  MODERATION_HPKE_PRIVATE_KEY: moderation.getPrivateKey().toString('base64url'),
  LINK_PREVIEW_FETCHER_TOKEN: 'f'.repeat(48),
  FETCHER_TOKEN: 'f'.repeat(48),
  ADMIN_OIDC_CLIENT_ID: 'tessera-admin',
  ADMIN_OIDC_CLIENT_SECRET: 'c'.repeat(40),
};
const secrets = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, SECRETS[key] ?? '']));

describe.each(ENVIRONMENTS)('%s settings', (environment) => {
  const all = rendered(environment);
  const deployment = (name: string) => named<Workload>(all, 'Deployment', name);

  it('boot the user API in production mode', () => {
    const config = loadApiConfig({
      ...containerConfig(all, deployment('api')),
      ...secrets(API_SECRET_KEYS),
    });
    expect(config.NODE_ENV).toBe('production');
    expect(config.LINK_PREVIEW_FETCHER_URL).toMatch(/^http:\/\/link-fetcher\./);
    // Paths on the web origin, as the web app's CSP requires.
    expect(config.REALTIME_WS_PATH).toBe('/rt/v1/ws');
    expect(config.LIVEKIT_URL).toBe('/sfu');
  });

  it('boot the admin API in production mode', () => {
    const config = loadApiConfig({
      ...containerConfig(all, deployment('admin-api')),
      ...secrets([...API_SECRET_KEYS, ...ADMIN_SECRET_KEYS]),
    });
    // admin-server.ts also needs its origin and public URL.
    expect(config.ADMIN_ORIGINS).toBeDefined();
    expect(config.ADMIN_PUBLIC_URL).toBeDefined();
  });

  it('boot the realtime gateway, the fetcher and the migration job in production mode', () => {
    expect(
      loadRealtimeConfig({
        ...containerConfig(all, deployment('realtime')),
        ...secrets(REALTIME_SECRET_KEYS),
      }).NODE_ENV,
    ).toBe('production');
    expect(
      loadFetcherConfig({
        ...containerConfig(all, deployment('link-fetcher')),
        ...secrets(FETCHER_SECRET_KEYS),
      }).NODE_ENV,
    ).toBe('production');
    const job = ofKind<Workload>(all, 'Job')[0];
    expect(job).toBeDefined();
    if (job !== undefined)
      expect(
        loadMigrateConfig({ ...containerConfig(all, job), ...secrets(MIGRATE_SECRET_KEYS) })
          .NODE_ENV,
      ).toBe('production');
  });

  it('keep every secret out of the ConfigMaps', () => {
    const secretKeys = new Set<string>([
      ...API_SECRET_KEYS,
      ...ADMIN_SECRET_KEYS,
      ...REALTIME_SECRET_KEYS,
      ...FETCHER_SECRET_KEYS,
      ...OPTIONAL_API_SECRET_KEYS,
      'TURN_STATIC_AUTH_SECRET',
      'LIVEKIT_KEYS',
      'REDIS_PASSWORD',
    ]);
    for (const map of ofKind<{ metadata: { name: string }; data: Record<string, string> }>(
      all,
      'ConfigMap',
    ))
      for (const key of Object.keys(map.data))
        expect(secretKeys.has(key), `${map.metadata.name}: ${key}`).toBe(false);
  });
});

describe('secret contracts', () => {
  it('name only settings the services actually read', () => {
    const api = readFileSync(path.join(REPO_ROOT, 'services/api/src/config.ts'), 'utf8');
    for (const key of [...API_SECRET_KEYS, ...ADMIN_SECRET_KEYS, ...OPTIONAL_API_SECRET_KEYS])
      expect(api, key).toContain(`${key}:`);
    const realtime = readFileSync(path.join(REPO_ROOT, 'services/realtime/src/config.ts'), 'utf8');
    for (const key of REALTIME_SECRET_KEYS) expect(realtime, key).toContain(`${key}:`);
  });
});
