import { describe, expect, it } from 'vitest';
import type { Bundle } from '@shop-agent/core';
import { CATALOG, lastUserText, setup, step, text, toolUse } from './helpers';

const BUNDLES: Bundle[] = [
  { id: 'kutty', name: 'Kutty Pattasu Pack', nameTa: 'குட்டி பட்டாசு பேக்', items: [{ id: 'SP001', qty: 10 }, { id: 'FP001', qty: 2 }] },
  { id: 'reels', name: 'Reels Raja Pack', items: [{ id: 'FP001', qty: 5 }] },
];

/** Customer has Kutty in the cart and is looking at Reels (not in the cart yet). */
const TWO_PACKS = {
  surface: 'combo-page',
  groups: [
    { key: 'kutty-1', bundleId: 'kutty', title: 'Kutty Pattasu Pack', items: [{ id: 'SP001', qty: 10 }, { id: 'FP001', qty: 2 }] },
    { key: 'reels-draft', bundleId: 'reels', title: 'Reels Raja Pack', items: [{ id: 'FP001', qty: 5 }] },
  ],
  active: 'reels-draft',
};
const DETAILS = { name: 'Ravi', phone: '9876543210', address: '12 Gandhi Street, Sivakasi 626123', email: '' };

async function withPacks() {
  const h = await setup();
  await h.repo.putCatalog('naga', CATALOG, BUNDLES);
  const created = await h.call('POST', '/v1/sessions', { context: TWO_PACKS });
  return { h, sid: created.body.id as string, created: created.body };
}

