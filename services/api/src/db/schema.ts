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

export interface CommunitiesTable {
  id: string;
  name: string;
  description: Generated<string>;
  visibility: 'public' | 'private';
  rules: Generated<string>;
  rules_version: Generated<number>;
  min_account_age_days: Generated<number>;
  owner_id: string;
  created_at: Timestamp;
  deleted_at: NullableTimestamp;
}

export interface CommunityRolesTable {
  id: string;
  community_id: string;
  name: string;
  position: number;
  permissions: number;
  created_at: Timestamp;
}

export interface CommunityMembersTable {
  community_id: string;
  user_id: string;
  joined_at: Timestamp;
  rules_version: number;
}

export interface CommunityMemberRolesTable {
  community_id: string;
  user_id: string;
  role_id: string;
}

export interface CommunityBansTable {
  community_id: string;
  user_id: string;
  banned_by: string;
  created_at: Timestamp;
}

export interface CommunityLinksTable {
  id: string;
  community_id: string;
  token_digest: Buffer;
  created_by: string;
  created_at: Timestamp;
  expires_at: Date;
  max_uses: number | null;
  uses: Generated<number>;
  revoked_at: NullableTimestamp;
}

export interface CommunitySpacesTable {
  conversation_id: string;
  community_id: string;
  name: string;
  auto_approve: Generated<boolean>;
  created_at: Timestamp;
}

export interface CommunitySpaceRolesTable {
  conversation_id: string;
  role_id: string;
}

export interface ChannelsTable {
  id: string;
  handle: string;
  title: string;
  description: Generated<string>;
  visibility: 'public' | 'private';
  comments_enabled: Generated<boolean>;
  slow_mode_seconds: Generated<number>;
  owner_id: string;
  last_post_at: Date | null;
  created_at: Timestamp;
  deleted_at: NullableTimestamp;
  moderation_state: ColumnType<
    'ok' | 'unlisted' | 'suspended',
    undefined,
    'ok' | 'unlisted' | 'suspended'
  >;
}

export interface ChannelAdminsTable {
  channel_id: string;
  user_id: string;
  permissions: number;
  added_by: string;
  created_at: Timestamp;
}

export interface ChannelOwnershipTransfersTable {
  channel_id: string;
  to_user_id: string;
  requested_by: string;
  effective_at: Date;
}

