import type { StaffRole } from '@tessera/validation';
import { useEffect, useState } from 'react';

import { moderationEndpoints } from '../api/moderation-endpoints.js';

/** This user's moderation roles (empty for everyone else; the server enforces every action). */
export function useStaffRoles(): StaffRole[] | null {
  const [roles, setRoles] = useState<StaffRole[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    moderationEndpoints.staffMe().then(
      (value) => {
        if (!cancelled) setRoles(value.roles);
      },
      () => {
        if (!cancelled) setRoles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return roles;
}

/** "due in 2 h 5 min" / "overdue by 40 min" (SLA countdowns in the queue). */
export function dueLabel(dueAt: string, now: number): string {
  const ms = Date.parse(dueAt) - now;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const text =
    minutes < 60
      ? `${minutes} min`
      : minutes < 48 * 60
        ? `${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? '' : ` ${minutes % 60} min`}`
        : `${Math.round(minutes / (24 * 60))} days`;
  return ms >= 0 ? `due in ${text}` : `overdue by ${text}`;
}
