# ADR-0011: Every route declares its responses

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

The routes declared what they accepted and said nothing about what they
returned. Two things needed that to change.

**OpenAPI.** The document is generated from the Fastify JSON Schemas so that it
cannot drift from the implementation — a document written alongside the code
describes the API someone remembered building, and the gap opens on the first
change nobody thought to write down. But a generator can only report what the
routes declare. With request bodies alone, the output would have listed nine
endpoints and, for every one of them, no stated result. That is not a
description a client can be written against.

**Serialisation.** Fastify does not merely validate a declared response, it
*serialises by it*. A route with no response schema returns whatever the handler
built, which is whatever the last `select` happened to include. Adding a column
for one purpose then publishes it for every purpose, silently, in a payload
nobody re-read.

## Decision

**Every route declares `response`, including error statuses, and path
parameters are validated as part of the same schema.**

```ts
{
  schema: {
    params: { $ref: 'MerchantParams#' },
    response: { 200: { $ref: 'MerchantDetail#' }, '4xx': { $ref: 'Problem#' } },
  },
}
```

Three things follow from that, and each is load-bearing.

**What is not declared is dropped.** This is the intended protection and it is
also the trap. Attaching a response schema to `GET /v1/invoices/:invoiceId`
emptied every `derivation` to `{}` — the recorded explanation of how each line
reached its amount, which is the single thing this project exists to show. The
response was still valid JSON with the right totals, and nothing failed. The
`derivation` is therefore declared as an open object:

```ts
derivation: {
  type: 'object',
  additionalProperties: true,   // load-bearing; see below
}
```

`additionalProperties: true` sends unknown members through `JSON.stringify`,
which preserves the nested tree. `false`, or simply omitting it, produces `{}`.

**The guard is tested, not assumed.** `apps/api/src/server.integration.test.ts`
walks the nested derivation rather than checking that the key exists, and the
test is mutation-checked: setting `additionalProperties: false` fails it. A test
that asserted only `expect(line.derivation).toBeDefined()` would have passed
against `{}` and been worse than no test, because it would have looked like
coverage.

**Ids are validated at the edge.** `merchants.id` and `invoices.id` are `UUID`
columns, so a request for `/v1/merchants/nobody` reached PostgreSQL as a type
error and came back as a 500 — our failure, reported for someone else's typo.
The shape of an id is knowable without a query, so `format: 'uuid'` on the
params schema turns it into a 400. This was a pre-existing bug on the routes
that already existed, found only because they were being given schemas.

## Consequences

- The OpenAPI document states a result for every operation. There is a test that
  fails if any operation gains a 2xx without a schema, so the property holds for
  routes added later rather than only for the ones present today.
- A field cannot leak into a response by being added to a `select`. It has to be
  declared, which is a decision someone makes rather than a side effect.
- Adding a field to a response now requires editing the schema as well as the
  handler. Forgetting means the field silently does not appear — the same
  failure mode as the derivation, pointed the other way. The mitigation is that
  responses are asserted in tests against real data, not against the handler's
  return value.
- Any future field carrying free-form recorded JSON — a payload, an audit
  snapshot — needs the same `additionalProperties: true` treatment, and needs a
  test that walks into it.

## Alternatives considered

**Declare responses only on the routes OpenAPI needs to document.** This is
every route, so it is not a smaller change; it only makes the rule harder to
state and easier to forget.

**Write the OpenAPI document by hand.** Rejected for the reason the whole
approach exists: a hand-written document is a second source of truth about the
same thing, and the two diverge. The first divergence is also the last one
anybody notices, because after that the document is known to be unreliable and
stops being read.

**Use `additionalProperties: true` everywhere, to avoid the truncation trap.**
That discards the protection this ADR is half about. The trap is real but it is
confined to fields that are genuinely open-ended, and there is exactly one of
those.

**Leave the 500 on a malformed id.** Defensible on the grounds that it is a
client error either way. Rejected because a 500 says the server is broken, gets
paged on, and tells the client to retry — three wrong signals for a typo.
