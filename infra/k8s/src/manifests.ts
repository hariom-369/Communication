import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import type { Values } from './values.js';

/**
 * Kubernetes manifests for one environment (docs/deployment.md). Everything here is reviewed
 * code; `policy.test.ts` enforces the hardening baseline (docs/deployment.md §6) on the output,
 * `config.test.ts` boots each service's configuration loader on the rendered settings, and CI
 * validates the output against the Kubernetes schemas.
 *
 * Workloads (namespace `tessera`, Pod Security "restricted"):
 * - api            user API (ALB, behind CloudFront); also runs the singleton background jobs
 * - admin-api      admin API (internal ALB, reached through ZTNA only)
 * - link-fetcher   isolated link-preview fetcher (F-05): no secrets but its token, public egress only
 * - realtime       WebSocket gateway (NLB)
 * - migrate-<ver>  pre-deploy migration Job (expand-only migrations)
 * Media (namespace `tessera-media`, host network on a dedicated node group): coturn, LiveKit.
 */

export type Manifest = Record<string, unknown> & { kind: string; metadata: Metadata };
interface Metadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export const NAMESPACE = 'tessera';
export const MEDIA_NAMESPACE = 'tessera-media';
const MONITORING_NAMESPACE = 'monitoring';
const NONROOT = 65532;

/** Environment variables whose values come only from the secrets manager. */
export const API_SECRET_KEYS = [
  'DATABASE_URL',
  'VALKEY_URL',
  'SMTP_URL',
  'PASSWORD_PEPPER',
  'SECRET_BOX_KEYS',
  'TURN_SHARED_SECRET',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'FRANKING_KEYS',
  'MODERATION_HPKE_PUBLIC_KEY',
  'MODERATION_HPKE_PRIVATE_KEY',
  'LINK_PREVIEW_FETCHER_TOKEN',
] as const;
export const ADMIN_SECRET_KEYS = ['ADMIN_OIDC_CLIENT_ID', 'ADMIN_OIDC_CLIENT_SECRET'] as const;
export const REALTIME_SECRET_KEYS = ['DATABASE_URL', 'VALKEY_URL'] as const;
export const MIGRATE_SECRET_KEYS = ['DATABASE_URL'] as const;
export const FETCHER_SECRET_KEYS = ['FETCHER_TOKEN'] as const;
export const LIVEKIT_SECRET_KEYS = ['LIVEKIT_KEYS', 'REDIS_HOST', 'REDIS_PASSWORD'] as const;
export const TURN_SECRET_KEYS = ['TURN_STATIC_AUTH_SECRET'] as const;
/** Optional secrets the API reads when the corresponding feature is configured. */
export const OPTIONAL_API_SECRET_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
] as const;

interface Sizing {
  readonly api: { min: number; max: number };
  readonly admin: number;
  readonly fetcher: { min: number; max: number };
  readonly web: { min: number; max: number };
  readonly realtime: { min: number; max: number; connectionsPerPod: number };
  readonly turn: number;
  readonly sfu: number;
}

/**
 * Sizes from docs/capacity.md: realtime N+1 with small pods (10–15k sockets, F-14) so a crash
 * sends few clients back at once; API headroom for one realtime pod's reconnects.
 */
const SIZING: Record<Values['environment'], Sizing> = {
  staging: {
    api: { min: 2, max: 6 },
    admin: 2,
    fetcher: { min: 2, max: 4 },
    web: { min: 2, max: 4 },
    realtime: { min: 3, max: 6, connectionsPerPod: 10_000 },
    turn: 2,
    sfu: 2,
  },
  production: {
    api: { min: 3, max: 30 },
    admin: 2,
    fetcher: { min: 2, max: 8 },
    web: { min: 3, max: 12 },
    realtime: { min: 4, max: 24, connectionsPerPod: 12_000 },
    turn: 3,
    sfu: 3,
  },
};

export function sizing(values: Values): Sizing {
  return SIZING[values.environment];
}

/**
 * One origin per app, as the web app's CSP (`connect-src 'self'`) and `__Host-` cookies require:
 * app.<domain> is CloudFront in front of the public ALB, which routes `/api` to the API, `/rt`
 * to the realtime gateway and everything else (static files, `/sfu` signalling) to the web tier;
 * admin.<domain> is the identity-aware proxy in front of the internal ALB (`/admin/v1` → admin
 * API, the rest → admin web tier). TURN has its own name: browsers connect to it directly.
 */
