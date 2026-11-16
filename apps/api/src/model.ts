import Anthropic from '@anthropic-ai/sdk';

// The agent keeps conversations in Messages API shape (content blocks:
// text, tool_use, tool_result). Each provider adapter translates to and
// from its own wire format, so the agent loop is provider-agnostic.

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaTextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type BetaTool = Anthropic.Beta.BetaTool;

export type Provider = 'anthropic' | 'openai';

export interface ModelRequest {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  system: BetaTextBlockParam[];
  tools: BetaTool[];
  messages: BetaMessageParam[];
  /** Stable per-tenant key; providers that route by cache key use it to keep hit rates high. */
  cacheKey?: string;
}

/** The one seam between the agent loop and an LLM, so tests can script the model. */
export interface ModelClient {
  run(req: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<BetaMessage>;
}

export interface ModelProvider {
  client: ModelClient;
  defaultModel: string;
}

export type ModelRegistry = Partial<Record<Provider, ModelProvider>>;

export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async run(req: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal) {
    const stream = this.client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: req.effort },
        // A classifier decline is retried server-side on the recommended model
        // instead of leaving the customer with no answer.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    stream.on('text', onText);
    return stream.finalMessage();
  }
}

/** Status code of a provider SDK error (both SDKs expose `status`), for mapping to client error codes. */
export function providerErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}
