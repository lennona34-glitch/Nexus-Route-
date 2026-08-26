import { OpenAIAdapter } from './openai.js';

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'deepseek',
      apiKey: config?.apiKey || process.env.DEEPSEEK_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.deepseek.com/v1',
    });
  }
}
