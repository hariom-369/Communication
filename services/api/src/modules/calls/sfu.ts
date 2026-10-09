import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * The selective forwarding unit for group calls (LiveKit, ADR-017). It forwards media frames
 * that are already end-to-end encrypted (SFrame, ADR-047); the server only decides who may join.
 */
export interface SfuRooms {
  /** Join token for one room, one identity, publish/subscribe only. */
  token(room: string, identity: string): Promise<string>;
  /** Best effort: disconnects a participant (removed from the conversation, or gone silent). */
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Best effort: closes the room when the call ends. */
  closeRoom(room: string): Promise<void>;
}

export interface LiveKitConfig {
  /** WebSocket URL given to browsers (may be a path on the web origin, e.g. `/sfu`). */
  readonly url: string;
  /** HTTP URL of LiveKit's server API, reachable from the API only. */
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/** Join tokens are only for joining; LiveKit refreshes them for connected participants. */
export const SFU_TOKEN_TTL_SECONDS = 5 * 60;
const API_TIMEOUT_MS = 3000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('SFU request timed out'));
      }, API_TIMEOUT_MS).unref(),
    ),
  ]);
}

export class LiveKitRooms implements SfuRooms {
  readonly #config: LiveKitConfig;
  readonly #service: RoomServiceClient;

  constructor(config: LiveKitConfig) {
    this.#config = config;
    this.#service = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret);
  }

  token(room: string, identity: string): Promise<string> {
    const token = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
      identity,
      ttl: SFU_TOKEN_TTL_SECONDS,
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // No server-visible side channel: chat and reactions stay in the MLS conversation.
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await withTimeout(this.#service.removeParticipant(room, identity));
  }

  async closeRoom(room: string): Promise<void> {
    await withTimeout(this.#service.deleteRoom(room));
  }
}
