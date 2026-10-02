import { describe, it, expect, beforeEach, vi } from 'vitest';
import { app, keyManager } from '../src/server.js';
import { MockAdapter } from '../src/adapters/mock.js';

describe('NexusRoute Gateway HTTP API', () => {
  let authHeader = '';

  beforeEach(() => {
    MockAdapter.clearChaos();
    const testKey = keyManager.generateKey('Server Test App', { dailyBudgetUsd: 10, rateLimitRpm: 100 });
    authHeader = `Bearer ${testKey.rawKey}`;
  });

  it('serves the dashboard shell for nested browser routes but not API misses', async () => {
    const browserRoute = await app.inject({ method: 'GET', url: '/chat/example' });
    expect(browserRoute.statusCode).toBe(200);
    expect(browserRoute.headers['content-type']).toContain('text/html');

    const apiMiss = await app.inject({ method: 'GET', url: '/v1/not-a-real-endpoint' });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.json().error).toBe('Not Found');
  });

  it('GET /health should return 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('allows bounded multimodal request bodies larger than Fastify\'s 1 MB default', () => {
    expect(app.initialConfig.bodyLimit).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(app.initialConfig.bodyLimit).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it('GET /v1/models should return OpenAI-formatted list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some((m: { id: string }) => m.id === 'auto')).toBe(true);
    expect(body.data.some((m: { id: string }) => m.id === 'grok-4.6')).toBe(true);
    expect(body.data.some((m: { id: string }) => m.id === 'stealth/ox-alpha')).toBe(true);
  });

  it('exposes xAI as a configurable provider without exposing a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/keys/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers.xai).toBeDefined();
    expect(res.json().providers.xai.apiKey).toBeUndefined();
  });

  it('exposes masked connection capacity and persisted route telemetry', async () => {
    const capacity = await app.inject({ method: 'GET', url: '/v1/free-capacity' });
    expect(capacity.statusCode).toBe(200);
    expect(Array.isArray(capacity.json().connections)).toBe(true);
    expect(Array.isArray(capacity.json().catalog)).toBe(true);
    for (const connection of capacity.json().connections) {
      expect(connection.apiKey).toBeUndefined();
      expect(['ready', 'cooldown', 'exhausted', 'disabled']).toContain(connection.routingStatus);
    }

    const routes = await app.inject({ method: 'GET', url: '/v1/telemetry/routes?limit=3' });
    expect(routes.statusCode).toBe(200);
    expect(Array.isArray(routes.json().routes)).toBe(true);
    expect(routes.json().summary.totalRequests).toBeTypeOf('number');
  });

  it('POST /v1/chat/completions should handle non-streaming chat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: authHeader,
      },
      payload: {
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Test ping' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBeDefined();
    expect(body.route_info).toBeDefined();
  }, 15000);

  it('POST /v1/chat/completions should handle streaming SSE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: authHeader,
      },
      payload: {
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Test stream' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: ');
    expect(res.body).toContain('data: [DONE]');
  }, 15000);

  it('POST /v1/chaos should toggle fault injection', async () => {
    const toggleRes = await app.inject({
      method: 'POST',
      url: '/v1/chaos',
      payload: { provider: 'mock', model: 'mock-gpt-4o', action: 'trip' },
    });
    expect(toggleRes.statusCode).toBe(200);

    // Reset circuit breakers
    const resetRes = await app.inject({
      method: 'POST',
      url: '/v1/chaos',
      payload: { action: 'reset' },
    });
    expect(resetRes.statusCode).toBe(200);
  }, 15000);

  it('GET /v1/hf/models returns likes and likesFormatted for model cards', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const urlStr = typeof input === 'string' ? input : (input?.url || '');
      if (urlStr.includes('huggingface.co/api/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'stabilityai/sdxl-turbo',
              downloads: 1250000,
              likes: 2631,
              tags: ['stable-diffusion-xl', 'text-to-image'],
              cardData: { instance_prompt: 'photo' },
            },
            {
              id: 'test/small-model',
              downloads: 450,
              likes: 42,
              tags: [],
            },
          ],
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/hf/models?q=sdxl',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.models).toHaveLength(2);
      expect(data.models[0].likes).toBe(2631);
      expect(data.models[0].likesFormatted).toBe('2.6k');
      expect(data.models[0].downloadsFormatted).toBe('1.3M');
      expect(data.models[1].likes).toBe(42);
      expect(data.models[1].likesFormatted).toBe('42');
      expect(data.models[1].downloadsFormatted).toBe('450');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
