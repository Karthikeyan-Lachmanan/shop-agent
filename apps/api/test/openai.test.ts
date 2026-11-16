import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { OpenAIModel, collectStream, supportsReasoningEffort, toOpenAIMessages } from '../src/openai';
import { setup, step, text } from './helpers';

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): ChatCompletionChunk =>
  ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-5.4-mini', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) as ChatCompletionChunk;

async function* chunks(list: ChatCompletionChunk[]) {
  for (const c of list) yield c;
}

describe('OpenAI request translation', () => {
  it('maps history: system → system, tool_use → tool_calls, tool_result → tool messages in order', () => {
    const msgs = toOpenAIMessages(
      [{ type: 'text', text: 'rules' }, { type: 'text', text: 'catalog' }],
      [
        { role: 'user', content: [{ type: 'text', text: '<cart_state>{}</cart_state>' }, { type: 'text', text: 'பூச்சட்டி சேர்க்கவும்' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' } as never, { type: 'text', text: 'Sure' }, { type: 'tool_use', id: 'call_1', name: 'set_item_qty', input: { id: 'FP001', qty: 5 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Unknown id', is_error: true }] },
      ],
    );
    expect(msgs[0]).toEqual({ role: 'system', content: 'rules\n\ncatalog' });
    expect(msgs[1]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'text', text: 'பூச்சட்டி சேர்க்கவும்' }] });
    expect(msgs[2]).toEqual({
      role: 'assistant', content: 'Sure',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'set_item_qty', arguments: '{"id":"FP001","qty":5}' } }],
    });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ERROR: Unknown id' });
  });

  it('only sends reasoning_effort to reasoning models', () => {
    expect(supportsReasoningEffort('gpt-5.4-mini')).toBe(true);
    expect(supportsReasoningEffort('gpt-5.5')).toBe(true);
    expect(supportsReasoningEffort('o4-mini')).toBe(true);
    expect(supportsReasoningEffort('gpt-4.1')).toBe(false);
    expect(supportsReasoningEffort('gpt-5-chat-latest')).toBe(false);
  });
});

describe('OpenAI stream translation', () => {
  it('assembles streamed text and split tool-call arguments', async () => {
    const deltas: string[] = [];
    const msg = await collectStream(chunks([
      chunk({ role: 'assistant', content: 'வணக்கம்' }),
      chunk({ content: '!' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'set_item_qty', arguments: '{"id":"FP' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '001","qty":5}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_cart', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-5.4-mini', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_tokens_details: { cached_tokens: 900 } } } as ChatCompletionChunk,
    ]), (d) => deltas.push(d), 'gpt-5.4-mini');

    expect(deltas.join('')).toBe('வணக்கம்!');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content).toEqual([
      { type: 'text', text: 'வணக்கம்!', citations: null },
      { type: 'tool_use', id: 'call_a', name: 'set_item_qty', input: { id: 'FP001', qty: 5 } },
      { type: 'tool_use', id: 'call_b', name: 'get_cart', input: {} },
    ]);
    expect(msg.usage).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 });
  });

  it('maps length → max_tokens and refusals → refusal; bad JSON fails schema validation later', async () => {
    expect((await collectStream(chunks([chunk({ content: 'cut' }, 'length')]), () => {}, 'm')).stop_reason).toBe('max_tokens');
    expect((await collectStream(chunks([chunk({ refusal: 'no' }, 'stop')]), () => {}, 'm')).stop_reason).toBe('refusal');
    const bad = await collectStream(chunks([chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'set_item_qty', arguments: '{"id":' } }] }, 'tool_calls')]), () => {}, 'm');
    expect((bad.content[0] as { input: unknown }).input).toEqual({ __invalid_json__: '{"id":' });
  });
});

describe('OpenAI provider end to end', () => {
  it('runs a Tamil turn with a tool call through the agent loop', async () => {
    const h = await setup({ provider: 'openai' });
    const bodies: ChatCompletionCreateParamsStreaming[] = [];
    const replies = [
      [chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'set_item_qty', arguments: '{"pack":"main","id":"FP001","qty":3}' } }] }, 'tool_calls')],
      [chunk({ content: '3 பூச்சட்டி சேர்த்தேன். மொத்தம் ₹371.' }, 'stop')],
    ];
    h.deps.models.openai = {
      defaultModel: 'gpt-5.4-mini',
      client: new OpenAIModel({ create: async (body) => { bodies.push(structuredClone(body)); return chunks(replies.shift()!); } }),
    };
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    const ev = await h.say(sid, 'பூச்சட்டி 3 சேர்க்கவும்');

    expect(ev.find((e) => e.type === 'ui.cart').cart.total).toBe(371); // 3 × 120 + 3% packing
    expect(ev.find((e) => e.type === 'text' && e.source === 'model').text).toContain('பூச்சட்டி');
    expect(h.model.requests).toHaveLength(0); // Anthropic not used

    expect(bodies[0]).toMatchObject({ model: 'gpt-5.4-mini', stream: true, reasoning_effort: 'low', prompt_cache_key: 'tenant:naga' });
    expect(bodies[0]!.tools![0]).toMatchObject({ type: 'function', function: { name: 'show_products', strict: true } });
    // Second request carries the assistant tool call and its result.
    const tail = bodies[1]!.messages.slice(-2);
    expect(tail[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] });
    expect(tail[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(JSON.parse((tail[1] as { content: string }).content).cart.total).toBe(371);
  });

  it('falls back to reasoning_effort "none" when the model rejects effort with tools, and remembers it', async () => {
    const sent: (string | null | undefined)[] = [];
    const model = new OpenAIModel({
      create: async (body) => {
        sent.push(body.reasoning_effort);
        if (body.reasoning_effort === 'low') throw Object.assign(new Error('400'), { status: 400, param: 'reasoning_effort' });
        return chunks([chunk({ content: 'ok' }, 'stop')]);
      },
    });
    const req = { model: 'gpt-5.4-mini', effort: 'low' as const, maxTokens: 100, system: [{ type: 'text' as const, text: 's' }], tools: [], messages: [{ role: 'user' as const, content: 'hi' }] };
    await model.run(req, () => {});
    await model.run(req, () => {});
    expect(sent).toEqual(['low', 'none', 'none']);
  });

  it('does not retry unrelated 400s', async () => {
    const model = new OpenAIModel({ create: async () => { throw Object.assign(new Error('bad'), { status: 400, param: 'messages' }); } });
    await expect(model.run({ model: 'gpt-5.4-mini', effort: 'low', maxTokens: 10, system: [], tools: [], messages: [] }, () => {})).rejects.toThrow('bad');
  });

  it('reports a clear error when the tenant picks a provider with no key', async () => {
    const h = await setup({ provider: 'openai' });
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    const ev = await h.say(sid, 'hi');
    expect(ev[0]).toMatchObject({ type: 'error', code: 'model_not_configured' });
  });

  it('uses the server default provider when the tenant does not choose', async () => {
    const h = await setup();
    h.model.push(step([text('hello')]));
    const sid = (await h.call('POST', '/v1/sessions', {})).body.id;
    await h.say(sid, 'hi');
    expect(h.model.requests[0]!.model).toBe('claude-opus-5-5');
  });
});
