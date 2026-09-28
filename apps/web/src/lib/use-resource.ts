import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '../api/client.js';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: string | undefined;
  /** Re-fetches; the previous data stays visible until the new data arrives. */
  readonly reload: () => void;
}

/**
 * Loads data in an effect with cancellation, so a stale response never overwrites a newer one
 * and nothing is set after unmount.
 */
export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(undefined);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { data, error, reload };
}
