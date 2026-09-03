-- Foundation: extensions and the reference data every other table depends on.

-- GiST indexes natively understand range overlap (&&) but not plain equality
-- for scalar types such as uuid. btree_gist adds the B-tree comparison
-- operators to GiST, which is what lets rate_intervals combine
-- `subscription_id WITH =` and `daterange(...) WITH &&` in one exclusion
-- constraint. Without it Postgres refuses the index outright.
-- Installed into public explicitly: integration tests each run in their own
-- schema with search_path = "<schema>,public", and the GiST operator classes
-- have to be findable from all of them.
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;

-- Currencies carry their own minor-unit exponent. Nothing in this system
-- hardcodes 100: JPY has no minor unit, and that difference has to survive the
-- first non-EUR market. See ADR-0001.
CREATE TABLE currencies (
  code                CHAR(3) PRIMARY KEY,
  minor_unit_exponent SMALLINT NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, minor_unit_exponent) VALUES
  ('EUR', 2),
  ('GBP', 2),
  ('USD', 2),
  ('JPY', 0);

-- A market is a regulatory jurisdiction, not a language. It decides the VAT
-- rate and, later, invoice layout requirements.
CREATE TABLE markets (
  id             CHAR(2) PRIMARY KEY,
  name           TEXT    NOT NULL,
  vat_rate_bps   INT     NOT NULL CHECK (vat_rate_bps BETWEEN 0 AND 10000),
  currency       CHAR(3) NOT NULL REFERENCES currencies (code),
  reverse_charge_available BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO markets (id, name, vat_rate_bps, currency) VALUES
  ('DE', 'Germany',        1900, 'EUR'),
  ('GB', 'United Kingdom', 2000, 'GBP'),
  ('IT', 'Italy',          2200, 'EUR');

-- The entity that issues invoices. Invoice numbering must be gapless per
-- legal entity — a requirement of German and Italian law, not a preference.
CREATE TABLE legal_entities (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  market_id      CHAR(2) NOT NULL REFERENCES markets (id),
  vat_id         TEXT NOT NULL,
  address_lines  TEXT[] NOT NULL,
  number_prefix  TEXT NOT NULL
);

INSERT INTO legal_entities (id, name, market_id, vat_id, address_lines, number_prefix) VALUES
  ('de-gmbh', 'Example Payments GmbH', 'DE', 'DE123456789',
   ARRAY['Beispielstrasse 1', '10115 Berlin', 'Germany'], 'DE');
