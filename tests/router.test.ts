import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RoutingEngine } from '../src/router/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { CircuitBreaker } from '../src/router/circuit-breaker.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AdapterError } from '../src/adapters/base.js';
import type { ProviderAdapter } from '../src/adapters/base.js';
import type { UniversalRequest, UniversalResponse, UniversalStreamChunk } from '../src/ir/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class OfflineFileClaimAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  private streamCalls = 0;

  async isAvailable() { return true; }

  async chatCompletion(_req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    return {
      id: 'offline-file-test',
      object: 'chat.completion',
      created: 1,
      model: targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *streamChatCompletion(_req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    const content = this.streamCalls === 1
      ? 'I wrote the requested file successfully.'
      : this.streamCalls === 2
        ? JSON.stringify({ name: 'write_file', arguments: { filename: 'proof.txt', content: 'wrong path write' } })
        : this.streamCalls === 3
        ? JSON.stringify({ name: 'write_file', arguments: { filename: 'projects/proof.txt', content: 'verified offline write' } })
        : 'The file is now genuinely present in the workspace.';
    yield {
      id: `offline-file-${this.streamCalls}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: targetModel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }
}

const COMPLETE_GAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Vector Dogfight</title>
<style>html,body,canvas{margin:0;width:100%;height:100%;background:#020805;color:#7cff9b}#hud{position:fixed;inset:12px;font:16px monospace;pointer-events:none}</style>
</head><body><canvas id="game"></canvas><div id="hud">SCORE <span id="score">0</span> · DASH: SHIFT · FIRE: SPACE</div>
<script>
const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d'),scoreEl=document.querySelector('#score');
let score=0,ship={x:0,y:0},targets=Array.from({length:12},(_,i)=>({x:Math.random(),y:Math.random(),z:i+1}));
function resize(){canvas.width=innerWidth;canvas.height=innerHeight} addEventListener('resize',resize);resize();
addEventListener('pointermove',e=>{ship.x=e.clientX;ship.y=e.clientY});
addEventListener('keydown',e=>{if(e.code==='Space'){score+=10;scoreEl.textContent=score}if(e.code==='ShiftLeft')score+=25});
const audio=new (window.AudioContext||window.webkitAudioContext)();
function frame(t){ctx.fillStyle='rgba(0,8,4,.28)';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#52ff89';
targets.forEach((p,i)=>{p.z-=.02;if(p.z<.2)p.z=12;const x=(p.x-.5)*canvas.width/p.z+canvas.width/2,y=(p.y-.5)*canvas.height/p.z+canvas.height/2;ctx.strokeRect(x-8,y-8,16,16)});
ctx.beginPath();ctx.moveTo(ship.x-14,ship.y+10);ctx.lineTo(ship.x,ship.y-18);ctx.lineTo(ship.x+14,ship.y+10);ctx.closePath();ctx.stroke();requestAnimationFrame(frame)}requestAnimationFrame(frame);
</script></body></html>`;

class PlaceholderThenGameAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  private streamCalls = 0;
  correctionText = '';

  async isAvailable() { return true; }
  async chatCompletion(_req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    return {
      id: 'placeholder-game-test', object: 'chat.completion', created: 1, model: targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    if (this.streamCalls === 3) {
      const lastUser = [...req.messages].reverse().find(message => message.role === 'user');
      this.correctionText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    }
    const content = this.streamCalls === 1
      ? JSON.stringify({ name: 'write_file', arguments: { filename: 'dogfight_3d.html', content: '<h1>Welcome</h1><p>This is a placeholder for the actual game content.</p>' } })
      : this.streamCalls === 2
        ? 'The complete playable game is ready.'
        : this.streamCalls === 3
          ? JSON.stringify({ name: 'write_file', arguments: { filename: 'dogfight_3d.html', content: COMPLETE_GAME_HTML } })
          : 'The complete playable game is ready.';
    yield {
      id: `placeholder-game-${this.streamCalls}`,
      object: 'chat.completion.chunk', created: 1, model: targetModel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }
}

class FakeTranscriptThenDependenciesAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  streamCalls = 0;
  correctionPrompts: string[] = [];

  async isAvailable() { return true; }
  async chatCompletion(_req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    return {
      id: 'fake-tool-test', object: 'chat.completion', created: 1, model: targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    const lastUser = [...req.messages].reverse().find(message => message.role === 'user');
    if (this.streamCalls > 1 && typeof lastUser?.content === 'string') {
      this.correctionPrompts.push(lastUser.content);
    }

    const indexHtml = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><main>Arcade</main><script src="game.js"></script></body></html>';
    const content = this.streamCalls === 1
      ? JSON.stringify({ name: 'write_file', arguments: { filename: 'projects/site/index.html', content: indexHtml } })
      : this.streamCalls === 2
        ? '[Executed tool: write_file({"filename":"projects/site/style.css","content":"fake css"})]'
        : this.streamCalls === 3
          ? JSON.stringify({ name: 'write_file', arguments: { filename: 'projects/site/style.css', content: 'body { background: #050510; color: white; }' } })
          : this.streamCalls === 4
            ? 'Everything is finished.'
            : this.streamCalls === 5
              ? JSON.stringify({ name: 'write_file', arguments: { filename: 'projects/site/game.js', content: 'document.querySelector("main").textContent = "Running";' } })
              : 'The website is now complete.';
    yield {
      id: `fake-tool-${this.streamCalls}`,
      object: 'chat.completion.chunk', created: 1, model: targetModel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }
}

class RuntimeGateAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  streamCalls = 0;
  runtimeCorrection = '';

  async isAvailable() { return true; }
  async chatCompletion(_req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    return {
      id: 'runtime-gate-test', object: 'chat.completion', created: 1, model: targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    if (this.streamCalls === 3) {
      const lastUser = [...req.messages].reverse().find(message => message.role === 'user');
      this.runtimeCorrection = typeof lastUser?.content === 'string' ? lastUser.content : '';
    }
    const content = this.streamCalls === 1
      ? JSON.stringify({ name: 'write_file', arguments: { filename: 'runtime_game.html', content: COMPLETE_GAME_HTML } })
      : this.streamCalls === 2
        ? 'The playable game is complete.'
        : this.streamCalls === 3
          ? JSON.stringify({ name: 'test_html_app', arguments: { filename: 'runtime_game.html' } })
          : 'The post-click runtime test passed.';
    yield {
      id: `runtime-gate-${this.streamCalls}`,
      object: 'chat.completion.chunk', created: 1, model: targetModel,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }
}

class NeverCompletesAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  async isAvailable() { return true; }
  async chatCompletion(): Promise<UniversalResponse> { return new Promise(() => {}); }
  async *streamChatCompletion(): AsyncGenerator<UniversalStreamChunk> {
    await new Promise<void>(() => {});
  }
}

class ImmediateTimeoutAdapter implements ProviderAdapter {
  readonly provider = 'openrouter' as const;
  streamCalls = 0;
  async isAvailable() { return true; }
  async chatCompletion(): Promise<UniversalResponse> {
    throw new AdapterError('upstream timed out', 'openrouter', 408, true);
  }
  async *streamChatCompletion(): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    throw new AdapterError('upstream timed out', 'openrouter', 408, true);
  }
}

class ImmediateSuccessAdapter implements ProviderAdapter {
  readonly provider = 'xai' as const;
  streamCalls = 0;
  async isAvailable() { return true; }
  async chatCompletion(_req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    return {
      id: 'fallback-success', object: 'chat.completion', created: 1, model: targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'fallback complete' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  async *streamChatCompletion(_req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls++;
    yield {
      id: 'fallback-success', object: 'chat.completion.chunk', created: 1, model: targetModel,
      choices: [{ index: 0, delta: { content: 'fallback complete' }, finish_reason: null }],
    };
  }
}

describe('Routing Engine & Resilience', () => {
  let router: RoutingEngine;

  beforeEach(() => {
    MockAdapter.clearChaos();
    router = new RoutingEngine();
    // Unit tests must not consume real keys from the developer's local .env.
    (router as any).configuredKeys.clear();
    (router as any).initAdapters();
  });

  it('should resolve virtual models into candidate cascades', () => {
    const { candidates } = router.resolveCandidates({
      model: 'fast',
      messages: [{ role: 'user', content: 'Ping' }],
    });

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].provider).toBeDefined();
    expect(candidates[0].model).toBeDefined();
  });

  it('should auto-classify code requests to coding/reasoning candidates', () => {
    const { candidates, classification } = router.resolveCandidates({
      model: 'auto',
      messages: [{ role: 'user', content: 'Write a typescript function to parse AST.' }],
    });

    expect(classification.category).toBe('CODE_DEV');
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should keep a verified artifact target across short repair follow-ups', () => {
    router.setApiKey('openrouter', 'test-openrouter-key');
    const { candidates } = router.resolveCandidates({
      model: 'auto',
      messages: [
        { role: 'user', content: 'Build the complete game in glow_pinball3.html.' },
        { role: 'assistant', content: '✅ Verified file written: `C:\\workspace\\glow_pinball3.html` (39,067 bytes)' },
        { role: 'user', content: "I can't hear the beats!" },
        { role: 'assistant', content: 'I will fix the audio unlock.' },
        { role: 'user', content: 'go' },
      ],
      enable_tools: true,
    });

    expect(candidates[0]).toMatchObject({
      provider: 'openrouter',
      model: 'poolside/laguna-s-2.1:free',
    });
  });

  it('should restore an active artifact target from persisted session metadata', () => {
    router.setApiKey('openrouter', 'test-openrouter-key');
    const { candidates } = router.resolveCandidates({
      model: 'auto',
      messages: [
        { role: 'assistant', content: 'The previous change is ready.' },
        { role: 'user', content: 'go' },
      ],
      enable_tools: true,
      metadata: { active_file_targets: ['projects/glow_pinball3.html'] },
    });

    expect(candidates[0]).toMatchObject({ provider: 'openrouter', model: 'poolside/laguna-s-2.1:free' });
  });

  it('should route OpenRouter free requests through the configured adapter', () => {
    router.setApiKey('openrouter', 'test-openrouter-key');
    const { candidates } = router.resolveCandidates({
      model: 'openrouter/free',
      messages: [{ role: 'user', content: 'Use a zero-cost cloud model' }],
    });

    expect(candidates[0]).toEqual({ provider: 'openrouter', model: 'openrouter/free' });
  });

  it('routes direct and coding requests through a configured xAI connection', () => {
    router.setApiKey('xai', 'test-xai-key');

    const direct = router.resolveCandidates({
      model: 'xai::grok-4.6',
      messages: [{ role: 'user', content: 'Use Grok directly' }],
    });
    const coding = router.resolveCandidates({
      model: 'coding',
      messages: [{ role: 'user', content: 'Repair this TypeScript project' }],
    });

    expect(direct.candidates[0]).toMatchObject({ provider: 'xai', model: 'xai::grok-4.6' });
    expect(coding.candidates[0]).toMatchObject({ provider: 'xai', model: 'grok-4.6' });
  });

  it('reserves fallback time for Ox Alpha and prioritizes the coding Grok route ahead of Groq', () => {
    router.setApiKey('openrouter', 'test-openrouter-key');
    router.setApiKey('xai', 'test-xai-key');
    router.setApiKey('groq', 'test-groq-key');

    const { candidates } = router.resolveCandidates({
      model: 'openrouter::stealth/ox-alpha',
      messages: [{ role: 'user', content: 'Build and save a complete game in lunar_lander_3d.html' }],
    });

    expect(candidates[0]).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter::stealth/ox-alpha',
      timeout_ms: 75_000,
    });
    expect(candidates.find(candidate => candidate.provider === 'xai')?.model).toBe('grok-build-0.1');
    expect(candidates.findIndex(candidate => candidate.provider === 'xai'))
      .toBeLessThan(candidates.findIndex(candidate => candidate.provider === 'groq'));
  });

  it('sends a lean tool and system prompt for a standalone HTML build', () => {
    const request: UniversalRequest = {
      model: 'openrouter::stealth/ox-alpha',
      messages: [{
        role: 'user',
        content: 'Build a complete standalone synthwave game in lunar_lander_3d.html and save it with write_file.',
      }],
      enable_tools: true,
      tools: ToolRegistry.getBuiltInTools(),
    };

    const effective = (router as any).ensureAutonomousPrompt(request) as UniversalRequest;
    const toolNames = effective.tools?.map(tool => tool.function.name);
    const systemPrompt = effective.messages.find(message => message.role === 'system')?.content;

    expect(toolNames).toEqual([
      'write_file',
      'patch_file',
      'read_file',
      'list_workspace_files',
      'open_in_browser_or_app',
      'test_html_app',
    ]);
    expect(toolNames?.length).toBeLessThan(ToolRegistry.getBuiltInTools().length);
    expect(systemPrompt).toContain('For standalone HTML');
    expect(systemPrompt).not.toContain('ANDROID APPS');
    expect(systemPrompt).not.toContain('CORE PERSONALITY');
  });

  it('should execute chat completion and attach route telemetry', async () => {
    const res = await router.executeChat({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello there' }],
    });

    expect(res.choices).toHaveLength(1);
    expect(res.choices[0].message.content).toBeDefined();
    expect(res.route_info).toBeDefined();
    expect(res.route_info?.attempts.length).toBeGreaterThanOrEqual(1);
    expect(res.route_info?.attempts.some(a => a.status === 'success')).toBe(true);
  });

  it('should automatically cascade and fallback when primary model fails', async () => {
    const { candidates } = router.resolveCandidates({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello fallback test' }],
    });

    if (candidates.length > 1) {
      // Simulate failure on the primary candidate
      MockAdapter.setChaos(candidates[0].model, true);

      const res = await router.executeChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello fallback test' }],
      });

      expect(res.route_info).toBeDefined();
      expect(res.choices[0].message.content).toBeDefined();
    }
  });

  it('should execute streaming completions and yield valid stream chunks', async () => {
    const stream = router.executeStream({
      model: 'auto',
      messages: [{ role: 'user', content: 'Streaming test' }],
      stream: true,
    });

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].route_info?.route_stage).toBe('selected');
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.route_info).toBeDefined();
    expect(lastChunk.route_info?.selected_provider).toBeDefined();
    expect(lastChunk.route_info?.route_stage).toBe('completed');
    expect(router.getAgentEventLog().list(20).some(event => event.stage === 'turn_completed')).toBe(true);
  });

  it('should stop a trickling or stalled turn at its wall-clock deadline', async () => {
    (router as any).adapters.set('mock', new NeverCompletesAdapter());
    const startedAt = Date.now();
    const consume = async () => {
      for await (const _chunk of router.executeStream({
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Never finish this' }],
        stream: true,
        timeout_ms: 35,
      })) {}
    };

    await expect(consume()).rejects.toThrow('All streaming route candidates failed');
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(router.getAgentEventLog().list(20).some(event => event.stage === 'route_failed' && event.error?.includes('wall-clock'))).toBe(true);
  });

  it('does not spend the fallback budget retrying a timed-out model with another key', async () => {
    const timedOut = new ImmediateTimeoutAdapter();
    const fallback = new ImmediateSuccessAdapter();
    const classification = {
      category: 'CODE_DEV',
      complexityScore: 0.8,
      recommendedTier: 'coding',
      paretoExplanation: 'test route',
      hasTools: false,
      hasVision: false,
    };
    (router as any).resolveCandidates = vi.fn(() => ({
      classification,
      candidates: [
        { provider: 'openrouter', model: 'openrouter::stealth/ox-alpha' },
        { provider: 'openrouter', model: 'openrouter::stealth/ox-alpha' },
        { provider: 'xai', model: 'grok-4.6' },
      ],
    }));
    (router as any).expandCandidatesForConnections = vi.fn((candidates: unknown[]) => candidates);
    (router as any).selectAttemptTarget = vi.fn((provider: string) => (
      provider === 'openrouter' ? { adapter: timedOut } : { adapter: fallback }
    ));

    const chunks = [];
    for await (const chunk of router.executeStream({
      model: 'openrouter::stealth/ox-alpha',
      messages: [{ role: 'user', content: 'Finish the coding task' }],
      stream: true,
      enable_tools: false,
    })) chunks.push(chunk);

    expect(timedOut.streamCalls).toBe(1);
    expect(fallback.streamCalls).toBe(1);
    expect(chunks.at(-1)?.route_info?.selected_provider).toBe('xai');
    expect(chunks.at(-1)?.route_info?.attempts.some(attempt => attempt.error?.includes('Skipped another API key'))).toBe(true);
  });

  it('attributes an exhausted stream to the real upstream instead of mock', async () => {
    const timedOut = new ImmediateTimeoutAdapter();
    (router as any).resolveCandidates = vi.fn(() => ({
      classification: {
        category: 'CODE_DEV', complexityScore: 0.8, recommendedTier: 'coding',
        paretoExplanation: 'test route', hasTools: false, hasVision: false,
      },
      candidates: [
        { provider: 'openrouter', model: 'openrouter::stealth/ox-alpha' },
        { provider: 'openrouter', model: 'openrouter::stealth/ox-alpha' },
      ],
    }));
    (router as any).expandCandidatesForConnections = vi.fn((candidates: unknown[]) => candidates);
    (router as any).selectAttemptTarget = vi.fn(() => ({ adapter: timedOut }));

    let failure: unknown;
    try {
      for await (const _chunk of router.executeStream({
        model: 'openrouter::stealth/ox-alpha',
        messages: [{ role: 'user', content: 'Fail this test route' }],
        stream: true,
        enable_tools: false,
      })) {}
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as Error).message).toContain('[OPENROUTER]');
    expect((failure as Error).message).not.toContain('[MOCK]');
    expect((failure as Error).message).toContain('Primary failure');
  });

  it('should replay every content chunk on a streaming cache hit', async () => {
    router.getCache().setEnabled(true);
    const request = {
      model: 'mock-gpt-4o',
      messages: [{ role: 'user' as const, content: 'Unique streaming cache replay test' }],
      stream: true,
    };

    const first = [];
    for await (const chunk of router.executeStream(request)) first.push(chunk);
    const second = [];
    for await (const chunk of router.executeStream(request)) second.push(chunk);

    const firstText = first.map(chunk => chunk.choices[0]?.delta.content || '').join('');
    const secondText = second.map(chunk => chunk.choices[0]?.delta.content || '').join('');
    expect(firstText).not.toBe('');
    expect(secondText).toBe(firstText);
    expect(second.at(-1)?.route_info?.cached).toBe(true);
  });

  it('should reject an offline file claim until write_file is verified on disk', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-write-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    (router as any).adapters.set('mock', new OfflineFileClaimAdapter());

    try {
      const chunks = [];
      for await (const chunk of router.executeStream({
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Create the file projects/proof.txt with the requested content.' }],
        stream: true,
        enable_tools: true,
      })) chunks.push(chunk);

      const text = chunks.map(chunk => chunk.choices[0]?.delta.content || '').join('');
      const writtenPath = path.join(testWorkspace, 'projects', 'proof.txt');
      expect(text).not.toContain('I wrote the requested file successfully.');
      expect(text).toContain('Verified file written');
      expect(fs.readFileSync(writtenPath, 'utf8')).toBe('verified offline write');
      expect(chunks.at(-1)?.route_info?.files_written?.[0].full_path).toBe(writtenPath);
      expect(chunks.at(-1)?.route_info?.files_written).toHaveLength(1);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should reject placeholder HTML and require a complete playable artifact', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-artifact-'));
    const adapter = new PlaceholderThenGameAdapter();
    ToolRegistry.setWorkspaceDir(testWorkspace);
    (router as any).adapters.set('mock', adapter);

    try {
      const chunks = [];
      for await (const chunk of router.executeStream({
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Build a complete playable HTML5 Canvas dogfight game with synth SFX in dogfight_3d.html.' }],
        stream: true,
        enable_tools: true,
      })) chunks.push(chunk);

      const writtenPath = path.join(testWorkspace, 'dogfight_3d.html');
      const text = chunks.map(chunk => chunk.choices[0]?.delta.content || '').join('');
      expect(adapter.correctionText).toContain('placeholder or unfinished-content text');
      expect(adapter.correctionText).toContain('complete, runnable content');
      expect(text).toContain('Verified file written');
      expect(fs.readFileSync(writtenPath, 'utf8')).toBe(COMPLETE_GAME_HTML);
      expect(chunks.at(-1)?.route_info?.files_written?.[0].bytes_written).toBeGreaterThan(800);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should continue after fake tool text until every local HTML dependency exists', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-dependencies-'));
    const adapter = new FakeTranscriptThenDependenciesAdapter();
    ToolRegistry.setWorkspaceDir(testWorkspace);
    (router as any).adapters.set('mock', adapter);

    try {
      const chunks = [];
      for await (const chunk of router.executeStream({
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Create the website in projects/site/index.html.' }],
        stream: true,
        enable_tools: true,
      })) chunks.push(chunk);

      const text = chunks.map(chunk => chunk.choices[0]?.delta.content || '').join('');
      expect(adapter.streamCalls).toBe(6);
      expect(adapter.correctionPrompts.some(prompt => prompt.includes('printed a textual transcript'))).toBe(true);
      expect(adapter.correctionPrompts.some(prompt => prompt.includes('game.js'))).toBe(true);
      expect(text).not.toContain('[Executed tool:');
      expect(fs.readFileSync(path.join(testWorkspace, 'projects', 'site', 'style.css'), 'utf8')).not.toContain('fake css');
      expect(fs.existsSync(path.join(testWorkspace, 'projects', 'site', 'game.js'))).toBe(true);
      expect(chunks.at(-1)?.route_info?.files_written?.[0].full_path).toBe(path.join(testWorkspace, 'projects', 'site', 'index.html'));
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should require a successful post-click runtime test before completing an HTML game', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-runtime-gate-'));
    const adapter = new RuntimeGateAdapter();
    const originalExecuteTool = ToolRegistry.executeTool;
    const executeSpy = vi.spyOn(ToolRegistry, 'executeTool').mockImplementation(async (name, args, artEngine) => {
      if (name === 'test_html_app') {
        return JSON.stringify({
          success: true,
          interactionVerified: true,
          clickedStart: true,
          clickTarget: '#start',
          runtimeErrors: [],
          consoleErrors: [],
        });
      }
      return await originalExecuteTool.call(ToolRegistry, name, args, artEngine);
    });
    ToolRegistry.setWorkspaceDir(testWorkspace);
    (router as any).adapters.set('mock', adapter);

    try {
      const chunks = [];
      for await (const chunk of router.executeStream({
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Build a complete playable arcade game in runtime_game.html.' }],
        stream: true,
        enable_tools: true,
      })) chunks.push(chunk);

      expect(adapter.runtimeCorrection).toContain('opening runtime_game.html');
      expect(adapter.runtimeCorrection).toContain('test_html_app');
      expect(executeSpy.mock.calls.some(call => call[0] === 'test_html_app')).toBe(true);
      expect(chunks.at(-1)?.route_info?.tools_executed).toContain('test_html_app');
      expect(chunks.map(chunk => chunk.choices[0]?.delta.content || '').join('')).toContain('post-click runtime test passed');
    } finally {
      executeSpy.mockRestore();
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should trip circuit breaker after repeated failures', () => {
    const cb = new CircuitBreaker();
    expect(cb.isAvailable('mock', 'model-1')).toBe(true);

    cb.recordFailure('mock', 'model-1');
    cb.recordFailure('mock', 'model-1');
    cb.recordFailure('mock', 'model-1');

    expect(cb.isAvailable('mock', 'model-1')).toBe(false);
  });
});
