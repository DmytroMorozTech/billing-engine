-- Idempotency for write endpoints. See ADR-0004.
--
-- This row is written in the *same transaction* as the action it protects.
-- That is the whole point, and it is why the keys are not in Redis: two
-- systems cannot commit atomically, so a crash between them either charges a
-- merchant twice or never charges them at all.
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,

  -- Scope, so the same key used against a different endpoint is a client
  -- error rather than a silently replayed unrelated response.
  endpoint        TEXT NOT NULL,

  -- Hash of the request body. A repeat with the same key but a different
  -- payload is a mistake worth reporting, not a replay worth serving.
  request_hash    TEXT NOT NULL,

  -- The stored response, returned verbatim on replay. A client that retries
  -- because it never saw the first response needs the result, not a conflict.
  response_status INT   NOT NULL,
  response_body   JSONB NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention: client retries live in minutes, not months. A periodic job
-- deletes rows past the window; the index makes that cheap.
CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);
