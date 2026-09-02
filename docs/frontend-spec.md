# Frontend specification

Scope: `apps/web` — one Next.js application serving two audiences.
Effort budget: ~25% of the project. Backend correctness comes first.

---

## 1. Two audiences, two jobs

**The merchant** shows up rarely and usually while annoyed — an invoice arrived
that is larger than expected. What they need is *transparency*, not features.

**The support engineer on weekly rotation** shows up with a ticket: "this merchant
says they were charged twice, find out." What they need is a timeline, an
explanation of every number, and the buttons to fix it.

The support console is the screen that distinguishes this project. The merchant
portal is built first because its hardest screen — the proration preview — forces
the derivation format into existence, and the console then reuses it.

## 2. Application shape

One Next.js app, two route groups, one deployment.

```
apps/web/app/
├── (merchant)/   → /login, /app/*
├── (ops)/        → /ops/login, /ops/*
└── layout.tsx    → design tokens, Circuit UI styles, demo bar
```

**Auth:** minimal but real. Email + password, session cookie, a `role` of
`merchant | support`. A merchant can only read their own data; the API enforces
this, not the UI. In demo mode a "sign in as…" panel lists the seeded users, so
nobody has to hunt for credentials.

**Data flow:** Server Components fetch from the Fastify API over the internal
network. Mutations go through Server Actions, which call the same API. The browser
never talks to the API directly, so there is exactly one place where auth and
error mapping live.

## 3. Merchant portal

| URL | Content | Actions |
|---|---|---|
| `/login` | sign-in form; demo user picker | sign in |
| `/app` | current plan and rate, wallet balance, "next invoice ≈ X on Y", last 5 events | navigate |
| `/app/subscription` | plan, rate, billing cycle, **anchor date**, status | start plan change, cancel |
| `/app/subscription/change` | **proration preview** — what will be charged and credited, with the full derivation expandable | confirm, cancel |
| `/app/invoices` | invoice table: number, period, total, status | filter by period and status |
| `/app/invoices/[id]` | line items, VAT, total; per-line "why this amount"; PDF link | download PDF, pay / retry |
| `/app/wallet` | balance **derived from the ledger**, movement history | — |
| `/app/settings` | market, VAT ID, billing time zone | edit — changes VAT treatment and period boundaries |

`/app/subscription/change` is the screen that earns its place. It is the only
place a merchant sees the consequences of an upgrade *before* committing to it,
and per [ADR-0006](adr/0006-plan-model-and-mid-cycle-rate-change.md) those
consequences are genuinely non-obvious: the monthly fee is prorated by days while
the commission splits into two rate segments.

## 4. Support console

| URL | Content | Actions |
|---|---|---|
| `/ops/login` | sign-in form | sign in |
| `/ops` | on-call dashboard: failed job count, merchants in dunning, last billing run, ledger invariant status | drill into any tile |
| `/ops/merchants` | search by email, id, or invoice number | find |
| `/ops/merchants/[id]` | 360° view: subscription, wallet, invoices, **event timeline** | see below |
| `/ops/invoices/[id]/explain` | **the derivation tree** — the project's centrepiece screen | expand nodes, jump to source events |
| `/ops/billing-runs` | runs: when, which period, invoices produced, which worker held the lock | — |
| `/ops/billing-runs/[id]` | what the run produced, diff against expectation | — |
| `/ops/jobs` | stuck and failed jobs, stack trace, attempt count | retry, move to DLQ, drop |
| `/ops/shadow-run` | v1 vs v2 report: money differences grouped by cause | run against a sample |
| `/ops/reconciliation` | invariant checks: ledger sums to zero, no gaps in invoice numbering | run check |

**Actions on `/ops/merchants/[id]`:** retry payment, issue credit note, force a
billing run, suspend or restore a subscription.

Every one of those actions writes an `ops_action` entry into the same timeline,
naming the operator. That audit trail is the point: it is what makes the console
read as a tool built by someone who imagined being on rotation, rather than a page
with buttons on it.

## 5. The derivation format

