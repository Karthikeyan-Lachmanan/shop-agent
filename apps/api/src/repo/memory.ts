import { randomUUID } from 'node:crypto';
import type { ActionRecord, CatalogRecord, MessageRecord, Repo, SessionRecord, TenantRecord, UsageRecord } from './types';

/** In-process store for tests and local runs without Postgres. Not for production. */
export class MemoryRepo implements Repo {
  private tenants = new Map<string, TenantRecord & { secretKeyHash: string }>();
  private catalogs = new Map<string, CatalogRecord>();
  private sessions = new Map<string, SessionRecord>();
  private messages = new Map<string, MessageRecord[]>();
  private actions = new Map<string, ActionRecord>();
  readonly usage: UsageRecord[] = [];

  async createTenant(t: Parameters<Repo['createTenant']>[0]) {
    if (this.tenants.has(t.id)) throw new Error(`tenant ${t.id} exists`);
    this.tenants.set(t.id, { ...t });
  }
  async getTenant(id: string) {
    return strip(this.tenants.get(id));
  }
  async getTenantByPublishableKey(key: string) {
    return strip([...this.tenants.values()].find((t) => t.publishableKey === key));
  }
  async getTenantBySecretHash(hash: string) {
    return strip([...this.tenants.values()].find((t) => t.secretKeyHash === hash));
  }
  async updateTenantConfig(id: string, config: TenantRecord['config']) {
    const t = this.tenants.get(id);
    if (t) t.config = config;
  }

  async getCatalog(tenantId: string) {
    return this.catalogs.get(tenantId) ?? null;
  }
  async putCatalog(tenantId: string, products: CatalogRecord['products'], bundles: CatalogRecord['bundles'] = []) {
    const prev = this.catalogs.get(tenantId);
    const rec = { version: (prev?.version ?? 0) + 1, products, bundles, updatedAt: new Date() };
    this.catalogs.set(tenantId, rec);
    return rec;
  }

  async createSession(s: Parameters<Repo['createSession']>[0]) {
    const now = new Date();
    const rec: SessionRecord = { ...s, id: randomUUID(), cartHistory: [], pendingEvents: [], status: 'active', turnCount: 0, customer: {}, tokensUsed: 0, createdAt: now, updatedAt: now };
    this.sessions.set(rec.id, rec);
    return structuredClone(rec);
  }
  async getSession(tenantId: string, id: string) {
    const s = this.sessions.get(id);
    return s && s.tenantId === tenantId ? structuredClone(s) : null;
  }
  async updateSession(tenantId: string, id: string, patch: Parameters<Repo['updateSession']>[2]) {
    const s = this.sessions.get(id);
    if (s && s.tenantId === tenantId) Object.assign(s, structuredClone(patch), { updatedAt: new Date() });
  }

  async listMessages(sessionId: string) {
    return structuredClone(this.messages.get(sessionId) ?? []);
  }
  async appendMessages(sessionId: string, msgs: Parameters<Repo['appendMessages']>[1]) {
    const list = this.messages.get(sessionId) ?? [];
    for (const m of msgs) list.push({ ...structuredClone(m), seq: list.length, createdAt: new Date() });
    this.messages.set(sessionId, list);
  }

  async createAction(a: Parameters<Repo['createAction']>[0]) {
    const rec: ActionRecord = { ...structuredClone(a), id: randomUUID(), result: null, createdAt: new Date() };
    this.actions.set(rec.id, rec);
    return structuredClone(rec);
  }
  async getAction(tenantId: string, id: string) {
    const a = this.actions.get(id);
    return a && a.tenantId === tenantId ? structuredClone(a) : null;
  }
  async getOpenAction(tenantId: string, sessionId: string) {
    const open = [...this.actions.values()]
      .filter((a) => a.tenantId === tenantId && a.sessionId === sessionId && (a.status === 'pending' || a.status === 'confirmed'))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ? structuredClone(open[0]) : null;
  }
  async updateAction(tenantId: string, id: string, patch: Parameters<Repo['updateAction']>[2]) {
    const a = this.actions.get(id);
    if (a && a.tenantId === tenantId) Object.assign(a, structuredClone(patch));
  }

  async recordUsage(u: UsageRecord) {
    this.usage.push(u);
  }
}

function strip(t: (TenantRecord & { secretKeyHash: string }) | undefined): TenantRecord | null {
  if (!t) return null;
  const { secretKeyHash: _omit, ...rest } = t;
  return structuredClone(rest);
}
