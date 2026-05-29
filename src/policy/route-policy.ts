export type AuthMode = 'none' | 'client-credential' | 'access-token';
export type Exposure = 'public' | 'auth' | 'internal';

export interface RoutePolicy {
  exposure: Exposure;
  authRequired?: boolean;
  authMode?: AuthMode;
  scopes?: string[];
  idempotencyRequired?: boolean;
}

export function policy(input: RoutePolicy): { policy: RoutePolicy } {
  return { policy: input };
}
