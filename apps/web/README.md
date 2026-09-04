# Billing engine — web

The merchant portal. A Next.js App Router application that reads the billing
API and renders what a merchant was charged, and why.

## Running it

The API and its database have to be up first:

```bash
docker compose up -d          # from the repository root
npm run dev --workspace @billing/web
```

Then <http://localhost:3000>. The API is expected at `http://localhost:8081`;
override with `BILLING_API_URL`. There is no session yet, so the merchant is
chosen with `DEMO_MERCHANT_ID`.

## Layout

```
app/(merchant)/app/*   merchant-facing screens
components/            presentational components, each with its own spec
lib/api.ts             the only place this app talks to the billing API
lib/money.ts           minor units and dates, formatted for reading only
```

Pages are Server Components and fetch with `no-store`: billing data moves
underneath a page, and a cached one would show a state that has already gone.

## Checks

```bash
npm run lint            # Biome, then ESLint
npm run lint:css        # Stylelint
npm run test:ci         # Jest, including an accessibility check per component
npm run build
```

Accessibility is part of the definition of done for a screen, not a later
phase — every component spec runs `jest-axe`.

## Toolchain

This app keeps its own toolchain — Biome, Jest, Stylelint — separate from the
backend's ESLint and Vitest, because it was scaffolded from the Circuit UI
template and adopting that toolchain wholesale was a deliberate decision. The
reasoning, and two Windows-only faults that had to be fixed before it worked on
a fresh clone, are in
[ADR-0008](../../docs/adr/0008-frontend-stack.md).
