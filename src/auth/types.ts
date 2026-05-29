export type ActorType = 'client' | 'access-token';

export interface AuthContext {
  actor: string;
  actorType: ActorType;
  clientId: number;
  clientName: string;
  scopes: string[];
  allowedPrefixes: string[];
  accessTokenId?: number;
}

export interface ClientCredentialRecord {
  id: number;
  name: string;
  allowed_scopes_json: string;
  allowed_prefixes_json: string;
  allowed_cidrs_json: string;
  enabled: number;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AccessTokenRecord {
  id: number;
  client_id: number;
  client_name: string;
  scopes_json: string;
  allowed_prefixes_json: string;
  expires_at: string;
  revoked_at: string | null;
}
