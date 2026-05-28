import type { FastifyReply } from 'fastify';

export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail?: string;
  readonly extra: Record<string, unknown>;

  constructor(options: {
    status: number;
    title: string;
    detail?: string;
    type?: string;
    extra?: Record<string, unknown>;
  }) {
    super(options.detail ?? options.title);
    this.status = options.status;
    this.title = options.title;
    this.detail = options.detail;
    this.type = options.type ?? 'about:blank';
    this.extra = options.extra ?? {};
  }
}

export function problem(status: number, title: string, detail?: string, extra?: Record<string, unknown>): ProblemError {
  return new ProblemError({ status, title, detail, extra });
}

export function sendProblem(reply: FastifyReply, err: ProblemError): void {
  reply
    .code(err.status)
    .header('content-type', 'application/problem+json')
    .send({
      type: err.type,
      title: err.title,
      status: err.status,
      ...(err.detail ? { detail: err.detail } : {}),
      ...err.extra,
    });
}
