# ADR-0001: Money is an integer in minor units

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Billing arithmetic is the whole point of this project. IEEE-754 doubles cannot
represent most decimal fractions exactly, so `0.1 + 0.2 !== 0.3`. In a system
that sums thousands of line items and then reconciles them against a ledger that
must total exactly zero, that error is not theoretical — it accumulates and the
ledger stops balancing.

There is a second, subtler problem: **when to round**. Given three line items of
`10.005` each, rounding per line and then summing gives `30.03`, while summing
first and then rounding gives `30.02`. Both are defensible; only one can be
implemented, and it must be the same one everywhere.

## Decision

**All monetary amounts are integers in the currency's minor unit**, paired with
an ISO-4217 currency code. `1999` + `EUR` means €19.99. Floating point numbers
never represent money anywhere in the system — not in the domain, not in the
database, not in API payloads.

- Database column type is `BIGINT`, never `NUMERIC`, never `FLOAT`.
- API requests and responses carry `{ "amount": 1999, "currency": "EUR" }`.
  Never `19.99`, never `"19.99"`.
- A `Money` value object owns all arithmetic. It refuses to add two amounts of
  different currencies.
- Minor-unit exponent comes from the currency, not a hardcoded `100`. JPY has
  zero decimal places; this matters the moment a non-EUR market is added.

**Rounding is applied per line item, then the lines are summed.** The rounding
mode is half away from zero (commercial rounding), which is what EU VAT guidance
assumes.

Percentage calculations (commission rates, VAT) are performed with the rate as an
integer in basis points — `169` for 1.69% — so the multiplication stays in
integer space and only the final division rounds.

## Consequences

- A test exists that computes the same invoice under both orders (round-then-sum
  vs sum-then-round) and asserts they differ. It documents that the choice is
  real and that we made it deliberately.
- Every display of money in the UI must divide by the minor-unit exponent. This
  happens once, in a formatting helper backed by `@sumup-oss/intl`, never inline.
- Any third-party payload that carries decimal money is converted at the
  boundary, and the conversion is tested for values like `0.1` and `1e21`.
- `JSON.parse` cannot silently corrupt an amount, because amounts are integers
  well inside `Number.MAX_SAFE_INTEGER` for realistic values. Amounts are still
  validated against a JSON Schema with `type: "integer"`.

## Alternatives considered

**Decimal library (decimal.js, big.js).** Correct, but introduces a non-primitive
type that must be serialised at every boundary, and invites the habit of writing
`new Decimal("19.99")` — a decimal string in the code again. Integers make the
wrong thing hard to type.

**PostgreSQL `NUMERIC`.** Exact in the database, but the value becomes a string
in the JavaScript driver and the problem simply moves into application code.