const hosts = (values: Values) => ({
  app: `app.${values.domain}`,
  admin: `admin.${values.domain}`,
  turn: `turn.${values.domain}`,
});

const IMAGES = {
  api: 'tessera-api',
  realtime: 'tessera-realtime',
  web: 'tessera-web',
  adminWeb: 'tessera-admin-web',
} as const;

function image(values: Values, name: keyof typeof IMAGES): string {
  const ref = values.images[name];
  return ref.startsWith('sha256:')
    ? `${values.registry}/${IMAGES[name]}@${ref}`
    : `${values.registry}/${IMAGES[name]}:${ref}`;
}

const labels = (component: string) => ({
  'app.kubernetes.io/name': component,
  'app.kubernetes.io/part-of': 'tessera',
});

/** Non-secret settings of the user API (and, with adminConfig, the admin API). */
export function apiConfig(values: Values): Record<string, string> {
  const h = hosts(values);
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '8080',
    HEALTH_PORT: '9090',
    LOG_LEVEL: 'info',
    LOG_ERROR_DETAILS: 'false',
    DATABASE_POOL_MAX: '10',
    DATABASE_STATEMENT_TIMEOUT_MS: '5000',
    VALKEY_KEY_PREFIX: 'tessera',
    ALLOWED_ORIGINS: `https://${h.app}`,
    // CloudFront, then the ALB, append to X-Forwarded-For.
    TRUST_PROXY_HOPS: '2',
    LISTEN_BACKLOG: '4096',
    PWNED_PASSWORDS_URL: `https://${values.pwnedPasswordsBucket}.s3.${values.awsRegion}.amazonaws.com`,
    LINK_PREVIEW_FETCHER_URL: `http://link-fetcher.${NAMESPACE}.svc.cluster.local:8080`,
    REALTIME_TICKETS_PER_SECOND: '0',
    PUBLIC_WEB_URL: `https://${h.app}`,
    EMAIL_FROM: `Tessera <no-reply@${values.domain}>`,
    WEBAUTHN_RP_ID: values.domain,
    WEBAUTHN_RP_NAME: 'Tessera',
    REALTIME_WS_PATH: '/rt/v1/ws',
    MEDIA_S3_BUCKET: values.mediaBucket,
    MEDIA_S3_REGION: values.awsRegion,
    TURN_URLS: `turn:${h.turn}:3478?transport=udp,turns:${h.turn}:5349?transport=tcp`,
    STUN_URLS: `stun:${h.turn}:3478`,
    LIVEKIT_URL: '/sfu',
    LIVEKIT_API_URL: `http://livekit.${MEDIA_NAMESPACE}.svc.cluster.local:7880`,
    VAPID_SUBJECT: `mailto:push@${values.domain}`,
    SHUTDOWN_DRAIN_MS: '10000',
    SHUTDOWN_TIMEOUT_MS: '30000',
    ...values.apiEnv,
  };
}

export function adminConfig(values: Values): Record<string, string> {
  const h = hosts(values);
  return {
    ADMIN_PORT: '8082',
    ADMIN_HEALTH_PORT: '9092',
    ADMIN_ORIGINS: `https://${h.admin}`,
    ADMIN_PUBLIC_URL: `https://${h.admin}`,
    ADMIN_OIDC_ISSUER: values.adminOidcIssuer,
    ADMIN_EMAIL_DOMAINS: values.adminEmailDomains,
    ADMIN_WEBAUTHN_RP_ID: h.admin,
  };
}

export function realtimeConfig(values: Values): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '8081',
    HEALTH_PORT: '9091',
    LOG_LEVEL: 'info',
    LOG_ERROR_DETAILS: 'false',
    DATABASE_POOL_MAX: '10',
    VALKEY_KEY_PREFIX: 'tessera',
    ALLOWED_ORIGINS: `https://${hosts(values).app}`,
    WS_PATH: '/rt/v1/ws',
    MAX_CONNECTIONS: String(sizing(values).realtime.connectionsPerPod),
    LISTEN_BACKLOG: '4096',
    // Drain window 30 s plus shutdown: terminationGracePeriodSeconds below must exceed it.
    SHUTDOWN_DRAIN_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '45000',
  };
}

export function fetcherConfig(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '8080',
    HEALTH_PORT: '9090',
    LOG_LEVEL: 'info',
    FETCHER_MAX_CONCURRENT: '32',
  };
}

