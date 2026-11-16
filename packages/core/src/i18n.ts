import type { Locale } from './types';

// ─────────────────────────────────────────────────────────────────
// Tamil + English support for everything the server says itself.
// The model handles conversational language; these strings cover
// confirmations, errors and order events, which must not depend on
// the model.
// ─────────────────────────────────────────────────────────────────

const TAMIL_RANGE = /[஀-௿]/;

export function hasTamilScript(text: string): boolean {
  return TAMIL_RANGE.test(text);
}

/**
 * Picks the locale for server-written text from what the customer typed.
 * Tamil script → ta. Latin text keeps the current locale, because
 * Tanglish ("enna price?") is Latin script but the customer may still
 * prefer Tamil; an explicit English sentence is not reliably detectable.
 */
export function detectLocale(text: string, current: Locale): Locale {
  if (hasTamilScript(text)) return 'ta';
  return current;
}

/** Indian digit grouping: 125000 → ₹1,25,000. */
export function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

const normalize = (s: string) =>
  s.normalize('NFC').trim().toLowerCase().replace(/[.!।\s]+$/u, '').replace(/\s+/g, ' ');

// Only explicit keywords count — a casual "ok" or "சரி" must never place an order.
const CONFIRM_WORDS = new Set(['confirm', 'confirm order', 'yes confirm', 'yes, confirm', 'உறுதி', 'உறுதிப்படுத்து', 'உறுதி செய்']);
const CANCEL_WORDS = new Set(['cancel', 'cancel order', 'ரத்து', 'ரத்து செய்']);

export function isConfirmKeyword(text: string): boolean {
  return CONFIRM_WORDS.has(normalize(text));
}

export function isCancelKeyword(text: string): boolean {
  return CANCEL_WORDS.has(normalize(text));
}

type Params = Record<string, string | number>;
type Dict = Record<string, (p: Params) => string>;

const en: Dict = {
  confirm_prompt: (p) => `Please review your order (${p.units} items, total ${p.total}). Tap Confirm or reply CONFIRM to place it, or CANCEL to change it.`,
  order_awaiting_client: () => 'Placing your order…',
  order_placed: (p) => `Your order is placed! Order ID: #${p.orderId}. Thank you for shopping with ${p.shop}.`,
  order_cancelled: () => 'Okay, I have not placed the order. You can keep changing your items.',
  order_failed: (p) => `Sorry, the order could not be placed${p.reason ? ` (${p.reason})` : ''}. Please try again.`,
  action_expired: () => 'That confirmation has expired. Ask me to check out again and I will prepare a fresh summary.',
  cart_changed: () => 'Your cart changed after the summary was shown, so I have not placed the order. Ask me to check out again.',
  no_pending: () => 'There is no order waiting for confirmation right now.',
  refusal: () => 'Sorry, I cannot help with that. I can help you choose products, check prices, and place your order.',
  error: () => 'Sorry, something went wrong on my side. Please try again in a moment.',
  busy: () => 'I am still answering your previous message. Please wait a moment.',
  rate_limited: () => 'You are sending messages too quickly. Please wait a minute and try again.',
  turn_limit: () => 'This chat has reached its limit. Please start a new chat to continue — your items are kept on the page.',
  session_expired: () => 'This chat has expired. Please start a new chat — your items are kept on the page.',
  budget_exceeded: () => 'The assistant is resting for today. You can still add items with Search and place your order as usual.',
  undo_done: () => 'Undone. Your cart is back to how it was.',
  undo_empty: () => 'There is nothing to undo.',
  truncated: () => 'Sorry, my reply was cut off. Could you ask that again?',
};

