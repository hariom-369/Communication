import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useMessaging, useMessagingStore } from '../../messaging/provider.js';
import type { ConversationView } from '../../messaging/store.js';
import { useSession } from '../../state/session.js';

import { shortTime } from './format.js';

const STATUS_LABEL = {
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Offline — reconnecting',
} as const;

export function peerOf(
  conversation: ConversationView,
  myId: string,
): { userId: string; username: string } {
  return (
    conversation.meta.members.find((member) => member.userId !== myId) ?? {
      userId: myId,
      username: 'Saved messages',
    }
  );
}

function preview(conversation: ConversationView): string {
  for (let i = conversation.timeline.order.length - 1; i >= 0; i--) {
    const message = conversation.timeline.byId[conversation.timeline.order[i] ?? ''];
    if (message === undefined) continue;
    if (message.deleted) return 'Message deleted';
    if (message.undecodable) return 'Unsupported message';
    return message.text;
  }
  return 'No messages yet';
}

export function ConversationList({ activeId }: { activeId: string | undefined }): ReactNode {
  const snapshot = useMessaging();
  const store = useMessagingStore();
  const { me } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (store === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const id = await store.openDirect(username.trim().replace(/^@/, ''));
      setUsername('');
      await navigate(`/chats/${id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <section className="chat-list" aria-labelledby="chats-heading">
      <header className="chat-list__header">
        <h1 id="chats-heading">Chats</h1>
        <span className={`connection connection--${snapshot.status}`} role="status">
          {STATUS_LABEL[snapshot.status]}
        </span>
      </header>
      <form className="chat-list__new" onSubmit={(event) => void start(event)}>
        <TextField
          label="Start a chat"
          placeholder="username"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={busy}
          loadingLabel="Opening chat"
        >
          Start
        </Button>
      </form>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {snapshot.error === null ? null : <Alert tone="warning">{snapshot.error}</Alert>}
      {!snapshot.loaded && snapshot.error === null ? (
        <div role="status" aria-busy="true" aria-label="Loading chats" className="stack">
          <Skeleton height="3.5rem" shape="tile" />
          <Skeleton height="3.5rem" shape="tile" />
        </div>
      ) : snapshot.conversations.length === 0 ? (
        <p className="empty">No chats yet. Start one with someone’s username.</p>
      ) : (
        <ul className="chat-list__items">
          {snapshot.conversations.map((conversation) => {
            const peer = peerOf(conversation, me?.id ?? '');
            return (
              <li key={conversation.meta.id}>
                <NavLink
                  to={`/chats/${conversation.meta.id}`}
                  className={
                    conversation.meta.id === activeId ? 'chat-item chat-item--active' : 'chat-item'
                  }
                  aria-current={conversation.meta.id === activeId ? 'page' : undefined}
                >
                  <span className="avatar" aria-hidden="true">
                    {peer.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="chat-item__body">
                    <span className="chat-item__name">@{peer.username}</span>
                    <span className="chat-item__preview">
                      {conversation.typing.length > 0 ? 'typing…' : preview(conversation)}
                    </span>
                  </span>
                  <span className="chat-item__meta">
                    <span className="chat-item__time">
                      {shortTime(Date.parse(conversation.meta.lastActivityAt))}
                    </span>
                    {conversation.unread > 0 ? (
                      <span className="unread" aria-label={`${conversation.unread} unread`}>
                        {conversation.unread}
                      </span>
                    ) : null}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
