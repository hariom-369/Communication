import type { HistoryRecord } from '../crypto/protocol.js';

import { contentSchema } from './content.js';

/** How long a membership intent lets devices add someone (matches invitation expiry). */
export const INTENT_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Users the group's members have confirmed, end to end, should be in the group
 * (docs/groups.md §4). The server lists members, but a device adds a *new user* to the
 * encryption group only if an authenticated `group_members` intent from someone allowed to add
 * people names them, recently, and no later intent removed them. A malicious server can then
 * withhold or delay members, but cannot add anyone.
 */
export function intendedMembers(records: readonly HistoryRecord[], now: number): Set<string> {
  const latest = new Map<string, { add: boolean; at: number; seq: number }>();
  for (const record of records) {
    if (record.content === null || record.authority?.add !== true) continue;
    let parsed;
    try {
      parsed = contentSchema.safeParse(JSON.parse(record.content));
    } catch {
      continue;
    }
    if (!parsed.success || parsed.data.id !== record.clientMessageId) continue;
    const body = parsed.data.body;
    if (body.kind !== 'group_members') continue;
    const at = Date.parse(record.serverTime);
    const note = (userId: string, add: boolean) => {
      const previous = latest.get(userId);
      if (previous === undefined || previous.seq < record.seq)
        latest.set(userId, { add, at, seq: record.seq });
    };
    for (const userId of body.add) note(userId, true);
    for (const userId of body.remove) note(userId, false);
  }
  const intended = new Set<string>();
  for (const [userId, intent] of latest)
    if (intent.add && now - intent.at <= INTENT_TTL_MS) intended.add(userId);
  return intended;
}
