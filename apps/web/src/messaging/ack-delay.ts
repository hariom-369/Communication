/**
 * How long a device coalesces delivery acknowledgements for one conversation.
 *
 * Every online member acknowledges what it received, so a busy conversation produces up to
 * members ÷ delay acknowledgements per second. A fixed 150 ms made one busy 1,024-member group
 * send ~7,000 per second (docs/capacity.md §3). Growing the delay with the group bounds that at
 * ~250 per second per conversation, whatever its size; the cost is that "delivered to everyone"
 * in a large group shows a few seconds later. Direct and small conversations keep 150 ms.
 */
export function ackDelayMs(memberCount: number): number {
  return Math.min(MAX_ACK_DELAY_MS, Math.max(MIN_ACK_DELAY_MS, memberCount * ACK_MS_PER_MEMBER));
}

const MIN_ACK_DELAY_MS = 150;
const MAX_ACK_DELAY_MS = 5000;
const ACK_MS_PER_MEMBER = 4;
