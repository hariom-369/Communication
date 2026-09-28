export interface Presence {
  readonly userId: string;
  readonly online: boolean | null;
  readonly lastSeenAt: string | null;
}
