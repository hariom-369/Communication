import { COMMUNITY_PERMISSIONS, type CommunityPermission } from '@tessera/validation';

export const PERMISSION_LABELS: Readonly<Record<CommunityPermission, string>> = {
  manageCommunity: 'Edit the community, rules and gate',
  manageRoles: 'Manage roles below their own',
  manageSpaces: 'Create and delete spaces',
  kickMembers: 'Remove members',
  banMembers: 'Ban people',
  createInvites: 'Create invite links',
};

export function can(permissions: number, permission: CommunityPermission): boolean {
  return (permissions & COMMUNITY_PERMISSIONS[permission]) !== 0;
}

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as CommunityPermission[];
