import {
  ENFORCEMENT_ACTIONS,
  REASON_CODES,
  type CaseDetail,
  type EvidenceView,
  type StaffRole,
} from '@tessera/validation';
import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { moderationEndpoints } from '../../api/moderation-endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { contentSchema } from '../../messaging/content.js';
import { ACTION_LABELS, categoryLabel } from '../../moderation/labels.js';
import { dueLabel, useStaffRoles } from '../../moderation/use-staff.js';
import { useStepUp } from '../../state/step-up.js';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const format = (iso: string) => when.format(new Date(iso));

const VERIFICATION: Record<string, string> = {
  content_verified: 'Messages verified (the sender’s device sent exactly this)',
  unverified: 'Messages not verified (no franking proof) — corroborate before severe action',
  server_content: 'Captured by the server at report time',
  none: 'No content attached',
};

/** Which actions fit a case's subject (the server checks again). */
function actionsFor(detail: CaseDetail): (typeof ENFORCEMENT_ACTIONS)[number][] {
  return ENFORCEMENT_ACTIONS.filter((action) => {
    if (['warn', 'restrict', 'suspend', 'ban'].includes(action))
      return detail.subjectUserId !== null;
    if (action === 'remove_content')
      return detail.subjectKind === 'post' || detail.subjectKind === 'comment';
    if (action === 'channel_unlist' || action === 'channel_suspend')
      return ['channel', 'post', 'comment'].includes(detail.subjectKind);
    return true;
  });
}

/** Text of a reported message, from its decrypted content (rendered as text only). */
function describe(plaintext: string): string {
  try {
    const parsed = contentSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) return '(content in an unknown format)';
    const body = parsed.data.body;
    if (body.kind === 'text') return body.text;
    if (body.kind === 'media')
      return `📎 ${body.attachment.name}${body.caption === undefined ? '' : ` — ${body.caption}`}`;
    if (body.kind === 'edit') return `(edit) ${body.text}`;
    if (body.kind === 'poll') return `(poll) ${body.question}`;
    return `(${body.kind})`;
  } catch {
    return '(unreadable)';
  }
}

export function CaseView(): ReactNode {
  const { caseId = '' } = useParams();
  const roles = useStaffRoles();
  const [detail, setDetail] = useState<CaseDetail>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    moderationEndpoints
      .caseDetail(caseId)
      .then(setDetail, (caught: unknown) => setError(errorMessage(caught)));
  }, [caseId]);
  useEffect(load, [load]);

  if (error !== undefined && detail === undefined)
    return (
      <div className="settings-page">
        <PageHeading>Case</PageHeading>
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  if (detail === undefined || roles === null)
    return (
      <div className="settings-page" role="status" aria-busy="true" aria-label="Loading case">
        <Skeleton height="6rem" shape="tile" />
      </div>
    );
  return <CaseBody detail={detail} roles={roles} reload={load} />;
}

