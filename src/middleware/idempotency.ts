import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SandboxdConfig } from '../config.js';
import type { SandboxDatabase } from '../db.js';
import { futureIso, nowIso } from '../db.js';
import { canonicalJson } from '../util/canonical-json.js';
import type { RoutePolicy } from '../policy/route-policy.js';
import { problem } from '../problem.js';

interface IdempotencyRow {
  id: number;
  request_fingerprint: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
}

function routePolicy(request: FastifyRequest): RoutePolicy | undefined {
  return (request.routeOptions.config as { policy?: RoutePolicy } | undefined)?.policy;
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function validateKey(key: string): boolean {
  return /^[A-Za-z0-9._:-]{8,200}$/.test(key);
}

function fingerprint(request: FastifyRequest): string {
  const body = request.body === undefined ? null : request.body;
  return createHash('sha256').update(canonicalJson({ method: request.method, url: request.url, body })).digest('hex');
}

function actorScope(request: FastifyRequest): string {
  if (!request.auth) return `anonymous:${request.ip}`;
  return `${request.auth.clientName}:${request.auth.clientId}`;
}

export function registerIdempotencyMiddleware(app: FastifyInstance, db: SandboxDatabase, config: SandboxdConfig): void {
  app.addHook('preHandler', async (request, reply) => {
    const rp = routePolicy(request);
    if (!rp?.idempotencyRequired) return;

    const key = idempotencyKey(request);
    if (!key) throw problem(428, 'Precondition Required', 'Idempotency-Key is required for this route.', { code: 'missing_idempotency_key' });
    if (!validateKey(key)) {
      throw problem(400, 'Invalid Idempotency-Key', "Idempotency-Key must be 8-200 characters using letters, numbers, '.', '_', ':', or '-'.", { code: 'invalid_idempotency_key' });
    }

    const scope = actorScope(request);
    const fp = fingerprint(request);
    const existing = db.raw.prepare('SELECT id, request_fingerprint, status, response_status, response_body FROM idempotency_keys WHERE scope = ? AND key = ? AND expires_at > ?')
      .get(scope, key, nowIso()) as IdempotencyRow | undefined;

    if (existing) {
      if (existing.request_fingerprint !== fp) {
        throw problem(409, 'Idempotency-Key conflict', 'Idempotency-Key was already used for a different request.', { code: 'idempotency_key_conflict' });
      }

      if (existing.status === 'completed' && existing.response_status !== null && existing.response_body !== null) {
        reply.header('Idempotency-Replayed', 'true');
        reply.status(existing.response_status).type('application/json').send(JSON.parse(existing.response_body) as unknown);
        return;
      }

      throw problem(409, 'Idempotency-Key in progress', 'A request with this Idempotency-Key is already in progress.', { code: 'idempotency_key_in_progress' });
    }

    const result = db.raw.prepare(`
      INSERT INTO idempotency_keys(scope, key, method, route, actor, request_fingerprint, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      scope,
      key,
      request.method,
      request.url,
      request.auth?.actor ?? 'anonymous',
      fp,
      nowIso(),
      futureIso(config.auth.idempotencyTtlSeconds),
    );

    request.idempotency = { recordId: Number(result.lastInsertRowid), reserved: true };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.idempotency?.reserved) return payload;
    const responseBody = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    db.raw.prepare(`
      UPDATE idempotency_keys
      SET status = 'completed', response_status = ?, response_body = ?
      WHERE id = ?
    `).run(reply.statusCode, responseBody, request.idempotency.recordId);
    return payload;
  });
}
