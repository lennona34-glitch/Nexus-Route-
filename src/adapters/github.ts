import { ProviderAdapter, AdapterError } from './base.js';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, ProviderType } from '../ir/types.js';
import { readStreamWithInactivityTimeout } from './base.js';

export class GitHubAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'github';
  private baseUrl: string;
  private apiKey?: string;

  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = config?.baseUrl || process.env.GITHUB_BASE_URL || 'https://models.inference.ai.azure.com';
    this.apiKey = config?.apiKey || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private normalizeModel(targetModel: string): string {
    const m = targetModel.replace(/^github::/i, '').replace(/^github\//i, '');
    const map: Record<string, string> = {
      'gpt-4o': 'gpt-4o',
      'gpt-4o-mini': 'gpt-4o-mini',
      'o3-mini': 'o3-mini',
      'o1': 'o1',
      'o1-mini': 'o1-mini',
      'deepseek-r1': 'DeepSeek-R1',
      'deepseek-v3': 'DeepSeek-V3',
      'llama-3.3-70b': 'Llama-3.3-70B-Instruct',
      'meta-llama-3.3-70b': 'Llama-3.3-70B-Instruct',
      'phi-4': 'Phi-4',
      'mistral-large': 'Mistral-large-2407',
    };
    return map[m.toLowerCase()] || m;
  }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    if (!this.apiKey) {
      throw new AdapterError('GitHub Token not configured. Add your GitHub Personal Access Token (PAT) in Provider Keys.', 'github', 401, false);
    }

    const payload = {
      ...req,
      model: this.normalizeModel(targetModel),
      stream: false,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      throw new AdapterError(`Network error reaching GitHub Models: ${(err as Error).message}`, 'github', 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new AdapterError(
        `GitHub Models error (${res.status}): ${errText}`,
        'github',
        res.status,
        res.status === 429 || res.status >= 500
      );
    }

    const data = (await res.json()) as UniversalResponse;
    return data;
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    if (!this.apiKey) {
      throw new AdapterError('GitHub Token not configured. Add your GitHub Personal Access Token (PAT) in Provider Keys.', 'github', 401, false);
    }

    const payload = {
      ...req,
      model: this.normalizeModel(targetModel),
      stream: true,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      throw new AdapterError(`Network error reaching GitHub Models: ${(err as Error).message}`, 'github', 503, true, err);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new AdapterError(
        `GitHub Models stream error (${res.status}): ${errText}`,
        'github',
        res.status,
        res.status === 429 || res.status >= 500
      );
    }

    if (!res.body) {
      throw new AdapterError('GitHub Models stream has no body', 'github', 502, true);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await readStreamWithInactivityTimeout(reader, req.timeout_ms || 120000, 'GitHub Models');
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        if (trimmed === 'data: [DONE]') continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as UniversalStreamChunk;
          yield chunk;
        } catch {
          // ignore stream parse errors
        }
      }
    }
  }
}
