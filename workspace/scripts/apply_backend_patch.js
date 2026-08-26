import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function writeFile(relPath, content) {
  const target = path.join(rootDir, relPath);
  fs.writeFileSync(target, content, 'utf8');
  console.log(`Successfully wrote ${relPath}`);
}

// 1. Update src/ir/types.ts
const typesTs = `export type ProviderType =
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'groq'
  | 'together'
  | 'mistral'
  | 'local';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallIR {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface MessageIR {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallIR[];
}

export interface ParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface FunctionDefinitionIR {
  name: string;
  description?: string;
  parameters?: ParameterSchema;
}

export interface ToolDefinitionIR {
  type: 'function';
  function: FunctionDefinitionIR;
}

export interface RequestIR {
  id?: string;
  model: string;
  messages: MessageIR[];
  tools?: ToolDefinitionIR[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  seed?: number;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageIR {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  total_tokens: number;
  cost_usd?: number;
  cost_gbp?: number;
}

export interface ResponseIR {
  id: string;
  model: string;
  provider: ProviderType;
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCallIR[];
  usage: TokenUsageIR;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  latency_ms: number;
  created: number;
}

export interface StreamChunkIR {
  id: string;
  model: string;
  provider: ProviderType;
  delta: {
    role?: MessageRole;
    content?: string;
    reasoning_content?: string;
    tool_calls?: Partial<ToolCallIR>[];
  };
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage?: TokenUsageIR;
}

export interface ProviderCapability {
  provider: ProviderType;
  model: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1k: number;
  outputPricePer1k: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsReasoning?: boolean;
  avgLatencyMs: number;
  tier: 'fast' | 'balanced' | 'reasoning' | 'heavy' | 'budget';
}
`;

writeFile('src/ir/types.ts', typesTs);

