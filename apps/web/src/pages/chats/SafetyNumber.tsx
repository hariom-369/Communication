import { Alert, Button } from '@tessera/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useMessagingStore } from '../../messaging/provider.js';

/** 60-digit safety number as 12 groups of 5 (docs/e2ee.md §9). */
function groups(digits: string): string[] {
  return digits.match(/.{5}/g) ?? [];
}

/**
 * Compare safety numbers in person or over a trusted channel. Both people see the same number
 * if (and only if) each has the other's genuine identity key.
 */
export function SafetyNumber(props: {
  conversationId: string;
  userId: string;
  username: string;
  verified: boolean;
}): ReactNode {
  const store = useMessagingStore();
  const [digits, setDigits] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    store?.security
      .safetyNumber(props.userId)
      .then((number) => {
        if (!cancelled) setDigits(number.digits);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [store, props.userId]);

  if (failed) return <Alert tone="warning">@{props.username} has not set up encryption yet.</Alert>;
  if (digits === null) return <p className="t-field__hint">Loading safety number…</p>;

  return (
    <div className="safety-number">
      <p className="safety-number__digits" aria-label={`Safety number with @${props.username}`}>
        {groups(digits).map((group, index) => (
          <span key={index}>{group}</span>
        ))}
      </p>
      <p className="t-field__hint">
        Compare these numbers with @{props.username} in person or on a call. If they match, your
        messages can only be read by the two of you.
      </p>
      <Button
        size="sm"
        variant={props.verified ? 'ghost' : 'primary'}
        onClick={() => {
          void store?.security.setVerified(props.conversationId, props.userId, !props.verified);
        }}
      >
        {props.verified ? 'Clear verification' : 'Mark as verified'}
      </Button>
    </div>
  );
}
