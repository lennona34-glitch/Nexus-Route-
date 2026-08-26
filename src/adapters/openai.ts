import { ProviderAdapter, AdapterError, readStreamWithInactivityTimeout } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType } from '../ir/types.js';
import { getGroqRequestBudget } from '../providers/groq-budget.js';

interface NormalizedUpstreamError {
  message: string;
  code?: string | number;
  retryAfterMs?: number;
}

function conciseText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return String(value).slice(0, 1200);
  }
}

function retryAfterMs(headers?: Headers): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.ceil(seconds * 1000));
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(300_000, Math.max(1_000, date - Date.now()));
}

function normalizeUpstreamError(payload: unknown, fallback: string, headers?: Headers): NormalizedUpstreamError {
  const root = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const error = root.error && typeof root.error === 'object'
    ? root.error as Record<string, any>
    : root.error !== undefined
      ? { message: root.error }
      : root;
  const metadata = error.metadata && typeof error.metadata === 'object'
    ? error.metadata as Record<string, any>
    : {};
  const providerName = conciseText(metadata.provider_name || metadata.provider || root.provider);
  const detailed = conciseText(metadata.raw || error.detail || error.message || root.message || payload || fallback);
  return {
    message: `${providerName ? `${providerName}: ` : ''}${detailed || fallback}`,
    code: error.code ?? root.code,
    retryAfterMs: retryAfterMs(headers),
  };
}

async function readUpstreamError(response: Response): Promise<NormalizedUpstreamError> {
  const text = await response.text().catch(() => '');
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {}
  return normalizeUpstreamError(payload, response.statusText || `HTTP ${response.status}`, response.headers);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function upstreamErrorMessage(provider: ProviderType, kind: 'request' | 'stream', status: number, error: NormalizedUpstreamError): string {
  const code = error.code !== undefined && String(error.code) !== String(status) ? `, code ${error.code}` : '';
  return `${provider} ${kind} error (${status}${code}): ${error.message}`;
}

function normalizeToolArgumentObject(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '{}';
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : '{}';
  } catch {
    return JSON.stringify({ raw: text });
  }
}

function normalizeMessages(req: UniversalRequest): UniversalRequest['messages'] {
  return req.messages.map(message => message.tool_calls?.length
    ? {
        ...message,
        tool_calls: message.tool_calls.map((toolCall, index) => ({
          id: toolCall.id || `call_${Date.now()}_${index}`,
          type: 'function' as const,
          function: {
            name: String(toolCall.function?.name || ''),
            arguments: normalizeToolArgumentObject((toolCall.function as any)?.arguments),
          },
        })),
      }
    : message);
}

