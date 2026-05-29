import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nowIso } from './time.js';
export { nowIso } from './time.js';

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface StatementAdapter {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): StatementAdapter;
  transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
  pragma(sql: string): void;
  close(): void;
}

type BetterSqlite3DatabaseConstructor = new (filename: string) => DatabaseAdapter;

const require = createRequire(import.meta.url);

function openSqliteDatabase(dbPath: string): DatabaseAdapter {
  try {
    const betterSqlite3 = require('better-sqlite3') as BetterSqlite3DatabaseConstructor;
    return new betterSqlite3(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('better-sqlite3') && !message.includes('bindings file') && !message.includes('Cannot find module')) throw error;
  }

  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseAdapter };
  const db = new DatabaseSync(dbPath);
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T extends unknown[], R>(fn: (...args: T) => R) => (...args: T): R => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    pragma: (sql: string) => db.exec(`PRAGMA ${sql}`),
    close: () => db.close(),
  };
}

export interface JobRecord {
  job_id: string;
  caller: string;
  profile: string;
  status: string;
  network: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  workspace_path: string;
  artifact_path: string;
  metadata_json: string;
}

export interface PipelineRunRecord {
  run_id: string;
  job_id: string;
  status: string;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  created_at: string;
  completed_at: string | null;
  cwd: string;
  pipeline_json: string;
  stdout: string;
  stderr: string;
  truncated: number;
  error_json: string | null;
}

function maybeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function jobRecord(row: Record<string, unknown>): JobRecord {
  return {
    job_id: String(row.job_id),
    caller: String(row.caller),
    profile: String(row.profile),
    status: String(row.status),
    network: String(row.network),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    workspace_path: String(row.workspace_path),
    artifact_path: String(row.artifact_path),
    metadata_json: String(row.metadata_json),
  };
}

function pipelineRecord(row: Record<string, unknown>): PipelineRunRecord {
  return {
    run_id: String(row.run_id),
    job_id: String(row.job_id),
    status: String(row.status),
    exit_code: maybeNumber(row.exit_code),
    signal: row.signal === null || row.signal === undefined ? null : String(row.signal),
    duration_ms: Number(row.duration_ms),
    created_at: String(row.created_at),
    completed_at: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    cwd: String(row.cwd),
    pipeline_json: String(row.pipeline_json),
    stdout: String(row.stdout),
    stderr: String(row.stderr),
    truncated: Number(row.truncated),
    error_json: row.error_json === null || row.error_json === undefined ? null : String(row.error_json),
  };
}

function migrationVersion(filename: string): string {
  return path.basename(filename, '.sql');
}

export function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

export class SandboxDatabase {
  readonly dbPath: string;
  readonly raw: DatabaseAdapter;

  constructor(dbPath: string, raw?: DatabaseAdapter) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.raw = raw ?? openSqliteDatabase(dbPath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
  }

  initialize(): void {
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();

    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applyMigration = this.raw.transaction((version: string, sql: string) => {
      const existing = this.raw.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
      if (existing) return;
      this.raw.exec(sql);
      this.raw.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, nowIso());
    });

    for (const file of files) applyMigration(migrationVersion(file), fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }

  close(): void {
    this.raw.close();
  }

  ready(): boolean {
    const row = this.raw.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  insertJob(job: JobRecord): void {
    this.raw.prepare(`
      INSERT INTO jobs(job_id, caller, profile, status, network, created_at, updated_at, completed_at, workspace_path, artifact_path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.job_id,
      job.caller,
      job.profile,
      job.status,
      job.network,
      job.created_at,
      job.updated_at,
      job.completed_at,
      job.workspace_path,
      job.artifact_path,
      job.metadata_json,
    );
  }

  listJobs(limit: number): JobRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.raw.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(safeLimit).map((row) => jobRecord(row as Record<string, unknown>));
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.raw.prepare('SELECT * FROM jobs WHERE job_id = ? LIMIT 1').get(jobId) as Record<string, unknown> | undefined;
    return row ? jobRecord(row) : undefined;
  }

  updateJobStatus(jobId: string, status: string, completed = false): void {
    const now = nowIso();
    this.raw.prepare(`
      UPDATE jobs
      SET status = ?,
          updated_at = ?,
          completed_at = COALESCE(completed_at, ?)
      WHERE job_id = ?
    `).run(status, now, completed ? now : null, jobId);
  }

  insertPipelineRun(run: PipelineRunRecord): void {
    this.raw.prepare(`
      INSERT INTO pipeline_runs(run_id, job_id, status, exit_code, signal, duration_ms, created_at, completed_at, cwd, pipeline_json, stdout, stderr, truncated, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.job_id,
      run.status,
      run.exit_code,
      run.signal,
      run.duration_ms,
      run.created_at,
      run.completed_at,
      run.cwd,
      run.pipeline_json,
      run.stdout,
      run.stderr,
      run.truncated,
      run.error_json,
    );
  }

  listPipelineRuns(jobId: string): PipelineRunRecord[] {
    return this.raw.prepare('SELECT * FROM pipeline_runs WHERE job_id = ? ORDER BY created_at DESC').all(jobId).map((row) => pipelineRecord(row as Record<string, unknown>));
  }
}
