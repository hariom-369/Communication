import { Alert, Button, Dialog, TextField } from '@tessera/ui';
import { MAX_ELEVATED_HOURS } from '@tessera/validation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../api.js';
import { endpoints } from '../endpoints.js';
import { roleName } from '../format.js';
import { useSession } from '../session.js';

/**
 * Just-in-time elevation (docs/admin.md §2): an eligible admin asks for an elevated role for a
 * few hours; it takes effect only when another admin approves it.
 */
export function ElevationButton(): ReactNode {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<'super_admin' | 'security_admin'>();
  const [hours, setHours] = useState('2');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const eligible = me?.eligibleRoles ?? [];
  if (me === null || eligible.length === 0) return null;
  const chosen = role ?? eligible[0];

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (me === null || chosen === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.requestApproval(
        { kind: 'role_grant', adminId: me.id, role: chosen, hours: Number(hours) },
        reason,
      );
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setDone(false);
          setOpen(true);
        }}
      >
        Request elevation
      </Button>
      <Dialog
        open={open}
        title="Request an elevated role"
        description={`Another admin must approve it. It ends by itself after at most ${String(MAX_ELEVATED_HOURS)} hours.`}
        onClose={() => {
          setOpen(false);
        }}
      >
        {done ? (
          <Alert tone="success" title="Requested">
            <p>Ask another admin to approve it under Approvals.</p>
          </Alert>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <label className="t-field">
              <span className="t-field__label">Role</span>
              <select
                className="t-field__input"
                value={chosen}
                onChange={(event) => {
                  setRole(event.target.value as 'super_admin' | 'security_admin');
                }}
              >
                {eligible.map((value) => (
                  <option key={value} value={value}>
                    {roleName(value)}
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="For how many hours"
              type="number"
              min={1}
              max={MAX_ELEVATED_HOURS}
              required
              value={hours}
              onChange={(event) => {
                setHours(event.target.value);
              }}
            />
            <TextField
              label="Why"
              required
              minLength={5}
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
            <Button type="submit" loading={busy}>
              Request
            </Button>
          </form>
        )}
      </Dialog>
    </>
  );
}
