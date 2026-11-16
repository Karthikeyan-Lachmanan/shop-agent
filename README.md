# Shop Agent

A headless shopping assistant API that many shops (tenants) can share. A customer chats in **English, Tamil script or Tanglish**. The agent answers questions about products, shows product cards (photo, price, stock), edits the cart, and prepares an order that the **customer confirms themselves**.

Any frontend can use it: the API streams typed events over SSE, and every event that carries UI also carries plain data for a text-only fallback.

```
apps/api         Hono server: sessions, agent loop, SSE, confirmations, webhooks
packages/core    Types, pricing, Tamil/English text, catalog search, prompt, tool schemas (pure, unit-tested)
packages/db      Drizzle schema + SQL migrations (Postgres)
packages/sdk     Typed client + SSE parser for frontends
examples/        Tenant config for Naga Crackers
```

## Run locally

```bash
npm install
cp .env.example .env           # set OPENAI_API_KEY (or ANTHROPIC_API_KEY) and ADMIN_TOKEN
docker compose up -d           # optional: Postgres + Redis (without them, storage is in memory)
npm run dev                    # http://localhost:8080
npm test                       # 30 tests, no API calls
```

Create a tenant and push its catalog:

```bash
API_URL=http://localhost:8080 ADMIN_TOKEN=... npm run seed:tenant -- examples/naga-crackers.tenant.json
curl -X PUT localhost:8080/v1/catalog -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
  -d '{"products":[{"id":"FP001","name":"Flower Pot Big","nameTa":"பூச்சட்டி பெரியது","category":"Flower Pots","price":120,"mrp":600,"inStock":true}]}'
```

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**. `railway.json` tells Railway to build with the `Dockerfile` and health-check `/healthz`.
3. In the same project: **New → Database → PostgreSQL**, and **New → Database → Redis**.
4. On the API service, under **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` (at least one), optionally `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `LLM_PROVIDER`
   - `ADMIN_TOKEN` (24+ chars), `WEBHOOK_SIGNING_SECRET` (32+ chars, never change it once tenants are live)
   - `NODE_ENV=production` is already set in the image. In production all of the above are required, and the server refuses to start without them.
5. **Settings → Networking → Generate Domain**, or add a custom domain.
6. Run `seed:tenant` against the Railway URL, then push the catalog with the tenant's secret key.

Migrations run on every boot. A Postgres advisory lock makes this safe with several replicas. Sessions and limits are stored in Postgres and Redis, so you can scale replicas freely.

## Carts with several packs

A cart is a list of **packs**. A pack is either a combo pack the customer chose, or a single "main" pack for plain shopping. The model sees each pack with its key, and which pack is active. It changes items inside one pack (`set_item_qty` with `pack`), adds a shop combo as a new pack (`add_pack`, and the same combo can be added twice), removes a pack (`remove_pack`), or restores a combo's original items (`reset_pack`). Checkout orders every pack together. `ui.cart` events carry `state` (the raw packs) so the host can mirror changes, and each pack in `cart.groups` has its own subtotal and a `customized` flag.

## Tamil and English

| Where | How |
|---|---|
| Replies | The model answers in the form the customer uses: Tamil script, Tanglish or English. It switches when they switch. |
| Products | `nameTa` / `categoryTa` go into the prompt and onto the cards. `aliases` add Tanglish spellings and nicknames. |
| Search | `search_products` matches Tamil script directly, and matches Latin text by a loose phonetic key (`mathaapu` finds `mathappu`, `puchatti` finds `poochatti`). |
| Server text | Confirmations, order results, errors and limits come in both `en` and `ta` (`packages/core/src/i18n.ts`). The session locale switches to `ta` when the customer types Tamil script. |
| Confirming | Only an exact keyword confirms an order: `CONFIRM` / `உறுதி` (cancel: `CANCEL` / `ரத்து`). "ok", "சரி" and "ஆம்" never place an order. |

## API

Browser calls use the tenant's **publishable key** (`Authorization: Bearer pk_...`), and are checked against `allowedOrigins`. Server calls use the **secret key** (`sk_...`).

