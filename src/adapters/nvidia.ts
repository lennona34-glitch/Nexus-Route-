import { OpenAIAdapter } from './openai.js';

export class NvidiaAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'nvidia',
      apiKey: config?.apiKey || process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY || process.env.NVAPI_KEY,
      baseUrl: config?.baseUrl || 'https://integrate.api.nvidia.com/v1',
    });
  }
}
