import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { validateAndNormalizeRequest, ValidationError } from './ir/validator.js';
import { RoutingEngine, RouterConfig } from './router/engine.js';
import { MODEL_CATALOG } from './router/capabilities.js';
import { formatSseChunk, formatSseDone } from './streaming/sse-transformer.js';
import { MockAdapter } from './adapters/mock.js';
import { AdapterError } from './adapters/base.js';
import { ProviderType } from './ir/types.js';
import { KeyManager } from './auth/key-manager.js';
import { ToolRegistry } from './tools/registry.js';
import { adminAuth } from './security/auth.js';
import { isInsideDir, sanitizeWorkspacePath } from './security/path.js';
import { validatePublicHttpUrl } from './security/ssrf.js';
import { endlessForgeEngine } from './endless-forge/engine.js';
import { unloadOllamaModels } from './gpu/ollama.js';
import { FREE_PROVIDER_CATALOG, type QuotaUnit, type ResetInterval } from './providers/connection-manager.js';
import { getCompressionStats, listRawContexts, recoverRawContext } from './context/compression.js';
import { getMcpInfo, handleMcpMessage, type JsonRpcRequest } from './mcp/handler.js';
import { ProviderModelDiscovery } from './providers/model-discovery.js';
import { EmbeddedLocalEngine } from './engine/embedded-local.js';
import { LocalGpuArtEngine } from './engine/gpu-art.js';

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

