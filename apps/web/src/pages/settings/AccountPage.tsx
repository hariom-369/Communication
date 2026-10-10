import { Button } from '@tessera/ui';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { PageHeading } from '../../components/PageHeading.js';
import { install, installState, subscribeInstall } from '../../pwa/install.js';
import { runningRelease, type RunningRelease } from '../../pwa/release-info.js';
import { useSession } from '../../state/session.js';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

/** Installing the app, and which verified release this browser runs (docs/e2ee.md §7). */
function ThisApp(): ReactNode {
  const state = useSyncExternalStore(subscribeInstall, installState, () => 'unavailable' as const);
  const [release, setRelease] = useState<RunningRelease | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void runningRelease().then((found) => {
      if (live) setRelease(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="settings-section" aria-labelledby="this-app">
      <h2 id="this-app">This app</h2>
      <dl className="details">
        <dt>Installed</dt>
        <dd>
          {state === 'installed'
            ? 'Yes'
            : state === 'available'
              ? 'No'
              : 'No — use your browser’s menu (“Install” or “Add to Home Screen”) if it offers it'}
        </dd>
        <dt>Release</dt>
        <dd>
          {release === undefined
            ? '…'
            : release === null
              ? 'Loaded from the network (no verified copy stored in this browser)'
              : `Verified release ${String(release.sequence)}${release.version === '' ? '' : ` (${release.version})`}`}
        </dd>
      </dl>
      {state === 'available' && (
        <Button variant="secondary" onClick={() => void install()}>
          Install Tessera
        </Button>
      )}
    </section>
  );
}

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
      <ThisApp />
    </div>
  );
}
