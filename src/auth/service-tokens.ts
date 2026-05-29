import type { SandboxDatabase } from '../db.js';
import { futureIso, nowIso, parseJsonArray } from '../db.js';
import { ACCESS_TOKEN_PREFIX, CLIENT_TOKEN_PREFIX, generateOpaqueToken, hashToken, hasTokenPrefix } from '../crypto/tokens.js';
import type { AccessTokenRecord, AuthContext, ClientCredentialRecord } from './types.js';
import { assertScopeSubset, assertValidScopes, normalizeScopes } from './scopes.js';
import { assertValidAllowedCidrs, ipAllowedByCidrs } from '../net/cidr.js';

export interface CreateClientCredentialInput {
  name: string;
  scopes: string[];
  allowedPrefixes?: string[];
  allowedCidrs?: string[];
  expiresAt?: string | null;
}

export interface IssuedClientCredential {
  rawToken: string;
  id: number;
  name: string;
}

function normalizeRoutePrefixes(prefixes: unknown): string[] {
  if (!Array.isArray(prefixes)) return [];
  return [...new Set(prefixes
    .filter((prefix): prefix is string => typeof prefix === 'string')
    .map((prefix) => prefix.trim())
    .filter(Boolean)
  )].sort();
}

function assertValidRoutePrefixes(prefixes: string[]): void {
  const bad = prefixes.find((prefix) => !prefix.startsWith('/') || /\s/.test(prefix));
  if (bad) throw new Error(`Invalid route prefix: ${bad}`);
}

function routePrefixIsWithin(requested: string, allowed: string): boolean {
  if (allowed === '/') return true;
  if (requested === allowed) return true;
  const normalizedAllowed = allowed.endsWith('/') ? allowed : `${allowed}/`;
  return requested.startsWith(normalizedAllowed);
}

function assertRoutePrefixSubset(requested: string[], allowed: string[]): void {
  if (allowed.length === 0 || requested.length === 0) return;
  const denied = requested.filter((prefix) => !allowed.some((allowedPrefix) => routePrefixIsWithin(prefix, allowedPrefix)));
  if (denied.length > 0) throw new Error(`Requested route prefixes not allowed: ${denied.join(', ')}`);
}

