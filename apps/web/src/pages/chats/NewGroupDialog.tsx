import { Alert, Button, Dialog, TextField } from '@tessera/ui';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useMessagingStore } from '../../messaging/provider.js';
import { MAX_GROUP_NAME } from '../../messaging/content.js';

/** Usernames separated by commas, spaces or new lines; a leading @ is optional. */
export function parseUsernames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((name) => name.trim().replace(/^@/, '').toLowerCase())
        .filter((name) => name !== ''),
    ),
  ];
}

export function NewGroupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const store = useMessagingStore();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [people, setPeople] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (store === null || name.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await store.createGroup(name, parseUsernames(people));
      setName('');
      setPeople('');
      onClose();
      const notes = [
        result.invited.length > 0
          ? `Invited (they need to accept): @${result.invited.join(', @')}`
          : '',
        result.skipped.length > 0 ? `Could not add: @${result.skipped.join(', @')}` : '',
      ].filter((note) => note !== '');
      await navigate(`/chats/${result.id}`, {
        state: notes.length === 0 ? undefined : { notice: notes.join('. ') },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New group"
      description="Messages, the group name and its description are end-to-end encrypted."
    >
      <form className="stack" onSubmit={(event) => void create(event)}>
        <TextField
          label="Group name"
          required
          maxLength={MAX_GROUP_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="People"
          hint="Usernames, separated by commas. People whose privacy settings require it get an invitation instead."
          placeholder="alice, bob"
          autoComplete="off"
          value={people}
          onChange={(e) => setPeople(e.target.value)}
        />
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <div className="button-row">
          <Button type="submit" loading={busy} loadingLabel="Creating group">
            Create group
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
