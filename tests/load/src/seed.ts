import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@tessera/shared';
import { DEFAULT_PRIVACY_SETTINGS } from '@tessera/validation';
import pg from 'pg';

/**
 * Seeds load-test accounts straight into the database (setup only — the test itself goes
 * through the public HTTP and WebSocket interfaces). Signing up 30,000 accounts through the API
 * would spend most of an hour on Argon2id, which is not what is being measured; everything the
 * scenarios exercise afterwards (session authentication, tickets, sends, fan-out) is the real
 * path. Sessions are stored exactly as the API stores them: only the SHA-256 of the token.
 *
 * Devices carry random keys and certificates: the server stores and serves those bytes but does
 * not interpret them on the message path (they are verified by peers' clients). The headless
 * clients (headless/worker.ts) register real ones through the API instead.
 */

export interface SeededUser {
  readonly id: string;
  readonly username: string;
  readonly token: string;
  readonly deviceId: string;
}

export interface SeededConversation {
  readonly id: string;
  readonly kind: 'direct' | 'group';
  /** Indexes into `users`. */
  readonly members: readonly number[];
}

export interface Seed {
  readonly runId: string;
  readonly users: readonly SeededUser[];
  readonly conversations: readonly SeededConversation[];
}

export interface SeedOptions {
  readonly databaseUrl: string;
  readonly users: number;
  /** Groups to create from the first users (e.g. [1024] for one 1,024-member group). */
  readonly groupSizes?: readonly number[];
  /** Placeholder MLS ciphersuite id (the web client's default). */
  readonly ciphersuite?: number;
  /**
   * `false`: accounts with a session only — no keys, devices or conversations (the headless
   * clients register real ones through the API). Default `true`.
   */
  readonly devices?: boolean;
  readonly prefix?: string;
}

const CHUNK = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function seed(options: SeedOptions): Promise<Seed> {
  const runId = Date.now().toString(36);
  const ciphersuite = options.ciphersuite ?? 1;
  const users: SeededUser[] = Array.from({ length: options.users }, (_, i) => ({
    id: newId(),
    username: `${options.prefix ?? 'load'}_${runId}_${String(i)}`,
    token: randomBytes(32).toString('base64url'),
    deviceId: newId(),
  }));
  const withDevices = options.devices ?? true;
  const conversations: SeededConversation[] = [];
  for (let i = 0; withDevices && i + 1 < users.length; i += 2)
    conversations.push({ id: newId(), kind: 'direct', members: [i, i + 1] });
  for (const size of options.groupSizes ?? [])
    conversations.push({
      id: newId(),
      kind: 'group',
      members: Array.from({ length: Math.min(size, users.length) }, (_, i) => i),
    });

  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const now = Date.now();
    const expires = new Date(now + 2 * DAY_MS);
    for (const part of chunks(users)) {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, username, status, accepted_terms_version, confirmed_adult_at)
         SELECT unnest($1::uuid[]), unnest($2::text[]), 'active', 'load-test', now()`,
        [part.map((u) => u.id), part.map((u) => u.username)],
      );
      await client.query(
        `INSERT INTO user_emails (user_id, email, verified_at)
         SELECT unnest($1::uuid[]), unnest($2::text[]), now()`,
        [part.map((u) => u.id), part.map((u) => `${u.username}@load.tessera.test`)],
      );
      // The rows sign-up creates (accounts module): privacy settings at their defaults.
      await client.query(
        `INSERT INTO privacy_settings (user_id, settings)
         SELECT unnest($1::uuid[]), $2::jsonb`,
        [part.map((u) => u.id), JSON.stringify(DEFAULT_PRIVACY_SETTINGS)],
      );
      await client.query(
        `INSERT INTO sessions (id, user_id, token_digest, stage, idle_expires_at, expires_at,
                               user_agent_summary, ip_prefix)
         SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::bytea[]), 'active', $4, $4,
                'Load test', '127.0.0.0/24'`,
        [
          part.map(() => newId()),
          part.map((u) => u.id),
          part.map((u) => createHash('sha256').update(u.token).digest()),
          expires,
        ],
      );
      if (withDevices) {
        await client.query(
          `INSERT INTO account_keys (user_id, public_key, version)
         SELECT unnest($1::uuid[]), unnest($2::bytea[]), 1`,
          [part.map((u) => u.id), part.map(() => randomBytes(32))],
        );
        await client.query(
          `INSERT INTO devices (id, user_id, ask_version, signature_key, certificate, label)
         SELECT unnest($1::uuid[]), unnest($2::uuid[]), 1, unnest($3::bytea[]), unnest($4::bytea[]),
                'Load test'`,
          [
            part.map((u) => u.deviceId),
            part.map((u) => u.id),
            part.map(() => randomBytes(32)),
            part.map(() => randomBytes(128)),
          ],
        );
      }
      await client.query('COMMIT');
    }
    for (const part of chunks(conversations, 2000)) {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conversations (id, kind, ciphersuite, created_by)
         SELECT unnest($1::uuid[]), unnest($2::text[]), $3, unnest($4::uuid[])`,
        [
          part.map((c) => c.id),
          part.map((c) => c.kind),
          ciphersuite,
          part.map((c) => users[c.members[0] ?? 0]?.id ?? ''),
        ],
      );
      const memberRows = part.flatMap((c) =>
        c.members.map((index, position) => ({
          conversation: c.id,
          user: users[index]?.id ?? '',
          role: position === 0 ? 'owner' : 'member',
        })),
      );
      for (const rows of chunks(memberRows))
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::text[])`,
          [rows.map((r) => r.conversation), rows.map((r) => r.user), rows.map((r) => r.role)],
        );
      const direct = part.filter((c) => c.kind === 'direct');
      if (direct.length > 0) {
        const pairs = direct.map((c) => {
          const [a, b] = c.members.map((index) => users[index]?.id ?? '');
          const [low, high] = (a ?? '') < (b ?? '') ? [a, b] : [b, a];
          return { low: low ?? '', high: high ?? '', conversation: c.id };
        });
        await client.query(
          `INSERT INTO direct_pairs (user_low, user_high, conversation_id)
           SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($3::uuid[])`,
          [pairs.map((p) => p.low), pairs.map((p) => p.high), pairs.map((p) => p.conversation)],
        );
      }
      await client.query('COMMIT');
    }
    await client.query('ANALYZE users, sessions, devices, conversations, conversation_members');
  } finally {
    await client.end();
  }
  return { runId, users, conversations };
}
