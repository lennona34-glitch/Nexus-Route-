const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// 1. Anthropic Adapter
const anthropicCode = `import { BaseAdapter, ProviderConfig } from './base';
import { UnifiedChatRequest, UnifiedChatResponse, UnifiedStreamChunk, UnifiedToolCall } from '../ir/types';

export class AnthropicAdapter extends BaseAdapter {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.anthropic.com/v1',
    });
  }

  async transformRequest(req: UnifiedChatRequest): Promise<any> {
    const systemMessages = req.messages.filter((m) => m.role === 'system');
    const systemPrompt = systemMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\\n\\n');

    const conversationMessages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        let content: any = m.content;
        if (m.toolCalls && m.toolCalls.length > 0) {
          content = m.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          }));
        } else if (m.role === 'tool') {
          content = [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            },
          ];
        }
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content,
        };
      });

    const tools = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    return {
      model: req.model,
      messages: conversationMessages,
      system: systemPrompt || undefined,
      max_tokens: req.maxTokens || 4096,
      temperature: req.temperature,
      top_p: req.topP,
      stop_sequences: req.stop,
      stream: req.stream || false,
      tools: tools && tools.length > 0 ? tools : undefined,
    };
  }

  async transformResponse(raw: any): Promise<UnifiedChatResponse> {
    let content = '';
    const toolCalls: UnifiedToolCall[] = [];

    if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            name: block.name,
            arguments: block.input,
          });
        }
      }
    }

    return {
      id: raw.id,
      model: raw.model,
      provider: 'anthropic',
      message: {
        role: 'assistant',
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      usage: {
        promptTokens: raw.usage?.input_tokens || 0,
        completionTokens: raw.usage?.output_tokens || 0,
        totalTokens: (raw.usage?.input_tokens || 0) + (raw.usage?.output_tokens || 0),
      },
      finishReason: raw.stop_reason === 'tool_use' ? 'tool_calls' : raw.stop_reason || 'stop',
      raw,
    };
  }

  async *transformStream(stream: AsyncIterable<any>): AsyncIterable<UnifiedStreamChunk> {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield {
          id: event.index?.toString() || '0',
          model: 'anthropic',
          provider: 'anthropic',
          delta: { content: event.delta.text },
          finishReason: null,
        };
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        yield {
          id: 'end',
          model: 'anthropic',
          provider: 'anthropic',
          delta: {},
          finishReason: event.delta.stop_reason,
        };
      }
    }
  }

  protected getHeaders(): Record<string, string> {
    const headers = super.getHeaders();
    headers['x-api-key'] = this.config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    delete headers['Authorization'];
    return headers;
  }

  protected getEndpoint(_req: UnifiedChatRequest): string {
    return '/messages';
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/anthropic.ts'), anthropicCode, 'utf8');
console.log('Written anthropic.ts');

// 2. Groq Adapter (High speed OpenAI-compatible endpoint)
const groqCode = `import { OpenAIAdapter } from './openai';
import { ProviderConfig } from './base';
import { UnifiedChatResponse } from '../ir/types';

