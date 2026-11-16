import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { TenantConfig, normalizeCartState } from '@shop-agent/core';
import { schema, type Database } from '@shop-agent/db';
import type { ActionRecord, CatalogRecord, MessageRecord, Repo, SessionRecord, TenantRecord, UsageRecord } from './types';

const { tenants, catalogs, sessions, messages, actions, usage } = schema;

export class PostgresRepo implements Repo {
  constructor(private db: Database) {}

  async createTenant(t: Parameters<Repo['createTenant']>[0]) {
    await this.db.insert(tenants).values(t);
  }
  async getTenant(id: string) {
    return toTenant((await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1))[0]);
  }
  async getTenantByPublishableKey(key: string) {
    return toTenant((await this.db.select().from(tenants).where(eq(tenants.publishableKey, key)).limit(1))[0]);
  }
  async getTenantBySecretHash(hash: string) {
    return toTenant((await this.db.select().from(tenants).where(eq(tenants.secretKeyHash, hash)).limit(1))[0]);
  }
  async updateTenantConfig(id: string, config: TenantRecord['config']) {
    await this.db.update(tenants).set({ config, updatedAt: new Date() }).where(eq(tenants.id, id));
  }

  async getCatalog(tenantId: string): Promise<CatalogRecord | null> {
    const row = (await this.db.select().from(catalogs).where(eq(catalogs.tenantId, tenantId)).limit(1))[0];
    return row ? { version: row.version, products: row.products as CatalogRecord['products'], bundles: (row.bundles ?? []) as CatalogRecord['bundles'], updatedAt: row.updatedAt } : null;
  }
  async putCatalog(tenantId: string, products: CatalogRecord['products'], bundles: CatalogRecord['bundles'] = []): Promise<CatalogRecord> {
    const [row] = await this.db
      .insert(catalogs)
      .values({ tenantId, products, bundles, version: 1 })
      .onConflictDoUpdate({ target: catalogs.tenantId, set: { products, bundles, version: sql`${catalogs.version} + 1`, updatedAt: new Date() } })
      .returning();
    return { version: row!.version, products, bundles, updatedAt: row!.updatedAt };
  }

  async createSession(s: Parameters<Repo['createSession']>[0]): Promise<SessionRecord> {
    const [row] = await this.db.insert(sessions).values(s).returning();
    return toSession(row!);
  }
  async getSession(tenantId: string, id: string) {
    const row = (await this.db.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId))).limit(1))[0];
    return row ? toSession(row) : null;
  }
  async updateSession(tenantId: string, id: string, patch: Parameters<Repo['updateSession']>[2]) {
    await this.db.update(sessions).set({ ...patch, updatedAt: new Date() }).where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId)));
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(messages.seq);
    return rows.map((r) => ({ seq: r.seq, role: r.role as MessageRecord['role'], content: r.content as MessageRecord['content'], displayText: r.displayText, createdAt: r.createdAt }));
  }
  async appendMessages(sessionId: string, msgs: Parameters<Repo['appendMessages']>[1]) {
    if (msgs.length === 0) return;
    // Callers hold the session lock; the unique (session_id, seq) index is the backstop.
    const [last] = await this.db.select({ seq: messages.seq }).from(messages).where(eq(messages.sessionId, sessionId)).orderBy(desc(messages.seq)).limit(1);
    const start = (last?.seq ?? -1) + 1;
    await this.db.insert(messages).values(msgs.map((m, i) => ({ sessionId, seq: start + i, role: m.role, content: m.content, displayText: m.displayText })));
  }

  async createAction(a: Parameters<Repo['createAction']>[0]): Promise<ActionRecord> {
    const [row] = await this.db.insert(actions).values(a).returning();
    return toAction(row!);
  }
  async getAction(tenantId: string, id: string) {
    const row = (await this.db.select().from(actions).where(and(eq(actions.id, id), eq(actions.tenantId, tenantId))).limit(1))[0];
    return row ? toAction(row) : null;
  }
  async getOpenAction(tenantId: string, sessionId: string) {
    const row = (await this.db.select().from(actions)
      .where(and(eq(actions.tenantId, tenantId), eq(actions.sessionId, sessionId), inArray(actions.status, ['pending', 'confirmed'])))
      .orderBy(desc(actions.createdAt)).limit(1))[0];
    return row ? toAction(row) : null;
  }
  async updateAction(tenantId: string, id: string, patch: Parameters<Repo['updateAction']>[2]) {
    await this.db.update(actions).set({ ...patch, updatedAt: new Date() }).where(and(eq(actions.id, id), eq(actions.tenantId, tenantId)));
  }

  async recordUsage(u: UsageRecord) {
    await this.db.insert(usage).values(u);
  }
}

function toTenant(row: typeof tenants.$inferSelect | undefined): TenantRecord | null {
  if (!row) return null;
  return { id: row.id, name: row.name, config: TenantConfig.parse(row.config), publishableKey: row.publishableKey };
}

function toSession(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locale: row.locale as SessionRecord['locale'],
    context: row.context as SessionRecord['context'],
    cart: normalizeCartState(row.cart),
    cartHistory: (row.cartHistory as unknown[]).map(normalizeCartState),
    pendingEvents: row.pendingEvents as string[],
    status: row.status as SessionRecord['status'],
    turnCount: row.turnCount,
    customer: row.customer as SessionRecord['customer'],
    tokensUsed: row.tokensUsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAction(row: typeof actions.$inferSelect): ActionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tenantId: row.tenantId,
    type: row.type as ActionRecord['type'],
    status: row.status as ActionRecord['status'],
    payload: row.payload as ActionRecord['payload'],
    cartHash: row.cartHash,
    result: row.result as ActionRecord['result'],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
