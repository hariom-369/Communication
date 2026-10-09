import { CALL_HEARTBEAT_SECONDS, CALL_RING_SECONDS, type IceConfig } from '@tessera/validation';

import type { endpoints as Endpoints } from '../api/endpoints.js';
import { ApiError, errorMessage } from '../api/client.js';
import type { CallSecret } from '../crypto/protocol.js';
import type { ConversationSecurity } from '../messaging/e2ee.js';
import type {
  CallFrame,
  CallSignalBody,
  CallSignalEvent,
  MessagingStore,
} from '../messaging/store.js';

import type { GroupCall, GroupParticipant } from './group-call.js';
import { groupCallsSupported } from './media-e2ee.js';
import type { MediaWorkerStats } from './media-worker.js';
import { PeerCall, type PeerState } from './peer-call.js';
import type { CallQuality } from './quality.js';
import { Ringer } from './ringer.js';

/**
 * Calls on this device (docs/calling.md): one call at a time, 1:1 (peer to peer, ADR-016) or
 * group (SFU with SFrame, ADR-017/047). Signalling is end-to-end encrypted messages; the server
 * only keeps the call record and hands out relay credentials and SFU tokens.
 */

export type CallPhase =
  'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface CallSnapshot {
  readonly phase: CallPhase;
  readonly callId: string | null;
  readonly conversationId: string | null;
  readonly mode: 'p2p' | 'sfu';
  readonly media: 'audio' | 'video';
  /** The other person (1:1). */
  readonly peerUserId: string | null;
  readonly connectedAt: number | null;
  readonly muted: boolean;
  readonly cameraOn: boolean;
  readonly sharing: boolean;
  readonly quality: CallQuality | null;
  /** 1:1: the peer's DTLS certificate matched the end-to-end encrypted fingerprint. */
  readonly verifiedFingerprint: string | null;
  /** Group: the MLS epoch whose key this device currently sends with. */
  readonly keyEpoch: number | null;
  readonly localStream: MediaStream | null;
  readonly remoteStream: MediaStream | null;
  readonly participants: readonly (GroupParticipant & { readonly userId: string | null })[];
  /** Group: frames from these devices decrypted in the last second. */
  readonly decrypting: readonly string[];
  readonly notice: string | null;
  /** A group call going on in a conversation this user is in (not joined). */
  readonly groupInvites: readonly { conversationId: string; callId: string }[];
}

type RelayPolicy = 'always' | 'unverified' | 'never';

export interface CallManagerDeps {
  readonly api: Pick<
    typeof Endpoints,
    | 'startCall'
    | 'joinCall'
    | 'leaveCall'
    | 'callHeartbeat'
    | 'iceServers'
    | 'call'
    | 'callCapabilities'
    | 'privacy'
  >;
  readonly store: Pick<
    MessagingStore,
    'onCallSignal' | 'onCallFrame' | 'onCommit' | 'sendCallSignal' | 'getSnapshot'
  >;
  readonly security: {
    readonly deviceId: string | null;
    callSecret(conversationId: string, callId: string): Promise<CallSecret>;
    security(conversationId: string): ConversationSecurity;
  };
  readonly me: string;
  /** Group calls are loaded on demand (the SFU client is large). */
  readonly loadGroupCall?: () => Promise<typeof GroupCall>;
}

export const IDLE_CALL: CallSnapshot = {
  phase: 'idle',
  callId: null,
  conversationId: null,
  mode: 'p2p',
  media: 'audio',
  peerUserId: null,
  connectedAt: null,
  muted: false,
  cameraOn: false,
  sharing: false,
  quality: null,
  verifiedFingerprint: null,
  keyEpoch: null,
  localStream: null,
  remoteStream: null,
  participants: [],
  decrypting: [],
  notice: null,
  groupInvites: [],
};

/** Reconnecting gives up after this long. */
const RECONNECT_GIVE_UP_MS = 40_000;
const RESTART_EVERY_MS = 8_000;
/** How long "Call ended" stays on screen. */
const ENDED_DISPLAY_MS = 3_000;

const toIce = (config: IceConfig): RTCIceServer[] =>
  config.iceServers.map((server) => ({
    urls: server.urls,
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(server.credential === undefined ? {} : { credential: server.credential }),
  }));

