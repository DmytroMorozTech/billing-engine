import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://billing:billing@postgres:5432/billing';

/**
 * A process that starts with half its configuration is worse than one that
 * refuses to start: it fails later, under load, with an error that points
 * somewhere else entirely.
 */
describe('loadConfig', () => {
  it('reads the database URL and the port', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '3000' })).toEqual({
      databaseUrl: DATABASE_URL,
      port: 3000,
    });
  });

  it('defaults the port when none is given', () => {
    expect(loadConfig({ DATABASE_URL }).port).toBe(8080);
  });

  it('refuses to start without a database URL, and says which variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
  });

  it('refuses a port that is not a number', () => {
    // `PORT=$PORT` with the variable unset is the classic way this arrives.
    expect(() => loadConfig({ DATABASE_URL, PORT: '$PORT' })).toThrow(ConfigError);
  });

  it('refuses a port outside the range a socket can bind', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL, PORT: '0' })).toThrow(ConfigError);
  });
});
