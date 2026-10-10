import { KeyObject, webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

/**
 * A made-up security-key vendor for tests: a root CA and an attestation certificate for one key
 * model (AAGUID), shaped as FIDO requires for `packed` attestation. Test-only — never shipped.
 */

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 3_600_000;

export interface TestVendor {
  /** The vendor root, PEM (what an operator puts in ADMIN_ATTESTATION_ROOTS_FILE). */
  readonly rootPem: string;
  /** The attestation certificate chain, leaf first (DER). */
  readonly certificates: Buffer[];
  readonly key: KeyObject;
}

export async function testVendor(
  aaguid: Buffer,
  options: { aaguidExtension?: boolean } = {},
): Promise<TestVendor> {
  const rootKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'C=XX, O=Test Key Vendor, CN=Test Key Vendor Root',
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    signingAlgorithm: ALGORITHM,
    keys: rootKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
    ],
  });
  const leafKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  // id-fido-gen-ce-aaguid: OCTET STRING containing the 16-byte AAGUID.
  const aaguidValue = Buffer.concat([Buffer.from([0x04, 0x10]), aaguid]);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'C=XX, O=Test Key Vendor, OU=Authenticator Attestation, CN=Test Key',
    issuer: root.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    signingAlgorithm: ALGORITHM,
    publicKey: leafKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      ...(options.aaguidExtension === false
        ? []
        : [new x509.Extension('1.3.6.1.4.1.45724.1.1.4', false, aaguidValue)]),
    ],
  });
  return {
    rootPem: root.toString('pem'),
    certificates: [Buffer.from(leaf.rawData)],
    key: KeyObject.from(leafKeys.privateKey),
  };
}
