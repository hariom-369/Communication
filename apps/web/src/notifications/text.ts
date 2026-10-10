import type { MessageBody } from '../messaging/content.js';

import type { PreviewLevel } from './device-prefs.js';

/**
 * Notification wording, from content decrypted on this device (docs/notifications.md §2). Used
 * by the service worker for pushes and by the page for messages arriving while it is hidden.
 */

const MAX_BODY = 160;

/** A short description of a message, or null for messages that should not notify. */
export function describeBody(body: MessageBody): string | null {
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'media': {
      const label = {
        image: 'Photo',
        video: 'Video',
        audio: 'Audio',
        voice: 'Voice message',
        file: 'File',
      }[body.attachment.category];
      return body.caption === undefined || body.caption === ''
        ? label
        : `${label}: ${body.caption}`;
    }
    case 'poll':
      return `Poll: ${body.question}`;
    // Reactions, edits, deletions, receipts, group changes, votes and call signals do not
    // notify (calls ring through their own push).
    case 'reaction':
    case 'edit':
    case 'delete':
    case 'read':
    case 'group_info':
    case 'group_members':
    case 'pin':
    case 'vote':
    case 'call':
      return null;
  }
}

export interface IncomingItem {
  /** "@alice" */
  readonly sender: string;
  readonly text: string;
  readonly mentionsMe: boolean;
}

export interface NotificationText {
  readonly title: string;
  readonly body: string;
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_BODY ? `${single.slice(0, MAX_BODY - 1)}…` : single;
}

export function messageNotification(options: {
  readonly conversationTitle: string;
  readonly isGroup: boolean;
  readonly items: readonly IncomingItem[];
  readonly level: PreviewLevel;
}): NotificationText {
  const { conversationTitle, isGroup, items, level } = options;
  const count = items.length;
  const generic = count > 1 ? `${count} new messages` : 'New message';
  if (level === 'none') return { title: 'Tessera', body: generic };
  if (level === 'name' || count === 0) return { title: conversationTitle, body: generic };
  const last = items[count - 1];
  if (last === undefined) return { title: conversationTitle, body: generic };
  const mention = items.some((item) => item.mentionsMe);
  const line = isGroup ? `${last.sender}: ${last.text}` : last.text;
  const prefix = count > 1 ? `(${count}) ` : '';
  return {
    title: mention ? `${conversationTitle} · mentioned you` : conversationTitle,
    body: clip(`${prefix}${line}`),
  };
}

/** Minutes after midnight in `timeZone`; quiet hours may cross midnight (start > end). */
export function inQuietHours(
  quiet: { readonly start: number; readonly end: number; readonly timeZone: string } | null,
  now = new Date(),
): boolean {
  if (quiet === null) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: quiet.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minutes = hour * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return quiet.start < quiet.end
    ? minutes >= quiet.start && minutes < quiet.end
    : minutes >= quiet.start || minutes < quiet.end;
}
