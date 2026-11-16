import { describe, expect, it } from 'vitest';
import { parseSSE } from '@shop-agent/sdk';
import { signWebhook, webhookKey } from '../src/actions';
import { CATALOG, lastUserText, setup, step, text, toolUse } from './helpers';

const COMBO = { surface: 'combo-editor', title: 'Kutty Pattasu Pack', baseItems: [{ id: 'SP001', qty: 10 }] };
const DETAILS = { name: 'Ravi', phone: '+91 98765 43210', address: '12 Gandhi Street, Sivakasi 626123', email: 'ravi@example.com' };

describe('Tamil combo customisation → order, end to end', () => {
  it('edits the cart, prepares a summary, confirms by Tamil keyword and records the order', async () => {
    const h = await setup({ requiredCustomerFields: ['name', 'phone', 'address', 'email'] });
    const created = await h.call('POST', '/v1/sessions', { context: COMBO });
    expect(created.status).toBe(201);
    const sid = created.body.id;
    expect(created.body.cart.subtotal).toBe(400); // 10 × ₹40 from the combo

    // 1. Customer asks in Tamil to add flower pots.
    h.model.push(
      step([toolUse('show_products', { ids: ['FP001'] }), toolUse('set_item_qty', { pack: 'main', id: 'FP001', qty: 5 })], 'tool_use'),
      step([text('5 பூச்சட்டி பெரியது (Flower Pot Big) சேர்த்துவிட்டேன். மொத்தம் ₹1,030.')]),
    );
    let ev = await h.say(sid, 'பூச்சட்டி 5 சேர்க்கவும்');
    expect(ev.find((e) => e.type === 'locale')?.locale).toBe('ta');
    expect(ev.find((e) => e.type === 'ui.products')?.products[0]).toMatchObject({ id: 'FP001', image: 'https://example.com/fp.jpg', price: 120 });
    const cartEv = ev.find((e) => e.type === 'ui.cart');
    expect(cartEv.cart.subtotal).toBe(1000);
    expect(cartEv.cart.total).toBe(1030); // + 3% packing
    expect(ev.find((e) => e.type === 'text' && e.source === 'model')?.text).toContain('பூச்சட்டி');

    // The model saw the cart as system-written context, and the Tamil-aware prompt.
    const firstReq = h.model.requests[0]!;
    expect(lastUserText(firstReq)).toContain('<cart_state>');
    expect(lastUserText(firstReq)).toContain('பூச்சட்டி 5 சேர்க்கவும்');
    expect(firstReq.system.map((b) => b.text).join('\n')).toContain('Tanglish');
    expect(firstReq.system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    // The tool result returned to the model carries server-computed totals.
    const toolResults = (h.model.requests[1]!.messages.at(-1)!.content as any[]);
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(toolResults[1].content).cart.total).toBe(1030);

    // 2. Customer gives details; model requests checkout.
    h.model.push(
      step([toolUse('request_checkout', DETAILS)], 'tool_use'),
      step([text('ஆர்டர் சுருக்கத்தைச் சரிபார்த்து "உறுதி" என்று பதிலளிக்கவும்.')]),
    );
    ev = await h.say(sid, 'Ravi, 9876543210, 12 Gandhi Street, Sivakasi 626123, ravi@example.com');
    const confirm = ev.find((e) => e.type === 'ui.confirm');
    expect(confirm.summary.customer.phone).toBe('9876543210');
    expect(confirm.summary.quote.total).toBe(1030);
    expect(confirm.prompt).toContain('உறுதி'); // locale stayed Tamil for Latin-script details
    expect(JSON.parse((h.model.requests[3]!.messages.at(-1)!.content as any[])[0].content).status).toBe('awaiting_customer_confirmation');

    // 3. Customer confirms with the Tamil keyword — no model call.
    const before = h.model.requests.length;
    ev = await h.say(sid, 'உறுதி');
    expect(h.model.requests.length).toBe(before);
    const exec = ev.find((e) => e.type === 'action.execute');
    expect(exec.actionId).toBe(confirm.actionId);
    expect(exec.payload.cart.groups).toEqual([{ key: 'main', title: 'Kutty Pattasu Pack', items: { SP001: 10, FP001: 5 } }]);

    // 4. The shop's frontend placed the order and reports back.
    const done = await h.call('POST', `/v1/sessions/${sid}/actions/${confirm.actionId}/complete`, { orderId: 'NC1001' });
    expect(done.body.events.find((e: any) => e.type === 'action.completed').orderId).toBe('NC1001');
    expect(done.body.events.find((e: any) => e.type === 'text').text).toContain('ஆர்டர் எண்: #NC1001');

    // 5. Next turn, the model is told about the order via <events>.
    h.model.push(step([text('நன்றி!')]));
    await h.say(sid, 'nandri');
    expect(lastUserText(h.model.requests.at(-1)!)).toContain('Order ID #NC1001');

    const view = await h.call('GET', `/v1/sessions/${sid}`);
    expect(view.body.status).toBe('ordered');
    expect(view.body.pendingAction).toBeNull();
    expect(h.repo.usage.length).toBe(5);
  });
});