// 2. Update src/security/vault.ts
const vaultTs = `export interface KeyEntry {
  key: string;
  label?: string;
  addedAt: number;
  lastUsedAt?: number;
  errorCount: number;
  quarantinedUntil?: number; // timestamp in ms until quarantine expires
  quarantineReason?: string;
  isActive: boolean;
}

export interface ProviderKeyPool {
  provider: string;
  keys: KeyEntry[];
  currentIndex: number;
}

export class VaultManager {
  private pools: Map<string, ProviderKeyPool> = new Map();
  private gbpRate: number = 0.79; // Default USD -> GBP

  constructor() {
    this.initFromEnv();
  }

  private initFromEnv(): void {
    const envMappings: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      groq: process.env.GROQ_API_KEY,
      together: process.env.TOGETHER_API_KEY,
      mistral: process.env.MISTRAL_API_KEY,
      local: 'local'
    };

    for (const [provider, keyStr] of Object.entries(envMappings)) {
      if (keyStr) {
        const keys = keyStr.split(',').map(k => k.trim()).filter(Boolean);
        for (const k of keys) {
          this.addKey(provider, k, 'env');
        }
      }
    }
  }

  public setGbpRate(rate: number): void {
    if (rate > 0) this.gbpRate = rate;
  }

  public getGbpRate(): number {
    return this.gbpRate;
  }

  public addKey(provider: string, key: string, label: string = 'manual'): boolean {
    if (!key || !key.trim()) return false;
    const cleanKey = key.trim();

    let pool = this.pools.get(provider);
    if (!pool) {
      pool = { provider, keys: [], currentIndex: 0 };
      this.pools.set(provider, pool);
    }

    if (pool.keys.some(k => k.key === cleanKey)) {
      return false; // Already exists
    }

    pool.keys.push({
      key: cleanKey,
      label,
      addedAt: Date.now(),
      errorCount: 0,
      isActive: true
    });
    return true;
  }

  public setKeysForProvider(provider: string, keys: string[]): void {
    const pool = { provider, keys: [], currentIndex: 0 } as ProviderKeyPool;
    for (const raw of keys) {
      const clean = raw.trim();
      if (clean) {
        pool.keys.push({
          key: clean,
          label: 'vault',
          addedAt: Date.now(),
          errorCount: 0,
          isActive: true
        });
      }
    }
    this.pools.set(provider, pool);
  }

  public removeKey(provider: string, key: string): boolean {
    const pool = this.pools.get(provider);
    if (!pool) return false;
    const initialLen = pool.keys.length;
    pool.keys = pool.keys.filter(k => k.key !== key.trim());
    return pool.keys.length < initialLen;
  }

  /**
   * Retrieves next available healthy (non-quarantined) API key with round-robin rotation.
   */
  public getActiveKey(provider: string): string | null {
    const pool = this.pools.get(provider);
    if (!pool || pool.keys.length === 0) {
      return null;
    }

    const now = Date.now();
    const available = pool.keys.filter(k => {
      if (!k.isActive) return false;
      if (k.quarantinedUntil && k.quarantinedUntil > now) return false;
      // Auto-lift expired quarantine
      if (k.quarantinedUntil && k.quarantinedUntil <= now) {
        k.quarantinedUntil = undefined;
        k.quarantineReason = undefined;
      }
      return true;
    });

    if (available.length === 0) {
      return null;
    }

    pool.currentIndex = (pool.currentIndex + 1) % available.length;
    const chosen = available[pool.currentIndex];
    chosen.lastUsedAt = now;
    return chosen.key;
  }

  /**
   * Quarantines a key on 429 (Rate Limit) or 401/403 (Auth/Revoked) error.
   */
  public reportKeyError(provider: string, key: string, status: number, errorMsg?: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;

    const entry = pool.keys.find(k => k.key === key);
    if (!entry) return;

    entry.errorCount++;

    if (status === 429) {
      // 429 Rate limited: Quarantine for 60 seconds (or exponential)
      const duration = Math.min(60000 * Math.pow(2, Math.min(entry.errorCount - 1, 4)), 300000);
      entry.quarantinedUntil = Date.now() + duration;
      entry.quarantineReason = \`Rate Limited (HTTP 429) - Cooldown \${Math.round(duration / 1000)}s: \${errorMsg || 'Quota exceeded'}\`;
      console.warn(\`[Vault] Key for \${provider} quarantined until \${new Date(entry.quarantinedUntil).toISOString()}: \${entry.quarantineReason}\`);
    } else if (status === 401 || status === 403) {
      // 401/403 Invalid / Revoked key: Deactivate permanently until manually restored
      entry.isActive = false;
      entry.quarantineReason = \`Auth Failure (HTTP \${status}): \${errorMsg || 'Invalid API Key'}\`;
      console.error(\`[Vault] Key for \${provider} deactivated due to auth failure: \${entry.quarantineReason}\`);
    }
  }

  public reportKeySuccess(provider: string, key: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;
    const entry = pool.keys.find(k => k.key === key);
    if (entry) {
      entry.errorCount = 0;
      entry.quarantinedUntil = undefined;
      entry.quarantineReason = undefined;
    }
  }

  public getPoolStatus(): Record<string, { total: number; healthy: number; quarantined: number; keys: any[] }> {
    const now = Date.now();
    const result: Record<string, any> = {};

    for (const [provider, pool] of this.pools.entries()) {
      let healthy = 0;
      let quarantined = 0;
      const sanitizedKeys = pool.keys.map(k => {
        const isQuarantined = !!(k.quarantinedUntil && k.quarantinedUntil > now);
        if (k.isActive && !isQuarantined) healthy++;
        if (isQuarantined) quarantined++;

        // Mask key for safety (show first 6 and last 4)
        const masked = k.key.length > 10 
          ? \`\${k.key.slice(0, 6)}...\${k.key.slice(-4)}\`
          : '••••••••';

        return {
          id: masked,
          label: k.label,
          isActive: k.isActive,
          isQuarantined,
          quarantinedUntil: k.quarantinedUntil,
          quarantineReason: k.quarantineReason,
          errorCount: k.errorCount,
          lastUsedAt: k.lastUsedAt
        };
      });

      result[provider] = {
        total: pool.keys.length,
        healthy,
        quarantined,
        keys: sanitizedKeys
      };
    }

    return result;
  }
}

export const GlobalVault = new VaultManager();
`;

writeFile('src/security/vault.ts', vaultTs);