// ---------------------------------------------------------------------------------------------
// Building blocks

const restrictedContainer = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: NONROOT,
  runAsGroup: NONROOT,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
};

const podSecurity = {
  runAsNonRoot: true,
  runAsUser: NONROOT,
  runAsGroup: NONROOT,
  fsGroup: NONROOT,
  seccompProfile: { type: 'RuntimeDefault' },
};

function probes(port: number) {
  const get = (p: string) => ({ httpGet: { path: p, port } });
  return {
    startupProbe: { ...get('/startupz'), periodSeconds: 2, failureThreshold: 60 },
    readinessProbe: { ...get('/readyz'), periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 2 },
    livenessProbe: { ...get('/livez'), periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
  };
}

interface WorkloadSpec {
  name: string;
  namespace?: string;
  replicas: number;
  image: string;
  /** Omitted: the image's own command (nginx). */
  args?: string[];
  ports: { name: string; port: number }[];
  healthPort: number;
  config: string[];
  secrets: string[];
  resources: { cpu: string; memory: string; memoryLimit: string };
  env?: { name: string; value: string }[];
  terminationGraceSeconds: number;
  maxUnavailable: number | string;
  maxSurge: number | string;
}

function deployment(spec: WorkloadSpec): Manifest {
  const selector = labels(spec.name);
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: spec.name, namespace: spec.namespace ?? NAMESPACE, labels: selector },
    spec: {
      replicas: spec.replicas,
      revisionHistoryLimit: 5,
      selector: { matchLabels: selector },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxUnavailable: spec.maxUnavailable, maxSurge: spec.maxSurge },
      },
      template: {
        metadata: { labels: selector },
        spec: {
          serviceAccountName: spec.name,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: podSecurity,
          terminationGracePeriodSeconds: spec.terminationGraceSeconds,
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: 'topology.kubernetes.io/zone',
              whenUnsatisfiable: 'DoNotSchedule',
              labelSelector: { matchLabels: selector },
            },
            {
              maxSkew: 1,
              topologyKey: 'kubernetes.io/hostname',
              whenUnsatisfiable: 'ScheduleAnyway',
              labelSelector: { matchLabels: selector },
            },
          ],
          containers: [
            {
              name: spec.name,
              image: spec.image,
              imagePullPolicy: 'IfNotPresent',
              ...(spec.args === undefined ? {} : { args: spec.args }),
              ports: [
                ...spec.ports.map((p) => ({
                  name: p.name,
                  containerPort: p.port,
                  protocol: 'TCP',
                })),
                { name: 'health', containerPort: spec.healthPort, protocol: 'TCP' },
              ],
              envFrom: [
                ...spec.config.map((name) => ({ configMapRef: { name } })),
                ...spec.secrets.map((name) => ({ secretRef: { name } })),
              ],
              ...(spec.env === undefined ? {} : { env: spec.env }),
              resources: {
                requests: { cpu: spec.resources.cpu, memory: spec.resources.memory },
                limits: { memory: spec.resources.memoryLimit },
              },
              securityContext: restrictedContainer,
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              ...probes(spec.healthPort),
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
        },
      },
    },
  };
}

function service(
  name: string,
  ports: { name: string; port: number }[],
  namespace = NAMESPACE,
  healthPort?: number,
) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: labels(name),
      // The ALB target group of this service checks the internal health port.
      ...(healthPort === undefined
        ? {}
        : {
            annotations: {
              'alb.ingress.kubernetes.io/healthcheck-port': String(healthPort),
              'alb.ingress.kubernetes.io/healthcheck-path': '/readyz',
            },
          }),
    },
    spec: {
      type: 'ClusterIP',
      selector: labels(name),
      ports: ports.map((p) => ({
        name: p.name,
        port: p.port,
        targetPort: p.name,
        protocol: 'TCP',
      })),
    },
  } satisfies Manifest;
}

function serviceAccount(name: string, namespace = NAMESPACE): Manifest {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name, namespace, labels: labels(name) },
    // AWS access (S3, KMS) through EKS Pod Identity associations made in Terraform: no token
    // or role annotation lives here.
    automountServiceAccountToken: false,
  };
}

function pdb(name: string, namespace = NAMESPACE): Manifest {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name, namespace, labels: labels(name) },
    spec: { maxUnavailable: 1, selector: { matchLabels: labels(name) } },
  };
}

