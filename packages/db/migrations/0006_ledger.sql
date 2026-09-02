-- Double-entry ledger. Balance is a query, never a column — see ADR-0003.

-- Named accounts rather than free text. The first typo in a string key creates
-- a ghost account that money quietly accumulates on, and nothing complains.
CREATE TABLE ledger_accounts (
  key         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue', 'expense')),
  merchant_id UUID REFERENCES merchants (id),
  currency    CHAR(3) NOT NULL REFERENCES currencies (code),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ledger_accounts (key, kind, currency) VALUES
  ('platform:revenue',     'revenue',   'EUR'),
  ('platform:vat_payable', 'liability', 'EUR'),
  ('platform:bank',        'asset',     'EUR');

-- One movement of money. Its entries must sum to zero.
CREATE TABLE ledger_transfers (
  id             UUID PRIMARY KEY,
  kind           TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  reference_type TEXT,
  reference_id   UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_transfers_reference_idx
  ON ledger_transfers (reference_type, reference_id);

CREATE TABLE ledger_entries (
  -- Monotonic, so "every entry up to N" is a meaningful watermark if a
  -- balance snapshot is ever needed. Gaps here are harmless, unlike in
  -- invoice numbering.
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  UUID    NOT NULL REFERENCES ledger_transfers (id),
  account_key  TEXT    NOT NULL REFERENCES ledger_accounts (key),
  amount_minor BIGINT  NOT NULL CHECK (amount_minor <> 0),
  currency     CHAR(3) NOT NULL REFERENCES currencies (code),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_key, currency);
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Append-only. A mistake is corrected by a reversing entry, which leaves both
-- the error and the correction visible — which is what a support engineer
-- needs to see. Silently editing history is how a ledger stops being evidence.
CREATE OR REPLACE FUNCTION ledger_entries_forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; correct a mistake with a reversing entry';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_forbid_mutation();

-- Every transfer balances, per currency.
--
-- DEFERRABLE INITIALLY DEFERRED because the entries of one transfer are
-- inserted as separate statements: the check must run at COMMIT, when the
-- transfer is complete, not after the first row. An unbalanced transfer
-- therefore cannot reach the database at all — not from the application, not
-- from a migration, not from someone with psql and good intentions.
CREATE OR REPLACE FUNCTION ledger_assert_transfer_balances() RETURNS TRIGGER AS $$
DECLARE
  offending RECORD;
BEGIN
  SELECT e.currency, SUM(e.amount_minor) AS total
    INTO offending
    FROM ledger_entries e
   WHERE e.transfer_id = NEW.transfer_id
   GROUP BY e.currency
  HAVING SUM(e.amount_minor) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'ledger transfer % does not balance in %: entries sum to %',
      NEW.transfer_id, offending.currency, offending.total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_transfer_balances();
