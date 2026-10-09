import { dtlsFingerprint, plausibleSdp, remoteCertificateMatches } from './sdp.js';
import { qualityFromStats, type CallQuality } from './quality.js';

/**
 * One 1:1 call (docs/calling.md §2, ADR-016): browser WebRTC with DTLS-SRTP, peer to peer or
 * through a TURN relay. Session descriptions are exchanged only through end-to-end encrypted
 * messages (the caller of this class sends and receives them), and they carry every network
 * candidate (no trickle), so a call needs one offer and one answer.
 *
 * After DTLS connects, the peer's certificate is checked against the fingerprint from the
 * encrypted description; any mismatch ends the call.
 */

export type PeerState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface PeerCallOptions {
  readonly media: 'audio' | 'video';
  readonly iceServers: RTCIceServer[];
  /** Offer only relayed paths, so the other person never learns this device's IP address. */
  readonly relayOnly: boolean;
  readonly onState: (state: PeerState) => void;
  readonly onRemoteStream: (stream: MediaStream) => void;
  /** The remote DTLS certificate matched the end-to-end encrypted fingerprint. */
  readonly onVerified: (fingerprint: string) => void;
  /** The connection could not be verified: the call must end. */
  readonly onSecurityFailure: () => void;
}

/** Gathering waits at most this long; candidates found by then are sent. */
const GATHER_TIMEOUT_MS = 4000;
/** How long to wait for the DTLS handshake after ICE connects, before failing closed. */
const DTLS_WAIT_MS = 5000;

export class PeerCall {
  readonly #options: PeerCallOptions;
  readonly #pc: RTCPeerConnection;
  readonly #remote = new MediaStream();
  #local: MediaStream | null = null;
  #expectedFingerprint: string | null = null;
  #verified = false;
  #state: PeerState = 'new';
  #audioSender: RTCRtpSender | null = null;
  #videoSender: RTCRtpSender | null = null;
  #camera: MediaStreamTrack | null = null;
  #screen: MediaStreamTrack | null = null;

  constructor(options: PeerCallOptions) {
    this.#options = options;
    this.#pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.#pc.ontrack = (event) => {
      this.#remote.addTrack(event.track);
      options.onRemoteStream(this.#remote);
    };
    this.#pc.onconnectionstatechange = () => void this.#onConnectionState();
  }

  get state(): PeerState {
    return this.#state;
  }

  get localStream(): MediaStream | null {
    return this.#local;
  }

  get sharingScreen(): boolean {
    return this.#screen !== null;
  }

  #setState(state: PeerState): void {
    if (this.#state === state || this.#state === 'closed') return;
    this.#state = state;
    this.#options.onState(state);
  }

  async #onConnectionState(): Promise<void> {
    switch (this.#pc.connectionState) {
      case 'connected': {
        if (!this.#verified && !(await this.#verifyPeer())) return;
        this.#setState('connected');
        return;
      }
      case 'disconnected':
        this.#setState('reconnecting');
        return;
      case 'failed':
        this.#setState('failed');
        return;
      case 'connecting':
        if (this.#state !== 'reconnecting') this.#setState('connecting');
        return;
      case 'new':
      case 'closed':
        return;
    }
  }

  /**
   * The certificate DTLS actually saw must be the one named in the encrypted description. The
   * peer connection can report "connected" a moment before its DTLS transport does, so wait for
   * the handshake to finish (bounded), then compare. Anything else fails closed.
   */
  async #verifyPeer(): Promise<boolean> {
    const transport =
      this.#pc.getSenders().find((s) => s.transport !== null)?.transport ??
      this.#pc.getReceivers().find((r) => r.transport !== null)?.transport ??
      null;
    if (transport !== null && transport.state !== 'connected') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DTLS_WAIT_MS);
        transport.addEventListener('statechange', () => {
          if (transport.state !== 'connecting' && transport.state !== 'new') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    const certificates = transport?.state === 'connected' ? transport.getRemoteCertificates() : [];
    const expected = this.#expectedFingerprint;
    if (expected === null || !(await remoteCertificateMatches(expected, certificates))) {
      this.close();
      this.#options.onSecurityFailure();
      return false;
    }
    this.#verified = true;
    this.#options.onVerified(expected);
    return true;
  }

  /** Captures microphone (and camera). */
  async startMedia(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video:
        this.#options.media === 'video'
          ? { width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
    });
    this.#local = stream;
    this.#camera = stream.getVideoTracks()[0] ?? null;
    return stream;
  }

