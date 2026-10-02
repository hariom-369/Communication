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

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';
import { useMessaging } from '../../messaging/provider.js';

type Summary = Awaited<ReturnType<typeof endpoints.myCommunities>>['communities'][number];

function CommunityList({ items, empty }: { items: readonly Summary[]; empty: string }): ReactNode {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="item-list">
      {items.map((community) => (
        <li key={community.id} className="item">
          <div>
            <p className="item__title">
              <Link to={`/communities/${community.id}`}>{community.name}</Link>
            </p>
            <p className="item__meta">
              {community.memberCount} {community.memberCount === 1 ? 'member' : 'members'} ·{' '}
              {community.visibility === 'public' ? 'Public' : 'Private'}
              {community.description === '' ? '' : ` · ${community.description}`}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Communities: the ones you are in, the public directory, and creating one. */
export function CommunitiesPage(): ReactNode {
  const { communityVersion } = useMessaging();
  const loadMine = useCallback(() => endpoints.myCommunities(), []);
  const mine = useResource(loadMine);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const [results, setResults] = useState<Summary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { reload } = mine;

  useEffect(() => {
    if (communityVersion > 0) reload();
  }, [communityVersion, reload]);

  useEffect(() => {
    let cancelled = false;
    endpoints.discoverCommunities(deferred).then(
      (found) => {
        if (!cancelled) setResults(found.communities);
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
      <PageHeading description="Communities group several spaces. Every space is an end-to-end encrypted group; a community's name, rules, roles and member list are visible to the server.">
        Communities
      </PageHeading>
      <section className="settings-section stack" aria-labelledby="mine-heading">
        <h2 id="mine-heading">Your communities</h2>
        {mine.error === undefined ? null : <Alert tone="danger">{mine.error}</Alert>}
        {mine.data === undefined ? (
          <Skeleton height="3rem" shape="tile" />
        ) : (
          <CommunityList items={mine.data.communities} empty="You are not in any community yet." />
        )}
        <div className="button-row">
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            Create a community
          </Button>
        </div>
      </section>
      <section className="settings-section stack" aria-labelledby="directory-heading">
        <h2 id="directory-heading">Discover</h2>
        <TextField
          label="Search public communities"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results === null ? (
          <Skeleton height="3rem" shape="tile" />
        ) : (
          <CommunityList items={results} empty="No public communities match." />
        )}
      </section>
      <CreateCommunityDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateCommunityDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [minAge, setMinAge] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await endpoints.createCommunity({
        name: name.trim(),
        description: description.trim(),
        rules: rules.trim(),
        visibility,
        minAccountAgeDays: Math.min(365, Math.max(0, Number(minAge) || 0)),
      });
      onClose();
      await navigate(`/communities/${id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create a community"
      description="The name, description and rules are readable by the server. Messages in spaces are end-to-end encrypted."
    >
      <form className="stack" onSubmit={(event) => void create(event)}>
        <TextField
          label="Name"
          required
          minLength={3}
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Description"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="t-field">
          <span className="t-field__label">Rules</span>
          <textarea
            className="t-field__input"
            rows={4}
            maxLength={4000}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
          />
        </label>
        <label className="t-field">
          <span className="t-field__label">Who can find it</span>
          <select
            className="t-field__input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
          >
            <option value="private">Private — invite links only</option>
            <option value="public">Public — listed in Discover</option>
          </select>
        </label>
        <TextField
          label="Minimum account age to join (days)"
          inputMode="numeric"
          value={minAge}
          onChange={(e) => setMinAge(e.target.value.replace(/\D/g, ''))}
        />
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
