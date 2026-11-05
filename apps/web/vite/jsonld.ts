import { PLANS, planCtaHref } from '../../../packages/core/src/contracts/plans';

/** schema.org Offers for the priced plans, derived from PLANS (007/FR-086) so prices live in one place. */
export function planOffers(origin = 'https://tenderpilot.in') {
  return PLANS.filter((p) => p.monthlyInr !== null).map((p) => ({
    '@type': 'Offer', name: p.name, price: String(p.monthlyInr), priceCurrency: 'INR', url: `${origin}${planCtaHref(p)}`,
  }));
}

const LD = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;

/** Rewrites the `offers` of index.html's JSON-LD from PLANS. Idempotent; the HTML keeps a valid, readable copy. */
export function withPlanOffers(html: string): string {
  return html.replace(LD, (_m, open: string, json: string, close: string) => {
    const data = JSON.parse(json);
    data.offers = planOffers();
    return `${open}\n      ${JSON.stringify(data)}\n    ${close}`;
  });
}
