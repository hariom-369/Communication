import type { AdminRole } from '@tessera/validation';

/**
 * Role-based access for the admin console (docs/admin.md §2). Each route names one capability;
 * a person has the union of their current (time-bound, unrevoked) roles' capabilities. What is
 * not listed is denied. Sensitive changes additionally go through four-eyes approval (approvals.ts)
 * and data views through purpose binding (service.ts).
 */

export const CAPABILITIES = {
  /** Aggregates only. */
  dashboard: ['super_admin', 'security_admin', 'moderator', 'support_agent', 'analyst'],
  /** A person's account metadata — always with a purpose (ticket, case or investigation). */
  usersView: ['super_admin', 'security_admin', 'moderator', 'support_agent'],
  /** Sign a person out (on their request, through a ticket, or for security). */
  usersRevokeSessions: ['super_admin', 'security_admin', 'support_agent'],
  usersResendVerification: ['super_admin', 'support_agent'],
  tickets: ['super_admin', 'support_agent'],
  securityEvents: ['super_admin', 'security_admin'],
  health: ['super_admin', 'security_admin', 'analyst'],
  analytics: ['super_admin', 'analyst'],
  flagsView: ['super_admin', 'security_admin'],
  /** Request a change; who may *approve* is decided per request kind (approvals.ts). */
  approvalsRequest: ['super_admin', 'security_admin', 'moderator', 'support_agent', 'analyst'],
  /** The audit viewer: everything (below) or one's own actions. */
  auditView: ['super_admin', 'security_admin', 'moderator', 'support_agent', 'analyst'],
  auditViewAll: ['super_admin', 'security_admin'],
  adminsView: ['super_admin', 'security_admin'],
  /** Disabling someone takes effect at once (the safe direction needs no second person). */
  adminsDisable: ['super_admin', 'security_admin'],
  staffView: ['super_admin', 'security_admin'],
  staffRevoke: ['super_admin', 'security_admin'],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function capabilitiesOf(roles: readonly AdminRole[]): Set<Capability> {
  const result = new Set<Capability>();
  for (const [capability, holders] of Object.entries(CAPABILITIES) as [
    Capability,
    readonly AdminRole[],
  ][])
    if (holders.some((role) => roles.includes(role))) result.add(capability);
  return result;
}

export const ELEVATED: readonly AdminRole[] = ['super_admin', 'security_admin'];
