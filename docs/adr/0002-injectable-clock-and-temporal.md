# ADR-0002: Time is injected; dates use Temporal

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Billing is a system where **time is an input parameter**. To verify what an
invoice looks like after eleven monthly renewals, you would normally wait eleven
months. That makes the most valuable tests the ones nobody writes.

The domain also sits on top of several date traps that `Date` handles badly or
not at all:

- **The anniversary problem.** A subscription anchored on 31 January renews on
  28 February, and the one after that must fall on **31 March** — not 28 March.
  The anchor is the original date, not the last actual charge. Systems that carry
  the last charge forward let subscriptions drift earlier every February.
- **Time zones.** A merchant in Italy and one in the UK are in different calendar
  days at the same instant. The date printed on a tax invoice has legal meaning.
- **DST.** A "day" can be 23 or 25 hours long. Adding `24 * 60 * 60 * 1000`
  milliseconds is not the same as adding one calendar day.
- **Leap years.** A daily proration divides by 365 or 366, and a period may
  straddle 29 February.

`Date` is a timestamp with a time-zone-less API bolted on. It cannot express
"the 31st of a month, clamped" or "one calendar day later in Europe/Rome" without
manual arithmetic — which is exactly where these bugs live.

## Decision

**Two rules, both enforced by lint.**

**1. Time is injected as a dependency.**

```ts
interface Clock {
  now(): Temporal.ZonedDateTime;
}

class SystemClock implements Clock {        // production
  now() { return Temporal.Now.zonedDateTimeISO('UTC'); }
}

class VirtualClock implements Clock {       // tests and demo
  constructor(private current: Temporal.ZonedDateTime) {}
  now() { return this.current; }
  advance(d: Temporal.Duration) { this.current = this.current.add(d); }
  setTo(t: Temporal.ZonedDateTime) { this.current = t; }
}
```

`Temporal.Now` and `new Date()` appear **only in the composition root**. An
ESLint `no-restricted-globals` / `no-restricted-properties` rule forbids both
`Date` and `Temporal.Now` inside `packages/domain`.

**2. Date arithmetic uses the Temporal API.**

- `Temporal.PlainDate` for calendar dates with no time (invoice dates, period
  boundaries).
- `Temporal.ZonedDateTime` for instants that must be interpreted in a merchant's
  billing time zone.
- `Temporal.Duration` and `PlainDate.until()` for calendar-aware differences.
- The anniversary problem is handled by `PlainDate.add({ months: 1 })` with
  `overflow: 'constrain'`, while the **original anchor day-of-month is stored
  separately** and re-applied each cycle.

Every merchant carries a `billingTimeZone` (IANA identifier). Period boundaries
are computed in that zone, not in UTC and not in the server's zone.

**3. A controlled scheduler.** Knowing the time is not enough — the system has to
react to it. Fast-forwarding a month is a loop:

```
for each day in 30:
    advance the virtual clock by 1 day
    run every scheduled job whose run-at <= virtual now
    (renewals, billing runs, payment retries, suspensions)
```

In production the scheduler is BullMQ with real delays. In tests and demo mode it
is swapped for a deterministic driver. This substitution is designed in from the
start, because retrofitting it later means rewriting every job.

## Consequences

- Tests covering a year of billing run in milliseconds and are deterministic.
- Property-based tests (fast-check) can generate random timelines and assert
  invariants over them.
- Bugs are reproducible: "show me this merchant's state on 1 February".
- The demo has a "+1 month" button that produces a real invoice, a real failed
  payment, and a real dunning sequence on the spot, with no waiting and no seeded
  fixtures pretending time has passed.
- `temporal-polyfill` is a runtime dependency until Node ships Temporal natively.
  It is already a dependency of Circuit UI's Next.js template, so the frontend
  carries it regardless.
- Developers unfamiliar with Temporal pay a small learning cost. This is accepted:
  the alternative is hand-rolling the same logic incorrectly.

## Alternatives considered

**date-fns + date-fns-tz.** Familiar and well documented, but time zones and the
anniversary rule remain manual work — the exact work that produces the bugs this
project exists to demonstrate.

**Luxon.** Closer to Temporal's model, but it is a stand-in for an API that is now
reaching the platform. Choosing the standard over its predecessor is the easier
decision to defend.

**Precedent:** Stripe ships this capability as a product feature, Test Clocks
(`docs.stripe.com/billing/testing/test-clocks`).
