import type { ActionType, CartState, CartView, Locale, PlaceOrderPayload } from './types';

// Events streamed to frontends. Every event that carries UI also has
// enough plain data for a text-only frontend to render a fallback.

export interface ProductCard {
  id: string;
  name: string;
  nameTa?: string;
  category: string;
  image?: string;
  price: number;
  mrp?: number;
  inStock: boolean;
  inCartQty: number;
}

export type AgentEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'text'; text: string; source: 'model' | 'system' }
  | { type: 'ui.products'; products: ProductCard[] }
  /** `state` is the raw packs (keys, combo ids, quantities) so the host can mirror changes. */
  | { type: 'ui.cart'; cart: CartView; state: CartState; canUndo: boolean }
  | { type: 'ui.confirm'; actionId: string; actionType: ActionType; summary: PlaceOrderPayload; expiresAt: string; prompt: string }
  /** The tenant's frontend must now run the action and report back (client executor). */
  | { type: 'action.execute'; actionId: string; actionType: ActionType; payload: PlaceOrderPayload }
  | { type: 'action.completed'; actionId: string; orderId: string }
  | { type: 'action.cancelled'; actionId: string }
  | { type: 'locale'; locale: Locale }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number } };

export type AgentEventType = AgentEvent['type'];
