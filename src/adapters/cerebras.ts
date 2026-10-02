import { OpenAIAdapter } from './openai.js';

export class CerebrasAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'cerebras',
      apiKey: config?.apiKey || process.env.CEREBRAS_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.cerebras.ai/v1',
    });
  }
}
