import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';

import { NOT_E2EE_NOTICE, subscriberLabel } from './shared.js';

/** Opening a private channel's invite link. */
export function ChannelInvitePage(): ReactNode {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const load = useCallback(() => endpoints.previewChannelInvite(token), [token]);
  const preview = useResource(load);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const data = preview.data;

  async function subscribe() {
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await endpoints.joinChannelInvite(token);
      await navigate(`/channels/${id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="settings-page">
      <PageHeading>Channel invitation</PageHeading>
      {preview.error !== undefined ? (
        <Alert tone="warning">This invite link is invalid or has expired.</Alert>
      ) : data === undefined ? (
        <Skeleton height="4rem" shape="tile" />
      ) : (
        <section className="settings-section stack">
          <h2>{data.title}</h2>
          <p>
            @{data.handle} · {subscriberLabel(data.subscriberCount)}
          </p>
          {data.description === '' ? null : <p className="group-description">{data.description}</p>}
          <p className="t-field__hint">{NOT_E2EE_NOTICE}</p>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          {data.subscribed ? (
            <Link to={`/channels/${data.id}`}>You already follow this channel — open it.</Link>
          ) : (
            <div className="button-row">
              <Button loading={busy} loadingLabel="Subscribing" onClick={() => void subscribe()}>
                Subscribe
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
