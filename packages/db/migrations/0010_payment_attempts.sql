-- Every attempt to collect an invoice, kept whether it worked or not.
--
-- The failures are the point. "Why is this merchant suspended" is answered by
-- the row that says the card expired on the third try, and a table that only
-- recorded successes could not answer it at all.
CREATE TABLE payment_attempts (
  id            UUID PRIMARY KEY,
  invoice_id    UUID NOT NULL REFERENCES invoices (id),

  -- Which attempt of the dunning sequence this was. Not a count kept
  -- elsewhere: it is part of the identity of the attempt, and of the
  -- idempotency key sent to the provider.
  attempt       INT  NOT NULL CHECK (attempt >= 1),

  status        TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),

  -- Present exactly when the attempt failed. The reason a retry might or might
  -- not help: insufficient_funds may clear by Friday, card_expired will not.
  decline_code  TEXT,

  -- What the provider called it. The reference an on-call engineer takes into
  -- the provider's own dashboard.
  psp_charge_id TEXT NOT NULL,

  amount_minor  BIGINT  NOT NULL CHECK (amount_minor > 0),
  currency      CHAR(3) NOT NULL REFERENCES currencies (code),

  attempted_at  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK ((status = 'failed') = (decline_code IS NOT NULL)),

  -- The natural idempotency of a retried job. A queue that delivers the same
  -- attempt twice cannot record it twice, and since the provider derives its
  -- charge from the same key, it cannot collect twice either.
  UNIQUE (invoice_id, attempt)
);

CREATE INDEX payment_attempts_invoice_idx ON payment_attempts (invoice_id, attempt);