const ta: Dict = {
  confirm_prompt: (p) => `உங்கள் ஆர்டரைச் சரிபார்க்கவும் (${p.units} பொருட்கள், மொத்தம் ${p.total}). ஆர்டர் செய்ய Confirm பட்டனை அழுத்தவும் அல்லது "உறுதி" என்று பதிலளிக்கவும். மாற்ற வேண்டுமெனில் "ரத்து" என்று பதிலளிக்கவும்.`,
  order_awaiting_client: () => 'உங்கள் ஆர்டர் பதிவு செய்யப்படுகிறது…',
  order_placed: (p) => `உங்கள் ஆர்டர் பதிவு செய்யப்பட்டது! ஆர்டர் எண்: #${p.orderId}. ${p.shop}-இல் வாங்கியதற்கு நன்றி.`,
  order_cancelled: () => 'சரி, ஆர்டர் செய்யவில்லை. நீங்கள் பொருட்களைத் தொடர்ந்து மாற்றலாம்.',
  order_failed: (p) => `மன்னிக்கவும், ஆர்டர் பதிவு செய்ய முடியவில்லை${p.reason ? ` (${p.reason})` : ''}. மீண்டும் முயற்சிக்கவும்.`,
  action_expired: () => 'இந்த உறுதிப்படுத்தல் காலாவதியாகிவிட்டது. மீண்டும் செக்அவுட் செய்யச் சொல்லுங்கள், புதிய சுருக்கம் தருகிறேன்.',
  cart_changed: () => 'சுருக்கம் காட்டிய பிறகு உங்கள் கார்ட் மாறிவிட்டது, அதனால் ஆர்டர் செய்யவில்லை. மீண்டும் செக்அவுட் செய்யச் சொல்லுங்கள்.',
  no_pending: () => 'உறுதிப்படுத்தக் காத்திருக்கும் ஆர்டர் எதுவும் இல்லை.',
  refusal: () => 'மன்னிக்கவும், அதற்கு என்னால் உதவ முடியாது. பொருட்களைத் தேர்வு செய்ய, விலை பார்க்க, ஆர்டர் செய்ய உதவுகிறேன்.',
  error: () => 'மன்னிக்கவும், ஏதோ தவறு நடந்துவிட்டது. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.',
  busy: () => 'உங்கள் முந்தைய செய்திக்கு இன்னும் பதில் அளித்துக்கொண்டிருக்கிறேன். சற்று காத்திருக்கவும்.',
  rate_limited: () => 'நீங்கள் மிக வேகமாக செய்திகள் அனுப்புகிறீர்கள். ஒரு நிமிடம் கழித்து மீண்டும் முயற்சிக்கவும்.',
  turn_limit: () => 'இந்த உரையாடல் அதன் வரம்பை எட்டிவிட்டது. தொடர புதிய உரையாடலைத் தொடங்கவும் — உங்கள் பொருட்கள் பக்கத்தில் அப்படியே இருக்கும்.',
  session_expired: () => 'இந்த உரையாடல் காலாவதியாகிவிட்டது. புதிய உரையாடலைத் தொடங்கவும் — உங்கள் பொருட்கள் பக்கத்தில் அப்படியே இருக்கும்.',
  budget_exceeded: () => 'உதவியாளர் இன்று ஓய்வில் இருக்கிறார். Search மூலம் பொருட்களைச் சேர்த்து வழக்கம் போல் ஆர்டர் செய்யலாம்.',
  undo_done: () => 'மாற்றம் திரும்பப் பெறப்பட்டது. உங்கள் கார்ட் முன்பு இருந்தபடி உள்ளது.',
  undo_empty: () => 'திரும்பப் பெற எதுவும் இல்லை.',
  truncated: () => 'மன்னிக்கவும், என் பதில் பாதியில் நின்றுவிட்டது. மீண்டும் கேட்க முடியுமா?',
};

const DICTS: Record<Locale, Dict> = { en, ta };

export type MessageKey = keyof typeof en;

export function t(locale: Locale, key: MessageKey, params: Params = {}): string {
  const fn = DICTS[locale][key] ?? en[key]!;
  return fn(params);
}
