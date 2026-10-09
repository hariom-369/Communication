import type { ReactNode } from 'react';

import type { TimelineMessage } from '../../messaging/timeline.js';

function length(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(seconds / 60);
  return m === 0 ? `${seconds} s` : `${m} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** A call in the chat history (kept only on devices, end-to-end encrypted like messages). */
export function CallEntry({
  message,
  mine,
  author,
}: {
  message: TimelineMessage;
  mine: boolean;
  author: string;
}): ReactNode {
  const call = message.call;
  if (call === null) return null;
  const kind = call.media === 'video' ? 'video call' : 'voice call';
  const Kind = call.media === 'video' ? 'Video call' : 'Voice call';
  const direction = mine ? 'Outgoing' : 'Incoming';
  let text: string;
  if (call.group) text = `${author} started a group ${kind}`;
  else if (call.answeredAt !== null)
    text =
      call.endedAt === null
        ? `${direction} ${kind}`
        : `${direction} ${kind} · ${length(call.endedAt - call.answeredAt)}`;
  else if (call.endedAt === null) text = `${direction} ${kind}`;
  else if (call.endReason === 'declined')
    text = mine ? `${Kind} declined` : `You declined a ${kind}`;
  else if (call.endReason === 'busy') text = `${Kind} · busy`;
  else text = mine ? `Unanswered ${kind}` : `Missed ${kind}`;
  const time = new Date(message.serverTime ?? message.sentAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <li className="call-entry">
      <span aria-hidden="true">{call.media === 'video' ? '🎥 ' : '📞 '}</span>
      {text} <time className="call-entry__time">{time}</time>
    </li>
  );
}
