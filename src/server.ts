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
  if (!isJobId(jobId)) {
    throw problem(400, 'Invalid job id', 'jobId must use sandboxd_<uuidv7> format.');
  }
  const job = db.getJob(jobId);
  if (!job) {
    throw problem(404, 'Job not found', `No job exists with id '${jobId}'.`);
  }
  return job;
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

  app.addHook('preHandler', async (request) => {
    if (!config.auth.enabled) return;
    if (request.url === '/healthz') return;
    const header = request.headers.authorization ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token || !config.auth.bearerTokens.includes(token)) {
      throw problem(401, 'Unauthorized', 'A valid bearer token is required.');
    }
  });

  app.get('/healthz', async () => ({ ok: true, service: 'seasonal-sandboxd' }));

  app.get('/readyz', async () => {
    const dbReady = db.ready();
    const workspaceReady = fs.existsSync(config.storage.workspaceRoot);
    const artifactReady = fs.existsSync(config.storage.artifactRoot);
    if (!dbReady || !workspaceReady || !artifactReady) {
      throw problem(503, 'Service Unavailable', 'Database or storage path is not ready.', { dbReady, workspaceReady, artifactReady });
    }
    return { ok: true, dbReady, workspaceReady, artifactReady };
  });

  app.get('/openapi.json', async () => {
    const openapiPath = path.resolve('openapi/openapi.yaml');
    const parsed = YAML.parse(fs.readFileSync(openapiPath, 'utf8')) as unknown;
    return parsed;
  });

  app.post('/v1/jobs', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const caller = String(body.caller ?? '').trim() || 'unknown';
    const profile = String(body.profile ?? config.execution.defaultProfile).trim();
    if (!config.execution.profiles[profile]) {
      throw problem(400, 'Unknown execution profile', `profile '${profile}' is not configured.`);
    }
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

  app.get('/v1/jobs', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return { items: db.listJobs(limit).map(publicJob) };
  });

  app.get('/v1/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = requireJob(db, jobId);
    return publicJob(job);
  });

  app.post('/v1/jobs/:jobId/pipelines', async (request) => {
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

  app.get('/v1/jobs/:jobId/processes', async (request) => {
    const { jobId } = request.params as { jobId: string };
    requireJob(db, jobId);
    return { jobId, items: [] };
  });

  app.post('/v1/jobs/:jobId/cancel', async (request) => {
    const { jobId } = request.params as { jobId: string };
    requireJob(db, jobId);
    db.updateJobStatus(jobId, 'cancel_requested', false);
    return { jobId, status: 'cancel_requested' };
  });

  app.get('/v1/jobs/:jobId/artifacts', async (request) => {
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
