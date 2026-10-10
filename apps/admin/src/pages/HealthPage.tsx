import { Alert, Button, Skeleton } from '@tessera/ui';
import type { ReactNode } from 'react';

import { endpoints } from '../endpoints.js';
import { useResource } from '../use-resource.js';

/** Dependencies as the API sees them right now. */
export function HealthPage(): ReactNode {
  const health = useResource(endpoints.health);
  return (
    <section className="stack">
      <h1>Health</h1>
      {health.error === undefined ? null : <Alert tone="danger">{health.error}</Alert>}
      {health.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      <ul className="list">
        {health.data?.checks.map((check) => (
          <li key={check.name}>
            <span>
              <strong>{check.name}</strong> · {check.ok ? 'OK' : 'FAILING'} · {check.detail} ·{' '}
              {check.latencyMs} ms
            </span>
          </li>
        ))}
      </ul>
      <Button variant="secondary" onClick={health.reload}>
        Check again
      </Button>
    </section>
  );
}
