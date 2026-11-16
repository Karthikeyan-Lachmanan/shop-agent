import type { Product } from './types';

export type CatalogIndex = Map<string, Product>;

export function indexCatalog(products: Product[]): CatalogIndex {
  return new Map(products.map((p) => [p.id, p]));
}

/** Stable ordering so the prompt (and its cache) only changes when the catalog does. */
export function sortCatalog(products: Product[]): Product[] {
  return [...products].sort((a, b) =>
    a.category === b.category ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.category < b.category ? -1 : 1,
  );
}

// ── Search ─────────────────────────────────────────────────────────
// Customers type product names three ways: English ("flower pot"),
// Tamil script ("பூச்சட்டி") and Tanglish with free spelling
// ("poochatti", "puchati"). Latin text is reduced to a loose phonetic
// key so spelling variants meet; Tamil text is matched as-is.

const TAMIL = /[஀-௿]/;

/** Loose key for Latin/Tanglish text: drops vowel length, doubled letters and h-digraphs. */
export function latinKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
    .replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u')
    .replace(/([a-z])h/g, '$1')
    .replace(/(.)\1+/g, '$1');
}

function tamilKey(s: string): string {
  return s.normalize('NFC').replace(/[\s​-‍]+/g, '');
}

function tokens(q: string): string[] {
  return q.normalize('NFC').toLowerCase().split(/[\s,./\-_()]+/).filter((t) => t.length > 0);
}

function haystacks(p: Product): { latin: string[]; tamil: string[] } {
  const all = [p.name, p.nameTa, p.category, p.categoryTa, p.id, ...(p.aliases ?? []), ...(p.tags ?? [])]
    .filter((x): x is string => !!x);
  return {
    latin: all.filter((x) => !TAMIL.test(x)).map(latinKey),
    tamil: all.filter((x) => TAMIL.test(x)).map(tamilKey),
  };
}

export interface SearchHit { product: Product; score: number }

export function searchProducts(products: Product[], query: string, limit = 10): SearchHit[] {
  const qTokens = tokens(query);
  if (qTokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const p of products) {
    const h = haystacks(p);
    let score = 0;
    for (const tok of qTokens) {
      if (TAMIL.test(tok)) {
        const k = tamilKey(tok);
        if (h.tamil.some((x) => x.includes(k))) score += 2;
      } else {
        const k = latinKey(tok);
        if (k.length < 2) continue;
        if (h.latin.some((x) => x === k)) score += 3;
        else if (h.latin.some((x) => x.includes(k))) score += 2;
      }
    }
    if (score > 0) hits.push({ product: p, score: score + (p.inStock ? 0.5 : 0) });
  }
  return hits.sort((a, b) => b.score - a.score || a.product.price - b.product.price).slice(0, limit);
}

// ── Prompt rendering ───────────────────────────────────────────────

/** Products above this count are not inlined in the prompt; the agent must search. */
export const INLINE_CATALOG_LIMIT = 800;

function line(p: Product): string {
  const parts = [
    p.id,
    p.nameTa ? `${p.name} / ${p.nameTa}` : p.name,
    p.categoryTa ? `${p.category} / ${p.categoryTa}` : p.category,
    `₹${p.price}` + (p.mrp && p.mrp > p.price ? ` (MRP ₹${p.mrp})` : ''),
    p.inStock ? 'in stock' : 'OUT OF STOCK',
  ];
  if (p.tags?.length) parts.push(`tags: ${p.tags.join(', ')}`);
  if (p.attributes && Object.keys(p.attributes).length) {
    parts.push(Object.entries(p.attributes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}: ${v}`).join('; '));
  }
  return parts.join(' | ');
}

export function renderCatalog(products: Product[]): string {
  return sortCatalog(products).map(line).join('\n');
}
