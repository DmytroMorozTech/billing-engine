/**
 * Errors as RFC 9457 Problem Details.
 *
 * A single shape for every failure, so a client never has to guess whether an
 * error arrives as `{error}`, `{message}` or a bare string. `type` is a stable
 * identifier a client can branch on; `detail` is prose for a human and may be
 * reworded without breaking anyone.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Extension members. RFC 9457 allows these and clients must ignore unknown ones. */
  [key: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Base URI for problem types. Not dereferenced, but stable and greppable. */
const TYPE_PREFIX = 'https://billing-engine.example/problems/';

export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly extensions: Record<string, unknown>;

  constructor(
    status: number,
    type: string,
    title: string,
    detail?: string,
    extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
    this.status = status;
    this.type = `${TYPE_PREFIX}${type}`;
    this.title = title;
    this.extensions = extensions;
  }

  toProblem(instance?: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.message && this.message !== this.title ? { detail: this.message } : {}),
      ...(instance ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export const problems = {
  notFound: (what: string, id: string) =>
    new ProblemError(404, 'not-found', 'Not found', `No ${what} with id ${id}`),

  validation: (detail: string, errors?: unknown) =>
    new ProblemError(400, 'validation-failed', 'Request is not valid', detail, {
      ...(errors === undefined ? {} : { errors }),
    }),

  missingIdempotencyKey: () =>
    new ProblemError(
      400,
      'idempotency-key-required',
      'Idempotency-Key header is required',
      'Every write endpoint requires an Idempotency-Key so a retry cannot charge twice.',
    ),

  /**
   * Deliberately 422 rather than 409. The key itself is not in conflict — it
   * was reused for a different payload, which is a client mistake, and saying
   * "conflict" invites a retry that will fail identically.
   */
  idempotencyKeyReused: (key: string) =>
    new ProblemError(
      422,
      'idempotency-key-reused',
      'Idempotency-Key was reused with a different request',
      `The key ${key} has already been used for a different request body or endpoint.`,
    ),

  idempotencyInFlight: (key: string) =>
    new ProblemError(
      409,
      'request-in-flight',
      'An identical request is still being processed',
      `The key ${key} was claimed by a request that has not finished. Retry shortly.`,
    ),

  noSuchPlan: (planId: string) =>
    new ProblemError(
      422,
      'no-such-plan',
      'No such plan',
      `The catalogue has no plan with id ${planId}.`,
    ),

  /** A change the timeline cannot accept — already on the plan, or before it began. */
  planChangeRejected: (detail: string) =>
    new ProblemError(422, 'plan-change-rejected', 'Plan change was rejected', detail),

  conflict: (title: string, detail: string) =>
    new ProblemError(409, 'conflict', title, detail),

  unprocessable: (title: string, detail: string) =>
    new ProblemError(422, 'unprocessable', title, detail),

  internal: () =>
    new ProblemError(
      500,
      'internal-error',
      'Something went wrong',
      'The failure has been logged. No detail is exposed here on purpose.',
    ),
} as const;