| Method | Path | Key | Purpose |
|---|---|---|---|
| POST | `/v1/sessions` | pk | `{ locale?, context?: { surface, title, groups?: [{ key, bundleId?, title, items: [{id, qty}] }], active?, baseItems? } }` starts a chat. `groups` are the packs already in the cart (for example combo packs); `active` is the one the customer is looking at. Simple hosts can send `baseItems` for a single pack. |
| GET | `/v1/sessions/:id` | pk | Cart, pending order summary, transcript |
| POST | `/v1/sessions/:id/messages` | pk | `{ text }` returns an SSE stream. Add `?stream=false` for `{ events: [...] }` |
| POST | `/v1/sessions/:id/actions/:actionId` | pk | `{ decision: "confirm" \| "cancel" }`, used by the Confirm button |
| POST | `/v1/sessions/:id/actions/:actionId/complete` | pk | Client executor reports back: `{ orderId }` or `{ error }` |
| PUT | `/v1/sessions/:id/cart` | pk | `{ groups, active? }` mirrors cart changes made on the page (packs added, edited, removed, or a different pack opened). Single-pack hosts can send `{ items: { id: qty } }`. |
| POST | `/v1/sessions/:id/cart/undo` | pk | Undo the last cart change |
| PUT / GET | `/v1/catalog` | sk | Replace / read `{ products, bundles? }`: up to 5000 products, and up to 200 bundles (combo packs: `{ id, name, nameTa?, description?, tags?, items: [{id, qty}] }`) |
| GET / PATCH | `/v1/tenant`, `/v1/tenant/config` | sk | Read / update tenant config |
| POST | `/admin/tenants` | ADMIN_TOKEN | Create a tenant. Returns the keys once. |

### Events

`text.delta` · `text` · `ui.products` · `ui.cart` · `ui.confirm` · `action.execute` · `action.completed` · `action.cancelled` · `locale` · `error` · `done` (types in `packages/core/src/events.ts`).

### Placing an order

```
model calls request_checkout ─▶ ui.confirm (summary, server-priced) ─▶ customer: Confirm button / "CONFIRM" / "உறுதி"
   ├─ orderExecutor "client":  action.execute ─▶ your frontend places the order ─▶ POST …/complete { orderId }
   └─ orderExecutor "webhook": signed POST to config.webhook.url ─▶ { "orderId": "..." }
```

- The model can only *prepare* a summary. Confirming is a customer action handled without the model.
- A summary expires after 10 minutes. It is cancelled if the cart changes after it was shown.
- Prices and totals always come from the catalog plus `charges`, never from model text.

**Webhook signature:** `x-shop-agent-signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(webhookSigningKey, "<t>.<raw body>")`. The tenant receives `webhookSigningKey` when it is created. Use `idempotency-key` (the action id) to avoid creating an order twice on retries.

## Model providers

The agent supports **OpenAI** and **Anthropic (Claude)**, and you can use either one, or both on the same server.

| | OpenAI | Anthropic |
|---|---|---|
| Key | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` |
| Default model | `OPENAI_MODEL` (default `gpt-5.4-mini`) | `ANTHROPIC_MODEL` (default `claude-opus-5-5`) |
| API used | Chat Completions, streaming, strict function tools | Messages API, streaming, strict tools, server-side refusal fallback |
| Effort | `effort` becomes `reasoning_effort` (reasoning models only) | `output_config.effort` |
| Prompt cache | Automatic for repeated prefixes; `prompt_cache_key` is set per tenant | Explicit breakpoint after the catalog |

- **Which provider a tenant uses:** `config.provider` (`"openai"` or `"anthropic"`) and `config.model` choose them. If those are unset, the tenant gets the server default. That default is whichever key is set, or `LLM_PROVIDER` when both are set.
- **Different models per shop:** `PATCH /v1/tenant/config` with `{ "provider": "openai", "model": "gpt-5.4-mini" }` switches a shop without redeploying.
- **Conversation format:** conversations are stored in one internal format (content blocks), and each adapter translates to and from it (`apps/api/src/openai.ts`, `apps/api/src/model.ts`). So a shop can switch providers mid-way, and the cart, ordering, and Tamil/English logic stay the same.
