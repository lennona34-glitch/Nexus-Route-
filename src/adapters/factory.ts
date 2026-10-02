import type { ProviderAdapter } from './base.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { AnthropicAdapter } from './anthropic.js';
import { GroqAdapter } from './groq.js';
import { DeepSeekAdapter } from './deepseek.js';
import { MistralAdapter } from './mistral.js';
import { XAIAdapter } from './xai.js';
import { OllamaAdapter } from './ollama.js';

import { CerebrasAdapter } from './cerebras.js';
import { NvidiaAdapter } from './nvidia.js';
import { CheaperInferenceAdapter } from './cheaperinference.js';
import { UnorouterAdapter } from './unorouter.js';
import { QwenAdapter } from './qwen.js';
import { XkiroAdapter } from './xkiro.js';
import { CloudflareAdapter } from './cloudflare.js';
import { AimlapiAdapter } from './aimlapi.js';
import { GmiCloudAdapter } from './gmicloud.js';
import { InceptionAdapter } from './inception.js';
import { AtriaAdapter } from './atria.js';

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
      case 'cerebras':
        return new CerebrasAdapter(config);
      case 'nvidia':
        return new NvidiaAdapter(config);
      case 'cheaperinference':
        return new CheaperInferenceAdapter(config);
      case 'unorouter':
        return new UnorouterAdapter(config);
      case 'qwen':
      case 'dashscope':
        return new QwenAdapter(config);
      case 'xkiro':
        return new XkiroAdapter(config);
      case 'cloudflare':
        return new CloudflareAdapter(config);
      case 'aimlapi':
      case 'aiml':
        return new AimlapiAdapter(config);
      case 'gmicloud':
      case 'gmi':
        return new GmiCloudAdapter(config);
      case 'inception':
      case 'inceptionlabs':
        return new InceptionAdapter(config);
      case 'atria':
      case 'atria-asi':
      case 'dawn':
        return new AtriaAdapter(config);
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
