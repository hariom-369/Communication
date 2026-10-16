import { Counter, Gauge, type Registry } from '@tessera/platform';

/**
 * API metrics beyond requests and jobs that alerts depend on (infra/monitoring/alerts.yaml): the
 * controls that fail open or degrade must be visible when they do.
 */
export interface ApiMetrics {
  /** The breached-password mirror did not answer; passwords were checked by strength alone. */
  readonly breachCheckUnavailable: Counter;
  /** The rate-limit store failed; limits fell back to per-process (or refused, fail-closed). */
  readonly rateLimitStoreErrors: Counter;
  /** Age of the oldest due push in the notification queue, seconds (0 when none is due). */
  readonly notifyQueueAge: Gauge;
  /** Link-preview lookups by outcome (`fetched`, `refused`, `cached`, `unavailable`). */
  readonly linkPreviews: Counter<'result'>;
}

export function apiMetrics(registry: Registry): ApiMetrics {
  return {
    breachCheckUnavailable: new Counter({
      name: 'tessera_breach_check_unavailable_total',
      help: 'Breached-password checks that failed open because the mirror did not answer.',
      registers: [registry],
    }),
    rateLimitStoreErrors: new Counter({
      name: 'tessera_rate_limit_store_errors_total',
      help: 'Rate-limit decisions made without the shared store.',
      registers: [registry],
    }),
    notifyQueueAge: new Gauge({
      name: 'tessera_notify_queue_oldest_due_seconds',
      help: 'Age of the oldest due entry in the push queue, measured by the notify worker.',
      registers: [registry],
    }),
    linkPreviews: new Counter({
      name: 'tessera_link_previews_total',
      help: 'Link-preview lookups by outcome.',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
  };
}
