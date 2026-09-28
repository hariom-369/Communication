import type { PrivacySettings } from '@tessera/validation';
import { Alert, Button, Skeleton } from '@tessera/ui';
import { useEffect, useId, useState, type SubmitEvent, type ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
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
            hint="Who can call you."
            value={settings.calls}
            onChange={(v) => update('calls', v)}
          />
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
    </div>
  );
}
