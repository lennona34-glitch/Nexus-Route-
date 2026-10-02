import { OpenAIAdapter } from './openai.js';

export class CheaperInferenceAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'cheaperinference',
      apiKey: config?.apiKey || process.env.CHEAPERINFERENCE_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.cheaperinference.com/v1',
    });
  }
}
