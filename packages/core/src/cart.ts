import { createHash } from 'node:crypto';
import type { CatalogIndex } from './catalog';
import type { Bundle, Cart, CartGroup, CartGroupInput, CartLine, CartState, CartView, Charge, GroupView, SessionContext } from './types';

export const MAIN_GROUP = 'main';

const toItems = (list: { id: string; qty: number }[]): Cart => {
  const cart: Cart = {};
  for (const { id, qty } of list) cart[id] = (cart[id] ?? 0) + qty;
  return cart;
};

export function groupFromInput(g: CartGroupInput): CartGroup {
  return { key: g.key, ...(g.bundleId ? { bundleId: g.bundleId } : {}), title: g.title, items: toItems(g.items) };
}

/** The starting cart: the host's packs, or one "main" pack from baseItems. Always at least one pack. */
export function cartFromContext(context: SessionContext): CartState {
  const groups = context.groups?.length
    ? context.groups.map(groupFromInput)
    : [{ key: MAIN_GROUP, title: context.title ?? 'Cart', items: toItems(context.baseItems) }];
  const active = context.active && groups.some((g) => g.key === context.active) ? context.active : groups.length === 1 ? groups[0]!.key : undefined;
  return { groups, ...(active ? { active } : {}) };
}

/** Accepts carts stored before packs existed (a bare {id: qty} map). */
export function normalizeCartState(raw: unknown): CartState {
  if (raw && typeof raw === 'object' && Array.isArray((raw as CartState).groups)) return raw as CartState;
  return { groups: [{ key: MAIN_GROUP, title: 'Cart', items: (raw as Cart) ?? {} }], active: MAIN_GROUP };
}

export function findGroup(state: CartState, key: string): CartGroup | undefined {
  return state.groups.find((g) => g.key === key);
}

/** Returns a new state; qty 0 removes the line. */
export function setQty(state: CartState, key: string, id: string, qty: number): CartState {
  return {
    ...state,
    groups: state.groups.map((g) => {
      if (g.key !== key) return g;
      const items = { ...g.items };
      if (qty <= 0) delete items[id];
      else items[id] = qty;
      return { ...g, items };
    }),
  };
}

export function addGroup(state: CartState, group: CartGroup): CartState {
  return { ...state, groups: [...state.groups, group], active: group.key };
}

export function removeGroup(state: CartState, key: string): CartState {
  const groups = state.groups.filter((g) => g.key !== key);
  return { groups, ...(state.active && state.active !== key ? { active: state.active } : {}) };
}

export function replaceGroupItems(state: CartState, key: string, items: Cart): CartState {
  return { ...state, groups: state.groups.map((g) => (g.key === key ? { ...g, items: { ...items } } : g)) };
}

/** A key for a newly added pack that doesn't collide with existing ones. */
export function newGroupKey(state: CartState, bundleId: string): string {
  for (let n = 1; ; n++) {
    const key = `${bundleId}-${n}`.replace(/[^\w:.-]/g, '-');
    if (!state.groups.some((g) => g.key === key)) return key;
  }
}

/** All packs merged by product — the quantities that get ordered. */
export function mergedItems(state: CartState): Cart {
  const out: Cart = {};
  for (const g of state.groups) for (const [id, q] of Object.entries(g.items)) if (q > 0) out[id] = (out[id] ?? 0) + q;
  return out;
}

const sortedEntries = (c: Cart) => Object.entries(c).filter(([, q]) => q > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Order-independent fingerprint, used to make sure a confirmed order matches what was shown. */
export function cartHash(state: CartState): string {
  const groups = state.groups.map((g) => [g.key, g.bundleId ?? '', sortedEntries(g.items)]);
  return createHash('sha256').update(JSON.stringify(groups)).digest('hex').slice(0, 32);
}

export function sameItems(a: Cart, b: Cart): boolean {
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

export function chargeAmount(charge: Charge, subtotal: number): number {
  if (subtotal <= 0) return 0;
  const pct = charge.percent !== undefined ? Math.round((subtotal * charge.percent) / 100) : 0;
  return pct + (charge.flat ?? 0);
}

function priceLines(items: Cart, index: CatalogIndex, unavailable: Set<string>): CartLine[] {
  const lines: CartLine[] = [];
  for (const [id, qty] of Object.entries(items)) {
    if (qty <= 0) continue;
    const p = index.get(id);
    if (!p || !p.inStock) {
      unavailable.add(id);
      if (!p) continue;
    }
    lines.push({
      id, name: p.name, nameTa: p.nameTa, category: p.category, image: p.image, qty,
      unitPrice: p.price, unitMrp: p.mrp, lineTotal: p.inStock ? p.price * qty : 0, inStock: p.inStock,
    });
  }
  return lines;
}

const sum = (lines: CartLine[], f: (l: CartLine) => number) => lines.filter((l) => l.inStock).reduce((s, l) => s + f(l), 0);

/**
 * Prices a cart against the live catalog. All money the customer sees comes
 * from here, never the model. Pass bundles to flag customized packs.
 */
export function quote(state: CartState, index: CatalogIndex, charges: Charge[], bundles: Map<string, Bundle> = new Map()): CartView {
  const unavailable = new Set<string>();
  const groups: GroupView[] = state.groups.map((g) => {
    const lines = priceLines(g.items, index, unavailable);
    const bundle = g.bundleId ? bundles.get(g.bundleId) : undefined;
    return {
      key: g.key, ...(g.bundleId ? { bundleId: g.bundleId } : {}), title: g.title, items: { ...g.items }, lines,
      units: sum(lines, (l) => l.qty), subtotal: sum(lines, (l) => l.lineTotal),
      customized: bundle ? !sameItems(g.items, toItems(bundle.items)) : false,
    };
  });
  const lines = priceLines(mergedItems(state), index, new Set());
  const subtotal = sum(lines, (l) => l.lineTotal);
  const chargeLines = charges.map((c) => ({ label: c.label, labelTa: c.labelTa, amount: chargeAmount(c, subtotal) }));
  return {
    groups,
    lines,
    unavailable: [...unavailable],
    units: sum(lines, (l) => l.qty),
    subtotal,
    mrpTotal: sum(lines, (l) => (l.unitMrp ?? l.unitPrice) * l.qty),
    charges: chargeLines,
    total: subtotal + chargeLines.reduce((s, c) => s + c.amount, 0),
  };
}

/** Compact JSON for tool results and the per-turn <cart_state> block. */
export function cartSummaryForModel(view: CartView, active?: string) {
  return {
    packs: view.groups.map((g) => ({
      pack: g.key,
      title: g.title,
      ...(g.bundleId ? { comboId: g.bundleId, customized: g.customized } : {}),
      items: g.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, ...(l.inStock ? {} : { outOfStock: true }) })),
      subtotal: g.subtotal,
    })),
    ...(active ? { activePack: active } : {}),
    units: view.units,
    subtotal: view.subtotal,
    charges: view.charges.map((c) => ({ label: c.label, amount: c.amount })),
    total: view.total,
    ...(view.unavailable.length ? { unavailable: view.unavailable } : {}),
  };
}
