import type { ConversationMute, NotificationPreferences } from '@tessera/validation';
import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useEffect, useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useE2ee, useMessaging } from '../../messaging/provider.js';
import {
  readDevicePrefs,
  writeDevicePrefs,
  type PreviewLevel,
} from '../../notifications/device-prefs.js';
import { disablePush, enablePush, pushSupport } from '../../notifications/push.js';
import { useSession } from '../../state/session.js';
import { conversationTitle } from '../chats/titles.js';

const PREVIEW_OPTIONS: { value: PreviewLevel; label: string }[] = [
  { value: 'full', label: 'Name and message' },
  { value: 'name', label: 'Name only' },
  { value: 'none', label: 'Nothing (“New message”)' },
];

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function fromTime(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function timeZones(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: 'timeZone') => string[] };
  return intl.supportedValuesOf?.('timeZone') ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
}

/** Push on this browser and what notifications show here (kept on this device only). */
function ThisBrowser(): ReactNode {
  const { me } = useSession();
  const session = useE2ee();
  const support = pushSupport();
  const [state, setState] = useState<'loading' | 'on' | 'off' | 'unavailable'>('loading');
  const [preview, setPreview] = useState<PreviewLevel>('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();

  const load = useCallback(async () => {
    if (me === null) return null;
    const prefs = await readDevicePrefs(me.id);
    if (support !== 'supported') return { preview: prefs.preview, state: 'unavailable' as const };
    const config = await endpoints.notificationConfig();
    const on = config.subscribed && prefs.push && Notification.permission === 'granted';
    return {
      preview: prefs.preview,
      state: !config.pushAvailable
        ? ('unavailable' as const)
        : on
          ? ('on' as const)
          : ('off' as const),
    };
  }, [me, support]);

  const refresh = useCallback(async () => {
    const loaded = await load();
    if (loaded === null) return;
    setPreview(loaded.preview);
    setState(loaded.state);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (loaded) => {
        if (cancelled || loaded === null) return;
        setPreview(loaded.preview);
        setState(loaded.state);
      },
      (caught: unknown) => {
        if (!cancelled) setMessage({ tone: 'danger', text: errorMessage(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function turnOn() {
    if (me === null) return;
    const deviceId = session?.deviceId ?? null;
    if (deviceId === null) {
      setMessage({
        tone: 'danger',
        text: 'Set up encrypted chats on this device first (open Chats).',
      });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await enablePush(me.id, deviceId);
      setMessage({ tone: 'success', text: 'Notifications are on for this browser.' });
      await refresh();
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  async function turnOff() {
    if (me === null) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await disablePush(me.id);
      setMessage({ tone: 'success', text: 'Notifications are off for this browser.' });
      await refresh();
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  async function changePreview(level: PreviewLevel) {
    if (me === null) return;
    setPreview(level);
    await writeDevicePrefs(me.id, { preview: level });
  }

  return (
    <section className="settings-section stack" aria-labelledby="this-browser">
      <h2 id="this-browser">This browser</h2>
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      {state === 'loading' ? (
        <Skeleton height="3rem" shape="tile" />
      ) : state === 'unavailable' ? (
        <p>
          {support === 'install-required'
            ? 'On iPhone and iPad, notifications work after you add Tessera to your home screen (Share → Add to Home Screen) and open it from there.'
            : support === 'unsupported'
              ? 'This browser cannot receive push notifications.'
              : 'Push notifications are not available on this server.'}
        </p>
      ) : (
        <div className="stack">
          <p>
            {state === 'on'
              ? 'Notifications are on. You are notified while Tessera is closed; the server only learns that something is new, never what.'
              : 'Notifications are off for this browser.'}
          </p>
          <div>
            {state === 'on' ? (
              <Button
                variant="secondary"
                loading={busy}
                loadingLabel="Turning off"
                onClick={() => void turnOff()}
              >
                Turn off notifications
              </Button>
            ) : (
              <Button loading={busy} loadingLabel="Turning on" onClick={() => void turnOn()}>
                Turn on notifications
              </Button>
            )}
          </div>
        </div>
      )}
      <label className="t-field">
        <span className="t-field__label">Notifications show</span>
        <select
          className="t-field__input"
          value={preview}
          onChange={(e) => void changePreview(e.target.value as PreviewLevel)}
        >
          {PREVIEW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="t-field__hint">
          Messages are decrypted on this device to write the notification. This setting stays on
          this device; anyone who can see your screen can read what it shows.
        </span>
      </label>
    </section>
  );
}

/** Server-side rules: which events may wake your devices, and when not. */
function Rules(): ReactNode {
  const [preferences, setPreferences] = useState<NotificationPreferences>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();

  useEffect(() => {
    endpoints
      .notificationPreferences()
      .then(setPreferences, (caught: unknown) =>
        setMessage({ tone: 'danger', text: errorMessage(caught) }),
      );
  }, []);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (preferences === undefined) return;
    setBusy(true);
    setMessage(undefined);
    try {
      setPreferences(await endpoints.setNotificationPreferences(preferences));
      setMessage({ tone: 'success', text: 'Notification settings saved.' });
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  if (preferences === undefined)
    return (
      <section
        className="settings-section"
        aria-busy="true"
        aria-label="Loading notification rules"
      >
        {message === undefined ? <Skeleton height="6rem" shape="tile" /> : null}
        {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      </section>
    );

  const quiet = preferences.quietHours;
  const update = (change: Partial<NotificationPreferences>) =>
    setPreferences({ ...preferences, ...change });

  return (
    <form
      className="settings-section stack"
      aria-labelledby="notify-rules"
      onSubmit={(event) => void save(event)}
    >
      <h2 id="notify-rules">What can notify you</h2>
      <p className="t-field__hint">
        These apply to all your devices. Security alerts always reach you.
      </p>
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={preferences.messages}
          onChange={(e) => update({ messages: e.target.checked })}
        />
        <span>Messages</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={preferences.calls}
          onChange={(e) => update({ calls: e.target.checked })}
        />
        <span>Calls</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={preferences.channelPosts}
          onChange={(e) => update({ channelPosts: e.target.checked })}
        />
        <span>Posts in channels you turned notifications on for</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={quiet !== null}
          onChange={(e) =>
            update({
              quietHours: e.target.checked
                ? {
                    start: 22 * 60,
                    end: 7 * 60,
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    allowCalls: true,
                  }
                : null,
            })
          }
        />
        <span>Quiet hours</span>
      </label>
      {quiet === null ? null : (
        <fieldset className="stack">
          <legend>Quiet hours</legend>
          <div className="button-row">
            <label className="t-field">
              <span className="t-field__label">From</span>
              <input
                type="time"
                className="t-field__input"
                value={toTime(quiet.start)}
                onChange={(e) =>
                  update({ quietHours: { ...quiet, start: fromTime(e.target.value) } })
                }
              />
            </label>
            <label className="t-field">
              <span className="t-field__label">To</span>
              <input
                type="time"
                className="t-field__input"
                value={toTime(quiet.end)}
                onChange={(e) =>
                  update({ quietHours: { ...quiet, end: fromTime(e.target.value) } })
                }
              />
            </label>
          </div>
          <label className="t-field">
            <span className="t-field__label">Time zone</span>
            <select
              className="t-field__input"
              value={quiet.timeZone}
              onChange={(e) => update({ quietHours: { ...quiet, timeZone: e.target.value } })}
            >
              {timeZones().map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={quiet.allowCalls}
              onChange={(e) => update({ quietHours: { ...quiet, allowCalls: e.target.checked } })}
            />
            <span>Let one-to-one calls ring during quiet hours</span>
          </label>
        </fieldset>
      )}
      <div>
        <Button type="submit" loading={busy} loadingLabel="Saving">
          Save
        </Button>
      </div>
    </form>
  );
}

function MutedChats(): ReactNode {
  const { me } = useSession();
  const messaging = useMessaging();
  const [mutes, setMutes] = useState<ConversationMute[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    endpoints.mutes().then(
      (result) => setMutes(result.mutes),
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);
  useEffect(load, [load]);

  async function unmute(conversationId: string) {
    setError(undefined);
    try {
      await endpoints.unmute(conversationId);
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const title = (conversationId: string) => {
    const conversation = messaging.conversations.find((c) => c.meta.id === conversationId);
    return conversation === undefined
      ? 'A conversation'
      : conversationTitle(conversation, me?.id ?? '', messaging.spaces[conversationId]);
  };

  return (
    <section className="settings-section stack" aria-labelledby="muted-chats">
      <h2 id="muted-chats">Muted chats</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {mutes === undefined ? (
        <Skeleton height="2rem" shape="tile" />
      ) : mutes.length === 0 ? (
        <p>No muted chats. Mute a chat from its details.</p>
      ) : (
        <ul className="stack" aria-label="Muted chats">
          {mutes.map((mute) => (
            <li key={mute.conversationId} className="button-row">
              <span>
                {title(mute.conversationId)} ·{' '}
                {mute.until === null
                  ? 'until you unmute'
                  : `until ${new Date(mute.until).toLocaleString()}`}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void unmute(mute.conversationId)}>
                Unmute
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NotificationsPage(): ReactNode {
  return (
    <div className="settings-page">
      <PageHeading description="Notifications never contain your messages on their way to you: your device decrypts them and decides what to show.">
        Notifications
      </PageHeading>
      <ThisBrowser />
      <Rules />
      <MutedChats />
    </div>
  );
}
