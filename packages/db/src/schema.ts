import { sql } from 'drizzle-orm';
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// Every row below a tenant carries tenant_id so queries can always be scoped.

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: jsonb('config').notNull(),
  publishableKey: text('publishable_key').notNull().unique(),
  secretKeyHash: text('secret_key_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const catalogs = pgTable('catalogs', {
  tenantId: text('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  products: jsonb('products').notNull(),
  bundles: jsonb('bundles').notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  context: jsonb('context').notNull(),
  cart: jsonb('cart').notNull(),
  cartHistory: jsonb('cart_history').notNull().default(sql`'[]'::jsonb`),
  pendingEvents: jsonb('pending_events').notNull().default(sql`'[]'::jsonb`),
  status: text('status').notNull().default('active'),
  turnCount: integer('turn_count').notNull().default(0),
  /** Delivery details collected so far, re-sent each turn so trimmed history can't lose them. */
  customer: jsonb('customer').notNull().default(sql`'{}'::jsonb`),
  /** Uncached input + output tokens used by this chat. */
  tokensUsed: integer('tokens_used').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_tenant_idx').on(t.tenantId, t.createdAt)]);

/** Full Messages API content, stored as returned so history replays byte-for-byte. */
export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role').notNull(),
  content: jsonb('content').notNull(),
  /** What the customer typed / saw, for transcripts. Null for tool plumbing. */
  displayText: text('display_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('messages_session_seq_idx').on(t.sessionId, t.seq)]);

export const actions = pgTable('actions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull(),
  payload: jsonb('payload').notNull(),
  cartHash: text('cart_hash').notNull(),
  result: jsonb('result'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('actions_session_idx').on(t.sessionId, t.status)]);

export const usage = pgTable('usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('usage_tenant_idx').on(t.tenantId, t.createdAt)]);
