import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { errorMessage } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { PageHeading } from '../components/PageHeading.js';
import { useResource } from '../lib/use-resource.js';

/** Opening a group invite link: preview, then ask to join (an admin approves). */
export function InvitePage(): ReactNode {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const load = useCallback(() => endpoints.previewInvite(token), [token]);
  const preview = useResource(load);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await endpoints.requestJoin(token);
      if (result.groupId !== null) await navigate(`/chats/${result.groupId}`);
      else setRequested(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  const data = preview.data;
  return (
    <div className="settings-page">
      <PageHeading>Group invitation</PageHeading>
      {preview.error !== undefined ? (
        <Alert tone="warning">This invite link is invalid or has expired.</Alert>
      ) : data === undefined ? (
        <Skeleton height="4rem" shape="tile" />
      ) : (
        <section className="settings-section stack">
          <h2>{data.previewTitle ?? 'A group on Tessera'}</h2>
          <p>
            {data.memberCount} {data.memberCount === 1 ? 'member' : 'members'}. The group’s real
            name and messages are end-to-end encrypted; you will see them once you are added.
          </p>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          {data.alreadyMember ? (
            <Link to="/chats">You are already a member — open your chats.</Link>
          ) : requested || data.requested ? (
            <Alert tone="success">Request sent. An admin of the group needs to approve it.</Alert>
          ) : (
            <div className="button-row">
              <Button loading={busy} loadingLabel="Sending request" onClick={() => void join()}>
                Ask to join
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