// 3. Update src/adapters/openai.ts
const openaiTs = `import { IModelAdapter, AdapterConfig } from './interface';
import { RequestIR, ResponseIR, StreamChunkIR, TokenUsageIR } from '../ir/types';
import { GlobalVault } from '../security/vault';

export class OpenAIAdapter implements IModelAdapter {
  private config: AdapterConfig;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  public get providerName(): string {
    return this.config.provider;
  }

  public async isAvailable(): Promise<boolean> {
    const activeKey = this.getKey();
    return Boolean(activeKey && activeKey.length > 0);
  }

  private getKey(): string {
    const vaultKey = GlobalVault.getActiveKey(this.config.provider);
    return vaultKey || this.config.apiKey || '';
  }

  public async complete(request: RequestIR): Promise<ResponseIR> {
    const startTime = Date.now();
    const activeKey = this.getKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${activeKey}\`
    };

    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://nexusroute.local';
      headers['X-Title'] = 'NexusRoute Smart Router';
    }

    const payload: any = {
      model: request.model || this.config.defaultModel,
      messages: request.messages.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.name) msg.name = m.name;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens,
      stream: false
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      if (request.tool_choice) {
        payload.tool_choice = request.tool_choice;
      }
    }

    let response: Response;
    try {
      response = await fetch(\`\${this.config.baseUrl}/chat/completions\`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (netErr: any) {
      GlobalVault.reportKeyError(this.config.provider, activeKey, 503, netErr.message);
      throw netErr;
    }

    if (!response.ok) {
      const errorText = await response.text();
      GlobalVault.reportKeyError(this.config.provider, activeKey, response.status, errorText);
      throw new Error(\`[\${this.config.provider.toUpperCase()} \${response.status}] \${errorText}\`);
    }

    GlobalVault.reportKeySuccess(this.config.provider, activeKey);
    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message || {};

    const usage: TokenUsageIR = {
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
      reasoning_tokens: data.usage?.completion_tokens_details?.reasoning_tokens || data.usage?.reasoning_tokens || 0,
      cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0
    };

    return {
      id: data.id || \`resp_\${Date.now()}\`,
      model: data.model || request.model,
      provider: this.config.provider as any,
      content: message.content || '',
      reasoning_content: message.reasoning_content || message.reasoning || undefined,
      tool_calls: message.tool_calls,
      usage,
      finish_reason: choice?.finish_reason || 'stop',
      latency_ms: Date.now() - startTime,
      created: data.created || Math.floor(Date.now() / 1000)
    };
  }

  public async *stream(request: RequestIR): AsyncGenerator<StreamChunkIR, void, unknown> {
    const activeKey = this.getKey();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${activeKey}\`
    };

    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://nexusroute.local';
      headers['X-Title'] = 'NexusRoute Smart Router';
    }

    const payload: any = {
      model: request.model || this.config.defaultModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens,
      stream: true,
      stream_options: { include_usage: true }
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      if (request.tool_choice) {
        payload.tool_choice = request.tool_choice;
      }
    }

    const response = await fetch(\`\${this.config.baseUrl}/chat/completions\`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      GlobalVault.reportKeyError(this.config.provider, activeKey, response.status, errorText);
      throw new Error(\`[\${this.config.provider.toUpperCase()} \${response.status}] \${errorText}\`);
    }

    GlobalVault.reportKeySuccess(this.config.provider, activeKey);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to get response stream reader');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return;

        try {
          const parsed = JSON.parse(dataStr);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          yield {
            id: parsed.id || 'stream_chunk',
            model: parsed.model || request.model,
            provider: this.config.provider as any,
            delta: {
              role: delta?.role,
              content: delta?.content || undefined,
              reasoning_content: delta?.reasoning_content || delta?.reasoning || undefined,
              tool_calls: delta?.tool_calls
            },
            finish_reason: choice?.finish_reason,
            usage: parsed.usage ? {
              prompt_tokens: parsed.usage.prompt_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || 0,
              reasoning_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens || 0,
              cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0
            } : undefined
          };
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }
}
`;

writeFile('src/adapters/openai.ts', openaiTs);

