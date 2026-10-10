import type { ReportCategory, reportTargetSchema } from '@tessera/validation';
import { Alert, Button, Dialog } from '@tessera/ui';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import type { z } from 'zod';

import { errorMessage } from '../api/client.js';
import { moderationEndpoints } from '../api/moderation-endpoints.js';

import { CATEGORY_LABELS } from './labels.js';

type PublicTarget = Exclude<z.input<typeof reportTargetSchema>, { kind: 'conversation' }>;

/**
 * Reporting public content (channels, posts, comments, communities) or a person. The server
 * captures the content itself, as the reporter can see it, so nothing needs to be attached.
 */
export function ReportContentDialog({
  target,
  title,
  onClose,
}: {
  /** null: closed. */
  target: PublicTarget | null;
  title: string;
  onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open={target !== null}
      title={title}
      description="Your report goes to Tessera’s safety team. The author is not told who reported it."
      onClose={onClose}
    >
      {target === null ? null : <Form target={target} onClose={onClose} />}
    </Dialog>
  );
}

function Form({ target, onClose }: { target: PublicTarget; onClose: () => void }): ReactNode {
  const ids = useId();
  const [category, setCategory] = useState<ReportCategory>('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await moderationEndpoints.report({ target, category, details: details.trim() });
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  if (done)
    return (
      <div className="stack">
        <Alert tone="success" title="Thank you for reporting">
          <p>Our safety team will review it.</p>
        </Alert>
        <div className="button-row">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-category`}>
          What is wrong?
        </label>
        <select
          id={`${ids}-category`}
          className="t-field__input"
          value={category}
          onChange={(e) => setCategory(e.target.value as ReportCategory)}
        >
          {CATEGORY_LABELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-details`}>
          Anything else we should know? (optional)
        </label>
        <textarea
          id={`${ids}-details`}
          className="t-field__input"
          rows={3}
          maxLength={1000}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>
      <div className="button-row">
        <Button type="submit" loading={busy} loadingLabel="Sending report">
          Send report
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
