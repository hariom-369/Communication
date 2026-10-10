import { Alert, Skeleton } from '@tessera/ui';
import { useCallback, useState, type ReactNode } from 'react';

import { Select } from '../components/ChangeRequest.js';
import { endpoints } from '../endpoints.js';
import { useResource } from '../use-resource.js';

/** Networks (address prefixes) with the most failed sign-ins: credential stuffing shows here. */
export function SecurityPage(): ReactNode {
  const [hours, setHours] = useState<'1' | '24' | '168'>('24');
  const load = useCallback(() => endpoints.hotspots(Number(hours)), [hours]);
  const hotspots = useResource(load);
  return (
    <section className="stack">
      <h1>Failed sign-ins</h1>
      <Select
        label="Period"
        value={hours}
        options={[
          { value: '1', label: 'Last hour' },
          { value: '24', label: 'Last 24 hours' },
          { value: '168', label: 'Last 7 days' },
        ]}
        onChange={setHours}
      />
      {hotspots.error === undefined ? null : <Alert tone="danger">{hotspots.error}</Alert>}
      {hotspots.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      {hotspots.data?.hotspots.length === 0 ? <p>No failed sign-ins in this period.</p> : null}
      {hotspots.data === undefined || hotspots.data.hotspots.length === 0 ? null : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Network</th>
              <th scope="col">Failures</th>
              <th scope="col">Accounts tried</th>
            </tr>
          </thead>
          <tbody>
            {hotspots.data.hotspots.map((spot) => (
              <tr key={spot.ipPrefix}>
                <td className="mono">{spot.ipPrefix}</td>
                <td>{spot.failures}</td>
                <td>{spot.accounts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
