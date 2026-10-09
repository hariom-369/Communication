import {
  ParticipantEvent,
  Room,
  RoomEvent,
  Track,
  type BaseE2EEManager,
  type LocalTrack,
  type Participant,
  type RemoteTrack,
} from 'livekit-client';

import { MediaE2ee } from './media-e2ee.js';
import type { MediaWorkerStats } from './media-worker.js';

/**
 * A group call through the SFU (ADR-017, ADR-047). LiveKit forwards media; every frame is
 * SFrame-encrypted on the sending device before it reaches the SFU (the transform is attached
 * when each sender is created, before any media flows) and decrypted only by members' devices.
 */

export interface GroupParticipant {
  /** Device ID (the SFU identity). */
  readonly deviceId: string;
  readonly local: boolean;
  readonly audio: MediaStreamTrack | null;
  readonly video: MediaStreamTrack | null;
  readonly screen: MediaStreamTrack | null;
  readonly speaking: boolean;
  readonly muted: boolean;
}

export interface GroupCallOptions {
  readonly media: 'audio' | 'video';
  readonly onChange: () => void;
  readonly onStats: (stats: MediaWorkerStats) => void;
  readonly onDisconnected: () => void;
}

/** `/sfu` on the web origin, or an absolute ws(s) URL. */
function socketUrl(url: string): string {
  if (!url.startsWith('/')) return url;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${url}`;
}

function frameKind(track: Track): 'audio' | 'video' {
  return track.kind === Track.Kind.Audio ? 'audio' : 'video';
}

/**
 * Plugs Tessera's SFrame pipeline into the SFU client as its end-to-end encryption manager. The
 * SFU client then creates its connections for encoded-frame access (holding frames until the
 * pipeline is attached) and labels the published tracks as end-to-end encrypted. It never sees a
 * key: keys come from MLS (manager.ts) and stay in the media worker.
 */
class SframeManager implements BaseE2EEManager {
  readonly isEnabled = true;
  /** Chat and reactions use the MLS conversation, not the SFU's data channel. */
  readonly isDataChannelEncryptionEnabled = false;
  readonly #e2ee: MediaE2ee;
  readonly #onChange: () => void;

  constructor(e2ee: MediaE2ee, onChange: () => void) {
    this.#e2ee = e2ee;
    this.#onChange = onChange;
  }

  setup(room: Room): void {
    // Before negotiation: no frame leaves this device unencrypted.
    room.localParticipant.on(ParticipantEvent.LocalSenderCreated, (sender, track) => {
      this.#e2ee.protect(sender, 'send', frameKind(track));
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.receiver !== undefined)
        this.#e2ee.protect(track.receiver, 'receive', frameKind(track));
      this.#onChange();
    });
  }

  setupEngine(): void {
    // Nothing to configure on the engine: frames are handled per sender and receiver.
  }

  setParticipantCryptorEnabled(): void {
    // Every participant is always encrypted; there is no per-participant switch.
  }

  setSifTrailer(): void {
    // SFrame needs no server-injected-frame trailer.
  }

  encryptData(): Promise<never> {
    return Promise.reject(new Error('The SFU data channel is not used.'));
  }

  handleEncryptedData(): Promise<never> {
    return Promise.reject(new Error('The SFU data channel is not used.'));
  }

  on(): this {
    return this;
  }
}

export class GroupCall {
  readonly #options: GroupCallOptions;
  readonly #e2ee = new MediaE2ee();
  readonly #room: Room;
  #closed = false;

  constructor(options: GroupCallOptions) {
    this.#options = options;
    this.#e2ee.onStats(options.onStats);
    this.#room = new Room({
      encryption: { e2eeManager: new SframeManager(this.#e2ee, () => options.onChange()) },
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      publishDefaults: {
        // VP8: the SFU reads only its clear payload header (frame-crypto.ts). No RED: it would
        // wrap encrypted audio in a format the SFU parses.
        videoCodec: 'vp8',
        backupCodec: false,
        red: false,
        dtx: true,
        simulcast: true,
      },
    });
    this.#room
      .on(RoomEvent.TrackUnsubscribed, () => options.onChange())
      .on(RoomEvent.ParticipantConnected, () => options.onChange())
      .on(RoomEvent.ParticipantDisconnected, () => options.onChange())
      .on(RoomEvent.TrackMuted, () => options.onChange())
      .on(RoomEvent.TrackUnmuted, () => options.onChange())
      .on(RoomEvent.LocalTrackPublished, () => options.onChange())
      .on(RoomEvent.LocalTrackUnpublished, () => options.onChange())
      .on(RoomEvent.ActiveSpeakersChanged, () => options.onChange())
      .on(RoomEvent.Disconnected, () => {
        if (!this.#closed) options.onDisconnected();
      });
  }

  /** Keys first, then connect and publish: nothing is sent before a key exists. */
  async connect(
    url: string,
    token: string,
    keys: { epoch: number; secret: Uint8Array; ownIndex: number },
  ): Promise<void> {
    this.#e2ee.setEpoch(keys.epoch, keys.secret, keys.ownIndex);
    await this.#room.setE2EEEnabled(true);
    await this.#room.connect(socketUrl(url), token, { autoSubscribe: true });
    await this.#room.localParticipant.setMicrophoneEnabled(true);
    if (this.#options.media === 'video') await this.#room.localParticipant.setCameraEnabled(true);
    this.#options.onChange();
  }

  /** A new MLS epoch (membership changed): new keys for sending, old ones kept briefly. */
  setEpoch(epoch: number, secret: Uint8Array, ownIndex: number): void {
    this.#e2ee.setEpoch(epoch, secret, ownIndex);
  }

  participants(): GroupParticipant[] {
    const describe = (participant: Participant, local: boolean): GroupParticipant => {
      const track = (source: Track.Source) =>
        participant.getTrackPublication(source)?.track?.mediaStreamTrack ?? null;
      const mic = participant.getTrackPublication(Track.Source.Microphone);
      return {
        deviceId: participant.identity,
        local,
        audio: local ? null : track(Track.Source.Microphone),
        video: track(Track.Source.Camera),
        screen: track(Track.Source.ScreenShare),
        speaking: participant.isSpeaking,
        muted: mic?.isMuted ?? true,
      };
    };
    return [
      describe(this.#room.localParticipant, true),
      ...[...this.#room.remoteParticipants.values()].map((p) => describe(p, false)),
    ];
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.#room.localParticipant.setMicrophoneEnabled(!muted);
  }

  async setCamera(on: boolean): Promise<void> {
    await this.#room.localParticipant.setCameraEnabled(on);
  }

  async setSharing(on: boolean): Promise<void> {
    await this.#room.localParticipant.setScreenShareEnabled(on, { audio: false });
  }

  get sharing(): boolean {
    return this.#room.localParticipant.isScreenShareEnabled;
  }

  async switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    await this.#room.switchActiveDevice(kind, deviceId);
  }

  localTracks(): LocalTrack[] {
    return [...this.#room.localParticipant.trackPublications.values()]
      .map((publication) => publication.track)
      .filter((track): track is LocalTrack => track !== undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#room.disconnect();
    this.#e2ee.close();
  }
}
