import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import YAML from 'yaml';
import { type SandboxdConfig } from './config.js';
import { type JobRecord, SandboxDatabase } from './db.js';
import { createJobId, isJobId } from './ids.js';
import { writeJobManifests } from './manifest.js';
import { createJobPaths } from './paths.js';
import { problem, ProblemError, sendProblem } from './problem.js';
import { runPipeline } from './pipeline.js';
import { nowIso } from './time.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { registerIdempotencyMiddleware } from './middleware/idempotency.js';
import { issueAccessToken, revokeAccessToken } from './auth/service-tokens.js';
import { normalizeScopes } from './auth/scopes.js';
import { policy } from './policy/route-policy.js';

function publicJob(job: JobRecord): Record<string, unknown> {
  return {
    jobId: job.job_id,
    caller: job.caller,
    profile: job.profile,
    status: job.status,
    network: job.network,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
    workspacePath: job.workspace_path,
    artifactPath: job.artifact_path,
    metadata: JSON.parse(job.metadata_json),
  };
}

function requireJob(db: SandboxDatabase, jobId: string): JobRecord {
  if (!isJobId(jobId)) throw problem(400, 'Invalid job id', 'jobId must use sandboxd_<uuidv7> format.');
  const job = db.getJob(jobId);
  if (!job) throw problem(404, 'Job not found', `No job exists with id '${jobId}'.`);
  return job;
}

interface TokenRequestBody {
  requestedScopes?: unknown;
  requested_scopes?: unknown;
  requestedPrefixes?: unknown;
  requested_prefixes?: unknown;
  ttlSeconds?: number;
  ttl_seconds?: number;
}

function requestedScopes(body: TokenRequestBody): string[] {
  return normalizeScopes(body.requestedScopes ?? body.requested_scopes ?? []);
}