// 4. Update src/adapters/index.ts
const adapterIndexTs = `import { IModelAdapter } from './interface';
import { OpenAIAdapter } from './openai';
import { AnthropicAdapter } from './anthropic';
import { GeminiAdapter } from './gemini';
import { LocalAdapter } from './local';
import { ProviderType } from '../ir/types';

export * from './interface';
export * from './openai';
export * from './anthropic';
export * from './gemini';
export * from './local';

export class AdapterFactory {
  private static adapters: Map<string, IModelAdapter> = new Map();

  public static getAdapter(provider: ProviderType, customApiKey?: string): IModelAdapter {
    const key = \`\${provider}:\${customApiKey || 'default'}\`;
    if (!this.adapters.has(key)) {
      this.adapters.set(key, this.createAdapter(provider, customApiKey));
    }
    return this.adapters.get(key)!;
  }

  private static createAdapter(provider: ProviderType, apiKey?: string): IModelAdapter {
    switch (provider) {
      case 'openai':
        return new OpenAIAdapter({
          provider: 'openai',
          apiKey: apiKey || process.env.OPENAI_API_KEY || '',
          baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o'
        });

      case 'openrouter':
        return new OpenAIAdapter({
          provider: 'openrouter',
          apiKey: apiKey || process.env.OPENROUTER_API_KEY || '',
          baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
          defaultModel: 'deepseek/deepseek-r1'
        });

      case 'anthropic':
        return new AnthropicAdapter({
          apiKey: apiKey || process.env.ANTHROPIC_API_KEY || '',
          baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
          defaultModel: 'claude-3-5-sonnet-20241022'
        });

      case 'gemini':
        return new GeminiAdapter({
          apiKey: apiKey || process.env.GEMINI_API_KEY || '',
          baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
          defaultModel: 'gemini-1.5-pro'
        });

      case 'deepseek':
        return new OpenAIAdapter({
          provider: 'deepseek',
          apiKey: apiKey || process.env.DEEPSEEK_API_KEY || '',
          baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
          defaultModel: 'deepseek-chat'
        });

      case 'groq':
        return new OpenAIAdapter({
          provider: 'groq',
          apiKey: apiKey || process.env.GROQ_API_KEY || '',
          baseUrl: 'https://api.groq.com/openai/v1',
          defaultModel: 'llama-3.3-70b-versatile'
        });

      case 'together':
        return new OpenAIAdapter({
          provider: 'together',
          apiKey: apiKey || process.env.TOGETHER_API_KEY || '',
          baseUrl: 'https://api.together.xyz/v1',
          defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
        });

      case 'mistral':
        return new OpenAIAdapter({
          provider: 'mistral',
          apiKey: apiKey || process.env.MISTRAL_API_KEY || '',
          baseUrl: 'https://api.mistral.ai/v1',
          defaultModel: 'mistral-large-latest'
        });

      case 'local':
        return new LocalAdapter({
          baseUrl: process.env.LOCAL_LLM_URL || 'http://localhost:11434',
          defaultModel: 'llama3:latest'
        });

      default:
        throw new Error(\`Unsupported provider: \${provider}\`);
    }
  }

  public static clearCache(): void {
    this.adapters.clear();
  }
}
`;

writeFile('src/adapters/index.ts', adapterIndexTs);

