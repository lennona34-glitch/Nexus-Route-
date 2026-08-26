const fs = require('fs');
const path = require('path');

const targetDir = path.resolve('..', 'src', 'adapters');

// 1. DeepSeek Adapter
const deepSeekCode = `import { ProviderAdapter, ProviderRequest, ProviderResponse, SSEStreamTransformer } from './base';
import { UnifiedRequest, UnifiedResponse, UnifiedStreamChunk } from '../ir/types';

export class DeepSeekAdapter implements ProviderAdapter {
  name = 'deepseek';

  formatRequest(ir: UnifiedRequest, config?: { apiKey?: string; endpoint?: string }): ProviderRequest {
    const messages = ir.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));

    const body: Record<string, any> = {
      model: ir.model || 'deepseek-chat',
      messages,
      stream: ir.stream ?? false
    };

    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.max_tokens !== undefined) body.max_tokens = ir.max_tokens;
    if (ir.top_p !== undefined) body.top_p = ir.top_p;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (config?.apiKey) {
      headers['Authorization'] = \`Bearer \${config.apiKey}\`;
    }

    const url = config?.endpoint || 'https://api.deepseek.com/chat/completions';

    return { url, method: 'POST', headers, body };
  }

  parseResponse(response: ProviderResponse): UnifiedResponse {
    const raw = response.body;
    const choice = raw.choices?.[0];
    const message = choice?.message;

    return {
      id: raw.id || \`deepseek-\${Date.now()}\`,
      model: raw.model || 'deepseek-chat',
      provider: 'deepseek',
      message: {
        role: message?.role || 'assistant',
        content: message?.content || '',
        tool_calls: message?.tool_calls
      },
      finish_reason: choice?.finish_reason || 'stop',
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens || 0,
        completion_tokens: raw.usage?.completion_tokens || 0,
        total_tokens: raw.usage?.total_tokens || 0
      },
      raw
    };
  }

  createStreamTransformer(): SSEStreamTransformer {
    return new SSEStreamTransformer((data: any): UnifiedStreamChunk | null => {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return null;
        }
      }

      const choice = data.choices?.[0];
      if (!choice) return null;

      return {
        id: data.id || \`deepseek-\${Date.now()}\`,
        provider: 'deepseek',
        delta: {
          role: choice.delta?.role,
          content: choice.delta?.content || ''
        },
        finish_reason: choice.finish_reason || null
      };
    });
  }
}
`;

// 2. Groq Adapter
const groqCode = `import { ProviderAdapter, ProviderRequest, ProviderResponse, SSEStreamTransformer } from './base';
import { UnifiedRequest, UnifiedResponse, UnifiedStreamChunk } from '../ir/types';

export class GroqAdapter implements ProviderAdapter {
  name = 'groq';

  formatRequest(ir: UnifiedRequest, config?: { apiKey?: string; endpoint?: string }): ProviderRequest {
    const messages = ir.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));

    const body: Record<string, any> = {
      model: ir.model || 'llama-3.3-70b-versatile',
      messages,
      stream: ir.stream ?? false
    };

    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.max_tokens !== undefined) body.max_tokens = ir.max_tokens;
    if (ir.top_p !== undefined) body.top_p = ir.top_p;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (config?.apiKey) {
      headers['Authorization'] = \`Bearer \${config.apiKey}\`;
    }

    const url = config?.endpoint || 'https://api.groq.com/openai/v1/chat/completions';

    return { url, method: 'POST', headers, body };
  }

  parseResponse(response: ProviderResponse): UnifiedResponse {
    const raw = response.body;
    const choice = raw.choices?.[0];
    const message = choice?.message;

    return {
      id: raw.id || \`groq-\${Date.now()}\`,
      model: raw.model || 'groq-model',
      provider: 'groq',
      message: {
        role: message?.role || 'assistant',
        content: message?.content || '',
        tool_calls: message?.tool_calls
      },
      finish_reason: choice?.finish_reason || 'stop',
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens || 0,
        completion_tokens: raw.usage?.completion_tokens || 0,
        total_tokens: raw.usage?.total_tokens || 0
      },
      raw
    };
  }

  createStreamTransformer(): SSEStreamTransformer {
    return new SSEStreamTransformer((data: any): UnifiedStreamChunk | null => {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return null;
        }
      }

      const choice = data.choices?.[0];
      if (!choice) return null;

      return {
        id: data.id || \`groq-\${Date.now()}\`,
        provider: 'groq',
        delta: {
          role: choice.delta?.role,
          content: choice.delta?.content || ''
        },
        finish_reason: choice.finish_reason || null
      };
    });
  }
}
`;

// 3. Mistral Adapter
const mistralCode = `import { ProviderAdapter, ProviderRequest, ProviderResponse, SSEStreamTransformer } from './base';
import { UnifiedRequest, UnifiedResponse, UnifiedStreamChunk } from '../ir/types';

export class MistralAdapter implements ProviderAdapter {
  name = 'mistral';

  formatRequest(ir: UnifiedRequest, config?: { apiKey?: string; endpoint?: string }): ProviderRequest {
    const messages = ir.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));

    const body: Record<string, any> = {
      model: ir.model || 'mistral-large-latest',
      messages,
      stream: ir.stream ?? false
    };

    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.max_tokens !== undefined) body.max_tokens = ir.max_tokens;
    if (ir.top_p !== undefined) body.top_p = ir.top_p;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (config?.apiKey) {
      headers['Authorization'] = \`Bearer \${config.apiKey}\`;
    }

    const url = config?.endpoint || 'https://api.mistral.ai/v1/chat/completions';

    return { url, method: 'POST', headers, body };
  }

  parseResponse(response: ProviderResponse): UnifiedResponse {
    const raw = response.body;
    const choice = raw.choices?.[0];
    const message = choice?.message;

    return {
      id: raw.id || \`mistral-\${Date.now()}\`,
      model: raw.model || 'mistral-large-latest',
      provider: 'mistral',
      message: {
        role: message?.role || 'assistant',
        content: message?.content || '',
        tool_calls: message?.tool_calls
      },
      finish_reason: choice?.finish_reason || 'stop',
      usage: {
        prompt_tokens: raw.usage?.prompt_tokens || 0,
        completion_tokens: raw.usage?.completion_tokens || 0,
        total_tokens: raw.usage?.total_tokens || 0
      },
      raw
    };
  }

  createStreamTransformer(): SSEStreamTransformer {
    return new SSEStreamTransformer((data: any): UnifiedStreamChunk | null => {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return null;
        }
      }

      const choice = data.choices?.[0];
      if (!choice) return null;

      return {
        id: data.id || \`mistral-\${Date.now()}\`,
        provider: 'mistral',
        delta: {
          role: choice.delta?.role,
          content: choice.delta?.content || ''
        },
        finish_reason: choice.finish_reason || null
      };
    });
  }
}
`;

