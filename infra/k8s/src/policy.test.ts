import { describe, expect, it } from 'vitest';

import { MEDIA_NAMESPACE, NAMESPACE, type Manifest } from './manifests.js';
import { render } from './render.js';
import {
  ENVIRONMENTS,
  containerConfig,
  containerSecrets,
  named,
  ofKind,
  rendered,
  testValues,
  workloads,
  type NetworkPolicy,
  type Workload,
} from './test-support.js';

/** The hardening baseline of docs/deployment.md §6, enforced on the rendered manifests. */
describe.each(ENVIRONMENTS)('%s manifests', (environment) => {
  const all = rendered(environment);
  const appWorkloads = workloads(all).filter((w) => w.metadata.namespace === NAMESPACE);

  it('have unique names per kind and namespace, and render to YAML', () => {
    const keys = all.map((m) => `${m.kind}/${m.metadata.namespace ?? ''}/${m.metadata.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    const { prepare, workloads } = render(testValues(environment));
    // Migrations (the Job) are applied and awaited before any workload changes.
    expect(prepare).toContain('kind: Job');
    expect(prepare).not.toContain('kind: Deployment');
    expect(workloads).toContain('kind: Deployment');
    expect(workloads).not.toContain('kind: Job');
  });

  it('enforce the "restricted" Pod Security Standard on the application namespace', () => {
    const ns = named<Manifest & { metadata: { labels: Record<string, string> } }>(
      all,
      'Namespace',
      NAMESPACE,
      null,
    );
    expect(ns.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
  });

  it('run every container non-root, read-only, without privileges or capabilities', () => {
    for (const workload of workloads(all)) {
      const pod = workload.spec.template.spec;
      const id = `${workload.metadata.namespace}/${workload.metadata.name}`;
      expect(pod.automountServiceAccountToken, id).toBe(false);
      expect(pod.securityContext?.runAsNonRoot, id).toBe(true);
      expect(pod.securityContext?.seccompProfile?.type, id).toBe('RuntimeDefault');
      if (pod.hostNetwork === true) expect(workload.metadata.namespace, id).toBe(MEDIA_NAMESPACE);
      for (const container of pod.containers) {
        const sc = container.securityContext;
        expect(sc?.allowPrivilegeEscalation, id).toBe(false);
        expect(sc?.readOnlyRootFilesystem, id).toBe(true);
        expect(sc?.runAsNonRoot, id).toBe(true);
        expect(sc?.privileged ?? false, id).toBe(false);
        expect(sc?.capabilities?.drop, id).toEqual(['ALL']);
        expect(sc?.capabilities?.add ?? [], id).toEqual([]);
        expect(sc?.seccompProfile?.type, id).toBe('RuntimeDefault');
        expect(container.resources?.requests?.['cpu'], id).toBeDefined();
        expect(container.resources?.requests?.['memory'], id).toBeDefined();
        expect(container.resources?.limits?.['memory'], id).toBeDefined();
        expect(container.image, id).not.toMatch(/:latest$|^[^:@]+$/);
      }
    }
  });

  it('run our images by the release digest or version from the values', () => {
    const values = testValues(environment);
    for (const workload of appWorkloads)
      for (const container of workload.spec.template.spec.containers)
        expect(container.image.startsWith(`${values.registry}/tessera-`), container.name).toBe(
          true,
        );
  });

  it('probe every long-running service, and protect each with a disruption budget', () => {
    const budgets = ofKind<{
      metadata: { namespace: string };
      spec: { selector: { matchLabels: Record<string, string> } };
    }>(all, 'PodDisruptionBudget');
    for (const workload of workloads(all).filter((w) => w.kind === 'Deployment')) {
      const container = workload.spec.template.spec.containers[0];
      expect(container?.readinessProbe, workload.metadata.name).toBeDefined();
      expect(container?.livenessProbe, workload.metadata.name).toBeDefined();
      const covered = budgets.some(
        (b) =>
          b.metadata.namespace === workload.metadata.namespace &&
          Object.entries(b.spec.selector.matchLabels).every(
            ([k, v]) => workload.spec.template.metadata.labels[k] === v,
          ),
      );
      expect(covered, `PodDisruptionBudget for ${workload.metadata.name}`).toBe(true);
    }
  });

  it('deny all traffic by default and give every application pod its own policy', () => {
    const policies = ofKind<NetworkPolicy>(all, 'NetworkPolicy').filter(
      (p) => p.metadata.namespace === NAMESPACE,
    );
    const deny = policies.find((p) => p.metadata.name === 'default-deny');
    expect(deny?.spec.podSelector).toEqual({});
    expect(deny?.spec.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
    expect(deny?.spec.ingress ?? []).toEqual([]);
    expect(deny?.spec.egress ?? []).toEqual([]);
    for (const workload of appWorkloads) {
      const own = policies.filter(
        (p) =>
          p.spec.podSelector.matchLabels !== undefined &&
          Object.entries(p.spec.podSelector.matchLabels).every(
            ([k, v]) => workload.spec.template.metadata.labels[k] === v,
          ),
      );
      expect(own.length, `NetworkPolicy for ${workload.metadata.name}`).toBe(1);
    }
  });

  it('isolate the link-preview fetcher (F-05): only the API may ask it, it reaches only public 443', () => {
    const policy = named<NetworkPolicy>(all, 'NetworkPolicy', 'link-fetcher');
    const fromPods = (policy.spec.ingress ?? []).flatMap((r) => r.from ?? []);
    expect(
      fromPods.filter((p) => p.podSelector !== undefined).map((p) => p.podSelector?.matchLabels),
    ).toEqual([{ 'app.kubernetes.io/name': 'api', 'app.kubernetes.io/part-of': 'tessera' }]);
    for (const rule of policy.spec.egress ?? []) {
      const dnsOnly = rule.ports?.every((p) => p.port === 53) === true;
      if (dnsOnly) continue;
      expect(rule.ports).toEqual([{ protocol: 'TCP', port: 443 }]);
      for (const peer of rule.to ?? []) {
        expect(peer.podSelector).toBeUndefined();
        expect(peer.namespaceSelector).toBeUndefined();
        const except = peer.ipBlock?.except ?? [];
        if (peer.ipBlock?.cidr === '0.0.0.0/0')
          for (const range of [
            '10.0.0.0/8',
            '172.16.0.0/12',
            '192.168.0.0/16',
            '169.254.0.0/16',
            '100.64.0.0/10',
            '127.0.0.0/8',
          ])
            expect(except).toContain(range);
        else expect(peer.ipBlock?.cidr).toBe('::/0');
        if (peer.ipBlock?.cidr === '::/0')
          for (const range of ['fc00::/7', 'fe80::/10', '::1/128', '::ffff:0:0/96'])
            expect(except).toContain(range);
      }
    }
    const fetcher = named<Workload>(all, 'Deployment', 'link-fetcher');
    // No database, Valkey or key material: only its own token.
    expect(containerSecrets(fetcher)).toEqual(['link-fetcher']);
    expect(
      Object.keys(containerConfig(all, fetcher)).filter((k) => /DATABASE|VALKEY|S3|KMS/.test(k)),
    ).toEqual([]);
  });

  it('give the migration job only the migrator database credentials', () => {
    const job = workloads(all).find((w) => w.kind === 'Job');
    expect(job).toBeDefined();
    if (job !== undefined) expect(containerSecrets(job)).toEqual(['migrate']);
  });

  it('roll out without losing capacity, the realtime tier one pod at a time with a full drain', () => {
    const api = named<Workload>(all, 'Deployment', 'api');
    expect(api.spec.strategy?.rollingUpdate?.maxUnavailable).toBe(0);
    const realtime = named<Workload>(all, 'Deployment', 'realtime');
    expect(realtime.spec.strategy?.rollingUpdate).toEqual({ maxUnavailable: 1, maxSurge: 1 });
    const config = containerConfig(all, realtime);
    const needed =
      (Number(config['SHUTDOWN_DRAIN_MS']) + Number(config['SHUTDOWN_TIMEOUT_MS'])) / 1000;
    expect(realtime.spec.template.spec.terminationGracePeriodSeconds).toBeGreaterThan(needed);
    // N+1 (docs/capacity.md): the pods left after one fails hold its sockets.
    expect(realtime.spec.replicas).toBeGreaterThanOrEqual(3);
  });

  it('autoscale the API, the realtime tier and the fetcher', () => {
    const scaled = ofKind<{
      spec: { scaleTargetRef: { name: string }; minReplicas: number; maxReplicas: number };
    }>(all, 'HorizontalPodAutoscaler');
    expect(scaled.map((h) => h.spec.scaleTargetRef.name).sort()).toEqual([
      'api',
      'link-fetcher',
      'realtime',
      'web',
    ]);
    for (const h of scaled) expect(h.spec.maxReplicas).toBeGreaterThan(h.spec.minReplicas);
  });

  it('serve each app from one origin, the admin app only on an internal load balancer', () => {
    interface Ingress {
      metadata: { annotations: Record<string, string> };
      spec: {
        rules: { http: { paths: { path: string; backend: { service: { name: string } } }[] } }[];
      };
    }
    const routes = (ingress: Ingress) =>
      Object.fromEntries(
        ingress.spec.rules.flatMap((r) =>
          r.http.paths.map((p) => [p.path, p.backend.service.name]),
        ),
      );
    // The web app's CSP allows only 'self' and its cookies are __Host-: API, realtime and SFU
    // signalling must share the app's origin.
    const publicIngress = named<Ingress>(all, 'Ingress', 'public');
    expect(routes(publicIngress)).toEqual({ '/api/': 'api', '/rt/': 'realtime', '/': 'web' });
    expect(publicIngress.metadata.annotations['alb.ingress.kubernetes.io/ssl-policy']).toMatch(
      /TLS13/,
    );
    expect(publicIngress.metadata.annotations['alb.ingress.kubernetes.io/security-groups']).toBe(
      testValues(environment).publicAlbSecurityGroupId,
    );
    const admin = named<Ingress>(all, 'Ingress', 'admin');
    expect(admin.metadata.annotations['alb.ingress.kubernetes.io/scheme']).toBe('internal');
    expect(routes(admin)).toEqual({ '/admin/v1/': 'admin-api', '/': 'admin-web' });
    // No other way in: no LoadBalancer or NodePort services in the application namespace.
    for (const svc of ofKind<{
      metadata: { namespace: string; name: string };
      spec: { type: string };
    }>(all, 'Service'))
      if (svc.metadata.namespace === NAMESPACE)
        expect(svc.spec.type, svc.metadata.name).toBe('ClusterIP');
  });
});
