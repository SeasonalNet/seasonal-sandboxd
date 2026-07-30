import { loadConfig } from './config.js';
import { SandboxDatabase } from './db.js';
import { createClientCredential } from './auth/service-tokens.js';

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function value(args: string[], name: string): string | undefined {
  return values(args, name)[0];
}

function csv(input: string | undefined): string[] {
  if (!input) return [];
  return input.split(',').map((item) => item.trim()).filter(Boolean);
}

function usage(): never {
  console.error(`Usage:
  seasonal-sandboxd token create-client --name NAME --scopes scope1,scope2 [--prefix /v1/jobs] [--cidr 192.168.1.0/24] [--expires-at ISO]

Examples:
  pnpm token -- create-client --name seasonal-agent --scopes sandbox:status:read,sandbox:job:create,sandbox:job:read,sandbox:pipeline:run,sandbox:artifact:read,sandbox:job:cancel --prefix /v1/jobs --cidr 192.168.1.20/32
`);
  process.exit(2);
}

const [, , command, subcommand, ...args] = process.argv;
if (command !== 'token' || subcommand !== 'create-client') usage();

const name = value(args, '--name');
const scopes = csv(value(args, '--scopes'));
if (!name || scopes.length === 0) usage();

const config = loadConfig();
const db = new SandboxDatabase(config.database.path);
db.initialize();

const issued = createClientCredential(db, {
  name,
  scopes,
  allowedPrefixes: values(args, '--prefix'),
  allowedCidrs: values(args, '--cidr'),
  expiresAt: value(args, '--expires-at') ?? null,
});

console.log(JSON.stringify({
  id: issued.id,
  name: issued.name,
  clientToken: issued.rawToken,
  tokenType: 'Bearer',
}, null, 2));

db.close();
