import { OpenAIAdapter } from './openai.js';

export function resolveQwenBaseUrl(apiKey?: string, explicitUrl?: string): string {
  if (explicitUrl) return explicitUrl;
  if (process.env.QWEN_BASE_URL) return process.env.QWEN_BASE_URL;
  if (process.env.DASHSCOPE_BASE_URL) return process.env.DASHSCOPE_BASE_URL;
  const key = apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (key.startsWith('sk-sp-')) {
    // Qwen Token Plan endpoint (home.qwencloud.com)
    return 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  }
  // Standard Pay-as-you-go DashScope endpoint
  return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
}

export class QwenAdapter extends OpenAIAdapter {
  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    const key = config?.apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
    super({
      provider: 'qwen',
      apiKey: key,
      baseUrl: resolveQwenBaseUrl(key, config?.baseUrl),
    });
  }
}
