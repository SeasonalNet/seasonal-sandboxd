import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { defaultConfig, type SandboxdConfig } from '../src/config.js';
import { SandboxDatabase } from '../src/db.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(): { db: SandboxDatabase; config: SandboxdConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-test-'));
  cleanup.push(root);
  const config: SandboxdConfig = {
    ...defaultConfig,
    database: { path: ':memory:' },
    storage: {
      ...defaultConfig.storage,
      workspaceRoot: path.join(root, 'workspaces'),
      artifactRoot: path.join(root, 'artifacts'),
    },
    auth: { ...defaultConfig.auth, enabled: false },
  };
  fs.mkdirSync(config.storage.workspaceRoot, { recursive: true });
  fs.mkdirSync(config.storage.artifactRoot, { recursive: true });
  const db = new SandboxDatabase(':memory:');
  db.initialize();
  return { db, config };
}

describe('idempotency', () => {
  it('requires Idempotency-Key on mutating job routes', async () => {
    const { db, config } = setup();
    const app = buildServer(config, db);

    const response = await app.inject({ method: 'POST', url: '/v1/jobs', payload: { caller: 'test' } });

    expect(response.statusCode).toBe(428);
    expect((response.json() as { code: string }).code).toBe('missing_idempotency_key');

    await app.close();
    db.close();
  });

  it('replays the original response for the same key and same payload', async () => {
    const { db, config } = setup();
    const app = buildServer(config, db);
    const headers = { 'idempotency-key': 'idem-job-0001' };
    const payload = { caller: 'test', profile: 'inspect' };

    const first = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    await app.close();
    db.close();
  });

  it('rejects same key with different payload', async () => {
    const { db, config } = setup();
    const app = buildServer(config, db);
    const headers = { 'idempotency-key': 'idem-job-0002' };

    const first = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { caller: 'a' } });
    const second = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { caller: 'b' } });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('idempotency_key_conflict');

    await app.close();
    db.close();
  });
});
