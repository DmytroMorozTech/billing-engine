import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * The database as Kysely sees it.
 *
 * Hand-written rather than generated. The schema is small enough that the
 * generation step would cost more than it saves, and writing it by hand keeps
 * the type of every money column honest: `bigint` columns come back as strings
 * from node-postgres unless a parser is installed, and that is a detail worth
 * confronting in the type rather than discovering in production.
 */

/** A `TIMESTAMPTZ` the database defaults on insert. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** A `DATE`. Kept as an ISO `YYYY-MM-DD` string, never a JS Date. */
type IsoDate = string;

/**
 * `BIGINT` carrying money in minor units.
 *
 * node-postgres returns bigint as a string by default, because a 64-bit
 * integer does not always fit a double. Our amounts do fit — they are validated
 * as safe integers before they are ever written — so a type parser converts
 * them back to numbers on read. See `connection.ts`.
 */
type MinorUnits = ColumnType<number, number, number>;

export interface CurrenciesTable {
  code: string;
  minor_unit_exponent: number;
}

export interface MarketsTable {
  id: string;
  name: string;
  vat_rate_bps: number;
  currency: string;
  reverse_charge_available: Generated<boolean>;
}

export interface LegalEntitiesTable {
  id: string;
  name: string;
  market_id: string;
  vat_id: string;
  address_lines: string[];
  number_prefix: string;
}

export interface PlansTable {
  id: string;
  name: string;
  monthly_fee_minor: MinorUnits;
  currency: string;
  in_person_rate_bps: number;
  online_rate_bps: number;
  moto_rate_bps: number;
  moto_fixed_fee_minor: Generated<MinorUnits>;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface MerchantsTable {
  id: string;
  legal_entity_id: string;
  market_id: string;
  currency: string;
  email: string;
  name: string;
  billing_time_zone: string;
  vat_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface SubscriptionsTable {
  id: string;
  merchant_id: string;
  anchor_date: IsoDate;
  status: 'active' | 'past_due' | 'suspended' | 'cancelled';
  started_on: IsoDate;
  cancelled_on: IsoDate | null;
  created_at: Generated<Timestamp>;
}

export interface RateIntervalsTable {
  id: string;
  subscription_id: string;
  plan_id: string;
  monthly_fee_minor: MinorUnits;
  currency: string;
  in_person_rate_bps: number;
  online_rate_bps: number;
  moto_rate_bps: number;
  moto_fixed_fee_minor: Generated<MinorUnits>;
  effective_from: IsoDate;
  effective_to: IsoDate | null;
  recorded_at: Generated<Timestamp>;
  superseded_at: Timestamp | null;
  superseded_by: string | null;
}

export interface TransactionsTable {
  id: string;
  merchant_id: string;
  gross_minor: MinorUnits;
  currency: string;
  channel: 'in_person' | 'online' | 'moto';
  occurred_at: Timestamp;
  occurred_on: IsoDate;
  recorded_at: Generated<Timestamp>;
  invoiced_by: string | null;
}

export interface InvoiceSequencesTable {
  legal_entity_id: string;
  year: number;
  next_value: Generated<number>;
}

export interface InvoicesTable {
  id: string;
  merchant_id: string;
  subscription_id: string;
  legal_entity_id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  period_start: IsoDate;
  period_end: IsoDate;
  currency: string;
  subtotal_minor: MinorUnits;
  vat_minor: MinorUnits;
  total_minor: MinorUnits;
  issued_on: IsoDate | null;
  due_on: IsoDate | null;
  created_at: Generated<Timestamp>;
}

export interface InvoiceLinesTable {
  id: string;
  invoice_id: string;
  position: number;
  kind: 'subscription' | 'commission' | 'proration_credit' | 'adjustment';
  description: string;
  amount_minor: MinorUnits;
  currency: string;
  vat_rate_bps: number;
  /** The recorded explanation. Never recomputed on read. */
  derivation: ColumnType<unknown, string, string>;
}

export interface LedgerAccountsTable {
  key: string;
  kind: 'asset' | 'liability' | 'revenue' | 'expense';
  merchant_id: string | null;
  currency: string;
  created_at: Generated<Timestamp>;
}

export interface LedgerTransfersTable {
  id: string;
  kind: string;
  occurred_at: Timestamp;
  reference_type: string | null;
  reference_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  transfer_id: string;
  account_key: string;
  amount_minor: MinorUnits;
  currency: string;
  created_at: Generated<Timestamp>;
}

export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  applied_at: Generated<Timestamp>;
}

export interface Database {
  currencies: CurrenciesTable;
  markets: MarketsTable;
  legal_entities: LegalEntitiesTable;
  plans: PlansTable;
  merchants: MerchantsTable;
  subscriptions: SubscriptionsTable;
  rate_intervals: RateIntervalsTable;
  transactions: TransactionsTable;
  invoice_sequences: InvoiceSequencesTable;
  invoices: InvoicesTable;
  invoice_lines: InvoiceLinesTable;
  ledger_accounts: LedgerAccountsTable;
  ledger_transfers: LedgerTransfersTable;
  ledger_entries: LedgerEntriesTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Merchant = Selectable<MerchantsTable>;
export type NewMerchant = Insertable<MerchantsTable>;
export type MerchantUpdate = Updateable<MerchantsTable>;

export type RateInterval = Selectable<RateIntervalsTable>;
export type NewRateInterval = Insertable<RateIntervalsTable>;

export type Transaction = Selectable<TransactionsTable>;
export type NewTransaction = Insertable<TransactionsTable>;

export type Invoice = Selectable<InvoicesTable>;
export type NewInvoice = Insertable<InvoicesTable>;

export type InvoiceLine = Selectable<InvoiceLinesTable>;
export type NewInvoiceLine = Insertable<InvoiceLinesTable>;

export type LedgerEntry = Selectable<LedgerEntriesTable>;
export type NewLedgerEntry = Insertable<LedgerEntriesTable>;
