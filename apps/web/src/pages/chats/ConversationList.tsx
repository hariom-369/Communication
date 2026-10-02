import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useDeferredValue, useMemo, useState, type ReactNode, type SubmitEvent } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useMessaging, useMessagingStore } from '../../messaging/provider.js';
import type { ConversationView } from '../../messaging/store.js';
import { useSession } from '../../state/session.js';

import { shortTime } from './format.js';
import { GroupInvitations } from './GroupInvitations.js';
import { attachmentLabel } from './MessageBubble.js';
import { NewGroupDialog } from './NewGroupDialog.js';
import { conversationTitle } from './titles.js';

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

function preview(conversation: ConversationView, myId: string): string {
  for (let i = conversation.timeline.order.length - 1; i >= 0; i--) {
    const message = conversation.timeline.byId[conversation.timeline.order[i] ?? ''];
    if (message === undefined) continue;
    if (message.deleted) return 'Message deleted';
    if (message.undecodable) return 'Message couldn’t be decrypted';
    const who =
      conversation.meta.kind === 'group'
        ? message.senderId === myId
          ? 'You: '
          : `${conversation.meta.members.find((m) => m.userId === message.senderId)?.username ?? 'someone'}: `
        : '';
    if (message.poll !== null) return `${who}📊 ${message.text}`;
    if (message.attachment !== null)
      return (
        who +
        (message.text === ''
          ? attachmentLabel(message.attachment.category)
          : `${attachmentLabel(message.attachment.category)} · ${message.text}`)
      );
    return who + message.text;
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
  const [groupOpen, setGroupOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(
    () => (store === null ? [] : store.search(deferredQuery)),
    // Re-run when history changes as well as when the query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, deferredQuery, snapshot.conversations],
  );
  const searching = query.trim().length >= 2;
  const nameOf = (conversationId: string) => {
    const conversation = snapshot.conversations.find((c) => c.meta.id === conversationId);
    return conversation === undefined ? '' : conversationTitle(conversation, me?.id ?? '');
  };

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
      <div className="button-row">
        <Button size="sm" variant="ghost" onClick={() => setGroupOpen(true)}>
          New group
        </Button>
      </div>
      <NewGroupDialog open={groupOpen} onClose={() => setGroupOpen(false)} />
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {snapshot.loaded ? <GroupInvitations /> : null}
      {snapshot.error === null ? null : <Alert tone="warning">{snapshot.error}</Alert>}
      <div className="chat-list__search">
        <TextField
          label="Search messages"
          hint="Searches the messages stored on this device."
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {searching ? (
        results.length === 0 ? (
          <p className="empty" role="status">
            No messages on this device match “{query.trim()}”.
          </p>
        ) : (
          <ul className="search-results" aria-label="Search results">
            {results.map((result) => (
              <li key={`${result.conversationId}/${result.messageId}`}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    void navigate(`/chats/${result.conversationId}`);
                  }}
                >
                  <span className="chat-item__name">
                    {nameOf(result.conversationId)} · {shortTime(result.sentAt)}
                  </span>
                  <span className="chat-item__preview">
                    <Highlight text={result.text} query={deferredQuery.trim()} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : !snapshot.loaded && snapshot.error === null ? (
        <div role="status" aria-busy="true" aria-label="Loading chats" className="stack">
          <Skeleton height="3.5rem" shape="tile" />
          <Skeleton height="3.5rem" shape="tile" />
        </div>
      ) : snapshot.conversations.length === 0 ? (
        <p className="empty">No chats yet. Start one with someone’s username.</p>
      ) : (
        <ul className="chat-list__items">
          {snapshot.conversations.map((conversation) => {
            const title = conversationTitle(conversation, me?.id ?? '');
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
                    {(title.replace(/^@/, '').at(0) ?? '#').toUpperCase()}
                  </span>
                  <span className="chat-item__body">
                    <span className="chat-item__name">{title}</span>
                    <span className="chat-item__preview">
                      {conversation.typing.length > 0
                        ? 'typing…'
                        : preview(conversation, me?.id ?? '')}
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

/** Marks the first match (plain-text rendering; no HTML is interpreted). */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const snippetStart = Math.max(0, index - 40);
  const snippet = (snippetStart > 0 ? '…' : '') + text.slice(snippetStart);
  if (index < 0 || query === '') return snippet;
  const offset = index - snippetStart + (snippetStart > 0 ? 1 : 0);
  return (
    <>
      {snippet.slice(0, offset)}
      <mark>{snippet.slice(offset, offset + query.length)}</mark>
      {snippet.slice(offset + query.length)}
    </>
  );
}
