import { Alert, Button, Dialog, Skeleton, TextField } from '@tessera/ui';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';

import { errorMessage, fieldErrors } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';

import { NOT_E2EE_NOTICE, subscriberLabel } from './shared.js';

type Summary = Awaited<ReturnType<typeof endpoints.myChannels>>['channels'][number];

function ChannelList({ items, empty }: { items: readonly Summary[]; empty: string }): ReactNode {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="item-list">
      {items.map((channel) => (
        <li key={channel.id} className="item">
          <div>
            <p className="item__title">
              <Link to={`/channels/${channel.id}`}>{channel.title}</Link>
            </p>
            <p className="item__meta">
              @{channel.handle} · {subscriberLabel(channel.subscriberCount)}
              {channel.visibility === 'private' ? ' · Private' : ''}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Channels: the ones you follow or run, the public directory, and creating one. */
export function ChannelsPage(): ReactNode {
  const load = useCallback(() => endpoints.myChannels(), []);
  const mine = useResource(load);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const [results, setResults] = useState<Summary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    endpoints.discoverChannels(deferred).then(
      (found) => {
        if (!cancelled) setResults(found.channels);
      },
      () => {
        if (!cancelled) setResults([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deferred]);

  return (
    <div className="settings-page">
      <PageHeading description={NOT_E2EE_NOTICE}>Channels</PageHeading>
      <section className="settings-section stack" aria-labelledby="my-channels-heading">
        <h2 id="my-channels-heading">Your channels</h2>
        {mine.error === undefined ? null : <Alert tone="danger">{mine.error}</Alert>}
        {mine.data === undefined ? (
          <Skeleton height="3rem" shape="tile" />
        ) : (
          <ChannelList items={mine.data.channels} empty="You do not follow any channels yet." />
        )}
        <div className="button-row">
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            Create a channel
          </Button>
        </div>
      </section>
      <section className="settings-section stack" aria-labelledby="channel-directory-heading">
        <h2 id="channel-directory-heading">Discover</h2>
        <TextField
          label="Search public channels"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results === null ? (
          <Skeleton height="3rem" shape="tile" />
        ) : (
          <ChannelList items={results} empty="No public channels match." />
        )}
      </section>
      <CreateChannelDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateChannelDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFields({});
    try {
      const { id } = await endpoints.createChannel({
        handle: handle.trim().replace(/^@/, '').toLowerCase(),
        title: title.trim(),
        description: description.trim(),
        visibility,
        commentsEnabled: true,
        slowModeSeconds: 0,
      });
      onClose();
      await navigate(`/channels/${id}`);
    } catch (caught) {
      setFields(fieldErrors(caught));
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create a channel" description={NOT_E2EE_NOTICE}>
      <form className="stack" onSubmit={(event) => void create(event)}>
        <TextField
          label="Handle"
          hint="3–32 letters, digits or underscores; people find the channel as @handle."
          required
          autoComplete="off"
          value={handle}
          error={fields['handle']}
          onChange={(e) => setHandle(e.target.value)}
        />
        <TextField
          label="Title"
          required
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextField
          label="Description"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="t-field">
          <span className="t-field__label">Who can find it</span>
          <select
            className="t-field__input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
          >
            <option value="public">Public — anyone can find and read it</option>
            <option value="private">Private — invite links only</option>
          </select>
        </label>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <div className="button-row">
          <Button type="submit" loading={busy} loadingLabel="Creating">
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
