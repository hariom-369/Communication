import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';

/** Rules must be read and accepted before joining (the server checks the version accepted). */
export function RulesAgreement(props: {
  rules: string;
  minAccountAgeDays: number;
  busy: boolean;
  onJoin: () => void;
}): ReactNode {
  const [accepted, setAccepted] = useState(props.rules === '');
  return (
    <div className="stack">
      {props.rules === '' ? null : (
        <section aria-labelledby="rules-heading" className="stack">
          <h3 id="rules-heading">Rules</h3>
          <p className="group-description">{props.rules}</p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I have read and accept the rules
          </label>
        </section>
      )}
      {props.minAccountAgeDays > 0 ? (
        <p className="t-field__hint">
          Accounts must be at least {props.minAccountAgeDays} days old to join.
        </p>
      ) : null}
      <div className="button-row">
        <Button
          disabled={!accepted}
          loading={props.busy}
          loadingLabel="Joining"
          onClick={props.onJoin}
        >
          Join community
        </Button>
      </div>
    </div>
  );
}
