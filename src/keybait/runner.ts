/**
 * src/keybait/runner.ts - KeyBait Execution Engine for NexusRoute
 * Dispatches test prompts through NexusRoute's routing engine or local Codex Pro CLI,
 * tracks latency, token usage, and runs automated trap evaluations.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { RoutingEngine } from '../router/engine.js';
import { UniversalRequest, UniversalResponse } from '../ir/types.js';
import { KEYBAIT_PROMPTS, evaluateResponse, KeyBaitPrompt, TrapEvaluation } from './prompts.js';

export interface KeyBaitTestResult {
  ok: boolean;
  status_code: number;
  latency_ms: number;
  text: string;
  error: string | null;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  } | null;
  evaluation: TrapEvaluation;
  provider: string;
  model: string;
  prompt_id: string;
  route_details?: {
    strategy?: string;
    target_provider?: string;
    target_model?: string;
  };
}

export interface ScoreboardEntry {
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  status_code: number;
  preview: string;
  error?: string | null;
  evaluation?: TrapEvaluation;
}

/**
 * Locate local Codex CLI executable (if installed via Codex Pro).
 */
export function findCodexBinary(): string | null {
  // 1. Check ~/.codex/config.toml
  try {
    const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, 'utf8');
      for (const line of content.split('\n')) {
        if (line.includes('CODEX_CLI_PATH') && line.includes('=')) {
          const val = line.split('=')[1].trim().replace(/^['"]|['"]$/g, '');
          if (fs.existsSync(val)) return val;
        }
      }
    }
  } catch {}

  // 2. Scan AppData/Local/OpenAI/Codex/bin
  try {
    const baseDir = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(baseDir)) {
      const subdirs = fs.readdirSync(baseDir);
      for (const sub of subdirs) {
        const candidate = path.join(baseDir, sub, 'codex.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  return null;
}

/**
 * Run test prompt using Codex Pro CLI.
 */
export async function executeCodexPrompt(
  prompt: string,
  model: string = 'gpt-5.6-luna',
  timeoutMs: number = 45000
): Promise<{ ok: boolean; statusCode: number; text: string; error: string | null; tokens: any }> {
  const binary = findCodexBinary();
  if (!binary) {
    return {
      ok: false,
      statusCode: 404,
      text: '',
      error: 'Codex CLI binary not found. Ensure Codex Pro is installed.',
      tokens: null,
    };
  }

  const tmpOut = path.join(os.tmpdir(), `codex_kb_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);

  return new Promise(resolve => {
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-o',
      tmpOut,
    ];

    if (model && model !== 'default') {
      args.push('-m', model);
    }
    args.push(prompt);

    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      stdout += d.toString();
    });
    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      cleanup();
      resolve({
        ok: false,
        statusCode: 408,
        text: '',
        error: `Codex timed out after ${Math.round(timeoutMs / 1000)}s`,
        tokens: null,
      });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      } catch {}
    }

    child.on('close', code => {
      let output = '';
      try {
        if (fs.existsSync(tmpOut)) {
          output = fs.readFileSync(tmpOut, 'utf8').trim();
        }
      } catch {}

      if (!output && stdout) {
        output = stdout.trim();
      }

      cleanup();

      if (code !== 0 && !output) {
        return resolve({
          ok: false,
          statusCode: 500,
          text: '',
          error: stderr.trim() || `Codex exited with code ${code}`,
          tokens: null,
        });
      }

      const promptWords = prompt.split(/\s+/).length;
      const compWords = output.split(/\s+/).length;

      resolve({
        ok: true,
        statusCode: 200,
        text: output,
        error: null,
        tokens: {
          prompt: Math.round(promptWords * 1.3),
          completion: Math.round(compWords * 1.3),
          total: Math.round((promptWords + compWords) * 1.3),
        },
      });
    });

    child.on('error', err => {
      cleanup();
      resolve({
        ok: false,
        statusCode: 500,
        text: '',
        error: err.message,
        tokens: null,
      });
    });
  });
}

/**
 * Execute a single KeyBait test against any model or provider.
 */
export async function runKeyBaitTest(
  router: RoutingEngine,
  params: {
    prompt_id?: string;
    prompt_text?: string;
    system_prompt?: string;
    provider?: string;
    model?: string;
  }
): Promise<KeyBaitTestResult> {
  const promptObj = params.prompt_id
    ? KEYBAIT_PROMPTS.find(p => p.id === params.prompt_id)
    : undefined;

  const promptText = params.prompt_text || promptObj?.prompt || 'Respond with the single uppercase word: PONG.';
  const systemPrompt = params.system_prompt || promptObj?.system_prompt;
  const targetProvider = (params.provider || 'auto').toLowerCase();
  let targetModel = params.model || (targetProvider === 'codex' ? 'gpt-5.6-luna' : 'auto');

  // If a specific provider is targeted, format with provider:: prefix so routing engine targets that provider directly
  if (targetProvider && targetProvider !== 'auto' && targetProvider !== 'local' && targetProvider !== 'codex') {
    if (!targetModel.startsWith(`${targetProvider}::`) && !targetModel.startsWith(`${targetProvider}/`)) {
      targetModel = `${targetProvider}::${targetModel}`;
    }
  }

  const startTime = Date.now();

  // 1. Special Case: Codex Pro CLI
  if (targetProvider === 'codex') {
    const codexRes = await executeCodexPrompt(promptText, targetModel);
    const latency = Date.now() - startTime;
    const evalResult = promptObj
      ? evaluateResponse(promptObj, codexRes.text)
      : { status: 'unverified' as const, message: 'Completed test.' };

    return {
      ok: codexRes.ok,
      status_code: codexRes.statusCode,
      latency_ms: latency,
      text: codexRes.text,
      error: codexRes.error,
      tokens: codexRes.tokens,
      evaluation: evalResult,
      provider: 'codex',
      model: targetModel,
      prompt_id: params.prompt_id || 'custom',
      route_details: {
        strategy: 'codex_cli_direct',
        target_provider: 'codex',
        target_model: targetModel,
      },
    };
  }

  // 2. Dispatch via NexusRoute's Universal Routing Engine
  const messages: UniversalRequest['messages'] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: promptText });

  const universalReq: UniversalRequest = {
    model: targetModel,
    messages,
    temperature: 0.1,
    timeout_ms: 35000,
    ui_origin: 'keybait_lab',
  };

  try {
    const resp: UniversalResponse = await router.executeChat(universalReq);
    const latency = Date.now() - startTime;
    const text = resp.choices?.[0]?.message?.content || '';
    const evalResult = promptObj
      ? evaluateResponse(promptObj, text)
      : { status: 'unverified' as const, message: 'Response received.' };

    const promptTokens = resp.usage?.prompt_tokens || Math.round(promptText.split(/\s+/).length * 1.3);
    const compTokens = resp.usage?.completion_tokens || Math.round(text.split(/\s+/).length * 1.3);

    return {
      ok: true,
      status_code: 200,
      latency_ms: latency,
      text,
      error: null,
      tokens: {
        prompt: promptTokens,
        completion: compTokens,
        total: resp.usage?.total_tokens || promptTokens + compTokens,
      },
      evaluation: evalResult,
      provider: resp.route_info?.selected_provider || targetProvider,
      model: resp.model || resp.route_info?.selected_model || targetModel,
      prompt_id: params.prompt_id || 'custom',
      route_details: {
        strategy: resp.route_info?.routing_strategy || 'nexus_routed',
        target_provider: resp.route_info?.selected_provider,
        target_model: resp.route_info?.selected_model,
      },
    };
  } catch (err: any) {
    const latency = Date.now() - startTime;
    return {
      ok: false,
      status_code: err.statusCode || 500,
      latency_ms: latency,
      text: '',
      error: err.message || 'Routing engine error',
      tokens: null,
      evaluation: { status: 'failed', message: err.message || 'API call failed' },
      provider: targetProvider,
      model: targetModel,
      prompt_id: params.prompt_id || 'custom',
    };
  }
}

/**
 * Test all active providers side-by-side in parallel for the scoreboard.
 */
export async function runKeyBaitScoreboard(
  router: RoutingEngine,
  promptId: string = 'ping_pong'
): Promise<{ prompt: KeyBaitPrompt; results: ScoreboardEntry[] }> {
  const promptObj = KEYBAIT_PROMPTS.find(p => p.id === promptId) || KEYBAIT_PROMPTS[0];

  // List of active providers to test
  const testCandidates: Array<{ provider: string; model: string; name: string }> = [
    { provider: 'cerebras', model: 'cerebras::gpt-oss-120b', name: 'Cerebras' },
    { provider: 'groq', model: 'groq::groq/compound-mini', name: 'Groq' },
    { provider: 'mistral', model: 'mistral::mistral-small-latest', name: 'Mistral' },
    { provider: 'deepseek', model: 'deepseek::deepseek-chat', name: 'DeepSeek' },
    { provider: 'gemini', model: 'gemini::gemini-flash-latest', name: 'Gemini' },
    { provider: 'xai', model: 'xai::grok-4.3', name: 'xAI' },
    { provider: 'openrouter', model: 'openrouter::meta-llama/llama-3.3-70b-instruct', name: 'OpenRouter' },
    { provider: 'codex', model: 'gpt-5.6-luna', name: 'Codex Pro' },
    { provider: 'local', model: 'auto', name: 'NexusRoute Gateway' },
  ];

  const tasks = testCandidates.map(async candidate => {
    try {
      const res = await runKeyBaitTest(router, {
        prompt_id: promptObj.id,
        prompt_text: promptObj.prompt,
        provider: candidate.provider,
        model: candidate.model,
      });

      return {
        provider: candidate.name,
        model: res.model || candidate.model,
        ok: res.ok,
        latency_ms: res.latency_ms,
        status_code: res.status_code,
        preview: res.text ? res.text.slice(0, 100) : '',
        error: res.error,
        evaluation: res.evaluation,
      };
    } catch (e: any) {
      return {
        provider: candidate.name,
        model: candidate.model,
        ok: false,
        latency_ms: 0,
        status_code: 500,
        preview: '',
        error: e.message,
      };
    }
  });

  const results = await Promise.all(tasks);
  // Sort by latency (fastest first for successful ones)
  results.sort((a, b) => {
    if (a.ok && !b.ok) return -1;
    if (!a.ok && b.ok) return 1;
    return a.latency_ms - b.latency_ms;
  });

  return { prompt: promptObj, results };
}
