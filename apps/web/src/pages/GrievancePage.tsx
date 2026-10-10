import { Alert, Button, TextField } from '@tessera/ui';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { errorMessage, fieldErrors } from '../api/client.js';
import { moderationEndpoints } from '../api/moderation-endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';

const KINDS = [
  { value: 'grievance', label: 'A complaint about content or a decision' },
  { value: 'ncii', label: 'Intimate images of me shared without my consent' },
  { value: 'synthetic_media', label: 'Fake (deepfake) images or video of me' },
] as const;

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The grievance officer (IT Rules): anyone may file, with or without an account. */
export function GrievancePage(): ReactNode {
  const ids = useId();
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('grievance');
  const [contact, setContact] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<{
    id: string;
    acknowledgeBy: string;
    resolveBy: string;
  }>();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFields({});
    try {
      setReceipt(
        await moderationEndpoints.grievance({
          kind,
          contact: contact.trim(),
          description: description.trim(),
          reference: reference.trim(),
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught));
      setFields(fieldErrors(caught));
    }
    setBusy(false);
  }

  return (
    <AuthLayout footer={<Link to="/">Back to Tessera</Link>}>
      <PageHeading description="Tell our grievance officer about content on Tessera or a decision we made. You do not need an account.">
        Grievance officer
      </PageHeading>
      {receipt !== undefined ? (
        <Alert tone="success" title="We received your complaint">
          <p>
            Reference: <code>{receipt.id}</code>. We sent the details to your email address.
          </p>
          <p>
            We will acknowledge it by {when.format(new Date(receipt.acknowledgeBy))} and aim to
            resolve it by {when.format(new Date(receipt.resolveBy))}.
          </p>
        </Alert>
      ) : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          <div className="t-field">
            <label className="t-field__label" htmlFor={`${ids}-kind`}>
              What is it about?
            </label>
            <select
              id={`${ids}-kind`}
              className="t-field__input"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              {KINDS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {kind === 'grievance' ? null : (
              <p className="t-field__hint">We treat these first: we aim to act within two hours.</p>
            )}
          </div>
          <TextField
            label="Your email address"
            type="email"
            autoComplete="email"
            required
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            error={fields['contact']}
          />
          <div className="t-field">
            <label className="t-field__label" htmlFor={`${ids}-description`}>
              What happened?
            </label>
            <textarea
              id={`${ids}-description`}
              className="t-field__input"
              rows={5}
              minLength={10}
              maxLength={4000}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <TextField
            label="Links or usernames (optional)"
            value={reference}
            maxLength={500}
            onChange={(e) => setReference(e.target.value)}
            hint="Where the content is, for example a channel link or @username. Do not paste the images themselves."
          />
          <Button type="submit" loading={busy} loadingLabel="Sending">
            Send complaint
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