describe('order safety', () => {
  async function withSummary() {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', { context: COMBO })).body.id;
    h.model.push(step([toolUse('request_checkout', DETAILS)], 'tool_use'), step([text('Please confirm.')]));
    const confirm = (await h.say(sid, 'checkout')).find((e) => e.type === 'ui.confirm');
    return { h, sid, confirm };
  }

  it('casual agreement does not confirm — it goes to the model', async () => {
    const { h, sid } = await withSummary();
    h.model.push(step([text('Tap Confirm or reply CONFIRM to place the order.')]));
    const ev = await h.say(sid, 'ok');
    expect(ev.some((e) => e.type === 'action.execute')).toBe(false);
  });

  it('refuses to confirm if the cart changed after the summary', async () => {
    const { h, sid, confirm } = await withSummary();
    h.model.push(step([toolUse('set_item_qty', { pack: 'main', id: 'FP001', qty: 2 })], 'tool_use'), step([text('Added.')]));
    await h.say(sid, 'add 2 flower pots');
    const res = await h.call('POST', `/v1/sessions/${sid}/actions/${confirm.actionId}`, { decision: 'confirm' });
    expect(res.body.events.map((e: any) => e.type)).toEqual(['action.cancelled', 'text']);
    expect((await h.call('GET', `/v1/sessions/${sid}`)).body.pendingAction).toBeNull();
  });

  it('expires summaries after 10 minutes', async () => {
    const { h, sid, confirm } = await withSummary();
    h.deps.now = () => new Date(Date.now() + 11 * 60 * 1000);
    const res = await h.call('POST', `/v1/sessions/${sid}/actions/${confirm.actionId}`, { decision: 'confirm' });
    expect(res.body.events[0].text).toContain('expired');
  });

  it('cancels with the Tamil keyword', async () => {
    const { h, sid } = await withSummary();
    const ev = await h.say(sid, 'ரத்து');
    expect(ev.map((e) => e.type)).toContain('action.cancelled');
  });

  it('places the order by signed webhook for webhook tenants', async () => {
    const h = await setup({ orderExecutor: 'webhook', webhook: { url: 'https://tenant.example/orders' } });
    h.setFetch(async () => Response.json({ orderId: 'W-77' }));
    const sid = (await h.call('POST', '/v1/sessions', { context: COMBO })).body.id;
    h.model.push(step([toolUse('request_checkout', DETAILS)], 'tool_use'), step([text('Please confirm.')]));
    await h.say(sid, 'checkout');
    const ev = await h.say(sid, 'CONFIRM');
    expect(ev.find((e) => e.type === 'action.completed').orderId).toBe('W-77');

    const { init } = h.fetchCalls[0]!;
    const sig = (init.headers as Record<string, string>)['x-shop-agent-signature']!;
    const ts = Number(sig.match(/t=(\d+)/)![1]);
    expect(sig).toBe(signWebhook(webhookKey('x'.repeat(40), 'naga'), ts, init.body as string));
    expect(JSON.parse(init.body as string).idempotencyKey).toBeTruthy();
  });
});