function hpa(name: string, min: number, max: number, cpuPercent: number): Manifest {
  return {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name, namespace: NAMESPACE, labels: labels(name) },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name },
      minReplicas: min,
      maxReplicas: max,
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: { type: 'Utilization', averageUtilization: cpuPercent },
          },
        },
      ],
      behavior: {
        // Scale up fast (a reconnect storm), down slowly (a scale-down moves sockets).
        scaleUp: {
          stabilizationWindowSeconds: 0,
          policies: [{ type: 'Percent', value: 100, periodSeconds: 30 }],
        },
        scaleDown: {
          stabilizationWindowSeconds: 600,
          policies: [{ type: 'Pods', value: 1, periodSeconds: 120 }],
        },
      },
    },
  };
}

function configMap(name: string, data: Record<string, string>, namespace = NAMESPACE): Manifest {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace, labels: labels(name) },
    data,
  };
}

/**
 * A Secret synchronised from AWS Secrets Manager by External Secrets Operator: the JSON secret
 * `tessera/<environment>/<name>` holds the keys listed for it above (ops/runbooks/secrets.md).
 */
function externalSecret(values: Values, name: string, namespace = NAMESPACE): Manifest {
  return {
    apiVersion: 'external-secrets.io/v1',
    kind: 'ExternalSecret',
    metadata: { name, namespace, labels: labels(name) },
    spec: {
      refreshInterval: '1h',
      secretStoreRef: { kind: 'ClusterSecretStore', name: 'aws-secrets-manager' },
      target: { name, creationPolicy: 'Owner', deletionPolicy: 'Retain' },
      dataFrom: [{ extract: { key: `tessera/${values.environment}/${name}` } }],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Network policies (default deny; docs/deployment.md §6)

const PRIVATE_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '127.0.0.0/8',
  '0.0.0.0/8',
  '192.0.0.0/24',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const PRIVATE_V6 = [
  'fc00::/7',
  'fe80::/10',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '2001:db8::/32',
  'ff00::/8',
];

const dns = {
  to: [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
      podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
    },
  ],
  ports: [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
  ],
};
const publicHttps = {
  to: [
    { ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_V4 } },
    { ipBlock: { cidr: '::/0', except: PRIVATE_V6 } },
  ],
  ports: [{ protocol: 'TCP', port: 443 }],
};
const fromPrometheus = (port: number) => ({
  from: [
    { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': MONITORING_NAMESPACE } } },
  ],
  ports: [{ protocol: 'TCP', port }],
});
const toPods = (name: string, port: number, namespace = NAMESPACE) => ({
  to: [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
      podSelector: { matchLabels: labels(name) },
    },
  ],
  ports: [{ protocol: 'TCP', port }],
});

function networkPolicy(
  name: string,
  spec: Record<string, unknown>,
  namespace = NAMESPACE,
): Manifest {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace },
    spec,
  };
}

