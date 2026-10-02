import type { ConversationView } from '../../messaging/store.js';

/** Display name: a group's end-to-end encrypted name, or the other person's username. */
export function conversationTitle(conversation: ConversationView, myId: string): string {
  const { meta, timeline } = conversation;
  if (meta.kind === 'group') {
    if (timeline.group.name !== null) return timeline.group.name;
    const others = meta.members.filter((member) => member.userId !== myId);
    if (others.length === 0) return 'Group';
    const names = others.slice(0, 3).map((member) => `@${member.username}`);
    return `Group with ${names.join(', ')}${others.length > 3 ? ` +${others.length - 3}` : ''}`;
  }
  const peer = meta.members.find((member) => member.userId !== myId);
  return peer === undefined ? 'Saved messages' : `@${peer.username}`;
}

/** Usernames mentioned as `@name` that belong to members (their user ids). */
export function mentionsIn(
  text: string,
  members: readonly { userId: string; username: string }[],
  myId: string,
): string[] {
  const byName = new Map(members.map((member) => [member.username.toLowerCase(), member.userId]));
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^\w@])@([a-z0-9_.]{1,32})/giu)) {
    const id = byName.get((match[1] ?? '').toLowerCase());
    if (id !== undefined && id !== myId) found.add(id);
  }
  return [...found];
}
