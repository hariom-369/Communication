import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../api.js';
import { endpoints, type ApprovalPayload } from '../endpoints.js';

/**
 * A four-eyes change request (docs/admin.md §2): the form's fields build the payload, a reason is
 * always required, and nothing changes until a different admin approves it under Approvals.
 */
export function ChangeRequest({
  title,
  submitLabel,
  build,
  children,
  onRequested,
}: {
  title: string;
  submitLabel: string;
  /** The payload from the form's current values, or a message saying what is missing. */
  build: () => ApprovalPayload | string;
  children: ReactNode;
  onRequested?: () => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    const payload = build();
    if (typeof payload === 'string') {
      setError(payload);
      return;
    }
    setBusy(true);
    try {
      await endpoints.requestApproval(payload, reason);
      setNotice('Requested. It takes effect when another admin approves it.');
      setReason('');
      onRequested?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" aria-label={title} onSubmit={(event) => void submit(event)}>
      <h2>{title}</h2>
      {children}
      <TextField
        label="Reason"
        required
        minLength={5}
        maxLength={500}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {notice === undefined ? null : <Alert tone="success">{notice}</Alert>}
      <Button type="submit" loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): ReactNode {
  return (
    <label className="t-field">
      <span className="t-field__label">{label}</span>
      <select
        className="t-field__input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
