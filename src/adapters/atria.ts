import { OpenAIAdapter } from './openai.js';

export class AtriaAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'atria',
      apiKey: config?.apiKey || process.env.ATRIA_API_KEY || process.env.ATRIA_ASI_API_KEY || process.env.DAWN_API_KEY,
      baseUrl: config?.baseUrl || process.env.ATRIA_BASE_URL || 'https://api.atria-asi.ai/v1',
    });
  }
}
