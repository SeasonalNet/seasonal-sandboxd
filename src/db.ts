import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nowIso } from './time.js';

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

type SqlValue = string | number | boolean | null;

function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number cannot be stored in sqlite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${value.replaceAll("'", "''")}'`;
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

export class SandboxDatabase {
  readonly dbPath: string;
  readonly sqliteBin: string;

  constructor(dbPath: string, sqliteBin = process.env.SQLITE3_BIN ?? '/usr/bin/sqlite3') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.sqliteBin = sqliteBin;
  }

  private exec(sql: string): void {
    execFileSync(this.sqliteBin, ['-batch', this.dbPath], {
      input: `PRAGMA foreign_keys = ON;\n${sql}\n`,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
    });
  }

  private query<T>(sql: string): T[] {
    const output = execFileSync(this.sqliteBin, ['-json', this.dbPath], {
      input: `PRAGMA foreign_keys = ON;\n${sql}\n`,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 16,
    }).trim();
    if (!output) return [];
    return JSON.parse(output) as T[];
  }

  initialize(): void {
    const migrationPath = path.resolve(process.cwd(), 'migrations/001_initial.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    this.exec(`PRAGMA journal_mode = WAL;\n${sql}`);
    this.exec(`INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (${sqlLiteral('001_initial')}, ${sqlLiteral(nowIso())});`);
  }

  ready(): boolean {
    const rows = this.query<{ ok: number }>('SELECT 1 AS ok;');
    return rows[0]?.ok === 1;
  }

  insertJob(job: JobRecord): void {
    this.exec(`
      INSERT INTO jobs(job_id, caller, profile, status, network, created_at, updated_at, completed_at, workspace_path, artifact_path, metadata_json)
      VALUES (
        ${sqlLiteral(job.job_id)},
        ${sqlLiteral(job.caller)},
        ${sqlLiteral(job.profile)},
        ${sqlLiteral(job.status)},
        ${sqlLiteral(job.network)},
        ${sqlLiteral(job.created_at)},
        ${sqlLiteral(job.updated_at)},
        ${sqlLiteral(job.completed_at)},
        ${sqlLiteral(job.workspace_path)},
        ${sqlLiteral(job.artifact_path)},
        ${sqlLiteral(job.metadata_json)}
      );
    `);
  }

  listJobs(limit: number): JobRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.query<Record<string, unknown>>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${safeLimit};`).map(jobRecord);
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE job_id = ${sqlLiteral(jobId)} LIMIT 1;`).map(jobRecord)[0];
  }

  updateJobStatus(jobId: string, status: string, completed = false): void {
    this.exec(`
      UPDATE jobs
      SET status = ${sqlLiteral(status)},
          updated_at = ${sqlLiteral(nowIso())},
          completed_at = COALESCE(completed_at, ${sqlLiteral(completed ? nowIso() : null)})
      WHERE job_id = ${sqlLiteral(jobId)};
    `);
  }

  insertPipelineRun(run: PipelineRunRecord): void {
    this.exec(`
      INSERT INTO pipeline_runs(run_id, job_id, status, exit_code, signal, duration_ms, created_at, completed_at, cwd, pipeline_json, stdout, stderr, truncated, error_json)
      VALUES (
        ${sqlLiteral(run.run_id)},
        ${sqlLiteral(run.job_id)},
        ${sqlLiteral(run.status)},
        ${sqlLiteral(run.exit_code)},
        ${sqlLiteral(run.signal)},
        ${sqlLiteral(run.duration_ms)},
        ${sqlLiteral(run.created_at)},
        ${sqlLiteral(run.completed_at)},
        ${sqlLiteral(run.cwd)},
        ${sqlLiteral(run.pipeline_json)},
        ${sqlLiteral(run.stdout)},
        ${sqlLiteral(run.stderr)},
        ${sqlLiteral(run.truncated)},
        ${sqlLiteral(run.error_json)}
      );
    `);
  }

  listPipelineRuns(jobId: string): PipelineRunRecord[] {
    return this.query<Record<string, unknown>>(`SELECT * FROM pipeline_runs WHERE job_id = ${sqlLiteral(jobId)} ORDER BY created_at DESC;`).map(pipelineRecord);
  }
}
