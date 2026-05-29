export function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter(Boolean)
  )].sort();
}

export function assertValidScopes(scopes: string[]): void {
  const bad = scopes.find((scope) => !/^[a-z0-9][a-z0-9:-]*[a-z0-9*]$/i.test(scope));
  if (bad) throw new Error(`Invalid scope: ${bad}`);
}

export function hasRequiredScopes(actual: string[], required: string[]): boolean {
  const actualSet = new Set(actual);
  return required.every((scope) => actualSet.has(scope) || actualSet.has('admin:all'));
}

export function assertScopeSubset(requested: string[], allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const denied = requested.filter((scope) => !allowedSet.has(scope) && !allowedSet.has('admin:all'));
  if (denied.length > 0) throw new Error(`Requested scopes not allowed: ${denied.join(', ')}`);
}
