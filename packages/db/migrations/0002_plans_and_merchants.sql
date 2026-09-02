-- Plans and merchants.

-- A plan does not unlock features. It buys a commission rate — see ADR-0006.
-- The monthly fee and the rates travel together because changing one without
-- the other is never a valid business change.
CREATE TABLE plans (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,

  monthly_fee_minor    BIGINT  NOT NULL CHECK (monthly_fee_minor >= 0),
  currency             CHAR(3) NOT NULL REFERENCES currencies (code),

  -- Rates in basis points: 169 is 1.69%. Integers, so that applying a rate
  -- stays in integer arithmetic and only the final division rounds (ADR-0001).
  in_person_rate_bps   INT NOT NULL CHECK (in_person_rate_bps BETWEEN 0 AND 10000),
  online_rate_bps      INT NOT NULL CHECK (online_rate_bps BETWEEN 0 AND 10000),
  moto_rate_bps        INT NOT NULL CHECK (moto_rate_bps BETWEEN 0 AND 10000),
  -- MOTO is percentage plus a flat fee per transaction, which is why the
  -- rating engine cannot assume every channel is a pure percentage.
  moto_fixed_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (moto_fixed_fee_minor >= 0),

  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plans
  (id, name, monthly_fee_minor, currency,
   in_person_rate_bps, online_rate_bps, moto_rate_bps, moto_fixed_fee_minor)
VALUES
  ('standard',      'Standard',         0, 'EUR', 169, 250, 295, 25),
  ('payments_plus', 'Payments Plus', 1900, 'EUR',  99, 250, 295, 25);

CREATE TABLE merchants (
  id                UUID PRIMARY KEY,
  legal_entity_id   TEXT    NOT NULL REFERENCES legal_entities (id),
  market_id         CHAR(2) NOT NULL REFERENCES markets (id),
  currency          CHAR(3) NOT NULL REFERENCES currencies (code),

  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,

  -- IANA identifier. Period boundaries and the local date of every transaction
  -- are computed in this zone, not in UTC and not in the server's zone.
  --
  -- Not constrained here: a CHECK cannot contain the subquery against
  -- pg_timezone_names that would validate it, and the alternatives (a trigger,
  -- or a materialised copy of the tz database) cost more than they are worth.
  -- Validation happens at the application boundary instead.
  billing_time_zone TEXT NOT NULL,

  -- Present and valid means reverse charge applies for B2B in another market.
  vat_id            TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX merchants_legal_entity_idx ON merchants (legal_entity_id);
