import type Anthropic from '@anthropic-ai/sdk';
import { TenantConfig, type Product, type TenantConfigInput } from '@shop-agent/core';
import { createApp } from '../src/app';
import type { Deps } from '../src/deps';
import { hashSecret } from '../src/keys';
import { MemoryKV } from '../src/kv';
import type { ModelClient, ModelRequest } from '../src/model';
import { MemoryRepo } from '../src/repo/memory';

type Block = Anthropic.Beta.BetaContentBlock;

let idCounter = 0;
export const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
export const toolUse = (name: string, input: unknown): Block => ({ type: 'tool_use', id: `toolu_${++idCounter}`, name, input }) as Block;

/** A scripted model: each call pops the next step. Records every request it saw. */
export class FakeModel implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(public steps: ((req: ModelRequest) => { content: Block[]; stop: string })[] = []) {}
  push(...steps: FakeModel['steps']) {
    this.steps.push(...steps);
  }
  async run(req: ModelRequest, onText: (d: string) => void) {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('FakeModel: no scripted step left');
    const { content, stop } = step(req);
    for (const b of content) if (b.type === 'text') onText(b.text);
    return {
      id: `msg_${++idCounter}`, type: 'message', role: 'assistant', model: req.model, content, stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

export const step = (content: Block[], stop = 'end_turn') => () => ({ content, stop });

export const CATALOG: Product[] = [
  { id: 'FP001', name: 'Flower Pot Big', nameTa: 'பூச்சட்டி பெரியது', category: 'Flower Pots', price: 120, mrp: 600, inStock: true, image: 'https://example.com/fp.jpg' },
  { id: 'SP001', name: '10cm Sparklers', nameTa: 'மத்தாப்பு', category: 'Sparklers', price: 40, mrp: 200, inStock: true },
  { id: 'RK001', name: 'Rocket Bomb', category: 'Rockets', price: 90, inStock: false },
];

export async function setup(configOverrides: Partial<TenantConfigInput> = {}) {
  const repo = new MemoryRepo();
  const model = new FakeModel();
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  let fetchImpl: typeof fetch = async () => new Response('{}', { status: 500 });
  const deps: Deps = {
    repo,
    kv: new MemoryKV(),
    models: { anthropic: { client: model, defaultModel: 'claude-opus-5-5' } },
    defaultProvider: 'anthropic',
    now: () => new Date(),
    webhookSigningSecret: 'x'.repeat(40),
    fetch: (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return fetchImpl(url, init);
    }) as typeof fetch,
  };
  const config = TenantConfig.parse({
    shopName: 'Naga Crackers',
    charges: [{ label: 'Packing', labelTa: 'பேக்கிங்', percent: 3 }],
    allowedOrigins: ['https://shop.example'],
    ...configOverrides,
  });
  await repo.createTenant({ id: 'naga', name: 'Naga', config, publishableKey: 'pk_test', secretKeyHash: hashSecret('sk_test') });
  await repo.putCatalog('naga', CATALOG);
  const app = createApp(deps, { adminToken: 'a'.repeat(30) });

  const call = async (method: string, path: string, body?: unknown, key = 'pk_test', headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const say = async (sessionId: string, t: string) => (await call('POST', `/v1/sessions/${sessionId}/messages?stream=false`, { text: t })).body.events as any[];

  return {
    app, repo, model, deps, call, say, fetchCalls,
    setFetch: (f: typeof fetch) => { fetchImpl = f; },
  };
}

/** Text the model saw in the last user turn (system context + customer text). */
export function lastUserText(req: ModelRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'text'));
  return (last?.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
