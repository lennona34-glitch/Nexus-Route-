import { ProviderAdapter, AdapterError, readStreamWithInactivityTimeout } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType } from '../ir/types.js';
import { getGroqRequestBudget } from '../providers/groq-budget.js';

interface NormalizedUpstreamError {
  message: string;
  code?: string | number;
  retryAfterMs?: number;
  failedGeneration?: string;
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

function extractRetryAfterFromBody(message: string): number | undefined {
  if (!message) return undefined;
  const match = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i) || message.match(/try again in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(300_000, Math.ceil(seconds * 1000));
    }
  }
  return undefined;
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
  const failedGeneration = typeof error.failed_generation === 'string'
    ? error.failed_generation
    : typeof root.failed_generation === 'string'
      ? root.failed_generation
      : undefined;

  const retryMs = retryAfterMs(headers) ?? extractRetryAfterFromBody(detailed || fallback);

  return {
    message: `${providerName ? `${providerName}: ` : ''}${detailed || fallback}`,
    code: error.code ?? root.code,
    retryAfterMs: retryMs,
    failedGeneration,
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

function retryableStatus(status: number, message?: string): boolean {
  if (status === 400 && message && /(?:context length|maximum context|too many tokens|context_window_exceeded|overloaded|rate limit)/i.test(message)) {
    return true;
  }
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isToolUnsupportedError(status: number, message?: string): boolean {
  if (!message) return false;
  return (
    /support tool use/i.test(message) ||
    /function calling not support/i.test(message) ||
    /function calling is not supported/i.test(message) ||
    /does not support tools/i.test(message) ||
    /tools are not supported/i.test(message) ||
    /tools is not supported/i.test(message) ||
    /invalid parameter: tools/i.test(message) ||
    /tool_choice is not supported/i.test(message) ||
    /tools parameter is not supported/i.test(message)
  );
}

function isReasoningUnsupportedError(status: number, message?: string): boolean {
  if (!message) return false;
  return (
    /reasoningEffort/i.test(message) ||
    /reasoning_effort/i.test(message) ||
    /does not support parameter reasoning/i.test(message) ||
    /does not support reasoning/i.test(message) ||
    /does not support thinking/i.test(message) ||
    /unsupported parameter: ['"]?reasoning/i.test(message) ||
    /unrecognized request argument: ['"]?reasoning/i.test(message) ||
    /unknown parameter.*reasoning/i.test(message) ||
    /extra fields not permitted.*reasoning/i.test(message)
  );
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

function isVisionModel(provider: ProviderType, model: string): boolean {
  if (provider === 'deepseek') return false;
  const m = model.toLowerCase();
  if (m.includes('vision') || m.includes('-vl') || m.includes('4o') || m.includes('claude-3') || m.includes('pixtral') || m.includes('gemini') || m.includes('grok-2-vision')) {
    return true;
  }
  if (provider === 'anthropic' || provider === 'gemini') return true;
  return false;
}

function normalizeMessages(req: UniversalRequest, isVisionSupported = true, provider: ProviderType = 'openai'): UniversalRequest['messages'] {
  return req.messages.map(message => {
    let content = message.content;
    if (!isVisionSupported) {
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const part of content) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text);
          } else if (part.type === 'image_url') {
            textParts.push('[Attached image]');
          }
        }
        content = textParts.join('\n').trim() || '[Attached image]';
      } else if (typeof content === 'string') {
        content = content.replace(/!\[.*?\]\(data:image\/[^;]+;base64,[^\)]+\)/g, '[Attached image]');
      }
    }

    if (message.role === 'assistant' && typeof content === 'string') {
      const stripped = content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
      content = stripped.length > 0 ? stripped : (message.tool_calls?.length ? '' : content);
    }

    let reasoning_content = message.reasoning_content;
    const supportsReasoningContentProperty = provider === 'deepseek' || provider === 'cheaperinference';

    if (provider === 'deepseek' && message.role === 'assistant') {
      // DeepSeek strictly requires reasoning_content on assistant messages in multi-turn tool calling
      if (!reasoning_content && message.tool_calls?.length) {
        reasoning_content = typeof content === 'string' && content.trim() ? content : 'Executing requested tool calls.';
      }
    }

    const cleanedMsg: any = {
      role: message.role,
      content: content ?? '',
    };
    if (message.name) cleanedMsg.name = message.name;
    if (message.tool_call_id) cleanedMsg.tool_call_id = message.tool_call_id;

    if (supportsReasoningContentProperty && reasoning_content) {
      cleanedMsg.reasoning_content = reasoning_content;
    }

    if (message.tool_calls?.length) {
      cleanedMsg.tool_calls = message.tool_calls.map((toolCall, index) => ({
        id: toolCall.id || `call_${Date.now()}_${index}`,
        type: 'function' as const,
        function: {
          name: String(toolCall.function?.name || ''),
          arguments: normalizeToolArgumentObject((toolCall.function as any)?.arguments),
        },
      }));
    }
    return cleanedMsg;
  });
}

