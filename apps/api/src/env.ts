import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  // At least one LLM key is required. Tenants pick a provider; LLM_PROVIDER is the default.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  OPENAI_BASE_URL: z.string().url().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openai']).optional(),
  ADMIN_TOKEN: z.string().min(24, 'ADMIN_TOKEN must be at least 24 characters'),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  MIGRATIONS_DIR: z.string().default('packages/db/migrations'),
});

export type AppEnv = Omit<z.infer<typeof Env>, 'LLM_PROVIDER'> & {
  WEBHOOK_SIGNING_SECRET: string;
  LLM_PROVIDER: 'anthropic' | 'openai';
};

/** Local dev convenience: read .env from the repo root (npm workspaces run us from apps/api). */
function loadDotEnv() {
  if (process.env.NODE_ENV === 'production') return;
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

export function loadEnv(): AppEnv {
  loadDotEnv();
  const env = Env.parse(process.env);
  const prod = env.NODE_ENV === 'production';

  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY');
  const provider = env.LLM_PROVIDER ?? (env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY ? 'openai' : 'anthropic');
  const keyFor = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY };
  if (!keyFor[provider]) throw new Error(`LLM_PROVIDER is ${provider} but ${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`);

  if (prod) {
    const missing = (['DATABASE_URL', 'REDIS_URL', 'WEBHOOK_SIGNING_SECRET'] as const).filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing required env in production: ${missing.join(', ')}`);
  }
  if (env.WEBHOOK_SIGNING_SECRET && env.WEBHOOK_SIGNING_SECRET.length < 32) throw new Error('WEBHOOK_SIGNING_SECRET must be at least 32 characters');
  if (!env.DATABASE_URL) console.warn('[shop-agent] DATABASE_URL not set — using in-memory storage (data is lost on restart)');
  if (!env.REDIS_URL) console.warn('[shop-agent] REDIS_URL not set — using in-memory rate limits and locks (single instance only)');
  console.log(`[shop-agent] default LLM provider: ${provider} (${provider === 'openai' ? env.OPENAI_MODEL : env.ANTHROPIC_MODEL})`);

  // Relative to the repo root; npm workspace scripts run from apps/api, Docker from the root.
  const migrations = [resolve(process.cwd(), env.MIGRATIONS_DIR), resolve(process.cwd(), '../..', env.MIGRATIONS_DIR)]
    .find((p) => existsSync(resolve(p, 'meta/_journal.json'))) ?? env.MIGRATIONS_DIR;

  return {
    ...env,
    MIGRATIONS_DIR: migrations,
    LLM_PROVIDER: provider,
    WEBHOOK_SIGNING_SECRET: env.WEBHOOK_SIGNING_SECRET ?? randomBytes(32).toString('hex'),
  };
}
