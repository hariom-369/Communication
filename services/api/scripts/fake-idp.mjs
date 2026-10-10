// Test only: runs the test identity provider (src/test/fake-idp.ts) as a process for the admin
// console's E2E tests (apps/admin/e2e/global-setup.ts). Never part of a build or deployment.
//   FAKE_IDP_PORT=0 FAKE_IDP_CLIENT_SECRET=… node scripts/fake-idp.mjs   (0: any free port; the issuer is printed)
const { FakeIdp } = await import('../src/test/fake-idp.ts');

const port = Number(process.env.FAKE_IDP_PORT ?? '0');
const secret = process.env.FAKE_IDP_CLIENT_SECRET;
if (secret === undefined || secret.length < 16) throw new Error('Set FAKE_IDP_CLIENT_SECRET');
const idp = await FakeIdp.start(port, secret);
process.stdout.write(`fake identity provider at ${idp.issuer}\n`);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void idp.close().then(() => process.exit(0));
  });
