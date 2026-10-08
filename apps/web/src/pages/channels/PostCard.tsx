import { Alert, Button, TextField } from '@tessera/ui';
import { CHANNEL_REACTIONS, type channelPostSchema } from '@tessera/validation';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';
import type { z } from 'zod';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { useResource } from '../../lib/use-resource.js';
import { shortTime } from '../chats/format.js';

export type ChannelPost = z.infer<typeof channelPostSchema>;

/**
 * One channel post. Text is rendered as text nodes, never HTML; the link preview comes from the
 * server's own fetch and opens without a referrer.
 */
export function PostCard(props: {
  channelId: string;
  post: ChannelPost;
  myId: string;
  canEditAny: boolean;
  canDeleteAny: boolean;
  canPost: boolean;
  canModerateComments: boolean;
  commentsEnabled: boolean;
  onChange: (post: ChannelPost | null) => void;
}): ReactNode {
  const { post, channelId } = props;
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.body);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const mine = post.authorId === props.myId && props.canPost;
  const published = post.status === 'published';

  async function act(action: () => Promise<ChannelPost | null>) {
    setError(undefined);
    try {
      props.onChange(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    await act(() => endpoints.updateChannelPost(channelId, post.id, draft.trim()));
    setEditing(false);
  }

  const when =
    post.status === 'scheduled' && post.publishAt !== null
      ? `Scheduled for ${new Date(post.publishAt).toLocaleString()}`
      : post.status === 'draft'
        ? 'Draft'
        : shortTime(Date.parse(post.publishedAt ?? post.createdAt));

  return (
    <article className="channel-post" aria-labelledby={`post-${post.id}-meta`}>
      <p id={`post-${post.id}-meta`} className="channel-post__meta">
        <span>@{post.authorUsername}</span> · <span>{when}</span>
        {post.editedAt === null ? null : <span> · edited</span>}
      </p>
      {editing ? (
        <form className="stack" onSubmit={(event) => void save(event)}>
          <label className="t-field">
            <span className="t-field__label">Edit post</span>
            <textarea
              className="t-field__input"
              rows={4}
              maxLength={4096}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <div className="button-row">
            <Button type="submit" size="sm" disabled={draft.trim() === ''}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : post.body === '' ? null : (
        <p className="channel-post__body">{post.body}</p>
      )}
      {post.preview === null ? null : (
        <a
          className="link-card"
          href={post.preview.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          {post.preview.siteName === null ? null : (
            <span className="link-card__site">{post.preview.siteName}</span>
          )}
          <span className="link-card__title">
            {post.preview.title ?? new URL(post.preview.url).hostname}
          </span>
          {post.preview.description === null ? null : (
            <span className="link-card__description">{post.preview.description}</span>
          )}
        </a>
      )}
      {post.poll === null ? null : (
        <ChannelPoll
          channelId={channelId}
          post={post}
          disabled={!published}
          onVoted={(next) => props.onChange(next)}
        />
      )}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {published ? (
        <div className="channel-post__reactions" role="group" aria-label="Reactions">
          {CHANNEL_REACTIONS.map((emoji) => {
            const count = post.reactions.find((r) => r.emoji === emoji)?.count ?? 0;
            const mineReaction = post.myReaction === emoji;
            return (
              <button
                key={emoji}
                type="button"
                className="reaction-toggle"
                aria-pressed={mineReaction}
                aria-label={`React ${emoji}${count > 0 ? ` (${count})` : ''}`}
                onClick={() =>
                  void act(() =>
                    endpoints.reactToChannelPost(channelId, post.id, mineReaction ? null : emoji),
                  )
                }
              >
                {emoji}
                {count > 0 ? <span className="reaction-toggle__count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="button-row">
        {published && (props.commentsEnabled || post.commentCount > 0) ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={commentsOpen}
            onClick={() => setCommentsOpen(!commentsOpen)}
          >
            Comments ({post.commentCount})
          </Button>
        ) : null}
        {!published && props.canPost ? (
          <Button
            size="sm"
            onClick={() => void act(() => endpoints.publishChannelPost(channelId, post.id))}
          >
            Publish now
          </Button>
        ) : null}
        {(mine || props.canEditAny) && !editing ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        {mine || props.canDeleteAny ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm('Delete this post?'))
                void act(async () => {
                  await endpoints.deleteChannelPost(channelId, post.id);
                  return null;
                });
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {commentsOpen ? (
        <Comments
          channelId={channelId}
          postId={post.id}
          myId={props.myId}
          canModerate={props.canModerateComments}
          open={props.commentsEnabled}
        />
      ) : null}
    </article>
  );
}

function ChannelPoll(props: {
  channelId: string;
  post: ChannelPost;
  disabled: boolean;
  onVoted: (post: ChannelPost) => void;
}): ReactNode {
  const poll = props.post.poll;
  const [voters, setVoters] = useState<{ option: number; usernames: string[] }[] | null>(null);
  const [error, setError] = useState<string>();
  if (poll === null) return null;
  const total = poll.counts.reduce((sum, count) => sum + count, 0);

  async function vote(index: number) {
    if (poll === null) return;
    setError(undefined);
    const mine = poll.myChoices;
    const choices = poll.multiple
      ? mine.includes(index)
        ? mine.filter((c) => c !== index)
        : [...mine, index]
      : mine.includes(index)
        ? []
        : [index];
    try {
      props.onVoted(await endpoints.voteInChannelPoll(props.channelId, props.post.id, choices));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <fieldset className="poll">
      <legend className="poll__question">{poll.question}</legend>
      <p className="t-field__hint">
        {poll.multiple ? 'Choose any' : 'Choose one'} ·{' '}
        {poll.anonymous ? 'Anonymous' : 'Votes are public'} · {poll.voters}{' '}
        {poll.voters === 1 ? 'voter' : 'voters'}
      </p>
      <ul className="poll__options">
        {poll.options.map((option, index) => {
          const count = poll.counts[index] ?? 0;
          const share = total === 0 ? 0 : Math.round((count / total) * 100);
          return (
            <li key={index}>
              <button
                type="button"
                className="poll__option"
                aria-pressed={poll.myChoices.includes(index)}
                disabled={props.disabled}
                onClick={() => void vote(index)}
              >
                <span className="poll__label">{option}</span>
                <span className="poll__count">
                  {count} · {share}%
                </span>
                <span className="poll__bar" style={{ inlineSize: `${share}%` }} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {!poll.anonymous && !props.disabled ? (
        voters === null ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void endpoints.channelPollVoters(props.channelId, props.post.id).then(
                (result) => setVoters(result.options),
                (caught: unknown) => setError(errorMessage(caught)),
              )
            }
          >
            Show voters
          </Button>
        ) : (
          <ul className="plain-list" aria-label="Voters">
            {voters.map((entry) => (
              <li key={entry.option}>
                {poll.options[entry.option]}:{' '}
                {entry.usernames.length === 0
                  ? 'nobody'
                  : entry.usernames.map((u) => `@${u}`).join(', ')}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </fieldset>
  );
}

function Comments(props: {
  channelId: string;
  postId: string;
  myId: string;
  canModerate: boolean;
  open: boolean;
}): ReactNode {
  const load = useCallback(
    () => endpoints.channelComments(props.channelId, props.postId),
    [props.channelId, props.postId],
  );
  const comments = useResource(load);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.addChannelComment(props.channelId, props.postId, body.trim());
      setBody('');
      comments.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <section className="channel-comments stack" aria-label="Comments">
      {comments.error === undefined ? null : <Alert tone="danger">{comments.error}</Alert>}
      <ul className="member-list">
        {(comments.data?.comments ?? []).map((comment) => (
          <li key={comment.id} className="member">
            <p className="channel-post__meta">
              @{comment.authorUsername} · {shortTime(Date.parse(comment.createdAt))}
            </p>
            <p className="channel-post__body">{comment.body}</p>
            {comment.authorId === props.myId || props.canModerate ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void endpoints
                    .deleteChannelComment(props.channelId, comment.id)
                    .then(comments.reload, (caught: unknown) => {
                      setError(errorMessage(caught));
                    })
                }
              >
                Delete comment
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {(comments.data?.comments ?? []).length === 0 && comments.data !== undefined ? (
        <p className="empty">No comments yet.</p>
      ) : null}
      {props.open ? (
        <form className="stack" onSubmit={(event) => void add(event)}>
          <TextField
            label="Add a comment"
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
          <div className="button-row">
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={body.trim() === ''}
              loading={busy}
              loadingLabel="Sending"
            >
              Comment
            </Button>
          </div>
        </form>
      ) : (
        <p className="t-field__hint">Comments are turned off.</p>
      )}
    </section>
  );
}