describe('tool validation', () => {
  it('returns errors to the model instead of changing the cart', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    h.model.push(
      step([toolUse('set_item_qty', { pack: 'main', id: 'RK001', qty: 1 }), toolUse('set_item_qty', { pack: 'main', id: 'NOPE', qty: 1 }), toolUse('set_item_qty', { pack: 'main', id: 'FP001', qty: 9999 })], 'tool_use'),
      step([text('Sorry, the rocket is out of stock.')]),
    );
    const ev = await h.say(sid, 'add a rocket');
    expect(ev.some((e) => e.type === 'ui.cart')).toBe(false);
    const results = h.model.requests[1]!.messages.at(-1)!.content as any[];
    expect(results.every((r) => r.is_error)).toBe(true);
    expect(results[0].content).toContain('out of stock');
    expect((await h.call('GET', `/v1/sessions/${sid}`)).body.cart.units).toBe(0);
  });

  it('validates checkout details and lets the model ask again', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', { context: COMBO })).body.id;
    h.model.push(step([toolUse('request_checkout', { name: 'Ravi', phone: '123', address: '', email: '' })], 'tool_use'), step([text('Need phone and address.')]));
    const ev = await h.say(sid, 'order now');
    expect(ev.some((e) => e.type === 'ui.confirm')).toBe(false);
    const result = JSON.parse((h.model.requests[1]!.messages.at(-1)!.content as any[])[0].content);
    expect(Object.keys(result.errors).sort()).toEqual(['address', 'phone']);
  });

  it('undo restores the previous cart', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', { context: COMBO })).body.id;
    h.model.push(step([toolUse('set_item_qty', { pack: 'main', id: 'SP001', qty: 0 })], 'tool_use'), step([text('Removed.')]));
    await h.say(sid, 'remove sparklers');
    const res = await h.call('POST', `/v1/sessions/${sid}/cart/undo`);
    expect(res.body.events[0].cart.units).toBe(10);
  });

  it('adopts quantities edited on the page and tells the model next turn', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', { context: COMBO })).body.id;
    expect((await h.call('PUT', `/v1/sessions/${sid}/cart`, { items: { NOPE: 1 } })).status).toBe(400);
    const res = await h.call('PUT', `/v1/sessions/${sid}/cart`, { items: { SP001: 4, FP001: 1, RK001: 0 } });
    expect(res.body.cart).toMatchObject({ subtotal: 280, units: 5 });
    expect(res.body.canUndo).toBe(true);
    h.model.push(step([text('ok')]));
    await h.say(sid, 'what is in my cart?');
    const ctx = lastUserText(h.model.requests[0]!);
    expect(ctx).toContain('changed the cart on the page');
    expect(ctx).toContain('"subtotal":280');
  });

  it('closes a dangling tool call from an interrupted turn before the next request', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    await h.repo.appendMessages(sid, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], displayText: 'hi' },
      { role: 'assistant', content: [toolUse('get_cart', {})] as any, displayText: null },
    ]);
    h.model.push(step([text('Hello!')]));
    await h.say(sid, 'hello?');
    const last = h.model.requests[0]!.messages.at(-1)!.content as any[];
    expect(last[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });
});

describe('auth and isolation', () => {
  it('enforces the origin allowlist and key types', async () => {
    const h = await setup();
    expect((await h.call('POST', '/v1/sessions', {}, 'pk_test', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.call('POST', '/v1/sessions', {}, 'pk_test', { origin: 'https://shop.example' })).status).toBe(201);
    expect((await h.call('POST', '/v1/sessions', {}, 'pk_wrong')).status).toBe(401);
    expect((await h.call('PUT', '/v1/catalog', { products: CATALOG }, 'pk_test')).status).toBe(401);
    expect((await h.call('PUT', '/v1/catalog', { products: CATALOG }, 'sk_test')).body).toMatchObject({ version: 2, count: 3 });
  });

  it('does not expose one tenant\'s sessions to another tenant', async () => {
    const h = await setup();
    const created = await h.call('POST', '/admin/tenants', { id: 'other-shop', name: 'Other', config: { shopName: 'Other' } }, 'a'.repeat(30));
    expect(created.status).toBe(201);
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    expect((await h.call('GET', `/v1/sessions/${sid}`, undefined, created.body.publishableKey)).status).toBe(404);
  });

  it('rejects admin calls without the operator token', async () => {
    const h = await setup();
    expect((await h.call('POST', '/admin/tenants', { id: 'x1', name: 'X', config: { shopName: 'X' } }, 'nope')).status).toBe(401);
  });
});

describe('streaming', () => {
  it('streams deltas and events over SSE that the SDK can parse', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    h.model.push(step([text('வணக்கம்! Vanakkam!')]));
    const res = await h.app.request(`/v1/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer pk_test', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'vanakkam' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const types: string[] = [];
    let deltas = '';
    for await (const e of parseSSE(res.body!)) {
      types.push(e.type);
      if (e.type === 'text.delta') deltas += e.text;
    }
    expect(deltas).toBe('வணக்கம்! Vanakkam!');
    expect(types.at(-1)).toBe('done');
  });

  it('rejects a second message while a turn is running', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    const release = await h.deps.kv.lock(`session:${sid}`, 5000);
    expect((await h.call('POST', `/v1/sessions/${sid}/messages?stream=false`, { text: 'hi' })).status).toBe(409);
    await release!();
  });
});
