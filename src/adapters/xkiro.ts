import { OpenAIAdapter } from './openai.js';

export class XkiroAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'xkiro',
      apiKey: config?.apiKey || process.env.XKIRO_API_KEY,
      baseUrl: config?.baseUrl || process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1',
    });
  }
}
