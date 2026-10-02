import type { ColumnType, Generated } from 'kysely';

/**
 * Typed view of the database schema defined by migrations/. Each table belongs to exactly one
 * module (TABLE_OWNERS); `src/architecture.test.ts` fails if a module queries another module's
 * tables — cross-module access goes through module interfaces (ADR-001).
 */

type Timestamp = ColumnType<Date, Date | undefined, Date>;
type NullableTimestamp = ColumnType<Date | null, Date | null | undefined, Date | null>;

export interface SchemaMigrationsTable {
  version: string;
  checksum: string;
  applied_at: Timestamp;
}

export interface UsersTable {
  id: string;
  username: string;
  status: 'pending_verification' | 'pending_credential' | 'active';
  accepted_terms_version: string;
  confirmed_adult_at: Date;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserEmailsTable {
  user_id: string;
  email: string;
  verified_at: NullableTimestamp;
}

export interface EmailVerificationsTable {
  id: string;
  user_id: string;
  code_digest: Buffer;
  attempts: ColumnType<number, number | undefined, number>;
  expires_at: Date;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface PrivacySettingsTable {
  user_id: string;
  settings: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
}

export interface PasswordCredentialsTable {
  user_id: string;
  hash: string;
  pepper_id: string;
  updated_at: Timestamp;
}

export interface PasskeysTable {
  id: string;
  user_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: ColumnType<string, number, number>;
  transports: string[];
  backup_eligible: boolean;
  backup_state: boolean;
  name: string;
  created_at: Timestamp;
  last_used_at: NullableTimestamp;
}

export interface TotpCredentialsTable {
  user_id: string;
  secret_encrypted: string;
  confirmed_at: NullableTimestamp;
  last_used_step: ColumnType<string | null, number | null | undefined, number | null>;
  created_at: Timestamp;
}

export interface RecoveryCodesTable {
  id: string;
  user_id: string;
  code_digest: Buffer;
  used_at: NullableTimestamp;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_digest: Buffer;
  stage: 'credential_setup' | 'mfa_pending' | 'active';
  created_at: Timestamp;
  last_seen_at: Timestamp;
  idle_expires_at: Date;
  expires_at: Date;
  reauthenticated_at: NullableTimestamp;
  user_agent_summary: string;
  ip_prefix: string;
  revoked_at: NullableTimestamp;
  revoke_reason: string | null;
}

export interface PasswordResetsTable {
  id: string;
  user_id: string;
  token_digest: Buffer;
  expires_at: Date;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface LoginEventsTable {
  id: string;
  user_id: string | null;
  kind: 'success' | 'failure' | 'mfa_failure';
  method: 'password' | 'passkey' | 'mfa' | 'recovery_code';
  ip_prefix: string;
  user_agent_summary: string;
  created_at: Timestamp;
}

export interface AuditLogTable {
  seq: Generated<string>;
  id: string;
  at: Date;
  actor_kind: 'user' | 'system' | 'admin';
  actor_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  request_id: string | null;
  details: ColumnType<unknown, string, never>;
  prev_hash: Buffer;
  hash: Buffer;
}

export interface ConversationsTable {
  id: string;
  kind: 'direct' | 'group';
  ciphersuite: number;
  epoch: ColumnType<string, number | undefined, number>;
  last_seq: ColumnType<string, number | undefined, number>;
  last_activity_at: Timestamp;
  disappearing_seconds: ColumnType<number, number | undefined, number>;
  created_by: string;
  created_at: Timestamp;
  members_can_add: ColumnType<boolean, boolean | undefined, boolean>;
  announcements_only: ColumnType<boolean, boolean | undefined, boolean>;
  deleted_at: NullableTimestamp;
}

export interface ConversationMembersTable {
  conversation_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  acked_seq: ColumnType<string, number | undefined, number>;
  joined_at: Timestamp;
  left_at: NullableTimestamp;
  added_by: string | null;
}

export interface MlsWelcomePayloadsTable {
  id: string;
  conversation_id: string;
  welcome: Buffer;
  expires_at: Date;
}

export interface GroupInvitationsTable {
  conversation_id: string;
  user_id: string;
  invited_by: string;
  created_at: Timestamp;
  expires_at: Date;
}

export interface GroupLinksTable {
  id: string;
  conversation_id: string;
  token_digest: Buffer;
  created_by: string;
  created_at: Timestamp;
  expires_at: Date;
  max_uses: number | null;
  uses: ColumnType<number, number | undefined, number>;
  preview_title: string | null;
  revoked_at: NullableTimestamp;
}

export interface GroupJoinRequestsTable {
  conversation_id: string;
  user_id: string;
  link_id: string | null;
  created_at: Timestamp;
}

export interface GroupBansTable {
  conversation_id: string;
  user_id: string;
  banned_by: string;
  created_at: Timestamp;
}

export interface DirectPairsTable {
  user_low: string;
  user_high: string;
  conversation_id: string;
}

export interface MailboxMessagesTable {
  conversation_id: string;
  seq: ColumnType<string, number, number>;
  /** 1 = application (MLS PrivateMessage), 2 = commit (MLS PublicMessage). */
  kind: 1 | 2;
  client_message_id: string;
  sender_user_id: string;
  sender_device_id: string | null;
  epoch: ColumnType<string, number, number>;
  ciphertext: Buffer;
  created_at: Timestamp;
  expires_at: Date;
}

export interface AccountKeysTable {
  user_id: string;
  public_key: Buffer;
  version: number;
  updated_at: Timestamp;
}

export interface DevicesTable {
  id: string;
  user_id: string;
  ask_version: number;
  signature_key: Buffer;
  certificate: Buffer;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: NullableTimestamp;
  label: ColumnType<string, string | undefined, string>;
  trusted: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface LinkSessionsTable {
  id: string;
  user_id: string;
  session_id: string;
  short_id: Buffer;
  device_id: string;
  hpke_public: Buffer;
  signature_public: Buffer;
  label: string;
  sealed: Buffer | null;
  approved_by: string | null;
  created_at: Timestamp;
  expires_at: Date;
}

export interface BackupsTable {
  user_id: string;
  version: ColumnType<string, number, number>;
  blob: Buffer;
  manifest: string;
  mac: Buffer;
  created_at: Timestamp;
}

export interface MediaBlobsTable {
  id: string;
  owner_id: string;
  object_key: string;
  upload_id: string | null;
  size: ColumnType<string, number, number>;
  part_size: number;
  status: 'uploading' | 'ready';
  created_at: Timestamp;
  completed_at: Date | null;
  expires_at: Date;
}

export interface MediaLinksTable {
  blob_id: string;
  conversation_id: string;
  created_at: Timestamp;
  expires_at: Date;
}

export interface BackupWrapsTable {
  id: string;
  user_id: string;
  kind: 'recovery' | 'passkey';
  wrap: Buffer;
  credential_id: string | null;
  prf_salt: Buffer | null;
  created_at: Timestamp;
}

export interface KeyPackagesTable {
  id: string;
  device_id: string;
  key_package: Buffer;
  last_resort: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
  expires_at: Date;
}

export interface MlsWelcomesTable {
  id: string;
  conversation_id: string;
  target_user_id: string;
  target_device_id: string;
  commit_seq: ColumnType<string, number, number>;
  welcome: Buffer | null;
  payload_id: string | null;
  created_at: Timestamp;
  expires_at: Date;
}

export interface Database {
  schema_migrations: SchemaMigrationsTable;
  users: UsersTable;
  user_emails: UserEmailsTable;
  email_verifications: EmailVerificationsTable;
  privacy_settings: PrivacySettingsTable;
  password_credentials: PasswordCredentialsTable;
  passkeys: PasskeysTable;
  totp_credentials: TotpCredentialsTable;
  recovery_codes: RecoveryCodesTable;
  sessions: SessionsTable;
  password_resets: PasswordResetsTable;
  login_events: LoginEventsTable;
  audit_log: AuditLogTable;
  conversations: ConversationsTable;
  conversation_members: ConversationMembersTable;
  direct_pairs: DirectPairsTable;
  mailbox_messages: MailboxMessagesTable;
  mls_welcomes: MlsWelcomesTable;
  account_keys: AccountKeysTable;
  devices: DevicesTable;
  key_packages: KeyPackagesTable;
  link_sessions: LinkSessionsTable;
  backups: BackupsTable;
  backup_wraps: BackupWrapsTable;
  media_blobs: MediaBlobsTable;
  media_links: MediaLinksTable;
  mls_welcome_payloads: MlsWelcomePayloadsTable;
  group_invitations: GroupInvitationsTable;
  group_links: GroupLinksTable;
  group_join_requests: GroupJoinRequestsTable;
  group_bans: GroupBansTable;
}

/** Owning module of every table ('platform' = infrastructure code outside modules/). */
export const TABLE_OWNERS: Readonly<Record<keyof Database, string>> = {
  schema_migrations: 'platform',
  users: 'accounts',
  user_emails: 'accounts',
  email_verifications: 'accounts',
  privacy_settings: 'accounts',
  password_credentials: 'auth',
  passkeys: 'auth',
  totp_credentials: 'auth',
  recovery_codes: 'auth',
  sessions: 'auth',
  password_resets: 'auth',
  login_events: 'auth',
  audit_log: 'audit',
  conversations: 'messaging',
  conversation_members: 'messaging',
  direct_pairs: 'messaging',
  mailbox_messages: 'messaging',
  mls_welcomes: 'messaging',
  account_keys: 'keys',
  devices: 'keys',
  key_packages: 'keys',
  link_sessions: 'keys',
  backups: 'backups',
  backup_wraps: 'backups',
  media_blobs: 'media',
  media_links: 'media',
  mls_welcome_payloads: 'messaging',
  group_invitations: 'messaging',
  group_links: 'messaging',
  group_join_requests: 'messaging',
  group_bans: 'messaging',
};
