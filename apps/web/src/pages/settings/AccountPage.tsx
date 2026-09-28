import type { ReactNode } from 'react';

import { PageHeading } from '../../components/PageHeading.js';
import { useSession } from '../../state/session.js';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

export function AccountPage(): ReactNode {
  const { me } = useSession();
  if (me === null) return null;
  return (
    <div className="settings-page">
      <PageHeading>Account</PageHeading>
      <section className="settings-section" aria-labelledby="profile">
        <h2 id="profile">Your account</h2>
        <dl className="details">
          <dt>Username</dt>
          <dd>@{me.username}</dd>
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Member since</dt>
          <dd>{date.format(new Date(me.createdAt))}</dd>
        </dl>
      </section>
    </div>
  );
}
