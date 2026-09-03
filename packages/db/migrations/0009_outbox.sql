-- Transactional outbox. See ADR-0005.
--
-- The event is written in the same transaction as the change it describes, so
-- it cannot be lost when the process dies before publishing, and cannot escape
-- when the transaction rolls back. Publishing after COMMIT instead fails in
-- both directions, and it fails silently.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,

  -- What the event is about: an invoice id, a subscription id. Kept as text
  -- rather than a foreign key, because an event outlives the row it describes
  -- and a published fact must not be deletable by a cascade.
  aggregate    TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

-- The relay asks one question over and over: what is unpublished, oldest first.
-- A partial index answers it without carrying the rows already dealt with,
-- which is nearly all of them.
CREATE INDEX outbox_unpublished_idx
  ON outbox (id)
  WHERE published_at IS NULL;
