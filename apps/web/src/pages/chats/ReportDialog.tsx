import type { ReportCategory } from '@tessera/validation';
import { Alert, Button, Dialog } from '@tessera/ui';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';

import { errorMessage } from '../../api/client.js';
import { moderationEndpoints } from '../../api/moderation-endpoints.js';
import { useMediaTransfer, useMessagingStore } from '../../messaging/provider.js';
import type { ConversationView } from '../../messaging/store.js';
import { CATEGORY_LABELS } from '../../moderation/labels.js';
import { buildBundle, sealBundle, type ReportedFile } from '../../moderation/report-bundle.js';

/** How many recent messages are offered for selection. */
const SELECTABLE = 40;
const CONTEXT_CHOICES = [0, 3, 5, 10] as const;

export interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: ConversationView;
  myId: string;
  /** The other person in a direct chat. */
  peer: { userId: string; username: string } | null;
  /** The message the report was started from (timeline id), preselected. */
  initialMessageId: string | null;
  username: (userId: string) => string;
  /** After a report that also blocked someone. */
  onBlocked?: (userId: string) => void;
}

/**
 * Reporting from a chat (docs/moderation.md §3). Only what the person selects leaves the device:
 * the chosen messages (and, if they want, a few earlier ones for context and the files), sealed
 * to Tessera's moderation key. The chat itself stays end-to-end encrypted.
 */
export function ReportDialog(props: ReportDialogProps): ReactNode {
  return (
    <Dialog
      open={props.open}
      title={props.peer === null ? 'Report' : `Report @${props.peer.username}`}
      description="Only what you select here is sent to Tessera’s safety team, encrypted. Nobody else sees your report, and the person is not told who reported them."
      onClose={props.onClose}
    >
      <ReportForm key={props.initialMessageId ?? 'none'} {...props} />
    </Dialog>
  );
}

function ReportForm({
  onClose,
  conversation,
  myId,
  peer,
  initialMessageId,
  username,
  onBlocked,
}: ReportDialogProps): ReactNode {
  const store = useMessagingStore();
  const transfer = useMediaTransfer();
  const ids = useId();
  const { timeline, meta } = conversation;
  const candidates = timeline.order
    .flatMap((id) => {
      const message = timeline.byId[id];
      return message === undefined ? [] : [message];
    })
    .filter((message) => message.seq !== null && !message.deleted && message.call === null)
    .slice(-SELECTABLE);
  const [category, setCategory] = useState<ReportCategory>('harassment');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialMessageId === null ? [] : [initialMessageId]),
  );
  const [context, setContext] = useState<number>(3);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [details, setDetails] = useState('');
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const chosen = candidates.filter((message) => selected.has(message.id));
  const senders = [...new Set(chosen.map((m) => m.senderId).filter((id) => id !== myId))];
  const blockTarget = peer?.userId ?? (senders.length === 1 ? (senders[0] ?? null) : null);
  const hasFiles = chosen.some((message) => message.attachment !== null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (store === null) return;
    setBusy(true);
    setError(undefined);
    try {
      let target: Parameters<typeof moderationEndpoints.report>[0]['target'];
      if (chosen.length === 0) {
        target =
          peer === null
            ? { kind: 'conversation', conversationId: meta.id, seqs: [], bundle: null }
            : { kind: 'user', userId: peer.userId };
      } else {
        const [key, history] = await Promise.all([
          moderationEndpoints.moderationKey(),
          store.security.history(meta.id),
        ]);
        const files: ReportedFile[] = [];
        if (includeFiles && transfer !== null)
          for (const message of chosen) {
            if (message.attachment === null || message.seq === null) continue;
            const blob = await transfer.open(message.attachment.media, message.attachment.mime);
            files.push({
              seq: message.seq,
              name: message.attachment.name,
              mime: message.attachment.mime,
              data: new Uint8Array(await blob.arrayBuffer()),
            });
          }
        const bundle = buildBundle({
          conversationId: meta.id,
          reporterId: myId,
          history,
          selected: chosen.flatMap((message) => (message.seq === null ? [] : [message.seq])),
          context,
          files,
        });
        target = {
          kind: 'conversation',
          conversationId: meta.id,
          ...(peer === null ? {} : { userId: peer.userId }),
          seqs: bundle.messages.map((message) => message.seq),
          bundle: await sealBundle(key.publicKey, bundle),
        };
      }
      await moderationEndpoints.report({
        target,
        category,
        details: details.trim(),
        block: block && blockTarget !== null,
      });
      if (block && blockTarget !== null) onBlocked?.(blockTarget);
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
          <p>
            Our safety team will review it. You can follow your reports in Settings → Account
            status.
            {block && blockTarget !== null ? ` You blocked @${username(blockTarget)}.` : ''}
          </p>
        </Alert>
        <div className="button-row">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );

  return (
    <form className="stack report-form" onSubmit={(event) => void submit(event)}>
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
      {category === 'csam' || category === 'self_harm' ? (
        <Alert tone="warning">
          {category === 'csam'
            ? 'Do not forward or save this material. If a child is in danger, contact the police now.'
            : 'If someone is in immediate danger, contact local emergency services now.'}
        </Alert>
      ) : null}
      <fieldset className="report-form__messages">
        <legend className="t-field__label">Messages to include</legend>
        {candidates.length === 0 ? (
          <p className="t-field__hint">There are no messages to include.</p>
        ) : (
          <ul className="plain-list report-form__list">
            {candidates.map((message) => (
              <li key={message.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={selected.has(message.id)}
                    onChange={() => toggle(message.id)}
                  />
                  <span>
                    <strong>
                      {message.senderId === myId ? 'You' : `@${username(message.senderId)}`}:
                    </strong>{' '}
                    {message.text !== ''
                      ? message.text.slice(0, 140)
                      : message.attachment !== null
                        ? `📎 ${message.attachment.name}`
                        : 'Message'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="t-field__hint">
          {chosen.length === 0
            ? 'You can report without messages, but selected messages help us act.'
            : `${chosen.length} selected.`}
        </p>
      </fieldset>
      {chosen.length === 0 ? null : (
        <>
          <div className="t-field">
            <label className="t-field__label" htmlFor={`${ids}-context`}>
              Earlier messages for context
            </label>
            <select
              id={`${ids}-context`}
              className="t-field__input"
              value={context}
              onChange={(e) => setContext(Number(e.target.value))}
            >
              {CONTEXT_CHOICES.map((count) => (
                <option key={count} value={count}>
                  {count === 0 ? 'None' : `Up to ${count}`}
                </option>
              ))}
            </select>
          </div>
          {hasFiles ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeFiles}
                onChange={(e) => setIncludeFiles(e.target.checked)}
              />
              <span>Include the photos and files in the selected messages</span>
            </label>
          ) : null}
        </>
      )}
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-details`}>
          Anything else we should know? (optional)
        </label>
        <textarea
          id={`${ids}-details`}
          className="t-field__input"
          maxLength={1000}
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>
      {blockTarget === null ? null : (
        <label className="checkbox">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
          <span>Also block @{username(blockTarget)}</span>
        </label>
      )}
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
