import type { MyReport, Notice, Standing } from '@tessera/validation';
import { Alert, Button, Skeleton } from '@tessera/ui';
import { useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { moderationEndpoints } from '../../api/moderation-endpoints.js';
import { AuthLayout } from '../../components/AuthLayout.js';
import { PageHeading } from '../../components/PageHeading.js';
import { ACTION_LABELS, categoryLabel } from '../../moderation/labels.js';
import { useSession } from '../../state/session.js';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const format = (iso: string) => when.format(new Date(iso));

const STATUS_TEXT: Record<Standing['status'], string> = {
  good: 'Your account is in good standing.',
  restricted: 'Some features of your account are limited.',
  suspended: 'Your account is suspended.',
  banned: 'Your account is banned.',
};

const REPORT_STATUS: Record<MyReport['status'], string> = {
  received: 'Received — being reviewed',
  action_taken: 'Reviewed — we took action',
  no_violation: 'Reviewed — no rule was broken',
};

function AppealForm({ notice, onDone }: { notice: Notice; onDone: () => void }): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await moderationEndpoints.appeal(notice.actionId, statement.trim());
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Appeal this decision
      </Button>
    );
  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="t-field">
        <label className="t-field__label" htmlFor={id}>
          Why should we look at this again?
        </label>
        <textarea
          id={id}
          className="t-field__input"
          rows={4}
          maxLength={2000}
          required
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
        <p className="t-field__hint">
          Someone who was not involved in the decision will review your appeal.
        </p>
      </div>
      <div className="button-row">
        <Button type="submit" size="sm" loading={busy} loadingLabel="Sending appeal">
          Send appeal
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Account status: decisions about this account, appeals, and the person's own reports. */
export function AccountStanding({ headingLevel }: { headingLevel: 1 | 2 }): ReactNode {
  const [standing, setStanding] = useState<Standing>();
  const [reports, setReports] = useState<MyReport[]>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    moderationEndpoints.standing().then(
      (value) => {
        if (!cancelled) setStanding(value);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    moderationEndpoints.myReports().then(
      (value) => {
        if (!cancelled) setReports(value.reports);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  const Heading = headingLevel === 1 ? 'h2' : 'h3';
  if (error !== undefined) return <Alert tone="danger">{error}</Alert>;
  if (standing === undefined)
    return (
      <div role="status" aria-busy="true" aria-label="Loading account status" className="stack">
        <Skeleton height="4rem" shape="tile" />
      </div>
    );
  return (
    <div className="stack">
      {sent ? (
        <Alert tone="success">
          Your appeal was sent. We will tell you the outcome here and by email.
        </Alert>
      ) : null}
      <Alert
        tone={standing.status === 'good' ? 'success' : 'warning'}
        title={STATUS_TEXT[standing.status]}
      >
        {standing.suspendedUntil === null ? null : (
          <p>Suspended until {format(standing.suspendedUntil)}.</p>
        )}
      </Alert>
      <section className="settings-section" aria-labelledby="decisions-heading">
        <Heading id="decisions-heading">Decisions about your account</Heading>
        {standing.notices.length === 0 ? (
          <p className="empty">Nothing in the last 30 days.</p>
        ) : (
          <ul className="plain-list stack">
            {standing.notices.map((notice) => (
              <li key={notice.actionId} className="notice-card">
                <p>
                  <strong>{ACTION_LABELS[notice.action] ?? notice.action}</strong>
                  {notice.restriction === null
                    ? null
                    : notice.restriction === 'creation'
                      ? ' — cannot start chats or create groups, channels or invite links'
                      : ' — cannot start new chats'}
                </p>
                <p>Reason: {categoryLabel(notice.reasonCode)}</p>
                <p className="t-field__hint">
                  {format(notice.startsAt)}
                  {notice.endsAt === null ? '' : ` until ${format(notice.endsAt)}`}
                  {notice.active ? '' : ' · no longer in effect'}
                </p>
                {notice.appeal === null ? null : (
                  <p>
                    Appeal:{' '}
                    {notice.appeal.status === 'open'
                      ? 'being reviewed'
                      : notice.appeal.status === 'overturned'
                        ? 'accepted — the decision was reversed'
                        : 'not accepted — the decision stays'}
                    {notice.appeal.reason === null ? '' : ` (${notice.appeal.reason})`}
                  </p>
                )}
                {notice.appealable ? (
                  <AppealForm
                    notice={notice}
                    onDone={() => {
                      setSent(true);
                      setVersion((v) => v + 1);
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="t-field__hint">
          You can appeal a decision for 30 days. If you disagree with the outcome, you can also
          contact our grievance officer at <Link to="/grievance">the grievance page</Link>.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="reports-heading">
        <Heading id="reports-heading">Your reports</Heading>
        {reports === undefined || reports.length === 0 ? (
          <p className="empty">You have not reported anything.</p>
        ) : (
          <ul className="plain-list">
            {reports.map((report) => (
              <li key={report.id}>
                {categoryLabel(report.category)} · {format(report.createdAt)} ·{' '}
                {REPORT_STATUS[report.status]}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function AccountStatusPage(): ReactNode {
  return (
    <div className="settings-page">
      <PageHeading description="Decisions our safety team made about your account, and your reports.">
        Account status
      </PageHeading>
      <AccountStanding headingLevel={1} />
    </div>
  );
}

/** What a suspended or banned account sees after signing in (docs/moderation.md §5). */
export function SuspendedScreen(): ReactNode {
  const { clear } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout>
      <PageHeading>Account status</PageHeading>
      <AccountStanding headingLevel={1} />
      <div className="button-row">
        <Button
          variant="ghost"
          loading={busy}
          loadingLabel="Signing out"
          onClick={() => {
            setBusy(true);
            void endpoints
              .logout()
              .catch(() => undefined)
              .finally(clear);
          }}
        >
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}
