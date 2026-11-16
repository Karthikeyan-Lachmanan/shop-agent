import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// Shared contracts between the agent service, tenants and frontends.
// ─────────────────────────────────────────────────────────────────

export const LOCALES = ['en', 'ta'] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** A product as the agent sees it. `price` is the final selling price per unit. */
export const Product = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  nameTa: z.string().max(200).optional(),
  category: z.string().min(1).max(120),
  categoryTa: z.string().max(120).optional(),
  price: z.number().nonnegative(),
  mrp: z.number().nonnegative().optional(),
  inStock: z.boolean(),
  image: z.string().url().optional(),
  /** Extra search terms: Tanglish spellings, nicknames, Tamil words. */
  aliases: z.array(z.string().max(80)).max(20).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  /** Free-form facts the agent may cite, e.g. { sound: "low", kidsSafe: "yes" }. */
  attributes: z.record(z.string().max(40), z.string().max(200)).optional(),
});
export type Product = z.infer<typeof Product>;

export const Charge = z.object({
  label: z.string().min(1).max(60),
  labelTa: z.string().max(60).optional(),
  /** Percentage of the subtotal, rounded to the nearest rupee. */
  percent: z.number().min(0).max(100).optional(),
  flat: z.number().min(0).optional(),
}).refine((c) => c.percent !== undefined || c.flat !== undefined, 'charge needs percent or flat');
export type Charge = z.infer<typeof Charge>;

export const CustomerField = z.enum(['name', 'phone', 'address', 'email']);
export type CustomerField = z.infer<typeof CustomerField>;

export const TenantConfig = z.object({
  shopName: z.string().min(1).max(120),
  shopNameTa: z.string().max(120).optional(),
  persona: z.object({
    name: z.string().min(1).max(60).default('Shopping Assistant'),
    /** Short description of tone, e.g. "warm, playful, uses light Tanglish". */
    tone: z.string().max(300).default('friendly and concise'),
  }).default({}),
  languages: z.array(Locale).min(1).default(['en', 'ta']),
  defaultLocale: Locale.default('en'),
  currency: z.literal('INR').default('INR'),
  /** LLM provider. Unset = the server's default (whichever API key is configured). */
  provider: z.enum(['anthropic', 'openai']).optional(),
  /** Model id for that provider. Unset = the provider's default model on this server. */
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).default('low'),
  /** Cap per model response. Chat replies are short; this bounds runaway output cost. */
  maxTokens: z.number().int().min(1024).max(64000).default(4096),
  charges: z.array(Charge).max(5).default([]),
  minOrderValue: z.number().min(0).default(0),
  maxQtyPerItem: z.number().int().min(1).max(10000).default(500),
  requiredCustomerFields: z.array(CustomerField).default(['name', 'phone', 'address']),
  /** Who actually creates the order once the customer confirms. */
  orderExecutor: z.enum(['client', 'webhook']).default('client'),
  webhook: z.object({
    url: z.string().url(),
  }).optional(),
  /** Short reference notes the agent may rely on (safety rules, delivery FAQ…). */
  knowledge: z.array(z.string().max(4000)).max(10).default([]),
  allowedOrigins: z.array(z.string()).default([]),
  limits: z.object({
    messagesPer10Min: z.number().int().min(1).default(30),
    maxTurnsPerSession: z.number().int().min(1).default(60),
    maxToolRoundsPerTurn: z.number().int().min(1).max(10).default(6),
    /** Customer turns of history the model sees. Cart, customer details and order events are re-sent every turn, so older chat can go. */
    historyTurns: z.number().int().min(2).max(100).default(12),
    /** The window advances this many turns at a time, so the cached prompt prefix stays stable in between. */
    historyStep: z.number().int().min(1).max(50).default(6),
    /** Uncached input + output tokens one chat may use before it asks the customer to start over. */
    maxTokensPerSession: z.number().int().min(10_000).default(300_000),
    /** Uncached input + output tokens all chats of this tenant may use per UTC day. */
    dailyTokenBudget: z.number().int().min(10_000).default(5_000_000),
    sessionTtlHours: z.number().min(1).max(720).default(24),
  }).default({}),
});
export type TenantConfig = z.infer<typeof TenantConfig>;
export type TenantConfigInput = z.input<typeof TenantConfig>;

/** Quantities keyed by product id (the contents of one pack). */
export type Cart = Record<string, number>;

const ItemQty = z.object({ id: z.string().max(64), qty: z.number().int().min(1).max(10000) });

/** A ready-made set of products the shop sells together, e.g. a combo pack or gift hamper. */
export const Bundle = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  nameTa: z.string().max(120).optional(),
  description: z.string().max(400).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  items: z.array(ItemQty).min(1).max(200),
});
export type Bundle = z.infer<typeof Bundle>;

/**
 * One pack in the cart. A cart holds one or more packs: combo packs the
 * customer picked (bundleId set), or a single "main" pack for plain shopping.
 */
export interface CartGroup {
  /** Stable id chosen by the host (or the agent when it adds a pack). */
  key: string;
  bundleId?: string;
  title: string;
  items: Cart;
}

export interface CartState {
  groups: CartGroup[];
  /** The pack the customer is looking at right now, if any. */
  active?: string;
}

export const CartGroupInput = z.object({
  key: z.string().min(1).max(80).regex(/^[\w:.-]+$/, 'letters, digits, _ : . - only'),
  bundleId: z.string().max(64).optional(),
  title: z.string().min(1).max(120),
  items: z.array(ItemQty).max(500),
});
export type CartGroupInput = z.infer<typeof CartGroupInput>;

export const SessionContext = z.object({
  /** Where the widget is mounted, e.g. "combo-editor" or "store". */
  surface: z.string().max(40).default('store'),
  /** Human title of what is being built, e.g. the combo pack name. */
  title: z.string().max(120).optional(),
  /** Starting cart as one pack (simple hosts). Ignored when `groups` is given. */
  baseItems: z.array(ItemQty).max(500).default([]),
  /** Starting cart as several packs, e.g. the combo packs already in the host's cart. */
  groups: z.array(CartGroupInput).max(20).optional(),
  /** Key of the pack the customer is looking at. */
  active: z.string().max(80).optional(),
});
export type SessionContext = z.infer<typeof SessionContext>;

export const Customer = z.object({
  name: z.string().max(120).default(''),
  phone: z.string().max(20).default(''),
  address: z.string().max(500).default(''),
  email: z.string().max(200).default(''),
});
export type Customer = z.infer<typeof Customer>;

export interface CartLine {
  id: string;
  name: string;
  nameTa?: string;
  category: string;
  image?: string;
  qty: number;
  unitPrice: number;
  unitMrp?: number;
  lineTotal: number;
  inStock: boolean;
}

export interface GroupView {
  key: string;
  bundleId?: string;
  title: string;
  items: Cart;
  lines: CartLine[];
  units: number;
  subtotal: number;
  /** True when a bundle's contents differ from the shop's original bundle. */
  customized: boolean;
}

export interface CartView {
  /** Per-pack breakdown. */
  groups: GroupView[];
  /** All packs merged by product — what actually gets ordered. */
  lines: CartLine[];
  /** Ids in the cart that are unknown or out of stock — excluded from totals. */
  unavailable: string[];
  units: number;
  subtotal: number;
  mrpTotal: number;
  charges: { label: string; labelTa?: string; amount: number }[];
  total: number;
}

export type ActionType = 'place_order';
export type ActionStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'expired' | 'failed';

export interface PlaceOrderPayload {
  customer: Customer;
  cart: CartState;
  quote: CartView;
  context: SessionContext;
}
