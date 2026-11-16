import { z } from 'zod';

// Tool contracts. JSON schemas go to the model (with strict: true);
// the zod schemas re-validate every call before anything runs.

export const ShowProductsInput = z.object({ ids: z.array(z.string()).min(1).max(12) });
export const SearchProductsInput = z.object({ query: z.string().min(1).max(200) });
export const SetItemQtyInput = z.object({ pack: z.string().min(1), id: z.string().min(1), qty: z.number().int().min(0) });
export const AddPackInput = z.object({ combo_id: z.string().min(1) });
export const PackInput = z.object({ pack: z.string().min(1) });
export const GetCartInput = z.object({});
export const RequestCheckoutInput = z.object({
  name: z.string(),
  phone: z.string(),
  address: z.string(),
  email: z.string(),
});

export const TOOL_INPUTS = {
  show_products: ShowProductsInput,
  search_products: SearchProductsInput,
  get_cart: GetCartInput,
  set_item_qty: SetItemQtyInput,
  add_pack: AddPackInput,
  remove_pack: PackInput,
  reset_pack: PackInput,
  request_checkout: RequestCheckoutInput,
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/** Fixed order — changing it invalidates every tenant's prompt cache. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'show_products',
    description: 'Display product cards (photo, price, MRP, stock) to the customer. Call this whenever you recommend or describe specific products. Returns the facts shown on the cards.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Product ids from the catalog, at most 12.' } },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_products',
    description: 'Search the catalog by name, Tamil name, Tanglish spelling, category or tag. Returns up to 10 matches with ids, prices and stock.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What the customer is looking for, in any language or spelling.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_cart',
    description: 'Get the current cart: every pack with its items and subtotal, plus charges and the grand total.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'set_item_qty',
    description: 'Set the quantity of one product inside one pack of the cart. qty 0 removes it. Returns the updated cart. Only use when the customer asked for the change or agreed to it.',
    input_schema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'Key of the pack to change, from <cart_state> (use activePack when the customer means "this pack").' },
        id: { type: 'string', description: 'Product id from the catalog.' },
        qty: { type: 'integer', description: 'New total quantity for this product in this pack (not a delta).' },
      },
      required: ['pack', 'id', 'qty'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_pack',
    description: 'Add one of the shop\'s combo packs to the cart as a new pack, with its standard items. The customer can add the same combo more than once. Returns the updated cart.',
    input_schema: {
      type: 'object',
      properties: { combo_id: { type: 'string', description: 'Combo pack id from the combo pack list.' } },
      required: ['combo_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_pack',
    description: 'Remove a whole pack from the cart. Only when the customer asks for it.',
    input_schema: {
      type: 'object',
      properties: { pack: { type: 'string', description: 'Key of the pack to remove, from <cart_state>.' } },
      required: ['pack'],
      additionalProperties: false,
    },
  },
  {
    name: 'reset_pack',
    description: 'Restore one pack to its original items (the shop\'s standard combo, or what it started with). Only when the customer asks to undo their customizations for that pack.',
    input_schema: {
      type: 'object',
      properties: { pack: { type: 'string', description: 'Key of the pack to reset, from <cart_state>.' } },
      required: ['pack'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_checkout',
    description: 'Prepare the order for the current cart with the customer\'s details. Shows the customer an order summary to confirm; it does not place the order. Pass an empty string for any detail the customer has not given. Returns validation errors to fix, or confirms that the summary is waiting for the customer.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string', description: '10-digit Indian mobile number.' },
        address: { type: 'string', description: 'Full delivery address.' },
        email: { type: 'string', description: 'Empty string if not given.' },
      },
      required: ['name', 'phone', 'address', 'email'],
      additionalProperties: false,
    },
  },
];
