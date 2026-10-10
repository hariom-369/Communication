/** Display helpers. */

const ROLE_NAMES: Record<string, string> = {
  super_admin: 'Super admin',
  security_admin: 'Security admin',
  moderator: 'Moderator',
  support_agent: 'Support agent',
  analyst: 'Analyst',
  senior_moderator: 'Senior moderator',
  legal: 'Legal',
};

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "in 3 h 20 min" / "expired". */
export function until(iso: string, now = Date.now()): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return 'expired';
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${String(hours)} h ${String(minutes % 60)} min`;
  return `in ${String(Math.round(hours / 24))} days`;
}

export type PurposeKind = 'ticket' | 'case' | 'investigation';

/** The purpose string the API expects (`ticket:<id>`, `case:<id>`, `investigation:<reason>`). */
export function purposeText(kind: PurposeKind, value: string): string {
  return `${kind}:${value.trim()}`;
}
