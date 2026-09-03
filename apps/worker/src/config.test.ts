import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const env = {
  DATABASE_URL: 'postgres://billing@postgres:5432/billing',
  REDIS_URL: 'redis://redis:6379',
  PSP_URL: 'http://psp:8082',
};

describe('loadConfig', () => {
  it('reads both connections and defaults the pacing', () => {
    expect(loadConfig(env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      redisUrl: env.REDIS_URL,
      pspUrl: env.PSP_URL,
      batchSize: 100,
      pollIntervalMs: 1000,
    });
  });

  it('refuses to start without a database, and says which variable', () => {
    expect(() => loadConfig({ REDIS_URL: env.REDIS_URL, PSP_URL: env.PSP_URL })).toThrow(
      'DATABASE_URL',
    );
  });

  it('refuses to start without a provider to charge', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL }),
    ).toThrow('PSP_URL');
  });

  it('refuses to start without a transport to publish to', () => {
    // A relay with nowhere to publish is not degraded, it is pointless: it
    // would sit there while the backlog grows and report itself healthy.
    expect(() => loadConfig({ DATABASE_URL: env.DATABASE_URL, PSP_URL: env.PSP_URL })).toThrow(
      'REDIS_URL',
    );
  });

  it('takes the pacing from the environment when it is given', () => {
    expect(loadConfig({ ...env, OUTBOX_BATCH_SIZE: '25', OUTBOX_POLL_INTERVAL_MS: '250' })).toMatchObject({
      batchSize: 25,
      pollIntervalMs: 250,
    });
  });

  it('rejects pacing that is not a positive number', () => {
    expect(() => loadConfig({ ...env, OUTBOX_BATCH_SIZE: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, OUTBOX_POLL_INTERVAL_MS: 'soon' })).toThrow(ConfigError);
  });
});
