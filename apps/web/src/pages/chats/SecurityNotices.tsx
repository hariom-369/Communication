import { Alert, Button } from '@tessera/ui';
import type { ReactNode } from 'react';

import { useMessagingStore } from '../../messaging/provider.js';
import type { ConversationView } from '../../messaging/store.js';

/**
 * Security conditions of one conversation. A changed identity key blocks sending until the user
 * chooses to continue (docs/e2ee.md §9).
 */
export function SecurityNotices(props: {
  conversation: ConversationView;
  username: (userId: string) => string;
  onVerify: () => void;
}): ReactNode {
  const store = useMessagingStore();
  const { security, meta } = props.conversation;
  const notices: ReactNode[] = [];

  for (const userId of security.keyChanged) {
    notices.push(
      <div key={`changed-${userId}`} className="key-change" role="alert">
        <p>
          <strong>@{props.username(userId)}’s security key changed.</strong> This happens when they
          set up encryption again, for example on a new device. If you did not expect this, verify
          their safety number before sending anything sensitive. Messages you write are held until
          you continue.
        </p>
        <div className="key-change__actions">
          <Button size="sm" variant="ghost" onClick={props.onVerify}>
            Verify safety number
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void store?.security.acknowledgeChange(meta.id, userId).then(() => {
                store.unblock(meta.id);
              });
            }}
          >
            Continue
          </Button>
        </div>
      </div>,
    );
  }
  if (security.newDevices.length > 0)
    notices.push(
      <div key="new-devices" className="conversation__notice" role="status">
        <p>
          {security.newDevices.map((userId) => `@${props.username(userId)}`).join(', ')}{' '}
          {security.newDevices.length === 1 ? 'added a new device' : 'added new devices'}. Their
          security key is unchanged, so their devices are still verified by it.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => store?.security.dismissNewDevices(meta.id)}
        >
          Dismiss
        </Button>
      </div>,
    );
  if (security.failed)
    notices.push(
      <Alert key="failed" tone="danger">
        A security check failed in this conversation, so some messages could not be decrypted.
      </Alert>,
    );
  if (security.peerNotReady)
    notices.push(
      <p key="peer" className="conversation__notice">
        Your contact hasn’t set up encryption yet. Messages will be sent once they do.
      </p>,
    );
  else if (security.waitingForWelcome)
    notices.push(
      <p key="welcome" className="conversation__notice">
        Waiting for the other person’s device to add this one to the conversation…
      </p>,
    );
  return notices.length === 0 ? null : <>{notices}</>;
}
