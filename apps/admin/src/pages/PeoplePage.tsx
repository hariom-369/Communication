import { Alert, Button, TextField } from '@tessera/ui';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { purposeText, type PurposeKind } from '../format.js';
import { useSession } from '../session.js';
import { useResource } from '../use-resource.js';

/**
 * Find a person by exact email, username or id — always for a purpose (docs/admin.md §2): an open
 * support ticket about them, an open moderation case about them, or (security staff) a written
 * investigation reason. There is no browsing and no partial search.
 */
export function PeoplePage(): ReactNode {
  const { me, can } = useSession();
  const navigate = useNavigate();
  const roles = me?.roles.map((r) => r.role) ?? [];
  const kinds: { kind: PurposeKind; label: string }[] = [
    ...(roles.includes('support_agent') || roles.includes('super_admin')
      ? [{ kind: 'ticket' as const, label: 'Support ticket' }]
      : []),
    ...(roles.some((r) => ['moderator', 'security_admin', 'super_admin'].includes(r))
      ? [{ kind: 'case' as const, label: 'Moderation case' }]
      : []),
    ...(roles.includes('security_admin') || roles.includes('super_admin')
      ? [{ kind: 'investigation' as const, label: 'Security investigation' }]
      : []),
  ];
  const [identifier, setIdentifier] = useState('');
  const [kind, setKind] = useState<PurposeKind | undefined>();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = kind ?? kinds[0]?.kind;
  const showTickets = can('tickets');
  const loadTickets = useCallback(
    () => (showTickets ? endpoints.tickets('open') : Promise.resolve({ tickets: [] })),
    [showTickets],
  );
  const tickets = useResource(loadTickets);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (chosen === undefined) return;
    setBusy(true);
    setError(undefined);
    const purpose = purposeText(chosen, value);
    try {
      const found = await endpoints.lookup(identifier.trim(), purpose);
      await navigate(`/people/${found.id}?purpose=${encodeURIComponent(purpose)}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <h1>People</h1>
      <form className="stack narrow" onSubmit={(event) => void submit(event)}>
        <TextField
          label="Exact email, username or account id"
          required
          autoComplete="off"
          value={identifier}
          onChange={(event) => {
            setIdentifier(event.target.value);
          }}
        />
        <fieldset className="stack">
          <legend>Purpose</legend>
          {kinds.map((option) => (
            <label key={option.kind} className="radio">
              <input
                type="radio"
                name="purpose-kind"
                value={option.kind}
                checked={chosen === option.kind}
                onChange={() => {
                  setKind(option.kind);
                  setValue('');
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {chosen === 'ticket' ? (
          <label className="t-field">
            <span className="t-field__label">Ticket</span>
            <select
              className="t-field__input"
              required
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            >
              <option value="">Choose an open ticket</option>
              {tickets.data?.tickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  {ticket.reference} — {ticket.subjectUsername}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {chosen === 'case' ? (
          <TextField
            label="Case id"
            required
            pattern="[0-9a-f-]{36}"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        ) : null}
        {chosen === 'investigation' ? (
          <TextField
            label="Investigation reason (recorded)"
            hint="At least 10 characters. It is stored with every look at this account."
            required
            minLength={10}
            maxLength={500}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        ) : null}
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={chosen === undefined}>
          Look up
        </Button>
      </form>
    </section>
  );
}
