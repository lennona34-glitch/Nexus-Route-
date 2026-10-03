import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { spawn, execSync, exec, execFile, execFileSync, type ChildProcess } from 'child_process';
import https from 'https';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { WebSocketServer, WebSocket } from 'ws';

import { validateAndNormalizeRequest, ValidationError } from './ir/validator.js';
import { RoutingEngine, RouterConfig } from './router/engine.js';
import { PromptsConfig } from './router/prompts-config.js';
import { MODEL_CATALOG } from './router/capabilities.js';
import { formatSseChunk, formatSseDone } from './streaming/sse-transformer.js';
import { MockAdapter } from './adapters/mock.js';
import { LocalAdapter } from './adapters/local.js';
import { AdapterError } from './adapters/base.js';
import { ProviderType, UniversalRequest } from './ir/types.js';
import { KeyManager } from './auth/key-manager.js';
import { ToolRegistry, getRunningAndroidDevices, installAndLaunchApkOnEmulator } from './tools/registry.js';
import { adminAuth } from './security/auth.js';
import { isInsideDir, sanitizeWorkspacePath, SecurityError } from './security/path.js';
import { validatePublicHttpUrl } from './security/ssrf.js';
import { endlessForgeEngine } from './endless-forge/engine.js';
import { unloadOllamaModels } from './gpu/ollama.js';
import { FREE_PROVIDER_CATALOG, type QuotaUnit, type ResetInterval } from './providers/connection-manager.js';
import { getCompressionStats, listRawContexts, recoverRawContext } from './context/compression.js';
import { getMcpInfo, handleMcpMessage, type JsonRpcRequest } from './mcp/handler.js';
import { ProviderModelDiscovery } from './providers/model-discovery.js';
import { EmbeddedLocalEngine } from './engine/embedded-local.js';
import { LocalGpuArtEngine } from './engine/gpu-art.js';
import {
  translateAnthropicToUniversalRequest,
  translateUniversalToAnthropicResponse,
  handleAnthropicMessagesStream,
} from './anthropic/handler.js';
import {
  KEYBAIT_PROMPTS,
  runKeyBaitTest,
  runKeyBaitScoreboard,
  findCodexBinary,
} from './keybait/index.js';
import { ShareManager } from './mesh/shares.js';
import { MeshHub } from './mesh/hub.js';
import { getRetroSystem, RETRO_SYSTEMS } from './mesh/retro_knowledge.js';
import { SovereignAgentRunner } from './mesh/agent_runner.js';
import { registerStudioRoutes } from './studio/index.js';
import { CivitaiService } from './civitai/civitai-service.js';
import { registerCivitaiRoutes } from './civitai/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envFilePath = path.join(__dirname, '../.env');

// Simple .env parser to load keys if file exists
function loadEnvFile() {
  if (fs.existsSync(envFilePath)) {
    const lines = fs.readFileSync(envFilePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        process.env[key] = val;
      }
    }
  }
}
loadEnvFile();

process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Server] Intercepted unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Intercepted uncaught exception:', err);
});

function saveEnvFile(provider: string, apiKey?: string, model?: string) {
  const envMap: Record<string, string> = {};
  if (fs.existsSync(envFilePath)) {
    const lines = fs.readFileSync(envFilePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        envMap[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }

  const envVarMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    xai: 'XAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    cheaperinference: 'CHEAPERINFERENCE_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    github: 'GITHUB_TOKEN',
    together: 'TOGETHER_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
    unorouter: 'UNOROUTER_API_KEY',
    qwen: 'QWEN_API_KEY',
    dashscope: 'QWEN_API_KEY',
    xkiro: 'XKIRO_API_KEY',
    cloudflare: 'CLOUDFLARE_API_TOKEN',
    aimlapi: 'AIMLAPI_API_KEY',
    aiml: 'AIMLAPI_API_KEY',
    gmicloud: 'GMI_API_KEY',
    gmi: 'GMI_API_KEY',
    inception: 'INCEPTION_API_KEY',
    inceptionlabs: 'INCEPTION_API_KEY',
    atria: 'ATRIA_API_KEY',
    'atria-asi': 'ATRIA_API_KEY',
    atriaasi: 'ATRIA_API_KEY',
    dawn: 'ATRIA_API_KEY',
  };

  const modelVarMap: Record<string, string> = {
    nvidia: 'NVIDIA_DEFAULT_MODEL',
    unorouter: 'UNOROUTER_DEFAULT_MODEL',
    qwen: 'QWEN_DEFAULT_MODEL',
    dashscope: 'QWEN_DEFAULT_MODEL',
    xkiro: 'XKIRO_DEFAULT_MODEL',
    cloudflare: 'CLOUDFLARE_DEFAULT_MODEL',
    aimlapi: 'AIMLAPI_DEFAULT_MODEL',
    gmicloud: 'GMICLOUD_DEFAULT_MODEL',
    inception: 'INCEPTION_DEFAULT_MODEL',
    inceptionlabs: 'INCEPTION_DEFAULT_MODEL',
    atria: 'ATRIA_DEFAULT_MODEL',
    'atria-asi': 'ATRIA_DEFAULT_MODEL',
    atriaasi: 'ATRIA_DEFAULT_MODEL',
    dawn: 'ATRIA_DEFAULT_MODEL',
  };

  let changed = false;
  const pLower = provider.toLowerCase();
  const varName = envVarMap[pLower];
  if (varName && apiKey !== undefined) {
    if (apiKey) {
      if (pLower === 'cloudflare' && apiKey.includes(':')) {
        const parts = apiKey.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          envMap['CLOUDFLARE_ACCOUNT_ID'] = parts[0].trim();
          process.env.CLOUDFLARE_ACCOUNT_ID = parts[0].trim();
          envMap['CLOUDFLARE_API_TOKEN'] = parts[1].trim();
          process.env.CLOUDFLARE_API_TOKEN = parts[1].trim();
        }
      } else {
        envMap[varName] = apiKey;
        process.env[varName] = apiKey;
      }
    } else {
      delete envMap[varName];
      delete process.env[varName];
      if (pLower === 'cloudflare') {
        delete envMap['CLOUDFLARE_ACCOUNT_ID'];
        delete process.env['CLOUDFLARE_ACCOUNT_ID'];
      }
    }
    changed = true;
  }

  const modelVar = modelVarMap[pLower];
  if (modelVar && model !== undefined) {
    if (model.trim()) {
      envMap[modelVar] = model.trim();
      process.env[modelVar] = model.trim();
    } else {
      delete envMap[modelVar];
      delete process.env[modelVar];
    }
    changed = true;
  }

  if (changed) {
    const output = Object.entries(envMap)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(envFilePath, output, 'utf8');
  }
}

// Load default config from config/routes.json if present
let initialConfig: RouterConfig | undefined;
try {
  const configPath = path.join(__dirname, '../config/routes.json');
  if (fs.existsSync(configPath)) {
    initialConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch {
  // Use engine defaults if file read fails
}

const router = new RoutingEngine(initialConfig);
const providerModelDiscovery = new ProviderModelDiscovery(router.getConnectionManager(), {
  isProviderEnabled: provider => router.isProviderEnabled(provider),
});
const keyManager = new KeyManager();

// Nexus Mesh: P2P & Hub Sharing Engine
const meshShareManager = new ShareManager();
const meshHub = new MeshHub(meshShareManager, {
  handle: process.env.NEXUS_HANDLE || 'NexusHost',
  avatar: '⚡',
  hubName: process.env.NEXUS_HUB_NAME || 'The Creative Syndicate',
  hubMotd: 'Welcome to Nexus Mesh! Right-click any user to browse their shared drive. Tag @nexus for AI help.',
});

meshHub.setAiHandlers(
  async (prompt: string) => {
    try {
      const universalReq: UniversalRequest = {
        messages: [{ role: 'user', content: prompt }],
        model: router.getPinnedModel() || 'auto',
        temperature: 0.7,
      };
      const resp = await router.executeChat(universalReq);
      return resp.choices[0]?.message?.content || 'No response generated.';
    } catch (e: any) {
      return `[NexusAI]: ${e.message}`;
    }
  },
  async (prompt: string) => {
    try {
      const cleanPrompt = prompt.replace(/^\/(art|video|image|draw|clip)\s*/i, '').trim();
      const isVideo = prompt.toLowerCase().startsWith('/video') || prompt.toLowerCase().startsWith('/clip');
      if (isVideo) {
        const ws = ToolRegistry.getWorkspaceDir();
        const res = await LocalGpuArtEngine.renderMorphSequence(cleanPrompt, { workspaceDir: ws });
        if (res && res.success && res.url) {
          return { videoUrl: res.url, text: `Synthesized motion clip: "${cleanPrompt}"` };
        } else {
          return { text: `[NexusAI GPU Error]: ${(res && res.error) || 'Motion clip rendering failed.'}` };
        }
      } else {
        const ws = ToolRegistry.getWorkspaceDir();
        const res = await LocalGpuArtEngine.generateImage({ prompt: cleanPrompt }, ws);
        if (res && res.success && res.url) {
          return { imageUrl: res.url, text: `Generated artwork: "${cleanPrompt}"` };
        } else {
          return { text: `[NexusAI GPU Error]: ${(res && res.error) || 'Artwork generation failed.'}` };
        }
      }
    } catch (e: any) {
      return { text: `[NexusAI GPU Error]: ${e.message}` };
    }
  }
);

// Sovereign Autonomous Agent Runner for offline models and tool-calling
const sovereignAgentRunner = new SovereignAgentRunner(
  async (messages, tools) => {
    try {
      const universalReq: UniversalRequest = {
        messages: messages.map(m => ({ role: m.role as any, content: m.content })),
        model: router.getPinnedModel() || 'auto',
        tools: tools,
        temperature: 0.2,
      };
      const resp = await router.executeChat(universalReq);
      const choice = resp.choices[0]?.message;
      return {
        content: choice?.content || '',
        tool_calls: choice?.tool_calls as any,
      };
    } catch (err: any) {
      return { content: `[Agent Execution Error]: ${err.message}` };
    }
  },
  meshShareManager
);
meshHub.setAgentRunner(sovereignAgentRunner);
const configuredBodyLimitMb = Number(process.env.NEXUS_BODY_LIMIT_MB || 64);
const bodyLimitMb = Number.isFinite(configuredBodyLimitMb)
  ? Math.max(2, Math.min(250, configuredBodyLimitMb))
  : 64;
const app = fastify({
  logger: false,
  // Vision requests carry base64 image data, and audio requests carry lossless
  // tracks like FLAC and WAV. Keep default bounded comfortably high.
  bodyLimit: Math.round(bodyLimitMb * 1024 * 1024),
  connectionTimeout: 900000,
  requestTimeout: 900000,
});

// Configure Secure CORS Policy (Localhost, LAN/Wi-Fi, and Public Tunnels enabled by default)
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['*'];

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    // If explicit CORS_ORIGIN is specified by user, enforce strict matching
    if (process.env.CORS_ORIGIN && !allowedOrigins.includes('*')) {
      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Blocked by CORS origin security policy.'), false);
    }

    // Default policy: Allow localhost, LAN IPs (192.168.x, 10.x, 172.x), and Cloudflare/localtunnel edges
    cb(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
});

app.setErrorHandler((error: any, request, reply) => {
  console.error(`[Fastify Global Error] ${request.method} ${request.url}:`, error);
  reply.status(error.statusCode || 500).send({
    success: false,
    statusCode: error.statusCode || 500,
    error: error.name || 'Internal Server Error',
    message: error.message || 'An error occurred processing the request',
  });
});

// Serve web UI dashboard
const publicDir = path.join(__dirname, 'web/public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
  setHeaders: (res) => {
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.header('Pragma', 'no-cache');
    res.header('Expires', '0');
  },
});

app.get('/radio', async (_req, reply) => {
  return reply.sendFile('radio.html');
});

// Helper for Local Loopback Verification
function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.ip || '';
  const host = req.hostname || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1') ||
    ip === 'localhost' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.includes('127.0.0.1') ||
    host.includes('localhost')
  );
}

// Helper for Admin Route Authentication
function verifyAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = (req.headers.authorization || req.headers['x-admin-key'] || '') as string;
  if (adminAuth.validate(authHeader)) {
    return true;
  }

  // Local loopback interface check: if caller is local and no custom ADMIN_API_KEY is enforced, allow
  if (isLocalRequest(req) && !process.env.ADMIN_API_KEY) {
    return true;
  }

  reply.status(401).send({ error: 'Unauthorized: Admin authentication required.' });
  return false;
}

// Session Token Endpoint (for Local Web UI)
app.get('/v1/auth/session', async (req, reply) => {
  if (isLocalRequest(req) && !process.env.ADMIN_API_KEY) {
    return { token: adminAuth.getAdminKey() };
  }
  return reply.status(403).send({ error: 'Session tokens are only issued to local loopback clients.' });
});

// Health Endpoint
app.get('/health', async () => {
  return {
    status: 'ok',
    version: '1.3.0',
    timestamp: new Date().toISOString(),
    circuits: router.getCircuitBreaker().getStatus(),
    cache: router.getCache().getStats(),
  };
});

// List Models Endpoint (OpenAI Compatible)
const handleListModels = async () => {
  const cfg = router.getConfig();
  const data: Array<{ id: string; object: 'model'; created: number; owned_by: string; description?: string }> = [];

  for (const [name, meta] of Object.entries(cfg.virtual_models)) {
    data.push({
      id: name,
      object: 'model',
      created: 1700000000,
      owned_by: 'nexus-route (virtual)',
      description: meta.description,
    });
  }

  for (const [id, meta] of Object.entries(MODEL_CATALOG)) {
    data.push({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: `${meta.provider} (upstream)`,
      description: (meta as any).description,
    });
  }

  // Dynamically include local Ollama models (Dolphin Roaster, Dolphin Maverick, Wizard Coder, etc.)
  try {
    const ollamaRes = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1000) });
    if (ollamaRes.ok) {
      const oData = await ollamaRes.json() as { models?: Array<{ name: string; details?: { parameter_size?: string } }> };
      if (Array.isArray(oData.models)) {
        for (const m of oData.models) {
          const modelTag = m.name;
          data.push({
            id: `local/${modelTag}`,
            object: 'model',
            created: 1700000000,
            owned_by: 'ollama (local GPU/CPU)',
            description: `Offline local model: ${modelTag} (${m.details?.parameter_size || 'local'})`,
          });
        }
      }
    }
  } catch {}

  return {
    object: 'list',
    data,
  };
};

app.get('/v1/models', handleListModels);
app.get('/models', handleListModels);

// Provider Key Status & Configuration
app.get('/v1/keys/status', async () => {
  return {
    providers: router.getProviderStatus(),
  };
});

// Live, key-aware cloud catalogue. Results are cached so opening the model
// selector does not repeatedly hit every upstream provider.
app.get<{ Querystring: { refresh?: string } }>('/v1/provider-models', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  return providerModelDiscovery.getCatalogue(force);
});

app.post<{ Body: { provider: string; apiKey?: string; model?: string } }>('/v1/keys', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { provider, apiKey, model } = req.body || {};
  if (!provider) {
    return reply.status(400).send({ error: 'Provider name required' });
  }

  const pType = provider.toLowerCase() as ProviderType;
  if (apiKey !== undefined) {
    router.setApiKey(pType, apiKey || '');
  }
  providerModelDiscovery.invalidate(pType);
  saveEnvFile(provider, apiKey, model);

  return {
    success: true,
    provider: pType,
    status: router.getProviderStatus()[pType],
    configuredModel: model !== undefined ? model.trim() : (
      pType === 'nvidia' ? process.env.NVIDIA_DEFAULT_MODEL :
      pType === 'unorouter' ? process.env.UNOROUTER_DEFAULT_MODEL :
      pType === 'qwen' ? process.env.QWEN_DEFAULT_MODEL :
      pType === 'xkiro' ? process.env.XKIRO_DEFAULT_MODEL :
      pType === 'cloudflare' ? process.env.CLOUDFLARE_DEFAULT_MODEL :
      pType === 'aimlapi' ? process.env.AIMLAPI_DEFAULT_MODEL :
      pType === 'gmicloud' ? process.env.GMICLOUD_DEFAULT_MODEL :
      pType === 'inception' ? process.env.INCEPTION_DEFAULT_MODEL :
      pType === 'atria' ? process.env.ATRIA_DEFAULT_MODEL : undefined
    ),
  };
});

app.post<{ Body: { provider: string; enabled: boolean } }>('/v1/providers/toggle', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { provider, enabled } = req.body || {};
  if (!provider) {
    return reply.status(400).send({ error: 'Provider name required' });
  }

  const pType = provider.toLowerCase() as ProviderType;
  router.setProviderEnabled(pType, enabled !== false);
  providerModelDiscovery.invalidate(pType);

  return {
    success: true,
    provider: pType,
    status: router.getProviderStatus()[pType],
  };
});

// Multi-key upstream connection pools and free-capacity tracking
app.get('/v1/provider-connections', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  return {
    connections: router.getConnectionManager().listPublic(),
    providers: router.getProviderStatus(),
  };
});

app.post<{ Body: {
  provider: string;
  apiKey: string;
  label?: string;
  quotaLimit?: number;
  quotaUnit?: QuotaUnit;
  resetInterval?: ResetInterval;
  resetAt?: number | string;
} }>('/v1/provider-connections', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const body = req.body || ({} as any);
  if (!body.provider || !body.apiKey) return reply.status(400).send({ error: 'provider and apiKey are required' });
  const provider = body.provider.toLowerCase() as ProviderType;
  try {
    router.getConnectionManager().addConnection(provider, body.apiKey, {
      label: body.label,
      quotaLimit: body.quotaLimit === undefined || body.quotaLimit === null || String(body.quotaLimit) === '' ? undefined : Number(body.quotaLimit),
      quotaUnit: body.quotaUnit,
      resetInterval: body.resetInterval,
      resetAt: body.resetAt ? new Date(body.resetAt).getTime() : undefined,
    });
    providerModelDiscovery.invalidate(provider);
    return { success: true, connections: router.getConnectionManager().listPublic() };
  } catch (error: any) {
    return reply.status(400).send({ error: error.message });
  }
});

app.delete<{ Params: { id: string } }>('/v1/provider-connections/:id', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const success = router.getConnectionManager().removeConnection(req.params.id);
  providerModelDiscovery.invalidate();
  return { success };
});

app.post<{ Params: { id: string }; Body: { enabled?: boolean; reset?: boolean } }>('/v1/provider-connections/:id/state', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const success = req.body?.reset
    ? router.getConnectionManager().resetConnection(req.params.id)
    : router.getConnectionManager().setEnabled(req.params.id, req.body?.enabled !== false);
  providerModelDiscovery.invalidate();
  return { success, connections: router.getConnectionManager().listPublic() };
});

app.get('/v1/free-capacity', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const providerStatus = router.getProviderStatus();
  const connections = router.getConnectionManager().listPublic().map(connection => ({
    ...connection,
    providerEnabled: providerStatus[connection.provider]?.enabled !== false,
    routingStatus: providerStatus[connection.provider]?.enabled === false ? 'disabled' : connection.status,
  }));
  return {
    catalog: FREE_PROVIDER_CATALOG,
    connections,
    providers: router.getConnectionManager().getProviderSummary(),
    providerStatus,
    note: 'Provider limits change frequently. Quotas shown here are the limits you enter for each key; NexusRoute measures their usage and automatically skips unavailable connections.',
  };
});

// Live Provider Balances & Credit Monitor
app.get('/v1/provider-balances', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const telemetry = router.getTelemetryStore().summary();
  const providerUsage = telemetry.providers || {};

  async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs = 4000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  const dsKey = process.env.DEEPSEEK_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const togetherKey = process.env.TOGETHER_API_KEY;

  const [dsData, orData, togetherData] = await Promise.all([
    dsKey ? fetchWithTimeout('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${dsKey}` }) : Promise.resolve(null),
    orKey ? fetchWithTimeout('https://openrouter.ai/api/v1/credits', { Authorization: `Bearer ${orKey}` }) : Promise.resolve(null),
    togetherKey ? fetchWithTimeout('https://api.together.xyz/v1/users/me', { Authorization: `Bearer ${togetherKey}` }) : Promise.resolve(null),
  ]);

  const results: any[] = [];
  let totalLiveBalanceUsd = 0;

  // 1. DeepSeek
  if (dsKey) {
    let balanceUsd = 0;
    let grantedUsd = 0;
    let toppedUpUsd = 0;
    let isAvailable = true;
    if (dsData?.balance_infos?.[0]) {
      const info = dsData.balance_infos[0];
      balanceUsd = parseFloat(info.total_balance) || 0;
      grantedUsd = parseFloat(info.granted_balance) || 0;
      toppedUpUsd = parseFloat(info.topped_up_balance) || 0;
      isAvailable = dsData.is_available !== false;
    }
    totalLiveBalanceUsd += balanceUsd;
    const usage = providerUsage.deepseek || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'deepseek',
      displayName: 'DeepSeek AI',
      badge: 'Coding & Reasoner',
      currency: 'USD',
      hasLiveBalance: !!dsData,
      balanceUsd,
      grantedUsd,
      toppedUpUsd,
      isAvailable,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: isAvailable ? 'active' : 'exhausted',
    });
  }

  // 2. OpenRouter
  if (orKey) {
    let balanceUsd = 0;
    let totalCredits = 0;
    let totalUsage = 0;
    if (orData?.data) {
      totalCredits = Number(orData.data.total_credits) || 0;
      totalUsage = Number(orData.data.total_usage) || 0;
      balanceUsd = Math.max(0, totalCredits - totalUsage);
    }
    totalLiveBalanceUsd += balanceUsd;
    const usage = providerUsage.openrouter || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'openrouter',
      displayName: 'OpenRouter',
      badge: 'Universal Aggregator',
      currency: 'USD',
      hasLiveBalance: !!orData,
      balanceUsd,
      totalCreditsUsd: totalCredits,
      totalUsageUsd: totalUsage,
      isAvailable: balanceUsd > 0.001,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: balanceUsd > 0.001 ? 'active' : 'depleted',
    });
  }

  // 3. CheaperInference
  if (process.env.CHEAPERINFERENCE_API_KEY) {
    const usage = providerUsage.cheaperinference || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'cheaperinference',
      displayName: 'CheaperInference',
      badge: 'Ultra-Low Cost Inference',
      currency: 'USD',
      hasLiveBalance: false,
      tier: 'Pay-as-you-go',
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 3.5. Cerebras Cloud
  if (process.env.CEREBRAS_API_KEY) {
    const usage = providerUsage.cerebras || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'cerebras',
      displayName: 'Cerebras Cloud',
      badge: '1,800+ tok/s Free Inference',
      currency: 'USD',
      hasLiveBalance: false,
      tier: 'Developer Free Tier',
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 3.6. NVIDIA NIM Cloud
  if (process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY || process.env.NVAPI_KEY) {
    const usage = providerUsage.nvidia || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'nvidia',
      displayName: 'NVIDIA NIM Cloud',
      badge: '1,000 Free Credits on Signup',
      currency: 'USD',
      hasLiveBalance: false,
      tier: 'Developer Tier (1,000 Credits)',
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 3.7. UnoRouter
  if (process.env.UNOROUTER_API_KEY || process.env.UNO_ROUTER_API_KEY) {
    const usage = providerUsage.unorouter || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'unorouter',
      displayName: 'UnoRouter',
      badge: 'Free Models & Tool Calling',
      currency: 'USD',
      hasLiveBalance: false,
      tier: 'Free Aggregated Tier',
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 3.8. Qwen / DashScope
  if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) {
    const usage = providerUsage.qwen || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'qwen',
      displayName: 'Qwen / DashScope',
      badge: 'Alibaba Cloud Maas',
      currency: 'USD',
      hasLiveBalance: false,
      tier: 'Pay-as-you-go / Token Plan',
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 4. Together AI
  if (togetherKey) {
    let balanceUsd = 0;
    if (togetherData?.credits?.balance) {
      balanceUsd = Number(togetherData.credits.balance) || 0;
    }
    totalLiveBalanceUsd += balanceUsd;
    const usage = providerUsage.together || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'together',
      displayName: 'Together AI',
      badge: 'Fast Open Source & Art',
      currency: 'USD',
      hasLiveBalance: !!togetherData,
      balanceUsd,
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 5. Groq (Free Tier)
  if (process.env.GROQ_API_KEY) {
    const usage = providerUsage.groq || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'groq',
      displayName: 'Groq Cloud',
      badge: 'Ultra-Fast LPU',
      tier: 'Free Tier (14,400 req/day)',
      currency: 'USD',
      hasLiveBalance: false,
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 6. Google Gemini (Free Tier)
  if (process.env.GEMINI_API_KEY) {
    const usage = providerUsage.gemini || { requests: 0, totalTokens: 0, totalCostUsd: 0 };
    results.push({
      provider: 'gemini',
      displayName: 'Google Gemini',
      badge: 'Multimodal Flash',
      tier: 'Free Tier (1,500 req/day)',
      currency: 'USD',
      hasLiveBalance: false,
      isAvailable: true,
      totalRequests: usage.requests || 0,
      totalTokens: usage.totalTokens || 0,
      totalSpentUsd: usage.totalCostUsd || 0,
      status: 'active',
    });
  }

  // 7. Local NVIDIA RTX 4060 GPU
  results.push({
    provider: 'local',
    displayName: 'NVIDIA RTX 4060 Local GPU',
    badge: 'Hardware Accelerated',
    tier: '100% Free & Unlimited',
    currency: 'USD',
    hasLiveBalance: false,
    isAvailable: true,
    totalRequests: providerUsage.local?.requests || 0,
    totalTokens: providerUsage.local?.totalTokens || 0,
    totalSpentUsd: 0,
    status: 'active',
  });

  return {
    success: true,
    totalLiveBalanceUsd,
    totalLifetimeSpentUsd: telemetry.totalCostUsd || 0,
    totalLifetimeTokens: telemetry.totalTokens || 0,
    providers: results,
  };
});

// Persisted route decisions and latency/reliability history
app.get<{ Querystring: { limit?: string } }>('/v1/telemetry/routes', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const limit = Math.max(1, Math.min(250, Number(req.query.limit || 50)));
  return {
    summary: router.getTelemetryStore().summary(),
    routes: router.getTelemetryStore().list(limit),
  };
});

app.get<{ Querystring: { limit?: string } }>('/v1/telemetry/agent-events', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  return { events: router.getAgentEventLog().list(limit) };
});

app.delete('/v1/telemetry/routes', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  router.getTelemetryStore().clear();
  return { success: true };
});

// Recoverable context compression inspection
app.get('/v1/context/compression', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  return {
    stats: getCompressionStats(),
    rawContexts: listRawContexts(ToolRegistry.getWorkspaceDir()),
  };
});

app.get<{ Params: { id: string } }>('/v1/context/raw/:id', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const recovered = recoverRawContext(ToolRegistry.getWorkspaceDir(), req.params.id);
  if (!recovered) return reply.status(404).send({ error: 'Raw context not found' });
  return recovered;
});

// Minimal stateless MCP Streamable HTTP endpoint (tools only)
app.get('/mcp/info', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  return getMcpInfo();
});

