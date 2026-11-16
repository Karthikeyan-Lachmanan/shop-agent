import type { AgentEvent, CartGroupInput, CartState, CartView, Locale, PlaceOrderPayload, SessionContext } from '@shop-agent/core';

export type { AgentEvent, Bundle, CartGroupInput, CartState, CartView, GroupView, Locale, PlaceOrderPayload, SessionContext } from '@shop-agent/core';
export type { ProductCard } from '@shop-agent/core';

export interface SessionView {
  id: string;
  locale: Locale;
  status: 'active' | 'ordered' | 'closed';
  context: SessionContext;
  cart: CartView;
  state: CartState;
  canUndo: boolean;
  pendingAction: { id: string; type: 'place_order'; status: 'pending' | 'confirmed'; summary: PlaceOrderPayload; expiresAt: string } | null;
  transcript: { role: 'user' | 'assistant'; text: string; at: string }[];
}

export class ShopAgentError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Minimal browser/Node client. Works with any UI: feed `onEvent` into your
 * own renderer. Events: text.delta, text, ui.products, ui.cart, ui.confirm,
 * action.execute, action.completed, action.cancelled, locale, error, done.
 */
export class ShopAgentClient {
  constructor(private opts: { baseUrl: string; publishableKey: string; fetch?: typeof fetch }) {}

  private get f() {
    return this.opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(this.opts.baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.publishableKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) throw new ShopAgentError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? res.statusText);
    return data as T;
  }

  createSession(input: { locale?: Locale; context?: Partial<SessionContext> } = {}) {
    return this.req<SessionView>('POST', '/v1/sessions', input);
  }

  getSession(sessionId: string) {
    return this.req<SessionView>('GET', `/v1/sessions/${sessionId}`);
  }

  /** Streams one turn. Resolves when the server sends `done` or closes the stream. */
  async sendMessage(sessionId: string, text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.publishableKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ShopAgentError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? res.statusText);
    }
    for await (const e of parseSSE(res.body)) {
      onEvent(e);
      if (e.type === 'done') return;
    }
  }

  async decide(sessionId: string, actionId: string, decision: 'confirm' | 'cancel') {
    return (await this.req<{ events: AgentEvent[] }>('POST', `/v1/sessions/${sessionId}/actions/${actionId}`, { decision })).events;
  }

  /** For tenants with orderExecutor "client": report the result of placing the order. */
  async complete(sessionId: string, actionId: string, outcome: { orderId: string } | { error: string }) {
    return (await this.req<{ events: AgentEvent[] }>('POST', `/v1/sessions/${sessionId}/actions/${actionId}/complete`, outcome)).events;
  }

  /**
   * Mirror cart changes made outside the chat (e.g. +/- buttons, packs added on the page).
   * Send every pack; `active` is the pack the customer is looking at.
   */
  setCart(sessionId: string, cart: { groups: CartGroupInput[]; active?: string } | { items: Record<string, number> }) {
    return this.req<{ cart: CartView; canUndo: boolean }>('PUT', `/v1/sessions/${sessionId}/cart`, cart);
  }

  async undo(sessionId: string) {
    return (await this.req<{ events: AgentEvent[] }>('POST', `/v1/sessions/${sessionId}/cart/undo`)).events;
  }
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (event === 'ping' || data.length === 0) continue;
        try {
          yield JSON.parse(data.join('\n')) as AgentEvent;
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