function requestedPrefixes(body: TokenRequestBody): string[] {
  const value = body.requestedPrefixes ?? body.requested_prefixes ?? [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function requestedTtl(body: TokenRequestBody, fallback: number): number {
  const value = body.ttlSeconds ?? body.ttl_seconds;
  return Number.isFinite(value) ? Number(value) : fallback;
}

function authHeaderToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  return /^Bearer\s+(.+)$/i.exec(value)?.[1]?.trim() ?? null;
}

export function buildServer(config: SandboxdConfig, db: SandboxDatabase): FastifyInstance {
  const app = Fastify({ logger: true, trustProxy: config.server.trustProxy });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ProblemError) {
      sendProblem(reply, err);
      return;
    }
    requestLoggerError(app, err);
    sendProblem(reply, new ProblemError({ status: 500, title: 'Internal Server Error', detail: 'The request failed unexpectedly.' }));
  });

  registerAuthMiddleware(app, db, config);
  registerIdempotencyMiddleware(app, db, config);

  app.get('/healthz', { config: policy({ exposure: 'public' }) }, async () => ({ ok: true, service: 'seasonal-sandboxd' }));

  app.get('/readyz', { config: policy({ exposure: 'public' }) }, async () => {
    const dbReady = db.ready();
    const workspaceReady = fs.existsSync(config.storage.workspaceRoot);
    const artifactReady = fs.existsSync(config.storage.artifactRoot);
    if (!dbReady || !workspaceReady || !artifactReady) {
      throw problem(503, 'Service Unavailable', 'Database or storage path is not ready.', { dbReady, workspaceReady, artifactReady });
    }
    return { ok: true, dbReady, workspaceReady, artifactReady };
  });

  app.get('/openapi.json', { config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:status:read'] }) }, async () => {
    const openapiPath = path.resolve('openapi/openapi.yaml');
    const parsed = YAML.parse(fs.readFileSync(openapiPath, 'utf8')) as unknown;
    return parsed;
  });

  app.post('/v1/auth/token', {
    config: policy({ exposure: 'auth', authRequired: true, authMode: 'client-credential' }),
  }, async (request, reply) => {
    const body = (request.body ?? {}) as TokenRequestBody;
    try {
      const issued = issueAccessToken(db, {
        client: request.auth!,
        requestedScopes: requestedScopes(body),
        requestedPrefixes: requestedPrefixes(body),
        ttlSeconds: requestedTtl(body, config.auth.defaultAccessTokenTtlSeconds),
        maxTtlSeconds: config.auth.maxAccessTokenTtlSeconds,
        sourceIp: request.ip,
        userAgent: Array.isArray(request.headers['user-agent']) ? request.headers['user-agent'].join(' ') : request.headers['user-agent'],
      });

      return {
        accessToken: issued.rawToken,
        tokenType: 'Bearer',
        expiresAt: issued.expiresAt,
        expiresIn: Math.max(0, Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000)),
        scopes: issued.scopes,
        allowedPrefixes: issued.allowedPrefixes,
      };
    } catch (error) {
      throw problem(403, 'Token request denied', error instanceof Error ? error.message : 'Token request denied.', { code: 'token_request_denied' });
    }
  });

  app.post('/v1/auth/revoke', {
    config: policy({ exposure: 'auth', authRequired: true, authMode: 'access-token' }),
  }, async (request) => {
    const token = authHeaderToken(request.headers.authorization);
    return { revoked: token ? revokeAccessToken(db, token) : false };
  });

  app.post('/v1/jobs', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:job:create'], idempotencyRequired: true }),
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const caller = (request.auth?.actor ?? String(body.caller ?? '').trim()) || 'unknown';
    const profile = String(body.profile ?? config.execution.defaultProfile).trim();
    if (!config.execution.profiles[profile]) throw problem(400, 'Unknown execution profile', `profile '${profile}' is not configured.`);
    const metadata = typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {};
    const jobId = createJobId();
    const paths = createJobPaths(config.storage.workspaceRoot, config.storage.artifactRoot, jobId);
    const createdAt = nowIso();
    const job: JobRecord = {
      job_id: jobId,
      caller,
      profile,
      status: 'created',
      network: 'disabled',
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: null,
      workspace_path: paths.workspacePath,
      artifact_path: paths.artifactPath,
      metadata_json: JSON.stringify(metadata),
    };
    db.insertJob(job);
    writeJobManifests(job);
    reply.code(201);
    return publicJob(job);
  });

  app.get('/v1/jobs', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:job:read'] }),
  }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return { items: db.listJobs(limit).map(publicJob) };
  });

  app.get('/v1/jobs/:jobId', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:job:read'] }),
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = requireJob(db, jobId);
    return publicJob(job);
  });

  app.post('/v1/jobs/:jobId/pipelines', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:pipeline:run'], idempotencyRequired: true }),
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = requireJob(db, jobId);
    const result = await runPipeline({
      config,
      jobId,
      profile: job.profile,
      workPath: path.join(job.workspace_path, 'work'),
      artifactPath: job.artifact_path,
      request: request.body as never,
    });
    db.insertPipelineRun(result.run);
    db.updateJobStatus(jobId, result.run.status === 'completed' ? 'completed' : result.run.status, true);
    return {
      runId: result.run.run_id,
      jobId,
      status: result.run.status,
      exitCode: result.run.exit_code,
      signal: result.run.signal,
      durationMs: result.run.duration_ms,
      cwd: result.run.cwd,
      stdout: result.run.stdout,
      stderr: result.run.stderr,
      truncated: Boolean(result.run.truncated),
    };
  });

  app.get('/v1/jobs/:jobId/processes', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:job:read'] }),
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    requireJob(db, jobId);
    return { jobId, items: [] };
  });

  app.post('/v1/jobs/:jobId/cancel', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:job:cancel'], idempotencyRequired: true }),
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    requireJob(db, jobId);
    db.updateJobStatus(jobId, 'cancel_requested', false);
    return { jobId, status: 'cancel_requested' };
  });

  app.get('/v1/jobs/:jobId/artifacts', {
    config: policy({ exposure: 'internal', authRequired: true, scopes: ['sandbox:artifact:read'] }),
  }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = requireJob(db, jobId);
    const files = fs.existsSync(job.artifact_path)
      ? fs.readdirSync(job.artifact_path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
      : [];
    return { jobId, artifactPath: job.artifact_path, items: files };
  });

  return app;
}

function requestLoggerError(app: FastifyInstance, err: unknown): void {
  app.log.error({ err }, 'unhandled request error');
}
