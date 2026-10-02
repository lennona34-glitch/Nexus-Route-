import { OpenAIAdapter } from './openai.js';

export class AimlapiAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'aimlapi',
      apiKey: config?.apiKey || process.env.AIMLAPI_API_KEY || process.env.AI_ML_API_KEY,
      baseUrl: config?.baseUrl || process.env.AIMLAPI_BASE_URL || 'https://api.aimlapi.com/v1',
    });
  }
}
