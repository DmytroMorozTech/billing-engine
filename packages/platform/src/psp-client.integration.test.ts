import { describe, expect, it } from 'vitest';

import { HttpPspClient, PspUnavailableError } from './psp-client.js';

const baseUrl = process.env.PSP_URL;
const describeIfPsp = baseUrl ? describe : describe.skip;

/**
 * The client against the running simulator.
 *
 * Worth doing over HTTP rather than against a stub: the things that go wrong at
 * this boundary are the JSON shape, the status codes and the timeout, and a
 * stub agrees with whatever this file assumes about all three.
 */
describeIfPsp('HttpPspClient', () => {
  const client = new HttpPspClient({ baseUrl: baseUrl as string });

  const charge = (amountMinor: number, attempt = 1) =>
    client.charge({
      idempotencyKey: `test-${amountMinor}-${attempt}-${Date.now()}`,
      amountMinor,
      currency: 'EUR',
      attempt,
      reference: 'invoice:test',
    });

  it('collects an ordinary amount', async () => {
    const result = await charge(14071);

    expect(result.status).toBe('succeeded');
    expect(result.id).toMatch(/^ch_/);
    expect(result.declineCode).toBeUndefined();
  });

  it('reports a decline as an answer, not a failure', async () => {
    const result = await charge(12301);

    expect(result).toMatchObject({ status: 'failed', declineCode: 'insufficient_funds' });
  });

  it('carries the attempt number through, so the sequence can recover', async () => {
    expect((await charge(12302, 2)).status).toBe('failed');
    expect((await charge(12302, 3)).status).toBe('succeeded');
  });

  it('returns the same charge for the same key', async () => {
    const request = {
      idempotencyKey: 'stable-key-for-this-test',
      amountMinor: 5000,
      currency: 'EUR',
      attempt: 1,
      reference: 'invoice:test',
    };

    expect((await client.charge(request)).id).toBe((await client.charge(request)).id);
  });

  it('raises rather than declining when the provider cannot be reached', async () => {
    // A transport failure says nothing about the money. Reporting it as a
    // decline would spend one of the merchant's attempts on our own outage.
    const unreachable = new HttpPspClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });

    await expect(
      unreachable.charge({
        idempotencyKey: 'nowhere',
        amountMinor: 100,
        currency: 'EUR',
        attempt: 1,
        reference: 'invoice:test',
      }),
    ).rejects.toThrow(PspUnavailableError);
  });

  it('raises when the provider rejects the request as malformed', async () => {
    await expect(
      client.charge({
        idempotencyKey: '',
        amountMinor: 100,
        currency: 'EUR',
        attempt: 1,
        reference: 'invoice:test',
      }),
    ).rejects.toThrow(PspUnavailableError);
  });

  it('waits out the deliberately slow amount', async () => {
    const started = Date.now();
    const result = await charge(12399);

    expect(result.status).toBe('succeeded');
    expect(Date.now() - started).toBeGreaterThan(4500);
  }, 20_000);
});
