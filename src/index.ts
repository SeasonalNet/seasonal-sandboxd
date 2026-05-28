import { loadConfig } from './config.js';
import { SandboxDatabase } from './db.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = new SandboxDatabase(config.database.path);
db.initialize();

const app = buildServer(config, db);
await app.listen({ host: config.server.host, port: config.server.port });
