import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionManager } from '../src/providers/connection-manager.js';
import { ProviderModelDiscovery } from '../src/providers/model-discovery.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { AdapterError } from '../src/adapters/base.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Live provider model catalogue', () => {
  it('discovers, normalizes and caches models without exposing the API key', async () => {
    const pool = new ProviderConnectionManager({ storagePath: null, hydrateEnvironment: false });
    pool.addConnection('openrouter', 'secret-openrouter-key', { label: 'Paid OpenRouter' }, false);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-openrouter-key');
      return new Response(JSON.stringify({
        data: [
          {
            id: 'openai/gpt-test',
            name: 'GPT Test',
            context_length: 131072,
            supported_parameters: ['tools'],
            // OpenRouter may omit the optional request price on free models.
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const discovery = new ProviderModelDiscovery(pool, { fetchImpl, cacheTtlMs: 60_000 });
    const first = await discovery.getCatalogue();
    const second = await discovery.getCatalogue();
    const group = first.providers.find(provider => provider.provider === 'openrouter');

    expect(group?.status).toBe('ready');
    expect(group?.models).toEqual([
      expect.objectContaining({
        id: 'openai/gpt-test',
        routeId: 'openrouter::openai/gpt-test',
        free: true,
        supportsTools: true,
      }),
    ]);
    expect(second.providers.find(provider => provider.provider === 'openrouter')?.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('secret-openrouter-key');
  });

  it('marks the retired GitHub Models service without offering dead choices', async () => {
    const pool = new ProviderConnectionManager({ storagePath: null, hydrateEnvironment: false });
    pool.addConnection('github', 'test-token', {}, false);
    const discovery = new ProviderModelDiscovery(pool, { fetchImpl: vi.fn() as unknown as typeof fetch });

    const catalogue = await discovery.getCatalogue();
    const github = catalogue.providers.find(provider => provider.provider === 'github');
    expect(github?.status).toBe('retired');
    expect(github?.models).toEqual([]);
    expect(github?.error).toContain('30 July 2026');
  });

  it('discovers only xAI language models and preserves their live context limits', async () => {
    const pool = new ProviderConnectionManager({ storagePath: null, hydrateEnvironment: false });
    pool.addConnection('xai', 'secret-xai-key', {}, false);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/language-models');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-xai-key');
      return new Response(JSON.stringify({
        models: [
          { id: 'grok-4.6', context_length: 500000, owned_by: 'xai', input_modalities: ['text', 'image'], output_modalities: ['text'] },
          { id: 'voice-only', output_modalities: ['audio'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const catalogue = await new ProviderModelDiscovery(pool, { fetchImpl }).getCatalogue();
    const xai = catalogue.providers.find(provider => provider.provider === 'xai');

    expect(xai?.status).toBe('ready');
    expect(xai?.models).toEqual([
      expect.objectContaining({ id: 'grok-4.6', routeId: 'xai::grok-4.6', contextLength: 500000, supportsTools: true }),
    ]);
    expect(JSON.stringify(catalogue)).not.toContain('secret-xai-key');
  });

  it('passes dynamic route IDs, routing policy, session and attribution to OpenRouter', () => {
    vi.stubEnv('OPENROUTER_HTTP_REFERER', 'http://localhost:3000');
    vi.stubEnv('OPENROUTER_APP_TITLE', 'NexusRoute');
    const adapter = new OpenAIAdapter({
      provider: 'openrouter',
      apiKey: 'test',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const payload = (adapter as any).buildPayload({
      model: 'openrouter::openai/gpt-test',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'patch_file', arguments: { filename: 'game.html' } } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"success":true}' },
      ],
      tools: [{ type: 'function', function: { name: 'patch_file', parameters: { type: 'object' } } }],
      session_id: 'chat-session-123',
      openrouter_routing: 'cheapest',
    }, 'openrouter::openai/gpt-test', false);
    const headers = (adapter as any).getHeaders();

    expect(payload.model).toBe('openai/gpt-test');
    expect(payload.session_id).toBe('chat-session-123');
    expect(payload.provider).toEqual({ sort: 'price', allow_fallbacks: true, require_parameters: true });
    expect((payload.messages as any[])[1].tool_calls[0].function.arguments).toBe('{"filename":"game.html"}');
    expect(headers['HTTP-Referer']).toBe('http://localhost:3000');
    expect(headers['X-OpenRouter-Title']).toBe('NexusRoute');
  });

  it('normalizes nested OpenRouter errors and preserves Retry-After cooldowns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 429,
        metadata: {
          raw: 'stealth/ox-alpha is temporarily rate-limited upstream',
          provider_name: 'Stealth',
        },
      },
      user_id: 'must-not-leak',
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
    })));
    const adapter = new OpenAIAdapter({
      provider: 'openrouter', apiKey: 'test', baseUrl: 'https://openrouter.ai/api/v1',
    });

    let failure: unknown;
    try {
      await adapter.chatCompletion({
        model: 'openrouter::stealth/ox-alpha',
        messages: [{ role: 'user', content: 'hello' }],
      }, 'openrouter::stealth/ox-alpha');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as Error).message).toContain('Stealth: stealth/ox-alpha is temporarily rate-limited upstream');
    expect((failure as Error).message).not.toContain('must-not-leak');
    expect((failure as AdapterError).retryAfterMs).toBe(2_000);
    expect((failure as AdapterError).isRetryable).toBe(true);
  });

  it('surfaces an OpenRouter error delivered inside an established SSE stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"upstream pool busy","provider_name":"Stealth"}}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));
    const adapter = new OpenAIAdapter({
      provider: 'openrouter', apiKey: 'test', baseUrl: 'https://openrouter.ai/api/v1',
    });

    let failure: unknown;
    try {
      for await (const _chunk of adapter.streamChatCompletion({
        model: 'openrouter::stealth/ox-alpha',
        messages: [{ role: 'user', content: 'hello' }],
      }, 'openrouter::stealth/ox-alpha')) {}
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as Error).message).toContain('Stealth: upstream pool busy');
    expect((failure as AdapterError).statusCode).toBe(429);
    expect((failure as AdapterError).isRetryable).toBe(true);
  });
});
