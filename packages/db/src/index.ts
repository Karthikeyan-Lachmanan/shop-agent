import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export { schema };
export type Database = ReturnType<typeof createDb>['db'];

export function createDb(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

/** Safe to call from every replica on boot: an advisory lock serializes concurrent runs. */
export async function runMigrations(url: string, migrationsFolder: string) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(727274)`;
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client`select pg_advisory_unlock(727274)`.catch(() => {});
    await client.end();
  }
}