export interface ChannelSubscribersTable {
  channel_id: string;
  user_id: string;
  created_at: Timestamp;
  notify: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface ChannelSubscriberCountsTable {
  channel_id: string;
  shard: number;
  count: ColumnType<string, number | string, number | string>;
}

export interface ChannelSubscriberDailyTable {
  channel_id: string;
  // Read through to_char(): compared and written as YYYY-MM-DD strings.
  day: ColumnType<string, string, string>;
  shard: number;
  joined: Generated<number>;
  left_count: Generated<number>;
}

export type ChannelPostStatus = 'draft' | 'scheduled' | 'published' | 'removed';

export interface ChannelPostsTable {
  id: string;
  channel_id: string;
  author_id: string;
  status: ChannelPostStatus;
  body: string;
  preview_url: string | null;
  preview: ColumnType<unknown, string | null, string | null>;
  publish_at: Date | null;
  published_at: Date | null;
  edited_at: Date | null;
  removed_at: Date | null;
  removed_by: string | null;
  created_at: Timestamp;
  search: ColumnType<string, never, never>;
}

export interface ChannelPollsTable {
  post_id: string;
  question: string;
  options: ColumnType<string[], string, string>;
  multiple: boolean;
  anonymous: boolean;
}

export interface ChannelPollVotesTable {
  post_id: string;
  user_id: string;
  option: number;
  created_at: Timestamp;
}

export interface ChannelReactionsTable {
  post_id: string;
  user_id: string;
  emoji: string;
  created_at: Timestamp;
}

export interface ChannelReactionCountsTable {
  post_id: string;
  emoji: string;
  count: ColumnType<string, number | string, number | string>;
}

export interface ChannelCommentsTable {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  created_at: Timestamp;
  removed_at: Date | null;
  removed_by: string | null;
}

export interface ChannelPostViewsTable {
  post_id: string;
  // Read through to_char(): compared and written as YYYY-MM-DD strings.
  day: ColumnType<string, string, string>;
  views: ColumnType<string, number | string, number | string>;
}

export interface ChannelLinksTable {
  id: string;
  channel_id: string;
  token_digest: Buffer;
  created_by: string;
  created_at: Timestamp;
  expires_at: Date;
  max_uses: number | null;
  uses: Generated<number>;
  revoked_at: NullableTimestamp;
}

export interface CallsTable {
  id: string;
  conversation_id: string;
  mode: 'p2p' | 'sfu';
  media: 'audio' | 'video';
  initiator_user_id: string;
  initiator_device_id: string;
  started_at: Timestamp;
  answered_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  end_reason: 'hangup' | 'declined' | 'busy' | 'missed' | 'failed' | 'removed' | null;
  peak_participants: Generated<number>;
}

export interface CallParticipantsTable {
  call_id: string;
  device_id: string;
  user_id: string;
  joined_at: Timestamp;
  last_seen_at: Timestamp;
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
  commitment: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  franking_tag: ColumnType<string | null, string | null | undefined, string | null>;
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

export interface PushSubscriptionsTable {
  id: string;
  user_id: string;
  session_id: string;
  device_id: string;
  endpoint: string;
  p256dh: Buffer;
  auth: Buffer;
  created_at: Timestamp;
  last_success_at: NullableTimestamp;
  failures: ColumnType<number, number | undefined, number>;
}

export interface NotificationPreferencesTable {
  user_id: string;
  messages: boolean;
  calls: boolean;
  channel_posts: boolean;
  quiet_start: number | null;
  quiet_end: number | null;
  quiet_time_zone: string | null;
  quiet_allow_calls: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: Timestamp;
}

export interface ConversationMutesTable {
  user_id: string;
  conversation_id: string;
  muted_until: Date | null;
}

export interface SecurityAlertsTable {
  id: string;
  user_id: string;
  headline: string;
  details: ColumnType<string[], string, string>;
  created_at: Timestamp;
  read_at: NullableTimestamp;
}

export interface BlocksTable {
  blocker_id: string;
  blocked_id: string;
  created_at: Timestamp;
}

export interface StaffRolesTable {
  user_id: string;
  role: 'moderator' | 'senior_moderator' | 'legal';
  granted_by: string;
  granted_at: Timestamp;
  expires_at: Date;
}

export interface ModerationCasesTable {
  id: string;
  subject_kind:
    'user' | 'conversation' | 'channel' | 'post' | 'comment' | 'community' | 'grievance';
  subject_id: string;
  subject_parent_id: string | null;
  subject_user_id: string | null;
  category: string;
  source: 'report' | 'grievance' | 'legal_order' | 'automated';
  priority: number;
  status: 'open' | 'actioned' | 'dismissed';
  ack_due_at: Date;
  due_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  assigned_to: string | null;
  report_count: ColumnType<number, number | undefined, number>;
  breached_at: Date | null;
  legal_hold: ColumnType<boolean, boolean | undefined, boolean>;
  opened_at: Timestamp;
}

export interface ModerationCaseEventsTable {
  id: string;
  case_id: string;
  actor_id: string | null;
  kind: string;
  payload: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
}

export interface ModerationEvidenceTable {
  id: string;
  case_id: string;
  kind: 'e2ee_bundle' | 'public_snapshot';
  hpke_enc: Buffer | null;
  sealed: Buffer;
  sha256: Buffer;
  plaintext_sha256: Buffer | null;
  size: number;
  media_count: ColumnType<number, number | undefined, number>;
  csam_match: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: Timestamp;
}

export interface ModerationReportsTable {
  id: string;
  case_id: string;
  reporter_id: string | null;
  target_kind: string;
  target_id: string;
  category: string;
  details: ColumnType<string, string | undefined, string>;
  evidence_id: string | null;
  verification: 'content_verified' | 'unverified' | 'server_content' | 'none';
  created_at: Timestamp;
}

export interface ModerationActionsTable {
  id: string;
  case_id: string;
  subject_user_id: string | null;
  target_kind: string;
  target_id: string;
  action:
    | 'warn'
    | 'restrict'
    | 'suspend'
    | 'ban'
    | 'remove_content'
    | 'channel_unlist'
    | 'channel_suspend'
    | 'legal_referral';
  restriction: 'new_chats' | 'creation' | null;
  reason_code: string;
  note: ColumnType<string, string | undefined, string>;
  status: 'pending_review' | 'active' | 'reverted' | 'rejected';
  starts_at: Timestamp;
  ends_at: Date | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: Timestamp;
}

export interface ModerationAppealsTable {
  id: string;
  action_id: string;
  user_id: string;
  statement: string;
  status: 'open' | 'upheld' | 'overturned';
  reviewer_id: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  created_at: Timestamp;
}

export interface ModerationGrievancesTable {
  id: string;
  case_id: string;
  user_id: string | null;
  contact: string;
  kind: 'grievance' | 'ncii' | 'synthetic_media' | 'court_order' | 'government_order';
  description: string;
  reference: ColumnType<string, string | undefined, string>;
  created_at: Timestamp;
}

export interface LinkBlocklistTable {
  host: string;
  host_hash: Buffer;
  category: 'phishing' | 'malware' | 'scam' | 'csam';
  added_by: string | null;
  created_at: Timestamp;
}

export interface CsamHashesTable {
  sha256: Buffer;
  source: string;
  added_by: string | null;
  added_at: Timestamp;
}

export type AdminRole =
  'super_admin' | 'security_admin' | 'moderator' | 'support_agent' | 'analyst';

export interface AdminUsersTable {
  id: string;
  email: string;
  display_name: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  status: 'active' | 'disabled';
  eligible_roles: ColumnType<AdminRole[], AdminRole[] | undefined, AdminRole[]>;
  created_by: string;
  created_at: Timestamp;
  disabled_at: NullableTimestamp;
}

export interface AdminCredentialsTable {
  id: string;
  admin_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: ColumnType<string, number | undefined, number>;
  transports: ColumnType<string[], string[] | undefined, string[]>;
  aaguid: string;
  name: string;
  created_at: Timestamp;
  last_used_at: NullableTimestamp;
}

export interface AdminSessionsTable {
  id: string;
  admin_id: string;
  token_digest: Buffer;
  stage: 'key' | 'active';
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Date;
  reauthenticated_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  ip_prefix: string;
  user_agent_summary: string;
}

export interface AdminRoleGrantsTable {
  id: string;
  admin_id: string;
  role: AdminRole;
  starts_at: Timestamp;
  expires_at: Date;
  approval_id: string | null;
  granted_by: string;
  revoked_at: NullableTimestamp;
}

export interface AdminApprovalsTable {
  id: string;
  kind: 'role_grant' | 'eligibility' | 'admin_create' | 'feature_flag' | 'staff_role';
  payload: ColumnType<Record<string, unknown>, string, string>;
  reason: string;
  requested_by: string;
  requested_at: Timestamp;
  expires_at: Date;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by: string | null;
  decided_at: NullableTimestamp;
  decision_note: ColumnType<string, string | undefined, string>;
}

export interface SupportTicketsTable {
  id: string;
  reference: string;
  subject_user_id: string;
  reason: string;
  status: 'open' | 'closed';
  created_by: string;
  created_at: Timestamp;
  closed_at: NullableTimestamp;
}

export interface FeatureFlagsTable {
  key: string;
  description: string;
  kind: 'product' | 'security';
  enabled: boolean;
  rollout_percent: number;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface BillingPlansTable {
  code: string;
  tier: 'premium' | 'creator' | 'business';
  name: string;
  interval: 'month' | 'year';
  price_inr_minor: number;
  price_usd_minor: number;
  active: boolean;
  sort_order: number;
}

export interface BillingProfilesTable {
  user_id: string;
  legal_name: string;
  country: string;
  state: string | null;
  gstin: string | null;
  updated_at: Generated<Date>;
}

export interface BillingSubscriptionsTable {
  id: string;
  user_id: string;
  plan_code: string;
  provider: 'razorpay' | 'stripe';
  provider_ref: string | null;
  checkout_ref: string;
  status: 'incomplete' | 'active' | 'past_due' | 'canceled';
  provider_status: string;
  cancel_at_period_end: Generated<boolean>;
  current_period_start: Date | null;
  current_period_end: Date | null;
  past_due_since: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  ended_at: Date | null;
}

export interface BillingEventsTable {
  provider: 'razorpay' | 'stripe';
  event_id: string;
  type: string;
  subscription_id: string | null;
  received_at: Generated<Date>;
}

export interface BillingInvoiceCountersTable {
  financial_year: string;
  last_number: number;
}

export interface BillingInvoicesTable {
  id: string;
  number: string;
  user_id: string | null;
  subscription_id: string | null;
  provider: 'razorpay' | 'stripe';
  payment_ref: string;
  issued_at: Generated<Date>;
  plan_code: string;
  plan_name: string;
  period_start: Date | null;
  period_end: Date | null;
  currency: 'INR' | 'USD';
  total_minor: number;
  taxable_minor: number;
  cgst_minor: Generated<number>;
  sgst_minor: Generated<number>;
  igst_minor: Generated<number>;
  tax_note: string;
  sac_code: string;
  refunded_minor: Generated<number>;
  buyer_name: string;
  buyer_country: string;
  buyer_state: string | null;
  buyer_gstin: string | null;
  seller_name: string;
  seller_address: string;
  seller_gstin: string | null;
  seller_state: string;
}

export interface AccountTiersTable {
  user_id: string;
  tier: 'premium' | 'creator' | 'business';
  valid_until: Date;
  subscription_id: string;
  updated_at: Generated<Date>;
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
  communities: CommunitiesTable;
  community_roles: CommunityRolesTable;
  community_members: CommunityMembersTable;
  community_member_roles: CommunityMemberRolesTable;
  community_bans: CommunityBansTable;
  community_links: CommunityLinksTable;
  community_spaces: CommunitySpacesTable;
  community_space_roles: CommunitySpaceRolesTable;
  channels: ChannelsTable;
  channel_admins: ChannelAdminsTable;
  channel_ownership_transfers: ChannelOwnershipTransfersTable;
  channel_subscribers: ChannelSubscribersTable;
  channel_subscriber_counts: ChannelSubscriberCountsTable;
  channel_subscriber_daily: ChannelSubscriberDailyTable;
  channel_posts: ChannelPostsTable;
  channel_polls: ChannelPollsTable;
  channel_poll_votes: ChannelPollVotesTable;
  channel_reactions: ChannelReactionsTable;
  channel_reaction_counts: ChannelReactionCountsTable;
  channel_comments: ChannelCommentsTable;
  channel_post_views: ChannelPostViewsTable;
  channel_links: ChannelLinksTable;
  calls: CallsTable;
  call_participants: CallParticipantsTable;
  push_subscriptions: PushSubscriptionsTable;
  notification_preferences: NotificationPreferencesTable;
  conversation_mutes: ConversationMutesTable;
  security_alerts: SecurityAlertsTable;
  blocks: BlocksTable;
  staff_roles: StaffRolesTable;
  moderation_cases: ModerationCasesTable;
  moderation_case_events: ModerationCaseEventsTable;
  moderation_evidence: ModerationEvidenceTable;
  moderation_reports: ModerationReportsTable;
  moderation_actions: ModerationActionsTable;
  moderation_appeals: ModerationAppealsTable;
  moderation_grievances: ModerationGrievancesTable;
  link_blocklist: LinkBlocklistTable;
  csam_hashes: CsamHashesTable;
  admin_users: AdminUsersTable;
  admin_credentials: AdminCredentialsTable;
  admin_sessions: AdminSessionsTable;
  admin_role_grants: AdminRoleGrantsTable;
  admin_approvals: AdminApprovalsTable;
  support_tickets: SupportTicketsTable;
  feature_flags: FeatureFlagsTable;
  billing_plans: BillingPlansTable;
  billing_profiles: BillingProfilesTable;
  billing_subscriptions: BillingSubscriptionsTable;
  billing_events: BillingEventsTable;
  billing_invoice_counters: BillingInvoiceCountersTable;
  billing_invoices: BillingInvoicesTable;
  account_tiers: AccountTiersTable;
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
  communities: 'communities',
  community_roles: 'communities',
  community_members: 'communities',
  community_member_roles: 'communities',
  community_bans: 'communities',
  community_links: 'communities',
  community_spaces: 'communities',
  community_space_roles: 'communities',
  channels: 'channels',
  channel_admins: 'channels',
  channel_ownership_transfers: 'channels',
  channel_subscribers: 'channels',
  channel_subscriber_counts: 'channels',
  channel_subscriber_daily: 'channels',
  channel_posts: 'channels',
  channel_polls: 'channels',
  channel_poll_votes: 'channels',
  channel_reactions: 'channels',
  channel_reaction_counts: 'channels',
  channel_comments: 'channels',
  channel_post_views: 'channels',
  channel_links: 'channels',
  calls: 'calls',
  call_participants: 'calls',
  push_subscriptions: 'notifications',
  notification_preferences: 'notifications',
  conversation_mutes: 'notifications',
  security_alerts: 'notifications',
  blocks: 'moderation',
  staff_roles: 'moderation',
  moderation_cases: 'moderation',
  moderation_case_events: 'moderation',
  moderation_evidence: 'moderation',
  moderation_reports: 'moderation',
  moderation_actions: 'moderation',
  moderation_appeals: 'moderation',
  moderation_grievances: 'moderation',
  link_blocklist: 'moderation',
  csam_hashes: 'moderation',
  admin_users: 'admin',
  admin_credentials: 'admin',
  admin_sessions: 'admin',
  admin_role_grants: 'admin',
  admin_approvals: 'admin',
  support_tickets: 'admin',
  feature_flags: 'flags',
  billing_plans: 'billing',
  billing_profiles: 'billing',
  billing_subscriptions: 'billing',
  billing_events: 'billing',
  billing_invoice_counters: 'billing',
  billing_invoices: 'billing',
  account_tiers: 'entitlements',
};