// Only Anthropic models need - and accept - an explicit cache breakpoint here.
// Other providers on OpenRouter either cache automatically or ignore the field,
// so it is not worth sending to them.
function cachingSupported(model: string): boolean {
  return /(^|\/)anthropic\/|claude/i.test(model);
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: ProviderType;
  protected config?: { provider?: ProviderType; baseUrl?: string; apiKey?: string };

  constructor(config?: { provider?: ProviderType; baseUrl?: string; apiKey?: string }) {
    this.provider = config?.provider || 'openai';
    this.config = config;
  }

  protected get baseUrl(): string {
    return this.config?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  }

  protected get apiKey(): string | undefined {
    return this.config?.apiKey || process.env.OPENAI_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private getHeaders(sessionId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'NexusRoute/1.3.0 (+https://github.com/nexusroute/nexus-route)',
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

    if (this.provider === 'openrouter') {
      if (m.startsWith('openrouter/') && (m === 'openrouter/free' || m === 'openrouter/auto' || m.startsWith('openrouter/flavor-'))) {
        return m;
      }
      if (m.startsWith('openrouter/')) return m.slice(11);
      return m;
    }

    if (this.provider === 'ollama' || this.provider === 'local') {
      while (m.startsWith('ollama/') || m.startsWith('local/')) {
        if (m.startsWith('ollama/')) m = m.slice(7);
        else if (m.startsWith('local/')) m = m.slice(6);
      }
      return m;
    }

    const slashPrefix = `${this.provider}/`;
    if (m.startsWith(slashPrefix)) {
      return m.slice(slashPrefix.length);
    }
    return m;
  }

  protected supportsReasoningEffort(targetModel: string): boolean {
    const m = targetModel.toLowerCase();
    if (this.provider === 'openai') {
      return m.includes('o1') || m.includes('o3') || m.includes('o4') || m.includes('reasoner') || m.includes('reasoning');
    }
    if (this.provider === 'xai') {
      return m.includes('reasoner') || (m.includes('grok-3') && m.includes('mini'));
    }
    if (this.provider === 'openrouter') {
      return m.includes('o1') || m.includes('o3') || m.includes('o4') || m.includes('reasoner') || m.includes('r1') || m.includes('qwq');
    }
    if (this.provider === 'local') {
      return m.includes('r1') || m.includes('deepseek-r1') || m.includes('qwq') || m.includes('reasoner') || m.includes('qwen3') || m.includes('brain');
    }
    return m.includes('reasoner') || m.includes('reasoning') || m.includes('o1') || m.includes('o3');
  }

  protected buildPayload(req: UniversalRequest, targetModel: string, stream: boolean): Record<string, unknown> {
    const cleanedModel = this.cleanModel(targetModel);
    const visionSupported = isVisionModel(this.provider, cleanedModel);
    const payload: Record<string, unknown> = {
      model: cleanedModel,
      messages: normalizeMessages(req, visionSupported, this.provider),
      stream,
    };
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;
    if (req.user !== undefined) payload.user = req.user;
    if (req.reasoning_effort !== undefined && req.reasoning_effort !== 'none' && this.supportsReasoningEffort(targetModel)) {
      payload.reasoning_effort = req.reasoning_effort;
    }

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
      const isFree = targetModel.includes(':free') || targetModel.includes('openrouter/free') || targetModel.includes('/free');
      const hasToolChain = !!req.tools?.length || req.messages.some(message => !!message.tool_calls?.length || message.role === 'tool');
      if (routingMode !== 'balanced' || (hasToolChain && !isFree)) {
        payload.provider = {
          ...(routingMode !== 'balanced' ? {
            sort: (routingMode === 'cheapest' || routingMode === 'free')
            ? 'price'
            : routingMode === 'fastest'
              ? 'throughput'
              : 'exacto',
          } : {}),
          allow_fallbacks: true,
          ...(hasToolChain && !isFree ? { require_parameters: true } : {}),
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
      payload.max_tokens = Math.min(8192, Math.max(req.max_tokens || 8192, budget.maxCompletionTokens));
    } else if (req.max_tokens !== undefined) {
      payload.max_tokens = req.max_tokens;
    } else if (targetModel.toLowerCase().includes('qwen') || this.baseUrl.includes('aliyuncs.com') || targetModel.toLowerCase().includes('coder')) {
      payload.max_tokens = 16384;
    } else {
      payload.max_tokens = 8192;
    }

    const isGroqCompound = this.provider === 'groq' && targetModel.toLowerCase().includes('compound');
    if (!isGroqCompound && req.tools !== undefined && Array.isArray(req.tools) && req.tools.length > 0) {
      payload.tools = req.tools;
    }
    if (!isGroqCompound && req.tool_choice !== undefined) payload.tool_choice = req.tool_choice;
    if (req.response_format !== undefined) payload.response_format = req.response_format;
    if (this.baseUrl.includes('11434') || this.baseUrl.includes('localhost')) {
      payload.keep_alive = '15m';
      (payload as any).options = { num_ctx: 8192 };
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
      if ((res.status === 400 || res.status === 404 || res.status === 422) && isToolUnsupportedError(res.status, upstreamError.message) && payload.tools) {
        return this.chatCompletion({ ...req, tools: undefined, tool_choice: undefined }, targetModel);
      }
      const hasReasoningParam = payload.reasoning_effort !== undefined || (payload as any).reasoningEffort !== undefined || (payload as any).thinking !== undefined || (payload as any).think !== undefined || req.reasoning_effort !== undefined;
      if ((res.status === 400 || res.status === 404 || res.status === 422) && isReasoningUnsupportedError(res.status, upstreamError.message) && hasReasoningParam) {
        const cleanedReq = { ...req, reasoning_effort: undefined };
        delete (cleanedReq as any).thinking;
        delete (cleanedReq as any).think;
        return this.chatCompletion(cleanedReq, targetModel);
      }
      if (upstreamError.code === 'tool_use_failed' && upstreamError.failedGeneration) {
        return {
          id: `salvage-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: upstreamError.failedGeneration },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };
      }
      throw new AdapterError(
        upstreamErrorMessage(this.provider, 'request', res.status, upstreamError),
        this.provider,
        res.status,
        retryableStatus(res.status, upstreamError.message),
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
    const hardTimeoutMs = req.timeout_ms || (
      this.provider === 'xai' ? 180_000 :
      this.provider === 'openrouter' ? 300_000 :
      this.baseUrl.includes('localhost') || this.baseUrl.includes('11434') ? 300_000 :
      240_000
    );
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

    // Clear the initial connect timer once headers and stream are established
    clearTimeout(hardTimeout);

    if (!res.ok) {
      const upstreamError = await readUpstreamError(res);
      if ((res.status === 400 || res.status === 404 || res.status === 422) && isToolUnsupportedError(res.status, upstreamError.message) && payload.tools) {
        yield* this.streamChatCompletion({ ...req, tools: undefined, tool_choice: undefined }, targetModel);
        return;
      }
      const hasReasoningParam = payload.reasoning_effort !== undefined || (payload as any).reasoningEffort !== undefined || (payload as any).thinking !== undefined || (payload as any).think !== undefined || req.reasoning_effort !== undefined;
      if ((res.status === 400 || res.status === 404 || res.status === 422) && isReasoningUnsupportedError(res.status, upstreamError.message) && hasReasoningParam) {
        const cleanedReq = { ...req, reasoning_effort: undefined };
        delete (cleanedReq as any).thinking;
        delete (cleanedReq as any).think;
        yield* this.streamChatCompletion(cleanedReq, targetModel);
        return;
      }
      if (upstreamError.code === 'tool_use_failed' && upstreamError.failedGeneration) {
        const salvagedChunk: UniversalStreamChunk = {
          id: `salvage-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            delta: { content: upstreamError.failedGeneration },
            finish_reason: 'stop',
          }],
        };
        yield salvagedChunk;
        return;
      }
      throw new AdapterError(
        upstreamErrorMessage(this.provider, 'stream', res.status, upstreamError),
        this.provider,
        res.status,
        retryableStatus(res.status, upstreamError.message),
        undefined,
        upstreamError.retryAfterMs,
      );
    }

    if (!res.body) {
      throw new AdapterError(`${this.provider} response has no readable body stream`, this.provider, 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const inactivityTimeout = Math.max(300_000, req.timeout_ms || 300_000);
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
              // If Groq or another provider fails tool calling syntax with 'failed_generation', salvage the raw text output!
              if (parsed.error.code === 'tool_use_failed' && typeof parsed.error.failed_generation === 'string' && parsed.error.failed_generation.trim()) {
                const salvagedChunk: UniversalStreamChunk = {
                  id: `salvage-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: targetModel,
                  choices: [{
                    index: 0,
                    delta: { content: parsed.error.failed_generation },
                    finish_reason: 'stop',
                  }],
                };
                yield salvagedChunk;
                return;
              }

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
            // Preserve DeepSeek reasoning_content as reasoning metadata without polluting user content
            if (chunk.choices?.[0]?.delta) {
              const delta = chunk.choices[0].delta;
              if (delta.reasoning_content) {
                delta.reasoning = delta.reasoning_content;
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
