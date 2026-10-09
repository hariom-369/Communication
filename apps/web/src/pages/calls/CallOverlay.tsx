import { Alert, Button } from '@tessera/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { callErrorMessage, type CallManager, type CallSnapshot } from '../../calls/manager.js';
import { useCalls, useMessaging } from '../../messaging/provider.js';
import { useSession } from '../../state/session.js';
import { conversationTitle } from '../chats/titles.js';

/** Plays a stream or track in a media element (local previews are muted). */
function Media({
  source,
  kind,
  muted,
  label,
  className,
}: {
  source: MediaStream | MediaStreamTrack | null;
  kind: 'video' | 'audio';
  muted?: boolean;
  label: string;
  className?: string;
}): ReactNode {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.srcObject =
      source === null ? null : source instanceof MediaStream ? source : new MediaStream([source]);
  }, [source]);
  if (kind === 'audio') return <audio ref={ref} autoPlay aria-label={label} />;
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted === true}
      aria-label={label}
      className={className}
    />
  );
}

function duration(since: number | null, now: number): string {
  if (since === null) return '';
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Microphone and camera choice (switched without interrupting the call). */
function DevicePicker({ manager, media }: { manager: CallManager; media: 'audio' | 'video' }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices.enumerateDevices().then((list) => {
      if (!cancelled) setDevices(list.filter((d) => d.deviceId !== ''));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const select = (kind: 'audioinput' | 'videoinput', label: string) => {
    const options = devices.filter((d) => d.kind === kind);
    if (options.length < 2) return null;
    return (
      <label className="t-field call__device">
        <span className="t-field__label">{label}</span>
        <select
          className="t-field__input"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value === '') return;
            manager.switchDevice(kind, e.target.value).catch((caught: unknown) => {
              setError(callErrorMessage(caught));
            });
          }}
        >
          <option value="">Default</option>
          {options.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label === '' ? `${label} ${i + 1}` : d.label}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="call__devices">
      {select('audioinput', 'Microphone')}
      {media === 'video' ? select('videoinput', 'Camera') : null}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

const PHASE_TEXT: Partial<Record<CallSnapshot['phase'], string>> = {
  outgoing: 'Calling…',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
};

function InCall({
  manager,
  call,
  title,
}: {
  manager: CallManager;
  call: CallSnapshot;
  title: string;
}) {
  const now = useClock();
  const [error, setError] = useState<string>();
  const { conversations } = useMessaging();
  const members = conversations.find((c) => c.meta.id === call.conversationId)?.meta.members ?? [];
  const name = (userId: string | null) =>
    `@${members.find((m) => m.userId === userId)?.username ?? 'someone'}`;
  const act = (work: () => Promise<void>) => {
    setError(undefined);
    work().catch((caught: unknown) => setError(callErrorMessage(caught)));
  };
  const status =
    call.phase === 'connected'
      ? `Connected ${duration(call.connectedAt, now)}`
      : (PHASE_TEXT[call.phase] ?? '');
  const quality = call.quality;
  return (
    <section className="call" aria-label="Call" role="region">
      <header className="call__header">
        <h2 className="call__title">{title}</h2>
        <p className="call__status" aria-live="polite">
          {status}
        </p>
        <p className="call__security">
          {call.mode === 'p2p'
            ? call.verifiedFingerprint === null
              ? 'End-to-end encrypted'
              : 'End-to-end encrypted · connection verified'
            : call.keyEpoch === null
              ? 'End-to-end encrypted'
              : `End-to-end encrypted · key epoch ${call.keyEpoch}`}
          {quality === null || call.mode === 'sfu'
            ? null
            : ` · Connection ${quality.level === 'unknown' ? 'checking' : quality.level}${
                quality.relayed === null ? '' : quality.relayed ? ' · relayed' : ' · direct'
              }`}
        </p>
      </header>
      {call.mode === 'p2p' ? (
        <div className="call__stage">
          {call.media === 'video' || call.sharing ? (
            <Media
              source={call.remoteStream}
              kind="video"
              label={`Video from ${name(call.peerUserId)}`}
              className="call__remote"
            />
          ) : (
            <>
              <p className="call__avatar" aria-hidden="true">
                {name(call.peerUserId).slice(1, 2).toUpperCase()}
              </p>
              <Media
                source={call.remoteStream}
                kind="audio"
                label={`Audio from ${name(call.peerUserId)}`}
              />
            </>
          )}
          {call.media === 'video' && call.localStream !== null ? (
            <Media
              source={call.localStream}
              kind="video"
              muted
              label="Your camera"
              className="call__self"
            />
          ) : null}
        </div>
      ) : (
        <ul className="call__grid" aria-label="Participants">
          {call.participants.map((p) => {
            const who = p.local ? 'You' : name(p.userId);
            const encrypted = p.local || call.decrypting.includes(p.deviceId);
            // A muted participant without camera or screen sends nothing to decrypt.
            const sending = !p.muted || p.video !== null || p.screen !== null;
            return (
              <li
                key={p.deviceId}
                className={p.speaking ? 'call__tile call__tile--speaking' : 'call__tile'}
              >
                {p.screen !== null ? (
                  <Media
                    source={p.screen}
                    kind="video"
                    muted={p.local}
                    label={`Screen shared by ${who}`}
                  />
                ) : p.video !== null ? (
                  <Media
                    source={p.video}
                    kind="video"
                    muted={p.local}
                    label={`Video from ${who}`}
                  />
                ) : (
                  <p className="call__avatar" aria-hidden="true">
                    {who.replace('@', '').slice(0, 1).toUpperCase()}
                  </p>
                )}
                {p.audio === null ? null : (
                  <Media source={p.audio} kind="audio" label={`Audio from ${who}`} />
                )}
                <p className="call__tile-label">
                  {who}
                  {p.muted ? ' · muted' : ''}
                  {p.local || (!encrypted && !sending)
                    ? ''
                    : encrypted
                      ? ' · decrypting'
                      : ' · waiting for keys'}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="call__controls" role="group" aria-label="Call controls">
        <Button
          variant="secondary"
          aria-pressed={call.muted}
          onClick={() => act(() => manager.setMuted(!call.muted))}
        >
          {call.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={!call.cameraOn}
          onClick={() => act(() => manager.setCamera(!call.cameraOn))}
        >
          {call.cameraOn ? 'Turn camera off' : 'Turn camera on'}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={call.sharing}
          onClick={() => act(() => manager.setSharing(!call.sharing))}
        >
          {call.sharing ? 'Stop sharing' : 'Share screen'}
        </Button>
        <Button variant="danger" onClick={() => act(() => manager.hangUp())}>
          Hang up
        </Button>
      </div>
      <DevicePicker manager={manager} media={call.media} />
    </section>
  );
}

/** Incoming calls, group-call invitations and the active call, over every page. */
export function CallOverlay(): ReactNode {
  const { manager, call } = useCalls();
  const messaging = useMessaging();
  const { me } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  if (manager === null) return null;
  const titleOf = (conversationId: string | null) => {
    const conversation = messaging.conversations.find((c) => c.meta.id === conversationId);
    return conversation === undefined
      ? 'Call'
      : conversationTitle(conversation, me?.id ?? '', messaging.spaces[conversation.meta.id]);
  };
  const act = (work: () => Promise<void>) => {
    setError(undefined);
    work().catch((caught: unknown) => setError(callErrorMessage(caught)));
  };

  return (
    <div className="call-layer">
      {error === undefined ? null : (
        <Alert tone="danger">
          {error}{' '}
          <Button size="sm" variant="ghost" onClick={() => setError(undefined)}>
            Dismiss
          </Button>
        </Alert>
      )}
      {call.groupInvites.map((invite) => (
        <div key={invite.callId} className="call-invite" role="status">
          <p>A group call is going on in {titleOf(invite.conversationId)}.</p>
          <div className="button-row">
            <Button
              size="sm"
              onClick={() => act(() => manager.join(invite.conversationId, invite.callId))}
            >
              Join call
            </Button>
            <Button size="sm" variant="ghost" onClick={() => manager.dismissInvite(invite.callId)}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
      {call.phase === 'incoming' ? (
        <div
          className="call-incoming"
          role="alertdialog"
          aria-label="Incoming call"
          aria-describedby="incoming-text"
        >
          <p id="incoming-text">
            {titleOf(call.conversationId)} is calling you (
            {call.media === 'video' ? 'video' : 'voice'} call)
          </p>
          <p className="t-field__hint">End-to-end encrypted</p>
          <div className="button-row">
            <Button
              onClick={() =>
                act(async () => {
                  await manager.accept();
                  if (call.conversationId !== null) void navigate(`/chats/${call.conversationId}`);
                })
              }
            >
              Accept
            </Button>
            <Button variant="danger" onClick={() => act(() => manager.decline())}>
              Decline
            </Button>
          </div>
        </div>
      ) : null}
      {call.phase === 'ended' && call.notice !== null ? (
        <p className="call-ended" role="status">
          {call.notice}
        </p>
      ) : null}
      {call.phase === 'outgoing' ||
      call.phase === 'connecting' ||
      call.phase === 'connected' ||
      call.phase === 'reconnecting' ? (
        <InCall manager={manager} call={call} title={titleOf(call.conversationId)} />
      ) : null}
    </div>
  );
}
