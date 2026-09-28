import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '../api/client.js';
import { ReauthDialog } from '../components/ReauthDialog.js';

interface StepUpValue {
  /**
   * Runs a sensitive action. If the API answers STEP_UP_REQUIRED, asks the user to confirm their
   * identity and retries once. Resolves to `undefined` if the user cancels.
   */
  readonly withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}

const StepUpContext = createContext<StepUpValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const confirmIdentity = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      }),
    [],
  );

  const finish = useCallback((confirmed: boolean) => {
    setOpen(false);
    pending.current?.(confirmed);
    pending.current = null;
  }, []);

  const withStepUp = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'STEP_UP_REQUIRED') throw error;
        if (!(await confirmIdentity())) return undefined;
        return action();
      }
    },
    [confirmIdentity],
  );

  const value = useMemo(() => ({ withStepUp }), [withStepUp]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <ReauthDialog open={open} onDone={finish} />
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpValue {
  const value = useContext(StepUpContext);
  if (value === null) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return value;
}
