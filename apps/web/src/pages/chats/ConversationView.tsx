import { Alert, Button } from '@tessera/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { endpoints } from '../../api/endpoints.js';
import { errorMessage } from '../../api/client.js';
import { useMessaging, useMessagingStore } from '../../messaging/provider.js';
import { roleIn } from '../../messaging/e2ee.js';
import type { ConversationView as ConversationState } from '../../messaging/store.js';
import { useSession } from '../../state/session.js';

import { Composer } from './Composer.js';
import { peerOf } from './ConversationList.js';
import { lastSeen } from './format.js';
import { GroupPanel } from './GroupPanel.js';
import { MessageBubble } from './MessageBubble.js';
import { PollDialog } from './PollDialog.js';
import { SafetyNumber } from './SafetyNumber.js';
import { SecurityNotices } from './SecurityNotices.js';
import { conversationTitle, mentionsIn } from './titles.js';
import type { Presence } from './types.js';

const TIMERS = [
  { value: 0, label: 'Off' },
  { value: 86_400, label: '24 hours' },
  { value: 604_800, label: '7 days' },
  { value: 7_776_000, label: '90 days' },
] as const;

/** Current time, refreshed periodically (for edit/delete windows and relative times). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function usePresence(userId: string | null): Presence | null {
  const [presence, setPresence] = useState<Presence | null>(null);
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    const load = () => {
      endpoints.presence(userId).then(
        (value) => {
          if (!cancelled) setPresence(value);
        },
        () => undefined,
      );
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [userId]);
  return presence;
}

export function ConversationView({ conversation }: { conversation: ConversationState }): ReactNode {
  const store = useMessagingStore();
  const { uploads } = useMessaging();
  const { me } = useSession();
  const myId = me?.id ?? '';
  const peer = peerOf(conversation, myId);
  const isGroup = conversation.meta.kind === 'group';
  const presence = usePresence(isGroup ? null : peer.userId);
  const location = useLocation();
  const [notice, setNotice] = useState<string | undefined>(
    (location.state as { notice?: string } | null)?.notice,
  );
  const [pollOpen, setPollOpen] = useState(false);
  const now = useNow(30_000);
  const [context, setContext] = useState<{ kind: 'reply' | 'edit'; id: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const { timeline, meta } = conversation;
  const conversationId = meta.id;
  const messageCount = timeline.order.length;

  // Keep the newest message in view and mark the conversation read while it is visible.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    if (document.visibilityState === 'visible') store?.markRead(conversationId);
  }, [messageCount, conversationId, store]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') store?.markRead(conversationId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [conversationId, store]);

  if (store === null) return null;
  const peers = { deliveredUpTo: meta.peersAckedSeq, readUpTo: timeline.readBy[peer.userId] ?? 0 };
  const contextMessage = context === null ? undefined : timeline.byId[context.id];
  const author = (userId: string) =>
    userId === myId
      ? 'You'
      : `@${meta.members.find((m) => m.userId === userId)?.username ?? 'someone'}`;
  const verified = conversation.security.verified.includes(peer.userId);
  const username = (userId: string) =>
    meta.members.find((m) => m.userId === userId)?.username ?? 'someone';
  const title = conversationTitle(conversation, myId);
  const policy = conversation.security.policy;
  const myRole = roleIn(policy, myId);
  const moderator = isGroup ? myRole === 'owner' || myRole === 'admin' : true;
  const readOnly =
    conversation.removed || (policy?.announcementsOnly === true && myRole === 'member');
  const typingNames = conversation.typing.map((userId) => `@${username(userId)}`);
  const pins = timeline.group.pins
    .map((id) => timeline.byId[id])
    .filter((message): message is NonNullable<typeof message> => message?.deleted === false);

  async function setTimer(seconds: 0 | 86400 | 604800 | 7776000) {
    setError(undefined);
    try {
      await store?.setDisappearing(conversationId, seconds);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="conversation">
      <section className="conversation__main" aria-labelledby="conversation-title">
        <header className="conversation__header">
          <Link to="/chats" className="conversation__back" aria-label="Back to chats">
            ←
          </Link>
          <div className="conversation__title">
            <h2 id="conversation-title">
              {title}
              {verified && !isGroup ? <span className="verified-badge"> · Verified</span> : null}
            </h2>
            <p className="conversation__presence" aria-live="polite">
              {isGroup
                ? typingNames.length > 0
                  ? `${typingNames.join(', ')} typing…`
                  : `${meta.members.length} ${meta.members.length === 1 ? 'member' : 'members'}`
                : conversation.typing.includes(peer.userId)
                  ? 'typing…'
                  : presence?.online === true
                    ? 'online'
                    : presence?.lastSeenAt != null
                      ? lastSeen(presence.lastSeenAt)
                      : ''}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            Details
          </Button>
        </header>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        {notice === undefined ? null : (
          <div className="conversation__notice" role="status">
            <p>{notice}</p>
            <Button size="sm" variant="ghost" onClick={() => setNotice(undefined)}>
              Dismiss
            </Button>
          </div>
        )}
        {pins.length === 0 ? null : (
          <section className="pinned-bar" aria-label="Pinned messages">
            {pins.slice(0, 3).map((message) => (
              <p key={message.id} className="pinned-bar__item">
                <span aria-hidden="true">📌 </span>
                <span className="pinned-bar__author">{author(message.senderId)}: </span>
                {message.text === '' ? 'Attachment' : message.text}
              </p>
            ))}
          </section>
        )}
        <SecurityNotices
          conversation={conversation}
          username={username}
          onVerify={() => setDetailsOpen(true)}
        />
        {meta.disappearingSeconds > 0 ? (
          <p className="conversation__notice">
            Disappearing messages are on: new messages disappear after{' '}
            {TIMERS.find((t) => t.value === meta.disappearingSeconds)?.label}.
          </p>
        ) : null}
        <div className="timeline">
          {timeline.order.length === 0 ? (
            <p className="empty timeline__empty">
              {isGroup ? 'No messages yet.' : `Say hello to @${peer.username}.`}
            </p>
          ) : (
            <ol
              className="timeline__list"
              aria-label={isGroup ? `Messages in ${title}` : `Messages with @${peer.username}`}
              aria-live="polite"
            >
              {timeline.order.map((id) => {
                const message = timeline.byId[id];
                if (message === undefined) return null;
                const quoted =
                  message.replyTo === null ? undefined : timeline.byId[message.replyTo];
                return (
                  <MessageBubble
                    key={id}
                    message={message}
                    mine={message.senderId === myId}
                    quoted={quoted}
                    quotedAuthor={quoted === undefined ? '' : author(quoted.senderId)}
                    peers={peers}
                    showRead={true}
                    myId={myId}
                    now={now}
                    onReply={() => setContext({ kind: 'reply', id })}
                    onEdit={() => setContext({ kind: 'edit', id })}
                    onReact={(emoji) => store.react(conversationId, id, emoji)}
                    onDelete={() => {
                      if (window.confirm('Delete this message for everyone?'))
                        store.deleteForEveryone(conversationId, id);
                    }}
                    onRetry={() => store.retry(conversationId, id)}
                    upload={uploads[id]}
                    onCancelUpload={() => store.cancelUpload(conversationId, id)}
                    author={isGroup ? author(message.senderId) : undefined}
                    canModerate={
                      isGroup &&
                      !readOnly &&
                      (myRole === 'owner' || (myRole === 'admin' && message.authorRole !== 'owner'))
                    }
                    pinned={timeline.group.pins.includes(id)}
                    onPin={
                      moderator && !readOnly
                        ? (pinned) => store.pin(conversationId, id, pinned)
                        : undefined
                    }
                    canRespond={!readOnly}
                    onVote={(choices) => store.vote(conversationId, id, choices)}
                  />
                );
              })}
            </ol>
          )}
          <div ref={bottom} />
        </div>
        {readOnly ? (
          <p className="conversation__notice composer-locked" role="status">
            {conversation.removed
              ? 'You are no longer a member of this group.'
              : 'Only admins can send messages in this group.'}
          </p>
        ) : null}
        {isGroup && !readOnly ? (
          <>
            <div className="button-row composer-extras">
              <Button size="sm" variant="ghost" onClick={() => setPollOpen(true)}>
                Poll
              </Button>
            </div>
            <PollDialog
              open={pollOpen}
              onClose={() => setPollOpen(false)}
              onCreate={(question, options, multiple) =>
                store.sendPoll(conversationId, question, options, multiple)
              }
            />
          </>
        ) : null}
        {readOnly ? null : (
          <Composer
            key={context === null ? 'new' : `${context.kind}:${context.id}`}
            context={
              context === null || contextMessage === undefined
                ? null
                : {
                    kind: context.kind,
                    label: context.kind === 'reply' ? author(contextMessage.senderId) : 'message',
                    text: contextMessage.text,
                  }
            }
            onCancelContext={() => setContext(null)}
            onTyping={(state) => store.typing(conversationId, state)}
            onSubmit={(text, attachments) => {
              const replyTo = context?.kind === 'reply' ? context.id : null;
              if (context?.kind === 'edit') store.edit(conversationId, context.id, text);
              else if (attachments.length === 0)
                store.sendText(
                  conversationId,
                  text,
                  replyTo,
                  isGroup ? mentionsIn(text, meta.members, myId) : [],
                );
              else
                attachments.forEach((attachment, index) => {
                  store.sendAttachment(
                    conversationId,
                    attachment,
                    index === 0 ? text : '',
                    index === 0 ? replyTo : null,
                  );
                });
              setContext(null);
            }}
          />
        )}
      </section>
      {detailsOpen && isGroup ? (
        <aside className="conversation__details" aria-labelledby="details-heading">
          <h2 id="details-heading">Group details</h2>
          <GroupPanel conversation={conversation} myId={myId} />
        </aside>
      ) : detailsOpen ? (
        <aside className="conversation__details" aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <h3>Encryption</h3>
          <p className="t-field__hint">
            Messages in this chat are end-to-end encrypted: only the devices of the people in it can
            read them.
          </p>
          <SafetyNumber
            conversationId={conversationId}
            userId={peer.userId}
            username={peer.username}
            verified={verified}
          />
          <h3>Members</h3>
          <ul className="plain-list">
            {meta.members.map((member) => (
              <li key={member.userId}>
                @{member.username}
                {member.userId === myId ? ' (you)' : ''}
              </li>
            ))}
          </ul>
          <label className="t-field">
            <span className="t-field__label">Disappearing messages</span>
            <select
              className="t-field__input"
              value={meta.disappearingSeconds}
              onChange={(e) =>
                void setTimer(Number(e.target.value) as 0 | 86400 | 604800 | 7776000)
              }
            >
              {TIMERS.map((timer) => (
                <option key={timer.value} value={timer.value}>
                  {timer.label}
                </option>
              ))}
            </select>
          </label>
          <p className="t-field__hint">
            Recipients can still copy or photograph messages before they disappear.
          </p>
        </aside>
      ) : null}
    </div>
  );
}
