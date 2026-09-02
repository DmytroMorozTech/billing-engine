-- Invoices, their lines, and gapless numbering.

-- Deliberately NOT a Postgres SEQUENCE. Sequences are non-transactional: a
-- rolled-back transaction burns its number and leaves a gap. German and
-- Italian law require invoice numbering without gaps, so the counter has to be
-- an ordinary row, locked with SELECT ... FOR UPDATE inside the same
-- transaction that inserts the invoice. Slower under contention, and correct.
CREATE TABLE invoice_sequences (
  legal_entity_id TEXT     NOT NULL REFERENCES legal_entities (id),
  year            SMALLINT NOT NULL,
  next_value      BIGINT   NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  PRIMARY KEY (legal_entity_id, year)
);

CREATE TABLE invoices (
  id               UUID PRIMARY KEY,
  merchant_id      UUID NOT NULL REFERENCES merchants (id),
  subscription_id  UUID NOT NULL REFERENCES subscriptions (id),
  legal_entity_id  TEXT NOT NULL REFERENCES legal_entities (id),

  -- NULL while the invoice is a draft. Assigned at finalisation, from
  -- invoice_sequences, and never changed afterwards.
  number           TEXT,

  status           TEXT NOT NULL
                   CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),

  -- Half-open [start, end) in the merchant's billing time zone, so that
  -- consecutive periods tile without a transaction falling into both.
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,

  currency         CHAR(3) NOT NULL REFERENCES currencies (code),
  subtotal_minor   BIGINT  NOT NULL,
  vat_minor        BIGINT  NOT NULL,
  total_minor      BIGINT  NOT NULL,

  issued_on        DATE,
  due_on           DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (period_end > period_start),
  CHECK (total_minor = subtotal_minor + vat_minor),
  -- A number exists exactly when the invoice has left draft.
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((number IS NULL) = (issued_on IS NULL))
);

CREATE UNIQUE INDEX invoices_number_per_entity
  ON invoices (legal_entity_id, number)
  WHERE number IS NOT NULL;

-- One invoice per subscription per period. This is the natural idempotency of
-- a billing run: a retried run cannot produce a second invoice.
CREATE UNIQUE INDEX invoices_one_per_period
  ON invoices (subscription_id, period_start)
  WHERE status <> 'void';

CREATE INDEX invoices_merchant_idx ON invoices (merchant_id, period_start DESC);

CREATE TABLE invoice_lines (
  id            UUID PRIMARY KEY,
  invoice_id    UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  position      INT  NOT NULL CHECK (position >= 0),

  kind          TEXT NOT NULL
                CHECK (kind IN ('subscription', 'commission', 'proration_credit', 'adjustment')),
  description   TEXT NOT NULL,

  amount_minor  BIGINT  NOT NULL,
  currency      CHAR(3) NOT NULL REFERENCES currencies (code),
  vat_rate_bps  INT     NOT NULL CHECK (vat_rate_bps BETWEEN 0 AND 10000),

  -- How this number came to be: the events that fed it, the formula, the
  -- intermediate value, the rounding step.
  --
  -- NOT NULL on purpose. The moment an explanation becomes optional, lines
  -- appear without one, and the support screen starts going quiet exactly when
  -- someone needs it. Better that the calculation refuses to produce a line it
  -- cannot explain.
  --
  -- Written when the amount is computed and never recomputed on read: a later
  -- change to the calculation must not be able to make the explanation
  -- disagree with the invoice it explains.
  derivation    JSONB NOT NULL,

  UNIQUE (invoice_id, position)
);

CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, position);

ALTER TABLE transactions
  ADD CONSTRAINT transactions_invoiced_by_fkey
  FOREIGN KEY (invoiced_by) REFERENCES invoices (id);