const base64Bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export class CallError extends Error {}

/** User-facing text for a failure to start, answer or control a call. */
export function callErrorMessage(error: unknown): string {
  if (error instanceof CallError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return 'Allow access to your microphone and camera in the browser to make calls.';
    if (error.name === 'NotFoundError') return 'No microphone or camera was found.';
    if (error.name === 'NotReadableError')
      return 'Your microphone or camera is being used by another app.';
  }
  // The SFU client's connection failures (signalling or media path).
  if (error instanceof Error && error.name === 'ConnectionError')
    return 'Could not connect to the call. Check your connection and try again.';
  return errorMessage(error);
}

export class CallManager {
  readonly #deps: CallManagerDeps;
  readonly #listeners = new Set<() => void>();
  #snapshot: CallSnapshot = IDLE_CALL;
  #peer: PeerCall | null = null;
  #group: GroupCall | null = null;
  #role: 'caller' | 'callee' = 'caller';
  /** The other device of a 1:1 call, once known. */
  #peerDevice: string | null = null;
  #pendingOffer: { sdp: string; fromDevice: string } | null = null;
  #members = new Map<number, { userId: string; deviceId: string }>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #statsTimer: ReturnType<typeof setInterval> | null = null;
  #lostAt: number | null = null;
  #ringer = new Ringer();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(deps: CallManagerDeps) {
    this.#deps = deps;
    this.#unsubscribe.push(
      deps.store.onCallSignal((event) => void this.#onSignal(event).catch(() => undefined)),
      deps.store.onCallFrame((frame) => this.#onFrame(frame)),
      deps.store.onCommit((conversationId) => void this.#rekey(conversationId)),
    );
    const online = () => {
      if (this.#role === 'caller' && this.#peer !== null && this.#snapshot.phase !== 'outgoing')
        void this.#restart();
    };
    window.addEventListener('online', online);
    this.#unsubscribe.push(() => window.removeEventListener('online', online));
  }

  // ---- React integration -------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot => this.#snapshot;

  #set(change: Partial<CallSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    for (const stop of this.#unsubscribe) stop();
    void this.hangUp();
  }

  // ---- starting and answering --------------------------------------------------------------------

  #deviceId(): string {
    const deviceId = this.#deps.security.deviceId;
    if (deviceId === null) throw new CallError('Set up encryption on this device first.');
    return deviceId;
  }

