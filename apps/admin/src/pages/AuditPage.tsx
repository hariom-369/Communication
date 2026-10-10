import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';

import { endpoints, type AuditFilter } from '../endpoints.js';
import { dateTime } from '../format.js';
import { useResource } from '../use-resource.js';

/** The audit log, newest first. Security staff see everything and the hash-chain check. */
export function AuditPage(): ReactNode {
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [filter, setFilter] = useState<AuditFilter>({});
  const load = useCallback(() => endpoints.audit(filter), [filter]);
  const page = useResource(load);

  function apply(event: SubmitEvent) {
    event.preventDefault();
    setFilter({
      ...(action.trim() === '' ? {} : { action: action.trim() }),
      ...(actorId.trim() === '' ? {} : { actorId: actorId.trim() }),
      ...(targetId.trim() === '' ? {} : { targetId: targetId.trim() }),
    });
  }

  const entries = page.data?.entries ?? [];
  const oldest = entries.at(-1)?.seq;
  return (
    <section className="stack">
      <h1>Audit log</h1>
      {page.data === undefined ? null : page.data.ownOnly ? (
        <Alert tone="info">You see your own actions only.</Alert>
      ) : page.data.chainBrokenAt === null ? (
        <Alert tone="success">
          The audit chain verifies: no entry has been changed or removed.
        </Alert>
      ) : (
        <Alert tone="danger" title="The audit chain is broken">
          <p>Entry {page.data.chainBrokenAt} does not match the chain. Report this to security.</p>
        </Alert>
      )}
      <form className="row" aria-label="Filter" onSubmit={apply}>
        <TextField
          label="Action"
          placeholder="admin.user_lookup"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
          }}
        />
        <TextField
          label="Actor id"
          value={actorId}
          onChange={(e) => {
            setActorId(e.target.value);
          }}
        />
        <TextField
          label="Target id"
          value={targetId}
          onChange={(e) => {
            setTargetId(e.target.value);
          }}
        />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      {page.error === undefined ? null : <Alert tone="danger">{page.error}</Alert>}
      {page.data === undefined && page.error === undefined ? (
        <Skeleton width="100%" height="6rem" />
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.seq}>
              <td>{entry.seq}</td>
              <td>{dateTime(entry.at)}</td>
              <td>
                {entry.actorKind}
                {entry.actorId === null ? '' : <span className="mono"> {entry.actorId}</span>}
              </td>
              <td className="mono">{entry.action}</td>
              <td>
                {entry.targetKind ?? ''}
                {entry.targetId === null ? '' : <span className="mono"> {entry.targetId}</span>}
              </td>
              <td className="mono">
                {Object.entries(entry.details)
                  .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                  .join(' ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {oldest !== undefined && entries.length === 50 ? (
        <Button
          variant="secondary"
          onClick={() => {
            setFilter({ ...filter, before: oldest });
          }}
        >
          Older entries
        </Button>
      ) : null}
    </section>
  );
}