export function routeAllowedByPrefixes(route: string, allowedPrefixes: string[]): boolean {
  if (allowedPrefixes.length === 0) return true;
  const path = route.split(/[?#]/, 1)[0] || '/';
  return allowedPrefixes.some((prefix) => routePrefixIsWithin(path, prefix));
}

export function createClientCredential(db: SandboxDatabase, input: CreateClientCredentialInput): IssuedClientCredential {
  const scopes = normalizeScopes(input.scopes);
  assertValidScopes(scopes);
  const allowedPrefixes = normalizeRoutePrefixes(input.allowedPrefixes ?? []);
  assertValidRoutePrefixes(allowedPrefixes);
  const allowedCidrs = input.allowedCidrs ?? [];
  assertValidAllowedCidrs(allowedCidrs);

  const rawToken = generateOpaqueToken(CLIENT_TOKEN_PREFIX);
  const tokenHash = hashToken(rawToken);
  const createdAt = nowIso();

  const result = db.raw.prepare(`
    INSERT INTO client_credentials(name, token_hash, allowed_scopes_json, allowed_prefixes_json, allowed_cidrs_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    tokenHash,
    JSON.stringify(scopes),
    JSON.stringify(allowedPrefixes),
    JSON.stringify(allowedCidrs),
    createdAt,
    input.expiresAt ?? null,
  );

  return { rawToken, id: Number(result.lastInsertRowid), name: input.name };
}

export function validateClientCredential(db: SandboxDatabase, token: string, sourceIp: string): AuthContext | null {
  if (!hasTokenPrefix(token, CLIENT_TOKEN_PREFIX)) return null;

  const row = db.raw.prepare(`
    SELECT id, name, allowed_scopes_json, allowed_prefixes_json, allowed_cidrs_json, enabled, expires_at, revoked_at
    FROM client_credentials
    WHERE token_hash = ?
  `).get(hashToken(token)) as ClientCredentialRecord | undefined;

  if (!row || row.enabled !== 1 || row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= nowIso()) return null;

  const cidrs = parseJsonArray(row.allowed_cidrs_json);
  if (!ipAllowedByCidrs(sourceIp, cidrs)) return null;

  db.raw.prepare('UPDATE client_credentials SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);

  return {
    actor: row.name,
    actorType: 'client',
    clientId: row.id,
    clientName: row.name,
    scopes: parseJsonArray(row.allowed_scopes_json),
    allowedPrefixes: parseJsonArray(row.allowed_prefixes_json),
  };
}

export interface IssueAccessTokenInput {
  client: AuthContext;
  requestedScopes: string[];
  ttlSeconds: number;
  maxTtlSeconds: number;
  requestedPrefixes?: string[];
  sourceIp?: string;
  userAgent?: string;
}

export function issueAccessToken(db: SandboxDatabase, input: IssueAccessTokenInput): { rawToken: string; expiresAt: string; scopes: string[]; allowedPrefixes: string[] } {
  const requestedScopes = normalizeScopes(input.requestedScopes);
  assertValidScopes(requestedScopes);
  assertScopeSubset(requestedScopes, input.client.scopes);

  const requestedPrefixes = normalizeRoutePrefixes(input.requestedPrefixes ?? []);
  assertValidRoutePrefixes(requestedPrefixes);
  assertRoutePrefixSubset(requestedPrefixes, input.client.allowedPrefixes);
  const allowedPrefixes = requestedPrefixes.length > 0 ? requestedPrefixes : input.client.allowedPrefixes;

  const ttlSeconds = Math.max(1, Math.min(input.ttlSeconds, input.maxTtlSeconds));
  const rawToken = generateOpaqueToken(ACCESS_TOKEN_PREFIX);
  const tokenHash = hashToken(rawToken);
  const createdAt = nowIso();
  const expiresAt = futureIso(ttlSeconds);

  db.raw.prepare(`
    INSERT INTO access_tokens(token_hash, client_id, scopes_json, allowed_prefixes_json, source_ip, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    input.client.clientId,
    JSON.stringify(requestedScopes),
    JSON.stringify(allowedPrefixes),
    input.sourceIp ?? null,
    input.userAgent ?? null,
    createdAt,
    expiresAt,
  );

  return { rawToken, expiresAt, scopes: requestedScopes, allowedPrefixes };
}

export function validateAccessToken(db: SandboxDatabase, token: string): AuthContext | null {
  if (!hasTokenPrefix(token, ACCESS_TOKEN_PREFIX)) return null;

  const row = db.raw.prepare(`
    SELECT access_tokens.id,
           access_tokens.client_id,
           client_credentials.name AS client_name,
           access_tokens.scopes_json,
           access_tokens.allowed_prefixes_json,
           access_tokens.expires_at,
           access_tokens.revoked_at
    FROM access_tokens
    JOIN client_credentials ON client_credentials.id = access_tokens.client_id
    WHERE access_tokens.token_hash = ?
      AND client_credentials.enabled = 1
      AND client_credentials.revoked_at IS NULL
  `).get(hashToken(token)) as AccessTokenRecord | undefined;

  if (!row || row.revoked_at) return null;
  if (row.expires_at <= nowIso()) return null;

  return {
    actor: row.client_name,
    actorType: 'access-token',
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: parseJsonArray(row.scopes_json),
    allowedPrefixes: parseJsonArray(row.allowed_prefixes_json),
    accessTokenId: row.id,
  };
}

export function revokeAccessToken(db: SandboxDatabase, token: string): boolean {
  if (!hasTokenPrefix(token, ACCESS_TOKEN_PREFIX)) return false;
  const result = db.raw.prepare('UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(nowIso(), hashToken(token));
  return result.changes > 0;
}
