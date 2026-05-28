import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SandboxdConfig } from './config.js';
import { type PipelineRunRecord } from './db.js';
import { createRunId } from './ids.js';
import { capOutput } from './output.js';
import { problem } from './problem.js';
import { nowIso } from './time.js';

export type PipelineStage = string[];

function resolveExecutable(command: string, envPath: string): string {
  for (const entry of envPath.split(':').filter(Boolean)) {
    const candidate = path.join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw problem(503, 'Command unavailable', `command '${command}' is allowlisted but is not installed in PATH.`);
}

export interface PipelineRequest {
  pipeline: PipelineStage[];
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
}

export interface PipelineResult {
  run: PipelineRunRecord;
}

function validatePipeline(pipeline: unknown, allowedCommands: Set<string>): PipelineStage[] {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw problem(400, 'Invalid pipeline', 'pipeline must be a non-empty array of argv arrays.');
  }
  if (pipeline.length > 8) {
    throw problem(400, 'Invalid pipeline', 'pipeline may contain at most 8 stages.');
  }
  return pipeline.map((stage, index) => {
    if (!Array.isArray(stage) || stage.length === 0) {
      throw problem(400, 'Invalid pipeline stage', `stage ${index} must be a non-empty argv array.`);
    }
    const argv = stage.map((part) => String(part));
    const command = path.basename(argv[0]);
    if (argv[0] !== command || argv[0].includes('/') || argv[0].includes('\\')) {
      throw problem(403, 'Command path not allowed', 'stage commands must be bare executable names, not paths.', { command: argv[0], stage: index });
    }
    if (!allowedCommands.has(command)) {
      throw problem(403, 'Command not allowed', `command '${command}' is not allowed by this execution profile.`, { command, stage: index });
    }
    if (argv.some((part) => part.includes('\u0000'))) {
      throw problem(400, 'Invalid argument', 'arguments may not contain NUL bytes.');
    }
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('/') || arg === '..' || arg.startsWith('../') || arg.includes('/../')) {
        throw problem(400, 'Path argument not allowed', 'pipeline arguments must not use absolute paths or parent-directory traversal.', { stage: index });
      }
    }
    return argv;
  });
}

export async function runPipeline(options: {
  config: SandboxdConfig;
  jobId: string;
  profile: string;
  workPath: string;
  artifactPath: string;
  request: PipelineRequest;
}): Promise<PipelineResult> {
  const profileConfig = options.config.execution.profiles[options.profile];
  if (!profileConfig) {
    throw problem(400, 'Unknown execution profile', `profile '${options.profile}' is not configured.`);
  }
  const allowedCommands = new Set(profileConfig.allowedCommands.map((cmd) => path.basename(cmd)));
  const pipeline = validatePipeline(options.request.pipeline, allowedCommands);
  const timeoutSeconds = Math.min(
    Math.max(1, Number(options.request.timeoutSeconds ?? options.config.execution.defaultTimeoutSeconds)),
    options.config.execution.maxTimeoutSeconds,
  );
  const maxOutputBytes = Math.min(
    Math.max(1024, Number(options.request.maxOutputBytes ?? options.config.execution.maxOutputBytes)),
    options.config.execution.maxOutputBytes,
  );
  const cwd = options.request.cwd ? path.resolve(options.workPath, options.request.cwd) : options.workPath;
  if (cwd !== options.workPath && !cwd.startsWith(`${options.workPath}${path.sep}`)) {
    throw problem(400, 'Invalid cwd', 'cwd must stay inside the job work directory.');
  }

  const createdAt = nowIso();
  const started = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const childEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: path.join(options.workPath, '..', 'tmp'),
  };
  const children = pipeline.map((argv) => spawn(resolveExecutable(argv[0], childEnv.PATH), argv.slice(1), {
    cwd,
    shell: false,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  }));

  for (let i = 0; i < children.length - 1; i += 1) {
    children[i].stdout!.pipe(children[i + 1].stdin!);
  }
  children[0].stdin!.end();
  children[children.length - 1].stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  for (const child of children) {
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  }

  const timeout = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) child.kill('SIGKILL');
      }
    }, 1500).unref();
  }, timeoutSeconds * 1000);

  const exits = await Promise.all(children.map(async (child) => {
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    return { code, signal };
  }));
  clearTimeout(timeout);

  const finalExit = exits.find((exit) => exit.code !== null && exit.code !== 0) ?? exits[exits.length - 1];
  const stdoutCapped = capOutput(Buffer.concat(stdoutChunks).toString('utf8'), maxOutputBytes);
  const stderrCapped = capOutput(Buffer.concat(stderrChunks).toString('utf8'), maxOutputBytes);
  const completedAt = nowIso();
  const durationMs = Date.now() - started;
  const runId = createRunId();

  const stdoutPath = path.join(options.artifactPath, `${runId}.stdout.txt`);
  const stderrPath = path.join(options.artifactPath, `${runId}.stderr.txt`);
  writeFileSync(stdoutPath, stdoutCapped.text, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(stderrPath, stderrCapped.text, { encoding: 'utf8', mode: 0o600 });

  const timedOut = exits.some((exit) => exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL') && durationMs >= timeoutSeconds * 1000;
  const run: PipelineRunRecord = {
    run_id: runId,
    job_id: options.jobId,
    status: timedOut ? 'timeout' : (finalExit.code === 0 ? 'completed' : 'failed'),
    exit_code: finalExit.code,
    signal: finalExit.signal,
    duration_ms: durationMs,
    created_at: createdAt,
    completed_at: completedAt,
    cwd,
    pipeline_json: JSON.stringify(pipeline),
    stdout: stdoutCapped.text,
    stderr: stderrCapped.text,
    truncated: stdoutCapped.truncated || stderrCapped.truncated ? 1 : 0,
    error_json: null,
  };
  return { run };
}
