import Anthropic from '@anthropic-ai/sdk';
import {
  TOOL_DEFINITIONS, TOOL_INPUTS, addGroup, buildSystemPrompt, cartFromContext, cartHash, cartSummaryForModel, detectLocale,
  findGroup, formatINR, indexCatalog, isCancelKeyword, isConfirmKeyword, mergedItems, newGroupKey, quote, removeGroup,
  renderTurnContext, replaceGroupItems, searchProducts, setQty, t, validateCustomer,
  type AgentEvent, type Bundle, type Cart, type CartGroup, type CartState, type CatalogIndex, type Product, type ProductCard, type ToolName,
} from '@shop-agent/core';
import { cancelAction, confirmAction, expireIfStale } from './actions';
import { resolveModel, type Deps, type Emit } from './deps';
import type { BetaMessageParam, BetaTextBlockParam, BetaTool } from './model';
import type { MessageRecord, SessionRecord, TenantRecord } from './repo/types';

const UNDO_DEPTH = 20;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const TOOLS: BetaTool[] = TOOL_DEFINITIONS.map((d) => ({ ...d, strict: true }));

export function systemBlocks(tenant: TenantRecord, products: Product[], bundles: Bundle[] = []): BetaTextBlockParam[] {
  const { instructions, catalog } = buildSystemPrompt(tenant.config, products, bundles);
  return [
    { type: 'text', text: instructions },
    // One breakpoint after the catalog: tools + instructions + catalog are shared by every session of this tenant.
    { type: 'text', text: catalog, cache_control: { type: 'ephemeral' } },
  ];
}

/**
 * A crash between saving an assistant tool_use and its tool_result would
 * leave history the API rejects. Close any dangling calls by appending
 * error results (append-only, so earlier turns stay byte-identical).
 */
export function danglingToolResults(history: MessageRecord[]): Anthropic.Beta.BetaToolResultBlockParam[] {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant') return [];
  return (last.content as Anthropic.Beta.BetaContentBlock[])
    .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Interrupted before this tool ran. Ask the customer to repeat if needed.' }));
}

const TRIM_NOTE = '[Earlier messages in this chat are not shown. The tags below carry the current cart, details and events.]';

/**
 * Keeps long chats affordable: only the most recent customer turns are sent.
 * The cut advances `step` turns at a time, so the sent prefix stays the same
 * for several turns and keeps hitting the prompt cache. Cart, customer details
 * and order events travel in every turn's tags, so nothing important is lost.
 *
 * When turns are dropped, thinking blocks are removed from the kept turns:
 * Claude binds each thinking block to the exact history before it, so after
 * a cut they must not be replayed. Tool results whose call was cut are removed.
 */
export function windowHistory(history: MessageRecord[], historyTurns: number, step: number): { messages: MessageRecord[]; trimmed: boolean } {
  const starts = history.flatMap((m, i) => (m.role === 'user' && m.displayText !== null ? [i] : []));
  const drop = Math.max(0, Math.floor((starts.length - historyTurns) / step) * step);
  if (drop === 0) return { messages: history, trimmed: false };

  const kept = history.slice(starts[drop]!);
  const messages: MessageRecord[] = [];
  kept.forEach((m, i) => {
    let content = m.content as Anthropic.Beta.BetaContentBlockParam[];
    if (m.role === 'assistant') content = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (i === 0) content = [{ type: 'text', text: TRIM_NOTE }, ...content.filter((b) => b.type !== 'tool_result')];
    if (content.length) messages.push({ ...m, content });
  });
  return { messages, trimmed: true };
}

const dayKey = (tenantId: string, now: Date) => `tokens:${tenantId}:${now.toISOString().slice(0, 10)}`;

function card(p: Product, inCart: Cart): ProductCard {
  return { id: p.id, name: p.name, nameTa: p.nameTa, category: p.category, image: p.image, price: p.price, mrp: p.mrp, inStock: p.inStock, inCartQty: inCart[p.id] ?? 0 };
}

interface TurnState {
  tenant: TenantRecord;
  session: SessionRecord;
  index: CatalogIndex;
  products: Product[];
  bundles: Map<string, Bundle>;
}

const bundleItems = (b: Bundle): Cart => Object.fromEntries(b.items.map((i) => [i.id, i.qty]));

/** The items a pack started with: its combo's standard items, or what the session opened with. */
function originalItems(st: TurnState, group: CartGroup): Cart | undefined {
  if (group.bundleId) {
    const b = st.bundles.get(group.bundleId);
    if (b) return bundleItems(b);
  }
  return findGroup(cartFromContext(st.session.context), group.key)?.items;
}

const packList = (state: CartState) => state.groups.map((g) => `"${g.key}" (${g.title})`).join(', ');

