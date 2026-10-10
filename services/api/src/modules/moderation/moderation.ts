import { createHash } from 'node:crypto';

import { AppError, type Logger } from '@tessera/platform';
import { newId } from '@tessera/shared';
import {
  APPEAL_WINDOW_DAYS,
  MAX_REPORT_CONTEXT,
  MAX_REPORTED_MESSAGES,
  REASON_TEXT,
  reportBundleSchema,
  type AppealSummary,
  type BlocklistItem,
  type CaseDetail,
  type CaseSummary,
  type CreateReport,
  type EvidenceView,
  type MyReport,
  type Notice,
  type ReasonCode,
  type ReportBundle,
  type ReportCategory,
  type ReportTargetKind,
  type StaffRole,
  type Standing,
  type Transparency,
} from '@tessera/validation';
import type { Redis } from 'ioredis';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';

import type { Database, ModerationActionsTable, ModerationCasesTable } from '../../db/schema.js';
import type { Mailer } from '../../platform/email.js';
import { commitmentOpens, type FrankingTagger } from '../../platform/franking.js';
import type { SecretBox } from '../../platform/secrets.js';
import type { AuditLog } from '../audit/index.js';

import { bundleAad, type ModerationKey } from './hpke.js';
import { hostHash, hostsIn, hostVariants } from './links.js';
import { deadlines, serviceLevel } from './sla.js';

/**
 * Abuse prevention and moderation (docs/moderation.md, ADR-021, ADR-049).
 *
 * - People block (server-enforced) and report. A report of end-to-end encrypted messages
 *   carries only what the reporter selected, encrypted to the moderation key; franked messages
 *   are verified (the plaintext is what the sender's device sent).
 * - Reports, grievances and legal orders become cases with service-level deadlines.
 * - Moderators see cases — never conversations — and act along the enforcement ladder; bans and
 *   legal referrals need a second reviewer; every action is audited, explained to the person
 *   and can be appealed to a different reviewer.
 */

type Executor = Kysely<Database> | Transaction<Database>;
type CaseRow = Selectable<ModerationCasesTable>;
type ActionRow = Selectable<ModerationActionsTable>;
type SubjectKind = CaseRow['subject_kind'];

export interface ModerationAccounts {
  usernames(userIds: readonly string[]): Promise<Map<string, string>>;
  accountCreatedAt(userId: string): Promise<Date | null>;
}

export interface ModerationSessions {
  revokeAll(userId: string, reason: string): Promise<number>;
}

/** Email and in-app notice to a person (the auth module's security notices). */
export interface ModerationNotices {
  securityNotice(userId: string, headline: string, lines?: readonly string[]): Promise<void>;
}

export interface ModerationConversations {
  isMember(userId: string, conversationId: string): Promise<boolean>;
  directPeer(userId: string, conversationId: string): Promise<string | null>;
}

export interface ModerationChannels {
  moderationSnapshot(
    viewer: string,
    kind: 'channel' | 'post' | 'comment',
    channelId: string,
    id: string,
  ): Promise<{ authorId: string; content: Record<string, unknown> } | null>;
  moderationSetRemoved(
    kind: 'post' | 'comment',
    channelId: string,
    id: string,
    removed: boolean,
    actor: string | null,
  ): Promise<void>;
  moderationSetState(channelId: string, state: 'ok' | 'unlisted' | 'suspended'): Promise<void>;
  moderationLabel(channelId: string): Promise<string>;
}

export interface ModerationCommunities {
  moderationSnapshot(
    viewer: string,
    id: string,
  ): Promise<{ authorId: string; content: Record<string, unknown> } | null>;
  moderationLabel(id: string): Promise<string>;
}

export interface ModerationDeps {
  readonly db: Kysely<Database>;
  readonly valkey: Redis;
  readonly keyPrefix: string;
  readonly audit: AuditLog;
  readonly secretBox: SecretBox;
  readonly mailer: Mailer;
  readonly logger: Logger;
  readonly moderationKey: ModerationKey | null;
  readonly franking: FrankingTagger | null;
  readonly accounts: ModerationAccounts;
  readonly sessions: ModerationSessions;
  readonly notices: ModerationNotices;
  readonly conversations: ModerationConversations;
  readonly channels: ModerationChannels;
  readonly communities: ModerationCommunities;
  readonly evidenceRetentionDays: number;
}

const DAY_MS = 24 * 3_600_000;
/** New accounts (docs/moderation.md §4): limits during their first week. */
const NEW_ACCOUNT_MS = 7 * DAY_MS;
const NEW_ACCOUNT_LIMITS = {
  chat: {
    limit: 20,
    windowSeconds: 24 * 3600,
    detail: 'New accounts can start up to 20 new chats a day.',
  },
  group: {
    limit: 5,
    windowSeconds: 24 * 3600,
    detail: 'New accounts can create up to 5 groups a day.',
  },
  channel: {
    limit: 2,
    windowSeconds: 7 * 24 * 3600,
    detail: 'New accounts can create up to 2 channels in their first week.',
  },
  invite: {
    limit: 10,
    windowSeconds: 24 * 3600,
    detail: 'New accounts can create up to 10 invite links a day.',
  },
} as const;
/** Behaviour signals: this many distinct people reporting or blocking within a day. */
const REPORT_SIGNAL = 3;
const BLOCK_SIGNAL = 5;
const AUTO_RESTRICTION_HOURS = 24;
const STANDING_CACHE_MS = 10_000;
const STAFF_CACHE_MS = 30_000;
const SYSTEM_NOTE = 'Automatic: several people reported or blocked this account within a day.';

const reportedBodySchema = z.object({
  f: z.string().optional(),
  body: z.looseObject({ kind: z.string() }),
});
const mediaBodySchema = z.object({
  kind: z.literal('media'),
  attachment: z.object({ media: z.object({ plaintextSha256: z.string() }) }),
});

