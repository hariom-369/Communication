import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';

import {
  deliveryState,
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  type DeliveryState,
  type Poll,
  type TimelineMessage,
} from '../../messaging/timeline.js';

import type { UploadProgress } from '../../messaging/store.js';
import { useHarmfulLinks } from '../../moderation/link-safety.js';

import { AttachmentView, UploadingAttachment } from './AttachmentView.js';
import { clockTime } from './format.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '🙏'] as const;

const STATUS_TEXT: Record<DeliveryState, string> = {
  sending: 'Sending',
  queued: 'Waiting for connection',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not sent',
};

export function attachmentLabel(category: string): string {
  switch (category) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎬 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'audio':
      return '🎵 Audio';
    default:
      return '📄 File';
  }
}

export interface MessageBubbleProps {
  message: TimelineMessage;
  mine: boolean;
  quoted: TimelineMessage | undefined;
  quotedAuthor: string;
  peers: { deliveredUpTo: number; readUpTo: number };
  showRead: boolean;
  myId: string;
  /** Current time, supplied by the parent (renders must be pure). */
  now: number;
  onReply: () => void;
  onReact: (emoji: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRetry: () => void;
  /** Own attachment still uploading. */
  upload?: UploadProgress | undefined;
  onCancelUpload?: () => void;
  // ---- groups ----
  /** Sender name shown above others' messages in groups. */
  author?: string | undefined;
  /** This user may delete the message as a group admin. */
  canModerate?: boolean;
  /** Pinning is offered when given (admins in groups, anyone in 1:1 chats). */
  pinned?: boolean;
  onPin?: ((pinned: boolean) => void) | undefined;
  /** False in announcement-only groups for members (no replies or reactions). */
  canRespond?: boolean;
  onVote?: (choices: number[]) => void;
  /** Report this message (offered for other people's messages). */
  onReport?: (() => void) | undefined;
}

function PollCard({
  poll,
  myId,
  onVote,
  disabled,
}: {
  poll: Poll;
  myId: string;
  onVote: ((choices: number[]) => void) | undefined;
  disabled: boolean;
}): ReactNode {
  const mine = poll.votes[myId] ?? [];
  const totals = poll.options.map(
    (_, index) => Object.values(poll.votes).filter((choices) => choices.includes(index)).length,
  );
  const voters = Object.keys(poll.votes).length;
  const toggle = (index: number) => {
    if (onVote === undefined) return;
    if (poll.multiple)
      onVote(mine.includes(index) ? mine.filter((c) => c !== index) : [...mine, index]);
    else onVote(mine.includes(index) ? [] : [index]);
  };
  return (
    <fieldset className="poll">
      <legend className="poll__question">{poll.question}</legend>
      <p className="t-field__hint">
        {poll.multiple ? 'Choose any' : 'Choose one'} · {voters} {voters === 1 ? 'vote' : 'votes'}
      </p>
      <ul className="poll__options">
        {poll.options.map((option, index) => {
          const share = voters === 0 ? 0 : Math.round(((totals[index] ?? 0) / voters) * 100);
          return (
            <li key={index}>
              <button
                type="button"
                className="poll__option"
                aria-pressed={mine.includes(index)}
                disabled={disabled || onVote === undefined}
                onClick={() => toggle(index)}
              >
                <span className="poll__label">{option}</span>
                <span className="poll__count">
                  {totals[index] ?? 0} · {share}%
                </span>
                <span className="poll__bar" style={{ inlineSize: `${share}%` }} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** One message. Text is rendered as React text nodes — never as HTML (docs/security.md §4). */
export function MessageBubble(props: MessageBubbleProps): ReactNode {
  const { message, mine } = props;
  const [actionsOpen, setActionsOpen] = useState(false);
  const state = mine ? deliveryState(message, props.peers, props.showRead) : null;
  const age = message.serverTime === null ? 0 : props.now - message.serverTime;
  const canEdit = mine && !message.deleted && message.seq !== null && age < EDIT_WINDOW_MS;
  const canDelete =
    !message.deleted &&
    message.seq !== null &&
    ((mine && age < DELETE_WINDOW_MS) || (!mine && props.canModerate === true));
  const canRespond = props.canRespond !== false;
  const accepted = message.seq !== null && !message.deleted && !message.undecodable;
  // Other people's links are checked on this device against the harmful-link list.
  const harmful = useHarmfulLinks(message.text, !mine && !message.deleted);
  const myReaction = props.message.reactions[props.myId] ?? null;
  const reactionCounts = Object.values(message.reactions).reduce<Record<string, number>>(
    (counts, emoji) => {
      counts[emoji] = (counts[emoji] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return (
    <li
      className={[
        'message',
        mine ? 'message--mine' : '',
        message.mentions.includes(props.myId) ? 'message--mention' : '',
      ]
        .filter((c) => c !== '')
        .join(' ')}
      data-status={state ?? undefined}
    >
      <div className="bubble">
        {props.author === undefined || mine ? null : (
          <p className="bubble__author">{props.author}</p>
        )}
        {props.pinned === true ? <p className="bubble__pinned">📌 Pinned</p> : null}
        {props.quoted === undefined ? null : (
          <p className="bubble__quote">
            <span className="bubble__quote-author">{props.quotedAuthor}</span>
            {props.quoted.deleted
              ? 'Message deleted'
              : props.quoted.text !== ''
                ? props.quoted.text
                : props.quoted.attachment !== null
                  ? attachmentLabel(props.quoted.attachment.category)
                  : ''}
          </p>
        )}
        {message.undecodable ? (
          <p className="bubble__text bubble__text--muted">
            This message couldn’t be decrypted on this device.
          </p>
        ) : message.deleted ? (
          <p className="bubble__text bubble__text--muted">
            {mine ? 'You deleted this message' : 'This message was deleted'}
          </p>
        ) : (
          <>
            {props.upload !== undefined ? (
              <UploadingAttachment
                upload={props.upload}
                onCancel={() => props.onCancelUpload?.()}
              />
            ) : message.attachment !== null ? (
              <AttachmentView attachment={message.attachment} />
            ) : null}
            {message.poll !== null ? (
              <PollCard
                poll={message.poll}
                myId={props.myId}
                onVote={props.onVote}
                disabled={!canRespond || message.seq === null}
              />
            ) : message.text === '' ? null : (
              <p className="bubble__text">{message.text}</p>
            )}
            {harmful.length === 0 ? null : (
              <p className="bubble__warning" role="note">
                ⚠ This message links to a site reported as harmful ({harmful.join(', ')}). Do not
                enter passwords or payment details there.
              </p>
            )}
          </>
        )}
        <p className="bubble__meta">
          {message.edited && !message.deleted ? <span>edited · </span> : null}
          <time dateTime={new Date(message.serverTime ?? message.sentAt).toISOString()}>
            {clockTime(message.serverTime ?? message.sentAt)}
          </time>
          {state === null ? null : (
            <span className={`status status--${state}`}> · {STATUS_TEXT[state]}</span>
          )}
        </p>
        {Object.keys(reactionCounts).length === 0 ? null : (
          <p className="reactions" aria-label="Reactions">
            {Object.entries(reactionCounts).map(([emoji, count]) => (
              <span key={emoji} className="reaction">
                {emoji} {count > 1 ? count : ''}
              </span>
            ))}
          </p>
        )}
      </div>
      {state === 'failed' ? (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
      {accepted ? (
        <div className="message__actions">
          <button
            type="button"
            className="icon-button"
            aria-expanded={actionsOpen}
            aria-label="Message actions"
            onClick={() => setActionsOpen(!actionsOpen)}
          >
            ⋯
          </button>
          {actionsOpen ? (
            <div className="action-bar" role="group" aria-label="Message actions">
              {(canRespond ? REACTIONS : []).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="icon-button"
                  aria-pressed={myReaction === emoji}
                  aria-label={`React ${emoji}`}
                  onClick={() => {
                    props.onReact(myReaction === emoji ? null : emoji);
                    setActionsOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
              {canRespond ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    props.onReply();
                    setActionsOpen(false);
                  }}
                >
                  Reply
                </button>
              ) : null}
              {props.onPin === undefined ? null : (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    props.onPin?.(props.pinned !== true);
                    setActionsOpen(false);
                  }}
                >
                  {props.pinned === true ? 'Unpin' : 'Pin'}
                </button>
              )}
              {canEdit ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    props.onEdit();
                    setActionsOpen(false);
                  }}
                >
                  Edit
                </button>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  className="text-button text-button--danger"
                  onClick={() => {
                    props.onDelete();
                    setActionsOpen(false);
                  }}
                >
                  {mine ? 'Delete for everyone' : 'Remove for everyone'}
                </button>
              ) : null}
              {!mine && props.onReport !== undefined ? (
                <button
                  type="button"
                  className="text-button text-button--danger"
                  onClick={() => {
                    props.onReport?.();
                    setActionsOpen(false);
                  }}
                >
                  Report
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
