import { Alert, Button } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { useMessagingStore } from '../../messaging/provider.js';
import { useResource } from '../../lib/use-resource.js';

/** Invitations from people this user's privacy settings do not let add them directly. */
export function GroupInvitations(): ReactNode {
  const store = useMessagingStore();
  const navigate = useNavigate();
  const load = useCallback(() => endpoints.groupInvitations(), []);
  const invitations = useResource(load);
  const [error, setError] = useState<string>();
  const list = invitations.data?.invitations ?? [];
  if (list.length === 0) return null;

  async function respond(conversationId: string, accept: boolean) {
    setError(undefined);
    try {
      if (accept) {
        await store?.acceptInvitation(conversationId);
        await navigate(`/chats/${conversationId}`);
      } else await endpoints.declineInvitation(conversationId);
      invitations.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="invitations stack" aria-labelledby="invitations-heading">
      <h2 id="invitations-heading">Group invitations</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <ul className="member-list">
        {list.map((invitation) => (
          <li key={invitation.conversationId} className="member">
            <span>
              From @{invitation.invitedBy} · {invitation.memberCount}{' '}
              {invitation.memberCount === 1 ? 'member' : 'members'}
            </span>
            <div className="button-row">
              <Button size="sm" onClick={() => void respond(invitation.conversationId, true)}>
                Join
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void respond(invitation.conversationId, false)}
              >
                Decline
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
