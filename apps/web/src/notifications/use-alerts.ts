import type { SecurityAlert } from '@tessera/validation';
import { useCallback, useEffect, useState } from 'react';

import { endpoints } from '../api/endpoints.js';
import { useMessagingStore } from '../messaging/provider.js';

/** Account security alerts (docs/notifications.md §4), refreshed when the server signals one. */
export function useSecurityAlerts(): {
  readonly alerts: readonly SecurityAlert[] | null;
  readonly unread: number;
  readonly error: boolean;
  readonly markRead: () => Promise<void>;
} {
  const store = useMessagingStore();
  const [alerts, setAlerts] = useState<readonly SecurityAlert[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    endpoints.securityAlerts().then(
      (result) => {
        setAlerts(result.alerts);
        setUnread(result.unread);
        setError(false);
      },
      () => {
        setError(true);
      },
    );
  }, []);

  useEffect(() => {
    load();
    const off = store?.onNotificationsChanged((what) => {
      if (what === 'alerts') load();
    });
    return () => off?.();
  }, [load, store]);

  const markRead = useCallback(async () => {
    const newest = alerts?.[0];
    if (newest === undefined) return;
    await endpoints.markAlertsRead(newest.id);
    load();
  }, [alerts, load]);

  return { alerts, unread, error, markRead };
}
