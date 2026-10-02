import { OpenAIAdapter } from './openai.js';

export class UnorouterAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'unorouter',
      apiKey: config?.apiKey || process.env.UNOROUTER_API_KEY || process.env.UNO_ROUTER_API_KEY,
      baseUrl: config?.baseUrl || process.env.UNOROUTER_BASE_URL || 'https://api.unorouter.com/v1',
    });
  }
}