// Only Anthropic models need - and accept - an explicit cache breakpoint here.
// Other providers on OpenRouter either cache automatically or ignore the field,
// so it is not worth sending to them.
function cachingSupported(model: string): boolean {
  return /(^|\/)anthropic\/|claude/i.test(model);
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: ProviderType;
  protected baseUrl: string;
  protected apiKey?: string;

  constructor(config?: { provider?: ProviderType; baseUrl?: string; apiKey?: string }) {
    this.provider = config?.provider || 'openai';
    this.baseUrl = config?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private getHeaders(sessionId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000';
      headers['X-OpenRouter-Title'] = process.env.OPENROUTER_APP_TITLE || 'NexusRoute';
    }
    if (this.provider === 'xai' && sessionId) {
      // xAI uses this stable conversation identifier to route related turns
      // to the same cache-warm server. Do not include user prompt content.
      headers['x-grok-conv-id'] = sessionId.slice(0, 256);
    }
    return headers;
  }

  private attachOpenRouterUsageMetadata<T extends { usage?: UniversalResponse['usage']; cache_discount?: number }>(data: T): T {
    if (this.provider === 'openrouter' && data.usage && typeof data.cache_discount === 'number') {
      data.usage.cache_discount = data.cache_discount;
    }
    return data;
  }

  private cleanModel(targetModel: string): string {
    let m = targetModel;
    const discoveredPrefix = `${this.provider}::`;
    if (m.startsWith(discoveredPrefix)) return m.slice(discoveredPrefix.length);
    if (m.startsWith('groq/')) m = m.slice(5);
    if (m.startsWith('together/')) m = m.slice(9);
    if (m.startsWith('github/')) m = m.slice(7);
    if (m.startsWith('deepseek/')) m = m.slice(9);
    if (m.startsWith('mistral/')) m = m.slice(8);
    if (m.startsWith('xai/')) m = m.slice(4);
    if (m.startsWith('ollama/')) m = m.slice(7);
    return m;
  }

  protected buildPayload(req: UniversalRequest, targetModel: string, stream: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.cleanModel(targetModel),
      messages: normalizeMessages(req),
      stream,
    };
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;
    if (req.user !== undefined) payload.user = req.user;

    if (this.provider === 'openrouter') {
      if (req.session_id) payload.session_id = req.session_id;
      // Anthropic models do not cache unless a breakpoint is sent - unlike
      // OpenAI models, which cache automatically. An agent loop re-sends the
      // whole conversation every turn, so without this the repeated prefix is
      // billed at full input price on each one. The top-level form lets
      // OpenRouter advance the breakpoint as the conversation grows, which is
      // the documented shape for multi-turn use and cannot exceed the
      // four-breakpoint limit. Cache reads bill at 0.1x input.
      if (cachingSupported(targetModel) && process.env.NEXUS_PROMPT_CACHE !== 'off') {
        const ttl = process.env.NEXUS_PROMPT_CACHE_TTL?.trim();
        payload.cache_control = ttl && ttl !== '5m'
          ? { type: 'ephemeral', ttl }
          : { type: 'ephemeral' };
      }
      const routingMode = req.openrouter_routing || 'balanced';
      const hasToolChain = !!req.tools?.length || req.messages.some(message => !!message.tool_calls?.length || message.role === 'tool');
      if (routingMode !== 'balanced' || hasToolChain) {
        payload.provider = {
          ...(routingMode !== 'balanced' ? {
            sort: (routingMode === 'cheapest' || routingMode === 'free')
            ? 'price'
            : routingMode === 'fastest'
              ? 'throughput'
              : 'exacto',
          } : {}),
          allow_fallbacks: true,
          ...(hasToolChain ? { require_parameters: true } : {}),
        };
      }
    }

    // Provider-aware clamping for Groq TPM limits (includes tools and the
    // complete system/history payload). The router normally skips an
    // oversized first attempt; this also protects later tool-call turns.
    if (this.baseUrl.includes('groq.com')) {
      const budget = getGroqRequestBudget(req);
      if (!budget.allowed) {
        throw new AdapterError(budget.reason || 'Groq request exceeds its configured TPM safety budget.', 'groq', 413, false);
      }
      payload.max_tokens = budget.maxCompletionTokens;
    } else if (req.max_tokens !== undefined) {
      payload.max_tokens = req.max_tokens;
    } else {
      payload.max_tokens = 8192;
    }

    if (req.tools !== undefined && Array.isArray(req.tools) && req.tools.length > 0) {
      payload.tools = req.tools;
    }
    if (req.tool_choice !== undefined) payload.tool_choice = req.tool_choice;
    if (req.response_format !== undefined) payload.response_format = req.response_format;
    if (this.baseUrl.includes('11434') || this.baseUrl.includes('localhost')) {
      payload.keep_alive = '5m';
      (payload as any).options = { num_ctx: 65536 };
    }
    if (this.baseUrl.includes('deepseek.com') || targetModel.includes('deepseek')) {
      if (req.max_tokens === undefined) {
        payload.max_tokens = 8192;
      }
    }
    if (req.stop !== undefined) payload.stop = req.stop;
    return payload;
  }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    if (!this.apiKey && !this.baseUrl.includes('localhost')) {
      throw new AdapterError(`${this.provider} API key not configured`, this.provider, 401, false);
    }

    const payload = this.buildPayload(req, targetModel, false);
    const controller = new AbortController();
    const hardTimeoutMs = req.timeout_ms || (this.provider === 'xai' ? 150_000 : this.baseUrl.includes('localhost') ? 180_000 : 90_000);
    const hardTimeout = setTimeout(() => controller.abort(), hardTimeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(req.session_id),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(hardTimeout);
      if (controller.signal.aborted) {
        throw new AdapterError(`${this.provider} request exceeded the ${Math.round(hardTimeoutMs / 1000)}s wall-clock limit`, this.provider, 408, true, err);
      }
      throw new AdapterError(`Network error reaching ${this.provider}: ${(err as Error).message}`, this.provider, 503, true, err);
    }

    if (!res.ok) {
      const upstreamError = await readUpstreamError(res);
      clearTimeout(hardTimeout);
      throw new AdapterError(
        upstreamErrorMessage(this.provider, 'request', res.status, upstreamError),
        this.provider,
        res.status,
        retryableStatus(res.status),
        undefined,
        upstreamError.retryAfterMs,
      );
    }

    try {
      const data = (await res.json()) as UniversalResponse;
      return this.attachOpenRouterUsageMetadata(data);
    } finally {
      clearTimeout(hardTimeout);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    if (!this.apiKey && !this.baseUrl.includes('localhost')) {
      throw new AdapterError(`${this.provider} API key not configured`, this.provider, 401, false);
    }

    const payload = this.buildPayload(req, targetModel, true);
    const controller = new AbortController();
    const hardTimeoutMs = req.timeout_ms || (this.provider === 'xai' ? 150_000 : this.baseUrl.includes('localhost') || this.baseUrl.includes('11434') ? 180_000 : 90_000);
    const hardTimeout = setTimeout(() => controller.abort(), hardTimeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(req.session_id),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(hardTimeout);
      if (controller.signal.aborted) {
        throw new AdapterError(`${this.provider} stream exceeded the ${Math.round(hardTimeoutMs / 1000)}s wall-clock limit`, this.provider, 408, true, err);
      }
      throw new AdapterError(`Network error reaching ${this.provider}: ${(err as Error).message}`, this.provider, 503, true, err);
    }

    if (!res.ok) {
      const upstreamError = await readUpstreamError(res);
      clearTimeout(hardTimeout);
      throw new AdapterError(
        upstreamErrorMessage(this.provider, 'stream', res.status, upstreamError),
        this.provider,
        res.status,
        retryableStatus(res.status),
        undefined,
        upstreamError.retryAfterMs,
      );
    }

    if (!res.body) {
      clearTimeout(hardTimeout);
      throw new AdapterError(`${this.provider} response has no readable body stream`, this.provider, 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const inactivityTimeout = req.timeout_ms || (this.baseUrl.includes('localhost') || this.baseUrl.includes('11434') ? 180000 : 120000);
        const { done, value } = await readStreamWithInactivityTimeout(reader, inactivityTimeout, this.provider);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') return;

          if (trimmed.startsWith('data: ')) {
            let parsed: any;
            try {
              parsed = JSON.parse(trimmed.slice(6));
            } catch {
              // ignore partial parse errors in sse stream
              continue;
            }
            if (parsed?.error) {
              const upstreamError = normalizeUpstreamError(parsed, `${this.provider} streaming provider failed`);
              const status = Number(upstreamError.code);
              const statusCode = Number.isFinite(status) && status >= 400 && status <= 599 ? status : 502;
              throw new AdapterError(
                upstreamErrorMessage(this.provider, 'stream', statusCode, upstreamError),
                this.provider,
                statusCode,
                retryableStatus(statusCode),
              );
            }
            const chunk = this.attachOpenRouterUsageMetadata(parsed as any);
            // Normalize DeepSeek reasoning_content into content / reasoning stream so UI never stalls
            if (chunk.choices?.[0]?.delta) {
              const delta = chunk.choices[0].delta;
              if (delta.reasoning_content && !delta.content) {
                delta.reasoning = delta.reasoning_content;
                // If client only handles content, wrap or stream reasoning content
                delta.content = delta.reasoning_content;
              }
            }
            yield chunk as UniversalStreamChunk;
          }
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new AdapterError(`${this.provider} stream exceeded the ${Math.round(hardTimeoutMs / 1000)}s wall-clock limit`, this.provider, 408, true, err);
      }
      throw err;
    } finally {
      clearTimeout(hardTimeout);
      if (!controller.signal.aborted) controller.abort();
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}