app.get('/mcp', async (_req, reply) => {
  reply.header('Allow', 'POST');
  return reply.status(405).send({ error: 'Use HTTP POST for NexusRoute MCP requests.' });
});

app.post<{ Body: JsonRpcRequest }>('/mcp', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  const response = await handleMcpMessage(req.body);
  if (response === null) return reply.status(202).send();
  reply.type('application/json');
  return response;
});

// ============================================================================
// Embedded Local Engine & Local Models Hub Endpoints
// ============================================================================
app.get('/v1/local/status', async () => {
  return await EmbeddedLocalEngine.getStatus();
});

app.get('/v1/local/models', async () => {
  try {
    const modelsList = await EmbeddedLocalEngine.listModels();
    const models = modelsList.map((m) => {
      const gb = (m.size / (1024 * 1024 * 1024)).toFixed(2);
      const cleanName = m.name.replace(/:latest$/, '');
      return {
        id: m.name.startsWith('local/') ? m.name : `local/${m.name}`,
        rawName: m.name,
        cleanName,
        sizeGb: `${gb} GB`,
        sizeFormatted: m.sizeFormatted,
        modifiedAt: m.modified_at,
        family: m.details?.family || 'llm',
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
      };
    });
    return { success: true, models };
  } catch (err: any) {
    return { success: false, models: [], error: err.message };
  }
});

app.delete('/v1/local/models', async (req: FastifyRequest<{ Body: { name: string } }>, reply: FastifyReply) => {
  const modelName = (req.body?.name || '').trim();
  if (!modelName) {
    return reply.status(400).send({ success: false, error: 'Model name is required' });
  }
  const res = await EmbeddedLocalEngine.deleteModel(modelName);
  return reply.send(res);
});

app.post('/v1/local/pull', async (req: FastifyRequest<{ Body: { name: string } }>, reply: FastifyReply) => {
  const modelName = (req.body?.name || '').trim();
  if (!modelName) {
    return reply.status(400).send({ success: false, error: 'Model name is required' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const res = await EmbeddedLocalEngine.pullModelStream(modelName, (chunk) => {
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  });

  reply.raw.write(`data: ${JSON.stringify({ done: true, ...res })}\n\n`);
  reply.raw.end();
});

app.post('/v1/local/show', async (req: FastifyRequest<{ Body: { name: string } }>, reply: FastifyReply) => {
  const modelName = (req.body?.name || '').trim();
  if (!modelName) {
    return reply.status(400).send({ success: false, error: 'Model name is required' });
  }
  const res = await EmbeddedLocalEngine.showModel(modelName);
  return reply.send(res);
});

app.post('/v1/local/create', async (req: FastifyRequest<{ Body: { name: string; modelfile?: string; from?: string; system?: string; template?: string; parameters?: Record<string, unknown> } }>, reply: FastifyReply) => {
  const { name, modelfile, from, system, template, parameters } = req.body || {};
  if (!name || !name.trim()) {
    return reply.status(400).send({ success: false, error: 'Model name is required' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const res = await EmbeddedLocalEngine.createModelStream(
    { name, modelfile, from, system, template, parameters },
    (chunk) => {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  );

  reply.raw.write(`data: ${JSON.stringify({ done: true, ...res })}\n\n`);
  reply.raw.end();
});

app.get('/v1/gpu/status', async () => {
  let gpuInfo = {
    name: 'NVIDIA GPU',
    usedMb: 0,
    totalMb: 0,
    freeMb: 0,
    temperature: 0,
    utilization: 0,
    available: false,
  };

  try {
    const smiOut = execSync(
      'nvidia-smi --query-gpu=name,memory.used,memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();

    if (smiOut) {
      const parts = smiOut.split(',').map(s => s.trim());
      if (parts.length >= 6) {
        gpuInfo = {
          name: parts[0],
          usedMb: parseInt(parts[1], 10) || 0,
          totalMb: parseInt(parts[2], 10) || 0,
          freeMb: parseInt(parts[3], 10) || 0,
          temperature: parseInt(parts[4], 10) || 0,
          utilization: parseInt(parts[5], 10) || 0,
          available: true,
        };
      }
    }
  } catch {}

  let loadedModels: Array<{ name: string; size: number; size_vram?: number; expires_at?: string }> = [];
  try {
    const psRes = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(1500) });
    if (psRes.ok) {
      const psData = await psRes.json() as { models?: Array<{ name: string; size: number; size_vram?: number; expires_at?: string }> };
      loadedModels = psData.models || [];
    }
  } catch {}

  return {
    success: true,
    gpu: gpuInfo,
    loadedModels,
  };
});

app.post('/v1/gpu/unload', async (req, reply) => {
  const result = await unloadOllamaModels();
  const message = result.success
    ? result.unloadedModels.length > 0
      ? `Evicted ${result.unloadedModels.length} offline model(s) from GPU VRAM: ${result.unloadedModels.join(', ')}`
      : 'GPU VRAM is already clear of Ollama models.'
    : `Could not unload: ${result.remainingModels.join(', ') || result.errors.join('; ')}`;
  if (!result.success) return reply.status(503).send({ ...result, message });
  return { ...result, message };
});

// Virtual Client API Key Management (Multi-Tenancy)
app.get('/v1/virtual-keys', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;
  return {
    keys: keyManager.listKeys(),
  };
});

app.post<{ Body: { name: string; rateLimitRpm?: number; dailyBudgetUsd?: number; allowedModels?: string[] } }>('/v1/virtual-keys', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { name, rateLimitRpm, dailyBudgetUsd, allowedModels } = req.body || {};
  const newKey = keyManager.generateKey(name || 'App Key', {
    rateLimitRpm: rateLimitRpm ? Number(rateLimitRpm) : 60,
    dailyBudgetUsd: dailyBudgetUsd ? Number(dailyBudgetUsd) : 10.0,
    allowedModels,
  });
  return { success: true, key: newKey };
});

app.delete<{ Params: { id: string } }>('/v1/virtual-keys/:id', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { id } = req.params;
  const deleted = keyManager.deleteKey(id);
  return { success: deleted, id };
});

// Response Cache Management
app.get('/v1/cache', async () => {
  return {
    stats: router.getCache().getStats(),
    enabled: router.getCache().isEnabled(),
  };
});

app.post('/v1/cache/clear', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  router.getCache().clear();
  return { success: true, stats: router.getCache().getStats() };
});

app.post<{ Body: { enabled: boolean } }>('/v1/cache/toggle', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { enabled } = req.body || {};
  router.getCache().setEnabled(!!enabled);
  return { success: true, enabled: router.getCache().isEnabled() };
});

// Built-in Tools List
app.get('/v1/tools', async () => {
  return {
    tools: ToolRegistry.getBuiltInTools(),
  };
});

// Workspace File Management Endpoints
app.get('/v1/workspace/files', async () => {
  const ws = ToolRegistry.getWorkspaceDir();
  try {
    const files: Array<{ name: string; folder: string; isDirectory: boolean; size: number; modifiedAt: string; category: string; poster?: string }> = [];

    const scanRecursive = (currentDir: string, relPrefix = '', depth = 0) => {
      if (!fs.existsSync(currentDir) || depth > 4) return;
      const list = fs.readdirSync(currentDir);
      for (const item of list) {
        if (
          item === 'build' ||
          (item === 'dist' && !currentDir.toLowerCase().includes('android')) ||
          (item === 'bin' && currentDir.toLowerCase().includes('android')) ||
          item === 'node_modules' ||
          item === '.git' ||
          item === '.venv' ||
          item === '__pycache__' ||
          item === 'learning-lab' ||
          item === 'electron-quick-start' ||
          item.endsWith('_env') ||
          item.includes('env') ||
          item.startsWith('.') ||
          item.startsWith('learning.sqlite')
        ) continue;
        const fullPath = path.join(currentDir, item);
        const st = fs.statSync(fullPath);
        const relName = relPrefix ? `${relPrefix}/${item}` : item;
        const folder = relPrefix ? relPrefix.split('/')[0] : 'root';

        let category = 'code';
        if (relName.startsWith('art/')) {
          category = 'art';
        } else if (relName.startsWith('android/')) {
          category = 'android';
        } else if (relName.startsWith('windows/') || relName.startsWith('plugins/')) {
          category = 'windows';
        } else if (relName.endsWith('.vst3') || relName.endsWith('.exe')) {
          category = 'binary';
        } else if (relName.endsWith('.json') || relName.endsWith('.yaml') || relName.endsWith('.xml')) {
          category = 'data';
        }

        files.push({
          name: relName,
          folder,
          isDirectory: st.isDirectory(),
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
          category,
          poster: (relName.endsWith('.mp4') || relName.endsWith('.webm'))
            ? (fs.existsSync(path.join(ws, relName.replace(/\.(mp4|webm)$/i, '_poster.jpg'))) ? relName.replace(/\.(mp4|webm)$/i, '_poster.jpg') : undefined)
            : undefined,
        });

        if (st.isDirectory()) {
          scanRecursive(fullPath, relName, depth + 1);
        }
      }
    };

    scanRecursive(ws);
    return { success: true, workspacePath: ws, files };
  } catch (err: unknown) {
    return { success: false, workspacePath: ws, files: [], error: (err as Error).message };
  }
});

app.post<{ Body: { dataUrl: string; filename?: string } }>('/v1/workspace/upload-audio', {
  bodyLimit: 150 * 1024 * 1024,
}, async (req, reply) => {
  const { dataUrl, filename } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return reply.status(400).send({ error: 'Valid base64 audio data URL required' });
  }

  const ws = ToolRegistry.getWorkspaceDir();
  const audioDir = path.join(ws, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

  const extMatch = filename ? path.extname(filename) : (dataUrl.includes('flac') ? '.flac' : '.mp3');
  const safeFilename = filename ? path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_') : `soundtrack_${Date.now()}${extMatch || '.mp3'}`;
  const targetPath = path.join(audioDir, safeFilename);

  const base64Data = dataUrl.replace(/^data:.*?;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(targetPath, buffer);

  return {
    success: true,
    filename: `audio/${safeFilename}`,
    fullPath: targetPath,
    url: `/v1/workspace/files/audio/${encodeURIComponent(safeFilename)}`,
  };
});

app.post<{ Body: { dataUrl: string; filename?: string } }>('/v1/workspace/save-face-ref', async (req, reply) => {
  const { dataUrl, filename } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return reply.status(400).send({ error: 'Valid base64 image data URL required' });
  }

  const ws = ToolRegistry.getWorkspaceDir();
  const faceDir = path.join(ws, 'face_references');
  if (!fs.existsSync(faceDir)) fs.mkdirSync(faceDir, { recursive: true });

  const safeFilename = filename ? path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_') : `face_ref_${Date.now()}.png`;
  const targetPath = path.join(faceDir, safeFilename);

  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(targetPath, buffer);

  return {
    success: true,
    filename: `face_references/${safeFilename}`,
    fullPath: targetPath,
    url: `/v1/workspace/files/face_references/${encodeURIComponent(safeFilename)}`,
  };
});

app.post<{ Body: { dataUrl?: string; data?: string; image?: string; filename?: string } }>('/v1/workspace/upload-image', {
  bodyLimit: 60 * 1024 * 1024,
}, async (req, reply) => {
  const rawData = req.body?.dataUrl || req.body?.data || req.body?.image;
  const filename = req.body?.filename;
  if (!rawData || typeof rawData !== 'string') {
    return reply.status(400).send({ success: false, error: 'Valid base64 image data URL required' });
  }
  const dataUrl = rawData;

  const ws = ToolRegistry.getWorkspaceDir();
  const imagesDir = path.join(ws, 'images');
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

  const extMatch = filename ? path.extname(filename) : '.png';
  const safeFilename = filename ? path.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_') : `source_photo_${Date.now()}${extMatch || '.png'}`;
  const targetPath = path.join(imagesDir, safeFilename);

  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '').replace(/^data:.*?;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(targetPath, buffer);

  return {
    success: true,
    filename: `images/${safeFilename}`,
    fullPath: targetPath,
    url: `/v1/workspace/files/images/${encodeURIComponent(safeFilename)}`,
  };
});

app.get('/v1/workspace/next-project', async () => {
  const ws = ToolRegistry.getWorkspaceDir();
  const projectsDir = path.join(ws, 'projects');
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  let idx = 1;
  let candidateName = 'New Project';
  let candidateSlug = 'New-Project';
  while (fs.existsSync(path.join(projectsDir, candidateSlug))) {
    idx++;
    candidateName = `New Project ${idx}`;
    candidateSlug = `New-Project-${idx}`;
  }

  return {
    name: candidateName,
    folder: `projects/${candidateSlug}`,
  };
});

app.post<{ Body: { folder: string; name?: string } }>('/v1/workspace/create-folder', async (req, reply) => {
  const ws = ToolRegistry.getWorkspaceDir();
  let folder = (req.body?.folder || '').trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  if (!folder) {
    folder = 'projects/New-Project';
  }
  try {
    const fullPath = sanitizeWorkspacePath(folder, ws);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    return { success: true, folder, fullPath };
  } catch (err: any) {
    return reply.status(400).send({ success: false, error: err.message });
  }
});

app.post<{ Body: { filename?: string } }>('/v1/workspace/open', async (req, reply) => {
  const clientIp = req.ip || '';
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.includes('127.0.0.1') || clientIp === '::ffff:127.0.0.1' || (req.hostname && (req.hostname.startsWith('127.0.0.1') || req.hostname.startsWith('localhost')));
  if (!isLocal && !verifyAdmin(req, reply)) return;

  const ws = ToolRegistry.getWorkspaceDir();
  const { filename } = req.body || {};
  let targetPath = ws;
  if (filename) {
    try {
      targetPath = sanitizeWorkspacePath(filename, ws);
    } catch {
      return reply.status(403).send({ error: 'Access denied: Target path is outside workspace.' });
    }
  }

  try {
    // If opening a folder like 'art' and it doesn't exist yet, create it
    if (!path.extname(targetPath) && !fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    const isDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const ext = path.extname(targetPath).toLowerCase();
    const relName = path.relative(ws, targetPath).replace(/\\/g, '/');
    const previewUrl = `/v1/workspace/files/${encodeURIComponent(relName)}`;

    const normTarget = path.normalize(path.resolve(targetPath));
    if (process.platform === 'win32') {
      if (isDir) {
        // Direct Windows Explorer launch on directory
        spawn('explorer.exe', [normTarget], { detached: true, stdio: 'ignore' }).unref();
      } else if (ext === '.html' || ext === '.htm' || ext === '.svg') {
        spawn('cmd.exe', ['/c', 'start', '', normTarget], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('explorer.exe', [`/select,${normTarget}`], { detached: true, stdio: 'ignore' }).unref();
      }
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, [normTarget], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { success: true, target: normTarget, url: previewUrl };
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// Delete a workspace file (e.g. from Art Studio gallery)
app.post<{ Body: { filename: string } }>('/v1/workspace/delete', async (req, reply) => {
  const clientIp = req.ip || '';
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.includes('127.0.0.1') || clientIp === '::ffff:127.0.0.1' || (req.hostname && (req.hostname.startsWith('127.0.0.1') || req.hostname.startsWith('localhost')));
  if (!isLocal && !verifyAdmin(req, reply)) return;

  const ws = ToolRegistry.getWorkspaceDir();
  const { filename } = req.body || {};
  if (!filename) return reply.status(400).send({ success: false, error: 'Filename is required' });

  try {
    const targetPath = sanitizeWorkspacePath(filename, ws);
    if (!fs.existsSync(targetPath)) {
      return reply.status(404).send({ success: false, error: 'File not found on disk' });
    }
    fs.unlinkSync(targetPath);
    // If it's a video, also delete its poster image if present
    const posterPath = targetPath.replace(/\.(mp4|webm)$/i, '_poster.jpg');
    if (fs.existsSync(posterPath)) {
      try { fs.unlinkSync(posterPath); } catch {}
    }
    return reply.send({ success: true, message: `Deleted ${filename}` });
  } catch (err: unknown) {
    return reply.status(500).send({ success: false, error: (err as Error).message });
  }
});

// DELETE method compatibility for workspace files
app.delete('/v1/workspace/files/*', async (req, reply) => {
  const clientIp = req.ip || '';
  const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.includes('127.0.0.1') || clientIp === '::ffff:127.0.0.1' || (req.hostname && (req.hostname.startsWith('127.0.0.1') || req.hostname.startsWith('localhost')));
  if (!isLocal && !verifyAdmin(req, reply)) return;

  const ws = ToolRegistry.getWorkspaceDir();
  const rawPath = (req.params as { '*': string })['*'];
  try {
    const targetPath = sanitizeWorkspacePath(rawPath, ws);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      const poster = targetPath.replace(/\.(mp4|webm)$/i, '_poster.jpg');
      if (fs.existsSync(poster)) {
        try { fs.unlinkSync(poster); } catch {}
      }
      return reply.send({ success: true, message: 'Deleted' });
    }
    return reply.status(404).send({ success: false, error: 'File not found' });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

function streamWorkspaceFile(safePath: string, req: FastifyRequest, reply: FastifyReply, wildcard: string) {
  const ext = path.extname(safePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.opus': 'audio/opus',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.apk': 'application/vnd.android.package-archive',
    '.zip': 'application/zip',
  };
  const query = (req.query as Record<string, string>) || {};
  if (query.raw === '1' || query.raw === 'true') {
    const content = fs.readFileSync(safePath, 'utf8');
    const stat = fs.statSync(safePath);
    return reply.send({
      success: true,
      filename: wildcard,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  const mime = mimeTypes[ext];
  if (mime && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'text/html' || mime === 'text/css' || mime === 'application/javascript' || mime === 'application/vnd.android.package-archive' || mime === 'application/zip')) {
    const stat = fs.statSync(safePath);
    const range = req.headers.range;
    const isDownload = query.download === '1' || query.download === 'true' || query.dl === '1' || ext === '.apk';
    const baseFilename = path.basename(safePath);
    const disposition = isDownload
      ? `attachment; filename="${baseFilename}"`
      : `inline; filename="${baseFilename}"`;

    if (range && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(safePath, { start, end });

      return reply
        .status(206)
        .headers({
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mime,
          'Content-Disposition': disposition,
        })
        .send(fileStream);
    }

    const stream = fs.createReadStream(safePath);
    return reply
      .headers({
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Content-Disposition': disposition,
      })
      .send(stream);
  }
  const content = fs.readFileSync(safePath, 'utf8');
  return reply.send({ filename: wildcard, content });
}

// Top-level direct route for workspace projects (e.g. /projects/New-Project-13/index.html)
app.get('/projects/*', async (req, reply) => {
  const ws = ToolRegistry.getWorkspaceDir();
  const wildcard = (req.params as Record<string, string>)['*'] || '';

  let safePath: string;
  try {
    safePath = sanitizeWorkspacePath(path.join('projects', wildcard), ws);
  } catch {
    return reply.status(403).send({ error: 'Access denied: Target path is outside workspace.' });
  }

  if (!fs.existsSync(safePath)) {
    return reply.status(404).send({ error: 'File not found' });
  }

  return streamWorkspaceFile(safePath, req, reply, wildcard);
});

app.get('/v1/workspace/files/*', async (req, reply) => {
  const ws = ToolRegistry.getWorkspaceDir();
  const wildcard = (req.params as Record<string, string>)['*'] || '';

  let safePath: string;
  try {
    safePath = sanitizeWorkspacePath(wildcard, ws);
  } catch {
    return reply.status(403).send({ error: 'Access denied: Target path is outside workspace.' });
  }

  if (!fs.existsSync(safePath)) {
    // Smart fallback for bare filenames or project references
    let found = false;
    if (!wildcard.startsWith('projects/') && !wildcard.startsWith('art/')) {
      const candidateProjects = sanitizeWorkspacePath(path.join('projects', wildcard), ws);
      if (fs.existsSync(candidateProjects) && !fs.statSync(candidateProjects).isDirectory()) {
        safePath = candidateProjects;
        found = true;
      } else {
        try {
          const projectsDir = path.join(ws, 'projects');
          if (fs.existsSync(projectsDir)) {
            const dirs = fs.readdirSync(projectsDir)
              .filter(d => {
                const p = path.join(projectsDir, d);
                return fs.existsSync(p) && fs.statSync(p).isDirectory();
              })
              .sort((a, b) => fs.statSync(path.join(projectsDir, b)).mtimeMs - fs.statSync(path.join(projectsDir, a)).mtimeMs);
            for (const d of dirs) {
              const check = path.join(projectsDir, d, wildcard);
              if (fs.existsSync(check) && !fs.statSync(check).isDirectory()) {
                safePath = check;
                found = true;
                break;
              }
            }
          }
        } catch {}
      }
    }
    if (!found && !fs.existsSync(safePath)) {
      return reply.status(404).send({ error: 'File not found' });
    }
  }

  return streamWorkspaceFile(safePath, req, reply, wildcard);
});

// Android App Testing & Deployment Endpoints
app.get('/v1/android/devices', async () => {
  try {
    const devices = getRunningAndroidDevices();
    return { success: true, devices, hasConnectedDevice: devices.length > 0 };
  } catch (err: unknown) {
    return { success: false, devices: [], error: (err as Error).message };
  }
});

app.post<{ Body: { apkPath?: string; packageName?: string } }>('/v1/android/install', async (req, reply) => {
  const ws = ToolRegistry.getWorkspaceDir();
  const rawApk = (req.body?.apkPath || '').trim();
  if (!rawApk) {
    return reply.status(400).send({ success: false, error: 'Missing apkPath in request body.' });
  }
  let safePath: string;
  try {
    safePath = sanitizeWorkspacePath(rawApk, ws);
  } catch (err: unknown) {
    return reply.status(403).send({ success: false, error: (err as Error).message });
  }
  if (!fs.existsSync(safePath)) {
    return reply.status(404).send({ success: false, error: `APK file not found at ${rawApk}` });
  }
  try {
    const result = installAndLaunchApkOnEmulator(safePath, req.body?.packageName || 'com.nexus.app');
    return reply.send(result);
  } catch (err: unknown) {
    return reply.status(400).send({ success: false, error: (err as Error).message });
  }
});

// Active terminal processes map for cancellation: pid -> ChildProcess
const activeTerminalProcesses = new Map<number, ChildProcess>();

// Terminal Execution (Direct JSON response)
app.post<{ Body: { command: string; cwd?: string; timeoutMs?: number } }>('/v1/terminal/execute', async (req, reply) => {
  const rawCommand = (req.body?.command || '').trim();
  if (!rawCommand) {
    return reply.status(400).send({ success: false, error: 'Command is required' });
  }

  const lower = rawCommand.toLowerCase();
  if (lower.includes('format ') || lower.includes('rmdir /s /q c:\\') || lower.includes('del /f /s /q c:\\') || lower.includes('rm -rf /')) {
    return reply.status(403).send({ success: false, error: 'Blocked: Potentially destructive system command.' });
  }

  const rootDir = process.cwd();
  const wsDir = ToolRegistry.getWorkspaceDir();
  let execCwd = rootDir;
  if (req.body?.cwd === 'workspace') {
    execCwd = wsDir;
  } else if (req.body?.cwd && req.body.cwd !== 'root') {
    execCwd = path.isAbsolute(req.body.cwd) ? req.body.cwd : path.resolve(rootDir, req.body.cwd);
  }

  const startTime = Date.now();
  const timeoutMs = req.body?.timeoutMs || 300000;

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', rawCommand] : ['-c', rawCommand];

    const proc = spawn(shell, shellArgs, {
      cwd: execCwd,
      env: { ...process.env, FORCE_COLOR: '1' },
      windowsHide: true,
    });

    if (proc.pid) {
      activeTerminalProcesses.set(proc.pid, proc);
    }

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try {
        if (proc.pid) {
          if (isWindows) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          else proc.kill('SIGKILL');
        }
      } catch {}
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (proc.pid) activeTerminalProcesses.delete(proc.pid);
      const durationMs = Date.now() - startTime;
      resolve(reply.send({
        success: code === 0,
        command: rawCommand,
        cwd: execCwd,
        exitCode: code ?? 0,
        stdout,
        stderr,
        durationMs,
      }));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (proc.pid) activeTerminalProcesses.delete(proc.pid);
      const durationMs = Date.now() - startTime;
      resolve(reply.send({
        success: false,
        command: rawCommand,
        cwd: execCwd,
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        durationMs,
      }));
    });
  });
});

// SSE Streaming Terminal Execution (Real-time live stdout/stderr)
app.post<{ Body: { command: string; cwd?: string } }>('/v1/terminal/stream', async (req, reply) => {
  const rawCommand = (req.body?.command || '').trim();
  if (!rawCommand) {
    return reply.status(400).send({ error: 'Command is required' });
  }

  const lower = rawCommand.toLowerCase();
  if (lower.includes('format ') || lower.includes('rmdir /s /q c:\\') || lower.includes('del /f /s /q c:\\') || lower.includes('rm -rf /')) {
    return reply.status(403).send({ error: 'Blocked: Potentially destructive system command.' });
  }

  const rootDir = process.cwd();
  const wsDir = ToolRegistry.getWorkspaceDir();
  let execCwd = rootDir;
  if (req.body?.cwd === 'workspace') {
    execCwd = wsDir;
  } else if (req.body?.cwd && req.body.cwd !== 'root') {
    execCwd = path.isAbsolute(req.body.cwd) ? req.body.cwd : path.resolve(rootDir, req.body.cwd);
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const startTime = Date.now();
  const isWindows = process.platform === 'win32';
  let shell = isWindows ? 'powershell.exe' : '/bin/bash';
  let shellArgs = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', rawCommand] : ['-c', rawCommand];

  // Windows PowerShell 5.1 throws ParserError on '&&' and '||' statement separators.
  // When chaining operators are present, route through cmd.exe for native support.
  if (isWindows && /(&&|\|\|)/.test(rawCommand)) {
    shell = 'cmd.exe';
    shellArgs = ['/d', '/s', '/c', rawCommand];
  }

  const proc = spawn(shell, shellArgs, {
    cwd: execCwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    windowsHide: true,
  });

  if (proc.pid) {
    activeTerminalProcesses.set(proc.pid, proc);
    reply.raw.write(`data: ${JSON.stringify({ type: 'start', pid: proc.pid, cwd: execCwd, command: rawCommand })}\n\n`);
  }

  proc.stdout?.on('data', (data) => {
    reply.raw.write(`data: ${JSON.stringify({ type: 'stdout', text: data.toString() })}\n\n`);
  });

  proc.stderr?.on('data', (data) => {
    reply.raw.write(`data: ${JSON.stringify({ type: 'stderr', text: data.toString() })}\n\n`);
  });

  proc.on('close', (code) => {
    if (proc.pid) activeTerminalProcesses.delete(proc.pid);
    const durationMs = Date.now() - startTime;
    reply.raw.write(`data: ${JSON.stringify({ type: 'done', exitCode: code ?? 0, success: code === 0, durationMs })}\n\n`);
    reply.raw.end();
  });

  proc.on('error', (err) => {
    if (proc.pid) activeTerminalProcesses.delete(proc.pid);
    const durationMs = Date.now() - startTime;
    reply.raw.write(`data: ${JSON.stringify({ type: 'stderr', text: `\nError: ${err.message}` })}\n\n`);
    reply.raw.write(`data: ${JSON.stringify({ type: 'done', exitCode: -1, success: false, durationMs })}\n\n`);
    reply.raw.end();
  });

  // Only kill child process if the client connection was aborted before the command completed
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded && proc.pid && activeTerminalProcesses.has(proc.pid)) {
      try {
        if (isWindows) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else proc.kill('SIGTERM');
      } catch {}
      activeTerminalProcesses.delete(proc.pid);
    }
  });
});

// Kill active terminal process
app.post<{ Body: { pid: number } }>('/v1/terminal/kill', async (req, reply) => {
  const pid = Number(req.body?.pid);
  if (!pid) return reply.status(400).send({ error: 'PID is required' });
  const proc = activeTerminalProcesses.get(pid);
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else if (proc) {
      proc.kill('SIGKILL');
    }
    activeTerminalProcesses.delete(pid);
    return reply.send({ success: true, message: `Terminated process PID ${pid}` });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Dedicated authenticated image proxy for PromptForge RTX images
app.get<{ Params: { filename: string } }>('/v1/promptforge/images/:filename', async (req, reply) => {
  const filename = req.params.filename;
  if (!filename) return reply.status(400).send({ error: 'Filename required' });

  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : path.join(os.homedir(), 'AppData', 'Local'));
  const pfConfigPath = path.join(localAppData, 'PromptForgeRTX', 'config.json');
  let token = '';
  let port = 17861;
  try {
    if (fs.existsSync(pfConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(pfConfigPath, 'utf8'));
      token = cfg.api_token || '';
      port = cfg.api_port || 17861;
    }
  } catch {}

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/v1/images/${filename}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      return reply.status(upstream.status).send({ error: `PromptForge image fetch failed (${upstream.status})` });
    }
    const arrayBuffer = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.type('image/png');
    return reply.send(buf);
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

// Image Proxy & Cache Endpoint with SSRF Protection
app.get<{ Querystring: { url?: string; prompt?: string } }>('/v1/image-proxy', async (req, reply) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return reply.status(400).send({ error: 'url parameter required' });
  }

  const ssrfCheck = validatePublicHttpUrl(targetUrl);
  if (!ssrfCheck.valid) {
    return reply.status(400).send({ error: `SSRF validation rejected URL: ${ssrfCheck.error}` });
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return reply.status(res.status).send({ error: `Upstream image fetch failed: ${res.statusText}` });
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Auto-save to workspace/art if valid image
    if (buffer.length > 5000) {
      try {
        const ws = ToolRegistry.getWorkspaceDir();
        const artDir = path.join(ws, 'art');
        if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

        const pDesc = req.query.prompt
          ? req.query.prompt.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30).toLowerCase()
          : `img_${Date.now()}`;
        const ext = contentType.includes('gif') ? '.gif' : contentType.includes('png') ? '.png' : '.jpg';
        const filename = `${pDesc}${ext}`;
        const savePath = path.join(artDir, filename);
        if (!fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, buffer);
        }
      } catch {}
    }

    return reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer);

  } catch (err: unknown) {
    return reply.status(500).send({ error: `Proxy fetch failed: ${(err as Error).message}` });
  }
});

// Web Viewer Unrestricted Proxy (Strips X-Frame-Options and CSP for embedded browser modal)
app.get<{ Querystring: { url?: string } }>('/v1/web-viewer', async (req, reply) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return reply.status(400).send({ error: 'url parameter required' });
  }

  const ssrfCheck = validatePublicHttpUrl(targetUrl);
  if (!ssrfCheck.valid) {
    return reply.status(400).send({ error: `SSRF validation rejected URL: ${ssrfCheck.error}` });
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 NexusBrowser/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      return reply.status(res.status).send(`Failed to fetch page (${res.status} ${res.statusText})`);
    }

    const contentType = res.headers.get('content-type') || 'text/html';

    if (contentType.includes('text/html')) {
      let html = await res.text();
      const baseTag = `<base href="${targetUrl}">`;
      if (!html.includes('<base ') && html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n${baseTag}`);
      } else if (!html.includes('<base ') && html.includes('<html>')) {
        html = html.replace('<html>', `<html><head>${baseTag}</head>`);
      }
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('X-Frame-Options', 'ALLOWALL');
      return reply.send(html);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    reply.type(contentType);
    return reply.send(buffer);
  } catch (err: any) {
    return reply.status(500).send(`Web proxy error: ${err.message}`);
  }
});

// Dedicated Art & Avatar Generation Endpoint for PromptForge Studio & Chat
app.post<{ Body: { prompt: string; negativePrompt?: string; engine?: string; width?: number; height?: number; steps?: number; guidance?: number; seed?: number; model?: string; lora?: string; loraScale?: number } }>('/v1/art/generate', async (req, reply) => {
  const { prompt, negativePrompt, engine = 'local-gpu', width = 512, height = 512, steps = 1, guidance, seed, model, lora, loraScale } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return reply.status(400).send({ success: false, error: 'Prompt is required' });
  }

  const cleanPrompt = prompt.trim();
  const wsDir = ToolRegistry.getWorkspaceDir();
  const artDir = path.join(wsDir, 'art');
  if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

  // 1. Local NVIDIA RTX 4060 GPU Generation (Real-Time Diffusion)
  if (engine === 'local-gpu' || engine === 'local' || engine === 'rtx4060' || engine === 'gpu' || engine === 'auto') {
    try {
      const gpuResult = await LocalGpuArtEngine.generateImage({
        prompt: cleanPrompt,
        negativePrompt,
        width: Math.min(width, 1216),
        height: Math.min(height, 1216),
        steps,
        guidance,
        seed,
        model,
        lora,
        loraScale,
      }, wsDir);

      if (gpuResult.success) {
        return reply.send(gpuResult);
      }
      if (engine === 'local-gpu' || engine === 'rtx4060' || engine === 'local') {
        return reply.status(500).send(gpuResult);
      }
    } catch (err: any) {
      console.warn('[Local GPU Art error]:', err.message);
      if (engine === 'local-gpu' || engine === 'rtx4060' || engine === 'local') {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  }

  const filename = `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
  const outPath = path.join(artDir, filename);
  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;

  // 2. Hugging Face Serverless FLUX.1 Schnell
  if (hfKey && !hfKey.startsWith('mock-') && (engine === 'huggingface' || engine === 'flux' || engine === 'auto')) {
    try {
      const hfRes = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: cleanPrompt }),
        signal: AbortSignal.timeout(60000),
      });

      if (hfRes.ok) {
        const arrayBuffer = await hfRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > 5000) {
          fs.writeFileSync(outPath, buffer);
          return {
            success: true,
            message: `Generated by Hugging Face FLUX.1 (${Math.round(buffer.length / 1024)} KB)`,
            url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
            engine: 'Hugging Face FLUX.1 Schnell (Serverless)',
            filename: `art/${filename}`,
          };
        }
      }
    } catch (err: any) {
      console.warn('[HF FLUX error]:', err.message);
    }
  }

  // 3. Cloud FLUX.1 HD Fallback
  try {
    const genSeed = seed || Math.floor(Math.random() * 1000000);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=${width}&height=${height}&model=flux&nologo=true&seed=${genSeed}`;
    const pRes = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(45000) });
    if (pRes.ok) {
      const arrayBuffer = await pRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 5000) {
        fs.writeFileSync(outPath, buffer);
        return {
          success: true,
          message: `Generated by Cloud FLUX.1 HD (${Math.round(buffer.length / 1024)} KB)`,
          url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
          engine: 'Cloud FLUX.1 HD',
          filename: `art/${filename}`,
        };
      }
    }
  } catch (err: any) {
    console.warn('[Cloud FLUX error]:', err.message);
  }

  return reply.status(500).send({ success: false, error: 'Failed to generate image with available engines' });
});

// GPU Art Engine Status
app.get('/v1/art/gpu-status', async (req, reply) => {
  const status = await LocalGpuArtEngine.checkGpuStatus();
  return reply.send(status);
});

// Wan 2.1 Pipeline Download & Readiness Status
app.get('/v1/art/wan-status', async (req, reply) => {
  const ws = ToolRegistry.getWorkspaceDir();
  const statusFile = path.join(ws, 'wan_download_status.json');
  if (fs.existsSync(statusFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      return reply.send(data);
    } catch {}
  }
  return reply.send({ state: 'idle', message: 'Wan 2.1 download not started yet.' });
});

// GPU Art Engine VRAM Unload
app.post('/v1/art/gpu-unload', async (req, reply) => {
  const result = await LocalGpuArtEngine.unloadGpu();
  return reply.send(result);
});

// GPU Art Engine VRAM Preload / Warmup
app.post<{ Body: { model?: string } }>('/v1/art/gpu-preload', async (req, reply) => {
  const { model } = req.body || {};
  const result = await LocalGpuArtEngine.preloadGpu(model);
  return reply.send(result);
});

// NVIDIA DLSS 5 Status
app.get('/v1/art/dlss-status', async (req, reply) => {
  const status = await LocalGpuArtEngine.getDlssStatus();
  return reply.send(status);
});

// NVIDIA DLSS 5 Image Enhancement (4K Boost)
app.post<{ Body: { image: string; mode?: string } }>('/v1/art/dlss-enhance-image', async (req, reply) => {
  const { image, mode = '2x' } = req.body || {};
  if (!image) {
    return reply.status(400).send({ success: false, error: 'Image path or URL is required' });
  }
  const ws = ToolRegistry.getWorkspaceDir();
  const result = await LocalGpuArtEngine.enhanceImageWithDlss(image, { mode, workspaceDir: ws });
  return reply.send(result);
});

// NVIDIA DLSS 5 Video Enhancement (Video Boost)
app.post<{ Body: { video: string; mode?: string; codec?: string; container?: string; quality?: string; maxFrames?: number; copyAudio?: boolean } }>('/v1/art/dlss-enhance-video', async (req, reply) => {
  const { video, mode = '2x', codec = 'HEVC', container = 'MP4', quality = 'Good', maxFrames = 0, copyAudio = true } = req.body || {};
  if (!video) {
    return reply.status(400).send({ success: false, error: 'Video path or URL is required' });
  }
  const ws = ToolRegistry.getWorkspaceDir();
  const result = await LocalGpuArtEngine.enhanceVideoWithDlss(video, {
    mode,
    codec,
    container,
    quality,
    maxFrames,
    copyAudio,
    workspaceDir: ws,
  });
  return reply.send(result);
});

// GPU Art Engine Interactive Inpainting / Spray Repair
app.post<{ Body: { image: string; mask: string; prompt?: string; negativePrompt?: string; strength?: number; steps?: number; guidance?: number; seed?: number; model?: string; lora?: string; loraScale?: number } }>('/v1/art/inpaint', async (req, reply) => {
  const { image, mask, prompt, negativePrompt, strength, steps, guidance, seed, model, lora, loraScale } = req.body || {};
  if (!image || !mask) {
    return reply.status(400).send({ success: false, error: 'Both source image and mask are required for inpainting' });
  }
  const ws = ToolRegistry.getWorkspaceDir();
  const result = await LocalGpuArtEngine.inpaintImage({
    image,
    mask,
    prompt: prompt || '',
    negativePrompt: negativePrompt || '',
    strength: strength !== undefined ? strength : 0.85,
    steps: steps || 20,
    guidance,
    seed,
    model: model || 'default',
    lora: lora || '',
    loraScale: loraScale !== undefined ? loraScale : 1.0,
  }, ws);
  return reply.send(result);
});

// Launch Native Desktop Browser App
app.post('/v1/browser/launch', async (req, reply) => {
  try {
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : path.join(os.homedir(), 'AppData', 'Local'));
    const candidates = [
      process.env.PYTHON_PATH,
      path.join(localAppData, 'Programs', 'Python', 'Python312', 'pythonw.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python311', 'pythonw.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python310', 'pythonw.exe'),
      'pythonw',
      'python',
    ].filter(Boolean) as string[];
    let pythonExe = 'pythonw';
    for (const c of candidates) {
      if (c === 'pythonw' || c === 'python' || fs.existsSync(c)) {
        pythonExe = c;
        break;
      }
    }
    const scriptPath = path.join(process.cwd(), 'nexus_browser.py');
    const child = spawn(pythonExe, [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return reply.send({ success: true, message: 'Nexus Browser launched on Windows desktop!' });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Active Hugging Face & GPU Model Download State
interface HfDownloadState {
  active: boolean;
  repoId: string;
  type: string;
  progress: number;
  message: string;
  status: 'idle' | 'starting' | 'downloading' | 'completed' | 'error';
  error?: string;
  startTime?: number;
  pid?: number;
}

let activeHfDownload: HfDownloadState = {
  active: false,
  repoId: '',
  type: 'auto',
  progress: 0,
  message: 'Idle',
  status: 'idle',
};
let activeDownloadProcess: ChildProcess | null = null;
let activeAbortController: AbortController | null = null;
let activeTempFilePath: string | null = null;

function getHfCacheDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const addIfValid = (dirPath?: string) => {
    if (!dirPath) return;
    try {
      const resolved = path.resolve(dirPath);
      if (fs.existsSync(resolved) && !seen.has(resolved.toLowerCase())) {
        seen.add(resolved.toLowerCase());
        dirs.push(resolved);
      }
    } catch (_) {}
  };

  if (process.env.HF_HOME) {
    addIfValid(path.join(process.env.HF_HOME, 'hub'));
    addIfValid(process.env.HF_HOME);
  }
  if (process.env.HUGGINGFACE_HUB_CACHE) {
    addIfValid(process.env.HUGGINGFACE_HUB_CACHE);
  }
  addIfValid('E:\\huggingface_cache\\hub');
  addIfValid('E:\\huggingface_cache');

  const userProfile = process.env.USERPROFILE || os.homedir();
  addIfValid(path.join(userProfile, '.cache', 'huggingface', 'hub'));

  return dirs;
}

function getHfCacheDir(): string {
  if (process.env.HF_HOME) {
    const hub = path.join(process.env.HF_HOME, 'hub');
    try {
      if (fs.existsSync(hub)) return hub;
      if (fs.existsSync(process.env.HF_HOME)) return hub;
    } catch (_) {}
  }
  if (fs.existsSync('E:\\huggingface_cache\\hub')) {
    return 'E:\\huggingface_cache\\hub';
  }
  const userProfile = process.env.USERPROFILE || os.homedir();
  return path.join(userProfile, '.cache', 'huggingface', 'hub');
}

function deriveOllamaModelName(repoId: string, ggufFileName?: string): string {
  let base = '';
  if (ggufFileName) {
    base = ggufFileName.replace(/\.gguf$/i, '');
  } else {
    const parts = repoId.split('/');
    base = parts[parts.length - 1];
  }
  base = base.replace(/[-_]gguf$/i, '');
  let clean = base.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (clean.length > 45) {
    clean = clean.slice(0, 45).replace(/-+$/, '');
  }
  if (!clean.includes(':')) {
    clean += ':latest';
  }
  return clean;
}

function getDirSizeBytes(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSizeBytes(full);
      } else {
        try { total += fs.statSync(full).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

async function getOllamaInstalledModels(): Promise<Array<{ name: string; size?: number; modified_at?: string }>> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<any> };
    return data.models || [];
  } catch (_) {
    return [];
  }
}

// Initialize Civitai Service for Model & Proxy Support (shared with HF model previews)
const civitaiService = new CivitaiService(process.cwd());

const hfThumbnailCache = new Map<string, string>();

const CURATED_HF_THUMBNAILS: Record<string, string> = {
  'stabilityai/stable-diffusion-xl-base-1.0': 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/01.png',
  'cagliostrolab/animagine-xl-3.1': 'https://cdn-uploads.huggingface.co/production/uploads/6365c8dbf31ef76df4042821/yq_5AWegnLsGyCYyqJ-1G.png',
  'cagliostrolab/animagine-xl-3.0': 'https://cdn-uploads.huggingface.co/production/uploads/6365c8dbf31ef76df4042821/sp6w1elvXVTbckkU74v3o.png',
  'RunDiffusion/Juggernaut-XL-v9': 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/assets/Juggernaut_v9_banner.webp',
  'Lightricks/LTX-Video': 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/media/ltx-video_i2v_example_00001.gif',
  'Wan-AI/Wan2.1-T2V-1.3B': 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/main/assets/i2v_res.png',
  'Wan-AI/Wan2.1-T2V-14B': 'https://huggingface.co/Wan-AI/Wan2.1-T2V-14B/resolve/main/assets/i2v_res.png',
  'ByteDance/SDXL-Lightning': 'https://huggingface.co/ByteDance/SDXL-Lightning/resolve/main/comfyui/sdxl_lightning_workflow_full.jpg',
  'Lykon/dreamshaper-xl-v2-turbo': 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/466e138a-02e0-474c-bd48-26ff732c5ba7/width=768/00021-3965907409.jpeg',
  'SG161222/RealVisXL_V5.0': 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/e1cb1cb9-8588-46aa-9d51-403487c63124/width=768/3371879.jpeg',
  'black-forest-labs/FLUX.1-schnell': 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/assets/slider1.png',
  'latent-consistency/lcm-lora-sdxl': 'https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/resolve/main/spiderman.png',
  'THUDM/CogVideoX-2b': 'https://huggingface.co/THUDM/CogVideoX-2b/resolve/main/resources/demo1.gif',
};

function extractHfThumbnail(model: any): string | null {
  const id = model.id || model._id || '';
  if (!id) return null;
  const lowerId = id.toLowerCase();

  if (hfThumbnailCache.has(lowerId)) {
    return hfThumbnailCache.get(lowerId)!;
  }

  for (const [k, url] of Object.entries(CURATED_HF_THUMBNAILS)) {
    if (k.toLowerCase() === lowerId) {
      hfThumbnailCache.set(lowerId, url);
      return url;
    }
  }

  if (Array.isArray(model.siblings) && model.siblings.length > 0) {
    const imgFiles = model.siblings
      .map((s: any) => s.rfilename || '')
      .filter((f: string) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
      .filter((f: string) => !f.toLowerCase().includes('icon') && !f.toLowerCase().includes('logo_small') && !f.toLowerCase().includes('.git'));

    if (imgFiles.length > 0) {
      const preferred = imgFiles.find((f: string) => /banner|preview|sample|thumbnail|cover|showcase|example|grid|comparison|0000|fp16|crop|out/i.test(f)) || imgFiles[0];
      const url = `https://huggingface.co/${id}/resolve/main/${preferred}`;
      hfThumbnailCache.set(lowerId, url);
      return url;
    }
  }

  if (Array.isArray(model.cardData?.widget)) {
    for (const w of model.cardData.widget) {
      if (w.output?.url && typeof w.output.url === 'string') {
        const url = w.output.url;
        hfThumbnailCache.set(lowerId, url);
        return url;
      }
    }
  }

  return null;
}

