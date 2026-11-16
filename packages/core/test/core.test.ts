import { describe, expect, it } from 'vitest';
import {
  TenantConfig, buildSystemPrompt, cartHash, detectLocale, formatINR, indexCatalog, isCancelKeyword, isConfirmKeyword,
  latinKey, normalizePhone, quote, searchProducts, t, validateCustomer, type Product,
} from '../src';

const products: Product[] = [
  { id: 'FP001', name: 'Flower Pot Big', nameTa: 'பூச்சட்டி பெரியது', category: 'Flower Pots', categoryTa: 'பூச்சட்டி', price: 120, mrp: 600, inStock: true, aliases: ['poochatti', 'flowerpot'] },
  { id: 'SP001', name: '10cm Sparklers', nameTa: 'மத்தாப்பு 10 செ.மீ', category: 'Sparklers', price: 40, mrp: 200, inStock: true, aliases: ['mathappu', 'kambi mathappu'] },
  { id: 'RK001', name: 'Rocket Bomb', nameTa: 'ராக்கெட்', category: 'Rockets', price: 90, inStock: false },
];
const index = indexCatalog(products);
const one = (items: Record<string, number>) => ({ groups: [{ key: 'main', title: 'Cart', items }] });

describe('locale', () => {
  it('switches to Tamil on Tamil script and keeps the current locale for Latin text', () => {
    expect(detectLocale('பூச்சட்டி விலை என்ன?', 'en')).toBe('ta');
    expect(detectLocale('poochatti price enna?', 'ta')).toBe('ta');
    expect(detectLocale('what is the price?', 'en')).toBe('en');
  });

  it('formats rupees with Indian grouping', () => {
    expect(formatINR(125000)).toBe('₹1,25,000');
  });

  it('has every server message in Tamil', () => {
    expect(t('ta', 'order_placed', { orderId: 'NC1', shop: 'Naga' })).toContain('#NC1');
    expect(t('ta', 'confirm_prompt', { units: 3, total: '₹500' })).toContain('உறுதி');
  });
});

describe('confirmation keywords', () => {
  it('accepts only explicit confirm words in English and Tamil', () => {
    for (const w of ['CONFIRM', 'confirm.', ' Confirm ', 'உறுதி', 'உறுதிப்படுத்து']) expect(isConfirmKeyword(w)).toBe(true);
    for (const w of ['ok', 'yes', 'சரி', 'ஆம்', 'confirm but add 2 more', 'dont confirm']) expect(isConfirmKeyword(w)).toBe(false);
    expect(isCancelKeyword('ரத்து')).toBe(true);
    expect(isCancelKeyword('CANCEL')).toBe(true);
  });
});

describe('search', () => {
  it('finds products by Tamil script', () => {
    expect(searchProducts(products, 'பூச்சட்டி')[0]?.product.id).toBe('FP001');
  });
  it('finds products by loose Tanglish spellings', () => {
    expect(latinKey('mathaappu')).toBe(latinKey('mathappu'));
    expect(searchProducts(products, 'mathaapu')[0]?.product.id).toBe('SP001');
    expect(searchProducts(products, 'puchatti')[0]?.product.id).toBe('FP001');
  });
  it('finds products by English name', () => {
    expect(searchProducts(products, 'rocket')[0]?.product.id).toBe('RK001');
  });
});

describe('cart', () => {
  it('prices against the catalog and applies percent charges like the shop does', () => {
    const v = quote(one({ FP001: 5, SP001: 10 }), index, [{ label: 'Packing', percent: 3 }]);
    expect(v.subtotal).toBe(1000);
    expect(v.charges[0]?.amount).toBe(30);
    expect(v.total).toBe(1030);
    expect(v.mrpTotal).toBe(5000);
  });
  it('excludes unknown and out-of-stock items from totals', () => {
    const v = quote(one({ FP001: 1, RK001: 2, NOPE: 1 }), index, []);
    expect(v.subtotal).toBe(120);
    expect(v.unavailable.sort()).toEqual(['NOPE', 'RK001']);
  });
  it('hashes carts independent of key order', () => {
    expect(cartHash(one({ a: 1, b: 2 }))).toBe(cartHash(one({ b: 2, a: 1 })));
    expect(cartHash(one({ a: 1 }))).not.toBe(cartHash(one({ a: 2 })));
  });
});

describe('customer validation', () => {
  it('normalizes Indian mobile numbers', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('5876543210')).toBeNull();
  });
  it('reports missing required fields', () => {
    const { errors } = validateCustomer({ name: 'Ravi', phone: '98765', address: '', email: '' }, ['name', 'phone', 'address']);
    expect(Object.keys(errors).sort()).toEqual(['address', 'phone']);
  });
});

describe('system prompt', () => {
  const cfg = TenantConfig.parse({ shopName: 'Naga Crackers', shopNameTa: 'நாகா பட்டாசு', charges: [{ label: 'Packing', percent: 3 }] });
  it('is deterministic regardless of catalog order (so it stays cached)', () => {
    const a = buildSystemPrompt(cfg, products);
    const b = buildSystemPrompt(cfg, [...products].reverse());
    expect(a).toEqual(b);
  });
  it('includes Tamil handling and Tamil product names when Tamil is enabled', () => {
    const { instructions, catalog } = buildSystemPrompt(cfg, products);
    expect(instructions).toContain('Tanglish');
    expect(instructions).toContain('உறுதி');
    expect(catalog).toContain('பூச்சட்டி பெரியது');
  });
  it('requires respectful Tamil address and forbids informal terms like "da"', () => {
    const { instructions } = buildSystemPrompt(cfg, products);
    expect(instructions).toContain('நீங்கள்');
    expect(instructions).toContain('"da"');
    expect(instructions).toContain('even if the customer talks to you that way');
  });

  it('drops Tamil instructions for English-only tenants', () => {
    const en = TenantConfig.parse({ shopName: 'X', languages: ['en'] });
    expect(buildSystemPrompt(en, products).instructions).not.toContain('Tanglish');
  });
});
