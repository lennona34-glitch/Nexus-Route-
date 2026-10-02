import { OpenAIAdapter } from './openai.js';
import { UniversalRequest } from '../ir/types.js';

export class DeepSeekAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    super({
      provider: 'deepseek',
      apiKey: config?.apiKey || process.env.DEEPSEEK_API_KEY,
      baseUrl: config?.baseUrl || 'https://api.deepseek.com/v1',
    });
  }

  protected override buildPayload(req: UniversalRequest, targetModel: string, stream: boolean): Record<string, unknown> {
    const raw = targetModel.toLowerCase().replace(/^deepseek[::/]/, '');
    let resolvedModel = 'deepseek-chat';
    if (raw.includes('reasoner') || raw.includes('r1')) {
      resolvedModel = 'deepseek-reasoner';
    } else {
      resolvedModel = 'deepseek-chat';
    }

    const payload = super.buildPayload(req, resolvedModel, stream);
    payload.model = resolvedModel;
    return payload;
  }
}