function saveEnvFile(provider: string, apiKey: string) {
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
    github: 'GITHUB_TOKEN',
    together: 'TOGETHER_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
    qwen: 'QWEN_API_KEY',
    dashscope: 'QWEN_API_KEY',
  };

  const varName = envVarMap[provider.toLowerCase()];
  if (varName) {
    if (apiKey) {
      envMap[varName] = apiKey;
    } else {
      delete envMap[varName];
    }

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
const configuredBodyLimitMb = Number(process.env.NEXUS_BODY_LIMIT_MB || 12);
const bodyLimitMb = Number.isFinite(configuredBodyLimitMb)
  ? Math.max(2, Math.min(50, configuredBodyLimitMb))
  : 12;
const app = fastify({
  logger: false,
  // Vision requests carry base64 image data, which is ~33% larger than the
  // source screenshot. Keep the limit bounded but comfortably above a normal
  // desktop capture; the browser also downsizes images before sending them.
  bodyLimit: Math.round(bodyLimitMb * 1024 * 1024),
});

// Configure Secure CORS Policy (Same-Origin & Localhost by default)
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      cb(null, true);
    } else {
      cb(new Error('Blocked by CORS origin security policy.'), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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

// Helper for Admin Route Authentication
function verifyAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = (req.headers.authorization || req.headers['x-admin-key'] || '') as string;
  if (adminAuth.validate(authHeader)) {
    return true;
  }

  // Local loopback interface check: if caller is local and no custom ADMIN_API_KEY is enforced, allow
  const ip = req.ip;
  if ((ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') && !process.env.ADMIN_API_KEY) {
    return true;
  }

  reply.status(401).send({ error: 'Unauthorized: Admin authentication required.' });
  return false;
}

// Session Token Endpoint (for Local Web UI)
app.get('/v1/auth/session', async (req, reply) => {
  const ip = req.ip;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || !process.env.ADMIN_API_KEY) {
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
app.get('/v1/models', async () => {
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
});

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

app.post<{ Body: { provider: string; apiKey: string } }>('/v1/keys', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

  const { provider, apiKey } = req.body || {};
  if (!provider) {
    return reply.status(400).send({ error: 'Provider name required' });
  }

  const pType = provider.toLowerCase() as ProviderType;
  router.setApiKey(pType, apiKey || '');
  providerModelDiscovery.invalidate(pType);
  saveEnvFile(provider, apiKey || '');

  return {
    success: true,
    provider: pType,
    status: router.getProviderStatus()[pType],
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
        id: `local/${m.name}`,
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
    const files: Array<{ name: string; folder: string; isDirectory: boolean; size: number; modifiedAt: string; category: string }> = [];

    const scanRecursive = (currentDir: string, relPrefix = '', depth = 0) => {
      if (!fs.existsSync(currentDir) || depth > 4) return;
      const list = fs.readdirSync(currentDir);
      for (const item of list) {
        if (item === 'build' || item === 'node_modules' || item === '.git' || item === '.venv') continue;
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
        });

        if (st.isDirectory()) {
          scanRecursive(fullPath, relName, depth + 1);
        }
      }
    };

    scanRecursive(ws);
    return { workspacePath: ws, files };
  } catch (err: unknown) {
    return { workspacePath: ws, files: [], error: (err as Error).message };
  }
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

app.post<{ Body: { filename?: string } }>('/v1/workspace/open', async (req, reply) => {
  if (!verifyAdmin(req, reply)) return;

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
    const isDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const ext = path.extname(targetPath).toLowerCase();
    const relName = path.relative(ws, targetPath).replace(/\\/g, '/');
    const previewUrl = `/v1/workspace/files/${encodeURIComponent(relName)}`;

    if (isDir) {
      spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
    } else if (ext === '.html' || ext === '.htm' || ext === '.svg') {
      spawn('cmd.exe', ['/c', 'start', '""', targetPath], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    } else {
      spawn('explorer.exe', [`/select,${targetPath}`], { detached: true, stdio: 'ignore' });
    }
    return { success: true, target: targetPath, url: previewUrl };
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
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
    return reply.status(404).send({ error: 'File not found' });
  }

  const ext = path.extname(safePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.txt': 'text/plain',
  };
  const mime = mimeTypes[ext];
  if (mime && (mime.startsWith('image/') || mime === 'text/html')) {
    const stream = fs.createReadStream(safePath);
    return reply.type(mime).send(stream);
  }
  const content = fs.readFileSync(safePath, 'utf8');
  return reply.send({ filename: wildcard, content });
});

// Dedicated authenticated image proxy for PromptForge RTX images
app.get<{ Params: { filename: string } }>('/v1/promptforge/images/:filename', async (req, reply) => {
  const filename = req.params.filename;
  if (!filename) return reply.status(400).send({ error: 'Filename required' });

  const pfConfigPath = 'C:\\Users\\adria\\AppData\\Local\\PromptForgeRTX\\config.json';
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
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(30000) });
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
        const ext = contentType.includes('png') ? '.png' : '.jpg';
        const filename = `${pDesc}${ext}`;
        const savePath = path.join(artDir, filename);
        if (!fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, buffer);
        }
      } catch {}
    }

    reply.type(contentType);
    return reply.send(buffer);
  } catch (err: unknown) {
    return reply.status(500).send({ error: `Proxy fetch failed: ${(err as Error).message}` });
  }
});

// Dedicated Art & Avatar Generation Endpoint for Modelfile Studio & Chat
app.post<{ Body: { prompt: string; engine?: string; width?: number; height?: number; steps?: number; seed?: number } }>('/v1/art/generate', async (req, reply) => {
  const { prompt, engine = 'local-gpu', width = 512, height = 512, steps = 1, seed } = req.body || {};
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
        width: Math.min(width, 1024),
        height: Math.min(height, 1024),
        steps,
        seed,
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

// Hugging Face Trending GGUF Models Search Endpoint
app.get<{ Querystring: { q?: string; limit?: string } }>('/v1/hf/models', async (req, reply) => {
  const query = (req.query.q || 'gguf').trim();
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 50);
  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hfKey && !hfKey.startsWith('mock-')) {
      headers.Authorization = `Bearer ${hfKey}`;
    }

    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return reply.status(res.status).send({ error: `Hugging Face API returned ${res.status}` });
    }

    const models = await res.json() as Array<any>;
    const formatted = models.map(m => ({
      id: m.id || m._id,
      name: m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      lastModified: m.lastModified,
      ollamaPullRef: `hf.co/${m.id}`,
    }));

    return {
      success: true,
      query,
      hfKeyConfigured: !!(hfKey && !hfKey.startsWith('mock-')),
      models: formatted,
    };
  } catch (err: any) {
    return reply.status(500).send({ success: false, error: err.message });
  }
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

