import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import type { channelSchema } from '@tessera/validation';
import { useCallback, useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { z } from 'zod';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';
import { useSession } from '../../state/session.js';

import { ChannelAnalytics } from './ChannelAnalytics.js';
import { ChannelSettings } from './ChannelSettings.js';
import { PostCard, type ChannelPost } from './PostCard.js';
import { PostComposer } from './PostComposer.js';
import { canChannel, NOT_E2EE_NOTICE, subscriberLabel } from './shared.js';

type Channel = z.infer<typeof channelSchema>;
type Tab = 'posts' | 'drafts' | 'analytics' | 'settings';

/** New posts are picked up by polling while the channel is open (fan-out on read). */
const REFRESH_MS = 20_000;

export function ChannelPage(): ReactNode {
  const { channelId = '' } = useParams();
  const load = useCallback(() => endpoints.channel(channelId), [channelId]);
  const channel = useResource(load);
  if (channel.error !== undefined)
    return (
      <div className="settings-page">
        <PageHeading>Channel</PageHeading>
        <Alert tone="warning">This channel does not exist or is private.</Alert>
        <Link to="/channels">Back to channels</Link>
      </div>
    );
  if (channel.data === undefined)
    return (
      <div className="settings-page">
        <Skeleton height="4rem" shape="tile" />
      </div>
    );
  return <ChannelView key={channel.data.id} channel={channel.data} reload={channel.reload} />;
}

function ChannelView({ channel, reload }: { channel: Channel; reload: () => void }): ReactNode {
  const { me } = useSession();
  const myId = me?.id ?? '';
  const perms = channel.me.permissions;
  const isAdmin = perms !== 0;
  const [tab, setTab] = useState<Tab>('posts');
  const [error, setError] = useState<string>();

  async function toggleSubscription() {
    setError(undefined);
    try {
      if (channel.me.subscribed) await endpoints.unsubscribeChannel(channel.id);
      else await endpoints.subscribeChannel(channel.id);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'posts', label: 'Posts' },
    ...(canChannel(perms, 'post')
      ? [{ id: 'drafts' as const, label: 'Drafts and scheduled' }]
      : []),
    ...(canChannel(perms, 'viewAnalytics')
      ? [{ id: 'analytics' as const, label: 'Analytics' }]
      : []),
    ...(isAdmin ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];

  return (
    <div className="settings-page">
      <PageHeading
        description={`@${channel.handle} · ${subscriberLabel(channel.subscriberCount)}${channel.visibility === 'private' ? ' · Private' : ''}`}
      >
        {channel.title}
      </PageHeading>
      {channel.description === '' ? null : (
        <p className="group-description">{channel.description}</p>
      )}
      <p className="conversation__notice" role="note">
        {NOT_E2EE_NOTICE}
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="button-row">
        <Button
          variant={channel.me.subscribed ? 'secondary' : 'primary'}
          onClick={() => void toggleSubscription()}
        >
          {channel.me.subscribed ? 'Unsubscribe' : 'Subscribe'}
        </Button>
      </div>
      {tabs.length > 1 ? (
        <div className="segmented" role="tablist" aria-label="Channel sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className="segmented__option"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {tab === 'posts' ? <Feed channel={channel} myId={myId} /> : null}
      {tab === 'drafts' ? <Drafts channel={channel} myId={myId} /> : null}
      {tab === 'analytics' ? <ChannelAnalytics channelId={channel.id} /> : null}
      {tab === 'settings' ? <ChannelSettings channel={channel} onChanged={reload} /> : null}
    </div>
  );
}

function postProps(channel: Channel, myId: string) {
  const perms = channel.me.permissions;
  return {
    channelId: channel.id,
    myId,
    canPost: canChannel(perms, 'post'),
    canEditAny: canChannel(perms, 'editAny'),
    canDeleteAny: canChannel(perms, 'deleteAny'),
    canModerateComments: canChannel(perms, 'manageComments'),
    commentsEnabled: channel.commentsEnabled,
  };
}

/** Records which posts were on screen (unique viewers per day; no history is kept). */
function useViewTracking(channelId: string) {
  const seen = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  useEffect(() => {
    const timer = setInterval(() => {
      const ids = [...pending.current].slice(0, 50);
      if (ids.length === 0) return;
      for (const id of ids) pending.current.delete(id);
      void endpoints.recordChannelViews(channelId, ids).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [channelId]);
  return useCallback((postId: string) => {
    if (seen.current.has(postId)) return;
    seen.current.add(postId);
    pending.current.add(postId);
  }, []);
}

function Viewed({
  postId,
  onSeen,
  children,
}: {
  postId: string;
  onSeen: (id: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      onSeen(postId);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onSeen(postId);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [postId, onSeen]);
  return <li ref={ref}>{children}</li>;
}

function Feed({ channel, myId }: { channel: Channel; myId: string }): ReactNode {
  const [posts, setPosts] = useState<ChannelPost[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChannelPost[] | null>(null);
  const onSeen = useViewTracking(channel.id);
  const props = postProps(channel, myId);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      endpoints.channelPosts(channel.id).then(
        (page) => {
          if (cancelled) return;
          setPosts((current) => {
            if (current === null) return page.posts;
            // Keep older pages already loaded; replace the newest page.
            const fresh = new Set(page.posts.map((p) => p.id));
            const lastNew = page.posts.at(-1);
            const older = current.filter(
              (p) =>
                !fresh.has(p.id) &&
                lastNew !== undefined &&
                (p.publishedAt ?? '') < (lastNew.publishedAt ?? ''),
            );
            return [...page.posts, ...older];
          });
          setCursor((current) => current ?? page.nextCursor);
          setError(undefined);
        },
        (caught: unknown) => {
          if (!cancelled) setError(errorMessage(caught));
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [channel.id]);

  async function older() {
    if (cursor === null) return;
    try {
      const page = await endpoints.channelPosts(channel.id, { before: cursor });
      setPosts((current) => [
        ...(current ?? []),
        ...page.posts.filter((p) => !(current ?? []).some((c) => c.id === p.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function search(event: SubmitEvent) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    try {
      setResults((await endpoints.searchChannel(channel.id, query.trim())).posts);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const replace = (id: string) => (next: ChannelPost | null) => {
    const apply = (list: ChannelPost[] | null) =>
      list === null
        ? null
        : next === null || next.status === 'removed'
          ? list.filter((p) => p.id !== id)
          : list.map((p) => (p.id === id ? next : p));
    setPosts(apply);
    setResults(apply);
  };

  const shown = results ?? posts;
  return (
    <div className="stack">
      {props.canPost ? (
        <PostComposer
          channelId={channel.id}
          onCreated={(post) => {
            if (post.status === 'published') setPosts((current) => [post, ...(current ?? [])]);
          }}
        />
      ) : null}
      <form className="stack" role="search" onSubmit={(event) => void search(event)}>
        <TextField
          label="Search this channel"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim() === '') setResults(null);
          }}
        />
      </form>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {shown === null ? (
        <Skeleton height="6rem" shape="tile" />
      ) : shown.length === 0 ? (
        <p className="empty">{results === null ? 'No posts yet.' : 'No posts match.'}</p>
      ) : (
        <ol className="channel-feed" aria-label={results === null ? 'Posts' : 'Search results'}>
          {shown.map((post) => (
            <Viewed key={post.id} postId={post.id} onSeen={onSeen}>
              <PostCard {...props} post={post} onChange={replace(post.id)} />
            </Viewed>
          ))}
        </ol>
      )}
      {results === null && cursor !== null ? (
        <Button variant="ghost" onClick={() => void older()}>
          Older posts
        </Button>
      ) : null}
    </div>
  );
}

function Drafts({ channel, myId }: { channel: Channel; myId: string }): ReactNode {
  const loadDrafts = useCallback(
    () => endpoints.channelPosts(channel.id, { status: 'draft', limit: 50 }),
    [channel.id],
  );
  const loadScheduled = useCallback(
    () => endpoints.channelPosts(channel.id, { status: 'scheduled', limit: 50 }),
    [channel.id],
  );
  const drafts = useResource(loadDrafts);
  const scheduled = useResource(loadScheduled);
  const props = postProps(channel, myId);
  const refresh = () => {
    drafts.reload();
    scheduled.reload();
  };
  return (
    <div className="stack">
      <section className="stack" aria-labelledby="scheduled-heading">
        <h2 id="scheduled-heading">Scheduled</h2>
        {(scheduled.data?.posts ?? []).length === 0 ? (
          <p className="empty">Nothing scheduled.</p>
        ) : (
          <ul className="channel-feed" aria-label="Scheduled posts">
            {(scheduled.data?.posts ?? []).map((post) => (
              <li key={post.id}>
                <PostCard {...props} post={post} onChange={refresh} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="stack" aria-labelledby="drafts-heading">
        <h2 id="drafts-heading">Drafts</h2>
        {(drafts.data?.posts ?? []).length === 0 ? (
          <p className="empty">No drafts.</p>
        ) : (
          <ul className="channel-feed" aria-label="Drafts">
            {(drafts.data?.posts ?? []).map((post) => (
              <li key={post.id}>
                <PostCard {...props} post={post} onChange={refresh} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
