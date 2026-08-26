import { OpenAIAdapter } from './openai.js';

export class GroqAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'groq',
      apiKey: config?.apiKey || process.env.GROQ_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.groq.com/openai/v1',
    });
  }
}
