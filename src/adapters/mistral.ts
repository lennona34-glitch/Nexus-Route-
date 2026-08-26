import { OpenAIAdapter } from './openai.js';

export class MistralAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'mistral',
      apiKey: config?.apiKey || process.env.MISTRAL_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.mistral.ai/v1',
    });
  }
}
