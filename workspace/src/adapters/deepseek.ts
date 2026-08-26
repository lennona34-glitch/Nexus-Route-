import {
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ProviderAdapter,
  AdapterConfig,
  ModelCapabilities
} from '../ir/types';

export class DeepSeekAdapter implements ProviderAdapter {
  readonly providerName = 'deepseek';
  private config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = {
      baseUrl: 'https://api.deepseek.com/v1',
      ...config,
    };
  }

  async execute(request: LLMRequest, apiKey?: string): Promise<LLMResponse> {
    const key = apiKey || this.config.apiKey;
    if (!key) {
      throw new Error('DeepSeek API key is missing');
    }

    const payload = this.transformRequest(request);
    const url = `${this.config.baseUrl}/chat/completions`;

    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errBody = await response.text();
      const error = new Error(`DeepSeek API error (${response.status}): ${errBody}`) as any;
      error.status = response.status;
      error.statusCode = response.status;
      throw error;
    }

    const data: any = await response.json();
    const latencyMs = Date.now() - start;

    return this.transformResponse(data, latencyMs);
  }

  async *stream(request: LLMRequest, apiKey?: string): AsyncIterable<LLMStreamChunk> {
    const key = apiKey || this.config.apiKey;
    if (!key) {
      throw new Error('DeepSeek API key is missing');
    }

    const payload = {
      ...this.transformRequest(request),
      stream: true,
    };
    const url = `${this.config.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errBody = await response.text();
      const error = new Error(`DeepSeek stream error (${response.status}): ${errBody}`) as any;
      error.status = response.status;
      error.statusCode = response.status;
      throw error;
    }

    if (!response.body) {
      throw new Error('No response body returned from DeepSeek');
    }

    const reader = response.body.getReader();
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
        if (trimmed === 'data: [DONE]') {
          yield { id: 'done', delta: '', done: true };
          return;
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || '';
            const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content;
            yield {
              id: parsed.id || 'stream-chunk',
              delta,
              reasoningDelta,
              done: false,
              usage: parsed.usage ? {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
              } : undefined,
            };
          } catch {
            // Ignore partial SSE chunks
          }
        }
      }
    }
  }

  getCapabilities(model: string): ModelCapabilities {
    const isReasoner = model.toLowerCase().includes('reasoner') || model.toLowerCase().includes('r1');
    return {
      model,
      contextWindow: 64000,
      supportsStreaming: true,
      supportsToolCalling: !isReasoner,
      supportsVision: false,
      supportsReasoning: isReasoner,
    };
  }

  private transformRequest(request: LLMRequest): any {
    return {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
        name: m.name,
      })),
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      presence_penalty: request.presencePenalty,
      frequency_penalty: request.frequencyPenalty,
      tools: request.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: request.toolChoice,
    };
  }

  private transformResponse(data: any, latencyMs: number): LLMResponse {
    const choice = data.choices?.[0] || {};
    const message = choice.message || {};

    return {
      id: data.id || `deepseek-${Date.now()}`,
      provider: this.providerName,
      model: data.model || 'deepseek-chat',
      content: message.content || '',
      reasoningContent: message.reasoning_content,
      role: message.role || 'assistant',
      toolCalls: message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      })),
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
        reasoningTokens: data.usage?.prompt_tokens_details?.reasoning_tokens,
      },
      finishReason: choice.finish_reason || 'stop',
      latencyMs,
    };
  }
}
