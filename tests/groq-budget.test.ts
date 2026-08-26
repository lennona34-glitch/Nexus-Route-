import { describe, expect, it } from 'vitest';
import { ProviderConnectionManager } from '../src/providers/connection-manager.js';
import { getGroqRequestBudget } from '../src/providers/groq-budget.js';
import { RoutingEngine } from '../src/router/engine.js';

describe('Groq TPM guard', () => {
  it('rejects an oversized request before sending it upstream', () => {
    const budget = getGroqRequestBudget({
      model: 'groq::qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: 'const value = 123;\n'.repeat(1_200) }],
      max_tokens: 4_096,
    });

    expect(budget.allowed).toBe(false);
    expect(budget.reason).toContain('Groq skipped');
    expect(budget.reason).toContain('8,000 TPM');
  });

  it('falls through to the next route instead of dropping an oversized chat', async () => {
    const router = new RoutingEngine();
    router.setApiKey('groq', 'test-groq-key');

    const response = await router.executeChat({
      model: 'groq::qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: 'function example() { return true; }\n'.repeat(1_200) }],
      max_tokens: 4_096,
    });

    expect(response.route_info?.attempts[0]).toEqual(expect.objectContaining({
      provider: 'groq',
      status: 'failed',
      error: expect.stringContaining('Groq skipped'),
    }));
    expect(response.route_info?.selected_provider).toBe('mock');
  });

  it('does not cool down a healthy key for a request-specific HTTP 413', () => {
    const pool = new ProviderConnectionManager({ storagePath: null, hydrateEnvironment: false });
    const connection = pool.addConnection('groq', 'test-key', {}, false);

    pool.recordFailure(connection.id, 413, 'Request too large for this model');

    const publicConnection = pool.listPublic().find(item => item.id === connection.id);
    expect(publicConnection?.status).toBe('ready');
    expect(publicConnection?.failureCount).toBe(0);
    expect(publicConnection?.lastError).toContain('Request too large');
  });
});