/** Runs one tool call. Returns the tool_result content; throws nothing the model shouldn't see. */
async function runTool(deps: Deps, st: TurnState, name: ToolName, rawInput: unknown, emit: Emit): Promise<{ content: string; isError?: boolean }> {
  const schema = TOOL_INPUTS[name];
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
  const { tenant, session, index } = st;
  const cfg = tenant.config;
  const view = () => quote(session.cart, index, cfg.charges, st.bundles);
  const summary = (v = view()) => cartSummaryForModel(v, session.cart.active);
  const changed = async (next: CartState) => {
    await updateCart(deps, session, next);
    const v = view();
    await emit({ type: 'ui.cart', cart: v, state: session.cart, canUndo: true });
    return v;
  };

  switch (name) {
    case 'show_products': {
      const { ids } = parsed.data as { ids: string[] };
      const found = ids.map((id) => index.get(id)).filter((p): p is Product => !!p);
      const notFound = ids.filter((id) => !index.has(id));
      const inCart = mergedItems(session.cart);
      if (found.length) await emit({ type: 'ui.products', products: found.map((p) => card(p, inCart)) });
      return {
        content: JSON.stringify({
          shown: found.map((p) => ({ id: p.id, name: p.name, price: p.price, mrp: p.mrp, inStock: p.inStock, inCartQty: inCart[p.id] ?? 0 })),
          ...(notFound.length ? { notFound } : {}),
        }),
      };
    }
    case 'search_products': {
      const { query } = parsed.data as { query: string };
      const hits = searchProducts(st.products, query, 10);
      return { content: JSON.stringify({ results: hits.map(({ product: p }) => ({ id: p.id, name: p.name, nameTa: p.nameTa, category: p.category, price: p.price, inStock: p.inStock })) }) };
    }
    case 'get_cart':
      return { content: JSON.stringify(summary()) };
    case 'set_item_qty': {
      const { pack, id, qty } = parsed.data as { pack: string; id: string; qty: number };
      const group = findGroup(session.cart, pack);
      if (!group) return { content: `Unknown pack "${pack}". Packs in the cart: ${packList(session.cart) || 'none'}.`, isError: true };
      const p = index.get(id);
      if (!p) return { content: `Unknown product id "${id}". Use search_products to find the right id.`, isError: true };
      if (qty > 0 && !p.inStock) return { content: `${p.name} is out of stock and cannot be added.`, isError: true };
      if (qty > cfg.maxQtyPerItem) return { content: `Maximum quantity per item is ${cfg.maxQtyPerItem}.`, isError: true };
      const from = group.items[id] ?? 0;
      if (from === qty) return { content: JSON.stringify({ unchanged: true, cart: summary() }) };
      const v = await changed(setQty(session.cart, pack, id, qty));
      return { content: JSON.stringify({ changed: { pack, id, name: p.name, from, to: qty }, cart: summary(v) }) };
    }
    case 'add_pack': {
      const { combo_id } = parsed.data as { combo_id: string };
      const b = st.bundles.get(combo_id);
      if (!b) return { content: st.bundles.size ? `Unknown combo id "${combo_id}". Use an id from the combo pack list.` : 'This shop has no combo packs.', isError: true };
      if (session.cart.groups.length >= 20) return { content: 'The cart already has the maximum of 20 packs.', isError: true };
      const key = newGroupKey(session.cart, b.id);
      const v = await changed(addGroup(session.cart, { key, bundleId: b.id, title: b.name, items: bundleItems(b) }));
      return { content: JSON.stringify({ added: { pack: key, title: b.name }, cart: summary(v) }) };
    }
    case 'remove_pack': {
      const { pack } = parsed.data as { pack: string };
      const group = findGroup(session.cart, pack);
      if (!group) return { content: `Unknown pack "${pack}". Packs in the cart: ${packList(session.cart) || 'none'}.`, isError: true };
      const v = await changed(removeGroup(session.cart, pack));
      return { content: JSON.stringify({ removed: { pack, title: group.title }, cart: summary(v) }) };
    }
    case 'reset_pack': {
      const { pack } = parsed.data as { pack: string };
      const group = findGroup(session.cart, pack);
      if (!group) return { content: `Unknown pack "${pack}". Packs in the cart: ${packList(session.cart) || 'none'}.`, isError: true };
      const original = originalItems(st, group);
      if (!original) return { content: `"${group.title}" has no original items to restore.`, isError: true };
      const v = await changed(replaceGroupItems(session.cart, pack, original));
      return { content: JSON.stringify({ reset: { pack, title: group.title }, cart: summary(v) }) };
    }
    case 'request_checkout': {
      const { customer, errors } = validateCustomer(parsed.data as never, cfg.requiredCustomerFields);
      // Remember what we have so far, so trimmed history never makes the customer repeat themselves.
      const known = Object.fromEntries(Object.entries(customer).filter(([k, v]) => v && !errors[k as keyof typeof errors]));
      if (Object.keys(known).length) {
        session.customer = { ...session.customer, ...known };
        await deps.repo.updateSession(tenant.id, session.id, { customer: session.customer });
      }
      if (Object.keys(errors).length) return { content: JSON.stringify({ ok: false, errors }) };
      const v = view();
      if (v.units === 0) return { content: JSON.stringify({ ok: false, errors: { cart: 'cart is empty' } }) };
      if (v.unavailable.length) return { content: JSON.stringify({ ok: false, errors: { cart: `remove unavailable items first: ${v.unavailable.join(', ')}` } }) };
      if (v.subtotal < cfg.minOrderValue) return { content: JSON.stringify({ ok: false, errors: { cart: `minimum order value is ₹${cfg.minOrderValue}; subtotal is ₹${v.subtotal}` } }) };

      // Only one summary can be open at a time.
      const open = await deps.repo.getOpenAction(tenant.id, session.id);
      if (open?.status === 'pending') await deps.repo.updateAction(tenant.id, open.id, { status: 'cancelled' });

      const payload = { customer, cart: session.cart, quote: v, context: session.context };
      const expiresAt = new Date(deps.now().getTime() + CONFIRM_TTL_MS);
      const action = await deps.repo.createAction({
        sessionId: session.id, tenantId: tenant.id, type: 'place_order', status: 'pending', payload, cartHash: cartHash(session.cart), expiresAt,
      });
      await emit({
        type: 'ui.confirm', actionId: action.id, actionType: 'place_order', summary: payload, expiresAt: expiresAt.toISOString(),
        prompt: t(session.locale, 'confirm_prompt', { units: v.units, total: formatINR(v.total) }),
      });
      return {
        content: JSON.stringify({
          ok: true,
          status: 'awaiting_customer_confirmation',
          total: v.total,
          note: 'The order is NOT placed yet. Tell the customer to check the summary and tap Confirm or reply CONFIRM / உறுதி. If they want changes, they can reply CANCEL / ரத்து.',
        }),
      };
    }
  }
}

