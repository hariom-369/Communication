import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './test-support.js';

interface Rule {
  alert?: string;
  record?: string;
  expr: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; runbook_url?: string };
}
const rules = (
  parse(readFileSync(path.join(REPO_ROOT, 'infra/monitoring/alerts.yaml'), 'utf8')) as {
    groups: { name: string; rules: Rule[] }[];
  }
).groups.flatMap((group) => group.rules);

/** Metric names the services register (`name: 'tessera_…'`) plus prom-client's defaults. */
function exportedMetrics(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry);
      if (statSync(file).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') walk(file);
      } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        for (const match of readFileSync(file, 'utf8').matchAll(/name: '(tessera_[a-z0-9_]+)'/g))
          if (match[1] !== undefined) names.add(match[1]);
      }
    }
  };
  for (const dir of ['services/api/src', 'services/realtime/src', 'packages/platform/src'])
    walk(path.join(REPO_ROOT, dir));
  // collectDefaultMetrics({ prefix: 'tessera_' }) in packages/platform/src/metrics.ts.
  for (const name of [
    'process_cpu_seconds_total',
    'process_open_fds',
    'process_max_fds',
    'process_resident_memory_bytes',
    'nodejs_eventloop_lag_p99_seconds',
    'nodejs_heap_size_used_bytes',
  ])
    names.add(`tessera_${name}`);
  return names;
}

describe('alert rules', () => {
  const alerts = rules.filter((rule) => rule.alert !== undefined);

  it('exist for every SLO in docs/observability.md §3', () => {
    const names = alerts.map((a) => a.alert);
    for (const required of [
      'MessageSubmitErrorBudgetBurnFast',
      'MessageSubmitLatencyHigh',
      'RealtimeConnectionSuccessLow',
      'ApiErrorBudgetBurnFast',
      'NotifyQueueAgeHigh',
    ])
      expect(names).toContain(required);
  });

  it('each name a severity, a summary and a runbook that exists', () => {
    for (const alert of alerts) {
      expect(['page', 'ticket'], alert.alert).toContain(alert.labels?.severity);
      expect(alert.annotations?.summary, alert.alert).toBeTruthy();
      const runbook = alert.annotations?.runbook_url ?? '';
      expect(runbook, alert.alert).toMatch(/^ops\/runbooks\/[a-z0-9-]+\.md$/);
      expect(existsSync(path.join(REPO_ROOT, runbook)), `${alert.alert}: ${runbook}`).toBe(true);
    }
  });

  it('use only metrics the services export (or recording rules defined here)', () => {
    const exported = exportedMetrics();
    const recorded = new Set(
      rules.flatMap((rule) => (rule.record === undefined ? [] : [rule.record])),
    );
    const external = new Set(['up']);
    for (const rule of rules) {
      for (const match of rule.expr.matchAll(/\b(tessera_[a-z0-9_]+|tessera:[a-z0-9_:]+)/g)) {
        const name = (match[1] ?? '').replace(/_(bucket|count|sum)$/, '');
        const known = exported.has(name) || recorded.has(name) || exported.has(match[1] ?? '');
        expect(known, `${rule.alert ?? rule.record ?? ''}: ${match[1] ?? ''}`).toBe(true);
      }
      for (const match of rule.expr.matchAll(/\b([a-z_]+)\{/g))
        if (!(match[1] ?? '').startsWith('tessera'))
          expect(external.has(match[1] ?? ''), match[1]).toBe(true);
    }
  });

  it('refer to route ids that exist', () => {
    const routes = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const file = path.join(dir, entry);
        if (statSync(file).isDirectory()) walk(file);
        else if (file.endsWith('routes.ts'))
          for (const match of readFileSync(file, 'utf8').matchAll(/id: '([a-z_]+\.[a-z_]+)'/g))
            if (match[1] !== undefined) routes.add(match[1]);
      }
    };
    walk(path.join(REPO_ROOT, 'services/api/src/modules'));
    for (const rule of rules)
      for (const match of rule.expr.matchAll(/route="([a-z_.]+)"/g))
        expect(routes.has(match[1] ?? ''), match[1]).toBe(true);
  });
});
