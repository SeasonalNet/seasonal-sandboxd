import fs from 'node:fs';
import path from 'node:path';
import { partitionForDate } from './time.js';

export interface JobPaths {
  workspacePath: string;
  artifactPath: string;
  inputPath: string;
  workPath: string;
  tmpPath: string;
  logsPath: string;
}

export function createJobPaths(workspaceRoot: string, artifactRoot: string, jobId: string, date = new Date()): JobPaths {
  const { year, month } = partitionForDate(date);
  const workspacePath = path.join(workspaceRoot, year, month, jobId);
  const artifactPath = path.join(artifactRoot, year, month, jobId);
  const paths = {
    workspacePath,
    artifactPath,
    inputPath: path.join(workspacePath, 'input'),
    workPath: path.join(workspacePath, 'work'),
    tmpPath: path.join(workspacePath, 'tmp'),
    logsPath: path.join(workspacePath, 'logs'),
  };
  for (const directory of Object.values(paths)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return paths;
}

export function ensureInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes allowed root: ${candidate}`);
  }
  return resolvedCandidate;
}