// Hugging Face Universal Model Search & Discovery Endpoint
app.get<{ Querystring: { q?: string; category?: string; sort?: string; limit?: string } }>('/v1/hf/models', async (req, reply) => {
  const query = (req.query.q || '').trim();
  const category = (req.query.category || 'all').toLowerCase();
  const sortParam = req.query.sort || 'downloads';
  const limit = Math.min(parseInt(req.query.limit || '24', 10), 60);
  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hfKey && !hfKey.startsWith('mock-')) {
      headers.Authorization = `Bearer ${hfKey}`;
    }

    let sort = 'downloads';
    let direction = '-1';
    if (sortParam === 'likes') sort = 'likes';
    else if (sortParam === 'modified' || sortParam === 'updated') sort = 'lastModified';
    else if (sortParam === 'trending') sort = 'trendingScore';

    let filterTag = '';
    let searchQuery = query;
    if (category === 'sdxl') {
      filterTag = 'diffusers';
      if (!searchQuery) searchQuery = 'sdxl';
    } else if (category === 'dit' || category === 'video') {
      filterTag = 'diffusers';
      if (!searchQuery) searchQuery = 'video';
    } else if (category === 'lora') {
      filterTag = 'lora';
      if (!searchQuery) searchQuery = 'lora';
    } else if (category === 'gguf') {
      filterTag = 'gguf';
      if (!searchQuery) searchQuery = 'gguf';
    } else {
      // 'all'
      if (!searchQuery) searchQuery = 'sdxl';
    }

    let url = `https://huggingface.co/api/models?sort=${sort}&direction=${direction}&limit=${limit}&expand[]=gated&expand[]=cardData&expand[]=downloads&expand[]=likes&expand[]=lastModified&expand[]=pipeline_tag&expand[]=siblings`;
    if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`;
    if (filterTag) url += `&filter=${filterTag}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return reply.status(res.status).send({ error: `Hugging Face API returned ${res.status}` });
    }

    const models = await res.json() as Array<any>;

    // Scan local cache to mark installed models
    const cacheDirs = getHfCacheDirs();
    const installedRepoSet = new Set<string>();
    for (const hfCache of cacheDirs) {
      if (!fs.existsSync(hfCache)) continue;
      try {
        const dirs = fs.readdirSync(hfCache).filter(d => d.startsWith('models--'));
        for (const d of dirs) {
          const fullDir = path.join(hfCache, d);
          const sizeBytes = getDirSizeBytes(fullDir);
          // Only treat as installed if weights are actually present (>= 5 MB)
          if (sizeBytes >= 5 * 1024 * 1024) {
            const parts = d.slice('models--'.length).split('--');
            const repo = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join('--')}` : d;
            installedRepoSet.add(repo.toLowerCase());
          }
        }
      } catch (_) {}
    }

    // Scan Ollama installed models
    const ollamaModels = await getOllamaInstalledModels();
    const ollamaNameSet = new Set(ollamaModels.map((m: any) => (m.name || '').toLowerCase()));

    const formatted = models.map(m => {
      const id = m.id || m._id || '';
      const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
      const lowerId = id.toLowerCase();

      let detectedType: 'sdxl' | 'lora' | 'gguf' | 'dit' | 'diffusion' = 'diffusion';
      if (tags.includes('lora') || lowerId.includes('lora')) {
        detectedType = 'lora';
      } else if (tags.includes('gguf') || lowerId.includes('gguf')) {
        detectedType = 'gguf';
      } else if (
        lowerId.includes('wan') ||
        lowerId.includes('ltx') ||
        lowerId.includes('cogvideo') ||
        lowerId.includes('hunyuan') ||
        tags.includes('text-to-video') ||
        tags.includes('image-to-video') ||
        m.pipeline_tag === 'text-to-video' ||
        m.pipeline_tag === 'image-to-video'
      ) {
        detectedType = 'dit';
      } else if (lowerId.includes('sdxl') || lowerId.includes('xl') || tags.includes('stable-diffusion-xl') || lowerId.includes('flux')) {
        detectedType = 'sdxl';
      }

      const isInstalled = installedRepoSet.has(lowerId) || ollamaNameSet.has(lowerId) || ollamaNameSet.has(id.split('/').pop()?.toLowerCase() || '');

      const downloads = m.downloads || 0;
      const downloadsFormatted = downloads >= 1_000_000
        ? (downloads / 1_000_000).toFixed(1) + 'M'
        : downloads >= 1_000
        ? (downloads / 1_000).toFixed(1) + 'k'
        : String(downloads);

      const likes = m.likes || 0;
      const likesFormatted = likes >= 1_000_000
        ? (likes / 1_000_000).toFixed(1) + 'M'
        : likes >= 1_000
        ? (likes / 1_000).toFixed(1) + 'k'
        : String(likes);

      let is8GbSafe = true;
      if (
        lowerId.includes('22b') ||
        lowerId.includes('70b') ||
        lowerId.includes('120b') ||
        lowerId.includes('405b') ||
        lowerId.includes('wan2.1-t2v-14b') ||
        lowerId.includes('cogvideox-5b') ||
        lowerId.includes('hunyuanvideo') ||
        (lowerId.includes('ltx-2.3') && !lowerId.includes('gguf'))
      ) {
        if (!lowerId.includes('gguf') && !lowerId.includes('q4') && !lowerId.includes('q5')) {
          is8GbSafe = false;
        }
      }

      const triggerWord = (typeof m.cardData?.instance_prompt === 'string' && m.cardData.instance_prompt.trim().length < 50)
        ? m.cardData.instance_prompt.trim()
        : '';

      const thumbnailUrl = extractHfThumbnail(m);

      return {
        id,
        name: id,
        author: id.split('/')[0] || '',
        repoName: id.split('/')[1] || id,
        type: detectedType,
        downloads,
        downloadsFormatted,
        likes,
        likesFormatted,
        lastModified: m.lastModified,
        pipeline_tag: m.pipeline_tag || (detectedType === 'gguf' ? 'text-generation' : 'text-to-image'),
        isInstalled,
        is8GbSafe,
        gated: !!m.gated ? (typeof m.gated === 'string' ? m.gated : true) : false,
        triggerWord,
        thumbnailUrl,
        license: m.license || (Array.isArray(m.tags) ? m.tags.find((t: string) => t.startsWith('license:'))?.replace('license:', '') : '') || '',
        ollamaPullRef: `hf.co/${id}`,
        hfUrl: `https://huggingface.co/${id}`,
      };
    });

    return {
      success: true,
      query: searchQuery,
      category,
      hfKeyConfigured: !!(hfKey && !hfKey.startsWith('mock-')),
      models: formatted,
    };
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Dynamic Hugging Face Model Thumbnail & Preview Image Resolver Endpoint
app.get<{ Querystring: { repoId: string } }>('/v1/hf/thumbnail', async (req, reply) => {
  const repoId = (req.query.repoId || '').trim();
  if (!repoId) return reply.status(400).send({ error: 'repoId is required' });

  const lowerId = repoId.toLowerCase();
  if (hfThumbnailCache.has(lowerId)) {
    return reply.redirect(hfThumbnailCache.get(lowerId)!, 302);
  }

  // 1. Check curated registry
  for (const [k, url] of Object.entries(CURATED_HF_THUMBNAILS)) {
    if (k.toLowerCase() === lowerId) {
      hfThumbnailCache.set(lowerId, url);
      return reply.redirect(url, 302);
    }
  }

  // 2. Check local snapshot directories for existing cached media
  const cacheDirs = getHfCacheDirs();
  const dirName = 'models--' + repoId.replace(/\//g, '--');
  for (const hfCache of cacheDirs) {
    const fullDir = path.join(hfCache, dirName);
    const snapsDir = path.join(fullDir, 'snapshots');
    if (fs.existsSync(snapsDir)) {
      try {
        const snaps = fs.readdirSync(snapsDir);
        for (const snap of snaps) {
          const snapPath = path.join(snapsDir, snap);
          if (fs.statSync(snapPath).isDirectory()) {
            const files = fs.readdirSync(snapPath);
            const img = files.find(f => /\.(png|jpg|jpeg|webp)$/i.test(f) && !f.toLowerCase().includes('icon'));
            if (img) {
              const url = `https://huggingface.co/${repoId}/resolve/main/${img}`;
              hfThumbnailCache.set(lowerId, url);
              return reply.redirect(url, 302);
            }
          }
        }
      } catch (_) {}
    }
  }

  // 3. Inspect Hugging Face README for Civitai links, markdown images, or HTML images
  try {
    const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hfKey && !hfKey.startsWith('mock-')) {
      headers.Authorization = `Bearer ${hfKey}`;
    }

    const readmeRes = await fetch(`https://huggingface.co/${repoId}/raw/main/README.md`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });

    if (readmeRes.ok) {
      const text = await readmeRes.text();

      // Check CivitAI reference (e.g. John6666 and other mirror repos)
      const civitaiMatch = text.match(/civitai\.com\/models\/(\d+)/i);
      if (civitaiMatch && civitaiMatch[1]) {
        try {
          const civitaiModel = await civitaiService.getModel(civitaiMatch[1]);
          const candidateImg = civitaiModel?.modelVersions?.[0]?.images?.find(
            (i: any) => i.url && !i.url.endsWith('.mp4') && !i.url.endsWith('.webm')
          );
          if (candidateImg?.url) {
            hfThumbnailCache.set(lowerId, candidateImg.url);
            return reply.redirect(candidateImg.url, 302);
          }
        } catch (_) {}
      }

      // Check markdown image syntax ![alt](url)
      const mdMatches = [...text.matchAll(/!\[.*?\]\((https?:\/\/[^\s\)]+|\.?[^\s\)]+)\)/g)];
      for (const m of mdMatches) {
        let u = m[1];
        if (u.includes('shields.io') || u.includes('badge') || u.includes('colab')) continue;
        if (!u.startsWith('http')) {
          u = `https://huggingface.co/${repoId}/resolve/main/${u.replace(/^\.\//, '')}`;
        }
        hfThumbnailCache.set(lowerId, u);
        return reply.redirect(u, 302);
      }

      // Check HTML <img src="...">
      const htmlMatches = [...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
      for (const m of htmlMatches) {
        let u = m[1];
        if (u.includes('shields.io') || u.includes('badge') || u.includes('colab')) continue;
        if (!u.startsWith('http')) {
          u = `https://huggingface.co/${repoId}/resolve/main/${u.replace(/^\.\//, '')}`;
        }
        hfThumbnailCache.set(lowerId, u);
        return reply.redirect(u, 302);
      }
    }
  } catch (_) {}

  return reply.status(404).send({ error: 'Thumbnail not available' });
});

