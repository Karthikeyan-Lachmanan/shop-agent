import { serve } from '@hono/node-server';
import { createDb, runMigrations } from '@shop-agent/db';
import { createApp } from './app';
import type { Deps } from './deps';
import { loadEnv } from './env';
import { MemoryKV, RedisKV } from './kv';
import { AnthropicModel, type ModelRegistry } from './model';
import { OpenAIModel } from './openai';
import { MemoryRepo } from './repo/memory';
import { PostgresRepo } from './repo/postgres';

async function main() {
  const env = loadEnv();

  let repo: Deps['repo'];
  let closeDb = async () => {};
  if (env.DATABASE_URL) {
    await runMigrations(env.DATABASE_URL, env.MIGRATIONS_DIR);
    const { db, close } = createDb(env.DATABASE_URL);
    repo = new PostgresRepo(db);
    closeDb = close;
  } else {
    repo = new MemoryRepo();
  }
  const kv = env.REDIS_URL ? new RedisKV(env.REDIS_URL) : new MemoryKV();

  const models: ModelRegistry = {};
  if (env.ANTHROPIC_API_KEY) models.anthropic = { client: new AnthropicModel(env.ANTHROPIC_API_KEY), defaultModel: env.ANTHROPIC_MODEL };
  if (env.OPENAI_API_KEY) models.openai = { client: new OpenAIModel({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL }), defaultModel: env.OPENAI_MODEL };

  const deps: Deps = {
    repo,
    kv,
    models,
    defaultProvider: env.LLM_PROVIDER,
    now: () => new Date(),
    webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET,
    fetch: globalThis.fetch,
  };
  const app = createApp(deps, { adminToken: env.ADMIN_TOKEN });

  // Railway sets PORT; bind all interfaces so its proxy can reach us.
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`[shop-agent] listening on :${info.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[shop-agent] ${signal} received, shutting down`);
    server.close();
    await kv.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
