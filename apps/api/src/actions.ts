import { createHmac } from 'node:crypto';
import { cartHash, formatINR, t } from '@shop-agent/core';
import type { Deps, Emit } from './deps';
import type { ActionRecord, SessionRecord, TenantRecord } from './repo/types';

// Order confirmation lifecycle:
//   pending ──confirm──▶ confirmed ──complete──▶ completed
//      │                    └──────fail───────▶ failed
//      ├──cancel──▶ cancelled
//      └──ttl─────▶ expired
// Only a customer action (button or exact keyword) moves pending → confirmed.

export async function expireIfStale(deps: Deps, tenant: TenantRecord, action: ActionRecord): Promise<ActionRecord> {
  if (action.status === 'pending' && action.expiresAt.getTime() <= deps.now().getTime()) {
    await deps.repo.updateAction(tenant.id, action.id, { status: 'expired' });
    return { ...action, status: 'expired' };
  }
  return action;
}

async function addEvent(deps: Deps, session: SessionRecord, event: string) {
  session.pendingEvents = [...session.pendingEvents, event];
  await deps.repo.updateSession(session.tenantId, session.id, { pendingEvents: session.pendingEvents });
}

export async function confirmAction(deps: Deps, tenant: TenantRecord, session: SessionRecord, action: ActionRecord, emit: Emit): Promise<void> {
  const locale = session.locale;
  action = await expireIfStale(deps, tenant, action);
  if (action.status === 'expired') {
    await addEvent(deps, session, 'The order summary expired before the customer confirmed. No order was placed.');
    await emit({ type: 'text', text: t(locale, 'action_expired'), source: 'system' });
    return;
  }
  if (action.status !== 'pending') {
    await emit({ type: 'text', text: t(locale, 'no_pending'), source: 'system' });
    return;
  }
  if (cartHash(session.cart) !== action.cartHash) {
    await deps.repo.updateAction(tenant.id, action.id, { status: 'cancelled' });
    await addEvent(deps, session, 'The customer tried to confirm, but the cart changed after the summary was shown, so the summary was cancelled. No order was placed. Call request_checkout again if they still want to order.');
    await emit({ type: 'action.cancelled', actionId: action.id });
    await emit({ type: 'text', text: t(locale, 'cart_changed'), source: 'system' });
    return;
  }

  await deps.repo.updateAction(tenant.id, action.id, { status: 'confirmed' });

  if (tenant.config.orderExecutor === 'client') {
    await emit({ type: 'action.execute', actionId: action.id, actionType: action.type, payload: action.payload });
    await emit({ type: 'text', text: t(locale, 'order_awaiting_client'), source: 'system' });
    return;
  }

  const res = await sendOrderWebhook(deps, tenant, session, action);
  await completeAction(deps, tenant, session, { ...action, status: 'confirmed' }, res, emit);
}

export async function cancelAction(deps: Deps, tenant: TenantRecord, session: SessionRecord, action: ActionRecord, emit: Emit): Promise<void> {
  if (action.status !== 'pending') {
    await emit({ type: 'text', text: t(session.locale, 'no_pending'), source: 'system' });
    return;
  }
  await deps.repo.updateAction(tenant.id, action.id, { status: 'cancelled' });
  await addEvent(deps, session, 'The customer cancelled the order summary. No order was placed; they may want to change items.');
  await emit({ type: 'action.cancelled', actionId: action.id });
  await emit({ type: 'text', text: t(session.locale, 'order_cancelled'), source: 'system' });
}

export async function completeAction(
  deps: Deps, tenant: TenantRecord, session: SessionRecord, action: ActionRecord,
  outcome: { orderId: string } | { error: string }, emit: Emit,
): Promise<void> {
  const locale = session.locale;
  if (action.status !== 'confirmed') {
    await emit({ type: 'error', code: 'invalid_state', message: `action is ${action.status}` });
    return;
  }
  if ('orderId' in outcome) {
    await deps.repo.updateAction(tenant.id, action.id, { status: 'completed', result: { orderId: outcome.orderId } });
    session.status = 'ordered';
    await deps.repo.updateSession(tenant.id, session.id, { status: 'ordered' });
    await addEvent(deps, session, `The customer confirmed and the order was placed. Order ID #${outcome.orderId}, total ${formatINR(action.payload.quote.total)}.`);
    await emit({ type: 'action.completed', actionId: action.id, orderId: outcome.orderId });
    await emit({ type: 'text', text: t(locale, 'order_placed', { orderId: outcome.orderId, shop: tenant.config.shopName }), source: 'system' });
  } else {
    await deps.repo.updateAction(tenant.id, action.id, { status: 'failed', result: { error: outcome.error } });
    await addEvent(deps, session, `The customer confirmed but placing the order failed (${outcome.error}). No order was placed.`);
    await emit({ type: 'text', text: t(locale, 'order_failed', { reason: '' }), source: 'system' });
  }
}

// ── Webhook executor ──────────────────────────────────────────────

/** Each tenant's signing key is derived, so no per-tenant secret has to be stored. */
export function webhookKey(serverSecret: string, tenantId: string): string {
  return createHmac('sha256', serverSecret).update(`webhook:${tenantId}`).digest('hex');
}

export function signWebhook(key: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function sendOrderWebhook(deps: Deps, tenant: TenantRecord, session: SessionRecord, action: ActionRecord): Promise<{ orderId: string } | { error: string }> {
  const url = tenant.config.webhook?.url;
  if (!url) return { error: 'webhook not configured' };
  const body = JSON.stringify({
    type: 'order.place',
    idempotencyKey: action.id,
    tenantId: tenant.id,
    sessionId: session.id,
    payload: action.payload,
  });
  const key = webhookKey(deps.webhookSigningSecret, tenant.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ts = Math.floor(deps.now().getTime() / 1000);
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shop-agent-signature': signWebhook(key, ts, body), 'idempotency-key': action.id },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { orderId?: unknown };
        if (typeof data.orderId === 'string' && data.orderId) return { orderId: data.orderId };
        return { error: 'webhook response missing orderId' };
      }
      if (res.status < 500) return { error: `webhook returned ${res.status}` };
    } catch {
      // network error or timeout: retry once with the same idempotency key
    }
  }
  return { error: 'webhook unreachable' };
}