describe('multiple combo packs in one chat', () => {
  it('shows every pack, the active one, and the combo list to the model', async () => {
    const { h, sid, created } = await withPacks();
    expect(created.cart.groups.map((g: { key: string; subtotal: number }) => [g.key, g.subtotal])).toEqual([['kutty-1', 640], ['reels-draft', 600]]);
    expect(created.cart.subtotal).toBe(1240);

    h.model.push(step([text('You have two packs.')]));
    await h.say(sid, 'what is in my cart?');
    const req = h.model.requests[0]!;
    const ctx = lastUserText(req);
    expect(ctx).toContain('"pack":"kutty-1"');
    expect(ctx).toContain('"pack":"reels-draft"');
    expect(ctx).toContain('"activePack":"reels-draft"');
    const system = req.system.map((b) => b.text).join('\n');
    expect(system).toContain('## Combo packs (2)');
    expect(system).toContain('kutty | Kutty Pattasu Pack / குட்டி பட்டாசு பேக் | ₹640');
  });

  it('changes only the pack it is told to', async () => {
    const { h, sid } = await withPacks();
    h.model.push(step([toolUse('set_item_qty', { pack: 'kutty-1', id: 'FP001', qty: 4 })], 'tool_use'), step([text('Done.')]));
    const ev = await h.say(sid, 'kutty pack la innum 2 flower pot');
    const cart = ev.find((e) => e.type === 'ui.cart');
    expect(cart.state.groups.map((g: { items: object }) => g.items)).toEqual([{ SP001: 10, FP001: 4 }, { FP001: 5 }]);
    expect(cart.cart.groups[0].customized).toBe(true);
    expect(cart.cart.groups[1].customized).toBe(false);
    // The merged order lines add the same product across packs.
    expect(cart.cart.lines.find((l: { id: string }) => l.id === 'FP001').qty).toBe(9);
  });

  it('rejects an unknown pack with the list of real ones', async () => {
    const { h, sid } = await withPacks();
    h.model.push(step([toolUse('set_item_qty', { pack: 'nope', id: 'FP001', qty: 1 })], 'tool_use'), step([text('Which pack?')]));
    await h.say(sid, 'add one');
    const result = (h.model.requests[1]!.messages.at(-1)!.content as { content: string; is_error: boolean }[])[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('"kutty-1" (Kutty Pattasu Pack)');
  });

  it('adds combos (even the same one twice), removes and resets packs', async () => {
    const { h, sid } = await withPacks();
    h.model.push(
      step([toolUse('add_pack', { combo_id: 'kutty' }), toolUse('add_pack', { combo_id: 'reels' })], 'tool_use'),
      step([text('Added both.')]),
    );
    let ev = await h.say(sid, 'add one more kutty pack and a reels pack');
    let state = ev.filter((e) => e.type === 'ui.cart').at(-1).state;
    expect(state.groups.map((g: { key: string }) => g.key)).toEqual(['kutty-1', 'reels-draft', 'kutty-2', 'reels-1']);
    expect(state.groups[2].items).toEqual({ SP001: 10, FP001: 2 });
    expect(state.active).toBe('reels-1');

    h.model.push(
      step([toolUse('set_item_qty', { pack: 'kutty-2', id: 'SP001', qty: 0 }), toolUse('remove_pack', { pack: 'reels-1' })], 'tool_use'),
      step([toolUse('reset_pack', { pack: 'kutty-2' })], 'tool_use'),
      step([text('Reset.')]),
    );
    ev = await h.say(sid, 'remove sparklers from the 2nd kutty, drop the new reels... actually reset kutty 2');
    state = ev.filter((e) => e.type === 'ui.cart').at(-1).state;
    expect(state.groups.map((g: { key: string }) => g.key)).toEqual(['kutty-1', 'reels-draft', 'kutty-2']);
    expect(state.groups[2].items).toEqual({ SP001: 10, FP001: 2 });

    h.model.push(step([toolUse('add_pack', { combo_id: 'diwali' })], 'tool_use'), step([text('No such combo.')]));
    await h.say(sid, 'add diwali pack');
    expect((h.model.requests.at(-1)!.messages.at(-1)!.content as { is_error: boolean }[])[0]!.is_error).toBe(true);
  });

  it('checks out every pack in one order', async () => {
    const { h, sid } = await withPacks();
    h.model.push(step([toolUse('request_checkout', DETAILS)], 'tool_use'), step([text('Please confirm.')]));
    const confirm = (await h.say(sid, 'order everything')).find((e) => e.type === 'ui.confirm');
    expect(confirm.summary.cart.groups).toHaveLength(2);
    expect(confirm.summary.quote.subtotal).toBe(1240);
    expect(confirm.summary.quote.total).toBe(1240 + Math.round(1240 * 0.03));
    const exec = (await h.say(sid, 'CONFIRM')).find((e) => e.type === 'action.execute');
    expect(exec.payload.cart.groups.map((g: { title: string }) => g.title)).toEqual(['Kutty Pattasu Pack', 'Reels Raja Pack']);
  });

  it('mirrors page changes: packs added in the shop UI and which pack is open', async () => {
    const { h, sid } = await withPacks();
    const put = await h.call('PUT', `/v1/sessions/${sid}/cart`, {
      groups: [...TWO_PACKS.groups, { key: 'reels-2', bundleId: 'reels', title: 'Reels Raja Pack', items: [{ id: 'FP001', qty: 6 }] }],
      active: 'kutty-1',
    });
    expect(put.body.cart.groups).toHaveLength(3);
    expect(put.body.cart.groups[2].customized).toBe(true);
    expect((await h.call('PUT', `/v1/sessions/${sid}/cart`, { groups: TWO_PACKS.groups, active: 'missing' })).status).toBe(400);
    expect((await h.call('PUT', `/v1/sessions/${sid}/cart`, { groups: [TWO_PACKS.groups[0], TWO_PACKS.groups[0]] })).status).toBe(400);

    h.model.push(step([text('ok')]));
    await h.say(sid, 'hi');
    const ctx = lastUserText(h.model.requests[0]!);
    expect(ctx).toContain('now looking at the pack "Kutty Pattasu Pack"');
    expect(ctx).toContain('"pack":"reels-2"');
  });

  it('validates combos when the catalog is pushed', async () => {
    const h = await setup();
    const bad = await h.call('PUT', '/v1/catalog', { products: CATALOG, bundles: [{ id: 'x', name: 'X', items: [{ id: 'NOPE', qty: 1 }] }] }, 'sk_test');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('NOPE');
    const ok = await h.call('PUT', '/v1/catalog', { products: CATALOG, bundles: BUNDLES }, 'sk_test');
    expect(ok.body).toMatchObject({ count: 3, bundles: 2 });
  });
});
