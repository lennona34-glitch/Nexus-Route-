import { OpenAIAdapter } from './openai.js';

export class GmiCloudAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'gmicloud',
      apiKey: config?.apiKey || process.env.GMI_API_KEY || process.env.GMICLOUD_API_KEY,
      baseUrl: config?.baseUrl || process.env.GMI_BASE_URL || 'https://api.gmi-serving.com/v1',
    });
  }
}
