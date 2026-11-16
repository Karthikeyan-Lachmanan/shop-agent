import type { AgentEvent, TenantConfig } from '@shop-agent/core';
import type { KV } from './kv';
import type { ModelClient, ModelRegistry, Provider } from './model';
import type { Repo } from './repo/types';

export interface Deps {
  repo: Repo;
  kv: KV;
  /** Configured LLM providers (only those with an API key). */
  models: ModelRegistry;
  /** Used for tenants that don't pick a provider. */
  defaultProvider: Provider;
  now: () => Date;
  /** Server secret used to derive each tenant's webhook signing key. */
  webhookSigningSecret: string;
  fetch: typeof fetch;
}

export type Emit = (e: AgentEvent) => void | Promise<void>;

/** The tenant's provider and model, or null if that provider has no API key on this server. */
export function resolveModel(deps: Deps, cfg: TenantConfig): { provider: Provider; client: ModelClient; model: string } | null {
  const provider = cfg.provider ?? deps.defaultProvider;
  const entry = deps.models[provider];
  if (!entry) return null;
  return { provider, client: entry.client, model: cfg.model ?? entry.defaultModel };
}
