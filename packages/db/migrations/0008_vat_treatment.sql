-- Why an invoice carries the VAT it carries.
--
-- A zero can arrive for two different reasons and they are not interchangeable:
-- reverse charge shifts the liability to an EU business under Article 196 and
-- must be stated as such on the document, while an out-of-scope supply never
-- entered the EU VAT system at all. Storing only the amount loses the
-- distinction, and it is the distinction an auditor asks about.
ALTER TABLE invoices
  ADD COLUMN vat_treatment TEXT NOT NULL DEFAULT 'standard'
    CHECK (vat_treatment IN ('standard', 'reverse_charge', 'outside_scope'));

-- The two cannot disagree. An invoice that says the liability moved elsewhere
-- and still charges VAT is charging tax it is not entitled to.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_no_vat_unless_standard
  CHECK (vat_treatment = 'standard' OR vat_minor = 0);

-- The United Kingdom left the EU, so the reverse-charge mechanism does not
-- reach it. The column was seeded with its default in 0001, before there was
-- anything to read it.
UPDATE markets SET reverse_charge_available = FALSE WHERE id = 'GB';