async function updateCart(deps: Deps, session: SessionRecord, next: CartState) {
  session.cartHistory = [...session.cartHistory, session.cart].slice(-UNDO_DEPTH);
  session.cart = next;
  await deps.repo.updateSession(session.tenantId, session.id, { cart: next, cartHistory: session.cartHistory });
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Handles one customer message end to end. The caller holds the session
 * lock. Every event goes through `emit`; nothing here writes to HTTP.
 */
export async function handleMessage(deps: Deps, tenant: TenantRecord, session: SessionRecord, text: string, emit: Emit, signal?: AbortSignal): Promise<void> {
  const cfg = tenant.config;

  const locale = cfg.languages.includes('ta') ? detectLocale(text, session.locale) : 'en';
  if (locale !== session.locale) {
    session.locale = locale;
    await deps.repo.updateSession(tenant.id, session.id, { locale });
    await emit({ type: 'locale', locale });
  }

  // Keyword replies to an open order summary are handled without the model,
  // so "CONFIRM" can never be reinterpreted or invented by it.
  let open = await deps.repo.getOpenAction(tenant.id, session.id);
  if (open) open = await expireIfStale(deps, tenant, open);
  if (open?.status === 'pending' && isConfirmKeyword(text)) return confirmAction(deps, tenant, session, open, emit);
  if (open?.status === 'pending' && isCancelKeyword(text)) return cancelAction(deps, tenant, session, open, emit);

  // ── Spend limits: checked before any model call ──
  const now = deps.now();
  if (now.getTime() - session.createdAt.getTime() > cfg.limits.sessionTtlHours * 3600_000) {
    await emit({ type: 'error', code: 'session_expired', message: t(locale, 'session_expired') });
    return;
  }
  if (session.turnCount >= cfg.limits.maxTurnsPerSession || session.tokensUsed >= cfg.limits.maxTokensPerSession) {
    await emit({ type: 'error', code: 'turn_limit', message: t(locale, 'turn_limit') });
    return;
  }
  if ((await deps.kv.add(dayKey(tenant.id, now), 0, 2 * 86400)) >= cfg.limits.dailyTokenBudget) {
    console.warn(`[shop-agent] tenant ${tenant.id} reached its daily token budget`);
    await emit({ type: 'error', code: 'budget_exceeded', message: t(locale, 'budget_exceeded') });
    return;
  }

  const llm = resolveModel(deps, cfg);
  if (!llm) {
    console.error(`[shop-agent] tenant ${tenant.id} uses provider ${cfg.provider ?? deps.defaultProvider}, which has no API key on this server`);
    await emit({ type: 'error', code: 'model_not_configured', message: t(locale, 'error') });
    return;
  }

  const catalog = await deps.repo.getCatalog(tenant.id);
  if (!catalog || catalog.products.length === 0) {
    await emit({ type: 'error', code: 'no_catalog', message: t(locale, 'error') });
    return;
  }
  const st: TurnState = { tenant, session, index: indexCatalog(catalog.products), products: catalog.products, bundles: new Map(catalog.bundles.map((b) => [b.id, b])) };
  const system = systemBlocks(tenant, catalog.products, catalog.bundles);

  const history = await deps.repo.listMessages(session.id);
  const repair = danglingToolResults(history);
  const events = session.pendingEvents;
  const turnContext = renderTurnContext(cartSummaryForModel(quote(session.cart, st.index, cfg.charges, st.bundles), session.cart.active), events, session.customer);
  const userMsg: Omit<MessageRecord, 'seq' | 'createdAt'> = {
    role: 'user',
    content: [...repair, { type: 'text', text: turnContext }, { type: 'text', text }],
    displayText: text,
  };
  await deps.repo.appendMessages(session.id, [userMsg]);
  session.turnCount += 1;
  session.pendingEvents = [];
  await deps.repo.updateSession(tenant.id, session.id, { pendingEvents: [], turnCount: session.turnCount });

  const { messages: windowed } = windowHistory([...history, { ...userMsg, seq: -1, createdAt: now }], cfg.limits.historyTurns, cfg.limits.historyStep);
  const transcript: BetaMessageParam[] = windowed.map((m) => ({ role: m.role, content: m.content as Anthropic.Beta.BetaContentBlockParam[] }));
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  for (let round = 0; round < cfg.limits.maxToolRoundsPerTurn; round++) {
    let streamed = '';
    const msg = await llm.client.run(
      { model: llm.model, effort: cfg.effort, maxTokens: cfg.maxTokens, system, tools: TOOLS, messages: transcript, cacheKey: `tenant:${tenant.id}` },
      (delta) => {
        streamed += delta;
        void emit({ type: 'text.delta', text: delta });
      },
      signal,
    );

    usage.inputTokens += msg.usage.input_tokens;
    usage.outputTokens += msg.usage.output_tokens;
    usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
    await deps.repo.recordUsage({
      tenantId: tenant.id, sessionId: session.id, model: msg.model,
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    });
    // Budgets count uncached input + output; cache reads are a small fraction of the price.
    const billable = msg.usage.input_tokens + msg.usage.output_tokens;
    session.tokensUsed += billable;
    await deps.repo.updateSession(tenant.id, session.id, { tokensUsed: session.tokensUsed });
    await deps.kv.add(dayKey(tenant.id, now), billable, 2 * 86400);
    const overBudget = session.tokensUsed >= cfg.limits.maxTokensPerSession;

    const replyText = textOf(msg.content);
    if (msg.stop_reason === 'refusal') {
      // Fallback already ran server-side; this is the whole chain declining.
      const content = msg.content.length ? msg.content : [{ type: 'text' as const, text: t(locale, 'refusal'), citations: null }];
      await deps.repo.appendMessages(session.id, [{ role: 'assistant', content, displayText: replyText || t(locale, 'refusal') }]);
      await emit({ type: 'text', text: t(locale, 'refusal'), source: 'system' });
      break;
    }

    // Store exactly what the API returned (thinking blocks included) so the next request replays it unchanged.
    await deps.repo.appendMessages(session.id, [{ role: 'assistant', content: msg.content, displayText: replyText || null }]);
    transcript.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (replyText) await emit({ type: 'text', text: replyText, source: 'model' });

    const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (msg.stop_reason === 'pause_turn') continue;
      if (msg.stop_reason === 'max_tokens' && !streamed) await emit({ type: 'text', text: t(locale, 'truncated'), source: 'system' });
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (msg.stop_reason === 'max_tokens') {
        // Input may be cut off mid-JSON; never act on it.
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Tool input was truncated; not run.' });
        continue;
      }
      const known = (TOOL_DEFINITIONS as { name: string }[]).some((d) => d.name === tu.name);
      const r = known
        ? await runTool(deps, st, tu.name as ToolName, tu.input, emit)
        : { content: `Unknown tool ${tu.name}`, isError: true };
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
    }
    // All results for one assistant turn go back in a single user message.
    await deps.repo.appendMessages(session.id, [{ role: 'user', content: results, displayText: null }]);
    transcript.push({ role: 'user', content: results });
    // Don't start another paid round once the chat is over its budget; the next message gets the limit notice.
    if (overBudget) break;

    if (msg.stop_reason === 'max_tokens') {
      await emit({ type: 'text', text: t(locale, 'truncated'), source: 'system' });
      break;
    }
  }

  await emit({ type: 'done', usage });
}

export function emitAll(events: AgentEvent[]): Emit {
  return (e) => {
    if (e.type !== 'text.delta') events.push(e);
  };
}
