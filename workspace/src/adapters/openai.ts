import { ProviderAdapter, AdapterError } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType } from '../ir/types.js';
import { GlobalVault } from '../vault/vault.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: ProviderType;
  private baseUrl: string;
  private defaultApiKey?: string;
  private customHeaders?: Record<string, string>;

  constructor(config?: { provider?: ProviderType; baseUrl?: string; apiKey?: string; customHeaders?: Record<string, string> }) {
    this.provider = config?.provider || 'openai';
    this.baseUrl = config?.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.defaultApiKey = config?.apiKey || process.env.OPENAI_API_KEY;
    this.customHeaders = config?.customHeaders;
  }

  private getEffectiveApiKey(): string | undefined {
    const vaultKey = GlobalVault.getActiveKey(this.provider);
    return vaultKey || this.defaultApiKey;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.getEffectiveApiKey() || this.baseUrl.includes('localhost') || this.baseUrl.includes('127.0.0.1');
  }

  private getHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders,
    };
    const key = apiKey || this.getEffectiveApiKey();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  private cleanModel(targetModel: string): string {
    let m = targetModel;
    if (m.startsWith('groq/')) m = m.slice(5);
    if (m.startsWith('together/')) m = m.slice(9);
    if (m.startsWith('github/')) m = m.slice(7);
    if (m.startsWith('deepseek/')) m = m.slice(9);
    if (m.startsWith('openrouter/')) m = m.slice(11);
    return m;
  }

  private buildPayload(req: UniversalRequest, targetModel: string, stream: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: this.cleanModel(targetModel),
      messages: req.messages,
      stream,
    };
    if (stream) {
      payload.stream_options = { include_usage: true };
    }
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;

    // Smart token clamping for Groq 8k TPM limit (includes tool schemas + messages)
    if (this.baseUrl.includes('groq.com')) {
      const messagesChars = JSON.stringify(req.messages).length;
      const toolsChars = req.tools ? JSON.stringify(req.tools).length : 0;
      const totalChars = messagesChars + toolsChars;
      const approxTotalPromptTokens = Math.ceil(totalChars / 3.0);
      const remainingBudget = Math.max(512, 7200 - approxTotalPromptTokens);
      const safeMaxTokens = Math.min(req.max_tokens || 6000, remainingBudget);
      payload.max_tokens = safeMaxTokens;
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
    const currentKey = this.getEffectiveApiKey();
    if (!currentKey && !this.baseUrl.includes('localhost') && !this.baseUrl.includes('127.0.0.1')) {
      throw new AdapterError(`${this.provider.toUpperCase()} API key not configured`, this.provider, 401, false);
    }

    const payload = this.buildPayload(req, targetModel, false);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(currentKey),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      if (currentKey) GlobalVault.recordKeyFailure(this.provider, currentKey, 503);
      throw new AdapterError(`Network error reaching ${this.provider}: ${(err as Error).message}`, this.provider, 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (currentKey) {
        GlobalVault.recordKeyFailure(this.provider, currentKey, res.status);
      }
      throw new AdapterError(
        `${this.provider.toUpperCase()} error (${res.status}): ${errText}`,
        this.provider,
        res.status,
        res.status === 429 || res.status >= 500
      );
    }

    if (currentKey) {
      GlobalVault.recordKeySuccess(this.provider, currentKey);
    }

    const data = (await res.json()) as UniversalResponse;
    return data;
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    const currentKey = this.getEffectiveApiKey();
    if (!currentKey && !this.baseUrl.includes('localhost') && !this.baseUrl.includes('127.0.0.1')) {
      throw new AdapterError(`${this.provider.toUpperCase()} API key not configured`, this.provider, 401, false);
    }

    const payload = this.buildPayload(req, targetModel, true);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(currentKey),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      if (currentKey) GlobalVault.recordKeyFailure(this.provider, currentKey, 503);
      throw new AdapterError(`Network error reaching ${this.provider}: ${(err as Error).message}`, this.provider, 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (currentKey) {
        GlobalVault.recordKeyFailure(this.provider, currentKey, res.status);
      }
      throw new AdapterError(
        `${this.provider.toUpperCase()} stream error (${res.status}): ${errText}`,
        this.provider,
        res.status,
        res.status === 429 || res.status >= 500
      );
    }

    if (currentKey) {
      GlobalVault.recordKeySuccess(this.provider, currentKey);
    }

    if (!res.body) {
      throw new AdapterError(`${this.provider.toUpperCase()} response has no readable body stream`, this.provider, 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;

        if (trimmed.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(trimmed.slice(6)) as any;
            // Normalize DeepSeek / o3 / OpenRouter reasoning_content into delta
            if (chunk.choices?.[0]?.delta) {
              const delta = chunk.choices[0].delta;
              if (delta.reasoning_content && !delta.content) {
                delta.reasoning = delta.reasoning_content;
                delta.content = delta.reasoning_content;
              }
            }
            yield chunk as UniversalStreamChunk;
          } catch {
            // ignore partial parse errors in sse stream
          }
        }
      }
    }
  }
}
