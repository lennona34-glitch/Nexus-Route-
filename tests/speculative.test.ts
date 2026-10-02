import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingEngine } from '../src/router/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ProviderAdapter } from '../src/adapters/base.js';
import type { UniversalRequest, UniversalResponse, UniversalStreamChunk } from '../src/ir/types.js';
import { PromptConfigManager } from '../src/router/prompts-config.js';
import fsExtra from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_SPECTRUM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sound Forge Spectrum Deck</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    #visualizer { width: 800px; height: 350px; background: #1e293b; border-radius: 8px; border: 1px solid #334155; }
    .controls { margin-top: 16px; display: flex; gap: 12px; }
    button { background: #38bdf8; border: none; padding: 10px 20px; font-weight: bold; border-radius: 6px; cursor: pointer; }
    button:hover { background: #0284c7; }
  </style>
</head>
<body>
  <h1>Sound Forge DSP Spectrum Analyzer</h1>
  <canvas id="visualizer" width="800" height="350"></canvas>
  <div class="controls">
    <button id="startBtn">Start Audio Engine</button>
    <button id="stopBtn">Stop</button>
  </div>
  <script>
    let audioCtx;
    let analyser;
    const canvas = document.getElementById('visualizer');
    const ctx = canvas.getContext('2d');
    document.getElementById('startBtn').addEventListener('click', () => {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      const osc = audioCtx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, audioCtx.currentTime);
      osc.connect(analyser);
      analyser.connect(audioCtx.destination);
      osc.start();
      draw();
    });
    function draw() {
      requestAnimationFrame(draw);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#38bdf8';
      for (let i = 0; i < 64; i++) {
        const h = Math.random() * 200;
        ctx.fillRect(i * 12, canvas.height - h, 8, h);
      }
    }
  </script>
</body>
</html>`;

class MockDraftAndVerifierAdapter implements ProviderAdapter {
  readonly provider = 'local' as const;
  public chatCalls: Array<{ model: string; req: UniversalRequest }> = [];
  public streamCalls: Array<{ model: string; req: UniversalRequest }> = [];
  public candidate0Fails = false;
  public candidate0Html = false;
  public candidate0HallucinatesTool = false;
  public candidate0EmitsCustomFileTool = false;
  public candidate0HallucinatesWebAudio = false;
  private chatTurn = 0;
  private streamTurn = 0;

  public resetTurn() {
    this.chatTurn = 0;
    this.streamTurn = 0;
  }

  async isAvailable() { return true; }

  async chatCompletion(req: UniversalRequest, targetModel: string): Promise<UniversalResponse> {
    this.chatCalls.push({ model: targetModel, req });
    this.chatTurn++;

    if (this.candidate0EmitsCustomFileTool && targetModel.includes('1.5b')) {
      if (this.chatTurn === 1) {
        return {
          id: 'draft-custom-file-0',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                name: 'create_dsp_analyzer',
                arguments: {
                  filename: 'spectrum_deck.html',
                  content: REAL_SPECTRUM_HTML,
                },
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
        };
      } else {
        return {
          id: 'mock-chat-done-spectrum',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'Done. The file spectrum_deck.html is saved and verified on disk.',
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 },
        };
      }
    }

    if (this.candidate0HallucinatesTool && targetModel.includes('1.5b')) {
      return {
        id: 'draft-hallucinate-0',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{\n  "name": "compile_vst3",\n  "arguments": {\n    "files": ["plugins/guitar_plugin1.cpp"]\n  }\n}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };
    }

    if (this.candidate0Fails && targetModel.includes('1.5b')) {
      return {
        id: 'draft-fail-0',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Broken draft placeholder without file write.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    }

    if (this.candidate0HallucinatesWebAudio && targetModel.includes('1.5b')) {
      return {
        id: 'draft-fake-audio-0',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Writing ascii_camera.html with createChorus.',
            tool_calls: [{
              id: `call_write_${Date.now()}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  filename: 'ascii_camera.html',
                  content: '<!DOCTYPE html><html><head><title>Camera</title></head><body><canvas id="c"></canvas><script>const ctx = new AudioContext(); const chorus = ctx.createChorus();</script></body></html>',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
      };
    }

    if (this.candidate0HallucinatesWebAudio && this.chatTurn === 2) {
      return {
        id: 'mock-chat-repair-audio',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Repaired ascii_camera.html with real getUserMedia, ASCII ramp, and stereo delay chorus.',
            tool_calls: [{
              id: `call_write_repair_${Date.now()}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  filename: 'ascii_camera.html',
                  content: '<!DOCTYPE html><html><head><title>Camera</title></head><body><video id="v"></video><canvas id="c"></canvas><pre id="ascii"></pre><script>const ctx = new AudioContext(); const osc = ctx.createOscillator(); const d = ctx.createDelay(); const ramp = " .:-=+*#%@"; const adsr = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 }; navigator.mediaDevices.getUserMedia({ video: true });</script></body></html>',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 25, completion_tokens: 50, total_tokens: 75 },
      };
    }

    if (this.chatTurn === 1 || ((this.candidate0Fails || this.candidate0HallucinatesTool) && this.chatTurn === 2)) {
      return {
        id: 'mock-chat-tool',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Writing calc.ts now.',
            tool_calls: [{
              id: `call_write_${Date.now()}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  filename: 'calc.ts',
                  content: 'export function add(a: number, b: number): number { return a + b; }',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 25, completion_tokens: 50, total_tokens: 75 },
      };
    }

    return {
      id: 'mock-chat-done',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Done. The file calc.ts is saved and verified on disk.',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 },
    };
  }

  async *streamChatCompletion(req: UniversalRequest, targetModel: string): AsyncGenerator<UniversalStreamChunk> {
    this.streamCalls.push({ model: targetModel, req });
    this.streamTurn++;

    if (this.candidate0Html) {
      if (this.streamTurn === 1) {
        yield {
          id: 'chunk-write-html-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `call_stream_html_${Date.now()}`,
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    filename: '[🚀 gravity_sandbox.html(Launch Web App)](http://localhost:3000/v1/workspace/files/projects/New-Project-2/gravity_sandbox.html)',
                    content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>3D Planetary Gravity Sandbox</title>\n  <style>body { margin: 0; background: #050510; color: #fff; overflow: hidden; font-family: sans-serif; } canvas { display: block; width: 100vw; height: 100vh; }</style>\n</head>\n<body>\n  <div id="hud" style="position: absolute; top: 10px; left: 10px; z-index: 10; background: rgba(0,0,0,0.7); padding: 12px; border-radius: 8px;">\n    <h2>Planetary Gravity Sim</h2>\n    <label>Gravitational Constant: <input type="range" id="g" min="1" max="100" value="50"></label>\n    <div id="stats">Active Bodies: 3 | 60 FPS</div>\n  </div>\n  <canvas id="c"></canvas>\n  <script>\n    const c = document.getElementById("c");\n    const ctx = c.getContext("2d");\n    c.width = window.innerWidth; c.height = window.innerHeight;\n    const planets = [\n      { x: c.width/2, y: c.height/2, vx: 0, vy: 0, mass: 1000, radius: 15, color: "#ffcc00" },\n      { x: c.width/2, y: c.height/2 - 120, vx: 3.5, vy: 0, mass: 10, radius: 6, color: "#3399ff" },\n      { x: c.width/2, y: c.height/2 + 180, vx: -2.8, vy: 0, mass: 15, radius: 8, color: "#ff5533" }\n    ];\n    function update() {\n      ctx.fillStyle = "rgba(5, 5, 16, 0.3)";\n      ctx.fillRect(0, 0, c.width, c.height);\n      for (const p of planets) {\n        ctx.beginPath();\n        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);\n        ctx.fillStyle = p.color;\n        ctx.fill();\n        p.x += p.vx; p.y += p.vy;\n      }\n      requestAnimationFrame(update);\n    }\n    window.addEventListener("click", (e) => {\n      planets.push({ x: e.clientX, y: e.clientY, vx: (Math.random()-0.5)*4, vy: (Math.random()-0.5)*4, mass: 5, radius: 4, color: "#aaffaa" });\n    });\n    update();\n  </script>\n</body>\n</html>',
                  }),
                },
              }],
            },
            finish_reason: null,
          }],
        };
        return;
      } else {
        yield {
          id: 'chunk-done-html-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            delta: { content: 'Done. The 3D planetary gravity simulation is saved to gravity_sandbox.html.' },
            finish_reason: 'stop',
          }],
        };
        return;
      }
    }

    if (this.candidate0EmitsCustomFileTool && targetModel.includes('1.5b')) {
      if (this.streamTurn === 1) {
        yield {
          id: 'chunk-draft-custom-tool',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            delta: {
              content: JSON.stringify({
                name: 'create_dsp_analyzer',
                arguments: {
                  filename: 'spectrum_deck.html',
                  content: REAL_SPECTRUM_HTML,
                },
              }),
            },
            finish_reason: null,
          }],
        };
        return;
      } else {
        yield {
          id: 'chunk-done-custom-1',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [{
            index: 0,
            delta: { content: 'Done. The file spectrum_deck.html is saved and verified.' },
            finish_reason: 'stop',
          }],
        };
        return;
      }
    }

    if (this.candidate0HallucinatesTool && targetModel.includes('1.5b')) {
      yield {
        id: 'chunk-draft-hallucinate',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          delta: {
            content: '{\n  "name": "compile_vst3",\n  "arguments": {\n    "files": ["plugins/guitar_plugin1.cpp"]\n  }\n}',
          },
          finish_reason: null,
        }],
      };
      return;
    }

    if (this.candidate0Fails && targetModel.includes('1.5b')) {
      yield {
        id: 'chunk-draft-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          delta: { content: 'Incomplete draft without write.' },
          finish_reason: null,
        }],
      };
      return;
    }

    if (this.streamTurn === 1 || ((this.candidate0Fails || this.candidate0HallucinatesTool) && this.streamTurn === 2)) {
      yield {
        id: 'chunk-write-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_stream_${Date.now()}`,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  filename: 'stream_calc.ts',
                  content: 'export function multiply(a: number, b: number): number { return a * b; }',
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      };
    } else {
      yield {
        id: 'chunk-done-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          delta: { content: 'Done. The file stream_calc.ts is saved.' },
          finish_reason: 'stop',
        }],
      };
    }
  }
}

