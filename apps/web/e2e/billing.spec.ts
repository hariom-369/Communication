import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test, type Page } from '@playwright/test';

import { resetSignUpLimits, signUpWithPassword, trackCspViolations } from './support.js';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * Plans end to end (docs/billing.md): billing details, the provider's hosted payment page (a
 * stand-in that signs webhooks as Razorpay and Stripe do), the plan taking effect, a GST invoice,
 * and one-step cancellation — under the production CSP.
 */

test.beforeAll(async () => {
  await resetSignUpLimits();
});

async function billingDetails(
  page: Page,
  details: { name: string; country: string; state?: string },
): Promise<void> {
  const form = page.getByRole('form', { name: 'Billing details' });
  await form.getByLabel('Name on invoices').fill(details.name);
  await form.getByLabel('Country').selectOption(details.country);
  if (details.state !== undefined)
    await form.getByLabel('State or union territory').selectOption(details.state);
  await form.getByRole('button', { name: 'Save billing details' }).click();
  await expect(form.getByText('Billing details saved.')).toBeVisible();
}

test.describe('plans and billing', () => {
  test('India: pay with Razorpay, get a GST invoice, cancel in one step', async ({ page }) => {
    const violations = trackCspViolations(page);
    await signUpWithPassword(page);
    await page.goto('/settings/security');
    await page.getByRole('link', { name: 'Plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your plan: Free' })).toBeVisible();
    await expect(page.getByText('Files up to 200 MB each')).toBeVisible();
    await expect(page.getByText('Add your billing details below')).toBeVisible();

    await billingDetails(page, { name: 'Asha Rao', country: 'IN', state: 'KA' });
    const premium = page.getByRole('listitem', { name: 'Premium (monthly)' });
    await expect(premium).toContainText('includes 18% GST');
    await expect(premium).toContainText('99');
    await premium.getByRole('button', { name: 'Choose Premium (monthly)' }).click();

    // The provider's page (card and UPI details are entered there, never with Tessera).
    await expect(
      page.getByRole('heading', { name: /Test payment page \(razorpay\)/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pay' }).click();

    await expect(page).toHaveURL(/\/settings\/plan\?checkout=return$/);
    await expect(page.getByRole('heading', { name: 'Your plan: Premium' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Files up to 1 GB each')).toBeVisible();
    await expect(page.getByText(/Renews on/)).toBeVisible();

    await page.getByRole('link', { name: /^T\/\d{4}-\d{2}\/\d{6}/ }).click();
    const invoice = page.getByRole('article', { name: /Invoice T\// });
    await expect(invoice).toContainText('Asha Rao');
    await expect(invoice).toContainText('Karnataka');
    await expect(invoice).toContainText('CGST 9%');
    await expect(invoice).toContainText('SGST 9%');
    await expect(invoice).toContainText('GSTIN: 29ABCDE1234F1Z5');
    await page.getByRole('link', { name: '← Plan' }).click();

    await page.getByRole('button', { name: 'Cancel plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel your plan?' });
    await expect(dialog).toContainText('You will not be charged again');
    await dialog.getByRole('button', { name: 'Cancel plan' }).click();
    await expect(page.getByText(/Cancelled — your plan stays until/)).toBeVisible();
    // Still Premium until the period ends; Razorpay cancellations cannot be undone.
    await expect(page.getByRole('heading', { name: 'Your plan: Premium' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep my plan' })).toHaveCount(0);
    expect(violations).toEqual([]);
  });

  test('abroad: Stripe in dollars; a cancellation can be undone', async ({ page }) => {
    await signUpWithPassword(page);
    await page.goto('/settings/plan');
    await billingDetails(page, { name: 'Lena Vogel', country: 'DE' });
    const creator = page.getByRole('listitem', { name: 'Creator (monthly)' });
    await expect(creator).toContainText('$6.99');
    await creator.getByRole('button', { name: 'Choose Creator (monthly)' }).click();
    await expect(page.getByRole('heading', { name: /Test payment page \(stripe\)/ })).toBeVisible();
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByRole('heading', { name: 'Your plan: Creator' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Own up to 100 channels')).toBeVisible();
    // The billing country cannot change under a running plan.
    await expect(page.getByLabel('Country')).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel plan' }).click();
    await page
      .getByRole('dialog', { name: 'Cancel your plan?' })
      .getByRole('button', { name: 'Cancel plan' })
      .click();
    await page.getByRole('button', { name: 'Keep my plan' }).click();
    await expect(page.getByText(/Renews on/)).toBeVisible();
    await page.getByRole('link', { name: /^T\/\d{4}-\d{2}\/\d{6}/ }).click();
    await expect(page.getByRole('article', { name: /Invoice T\// })).toContainText(
      'Export of services',
    );
  });

  test('plan and invoice pages are accessible (axe)', async ({ browser }) => {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    const audit = async (where: string) => {
      await page.addScriptTag({ content: axeSource });
      const found = await page.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: { run: () => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
          }
        ).axe;
        return (await axe.run()).violations.map((v) => `${v.id} (${String(v.nodes.length)})`);
      });
      expect(found, where).toEqual([]);
    };
    await signUpWithPassword(page);
    await page.goto('/settings/plan');
    await page.getByRole('heading', { name: 'Your plan: Free' }).waitFor();
    await audit('/settings/plan');
    await billingDetails(page, { name: 'Kiran Iyer', country: 'IN', state: 'TN' });
    await page
      .getByRole('listitem', { name: 'Premium (monthly)' })
      .getByRole('button', { name: 'Choose Premium (monthly)' })
      .click();
    await page.getByRole('button', { name: 'Pay' }).click();
    await page.getByRole('heading', { name: 'Your plan: Premium' }).waitFor({ timeout: 20_000 });
    await audit('/settings/plan (premium)');
    await page.getByRole('link', { name: /^T\/\d{4}-\d{2}\/\d{6}/ }).click();
    await page.getByRole('article', { name: /Invoice T\// }).waitFor();
    await audit('invoice');
    await context.close();
  });
});
