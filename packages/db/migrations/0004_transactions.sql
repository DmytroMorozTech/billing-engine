-- Processed payment volume. This is what the commission is charged on.

CREATE TABLE transactions (
  id             UUID PRIMARY KEY,
  merchant_id    UUID NOT NULL REFERENCES merchants (id),

  gross_minor    BIGINT  NOT NULL CHECK (gross_minor > 0),
  currency       CHAR(3) NOT NULL REFERENCES currencies (code),
  channel        TEXT    NOT NULL CHECK (channel IN ('in_person', 'online', 'moto')),

  -- The instant the payment happened.
  occurred_at    TIMESTAMPTZ NOT NULL,

  -- The same instant as a calendar date in the merchant's billing time zone,
  -- computed once at ingest and then frozen forever.
  --
  -- Denormalised deliberately. Rating is by local date, but the time zone lives
  -- on the merchant, so a generated column cannot produce this — and joining
  -- merchants into every rating query would be both slower and more fragile.
  --
  -- Frozen rather than recomputed because a merchant who changes their billing
  -- time zone must not retroactively alter invoices that have already been
  -- issued. A new zone applies from the change onward. This is what keeps the
  -- "recomputing a closed period is byte-identical" invariant true.
  occurred_on    DATE NOT NULL,

  -- When we learned about it. Differs from occurred_at for late-reported
  -- transactions, and the gap is what the support timeline's two axes show.
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Set when the transaction has been billed, so a period cannot be charged
  -- twice and so re-running a closed period is a no-op.
  invoiced_by    UUID
);

-- The main rating query: everything for one merchant within a local date range.
CREATE INDEX transactions_rating_idx
  ON transactions (merchant_id, occurred_on)
  INCLUDE (gross_minor, channel);

CREATE INDEX transactions_uninvoiced_idx
  ON transactions (merchant_id, occurred_on)
  WHERE invoiced_by IS NULL;
