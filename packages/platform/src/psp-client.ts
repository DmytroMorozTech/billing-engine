/**
 * The payment provider, as the billing engine sees it.
 *
 * An interface for the same reason the outbox publisher is one: this is the
 * boundary with something we do not own, and the tests that matter are about
 * what our side does with the answer. `apps/psp` is the implementation behind
 * it in development; a real provider is a different implementation and no
 * change above this line.
 */
export interface ChargeRequest {
  /**
   * Derived from the invoice and the attempt number, never generated. That is
   * what makes a retried job safe: the provider recognises the repeat and
   * returns the original charge rather than taking the money again.
   */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  /** Which attempt of the dunning sequence this is. */
  attempt: number;
  /** Ours, for the provider's records: `invoice:<id>`. */
  reference: string;
}

export interface ChargeResult {
  id: string;
  status: 'succeeded' | 'failed';
  /** Present exactly when the charge failed. */
  declineCode?: string;
}

export interface PspClient {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

export class PspUnavailableError extends Error {
  constructor(detail: string) {
    super(`The payment provider could not be reached: ${detail}`);
    this.name = 'PspUnavailableError';
  }
}

export interface HttpPspClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * Talks to the provider over HTTP.
 *
 * A transport failure throws rather than being reported as a decline, and the
 * distinction is the whole point: a decline is an answer about the money and
 * ends the attempt, while an unreachable provider is an answer about us and
 * must be retried without counting against the merchant.
 */
export class HttpPspClient implements PspClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpPspClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    // Above the simulator's deliberately slow rule, so a five-second charge is
    // slow rather than lost.
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/v1/charges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new PspUnavailableError(error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      // 4xx here means we sent something the provider could not read, which is
      // our bug and not a decline. Loud, and not retried as if it were money.
      throw new PspUnavailableError(`responded ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as ChargeResult;
    if (body.status !== 'succeeded' && body.status !== 'failed') {
      throw new PspUnavailableError(`answered with an unknown status: ${String(body.status)}`);
    }

    return body;
  }
}
