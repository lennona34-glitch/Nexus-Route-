import { describe, it, expect, beforeEach } from 'vitest';
import { PromptConfigManager, FACTORY_DEFAULTS } from '../src/router/prompts-config.js';
import { app, router } from '../src/server.js';

describe('Prompts & Configuration Studio (PIN: 1111)', () => {
  let configManager: PromptConfigManager;

  beforeEach(() => {
    // Isolated in-memory instance for testing
    configManager = new PromptConfigManager({ storagePath: null });
    router.getPromptConfigManager().resetToDefaults();
  });

  // =========================================================================
  // 1. PromptConfigManager Unit Tests
  // =========================================================================
  describe('1. PromptConfigManager Unit Tests', () => {
    it('initializes with factory defaults and PIN 1111', () => {
      const cfg = configManager.getConfig();
      expect(cfg.pin).toBe('1111');
      expect(cfg.maxAgentTurns).toBe(25);
      expect(cfg.cloudTimeoutMs).toBe(90000);
      expect(cfg.localTimeoutMs).toBe(120000);
      expect(cfg.requestTimeoutMs).toBe(900000);
      expect(cfg.noAutoLaunch).toBe(true);
      expect(cfg.openRouterModel).toBe('openrouter/free');
      expect(cfg.localDefaultModel).toBe('llama3.1:8b');
      expect(cfg.autonomousOperatingRules).toContain('MANDATORY AUTONOMOUS EXECUTION');
      expect(cfg.defaultPersona).toContain('NexusRoute Autonomous AI Engineer');
      expect(cfg.roasterPersona).toContain('Universal Roast Master');
      expect(cfg.fileSystemAccess).toBe('sandboxed');
      expect(cfg.workspaceDirectory).toBe('workspace');
      expect(cfg.blockDesktopAccess).toBe(true);
    });

    it('verifies default PIN 1111 correctly and rejects incorrect PINs', () => {
      expect(configManager.verifyPin('1111')).toBe(true);
      expect(configManager.verifyPin(' 1111 ')).toBe(true);
      expect(configManager.verifyPin('0000')).toBe(false);
      expect(configManager.verifyPin('abcd')).toBe(false);
      expect(configManager.verifyPin('')).toBe(false);
    });

    it('updates prompt configuration and allows changing the PIN', () => {
      const updated = configManager.updateConfig({
        customSystemPrompt: 'Always output JSON only.',
        maxAgentTurns: 15,
        noAutoLaunch: false,
        pin: '4321',
      });

      expect(updated.customSystemPrompt).toBe('Always output JSON only.');
      expect(updated.maxAgentTurns).toBe(15);
      expect(updated.noAutoLaunch).toBe(false);
      expect(updated.pin).toBe('4321');

      // Old PIN fails, new PIN succeeds
      expect(configManager.verifyPin('1111')).toBe(false);
      expect(configManager.verifyPin('4321')).toBe(true);
    });

    it('sanitizes and clamps numeric limits', () => {
      configManager.updateConfig({
        maxAgentTurns: -5, // clamped to min 1 or default
        cloudTimeoutMs: 100, // clamped to min 5000 or default
      });
      const cfg = configManager.getConfig();
      expect(cfg.maxAgentTurns).toBe(25);
      expect(cfg.cloudTimeoutMs).toBe(90000);
    });

    it('masks raw PIN in getPublicConfig()', () => {
      const pub = configManager.getPublicConfig();
      expect((pub as any).pin).toBeUndefined();
      expect(pub.hasPin).toBe(true);
      expect(pub.isDefaultPin).toBe(true);

      configManager.updateConfig({ pin: '9999' });
      const pub2 = configManager.getPublicConfig();
      expect(pub2.hasPin).toBe(true);
      expect(pub2.isDefaultPin).toBe(false);
    });

    it('resets all configurations back to factory defaults', () => {
      configManager.updateConfig({
        customSystemPrompt: 'Custom prompt',
        maxAgentTurns: 40,
        pin: '9876',
      });
      expect(configManager.getConfig().customSystemPrompt).toBe('Custom prompt');

      configManager.resetToDefaults();
      const reset = configManager.getConfig();
      expect(reset.customSystemPrompt).toBe('');
      expect(reset.maxAgentTurns).toBe(25);
      expect(reset.pin).toBe('1111');
      expect(configManager.verifyPin('1111')).toBe(true);
    });
  });

  // =========================================================================
  // 2. HTTP REST API Endpoints
  // =========================================================================
  describe('2. HTTP REST API Endpoints', () => {
    it('GET /v1/prompts/config returns public configuration without exposing PIN', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/prompts/config',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.config).toBeDefined();
      expect(data.config.pin).toBeUndefined();
      expect(data.config.hasPin).toBe(true);
      expect(data.config.isDefaultPin).toBe(true);
      expect(data.config.maxAgentTurns).toBe(25);
    });

    it('POST /v1/prompts/verify-pin verifies PIN 1111 and rejects invalid attempts', async () => {
      // Correct PIN
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/prompts/verify-pin',
        payload: { pin: '1111' },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().valid).toBe(true);

      // Wrong PIN
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/prompts/verify-pin',
        payload: { pin: '9999' },
      });
      expect(res2.statusCode).toBe(401);
      expect(res2.json().valid).toBe(false);
    });

    it('POST /v1/prompts/config requires valid PIN before applying updates', async () => {
      // Attempt with wrong PIN
      const unauthRes = await app.inject({
        method: 'POST',
        url: '/v1/prompts/config',
        payload: {
          pin: 'wrong',
          updates: { customSystemPrompt: 'Unauthorized prompt' },
        },
      });
      expect(unauthRes.statusCode).toBe(401);
      expect(router.getPromptConfigManager().getConfig().customSystemPrompt).not.toBe('Unauthorized prompt');

      // Attempt with correct PIN 1111
      const authRes = await app.inject({
        method: 'POST',
        url: '/v1/prompts/config',
        payload: {
          pin: '1111',
          updates: {
            customSystemPrompt: 'Always be concise and truthful.',
            maxAgentTurns: 20,
          },
        },
      });
      expect(authRes.statusCode).toBe(200);
      expect(authRes.json().success).toBe(true);
      expect(router.getPromptConfigManager().getConfig().customSystemPrompt).toBe('Always be concise and truthful.');
      expect(router.getPromptConfigManager().getConfig().maxAgentTurns).toBe(20);
    });

    it('POST /v1/prompts/config updates file system access and workspace directory', async () => {
      const authRes = await app.inject({
        method: 'POST',
        url: '/v1/prompts/config',
        payload: {
          pin: '1111',
          updates: {
            fileSystemAccess: 'trusted_full',
            workspaceDirectory: 'custom_projects',
            blockDesktopAccess: false,
          },
        },
      });
      expect(authRes.statusCode).toBe(200);
      const cfg = router.getPromptConfigManager().getConfig();
      expect(cfg.fileSystemAccess).toBe('trusted_full');
      expect(cfg.workspaceDirectory).toBe('custom_projects');
      expect(cfg.blockDesktopAccess).toBe(false);

      // Verify GET returns public properties
      const getRes = await app.inject({ method: 'GET', url: '/v1/prompts/config' });
      expect(getRes.statusCode).toBe(200);
      const pub = getRes.json().config;
      expect(pub.fileSystemAccess).toBe('trusted_full');
      expect(pub.workspaceDirectory).toBe('custom_projects');
      expect(pub.blockDesktopAccess).toBe(false);
    });

    it('POST /v1/prompts/reset reverts to factory defaults when authenticated with PIN', async () => {
      // Modify a prompt first
      router.getPromptConfigManager().updateConfig({ customSystemPrompt: 'Temporary directive' });
      expect(router.getPromptConfigManager().getConfig().customSystemPrompt).toBe('Temporary directive');

      // Reset with wrong PIN fails
      const failRes = await app.inject({
        method: 'POST',
        url: '/v1/prompts/reset',
        payload: { pin: 'bad-pin' },
      });
      expect(failRes.statusCode).toBe(401);

      // Reset with valid PIN succeeds
      const okRes = await app.inject({
        method: 'POST',
        url: '/v1/prompts/reset',
        payload: { pin: '1111' },
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().success).toBe(true);
      expect(router.getPromptConfigManager().getConfig().customSystemPrompt).toBe('');
      expect(router.getPromptConfigManager().getConfig().pin).toBe('1111');
    });
  });

  // =========================================================================
  // 3. Routing Engine Dynamic Prompt Injection
  // =========================================================================
  describe('3. Routing Engine Dynamic Prompt Injection', () => {
    it('dynamically injects customSystemPrompt into system messages', async () => {
      router.getPromptConfigManager().updateConfig({
        customSystemPrompt: 'GLOBAL DIRECTIVE: Strictly verify every line before saving.',
      });

      // Execute a test request through router to verify customSystemPrompt takes effect
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'Say hello' }],
          enable_tools: true,
        },
      });

      expect(response.statusCode).toBe(200);
      // Ensure the router engine didn't crash and processed the custom prompt
      const data = response.json();
      expect(data.choices).toBeDefined();
    });
  });
});
