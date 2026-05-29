import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SandboxdConfig } from '../config.js';
import type { SandboxDatabase } from '../db.js';
import { routeAllowedByPrefixes, validateAccessToken, validateClientCredential } from '../auth/service-tokens.js';
import { hasRequiredScopes } from '../auth/scopes.js';
import type { RoutePolicy } from '../policy/route-policy.js';
import { problem } from '../problem.js';

function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

function routePolicy(request: FastifyRequest): RoutePolicy | undefined {
  return (request.routeOptions.config as { policy?: RoutePolicy } | undefined)?.policy;
}

function fail(reply: FastifyReply, status: number, title: string, detail: string, extra?: Record<string, unknown>): never {
  void reply;
  throw problem(status, title, detail, extra);
}

export function registerAuthMiddleware(app: FastifyInstance, db: SandboxDatabase, config: SandboxdConfig): void {
  app.addHook('preHandler', async (request, reply) => {
    const rp = routePolicy(request);
    if (!rp?.authRequired) return;

    const bearer = getBearerToken(request);

    // Public auth disablement is only for non-auth API routes. Token mint/revoke routes still need
    // credentials. For non-auth routes, still opportunistically populate request.auth when a valid
    // access token is supplied so job/audit attribution remains accurate during staged rollout.
    if (!config.auth.enabled && rp.exposure !== 'auth') {
      if (bearer) request.auth = validateAccessToken(db, bearer) ?? undefined;
      return;
    }

    if (!bearer) fail(reply, 401, 'Unauthorized', 'Missing Authorization bearer token.', { code: 'missing_bearer_token' });

    const mode = rp.authMode ?? 'access-token';
    const auth = mode === 'client-credential'
      ? validateClientCredential(db, bearer, request.ip)
      : validateAccessToken(db, bearer);

    if (!auth) fail(reply, 401, 'Unauthorized', 'Invalid, expired, or unauthorized bearer token.', { code: 'invalid_bearer_token' });

    if (mode === 'access-token' && !routeAllowedByPrefixes(request.url, auth.allowedPrefixes)) {
      fail(reply, 403, 'Forbidden', 'Access token is not valid for this route prefix.', { code: 'route_prefix_forbidden' });
    }

    const requiredScopes = rp.scopes ?? [];
    if (requiredScopes.length > 0 && !hasRequiredScopes(auth.scopes, requiredScopes)) {
      fail(reply, 403, 'Forbidden', `Missing required scope: ${requiredScopes.join(', ')}`, { code: 'insufficient_scope' });
    }

    request.auth = auth;
  });
}