// 5. Update src/router/capabilities.ts
const capabilitiesTs = `import { ProviderCapability } from '../ir/types';

export const MODEL_CAPABILITIES: ProviderCapability[] = [
  // OpenRouter Unified Hub
  {
    provider: 'openrouter',
    model: 'deepseek/deepseek-r1',
    displayName: 'DeepSeek R1 (OpenRouter)',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.00055,
    outputPricePer1k: 0.00219,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: true,
    avgLatencyMs: 2200,
    tier: 'reasoning'
  },
  {
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    displayName: 'DeepSeek V3 (OpenRouter)',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.00014,
    outputPricePer1k: 0.00028,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    avgLatencyMs: 650,
    tier: 'fast'
  },
  {
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    displayName: 'Claude 3.5 Sonnet (OpenRouter)',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.003,
    outputPricePer1k: 0.015,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 900,
    tier: 'heavy'
  },
  {
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    displayName: 'GPT-4o Mini (OpenRouter)',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePer1k: 0.00015,
    outputPricePer1k: 0.0006,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 420,
    tier: 'budget'
  },

  // Direct DeepSeek
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    displayName: 'DeepSeek V3 (Direct)',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.00014,
    outputPricePer1k: 0.00028,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    avgLatencyMs: 600,
    tier: 'fast'
  },
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    displayName: 'DeepSeek R1 Reasoner (Direct)',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.00055,
    outputPricePer1k: 0.00219,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: true,
    avgLatencyMs: 2500,
    tier: 'reasoning'
  },

  // Direct OpenAI
  {
    provider: 'openai',
    model: 'gpt-4o',
    displayName: 'GPT-4o Omni',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePer1k: 0.0025,
    outputPricePer1k: 0.010,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 680,
    tier: 'heavy'
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePer1k: 0.00015,
    outputPricePer1k: 0.0006,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 380,
    tier: 'budget'
  },
  {
    provider: 'openai',
    model: 'o3-mini',
    displayName: 'OpenAI o3-mini Reasoner',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePer1k: 0.0011,
    outputPricePer1k: 0.0044,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    supportsReasoning: true,
    avgLatencyMs: 1900,
    tier: 'reasoning'
  },

  // Anthropic
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    displayName: 'Claude 3.5 Sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.003,
    outputPricePer1k: 0.015,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 820,
    tier: 'heavy'
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    displayName: 'Claude 3.5 Haiku',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.0008,
    outputPricePer1k: 0.004,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 320,
    tier: 'fast'
  },

  // Google Gemini
  {
    provider: 'gemini',
    model: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    contextWindow: 2000000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.00125,
    outputPricePer1k: 0.005,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 950,
    tier: 'heavy'
  },
  {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.0001,
    outputPricePer1k: 0.0004,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsJsonMode: true,
    avgLatencyMs: 250,
    tier: 'fast'
  },

  // Groq Fast Inference
  {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B (Groq)',
    contextWindow: 128000,
    maxOutputTokens: 32768,
    inputPricePer1k: 0.00059,
    outputPricePer1k: 0.00079,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    avgLatencyMs: 180,
    tier: 'fast'
  },

  // Mistral AI
  {
    provider: 'mistral',
    model: 'mistral-large-latest',
    displayName: 'Mistral Large 2',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    inputPricePer1k: 0.002,
    outputPricePer1k: 0.006,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    avgLatencyMs: 710,
    tier: 'heavy'
  },

  // Local Ollama
  {
    provider: 'local',
    model: 'llama3:latest',
    displayName: 'Local Llama 3 (Ollama)',
    contextWindow: 8192,
    maxOutputTokens: 4096,
    inputPricePer1k: 0.0,
    outputPricePer1k: 0.0,
    supportsTools: false,
    supportsStreaming: true,
    supportsVision: false,
    supportsJsonMode: true,
    avgLatencyMs: 450,
    tier: 'budget'
  }
];

export class CapabilityRegistry {
  public static getCapability(model: string, provider?: string): ProviderCapability | undefined {
    return MODEL_CAPABILITIES.find(c => {
      const modelMatch = c.model.toLowerCase() === model.toLowerCase();
      if (provider) {
        return modelMatch && c.provider === provider;
      }
      return modelMatch;
    });
  }

  public static getAvailableModels(): ProviderCapability[] {
    return [...MODEL_CAPABILITIES];
  }

  public static calculateCost(model: string, promptTokens: number, completionTokens: number, provider?: string): { usd: number; gbp: number } {
    const cap = this.getCapability(model, provider);
    if (!cap) {
      return { usd: 0, gbp: 0 };
    }

    const inputCost = (promptTokens / 1000) * cap.inputPricePer1k;
    const outputCost = (completionTokens / 1000) * cap.outputPricePer1k;
    const usd = Number((inputCost + outputCost).toFixed(6));
    const gbp = Number((usd * 0.79).toFixed(6));

    return { usd, gbp };
  }
}
`;

writeFile('src/router/capabilities.ts', capabilitiesTs);

