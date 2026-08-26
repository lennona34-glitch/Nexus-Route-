import { describe, it, expect } from 'vitest';
import { ResponseCache } from '../src/cache/cache.js';
import { UniversalRequest, UniversalResponse } from '../src/ir/types.js';

describe('ResponseCache', () => {
  it('should store and retrieve cached responses on identical requests when enabled', () => {
    const cache = new ResponseCache({ enabled: true });
    const req: UniversalRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      temperature: 0.7,
    };

    const resp: UniversalResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1700000000,
      model: 'mock-gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '4' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        estimated_cost_usd: 0.00005,
      },
    };

    expect(cache.get(req)).toBeNull();
    cache.set(req, resp);

    const hit = cache.get(req);
    expect(hit).not.toBeNull();
    expect(hit?.response.choices[0].message.content).toBe('4');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.entriesCount).toBeGreaterThanOrEqual(1);
  });

  it('should clear cache and reset metrics', () => {
    const cache = new ResponseCache({ enabled: true });
    const req: UniversalRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'ping' }],
    };
    const resp: UniversalResponse = {
      id: '1',
      object: 'chat.completion',
      created: 1,
      model: 'mock-gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    cache.set(req, resp);
    expect(cache.get(req)).not.toBeNull();
    cache.clear();
    expect(cache.get(req)).toBeNull();
    expect(cache.getStats().entriesCount).toBe(0);
  });
});
