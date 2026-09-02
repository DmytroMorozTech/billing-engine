# ADR-0006: Plans buy a rate; the rate applies by transaction date

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Most subscription-billing projects model a plan as a tier that unlocks features.
That produces a proration problem with one obvious answer and no interesting
failure modes.

The platform modelled here uses the hybrid that SMB payment platforms use: **a
subscription does not buy features, it buys a lower commission rate.**

| Plan | Monthly fee | In-person rate |
|---|---|---|
| Standard | €0 | 1.69% |
| Payments Plus | €19 | 0.99% |

A merchant therefore pays a *fixed* component and a *usage* component, and the
subscription changes the price of the usage component. This creates a question
with no self-evident answer:

> A merchant upgrades from Standard to Payments Plus on 15 September. Between
> 1 and 14 September they already processed €4 130 of volume at 1.69%. What are
> they charged for that volume?

Three candidate answers:

- **(a)** Rate follows the transaction date. Old volume at 1.69%, new volume at
  0.99%. The monthly fee is prorated by days.
- **(b)** The new rate applies retroactively to the whole period, with a credit
  note for the difference.
- **(c)** Rate follows the transaction date, but the €19 fee is charged in full
  regardless of when in the cycle the upgrade happened.

## Decision

**Option (a): the rate in force at the moment a transaction occurred is the rate
that applies to it. The subscription fee is prorated by calendar days.**

A plan change produces a new **rate interval**, not a mutation of past data:

```
merchant 42, period 2026-09-01 .. 2026-09-30 (Europe/Berlin)
  ├─ 2026-09-01 .. 2026-09-14   Standard        1.69%   (14 days)
  └─ 2026-09-15 .. 2026-09-30   Payments Plus   0.99%   (16 days)
```

Each transaction is rated against the interval containing its `occurred_at` in
the merchant's billing time zone. Intervals are closed once billed and are never
recalculated — which is what makes re-running a closed period byte-for-byte
reproducible.

### Worked example

Volume: €4 130.00 before the change, €3 870.00 after. Market DE, VAT 19%.

| Line | Calculation | Amount |
|---|---|---|
| Subscription — Payments Plus, 15–30 Sep | 1900 × 16 ÷ 30 = 1013.33 | **1013** |
| Commission — Standard, 1–14 Sep | 413000 × 169 ÷ 10000 = 6979.70 | **6980** |
| Commission — Payments Plus, 15–30 Sep | 387000 × 99 ÷ 10000 = 3831.30 | **3831** |
| Subtotal | | 11824 |
| VAT 19% | 11824 × 19 ÷ 100 = 2246.56 | **2247** |
| **Total** | | **14071** (€140.71) |

All values are integer minor units, rounded per line, half away from zero, per
[ADR-0001](0001-money-as-integer-minor-units.md). The Standard fee contributes no
line because €0 prorated is still €0 — but the *interval* is still recorded, and
it is what explains the 1.69% line.

### Why not (b)

Retroactive repricing is generous to the merchant and indefensible as a rule: a
merchant who upgrades on the 30th of the month buys a discount on volume they
already processed at a higher agreed rate. It is gameable by construction, and it
breaks the bitemporal principle that an event is priced by the terms in force when
it happened.

**Option (b) is not discarded, it is repurposed.** It becomes the `v1` "legacy"
calculator in the shadow-run feature — a plausible-looking implementation that a
real company might have shipped years ago. Running v1 and v2 over the same data
produces a concrete money diff:

```
v1 (retroactive):  800000 × 99 ÷ 10000  =  7920   (€79.20)
v2 (by date):      6980 + 3831          = 10811   (€108.11)
                                    diff = 2891   (€28.91 undercharged)
```

That is a far better demonstration of *"contribute to the refactoring of key
billing components"* than an artificial rounding difference.

### Why not (c)

Charging the full €19 for sixteen days is the simplest code, and it deletes the
proration logic that is the core of this project.

## Consequences

- The rating engine must resolve a rate **per transaction**, by timestamp in the
  merchant's billing time zone — not per invoice, not per merchant.
- Plan changes are **bitemporal**: a change may be *effective* on 5 September but
  *recorded* on 12 September. A backdated change reopens rate intervals and emits
  a credit note. This must be designed in from the start.
- Downgrades work identically in the opposite direction: the higher rate applies
  from the effective date forward, and the unused portion of the monthly fee is
  credited.
- A property-based test asserts that **proration credits never exceed what was
  actually paid for the period** — the invariant that catches sign errors and
  double-crediting.
- The "why is this amount" screen has genuinely non-obvious content to explain:
  one commission line splits into two rate segments with different denominators.
- Day counting uses calendar days in the merchant's time zone
  (`Temporal.PlainDate.until`), so a DST boundary inside the period does not shift
  a proration by 1/24th of a day. See [ADR-0002](0002-injectable-clock-and-temporal.md).

## Open question deferred

Volume-tiered rates (first €10 000 at one rate, the remainder at another) are
**out of scope for now**. They compose with rate intervals in a way that would
double the rating engine's complexity, and the domain is already rich enough
without them. If added later, this ADR is superseded rather than amended.
