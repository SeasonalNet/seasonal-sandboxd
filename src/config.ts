import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface ExecutionProfileConfig {
  description?: string;
  allowWriteArtifacts: boolean;
  allowedCommands: string[];
}

export interface SandboxdConfig {
  server: {
    host: string;
    port: number;
    trustProxy: boolean;
  };
  database: {
    path: string;
  };
  storage: {
    workspaceRoot: string;
    artifactRoot: string;
    monthFormat: 'numeric-name';
  };
  execution: {
    defaultTimeoutSeconds: number;
    maxTimeoutSeconds: number;
    maxOutputBytes: number;
    defaultProfile: string;
    profiles: Record<string, ExecutionProfileConfig>;
  };
  auth: {
    enabled: boolean;
    bearerTokens: string[];
  };
}

export const DEFAULT_CONFIG_PATH = '/etc/seasonal-sandboxd/config.yaml';

const defaultConfig: SandboxdConfig = {
  server: { host: '127.0.0.1', port: 9090, trustProxy: false },
  database: { path: '/var/lib/sandboxd/sandboxd.db' },
  storage: {
    workspaceRoot: '/mnt/seasonalnas/agent-workspaces/seasonal-sandboxd',
    artifactRoot: '/mnt/seasonalnas/artifacts/seasonal-sandboxd',
    monthFormat: 'numeric-name',
  },
  execution: {
    defaultTimeoutSeconds: 10,
    maxTimeoutSeconds: 60,
    maxOutputBytes: 65536,
    defaultProfile: 'inspect',
    profiles: {
      inspect: {
        allowWriteArtifacts: true,
        allowedCommands: ['cat', 'diff', 'file', 'find', 'grep', 'head', 'jq', 'ls', 'pwd', 'rg', 'sed', 'sort', 'tail', 'wc'],
      },
    },
  },
  auth: { enabled: false, bearerTokens: [] },
};

function mergeConfig(base: SandboxdConfig, override: Partial<SandboxdConfig>): SandboxdConfig {
  return {
    server: { ...base.server, ...(override.server ?? {}) },
    database: { ...base.database, ...(override.database ?? {}) },
    storage: { ...base.storage, ...(override.storage ?? {}) },
    execution: {
      ...base.execution,
      ...(override.execution ?? {}),
      profiles: {
        ...base.execution.profiles,
        ...((override.execution as SandboxdConfig['execution'] | undefined)?.profiles ?? {}),
      },
    },
    auth: { ...base.auth, ...(override.auth ?? {}) },
  };
}

function normalize(config: SandboxdConfig): SandboxdConfig {
  const profiles: Record<string, ExecutionProfileConfig> = {};
  for (const [name, profile] of Object.entries(config.execution.profiles)) {
    profiles[name] = {
      description: profile.description,
      allowWriteArtifacts: Boolean(profile.allowWriteArtifacts),
      allowedCommands: Array.from(new Set((profile.allowedCommands ?? []).map((cmd) => String(cmd).trim()).filter(Boolean))).sort(),
    };
  }
  return {
    ...config,
    database: { path: path.resolve(config.database.path) },
    storage: {
      ...config.storage,
      workspaceRoot: path.resolve(config.storage.workspaceRoot),
      artifactRoot: path.resolve(config.storage.artifactRoot),
    },
    execution: {
      ...config.execution,
      defaultTimeoutSeconds: Math.max(1, Number(config.execution.defaultTimeoutSeconds || 10)),
      maxTimeoutSeconds: Math.max(1, Number(config.execution.maxTimeoutSeconds || 60)),
      maxOutputBytes: Math.max(1024, Number(config.execution.maxOutputBytes || 65536)),
      profiles,
    },
    auth: {
      enabled: Boolean(config.auth.enabled),
      bearerTokens: (config.auth.bearerTokens ?? []).map((token) => String(token).trim()).filter(Boolean),
    },
  };
}

export function loadConfig(configPath = process.env.SEASONAL_SANDBOXD_CONFIG ?? DEFAULT_CONFIG_PATH): SandboxdConfig {
  if (!fs.existsSync(configPath)) {
    return normalize(defaultConfig);
  }
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Partial<SandboxdConfig> | null;
  return normalize(mergeConfig(defaultConfig, parsed ?? {}));
}
