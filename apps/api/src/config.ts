/**
 * Everything the process needs from its environment, read once at boot.
 *
 * Read here and nowhere else: a `process.env` lookup buried in a handler is a
 * configuration error that only surfaces on the request that happens to reach
 * it. This fails at startup instead, where a deploy can still be rolled back.
 */
export interface ApiConfig {
  databaseUrl: string;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 8080;

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL is not set. The API cannot start without a database.');
  }

  return { databaseUrl, port: readPort(env.PORT) };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }

  const port = Number(raw);
  // `Number('')` is 0 and `Number(' 8080 ')` is 8080, so the string is checked
  // rather than trusted: `PORT=$PORT` with the variable unset is the usual way
  // rubbish gets this far.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`PORT must be a whole number between 1 and 65535, not "${raw}".`);
  }

  return port;
}
