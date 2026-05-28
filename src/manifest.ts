import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord } from './db.js';

export function writeJobManifests(job: JobRecord): void {
  const payload = {
    jobId: job.job_id,
    service: 'seasonal-sandboxd',
    caller: job.caller,
    profile: job.profile,
    status: job.status,
    network: job.network,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    workspacePath: job.workspace_path,
    artifactPath: job.artifact_path,
    metadata: JSON.parse(job.metadata_json),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(path.join(job.workspace_path, 'manifest.json'), text, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(job.artifact_path, 'manifest.json'), text, { encoding: 'utf8', mode: 0o600 });
}
