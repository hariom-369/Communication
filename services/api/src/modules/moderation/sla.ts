/**
 * Service levels for cases (docs/moderation.md §6). The legal deadlines follow the IT Rules as
 * amended in 2026 and must be confirmed by counsel (L-05): 3 h for court and government orders,
 * 2 h for non-consensual intimate imagery and synthetic (deepfake) media, acknowledgement of
 * grievances within 24 h and resolution within 7 days.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ServiceLevel {
  /** 1 = most urgent. */
  readonly priority: 1 | 2 | 3 | 4;
  readonly ackMs: number;
  readonly dueMs: number;
}

export function serviceLevel(category: string): ServiceLevel {
  switch (category) {
    case 'court_order':
    case 'government_order':
      return { priority: 1, ackMs: 3 * HOUR, dueMs: 3 * HOUR };
    case 'ncii':
    case 'synthetic_media':
      return { priority: 1, ackMs: 2 * HOUR, dueMs: 2 * HOUR };
    case 'csam':
      return { priority: 1, ackMs: HOUR, dueMs: DAY };
    case 'terrorism':
    case 'violence_threat':
    case 'self_harm':
      return { priority: 2, ackMs: 4 * HOUR, dueMs: DAY };
    case 'spam':
      return { priority: 4, ackMs: DAY, dueMs: 7 * DAY };
    default:
      // Harassment, hate, scams, impersonation, sexual content, other reports and grievances.
      return { priority: 3, ackMs: DAY, dueMs: 7 * DAY };
  }
}

export function deadlines(category: string, from: Date): { ackDueAt: Date; dueAt: Date } {
  const level = serviceLevel(category);
  return {
    ackDueAt: new Date(from.getTime() + level.ackMs),
    dueAt: new Date(from.getTime() + level.dueMs),
  };
}
