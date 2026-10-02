import { OpenAIAdapter } from './openai.js';

export class InceptionAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'inception',
      apiKey: config?.apiKey || process.env.INCEPTION_API_KEY || process.env.INCEPTIONLABS_API_KEY,
      baseUrl: config?.baseUrl || process.env.INCEPTION_BASE_URL || 'https://api.inceptionlabs.ai/v1',
    });
  }
}
