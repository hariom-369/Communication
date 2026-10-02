import { Alert, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';

import { RulesAgreement } from './RulesAgreement.js';

/** Opening a community invite link: preview, accept the rules, join. */
export function CommunityInvitePage(): ReactNode {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const load = useCallback(() => endpoints.previewCommunityInvite(token), [token]);
  const preview = useResource(load);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const data = preview.data;

  async function join(rulesVersion: number) {
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await endpoints.joinCommunityInvite(token, rulesVersion);
      await navigate(`/communities/${id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="settings-page">
      <PageHeading>Community invitation</PageHeading>
      {preview.error !== undefined ? (
        <Alert tone="warning">This invite link is invalid or has expired.</Alert>
      ) : data === undefined ? (
        <Skeleton height="4rem" shape="tile" />
      ) : (
        <section className="settings-section stack">
          <h2>{data.name}</h2>
          <p>
            {data.memberCount} {data.memberCount === 1 ? 'member' : 'members'}
            {data.description === '' ? '' : ` · ${data.description}`}
          </p>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          {data.alreadyMember ? (
            <Link to={`/communities/${data.id}`}>
              You are already a member — open the community.
            </Link>
          ) : (
            <RulesAgreement
              rules={data.rules}
              minAccountAgeDays={data.minAccountAgeDays}
              busy={busy}
              onJoin={() => void join(data.rulesVersion)}
            />
          )}
        </section>
      )}
    </div>
  );
}
