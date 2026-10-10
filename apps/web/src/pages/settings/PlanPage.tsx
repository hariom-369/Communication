import { Alert, Button, Dialog, Skeleton, TextField } from '@tessera/ui';
import {
  INDIAN_STATES,
  type BillingProfile,
  type Plan,
  type Subscription,
} from '@tessera/validation';
import { useCallback, useEffect, useMemo, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { billingEndpoints } from '../../api/billing-endpoints.js';
import { errorMessage } from '../../api/client.js';
import { countries, describeLimits, money, TIER_NAMES } from '../../billing/format.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
const dateOf = (iso: string | null) => (iso === null ? '' : day.format(new Date(iso)));

const STATES = Object.entries(INDIAN_STATES)
  .map(([code, state]) => ({ code, name: state.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Name and place for invoices (the place decides the currency, the provider and GST). */
function BillingDetails({
  profile,
  locked,
  onSaved,
}: {
  profile: BillingProfile | null;
  locked: boolean;
  onSaved: () => void;
}): ReactNode {
  const list = useMemo(() => countries(), []);
  const [legalName, setLegalName] = useState(profile?.legalName ?? '');
  const [country, setCountry] = useState(profile?.country ?? 'IN');
  const [state, setState] = useState<string>(profile?.state ?? '');
  const [gstin, setGstin] = useState(profile?.gstin ?? '');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const india = country === 'IN';

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await billingEndpoints.saveProfile({
        legalName,
        country,
        state: india ? (state as BillingProfile['state']) : null,
        gstin: india && gstin.trim() !== '' ? gstin.trim() : null,
      });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" aria-label="Billing details" onSubmit={(event) => void save(event)}>
      <TextField
        label="Name on invoices"
        hint="Your name, or your business’s registered name."
        required
        maxLength={200}
        autoComplete="name"
        value={legalName}
        onChange={(e) => setLegalName(e.target.value)}
      />
      <label className="t-field">
        <span className="t-field__label">Country</span>
        <select
          className="t-field__input"
          value={country}
          disabled={locked}
          onChange={(e) => setCountry(e.target.value)}
        >
          {list.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        {locked ? (
          <span className="t-field__hint">
            You can change the country when your current plan ends.
          </span>
        ) : null}
      </label>
      {india ? (
        <>
          <label className="t-field">
            <span className="t-field__label">State or union territory</span>
            <select
              className="t-field__input"
              required
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">Choose…</option>
              {STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="GSTIN (optional)"
            hint="For a registered business: the invoice is issued in its name for input tax credit."
            maxLength={15}
            autoComplete="off"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
          />
        </>
      ) : null}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {saved ? <Alert tone="success">Billing details saved.</Alert> : null}
      <div className="button-row">
        <Button type="submit" loading={busy} loadingLabel="Saving">
          Save billing details
        </Button>
      </div>
    </form>
  );
}

function PlanCard({
  plan,
  canBuy,
  onChoose,
}: {
  plan: Plan;
  canBuy: boolean;
  onChoose: (plan: Plan) => void;
}): ReactNode {
  return (
    <li className="notice-card stack" aria-label={plan.name}>
      <p>
        <strong>{plan.name}</strong>
      </p>
      <p>
        {money(plan.price.amountMinor, plan.price.currency)} per {plan.interval}
        {plan.price.currency === 'INR' ? ' (includes 18% GST)' : ''}
      </p>
      {plan.available ? (
        <div className="button-row">
          <Button size="sm" disabled={!canBuy} onClick={() => onChoose(plan)}>
            Choose {plan.name}
          </Button>
        </div>
      ) : (
        <p className="t-field__hint">Not available to buy yet.</p>
      )}
    </li>
  );
}

function statusText(subscription: Subscription): string {
  const end = dateOf(subscription.currentPeriodEnd);
  switch (subscription.status) {
    case 'incomplete':
      return 'Waiting for the payment provider to confirm your payment.';
    case 'active':
      return subscription.cancelAtPeriodEnd
        ? `Cancelled — your plan stays until ${end}. You will not be charged again.`
        : `Renews on ${end}.`;
    case 'past_due':
      return 'Your last payment did not go through. The payment provider will try again; your plan stays for 7 days from the first failed attempt.';
    case 'canceled':
      return 'This plan has ended.';
  }
}

/**
 * Plans and billing (docs/billing.md). Payment happens on the provider's own page (Razorpay in
 * India, Stripe elsewhere); Tessera never sees card or UPI details. Cancelling is one step.
 * Security and privacy features are free on every plan.
 */
export function PlanPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const returning = params.get('checkout') === 'return';
  const loadAll = useCallback(
    () =>
      Promise.all([
        billingEndpoints.entitlements(),
        billingEndpoints.subscription(),
        billingEndpoints.plans(),
        billingEndpoints.profile(),
        billingEndpoints.invoices(),
      ]),
    [],
  );
  const data = useResource(loadAll);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const [entitlements, subscriptionResponse, planList, profileResponse, invoiceList] =
    data.data ?? [];
  const subscription = subscriptionResponse?.subscription ?? null;
  const waiting = subscription?.status === 'incomplete';

  // Back from the provider's page: the payment is confirmed by the provider's webhook, usually
  // within seconds, so look again for a little while.
  const reload = data.reload;
  useEffect(() => {
    if (!returning || !waiting) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > 40) {
        clearInterval(timer);
        return;
      }
      reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [returning, waiting, reload]);

  async function choose(plan: Plan) {
    setBusy(plan.code);
    setError(undefined);
    try {
      const { url } = await billingEndpoints.checkout(plan.code);
      window.location.assign(url);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(undefined);
    }
  }

  async function act(action: () => Promise<unknown>, label: string) {
    setBusy(label);
    setError(undefined);
    try {
      await action();
      setConfirmCancel(false);
      data.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  if (data.error !== undefined)
    return (
      <div className="settings-page">
        <PageHeading>Plan</PageHeading>
        <Alert tone="danger">{data.error}</Alert>
      </div>
    );
  if (
    entitlements === undefined ||
    planList === undefined ||
    profileResponse === undefined ||
    invoiceList === undefined
  )
    return (
      <div className="settings-page">
        <PageHeading>Plan</PageHeading>
        <div role="status" aria-busy="true" aria-label="Loading your plan" className="stack">
          <Skeleton height="6rem" shape="tile" />
        </div>
      </div>
    );

  const live = subscription !== null && subscription.status !== 'incomplete';
  const profile = profileResponse.profile;
  return (
    <div className="settings-page">
      <PageHeading description="Encryption, passkeys, two-step verification, safety numbers and backups are free on every plan.">
        Plan
      </PageHeading>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}

      <section className="settings-section" aria-labelledby="current-heading">
        <h2 id="current-heading">Your plan: {TIER_NAMES[entitlements.tier]}</h2>
        <ul className="plain-list">
          {describeLimits(entitlements.limits).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {subscription === null ? null : (
          <Alert
            tone={subscription.status === 'past_due' ? 'warning' : 'info'}
            title={subscription.planName}
          >
            <p>{statusText(subscription)}</p>
          </Alert>
        )}
        {waiting && returning ? (
          <p role="status" className="t-field__hint">
            Checking for your payment…{' '}
            <Button size="sm" variant="ghost" onClick={() => setParams({})}>
              Stop checking
            </Button>
          </p>
        ) : null}
        {live && subscription.status !== 'canceled' ? (
          <div className="button-row">
            {subscription.cancelAtPeriodEnd ? (
              subscription.canResume ? (
                <Button
                  variant="secondary"
                  loading={busy === 'resume'}
                  onClick={() => void act(billingEndpoints.resume, 'resume')}
                >
                  Keep my plan
                </Button>
              ) : null
            ) : (
              <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
                Cancel plan
              </Button>
            )}
          </div>
        ) : null}
      </section>

      {live ? null : (
        <section className="settings-section" aria-labelledby="plans-heading">
          <h2 id="plans-heading">Plans</h2>
          {profile === null ? (
            <p>Add your billing details below to see prices in your currency.</p>
          ) : (
            <p className="t-field__hint">
              You pay on {planList.provider === 'razorpay' ? 'Razorpay' : 'Stripe'}’s secure page
              (UPI, cards and more). Tessera never sees your card or UPI details. You can cancel at
              any time; the plan then runs to the end of the period you paid for.
            </p>
          )}
          <ul className="plain-list stack">
            {planList.plans.map((plan) => (
              <PlanCard
                key={plan.code}
                plan={plan}
                canBuy={profile !== null && busy === undefined}
                onChoose={(chosen) => void choose(chosen)}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="settings-section" aria-labelledby="details-heading">
        <h2 id="details-heading">Billing details</h2>
        <BillingDetails profile={profile} locked={live} onSaved={data.reload} />
      </section>

      <section className="settings-section" aria-labelledby="invoices-heading">
        <h2 id="invoices-heading">Invoices</h2>
        {invoiceList.invoices.length === 0 ? (
          <p className="empty">No invoices yet.</p>
        ) : (
          <ul className="plain-list">
            {invoiceList.invoices.map((invoice) => (
              <li key={invoice.id}>
                <Link to={`/settings/plan/invoices/${invoice.id}`}>
                  {invoice.number} — {dateOf(invoice.issuedAt)} —{' '}
                  {money(invoice.totalMinor, invoice.currency)}
                  {invoice.refundedMinor > 0 ? ' (refunded)' : ''}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={confirmCancel}
        title="Cancel your plan?"
        description={
          subscription?.currentPeriodEnd === null || subscription === null
            ? 'You will not be charged again.'
            : `Your plan stays until ${dateOf(subscription.currentPeriodEnd)}, then your account moves to the free plan. You will not be charged again.`
        }
        onClose={() => setConfirmCancel(false)}
      >
        <div className="button-row">
          <Button
            variant="danger"
            loading={busy === 'cancel'}
            onClick={() => void act(billingEndpoints.cancel, 'cancel')}
          >
            Cancel plan
          </Button>
          <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
            Keep my plan
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
