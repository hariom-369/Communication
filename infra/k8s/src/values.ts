import { z } from 'zod';

/**
 * Per-environment inputs that are not decisions of this repository: the domain, the registry and
 * release, and the addresses and bucket names the infrastructure (infra/terraform) created. The
 * Terraform root outputs them as `k8s_values`; everything else — sizes, policies, settings — is
 * code in manifests.ts and reviewed like code.
 */

const cidr = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, { message: 'Must be an IPv4 CIDR' });
const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
    message: 'Must be a lower-case DNS name',
  });

const imageRef = z.string().regex(/^(sha256:[a-f0-9]{64}|\d+\.\d+\.\d+(-[0-9a-z.-]+)?)$/);

export const valuesSchema = z.strictObject({
  environment: z.enum(['staging', 'production']),
  /** Apex domain: the app is app.<domain>, the API api.<domain>, realtime rt.<domain>. */
  domain: hostname,
  /** Container registry holding tessera-api and tessera-realtime, e.g. ghcr.io/<owner>. */
  registry: z.string().regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/),
  /** The release (semantic version): BUILD_VERSION, and the migration Job's name. */
  release: z.string().regex(/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/),
  /** Each image by digest (`sha256:…`, what the release pipeline signs) or by version tag. */
  images: z.strictObject({
    api: imageRef,
    realtime: imageRef,
    web: imageRef,
    adminWeb: imageRef,
  }),
  awsRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  /** The VPC: load balancers (IP targets) and interface endpoints have addresses in it. */
  vpcCidr: cidr,
  /** Subnets of PostgreSQL (RDS) and Valkey (ElastiCache). */
  dataSubnetCidrs: z.array(cidr).min(1),
  /** Subnets of the media node group (coturn, LiveKit on host networking). */
  mediaSubnetCidrs: z.array(cidr).min(1),
  /** Security groups of the load balancers: the public one admits CloudFront only, the admin
   * one the identity-aware access proxy only (infra/terraform). */
  publicAlbSecurityGroupId: z.string().regex(/^sg-[0-9a-f]{8,17}$/),
  adminAlbSecurityGroupId: z.string().regex(/^sg-[0-9a-f]{8,17}$/),
  /** Encrypted attachments (docs/media.md §5). */
  mediaBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  /** Pwned Passwords range files, read through the VPC endpoint only (docs/deployment.md §5). */
  pwnedPasswordsBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  /** ACM certificate for *.<domain> (TLS on the load balancers). */
  certificateArn: z.string().regex(/^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/),
  /** Admin identity provider (OIDC issuer URL) and the e-mail domains it may sign in. */
  adminOidcIssuer: z.url({ protocol: /^https$/ }),
  adminEmailDomains: z.string().min(1),
  /** Further non-secret API settings, e.g. billing seller details and price ids. */
  apiEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).default({}),
});

export type Values = z.infer<typeof valuesSchema>;

export function parseValues(input: unknown): Values {
  return valuesSchema.parse(input);
}