This is a backend contract, not a UI concern, and it must exist before any of
these screens can be built.

**The explanation is recorded when the amount is computed, and stored alongside
it. It is never recomputed on read.** If it were recomputed, a later change to the
calculation would silently make the explanation disagree with the invoice — and
the support tool would start lying at the exact moment it matters most.

```ts
type Derivation = {
  result: Money;                    // integer minor units + currency
  formula: string;                  // "volume × rate"
  rounding?: {
    mode: 'half-away-from-zero';
    exact: string;                  // "6979.70" — the value before rounding
    applied: number;                // 6980
  };
  inputs: DerivationNode[];
};

type DerivationNode =
  | { kind: 'value'; label: string; value: Money | number | string }
  | { kind: 'event'; label: string; eventId: string;
      occurredAt: string; recordedAt: string }      // bitemporal, both shown
  | { kind: 'computation'; label: string; derivation: Derivation };
```

A commission line from the worked example in ADR-0006:

```json
{
  "result": { "amount": 6980, "currency": "EUR" },
  "formula": "volume × rate",
  "rounding": { "mode": "half-away-from-zero", "exact": "6979.70", "applied": 6980 },
  "inputs": [
    { "kind": "value", "label": "Volume 1–14 Sep", "value": { "amount": 413000, "currency": "EUR" } },
    { "kind": "value", "label": "Rate (Standard)", "value": "169 bps = 1.69%" },
    { "kind": "event", "label": "Plan interval opened", "eventId": "evt_7f1",
      "occurredAt": "2026-09-01T00:00:00+02:00", "recordedAt": "2026-09-01T00:00:03+02:00" }
  ]
}
```

The UI renders this recursively as a collapsible tree. One component,
`<DerivationTree>`, is used in three places: the merchant invoice detail (shallow,
one level), the proration preview, and `/ops/invoices/[id]/explain` (full depth).

## 6. Two cross-cutting UI elements

**The time machine is a bar, not a page.** In demo mode a strip pins to the top of
both portals: `Virtual time: 15 Sep 2026` with `+1 day`, `+1 month`, and
`skip to next scheduled event`. Without it the demo video does not exist — the
whole point is that someone presses a button and an invoice appears, a
payment fails, and dunning fires in front of them.

**The bitemporal toggle.** The merchant timeline has two axes: *as it happened*
and *as we learned of it*. A merchant who cancelled on the 5th, recorded on the
12th, sits at a different position on each. One switch, and it explains the whole
model.

## 7. Circuit UI components this maps onto

Little of this needs hand-written markup:

| Need | Component |
|---|---|
| money input and display | `CurrencyInput`, `Numeral` |
| commission rates | `PercentageInput` |
| dates, time machine | `Timestamp`, `DateInput`, `Calendar`, `TimeInput` |
| plan comparison, current tier | `ComparisonTable`, `TierIndicator` |
| markets DE / UK / IT | `Flag` |
| invoice status | `Status`, `Badge`, `Tag` |
| dunning messages | `NotificationBanner`, `NotificationInline` |
| both portal shells | `TopNavigation`, `SideNavigation` |
| tables, dialogs, forms | `Table`, `Modal`, `Field`, `Button` |

The generated component inventory lives in `.claude/skills/circuit-ui/` and is the
source of truth for the current API.

## 8. Explicitly out of scope

Sign-up, password reset, team management, avatars, revenue charts, a dark theme,
and any mobile work beyond what Circuit UI provides by default. Each of these
consumes time and earns nothing against the goals of this project.

## 9. Definition of done, per screen

1. Renders correctly from a Server Component with no client-side data fetching
   unless the screen is genuinely interactive.
2. Has a `jest-axe` accessibility test that passes — the template ships this, so
   there is no excuse to skip it.
3. Money is formatted through the shared helper backed by `@sumup-oss/intl`, never
   inline, and never from a float.
4. Dates are rendered in the merchant's billing time zone, not the browser's.
5. `npm run lint`, `npm run lint:css` and `npx jest --ci` all exit 0.
