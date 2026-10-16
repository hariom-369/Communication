import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests, type Manifest } from './manifests.js';
import { parseValues, type Values } from './values.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
export const ENVIRONMENTS = ['staging', 'production'] as const;

export function testValues(environment: (typeof ENVIRONMENTS)[number]): Values {
  return parseValues(
    JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'test-values', `${environment}.json`), 'utf8')),
  );
}

export function rendered(environment: (typeof ENVIRONMENTS)[number]): Manifest[] {
  return manifests(testValues(environment));
}

// The shapes the tests read (a subset of the Kubernetes types).
export interface Container {
  name: string;
  image: string;
  args?: string[];
  env?: { name: string; value: string }[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    runAsNonRoot?: boolean;
    privileged?: boolean;
    capabilities?: { drop?: string[]; add?: string[] };
    seccompProfile?: { type: string };
  };
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  startupProbe?: unknown;
}
export interface PodSpec {
  containers: Container[];
  hostNetwork?: boolean;
  automountServiceAccountToken?: boolean;
  serviceAccountName?: string;
  terminationGracePeriodSeconds?: number;
  securityContext?: { runAsNonRoot?: boolean; seccompProfile?: { type: string } };
}
export interface Workload {
  kind: string;
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    replicas?: number;
    selector?: { matchLabels: Record<string, string> };
    strategy?: { rollingUpdate?: { maxUnavailable: number | string; maxSurge: number | string } };
    template: { metadata: { labels: Record<string, string> }; spec: PodSpec };
  };
}
export interface Rule {
  from?: Peer[];
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
export interface Peer {
  ipBlock?: { cidr: string; except?: string[] };
  podSelector?: { matchLabels?: Record<string, string> };
  namespaceSelector?: { matchLabels?: Record<string, string> };
}
export interface NetworkPolicy {
  metadata: { name: string; namespace: string };
  spec: {
    podSelector: { matchLabels?: Record<string, string> };
    policyTypes: string[];
    ingress?: Rule[];
    egress?: Rule[];
  };
}

export const workloads = (all: Manifest[]): Workload[] =>
  all.filter((m) => m.kind === 'Deployment' || m.kind === 'Job') as unknown as Workload[];

export const ofKind = <T>(all: Manifest[], kind: string): T[] =>
  all.filter((m) => m.kind === kind) as unknown as T[];

/** `namespace` null: a cluster-scoped resource. T is the shape the caller reads. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed lookup helper
export function named<T>(
  all: Manifest[],
  kind: string,
  name: string,
  namespace: string | null = 'tessera',
): T {
  const found = all.find(
    (m) =>
      m.kind === kind && m.metadata.name === name && (m.metadata.namespace ?? null) === namespace,
  );
  if (found === undefined) throw new Error(`no ${kind} ${namespace}/${name}`);
  return found as unknown as T;
}

/** The settings a container gets from its ConfigMaps and literal env (not from secrets). */
export function containerConfig(all: Manifest[], workload: Workload): Record<string, string> {
  const container = workload.spec.template.spec.containers[0];
  const result: Record<string, string> = {};
  for (const from of container?.envFrom ?? []) {
    if (from.configMapRef === undefined) continue;
    const map = named<{ data: Record<string, string> }>(
      all,
      'ConfigMap',
      from.configMapRef.name,
      workload.metadata.namespace,
    );
    Object.assign(result, map.data);
  }
  for (const entry of container?.env ?? []) result[entry.name] = entry.value;
  return result;
}

export function containerSecrets(workload: Workload): string[] {
  return (workload.spec.template.spec.containers[0]?.envFrom ?? []).flatMap((from) =>
    from.secretRef === undefined ? [] : [from.secretRef.name],
  );
}