function CaseBody({
  detail,
  roles,
  reload,
}: {
  detail: CaseDetail;
  roles: StaffRole[];
  reload: () => void;
}): ReactNode {
  const [now] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const { withStepUp } = useStepUp();
  const senior = roles.includes('senior_moderator') || roles.includes('legal');

  async function run(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="settings-page">
      <p>
        <Link to="/moderation">← All cases</Link>
      </p>
      <PageHeading description={`${detail.subjectLabel} · priority ${detail.priority}`}>
        {categoryLabel(detail.category)}
      </PageHeading>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <section className="settings-section stack" aria-labelledby="status-heading">
        <h2 id="status-heading">Status</h2>
        <dl className="details">
          <dt>Status</dt>
          <dd>{detail.status}</dd>
          <dt>Source</dt>
          <dd>{detail.source.replace('_', ' ')}</dd>
          <dt>Opened</dt>
          <dd>{format(detail.openedAt)}</dd>
          <dt>Deadline</dt>
          <dd className={detail.breached ? 'sla sla--breached' : 'sla'}>
            {detail.acknowledgedAt === null
              ? `Acknowledge ${dueLabel(detail.ackDueAt, now)}; resolve ${dueLabel(detail.dueAt, now)}`
              : `Resolve ${dueLabel(detail.dueAt, now)}`}
            {detail.breached ? ' (missed)' : ''}
          </dd>
          {detail.legalHold ? (
            <>
              <dt>Legal hold</dt>
              <dd>Evidence is kept until the hold is lifted.</dd>
            </>
          ) : null}
        </dl>
        {detail.status === 'open' && detail.acknowledgedAt === null ? (
          <div>
            <Button
              size="sm"
              onClick={() => void run(() => moderationEndpoints.acknowledge(detail.id))}
            >
              Acknowledge and take this case
            </Button>
          </div>
        ) : null}
      </section>

      <section className="settings-section stack" aria-labelledby="reports-heading">
        <h2 id="reports-heading">Reports</h2>
        {detail.reports.length === 0 ? <p className="empty">No user reports.</p> : null}
        <ul className="plain-list stack">
          {detail.reports.map((report) => (
            <li key={report.id} className="notice-card">
              <p>
                {report.reporter ?? 'Deleted account'} · {categoryLabel(report.category)} ·{' '}
                {format(report.createdAt)}
              </p>
              <p className="t-field__hint">{VERIFICATION[report.verification]}</p>
              {report.details === '' ? null : <p>{report.details}</p>}
            </li>
          ))}
        </ul>
        {detail.grievances.map((grievance) => (
          <div key={grievance.id} className="notice-card">
            <p>
              {grievance.kind.replace('_', ' ')} from {grievance.contact} ·{' '}
              {format(grievance.createdAt)}
            </p>
            <p>{grievance.description}</p>
            {grievance.reference === '' ? null : <p>Reference: {grievance.reference}</p>}
          </div>
        ))}
      </section>

      <section className="settings-section stack" aria-labelledby="evidence-heading">
        <h2 id="evidence-heading">Evidence</h2>
        <p className="t-field__hint">
          Evidence stays encrypted until you open it. Every view is recorded on the case and in the
          audit log.
        </p>
        {detail.evidence.length === 0 ? <p className="empty">No evidence attached.</p> : null}
        {detail.evidence.map((item) => (
          <EvidenceItem
            key={item.id}
            caseId={detail.id}
            evidence={item}
            legal={roles.includes('legal')}
            onViewed={reload}
          />
        ))}
      </section>

      <section className="settings-section stack" aria-labelledby="actions-heading">
        <h2 id="actions-heading">Actions</h2>
        {detail.actions.length === 0 ? <p className="empty">No actions yet.</p> : null}
        <ul className="plain-list stack">
          {detail.actions.map((action) => (
            <li key={action.id} className="notice-card stack">
              <p>
                <strong>{ACTION_LABELS[action.action] ?? action.action}</strong>
                {action.restriction === null
                  ? ''
                  : ` (${action.restriction.replace('_', ' ')})`} ·{' '}
                {categoryLabel(action.reasonCode)} · {action.status.replace('_', ' ')}
              </p>
              <p className="t-field__hint">
                By {action.createdBy ?? 'automatic rule'}
                {action.approvedBy === null ? '' : `, reviewed by ${action.approvedBy}`} ·{' '}
                {format(action.createdAt)}
                {action.endsAt === null ? '' : ` · until ${format(action.endsAt)}`}
              </p>
              {action.note === '' ? null : <p>{action.note}</p>}
              <div className="button-row">
                {action.status === 'pending_review' && senior ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        void run(() => withStepUp(() => moderationEndpoints.approve(action.id, '')))
                      }
                    >
                      Approve as second reviewer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void run(() => moderationEndpoints.reject(action.id, ''))}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {action.status === 'active' && senior ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(() => withStepUp(() => moderationEndpoints.revert(action.id, '')))
                    }
                  >
                    Reverse
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {detail.status === 'open' ? (
          <ActionForm detail={detail} onDone={reload} onError={setError} />
        ) : null}
      </section>

      {detail.status === 'open' ? (
        <DismissForm caseId={detail.id} onDone={reload} onError={setError} />
      ) : null}
      <NoteForm caseId={detail.id} onDone={reload} onError={setError} />

      {detail.history.length === 0 ? null : (
        <section className="settings-section stack" aria-labelledby="history-heading">
          <h2 id="history-heading">Earlier decisions about this person</h2>
          <ul className="plain-list">
            {detail.history.map((action) => (
              <li key={action.id}>
                {ACTION_LABELS[action.action] ?? action.action} · {categoryLabel(action.reasonCode)}{' '}
                · {action.status.replace('_', ' ')} · {format(action.createdAt)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="settings-section stack" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        <ol className="plain-list">
          {detail.events.map((event, index) => (
            <li key={`${event.createdAt}-${String(index)}`}>
              {format(event.createdAt)} · {event.kind.replaceAll('_', ' ')}
              {event.actor === null ? '' : ` · ${event.actor}`}
              {typeof event.payload['note'] === 'string' && event.payload['note'] !== ''
                ? ` — ${event.payload['note']}`
                : ''}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function EvidenceItem({
  caseId,
  evidence,
  legal,
  onViewed,
}: {
  caseId: string;
  evidence: CaseDetail['evidence'][number];
  legal: boolean;
  onViewed: () => void;
}): ReactNode {
  const [view, setView] = useState<EvidenceView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const restricted = evidence.csamMatch && !legal;

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      setView(await moderationEndpoints.viewEvidence(caseId, evidence.id));
      onViewed();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="notice-card stack">
      <p>
        {evidence.kind === 'e2ee_bundle' ? 'Reported messages' : 'Captured content'} ·{' '}
        {Math.ceil(evidence.size / 1024)} KB
        {evidence.mediaCount > 0 ? ` · ${evidence.mediaCount} files` : ''}
        {evidence.csamMatch ? ' · matches known abuse material' : ''}
      </p>
      <p className="t-field__hint">SHA-256 at receipt: {evidence.sha256}</p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {restricted ? (
        <Alert tone="warning">Only the legal team can open this evidence.</Alert>
      ) : view === undefined ? (
        <div>
          <Button size="sm" loading={busy} loadingLabel="Opening" onClick={() => void open()}>
            Open evidence (recorded)
          </Button>
        </div>
      ) : view.kind === 'public_snapshot' ? (
        <pre className="evidence-snapshot">{JSON.stringify(view.snapshot, null, 2)}</pre>
      ) : (
        <div className="stack">
          <ol className="plain-list stack" aria-label="Reported messages">
            {view.bundle.messages.map((message) => (
              <li
                key={message.seq}
                className={
                  message.selected
                    ? 'evidence-message'
                    : 'evidence-message evidence-message--context'
                }
              >
                <p className="t-field__hint">
                  {message.selected ? 'Reported' : 'Context'} · {format(message.serverTime)} ·
                  sender {message.senderUserId.slice(0, 8)}
                  {message.frankingTag === null ? ' · not franked' : ''}
                </p>
                <p className="evidence-message__text">{describe(message.plaintext)}</p>
              </li>
            ))}
          </ol>
          {view.bundle.media.map((file) => (
            <EvidenceFile key={`${file.seq}-${file.name}`} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A reported file: images are blurred until revealed; nothing else is rendered in the page. */
function EvidenceFile({
  file,
}: {
  file: { seq: number; name: string; mime: string; data: string };
}): ReactNode {
  const [revealed, setRevealed] = useState(false);
  const image = /^image\/(jpeg|png|webp|gif)$/.test(file.mime);
  // A data: URL needs no cleanup; anything but a known image type is offered only as a download.
  const url = `data:${image ? file.mime : 'application/octet-stream'};base64,${file.data}`;
  return (
    <figure className="evidence-file">
      {image ? (
        <>
          <img
            src={url}
            alt={`Reported file ${file.name}`}
            className={
              revealed
                ? 'evidence-file__image'
                : 'evidence-file__image evidence-file__image--hidden'
            }
          />
          <Button size="sm" variant="ghost" onClick={() => setRevealed(!revealed)}>
            {revealed ? 'Hide image' : 'Show image'}
          </Button>
        </>
      ) : (
        <a href={url} download={file.name.replace(/[^\w.-]+/g, '_')}>
          Download {file.name}
        </a>
      )}
      <figcaption className="t-field__hint">
        {file.name} · {file.mime}
      </figcaption>
    </figure>
  );
}

function ActionForm({
  detail,
  onDone,
  onError,
}: {
  detail: CaseDetail;
  onDone: () => void;
  onError: (message: string | undefined) => void;
}): ReactNode {
  const ids = useId();
  const choices = actionsFor(detail);
  const [action, setAction] = useState(choices[0] ?? 'warn');
  const [reasonCode, setReasonCode] = useState<string>(
    (REASON_CODES as readonly string[]).includes(detail.category)
      ? detail.category
      : 'other_policy',
  );
  const [restriction, setRestriction] = useState<'new_chats' | 'creation'>('new_chats');
  const [hours, setHours] = useState(72);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const timed = action === 'restrict' || action === 'suspend';

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    onError(undefined);
    try {
      await moderationEndpoints.takeAction(detail.id, {
        action,
        reasonCode,
        note: note.trim(),
        ...(action === 'restrict' ? { restriction } : {}),
        ...(timed ? { durationHours: hours } : {}),
      });
      setNote('');
      onDone();
    } catch (caught) {
      onError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} aria-label="Take action">
      <h3>Take action</h3>
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-action`}>
          Action
        </label>
        <select
          id={`${ids}-action`}
          className="t-field__input"
          value={action}
          onChange={(e) => setAction(e.target.value as typeof action)}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {ACTION_LABELS[choice]}
              {choice === 'ban' || choice === 'legal_referral' ? ' (needs a second reviewer)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-reason`}>
          Reason (shown to the person)
        </label>
        <select
          id={`${ids}-reason`}
          className="t-field__input"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
        >
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {code === 'other_policy' ? 'Other rule' : categoryLabel(code)}
            </option>
          ))}
        </select>
      </div>
      {action === 'restrict' ? (
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-restriction`}>
            Limit
          </label>
          <select
            id={`${ids}-restriction`}
            className="t-field__input"
            value={restriction}
            onChange={(e) => setRestriction(e.target.value as typeof restriction)}
          >
            <option value="new_chats">Cannot start new chats</option>
            <option value="creation">Cannot start chats or create groups, channels or links</option>
          </select>
        </div>
      ) : null}
      {timed ? (
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-hours`}>
            For how long
          </label>
          <select
            id={`${ids}-hours`}
            className="t-field__input"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={24}>1 day</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
        </div>
      ) : null}
      <div className="t-field">
        <label className="t-field__label" htmlFor={`${ids}-note`}>
          Internal note (not shown to the person)
        </label>
        <textarea
          id={`${ids}-note`}
          className="t-field__input"
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" loading={busy} loadingLabel="Applying">
          Apply
        </Button>
      </div>
    </form>
  );
}

function DismissForm({
  caseId,
  onDone,
  onError,
}: {
  caseId: string;
  onDone: () => void;
  onError: (message: string | undefined) => void;
}): ReactNode {
  const id = useId();
  const [reason, setReason] = useState('no_violation');
  return (
    <section className="settings-section stack" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Close without action</h2>
      <div className="button-row">
        <label className="t-field__label" htmlFor={id}>
          Why
        </label>
        <select
          id={id}
          className="t-field__input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <option value="no_violation">No rule was broken</option>
          <option value="insufficient_evidence">Not enough evidence</option>
          <option value="duplicate">Duplicate</option>
          <option value="false_report">False report</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onError(undefined);
            moderationEndpoints
              .dismiss(caseId, reason, '')
              .then(onDone, (caught: unknown) => onError(errorMessage(caught)));
          }}
        >
          Close case
        </Button>
      </div>
    </section>
  );
}

function NoteForm({
  caseId,
  onDone,
  onError,
}: {
  caseId: string;
  onDone: () => void;
  onError: (message: string | undefined) => void;
}): ReactNode {
  const id = useId();
  const [note, setNote] = useState('');
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    onError(undefined);
    try {
      await moderationEndpoints.note(caseId, note.trim());
      setNote('');
      onDone();
    } catch (caught) {
      onError(errorMessage(caught));
    }
  }
  return (
    <form className="settings-section stack" onSubmit={(event) => void submit(event)}>
      <div className="t-field">
        <label className="t-field__label" htmlFor={id}>
          Add an internal note
        </label>
        <textarea
          id={id}
          className="t-field__input"
          rows={2}
          maxLength={2000}
          required
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" size="sm" variant="ghost">
          Add note
        </Button>
      </div>
    </form>
  );
}
