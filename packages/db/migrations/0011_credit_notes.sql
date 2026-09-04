-- Credit notes: the document that gives money back after a backdated change.

-- Numbering is per document kind. A credit note in the middle of the invoice
-- series would leave that series with a number that is not an invoice, and
-- "gapless" is a claim about a series of invoices. Both remain gapless; they
-- are simply two series.
ALTER TABLE invoice_sequences
  ADD COLUMN series TEXT NOT NULL DEFAULT 'invoice'
    CHECK (series IN ('invoice', 'credit_note'));

ALTER TABLE invoice_sequences DROP CONSTRAINT invoice_sequences_pkey;
ALTER TABLE invoice_sequences ADD PRIMARY KEY (legal_entity_id, series, year);

-- A separate table rather than a flag on invoices. An invoice is something to
-- collect — dunning selects on it, one may exist per subscription period, it
-- can be paid or written off. None of that is true of a credit note, and
-- teaching every one of those queries to exclude a second document kind is a
-- larger and more error-prone change than a table of its own.
CREATE TABLE credit_notes (
  id              UUID PRIMARY KEY,
  merchant_id     UUID NOT NULL REFERENCES merchants (id),

  -- The invoice being corrected. Not unique: a period can be corrected more
  -- than once, and each correction is measured against what is still charged
  -- after the previous ones.
  invoice_id      UUID NOT NULL REFERENCES invoices (id),
  legal_entity_id TEXT NOT NULL REFERENCES legal_entities (id),

  -- NOT NULL, unlike an invoice number. An invoice is drafted first and
  -- numbered when it is issued, because a discarded draft must not burn a
  -- number. A credit note is computed and issued in one step, so there is no
  -- state in which it exists without one.
  number          TEXT NOT NULL,

  currency        CHAR(3) NOT NULL REFERENCES currencies (code),

  -- Negative. A credit note reduces what is owed, so a merchant's documents
  -- sum to their balance without special cases.
  subtotal_minor  BIGINT NOT NULL CHECK (subtotal_minor <= 0),
  vat_minor       BIGINT NOT NULL CHECK (vat_minor <= 0),
  total_minor     BIGINT NOT NULL CHECK (total_minor < 0),

  vat_treatment   TEXT NOT NULL
                  CHECK (vat_treatment IN ('standard', 'reverse_charge', 'outside_scope')),

  issued_on       DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (total_minor = subtotal_minor + vat_minor),
  -- Same rule as invoices: no VAT credited where no VAT was charged.
  CHECK (vat_treatment = 'standard' OR vat_minor = 0)
);

CREATE UNIQUE INDEX credit_notes_number_per_entity ON credit_notes (legal_entity_id, number);
CREATE INDEX credit_notes_invoice_idx ON credit_notes (invoice_id);
CREATE INDEX credit_notes_merchant_idx ON credit_notes (merchant_id, issued_on DESC);

CREATE TABLE credit_note_lines (
  id             UUID PRIMARY KEY,
  credit_note_id UUID NOT NULL REFERENCES credit_notes (id) ON DELETE CASCADE,
  position       INT  NOT NULL CHECK (position >= 0),

  kind           TEXT NOT NULL CHECK (kind IN ('proration_credit', 'adjustment')),
  description    TEXT NOT NULL,

  amount_minor   BIGINT  NOT NULL CHECK (amount_minor <= 0),
  currency       CHAR(3) NOT NULL REFERENCES currencies (code),
  vat_rate_bps   INT     NOT NULL CHECK (vat_rate_bps BETWEEN 0 AND 10000),

  -- Same rule as an invoice line: an amount arrives with its explanation or it
  -- does not arrive. "Why did I get 2686 back" is the question this answers.
  derivation     JSONB NOT NULL,

  UNIQUE (credit_note_id, position)
);

CREATE INDEX credit_note_lines_note_idx ON credit_note_lines (credit_note_id, position);
