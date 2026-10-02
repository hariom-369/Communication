const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "14:05" for today, "3 Oct" otherwise. */
export function shortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString() ? time.format(date) : day.format(date);
}

export function clockTime(timestamp: number): string {
  return time.format(new Date(timestamp));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function lastSeen(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes > -1) return 'last seen just now';
  if (minutes > -60) return `last seen ${relative.format(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours > -24) return `last seen ${relative.format(hours, 'hour')}`;
  return `last seen ${day.format(new Date(iso))}`;
}

/** "820 KB", "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "0:07", "12:30". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