function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export class ModerationService {
  readonly #d: ModerationDeps;
  readonly #standingCache = new Map<string, { at: number; suspended: boolean }>();
  readonly #staffCache = new Map<string, { at: number; roles: StaffRole[] }>();

  constructor(deps: ModerationDeps) {
    this.#d = deps;
  }

  get reportsWithMessages(): boolean {
    return this.#d.moderationKey !== null;
  }

  moderationPublicKey(): string | null {
    return this.#d.moderationKey?.publicKey ?? null;
  }

  // ---- blocks (docs/moderation.md §2) -----------------------------------------------------------

  async block(blocker: string, target: string): Promise<void> {
    if (blocker === target)
      throw new AppError('BAD_REQUEST', { detail: 'You cannot block yourself.' });
    const names = await this.#d.accounts.usernames([target]);
    if (!names.has(target)) throw new AppError('NOT_FOUND');
    await this.#d.db
      .insertInto('blocks')
      .values({ blocker_id: blocker, blocked_id: target })
      .onConflict((oc) => oc.columns(['blocker_id', 'blocked_id']).doNothing())
      .execute();
    await this.#behaviourSignal(target);
  }

  async unblock(blocker: string, target: string): Promise<void> {
    await this.#d.db
      .deleteFrom('blocks')
      .where('blocker_id', '=', blocker)
      .where('blocked_id', '=', target)
      .execute();
  }

  async blocked(
    blocker: string,
  ): Promise<{ userId: string; username: string; createdAt: string }[]> {
    const rows = await this.#d.db
      .selectFrom('blocks')
      .select(['blocked_id', 'created_at'])
      .where('blocker_id', '=', blocker)
      .orderBy('created_at', 'desc')
      .execute();
    const names = await this.#d.accounts.usernames(rows.map((row) => row.blocked_id));
    return rows.map((row) => ({
      userId: row.blocked_id,
      username: names.get(row.blocked_id) ?? 'deleted',
      createdAt: row.created_at.toISOString(),
    }));
  }

  async blockedEitherWay(a: string, b: string): Promise<boolean> {
    const row = await this.#d.db
      .selectFrom('blocks')
      .select('blocker_id')
      .where((eb) =>
        eb.or([
          eb.and([eb('blocker_id', '=', a), eb('blocked_id', '=', b)]),
          eb.and([eb('blocker_id', '=', b), eb('blocked_id', '=', a)]),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Did `blocker` block `target`? (Group adds respect the person being added.) */
  async hasBlocked(blocker: string, target: string): Promise<boolean> {
    const row = await this.#d.db
      .selectFrom('blocks')
      .select('blocker_id')
      .where('blocker_id', '=', blocker)
      .where('blocked_id', '=', target)
      .executeTakeFirst();
    return row !== undefined;
  }

  // ---- account standing, restrictions, new-account limits ------------------------------------

  async #activeActions(userId: string, executor: Executor = this.#d.db): Promise<ActionRow[]> {
    const now = new Date();
    return executor
      .selectFrom('moderation_actions')
      .selectAll()
      .where('subject_user_id', '=', userId)
      .where('status', '=', 'active')
      .where('action', 'in', ['restrict', 'suspend', 'ban'])
      .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
      .execute();
  }

  /** Whether the account may use the app beyond its status page (cached briefly). */
  async suspended(userId: string): Promise<boolean> {
    const cached = this.#standingCache.get(userId);
    if (cached !== undefined && Date.now() - cached.at < STANDING_CACHE_MS) return cached.suspended;
    const actions = await this.#activeActions(userId);
    const suspended = actions.some((a) => a.action === 'suspend' || a.action === 'ban');
    this.#standingCache.set(userId, { at: Date.now(), suspended });
    if (this.#standingCache.size > 50_000) this.#standingCache.clear();
    return suspended;
  }

  /**
   * Refuses starting chats, groups, channels or invites when a restriction applies, and limits
   * new accounts during their first week (spam waves come from fresh accounts).
   */
  async assertMay(userId: string, kind: 'chat' | 'group' | 'channel' | 'invite'): Promise<void> {
    const actions = await this.#activeActions(userId);
    const restricted = actions.some(
      (a) =>
        a.action === 'restrict' &&
        (a.restriction === 'creation' || (a.restriction === 'new_chats' && kind === 'chat')),
    );
    if (restricted)
      throw new AppError('FORBIDDEN', {
        detail:
          kind === 'chat'
            ? 'Your account cannot start new chats right now. See Settings → Account status.'
            : 'Your account cannot create this right now. See Settings → Account status.',
      });
    const created = await this.#d.accounts.accountCreatedAt(userId);
    if (created === null || Date.now() - created.getTime() >= NEW_ACCOUNT_MS) return;
    const limit = NEW_ACCOUNT_LIMITS[kind];
    const key = `${this.#d.keyPrefix}:trust:${kind}:${userId}`;
    const count = await this.#d.valkey.incr(key);
    if (count === 1) await this.#d.valkey.expire(key, limit.windowSeconds);
    if (count > limit.limit) {
      const ttl = await this.#d.valkey.ttl(key);
      throw new AppError('RATE_LIMITED', {
        detail: limit.detail,
        retryAfterSeconds: Math.max(1, ttl),
      });
    }
  }

  async standing(userId: string): Promise<Standing> {
    const since = new Date(Date.now() - APPEAL_WINDOW_DAYS * DAY_MS);
    const rows = await this.#d.db
      .selectFrom('moderation_actions')
      .selectAll()
      .where('subject_user_id', '=', userId)
      .where('status', 'in', ['active', 'reverted'])
      .where('action', '!=', 'legal_referral')
      .where((eb) =>
        eb.or([
          eb('created_at', '>', since),
          eb.and([
            eb('status', '=', 'active'),
            eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', new Date())]),
          ]),
        ]),
      )
      .orderBy('created_at', 'desc')
      .execute();
    const appeals =
      rows.length === 0
        ? []
        : await this.#d.db
            .selectFrom('moderation_appeals')
            .selectAll()
            .where(
              'action_id',
              'in',
              rows.map((row) => row.id),
            )
            .execute();
    const now = Date.now();
    const notices: Notice[] = rows.map((row) => {
      const appeal = appeals.find((a) => a.action_id === row.id);
      const active =
        row.status === 'active' && (row.ends_at === null || row.ends_at.getTime() > now);
      return {
        actionId: row.id,
        action: row.action,
        restriction: row.restriction,
        reasonCode: row.reason_code,
        targetKind: row.target_kind,
        startsAt: row.starts_at.toISOString(),
        endsAt: iso(row.ends_at),
        active,
        appeal:
          appeal === undefined
            ? null
            : {
                status: appeal.status,
                decidedAt: iso(appeal.decided_at),
                reason: appeal.decision_reason,
              },
        appealable:
          appeal === undefined &&
          row.status === 'active' &&
          now - row.created_at.getTime() < APPEAL_WINDOW_DAYS * DAY_MS,
      };
    });
    const live = notices.filter((n) => n.active);
    const ban = live.find((n) => n.action === 'ban');
    const suspensions = live.filter((n) => n.action === 'suspend');
    const status =
      ban !== undefined
        ? 'banned'
        : suspensions.length > 0
          ? 'suspended'
          : live.some((n) => n.action === 'restrict')
            ? 'restricted'
            : 'good';
    const until = suspensions
      .map((n) => n.endsAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1);
    return { status, suspendedUntil: until ?? null, notices };
  }

  async appeal(userId: string, actionId: string, statement: string): Promise<void> {
    const action = await this.#d.db
      .selectFrom('moderation_actions')
      .selectAll()
      .where('id', '=', actionId)
      .where('subject_user_id', '=', userId)
      .executeTakeFirst();
    if (action === undefined) throw new AppError('NOT_FOUND');
    if (action.status !== 'active')
      throw new AppError('CONFLICT', { detail: 'This decision is not in effect.' });
    if (Date.now() - action.created_at.getTime() > APPEAL_WINDOW_DAYS * DAY_MS)
      throw new AppError('CONFLICT', {
        detail: `Appeals are possible for ${APPEAL_WINDOW_DAYS} days after a decision.`,
      });
    try {
      await this.#d.db
        .insertInto('moderation_appeals')
        .values({ id: newId(), action_id: actionId, user_id: userId, statement, status: 'open' })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('CONFLICT', { detail: 'You already appealed this decision.' });
      throw error;
    }
    await this.#event(this.#d.db, action.case_id, userId, 'appeal', { actionId });
  }

  // ---- reports (docs/moderation.md §3) --------------------------------------------------------

  async report(reporterId: string, input: CreateReport): Promise<{ id: string }> {
    const target = input.target;
    let subject: { kind: SubjectKind; id: string; parentId: string | null; userId: string | null };
    let evidence: Omit<Parameters<typeof this.insertEvidence>[1], 'caseId'> | null = null;
    let verification: 'content_verified' | 'unverified' | 'server_content' | 'none' = 'none';
    let category: string = input.category;
    let csam = false;
    let csamProven = false;

    switch (target.kind) {
      case 'user': {
        if (target.userId === reporterId)
          throw new AppError('BAD_REQUEST', { detail: 'You cannot report yourself.' });
        const names = await this.#d.accounts.usernames([target.userId]);
        if (!names.has(target.userId)) throw new AppError('NOT_FOUND');
        subject = { kind: 'user', id: target.userId, parentId: null, userId: target.userId };
        break;
      }
      case 'conversation': {
        if (!(await this.#d.conversations.isMember(reporterId, target.conversationId)))
          throw new AppError('NOT_FOUND');
        const peer = await this.#d.conversations.directPeer(reporterId, target.conversationId);
        if (target.userId !== undefined && target.userId !== peer)
          throw new AppError('BAD_REQUEST', { detail: 'That person is not in this chat.' });
        subject =
          peer === null
            ? { kind: 'conversation', id: target.conversationId, parentId: null, userId: null }
            : { kind: 'user', id: peer, parentId: null, userId: peer };
        if (target.bundle !== null) {
          const opened = await this.#openBundle(reporterId, target.conversationId, target);
          verification = opened.verified ? 'content_verified' : 'unverified';
          csam = opened.csam;
          csamProven = opened.csamProven;
          const senders = [
            ...new Set(
              opened.bundle.messages
                .filter((m) => m.selected && m.senderUserId !== reporterId)
                .map((m) => m.senderUserId),
            ),
          ];
          // In a group, the person whose messages were reported is the subject.
          if (peer === null && senders.length === 1 && senders[0] !== undefined)
            subject = { kind: 'user', id: senders[0], parentId: null, userId: senders[0] };
          evidence = {
            kind: 'e2ee_bundle',
            hpkeEnc: Buffer.from(target.bundle.enc, 'base64url'),
            sealed: Buffer.from(target.bundle.ciphertext, 'base64'),
            plaintextSha256: sha256(opened.plaintext),
            mediaCount: opened.bundle.media.length,
            csamMatch: opened.csam,
          };
        }
        break;
      }
      case 'channel':
      case 'post':
      case 'comment': {
        const id =
          target.kind === 'channel'
            ? target.channelId
            : target.kind === 'post'
              ? target.postId
              : target.commentId;
        const snapshot = await this.#d.channels.moderationSnapshot(
          reporterId,
          target.kind,
          target.channelId,
          id,
        );
        if (snapshot === null) throw new AppError('NOT_FOUND');
        subject = {
          kind: target.kind,
          id,
          parentId: target.kind === 'channel' ? null : target.channelId,
          userId: snapshot.authorId,
        };
        evidence = this.#snapshotEvidence({ kind: target.kind, ...snapshot.content });
        verification = 'server_content';
        break;
      }
      case 'community': {
        const snapshot = await this.#d.communities.moderationSnapshot(
          reporterId,
          target.communityId,
        );
        if (snapshot === null) throw new AppError('NOT_FOUND');
        subject = {
          kind: 'community',
          id: target.communityId,
          parentId: null,
          userId: snapshot.authorId,
        };
        evidence = this.#snapshotEvidence({ kind: 'community', ...snapshot.content });
        verification = 'server_content';
        break;
      }
    }
    if (csam) category = 'csam';

    const reportId = newId();
    const caseId = await this.#d.db.transaction().execute(async (trx) => {
      const caseRow = await this.#openCase(trx, {
        subjectKind: subject.kind,
        subjectId: subject.id,
        subjectParentId: subject.parentId,
        subjectUserId: subject.userId,
        category,
        source: 'report',
        legalHold: csam,
      });
      const evidenceId =
        evidence === null
          ? null
          : await this.insertEvidence(trx, { ...evidence, caseId: caseRow.id });
      try {
        await trx
          .insertInto('moderation_reports')
          .values({
            id: reportId,
            case_id: caseRow.id,
            reporter_id: reporterId,
            target_kind: target.kind,
            target_id: subject.id,
            category: input.category,
            details: input.details,
            evidence_id: evidenceId,
            verification,
          })
          .execute();
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new AppError('CONFLICT', { detail: 'You already reported this.' });
        throw error;
      }
      await this.#event(trx, caseRow.id, reporterId, 'report', {
        reportId,
        category: input.category,
        verification,
        ...(target.kind === 'conversation' ? { conversationId: target.conversationId } : {}),
        ...(csam ? { csamMatch: true, provenSender: csamProven } : {}),
      });
      return caseRow.id;
    });

    if (input.block && subject.userId !== null && subject.userId !== reporterId)
      await this.block(reporterId, subject.userId);
    if (subject.userId !== null) {
      if (csamProven) await this.#csamResponse(caseId, subject.userId);
      else await this.#behaviourSignal(subject.userId);
    }
    return { id: reportId };
  }

  async myReports(reporterId: string): Promise<MyReport[]> {
    const rows = await this.#d.db
      .selectFrom('moderation_reports')
      .innerJoin('moderation_cases', 'moderation_cases.id', 'moderation_reports.case_id')
      .select([
        'moderation_reports.id',
        'moderation_reports.target_kind',
        'moderation_reports.category',
        'moderation_reports.created_at',
        'moderation_cases.status',
      ])
      .where('moderation_reports.reporter_id', '=', reporterId)
      .orderBy('moderation_reports.created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      targetKind: row.target_kind as ReportTargetKind,
      category: row.category as ReportCategory,
      createdAt: row.created_at.toISOString(),
      status:
        row.status === 'open'
          ? ('received' as const)
          : row.status === 'actioned'
            ? ('action_taken' as const)
            : ('no_violation' as const),
    }));
  }

  /** Decrypts, validates and verifies a report bundle (nothing of it is stored in the clear). */
  async #openBundle(
    reporterId: string,
    conversationId: string,
    target: Extract<CreateReport['target'], { kind: 'conversation' }>,
  ): Promise<{
    bundle: ReportBundle;
    plaintext: Buffer;
    verified: boolean;
    csam: boolean;
    /** The match is on media whose digest is in a franked (verified) message of the sender. */
    csamProven: boolean;
  }> {
    const key = this.#d.moderationKey;
    if (key === null || target.bundle === null)
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Reports with messages are not available on this server.',
      });
    let plaintext: Buffer;
    try {
      plaintext = await key.open(
        Buffer.from(target.bundle.enc, 'base64url'),
        Buffer.from(target.bundle.ciphertext, 'base64'),
        bundleAad(conversationId, reporterId),
      );
    } catch {
      throw new AppError('BAD_REQUEST', { detail: 'The report could not be read.' });
    }
    let bundle: ReportBundle;
    try {
      bundle = reportBundleSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } catch {
      throw new AppError('BAD_REQUEST', { detail: 'The report is malformed.' });
    }
    const claimed = [...target.seqs].sort((a, b) => a - b).join(',');
    const inside = bundle.messages
      .map((m) => m.seq)
      .sort((a, b) => a - b)
      .join(',');
    const selected = bundle.messages.filter((m) => m.selected).length;
    if (
      bundle.conversationId !== conversationId ||
      bundle.reporterId !== reporterId ||
      claimed !== inside ||
      selected === 0 ||
      selected > MAX_REPORTED_MESSAGES ||
      bundle.messages.length - selected > MAX_REPORT_CONTEXT
    )
      throw new AppError('BAD_REQUEST', { detail: 'The report does not match its messages.' });

    // Franking: each selected message must carry a tag this server issued and a commitment that
    // opens to the reported plaintext.
    const verifiedSeqs = new Set<number>();
    for (const message of bundle.messages) {
      if (message.commitment === null || message.frankingTag === null || this.#d.franking === null)
        continue;
      const commitment = Buffer.from(message.commitment, 'base64');
      const tagged = this.#d.franking.verify(message.frankingTag, commitment, {
        conversationId,
        seq: message.seq,
        senderUserId: message.senderUserId,
        senderDeviceId: message.senderDeviceId,
        clientMessageId: message.clientMessageId,
        serverTime: message.serverTime,
      });
      if (!tagged) continue;
      const content = reportedBodySchema.safeParse(safeJson(message.plaintext));
      if (!content.success || content.data.f === undefined) continue;
      if (
        commitmentOpens(
          commitment,
          Buffer.from(content.data.f, 'base64'),
          Buffer.from(message.plaintext, 'utf8'),
        )
      )
        verifiedSeqs.add(message.seq);
    }
    const verified = bundle.messages
      .filter((m) => m.selected)
      .every((m) => verifiedSeqs.has(m.seq));

    // Media: the digests of supplied files, and those attested by verified messages.
    const known = new Set<string>();
    const attested = new Map<number, string>();
    for (const message of bundle.messages) {
      const content = reportedBodySchema.safeParse(safeJson(message.plaintext));
      const media = content.success ? mediaBodySchema.safeParse(content.data.body) : null;
      if (media?.success === true && verifiedSeqs.has(message.seq))
        attested.set(
          message.seq,
          Buffer.from(media.data.attachment.media.plaintextSha256, 'base64').toString('hex'),
        );
    }
    for (const item of bundle.media)
      known.add(sha256(Buffer.from(item.data, 'base64')).toString('hex'));
    for (const digest of attested.values()) known.add(digest);
    const csam =
      known.size > 0 &&
      (await this.#d.db
        .selectFrom('csam_hashes')
        .select('sha256')
        .where(
          'sha256',
          'in',
          [...known].map((hex) => Buffer.from(hex, 'hex')),
        )
        .executeTakeFirst()) !== undefined;
    const csamProven =
      csam &&
      attested.size > 0 &&
      (await this.#d.db
        .selectFrom('csam_hashes')
        .select('sha256')
        .where(
          'sha256',
          'in',
          [...attested.values()].map((hex) => Buffer.from(hex, 'hex')),
        )
        .executeTakeFirst()) !== undefined;
    return { bundle, plaintext, verified, csam, csamProven };
  }

  #snapshotEvidence(content: Record<string, unknown>) {
    const plaintext = Buffer.from(JSON.stringify(content), 'utf8');
    const sealed = Buffer.from(this.#d.secretBox.seal(plaintext, 'moderation-evidence'), 'utf8');
    return {
      kind: 'public_snapshot' as const,
      hpkeEnc: null,
      sealed,
      plaintextSha256: sha256(plaintext),
      mediaCount: 0,
      csamMatch: false,
    };
  }

  async insertEvidence(
    trx: Executor,
    input: {
      caseId: string;
      kind: 'e2ee_bundle' | 'public_snapshot';
      hpkeEnc: Buffer | null;
      sealed: Buffer;
      plaintextSha256: Buffer;
      mediaCount: number;
      csamMatch: boolean;
    },
  ): Promise<string> {
    const id = newId();
    await trx
      .insertInto('moderation_evidence')
      .values({
        id,
        case_id: input.caseId,
        kind: input.kind,
        hpke_enc: input.hpkeEnc,
        sealed: input.sealed,
        sha256: sha256(input.sealed),
        plaintext_sha256: input.plaintextSha256,
        size: input.sealed.length,
        media_count: input.mediaCount,
        csam_match: input.csamMatch,
      })
      .execute();
    return id;
  }

  /** Known abuse media from a proven sender: immediate suspension and legal escalation. */
  async #csamResponse(caseId: string, userId: string): Promise<void> {
    const existing = await this.#activeActions(userId);
    if (!existing.some((a) => a.action === 'suspend' || a.action === 'ban')) {
      const id = newId();
      await this.#d.db
        .insertInto('moderation_actions')
        .values({
          id,
          case_id: caseId,
          subject_user_id: userId,
          target_kind: 'user',
          target_id: userId,
          action: 'suspend',
          restriction: null,
          reason_code: 'csam',
          note: 'Automatic: verified match against known child sexual abuse material.',
          status: 'active',
          ends_at: new Date(Date.now() + 30 * DAY_MS),
          created_by: null,
        })
        .execute();
      await this.#applyEffects(await this.#action(this.#d.db, id), null);
    }
    await this.#d.db
      .updateTable('moderation_cases')
      .set({ legal_hold: true, priority: 1 })
      .where('id', '=', caseId)
      .execute();
    await this.#event(this.#d.db, caseId, null, 'escalated', { reason: 'csam_match' });
    this.#d.logger.warn('moderation.csam_match', { component: 'moderation' });
  }

  /** Several independent reports or blocks within a day: restrict new chats, open a case. */
  async #behaviourSignal(userId: string): Promise<void> {
    const since = new Date(Date.now() - DAY_MS);
    const [reports, blocks] = await Promise.all([
      this.#d.db
        .selectFrom('moderation_reports')
        .innerJoin('moderation_cases', 'moderation_cases.id', 'moderation_reports.case_id')
        .select(sql<string>`count(DISTINCT moderation_reports.reporter_id)`.as('n'))
        .where('moderation_cases.subject_user_id', '=', userId)
        .where('moderation_reports.created_at', '>', since)
        .executeTakeFirstOrThrow(),
      this.#d.db
        .selectFrom('blocks')
        .select(sql<string>`count(*)`.as('n'))
        .where('blocked_id', '=', userId)
        .where('created_at', '>', since)
        .executeTakeFirstOrThrow(),
    ]);
    if (Number(reports.n) < REPORT_SIGNAL && Number(blocks.n) < BLOCK_SIGNAL) return;
    // Already restricted or suspended: a person decides from here.
    if ((await this.#activeActions(userId)).length > 0) return;
    const caseRow = await this.#d.db.transaction().execute((trx) =>
      this.#openCase(trx, {
        subjectKind: 'user',
        subjectId: userId,
        subjectParentId: null,
        subjectUserId: userId,
        category: 'spam',
        source: 'automated',
        legalHold: false,
      }),
    );
    const id = newId();
    await this.#d.db
      .insertInto('moderation_actions')
      .values({
        id,
        case_id: caseRow.id,
        subject_user_id: userId,
        target_kind: 'user',
        target_id: userId,
        action: 'restrict',
        restriction: 'new_chats',
        reason_code: 'spam',
        note: SYSTEM_NOTE,
        status: 'active',
        ends_at: new Date(Date.now() + AUTO_RESTRICTION_HOURS * 3_600_000),
        created_by: null,
      })
      .execute();
    await this.#event(this.#d.db, caseRow.id, null, 'action', { actionId: id, automated: true });
    await this.#applyEffects(await this.#action(this.#d.db, id), null);
  }

  // ---- grievances and legal orders --------------------------------------------------------------

  async grievance(
    userId: string | null,
    input: {
      kind: 'grievance' | 'ncii' | 'synthetic_media';
      contact: string;
      description: string;
      reference: string;
    },
  ): Promise<{ id: string; acknowledgeBy: string; resolveBy: string }> {
    const id = newId();
    const caseRow = await this.#d.db.transaction().execute(async (trx) => {
      const opened = await this.#openCase(trx, {
        subjectKind: 'grievance',
        subjectId: id,
        subjectParentId: null,
        subjectUserId: null,
        category: input.kind,
        source: 'grievance',
        legalHold: false,
      });
      await trx
        .insertInto('moderation_grievances')
        .values({
          id,
          case_id: opened.id,
          user_id: userId,
          contact: input.contact,
          kind: input.kind,
          description: input.description,
          reference: input.reference,
        })
        .execute();
      await this.#event(trx, opened.id, userId, 'grievance', { kind: input.kind });
      return opened;
    });
    await this.#d.mailer
      .send({
        to: input.contact,
        subject: `Tessera grievance received (reference ${id.slice(0, 8)})`,
        text: [
          'We received your complaint and a member of our team will review it.',
          '',
          `Reference: ${id}`,
          `We will acknowledge it by: ${caseRow.ack_due_at.toISOString()} (UTC)`,
          `We aim to resolve it by: ${caseRow.due_at.toISOString()} (UTC)`,
          '',
          'If you are unhappy with the outcome, you can appeal to the Grievance Appellate Committee.',
        ].join('\n'),
      })
      .catch((error: unknown) => {
        this.#d.logger.warn('moderation.grievance_mail_failed', this.#d.logger.errorFields(error));
      });
    return {
      id,
      acknowledgeBy: caseRow.ack_due_at.toISOString(),
      resolveBy: caseRow.due_at.toISOString(),
    };
  }

  async legalOrder(
    staffId: string,
    input: {
      kind: 'court_order' | 'government_order';
      reference: string;
      description: string;
      subject: {
        kind: 'user' | 'channel' | 'post' | 'comment' | 'community';
        id: string;
        channelId?: string | undefined;
      };
    },
    requestId?: string,
  ): Promise<{ caseId: string }> {
    await this.#requireRole(staffId, ['legal']);
    if (['post', 'comment'].includes(input.subject.kind) && input.subject.channelId === undefined)
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Give the channel of the post or comment.',
      });
    const id = newId();
    const caseId = await this.#d.db.transaction().execute(async (trx) => {
      const opened = await this.#openCase(trx, {
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        subjectParentId: input.subject.channelId ?? null,
        subjectUserId: input.subject.kind === 'user' ? input.subject.id : null,
        category: input.kind,
        source: 'legal_order',
        legalHold: true,
      });
      await trx
        .insertInto('moderation_grievances')
        .values({
          id,
          case_id: opened.id,
          user_id: null,
          contact: 'legal',
          kind: input.kind,
          description: input.description,
          reference: input.reference,
        })
        .execute();
      await this.#event(trx, opened.id, staffId, 'legal_order', { reference: input.reference });
      await this.#d.audit.record(
        {
          actorKind: 'admin',
          actorId: staffId,
          action: 'moderation.legal_order',
          targetKind: 'moderation_case',
          targetId: opened.id,
          ...(requestId === undefined ? {} : { requestId }),
        },
        trx,
      );
      return opened.id;
    });
    return { caseId };
  }

  // ---- cases --------------------------------------------------------------------------------------

  /** Attaches to the open case for this subject and category, or opens one (with deadlines). */
  async #openCase(
    trx: Transaction<Database>,
    input: {
      subjectKind: SubjectKind;
      subjectId: string;
      subjectParentId: string | null;
      subjectUserId: string | null;
      category: string;
      source: CaseRow['source'];
      legalHold: boolean;
    },
  ): Promise<CaseRow> {
    const existing = await trx
      .selectFrom('moderation_cases')
      .selectAll()
      .where('subject_kind', '=', input.subjectKind)
      .where('subject_id', '=', input.subjectId)
      .where('category', '=', input.category)
      .where('status', '=', 'open')
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined) {
      return trx
        .updateTable('moderation_cases')
        .set({
          report_count: existing.report_count + (input.source === 'report' ? 1 : 0),
          legal_hold: existing.legal_hold || input.legalHold,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const now = new Date();
    const due = deadlines(input.category, now);
    return trx
      .insertInto('moderation_cases')
      .values({
        id: newId(),
        subject_kind: input.subjectKind,
        subject_id: input.subjectId,
        subject_parent_id: input.subjectParentId,
        subject_user_id: input.subjectUserId,
        category: input.category,
        source: input.source,
        priority: serviceLevel(input.category).priority,
        status: 'open',
        ack_due_at: due.ackDueAt,
        due_at: due.dueAt,
        report_count: input.source === 'report' ? 1 : 0,
        legal_hold: input.legalHold,
        opened_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async #event(
    executor: Executor,
    caseId: string,
    actorId: string | null,
    kind: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await executor
      .insertInto('moderation_case_events')
      .values({
        id: newId(),
        case_id: caseId,
        actor_id: actorId,
        kind,
        payload: JSON.stringify(payload),
      })
      .execute();
  }

  // ---- staff ----------------------------------------------------------------------------------------

  async staffRoles(userId: string): Promise<StaffRole[]> {
    const cached = this.#staffCache.get(userId);
    if (cached !== undefined && Date.now() - cached.at < STAFF_CACHE_MS) return cached.roles;
    const rows = await this.#d.db
      .selectFrom('staff_roles')
      .select('role')
      .where('user_id', '=', userId)
      .where('expires_at', '>', new Date())
      .execute();
    const roles = rows.map((row) => row.role);
    this.#staffCache.set(userId, { at: Date.now(), roles });
    return roles;
  }

  async #requireRole(userId: string, allowed: readonly StaffRole[]): Promise<StaffRole[]> {
    const roles = await this.staffRoles(userId);
    if (!roles.some((role) => allowed.includes(role))) throw new AppError('FORBIDDEN');
    return roles;
  }

  async #subjectLabel(row: CaseRow, names: Map<string, string>): Promise<string> {
    switch (row.subject_kind) {
      case 'user':
        return `@${names.get(row.subject_id) ?? 'deleted'}`;
      case 'conversation':
        return 'A conversation (only reported messages are visible)';
      case 'channel':
        return this.#d.channels.moderationLabel(row.subject_id);
      case 'post':
      case 'comment':
        return `${row.subject_kind === 'post' ? 'Post' : 'Comment'} in ${
          row.subject_parent_id === null
            ? 'a channel'
            : await this.#d.channels.moderationLabel(row.subject_parent_id)
        }`;
      case 'community':
        return this.#d.communities.moderationLabel(row.subject_id);
      case 'grievance':
        return 'Grievance';
    }
  }

  async #summaries(rows: CaseRow[]): Promise<CaseSummary[]> {
    const names = await this.#d.accounts.usernames(
      rows.flatMap((row) => (row.subject_kind === 'user' ? [row.subject_id] : [])),
    );
    const now = Date.now();
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        subjectLabel: await this.#subjectLabel(row, names),
        category: row.category,
        source: row.source,
        priority: row.priority,
        status: row.status,
        reportCount: row.report_count,
        ackDueAt: row.ack_due_at.toISOString(),
        dueAt: row.due_at.toISOString(),
        acknowledgedAt: iso(row.acknowledged_at),
        breached:
          row.breached_at !== null ||
          (row.status === 'open' &&
            (row.due_at.getTime() < now ||
              (row.acknowledged_at === null && row.ack_due_at.getTime() < now))),
        legalHold: row.legal_hold,
        assignedTo: row.assigned_to,
        openedAt: row.opened_at.toISOString(),
      })),
    );
  }

  async queue(
    staffId: string,
    query: { status: 'open' | 'actioned' | 'dismissed'; category?: string | undefined },
  ): Promise<CaseSummary[]> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    let q = this.#d.db
      .selectFrom('moderation_cases')
      .selectAll()
      .where('status', '=', query.status);
    if (query.category !== undefined) q = q.where('category', '=', query.category);
    const rows = await q.orderBy('priority').orderBy('due_at').limit(200).execute();
    return this.#summaries(rows);
  }

  async #case(executor: Executor, caseId: string, lock = false): Promise<CaseRow> {
    let q = executor.selectFrom('moderation_cases').selectAll().where('id', '=', caseId);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  async #action(executor: Executor, actionId: string): Promise<ActionRow> {
    const row = await executor
      .selectFrom('moderation_actions')
      .selectAll()
      .where('id', '=', actionId)
      .executeTakeFirst();
    if (row === undefined) throw new AppError('NOT_FOUND');
    return row;
  }

  #actionView(row: ActionRow, names: Map<string, string>) {
    return {
      id: row.id,
      action: row.action,
      restriction: row.restriction,
      reasonCode: row.reason_code,
      note: row.note,
      status: row.status,
      targetKind: row.target_kind,
      targetId: row.target_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: iso(row.ends_at),
      createdBy: row.created_by === null ? null : `@${names.get(row.created_by) ?? 'staff'}`,
      approvedBy: row.approved_by === null ? null : `@${names.get(row.approved_by) ?? 'staff'}`,
      createdAt: row.created_at.toISOString(),
    };
  }

  async caseDetail(staffId: string, caseId: string): Promise<CaseDetail> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const row = await this.#case(this.#d.db, caseId);
    const [reports, evidence, grievances, actions, events] = await Promise.all([
      this.#d.db
        .selectFrom('moderation_reports')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('created_at')
        .execute(),
      this.#d.db
        .selectFrom('moderation_evidence')
        .select(['id', 'kind', 'size', 'media_count', 'csam_match', 'sha256', 'created_at'])
        .where('case_id', '=', caseId)
        .orderBy('created_at')
        .execute(),
      this.#d.db
        .selectFrom('moderation_grievances')
        .selectAll()
        .where('case_id', '=', caseId)
        .execute(),
      this.#d.db
        .selectFrom('moderation_actions')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('created_at')
        .execute(),
      this.#d.db
        .selectFrom('moderation_case_events')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('created_at')
        .execute(),
    ]);
    const history =
      row.subject_user_id === null
        ? []
        : await this.#d.db
            .selectFrom('moderation_actions')
            .selectAll()
            .where('subject_user_id', '=', row.subject_user_id)
            .where('case_id', '!=', caseId)
            .orderBy('created_at', 'desc')
            .limit(50)
            .execute();
    const people = [
      ...reports.flatMap((r) => (r.reporter_id === null ? [] : [r.reporter_id])),
      ...[...actions, ...history]
        .flatMap((a) => [a.created_by, a.approved_by])
        .filter((v): v is string => v !== null),
      ...events.flatMap((e) => (e.actor_id === null ? [] : [e.actor_id])),
      ...(row.subject_kind === 'user' ? [row.subject_id] : []),
    ];
    const names = await this.#d.accounts.usernames([...new Set(people)]);
    const [summary] = await this.#summaries([row]);
    if (summary === undefined) throw new AppError('NOT_FOUND');
    return {
      ...summary,
      subjectUserId: row.subject_user_id,
      reports: reports.map((r) => ({
        id: r.id,
        reporter: r.reporter_id === null ? null : `@${names.get(r.reporter_id) ?? 'deleted'}`,
        category: r.category,
        details: r.details,
        verification: r.verification,
        evidenceId: r.evidence_id,
        createdAt: r.created_at.toISOString(),
      })),
      evidence: evidence.map((e) => ({
        id: e.id,
        kind: e.kind,
        size: e.size,
        mediaCount: e.media_count,
        csamMatch: e.csam_match,
        sha256: e.sha256.toString('hex'),
        createdAt: e.created_at.toISOString(),
      })),
      grievances: grievances.map((g) => ({
        id: g.id,
        kind: g.kind,
        contact: g.contact,
        description: g.description,
        reference: g.reference,
        createdAt: g.created_at.toISOString(),
      })),
      actions: actions.map((a) => this.#actionView(a, names)),
      history: history.map((a) => this.#actionView(a, names)),
      events: events.map((e) => ({
        kind: e.kind,
        actor: e.actor_id === null ? null : `@${names.get(e.actor_id) ?? 'staff'}`,
        payload: e.payload,
        createdAt: e.created_at.toISOString(),
      })),
    };
  }

  /**
   * Decrypts evidence for a moderator, inside the case only. Every view is recorded on the case
   * and in the audit log; media matching known abuse material is shown to the legal role only.
   */
  async viewEvidence(
    staffId: string,
    caseId: string,
    evidenceId: string,
    requestId?: string,
  ): Promise<EvidenceView> {
    const roles = await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const evidence = await this.#d.db
      .selectFrom('moderation_evidence')
      .selectAll()
      .where('id', '=', evidenceId)
      .where('case_id', '=', caseId)
      .executeTakeFirst();
    if (evidence === undefined) throw new AppError('NOT_FOUND');
    if (evidence.csam_match && !roles.includes('legal'))
      throw new AppError('FORBIDDEN', { detail: 'Only the legal team may view this evidence.' });
    await this.#event(this.#d.db, caseId, staffId, 'evidence_viewed', { evidenceId });
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: 'moderation.evidence_viewed',
      targetKind: 'moderation_evidence',
      targetId: evidenceId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (evidence.kind === 'public_snapshot') {
      const plaintext = this.#d.secretBox.open(
        evidence.sealed.toString('utf8'),
        'moderation-evidence',
      );
      return {
        kind: 'public_snapshot' as const,
        snapshot: JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>,
      };
    }
    const key = this.#d.moderationKey;
    if (key === null || evidence.hpke_enc === null) throw new AppError('SERVICE_UNAVAILABLE');
    const report = await this.#d.db
      .selectFrom('moderation_reports')
      .select(['reporter_id'])
      .where('evidence_id', '=', evidenceId)
      .executeTakeFirst();
    const subject = await this.#case(this.#d.db, caseId);
    const conversationId = await this.#bundleConversation(evidence.id, subject);
    const plaintext = await key.open(
      evidence.hpke_enc,
      evidence.sealed,
      bundleAad(conversationId, report?.reporter_id ?? ''),
    );
    return {
      kind: 'e2ee_bundle' as const,
      bundle: reportBundleSchema.parse(JSON.parse(plaintext.toString('utf8'))),
    };
  }

  /** The conversation a bundle was sealed for (recorded on the report event). */
  async #bundleConversation(evidenceId: string, row: CaseRow): Promise<string> {
    if (row.subject_kind === 'conversation') return row.subject_id;
    const report = await this.#d.db
      .selectFrom('moderation_reports')
      .select('id')
      .where('evidence_id', '=', evidenceId)
      .executeTakeFirst();
    const event = await this.#d.db
      .selectFrom('moderation_case_events')
      .select('payload')
      .where('case_id', '=', row.id)
      .where('kind', '=', 'report')
      .execute();
    const match = event.find((e) => e.payload['reportId'] === report?.id);
    const conversationId = match?.payload['conversationId'];
    if (typeof conversationId !== 'string') throw new AppError('NOT_FOUND');
    return conversationId;
  }

  async acknowledge(staffId: string, caseId: string): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const result = await this.#d.db
      .updateTable('moderation_cases')
      .set({ acknowledged_at: new Date(), assigned_to: staffId })
      .where('id', '=', caseId)
      .where('acknowledged_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      await this.#case(this.#d.db, caseId);
      return;
    }
    await this.#event(this.#d.db, caseId, staffId, 'acknowledged');
  }

  async note(staffId: string, caseId: string, note: string): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    await this.#case(this.#d.db, caseId);
    await this.#event(this.#d.db, caseId, staffId, 'note', { note });
  }

  /** The enforcement ladder (docs/moderation.md §5). Bans and legal referrals wait for review. */
  async takeAction(
    staffId: string,
    caseId: string,
    input: {
      action: ActionRow['action'];
      reasonCode: ReasonCode;
      restriction?: 'new_chats' | 'creation' | undefined;
      durationHours?: number | undefined;
      note: string;
    },
    requestId?: string,
  ): Promise<{ id: string; status: 'active' | 'pending_review' }> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const row = await this.#case(this.#d.db, caseId);
    const target = this.#actionTarget(row, input.action);
    const status =
      input.action === 'ban' || input.action === 'legal_referral' ? 'pending_review' : 'active';
    const id = newId();
    const endsAt =
      input.durationHours !== undefined && ['restrict', 'suspend'].includes(input.action)
        ? new Date(Date.now() + input.durationHours * 3_600_000)
        : null;
    await this.#d.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('moderation_actions')
        .values({
          id,
          case_id: caseId,
          subject_user_id: row.subject_user_id,
          target_kind: target.kind,
          target_id: target.id,
          action: input.action,
          restriction: input.action === 'restrict' ? (input.restriction ?? null) : null,
          reason_code: input.reasonCode,
          note: input.note,
          status,
          ends_at: endsAt,
          created_by: staffId,
        })
        .execute();
      if (status === 'active')
        await trx
          .updateTable('moderation_cases')
          .set({ status: 'actioned', resolved_at: new Date() })
          .where('id', '=', caseId)
          .where('status', '=', 'open')
          .execute();
      await this.#event(trx, caseId, staffId, 'action', {
        actionId: id,
        action: input.action,
        status,
      });
      await this.#d.audit.record(
        {
          actorKind: 'admin',
          actorId: staffId,
          action: `moderation.${input.action}`,
          targetKind: target.kind,
          targetId: target.id,
          details: { case: caseId, reason: input.reasonCode, status },
          ...(requestId === undefined ? {} : { requestId }),
        },
        trx,
      );
    });
    if (status === 'active') {
      await this.#applyEffects(await this.#action(this.#d.db, id), staffId);
      await this.#tellComplainants(row, 'action_taken');
    }
    return { id, status };
  }

  #actionTarget(row: CaseRow, action: ActionRow['action']): { kind: string; id: string } {
    if (['warn', 'restrict', 'suspend', 'ban'].includes(action)) {
      if (row.subject_user_id === null)
        throw new AppError('VALIDATION_FAILED', { detail: 'This case has no person to act on.' });
      return { kind: 'user', id: row.subject_user_id };
    }
    if (action === 'remove_content') {
      if (row.subject_kind !== 'post' && row.subject_kind !== 'comment')
        throw new AppError('VALIDATION_FAILED', {
          detail:
            'Only public posts and comments can be removed (private messages stay on devices).',
        });
      return { kind: row.subject_kind, id: row.subject_id };
    }
    if (action === 'channel_unlist' || action === 'channel_suspend') {
      const channelId = row.subject_kind === 'channel' ? row.subject_id : row.subject_parent_id;
      if (channelId === null || !['channel', 'post', 'comment'].includes(row.subject_kind))
        throw new AppError('VALIDATION_FAILED', { detail: 'This case is not about a channel.' });
      return { kind: 'channel', id: channelId };
    }
    return { kind: row.subject_kind, id: row.subject_id };
  }

  async approve(
    staffId: string,
    actionId: string,
    note: string,
    requestId?: string,
  ): Promise<void> {
    const action = await this.#action(this.#d.db, actionId);
    await this.#requireRole(
      staffId,
      action.action === 'legal_referral' ? ['legal'] : ['senior_moderator', 'legal'],
    );
    if (action.status !== 'pending_review')
      throw new AppError('CONFLICT', { detail: 'This action is not waiting for review.' });
    if (action.created_by === staffId)
      throw new AppError('FORBIDDEN', { detail: 'A second reviewer must approve this.' });
    await this.#d.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('moderation_actions')
        .set({ status: 'active', approved_by: staffId, starts_at: new Date() })
        .where('id', '=', actionId)
        .execute();
      await trx
        .updateTable('moderation_cases')
        .set({ status: 'actioned', resolved_at: new Date() })
        .where('id', '=', action.case_id)
        .where('status', '=', 'open')
        .execute();
      await this.#event(trx, action.case_id, staffId, 'approved', { actionId, note });
      await this.#d.audit.record(
        {
          actorKind: 'admin',
          actorId: staffId,
          action: `moderation.${action.action}_approved`,
          targetKind: action.target_kind,
          targetId: action.target_id,
          details: { case: action.case_id },
          ...(requestId === undefined ? {} : { requestId }),
        },
        trx,
      );
    });
    await this.#applyEffects(await this.#action(this.#d.db, actionId), staffId);
    await this.#tellComplainants(await this.#case(this.#d.db, action.case_id), 'action_taken');
  }

  async reject(staffId: string, actionId: string, note: string): Promise<void> {
    const action = await this.#action(this.#d.db, actionId);
    await this.#requireRole(staffId, ['senior_moderator', 'legal']);
    if (action.status !== 'pending_review')
      throw new AppError('CONFLICT', { detail: 'This action is not waiting for review.' });
    if (action.created_by === staffId)
      throw new AppError('FORBIDDEN', { detail: 'A second reviewer must decide this.' });
    await this.#d.db
      .updateTable('moderation_actions')
      .set({ status: 'rejected', approved_by: staffId })
      .where('id', '=', actionId)
      .execute();
    await this.#event(this.#d.db, action.case_id, staffId, 'rejected', { actionId, note });
  }

  async revert(staffId: string, actionId: string, note: string, requestId?: string): Promise<void> {
    await this.#requireRole(staffId, ['senior_moderator', 'legal']);
    const action = await this.#action(this.#d.db, actionId);
    if (action.status !== 'active')
      throw new AppError('CONFLICT', { detail: 'Only actions in effect can be reverted.' });
    await this.#revertAction(action, staffId, 'reverted', note, requestId);
  }

  async #revertAction(
    action: ActionRow,
    staffId: string,
    kind: 'reverted' | 'appeal_overturned',
    note: string,
    requestId?: string,
  ): Promise<void> {
    await this.#d.db
      .updateTable('moderation_actions')
      .set({ status: 'reverted' })
      .where('id', '=', action.id)
      .execute();
    await this.#event(this.#d.db, action.case_id, staffId, kind, { actionId: action.id, note });
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: `moderation.${action.action}_reverted`,
      targetKind: action.target_kind,
      targetId: action.target_id,
      details: { case: action.case_id, via: kind },
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (action.subject_user_id !== null) this.#standingCache.delete(action.subject_user_id);
    if (
      action.action === 'remove_content' &&
      (action.target_kind === 'post' || action.target_kind === 'comment')
    ) {
      const row = await this.#case(this.#d.db, action.case_id);
      if (row.subject_parent_id !== null)
        await this.#d.channels.moderationSetRemoved(
          action.target_kind,
          row.subject_parent_id,
          action.target_id,
          false,
          null,
        );
    }
    if (action.action === 'channel_unlist' || action.action === 'channel_suspend')
      await this.#d.channels.moderationSetState(action.target_id, 'ok');
    if (action.subject_user_id !== null && action.action !== 'legal_referral')
      await this.#d.notices
        .securityNotice(action.subject_user_id, 'A moderation decision was reversed', [
          'An earlier decision about your account or content is no longer in effect.',
        ])
        .catch(() => undefined);
  }

  async dismiss(
    staffId: string,
    caseId: string,
    input: { reasonCode: string; note: string },
    requestId?: string,
  ): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const row = await this.#case(this.#d.db, caseId);
    if (row.status !== 'open') throw new AppError('CONFLICT', { detail: 'This case is closed.' });
    await this.#d.db
      .updateTable('moderation_cases')
      .set({
        status: 'dismissed',
        resolved_at: new Date(),
        acknowledged_at: row.acknowledged_at ?? new Date(),
      })
      .where('id', '=', caseId)
      .execute();
    await this.#event(this.#d.db, caseId, staffId, 'dismissed', input);
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: 'moderation.case_dismissed',
      targetKind: 'moderation_case',
      targetId: caseId,
      details: { reason: input.reasonCode },
      ...(requestId === undefined ? {} : { requestId }),
    });
    await this.#tellComplainants(row, 'no_violation');
  }

  /** What an action does, and the notice to the person (docs/moderation.md §5). */
  async #applyEffects(action: ActionRow, staffId: string | null): Promise<void> {
    const reason =
      action.reason_code in REASON_TEXT
        ? REASON_TEXT[action.reason_code as ReasonCode]
        : REASON_TEXT.other_policy;
    const until =
      action.ends_at === null ? null : action.ends_at.toISOString().slice(0, 16).replace('T', ' ');
    const userId = action.subject_user_id;
    if (userId !== null) this.#standingCache.delete(userId);
    const appeal = 'You can read the details and appeal in Settings → Account status.';
    switch (action.action) {
      case 'warn':
        if (userId !== null)
          await this.#notify(userId, 'You received a warning', [`Reason: ${reason}`, appeal]);
        return;
      case 'restrict':
        if (userId !== null)
          await this.#notify(userId, 'Some features of your account are limited', [
            action.restriction === 'creation'
              ? 'You cannot start new chats or create groups, channels or invite links.'
              : 'You cannot start new chats.',
            `Reason: ${reason}`,
            ...(until === null ? [] : [`Until (UTC): ${until}`]),
            appeal,
          ]);
        return;
      case 'suspend':
      case 'ban':
        if (userId === null) return;
        // Signed-in sessions end now; signing in again shows only the account status.
        await this.#d.sessions.revokeAll(userId, 'moderation');
        await this.#notify(
          userId,
          action.action === 'ban' ? 'Your account was banned' : 'Your account was suspended',
          [`Reason: ${reason}`, ...(until === null ? [] : [`Until (UTC): ${until}`]), appeal],
        );
        return;
      case 'remove_content': {
        const row = await this.#case(this.#d.db, action.case_id);
        if (
          (action.target_kind === 'post' || action.target_kind === 'comment') &&
          row.subject_parent_id !== null
        )
          await this.#d.channels.moderationSetRemoved(
            action.target_kind,
            row.subject_parent_id,
            action.target_id,
            true,
            staffId,
          );
        if (userId !== null)
          await this.#notify(userId, `Your ${action.target_kind} was removed`, [
            `Reason: ${reason}`,
            appeal,
          ]);
        return;
      }
      case 'channel_unlist':
      case 'channel_suspend':
        await this.#d.channels.moderationSetState(
          action.target_id,
          action.action === 'channel_unlist' ? 'unlisted' : 'suspended',
        );
        if (userId !== null)
          await this.#notify(
            userId,
            action.action === 'channel_unlist'
              ? 'A channel was removed from the directory'
              : 'A channel was suspended',
            [`Reason: ${reason}`, appeal],
          );
        return;
      case 'legal_referral':
        await this.#d.db
          .updateTable('moderation_cases')
          .set({ legal_hold: true })
          .where('id', '=', action.case_id)
          .execute();
        return;
    }
  }

  async #notify(userId: string, headline: string, lines: string[]): Promise<void> {
    await this.#d.notices.securityNotice(userId, headline, lines).catch((error: unknown) => {
      this.#d.logger.warn('moderation.notice_failed', this.#d.logger.errorFields(error));
    });
  }

  /** Grievance complainants hear the outcome (IT Rules); reporters see it in their report list. */
  async #tellComplainants(row: CaseRow, outcome: 'action_taken' | 'no_violation'): Promise<void> {
    if (row.source !== 'grievance') return;
    const grievance = await this.#d.db
      .selectFrom('moderation_grievances')
      .select(['id', 'contact'])
      .where('case_id', '=', row.id)
      .executeTakeFirst();
    if (grievance === undefined) return;
    await this.#d.mailer
      .send({
        to: grievance.contact,
        subject: `Tessera grievance ${grievance.id.slice(0, 8)}: decision`,
        text: [
          outcome === 'action_taken'
            ? 'We reviewed your complaint and took action under our rules.'
            : 'We reviewed your complaint and found no violation of our rules.',
          '',
          `Reference: ${grievance.id}`,
          '',
          'If you are unhappy with the outcome, you can appeal to the Grievance Appellate Committee.',
        ].join('\n'),
      })
      .catch(() => undefined);
  }

  // ---- appeals (staff) -----------------------------------------------------------------------------

  async openAppeals(staffId: string): Promise<AppealSummary[]> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const rows = await this.#d.db
      .selectFrom('moderation_appeals')
      .innerJoin('moderation_actions', 'moderation_actions.id', 'moderation_appeals.action_id')
      .selectAll('moderation_actions')
      .select([
        'moderation_appeals.id as appeal_id',
        'moderation_appeals.statement',
        'moderation_appeals.user_id',
        'moderation_appeals.created_at as appealed_at',
      ])
      .where('moderation_appeals.status', '=', 'open')
      .orderBy('moderation_appeals.created_at')
      .limit(200)
      .execute();
    const names = await this.#d.accounts.usernames([
      ...new Set(
        rows
          .flatMap((r) => [r.user_id, r.created_by, r.approved_by])
          .filter((v): v is string => v !== null),
      ),
    ]);
    return rows.map((r) => ({
      id: r.appeal_id,
      caseId: r.case_id,
      action: this.#actionView(r, names),
      statement: r.statement,
      user: `@${names.get(r.user_id) ?? 'deleted'}`,
      createdAt: r.appealed_at.toISOString(),
    }));
  }

  /** Decided by someone other than whoever took or approved the decision (docs/moderation.md §7). */
  async decideAppeal(
    staffId: string,
    appealId: string,
    outcome: 'upheld' | 'overturned',
    reason: string,
    requestId?: string,
  ): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const appeal = await this.#d.db
      .selectFrom('moderation_appeals')
      .selectAll()
      .where('id', '=', appealId)
      .executeTakeFirst();
    if (appeal === undefined) throw new AppError('NOT_FOUND');
    if (appeal.status !== 'open') throw new AppError('CONFLICT', { detail: 'Already decided.' });
    const action = await this.#action(this.#d.db, appeal.action_id);
    if (action.created_by === staffId || action.approved_by === staffId)
      throw new AppError('FORBIDDEN', {
        detail: 'An appeal must be reviewed by someone who did not take the decision.',
      });
    await this.#d.db
      .updateTable('moderation_appeals')
      .set({
        status: outcome,
        reviewer_id: staffId,
        decision_reason: reason,
        decided_at: new Date(),
      })
      .where('id', '=', appealId)
      .execute();
    await this.#event(this.#d.db, action.case_id, staffId, 'appeal_decided', { appealId, outcome });
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: `moderation.appeal_${outcome}`,
      targetKind: 'moderation_action',
      targetId: action.id,
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (outcome === 'overturned' && action.status === 'active')
      await this.#revertAction(action, staffId, 'appeal_overturned', reason, requestId);
    else
      await this.#notify(appeal.user_id, 'Your appeal was reviewed', [
        'The decision stays in effect.',
        `Reason: ${reason}`,
        'You can also appeal to the Grievance Appellate Committee.',
      ]);
  }

  // ---- transparency (IT Rules monthly compliance report) ---------------------------------------

  async transparency(staffId: string, month: string): Promise<Transparency> {
    await this.#requireRole(staffId, ['senior_moderator', 'legal']);
    const start = new Date(`${month}-01T00:00:00Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const db = this.#d.db;
    const count = async (
      table:
        'moderation_reports' | 'moderation_grievances' | 'moderation_cases' | 'moderation_actions',
      column: string,
      extra = sql<boolean>`true`,
    ): Promise<number> => {
      const result = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.table(table)}
        WHERE ${sql.ref(column)} >= ${start} AND ${sql.ref(column)} < ${end} AND ${extra}`.execute(
        db,
      );
      return Number(result.rows[0]?.n ?? 0);
    };
    const [reports, grievances, legal, opened, resolved, breaches, automated] = await Promise.all([
      count('moderation_reports', 'created_at'),
      count(
        'moderation_grievances',
        'created_at',
        sql<boolean>`kind IN ('grievance', 'ncii', 'synthetic_media')`,
      ),
      count(
        'moderation_grievances',
        'created_at',
        sql<boolean>`kind IN ('court_order', 'government_order')`,
      ),
      count('moderation_cases', 'opened_at'),
      count('moderation_cases', 'resolved_at'),
      count('moderation_cases', 'breached_at'),
      count('moderation_actions', 'created_at', sql<boolean>`created_by IS NULL`),
    ]);
    const byCategory = await db
      .selectFrom('moderation_cases')
      .select(['category', sql<string>`count(*)`.as('n')])
      .where('opened_at', '>=', start)
      .where('opened_at', '<', end)
      .groupBy('category')
      .execute();
    const actions = await db
      .selectFrom('moderation_actions')
      .select(['action', sql<string>`count(*)`.as('n')])
      .where('created_at', '>=', start)
      .where('created_at', '<', end)
      .where('status', 'in', ['active', 'reverted'])
      .groupBy('action')
      .execute();
    const appeals = await db
      .selectFrom('moderation_appeals')
      .select(['status', sql<string>`count(*)`.as('n')])
      .where('created_at', '>=', start)
      .where('created_at', '<', end)
      .groupBy('status')
      .execute();
    const appealCount = (status: string) =>
      Number(appeals.find((a) => a.status === status)?.n ?? 0);
    return {
      month,
      reportsReceived: reports,
      grievancesReceived: grievances,
      legalOrdersReceived: legal,
      casesOpened: opened,
      casesResolved: resolved,
      slaBreaches: breaches,
      byCategory: Object.fromEntries(byCategory.map((r) => [r.category, Number(r.n)])),
      actions: Object.fromEntries(actions.map((r) => [r.action, Number(r.n)])),
      appeals: {
        received: appeals.reduce((sum, a) => sum + Number(a.n), 0),
        upheld: appealCount('upheld'),
        overturned: appealCount('overturned'),
      },
      automated,
    };
  }

  // ---- link blocklist and abuse hashes -----------------------------------------------------------

  async linkPrefixes(): Promise<{ prefixes: string; version: string }> {
    const rows = await this.#d.db.selectFrom('link_blocklist').select('host_hash').execute();
    const prefixes = Buffer.concat(
      [...new Set(rows.map((row) => row.host_hash.subarray(0, 4).toString('hex')))]
        .sort()
        .map((hex) => Buffer.from(hex, 'hex')),
    );
    return {
      prefixes: prefixes.toString('base64'),
      version: sha256(prefixes).toString('hex').slice(0, 16),
    };
  }

  async linkHashes(prefixHex: string): Promise<{ sha256: string; category: string }[]> {
    const rows = await this.#d.db
      .selectFrom('link_blocklist')
      .select(['host_hash', 'category'])
      .where(sql<boolean>`substring(host_hash from 1 for 4) = ${Buffer.from(prefixHex, 'hex')}`)
      .execute();
    return rows.map((row) => ({ sha256: row.host_hash.toString('hex'), category: row.category }));
  }

  /** Blocklisted hosts mentioned in public text (channel posts and comments). */
  async blockedHosts(text: string): Promise<string[]> {
    const hosts = hostsIn(text);
    if (hosts.length === 0) return [];
    const variants = new Map<string, string>();
    for (const host of hosts) for (const variant of hostVariants(host)) variants.set(variant, host);
    if (variants.size === 0) return [];
    const rows = await this.#d.db
      .selectFrom('link_blocklist')
      .select('host')
      .where('host_hash', 'in', [...variants.keys()].map(hostHash))
      .execute();
    return [...new Set(rows.map((row) => variants.get(row.host) ?? row.host))];
  }

  async blocklist(staffId: string): Promise<BlocklistItem[]> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const rows = await this.#d.db
      .selectFrom('link_blocklist')
      .selectAll()
      .orderBy('host')
      .execute();
    return rows.map((row) => ({
      host: row.host,
      category: row.category,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async addBlockedHost(
    staffId: string,
    host: string,
    category: 'phishing' | 'malware' | 'scam' | 'csam',
  ): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    const canonical = host.replace(/^www\./, '').replace(/\.$/, '');
    await this.#d.db
      .insertInto('link_blocklist')
      .values({ host: canonical, host_hash: hostHash(canonical), category, added_by: staffId })
      .onConflict((oc) => oc.column('host').doUpdateSet({ category }))
      .execute();
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: 'moderation.link_blocked',
      targetKind: 'host',
      details: { host: canonical },
    });
  }

  async removeBlockedHost(staffId: string, host: string): Promise<void> {
    await this.#requireRole(staffId, ['moderator', 'senior_moderator', 'legal']);
    await this.#d.db.deleteFrom('link_blocklist').where('host', '=', host).execute();
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: 'moderation.link_unblocked',
      targetKind: 'host',
      details: { host: host },
    });
  }

  async importAbuseHashes(
    staffId: string,
    hashes: readonly string[],
    source: string,
  ): Promise<number> {
    await this.#requireRole(staffId, ['legal']);
    const result = await this.#d.db
      .insertInto('csam_hashes')
      .values(hashes.map((hex) => ({ sha256: Buffer.from(hex, 'hex'), source, added_by: staffId })))
      .onConflict((oc) => oc.column('sha256').doNothing())
      .executeTakeFirst();
    await this.#d.audit.record({
      actorKind: 'admin',
      actorId: staffId,
      action: 'moderation.abuse_hashes_imported',
      details: { count: hashes.length },
    });
    return Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  async abuseHashCount(staffId: string): Promise<number> {
    await this.#requireRole(staffId, ['legal']);
    const row = await this.#d.db
      .selectFrom('csam_hashes')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  // ---- housekeeping ------------------------------------------------------------------------------

  /** SLA breaches (recorded once, with an alert in the logs) and evidence retention. */
  async sweep(now = new Date()): Promise<{ breached: number }> {
    const breached = await this.#d.db
      .updateTable('moderation_cases')
      .set({ breached_at: now })
      .where('status', '=', 'open')
      .where('breached_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('due_at', '<', now),
          eb.and([eb('acknowledged_at', 'is', null), eb('ack_due_at', '<', now)]),
        ]),
      )
      .returning(['id', 'priority'])
      .execute();
    for (const row of breached) {
      await this.#event(this.#d.db, row.id, null, 'sla_breached', { priority: row.priority });
      this.#d.logger.warn('moderation.sla_breached', {
        component: 'moderation',
        count: row.priority,
      });
    }
    const cutoff = new Date(now.getTime() - this.#d.evidenceRetentionDays * DAY_MS);
    await this.#d.db
      .deleteFrom('moderation_evidence')
      .where('case_id', 'in', (eb) =>
        eb
          .selectFrom('moderation_cases')
          .select('id')
          .where('status', '!=', 'open')
          .where('legal_hold', '=', false)
          .where('resolved_at', '<', cutoff),
      )
      .execute();
    return { breached: breached.length };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
