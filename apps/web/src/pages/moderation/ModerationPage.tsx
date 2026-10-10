import type { AppealSummary, CaseSummary, StaffRole, Transparency } from '@tessera/validation';
import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import { useCallback, useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { moderationEndpoints } from '../../api/moderation-endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { ACTION_LABELS, categoryLabel } from '../../moderation/labels.js';
import { dueLabel, useStaffRoles } from '../../moderation/use-staff.js';
import { useStepUp } from '../../state/step-up.js';

type Tab = 'queue' | 'appeals' | 'links' | 'legal';
const STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'actioned', label: 'Actioned' },
  { value: 'dismissed', label: 'Dismissed' },
] as const;

/** Current time, refreshed every 30 seconds (SLA countdowns). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Moderation console (docs/moderation.md §6; interim inside the app until the admin console of
 * Phase 12). Staff see cases — never conversations — and every evidence view is recorded.
 */
export function ModerationPage(): ReactNode {
  const roles = useStaffRoles();
  const [tab, setTab] = useState<Tab>('queue');
  if (roles === null)
    return (
      <div className="settings-page" role="status" aria-busy="true" aria-label="Loading">
        <Skeleton height="4rem" shape="tile" />
      </div>
    );
  if (roles.length === 0)
    return (
      <div className="settings-page">
        <PageHeading>Moderation</PageHeading>
        <Alert tone="warning">This area is for Tessera’s safety team.</Alert>
      </div>
    );
  const tabs: { id: Tab; label: string }[] = [
    { id: 'queue', label: 'Cases' },
    { id: 'appeals', label: 'Appeals' },
    { id: 'links', label: 'Harmful links' },
    ...(roles.includes('legal') || roles.includes('senior_moderator')
      ? [{ id: 'legal' as const, label: 'Legal and reports' }]
      : []),
  ];
  return (
    <div className="settings-page">
      <PageHeading description={`Your roles: ${roles.map((r) => r.replace('_', ' ')).join(', ')}`}>
        Moderation
      </PageHeading>
      <div className="segmented" role="tablist" aria-label="Moderation sections">
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
      {tab === 'queue' ? <Queue /> : null}
      {tab === 'appeals' ? <Appeals /> : null}
      {tab === 'links' ? <Blocklist /> : null}
      {tab === 'legal' ? <Legal roles={roles} /> : null}
    </div>
  );
}