function networkPolicies(values: Values): Manifest[] {
  const data = {
    to: values.dataSubnetCidrs.map((cidr) => ({ ipBlock: { cidr } })),
    ports: [
      { protocol: 'TCP', port: 5432 },
      { protocol: 'TCP', port: 6379 },
    ],
  };
  // Interface VPC endpoints (S3, KMS, Secrets Manager, SES SMTP) and load balancer targets.
  const vpcHttps = {
    to: [{ ipBlock: { cidr: values.vpcCidr } }],
    ports: [
      { protocol: 'TCP', port: 443 },
      { protocol: 'TCP', port: 465 },
    ],
  };
  // LiveKit runs on host networking: its pods are reached at media node addresses.
  const livekit = {
    to: values.mediaSubnetCidrs.map((cidr) => ({ ipBlock: { cidr } })),
    ports: [{ protocol: 'TCP', port: 7880 }],
  };
  const fromVpc = (port: number) => ({
    from: [{ ipBlock: { cidr: values.vpcCidr } }],
    ports: [{ protocol: 'TCP', port }],
  });
  const select = (name: string) => ({ matchLabels: labels(name) });
  return [
    networkPolicy('default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
    networkPolicy('api', {
      podSelector: select('api'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [fromVpc(8080), fromPrometheus(9090)],
      // Public 443: Web Push services and payment providers (allow-listed in code; an egress
      // firewall with a domain allow-list is the deployment's second layer, docs/deployment.md).
      egress: [dns, data, vpcHttps, publicHttps, toPods('link-fetcher', 8080), livekit],
    }),
    networkPolicy('admin-api', {
      podSelector: select('admin-api'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [fromVpc(8082), fromPrometheus(9092)],
      // Public 443: the admin identity provider (OIDC discovery, token endpoint).
      egress: [dns, data, vpcHttps, publicHttps],
    }),
    networkPolicy('realtime', {
      podSelector: select('realtime'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [fromVpc(8081), fromPrometheus(9091)],
      egress: [dns, data],
    }),
    networkPolicy('link-fetcher', {
      podSelector: select('link-fetcher'),
      policyTypes: ['Ingress', 'Egress'],
      // Only the API may ask; only public addresses on 443 may be fetched (F-05: a second layer
      // under the fetcher's own address checks; no route to the VPC, the cluster or metadata).
      ingress: [
        { from: [{ podSelector: select('api') }], ports: [{ protocol: 'TCP', port: 8080 }] },
        fromPrometheus(9090),
      ],
      egress: [dns, publicHttps],
    }),
    networkPolicy('web', {
      podSelector: select('web'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [fromVpc(8080), fromVpc(8081)],
      // Static files, and LiveKit signalling proxied under /sfu.
      egress: [dns, livekit],
    }),
    networkPolicy('admin-web', {
      podSelector: select('admin-web'),
      policyTypes: ['Ingress', 'Egress'],
      ingress: [fromVpc(8080), fromVpc(8081)],
      egress: [],
    }),
    networkPolicy('migrate', {
      podSelector: select('migrate'),
      policyTypes: ['Ingress', 'Egress'],
      egress: [dns, { ...data, ports: [{ protocol: 'TCP', port: 5432 }] }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Ingress

function ingresses(values: Values): Manifest[] {
  const alb = (scheme: 'internet-facing' | 'internal', group: string, securityGroup: string) => ({
    'alb.ingress.kubernetes.io/scheme': scheme,
    'alb.ingress.kubernetes.io/target-type': 'ip',
    'alb.ingress.kubernetes.io/group.name': group,
    'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
    'alb.ingress.kubernetes.io/ssl-policy': 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    'alb.ingress.kubernetes.io/certificate-arn': values.certificateArn,
    // Only CloudFront (public) or the access proxy (admin) may connect (infra/terraform).
    'alb.ingress.kubernetes.io/security-groups': securityGroup,
    'alb.ingress.kubernetes.io/manage-backend-security-group-rules': 'true',
    // Above the realtime heartbeat (25 s), so idle sockets are not cut.
    'alb.ingress.kubernetes.io/load-balancer-attributes':
      'routing.http.drop_invalid_header_fields.enabled=true,idle_timeout.timeout_seconds=120',
  });
  const path = (prefix: string, name: string, port: number) => ({
    path: prefix,
    pathType: 'Prefix',
    backend: { service: { name, port: { number: port } } },
  });
  return [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'public',
        namespace: NAMESPACE,
        annotations: alb('internet-facing', 'tessera-public', values.publicAlbSecurityGroupId),
      },
      spec: {
        ingressClassName: 'alb',
        rules: [
          {
            http: {
              paths: [
                path('/api/', 'api', 8080),
                path('/rt/', 'realtime', 8081),
                path('/', 'web', 8080),
              ],
            },
          },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      // Internal only: reached through the identity-aware access proxy (docs/admin.md §1).
      metadata: {
        name: 'admin',
        namespace: NAMESPACE,
        annotations: alb('internal', 'tessera-admin', values.adminAlbSecurityGroupId),
      },
      spec: {
        ingressClassName: 'alb',
        rules: [
          {
            http: { paths: [path('/admin/v1/', 'admin-api', 8082), path('/', 'admin-web', 8080)] },
          },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Monitoring (Prometheus Operator)

function podMonitor(name: string, namespace = NAMESPACE): Manifest {
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PodMonitor',
    metadata: { name, namespace, labels: labels(name) },
    spec: {
      selector: { matchLabels: labels(name) },
      podMetricsEndpoints: [{ port: 'health', path: '/metrics', interval: '15s' }],
    },
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function alertRules(): Manifest {
  // The same file Prometheus can load directly (and promtool can check).
  const rules = parse(readFileSync(path.join(ROOT, 'infra/monitoring/alerts.yaml'), 'utf8')) as {
    groups: unknown[];
  };
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'PrometheusRule',
    metadata: { name: 'tessera-slos', namespace: NAMESPACE, labels: labels('tessera-slos') },
    spec: { groups: rules.groups },
  };
}

// ---------------------------------------------------------------------------------------------
// Media tier: coturn and LiveKit on host networking (UDP port ranges cannot go through an NLB
// target group per port at this scale), on a dedicated, tainted node group.

function mediaWorkload(
  name: 'coturn' | 'livekit',
  replicas: number,
  container: Record<string, unknown>,
  configName: string,
  tlsSecret?: string,
): Manifest {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: MEDIA_NAMESPACE, labels: labels(name) },
    spec: {
      replicas,
      selector: { matchLabels: labels(name) },
      // Host ports: one pod per node, so a rollout replaces pods in place.
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } },
      template: {
        metadata: { labels: labels(name) },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          serviceAccountName: name,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: podSecurity,
          nodeSelector: { 'tessera.dev/pool': 'media' },
          tolerations: [{ key: 'tessera.dev/media', operator: 'Exists', effect: 'NoSchedule' }],
          affinity: {
            podAntiAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: { matchLabels: labels(name) },
                  topologyKey: 'kubernetes.io/hostname',
                },
              ],
            },
          },
          terminationGracePeriodSeconds: 60,
          containers: [
            {
              name,
              imagePullPolicy: 'IfNotPresent',
              securityContext: restrictedContainer,
              volumeMounts: [
                { name: 'config', mountPath: '/etc/tessera', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
                ...(tlsSecret === undefined
                  ? []
                  : [{ name: 'tls', mountPath: '/etc/tessera-tls', readOnly: true }]),
              ],
              ...container,
            },
          ],
          volumes: [
            { name: 'config', configMap: { name: configName } },
            { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
            ...(tlsSecret === undefined
              ? []
              : [{ name: 'tls', secret: { secretName: tlsSecret, defaultMode: 0o440 } }]),
          ],
        },
      },
    },
  };
}

function media(values: Values): Manifest[] {
  const size = sizing(values);
  const turnConf = readFileSync(path.join(ROOT, 'infra/calls/turnserver.conf'), 'utf8');
  const livekit = [
    '# LiveKit SFU, production (ADR-017). Keys and Redis come from the environment',
    '# (LIVEKIT_KEYS, LIVEKIT_REDIS_ADDRESS) so they stay out of this ConfigMap.',
    'port: 7880',
    'rtc:',
    '  tcp_port: 7881',
    '  port_range_start: 50000',
    '  port_range_end: 60000',
    '  use_external_ip: true',
    'redis:',
    '  use_tls: true',
    'room:',
    '  empty_timeout: 30',
    '  departure_timeout: 10',
    'logging:',
    '  level: info',
    '',
  ].join('\n');
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: MEDIA_NAMESPACE,
        labels: {
          // Host networking needs "privileged"; containers still run non-root without
          // capabilities (policy.test.ts).
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/audit': 'restricted',
        },
      },
    },
    serviceAccount('coturn', MEDIA_NAMESPACE),
    serviceAccount('livekit', MEDIA_NAMESPACE),
    configMap('coturn-config', { 'turnserver.conf': turnConf }, MEDIA_NAMESPACE),
    configMap('livekit-config', { 'livekit.yaml': livekit }, MEDIA_NAMESPACE),
    externalSecret(values, 'coturn', MEDIA_NAMESPACE),
    externalSecret(values, 'livekit', MEDIA_NAMESPACE),
    mediaWorkload(
      'coturn',
      size.turn,
      {
        image: 'coturn/coturn:4.6.2',
        args: [
          '-c',
          '/etc/tessera/turnserver.conf',
          '--static-auth-secret=$(TURN_STATIC_AUTH_SECRET)',
          '--realm=tessera',
          '--log-file=stdout',
          '--pidfile=/tmp/turnserver.pid',
          '--db=/tmp/turndb',
          '--cert=/etc/tessera-tls/tls.crt',
          '--pkey=/etc/tessera-tls/tls.key',
        ],
        envFrom: [{ secretRef: { name: 'coturn' } }],
        resources: { requests: { cpu: '1', memory: '512Mi' }, limits: { memory: '1Gi' } },
        ports: [
          { name: 'turn-udp', containerPort: 3478, protocol: 'UDP' },
          { name: 'turns', containerPort: 5349, protocol: 'TCP' },
        ],
        readinessProbe: { tcpSocket: { port: 5349 }, periodSeconds: 10 },
        livenessProbe: { tcpSocket: { port: 5349 }, periodSeconds: 20, failureThreshold: 3 },
      },
      'coturn-config',
      'turn-tls',
    ),
    mediaWorkload(
      'livekit',
      size.sfu,
      {
        image: 'livekit/livekit-server:v1.13.9',
        args: ['--config', '/etc/tessera/livekit.yaml'],
        envFrom: [{ secretRef: { name: 'livekit' } }],
        resources: { requests: { cpu: '2', memory: '1Gi' }, limits: { memory: '2Gi' } },
        ports: [
          { name: 'http', containerPort: 7880, protocol: 'TCP' },
          { name: 'rtc-tcp', containerPort: 7881, protocol: 'TCP' },
        ],
        readinessProbe: { httpGet: { path: '/', port: 7880 }, periodSeconds: 10 },
        livenessProbe: {
          httpGet: { path: '/', port: 7880 },
          periodSeconds: 20,
          failureThreshold: 3,
        },
      },
      'livekit-config',
    ),
    service('livekit', [{ name: 'http', port: 7880 }], MEDIA_NAMESPACE),
    {
      // TURN over TLS (turns:5349) needs a certificate for turn.<domain> on the nodes.
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: 'turn-tls', namespace: MEDIA_NAMESPACE },
      spec: {
        secretName: 'turn-tls',
        dnsNames: [hosts(values).turn],
        issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt-dns' },
        privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
      },
    },
    pdb('coturn', MEDIA_NAMESPACE),
    pdb('livekit', MEDIA_NAMESPACE),
    networkPolicy(
      'livekit-api',
      {
        podSelector: { matchLabels: labels('livekit') },
        policyTypes: ['Ingress'],
        // Host-networked pods are not isolated by most CNIs; the node security group restricts
        // 7880 to the cluster (infra/terraform). This policy documents the intended peers.
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': NAMESPACE } },
                podSelector: {
                  matchExpressions: [
                    { key: 'app.kubernetes.io/name', operator: 'In', values: ['api', 'web'] },
                  ],
                },
              },
            ],
            ports: [{ protocol: 'TCP', port: 7880 }],
          },
        ],
      },
      MEDIA_NAMESPACE,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------

export function manifests(values: Values): Manifest[] {
  const size = sizing(values);
  const apiImage = image(values, 'api');
  const build = [{ name: 'BUILD_VERSION', value: values.release }];
  const migrateJob: Manifest = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      // One Job per release; expand-only migrations run before the new pods (docs/deployment.md §3).
      name: `migrate-${values.release.replace(/[^a-z0-9-]/g, '-')}`,
      namespace: NAMESPACE,
      labels: labels('migrate'),
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 1800,
      ttlSecondsAfterFinished: 604_800,
      template: {
        metadata: { labels: labels('migrate') },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'migrate',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: podSecurity,
          containers: [
            {
              name: 'migrate',
              image: apiImage,
              args: ['dist/cli/migrate.js'],
              env: [
                { name: 'NODE_ENV', value: 'production' },
                { name: 'LOG_LEVEL', value: 'info' },
              ],
              envFrom: [{ secretRef: { name: 'migrate' } }],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { memory: '256Mi' },
              },
              securityContext: restrictedContainer,
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '16Mi' } }],
        },
      },
    },
  };

  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: NAMESPACE,
        labels: {
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'latest',
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/audit': 'restricted',
        },
      },
    },
    ...['api', 'admin-api', 'realtime', 'link-fetcher', 'web', 'admin-web', 'migrate'].map((name) =>
      serviceAccount(name),
    ),
    configMap('api-config', apiConfig(values)),
    configMap('admin-config', adminConfig(values)),
    configMap('realtime-config', realtimeConfig(values)),
    configMap('link-fetcher-config', fetcherConfig()),
    externalSecret(values, 'api'),
    externalSecret(values, 'admin'),
    externalSecret(values, 'realtime'),
    externalSecret(values, 'link-fetcher'),
    externalSecret(values, 'migrate'),
    migrateJob,
    deployment({
      name: 'api',
      replicas: size.api.min,
      image: apiImage,
      args: ['dist/server.js'],
      ports: [{ name: 'http', port: 8080 }],
      healthPort: 9090,
      config: ['api-config'],
      secrets: ['api'],
      env: build,
      resources: { cpu: '500m', memory: '512Mi', memoryLimit: '1Gi' },
      terminationGraceSeconds: 45,
      maxUnavailable: 0,
      maxSurge: '25%',
    }),
    deployment({
      name: 'admin-api',
      replicas: size.admin,
      image: apiImage,
      args: ['dist/admin-server.js'],
      ports: [{ name: 'http', port: 8082 }],
      healthPort: 9092,
      config: ['api-config', 'admin-config'],
      secrets: ['api', 'admin'],
      env: build,
      resources: { cpu: '200m', memory: '256Mi', memoryLimit: '512Mi' },
      terminationGraceSeconds: 45,
      maxUnavailable: 0,
      maxSurge: 1,
    }),
    deployment({
      name: 'link-fetcher',
      replicas: size.fetcher.min,
      image: apiImage,
      args: ['dist/fetcher-server.js'],
      ports: [{ name: 'http', port: 8080 }],
      healthPort: 9090,
      config: ['link-fetcher-config'],
      secrets: ['link-fetcher'],
      resources: { cpu: '100m', memory: '128Mi', memoryLimit: '256Mi' },
      terminationGraceSeconds: 20,
      maxUnavailable: 0,
      maxSurge: 1,
    }),
    deployment({
      name: 'realtime',
      replicas: size.realtime.min,
      image: image(values, 'realtime'),
      args: ['dist/server.js'],
      ports: [{ name: 'ws', port: 8081 }],
      healthPort: 9091,
      config: ['realtime-config'],
      secrets: ['realtime'],
      resources: { cpu: '1', memory: '1Gi', memoryLimit: '2Gi' },
      // ≥ drain window + shutdown timeout (docs/deployment.md §5).
      terminationGraceSeconds: 90,
      // One pod at a time: each wave of reconnects is one pod's sockets.
      maxUnavailable: 1,
      maxSurge: 1,
    }),
    // The web tiers: nginx serving the signed build with the headers it was built with
    // (infra/images/web.Dockerfile); the web tier also proxies /sfu to LiveKit's signalling.
    deployment({
      name: 'web',
      replicas: size.web.min,
      image: image(values, 'web'),
      ports: [{ name: 'http', port: 8080 }],
      healthPort: 8081,
      config: [],
      secrets: [],
      resources: { cpu: '100m', memory: '64Mi', memoryLimit: '256Mi' },
      terminationGraceSeconds: 30,
      maxUnavailable: 0,
      maxSurge: '25%',
    }),
    deployment({
      name: 'admin-web',
      replicas: 2,
      image: image(values, 'adminWeb'),
      ports: [{ name: 'http', port: 8080 }],
      healthPort: 8081,
      config: [],
      secrets: [],
      resources: { cpu: '50m', memory: '32Mi', memoryLimit: '128Mi' },
      terminationGraceSeconds: 30,
      maxUnavailable: 0,
      maxSurge: 1,
    }),
    service('api', [{ name: 'http', port: 8080 }], NAMESPACE, 9090),
    service('admin-api', [{ name: 'http', port: 8082 }], NAMESPACE, 9092),
    service('link-fetcher', [{ name: 'http', port: 8080 }]),
    service('realtime', [{ name: 'ws', port: 8081 }], NAMESPACE, 9091),
    service('web', [{ name: 'http', port: 8080 }], NAMESPACE, 8081),
    service('admin-web', [{ name: 'http', port: 8080 }], NAMESPACE, 8081),
    ...['api', 'admin-api', 'link-fetcher', 'realtime', 'web', 'admin-web'].map((name) =>
      pdb(name),
    ),
    hpa('api', size.api.min, size.api.max, 60),
    hpa('web', size.web.min, size.web.max, 70),
    hpa('link-fetcher', size.fetcher.min, size.fetcher.max, 70),
    // CPU tracks connections closely in the load tests (capacity.md); a connections metric
    // through a custom-metrics adapter can replace it.
    hpa('realtime', size.realtime.min, size.realtime.max, 55),
    ...networkPolicies(values),
    ...ingresses(values),
    ...['api', 'admin-api', 'link-fetcher', 'realtime'].map((name) => podMonitor(name)),
    alertRules(),
    ...media(values),
  ];
}
