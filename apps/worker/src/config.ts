/**
 * Everything the worker needs from its environment, read once at boot.
 *
 * Both connections are required. A relay that starts without a transport is not
 * running in a degraded mode — it is doing nothing while the backlog grows, and
 * reporting itself healthy the whole time.
 */
export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  /** The payment provider. Required: a consumer with nowhere to charge is idle. */
  pspUrl: string;
  /** Events taken per pass. Bounds the transaction held across a publish. */
  batchSize: number;
  pollIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL', 'the outbox lives in PostgreSQL'),
    redisUrl: required(env.REDIS_URL, 'REDIS_URL', 'there is nowhere to publish without it'),
    pspUrl: required(env.PSP_URL, 'PSP_URL', 'invoices cannot be collected without a provider'),
    batchSize: positive(env.OUTBOX_BATCH_SIZE, 'OUTBOX_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    pollIntervalMs: positive(
      env.OUTBOX_POLL_INTERVAL_MS,
      'OUTBOX_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
    ),
  };
}

/**
 * What the demo seed needs, which is less than the worker does.
 *
 * It publishes nothing and consumes nothing, so it has no business demanding a
 * queue to start. Asking for configuration a process does not use is how an
 * unrelated outage becomes "the seed is broken".
 */
export interface SeedConfig {
  databaseUrl: string;
  pspUrl: string;
}

export function loadSeedConfig(env: NodeJS.ProcessEnv): SeedConfig {
  return {
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL', 'there is nothing to seed without it'),
    pspUrl: required(env.PSP_URL, 'PSP_URL', 'the demo collects payments as it seeds'),
  };
}

function required(value: string | undefined, name: string, why: string): string {
  if (!value) {
    throw new ConfigError(`${name} is not set. The worker cannot start: ${why}.`);
  }
  return value;
}

function positive(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a whole number above zero, not "${raw}".`);
  }
  return parsed;
}