function Queue(): ReactNode {
  const now = useNow();
  const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const [cases, setCases] = useState<CaseSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      moderationEndpoints.cases({ status }).then(
        (value) => {
          if (!cancelled) setCases(value.cases);
        },
        (caught: unknown) => {
          if (!cancelled) setError(errorMessage(caught));
        },
      );
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status]);

  return (
    <section className="settings-section stack" aria-labelledby="queue-heading">
      <h2 id="queue-heading">Cases</h2>
      <div className="button-row" role="group" aria-label="Case status">
        {STATUSES.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={status === option.value ? 'primary' : 'ghost'}
            aria-pressed={status === option.value}
            onClick={() => {
              setCases(undefined);
              setStatus(option.value);
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {cases === undefined ? (
        <Skeleton height="4rem" shape="tile" />
      ) : cases.length === 0 ? (
        <p className="empty">No cases.</p>
      ) : (
        <ul className="plain-list stack" aria-label="Cases, most urgent first">
          {cases.map((item) => (
            <li key={item.id} className="notice-card">
              <p>
                <Link to={`/moderation/cases/${item.id}`}>
                  <strong>{categoryLabel(item.category)}</strong> · {item.subjectLabel}
                </Link>
              </p>
              <p className="t-field__hint">
                Priority {item.priority} · {item.source.replace('_', ' ')} ·{' '}
                {item.reportCount === 1 ? '1 report' : `${item.reportCount} reports`}
                {item.legalHold ? ' · legal hold' : ''}
              </p>
              {item.status === 'open' ? (
                <p className={item.breached ? 'sla sla--breached' : 'sla'}>
                  {item.breached ? 'Deadline missed · ' : ''}
                  {item.acknowledgedAt === null
                    ? `Acknowledge ${dueLabel(item.ackDueAt, now)} · resolve ${dueLabel(item.dueAt, now)}`
                    : `Resolve ${dueLabel(item.dueAt, now)}`}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Appeals(): ReactNode {
  const [appeals, setAppeals] = useState<AppealSummary[]>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    moderationEndpoints.appeals().then(
      (value) => {
        if (!cancelled) setAppeals(value.appeals);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <section className="settings-section stack" aria-labelledby="appeals-heading">
      <h2 id="appeals-heading">Open appeals</h2>
      <p className="t-field__hint">
        Appeals are decided by someone who did not take or approve the decision.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {appeals === undefined ? null : appeals.length === 0 ? (
        <p className="empty">No open appeals.</p>
      ) : (
        <ul className="plain-list stack">
          {appeals.map((appeal) => (
            <AppealCard key={appeal.id} appeal={appeal} onDone={() => setVersion((v) => v + 1)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AppealCard({ appeal, onDone }: { appeal: AppealSummary; onDone: () => void }): ReactNode {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function decide(outcome: 'upheld' | 'overturned') {
    if (reason.trim() === '') {
      setError('Explain the decision to the person.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await moderationEndpoints.decideAppeal(appeal.id, outcome, reason.trim());
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <li className="notice-card stack">
      <p>
        <strong>{appeal.user}</strong> appeals: {ACTION_LABELS[appeal.action.action]} (
        {categoryLabel(appeal.action.reasonCode)}) ·{' '}
        <Link to={`/moderation/cases/${appeal.caseId}`}>case</Link>
      </p>
      <blockquote className="appeal-statement">{appeal.statement}</blockquote>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <div className="t-field">
        <label className="t-field__label" htmlFor={id}>
          Reason (shown to the person)
        </label>
        <textarea
          id={id}
          className="t-field__input"
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="button-row">
        <Button size="sm" loading={busy} onClick={() => void decide('overturned')}>
          Overturn
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('upheld')}>
          Uphold
        </Button>
      </div>
    </li>
  );
}

function Blocklist(): ReactNode {
  const ids = useId();
  const [entries, setEntries] = useState<{ host: string; category: string }[]>();
  const [host, setHost] = useState('');
  const [category, setCategory] = useState<'phishing' | 'malware' | 'scam' | 'csam'>('phishing');
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    moderationEndpoints.blocklist().then(
      (value) => setEntries(value.entries),
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);
  useEffect(load, [load]);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await moderationEndpoints.addBlockedHost(host.trim(), category);
      setHost('');
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="links-heading">
      <h2 id="links-heading">Harmful links</h2>
      <p className="t-field__hint">
        Devices warn about these hosts in chats (they check privately, by hash prefix); public posts
        and comments that link to them are refused.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <form className="button-row" onSubmit={(event) => void add(event)}>
        <TextField
          label="Host"
          value={host}
          required
          placeholder="phishing.example"
          onChange={(e) => setHost(e.target.value)}
        />
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-category`}>
            Kind
          </label>
          <select
            id={`${ids}-category`}
            className="t-field__input"
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
          >
            <option value="phishing">Phishing</option>
            <option value="malware">Malware</option>
            <option value="scam">Scam</option>
            <option value="csam">Child abuse material</option>
          </select>
        </div>
        <Button type="submit">Block host</Button>
      </form>
      {entries === undefined ? null : entries.length === 0 ? (
        <p className="empty">No hosts are blocked.</p>
      ) : (
        <ul className="plain-list">
          {entries.map((entry) => (
            <li key={entry.host} className="button-row">
              <span>
                {entry.host} · {entry.category}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void moderationEndpoints
                    .removeBlockedHost(entry.host)
                    .then(load, (caught: unknown) => setError(errorMessage(caught)))
                }
              >
                Unblock {entry.host}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Legal({ roles }: { roles: StaffRole[] }): ReactNode {
  const legal = roles.includes('legal');
  return (
    <>
      <TransparencyReport />
      {legal ? <LegalOrderForm /> : null}
      {legal ? <AbuseHashes /> : null}
    </>
  );
}

function TransparencyReport(): ReactNode {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [figures, setFigures] = useState<Transparency>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    moderationEndpoints.transparency(month).then(
      (value) => {
        if (!cancelled) setFigures(value);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [month]);
  return (
    <section className="settings-section stack" aria-labelledby="transparency-heading">
      <h2 id="transparency-heading">Monthly compliance report</h2>
      <TextField
        label="Month"
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
      />
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {figures === undefined ? null : (
        <dl className="details">
          <dt>Reports received</dt>
          <dd>{figures.reportsReceived}</dd>
          <dt>Grievances received</dt>
          <dd>{figures.grievancesReceived}</dd>
          <dt>Legal orders received</dt>
          <dd>{figures.legalOrdersReceived}</dd>
          <dt>Cases opened / resolved</dt>
          <dd>
            {figures.casesOpened} / {figures.casesResolved}
          </dd>
          <dt>Missed deadlines</dt>
          <dd>{figures.slaBreaches}</dd>
          <dt>Actions</dt>
          <dd>
            {Object.entries(figures.actions)
              .map(([action, count]) => `${ACTION_LABELS[action] ?? action}: ${count}`)
              .join(', ') || 'None'}
          </dd>
          <dt>Appeals (upheld / overturned)</dt>
          <dd>
            {figures.appeals.received} ({figures.appeals.upheld} / {figures.appeals.overturned})
          </dd>
          <dt>Automated actions</dt>
          <dd>{figures.automated}</dd>
        </dl>
      )}
    </section>
  );
}

function LegalOrderForm(): ReactNode {
  const ids = useId();
  const { withStepUp } = useStepUp();
  const [kind, setKind] = useState<'court_order' | 'government_order'>('court_order');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [subjectKind, setSubjectKind] = useState('user');
  const [subjectId, setSubjectId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const result = await withStepUp(() =>
        moderationEndpoints.legalOrder({
          kind,
          reference: reference.trim(),
          description: description.trim(),
          subject: {
            kind: subjectKind,
            id: subjectId.trim(),
            ...(channelId.trim() === '' ? {} : { channelId: channelId.trim() }),
          },
        }),
      );
      if (result !== undefined) setCreated(result.caseId);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="order-heading">
      <h2 id="order-heading">Record a legal order</h2>
      <p className="t-field__hint">
        Court and government orders must be acted on within 3 hours. The case is put on legal hold.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {created === undefined ? null : (
        <Alert tone="success">
          Recorded. <Link to={`/moderation/cases/${created}`}>Open the case</Link>
        </Alert>
      )}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-kind`}>
            Kind of order
          </label>
          <select
            id={`${ids}-kind`}
            className="t-field__input"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="court_order">Court order</option>
            <option value="government_order">Government order</option>
          </select>
        </div>
        <TextField
          label="Order reference"
          required
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-description`}>
            What the order requires
          </label>
          <textarea
            id={`${ids}-description`}
            className="t-field__input"
            rows={3}
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-subject`}>
            It concerns
          </label>
          <select
            id={`${ids}-subject`}
            className="t-field__input"
            value={subjectKind}
            onChange={(e) => setSubjectKind(e.target.value)}
          >
            <option value="user">An account</option>
            <option value="channel">A channel</option>
            <option value="post">A channel post</option>
            <option value="comment">A comment</option>
            <option value="community">A community</option>
          </select>
        </div>
        <TextField
          label="Its id"
          required
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
        />
        {subjectKind === 'post' || subjectKind === 'comment' ? (
          <TextField
            label="Channel id"
            required
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
          />
        ) : null}
        <div>
          <Button type="submit">Record order</Button>
        </div>
      </form>
    </section>
  );
}

function AbuseHashes(): ReactNode {
  const ids = useId();
  const { withStepUp } = useStepUp();
  const [count, setCount] = useState<number>();
  const [hashes, setHashes] = useState('');
  const [source, setSource] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();
  useEffect(() => {
    moderationEndpoints.abuseHashCount().then(
      (value) => setCount(value.count),
      () => undefined,
    );
  }, []);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setMessage(undefined);
    const list = hashes
      .split(/\s+/)
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '');
    try {
      const result = await withStepUp(() =>
        moderationEndpoints.importAbuseHashes(list, source.trim()),
      );
      if (result === undefined) return;
      setMessage({ tone: 'success', text: `${result.count} new hashes added.` });
      setHashes('');
      setCount((current) => (current ?? 0) + result.count);
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="hashes-heading">
      <h2 id="hashes-heading">Known child abuse material</h2>
      <p className="t-field__hint">
        SHA-256 hashes of files from a recognised hash list (exact matches only; perceptual matching
        is not available yet). {count === undefined ? '' : `${count} loaded.`}
      </p>
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <div className="t-field">
          <label className="t-field__label" htmlFor={`${ids}-hashes`}>
            Hashes (hex, one per line)
          </label>
          <textarea
            id={`${ids}-hashes`}
            className="t-field__input"
            rows={4}
            required
            value={hashes}
            onChange={(e) => setHashes(e.target.value)}
          />
        </div>
        <TextField
          label="Source of the list"
          required
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <div>
          <Button type="submit">Import</Button>
        </div>
      </form>
    </section>
  );
}