// 4. Ollama Adapter (Local LLM via /api/chat or /v1/chat/completions)
const ollamaCode = `import { ProviderAdapter, ProviderRequest, ProviderResponse, SSEStreamTransformer } from './base';
import { UnifiedRequest, UnifiedResponse, UnifiedStreamChunk } from '../ir/types';

export class OllamaAdapter implements ProviderAdapter {
  name = 'ollama';

  formatRequest(ir: UnifiedRequest, config?: { apiKey?: string; endpoint?: string }): ProviderRequest {
    const messages = ir.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));

    const body: Record<string, any> = {
      model: ir.model || 'llama3.2',
      messages,
      stream: ir.stream ?? false
    };

    const options: Record<string, any> = {};
    if (ir.temperature !== undefined) options.temperature = ir.temperature;
    if (ir.top_p !== undefined) options.top_p = ir.top_p;
    if (ir.max_tokens !== undefined) options.num_predict = ir.max_tokens;
    if (Object.keys(options).length > 0) body.options = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (config?.apiKey) {
      headers['Authorization'] = \`Bearer \${config.apiKey}\`;
    }

    const endpointBase = (config?.endpoint || 'http://localhost:11434').replace(/\\/+$/, '');
    const url = endpointBase.endsWith('/api/chat') ? endpointBase : \`\${endpointBase}/api/chat\`;

    return { url, method: 'POST', headers, body };
  }

  parseResponse(response: ProviderResponse): UnifiedResponse {
    const raw = response.body;
    const message = raw.message;

    return {
      id: \`ollama-\${Date.now()}\`,
      model: raw.model || 'ollama-model',
      provider: 'ollama',
      message: {
        role: message?.role || 'assistant',
        content: message?.content || '',
        tool_calls: message?.tool_calls
      },
      finish_reason: raw.done ? (raw.done_reason || 'stop') : 'stop',
      usage: {
        prompt_tokens: raw.prompt_eval_count || 0,
        completion_tokens: raw.eval_count || 0,
        total_tokens: (raw.prompt_eval_count || 0) + (raw.eval_count || 0)
      },
      raw
    };
  }

  createStreamTransformer(): SSEStreamTransformer {
    return new SSEStreamTransformer((data: any): UnifiedStreamChunk | null => {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return null;
        }
      }

      if (!data || !data.message) return null;

      return {
        id: \`ollama-\${Date.now()}\`,
        provider: 'ollama',
        delta: {
          role: data.message?.role,
          content: data.message?.content || ''
        },
        finish_reason: data.done ? (data.done_reason || 'stop') : null
      };
    });
  }
}
`;

// 5. Index Re-export
const indexCode = `export * from './base';
export * from './openai';
export * from './anthropic';
export * from './gemini';
export * from './deepseek';
export * from './groq';
export * from './mistral';
export * from './ollama';
`;

// 6. Router Registry Update
const routerEnginePath = path.resolve('..', 'src', 'router', 'engine.ts');
let engineContent = fs.readFileSync(routerEnginePath, 'utf8');

// Update imports in engine.ts
const newEngineImports = `import {
  ProviderAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  GeminiAdapter,
  DeepSeekAdapter,
  GroqAdapter,
  MistralAdapter,
  OllamaAdapter
} from '../adapters';`;

engineContent = engineContent.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\.\/adapters['"];/, newEngineImports);

// Update adapter registrations in engine constructor
const registrationBlock = `    this.registerAdapter('openai', new OpenAIAdapter());
    this.registerAdapter('anthropic', new AnthropicAdapter());
    this.registerAdapter('gemini', new GeminiAdapter());
    this.registerAdapter('deepseek', new DeepSeekAdapter());
    this.registerAdapter('groq', new GroqAdapter());
    this.registerAdapter('mistral', new MistralAdapter());
    this.registerAdapter('ollama', new OllamaAdapter());`;

engineContent = engineContent.replace(/this\.registerAdapter\('openai'[\s\S]*?this\.registerAdapter\('gemini', new GeminiAdapter\(\)\);/, registrationBlock);

// Write files
fs.writeFileSync(path.join(targetDir, 'deepseek.ts'), deepSeekCode);
fs.writeFileSync(path.join(targetDir, 'groq.ts'), groqCode);
fs.writeFileSync(path.join(targetDir, 'mistral.ts'), mistralCode);
fs.writeFileSync(path.join(targetDir, 'ollama.ts'), ollamaCode);
fs.writeFileSync(path.join(targetDir, 'index.ts'), indexCode);
fs.writeFileSync(routerEnginePath, engineContent);

console.log('Successfully wrote adapters and updated engine.ts!');
