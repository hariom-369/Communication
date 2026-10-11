// Test only: runs the payment-provider stand-in (src/test/fake-payments.ts) as a process for the
// web app's E2E tests (apps/web/e2e/global-setup.ts). Never part of a build or deployment.
//   FAKE_PAYMENTS_PORT=28997 FAKE_PAYMENTS_WEBHOOKS=http://127.0.0.1:28080/api/v1/billing/webhooks \
//   FAKE_PAYMENTS_RETURN_URL=http://localhost:4173/settings/plan?checkout=return node scripts/fake-payments.mjs
const { FakePayments } = await import('../src/test/fake-payments.ts');

// The E2E setup generates the credentials and gives the same ones to the API.
const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Set ${name}`);
  return value;
};
const payments = await FakePayments.start(Number(process.env.FAKE_PAYMENTS_PORT ?? '0'), {
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  razorpayKeyId: env('RAZORPAY_KEY_ID'),
  razorpayKeySecret: env('RAZORPAY_KEY_SECRET'),
  razorpayWebhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
});
payments.webhookBase = process.env.FAKE_PAYMENTS_WEBHOOKS ?? null;
if (process.env.FAKE_PAYMENTS_RETURN_URL !== undefined)
  payments.razorpayReturnUrl = process.env.FAKE_PAYMENTS_RETURN_URL;
process.stdout.write(`payment stand-in at ${payments.url}\n`);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void payments.close().then(() => process.exit(0));
  });
