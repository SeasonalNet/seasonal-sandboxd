import { createHash, randomBytes } from 'node:crypto';

export const CLIENT_TOKEN_PREFIX = 'seasonalsandboxd_client';
export const ACCESS_TOKEN_PREFIX = 'seasonalsandboxd_access';

const TOKEN_RE = /^seasonalsandboxd_(client|access)_[A-Za-z0-9_-]{43,}$/;

export function generateOpaqueToken(prefix: typeof CLIENT_TOKEN_PREFIX | typeof ACCESS_TOKEN_PREFIX): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isPlausibleSandboxdToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function hasTokenPrefix(token: string, prefix: typeof CLIENT_TOKEN_PREFIX | typeof ACCESS_TOKEN_PREFIX): boolean {
  return token.startsWith(`${prefix}_`) && isPlausibleSandboxdToken(token);
}
