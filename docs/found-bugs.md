# Bugs found, and the tests that catch them

The roadmap asks for one deliberately found and fixed bug, written up with the
test that catches it. There are six. This document leads with the strongest and
then lists the rest, because the pattern across them turned out to be more
interesting than any one of them.

**The pattern:** four of the six produced *valid, successful output*. Nothing
threw, no status was 500, no schema was violated. Each was caught by a test that
asserted on the content of the answer rather than on its shape, and each would
have survived a test that asserted only shape.

Two of them came close to slipping through anyway, in different ways. The
OpenAPI document (#3) was passed by three of the four tests written for it,
including one that was vacuously true against an empty document. The emptied
derivation (#2) was caught by a test that *passed on its first run* — which
proves nothing on its own, and was only known to work after being deliberately
broken.

---

## 1. A zero-amount ledger posting, found by a property test

**The strongest of the six**, because a generator found it, the fix was a design
decision rather than a patch, and the reasoning is written down in
[ADR-0003](adr/0003-balance-derived-from-ledger.md).

### The failure

`packages/db/src/repositories/ledger.property.integration.test.ts` asserts that
the ledger always sums to zero, whatever sequence of operations ran. It failed
about half the time.

The generator was producing an invoice with zero VAT, and `ledger_entries`
forbids a posting of zero — `ZeroPostingError`, raised in `ledger.ts` and backed
by a `CHECK` constraint. The invoice was legitimate and the ledger refused it.

### Why it was not a flaky test

The obvious reading was a bad generator: constrain it to produce non-zero VAT
and the failure goes away. That reading was wrong, and this is the part worth
keeping. **Reverse charge produces exactly that case in production.** A B2B
customer in another EU member state with a valid VAT ID is invoiced at zero VAT
by law. So does an out-of-scope supply to the UK. Two of the three VAT
treatments this system implements generate a zero-VAT invoice as their normal,
correct output.

The property test had not produced an unrealistic input. It had produced the
Italian merchant from the demo seed, before anyone had written the Italian
merchant.

### The fix

Not to relax the constraint. A posting of zero is either meaningless or a bug —
a proration that rounded away, a commission line whose rate never loaded — and
written as a zero row that is indistinguishable from a line which is
legitimately nothing.

So lines that are legitimately zero are not *dropped*, they are not *built*.
`invoicePostings` is the single place that decides it, and a reverse-charge
invoice simply has two postings rather than three. Relaxing the constraint would
have bought that one case at the price of the check on every other — and the
entries are append-only, so zero rows written today could never be removed.

### The test

```
packages/db/src/repositories/ledger.property.integration.test.ts
  it('always sums to zero, whatever sequence of operations ran')
  it('rejects a posting of zero and names the account it came from')
```

Fixed in `2f21769`.

---

## 2. Every derivation emptied to `{}` by its own response schema

The most vivid of the six, and the one that best justifies the work it came out
of. See [ADR-0011](adr/0011-response-schemas-on-every-route.md).

### The failure

Giving `GET /v1/invoices/:invoiceId` a response schema — so that OpenAPI could
document what it returns, and so that Fastify would stop publishing whatever the
`select` happened to include — replaced every `derivation` with `{}`.

The `derivation` is the recorded explanation of how a line reached its amount:
the formula, the inputs, the exact value before rounding, nested one level per
sub-computation. It is the data behind "why this amount", which is the screen
this whole project is built around.

Fastify serialises by response schema and drops what the schema does not
mention. The derivation is free-form recorded JSON, so it mentioned nothing.

### Why it would have survived review

Everything downstream looked correct:

- HTTP 200
- valid JSON
- every total, subtotal and VAT figure exactly right
- every line present, with its description and amount
- the `derivation` key present on every line

Only its *contents* were gone. A test written as
`expect(line.derivation).toBeDefined()` passes against `{}`. So does a snapshot
taken after the change. The failure is invisible until someone opens the support
console and finds an explanation with nothing in it — by which point the cause
is many commits away.

### The fix

```ts
derivation: {
  type: 'object',
  // Load-bearing. With this false, or simply absent, the serialiser emits
  // `{}` for every derivation and "why this amount" stops being answerable.
  additionalProperties: true,
}
```

### The test, and the mutation check

```
apps/api/src/server.integration.test.ts:457
  it('carries the recorded derivation through the response serialiser intact')
```

It walks into the nested tree rather than checking the key exists:

```ts
expect(body.lines[0]?.derivation).toMatchObject({
  formula: 'monthly fee × days in segment ÷ days in period',
  inputs: [
    { kind: 'value', label: 'Monthly fee', value: { amount: 1900, currency: 'EUR' } },
    { kind: 'value', label: 'Days in segment', value: 30 },
    { kind: 'value', label: 'Days in period', value: 30 },
    { kind: 'value', label: 'Period', value: '2026-09-01 to 2026-10-01' },
  ],
});
```

**Mutation-checked.** Setting `additionalProperties: false` and rerunning fails
it, so the test is testing the flag rather than the happy path. This mattered
here more than usual: the test was written before the fix but *passed on its
first run*, because the schema already happened to carry the flag. A test that
passes immediately has proved nothing, so it was deliberately broken to confirm
it could fail.

---

## 3. An OpenAPI document with no paths, served with a 200

The same species as #2, found the same day, in the code that documents the fix
for #2.

### The failure

`@fastify/swagger` collects routes through an `onRoute` hook. `app.register()`
is lazy — it queues the plugin and returns, and the plugin loads during
`app.ready()`. The routes were declared synchronously immediately after the
`register()` call, which means they were declared *before* the hook existed. The
plugin never saw them.

`GET /openapi.json` returned:

```json
{ "openapi": "3.1.0", "info": { "title": "Billing engine", ... }, "paths": {} }
```

200. Valid OpenAPI 3.1.0. Correct title, correct version, correct component
schemas. Zero endpoints.

### Why it is worse than a failure

An API with no documentation is a known quantity. An API with a document that
loads, validates, and describes nothing is worse, because every tool downstream
reports success: the spec fetches, a validator passes it, a client generator
runs and emits a client with no methods.

The test that caught it is the one that asserts the *list* of documented paths.
The three weaker tests written beside it all passed against the empty document —
including, embarrassingly, the one asserting that every operation states a
response schema, which is vacuously true when there are no operations.

### The fix

`buildServer` became async and awaits both plugin registrations before the first
route is declared:

```ts
export async function buildServer(deps: ApiDependencies): Promise<FastifyInstance> {
  await app.register(swagger, { /* ... */ });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  // routes from here on are seen by the onRoute hook
```

### The test

```
apps/api/src/server.integration.test.ts:709
  it('documents every versioned route')
```

It compares the full sorted list of paths against the expected nine, so it fails
both when the document is empty and when a route is added without being
documented.

---

## 4. A non-portable lockfile

`npm install` on Windows writes a lockfile that omits optional dependencies for
other platforms. `npm ci` on Linux then refuses to install from it. Measured
rather than inferred: 1170 packages and twelve `@parcel/watcher` binaries before,
1120 and zero after.

Found by CI, which is the point — `npm ci` failing loudly on a lockfile that
does not describe the tree is the backstop, and it must not be softened to
`npm install` to make a red build go away.

Written up in full, with the repair path, in
[ADR-0010](adr/0010-lockfile-generation.md). Cost `ba2441c` and `20da9f2`.

---

## 5. A test suite that could not skip itself

`describe.skip` still evaluates its body in order to collect the tests inside it.
Anything constructed at describe level therefore runs even when the suite is
skipped — so a suite that built its HTTP client at describe level threw when the
service it needed was absent, instead of skipping.

It passed locally, where the services are up, and failed only in CI's bare run.
Fixed by constructing clients in `beforeAll`. `2cca82f`.

The general lesson is in how the tests are now run: **every change is verified
both with all three service variables set and with none of them**, because those
are two different code paths and only one of them is CI's.

---

## 6. Double crediting on a second correction, and a 500 on a malformed id

Two smaller ones.

**Double crediting** was caught by writing the test before the code. Correcting
an invoice twice measured the recomputed period against the invoice's *original*
total, which hands back money the first credit note already returned. A support
engineer who fixes a date and then fixes it again is the ordinary case, not a
corner one. `netCharged` exists because of this test.

**The 500** is described in [ADR-0011](adr/0011-response-schemas-on-every-route.md):
`merchants.id` is a `UUID` column, so `/v1/merchants/nobody` reached PostgreSQL
as a type error and returned a 500 — which pages an operator and tells the client
to retry, both wrong for a typo. Path ids are now validated at the edge.

---

## What the six have in common

Two of them (#4, #5) were ordinary loud failures, found by CI doing its job.

The other four were quiet. #1 returned a correct refusal for a correct invoice.
#2 returned a valid, complete-looking invoice. #3 returned a valid, complete-
looking API document. #6 returned a plausible total. In each case the shape of
the answer was right and the content was wrong.

The tests that catch them share one property: **they assert on values, not on
structure.** `toBeDefined()`, `toHaveProperty()` and shape-only snapshots would
have passed against all four. That is why the derivation test walks into the
tree, why the OpenAPI test compares the whole path list, and why the ledger test
is a property over generated sequences rather than an example.