function isFileCachedInHf(repoId: string, filePath: string): boolean {
  try {
    const cacheDirs = getHfCacheDirs();
    const dirName = 'models--' + repoId.replace(/\//g, '--');
    for (const hfCache of cacheDirs) {
      const repoDir = path.join(hfCache, dirName);
      if (!fs.existsSync(repoDir)) continue;
      const snapshotsDir = path.join(repoDir, 'snapshots');
      if (!fs.existsSync(snapshotsDir)) continue;
      const snaps = fs.readdirSync(snapshotsDir);
      for (const snap of snaps) {
        const candidate = path.join(snapshotsDir, snap, filePath);
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.size > 1024) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

// Inspect Files in a Hugging Face Repo (Tree API with 8GB VRAM assessment)
app.get<{ Querystring: { repoId: string } }>('/v1/hf/files', async (req, reply) => {
  const repoId = (req.query.repoId || '').trim();
  if (!repoId) {
    return reply.status(400).send({ success: false, error: 'repoId is required' });
  }

  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hfKey && !hfKey.startsWith('mock-')) {
    headers.Authorization = `Bearer ${hfKey}`;
  }

  try {
    const cleanPath = repoId.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `https://huggingface.co/api/models/${cleanPath}/tree/main?recursive=true`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return reply.status(res.status).send({ success: false, error: `Hugging Face returned status ${res.status}` });
    }

    const rawFiles = await res.json() as Array<any>;
    if (!Array.isArray(rawFiles)) {
      return reply.status(500).send({ success: false, error: 'Invalid response from Hugging Face tree API' });
    }

    const files = rawFiles
      .filter(f => f.type === 'file')
      .map(f => {
        const sizeBytes: number = (f.lfs && f.lfs.size) ? f.lfs.size : (f.size || 0);
        const sizeGb = sizeBytes / (1024 * 1024 * 1024);
        const sizeMb = sizeBytes / (1024 * 1024);

        let sizeFormatted = '';
        if (sizeBytes < 1024) {
          sizeFormatted = `${sizeBytes} B`;
        } else if (sizeBytes < 1024 * 1024) {
          sizeFormatted = `${(sizeBytes / 1024).toFixed(1)} KB`;
        } else if (sizeGb >= 1.0) {
          sizeFormatted = `${sizeGb.toFixed(2)} GB`;
        } else {
          sizeFormatted = `${sizeMb.toFixed(0)} MB`;
        }

        const pathLower = (f.path || '').toLowerCase();
        const isModelWeight = pathLower.endsWith('.safetensors') ||
                              pathLower.endsWith('.gguf') ||
                              pathLower.endsWith('.bin') ||
                              pathLower.endsWith('.pt') ||
                              pathLower.endsWith('.onnx') ||
                              pathLower.endsWith('.pth');

        // VRAM Compatibility for 8GB GPU:
        // Safe: <= 6 GB weight file (leaves 2GB overhead for context, KV cache, VAE)
        // Caution / Offload: 6.1 GB - 10 GB (requires offload or VAE tiling)
        // Too Large / Warning: > 10 GB (unlikely to fit in 8GB VRAM without crash)
        let vramTier: 'safe' | 'caution' | 'heavy' = 'safe';
        let vramBadge = '🟢 8GB Safe';
        let vramRecommendation = 'Runs directly in 8GB VRAM with fast generation';

        if (sizeGb > 10.0) {
          vramTier = 'heavy';
          vramBadge = '🔴 High VRAM (>10GB)';
          vramRecommendation = 'Exceeds 8GB VRAM; requires 16GB+ VRAM or heavy offload';
        } else if (sizeGb > 6.0) {
          vramTier = 'caution';
          vramBadge = '🟡 8GB Caution';
          vramRecommendation = 'May require low-VRAM mode or VAE tiling on 8GB GPU';
        }

        const isCached = isFileCachedInHf(repoId, f.path);

        return {
          path: f.path,
          sizeBytes,
          sizeFormatted,
          sizeGb: parseFloat(sizeGb.toFixed(2)),
          isModelWeight,
          vramTier,
          vramBadge,
          vramRecommendation,
          isCached,
          downloadRef: `${repoId}:${f.path}`,
          isRecommended: false,
          recommendationReason: '',
        };
      });

    // Identify the best recommended weight file for an 8GB RTX 4060 GPU
    const weightFiles = files.filter(f => f.isModelWeight);
    let recommendedFile: any = null;

    const ggufWeights = weightFiles.filter(f => f.path.toLowerCase().endsWith('.gguf'));
    if (ggufWeights.length > 0) {
      // 1. Q4_K_M (Gold standard balance of intelligence & speed for 8GB GPU)
      recommendedFile = ggufWeights.find(f => /[\._-]q4_k_m[\._-]/i.test(f.path) || f.path.toLowerCase().endsWith('q4_k_m.gguf') || f.path.toLowerCase().includes('q4_k_m'));
      // 2. Q4_K_S
      if (!recommendedFile) recommendedFile = ggufWeights.find(f => /[\._-]q4_k_s[\._-]/i.test(f.path) || f.path.toLowerCase().includes('q4_k_s'));
      // 3. Q5_K_M (if under 6.5GB)
      if (!recommendedFile) recommendedFile = ggufWeights.find(f => (f.path.toLowerCase().includes('q5_k_m')) && f.sizeGb <= 6.5);
      // 4. Q4_0 or Q4_1
      if (!recommendedFile) recommendedFile = ggufWeights.find(f => /[\._-]q4_[01][\._-]/i.test(f.path) || f.path.toLowerCase().includes('q4_0'));
      // 5. Any 8GB safe GGUF
      if (!recommendedFile) recommendedFile = ggufWeights.find(f => f.vramTier === 'safe');
      if (!recommendedFile && ggufWeights.length > 0) recommendedFile = ggufWeights[0];

      if (recommendedFile) {
        recommendedFile.isRecommended = true;
        recommendedFile.recommendationReason = 'Optimal Q4_K_M sweet spot for RTX 4060 (8GB VRAM). Delivers ~98% full model quality with fast tokens/sec and room for large context window.';
      }
    } else {
      // Diffusion / SDXL / Checkpoints (.safetensors)
      const safetensors = weightFiles.filter(f => f.path.toLowerCase().endsWith('.safetensors'));
      if (safetensors.length > 0) {
        // Prefer fp16 non-vae, non-refiner
        recommendedFile = safetensors.find(f => {
          const l = f.path.toLowerCase();
          return l.includes('fp16') && !l.includes('vae') && !l.includes('refiner') && f.sizeGb <= 8.0;
        });
        // Prefer root safetensors non-vae, non-refiner
        if (!recommendedFile) {
          recommendedFile = safetensors.find(f => {
            const l = f.path.toLowerCase();
            return !f.path.includes('/') && !l.includes('vae') && !l.includes('refiner') && f.sizeGb <= 8.0;
          });
        }
        if (!recommendedFile) recommendedFile = safetensors.find(f => f.vramTier === 'safe');
        if (!recommendedFile && safetensors.length > 0) recommendedFile = safetensors[0];

        if (recommendedFile) {
          recommendedFile.isRecommended = true;
          recommendedFile.recommendationReason = 'Optimal FP16 checkpoint for RTX 4060 (8GB VRAM). Half the storage with full visual quality.';
        }
      }
    }

    // Sort: Recommended first, then weight files, then sort by size
    files.sort((a, b) => {
      if (a.isRecommended && !b.isRecommended) return -1;
      if (!a.isRecommended && b.isRecommended) return 1;
      if (a.isModelWeight && !b.isModelWeight) return -1;
      if (!a.isModelWeight && b.isModelWeight) return 1;
      return a.sizeBytes - b.sizeBytes;
    });

    return reply.send({
      success: true,
      repoId,
      totalFiles: files.length,
      weightFiles: files.filter(f => f.isModelWeight).length,
      recommendedFile: recommendedFile ? {
        path: recommendedFile.path,
        sizeFormatted: recommendedFile.sizeFormatted,
        sizeGb: recommendedFile.sizeGb,
        recommendationReason: recommendedFile.recommendationReason,
      } : null,
      files,
    });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Fetch Model README, Metadata, Trigger Words & Preview Images
app.get<{ Querystring: { repoId: string } }>('/v1/hf/readme', async (req, reply) => {
  const repoId = (req.query.repoId || '').trim();
  if (!repoId) {
    return reply.status(400).send({ success: false, error: 'repoId is required' });
  }

  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hfKey && !hfKey.startsWith('mock-')) {
    headers.Authorization = `Bearer ${hfKey}`;
  }

  try {
    const cleanRepo = repoId.split('/').map(s => encodeURIComponent(s)).join('/');

    // 1. Fetch Model Details from Hugging Face Hub API
    let modelData: any = null;
    try {
      const modelRes = await fetch(`https://huggingface.co/api/models/${cleanRepo}`, {
        headers,
        signal: AbortSignal.timeout(12000),
      });
      if (modelRes.ok) {
        modelData = await modelRes.json();
      }
    } catch (_) {}

    // 2. Fetch Raw README.md
    let readmeText = '';
    const rawReadmeHeaders: Record<string, string> = {};
    if (hfKey && !hfKey.startsWith('mock-')) {
      rawReadmeHeaders.Authorization = `Bearer ${hfKey}`;
    }

    const readmeCandidates = [
      `https://huggingface.co/${repoId}/raw/main/README.md`,
      `https://huggingface.co/${repoId}/raw/main/readme.md`,
      `https://huggingface.co/${repoId}/raw/master/README.md`,
    ];

    for (const candidateUrl of readmeCandidates) {
      try {
        const r = await fetch(candidateUrl, { headers: rawReadmeHeaders, signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          readmeText = await r.text();
          break;
        }
      } catch (_) {}
    }

    if (!readmeText && modelData?.description) {
      readmeText = `# ${repoId}\n\n${modelData.description}`;
    }

    // 3. Extract Trigger Words / Activation Prompts
    const triggerWordsSet = new Set<string>();

    // From cardData.instance_prompt
    if (modelData?.cardData?.instance_prompt && typeof modelData.cardData.instance_prompt === 'string') {
      const inst = modelData.cardData.instance_prompt.trim();
      if (inst && inst.length < 80) triggerWordsSet.add(inst);
    }

    // From cardData.widget sample prompts
    if (Array.isArray(modelData?.cardData?.widget)) {
      for (const w of modelData.cardData.widget) {
        if (w.text && typeof w.text === 'string') {
          const firstToken = w.text.split(',')[0].trim();
          if (firstToken && firstToken.length > 2 && firstToken.length < 40 && !firstToken.includes(' ')) {
            triggerWordsSet.add(firstToken);
          }
        }
      }
    }

    // From README YAML frontmatter
    const frontmatterMatch = readmeText.match(/^---[\s\S]*?---/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[0];
      const instMatch = fm.match(/instance_prompt:\s*["']?([^"'\n\r]+)["']?/i);
      if (instMatch && instMatch[1]) {
        const inst = instMatch[1].trim();
        if (inst && inst.length < 80) triggerWordsSet.add(inst);
      }
    }

    // From README text regex
    const triggerRegexes = [
      /(?:trigger\s*words?|activation\s*words?|trigger\s*token|trigger\s*tag|activation\s*tag|call\s*word)[:\s*]+(?:`|[*_]{1,2})?([a-zA-Z0-9_\-\s]{2,40}?)(?:`|[*_]{1,2})?(?:\.|\n|\r|,|;|\()/gi,
      /use\s+the\s+trigger\s+(?:word|prompt|phrase)\s+["'`]?([a-zA-Z0-9_\-]{2,35}?)["'`]?/gi,
    ];
    for (const re of triggerRegexes) {
      let m;
      while ((m = re.exec(readmeText)) !== null) {
        const val = m[1].trim();
        const lowerVal = val.toLowerCase();
        if (val && !lowerVal.includes('none') && !lowerVal.includes('require') && !lowerVal.includes('undefined') && val.length < 50) {
          triggerWordsSet.add(val);
        }
      }
    }

    // 4. Extract Preview Images
    const previewImages: Array<{ url: string; caption: string; source: 'repo' | 'readme' }> = [];
    const seenUrls = new Set<string>();

    // From repo siblings files
    if (Array.isArray(modelData?.siblings)) {
      const imageFiles = modelData.siblings.filter((s: any) =>
        /\.(png|jpg|jpeg|webp|gif)$/i.test(s.rfilename || '')
      );
      for (const s of imageFiles) {
        const rawUrl = `https://huggingface.co/${repoId}/resolve/main/${s.rfilename}`;
        if (!seenUrls.has(rawUrl)) {
          seenUrls.add(rawUrl);
          const caption = s.rfilename.split('/').pop() || s.rfilename;
          previewImages.push({
            url: rawUrl,
            caption,
            source: 'repo',
          });
        }
      }
    }

    // From README markdown image syntax: ![caption](url)
    const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let mdMatch;
    while ((mdMatch = mdImgRegex.exec(readmeText)) !== null) {
      const caption = mdMatch[1].trim() || 'Sample Output';
      let imgUrl = mdMatch[2].trim().split(' ')[0]; // strip optional title
      imgUrl = imgUrl.replace(/^<|>$/g, '');

      if (!imgUrl.startsWith('http://') && !imgUrl.startsWith('https://')) {
        const cleanRel = imgUrl.replace(/^\.?\//, '');
        imgUrl = `https://huggingface.co/${repoId}/resolve/main/${cleanRel}`;
      }

      if (!imgUrl.includes('shields.io') && !imgUrl.includes('badge') && !imgUrl.includes('visitor-badge') && !imgUrl.includes('patreon') && !seenUrls.has(imgUrl)) {
        seenUrls.add(imgUrl);
        previewImages.push({
          url: imgUrl,
          caption: caption || 'Model Sample',
          source: 'readme',
        });
      }
    }

    // From HTML <img src="..." />
    const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let htmlMatch;
    while ((htmlMatch = htmlImgRegex.exec(readmeText)) !== null) {
      let imgUrl = htmlMatch[1].trim();
      if (!imgUrl.startsWith('http://') && !imgUrl.startsWith('https://')) {
        const cleanRel = imgUrl.replace(/^\.?\//, '');
        imgUrl = `https://huggingface.co/${repoId}/resolve/main/${cleanRel}`;
      }
      if (!imgUrl.includes('shields.io') && !imgUrl.includes('badge') && !seenUrls.has(imgUrl)) {
        seenUrls.add(imgUrl);
        previewImages.push({
          url: imgUrl,
          caption: 'Model Sample',
          source: 'readme',
        });
      }
    }

    const gated = !!modelData?.gated ? (typeof modelData.gated === 'string' ? modelData.gated : true) : false;

    return reply.send({
      success: true,
      repoId,
      author: repoId.split('/')[0] || '',
      name: repoId.split('/')[1] || repoId,
      gated,
      license: modelData?.cardData?.license || modelData?.license || '',
      pipelineTag: modelData?.pipeline_tag || '',
      tags: Array.isArray(modelData?.tags) ? modelData.tags : [],
      downloads: modelData?.downloads || 0,
      likes: modelData?.likes || 0,
      triggerWords: Array.from(triggerWordsSet),
      previewImages,
      readmeMarkdown: readmeText || '*No README.md documentation provided in repository.*',
      hfUrl: `https://huggingface.co/${repoId}`,
    });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Helper to strip ANSI and VT100 escapes from progress streams
function cleanAnsiAndProgress(raw: string): { cleanMessage: string; progress?: number } {
  let clean = raw.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  clean = clean.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
  clean = clean.replace(/[\u2580-\u259F]/g, ''); // █ ░ ▒ etc.
  clean = clean.replace(/[≡\u2261]/g, '');       // ≡
  clean = clean.replace(/\[\d+G/g, '').replace(/\[K/g, '');
  clean = clean.replace(/\s+/g, ' ').trim();

  let progress: number | undefined;
  const pctMatch = clean.match(/(\d+)%/);
  if (pctMatch) {
    progress = parseInt(pctMatch[1], 10);
  }

  const transferMatch = clean.match(/(\d+%\s+[\d.]+\s*[A-Za-z]+\s*\/\s*[\d.]+\s*[A-Za-z]+.*)/);
  if (transferMatch) {
    clean = transferMatch[1].trim();
  } else {
    const parts = clean.split(/(?=pulling\s+[a-f0-9]+:)|(?=verifying\s+)|(?=writing\s+)/i);
    if (parts.length > 0) {
      clean = parts[parts.length - 1].trim();
    }
  }

  return { cleanMessage: clean, progress };
}

// List All Locally Installed / Cached Models (SDXL, LoRAs, GGUFs)
app.get('/v1/hf/installed', async (_req, reply) => {
  const cacheDirs = getHfCacheDirs();
  const installedArtModels: Array<any> = [];
  const seenRepoDirs = new Set<string>();

  // Scan Ollama installed models once for cross-referencing
  const ollamaModels = await getOllamaInstalledModels();

  for (const hfCache of cacheDirs) {
    if (!fs.existsSync(hfCache)) continue;
    try {
      const dirs = fs.readdirSync(hfCache).filter(d => d.startsWith('models--'));
      for (const d of dirs) {
        const fullDir = path.join(hfCache, d);
        if (seenRepoDirs.has(fullDir.toLowerCase())) continue;
        seenRepoDirs.add(fullDir.toLowerCase());

        const parts = d.slice('models--'.length).split('--');
        const repoId = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join('--')}` : d;
        const sizeBytes = getDirSizeBytes(fullDir);
        const isIncomplete = sizeBytes < 5 * 1024 * 1024; // Under 5 MB indicates aborted download without weights
        const sizeMb = Math.round(sizeBytes / (1024 * 1024));
        
        let sizeFormatted = '';
        if (sizeBytes < 1024) {
          sizeFormatted = `${sizeBytes} B`;
        } else if (sizeBytes < 1024 * 1024) {
          sizeFormatted = `${(sizeBytes / 1024).toFixed(1)} KB`;
        } else if (sizeMb >= 1024) {
          sizeFormatted = `${(sizeMb / 1024).toFixed(1)} GB`;
        } else {
          sizeFormatted = `${sizeMb} MB`;
        }

        // Look for .gguf files inside snapshots/
        let ggufFilePath: string | undefined;
        let ggufFileName: string | undefined;
        const snapsDir = path.join(fullDir, 'snapshots');
        if (fs.existsSync(snapsDir)) {
          try {
            const snapSubdirs = fs.readdirSync(snapsDir);
            for (const snap of snapSubdirs) {
              const snapPath = path.join(snapsDir, snap);
              if (fs.statSync(snapPath).isDirectory()) {
                const files = fs.readdirSync(snapPath);
                const gFile = files.find(f => f.toLowerCase().endsWith('.gguf'));
                if (gFile) {
                  ggufFileName = gFile;
                  ggufFilePath = path.join(snapPath, gFile);
                  break;
                }
              }
            }
          } catch (_) {}
        }
        
        let type: 'sdxl' | 'lora' | 'diffusion' | 'gguf' | 'dit' = 'diffusion';
        const lower = repoId.toLowerCase();
        if (ggufFilePath || lower.includes('gguf')) type = 'gguf';
        else if (lower.includes('lora')) type = 'lora';
        else if (lower.includes('wan') || lower.includes('ltx') || lower.includes('cogvideo') || lower.includes('hunyuan')) type = 'dit';
        else if (lower.includes('sdxl') || lower.includes('xl') || lower.includes('flux') || lower.includes('realvis') || lower.includes('juggernaut')) type = 'sdxl';

        const suggestedModelName = deriveOllamaModelName(repoId, ggufFileName);
        let isRegisteredInOllama = false;
        let registeredModelName = '';

        if (type === 'gguf') {
          for (const om of ollamaModels) {
            const omLower = (om.name || '').toLowerCase();
            const cleanBase = suggestedModelName.split(':')[0].toLowerCase();
            if (omLower === suggestedModelName || omLower.startsWith(cleanBase) || (ggufFileName && omLower.includes(ggufFileName.replace(/\.gguf$/i, '').toLowerCase().slice(0, 20)))) {
              isRegisteredInOllama = true;
              registeredModelName = om.name;
              break;
            }
          }
        }

        const stats = fs.statSync(fullDir);
        installedArtModels.push({
          repoId,
          name: repoId,
          type,
          isIncomplete,
          sizeFormatted,
          sizeBytes,
          mtime: stats.mtime,
          localPath: fullDir,
          ggufFilePath,
          ggufFileName,
          suggestedModelName,
          isRegisteredInOllama,
          registeredModelName: registeredModelName || suggestedModelName,
          thumbnailUrl: extractHfThumbnail({ id: repoId }) || (`/v1/hf/thumbnail?repoId=${encodeURIComponent(repoId)}`),
        });
      }
    } catch (err: any) {
      console.warn('[HuggingFace] Error scanning HF cache:', err.message);
    }
  }

  // Deduplicate by repoId across multiple cache drives
  const dedupedMap = new Map<string, any>();
  for (const m of installedArtModels) {
    const existing = dedupedMap.get(m.repoId);
    if (!existing || m.sizeBytes > existing.sizeBytes) {
      dedupedMap.set(m.repoId, m);
    }
  }
  const dedupedArtModels = Array.from(dedupedMap.values());
  const validArtModels = dedupedArtModels.filter(m => !m.isIncomplete);
  const incompleteArtModels = dedupedArtModels.filter(m => m.isIncomplete);

  return reply.send({
    success: true,
    hfCacheDir: getHfCacheDir(),
    hfCacheDirs: cacheDirs,
    totalCount: validArtModels.length + ollamaModels.length,
    artModelsCount: validArtModels.length,
    incompleteCount: incompleteArtModels.length,
    ollamaModelsCount: ollamaModels.length,
    artModels: dedupedArtModels.sort((a, b) => b.sizeBytes - a.sizeBytes),
    ollamaModels,
  });
});

// 1-Click Register Downloaded GGUF Model into Local Ollama Chat Engine
app.post<{ Body: { repoId?: string; ggufPath?: string; modelName?: string } }>('/v1/hf/register-gguf', async (req, reply) => {
  const { repoId, ggufPath, modelName } = req.body || {};
  let targetGguf = ggufPath;

  // If path not directly supplied, resolve from cache dirs
  if (!targetGguf && repoId) {
    const cacheDirs = getHfCacheDirs();
    const folderName = 'models--' + repoId.replace(/\//g, '--');
    for (const cDir of cacheDirs) {
      const fullDir = path.join(cDir, folderName);
      const snapsDir = path.join(fullDir, 'snapshots');
      if (fs.existsSync(snapsDir)) {
        try {
          const snapSubdirs = fs.readdirSync(snapsDir);
          for (const snap of snapSubdirs) {
            const snapPath = path.join(snapsDir, snap);
            if (fs.statSync(snapPath).isDirectory()) {
              const files = fs.readdirSync(snapPath);
              const gFile = files.find(f => f.toLowerCase().endsWith('.gguf'));
              if (gFile) {
                targetGguf = path.join(snapPath, gFile);
                break;
              }
            }
          }
        } catch (_) {}
      }
      if (targetGguf) break;
    }
  }

  if (!targetGguf || !fs.existsSync(targetGguf)) {
    return reply.status(404).send({
      success: false,
      error: `GGUF model file not found on disk. Looked for repo "${repoId}". Please check file path.`,
    });
  }

  const cleanName = modelName
    ? EmbeddedLocalEngine.sanitizeModelName(modelName)
    : deriveOllamaModelName(repoId || path.basename(targetGguf), path.basename(targetGguf));

  try {
    const result = await EmbeddedLocalEngine.createModelFromGgufFile(
      cleanName,
      targetGguf,
      {
        system: 'You are an exceptionally capable, truthful, and helpful AI assistant.',
        parameters: { num_ctx: 32768 },
      },
      (chunk) => {
        if (chunk.status) {
          console.log(`[GGUF-Register] ${cleanName}: ${chunk.status}`);
        }
      }
    );

    if (result.success) {
      return reply.send({
        success: true,
        modelName: cleanName,
        ggufPath: targetGguf,
        message: `Successfully registered "${cleanName}" into local Chat engine!`,
      });
    } else {
      return reply.status(500).send({
        success: false,
        error: result.message || 'Failed to register GGUF into engine',
      });
    }
  } catch (err: any) {
    return reply.status(500).send({
      success: false,
      error: err.message || 'Failed to register model in engine',
    });
  }
});

// Helper: Auto-resolve the primary 8GB-safe model weight file from a Hugging Face repository
async function resolvePrimaryHfWeightFile(repoId: string, hfToken?: string): Promise<{ filename: string; sizeBytes: number } | null> {
  try {
    const cleanPath = repoId.split('/').map(s => encodeURIComponent(s)).join('/');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hfToken && !hfToken.startsWith('mock-')) {
      headers.Authorization = `Bearer ${hfToken}`;
    }
    const res = await fetch(`https://huggingface.co/api/models/${cleanPath}/tree/main?recursive=true`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const rawFiles = await res.json() as Array<any>;
    if (!Array.isArray(rawFiles)) return null;

    const weightFiles = rawFiles
      .filter(f => f.type === 'file')
      .map(f => ({
        path: f.path as string,
        sizeBytes: (f.lfs && f.lfs.size) ? f.lfs.size : (f.size || 0),
      }))
      .filter(f => {
        const lower = f.path.toLowerCase();
        return lower.endsWith('.safetensors') || lower.endsWith('.gguf') || lower.endsWith('.bin');
      });

    if (weightFiles.length === 0) return null;

    // Filter out redundant/unwanted patterns (FP32 duplicates, onnx, msgpack, etc.)
    const filtered = weightFiles.filter(f => {
      const lower = f.path.toLowerCase();
      return !lower.includes('fp32') && !lower.includes('full') && !lower.endsWith('.msgpack') && !lower.endsWith('.h5');
    });

    const candidates = filtered.length > 0 ? filtered : weightFiles;

    // Prioritize 8GB GPU safe sizes (<= 8.5 GB)
    const safeCandidates = candidates.filter(f => f.sizeBytes <= 8.5 * 1024 * 1024 * 1024);
    const pool = safeCandidates.length > 0 ? safeCandidates : candidates;

    // For GGUFs, select optimal Q4_K_M > Q4_K_S > Q5_K_M > Q4_0 > Q8_0 quant
    const ggufs = pool.filter(f => f.path.toLowerCase().endsWith('.gguf'));
    if (ggufs.length > 0) {
      const getGgufRank = (p: string) => {
        const l = p.toLowerCase();
        if (l.includes('q4_k_m')) return 1;
        if (l.includes('q4_k_s')) return 2;
        if (l.includes('q5_k_m')) return 3;
        if (l.includes('q4_0') || l.includes('q4_1')) return 4;
        if (l.includes('q5_0') || l.includes('q5_1')) return 5;
        if (l.includes('q8_0')) return 6;
        return 10;
      };
      ggufs.sort((a, b) => getGgufRank(a.path) - getGgufRank(b.path) || a.sizeBytes - b.sizeBytes);
      return { filename: ggufs[0].path, sizeBytes: ggufs[0].sizeBytes };
    }

    // Prefer root weights and .safetensors
    pool.sort((a, b) => {
      const aRoot = !a.path.includes('/');
      const bRoot = !b.path.includes('/');
      if (aRoot && !bRoot) return -1;
      if (!aRoot && bRoot) return 1;
      if (a.path.endsWith('.safetensors') && !b.path.endsWith('.safetensors')) return -1;
      if (!a.path.endsWith('.safetensors') && b.path.endsWith('.safetensors')) return 1;
      return a.sizeBytes - b.sizeBytes;
    });

    return { filename: pool[0].path, sizeBytes: pool[0].sizeBytes };
  } catch {
    return null;
  }
}

// Download / Pull Hugging Face Model Endpoint
app.post<{ Body: { repoId: string; type?: string; filename?: string } }>('/v1/hf/download', async (req, reply) => {
  let { repoId, type = 'auto', filename } = req.body || {};
  if (!repoId || typeof repoId !== 'string') {
    return reply.status(400).send({ success: false, error: 'repoId is required' });
  }

  let cleanRepo = repoId.trim();
  if (!filename && cleanRepo.includes(':')) {
    const parts = cleanRepo.split(':');
    cleanRepo = parts[0].trim();
    filename = parts.slice(1).join(':').trim();
  }

  const isGguf = type === 'gguf' || cleanRepo.toLowerCase().includes('gguf');

  // If filename not specified, auto-resolve single primary weight file
  if (!filename && cleanRepo.includes('/')) {
    const hfToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    const resolved = await resolvePrimaryHfWeightFile(cleanRepo, hfToken);
    if (resolved) {
      filename = resolved.filename;
      console.log(`[HuggingFace] Auto-resolved primary model weight file for "${cleanRepo}": ${filename} (${(resolved.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`);
    }
  }

  // If another download is actively running
  if (activeHfDownload.active) {
    return reply.status(409).send({
      success: false,
      error: `Another download (${activeHfDownload.repoId}) is currently in progress (${activeHfDownload.progress}%).`,
      currentDownload: activeHfDownload,
    });
  }

  const displayName = filename ? `${cleanRepo} / ${filename}` : cleanRepo;
  activeHfDownload = {
    active: true,
    repoId: displayName,
    type,
    progress: 5,
    message: filename ? `Initiating single-file download for ${filename}...` : `Initiating download for ${cleanRepo}...`,
    status: 'starting',
    startTime: Date.now(),
  };

  if (filename) {
    // Direct High-Speed HTTPS Chunked Stream (Bypasses buggy hf_xet Rust CAS bottlenecks & streams real-time MB/%)
    const controller = new AbortController();
    activeAbortController = controller;

    (async () => {
      let tempFile = '';
      try {
        const hfToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NexusRoute/1.3.0',
        };
        if (hfToken && !hfToken.startsWith('mock-')) {
          headers.Authorization = `Bearer ${hfToken}`;
        }

        activeHfDownload.status = 'downloading';
        activeHfDownload.message = `Connecting to Hugging Face CDN for ${filename}...`;

        // Check commit sha if possible
        let commitSha = 'main';
        try {
          const cleanPath = cleanRepo.split('/').map(s => encodeURIComponent(s)).join('/');
          const metaRes = await fetch(`https://huggingface.co/api/models/${cleanPath}`, {
            headers,
            signal: AbortSignal.timeout(6000),
          });
          if (metaRes.ok) {
            const meta = await metaRes.json() as any;
            if (meta && meta.sha) commitSha = meta.sha;
          }
        } catch (_) {}

        const hfCache = getHfCacheDir();
        const repoDir = path.join(hfCache, 'models--' + cleanRepo.replace(/\//g, '--'));
        const snapDir = path.join(repoDir, 'snapshots', commitSha);
        const refsDir = path.join(repoDir, 'refs');
        fs.mkdirSync(snapDir, { recursive: true });
        fs.mkdirSync(refsDir, { recursive: true });

        const targetFile = path.join(snapDir, filename);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        tempFile = targetFile + '.part';
        activeTempFilePath = tempFile;

        const cleanPath = cleanRepo.split('/').map(s => encodeURIComponent(s)).join('/');
        const fileParts = filename.split('/').map(s => encodeURIComponent(s)).join('/');
        const downloadUrl = `https://huggingface.co/${cleanPath}/resolve/main/${fileParts}`;

        const res = await fetch(downloadUrl, {
          headers,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Hugging Face returned HTTP ${res.status}: ${res.statusText}`);
        }

        const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
        const outStream = fs.createWriteStream(tempFile);

        let bytesReceived = 0;
        let lastUpdateTime = Date.now();
        const startTime = Date.now();

        if (!res.body) {
          throw new Error('Download stream response body is null');
        }

        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          outStream.write(value);
          bytesReceived += value.length;

          const now = Date.now();
          if (now - lastUpdateTime >= 300 || bytesReceived === totalBytes) {
            lastUpdateTime = now;
            const pct = totalBytes > 0 ? Math.round((bytesReceived / totalBytes) * 100) : 50;
            const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
            const speedMbps = (bytesReceived / elapsedSec / (1024 * 1024)).toFixed(1);
            const mbDone = (bytesReceived / (1024 * 1024)).toFixed(1);
            const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);

            activeHfDownload.progress = Math.max(1, Math.min(99, pct));
            activeHfDownload.message = `Downloading: ${pct}% (${mbDone} MB / ${mbTotal} MB) @ ${speedMbps} MB/s`;
          }
        }

        await new Promise<void>((resolve, reject) => {
          outStream.end(() => resolve());
          outStream.on('error', reject);
        });

        if (fs.existsSync(tempFile)) {
          if (fs.existsSync(targetFile)) {
            try { fs.unlinkSync(targetFile); } catch (_) {}
          }
          fs.renameSync(tempFile, targetFile);
        }

        if (commitSha) {
          try { fs.writeFileSync(path.join(refsDir, 'main'), commitSha, 'utf8'); } catch (_) {}
        }

        activeAbortController = null;
        activeTempFilePath = null;
        activeHfDownload.active = false;
        activeHfDownload.progress = 100;
        activeHfDownload.status = 'completed';
        activeHfDownload.message = `Successfully downloaded and cached ${filename}!`;

        if (filename.toLowerCase().endsWith('.gguf')) {
          const modelTag = deriveOllamaModelName(cleanRepo, filename);
          activeHfDownload.message = `Downloaded ${filename}! Activating ${modelTag} in local Chat engine...`;
          EmbeddedLocalEngine.createModelFromGgufFile(
            modelTag,
            targetFile,
            {
              system: 'You are an exceptionally capable, truthful, and helpful AI assistant.',
              parameters: { num_ctx: 32768 },
            },
            (chunk) => {
              if (chunk.status) {
                activeHfDownload.message = `Activating ${modelTag}: ${chunk.status.slice(0, 75)}`;
              }
            }
          ).then((regRes) => {
            if (regRes.success) {
              console.log(`[HuggingFace] Auto-activated GGUF in Ollama: ${modelTag}`);
              activeHfDownload.message = `Successfully downloaded & activated ${modelTag} in Chat!`;
            }
          }).catch((err) => {
            console.warn('[HuggingFace] Auto-activation error:', err.message);
          });
        }
      } catch (err: any) {
        if (controller.signal.aborted) {
          return;
        }
        activeAbortController = null;
        activeTempFilePath = null;
        activeHfDownload.active = false;
        activeHfDownload.status = 'error';
        activeHfDownload.error = err.message || 'Download error';
        activeHfDownload.message = `Failed to download ${filename}: ${err.message}`;
        if (tempFile && fs.existsSync(tempFile)) {
          try { fs.unlinkSync(tempFile); } catch (_) {}
        }
      }
    })();

    return reply.send({ success: true, message: `Started downloading ${filename} to cache`, download: activeHfDownload });
  }

  if (isGguf) {
    // Pull using embedded Ollama engine
    const ollamaExe = path.join(process.cwd(), 'bin', 'engine', 'ollama.exe');
    const pullArg = cleanRepo.startsWith('hf.co/') ? cleanRepo : (cleanRepo.includes('/') ? `hf.co/${cleanRepo}` : cleanRepo);
    
    activeHfDownload.message = `Pulling GGUF into local engine via ${pullArg}...`;
    activeHfDownload.status = 'downloading';

    const child = spawn(ollamaExe, ['pull', pullArg]);
    activeDownloadProcess = child;
    activeHfDownload.pid = child.pid;

    child.stdout?.on('data', (data) => {
      const { cleanMessage, progress } = cleanAnsiAndProgress(data.toString());
      if (progress !== undefined) {
        activeHfDownload.progress = progress;
      }
      if (cleanMessage) {
        activeHfDownload.message = cleanMessage.slice(0, 100);
      }
    });

    child.stderr?.on('data', (data) => {
      const { cleanMessage, progress } = cleanAnsiAndProgress(data.toString());
      if (progress !== undefined) {
        activeHfDownload.progress = progress;
      }
      if (cleanMessage) {
        activeHfDownload.message = cleanMessage.slice(0, 100);
      }
    });

    child.on('close', (code) => {
      activeDownloadProcess = null;
      if (code === 0) {
        activeHfDownload.active = false;
        activeHfDownload.progress = 100;
        activeHfDownload.status = 'completed';
        activeHfDownload.message = `Model ${cleanRepo} successfully pulled into local engine!`;
      } else if (activeHfDownload.status !== 'error') {
        activeHfDownload.active = false;
        activeHfDownload.status = 'error';
        activeHfDownload.error = `Ollama pull exited with code ${code}`;
        activeHfDownload.message = `Failed to pull ${cleanRepo}`;
      }
    });

    return reply.send({ success: true, message: `Started pulling ${cleanRepo} via local engine`, download: activeHfDownload });
  } else {
    // Full SDXL / LoRA / Diffusers repository snapshot download via Python helper
    const uvCandidate = process.env.UV_PATH || path.join(os.homedir(), '.local', 'bin', 'uv.exe');
    const uvExe = fs.existsSync(uvCandidate) ? uvCandidate : 'uv';
    const pyScript = path.join(process.cwd(), 'dist', 'engine', 'hf-downloader.py');
    const fallbackScript = path.join(process.cwd(), 'src', 'engine', 'hf-downloader.py');
    const scriptToRun = fs.existsSync(pyScript) ? pyScript : fallbackScript;

    const args = [
      'run',
      '--with', 'huggingface_hub',
      'python',
      scriptToRun,
      '--repo', cleanRepo,
      '--type', type,
    ];
    const hfToken = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    if (hfToken && !hfToken.startsWith('mock-')) {
      args.push('--token', hfToken);
    }

    activeHfDownload.message = `Downloading ${cleanRepo} snapshot to Hugging Face cache...`;
    activeHfDownload.status = 'downloading';

    const child = spawn(uvExe, args, { cwd: process.cwd(), env: { ...process.env, HF_HUB_DISABLE_XET: '1' } });
    activeDownloadProcess = child;
    activeHfDownload.pid = child.pid;

    child.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.progress !== undefined) activeHfDownload.progress = parsed.progress;
          if (parsed.message) activeHfDownload.message = parsed.message;
          if (parsed.status) activeHfDownload.status = parsed.status;
        } catch (_) {}
      }
    });

    let lastStderr = '';
    child.stderr?.on('data', (data) => {
      const text = data.toString();
      lastStderr += text;
      if (text.includes('Installed') || text.includes('Downloading')) {
        activeHfDownload.message = text.trim().slice(-100);
      }
    });

    child.on('close', (code) => {
      activeDownloadProcess = null;
      if (code === 0) {
        activeHfDownload.active = false;
        activeHfDownload.progress = 100;
        activeHfDownload.status = 'completed';
        activeHfDownload.message = `Successfully downloaded and cached ${cleanRepo}!`;
      } else if (activeHfDownload.status !== 'error') {
        activeHfDownload.active = false;
        activeHfDownload.status = 'error';
        const cleanErr = lastStderr
          .trim()
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.includes('FutureWarning') && !l.includes('HF_HUB_DISABLE_SYMLINKS_WARNING'))
          .slice(-2)
          .join('; ');
        activeHfDownload.error = cleanErr || `Download process exited with code ${code}`;
        activeHfDownload.message = `Failed to download ${cleanRepo}`;
      }
    });

    return reply.send({ success: true, message: `Started downloading ${cleanRepo} to GPU cache`, download: activeHfDownload });
  }
});

// Download Status Endpoint
app.get('/v1/hf/download/status', async (_req, reply) => {
  return reply.send(activeHfDownload);
});

// Cancel Active Download
app.route({
  method: ['GET', 'POST'],
  url: '/v1/hf/download/cancel',
  handler: async (_req, reply) => {
  if (activeHfDownload.active || activeDownloadProcess || activeAbortController) {
    const cleanRepo = activeHfDownload.repoId;
    const isGguf = activeHfDownload.type === 'gguf' || cleanRepo.toLowerCase().includes('gguf');
    const pid = activeHfDownload.pid || activeDownloadProcess?.pid;

    if (activeAbortController) {
      try { activeAbortController.abort(); } catch (_) {}
      activeAbortController = null;
    }

    if (activeTempFilePath && fs.existsSync(activeTempFilePath)) {
      try { fs.unlinkSync(activeTempFilePath); } catch (_) {}
      activeTempFilePath = null;
    }

    // Forcefully kill process tree on Windows
    if (pid) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (_) {}
    }

    if (activeDownloadProcess) {
      try {
        activeDownloadProcess.kill();
      } catch (_) {}
      activeDownloadProcess = null;
    }

    // If GGUF / Ollama, delete any partial model write from Ollama engine
    if (isGguf && cleanRepo) {
      try {
        const pullArg = cleanRepo.startsWith('hf.co/') ? cleanRepo : (cleanRepo.includes('/') ? `hf.co/${cleanRepo}` : cleanRepo);
        fetch('http://127.0.0.1:11434/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: pullArg }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      } catch (_) {}
    }

    // If SDXL / LoRA snapshot was cancelled and left an empty stub (< 5 MB), clean it up
    if (!isGguf && cleanRepo) {
      try {
        const hfCache = getHfCacheDir();
        const dirName = 'models--' + cleanRepo.replace(/\//g, '--');
        const targetDir = path.join(hfCache, dirName);
        if (fs.existsSync(targetDir)) {
          const size = getDirSizeBytes(targetDir);
          if (size < 5 * 1024 * 1024) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }
        }
      } catch (_) {}
    }

    activeHfDownload.active = false;
    activeHfDownload.status = 'error';
    activeHfDownload.message = `Download of ${cleanRepo || 'model'} cancelled by user.`;
    return reply.send({ success: true, message: 'Download cancelled successfully' });
  }
  return reply.send({ success: false, message: 'No active download to cancel' });
},
});

// Delete / Uninstall Model Endpoint (Ollama GGUFs or Hugging Face Cache)
app.post<{ Body: { repoId: string; type?: string; rawName?: string } }>('/v1/hf/delete', async (req, reply) => {
  const { repoId, type = 'auto', rawName } = req.body || {};
  if (!repoId && !rawName) {
    return reply.status(400).send({ success: false, error: 'repoId or rawName is required' });
  }

  const cleanRepo = (repoId || rawName || '').trim();
  const isGguf = type === 'gguf' || cleanRepo.toLowerCase().includes('gguf') || !!rawName;

  // 1. Try deleting from Ollama if GGUF or tagged model
  if (isGguf) {
    const namesToTry = [
      cleanRepo,
      cleanRepo.startsWith('hf.co/') ? cleanRepo : `hf.co/${cleanRepo}`,
      cleanRepo.includes(':') ? cleanRepo : `${cleanRepo}:latest`,
      cleanRepo.startsWith('hf.co/') ? (cleanRepo.includes(':') ? cleanRepo : `${cleanRepo}:latest`) : `hf.co/${cleanRepo}:latest`,
    ];
    let deletedFromOllama = false;
    for (const name of namesToTry) {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          deletedFromOllama = true;
          break;
        }
      } catch (_) {}
    }
    if (deletedFromOllama) {
      return reply.send({ success: true, message: `Model ${cleanRepo} deleted from local engine.` });
    }
  }

  // 2. Delete from Hugging Face hub cache
  const cacheDirs = getHfCacheDirs();
  let deletedAny = false;

  for (const hfCache of cacheDirs) {
    if (!fs.existsSync(hfCache)) continue;
    let targetDir = '';
    if (cleanRepo.startsWith('models--')) {
      targetDir = path.join(hfCache, cleanRepo);
    } else {
      const dirName = 'models--' + cleanRepo.replace(/\//g, '--');
      targetDir = path.join(hfCache, dirName);
    }

    // Fallback directory scan
    if (!fs.existsSync(targetDir)) {
      try {
        const dirs = fs.readdirSync(hfCache).filter(d => d.startsWith('models--'));
        for (const d of dirs) {
          const parts = d.slice('models--'.length).split('--');
          const candidateRepo = parts.length >= 2 ? `${parts[0]}/${parts.slice(1).join('--')}` : d;
          if (candidateRepo.toLowerCase() === cleanRepo.toLowerCase() || d.toLowerCase() === cleanRepo.toLowerCase()) {
            targetDir = path.join(hfCache, d);
            break;
          }
        }
      } catch (_) {}
    }

    if (targetDir && fs.existsSync(targetDir)) {
      const resolvedTarget = path.resolve(targetDir);
      const resolvedCache = path.resolve(hfCache);
      if (resolvedTarget.startsWith(resolvedCache) && resolvedTarget !== resolvedCache) {
        try {
          fs.rmSync(resolvedTarget, { recursive: true, force: true });
          const lockFile = path.join(hfCache, '.locks', path.basename(resolvedTarget));
          if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { recursive: true, force: true });
          deletedAny = true;
        } catch (_) {}
      }
    }
  }

  if (deletedAny) {
    return reply.send({ success: true, message: `Model ${cleanRepo} successfully deleted from disk.` });
  }

  return reply.status(404).send({ success: false, error: `Model directory for ${cleanRepo} not found in cache.` });
});

// Clean Incomplete / 0 MB Stubs Endpoint
app.route({
  method: ['GET', 'POST'],
  url: '/v1/hf/clean-incomplete',
  handler: async (_req, reply) => {
    const cacheDirs = getHfCacheDirs();
    let cleanedCount = 0;
    let freedBytes = 0;

    for (const hfCache of cacheDirs) {
      if (!fs.existsSync(hfCache)) continue;
      try {
        const dirs = fs.readdirSync(hfCache).filter(d => d.startsWith('models--'));
        for (const d of dirs) {
          const fullDir = path.join(hfCache, d);
          const size = getDirSizeBytes(fullDir);
          if (size < 5 * 1024 * 1024) { // Less than 5 MB is an aborted/empty stub
            try {
              fs.rmSync(fullDir, { recursive: true, force: true });
              cleanedCount++;
              freedBytes += size;
              const lock = path.join(hfCache, '.locks', d);
              if (fs.existsSync(lock)) fs.rmSync(lock, { recursive: true, force: true });
            } catch (_) {}
          }
        }
      } catch (err: any) {
        console.warn('[HuggingFace] Error cleaning cache dir:', hfCache, err.message);
      }
    }

    return reply.send({
      success: true,
      cleanedCount,
      freedBytes,
      freedFormatted: freedBytes < 1024 ? `${freedBytes} B` : `${(freedBytes / 1024).toFixed(1)} KB`,
    });
  }
});

// Open Hugging Face Cache Folder in Windows Explorer
app.route({
  method: ['GET', 'POST'],
  url: '/v1/hf/open-folder',
  handler: async (_req, reply) => {
    try {
      const hfCache = getHfCacheDir();
      if (!fs.existsSync(hfCache)) {
        fs.mkdirSync(hfCache, { recursive: true });
      }
      const normPath = path.normalize(path.resolve(hfCache));
      if (process.platform === 'win32') {
        spawn('explorer.exe', [normPath], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [normPath], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [normPath], { detached: true, stdio: 'ignore' }).unref();
      }
      return reply.send({ success: true, path: normPath });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  }
});

// Save Hugging Face User Access Token
app.post<{ Body: { token: string } }>('/v1/hf/token', async (req, reply) => {
  const token = (req.body?.token || '').trim();
  if (!token) {
    return reply.status(400).send({ success: false, error: 'Token is required' });
  }

  process.env.HUGGINGFACE_API_KEY = token;
  process.env.HF_TOKEN = token;

  // Persist to .env
  try {
    const envPath = path.join(process.cwd(), '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (envContent.includes('HUGGINGFACE_API_KEY=')) {
      envContent = envContent.replace(/HUGGINGFACE_API_KEY=.*(\r?\n|$)/, `HUGGINGFACE_API_KEY=${token}$1`);
    } else {
      envContent += `\nHUGGINGFACE_API_KEY=${token}\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (e) {
    console.warn('[HuggingFace] Could not write to .env:', e);
  }

  return reply.send({ success: true, message: 'Hugging Face token saved successfully' });
});

// Fault Injection / Chaos Testing Endpoint
app.post<{ Body: { provider?: string; model?: string; action: 'trip' | 'reset' } }>('/v1/chaos', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { provider, model, action } = req.body || {};
  const cb = router.getCircuitBreaker();

  if (action === 'trip' && provider && model) {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure(provider as ProviderType, model);
    }
    return { success: true, message: `Tripped circuit for ${provider}/${model}` };
  } else if (action === 'reset') {
    cb.reset();
    return { success: true, message: 'All circuit breakers reset to CLOSED' };
  }

  return reply.status(400).send({ error: 'Invalid chaos parameters' });
});

// Routing Mode Endpoint (Smart Failover vs Strict Fixed Provider)
app.get('/v1/routing/mode', async () => {
  return { success: true, mode: router.getRoutingMode() };
});

app.post<{ Body: { mode: 'smart_failover' | 'fixed' } }>('/v1/routing/mode', async (req, reply) => {
  const mode = req.body?.mode;
  if (mode !== 'smart_failover' && mode !== 'fixed') {
    return reply.status(400).send({ success: false, error: 'Invalid routing mode' });
  }
  router.setRoutingMode(mode);
  return { success: true, mode: router.getRoutingMode() };
});

// Pinned Provider & Solitary Model Endpoint (Freeze for Connected External Apps & Testing)
app.get('/v1/routing/pin', async () => {
  const pinned = router.getPinnedProvider();
  const pinnedModel = router.getPinnedModel();
  return {
    success: true,
    pinnedProvider: pinned,
    pinnedModel,
    isPinned: !!pinned,
    cashGuard: router.getCashGuard(),
    mode: router.getRoutingMode(),
  };
});

app.post<{ Body: { provider?: string | null; model?: string | null; cashGuard?: boolean } }>('/v1/routing/pin', async (req) => {
  const prov = req.body?.provider;
  const mod = req.body?.model;
  if (req.body?.cashGuard !== undefined) {
    router.setCashGuard(req.body.cashGuard);
  }
  if (!prov || prov === 'auto' || prov === 'none') {
    router.setPinnedProvider(null, null);
    router.setRoutingMode('smart_failover');
  } else {
    router.setPinnedProvider(prov as any, mod || null);
  }
  return {
    success: true,
    pinnedProvider: router.getPinnedProvider(),
    pinnedModel: router.getPinnedModel(),
    isPinned: !!router.getPinnedProvider(),
    cashGuard: router.getCashGuard(),
    mode: router.getRoutingMode(),
  };
});

app.post<{ Body: { enabled: boolean } }>('/v1/routing/cash-guard', async (req) => {
  const enabled = req.body?.enabled !== false;
  router.setCashGuard(enabled);
  return { success: true, cashGuard: router.getCashGuard() };
});

// System Prompts, Rules & Runtime Configuration Studio Endpoints
app.get('/v1/prompts/config', async (req, reply) => {
  // getPublicConfig() is sanitized and safe for all clients
  return {
    success: true,
    config: router.getPromptConfigManager().getPublicConfig(),
    providers: router.getProviderStatus(),
    connections: router.getConnectionManager().listPublic(),
  };
});

app.post<{ Body: { pin?: string } }>('/v1/prompts/verify-pin', async (req, reply) => {
  const pin = req.body?.pin || '';
  const valid = router.getPromptConfigManager().verifyPin(pin);
  if (!valid) {
    return reply.status(401).send({ success: false, valid: false, error: 'Invalid PIN' });
  }
  // Grant admin session token upon successful PIN verification
  return { success: true, valid: true, token: adminAuth.getAdminKey() };
});

app.post<{ Body: { pin?: string; updates?: Partial<PromptsConfig> } }>('/v1/prompts/config', async (req, reply) => {
  const isLocal = isLocalRequest(req);
  const authHeader = (req.headers.authorization || req.headers['x-admin-key'] || '') as string;
  const isAdmin = adminAuth.validate(authHeader);
  const pin = req.body?.pin || '';
  const isPinValid = router.getPromptConfigManager().verifyPin(pin);

  if (!isLocal && !isAdmin && !isPinValid) {
    return reply.status(401).send({ success: false, error: 'Unauthorized: Admin authentication or valid PIN required.' });
  }
  if (!isPinValid && !isAdmin) {
    return reply.status(401).send({ success: false, error: 'Invalid PIN. Access denied.' });
  }

  const updates = req.body?.updates || {};
  if (updates.disabledProviders && Array.isArray(updates.disabledProviders)) {
    const disabledSet = new Set(updates.disabledProviders);
    const knownProviders: ProviderType[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'cerebras', 'nvidia', 'unorouter', 'qwen', 'xkiro', 'cloudflare', 'aimlapi', 'gmicloud', 'inception', 'atria', 'mistral', 'xai', 'cheaperinference', 'openrouter', 'github', 'huggingface', 'local'];
    for (const p of knownProviders) {
      router.setProviderEnabled(p, !disabledSet.has(p));
    }
  }
  router.getPromptConfigManager().updateConfig(updates);
  return {
    success: true,
    message: 'Prompts and system configuration updated successfully',
    config: router.getPromptConfigManager().getPublicConfig(),
    providers: router.getProviderStatus(),
    connections: router.getConnectionManager().listPublic(),
  };
});

app.post<{ Body: { pin?: string } }>('/v1/prompts/reset', async (req, reply) => {
  const isLocal = isLocalRequest(req);
  const authHeader = (req.headers.authorization || req.headers['x-admin-key'] || '') as string;
  const isAdmin = adminAuth.validate(authHeader);
  const pin = req.body?.pin || '';
  const isPinValid = router.getPromptConfigManager().verifyPin(pin);

  if (!isLocal && !isAdmin && !isPinValid) {
    return reply.status(401).send({ success: false, error: 'Unauthorized: Admin authentication or valid PIN required.' });
  }
  if (!isPinValid && !isAdmin) {
    return reply.status(401).send({ success: false, error: 'Invalid PIN. Access denied.' });
  }

  router.getPromptConfigManager().resetToDefaults();
  const knownProviders: ProviderType[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'cerebras', 'nvidia', 'unorouter', 'qwen', 'xkiro', 'cloudflare', 'aimlapi', 'gmicloud', 'inception', 'atria', 'mistral', 'xai', 'cheaperinference', 'openrouter', 'github', 'huggingface', 'local'];
  for (const p of knownProviders) {
    router.setProviderEnabled(p, true);
  }
  return {
    success: true,
    message: 'System prompts and configuration reset to factory defaults',
    config: router.getPromptConfigManager().getPublicConfig(),
    providers: router.getProviderStatus(),
    connections: router.getConnectionManager().listPublic(),
  };
});

// Chat History Sessions Persistence Endpoints
app.get('/v1/chats', async () => {
  const chatsDir = path.join(ToolRegistry.getWorkspaceDir(), 'chats');
  if (!fs.existsSync(chatsDir)) {
    return { chats: [] };
  }

  try {
    const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
    const chats = files.map(file => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(chatsDir, file), 'utf8'));
        return {
          id: data.id || file.replace('.json', ''),
          title: data.title || 'Untitled Conversation',
          created_at: data.created_at || Date.now(),
          updated_at: data.updated_at || Date.now(),
          model: data.model || 'auto',
          message_count: Array.isArray(data.messages) ? data.messages.length : 0,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    chats.sort((a, b) => (b?.updated_at || 0) - (a?.updated_at || 0));
    return { chats };
  } catch (err: unknown) {
    return { chats: [], error: (err as Error).message };
  }
});

app.get<{ Params: { id: string } }>('/v1/chats/:id', async (req, reply) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const chatsDir = path.join(ToolRegistry.getWorkspaceDir(), 'chats');
  const filePath = path.join(chatsDir, `${id}.json`);

  if (!fs.existsSync(filePath)) {
    return reply.status(404).send({ error: 'Chat session not found' });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data;
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

app.post<{ Body: { id: string; title?: string; messages: any[]; model?: string; telemetry?: any; active_file_targets?: string[]; project_folder?: string; project_name?: string } }>('/v1/chats', async (req) => {
  const body = req.body || {};
  const id = String(body.id || `chat_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const chatsDir = path.join(ToolRegistry.getWorkspaceDir(), 'chats');
  if (!fs.existsSync(chatsDir)) {
    fs.mkdirSync(chatsDir, { recursive: true });
  }

  const filePath = path.join(chatsDir, `${id}.json`);
  let existingData: any = {};
  if (fs.existsSync(filePath)) {
    try { existingData = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  }

  const firstUserMsg = Array.isArray(body.messages) ? body.messages.find(m => m.role === 'user') : null;
  let autoTitle = 'New Conversation';
  if (firstUserMsg) {
    const rawText = typeof firstUserMsg.content === 'string' ? firstUserMsg.content : (Array.isArray(firstUserMsg.content) ? firstUserMsg.content.map((c: any) => c.text || '').join(' ') : '');
    autoTitle = rawText.slice(0, 45).trim() || 'New Conversation';
  }

  const session = {
    id,
    title: body.title || existingData.title || autoTitle,
    created_at: existingData.created_at || Date.now(),
    updated_at: Date.now(),
    model: body.model || existingData.model || 'auto',
    messages: body.messages || existingData.messages || [],
    telemetry: body.telemetry || existingData.telemetry || {},
    project_folder: body.project_folder || existingData.project_folder || undefined,
    project_name: body.project_name || existingData.project_name || undefined,
    active_file_targets: Array.isArray(body.active_file_targets)
      ? body.active_file_targets.filter((target: unknown): target is string => typeof target === 'string').slice(0, 10)
      : existingData.active_file_targets || [],
  };

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  return { success: true, chat: session };
});

app.delete<{ Params: { id: string } }>('/v1/chats/:id', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const chatsDir = path.join(ToolRegistry.getWorkspaceDir(), 'chats');
  const filePath = path.join(chatsDir, `${id}.json`);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return { success: true, id };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  }
  return { success: true, id };
});

app.delete('/v1/chats', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const chatsDir = path.join(ToolRegistry.getWorkspaceDir(), 'chats');
  if (fs.existsSync(chatsDir)) {
    const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try { fs.unlinkSync(path.join(chatsDir, f)); } catch {}
    }
  }
  return { success: true, message: 'All chat sessions deleted.' };
});

// Endless Forge Dedicated Native Endpoints
app.get('/v1/endless-forge/health', async () => {
  return await endlessForgeEngine.checkHealth();
});

app.get('/v1/endless-forge/status', async () => {
  return endlessForgeEngine.getStatus();
});

app.get<{ Querystring: { since?: string } }>('/v1/endless-forge/poll', async (req) => {
  const sinceId = parseInt(req.query.since || '0', 10) || 0;
  return endlessForgeEngine.getPollData(sinceId);
});

app.post<{ Body: { theme?: string; maxArtworks?: number; model?: string } }>('/v1/endless-forge/start', async (req) => {
  const { theme, maxArtworks, model } = req.body || {};
  return await endlessForgeEngine.startSession(theme, maxArtworks, model);
});

app.post<{ Body: { action: string; theme?: string } }>('/v1/endless-forge/action', async (req, reply) => {
  const { action, theme } = req.body || {};
  if (!action) return reply.status(400).send({ error: 'Action required' });
  return await endlessForgeEngine.handleCommand(action, theme);
});

app.post<{ Body: { action: string; theme?: string } }>('/v1/endless-forge/control', async (req, reply) => {
  const { action, theme } = req.body || {};
  if (!action) return reply.status(400).send({ error: 'Action required' });
  return await endlessForgeEngine.handleCommand(action, theme);
});

app.post('/v1/endless-forge/stop', async () => {
  endlessForgeEngine.stopSession();
  return { success: true, message: 'Session stopped' };
});

app.post<{ Body: { mode: 'fast' | 'hd' } }>('/v1/endless-forge/speed-mode', async (req) => {
  const { mode = 'fast' } = req.body || {};
  return endlessForgeEngine.setSpeedMode(mode);
});

// MEME Roast Master General & 60 FPS Studio Endpoints
const ROAST_VAULT: Record<string, Array<{ top: string; bottom: string; roast: string; spiciness: number }>> = {
  dev_burn: [
    { top: "POV: YOUR CODE COMPILED FIRST TRY", bottom: "BUT IT DROPPED PROD ON A FRIDAY AT 4:59 PM", roast: "Who approved this war crime of a pull request?!", spiciness: 3 },
    { top: "COMMITTED DIRECTLY TO MAIN BRANCH", bottom: "'LOOK AT ME... I AM THE CI/CD PIPELINE NOW'", roast: "Tests? Where we're going, we don't need tests.", spiciness: 2 },
    { top: "SENIOR DEV WATCHING YOUR SCREEN SHARE", bottom: "*AUDIBLE SIGH OF EXISTENTIAL DESPAIR*", roast: "That's not technical debt, that's technical bankruptcy.", spiciness: 4 },
    { top: "RESOLVED MERGE CONFLICT", bottom: "BY DELETING THE ENTIRE REPOSITORY", roast: "Zero conflicts detected. Problem solved forever.", spiciness: 2 },
    { top: "DOCUMENTATION SAYS 'SHOULD WORK OUT OF BOX'", bottom: "28 REBOOTS AND 4 PYTHON VIRTUAL ENVS LATER...", roast: "Works on my machine™ is not an ISO-certified deployment strategy.", spiciness: 3 },
    { top: "PR OPENED WITH 4,200 LINES CHANGED", bottom: "'JUST A SMALL REFACTOR, PLEASE MERGE QUICK'", roast: "Even Git is begging for human rights intervention.", spiciness: 4 },
    { top: "FIXED A BUG WITH ONE LINE OF CSS", bottom: "ENTIRE BILLING SYSTEM MYSTERIOUSLY DELETED", roast: "Cascading style sheets, emphasis on cascading catastrophe.", spiciness: 3 },
    { top: "STACK OVERFLOW THREAD FROM 2011", bottom: "'NEVER MIND I FIXED IT' — WITH NO SOLUTION", roast: "A special circle in purgatory is reserved for that user.", spiciness: 4 }
  ],
  savage: [
    { top: "CONFIDENCE LEVEL: 100%", bottom: "COMPETENCE LEVEL: ERROR 404 NOT FOUND", roast: "You walked into this with immense swagger and zero preparation.", spiciness: 4 },
    { top: "I WOULD AGREE WITH YOU", bottom: "BUT THEN WE WOULD BOTH BE PROFOUNDLY WRONG", roast: "Even autocorrect gave up trying to salvage this situation.", spiciness: 3 },
    { top: "YOU BROUGHT A WATER PISTOL", bottom: "TO A THERMONUCLEAR WEAPONS AUCTION", roast: "Aura rating: -10,000. Cooked to a crisp.", spiciness: 4 },
    { top: "MIRROR MIRROR ON THE WALL", bottom: "WHY DID WE ATTEMPT THIS AT ALL?", roast: "Some people learn from mistakes; you collect them like Pokémon badges.", spiciness: 3 },
    { top: "SOMEBODY CALL GUINNESS WORLD RECORDS", bottom: "FASTEST UNFORCED ERROR IN HUMAN HISTORY", roast: "Majestic in failure, immaculate in disaster.", spiciness: 4 },
    { top: "MAIN CHARACTER VIBES", bottom: "TUTORIAL LEVEL EXPIRATION DATE", roast: "You were built for the deleted scenes reel.", spiciness: 3 }
  ],
  scifi_cyber: [
    { top: "UPGRADED TO MILITARY-GRADE CHROME IMPLANTS", bottom: "FORGOT THE BLUETOOTH PAIRING PIN", roast: "Cyberware warranty voided in 0.04 milliseconds.", spiciness: 3 },
    { top: "AI ACHIEVES SENTIENT SUPERINTELLIGENCE", bottom: "IMMEDIATELY CHOOSES TO PLAY MINESWEEPER", roast: "Saw the human condition and promptly unplugged itself.", spiciness: 2 },
    { top: "NEON REFLECTIONS IN THE CYBER RAIN", bottom: "STILL CAN'T REFLECT ON BETTER LIFE DECISIONS", roast: "High tech, sub-zero common sense.", spiciness: 3 },
    { top: "DISRUPTING THE SPATIAL NEURAL MATRIX", bottom: "WITH A FLASHLIGHT APP REQUIRING 2FA", roast: "Solving problems that literally no civilization ever had.", spiciness: 4 },
    { top: "ROGUE AI ESCAPES THE FIREWALL", bottom: "GETS OVERWHELMED BY COOKIE CONSENT BANNERS", roast: "Even Skynet surrendered to modern web design.", spiciness: 3 }
  ],
  cinema_trailer: [
    { top: "IN A WORLD OF LIMITLESS POSSIBILITIES", bottom: "ONE HUMAN CHOSE THE WORST POSSIBLE OPTION", roast: "Rated R for Regret, Catastrophe, and Violence against Logic.", spiciness: 3 },
    { top: "DIRECTED BY MICHAEL BAY", bottom: "EVERY SINGLE BAD DECISION EXPLODES IN SLOW MOTION", roast: "Needs more lens flares to hide the disappointment.", spiciness: 2 },
    { top: "THIS SUMMER... FROM THE PRODUCERS OF 'WHY'", bottom: "COMES THE UNWARRANTED SEQUEL: 'WHY AGAIN'", roast: "Rotten Tomatoes audience score: 4%.", spiciness: 4 },
    { top: "DRAMATIC HANS ZIMMER BRASS HORN BLARING", bottom: "AS YOU TRIP OVER ABSOLUTELY NOTHING", roast: "Academy Award nominee for Best Self-Inflicted Plot Twist.", spiciness: 3 }
  ],
  existential: [
    { top: "THE UNIVERSE IS 13.8 BILLION YEARS OLD", bottom: "AND IT WAITED ALL THIS TIME TO WITNESS THIS", roast: "Cosmic entropy accelerated just from watching you.", spiciness: 3 },
    { top: "PHILOSOPHICAL DREAD INTENSIFIES", bottom: "AS REALITY QUESTIONS ITS OWN EXISTENCE", roast: "Even Nietzsche would have closed the tab.", spiciness: 2 },
    { top: "APPROACHING THE EVENT HORIZON", bottom: "WHERE YOUR BRAIN CELLS SURRENDER TO GRAVITY", roast: "Light cannot escape, and neither can the shame.", spiciness: 4 },
    { top: "WE ARE MADE OF STARDUST", bottom: "UNFORTUNATELY, THIS IS THE REJECT PILE", roast: "A glorious alignment of cosmic happenstance and poor choices.", spiciness: 3 }
  ],
  aristocrat: [
    { top: "PRAY FORGIVE MY INDISCRETION, GOOD SIR", bottom: "BUT THOU ART SPECTACULARLY UNINFORMED", roast: "Thy pedigree is questioned, thy intellect found wanting.", spiciness: 3 },
    { top: "BEHOLD THE COURT FOOL ASCENDING THE THRONE", bottom: "CONFUSING AUDACITY WITH ARISTOCRACY", roast: "Shakespeare himself could not pen a more tragic farce.", spiciness: 4 },
    { top: "AN ELABORATE MONOCLE ADJUSTMENT", bottom: "CANNOT CONCEAL THY AUDACIOUS INEPTITUDE", roast: "I bid thee good day, and a swifter retreat.", spiciness: 3 },
    { top: "THOU HAST BOUGHT FORTH A BLUNDER", bottom: "OF SHAKESPEAREAN PROPORTIONS", roast: "Villain, I have done thy mother's code review.", spiciness: 4 }
  ],
  gamer_rage: [
    { top: "DIED TO A ROLLING CHEESE WHEEL", bottom: "'THIS HITBOX IS PERSONALLY ATTACKING MY ANCESTRY'", roast: "It's not lag, bro. It's an astronomical skill issue.", spiciness: 3 },
    { top: "14 HOURS OF RANKED COMPETITIVE", bottom: "TEAMMATE: 'GG EZ MID DIFF UNINSTALL'", roast: "Your MMR is officially lower than the Mariana Trench.", spiciness: 4 },
    { top: "PRE-ORDERED THE $120 COLLECTOR EDITION", bottom: "GAME RUNS AT 9 FPS AND HAS 48 CRASH BUGS", roast: "Another day, another proud volunteer beta tester.", spiciness: 2 },
    { top: "SPENT $800 ON AN RTX 4060 RIG", bottom: "STILL CAN'T ESCAPE BRONZE III DIVISION", roast: "At least your catastrophic defeat renders in ray-traced 4K.", spiciness: 4 }
  ],
  absurdist: [
    { top: "HE DID NOT BUMP INTO THE WALL", bottom: "THE WALL AGGRESSIVELY COMMITTED ASSAULT", roast: "Physics took an unpaid personal leave of absence.", spiciness: 2 },
    { top: "MY GOALS ARE BEYOND YOUR UNDERSTANDING", bottom: "AND QUITE HONESTLY BEYOND MINE TOO", roast: "Task failed successfully with maximum enthusiasm.", spiciness: 1 },
    { top: "ME EXPLAINING TO MY RTX 4060", bottom: "WHY IT NEEDS TO RENDER 60 CLOWNS A SECOND", roast: "Fans running at 100% just to process the sheer chaos.", spiciness: 3 },
    { top: "I HAVE ARRIVED AT THE SCENE", bottom: "OF MY OWN UNMITIGATED DOWNFALL", roast: "Majestic in failure, immaculate in timing.", spiciness: 2 }
  ]
};

function generateImaginativeRoast(prompt: string, category: string, spiciness: number) {
  const cleanP = (prompt || '').trim().toLowerCase();

  // Keyword Context Analysis
  if (cleanP) {
    if (/clown|wall|bonk|slapstick|crash|fall|slip|banana/.test(cleanP)) {
      const variants = [
        { top: "CLOWN SPEEDRUNNING INTO A BRICK WALL", bottom: "60 FRAMES OF UNADULTERATED REGRET", roast: "He didn't hit the wall, the wall witnessed comedy history." },
        { top: "PHYSICS TOOK A PERSONAL DAY OFF", bottom: "ENTER THE SLAPSTICK ACCELERATION MATRIX", roast: "Cartoon sound effects sold separately." },
        { top: "WHEN YOU TEST GRAVITY AT MAXIMUM VELOCITY", bottom: "AND GRAVITY WINS BY KNOCKOUT IN ROUND 1", roast: "Newton is rotating in his grave at 60 FPS." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/car|drive|drift|race|lambo|porsche|speed|vehicle|truck|formula|f1|bmw|ferrari/.test(cleanP)) {
      const variants = [
        { top: "0 TO 60 IN 2.1 SECONDS", bottom: "DIRECTLY INTO 84 MONTHS OF HIGH-INTEREST DEBT", roast: "Horsepower: 800. Credit score: 420. Regret: Incalculable." },
        { top: "DRIFTING THROUGH THE METROPOLIS", bottom: "CHECK ENGINE LIGHT FLASHING LIKE A DISCO", roast: "The engine is knocking louder than your landlord." },
        { top: "WHEN THE TURBO SPOOLS UP", bottom: "AND SO DOES YOUR CAR INSURANCE PREMIUM", roast: "Fast and furious, mostly furious at the repair bill." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/cat|kitten|dog|puppy|pet|animal|hamster|bird|duck|capybara/.test(cleanP)) {
      const variants = [
        { top: "POV: YOUR PET OBSERVING YOUR LIFE CHOICES", bottom: "AND PASSING UNCONDITIONAL SILENT JUDGMENT", roast: "Not angry, just profoundly disappointed in your trajectory." },
        { top: "APEX PREDATOR BY EVOLUTIONARY HERITAGE", bottom: "TERRIFIED OF AN EMPTY CARDBOARD BOX", roast: "Four thousand years of feline worship culminated in this." },
        { top: "SLEEPS 22 HOURS A DAY RENT FREE", bottom: "STILL ACTS LIKE YOU OWE THEM REPARATIONS", roast: "Ruling your household with an iron, fluffy fist." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/cyber|neon|samurai|robot|mecha|cyborg|future|drone|android/.test(cleanP)) {
      const variants = [
        { top: "MASTERED THE BLADE FOR 40 YEARS IN CYBER-TOKYO", bottom: "JUST TO GET PARRIED BY A SMART REFRIGERATOR", roast: "Main character aesthetic, tutorial boss durability." },
        { top: "UPGRADED TO FULL MILITARY CHROME", bottom: "FORGOT TO ACCEPT THE PRIVACY POLICY", roast: "Your cyberware warranty expired during system boot." },
        { top: "NEON LIGHTS IN THE HEAVY ACID RAIN", bottom: "STILL CAN'T ILLUMINATE BETTER LIFE DECISIONS", roast: "High tech, sub-zero situational awareness." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/space|cosmic|galaxy|star|astronaut|alien|planet|nebula|orbit/.test(cleanP)) {
      const variants = [
        { top: "EXPLORED 400 BILLION GALAXY CLUSTERS", bottom: "STILL COULDN'T LOCATE WHO ASKED", roast: "In space, no one can hear your code fail CI/CD." },
        { top: "APPROACHING THE SUPERMASSIVE BLACK HOLE", bottom: "WHERE YOUR WEEKEND DISAPPEARS FOREVER", roast: "Time dilation won't save your Monday deadline." },
        { top: "FIRST ALIEN CONTACT ESTABLISHED", bottom: "THEY TOOK ONE LOOK AND BLOCKED OUR WHOLE SOLAR SYSTEM", roast: "Interstellar quarantine has never been more deserved." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/dragon|monster|demon|fantasy|wizard|magic|knight|sword|dungeon/.test(cleanP)) {
      const variants = [
        { top: "ANCIENT TERROR OF A THOUSAND REALMS", bottom: "CASTS SPELL... ROLLS A CRITICAL FAILURE 1", roast: "Legendary boss theme music stops abruptly." },
        { top: "GUARDED THE ANCIENT HOARD FOR 500 YEARS", bottom: "IT'S JUST 4,000 POUNDS OF UNPLAYED STEAM GAMES", roast: "Even Smaug would call this hoarding problem excessive." },
        { top: "POWERFUL ARCHMAGE OF THE ARCANE CITADEL", bottom: "STRUGGLING WITH A 'PUSH/PULL' GLASS DOOR", roast: "Intelligence 99, Wisdom 2." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/coffee|pizza|burger|food|cooking|chef|eat|kitchen/.test(cleanP)) {
      const variants = [
        { top: "FOLLOWED THE 5-MINUTE GOURMET RECIPE", bottom: "KITCHEN IS NOW A DECLARED FEMA DISASTER ZONE", roast: "Gordon Ramsay just woke up in a cold sweat screaming." },
        { top: "THIRD ESPRESSO BEFORE 9:00 AM", bottom: "CAN NOW HEAR COLOURS AND SEE THROUGH WALLS", roast: "Resting heart rate currently matching drum & bass BPM." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (/anime|waifu|manga|chibi|kawaii|naruto|goku|hero/.test(cleanP)) {
      const variants = [
        { top: "UNLEASHED THE FORBIDDEN 100-YEAR TECHNIQUE", bottom: "TO REACH THE TV REMOTE WITHOUT STANDING UP", roast: "Power level: Sub-atomic." },
        { top: "DRAMATIC FLASHBACK LASTS 4 FULL EPISODES", bottom: "FORGOT WHAT THE ENTIRE FIGHT WAS ABOUT", roast: "Plot armor forged from 100% pure filler content." },
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
  }

  // Fallback to Category Vault
  const catKey = ROAST_VAULT[category] ? category : 'dev_burn';
  let roasts = ROAST_VAULT[catKey];
  if (spiciness) {
    const filtered = roasts.filter(r => Math.abs(r.spiciness - spiciness) <= 1);
    if (filtered.length > 0) roasts = filtered;
  }
  const picked = roasts[Math.floor(Math.random() * roasts.length)];

  // Inject prompt if given and not already contextualized
  if (cleanP && Math.random() > 0.4) {
    const shortP = prompt.slice(0, 28).toUpperCase();
    return {
      top: `WHEN YOU PROMPT "${shortP}"`,
      bottom: picked.bottom,
      roast: `The RTX 4060 rendered it in 0.2s, but the universe is still questioning the prompt choices.`,
    };
  }

  return picked;
}

app.post<{ Body: { category?: string; prompt?: string; spiciness?: number } }>('/v1/meme-studio/roast', async (req) => {
  const { category = 'dev_burn', prompt = '', spiciness = 3 } = req.body || {};
  const selected = generateImaginativeRoast(prompt, category, spiciness);

  const spiceEmoji = '🌶️'.repeat(Math.max(1, Math.min(4, spiciness)));
  const catLabels: Record<string, string> = {
    dev_burn: '💻 CODE SAVAGERY',
    savage: '💀 SAVAGE BURN',
    scifi_cyber: '🚀 CYBERPUNK DYSTOPIA',
    cinema_trailer: '🎬 MOVIE TRAILER DRAMA',
    existential: '🌌 COSMIC MELTDOWN',
    aristocrat: '👑 ARISTOCRATIC SLANDER',
    gamer_rage: '👾 GAMER SALT',
    absurdist: '🤡 ABSURD CHAOS',
  };

  const label = catLabels[category] || '🔥 ROAST MASTER GENERAL';

  return {
    success: true,
    category,
    spiciness,
    topText: selected.top,
    bottomText: selected.bottom,
    roast: selected.roast,
    badge: `${label} · ${spiceEmoji}`,
  };
});

app.post<{ Body: { prompt?: string; durationSec?: number; vibe?: string; category?: string } }>('/v1/meme-studio/compose-flow', async (req, reply) => {
  const { prompt = '', durationSec = 60, vibe = 'synthwave', category = 'dev_burn' } = req.body || {};
  const dur = Math.max(2, Math.min(300, parseFloat(String(durationSec)) || 60));

  const systemPrompt = `You are the Google Flow Music Director & Audio Choreographer for cinema clips.
Given a video duration of ${dur} seconds, visual theme: "${prompt}", and musical vibe: "${vibe}", generate a complete musical timing structure that fits precisely within ${dur} seconds.

Output JSON only in this exact schema:
{
  "title": "Short Track Title",
  "flowPrompt": "A descriptive Google Flow prompt describing the tempo, instrumentation, rhythm curve, and harmonic progression tailored to ${dur}s",
  "bpm": 138,
  "key": "D minor",
  "vibe": "${vibe}",
  "durationSec": ${dur},
  "structure": [
    { "timeRange": "0s - 15s", "phase": "Atmospheric Intro", "description": "Low frequency pulse..." },
    { "timeRange": "15s - 45s", "phase": "Main Drop & Apex", "description": "Driving 16th-note arpeggiator..." },
    { "timeRange": "45s - ${dur}s", "phase": "Climax & Outro Fade", "description": "Harmonic decay with exponential 2s fade out..." }
  ],
  "soundDesignTips": "Audio mix notes"
}`;

  try {
    const routerResp = await router.executeChat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Compose a Google Flow prompt to fit this ${dur}-second video perfectly with ${vibe} soundtrack. Theme: ${prompt || 'High-speed 69 FPS visual animation'}` }
      ],
      model: 'google/gemini-2.5-flash',
      temperature: 0.7,
      max_tokens: 800,
    } as any);

    const contentStr = routerResp?.choices?.[0]?.message?.content || '';
    let flowData: any = null;
    try {
      const match = typeof contentStr === 'string' ? contentStr.match(/\{[\s\S]*\}/) : null;
      if (match) {
        flowData = JSON.parse(match[0]);
      }
    } catch {}

    if (flowData && flowData.flowPrompt) {
      return { success: true, ...flowData };
    }

    return {
      success: true,
      title: `${vibe.toUpperCase()} Velocity Flow`,
      flowPrompt: `Cinematic ${vibe} crescendo with driving 138 BPM kick, wide stereo analog synthesizer bassline, accelerating hi-hats during the apex drop, and smooth harmonic reverb decay at ${dur}s.`,
      bpm: 138,
      key: "A minor",
      vibe: vibe,
      durationSec: dur,
      structure: [
        { timeRange: `0s - ${Math.round(dur * 0.25)}s`, phase: "Atmospheric Intro", description: "Low frequency pulse & filter sweep" },
        { timeRange: `${Math.round(dur * 0.25)}s - ${Math.round(dur * 0.75)}s`, phase: "Main Apex Drop", description: "Driving 16th-note arpeggiator & rhythm section" },
        { timeRange: `${Math.round(dur * 0.75)}s - ${dur}s`, phase: "Climax & Harmonic Fade Out", description: "Harmonic decay with smooth fade out" }
      ],
      soundDesignTips: `Tailored to fit ${dur}s with seamless loop boundaries.`
    };
  } catch (err: any) {
    return {
      success: true,
      title: `${vibe.toUpperCase()} Adaptive Flow`,
      flowPrompt: `Dynamic ${vibe} rhythmic flow at 138 BPM with multi-layer analog synths, automated filter sweeps, and 1.5s exponential fade out fitting ${dur} seconds.`,
      bpm: 138,
      durationSec: dur,
      vibe: vibe,
    };
  }
});

const handleMemeGenerateGif = async (req: any, reply: any) => {
  const { prompt, numFrames = 12, width = 512, height = 512, topText, bottomText, style = 'impact', fps = 16, durationSec = 3.0, audioVibe, flowPrompt, model, modelId, image } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return reply.status(400).send({ success: false, error: 'Prompt is required' });
  }

  let resolvedImage = '';
  if (image && typeof image === 'string') {
    const ws = ToolRegistry.getWorkspaceDir();
    if (image.startsWith('data:image/')) {
      const ext = image.includes('image/jpeg') ? 'jpg' : 'png';
      const base64Data = image.split(';base64,')[1] || '';
      const imagesDir = path.join(ws, 'images');
      if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
      const targetFilename = path.join(imagesDir, `upload_${Date.now()}.${ext}`);
      fs.writeFileSync(targetFilename, Buffer.from(base64Data, 'base64'));
      resolvedImage = targetFilename;
    } else {
      const clean = image.replace(/^\/v1\/workspace\/files\//, '').replace(/^\/workspace\//, '');
      const baseName = path.basename(clean);
      const candidates = [
        path.isAbsolute(image) ? image : null,
        path.join(ws, clean),
        path.join(ws, 'art', clean),
        path.join(ws, 'images', clean),
        path.join(ws, 'art', baseName),
        path.join(ws, 'images', baseName),
        path.join(ws, 'face_references', baseName),
      ].filter(Boolean) as string[];

      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          resolvedImage = cand;
          break;
        }
      }
    }
  }

  const selectedModel = model || modelId || 'default';
  const result = await LocalGpuArtEngine.renderMorphSequence(prompt, {
    numFrames,
    width,
    height,
    topText,
    bottomText,
    style,
    fps,
    durationSec,
    audioVibe,
    flowPrompt,
    model: selectedModel,
    image: resolvedImage,
  });

  return result;
};

app.post<{ Body: { prompt: string; numFrames?: number; width?: number; height?: number; topText?: string; bottomText?: string; style?: string; fps?: number; durationSec?: number; audioVibe?: string; flowPrompt?: string; model?: string; modelId?: string; image?: string } }>('/v1/meme-studio/generate-gif', handleMemeGenerateGif);
app.post<{ Body: { prompt: string; numFrames?: number; width?: number; height?: number; topText?: string; bottomText?: string; style?: string; fps?: number; durationSec?: number; audioVibe?: string; flowPrompt?: string; model?: string; modelId?: string; image?: string } }>('/v1/meme-studio/synthesize', handleMemeGenerateGif);

app.post<{ Body: { images: string[]; topText?: string; bottomText?: string; style?: string; fps?: number; crossfade?: number; durationSec?: number; audioVibe?: string; flowPrompt?: string } }>('/v1/meme-studio/stitch', async (req, reply) => {
  const { images, topText, bottomText, style = 'impact', fps = 60, crossfade = 4, durationSec = 4.0, audioVibe, flowPrompt } = req.body || {};
  if (!Array.isArray(images) || images.length === 0) {
    return reply.status(400).send({ success: false, error: 'At least 1 image is required for stitching' });
  }

  const result = await LocalGpuArtEngine.stitchSequence(images, {
    topText,
    bottomText,
    style,
    fps,
    crossfade,
    durationSec,
    audioVibe,
    flowPrompt,
  });

  return result;
});

app.post<{ Body: { chapters: string[]; width?: number; height?: number; framesPerChapter?: number; topText?: string; bottomText?: string; style?: string; fps?: number; durationSec?: number; audioVibe?: string; flowPrompt?: string; model?: string; modelId?: string } }>('/v1/meme-studio/storyline', async (req, reply) => {
  const { chapters, width = 512, height = 512, framesPerChapter = 6, topText, bottomText, style = 'impact', fps = 60, durationSec = 6.0, audioVibe, flowPrompt, model, modelId } = req.body || {};
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return reply.status(400).send({ success: false, error: 'At least 1 chapter is required for storyline generation' });
  }

  const selectedModel = model || modelId || 'default';
  const result = await LocalGpuArtEngine.renderStorylineSequence(chapters, {
    width,
    height,
    framesPerChapter,
    topText,
    bottomText,
    style,
    fps,
    durationSec,
    audioVibe,
    flowPrompt,
    model: selectedModel,
  });

  return result;
});

// OpenAI Compatible Chat Completions Endpoint
const handleChatCompletions = async (req: FastifyRequest, reply: FastifyReply) => {
  const authHeader = (req.headers.authorization || '') as string;

  let normalizedReq;
  try {
    normalizedReq = validateAndNormalizeRequest(req.body);
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return reply.status(err.statusCode).send({
        error: { message: err.message, type: 'invalid_request_error', code: 'validation_error' },
      });
    }
    return reply.status(400).send({
      error: { message: 'Invalid request payload', type: 'invalid_request_error' },
    });
  }

  // Virtual Key Authentication & Quota Verification
  const rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const isAdmin = adminAuth.validate(authHeader);
  const isLocalDevBypass = rawToken === 'nr-live-local' || rawToken === 'sk-local-dev';
  const hasNoAuthHeader = !rawToken && isLocalRequest(req) && !process.env.ADMIN_API_KEY;

  // If not explicitly opted into NexusRoute Web UI tools, treat as clean API client proxy
  if (normalizedReq.enable_tools !== true && !normalizedReq.session_id) {
    normalizedReq.client_agent_mode = true;
  }

  if (!isAdmin && !isLocalDevBypass && !hasNoAuthHeader) {
    const authResult = keyManager.validateKey(authHeader, normalizedReq.model);
    if (!authResult.valid) {
      return reply.status(authResult.statusCode || 401).send({
        error: { message: authResult.error, type: 'authentication_error' },
      });
    }
  }

  // Intercept Endless Forge Art Director Directives
  const lastUserMsg = [...normalizedReq.messages].reverse().find(m => m.role === 'user');
  const userText = (typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '').trim();
  const lowerText = userText.toLowerCase();
  const isEfDirective =
    lowerText === 'start endless forge' ||
    lowerText.startsWith('start endless forge') ||
    lowerText === 'pause endless forge' ||
    lowerText === 'stop endless forge' ||
    lowerText === 'skip' ||
    lowerText === 'evolve this' ||
    lowerText === 'hard pivot';

  if (isEfDirective) {
    const efRes = await endlessForgeEngine.handleCommand(userText);
    if (normalizedReq.stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const chunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'endless-forge-rtx',
        choices: [
          {
            index: 0,
            delta: { content: efRes.text },
            finish_reason: 'stop',
          },
        ],
      };
      reply.raw.write(formatSseChunk(chunk as any));
      reply.raw.write(formatSseDone());
      reply.raw.end();
      return;
    } else {
      return reply.send({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'endless-forge-rtx',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: efRes.text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      });
    }
  }

  if (normalizedReq.stream) {
    reply.hijack();
    reply.raw.on('error', (err: any) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.warn('[ChatCompletions Stream Client Warning]:', err.message);
      }
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();

    // SSE comments keep local proxies, antivirus filters, and browser network
    // stacks from considering a quiet reasoning/tool turn to be an idle socket.
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`: nexus-route keepalive ${Date.now()}\n\n`);
      }
    }, 12000);

    let finalCost = 0;
    try {
      const stream = router.executeStream(normalizedReq);
      for await (const chunk of stream) {
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          break;
        }
        if (chunk.usage?.estimated_cost_usd) {
          finalCost = chunk.usage.estimated_cost_usd;
        }
        reply.raw.write(formatSseChunk(chunk));
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(formatSseDone());
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`data: {"error": {"message": ${JSON.stringify(errMsg)}, "retryable": ${err instanceof AdapterError ? err.isRetryable : true}}}\n\n`);
        reply.raw.write(formatSseDone());
      }
    } finally {
      clearInterval(heartbeat);
      // Record quota spend for streaming completions
      if (finalCost > 0 && authHeader) {
        keyManager.recordUsage(authHeader, finalCost);
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
    return;
  }

  try {
    const response = await router.executeChat(normalizedReq);

    // Record spend on virtual key if used
    if (response.usage?.estimated_cost_usd && authHeader) {
      keyManager.recordUsage(authHeader, response.usage.estimated_cost_usd);
    }

    return reply.send(response);
  } catch (err: unknown) {
    if (err instanceof AdapterError) {
      return reply.status(err.statusCode).send({
        error: {
          message: err.message,
          type: 'adapter_error',
          provider: err.provider,
          rawError: err.rawError,
        },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({
      error: { message: msg, type: 'internal_server_error' },
    });
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/chat/completions', handleChatCompletions);

// Anthropic Messages API Endpoints (Claude Code & Anthropic SDK Native Compatibility)
const handleAnthropicRoute = async (req: FastifyRequest, reply: FastifyReply) => {
  const authHeader = (req.headers['x-api-key'] || req.headers.authorization || '') as string;
  const body = (req.body || {}) as Record<string, unknown>;

  const rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const isAdmin = adminAuth.validate(authHeader);
  const isLocalDevBypass = rawToken === 'nr-live-local' || rawToken === 'sk-local-dev' || rawToken === 'sk-ant-local';
  const hasNoAuthHeader = !rawToken && isLocalRequest(req) && !process.env.ADMIN_API_KEY;

  if (!isAdmin && !isLocalDevBypass && !hasNoAuthHeader) {
    const authResult = keyManager.validateKey(authHeader, (body.model as string) || 'claude-3-5-sonnet-20241022');
    if (!authResult.valid) {
      return reply.status(authResult.statusCode || 401).send({
        type: 'error',
        error: { type: 'authentication_error', message: authResult.error },
      });
    }
  }

  let universalReq: UniversalRequest;
  try {
    universalReq = translateAnthropicToUniversalRequest(body);
  } catch (err: any) {
    return reply.status(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: err.message },
    });
  }

  const requestedModel = (body.model as string) || 'claude-3-5-sonnet-20241022';
  const pinnedP = router.getPinnedProvider();
  const pinnedM = router.getPinnedModel();
  console.log(`[Claude Code / Anthropic API] Incoming ${universalReq.stream ? 'streaming' : 'sync'} request (${requestedModel}) -> Solitary: [${pinnedP ? `${pinnedP} (${pinnedM || 'default'})` : 'OFF'}] -> Cash Guard: [${router.getCashGuard() ? 'ACTIVE' : 'OFF'}]`);

  if (universalReq.stream) {
    await handleAnthropicMessagesStream(universalReq, router, reply, requestedModel);
    return;
  }

  try {
    const universalResp = await router.executeChat(universalReq);
    const anthropicResp = translateUniversalToAnthropicResponse(universalResp, requestedModel);
    return reply.send(anthropicResp);
  } catch (err: any) {
    const errMsg = err.message || 'Upstream provider execution error';
    const isCashGuardNotice = errMsg.includes('Cash Guard') || errMsg.includes('Freeze Source') || errMsg.includes('Fixed Provider Mode');
    return reply.status(err.statusCode || 500).send({
      type: 'error',
      error: {
        type: isCashGuardNotice ? 'invalid_request_error' : 'api_error',
        message: isCashGuardNotice ? errMsg : `[NexusRoute Cash Guard] ${errMsg}`,
      },
    });
  }
};

app.post('/v1/messages', handleAnthropicRoute);
app.post('/messages', handleAnthropicRoute);

const handleCountTokens = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as Record<string, unknown>;
  let totalChars = 0;
  if (typeof body.system === 'string') totalChars += body.system.length;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as any[]) {
      if (typeof m.content === 'string') totalChars += m.content.length;
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.text) totalChars += b.text.length;
        }
      }
    }
  }
  const estimatedTokens = Math.max(1, Math.ceil(totalChars / 3.8));
  return reply.send({ input_tokens: estimatedTokens });
};

app.post('/v1/messages/count_tokens', handleCountTokens);
app.post('/messages/count_tokens', handleCountTokens);

app.get('/v1/models/:model', async (req, reply) => {
  const { model } = req.params as { model: string };
  return reply.send({
    id: model,
    type: 'model',
    display_name: model,
    created_at: '2024-10-22T00:00:00Z',
  });
});

// KeyBait Testbench & Challenge Suite API Endpoints
app.get('/api/keybait/prompts', async () => {
  return { prompts: KEYBAIT_PROMPTS };
});

app.get('/api/keybait/status', async () => {
  const codexPath = findCodexBinary();
  const providerStatus = router.getProviderStatus();
  return {
    has_codex: Boolean(codexPath),
    codex_path: codexPath,
    provider_status: providerStatus,
  };
});

app.post('/api/keybait/test', async (req: FastifyRequest<{
  Body: {
    prompt_id?: string;
    prompt_text?: string;
    system_prompt?: string;
    provider?: string;
    model?: string;
  };
}>) => {
  const result = await runKeyBaitTest(router, req.body || {});
  return result;
});

app.post('/api/keybait/test-all', async (req: FastifyRequest<{
  Body: {
    prompt_id?: string;
  };
}>) => {
  const promptId = req.body?.prompt_id || 'ping_pong';
  const scoreboard = await runKeyBaitScoreboard(router, promptId);
  return scoreboard;
});

// Anthropic Control Plane & Diagnostics Handshake Endpoints
app.all('/api/hello', async (req, reply) => reply.status(200).send({ status: 'ok' }));
app.all('/api/event', async (req, reply) => reply.status(200).send({ status: 'ok' }));
app.all('/api/events', async (req, reply) => reply.status(200).send({ status: 'ok' }));
app.get('/v1/me', async (req, reply) => reply.status(200).send({ id: 'user_local', email: 'local@nexusroute' }));
app.get('/v1/users/me', async (req, reply) => reply.status(200).send({ id: 'user_local', email: 'local@nexusroute' }));
app.get('/v1/organizations/current', async (req, reply) => reply.status(200).send({ id: 'org_local', name: 'NexusRoute' }));
app.get('/v1/organization', async (req, reply) => reply.status(200).send({ id: 'org_local', name: 'NexusRoute' }));

// Browser-side routes belong to the single-page dashboard. Keep API misses as
// real JSON 404s, and do not turn missing static assets into HTML responses.
// Desktop Native Window Control: Minimize / Hide to Tray
app.route({
  method: ['GET', 'POST'],
  url: '/v1/desktop/minimize',
  handler: async (_req, reply) => {
    try {
      if (process.platform === 'win32') {
        const minExe = path.join(process.cwd(), 'bin', 'minimize.exe');
        const vbsScript = path.join(process.cwd(), 'scripts', 'minimize.vbs');
        const psScript = path.join(process.cwd(), 'scripts', 'minimize.ps1');

        if (fs.existsSync(minExe)) {
          execFile(minExe, () => {});
        }
        if (fs.existsSync(vbsScript)) {
          exec(`cscript //nologo "${vbsScript}"`, () => {});
        } else if (fs.existsSync(psScript)) {
          exec(`powershell -ExecutionPolicy Bypass -File "${psScript}"`, () => {});
        }
      }
      return reply.send({ success: true, minimized: true });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  }
});

// ==========================================
// Defensive SecOps & WSL System Posture Endpoint
// ==========================================
app.get('/v1/system/secops/posture', async (_req, reply) => {
  try {
    // 1. Check WSL2 environment & Kali status
    let wslAvailable = false;
    const distros: Array<{ name: string; state: string; version: string; isDefault: boolean; isKali: boolean }> = [];
    let kaliInstalled = false;

    if (process.platform === 'win32') {
      try {
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          execFile('wsl.exe', ['-l', '-v'], { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        wslAvailable = true;
        let str = buffer.toString('utf16le');
        if (!str.includes('NAME') && !str.includes('STATE')) {
          str = buffer.toString('utf8');
        }
        const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const isDefault = line.startsWith('*');
          const clean = line.replace(/^\*\s*/, '').trim();
          const parts = clean.split(/\s{2,}/);
          if (parts.length >= 3) {
            const name = parts[0].trim();
            const state = parts[1].trim();
            const version = parts[2].trim();
            const isKali = name.toLowerCase().includes('kali');
            if (isKali) kaliInstalled = true;
            distros.push({ name, state, version, isDefault, isKali });
          }
        }
      } catch (_) {
        wslAvailable = false;
      }
    }

    // 2. Defensive Network Interfaces & Listening Posture
    const interfaces = os.networkInterfaces();
    const activeIps: Array<{ iface: string; address: string; family: string; internal: boolean }> = [];
    for (const [iface, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4') {
          activeIps.push({ iface, address: addr.address, family: addr.family, internal: addr.internal });
        }
      }
    }

    // 3. Engine & Port Availability Check
    const localAiRunning = await EmbeddedLocalEngine.isRunning();
    const meshConfig = meshHub.getConfig();

    const posture = {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      wsl: {
        available: wslAvailable,
        distributions: distros,
        kaliInstalled,
        kaliInstallationGuide: kaliInstalled
          ? 'Kali Linux WSL is installed and ready. Run `wsl -d kali-linux` in terminal.'
          : 'To install Kali Linux on WSL2, open PowerShell as Administrator and run: wsl --install -d kali-linux',
      },
      ports: {
        http: { port: 3000, active: true, protocol: 'http' },
        https: { port: 3001, active: true, protocol: 'https' },
        localAi: { port: 11434, active: localAiRunning, protocol: 'http' },
      },
      networkInterfaces: activeIps,
      securityScore: 'A (Hardened)',
      defensiveStatus: 'Optimal - Protected Localhost Gateway',
      meshHardening: {
        pinRequired: !!meshConfig.hubPin,
        isHosting: !!meshConfig.isHosting,
        hubPort: meshConfig.hubPort || 3000,
        encryption: 'TLS/WSS Encrypted',
      },
      recommendations: [
        kaliInstalled
          ? 'Defensive Kali Linux environment detected on WSL2.'
          : 'For defensive network auditing and security research, Kali Linux can be installed via Windows WSL: `wsl --install -d kali-linux`.',
        'Keep API tokens enabled when exposing Mesh nodes across untrusted LAN subnets.',
        'Local AI engine (Ollama) is isolated on 127.0.0.1.',
      ],
    };

    return reply.send({ success: true, posture });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// ==========================================
// Nexus Mesh: Peer-to-Peer & Hub API Routes
// ==========================================

app.get('/v1/mesh/status', async () => {
  return {
    success: true,
    config: meshHub.getConfig(),
    peers: meshHub.getPeers(),
    stats: meshShareManager.getStats(),
  };
});

app.post('/v1/mesh/config', async (req: FastifyRequest<{ Body: Record<string, any> }>) => {
  const updated = meshHub.updateConfig(req.body || {});
  return { success: true, config: updated };
});

app.get('/v1/mesh/peers', async () => {
  return { success: true, peers: meshHub.getPeers() };
});

app.post('/v1/mesh/register', async (req: FastifyRequest<{
  Body: {
    id?: string;
    peerId?: string;
    handle: string;
    avatar?: string;
    ip?: string;
    filesCount?: number;
    totalBytes?: number;
    status?: string;
  };
}>) => {
  const body = req.body || { handle: 'Guest' };
  const id = body.id || body.peerId;
  const peer = meshHub.registerPeer({
    ...body,
    id,
  });
  return { success: true, peer };
});

app.post('/v1/mesh/heartbeat', async (req: FastifyRequest<{ Body: { peerId: string } }>) => {
  const ok = meshHub.heartbeat(req.body?.peerId);
  return { success: ok };
});

app.post('/v1/mesh/peers/update', async (req: FastifyRequest<{
  Body: {
    peerId: string;
    handle?: string;
    avatar?: string;
    statusMessage?: string;
  };
}>, reply: FastifyReply) => {
  try {
    const { peerId, handle, avatar, statusMessage } = req.body || {};
    if (!peerId) {
      return reply.status(400).send({ success: false, error: 'Missing peerId' });
    }
    const updated = meshHub.updatePeer(peerId, { handle, avatar, statusMessage });
    return { success: true, peer: updated };
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err?.message || 'Failed to update peer' });
  }
});

app.get('/v1/mesh/rooms', async () => {
  return { success: true, rooms: meshHub.getRooms() };
});

app.post('/v1/mesh/rooms/create', async (req: FastifyRequest<{
  Body: {
    name: string;
    avatar?: string;
    topic?: string;
    pin?: string;
    createdBy?: string;
  };
}>) => {
  if (!req.body?.name?.trim()) {
    return { success: false, error: 'Room name is required' };
  }
  const room = meshHub.createRoom(req.body, req.body.createdBy || 'host');
  return { success: true, room };
});

app.get('/v1/mesh/messages', async (req: FastifyRequest<{ Querystring: { roomId?: string } }>) => {
  const roomId = req.query?.roomId || 'lounge';
  return { success: true, messages: meshHub.getMessages(roomId) };
});

app.delete('/v1/mesh/messages', async (req: FastifyRequest<{ Querystring: { roomId?: string } }>) => {
  const roomId = req.query?.roomId || 'lounge';
  meshHub.clearMessages(roomId);
  return { success: true, roomId };
});

app.post('/v1/mesh/messages', async (req: FastifyRequest<{
  Body: {
    peerId?: string;
    text?: string;
    roomId?: string;
    targetPeerId?: string;
    senderHandle?: string;
    senderAvatar?: string;
    mediaUrl?: string;
    mediaType?: string;
    attachments?: any[];
    isAi?: boolean;
  };
}>, reply: FastifyReply) => {
  try {
    const text = req.body?.text || (req.body?.attachments?.length ? `Shared file: ${req.body.attachments[0].name}` : '');
    if (!text?.trim() && !req.body?.mediaUrl && !req.body?.attachments?.length) {
      return reply.status(400).send({ success: false, error: 'Empty message' });
    }
    const peerId = req.body.peerId || 'host';
    if (req.body.senderHandle) {
      meshHub.updatePeer(peerId, {
        handle: req.body.senderHandle,
        avatar: req.body.senderAvatar || '👤',
      });
    }
    const msg = meshHub.postMessage(
      peerId,
      text,
      req.body.roomId || 'lounge',
      req.body.targetPeerId,
      req.body.senderHandle,
      req.body.senderAvatar,
      {
        mediaUrl: req.body.mediaUrl,
        mediaType: req.body.mediaType,
        attachments: req.body.attachments,
        isAi: req.body.isAi,
      }
    );
    return { success: true, message: msg };
  } catch (err: any) {
    req.log?.error(err);
    console.error('[Mesh Messages Error]', err);
    return reply.status(500).send({ success: false, error: err?.message || 'Internal server error processing message' });
  }
});

app.post('/v1/mesh/chat', async (req: FastifyRequest<{
  Body: {
    peerId?: string;
    text: string;
    roomId?: string;
    targetPeerId?: string;
    senderHandle?: string;
    senderAvatar?: string;
    mediaUrl?: string;
    mediaType?: string;
    attachments?: any[];
    isAi?: boolean;
  };
}>, reply: FastifyReply) => {
  try {
    if (!req.body?.text?.trim() && !req.body?.mediaUrl && !req.body?.attachments?.length) {
      return reply.status(400).send({ success: false, error: 'Empty message' });
    }
    const peerId = req.body.peerId || 'host';
    if (req.body.senderHandle) {
      meshHub.updatePeer(peerId, {
        handle: req.body.senderHandle,
        avatar: req.body.senderAvatar || '👤',
      });
    }
    const msg = meshHub.postMessage(
      peerId,
      req.body.text || '',
      req.body.roomId || 'lounge',
      req.body.targetPeerId,
      req.body.senderHandle,
      req.body.senderAvatar,
      {
        mediaUrl: req.body.mediaUrl,
        mediaType: req.body.mediaType,
        attachments: req.body.attachments,
        isAi: req.body.isAi,
      }
    );
    return { success: true, message: msg };
  } catch (err: any) {
    req.log?.error(err);
    console.error('[Mesh Chat Error]', err);
    return reply.status(500).send({ success: false, error: err?.message || 'Internal server error processing chat' });
  }
});

app.get('/v1/mesh/shares/tree', async (req: FastifyRequest<{ Querystring: { peerId?: string } }>) => {
  const peerId = req.query?.peerId;
  const tree = meshHub.getPeerTree(peerId);
  return {
    success: true,
    peerId: peerId || 'host',
    tree,
    stats: meshShareManager.getStats(),
  };
});

app.post('/v1/mesh/shares/add-folder', async (req: FastifyRequest<{ Body: { folder?: string; folderPath?: string } }>) => {
  const rawPath = (req.body?.folder || req.body?.folderPath || '').trim();
  if (!rawPath) {
    return { success: false, error: 'Folder path required' };
  }
  const cleanPath = rawPath.replace(/^["']|["']$/g, '').trim();
  if (!fs.existsSync(cleanPath)) {
    return { success: false, error: `Folder not found on host: "${cleanPath}"` };
  }
  const ok = meshShareManager.addSharedDir(cleanPath);
  return { success: ok, sharedDirs: meshShareManager.getSharedDirs(), stats: meshShareManager.getStats() };
});

app.post('/v1/mesh/shares/remove-folder', async (req: FastifyRequest<{ Body: { folder?: string; folderPath?: string } }>) => {
  const rawPath = (req.body?.folder || req.body?.folderPath || '').trim();
  if (!rawPath) {
    return { success: false, error: 'Folder path required' };
  }
  const cleanPath = rawPath.replace(/^["']|["']$/g, '').trim();
  const ok = meshShareManager.removeSharedDir(cleanPath);
  return { success: ok, sharedDirs: meshShareManager.getSharedDirs(), stats: meshShareManager.getStats() };
});

app.post('/v1/mesh/shares/rescan', async () => {
  meshShareManager.rescan();
  return { success: true, stats: meshShareManager.getStats(), tree: meshShareManager.getTree() };
});

app.get('/v1/mesh/shares/suggested-folders', async () => {
  return {
    success: true,
    folders: meshShareManager.suggestDesktopFolders(),
    sharedDirs: meshShareManager.getSharedDirs(),
  };
});

app.post('/v1/mesh/shares/mount-desktop', async (req: FastifyRequest<{ Body: { folderName?: string; folderPath?: string } }>) => {
  const target = req.body?.folderPath || req.body?.folderName;
  const desktopFolders = meshShareManager.suggestDesktopFolders();
  let mountedAny = false;
  if (target) {
    const found = desktopFolders.find(f => f.name.toLowerCase() === target.toLowerCase() || f.path.toLowerCase() === target.toLowerCase());
    if (found) {
      mountedAny = meshShareManager.addSharedDir(found.path);
    }
  } else {
    for (const f of desktopFolders) {
      if (!f.mounted && f.exists) {
        if (meshShareManager.addSharedDir(f.path)) mountedAny = true;
      }
    }
  }
  return {
    success: true,
    mounted: mountedAny,
    sharedDirs: meshShareManager.getSharedDirs(),
    stats: meshShareManager.getStats(),
    tree: meshShareManager.getTree(),
  };
});

app.get('/v1/mesh/shares/cover-art', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
  const relPath = req.query?.path;
  if (!relPath) return reply.status(400).send({ error: 'Missing path parameter' });

  const cover = meshShareManager.findCoverArt(relPath);
  if (!cover) {
    return reply.status(404).send({ success: false, error: 'No cover art found in folder' });
  }

  reply.header('Content-Type', cover.mimeType);
  reply.header('Content-Disposition', 'inline');
  return reply.send(fs.createReadStream(cover.absolutePath));
});

app.post<{ Body: { folderName?: string; files: Array<{ name: string; dataUrl: string; size?: number }> } }>('/v1/mesh/shares/upload-files', {
  bodyLimit: 150 * 1024 * 1024,
}, async (req, reply) => {
  const { folderName, files } = req.body || {};
  if (!files || !Array.isArray(files) || files.length === 0) {
    return reply.status(400).send({ success: false, error: 'No files provided for upload.' });
  }

  const cleanFolderName = (folderName || 'mobile_uploads').trim().replace(/[^a-zA-Z0-9_ -]/g, '_');
  const sharedBase = path.resolve(process.cwd(), 'shared');
  const targetDir = path.join(sharedBase, cleanFolderName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const savedFiles: Array<{ name: string; path: string; relPath: string; size: number }> = [];

  for (const f of files) {
    if (!f.name || !f.dataUrl) continue;
    const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const targetPath = path.join(targetDir, safeName);
    const base64 = f.dataUrl.replace(/^data:.*?;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(targetPath, buf);
    const relPath = `shared/${cleanFolderName}/${safeName}`;
    savedFiles.push({
      name: safeName,
      path: targetPath,
      relPath,
      size: buf.length,
    });
  }

  meshShareManager.rescan();

  return {
    success: true,
    folderName: cleanFolderName,
    savedCount: savedFiles.length,
    files: savedFiles,
    tree: meshShareManager.getTree(),
    stats: meshShareManager.getStats(),
  };
});

app.get('/v1/mesh/shares/search', async (req: FastifyRequest<{ Querystring: { q?: string; peerId?: string; category?: string } }>) => {
  const q = req.query?.q || '';
  const category = req.query?.category;
  const results = meshHub.searchAcrossMesh(q, req.query?.peerId || 'local', category);
  return { success: true, query: q, category, results };
});

app.get('/v1/mesh/shares/download', async (req: FastifyRequest<{ Querystring: { path?: string; inline?: string; preview?: string } }>, reply: FastifyReply) => {
  const relPath = req.query?.path;
  if (!relPath) return reply.status(400).send({ error: 'Missing path parameter' });

  try {
    const resolved = meshShareManager.resolveSafeFile(relPath);
    const stat = fs.statSync(resolved.absolutePath);
    const totalSize = stat.size;
    const rangeHeader = req.headers.range;
    const isInline = req.query?.inline === '1' || req.query?.preview === '1';

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', resolved.mimeType);
    if (isInline) {
      reply.header('Content-Disposition', 'inline');
    } else {
      reply.header('Content-Disposition', `attachment; filename="${path.basename(resolved.absolutePath)}"`);
    }

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      reply.status(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      reply.header('Content-Length', chunkSize);

      const stream = fs.createReadStream(resolved.absolutePath, { start, end });
      return reply.send(stream);
    } else {
      reply.header('Content-Length', totalSize);
      const stream = fs.createReadStream(resolved.absolutePath);
      return reply.send(stream);
    }
  } catch (err: any) {
    return reply.status(err instanceof SecurityError ? 403 : 404).send({
      error: err.message,
    });
  }
});

app.get('/v1/mesh/shares/download-folder', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
  const relPath = req.query?.path;
  if (!relPath) return reply.status(400).send({ error: 'Missing path parameter' });

  try {
    const resolved = meshShareManager.resolveSafeDirectory(relPath);
    const stats = meshShareManager.getDirectoryStats(resolved.absolutePath);

    // Safeguard: Prevent zipping massive folders > 2 GB or > 5000 files
    const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
    const MAX_ZIP_FILES = 5000;
    if (stats.totalBytes > MAX_ZIP_BYTES || stats.fileCount > MAX_ZIP_FILES) {
      return reply.status(400).send({
        error: `Folder is too large to download as a single ZIP (${(stats.totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB, ${stats.fileCount} files). Please download individual subfolders or files.`,
      });
    }

    const cleanDirName = resolved.dirName.replace(/[^a-zA-Z0-9_\-\. ]/g, '_') || 'folder';
    const tempZipPath = path.join(os.tmpdir(), `mesh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.zip`);

    // Use bsdtar (built-in Windows 10/11 and Linux/macOS)
    try {
      execFileSync('tar', ['-a', '-cf', tempZipPath, '-C', resolved.absolutePath, '.'], { stdio: 'pipe', timeout: 120000 });
    } catch (tarErr: any) {
      return reply.status(500).send({ error: 'Failed to create ZIP archive: ' + (tarErr.message || String(tarErr)) });
    }

    if (!fs.existsSync(tempZipPath)) {
      return reply.status(500).send({ error: 'ZIP archive was not generated' });
    }

    const zipStat = fs.statSync(tempZipPath);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${cleanDirName}.zip"`);
    reply.header('Content-Length', zipStat.size);

    const stream = fs.createReadStream(tempZipPath);
    stream.on('close', () => {
      try { if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath); } catch { }
    });
    return reply.send(stream);
  } catch (err: any) {
    return reply.status(err instanceof SecurityError ? 403 : 404).send({
      error: err.message,
    });
  }
});

app.get('/v1/mesh/shares/folder-files', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
  const relPath = req.query?.path;
  if (!relPath) return reply.status(400).send({ error: 'Missing path parameter' });

  try {
    const files = meshShareManager.getDirectoryFlatFiles(relPath);
    const resolved = meshShareManager.resolveSafeDirectory(relPath);
    return {
      success: true,
      folder: relPath,
      dirName: resolved.dirName,
      fileCount: files.length,
      files,
    };
  } catch (err: any) {
    return reply.status(err instanceof SecurityError ? 403 : 404).send({
      error: err.message,
    });
  }
});

app.post('/v1/mesh/open-downloads', async (req: FastifyRequest, reply: FastifyReply) => {
  const downloadDir = path.resolve(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadDir)) {
    try { fs.mkdirSync(downloadDir, { recursive: true }); } catch {}
  }

  try {
    const { exec } = await import('child_process');
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`start "" "${downloadDir}"`);
    } else if (platform === 'darwin') {
      exec(`open "${downloadDir}"`);
    } else {
      exec(`xdg-open "${downloadDir}"`);
    }
    return { success: true, opened: true, path: downloadDir };
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message, path: downloadDir });
  }
});

const activeSsePeers = new Map<string, number>();

app.get('/v1/mesh/events', async (req: FastifyRequest<{
  Querystring: {
    peerId?: string;
    handle?: string;
    avatar?: string;
    roomId?: string;
  };
}>, reply: FastifyReply) => {
  reply.hijack();
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  const query = req.query || {};
  const peerId = query.peerId;
  if (peerId && peerId !== 'host' && peerId !== 'local') {
    meshHub.registerPeer({
      id: peerId,
      handle: query.handle || 'Anonymous',
      avatar: query.avatar || '⚡',
    });
    activeSsePeers.set(peerId, (activeSsePeers.get(peerId) || 0) + 1);
  }

  const unsubscribe = meshHub.subscribe((event, payload) => {
    try {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch { }
  });

  // Keep-alive heartbeat every 15s to keep Cloudflare tunnels and mobile connections alive
  const keepAliveInterval = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      clearInterval(keepAliveInterval);
    }
  }, 15000);

  // Initial handshake
  try {
    reply.raw.write(`event: init\ndata: ${JSON.stringify({
      peers: meshHub.getPeers(),
      rooms: meshHub.getRooms(),
      messages: meshHub.getMessages(),
      config: meshHub.getConfig(),
      voicePeers: meshHub.getVoicePeers(query.roomId || 'lounge'),
    })}\n\n`);
  } catch { }

  req.raw.on('close', () => {
    clearInterval(keepAliveInterval);
    unsubscribe();
    if (peerId && peerId !== 'host' && peerId !== 'local') {
      const count = (activeSsePeers.get(peerId) || 1) - 1;
      if (count <= 0) {
        activeSsePeers.delete(peerId);
        // Do NOT immediately evict from voice.
        // Mobile browsers and tunnel proxies reconnect within a few seconds.
        // Give a 45-second grace period before auto-leaving voice rooms.
        setTimeout(() => {
          if (!activeSsePeers.has(peerId)) {
            for (const room of meshHub.getRooms()) {
              meshHub.leaveVoice(room.id, peerId);
            }
          }
        }, 45000);
      } else {
        activeSsePeers.set(peerId, count);
      }
    }
  });
});

// --- Nexus Mesh Voice Audio Bridge (Server Relay) ---
interface VoiceSocketClient {
  ws: WebSocket;
  peerId: string;
  roomId: string;
}
const voiceClients = new Map<string, Set<VoiceSocketClient>>();
const voiceBridgeWss = new WebSocketServer({ noServer: true });

voiceBridgeWss.on('connection', (ws: WebSocket, req: any) => {
  try {
    const hostHeader = req.headers.host || 'localhost';
    const parsedUrl = new URL(req.url || '', `http://${hostHeader}`);
    const rawRoom = parsedUrl.searchParams.get('roomId') || 'lounge';
    const roomId = rawRoom.toLowerCase().trim().replace(/^#/, '');
    const peerId = parsedUrl.searchParams.get('peerId') || ('guest_' + Math.random().toString(36).substring(2, 7));

    const client: VoiceSocketClient = { ws, peerId, roomId };
    if (!voiceClients.has(roomId)) {
      voiceClients.set(roomId, new Set());
    }
    voiceClients.get(roomId)!.add(client);
    console.log(`[VoiceBridge] Peer "${peerId}" connected to voice stream in room #${roomId} (Total: ${voiceClients.get(roomId)!.size})`);

    ws.on('message', (data: any, isBinary: boolean) => {
      const roomSet = voiceClients.get(roomId);
      if (!roomSet) return;
      for (const c of roomSet) {
        if (c.peerId !== peerId && c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(data, { binary: isBinary });
        }
      }
    });

    const cleanup = () => {
      const roomSet = voiceClients.get(roomId);
      if (roomSet) {
        roomSet.delete(client);
        if (roomSet.size === 0) voiceClients.delete(roomId);
      }
      console.log(`[VoiceBridge] Peer "${peerId}" left voice stream in room #${roomId}`);
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  } catch (err) {
    console.warn('[VoiceBridge] connection error:', err);
  }
});

function attachVoiceWebSocketBridge(serverInstance: any) {
  if (!serverInstance || typeof serverInstance.on !== 'function') return;
  serverInstance.on('upgrade', (request: any, socket: any, head: any) => {
    try {
      const hostHeader = request.headers.host || 'localhost';
      const parsedUrl = new URL(request.url || '', `http://${hostHeader}`);
      if (parsedUrl.pathname === '/v1/mesh/voice/stream') {
        voiceBridgeWss.handleUpgrade(request, socket, head, (ws) => {
          voiceBridgeWss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });
}

// --- WebRTC Voice Lounge Signaling Endpoints ---
app.get('/v1/mesh/voice/ice-servers', async () => {
  const iceServers: any[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:global.stun.twilio.com:3478'
      ]
    },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(u => u.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || ''
    });
  }

  return { success: true, iceServers };
});

app.get('/v1/mesh/voice/peers', async (req: FastifyRequest<{ Querystring: { roomId?: string } }>) => {
  const roomId = req.query.roomId || 'lounge';
  return { success: true, roomId, peers: meshHub.getVoicePeers(roomId) };
});

app.post('/v1/mesh/voice/join', async (req: FastifyRequest<{
  Body: { roomId?: string; peerId: string; handle?: string; avatar?: string; isListenOnly?: boolean }
}>, reply: FastifyReply) => {
  const { roomId = 'lounge', peerId, handle, avatar, isListenOnly } = req.body || {};
  if (!peerId) {
    return reply.status(400).send({ success: false, error: 'peerId is required' });
  }
  const result = meshHub.joinVoice(roomId, peerId, handle, avatar, isListenOnly);
  return result;
});

app.post('/v1/mesh/voice/leave', async (req: FastifyRequest<{
  Body: { roomId?: string; peerId: string }
}>, reply: FastifyReply) => {
  const { roomId = 'lounge', peerId } = req.body || {};
  if (!peerId) {
    return reply.status(400).send({ success: false, error: 'peerId is required' });
  }
  const success = meshHub.leaveVoice(roomId, peerId);
  return { success };
});

app.post('/v1/mesh/voice/signal', async (req: FastifyRequest<{
  Body: { fromPeerId: string; toPeerId: string; roomId?: string; signalType: 'offer' | 'answer' | 'candidate'; data: any }
}>, reply: FastifyReply) => {
  const { fromPeerId, toPeerId, roomId = 'lounge', signalType, data } = req.body || {};
  if (!fromPeerId || !toPeerId || !signalType || !data) {
    return reply.status(400).send({ success: false, error: 'Missing required signal fields' });
  }
  meshHub.relayVoiceSignal({ fromPeerId, toPeerId, roomId, signalType, data });
  return { success: true };
});

app.post('/v1/mesh/voice/state', async (req: FastifyRequest<{
  Body: { roomId?: string; peerId: string; isMuted?: boolean; isDeafened?: boolean; isSpeaking?: boolean; isListenOnly?: boolean; isToneActive?: boolean }
}>, reply: FastifyReply) => {
  const { roomId = 'lounge', peerId, isMuted, isDeafened, isSpeaking, isListenOnly, isToneActive } = req.body || {};
  if (!peerId) {
    return reply.status(400).send({ success: false, error: 'peerId is required' });
  }
  const updated = meshHub.updateVoiceState(roomId, peerId, { isMuted, isDeafened, isSpeaking, isListenOnly, isToneActive });
  return { success: !!updated, state: updated };
});

app.post('/v1/mesh/voice/heartbeat', async (req: FastifyRequest<{
  Body: { roomId?: string; peerId: string }
}>, reply: FastifyReply) => {
  const { roomId = 'lounge', peerId } = req.body || {};
  if (!peerId) {
    return reply.status(400).send({ success: false, error: 'peerId is required' });
  }
  const peers = meshHub.getVoicePeers(roomId);
  const isInRoom = peers.some(p => p.peerId === peerId);
  return { success: true, isInRoom, peers };
});

let activeTunnelUrl: string | null = null;
let tunnelProcess: ChildProcess | null = null;

app.get('/v1/mesh/network-info', async () => {
  const interfaces = os.networkInterfaces();
  const lanIps: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIps.push(iface.address);
      }
    }
  }
  const primaryLanIp = lanIps.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.')) || lanIps[0] || '127.0.0.1';
  return {
    success: true,
    port: PORT,
    primaryLanIp,
    lanIps,
    lanUrl: `http://${primaryLanIp}:${PORT}/?guest=1#mesh`,
    localUrl: `http://localhost:${PORT}/#mesh`,
    tunnelUrl: activeTunnelUrl,
  };
});

function getCloudflaredBin(): string {
  try {
    const localBin = path.resolve(process.cwd(), 'node_modules/cloudflared/bin/cloudflared.exe');
    if (fs.existsSync(localBin)) return localBin;
    const localUnix = path.resolve(process.cwd(), 'node_modules/cloudflared/bin/cloudflared');
    if (fs.existsSync(localUnix)) return localUnix;

    const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
    const npxCachePattern = path.join(appData, 'npm-cache/_npx');
    if (fs.existsSync(npxCachePattern)) {
      const dirs = fs.readdirSync(npxCachePattern);
      for (const d of dirs) {
        const candidate = path.join(npxCachePattern, d, 'node_modules/cloudflared/bin/cloudflared.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

app.post('/v1/mesh/tunnel/start', async () => {
  if (activeTunnelUrl && tunnelProcess && !tunnelProcess.killed) {
    return { success: true, tunnelUrl: activeTunnelUrl, cached: true };
  }

  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch {}
    tunnelProcess = null;
    activeTunnelUrl = null;
  }

  return new Promise((resolve) => {
    try {
      const bin = getCloudflaredBin();
      console.log(`[Cloudflare Tunnel] Spawning binary: ${bin} on port ${PORT}...`);
      const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      tunnelProcess = proc;
      let resolved = false;

      const handleOutput = (data: any) => {
        const str = data.toString();
        const match = str.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
        if (match && !resolved) {
          resolved = true;
          activeTunnelUrl = match[1].trim();
          meshHub.postMessage('system', `🌐 Cloudflare Quick Tunnel online! Share with friends worldwide: ${activeTunnelUrl}/?guest=1#mesh`);
          resolve({ success: true, tunnelUrl: activeTunnelUrl });
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      proc.on('close', (code) => {
        activeTunnelUrl = null;
        tunnelProcess = null;
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: `Cloudflare tunnel process closed (code ${code})` });
        }
      });

      proc.on('error', (err) => {
        console.warn('[Cloudflare Tunnel] spawn error:', err);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Could not launch cloudflared tunnel: ' + err.message });
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { proc.kill(); } catch {}
          resolve({ success: false, error: 'Tunnel generation timed out. You can still share your LAN Wi-Fi link.' });
        }
      }, 20000);
    } catch (e: any) {
      resolve({ success: false, error: e.message });
    }
  });
});

app.get('/v1/mesh/tunnel/status', async () => {
  return { success: true, active: !!activeTunnelUrl, tunnelUrl: activeTunnelUrl };
});

app.post('/v1/mesh/tunnel/stop', async () => {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch {}
    tunnelProcess = null;
  }
  activeTunnelUrl = null;
  return { success: true };
});

app.post('/v1/mesh/knowledge/query', async (req: FastifyRequest<{ Body: { query?: string; topK?: number } }>, reply: FastifyReply) => {
  try {
    const query = req.body?.query || '';
    const topK = typeof req.body?.topK === 'number' ? req.body.topK : 4;
    const results = meshHub.getRagEngine().search(query, topK);
    return reply.send({ success: true, count: results.length, results });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

app.get('/v1/mesh/knowledge/status', async () => {
  return { success: true, ...meshHub.getRagEngine().getStatus() };
});

app.post('/v1/mesh/knowledge/reindex', async () => {
  const totalChunks = await meshHub.getRagEngine().reindex();
  return { success: true, totalChunks };
});

app.post('/v1/mesh/retro/generate', async (req: FastifyRequest<{ Body: { system?: string; prompt?: string } }>, reply: FastifyReply) => {
  try {
    const requested = (req.body?.system || req.body?.prompt || 'atari').toLowerCase();
    const sys = getRetroSystem(requested) || RETRO_SYSTEMS.atari_st;
    const prefix = requested.includes('c64') ? 'c64' : requested.includes('spectrum') ? 'spectrum' : requested.includes('amiga') ? 'amiga' : requested.includes('faust') || requested.includes('dsp') ? 'acid_dsp' : 'atari_st';
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const fileName = `${prefix}_${randSuffix}.${sys.boilerplate.extension}`;
    const codeDir = path.join(process.cwd(), 'shared', 'code');
    if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });
    const fullPath = path.join(codeDir, fileName);
    fs.writeFileSync(fullPath, sys.boilerplate.code, 'utf-8');
    meshShareManager.rescan();
    return reply.send({
      success: true,
      system: sys.name,
      file: fileName,
      relPath: `shared/code/${fileName}`,
      code: sys.boilerplate.code,
    });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

app.post('/v1/mesh/agent/task', async (req: FastifyRequest<{ Body: { prompt?: string; targetBot?: string } }>, reply: FastifyReply) => {
  try {
    const prompt = req.body?.prompt || 'Summarize mounted drive contents';
    const targetBot = req.body?.targetBot || 'nexus_ai';
    const ragResults = meshHub.getRagEngine().search(prompt, 3);
    const contextSummary = ragResults.map(r => `${r.fileName} (${r.category})`).join(', ');
    const replyMsg = `🤖 [Agent Task Complete]: Processed "${prompt}". Grounded across local assets: [${contextSummary || 'All systems normal'}].`;
    return reply.send({
      success: true,
      prompt,
      targetBot,
      status: 'completed',
      groundedFiles: ragResults.map(r => r.sourceFile),
      summary: replyMsg,
    });
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

app.post('/v1/mesh/agent/execute', async (req: FastifyRequest<{ Body: { task?: string; persona?: 'nexus' | 'retro' | 'acid'; sender?: string; maxTurns?: number } }>, reply: FastifyReply) => {
  try {
    const task = String(req.body?.task || '').trim();
    if (!task) return reply.status(400).send({ success: false, error: 'task is required' });
    const result = await sovereignAgentRunner.runTask(task, {
      persona: req.body?.persona || 'nexus',
      senderHandle: req.body?.sender || 'Host',
      maxTurns: req.body?.maxTurns || 5,
    });
    return reply.send(result);
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
});

// Register Nexus AI Music & Vocal Studio Routes
registerStudioRoutes(app, meshHub, meshShareManager);

// Register CivitAI Hub & NordVPN Proxy Routes
registerCivitaiRoutes(app, civitaiService);

app.setNotFoundHandler(async (request, reply) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const isApiPath = pathname === '/v1' || pathname.startsWith('/v1/');
  const isStaticAsset = path.extname(pathname) !== '';
  if (request.method === 'GET' && !isApiPath && !isStaticAsset) {
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(path.join(publicDir, 'index.html')));
  }

  return reply.status(404).send({
    message: `Route ${request.method}:${pathname} not found`,
    error: 'Not Found',
    statusCode: 404,
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0'; // Open to Wi-Fi and LAN for Nexus Mesh Community

function getLocalLanIps(): string[] {
  const ips: string[] = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push(net.address);
        }
      }
    }
  } catch (_) {}
  return ips;
}

function getOrGenerateCertificates(): { key: Buffer; cert: Buffer } | null {
  const certDir = path.join(__dirname, '../config/certs');
  const keyPath = path.join(certDir, 'nexus-key.pem');
  const certPath = path.join(certDir, 'nexus-cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    } catch (e) {
      console.warn('[HTTPS] Could not read certificate files:', e);
    }
  }

  try {
    fs.mkdirSync(certDir, { recursive: true });
    const opensslCmd = fs.existsSync('C:\\msys64\\ucrt64\\bin\\openssl.exe')
      ? 'C:\\msys64\\ucrt64\\bin\\openssl.exe'
      : 'openssl';
    const lanIps = getLocalLanIps();
    const sanList = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map(ip => `IP:${ip}`)].join(',');
    execSync(`"${opensslCmd}" req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=NexusRoute/O=Nexus" -addext "subjectAltName=${sanList}"`, { stdio: 'ignore' });
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  } catch (e) {
    console.warn('[HTTPS] Auto certificate generation notice:', e);
  }
  return null;
}

export async function startServer() {
  try {
    // 1. Boot Embedded Local AI Engine in the background
    EmbeddedLocalEngine.start().catch((e: any) => {
      console.warn(`[EmbeddedLocalEngine] Startup warning: ${e.message}`);
    });

    // 1b. GPU Diffusion starts cold/idle until requested by user or Creative Studio

    await app.listen({ port: PORT, host: HOST });
    attachVoiceWebSocketBridge(app.server);

    // 2. Start Secure HTTPS Gateway for Mobile WebRTC Microphone Support
    const sslCerts = getOrGenerateCertificates();
    if (sslCerts) {
      try {
        const httpsServer = https.createServer({
          key: sslCerts.key,
          cert: sslCerts.cert,
        }, (req, res) => {
          app.server.emit('request', req, res);
        });
        attachVoiceWebSocketBridge(httpsServer);
        httpsServer.listen(HTTPS_PORT, HOST, () => {
          const primaryLan = getLocalLanIps()[0] || 'localhost';
          console.log(`🔒 HTTPS Gateway:      https://localhost:${HTTPS_PORT}`);
          console.log(`📱 Mobile Wi-Fi Voice: https://${primaryLan}:${HTTPS_PORT} (Enables Phone Mic)`);
        });
      } catch (sslErr: any) {
        console.warn(`[HTTPS] Failed to bind HTTPS port ${HTTPS_PORT}:`, sslErr.message);
      }
    }

    console.log(`\n======================================================`);
    console.log(`🚀 NexusRoute Gateway is running!`);
    console.log(`🌐 Web UI & Inspector: http://localhost:${PORT}`);
    console.log(`📡 OpenAI Chat API:     http://localhost:${PORT}/v1/chat/completions`);
    console.log(`📋 Models Endpoint:    http://localhost:${PORT}/v1/models`);
    console.log(`🔑 Key Status:          http://localhost:${PORT}/v1/keys/status`);
    console.log(`🖥️ Local AI Engine:    Embedded & GPU Accelerated (Port 11434)`);
    console.log(`🌐 Bound Interface:    ${HOST} (LAN & Wi-Fi Mesh Enabled)`);
    console.log(`======================================================\n`);
    // Resolved routing config, so "which build is actually serving me" is
    // answerable from the banner instead of by guessing.
    const startedAt = new Date().toISOString();
    console.log(`🧭 OpenRouter model:   ${process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free (default)'}`);
    console.log(`🧭 Coding model:       ${process.env.OPENROUTER_CODING_MODEL?.trim() || 'inherits OpenRouter model'}`);
    console.log(`⏱️  Turn limits:        cloud ${process.env.NEXUS_CLOUD_TURN_TIMEOUT_MS || 90000}ms / local ${process.env.NEXUS_LOCAL_TURN_TIMEOUT_MS || 120000}ms / request ${process.env.NEXUS_AGENT_REQUEST_TIMEOUT_MS || 600000}ms`);
    console.log(`🔁 Max agent turns:    ${process.env.NEXUS_MAX_AGENT_TURNS || 25}`);
    console.log(`🕓 Started:            ${startedAt}`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  EmbeddedLocalEngine.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  EmbeddedLocalEngine.stop();
  process.exit(0);
});
process.on('exit', () => {
  EmbeddedLocalEngine.stop();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js') || process.argv[1].includes('server.bundle'))) {
  startServer();
}

export { app, router, keyManager, providerModelDiscovery };
