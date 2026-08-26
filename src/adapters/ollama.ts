import { LocalAdapter } from './local.js';
import type { ProviderType } from '../ir/types.js';

export class OllamaAdapter extends LocalAdapter {
  override readonly provider: ProviderType = 'ollama';

  constructor(config?: { baseUrl?: string }) {
    const baseUrl = (config?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
    super({ baseUrl: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1` });
  }
}
