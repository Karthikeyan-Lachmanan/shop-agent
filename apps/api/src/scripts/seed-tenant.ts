// Creates a tenant through the admin API.
//   API_URL=https://your-app.up.railway.app ADMIN_TOKEN=... npm run seed:tenant -- examples/naga-crackers.tenant.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
const apiUrl = process.env.API_URL ?? 'http://localhost:8080';
const token = process.env.ADMIN_TOKEN;
if (!file || !token) {
  console.error('usage: API_URL=... ADMIN_TOKEN=... npm run seed:tenant -- <tenant.json>');
  process.exit(1);
}

const body = readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8');
const res = await fetch(`${apiUrl.replace(/\/$/, '')}/admin/tenants`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body,
});
const data = await res.json();
if (!res.ok) {
  console.error(res.status, data);
  process.exit(1);
}
console.log('Tenant created. Store the secret key now — it is not shown again.\n');
console.log(JSON.stringify(data, null, 2));
