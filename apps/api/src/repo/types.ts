import type Anthropic from '@anthropic-ai/sdk';
import type { ActionStatus, ActionType, Bundle, CartState, Customer, Locale, PlaceOrderPayload, Product, SessionContext, TenantConfig } from '@shop-agent/core';

export interface TenantRecord {
  id: string;
  name: string;
  config: TenantConfig;
  publishableKey: string;
}

export interface CatalogRecord {
  version: number;
  products: Product[];
  bundles: Bundle[];
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  locale: Locale;
  context: SessionContext;
  cart: CartState;
  /** Previous carts, newest last, for undo. */
  cartHistory: CartState[];
  /** System notes to hand the model on its next turn, e.g. "order #123 placed". */
  pendingEvents: string[];
  status: 'active' | 'ordered' | 'closed';
  turnCount: number;
  customer: Partial<Customer>;
  tokensUsed: number;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageContent = Anthropic.Beta.BetaContentBlockParam[] | Anthropic.Beta.BetaContentBlock[];

export interface MessageRecord {
  seq: number;
  role: 'user' | 'assistant';
  content: MessageContent;
  displayText: string | null;
  createdAt: Date;
}

export interface ActionRecord {
  id: string;
  sessionId: string;
  tenantId: string;
  type: ActionType;
  status: ActionStatus;
  payload: PlaceOrderPayload;
  cartHash: string;
  result: { orderId?: string; error?: string } | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface UsageRecord {
  tenantId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type SessionPatch = Partial<Pick<SessionRecord, 'locale' | 'cart' | 'cartHistory' | 'pendingEvents' | 'status' | 'turnCount' | 'customer' | 'tokensUsed'>>;

/** Storage boundary. Every method that touches session data is scoped by tenant. */
export interface Repo {
  createTenant(t: { id: string; name: string; config: TenantConfig; publishableKey: string; secretKeyHash: string }): Promise<void>;
  getTenant(id: string): Promise<TenantRecord | null>;
  getTenantByPublishableKey(key: string): Promise<TenantRecord | null>;
  getTenantBySecretHash(hash: string): Promise<TenantRecord | null>;
  updateTenantConfig(id: string, config: TenantConfig): Promise<void>;

  getCatalog(tenantId: string): Promise<CatalogRecord | null>;
  putCatalog(tenantId: string, products: Product[], bundles?: Bundle[]): Promise<CatalogRecord>;

  createSession(s: Pick<SessionRecord, 'tenantId' | 'locale' | 'context' | 'cart'>): Promise<SessionRecord>;
  getSession(tenantId: string, id: string): Promise<SessionRecord | null>;
  updateSession(tenantId: string, id: string, patch: SessionPatch): Promise<void>;

  listMessages(sessionId: string): Promise<MessageRecord[]>;
  /** Appends in order, assigning seq after the current last message. */
  appendMessages(sessionId: string, msgs: Omit<MessageRecord, 'seq' | 'createdAt'>[]): Promise<void>;

  createAction(a: Omit<ActionRecord, 'id' | 'createdAt' | 'result'>): Promise<ActionRecord>;
  getAction(tenantId: string, id: string): Promise<ActionRecord | null>;
  getOpenAction(tenantId: string, sessionId: string): Promise<ActionRecord | null>;
  updateAction(tenantId: string, id: string, patch: Partial<Pick<ActionRecord, 'status' | 'result'>>): Promise<void>;

  recordUsage(u: UsageRecord): Promise<void>;
}
