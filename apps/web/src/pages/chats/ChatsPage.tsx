import { Alert } from '@tessera/ui';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';

import { useMessaging } from '../../messaging/provider.js';

import { ConversationList } from './ConversationList.js';
import { EncryptionSetup } from './EncryptionSetup.js';
import { ConversationView } from './ConversationView.js';

/**
 * Chats: conversation list + open conversation (+ details) on desktop; one pane at a time on
 * mobile (list at /chats, conversation at /chats/:id).
 */
export function ChatsPage(): ReactNode {
  const { conversationId } = useParams();
  const snapshot = useMessaging();
  const open = snapshot.conversations.find(
    (conversation) => conversation.meta.id === conversationId,
  );

  if (snapshot.device !== 'ready')
    return (
      <div className="chats chats--setup">
        <h1>Chats</h1>
        <EncryptionSetup status={snapshot.device} />
      </div>
    );

  return (
    <div className={conversationId === undefined ? 'chats' : 'chats chats--open'}>
      {conversationId === undefined ? null : (
        // On phones the chat list (and its heading) is hidden while a conversation is open.
        <h1 className="visually-hidden chats__mobile-heading">Chats</h1>
      )}
      <div className="chats__panes">
        <ConversationList activeId={conversationId} />
        {open !== undefined ? (
          <ConversationView key={open.meta.id} conversation={open} />
        ) : conversationId !== undefined && snapshot.loaded ? (
          <div className="conversation conversation--empty">
            <Alert tone="warning">This conversation does not exist or you are not a member.</Alert>
          </div>
        ) : (
          <div
            className="conversation conversation--empty"
            aria-hidden={conversationId === undefined}
          >
            <p className="empty">Select a chat or start a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}