describe('⚡ Speculative Draft & Verify Pipeline', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), 'nexus-speculative-test-'));
    ToolRegistry.setWorkspaceDir(workspaceDir);
  });

  it('resolves speculative model into fast draft and verifier candidates', () => {
    const engine = new RoutingEngine({
      mock: new MockAdapter(),
      local: new MockAdapter(),
    });

    const candidates = engine.resolveCandidates({
      messages: [{ role: 'user', content: 'Create a high-speed trading simulator in index.html' }],
      model: 'speculative',
    });

    expect(candidates.candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.candidates[0].model).toBe('qwen2.5-coder:1.5b');
    expect(candidates.candidates[1].model).toContain('nexus-qwen3-brain');
    expect(candidates.classification.category).toBe('CODE_DEV');
  });

  it('allows customizing speculative draft and verifier models in PromptsConfig', () => {
    const engine = new RoutingEngine({
      mock: new MockAdapter(),
      local: new MockAdapter(),
    });
    engine.promptConfigManager.updateConfig({
      speculativeDraftModel: 'qwen2.5-coder:1.5b',
      speculativeVerifierModel: 'local/nexus-qwen3-brain:14b',
    });

    const candidates = engine.resolveCandidates({
      messages: [{ role: 'user', content: 'Build a game' }],
      model: 'speculative_draft_verify',
    });

    expect(candidates.candidates[0].model).toBe('qwen2.5-coder:1.5b');
    expect(candidates.candidates[1].model).toBe('local/nexus-qwen3-brain:14b');
  });

  it('executes speculative draft and passes on turn 1 when verified', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const response = await engine.executeChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Write calc.ts with an add function' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    expect(response.route_info).toBeDefined();
    expect(response.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(response.route_info?.speculative_verified).toBe(true);
    expect(response.route_info?.draft_rate).toBe(156.96);
    expect(response.route_info?.draft_model).toBe('qwen2.5-coder:1.5b');

    const createdFile = path.join(workspaceDir, 'calc.ts');
    expect(fsExtra.existsSync(createdFile)).toBe(true);
  });

  it('cascades to verifier candidate with [VERIFIER REPAIR PASS] when draft fails verification', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0Fails = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const response = await engine.executeChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Write calc.ts with an add function' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    expect(response.route_info).toBeDefined();
    expect(response.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(response.route_info?.speculative_verified).toBe(true);
    expect(response.route_info?.verifier_model).toContain('nexus-qwen3-brain');

    const verifierCall = mockAdapter.chatCalls.find(c => c.model.includes('nexus-qwen3-brain'));
    expect(verifierCall).toBeDefined();
    const lastMsg = verifierCall!.req.messages[verifierCall!.req.messages.length - 1];
    expect(lastMsg.content).toContain('[VERIFIER REPAIR PASS]');
  });

  it('streams speculative completion with seamless verifier transition on defect', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0Fails = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const chunks: UniversalStreamChunk[] = [];
    const stream = engine.streamChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Write stream_calc.ts now' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const fullContent = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
    expect(fullContent).toContain('Speculative Verifier');

    const stopChunk = chunks.find(c => c.choices?.[0]?.finish_reason === 'stop');
    expect(stopChunk).toBeDefined();
    expect(stopChunk?.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(stopChunk?.route_info?.speculative_verified).toBe(true);
    expect(stopChunk?.route_info?.verifier_model).toContain('nexus-qwen3-brain');
  });

  it('handles interactive HTML web app prompts with markdown links and finishes cleanly without looping', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0Html = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const chunks: UniversalStreamChunk[] = [];
    const stream = engine.streamChat({
      model: 'speculative',
      messages: [{
        role: 'user',
        content: 'Build a complete single-file standalone web app for Interactive 3D Planetary Gravity Sim in [🚀 gravity_sandbox.html(Launch Web App)](http://localhost:3000/v1/workspace/files/projects/New-Project-2/gravity_sandbox.html) featuring interactive mouse controls, real-time parameter sliders, and smooth 60fps rendering. Save to workspace using write_file.',
      }],
      metadata: { project_folder: 'projects/New-Project-2' },
      tools: ToolRegistry.getBuiltInTools(),
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const fullContent = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
    expect(fullContent).not.toContain('Stopped after 25 agent turns');
    expect(fullContent).toContain('gravity_sandbox.html');

    const createdFile = path.join(workspaceDir, 'projects', 'New-Project-2', 'gravity_sandbox.html');
    expect(fsExtra.existsSync(createdFile)).toBe(true);

    const stopChunk = chunks.findLast(c => c.choices?.[0]?.finish_reason === 'stop');
    expect(stopChunk).toBeDefined();
    expect(stopChunk?.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(stopChunk?.route_info?.speculative_verified).toBe(true);
    expect(mockAdapter.streamCalls.length).toBeLessThanOrEqual(3);
  });

  it('identifies "build a vst3 with electric guitar plug ins" as requiring file write', () => {
    const engine = new RoutingEngine();
    const candidates = engine.resolveCandidates({
      messages: [{ role: 'user', content: 'build a vst3 with as many electric guitar plug ins as you can fit.' }],
      model: 'speculative',
    });
    expect(candidates.classification.category).toBe('CODE_DEV');
  });

  it('cascades to verifier when draft hallucinates non-existent tool compile_vst3 in non-streaming', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0HallucinatesTool = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const response = await engine.executeChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'build a vst3 with as many electric guitar plug ins as you can fit.' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    expect(response.route_info).toBeDefined();
    expect(response.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(response.route_info?.speculative_verified).toBe(true);
    expect(response.route_info?.verifier_model).toContain('nexus-qwen3-brain');

    const verifierCall = mockAdapter.chatCalls.find(c => c.model.includes('nexus-qwen3-brain'));
    expect(verifierCall).toBeDefined();
    const lastMsg = verifierCall!.req.messages[verifierCall!.req.messages.length - 1];
    expect(lastMsg.content).toContain('[VERIFIER REPAIR PASS]');
    expect(lastMsg.content).toContain('compile_vst3');
  });

  it('suppresses raw hallucinated tool JSON and engages verifier seamlessly in streaming', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0HallucinatesTool = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const chunks: UniversalStreamChunk[] = [];
    const stream = engine.streamChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'build a vst3 with as many electric guitar plug ins as you can fit.' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const fullContent = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
    // The raw hallucinated JSON tool call must NOT be leaked to the client stream
    expect(fullContent).not.toContain('"name": "compile_vst3"');
    expect(fullContent).toContain('Speculative Verifier');

    const stopChunk = chunks.findLast(c => c.choices?.[0]?.finish_reason === 'stop');
    expect(stopChunk).toBeDefined();
    expect(stopChunk?.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(stopChunk?.route_info?.speculative_verified).toBe(true);
    expect(stopChunk?.route_info?.verifier_model).toContain('nexus-qwen3-brain');
  });

  it('does NOT trip the circuit breaker on repeated speculative draft verification failures', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0Fails = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    // Run 5 requests that fail candidate 0 verification
    for (let i = 0; i < 5; i++) {
      const resp = await engine.executeChat({
        model: 'speculative',
        messages: [{ role: 'user', content: `Write stream_calc_${i}.ts now` }],
        tools: ToolRegistry.getBuiltInTools(),
      });
      expect(resp.route_info?.verifier_model).toContain('nexus-qwen3-brain');
    }

    // Candidate 0 (qwen2.5-coder:1.5b) should STILL be available in the circuit breaker
    expect(engine.getCircuitBreaker().isAvailable('local', 'qwen2.5-coder:1.5b')).toBe(true);

    // When candidate 0 succeeds, it should execute as candidate 0 without being skipped
    mockAdapter.candidate0Fails = false;
    mockAdapter.resetTurn();
    const respSuccess = await engine.executeChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Write calc.ts now' }],
      tools: ToolRegistry.getBuiltInTools(),
    });
    expect(respSuccess.route_info?.selected_model).toBe('qwen2.5-coder:1.5b');
    expect(respSuccess.route_info?.attempts?.[0]?.status).toBe('success');
  });

  it('correctly classifies conversational, diagnostic, negative, and speed inquiries without forcing file writes', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const conversationalQueries = [
      "Don't build it.",
      "I want to know why the model speculative stopped working. check it",
      "1,2 and 3 please",
      "I'll try to be a bit clearer, thanks.",
      "with or without good grammar it still doesn't work.",
      "I'm not seeing 150 toks per sec. almost everything gets sent to the big coder at 17 toks sec.",
      "Why did that happen?",
      "Can you check the logs for errors?",
    ];

    for (const query of conversationalQueries) {
      const resp = await engine.executeChat({
        model: 'speculative',
        messages: [
          { role: 'user', content: 'build a vst3 with electric guitar plug ins in CMakeLists.txt' },
          { role: 'assistant', content: 'Created CMakeLists.txt' },
          { role: 'user', content: query },
        ],
      });
      // Should not fail draft verification for missing file write, should select candidate 0
      expect(resp.route_info?.selected_model).toBe('qwen2.5-coder:1.5b');
      expect(resp.choices[0].message.content).not.toContain('No file was written: no successful write_file');
    }
  });

  it('normalizes small-model custom tool names with file content to write_file so Candidate 0 succeeds', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0EmitsCustomFileTool = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    // Test streaming speculative call
    const chunks: UniversalStreamChunk[] = [];
    for await (const chunk of engine.executeStream({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Create an interactive studio audio DSP spectrum analyzer in spectrum_deck.html' }],
      tools: ToolRegistry.getBuiltInTools(),
      stream: true,
    })) {
      chunks.push(chunk);
    }

    // Candidate 0 should succeed without falling back to verifier
    const stopChunk = chunks.findLast(c => c.choices?.[0]?.finish_reason === 'stop');
    expect(stopChunk).toBeDefined();
    expect(stopChunk?.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(stopChunk?.route_info?.speculative_verified).toBe(true);

    // The file should be written to workspace
    const filePath = path.join(workspaceDir, 'spectrum_deck.html');
    expect(fsExtra.existsSync(filePath)).toBe(true);
    expect(fsExtra.readFileSync(filePath, 'utf8')).toContain('Spectrum Deck');

    // The output should NOT be suppressed with Incomplete artifact
    const fullText = chunks.map(c => c.choices[0]?.delta.content || '').join('');
    expect(fullText).not.toContain('⚠️ Incomplete artifact');
  });

  it('skips forcing test_html_app and open_in_browser_or_app when user manually opens files or creates audio tools', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0EmitsCustomFileTool = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    // When prompt states manual file opening or asks for audio DSP app, test_html_app should not be required
    const resp = await engine.executeChat({
      model: 'speculative',
      messages: [{
        role: 'user',
        content: "I will manually open files, it saves extra shenanigans. Create an interactive studio audio DSP spectrum analyzer in spectrum_deck.html",
      }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    // Should not trigger interactive test repair loops or open browser
    expect(resp.route_info?.selected_model).toBe('qwen2.5-coder:1.5b');
    expect(resp.choices[0].message.content).not.toContain('⚠️ Incomplete artifact');
  });

  it('cascades to verifier when draft calls hallucinated createChorus() in HTML', async () => {
    const mockAdapter = new MockDraftAndVerifierAdapter();
    mockAdapter.candidate0HallucinatesWebAudio = true;

    const engine = new RoutingEngine();
    engine.promptConfigManager.updateConfig({ workspaceDirectory: workspaceDir });
    (engine as any).adapters.set('local', mockAdapter);

    const response = await engine.executeChat({
      model: 'speculative',
      messages: [{ role: 'user', content: 'Build a complete single-file standalone web app for Retro ASCII Art Video Camera in ascii_camera.html featuring custom envelope ADSR dials, dual oscillators, and stereo chorus FX.' }],
      tools: ToolRegistry.getBuiltInTools(),
    });

    expect(response.route_info).toBeDefined();
    expect(response.route_info?.routing_strategy).toBe('speculative_draft_verify');
    expect(response.route_info?.speculative_verified).toBe(true);
    expect(response.route_info?.verifier_model).toContain('nexus-qwen3-brain');

    const verifierCall = mockAdapter.chatCalls.find(c => c.model.includes('nexus-qwen3-brain'));
    expect(verifierCall).toBeDefined();
    const lastMsg = verifierCall!.req.messages[verifierCall!.req.messages.length - 1];
    expect(lastMsg.content).toContain('[VERIFIER REPAIR PASS]');
    expect(lastMsg.content).toContain('createChorus');
  });
});