  #conversation(conversationId: string) {
    const conversation = this.#deps.store
      .getSnapshot()
      .conversations.find((c) => c.meta.id === conversationId);
    if (conversation === undefined) throw new CallError('This chat is not available.');
    return conversation;
  }

  /** Relay unless the policy allows a direct connection to this person. */
  async #relayOnly(conversationId: string, peerUserId: string): Promise<boolean> {
    const settings = await this.#deps.api.privacy();
    const policy: RelayPolicy = settings.callRelay;
    if (policy === 'always') return true;
    if (policy === 'never') return false;
    return !this.#deps.security.security(conversationId).verified.includes(peerUserId);
  }

  async start(conversationId: string, media: 'audio' | 'video'): Promise<void> {
    // They are calling this chat right now: calling back answers.
    if (this.#snapshot.phase === 'incoming' && this.#snapshot.conversationId === conversationId) {
      await this.accept();
      return;
    }
    if (this.#snapshot.phase !== 'idle' && this.#snapshot.phase !== 'ended')
      throw new CallError('You are already in a call.');
    const conversation = this.#conversation(conversationId);
    const deviceId = this.#deviceId();
    if (conversation.meta.kind === 'group') {
      await this.#startGroup(conversationId, media, deviceId);
      return;
    }
    const peerUserId = conversation.meta.members.find((m) => m.userId !== this.#deps.me)?.userId;
    if (peerUserId === undefined) throw new CallError('There is nobody else in this chat.');
    if (conversation.security.keyChanged.length > 0)
      throw new CallError('Review the safety number change in this chat before calling.');
    const relayOnly = await this.#relayOnly(conversationId, peerUserId);
    const { call, created, ice } = await this.#deps.api.startCall(conversationId, media, deviceId);
    if (!created) {
      // They called at the same moment (their offer is on its way and will ring here), or a call
      // from another of my devices is still going on.
      throw new CallError(
        call.initiatorUserId === this.#deps.me
          ? 'You are already in a call in this chat on another device.'
          : 'They are calling you right now.',
      );
    }
    if (relayOnly && !ice.relayAvailable) {
      await this.#deps.api.leaveCall(call.id, deviceId, 'failed').catch(() => undefined);
      throw new CallError(
        'Calls cannot be relayed on this server. To call directly, change “Relay calls” in Privacy settings.',
      );
    }
    this.#reset();
    this.#role = 'caller';
    this.#set({
      ...IDLE_CALL,
      groupInvites: this.#snapshot.groupInvites,
      phase: 'outgoing',
      callId: call.id,
      conversationId,
      mode: 'p2p',
      media,
      peerUserId,
      cameraOn: media === 'video',
    });
    try {
      const peer = this.#newPeer(media, toIce(ice), relayOnly);
      const local = await peer.startMedia();
      this.#set({ localStream: local });
      const sdp = await peer.createOffer();
      if (this.#snapshot.callId !== call.id) return; // hung up meanwhile
      await this.#signal({ signal: 'offer', sdp });
    } catch (error) {
      await this.#finish('failed', true);
      throw error;
    }
    this.#startHeartbeat();
    this.#later(() => {
      if (this.#snapshot.phase === 'outgoing' && this.#snapshot.callId === call.id)
        void this.#finish('missed', true, 'No answer.');
    }, CALL_RING_SECONDS * 1000);
  }

  async accept(): Promise<void> {
    const { callId, conversationId, media, peerUserId } = this.#snapshot;
    const offer = this.#pendingOffer;
    if (
      this.#snapshot.phase !== 'incoming' ||
      callId === null ||
      conversationId === null ||
      offer === null
    )
      return;
    this.#ringer.stop();
    const deviceId = this.#deviceId();
    this.#role = 'callee';
    this.#peerDevice = offer.fromDevice;
    this.#set({ phase: 'connecting', cameraOn: media === 'video' });
    try {
      const joined = await this.#deps.api.joinCall(callId, deviceId);
      const relayOnly = await this.#relayOnly(conversationId, peerUserId ?? '');
      if (relayOnly && !joined.ice.relayAvailable)
        throw new CallError(
          'Calls cannot be relayed on this server. To answer directly, change “Relay calls” in Privacy settings.',
        );
      const peer = this.#newPeer(media, toIce(joined.ice), relayOnly);
      this.#set({ localStream: await peer.startMedia() });
      const sdp = await peer.acceptOffer(offer.sdp);
      await this.#signal({ signal: 'answer', sdp, toDevice: offer.fromDevice });
      this.#startHeartbeat();
    } catch (error) {
      await this.#finish('failed', true, error instanceof CallError ? error.message : null);
      throw error;
    }
  }

  async decline(): Promise<void> {
    if (this.#snapshot.phase !== 'incoming') return;
    await this.#finish('declined', true, null);
  }

  async hangUp(): Promise<void> {
    const phase = this.#snapshot.phase;
    if (phase === 'idle' || phase === 'ended') return;
    if (phase === 'incoming') {
      await this.decline();
      return;
    }
    await this.#finish(phase === 'outgoing' ? 'missed' : 'hangup', true, null);
  }

  // ---- group calls -------------------------------------------------------------------------------

  /** Refusal text when this browser cannot encrypt group-call media (no silent downgrade). */
  static groupCallRefusal(): string | null {
    return groupCallsSupported()
      ? null
      : 'This browser cannot end-to-end encrypt group calls, so they are not available here. Use a current version of Chrome, Edge, Firefox or Safari.';
  }

  async #startGroup(conversationId: string, media: 'audio' | 'video', deviceId: string) {
    const refusal = CallManager.groupCallRefusal();
    if (refusal !== null) throw new CallError(refusal);
    const { call, created } = await this.#deps.api.startCall(conversationId, media, deviceId);
    if (created)
      void this.#deps.store
        .sendCallSignal(conversationId, { kind: 'call', callId: call.id, signal: 'group', media })
        .catch(() => undefined);
    await this.join(conversationId, call.id, media);
  }

  /** Joins a group call; with the call's own media (voice or video) unless `media` is given. */
  async join(conversationId: string, callId: string, media?: 'audio' | 'video'): Promise<void> {
    const refusal = CallManager.groupCallRefusal();
    if (refusal !== null) throw new CallError(refusal);
    if (this.#snapshot.phase !== 'idle' && this.#snapshot.phase !== 'ended')
      throw new CallError('You are already in a call.');
    const deviceId = this.#deviceId();
    this.#reset();
    this.#set({
      ...IDLE_CALL,
      groupInvites: this.#snapshot.groupInvites.filter((i) => i.callId !== callId),
      phase: 'connecting',
      callId,
      conversationId,
      mode: 'sfu',
      media: media ?? 'audio',
      cameraOn: false,
    });
    try {
      const joined = await this.#deps.api.joinCall(callId, deviceId);
      if (joined.sfu === null) throw new CallError('Group calls are not available on this server.');
      const callMedia = media ?? joined.call.media;
      this.#set({ media: callMedia, cameraOn: callMedia === 'video' });
      const secret = await this.#deps.security.callSecret(conversationId, callId);
      this.#rememberMembers(secret);
      const load =
        this.#deps.loadGroupCall ?? (async () => (await import('./group-call.js')).GroupCall);
      const GroupCallClass = await load();
      const group = new GroupCallClass({
        media: callMedia,
        onChange: () => this.#refreshParticipants(),
        onStats: (stats) => this.#onMediaStats(stats),
        onDisconnected: () =>
          void this.#finish('hangup', true, 'You were disconnected from the call.'),
      });
      this.#group = group;
      await group.connect(joined.sfu.url, joined.sfu.token, {
        epoch: secret.epoch,
        secret: base64Bytes(secret.secret),
        ownIndex: secret.ownIndex,
      });
      this.#set({ phase: 'connected', connectedAt: Date.now(), keyEpoch: secret.epoch });
      this.#refreshParticipants();
      this.#startHeartbeat();
      // Epoch changes normally arrive through commits; this catches any missed one.
      this.#statsTimer = setInterval(() => void this.#rekey(conversationId), 5000);
    } catch (error) {
      await this.#finish('failed', true, error instanceof CallError ? error.message : null);
      throw error;
    }
  }

  #rememberMembers(secret: CallSecret): void {
    this.#members = new Map(
      secret.members.map((m) => [m.index, { userId: m.userId, deviceId: m.deviceId }]),
    );
  }

  /** Membership changed (MLS commit): switch to the new epoch's key. */
  async #rekey(conversationId: string): Promise<void> {
    const { callId, mode, keyEpoch } = this.#snapshot;
    if (mode !== 'sfu' || this.#group === null || callId === null) return;
    if (this.#snapshot.conversationId !== conversationId) return;
    try {
      const secret = await this.#deps.security.callSecret(conversationId, callId);
      if (secret.epoch === keyEpoch) return;
      this.#rememberMembers(secret);
      this.#group.setEpoch(secret.epoch, base64Bytes(secret.secret), secret.ownIndex);
      this.#set({ keyEpoch: secret.epoch });
      this.#refreshParticipants();
    } catch {
      // No group any more (removed): the server drops us from the call; heartbeat ends it here.
    }
  }

  #refreshParticipants(): void {
    const group = this.#group;
    if (group === null) return;
    const byDevice = new Map([...this.#members.values()].map((m) => [m.deviceId, m.userId]));
    this.#set({
      participants: group
        .participants()
        .map((p) => ({ ...p, userId: byDevice.get(p.deviceId) ?? null })),
      sharing: group.sharing,
    });
  }

  #onMediaStats(stats: MediaWorkerStats): void {
    const devices = stats.senders
      .map((index) => this.#members.get(index)?.deviceId)
      .filter((d): d is string => d !== undefined);
    this.#set({ decrypting: devices });
  }

  // ---- in-call controls --------------------------------------------------------------------------

  async setMuted(muted: boolean): Promise<void> {
    this.#peer?.setMuted(muted);
    await this.#group?.setMuted(muted);
    this.#set({ muted });
  }

  async setCamera(on: boolean): Promise<void> {
    await this.#peer?.setCamera(on);
    await this.#group?.setCamera(on);
    this.#set({ cameraOn: on, localStream: this.#peer?.localStream ?? this.#snapshot.localStream });
    this.#refreshParticipants();
  }

  async setSharing(on: boolean): Promise<void> {
    if (this.#peer !== null) {
      if (on) await this.#peer.shareScreen();
      else await this.#peer.stopSharing();
      this.#set({ sharing: this.#peer.sharingScreen });
    }
    if (this.#group !== null) {
      await this.#group.setSharing(on);
      this.#refreshParticipants();
    }
  }

  async switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    await this.#peer?.switchDevice(kind, deviceId);
    await this.#group?.switchDevice(kind, deviceId);
    this.#set({ localStream: this.#peer?.localStream ?? this.#snapshot.localStream });
  }

  dismissInvite(callId: string): void {
    this.#set({ groupInvites: this.#snapshot.groupInvites.filter((i) => i.callId !== callId) });
  }

  // ---- signalling --------------------------------------------------------------------------------

  #signal(body: Omit<CallSignalBody, 'kind' | 'callId' | 'media'>): Promise<void> {
    const { conversationId, callId, media } = this.#snapshot;
    if (conversationId === null || callId === null) return Promise.resolve();
    return this.#deps.store.sendCallSignal(conversationId, {
      kind: 'call',
      callId,
      media,
      ...body,
    });
  }

  async #onSignal(event: CallSignalEvent): Promise<void> {
    const { body } = event;
    const mine = this.#snapshot.callId === body.callId;
    const myDevice = this.#deps.security.deviceId;
    switch (body.signal) {
      case 'offer':
        await this.#onOffer(event);
        return;
      case 'answer':
        if (!mine) return;
        if (
          body.toDevice === myDevice &&
          this.#snapshot.phase === 'outgoing' &&
          body.sdp !== undefined
        ) {
          this.#peerDevice = event.senderDeviceId;
          this.#set({ phase: 'connecting' });
          await this.#peer?.acceptAnswer(body.sdp).catch(() => this.#securityFailure());
        } else if (this.#snapshot.phase === 'incoming' && event.senderUserId === this.#deps.me) {
          this.#ringer.stop();
          this.#closeLocally('Answered on another device.');
        }
        return;
      case 'update':
        if (!mine || body.toDevice !== myDevice || event.senderDeviceId !== this.#peerDevice)
          return;
        if (body.sdp === undefined || this.#peer === null) return;
        try {
          const sdp = await this.#peer.acceptOffer(body.sdp);
          await this.#signal({ signal: 'update_answer', sdp, toDevice: event.senderDeviceId });
        } catch {
          this.#securityFailure();
        }
        return;
      case 'update_answer':
        if (!mine || body.toDevice !== myDevice || event.senderDeviceId !== this.#peerDevice)
          return;
        if (body.sdp !== undefined)
          await this.#peer?.acceptAnswer(body.sdp).catch(() => this.#securityFailure());
        return;
      case 'end':
        if (!mine || this.#snapshot.mode !== 'p2p') return;
        // Only the call's two sides end it (the other person, or my other device declining).
        if (
          this.#snapshot.phase === 'incoming' ||
          event.senderDeviceId === this.#peerDevice ||
          this.#snapshot.phase === 'outgoing'
        ) {
          this.#ringer.stop();
          this.#closeLocally(
            body.reason === 'declined'
              ? 'Call declined.'
              : body.reason === 'busy'
                ? 'They are on another call.'
                : body.reason === 'missed'
                  ? 'Missed call.'
                  : 'Call ended.',
          );
        }
        return;
      case 'group':
        return;
    }
  }

  async #onOffer(event: CallSignalEvent): Promise<void> {
    const { body } = event;
    if (event.senderUserId === this.#deps.me || body.sdp === undefined) return;
    // Old offers arrive when catching up after being offline: shown as missed in the chat only.
    if (Date.now() - event.serverTime > CALL_RING_SECONDS * 1000) return;
    const busy = this.#snapshot.phase !== 'idle' && this.#snapshot.phase !== 'ended';
    if (busy) {
      if (this.#snapshot.callId === body.callId) return;
      const deviceId = this.#deps.security.deviceId;
      void this.#deps.store
        .sendCallSignal(event.conversationId, {
          kind: 'call',
          callId: body.callId,
          signal: 'end',
          reason: 'busy',
          media: body.media,
        })
        .catch(() => undefined);
      if (deviceId !== null)
        void this.#deps.api.leaveCall(body.callId, deviceId, 'busy').catch(() => undefined);
      return;
    }
    // The server still has it ringing (the caller has not given up meanwhile).
    const record = await this.#deps.api.call(body.callId).catch(() => null);
    if (record?.state !== 'ringing' || record.conversationId !== event.conversationId) return;
    if (record.initiatorUserId !== event.senderUserId) return;
    this.#reset();
    this.#pendingOffer = { sdp: body.sdp, fromDevice: event.senderDeviceId };
    this.#set({
      ...IDLE_CALL,
      groupInvites: this.#snapshot.groupInvites,
      phase: 'incoming',
      callId: body.callId,
      conversationId: event.conversationId,
      mode: 'p2p',
      media: body.media,
      peerUserId: event.senderUserId,
    });
    this.#ringer.start();
    this.#later(() => {
      if (this.#snapshot.phase === 'incoming' && this.#snapshot.callId === body.callId) {
        this.#ringer.stop();
        this.#closeLocally('Missed call.');
      }
    }, CALL_RING_SECONDS * 1000);
  }

  #onFrame(frame: CallFrame): void {
    if (frame.state === 'ended') {
      this.#set({
        groupInvites: this.#snapshot.groupInvites.filter((i) => i.callId !== frame.callId),
      });
      if (this.#snapshot.callId === frame.callId && this.#snapshot.phase !== 'ended') {
        this.#ringer.stop();
        void this.#endedByServer(frame.callId);
      }
      return;
    }
    if (
      frame.mode === 'sfu' &&
      frame.state === 'ringing' &&
      this.#snapshot.callId !== frame.callId &&
      !this.#snapshot.groupInvites.some((i) => i.callId === frame.callId)
    ) {
      this.#set({
        groupInvites: [
          ...this.#snapshot.groupInvites,
          { conversationId: frame.conversationId, callId: frame.callId },
        ],
      });
    }
  }

  /** The server says the call ended (the hint has no reason): show why, from the record. */
  async #endedByServer(callId: string): Promise<void> {
    const incoming = this.#snapshot.phase === 'incoming';
    const record = await this.#deps.api.call(callId).catch(() => null);
    if (this.#snapshot.callId !== callId) return; // already closed by the encrypted signal
    const reason = record?.endReason ?? null;
    this.#closeLocally(
      incoming
        ? 'Missed call.'
        : reason === 'declined'
          ? 'Call declined.'
          : reason === 'busy'
            ? 'They are on another call.'
            : reason === 'missed' && record?.initiatorUserId === this.#deps.me
              ? 'No answer.'
              : 'Call ended.',
    );
  }

  // ---- connection lifecycle ----------------------------------------------------------------------

  #newPeer(media: 'audio' | 'video', iceServers: RTCIceServer[], relayOnly: boolean): PeerCall {
    const peer = new PeerCall({
      media,
      iceServers,
      relayOnly,
      onState: (state) => this.#onPeerState(state),
      onRemoteStream: (stream) => this.#set({ remoteStream: stream }),
      onVerified: (fingerprint) => this.#set({ verifiedFingerprint: fingerprint }),
      onSecurityFailure: () => this.#securityFailure(),
    });
    this.#peer = peer;
    this.#statsTimer = setInterval(() => {
      void peer.quality().then(
        (quality) => this.#set({ quality }),
        () => undefined,
      );
    }, 2000);
    return peer;
  }

  #onPeerState(state: PeerState): void {
    if (state === 'connected') {
      this.#lostAt = null;
      this.#set({ phase: 'connected', connectedAt: this.#snapshot.connectedAt ?? Date.now() });
      return;
    }
    if (state === 'reconnecting' || state === 'failed') {
      if (this.#snapshot.phase !== 'connected' && this.#snapshot.phase !== 'reconnecting') {
        if (state === 'failed') void this.#finish('failed', true, 'The call could not connect.');
        return;
      }
      this.#set({ phase: 'reconnecting' });
      this.#lostAt ??= Date.now();
      // The caller restarts ICE (fresh relay credentials); the callee answers the update.
      if (this.#role === 'caller')
        this.#later(() => void this.#restart(), state === 'failed' ? 0 : 2000);
      this.#later(() => {
        if (
          this.#snapshot.phase === 'reconnecting' &&
          this.#lostAt !== null &&
          Date.now() - this.#lostAt >= RECONNECT_GIVE_UP_MS
        )
          void this.#finish('failed', true, 'The connection was lost.');
      }, RECONNECT_GIVE_UP_MS);
    }
  }

  async #restart(): Promise<void> {
    const peer = this.#peer;
    if (peer === null || this.#peerDevice === null) return;
    if (this.#snapshot.phase !== 'reconnecting' && this.#snapshot.phase !== 'connected') return;
    if (peer.state === 'connected') return;
    try {
      const ice = await this.#deps.api.iceServers();
      const sdp = await peer.restart(toIce(ice));
      await this.#signal({ signal: 'update', sdp, toDevice: this.#peerDevice });
    } catch {
      // Network still down: try again shortly.
    }
    this.#later(() => {
      if (this.#snapshot.phase === 'reconnecting') void this.#restart();
    }, RESTART_EVERY_MS);
  }

  #securityFailure(): void {
    void this.#finish(
      'failed',
      true,
      'The call was ended because the connection could not be verified as end-to-end encrypted.',
    );
  }

  #startHeartbeat(): void {
    const { callId } = this.#snapshot;
    const deviceId = this.#deps.security.deviceId;
    if (callId === null || deviceId === null) return;
    this.#heartbeat = setInterval(() => {
      this.#deps.api.callHeartbeat(callId, deviceId).catch((error: unknown) => {
        if (
          error instanceof ApiError &&
          error.problem.status === 404 &&
          this.#snapshot.callId === callId
        )
          this.#closeLocally('Call ended.');
      });
    }, CALL_HEARTBEAT_SECONDS * 1000);
  }

  #later(work: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      work();
    }, delayMs);
    this.#timers.add(timer);
  }

  /** Ends this device's part: tells the other side (1:1) and the server. */
  async #finish(
    reason: 'hangup' | 'declined' | 'busy' | 'failed' | 'missed',
    notify: boolean,
    notice: string | null = null,
  ): Promise<void> {
    const { callId, mode } = this.#snapshot;
    const deviceId = this.#deps.security.deviceId;
    if (notify && callId !== null && mode === 'p2p')
      await this.#signal({ signal: 'end', reason }).catch(() => undefined);
    if (callId !== null && deviceId !== null)
      await this.#deps.api.leaveCall(callId, deviceId, reason).catch(() => undefined);
    this.#closeLocally(notice ?? (reason === 'declined' ? null : 'Call ended.'));
  }

  #closeLocally(notice: string | null): void {
    this.#ringer.stop();
    this.#teardown();
    this.#set({
      ...IDLE_CALL,
      groupInvites: this.#snapshot.groupInvites,
      phase: notice === null ? 'idle' : 'ended',
      conversationId: this.#snapshot.conversationId,
      notice,
    });
    if (notice !== null)
      this.#later(() => {
        if (this.#snapshot.phase === 'ended')
          this.#set({ ...IDLE_CALL, groupInvites: this.#snapshot.groupInvites });
      }, ENDED_DISPLAY_MS);
  }

  #teardown(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    if (this.#statsTimer !== null) clearInterval(this.#statsTimer);
    this.#heartbeat = null;
    this.#statsTimer = null;
    this.#peer?.close();
    this.#peer = null;
    void this.#group?.close();
    this.#group = null;
    this.#pendingOffer = null;
    this.#peerDevice = null;
    this.#lostAt = null;
  }

  #reset(): void {
    this.#teardown();
  }
}