  /**
   * One audio and one video sender. The caller creates the transceivers; the callee uses the
   * ones the offer created (new ones could not be negotiated in an answer). There is always a
   * video sender, so screen sharing and turning the camera on need no renegotiation.
   */
  async #attachMedia(): Promise<void> {
    const stream = this.#local;
    if (stream === null) throw new Error('Media not started');
    const audio = stream.getAudioTracks()[0] ?? null;
    const transceivers = this.#pc.getTransceivers();
    const reuse = (kind: 'audio' | 'video') =>
      transceivers.find((t) => t.receiver.track.kind === kind && t.sender.track === null);
    for (const [kind, track] of [
      ['audio', audio],
      ['video', this.#camera],
    ] as const) {
      const existing = reuse(kind);
      let sender: RTCRtpSender;
      if (existing === undefined) {
        sender = this.#pc.addTransceiver(track ?? kind, {
          direction: 'sendrecv',
          streams: [stream],
        }).sender;
      } else {
        existing.direction = 'sendrecv';
        sender = existing.sender;
        sender.setStreams(stream);
        await sender.replaceTrack(track);
      }
      if (kind === 'audio') this.#audioSender = sender;
      else this.#videoSender = sender;
    }
  }

  /**
   * Applies a local description and waits for this round of candidate gathering to end (the
   * end-of-candidates event, armed before gathering starts: after an ICE restart the gathering
   * state still reads "complete" from the previous round for a moment). Bounded by a timeout.
   */
  async #describe(description: RTCSessionDescriptionInit): Promise<string> {
    const gathered = new Promise<void>((resolve) => {
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      const pc = this.#pc;
      function done() {
        clearTimeout(timer);
        pc.removeEventListener('icecandidate', onCandidate);
        resolve();
      }
      function onCandidate(event: RTCPeerConnectionIceEvent) {
        if (event.candidate === null) done();
      }
      pc.addEventListener('icecandidate', onCandidate);
    });
    await this.#pc.setLocalDescription(description);
    await gathered;
    const sdp = this.#pc.localDescription?.sdp;
    if (sdp === undefined) throw new Error('No local description');
    return sdp;
  }

  #checkRemote(sdp: string): void {
    if (!plausibleSdp(sdp)) throw new Error('The call setup could not be verified.');
    const fingerprint = dtlsFingerprint(sdp);
    // The certificate may not change during a call (renegotiation keeps the same DTLS session).
    if (this.#expectedFingerprint !== null && fingerprint !== this.#expectedFingerprint)
      throw new Error('The call setup could not be verified.');
    this.#expectedFingerprint = fingerprint;
  }

  async createOffer(): Promise<string> {
    this.#setState('connecting');
    await this.#attachMedia();
    return this.#describe(await this.#pc.createOffer());
  }

  async acceptOffer(sdp: string): Promise<string> {
    this.#checkRemote(sdp);
    this.#setState('connecting');
    await this.#pc.setRemoteDescription({ type: 'offer', sdp });
    if (this.#audioSender === null) await this.#attachMedia();
    return this.#describe(await this.#pc.createAnswer());
  }

  async acceptAnswer(sdp: string): Promise<void> {
    this.#checkRemote(sdp);
    await this.#pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** ICE restart after a network change, with fresh relay credentials. */
  async restart(iceServers: RTCIceServer[]): Promise<string> {
    this.#pc.setConfiguration({
      ...this.#pc.getConfiguration(),
      iceServers,
    });
    this.#setState('reconnecting');
    return this.#describe(await this.#pc.createOffer({ iceRestart: true }));
  }

  setMuted(muted: boolean): void {
    for (const track of this.#local?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  async setCamera(on: boolean): Promise<void> {
    if (on && this.#camera === null) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      this.#camera = stream.getVideoTracks()[0] ?? null;
      if (this.#camera !== null) this.#local?.addTrack(this.#camera);
    }
    if (this.#camera !== null) this.#camera.enabled = on;
    if (this.#screen === null) await this.#videoSender?.replaceTrack(on ? this.#camera : null);
  }

  /** Switches microphone or camera without renegotiating. */
  async switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'audioinput'
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId } } },
    );
    const track = stream.getTracks()[0];
    if (track === undefined || this.#local === null) return;
    const old = kind === 'audioinput' ? this.#local.getAudioTracks()[0] : this.#camera;
    if (kind === 'audioinput') {
      track.enabled = old?.enabled ?? true;
      await this.#audioSender?.replaceTrack(track);
    } else {
      this.#camera = track;
      if (this.#screen === null) await this.#videoSender?.replaceTrack(track);
    }
    if (old != null) {
      this.#local.removeTrack(old);
      old.stop();
    }
    this.#local.addTrack(track);
  }

  async shareScreen(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) return;
    this.#screen = track;
    track.addEventListener('ended', () => void this.stopSharing());
    await this.#videoSender?.replaceTrack(track);
  }

  async stopSharing(): Promise<void> {
    if (this.#screen === null) return;
    this.#screen.stop();
    this.#screen = null;
    const camera = this.#camera?.enabled === true ? this.#camera : null;
    await this.#videoSender?.replaceTrack(camera);
  }

  /** Connection quality and whether the call is relayed, from `getStats()`. */
  async quality(): Promise<CallQuality> {
    return qualityFromStats(await this.#pc.getStats());
  }

  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    for (const track of this.#local?.getTracks() ?? []) track.stop();
    this.#screen?.stop();
    this.#pc.close();
  }
}
