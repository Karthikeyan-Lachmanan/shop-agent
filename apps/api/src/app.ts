import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  Bundle, CartGroupInput, Locale, MAIN_GROUP, Product, SessionContext, TenantConfig, cartFromContext, cartHash, findGroup, groupFromInput,
  indexCatalog, quote, t, type CartState,
  type AgentEvent,
} from '@shop-agent/core';
import { cancelAction, completeAction, confirmAction, expireIfStale, webhookKey } from './actions';
import { emitAll, handleMessage } from './agent';
import type { Deps, Emit } from './deps';
import { hashSecret, newPublishableKey, newSecretKey, safeEqual } from './keys';
import { providerErrorStatus } from './model';
import type { SessionRecord, TenantRecord } from './repo/types';

type Env = { Variables: { tenant: TenantRecord } };

const SESSION_LOCK_MS = 120_000;
const json = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);

function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return c.req.header('x-api-key')?.trim();
}

export function createApp(deps: Deps, opts: { adminToken: string }) {
  const app = new Hono<Env>();
  const { repo, kv } = deps;

  app.onError((err, c) => {
    console.error(err);
    return json(c, 500, 'internal', 'internal error');
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Preflight can't carry the key, so CORS is open here and the tenant's
  // origin allowlist is enforced in publishableAuth once the key is known.
  app.use('/v1/*', cors({
    origin: (origin) => origin,
    allowHeaders: ['content-type', 'authorization', 'x-api-key'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    maxAge: 600,
  }));

  const publishableAuth: MiddlewareHandler<Env> = async (c, next) => {
    const key = bearer(c);
    if (!key?.startsWith('pk_')) return json(c, 401, 'unauthorized', 'publishable key required');
    const tenant = await repo.getTenantByPublishableKey(key);
    if (!tenant) return json(c, 401, 'unauthorized', 'invalid key');
    const origin = c.req.header('origin');
    if (origin && tenant.config.allowedOrigins.length && !tenant.config.allowedOrigins.includes(origin)) {
      return json(c, 403, 'origin_not_allowed', 'origin not allowed for this key');
    }
    c.set('tenant', tenant);
    await next();
  };

  const secretAuth: MiddlewareHandler<Env> = async (c, next) => {
    const key = bearer(c);
    if (!key?.startsWith('sk_')) return json(c, 401, 'unauthorized', 'secret key required');
    const tenant = await repo.getTenantBySecretHash(hashSecret(key));
    if (!tenant) return json(c, 401, 'unauthorized', 'invalid key');
    c.set('tenant', tenant);
    await next();
  };

  const smallBody = bodyLimit({ maxSize: 32 * 1024, onError: (c) => json(c, 413, 'too_large', 'body too large') });

  async function loadSession(c: Context<Env>): Promise<SessionRecord | null> {
    return repo.getSession(c.get('tenant').id, c.req.param('id')!);
  }

  /** Runs fn with the session lock held, passing a session re-read under the lock. */
  async function withLock<T>(c: Context<Env>, sessionId: string, fn: (s: SessionRecord) => Promise<T>): Promise<T | 'busy' | 'gone'> {
    const release = await kv.lock(`session:${sessionId}`, SESSION_LOCK_MS);
    if (!release) return 'busy';
    try {
      const fresh = await loadSession(c);
      return fresh ? await fn(fresh) : 'gone';
    } finally {
      await release();
    }
  }

  function lockFailure(c: Context, out: 'busy' | 'gone', locale: SessionRecord['locale']) {
    return out === 'busy' ? json(c, 409, 'busy', t(locale, 'busy')) : json(c, 404, 'not_found', 'session not found');
  }

  async function sessionView(tenant: TenantRecord, s: SessionRecord) {
    const { index, bundles } = await pricing(tenant.id);
    let open = await repo.getOpenAction(tenant.id, s.id);
    if (open) open = await expireIfStale(deps, tenant, open);
    const transcript = (await repo.listMessages(s.id))
      .filter((m) => m.displayText)
      .map((m) => ({ role: m.role, text: m.displayText!, at: m.createdAt.toISOString() }));
    return {
      id: s.id,
      locale: s.locale,
      status: s.status,
      context: s.context,
      cart: quote(s.cart, index, tenant.config.charges, bundles),
      state: s.cart,
      canUndo: s.cartHistory.length > 0,
      pendingAction: open && (open.status === 'pending' || open.status === 'confirmed')
        ? { id: open.id, type: open.type, status: open.status, summary: open.payload, expiresAt: open.expiresAt.toISOString() }
        : null,
      transcript,
    };
  }

  // ── Sessions (publishable key) ─────────────────────────────────

  const CreateSession = z.object({ locale: Locale.optional(), context: SessionContext.optional() });

  app.post('/v1/sessions', smallBody, publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    if (!(await kv.allow(`newsession:${tenant.id}:${clientIp(c)}`, 30, 600))) return json(c, 429, 'rate_limited', t(tenant.config.defaultLocale, 'rate_limited'));
    const body = CreateSession.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return json(c, 400, 'invalid_request', body.error.issues.map((i) => i.message).join('; '));
    const requested = body.data.locale;
    const locale = requested && tenant.config.languages.includes(requested) ? requested : tenant.config.defaultLocale;
    const context = body.data.context ?? SessionContext.parse({});
    const session = await repo.createSession({ tenantId: tenant.id, locale, context, cart: cartFromContext(context) });
    return c.json(await sessionView(tenant, session), 201);
  });

  app.get('/v1/sessions/:id', publishableAuth, async (c) => {
    const s = await loadSession(c);
    if (!s) return json(c, 404, 'not_found', 'session not found');
    return c.json(await sessionView(c.get('tenant'), s));
  });

  const PostMessage = z.object({ text: z.string().trim().min(1).max(2000) });

  app.post('/v1/sessions/:id/messages', smallBody, publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    const body = PostMessage.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return json(c, 400, 'invalid_request', 'text is required (1–2000 characters)');
    const session = await loadSession(c);
    if (!session) return json(c, 404, 'not_found', 'session not found');

    const limit = tenant.config.limits.messagesPer10Min;
    const allowed = (await kv.allow(`msg:${tenant.id}:${session.id}`, limit, 600))
      && (await kv.allow(`msgip:${tenant.id}:${clientIp(c)}`, limit * 3, 600));
    if (!allowed) return json(c, 429, 'rate_limited', t(session.locale, 'rate_limited'));

    const release = await kv.lock(`session:${session.id}`, SESSION_LOCK_MS);
    if (!release) return json(c, 409, 'busy', t(session.locale, 'busy'));

    const run = async (emit: Emit) => {
      // handleMessage updates current.locale in place, so errors use the language just detected.
      let current = session;
      try {
        // Re-read under the lock so we never act on a cart another request just changed.
        current = (await loadSession(c)) ?? session;
        await handleMessage(deps, tenant, current, body.data.text, emit);
      } catch (err) {
        console.error('turn failed', session.id, err);
        const status = providerErrorStatus(err);
        const code = status === 429 ? 'model_rate_limited' : status !== undefined ? 'model_error' : 'internal';
        await emit({ type: 'error', code, message: t(current.locale, 'error') });
        await emit({ type: 'done' });
      } finally {
        await release();
      }
    };

    if (c.req.query('stream') === 'false') {
      const events: AgentEvent[] = [];
      await run(emitAll(events));
      return c.json({ events });
    }

    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => { open = false; });
      // The turn keeps running if the client drops, so cart and history stay consistent.
      const heartbeat = setInterval(() => { if (open) void stream.writeSSE({ event: 'ping', data: '{}' }); }, 15_000);
      try {
        await run(async (e) => {
          if (open) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        });
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  async function pricing(tenantId: string) {
    const catalog = await repo.getCatalog(tenantId);
    return { index: indexCatalog(catalog?.products ?? []), bundles: new Map((catalog?.bundles ?? []).map((b) => [b.id, b])) };
  }

  const PutCart = z.union([
    z.object({ groups: z.array(CartGroupInput).max(20), active: z.string().max(80).optional() }),
    // Single-pack hosts can keep sending a flat item map.
    z.object({ items: z.record(z.string().max(64), z.number().int().min(0).max(10000)) }),
  ]);

  // The customer changed the cart in the host UI (not via chat): adopt it so both views agree.
  app.put('/v1/sessions/:id/cart', smallBody, publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    const body = PutCart.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return json(c, 400, 'invalid_request', 'send { groups: [{ key, bundleId?, title, items: [{ id, qty }] }], active? }');
    const session = await loadSession(c);
    if (!session) return json(c, 404, 'not_found', 'session not found');
    const { index, bundles } = await pricing(tenant.id);

    const next: CartState = 'groups' in body.data
      ? { groups: body.data.groups.map(groupFromInput), ...(body.data.active ? { active: body.data.active } : {}) }
      : { groups: [{ key: MAIN_GROUP, title: session.context.title ?? 'Cart', items: Object.fromEntries(Object.entries(body.data.items).filter(([, q]) => q > 0)) }], active: MAIN_GROUP };
    if (new Set(next.groups.map((g) => g.key)).size !== next.groups.length) return json(c, 400, 'invalid_request', 'pack keys must be unique');
    if (next.active && !findGroup(next, next.active)) return json(c, 400, 'invalid_request', `active pack "${next.active}" is not in groups`);
    const ids = next.groups.flatMap((g) => Object.keys(g.items));
    const unknown = ids.filter((id) => !index.has(id));
    if (unknown.length) return json(c, 400, 'unknown_products', `unknown product ids: ${[...new Set(unknown)].slice(0, 10).join(', ')}`);
    if (next.groups.some((g) => Object.values(g.items).some((q) => q > tenant.config.maxQtyPerItem))) {
      return json(c, 400, 'invalid_request', `max ${tenant.config.maxQtyPerItem} per item`);
    }

    const out = await withLock(c, session.id, async (session) => {
      const view = quote(next, index, tenant.config.charges, bundles);
      const contentChanged = cartHash(next) !== cartHash(session.cart);
      const activeChanged = next.active !== session.cart.active;
      if (!contentChanged && !activeChanged) return { cart: view, canUndo: session.cartHistory.length > 0 };
      const notes: string[] = [];
      if (contentChanged) notes.push('The customer changed the cart on the page (packs or quantities); <cart_state> shows the current cart.');
      if (activeChanged && next.active) notes.push(`The customer is now looking at the pack "${findGroup(next, next.active)!.title}" (key "${next.active}").`);
      const cartHistory = contentChanged ? [...session.cartHistory, session.cart].slice(-20) : session.cartHistory;
      await repo.updateSession(tenant.id, session.id, { cart: next, cartHistory, pendingEvents: [...session.pendingEvents, ...notes] });
      return { cart: view, canUndo: cartHistory.length > 0 };
    });
    if (out === 'busy' || out === 'gone') return lockFailure(c, out, session.locale);
    return c.json(out);
  });

  app.post('/v1/sessions/:id/cart/undo', publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    const session = await loadSession(c);
    if (!session) return json(c, 404, 'not_found', 'session not found');
    const out = await withLock(c, session.id, async (session) => {
      const events: AgentEvent[] = [];
      const prev = session.cartHistory[session.cartHistory.length - 1];
      if (!prev) {
        events.push({ type: 'text', text: t(session.locale, 'undo_empty'), source: 'system' });
        return events;
      }
      const cartHistory = session.cartHistory.slice(0, -1);
      const pendingEvents = [...session.pendingEvents, 'The customer pressed Undo; the cart is back to its previous state.'];
      await repo.updateSession(tenant.id, session.id, { cart: prev, cartHistory, pendingEvents });
      const { index, bundles } = await pricing(tenant.id);
      events.push({ type: 'ui.cart', cart: quote(prev, index, tenant.config.charges, bundles), state: prev, canUndo: cartHistory.length > 0 });
      events.push({ type: 'text', text: t(session.locale, 'undo_done'), source: 'system' });
      return events;
    });
    if (out === 'busy' || out === 'gone') return lockFailure(c, out, session.locale);
    return c.json({ events: out });
  });

  const Decision = z.object({ decision: z.enum(['confirm', 'cancel']) });

  app.post('/v1/sessions/:id/actions/:actionId', smallBody, publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    const body = Decision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return json(c, 400, 'invalid_request', 'decision must be "confirm" or "cancel"');
    const session = await loadSession(c);
    if (!session) return json(c, 404, 'not_found', 'session not found');
    const out = await withLock(c, session.id, async (session) => {
      const action = await repo.getAction(tenant.id, c.req.param('actionId')!);
      if (!action || action.sessionId !== session.id) return null;
      const events: AgentEvent[] = [];
      const emit = emitAll(events);
      if (body.data.decision === 'confirm') await confirmAction(deps, tenant, session, action, emit);
      else await cancelAction(deps, tenant, session, action, emit);
      return events;
    });
    if (out === 'busy' || out === 'gone') return lockFailure(c, out, session.locale);
    if (!out) return json(c, 404, 'not_found', 'action not found');
    return c.json({ events: out });
  });

  const Complete = z.union([
    z.object({ orderId: z.string().trim().min(1).max(100) }),
    z.object({ error: z.string().trim().min(1).max(300) }),
  ]);

  // Client executor: the tenant's frontend placed (or failed to place) the order and reports back.
  app.post('/v1/sessions/:id/actions/:actionId/complete', smallBody, publishableAuth, async (c) => {
    const tenant = c.get('tenant');
    if (tenant.config.orderExecutor !== 'client') return json(c, 400, 'invalid_request', 'this tenant places orders by webhook');
    const body = Complete.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return json(c, 400, 'invalid_request', 'send { orderId } or { error }');
    const session = await loadSession(c);
    if (!session) return json(c, 404, 'not_found', 'session not found');
    const out = await withLock(c, session.id, async (session) => {
      const action = await repo.getAction(tenant.id, c.req.param('actionId')!);
      if (!action || action.sessionId !== session.id) return null;
      const events: AgentEvent[] = [];
      await completeAction(deps, tenant, session, action, body.data, emitAll(events));
      return events;
    });
    if (out === 'busy' || out === 'gone') return lockFailure(c, out, session.locale);
    if (!out) return json(c, 404, 'not_found', 'action not found');
    return c.json({ events: out });
  });

  // ── Tenant server API (secret key) ─────────────────────────────

  const PutCatalog = z.object({ products: z.array(Product).max(5000), bundles: z.array(Bundle).max(200).default([]) });

  app.put('/v1/catalog', bodyLimit({ maxSize: 5 * 1024 * 1024 }), secretAuth, async (c) => {
    const body = PutCatalog.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return json(c, 400, 'invalid_request', body.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const ids = new Set<string>();
    for (const p of body.data.products) {
      if (ids.has(p.id)) return json(c, 400, 'invalid_request', `duplicate product id ${p.id}`);
      ids.add(p.id);
    }
    const bundleIds = new Set<string>();
    for (const b of body.data.bundles) {
      if (bundleIds.has(b.id)) return json(c, 400, 'invalid_request', `duplicate combo id ${b.id}`);
      bundleIds.add(b.id);
      const missing = b.items.filter((i) => !ids.has(i.id)).map((i) => i.id);
      if (missing.length) return json(c, 400, 'invalid_request', `combo ${b.id} uses unknown products: ${missing.slice(0, 10).join(', ')}`);
    }
    const rec = await repo.putCatalog(c.get('tenant').id, body.data.products, body.data.bundles);
    return c.json({ version: rec.version, count: rec.products.length, bundles: rec.bundles.length });
  });

  app.get('/v1/catalog', secretAuth, async (c) => {
    const rec = await repo.getCatalog(c.get('tenant').id);
    return c.json(rec ?? { version: 0, products: [] });
  });

  app.get('/v1/tenant', secretAuth, (c) => {
    const { id, name, config, publishableKey } = c.get('tenant');
    return c.json({ id, name, config, publishableKey });
  });

  app.patch('/v1/tenant/config', smallBody, secretAuth, async (c) => {
    const tenant = c.get('tenant');
    const patch = await c.req.json().catch(() => null);
    if (!patch || typeof patch !== 'object') return json(c, 400, 'invalid_request', 'JSON object required');
    const parsed = TenantConfig.safeParse({ ...tenant.config, ...patch });
    if (!parsed.success) return json(c, 400, 'invalid_request', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    await repo.updateTenantConfig(tenant.id, parsed.data);
    return c.json({ config: parsed.data });
  });

  // ── Admin (operator token) ─────────────────────────────────────

  const CreateTenant = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes'),
    name: z.string().min(1).max(120),
    config: TenantConfig,
  });

  app.post('/admin/tenants', smallBody, async (c) => {
    const token = bearer(c);
    if (!token || !safeEqual(token, opts.adminToken)) return json(c, 401, 'unauthorized', 'admin token required');
    const body = CreateTenant.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return json(c, 400, 'invalid_request', body.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (await repo.getTenant(body.data.id)) return json(c, 409, 'exists', 'tenant id already exists');
    const publishableKey = newPublishableKey();
    const secretKey = newSecretKey();
    await repo.createTenant({ ...body.data, publishableKey, secretKeyHash: hashSecret(secretKey) });
    return c.json({
      id: body.data.id,
      publishableKey,
      secretKey, // shown once
      webhookSigningKey: webhookKey(deps.webhookSigningSecret, body.data.id),
    }, 201);
  });

  return app;
}