// 6. Update src/router/engine.ts to inject cost calculation & vault rotation automatically
const engineTs = `import { RequestIR, ResponseIR, StreamChunkIR, ProviderCapability } from '../ir/types';
import { AdapterFactory } from '../adapters';
import { MODEL_CAPABILITIES, CapabilityRegistry } from './capabilities';
import { GlobalVault } from '../security/vault';

export interface RouteOptions {
  strategy?: 'cost_optimized' | 'latency_optimized' | 'quality_optimized' | 'auto';
  forceProvider?: string;
  forceModel?: string;
}

export class RoutingEngine {
  public async route(request: RequestIR, options: RouteOptions = {}): Promise<ResponseIR> {
    const target = this.resolveTarget(request, options);
    const adapter = AdapterFactory.getAdapter(target.provider);

    const targetRequest: RequestIR = {
      ...request,
      model: target.model
    };

    const response = await adapter.complete(targetRequest);
    
    // Inject accurate Cost Ledger calculations
    const cost = CapabilityRegistry.calculateCost(
      target.model,
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
      target.provider
    );
    response.usage.cost_usd = cost.usd;
    response.usage.cost_gbp = cost.gbp;

    return response;
  }

  public async *streamRoute(request: RequestIR, options: RouteOptions = {}): AsyncGenerator<StreamChunkIR, void, unknown> {
    const target = this.resolveTarget(request, options);
    const adapter = AdapterFactory.getAdapter(target.provider);

    const targetRequest: RequestIR = {
      ...request,
      model: target.model
    };

    for await (const chunk of adapter.stream(targetRequest)) {
      if (chunk.usage) {
        const cost = CapabilityRegistry.calculateCost(
          target.model,
          chunk.usage.prompt_tokens,
          chunk.usage.completion_tokens,
          target.provider
        );
        chunk.usage.cost_usd = cost.usd;
        chunk.usage.cost_gbp = cost.gbp;
      }
      yield chunk;
    }
  }

  private resolveTarget(request: RequestIR, options: RouteOptions): ProviderCapability {
    if (options.forceProvider && options.forceModel) {
      const match = CapabilityRegistry.getCapability(options.forceModel, options.forceProvider);
      if (match) return match;
      return {
        provider: options.forceProvider as any,
        model: options.forceModel,
        displayName: \`\${options.forceProvider}/\${options.forceModel}\`,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        inputPricePer1k: 0.001,
        outputPricePer1k: 0.002,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
        supportsJsonMode: true,
        avgLatencyMs: 500,
        tier: 'balanced'
      };
    }

    if (request.model && request.model !== 'auto') {
      const match = CapabilityRegistry.getCapability(request.model);
      if (match) return match;
      // If model name has slash like deepseek/deepseek-r1, default to openrouter
      if (request.model.includes('/')) {
        return {
          provider: 'openrouter',
          model: request.model,
          displayName: request.model,
          contextWindow: 128000,
          maxOutputTokens: 8192,
          inputPricePer1k: 0.001,
          outputPricePer1k: 0.002,
          supportsTools: true,
          supportsStreaming: true,
          supportsVision: false,
          supportsJsonMode: true,
          avgLatencyMs: 600,
          tier: 'balanced'
        };
      }
    }

    // Auto strategy evaluation
    const strategy = options.strategy || 'auto';
    switch (strategy) {
      case 'cost_optimized':
        return MODEL_CAPABILITIES.find(c => c.tier === 'budget') || MODEL_CAPABILITIES[0];
      case 'latency_optimized':
        return MODEL_CAPABILITIES.find(c => c.tier === 'fast') || MODEL_CAPABILITIES[0];
      case 'quality_optimized':
        return MODEL_CAPABILITIES.find(c => c.tier === 'reasoning' || c.tier === 'heavy') || MODEL_CAPABILITIES[0];
      case 'auto':
      default:
        // If complex reasoning prompt or code, pick R1/Sonnet, else fast
        const text = request.messages.map(m => m.content).join(' ');
        if (text.length > 2000 || /reason|proof|analyze|refactor|derive|math/i.test(text)) {
          return MODEL_CAPABILITIES.find(c => c.tier === 'reasoning') || MODEL_CAPABILITIES[0];
        }
        return MODEL_CAPABILITIES.find(c => c.tier === 'fast') || MODEL_CAPABILITIES[0];
    }
  }
}
`;

writeFile('src/router/engine.ts', engineTs);

console.log('Backend engine, capabilities, adapters, and vault updated!');
