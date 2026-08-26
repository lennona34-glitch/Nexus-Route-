import { OpenAIAdapter } from './openai.js';

export class XAIAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'xai',
      apiKey: config?.apiKey || process.env.XAI_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.x.ai/v1',
    });
  }
}
