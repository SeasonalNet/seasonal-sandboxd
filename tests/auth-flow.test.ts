import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { defaultConfig, type SandboxdConfig } from '../src/config.js';
import { SandboxDatabase } from '../src/db.js';
import { createClientCredential } from '../src/auth/service-tokens.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(authEnabled = true): { db: SandboxDatabase; config: SandboxdConfig; root: string } {
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
    auth: { ...defaultConfig.auth, enabled: authEnabled },
  };
  fs.mkdirSync(config.storage.workspaceRoot, { recursive: true });
  fs.mkdirSync(config.storage.artifactRoot, { recursive: true });
  const db = new SandboxDatabase(':memory:');
  db.initialize();
  return { db, config, root };
}

describe('auth token exchange', () => {
  it('exchanges a client credential for a scoped short-lived access token', async () => {
    const { db, config } = setup(true);
    const client = createClientCredential(db, {
      name: 'seasonal-agent',
      scopes: ['sandbox:job:create', 'sandbox:job:read'],
    });
    const app = buildServer(config, db);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { authorization: `Bearer ${client.rawToken}` },
      payload: { requestedScopes: ['sandbox:job:create', 'sandbox:job:read'] },
    });

    expect(tokenResponse.statusCode).toBe(200);
    const tokenBody = tokenResponse.json() as { accessToken: string; scopes: string[] };
    expect(tokenBody.accessToken).toMatch(/^seasonalsandboxd_access_/);
    expect(tokenBody.scopes).toEqual(['sandbox:job:create', 'sandbox:job:read']);

    const createJob = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${tokenBody.accessToken}`, 'idempotency-key': 'auth-flow-job-1' },
      payload: { profile: 'inspect' },
    });
    expect(createJob.statusCode).toBe(201);
    expect((createJob.json() as { caller: string }).caller).toBe('seasonal-agent');

    const staticTokenMisuse = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${client.rawToken}` },
    });
    expect(staticTokenMisuse.statusCode).toBe(401);

    await app.close();
    db.close();
  });

  it('rejects scope escalation during token mint', async () => {
    const { db, config } = setup(true);
    const client = createClientCredential(db, { name: 'limited-agent', scopes: ['sandbox:job:read'] });
    const app = buildServer(config, db);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { authorization: `Bearer ${client.rawToken}` },
      payload: { requestedScopes: ['sandbox:job:create'] },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('token_request_denied');

    await app.close();
    db.close();
  });

  it('enforces client credential route prefixes on minted access tokens', async () => {
    const { db, config } = setup(true);
    const client = createClientCredential(db, {
      name: 'jobs-only-agent',
      scopes: ['sandbox:job:read', 'sandbox:status:read'],
      allowedPrefixes: ['/v1/jobs'],
    });
    const app = buildServer(config, db);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { authorization: `Bearer ${client.rawToken}` },
      payload: { requestedScopes: ['sandbox:job:read'], requestedPrefixes: ['/v1/jobs'] },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const accessToken = (tokenResponse.json() as { accessToken: string }).accessToken;

    const jobs = await app.inject({ method: 'GET', url: '/v1/jobs', headers: { authorization: `Bearer ${accessToken}` } });
    expect(jobs.statusCode).toBe(200);

    const readyz = await app.inject({ method: 'GET', url: '/readyz', headers: { authorization: `Bearer ${accessToken}` } });
    expect(readyz.statusCode).toBe(200);

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json', headers: { authorization: `Bearer ${accessToken}` } });
    expect(openapi.statusCode).toBe(403);
    expect((openapi.json() as { code: string }).code).toBe('route_prefix_forbidden');

    await app.close();
    db.close();
  });

  it('uses a valid access token for caller attribution during auth-disabled rollout', async () => {
    const { db, config } = setup(false);
    const client = createClientCredential(db, {
      name: 'seasonal-agent-rollout',
      scopes: ['sandbox:job:create'],
    });
    const app = buildServer(config, db);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: { authorization: `Bearer ${client.rawToken}` },
      payload: { requestedScopes: ['sandbox:job:create'] },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const accessToken = (tokenResponse.json() as { accessToken: string }).accessToken;

    const createJob = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'auth-disabled-attribution-1' },
      payload: { profile: 'inspect' },
    });

    expect(createJob.statusCode).toBe(201);
    expect((createJob.json() as { caller: string }).caller).toBe('seasonal-agent-rollout');

    await app.close();
    db.close();
  });

});
