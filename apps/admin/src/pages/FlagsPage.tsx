import { Alert, Skeleton, TextField } from '@tessera/ui';
import { useState, type ReactNode } from 'react';

import { ChangeRequest, Select } from '../components/ChangeRequest.js';
import { endpoints } from '../endpoints.js';
import { dateTime } from '../format.js';
import { useSession } from '../session.js';
import { useResource } from '../use-resource.js';

/**
 * Feature flags: kill switches and staged rollouts. Changes are four-eyes requests; security
 * staff may change security flags, product flags need a super admin.
 */
export function FlagsPage(): ReactNode {
  const { me } = useSession();
  const flags = useResource(endpoints.flags);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState<'on' | 'off'>('off');
  const [percent, setPercent] = useState('100');
  const roles = me?.roles.map((r) => r.role) ?? [];
  const list = flags.data?.flags ?? [];
  const changeable = list.filter(
    (flag) =>
      roles.includes('super_admin') ||
      (flag.kind === 'security' && roles.includes('security_admin')),
  );
  const chosen = key === '' ? (changeable[0]?.key ?? '') : key;

  return (
    <section className="stack">
      <h1>Feature flags</h1>
      {flags.error === undefined ? null : <Alert tone="danger">{flags.error}</Alert>}
      {flags.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Flag</th>
            <th scope="col">Kind</th>
            <th scope="col">State</th>
            <th scope="col">Last changed</th>
          </tr>
        </thead>
        <tbody>
          {list.map((flag) => (
            <tr key={flag.key}>
              <td>
                <span className="mono">{flag.key}</span>
                <br />
                <span className="muted">{flag.description}</span>
              </td>
              <td>{flag.kind}</td>
              <td>{flag.enabled ? `on for ${String(flag.rolloutPercent)}%` : 'off'}</td>
              <td>{dateTime(flag.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {changeable.length === 0 ? null : (
        <ChangeRequest
          title="Change a flag"
          submitLabel="Request change"
          build={() => ({
            kind: 'feature_flag',
            key: chosen,
            enabled: enabled === 'on',
            rolloutPercent: enabled === 'on' ? Number(percent) : 0,
          })}
          onRequested={flags.reload}
        >
          <Select
            label="Flag"
            value={chosen}
            options={changeable.map((flag) => ({ value: flag.key, label: flag.key }))}
            onChange={setKey}
          />
          <Select
            label="Set to"
            value={enabled}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off (kill switch)' },
            ]}
            onChange={setEnabled}
          />
          {enabled === 'on' ? (
            <TextField
              label="Rollout (% of people)"
              type="number"
              min={0}
              max={100}
              required
              value={percent}
              onChange={(e) => {
                setPercent(e.target.value);
              }}
            />
          ) : null}
        </ChangeRequest>
      )}
    </section>
  );
}
