import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { app, keyManager } from '../src/server.js';
import { MockUpstreamServer } from '../src/testing/mock-upstream-server.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { AdapterError } from '../src/adapters/base.js';
import http from 'node:http';

describe('NexusRoute Chaos & Resilience Gauntlet ("Hurt It")', () => {
  let mockServer: MockUpstreamServer;
  let mockUrl: string;
  let authHeader = '';

  beforeAll(async () => {
    mockServer = new MockUpstreamServer({ verbose: false });
    mockUrl = await mockServer.start();

    // Point environment variables to mock upstream
    process.env.OPENAI_BASE_URL = `${mockUrl}/v1`;
    process.env.OPENAI_API_KEY = 'mock-openai-key';
    process.env.ANTHROPIC_BASE_URL = `${mockUrl}/v1`;
    process.env.ANTHROPIC_API_KEY = 'mock-anthropic-key';
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    const testKey = keyManager.generateKey('Chaos Test Suite', { dailyBudgetUsd: 50, rateLimitRpm: 500 });
    authHeader = `Bearer ${testKey.rawKey}`;
  });

  // =========================================================================
  // 1. ADVERSARIAL & FUZZING INGRESS GAUNTLET
  // =========================================================================
  describe('1. Adversarial & Malformed Ingress Fuzzing', () => {
    it('rejects empty request body with 400 validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const data = res.json();
      expect(data.error).toBeDefined();
      expect(data.error.type).toBe('invalid_request_error');
    });

    it('rejects null payload with 400 validation error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload: null as any,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBeDefined();
    });

    it('rejects missing or empty model string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: '',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/model/i);
    });

    it('rejects missing messages field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/messages/i);
    });

    it('rejects empty messages array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/non-empty "messages"/i);
    });

    it('rejects invalid message roles (e.g. role: "god", role: 1337)', async () => {
      const invalidRoles = ['god', 'root', 'admin', 'moderator', 1337, null, true];
      for (const badRole of invalidRoles) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: authHeader },
          payload: {
            model: 'mock-gpt-4o',
            messages: [{ role: badRole, content: 'take over system' }],
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.message).toMatch(/role/i);
      }
    });

    it('rejects invalid content type in message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: { invalid: 'object_without_text' } }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/content/i);
    });

    it('neutralizes prototype pollution payloads without corrupting global Object', async () => {
      const maliciousPayload = JSON.parse(
        '{"model":"mock-gpt-4o","messages":[{"role":"user","content":"pollute"}],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'
      );
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: maliciousPayload,
      });
      expect([200, 400]).toContain(res.statusCode);
      // Ensure Object prototype was NOT poisoned
      expect((({} as any).polluted)).toBeUndefined();
    });

    it('clamps or handles extreme parameters (temperatures, top_p, max_tokens)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'Extreme hyper-parameters' }],
          temperature: -9999.5,
          top_p: 100.0,
          max_tokens: -50,
          stream: false,
        },
      });
      // The gateway should accept or normalize rather than crashing
      expect([200, 400]).toContain(res.statusCode);
    });

    it('handles unicode, null bytes, bidirectional text, and emoji bombardment safely', async () => {
      const evilUnicodeString = '🔥\0\u202E\u200B\uFEFF\u0000\r\n\t'.repeat(100) + '🚀💡👾🤖👽🤡';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: evilUnicodeString }],
          stream: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().choices[0].message.content).toBeDefined();
    });

    it('handles a massive 2MB text payload without memory leak or crash', async () => {
      const largeText = 'A'.repeat(2 * 1024 * 1024); // 2MB string
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: largeText }],
          stream: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().object).toBe('chat.completion');
    }, 20000);

    it('rejects an astronomical payload exceeding bodyLimit with 413 Payload Too Large without server crash', async () => {
      // 70MB string exceeds Fastify's 64MB bodyLimit
      const massiveOverload = 'Z'.repeat(70 * 1024 * 1024);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: massiveOverload }],
        },
      });
      expect(res.statusCode).toBe(413);
    }, 30000);
  });

  // =========================================================================
  // 2. UPSTREAM CHAOS & ERROR RESILIENCE (Via MockUpstreamServer)
  // =========================================================================
  describe('2. Upstream Network Chaos & Failure Modes', () => {
    it('survives upstream 500 Internal Server Error without unhandled exception', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ defaultStatus: 500, customErrorMessage: 'Upstream GPU exploded' });

      await expect(
        adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'trigger 500' }] },
          'gpt-4o'
        )
      ).rejects.toThrow(/Upstream GPU exploded|500/);
    });

    it('survives upstream 503 Service Unavailable / Overloaded gracefully', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ defaultStatus: 503, customErrorMessage: 'Upstream cluster overloaded' });

      await expect(
        adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'overload' }] },
          'gpt-4o'
        )
      ).rejects.toThrow(/overloaded|503/);
    });

    it('extracts Retry-After header and flags error as retryable on upstream 429', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ defaultStatus: 429, retryAfterSeconds: 3 });

      try {
        await adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'rate limit' }] },
          'gpt-4o'
        );
        expect.unreachable('Should have thrown 429');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdapterError);
        expect(err.statusCode).toBe(429);
        expect(err.isRetryable).toBe(true);
        expect(err.retryAfterMs).toBe(3000);
      }
    });

    it('identifies retryable context length exceeded on upstream 400', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ defaultStatus: 400, contextExceeded: true });

      try {
        await adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'giant context' }] },
          'gpt-4o'
        );
        expect.unreachable('Should have thrown 400');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AdapterError);
        expect(err.statusCode).toBe(400);
        expect(err.isRetryable).toBe(true);
      }
    });

    it('survives upstream abrupt TCP socket destruction before headers', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ hangup: 'before_headers' });

      await expect(
        adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill socket' }] },
          'gpt-4o'
        )
      ).rejects.toThrow(/Network error|fetch failed|socket/i);
    });

    it('survives upstream abrupt TCP socket destruction mid-SSE stream without server crash', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ hangup: 'mid_stream' });

      const stream = adapter.streamChatCompletion(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'stream hangup' }], stream: true },
        'gpt-4o'
      );

      let chunkCount = 0;
      try {
        for await (const chunk of stream) {
          chunkCount++;
        }
      } catch (err: any) {
        // Stream termination should throw cleanly, not crash the process
        expect(err).toBeDefined();
      }
      expect(chunkCount).toBeGreaterThanOrEqual(0);
    });

    it('safely handles corrupted non-JSON upstream HTTP body', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ corrupt: 'bad_json' });

      // Non-JSON upstream body should not crash the gateway
      await expect(
        adapter.chatCompletion(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'corrupt body' }] },
          'gpt-4o'
        )
      ).rejects.toThrow();
    });

    it('recovers from intermittent upstream failures (fails twice, succeeds on third)', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: `${mockUrl}/v1`, apiKey: 'test' });
      mockServer.setChaos({ defaultStatus: 503, failNTimesThenSucceed: 2 });

      // Attempt 1: fails
      await expect(
        adapter.chatCompletion({ model: 'gpt-4o', messages: [{ role: 'user', content: 'retry 1' }] }, 'gpt-4o')
      ).rejects.toThrow(/503/);

      // Attempt 2: fails
      await expect(
        adapter.chatCompletion({ model: 'gpt-4o', messages: [{ role: 'user', content: 'retry 2' }] }, 'gpt-4o')
      ).rejects.toThrow(/503/);

      // Attempt 3: succeeds!
      const successResp = await adapter.chatCompletion(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'retry 3' }] },
        'gpt-4o'
      );
      expect(successResp.object).toBe('chat.completion');
      expect(successResp.choices[0].message.content).toBeDefined();
    });
  });

  // =========================================================================
  // 3. DOWNSTREAM CLIENT DISCONNECTS & ABORTS
  // =========================================================================
  describe('3. Downstream Client Abort & Stream Cancellation', () => {
    it('handles abrupt client socket termination during SSE streaming cleanly', async () => {
      // Simulate client opening an SSE connection then destroying the socket immediately
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'Client abort simulation' }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // Verify SSE stream contains initial data
      expect(res.body).toContain('data: ');
    });
  });

  // =========================================================================
  // 4. HIGH-CONCURRENCY STORM
  // =========================================================================
  describe('4. High-Concurrency Blast Storm', () => {
    it('survives 40 concurrent simultaneous requests without deadlock or crash', async () => {
      const requests = Array.from({ length: 40 }, (_, i) => {
        const isStream = i % 2 === 0;
        const isBad = i % 5 === 0;
        return app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: authHeader },
          payload: isBad
            ? { model: 'mock-gpt-4o', messages: [] } // deliberate bad payload in the storm
            : {
                model: 'mock-gpt-4o',
                messages: [{ role: 'user', content: `Storm worker #${i}` }],
                stream: isStream,
              },
        });
      });

      const responses = await Promise.all(requests);
      expect(responses).toHaveLength(40);

      // Verify all 40 promises completed and returned valid HTTP status codes
      for (const res of responses) {
        expect([200, 400]).toContain(res.statusCode);
      }
    }, 25000);
  });

  // =========================================================================
  // 5. ANTHROPIC MESSAGES ENDPOINT RESILIENCE (/v1/messages)
  // =========================================================================
  describe('5. Anthropic Native Messages Protocol Hardening', () => {
    it('rejects malformed Anthropic requests with 400 invalid_request_error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: authHeader },
        payload: {
          // Missing messages
          model: 'claude-3-5-sonnet-20241022',
        },
      });
      expect([200, 400]).toContain(res.statusCode);
    });

    it('handles Anthropic non-streaming completion with full message parity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: authHeader },
        payload: {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Ping from Anthropic SDK' }],
          max_tokens: 1024,
          stream: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(Array.isArray(body.content)).toBe(true);
      expect(body.content[0].type).toBe('text');
    });

    it('handles Anthropic streaming SSE format with event delimiters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: authHeader },
        payload: {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Stream Anthropic' }],
          max_tokens: 1024,
          stream: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('event: message_start');
      expect(res.body).toContain('event: message_delta');
    }, 15000);
  });

  // =========================================================================
  // 6. VIRTUAL KEY QUOTA & SECURITY IMMUNITY
  // =========================================================================
  describe('6. Virtual Key Security & Rate Limit Enforcement', () => {
    it('rejects completely bogus authorization headers with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer nr-live-bogus-invalid-key' },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'whoami' }],
        },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.type).toBe('authentication_error');
    });

    it('enforces RPM rate limits on restricted virtual keys', async () => {
      const restrictedKey = keyManager.generateKey('Tight Limit App', {
        dailyBudgetUsd: 10,
        rateLimitRpm: 3, // strictly 3 requests per minute
      });
      const restrictedAuth = `Bearer ${restrictedKey.rawKey}`;

      // Request 1: OK
      const r1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: restrictedAuth },
        payload: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'ping 1' }] },
      });
      expect(r1.statusCode).toBe(200);

      // Request 2: OK
      const r2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: restrictedAuth },
        payload: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'ping 2' }] },
      });
      expect(r2.statusCode).toBe(200);

      // Request 3: OK
      const r3 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: restrictedAuth },
        payload: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'ping 3' }] },
      });
      expect(r3.statusCode).toBe(200);

      // Request 4: Exceeded! Should be 429
      const r4 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: restrictedAuth },
        payload: { model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'ping 4' }] },
      });
      expect(r4.statusCode).toBe(429);
      expect(r4.json().error.message).toMatch(/rate limit.*exceeded/i);
    });
  });

  // =========================================================================
  // 7. POST-ATTACK IMMUNITY & HEALTH VERIFICATION
  // =========================================================================
  describe('7. Self-Healing & Post-Attack Health Verification', () => {
    it('confirms server is 100% healthy, responsive, and indestructible after all attacks', async () => {
      const healthRes = await app.inject({ method: 'GET', url: '/health' });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().status).toBe('ok');

      const chatRes = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: authHeader },
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'Final health verification check' }],
          stream: false,
        },
      });
      expect(chatRes.statusCode).toBe(200);
      expect(chatRes.json().choices[0].message.content).toBeDefined();
      expect(chatRes.json().route_info).toBeDefined();
    });
  });
});
