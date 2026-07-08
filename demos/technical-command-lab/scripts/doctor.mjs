import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'bundles', 'agentis-technical-command-lab.agentis.json');

console.log('Agentis Technical Command Lab');
console.log(`bundle: ${existsSync(bundle) ? 'ok' : 'missing - run npm run build:bundle'}`);
console.log(`AGENTIS_URL: ${process.env.AGENTIS_URL ?? 'http://127.0.0.1:3737'}`);
console.log(`auth: ${process.env.AGENTIS_API_KEY ? 'api key' : process.env.AGENTIS_PASSWORD ? 'login' : 'not configured'}`);
console.log(`workspace: ${process.env.AGENTIS_WORKSPACE_ID ?? 'auto after login'}`);
