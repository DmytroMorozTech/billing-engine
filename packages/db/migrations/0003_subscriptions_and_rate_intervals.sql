-- Subscriptions and the rate intervals that drive every calculation.

CREATE TABLE subscriptions (
  id            UUID PRIMARY KEY,
  merchant_id   UUID NOT NULL REFERENCES merchants (id),

  -- The original subscription date, and it never moves. The next billing date
  -- is always derived from this, never from the last actual charge — that is
  -- what stops a 31 January subscription drifting to the 28th after its first
  -- February. See ADR-0002. The day-of-month is not stored separately because
  -- it is simply EXTRACT(DAY FROM anchor_date).
  anchor_date   DATE NOT NULL,

  status        TEXT NOT NULL
                CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled')),
  started_on    DATE NOT NULL,
  cancelled_on  DATE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (cancelled_on IS NULL OR cancelled_on >= started_on),
  CHECK ((status = 'cancelled') = (cancelled_on IS NOT NULL))
);

-- A merchant has at most one live subscription. Cancelled ones accumulate.
CREATE UNIQUE INDEX subscriptions_one_live_per_merchant
  ON subscriptions (merchant_id)
  WHERE status <> 'cancelled';

-- The core table of the whole system.
--
-- A plan change does not mutate anything: it closes one interval and opens the
-- next. Every transaction is priced against the interval containing its local
-- date, so the rate in force when money moved is the rate that applies to it
-- (ADR-0006).
CREATE TABLE rate_intervals (
  id                   UUID PRIMARY KEY,
  subscription_id      UUID NOT NULL REFERENCES subscriptions (id),
  plan_id              TEXT NOT NULL REFERENCES plans (id),

  -- Terms are copied in, not joined to. Editing the plan catalogue must never
  -- silently reprice a period that has already been invoiced.
  monthly_fee_minor    BIGINT  NOT NULL CHECK (monthly_fee_minor >= 0),
  currency             CHAR(3) NOT NULL REFERENCES currencies (code),
  in_person_rate_bps   INT NOT NULL CHECK (in_person_rate_bps BETWEEN 0 AND 10000),
  online_rate_bps      INT NOT NULL CHECK (online_rate_bps BETWEEN 0 AND 10000),
  moto_rate_bps        INT NOT NULL CHECK (moto_rate_bps BETWEEN 0 AND 10000),
  moto_fixed_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (moto_fixed_fee_minor >= 0),

  -- Valid time: when this was true in the world, as dates in the merchant's
  -- billing time zone. NULL effective_to means still open.
  effective_from       DATE NOT NULL,
  effective_to         DATE,

  -- Transaction time: when we learned it, and when that belief was replaced.
  -- A merchant who cancels on the 5th and tells us on the 12th produces a row
  -- with effective_from = the 5th and recorded_at = the 12th. Corrections
  -- supersede rather than overwrite, so the timeline can be replayed as it was
  -- known at any past moment.
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at        TIMESTAMPTZ,

  -- Deferred, because a correction is inherently two statements that are only
  -- valid together: mark the old interval superseded by an id, then insert the
  -- row carrying that id. Either order breaks an immediate constraint — insert
  -- first and the new row overlaps a still-current one; update first and the
  -- foreign key points at a row that does not exist yet. Checking at COMMIT
  -- lets the pair be atomic without weakening the guarantee.
  superseded_by        UUID REFERENCES rate_intervals (id)
                       DEFERRABLE INITIALLY DEFERRED,

  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((superseded_at IS NULL) = (superseded_by IS NULL)),

  -- Two rates can never be in force at the same time for one subscription.
  -- Enforced among current knowledge only: superseded rows are history and may
  -- legitimately contradict each other and the present.
  --
  -- This is the constraint btree_gist exists for. Without it, overlapping
  -- intervals would let a single transaction be priced twice, and that is not
  -- a bug anyone wants to find from a reconciliation report.
  EXCLUDE USING gist (
    subscription_id WITH =,
    daterange(effective_from, effective_to) WITH &&
  ) WHERE (superseded_at IS NULL)
);

CREATE INDEX rate_intervals_current_idx
  ON rate_intervals (subscription_id, effective_from)
  WHERE superseded_at IS NULL;
