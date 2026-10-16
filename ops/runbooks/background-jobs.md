# Runbook — background jobs

Alerts: `BackgroundJobFailing` (ticket), `BackgroundJobStalled` (page), `HourlyJobStalled`
(ticket), `NotifyQueueAgeHigh` (ticket).

The API pods run singleton jobs under PostgreSQL advisory locks (`services/api/src/server.ts`):
`mailbox_sweeper` (expired mailbox entries, keys, abandoned uploads; 5 min), `channel_scheduler`
(scheduled posts exactly once, ownership transfers, view roll-ups), `call_sweeper`,
`notify_worker` (push delivery), `notify_sweeper` (hourly), `moderation_sweeper` (SLA breaches,
evidence retention). Only one pod runs each at a time; the others record `skipped`.

**User impact by job.** Mailbox sweeper stalled: storage grows, retention promises (30 days) are
broken — a privacy commitment, so treat as urgent. Channel scheduler: scheduled posts late.
Notify worker: pushes late (queue age). Moderation sweeper: SLA breaches not flagged, evidence
kept past retention.

## Confirm

1. `sum by (job, result) (increase(tessera_job_runs_total[30m]))` — failing, or not running at
   all (no `ok` and no `skipped` means no pod ran it: API pods down or the lock is held).
2. Logs: `event="periodic.task_failed"`, field `component` is the job.
3. A lock held by a stuck session:
   `SELECT pid, application_name, state, query_start FROM pg_stat_activity WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory');`
4. Push queue: `tessera_notify_queue_oldest_due_seconds`; push service errors in
   `event="notifications.delivery_failed"`.

## Mitigate

- A stuck lock holder: `SELECT pg_terminate_backend(<pid>)`; the next interval on any pod takes
  the lock.
- Failing on data: the job logs the error id; fix forward (the jobs are idempotent and resume
  where they stopped).
- Push queue: a push service outage drains by itself (entries stay queued); a VAPID key
  problem shows as 401/403 from every push service — see [secrets.md](secrets.md).

## Resolved when

Each job reports `ok` within its interval again and the queue age is under 30 s.
