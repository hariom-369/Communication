import { CHANNEL_PERMISSIONS, type ChannelPermission } from '@tessera/validation';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** "12.4K subscribers" (docs/channels.md §5: counts are shown rounded). */
export function subscriberLabel(count: number): string {
  return `${compact.format(count)} ${count === 1 ? 'subscriber' : 'subscribers'}`;
}

export const CHANNEL_PERMISSION_LABELS: Readonly<Record<ChannelPermission, string>> = {
  post: 'Post',
  editAny: 'Edit anyone’s posts',
  deleteAny: 'Delete anyone’s posts',
  manageComments: 'Moderate comments',
  viewAnalytics: 'See analytics',
  manageAdmins: 'Manage admins',
  editChannelInfo: 'Edit channel info and invite links',
};

export const CHANNEL_PERMISSION_KEYS = Object.keys(
  CHANNEL_PERMISSION_LABELS,
) as ChannelPermission[];

export function canChannel(permissions: number, permission: ChannelPermission): boolean {
  return (permissions & CHANNEL_PERMISSIONS[permission]) !== 0;
}

/** Shown wherever channel content is read or written (ADR-012). */
export const NOT_E2EE_NOTICE =
  'Channels are not end-to-end encrypted. Posts are visible to Tessera and to anyone who can view this channel.';
