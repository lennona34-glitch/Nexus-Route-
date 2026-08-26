import { describe, expect, it } from 'vitest';
import { finalizeUsageCost, mergeUsage, zeroUsageCostForCache } from '../src/telemetry/usage.js';

describe('Usage and exact cost telemetry', () => {
  it('aggregates exact cost and cached tokens across agent tool turns', () => {
    const usage = mergeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cost: 0.001,
        prompt_tokens_details: { cached_tokens: 40 },
      },
      {
        prompt_tokens: 150,
        completion_tokens: 30,
        total_tokens: 180,
        cost: 0.002,
        prompt_tokens_details: { cached_tokens: 90 },
      },
    );

    expect(usage).toMatchObject({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
      cost: 0.003,
      prompt_tokens_details: { cached_tokens: 130 },
    });
  });

  it('uses OpenRouter exact cost instead of a catalogue estimate', () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00042 };
    finalizeUsageCost('openrouter', usage, 9.99);
    expect(usage.estimated_cost_usd).toBe(0.00042);
    expect(usage.cost_source).toBe('provider');
  });

  it('reports a Nexus response-cache hit as zero-cost and preserves the saving', () => {
    const usage = zeroUsageCostForCache({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost_usd: 0.00042,
    });
    expect(usage.estimated_cost_usd).toBe(0);
    expect(usage.cache_savings_usd).toBe(0.00042);
    expect(usage.cost_source).toBe('cache');
  });
});
