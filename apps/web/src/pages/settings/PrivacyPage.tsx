import type { PrivacySettings } from '@tessera/validation';
import { Alert, Button, Skeleton } from '@tessera/ui';
import { useEffect, useId, useState, type SubmitEvent, type ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { moderationEndpoints } from '../../api/moderation-endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';

type Visibility = 'everyone' | 'contacts' | 'nobody';
const VISIBILITY: { value: Visibility; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'contacts', label: 'My contacts' },
  { value: 'nobody', label: 'Nobody' },
];

function VisibilityField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: Visibility;
  onChange: (value: Visibility) => void;
}) {
  const id = useId();
  return (
    <div className="t-field">
      <label className="t-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="t-field__input"
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value as Visibility)}
      >
        {VISIBILITY.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="t-field__hint">
        {hint}
      </p>
    </div>
  );
}

export function PrivacyPage(): ReactNode {
  const [settings, setSettings] = useState<PrivacySettings>();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    endpoints
      .privacy()
      .then(setSettings, (caught: unknown) =>
        setMessage({ tone: 'danger', text: errorMessage(caught) }),
      );
  }, []);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (settings === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await endpoints.updatePrivacy(settings);
      setMessage({ tone: 'success', text: 'Privacy settings saved.' });
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  const update = <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]) =>
    setSettings((current) => (current === undefined ? current : { ...current, [key]: value }));

  return (
    <div className="settings-page">
      <PageHeading description="Choose who can see your activity and reach you. These settings apply as each feature launches.">
        Privacy
      </PageHeading>
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      {settings === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading privacy settings" className="stack">
          <Skeleton height="4rem" shape="tile" />
          <Skeleton height="4rem" shape="tile" />
        </div>
      ) : (
        <form className="settings-section stack" onSubmit={(event) => void save(event)}>
          <VisibilityField
            label="Profile photo"
            hint="Who can see your profile photo."
            value={settings.profilePhoto}
            onChange={(v) => update('profilePhoto', v)}
          />
          <VisibilityField
            label="Last seen"
            hint="If you hide yours, you cannot see others’ either."
            value={settings.lastSeen}
            onChange={(v) => update('lastSeen', v)}
          />
          <VisibilityField
            label="Group invitations"
            hint="Who can add you to groups directly. Others send an invite."
            value={settings.groupInvites}
            onChange={(v) => update('groupInvites', v)}
          />
          <VisibilityField
            label="Calls"
            hint="Who can call you. Contacts are people you have a direct chat with."
            value={settings.calls}
            onChange={(v) => update('calls', v)}
          />
          <label className="t-field">
            <span className="t-field__label">Relay calls through Tessera</span>
            <select
              className="t-field__input"
              value={settings.callRelay}
              onChange={(e) => update('callRelay', e.target.value as PrivacySettings['callRelay'])}
            >
              <option value="always">Always</option>
              <option value="unverified">Unless I verified the person’s safety number</option>
              <option value="never">Never</option>
            </select>
            <span className="t-field__hint">
              A relayed call hides your IP address from the person you call. Tessera’s relay sees
              your address but not the call, which stays end-to-end encrypted. Direct calls can have
              better quality.
            </span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.onlineStatus === 'same_as_last_seen'}
              onChange={(e) =>
                update('onlineStatus', e.target.checked ? 'same_as_last_seen' : 'nobody')
              }
            />
            <span>Show when I am online (to the same people who can see my last seen)</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.readReceipts}
              onChange={(e) => update('readReceipts', e.target.checked)}
            />
            <span>Send read receipts (if off, you will not see others’ read receipts)</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.discoverableByUsername}
              onChange={(e) => update('discoverableByUsername', e.target.checked)}
            />
            <span>Let people find me by my username</span>
          </label>
          <div>
            <Button type="submit" loading={busy} loadingLabel="Saving">
              Save
            </Button>
          </div>
        </form>
      )}
      <BlockedPeople />
    </div>
  );
}

/** People this user blocked (docs/moderation.md §2). Nobody is told they were blocked. */
function BlockedPeople(): ReactNode {
  const [blocked, setBlocked] = useState<{ userId: string; username: string }[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    moderationEndpoints.blocked().then(
      (list) => setBlocked(list.blocked),
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  async function unblock(userId: string) {
    setError(undefined);
    try {
      await moderationEndpoints.unblock(userId);
      setBlocked((current) => current?.filter((entry) => entry.userId !== userId));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section" aria-labelledby="blocked-heading">
      <h2 id="blocked-heading">Blocked people</h2>
      <p className="t-field__hint">
        Blocked people cannot message or call you, add you to groups, or see when you are online.
        They are not told.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {blocked === undefined ? null : blocked.length === 0 ? (
        <p className="empty">You have not blocked anyone.</p>
      ) : (
        <ul className="plain-list">
          {blocked.map((entry) => (
            <li key={entry.userId} className="button-row">
              <span>@{entry.username}</span>
              <Button size="sm" variant="ghost" onClick={() => void unblock(entry.userId)}>
                Unblock @{entry.username}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
