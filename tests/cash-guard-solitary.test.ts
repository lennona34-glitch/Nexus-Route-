import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { app, router } from '../src/server.js';
import { MockUpstreamServer } from '../src/testing/mock-upstream-server.js';

describe('Cash Guard, Solitary Server & Freeze Source Verification', () => {
  let mockServer: MockUpstreamServer;
  let mockUrl: string;

  beforeAll(async () => {
    mockServer = new MockUpstreamServer({ verbose: false });
    mockUrl = await mockServer.start();

    process.env.OPENAI_BASE_URL = mockUrl + '/v1';
    process.env.OPENAI_API_KEY = 'mock-openai-key';
    process.env.ANTHROPIC_BASE_URL = mockUrl + '/v1';
    process.env.ANTHROPIC_API_KEY = 'mock-anthropic-key';
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    router.setPinnedProvider(null, null);
    router.setRoutingMode('smart_failover');
    router.setCashGuard(true);
  });

  // =========================================================================
  // 1. SOLITARY SERVER & CASH GUARD API ENDPOINTS
  // =========================================================================
  describe('1. Solitary Server & Cash Guard Endpoints', () => {
    it('returns cashGuard status and solitary configuration via GET /v1/routing/pin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/routing/pin',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.cashGuard).toBe(true);
      expect(data.isPinned).toBe(false);
    });

    it('sets pinned solitary provider and model via POST /v1/routing/pin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/routing/pin',
        payload: { provider: 'deepseek', model: 'deepseek-chat', cashGuard: true },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.pinnedProvider).toBe('deepseek');
      expect(data.pinnedModel).toBe('deepseek-chat');
      expect(data.isPinned).toBe(true);
      expect(data.cashGuard).toBe(true);
      expect(data.mode).toBe('fixed');
    });

    it('toggles Cash Guard via POST /v1/routing/cash-guard', async () => {
      const toggleOff = await app.inject({
        method: 'POST',
        url: '/v1/routing/cash-guard',
        payload: { enabled: false },
      });
      expect(toggleOff.json().cashGuard).toBe(false);

      const toggleOn = await app.inject({
        method: 'POST',
        url: '/v1/routing/cash-guard',
        payload: { enabled: true },
      });
      expect(toggleOn.json().cashGuard).toBe(true);
    });
  });

  // =========================================================================
  // 2. CLAUDE CODE CASH-GUARD & ZERO-SEEPAGE VERIFICATION
  // =========================================================================
  describe('2. Claude Code Cash Guard & Solitary Server Enforcement', () => {
    it('strictly routes external requests to solitary model with ZERO fallbacks', () => {
      router.setPinnedProvider('deepseek', 'deepseek-chat');

      // Request as if sent from Claude Code
      const result = router.resolveCandidates({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].provider).toBe('deepseek');
      expect(result.candidates[0].model).toBe('deepseek-chat');
    });

    it('routes local engine as solitary provider without Anthropic cloud fallback', () => {
      router.setPinnedProvider('local', 'local/llama3.1:8b');

      const result = router.resolveCandidates({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'test local' }],
      });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].provider).toBe('local');
      expect(result.candidates[0].model).toBe('local/llama3.1:8b');
    });
  });

  // =========================================================================
  // 3. MAIN SCREEN FREEZE SOURCE VERIFICATION
  // =========================================================================
  describe('3. Main Screen Freeze Source (Strict Fixed Mode)', () => {
    it('locks DeepSeek to exactly 1 candidate and removes all cloud fallbacks when Freeze Source is active', () => {
      const normalResult = router.resolveCandidates({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
        ui_origin: 'main_chat',
      });
      // Normal auto-failover includes fallbacks
      expect(normalResult.candidates.length).toBeGreaterThan(1);

      // With Freeze Source active
      const frozenResult = router.resolveCandidates({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
        ui_origin: 'main_chat',
        fixed_provider_mode: true,
        routing_mode: 'fixed',
      });
      expect(frozenResult.candidates).toHaveLength(1);
      expect(frozenResult.candidates[0].provider).toBe('deepseek');
      expect(frozenResult.candidates[0].model).toBe('deepseek-chat');
    });

    it('locks auto / virtual model to exactly 1 top candidate when Freeze Source is active', () => {
      const frozenAuto = router.resolveCandidates({
        model: 'auto',
        messages: [{ role: 'user', content: 'build a game' }],
        ui_origin: 'main_chat',
        fixed_provider_mode: true,
        routing_mode: 'fixed',
      });
      expect(frozenAuto.candidates).toHaveLength(1);
    });

    it('locks Gemini to exactly 1 candidate without auto-swapping when Freeze Source is active', () => {
      const frozenGemini = router.resolveCandidates({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'test' }],
        ui_origin: 'main_chat',
        fixed_provider_mode: true,
        routing_mode: 'fixed',
      });
      expect(frozenGemini.candidates).toHaveLength(1);
      expect(frozenGemini.candidates[0].provider).toBe('gemini');
      expect(frozenGemini.candidates[0].model).toBe('gemini-2.5-flash');
    });
  });
});
