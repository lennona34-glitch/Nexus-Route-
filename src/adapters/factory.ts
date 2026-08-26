import type { ProviderAdapter } from './base.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { AnthropicAdapter } from './anthropic.js';
import { GroqAdapter } from './groq.js';
import { DeepSeekAdapter } from './deepseek.js';
import { MistralAdapter } from './mistral.js';
import { XAIAdapter } from './xai.js';
import { OllamaAdapter } from './ollama.js';

export interface AdapterFactoryConfig {
  apiKey?: string;
  baseUrl?: string;
}

export class AdapterFactory {
  static create(provider: string, config: AdapterFactoryConfig = {}): ProviderAdapter {
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
      case 'xai':
      case 'grok':
        return new XAIAdapter(config);
      case 'openrouter':
        return new OpenAIAdapter({
          provider: 'openrouter',
          apiKey: config.apiKey || process.env.OPENROUTER_API_KEY,
          baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
        });
      case 'ollama':
      case 'local':
        return new OllamaAdapter(config);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}
