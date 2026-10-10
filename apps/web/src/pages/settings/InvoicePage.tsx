import { Alert, Button, Skeleton } from '@tessera/ui';
import { useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { billingEndpoints } from '../../api/billing-endpoints.js';
import { money } from '../../billing/format.js';
import { PageHeading } from '../../components/PageHeading.js';
import { useResource } from '../../lib/use-resource.js';

const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
const dateOf = (iso: string | null) => (iso === null ? '—' : day.format(new Date(iso)));

/** A tax invoice, laid out to print or save as PDF from the browser. */
export function InvoicePage(): ReactNode {
  const { invoiceId = '' } = useParams();
  const load = useCallback(() => billingEndpoints.invoice(invoiceId), [invoiceId]);
  const invoice = useResource(load);
  const data = invoice.data;
  return (
    <div className="settings-page">
      <p className="no-print">
        <Link to="/settings/plan">← Plan</Link>
      </p>
      <PageHeading>{data === undefined ? 'Invoice' : `Tax invoice ${data.number}`}</PageHeading>
      {invoice.error === undefined ? null : <Alert tone="danger">{invoice.error}</Alert>}
      {data === undefined ? (
        invoice.error === undefined ? (
          <Skeleton height="10rem" shape="tile" />
        ) : null
      ) : (
        <article className="invoice stack" aria-label={`Invoice ${data.number}`}>
          <div className="invoice__parties">
            <section aria-labelledby="seller-heading">
              <h2 id="seller-heading">From</h2>
              <p>{data.seller.name}</p>
              <p>{data.seller.address}</p>
              <p>State: {data.seller.state}</p>
              {data.seller.gstin === null ? null : <p>GSTIN: {data.seller.gstin}</p>}
            </section>
            <section aria-labelledby="buyer-heading">
              <h2 id="buyer-heading">To</h2>
              <p>{data.buyer.name}</p>
              <p>
                {data.buyer.state === null ? '' : `${data.buyer.state}, `}
                {data.buyer.country}
              </p>
              {data.buyer.gstin === null ? null : <p>GSTIN: {data.buyer.gstin}</p>}
            </section>
          </div>
          <dl className="invoice__facts">
            <dt>Invoice number</dt>
            <dd>{data.number}</dd>
            <dt>Date</dt>
            <dd>{dateOf(data.issuedAt)}</dd>
            <dt>Place of supply</dt>
            <dd>{data.buyer.state ?? data.buyer.country}</dd>
          </dl>
          <table className="invoice__lines">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">SAC</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {data.planName}
                  <br />
                  <span className="t-field__hint">
                    {dateOf(data.periodStart)} – {dateOf(data.periodEnd)}
                  </span>
                </td>
                <td>{data.sacCode}</td>
                <td>{money(data.taxableMinor, data.currency)}</td>
              </tr>
              {data.cgstMinor > 0 ? (
                <tr>
                  <td colSpan={2}>CGST 9%</td>
                  <td>{money(data.cgstMinor, data.currency)}</td>
                </tr>
              ) : null}
              {data.sgstMinor > 0 ? (
                <tr>
                  <td colSpan={2}>SGST 9%</td>
                  <td>{money(data.sgstMinor, data.currency)}</td>
                </tr>
              ) : null}
              {data.igstMinor > 0 ? (
                <tr>
                  <td colSpan={2}>IGST 18%</td>
                  <td>{money(data.igstMinor, data.currency)}</td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Total paid
                </th>
                <td>{money(data.totalMinor, data.currency)}</td>
              </tr>
              {data.refundedMinor > 0 ? (
                <tr>
                  <th scope="row" colSpan={2}>
                    Refunded
                  </th>
                  <td>{money(data.refundedMinor, data.currency)}</td>
                </tr>
              ) : null}
            </tfoot>
          </table>
          <p className="t-field__hint">{data.taxNote}</p>
          <div className="button-row no-print">
            <Button variant="secondary" onClick={() => window.print()}>
              Print or save as PDF
            </Button>
          </div>
        </article>
      )}
    </div>
  );
}
