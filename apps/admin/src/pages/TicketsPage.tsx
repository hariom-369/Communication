import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { dateTime } from '../format.js';
import { useResource } from '../use-resource.js';

/** Support tickets: the purpose under which support staff may look at an account. */
export function TicketsPage(): ReactNode {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const load = useCallback(() => endpoints.tickets(status), [status]);
  const tickets = useResource(load);
  const [reference, setReference] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.createTicket({ reference, identifier, reason });
      setReference('');
      setIdentifier('');
      setReason('');
      tickets.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function close(ticketId: string) {
    setError(undefined);
    try {
      await endpoints.closeTicket(ticketId);
      tickets.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="stack">
      <h1>Support tickets</h1>
      <form
        className="card stack narrow"
        aria-label="Open a ticket"
        onSubmit={(event) => void create(event)}
      >
        <h2>Open a ticket</h2>
        <TextField
          label="Help-desk reference"
          required
          maxLength={100}
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
        <TextField
          label="The person's email or username"
          required
          autoComplete="off"
          value={identifier}
          onChange={(event) => {
            setIdentifier(event.target.value);
          }}
        />
        <TextField
          label="What they asked for"
          required
          minLength={5}
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <Button type="submit" loading={busy}>
          Open ticket
        </Button>
      </form>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="row" role="group" aria-label="Show">
        <Button
          size="sm"
          variant={status === 'open' ? 'primary' : 'secondary'}
          aria-pressed={status === 'open'}
          onClick={() => {
            setStatus('open');
          }}
        >
          Open
        </Button>
        <Button
          size="sm"
          variant={status === 'closed' ? 'primary' : 'secondary'}
          aria-pressed={status === 'closed'}
          onClick={() => {
            setStatus('closed');
          }}
        >
          Closed
        </Button>
      </div>
      {tickets.error === undefined ? null : <Alert tone="danger">{tickets.error}</Alert>}
      {tickets.data === undefined ? <Skeleton width="100%" height="4rem" /> : null}
      {tickets.data?.tickets.length === 0 ? <p>No {status} tickets.</p> : null}
      <ul className="list">
        {tickets.data?.tickets.map((ticket) => (
          <li key={ticket.id}>
            <span>
              <strong>{ticket.reference}</strong> · {ticket.subjectUsername} · {ticket.reason} ·
              opened by {ticket.createdBy} {dateTime(ticket.createdAt)}
            </span>
            {ticket.status === 'open' ? (
              <span className="row">
                <Link
                  to={`/people/${ticket.subjectUserId}?purpose=${encodeURIComponent(`ticket:${ticket.id}`)}`}
                >
                  View account
                </Link>
                <Button size="sm" variant="secondary" onClick={() => void close(ticket.id)}>
                  Close
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