app.post<{ Body: { id: string; title?: string; messages: any[]; model?: string; telemetry?: any; active_file_targets?: string[] } }>('/v1/chats', async (req) => {
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

// Endless Forge Dedicated Endpoints
app.get('/v1/endless-forge/status', async () => {
  return { success: true, ...endlessForgeEngine.getStatus() };
});

app.get<{ Querystring: { since?: string } }>('/v1/endless-forge/poll', async (req) => {
  const sinceId = parseInt(req.query.since || '0', 10) || 0;
  return endlessForgeEngine.getPollData(sinceId);
});

app.post<{ Body: { action: string; theme?: string } }>('/v1/endless-forge/action', async (req, reply) => {
  const { action, theme } = req.body || {};
  if (!action) return reply.status(400).send({ error: 'Action required' });
  const result = await endlessForgeEngine.handleCommand(action, theme);
  return { success: true, ...result, status: endlessForgeEngine.getStatus() };
});

// OpenAI Compatible Chat Completions Endpoint
app.post('/v1/chat/completions', async (req, reply) => {
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
  const isAdmin = adminAuth.validate(authHeader);
  const isLoopbackUI = (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === 'localhost') && !process.env.ADMIN_API_KEY;

  if (!isAdmin && !isLoopbackUI) {
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
        if (chunk.usage?.estimated_cost_usd) {
          finalCost = chunk.usage.estimated_cost_usd;
        }
        reply.raw.write(formatSseChunk(chunk));
      }
      reply.raw.write(formatSseDone());
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
});

// Browser-side routes belong to the single-page dashboard. Keep API misses as
// real JSON 404s, and do not turn missing static assets into HTML responses.
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
const HOST = process.env.HOST || '127.0.0.1'; // Secure local loopback default

export async function startServer() {
  try {
    // 1. Boot Embedded Local AI Engine in the background
    try {
      await EmbeddedLocalEngine.start();
    } catch (e: any) {
      console.warn(`[EmbeddedLocalEngine] Startup warning: ${e.message}`);
    }

    await app.listen({ port: PORT, host: HOST });
    console.log(`\n======================================================`);
    console.log(`🚀 NexusRoute Gateway is running!`);
    console.log(`🌐 Web UI & Inspector: http://${HOST}:${PORT}`);
    console.log(`📡 OpenAI Chat API:     http://${HOST}:${PORT}/v1/chat/completions`);
    console.log(`📋 Models Endpoint:    http://${HOST}:${PORT}/v1/models`);
    console.log(`🔑 Key Status:          http://${HOST}:${PORT}/v1/keys/status`);
    console.log(`🖥️ Local AI Engine:    Embedded & GPU Accelerated (Port 11434)`);
    console.log(`🔒 Bound Interface:    ${HOST} (Localhost Secure Mode)`);
    console.log(`======================================================\n`);
    // Resolved routing config, so "which build is actually serving me" is
    // answerable from the banner instead of by guessing.
    const startedAt = new Date().toISOString();
    console.log(`🧭 OpenRouter model:   ${process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free (default)'}`);
    console.log(`🧭 Coding model:       ${process.env.OPENROUTER_CODING_MODEL?.trim() || 'inherits OpenRouter model'}`);
    console.log(`⏱️  Turn limits:        cloud ${process.env.NEXUS_CLOUD_TURN_TIMEOUT_MS || 90000}ms / local ${process.env.NEXUS_LOCAL_TURN_TIMEOUT_MS || 120000}ms / request ${process.env.NEXUS_AGENT_REQUEST_TIMEOUT_MS || 600000}ms`);
    console.log(`🔁 Max agent turns:    ${process.env.NEXUS_MAX_AGENT_TURNS || 4}`);
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

if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  startServer();
}

export { app, router, keyManager, providerModelDiscovery };
