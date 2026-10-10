import { Alert, Button, Dialog } from '@tessera/ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, errorMessage } from './api.js';
import { confirmWithKey, isKeyCancellation } from './webauthn.js';

interface StepUpValue {
  /**
   * Runs a sensitive action. If the API answers STEP_UP_REQUIRED, asks for the security key and
   * retries once. Resolves to `undefined` if the person cancels.
   */
  readonly withStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
}

const StepUpContext = createContext<StepUpValue | null>(null);

export function StepUpProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const finish = useCallback((confirmed: boolean) => {
    setOpen(false);
    setError(undefined);
    setBusy(false);
    pending.current?.(confirmed);
    pending.current = null;
  }, []);

  const withStepUp = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== 'STEP_UP_REQUIRED') throw caught;
      const confirmed = await new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      });
      if (!confirmed) return undefined;
      return action();
    }
  }, []);

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await confirmWithKey();
      finish(true);
    } catch (caught) {
      setError(
        isKeyCancellation(caught) ? 'The security key prompt was dismissed.' : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  const value = useMemo(() => ({ withStepUp }), [withStepUp]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Dialog
        open={open}
        title="Confirm with your security key"
        description="Sensitive changes need your key again if you last used it more than five minutes ago."
        onClose={() => {
          finish(false);
        }}
      >
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <div className="row">
          <Button onClick={() => void confirm()} loading={busy} loadingLabel="Waiting for your key">
            Use security key
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              finish(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpValue {
  const value = useContext(StepUpContext);
  if (value === null) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return value;
}
