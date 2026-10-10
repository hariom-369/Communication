import { Alert } from '@tessera/ui';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { useMessagingStore } from '../../messaging/provider.js';

const CHOICES = [
  { value: 'on', label: 'On', ms: 0 },
  { value: '1h', label: 'Muted for 1 hour', ms: 3_600_000 },
  { value: '8h', label: 'Muted for 8 hours', ms: 8 * 3_600_000 },
  { value: '1w', label: 'Muted for 1 week', ms: 7 * 24 * 3_600_000 },
  { value: 'always', label: 'Muted until I unmute', ms: 0 },
] as const;
type Choice = (typeof CHOICES)[number]['value'];

/**
 * Mute a conversation (docs/notifications.md §3). Muting is a server-side rule (the server then
 * does not wake your devices for this chat); a muted group also does not ring for group calls.
 */
export function MuteControl({ conversationId }: { conversationId: string }): ReactNode {
  const store = useMessagingStore();
  const [until, setUntil] = useState<string | null | undefined>();
  const [error, setError] = useState<string>();
  const id = useId();

  const load = useCallback(() => {
    endpoints.mutes().then(
      (result) => {
        const mute = result.mutes.find((m) => m.conversationId === conversationId);
        setUntil(mute === undefined ? undefined : mute.until);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, [conversationId]);

  useEffect(() => {
    load();
    return store?.onNotificationsChanged((what) => {
      if (what === 'settings') load();
    });
  }, [load, store]);

  async function choose(choice: Choice) {
    setError(undefined);
    try {
      if (choice === 'on') await endpoints.unmute(conversationId);
      else {
        const entry = CHOICES.find((c) => c.value === choice);
        await endpoints.mute(
          conversationId,
          choice === 'always' || entry === undefined
            ? null
            : new Date(Date.now() + entry.ms).toISOString(),
        );
      }
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const muted = until !== undefined;
  return (
    <div className="stack">
      <div className="t-field">
        <label className="t-field__label" htmlFor={id}>
          Notifications
        </label>
        <select
          id={id}
          className="t-field__input"
          // A timed mute shows as "on" in the menu only after it ended; the status line says until when.
          value={!muted ? 'on' : until === null ? 'always' : ''}
          onChange={(e) => void choose(e.target.value as Choice)}
        >
          {muted && until !== null ? (
            <option value="" disabled>
              Muted until {new Date(until).toLocaleString()}
            </option>
          ) : null}
          {CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
