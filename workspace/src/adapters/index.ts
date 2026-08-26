import {
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ProviderAdapter,
  AdapterConfig,
  ModelCapabilities,
  ProviderHealth
} from '../ir/types';
import { OpenAIAdapter } from './openai';
import { AnthropicAdapter } from './anthropic';
import { GeminiAdapter } from './gemini';
import { DeepSeekAdapter } from './deepseek';
import { GroqAdapter } from './groq';
import { OpenRouterAdapter } from './openrouter';
import { MultiKeyPool } from '../vault/key-pool';

export {
  OpenAIAdapter,
  AnthropicAdapter,
  GeminiAdapter,
  DeepSeekAdapter,
  GroqAdapter,
  OpenRouterAdapter,
};

export interface RegistryConfig {
  openaiApiKey?: string | string[];
  anthropicApiKey?: string | string[];
  geminiApiKey?: string | string[];
  deepseekApiKey?: string | string[];
  groqApiKey?: string | string[];
  openrouterApiKey?: string | string[];
  customEndpoints?: Record<string, AdapterConfig>;
}

export class AdapterRegistry {
  private adapters: Map<string, ProviderAdapter> = new Map();
  private keyPool: MultiKeyPool;

  constructor(config: RegistryConfig = {}, keyPool?: MultiKeyPool) {
    this.keyPool = keyPool || new MultiKeyPool();

    // Register OpenAI
    if (config.openaiApiKey) {
      this.keyPool.loadKeys('openai', config.openaiApiKey);
      this.register(new OpenAIAdapter({
        apiKey: Array.isArray(config.openaiApiKey) ? config.openaiApiKey[0] : config.openaiApiKey,
      }));
    }

    // Register Anthropic
    if (config.anthropicApiKey) {
      this.keyPool.loadKeys('anthropic', config.anthropicApiKey);
      this.register(new AnthropicAdapter({
        apiKey: Array.isArray(config.anthropicApiKey) ? config.anthropicApiKey[0] : config.anthropicApiKey,
      }));
    }

    // Register Gemini
    if (config.geminiApiKey) {
      this.keyPool.loadKeys('gemini', config.geminiApiKey);
      this.register(new GeminiAdapter({
        apiKey: Array.isArray(config.geminiApiKey) ? config.geminiApiKey[0] : config.geminiApiKey,
      }));
    }

    // Register DeepSeek
    if (config.deepseekApiKey) {
      this.keyPool.loadKeys('deepseek', config.deepseekApiKey);
      this.register(new DeepSeekAdapter({
        apiKey: Array.isArray(config.deepseekApiKey) ? config.deepseekApiKey[0] : config.deepseekApiKey,
      }));
    }

    // Register Groq
    if (config.groqApiKey) {
      this.keyPool.loadKeys('groq', config.groqApiKey);
      this.register(new GroqAdapter({
        apiKey: Array.isArray(config.groqApiKey) ? config.groqApiKey[0] : config.groqApiKey,
      }));
    }

    // Register OpenRouter
    if (config.openrouterApiKey) {
      this.keyPool.loadKeys('openrouter', config.openrouterApiKey);
      this.register(new OpenRouterAdapter({
        apiKey: Array.isArray(config.openrouterApiKey) ? config.openrouterApiKey[0] : config.openrouterApiKey,
      }));
    }

    // Register Custom Endpoints
    if (config.customEndpoints) {
      for (const [provider, adapterConfig] of Object.entries(config.customEndpoints)) {
        if (adapterConfig.apiKey) {
          this.keyPool.loadKeys(provider, adapterConfig.apiKey);
        }
        // Custom OpenAI-compatible endpoints default to OpenAIAdapter
        this.register(new OpenAIAdapter(adapterConfig));
      }
    }
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerName.toLowerCase(), adapter);
  }

  get(providerName: string): ProviderAdapter | undefined {
    return this.adapters.get(providerName.toLowerCase());
  }

  getKeyPool(): MultiKeyPool {
    return this.keyPool;
  }

  listProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  has(providerName: string): boolean {
    return this.adapters.has(providerName.toLowerCase());
  }

  getHealth(): Record<string, ProviderHealth> {
    const health: Record<string, ProviderHealth> = {};
    const keyStats = this.keyPool.getStats();

    for (const [name, adapter] of this.adapters.entries()) {
      const stats = keyStats.find(s => s.provider === name);
      health[name] = {
        provider: name,
        healthy: stats ? stats.healthyKeys > 0 : true,
        latencyMs: 0,
        lastChecked: Date.now(),
        error: stats && stats.healthyKeys === 0 && stats.totalKeys > 0 ? 'All API keys quarantined (429/Rate Limited)' : undefined,
      };
    }
    return health;
  }
}
