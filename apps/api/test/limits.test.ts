import { describe, expect, it } from 'vitest';
import { windowHistory } from '../src/agent';
import type { MessageRecord } from '../src/repo/types';
import { lastUserText, setup, step, text, toolUse } from './helpers';

/** n customer turns: user text → assistant (thinking + tool_use) → tool_result → assistant text. */
function chat(n: number): MessageRecord[] {
  const out: MessageRecord[] = [];
  const at = new Date();
  for (let i = 0; i < n; i++) {
    out.push({ seq: out.length, role: 'user', content: [{ type: 'text', text: `turn ${i}` }], displayText: `turn ${i}`, createdAt: at });
    out.push({ seq: out.length, role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: `t${i}`, name: 'get_cart', input: {} }] as never, displayText: null, createdAt: at });
    out.push({ seq: out.length, role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }], displayText: null, createdAt: at });
    out.push({ seq: out.length, role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] as never, displayText: `reply ${i}`, createdAt: at });
  }
  return out;
}

const turnsIn = (msgs: MessageRecord[]) => msgs.filter((m) => m.role === 'user' && m.displayText !== null).length;

describe('history window', () => {
  it('sends everything while the chat is short', () => {
    const h = chat(17);
    const w = windowHistory(h, 12, 6);
    expect(w.trimmed).toBe(false);
    expect(w.messages).toBe(h);
  });

  it('keeps between historyTurns and historyTurns + step - 1 customer turns', () => {
    for (let n = 18; n <= 60; n++) {
      const kept = turnsIn(windowHistory(chat(n), 12, 6).messages);
      expect(kept).toBeGreaterThanOrEqual(12);
      expect(kept).toBeLessThanOrEqual(17);
    }
  });

  it('moves the cut in steps so the sent prefix is stable for several turns (prompt cache)', () => {
    const first = (n: number) => JSON.stringify(windowHistory(chat(n), 12, 6).messages.slice(0, 8).map((m) => m.content));
    expect(first(19)).toBe(first(18));
    expect(first(23)).toBe(first(18));
    expect(first(24)).not.toBe(first(23));
  });

  it('starts on a customer turn, notes the trim, and drops thinking blocks from kept turns', () => {
    const w = windowHistory(chat(30), 12, 6);
    const head = w.messages[0]!;
    expect(head.role).toBe('user');
    expect((head.content as { text?: string }[])[0]!.text).toContain('Earlier messages');
    const blocks = w.messages.flatMap((m) => m.content as { type: string }[]);
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    // Every kept tool_result still has its tool_use.
    const uses = new Set(blocks.filter((b) => b.type === 'tool_use').map((b) => (b as unknown as { id: string }).id));
    for (const b of blocks.filter((b) => b.type === 'tool_result')) expect(uses.has((b as unknown as { tool_use_id: string }).tool_use_id)).toBe(true);
  });

  it('bounds what a long real conversation sends to the model', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    for (let i = 0; i < 30; i++) {
      h.model.push(step([text(`answer ${i}`)]));
      await h.say(sid, `question ${i}`);
    }
    const sizes = h.model.requests.map((r) => r.messages.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2 * 17);
    expect(lastUserText(h.model.requests.at(-1)!)).toContain('question 29');
  });
});

describe('spend limits', () => {
  it('stops a chat once it has used its token budget', async () => {
    const h = await setup({ limits: { maxTokensPerSession: 10_000 } });
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    await h.repo.updateSession('naga', sid, { tokensUsed: 10_000 });
    const ev = await h.say(sid, 'hi');
    expect(ev[0]).toMatchObject({ type: 'error', code: 'turn_limit' });
    expect(h.model.requests).toHaveLength(0);
  });

  it('counts uncached input + output per chat', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    h.model.push(step([toolUse('get_cart', {})], 'tool_use'), step([text('ok')]));
    await h.say(sid, 'cart?');
    expect((await h.repo.getSession('naga', sid))!.tokensUsed).toBe(2 * (100 + 20));
  });

  it('pauses the assistant for the day when the tenant budget is used up', async () => {
    const h = await setup({ limits: { dailyTokenBudget: 10_000 } });
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    await h.deps.kv.add(`tokens:naga:${new Date().toISOString().slice(0, 10)}`, 10_000, 3600);
    const ev = await h.say(sid, 'hi');
    expect(ev[0]).toMatchObject({ type: 'error', code: 'budget_exceeded' });
    expect(h.model.requests).toHaveLength(0);
  });

  it('expires old chats', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    h.deps.now = () => new Date(Date.now() + 25 * 3600_000);
    const ev = await h.say(sid, 'hi');
    expect(ev[0]).toMatchObject({ type: 'error', code: 'session_expired' });
  });

  it('remembers valid delivery details from a failed checkout and re-sends them each turn', async () => {
    const h = await setup();
    const sid = (await h.call('POST', '/v1/sessions', { context: { baseItems: [{ id: 'SP001', qty: 2 }] } })).body.id;
    h.model.push(step([toolUse('request_checkout', { name: 'Ravi', phone: '98765 43210', address: '', email: '' })], 'tool_use'), step([text('Address please.')]));
    await h.say(sid, 'order for Ravi 9876543210');
    h.model.push(step([text('Thanks')]));
    await h.say(sid, '12 Gandhi Street, Sivakasi');
    const ctx = lastUserText(h.model.requests.at(-1)!);
    expect(ctx).toContain('<customer_details>{"name":"Ravi","phone":"9876543210"}</customer_details>');
  });
});
