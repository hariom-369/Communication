import { useCallback, useEffect, useState } from 'react';

import { moderationEndpoints } from '../api/moderation-endpoints.js';

/**
 * Whether this user blocked `userId` (docs/moderation.md §2), and a setter that keeps the server
 * and the screen in step. Blocks are private: nobody is told they were blocked.
 */
export function useBlocked(userId: string | null): {
  blocked: boolean;
  setBlocked: (blocked: boolean) => Promise<void>;
} {
  const [blocked, setState] = useState(false);
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    moderationEndpoints.blocked().then(
      ({ blocked: list }) => {
        if (!cancelled) setState(list.some((entry) => entry.userId === userId));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);
  const setBlocked = useCallback(
    async (next: boolean) => {
      if (userId === null) return;
      if (next) await moderationEndpoints.block(userId);
      else await moderationEndpoints.unblock(userId);
      setState(next);
    },
    [userId],
  );
  return { blocked: userId !== null && blocked, setBlocked };
}