export class GroqAdapter extends OpenAIAdapter {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1',
    });
  }

  override async transformResponse(raw: any): Promise<UnifiedChatResponse> {
    const res = await super.transformResponse(raw);
    res.provider = 'groq';
    return res;
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/groq.ts'), groqCode, 'utf8');
console.log('Written groq.ts');

// 3. DeepSeek Adapter (OpenAI compatible with reasoning capability)
const deepseekCode = `import { OpenAIAdapter } from './openai';
import { ProviderConfig } from './base';
import { UnifiedChatResponse } from '../ir/types';

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.deepseek.com/v1',
    });
  }

  override async transformResponse(raw: any): Promise<UnifiedChatResponse> {
    const res = await super.transformResponse(raw);
    res.provider = 'deepseek';
    return res;
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/deepseek.ts'), deepseekCode, 'utf8');
console.log('Written deepseek.ts');

// 4. Mistral Adapter (OpenAI compatible with Mistral AI endpoint)
const mistralCode = `import { OpenAIAdapter } from './openai';
import { ProviderConfig } from './base';
import { UnifiedChatResponse } from '../ir/types';

export class MistralAdapter extends OpenAIAdapter {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.mistral.ai/v1',
    });
  }

  override async transformResponse(raw: any): Promise<UnifiedChatResponse> {
    const res = await super.transformResponse(raw);
    res.provider = 'mistral';
    return res;
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/mistral.ts'), mistralCode, 'utf8');
console.log('Written mistral.ts');

// 5. Ollama Adapter (Local LLM runner)
const ollamaCode = `import { BaseAdapter, ProviderConfig } from './base';
import { UnifiedChatRequest, UnifiedChatResponse, UnifiedStreamChunk } from '../ir/types';

export class OllamaAdapter extends BaseAdapter {
  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:11434/api',
    });
  }

  async transformRequest(req: UnifiedChatRequest): Promise<any> {
    return {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      stream: req.stream || false,
      options: {
        temperature: req.temperature,
        top_p: req.topP,
        num_predict: req.maxTokens,
        stop: req.stop,
      },
    };
  }

  async transformResponse(raw: any): Promise<UnifiedChatResponse> {
    return {
      id: raw.created_at || Date.now().toString(),
      model: raw.model,
      provider: 'ollama',
      message: {
        role: raw.message?.role || 'assistant',
        content: raw.message?.content || '',
      },
      usage: {
        promptTokens: raw.prompt_eval_count || 0,
        completionTokens: raw.eval_count || 0,
        totalTokens: (raw.prompt_eval_count || 0) + (raw.eval_count || 0),
      },
      finishReason: raw.done ? 'stop' : null,
      raw,
    };
  }

  async *transformStream(stream: AsyncIterable<any>): AsyncIterable<UnifiedStreamChunk> {
    for await (const chunk of stream) {
      yield {
        id: chunk.created_at || Date.now().toString(),
        model: chunk.model || 'ollama',
        provider: 'ollama',
        delta: {
          content: chunk.message?.content || '',
        },
        finishReason: chunk.done ? 'stop' : null,
      };
    }
  }

  protected getEndpoint(_req: UnifiedChatRequest): string {
    return '/chat';
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/ollama.ts'), ollamaCode, 'utf8');
console.log('Written ollama.ts');

// 6. Update src/adapters/index.ts
const indexCode = `export * from './base';
export * from './openai';
export * from './gemini';
export * from './anthropic';
export * from './groq';
export * from './deepseek';
export * from './mistral';
export * from './ollama';
export * from './factory';
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/index.ts'), indexCode, 'utf8');
console.log('Updated adapters/index.ts');

// 7. Update src/adapters/factory.ts
const factoryCode = `import { BaseAdapter, ProviderConfig } from './base';
import { OpenAIAdapter } from './openai';
import { GeminiAdapter } from './gemini';
import { AnthropicAdapter } from './anthropic';
import { GroqAdapter } from './groq';
import { DeepSeekAdapter } from './deepseek';
import { MistralAdapter } from './mistral';
import { OllamaAdapter } from './ollama';

export class AdapterFactory {
  static create(provider: string, config: ProviderConfig): BaseAdapter {
    switch (provider.toLowerCase()) {
      case 'openai':
        return new OpenAIAdapter(config);
      case 'gemini':
      case 'google':
        return new GeminiAdapter(config);
      case 'anthropic':
      case 'claude':
        return new AnthropicAdapter(config);
      case 'groq':
        return new GroqAdapter(config);
      case 'deepseek':
        return new DeepSeekAdapter(config);
      case 'mistral':
        return new MistralAdapter(config);
      case 'ollama':
        return new OllamaAdapter(config);
      default:
        throw new Error(\`Unsupported provider: \${provider}\`);
    }
  }
}
`;
fs.writeFileSync(path.join(rootDir, 'src/adapters/factory.ts'), factoryCode, 'utf8');
console.log('Updated adapters/factory.ts');
