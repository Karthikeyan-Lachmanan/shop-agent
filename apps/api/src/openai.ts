import type Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk, ChatCompletionContentPartText, ChatCompletionCreateParamsStreaming, ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam, ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaTool, ModelClient, ModelRequest } from './model';

type CreateStream = (body: ChatCompletionCreateParamsStreaming, opts: { signal?: AbortSignal }) => Promise<AsyncIterable<ChatCompletionChunk>>;

// ── Request translation ─────────────────────────────────────────────

export function toOpenAITools(tools: BetaTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
      strict: true,
    },
  }));
}

function toolResultText(block: Anthropic.Beta.BetaToolResultBlockParam): string {
  const body = typeof block.content === 'string'
    ? block.content
    : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  // Chat completions has no error flag on tool messages, so say it in the content.
  return block.is_error ? `ERROR: ${body}` : body;
}

/**
 * Stored history → chat messages. Tool results become `tool` messages placed
 * right after the assistant turn that called them; provider-specific blocks
 * (thinking, fallback markers) are dropped.
 */
export function toOpenAIMessages(system: BetaTextBlockParam[], messages: BetaMessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system.map((b) => b.text).join('\n\n') }];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : (m.content ?? []);
    if (m.role === 'assistant') {
      const text = blocks.filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text').map((b) => b.text).join('');
      const toolCalls: ChatCompletionMessageFunctionToolCall[] = blocks
        .filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && toolCalls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
    }
    const parts: ChatCompletionContentPartText[] = blocks
      .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text')
      .map((b) => ({ type: 'text', text: b.text }));
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

/** reasoning_effort is only accepted by reasoning models; sending it to others is a 400. */
export function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model) && !model.includes('chat-latest');
}

// ── Response translation ────────────────────────────────────────────

const STOP_MAP: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Fails the tool's schema check, so the model gets an error result and can retry.
    return { __invalid_json__: raw };
  }
}

/** Folds a chat-completions stream into one Messages-shaped reply. */
export async function collectStream(stream: AsyncIterable<ChatCompletionChunk>, onText: (delta: string) => void, model: string): Promise<BetaMessage> {
  let text = '';
  let refusal = '';
  let finish: string | null = null;
  let id = '';
  let usage: ChatCompletionChunk['usage'] = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    id ||= chunk.id;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices) {
      const d = choice.delta;
      if (d?.content) {
        text += d.content;
        onText(d.content);
      }
      if (d?.refusal) refusal += d.refusal;
      for (const tc of d?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.Beta.BetaContentBlock);
  for (const [, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) } as Anthropic.Beta.BetaContentBlock);
  }
  let stop = STOP_MAP[finish ?? 'stop'] ?? 'end_turn';
  if (refusal) stop = 'refusal';
  if (stop === 'tool_use' && calls.size === 0) stop = 'end_turn';

  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: id || 'chatcmpl',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
      output_tokens: usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

// ── Client ──────────────────────────────────────────────────────────

type EffortMode = 'tenant' | 'none' | 'omit';

function rejectsReasoningEffort(err: unknown): boolean {
  const e = err as { status?: number; param?: string | null } | null;
  return e?.status === 400 && e.param === 'reasoning_effort';
}

export class OpenAIModel implements ModelClient {
  private create: CreateStream;
  /**
   * Some models refuse reasoning_effort alongside function tools on this
   * endpoint (e.g. gpt-5.4-mini only accepts "none"). Learned per model on
   * the first 400 and reused, so later turns don't pay for the retry.
   */
  private effortMode = new Map<string, EffortMode>();

  constructor(opts: { apiKey?: string; baseURL?: string; create?: CreateStream } = {}) {
    if (opts.create) {
      this.create = opts.create;
    } else {
      const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      this.create = (body, o) => client.chat.completions.create(body, o);
    }
  }

  async run(req: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal) {
    const base: ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: toOpenAITools(req.tools),
      max_completion_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    };
    const order: EffortMode[] = supportsReasoningEffort(req.model) ? ['tenant', 'none', 'omit'] : ['omit'];
    const known = this.effortMode.get(req.model);
    const modes = known ? order.slice(order.indexOf(known)) : order;

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]!;
      const body = mode === 'omit' ? base : { ...base, reasoning_effort: mode === 'none' ? ('none' as const) : req.effort };
      try {
        // The error (if any) is raised when the request is sent, before any text is streamed.
        const stream = await this.create(body, { signal });
        this.effortMode.set(req.model, mode);
        return await collectStream(stream, onText, req.model);
      } catch (err) {
        if (i < modes.length - 1 && rejectsReasoningEffort(err)) continue;
        throw err;
      }
    }
    throw new Error('unreachable');
  }
}
