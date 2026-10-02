import { OpenAIAdapter } from './openai.js';

export function resolveCloudflareConfig(config?: { apiKey?: string; baseUrl?: string }) {
  const rawKey = config?.apiKey || process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY || '';
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  let apiKey = rawKey;

  // Support accountId:apiToken syntax in the key input
  if (rawKey.includes(':')) {
    const parts = rawKey.split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
      accountId = parts[0].trim();
      apiKey = parts[1].trim();
    }
  }

  let baseUrl = config?.baseUrl || process.env.CLOUDFLARE_BASE_URL;
  if (!baseUrl) {
    baseUrl = accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
      : 'https://api.cloudflare.com/client/v4/accounts/default/ai/v1';
  }

  return { apiKey, baseUrl, accountId };
}

export class CloudflareAdapter extends OpenAIAdapter {
  readonly accountId?: string;

  constructor(config?: { apiKey?: string; baseUrl?: string }) {
    const resolved = resolveCloudflareConfig(config);
    super({
      provider: 'cloudflare',
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
    });
    this.accountId = resolved.accountId;
  }
}
