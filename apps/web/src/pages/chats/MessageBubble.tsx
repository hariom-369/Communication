import { Button } from '@tessera/ui';
import { useState, type ReactNode } from 'react';

import {
  deliveryState,
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  type DeliveryState,
  type TimelineMessage,
} from '../../messaging/timeline.js';

import type { UploadProgress } from '../../messaging/store.js';

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
}

/** One message. Text is rendered as React text nodes — never as HTML (docs/security.md §4). */
export function MessageBubble(props: MessageBubbleProps): ReactNode {
  const { message, mine } = props;
  const [actionsOpen, setActionsOpen] = useState(false);
  const state = mine ? deliveryState(message, props.peers, props.showRead) : null;
  const age = message.serverTime === null ? 0 : props.now - message.serverTime;
  const canEdit = mine && !message.deleted && message.seq !== null && age < EDIT_WINDOW_MS;
  const canDelete = mine && !message.deleted && message.seq !== null && age < DELETE_WINDOW_MS;
  const accepted = message.seq !== null && !message.deleted && !message.undecodable;
  const myReaction = props.message.reactions[props.myId] ?? null;
  const reactionCounts = Object.values(message.reactions).reduce<Record<string, number>>(
    (counts, emoji) => {
      counts[emoji] = (counts[emoji] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return (
    <li className={mine ? 'message message--mine' : 'message'} data-status={state ?? undefined}>
      <div className="bubble">
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
            {message.text === '' ? null : <p className="bubble__text">{message.text}</p>}
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
              {REACTIONS.map((emoji) => (
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
                  Delete for everyone
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
