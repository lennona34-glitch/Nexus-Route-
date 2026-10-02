import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ProviderType, UniversalUsage } from '../ir/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type QuotaUnit = 'requests' | 'tokens' | 'usd';
export type ResetInterval = 'daily' | 'monthly' | 'manual';

export interface ProviderConnection {
  id: string;
  provider: ProviderType;
  label: string;
  apiKey: string;
  enabled: boolean;
  source: 'environment' | 'manual' | 'legacy';
  priority: number;
  createdAt: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  failureCount: number;
  cooldownUntil?: number;
  exhausted: boolean;
  quotaLimit?: number;
  quotaUsed: number;
  quotaUnit: QuotaUnit;
  resetInterval: ResetInterval;
  resetAt?: number;
}

export interface PublicProviderConnection extends Omit<ProviderConnection, 'apiKey'> {
  maskedKey: string;
  status: 'ready' | 'cooldown' | 'exhausted' | 'disabled';
  remaining?: number;
  usagePercent?: number;
}

interface AddConnectionOptions {
  id?: string;
  label?: string;
  source?: ProviderConnection['source'];
  priority?: number;
  quotaLimit?: number;
  quotaUnit?: QuotaUnit;
  resetInterval?: ResetInterval;
  resetAt?: number;
}

const ENV_KEYS: Partial<Record<ProviderType, string[]>> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY', 'NVAPI_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  cheaperinference: ['CHEAPERINFERENCE_API_KEY', 'CHEAP_INFERENCE_API_KEY'],
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  huggingface: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  unorouter: ['UNOROUTER_API_KEY', 'UNO_ROUTER_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  xkiro: ['XKIRO_API_KEY'],
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
  aimlapi: ['AIMLAPI_API_KEY', 'AI_ML_API_KEY'],
  gmicloud: ['GMI_API_KEY', 'GMICLOUD_API_KEY'],
  inception: ['INCEPTION_API_KEY', 'INCEPTIONLABS_API_KEY'],
  atria: ['ATRIA_API_KEY', 'ATRIA_ASI_API_KEY', 'DAWN_API_KEY'],
};

export const FREE_PROVIDER_CATALOG = [
  { provider: 'atria', name: 'Atria ASI (Dawn)', note: '744B MoE agentic foundation model for scientific research and complex workflows.', signupUrl: 'https://api.atria-asi.ai/console/keys' },
  { provider: 'inception', name: 'Inception Labs', note: 'High-speed diffusion LLMs (Mercury 2.5/2, Mercury Coder).', signupUrl: 'https://platform.inceptionlabs.ai' },
  { provider: 'xkiro', name: 'xKiro', note: 'Free models including DeepSeek R1/V3, Llama 3.3, and Qwen (5M daily free tokens).', signupUrl: 'https://xkiro.com' },
  { provider: 'cloudflare', name: 'Cloudflare Workers AI', note: '10,000 free daily neurons on Llama 3.3, DeepSeek R1 Distill, and Qwen.', signupUrl: 'https://dash.cloudflare.com/' },
  { provider: 'aimlapi', name: 'AI/ML API', note: '200+ models aggregator. Pay-as-you-go requiring prepaid account balance (no free tier).', signupUrl: 'https://aimlapi.com' },
  { provider: 'gmicloud', name: 'GMI Cloud', note: 'Enterprise GPU cloud with DeepSeek R1/V3 and Llama 3.3 API serving.', signupUrl: 'https://console.gmicloud.ai' },
  { provider: 'unorouter', name: 'UnoRouter', note: 'Aggregated free models and tool-calling models (Qwen, DeepSeek, Llama).', signupUrl: 'https://unorouter.com' },
  { provider: 'qwen', name: 'Qwen / DashScope', note: 'Alibaba Cloud free Token Plan and frontier Qwen 2.5 Coder models.', signupUrl: 'https://bailian.console.aliyun.com/' },
  { provider: 'cerebras', name: 'Cerebras Cloud', note: 'World-record 1,800+ tok/s free inference on Llama 3.3 70B & DeepSeek R1.', signupUrl: 'https://cloud.cerebras.ai' },
  { provider: 'nvidia', name: 'NVIDIA NIM Cloud', note: '1,000 free API credits on signup for Llama 3.1 405B, Nemotron-4 & DeepSeek R1.', signupUrl: 'https://build.nvidia.com/' },
  { provider: 'gemini', name: 'Google Gemini', note: 'Free API tier available for Flash & Pro models.', signupUrl: 'https://aistudio.google.com/app/apikey' },
  { provider: 'groq', name: 'Groq', note: 'Fast developer free tier with model-specific rate limits.', signupUrl: 'https://console.groq.com/keys' },
  { provider: 'openrouter', name: 'OpenRouter', note: 'Includes a rotating catalogue of 100% free :free models.', signupUrl: 'https://openrouter.ai/settings/keys' },
  { provider: 'huggingface', name: 'Hugging Face', note: 'Serverless inference allowance for open-weight models.', signupUrl: 'https://huggingface.co/settings/tokens' },
  { provider: 'mistral', name: 'Mistral', note: 'Developer/API promotions and free tier endpoints.', signupUrl: 'https://console.mistral.ai/api-keys' },
] as const;

function nextReset(interval: ResetInterval, from = Date.now()): number | undefined {
  if (interval === 'manual') return undefined;
  const date = new Date(from);
  if (interval === 'daily') {
    date.setHours(24, 0, 0, 0);
    return date.getTime();
  }
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function maskKey(key: string): string {
  if (key.length < 10) return '••••••••';
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export class ProviderConnectionManager {
  private connections: ProviderConnection[] = [];
  private roundRobin = new Map<ProviderType, number>();
  private storagePath: string | null;

  constructor(options: { storagePath?: string | null; hydrateEnvironment?: boolean } = {}) {
    this.storagePath = options.storagePath === undefined
      ? path.join(__dirname, '../../config/provider_connections.json')
      : options.storagePath;
    this.load();
    if (options.hydrateEnvironment !== false) this.hydrateEnvironment();
  }

  private load(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8')) as ProviderConnection[];
      if (Array.isArray(parsed)) this.connections = parsed;
    } catch {}
  }

  private save(): void {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      // Environment-backed secrets remain sourced from .env/process.env and are
      // never copied into the secondary JSON store. Manual pool keys do need to
      // persist locally so extra connections survive a restart.
      const persistedConnections = this.connections.filter(connection => connection.source !== 'environment');
      fs.writeFileSync(this.storagePath, JSON.stringify(persistedConnections, null, 2), 'utf8');
    } catch {}
  }

  private hydrateEnvironment(): void {
    for (const [provider, variableNames] of Object.entries(ENV_KEYS) as Array<[ProviderType, string[]]>) {
      for (const variableName of variableNames) {
        const raw = process.env[variableName];
        if (!raw) continue;
        raw.split(',').map(value => value.trim()).filter(Boolean).forEach((apiKey, index) => {
          this.addConnection(provider, apiKey, {
            id: `env-${provider}-${variableName.toLowerCase()}-${index}`,
            label: index === 0 ? variableName : `${variableName} #${index + 1}`,
            source: 'environment',
            priority: 10,
          }, false);
        });
      }
    }
    this.save();
  }

  addConnection(provider: ProviderType, apiKey: string, options: AddConnectionOptions = {}, persist = true): ProviderConnection {
    const cleanKey = apiKey.trim();
    if (!cleanKey) throw new Error('API key is required');
    const sameId = options.id ? this.connections.find(item => item.id === options.id) : undefined;
    if (sameId) {
      sameId.provider = provider;
      sameId.apiKey = cleanKey;
      sameId.enabled = true;
      sameId.label = options.label?.trim() || sameId.label;
      if (persist) this.save();
      return sameId;
    }
    const duplicate = this.connections.find(item => item.provider === provider && item.apiKey === cleanKey);
    if (duplicate) {
      duplicate.enabled = true;
      duplicate.label = options.label?.trim() || duplicate.label;
      if (options.quotaLimit !== undefined) duplicate.quotaLimit = Math.max(0, Number(options.quotaLimit));
      if (options.quotaUnit) duplicate.quotaUnit = options.quotaUnit;
      if (options.resetInterval) duplicate.resetInterval = options.resetInterval;
      if (options.resetAt !== undefined) duplicate.resetAt = options.resetAt;
      if (persist) this.save();
      return duplicate;
    }

    const resetInterval = options.resetInterval || 'manual';
    const connection: ProviderConnection = {
      id: options.id || crypto.randomUUID(),
      provider,
      label: options.label?.trim() || `${provider} key ${this.connections.filter(item => item.provider === provider).length + 1}`,
      apiKey: cleanKey,
      enabled: true,
      source: options.source || 'manual',
      priority: options.priority ?? 10,
      createdAt: Date.now(),
      failureCount: 0,
      exhausted: false,
      quotaLimit: options.quotaLimit !== undefined ? Math.max(0, Number(options.quotaLimit)) : undefined,
      quotaUsed: 0,
      quotaUnit: options.quotaUnit || 'requests',
      resetInterval,
      resetAt: options.resetAt || nextReset(resetInterval),
    };
    this.connections.push(connection);
    if (persist) this.save();
    return connection;
  }

  setPrimaryConnection(provider: ProviderType, apiKey: string): ProviderConnection | null {
    this.connections = this.connections.filter(item => !(
      item.provider === provider && (item.source === 'environment' || item.id === `legacy-${provider}`)
    ));
    if (!apiKey.trim()) {
      this.save();
      return null;
    }
    return this.addConnection(provider, apiKey, {
      id: `env-${provider}-runtime-primary-0`,
      label: 'Primary key (.env)',
      source: 'environment',
      priority: 20,
    });
  }

  removeConnection(id: string): boolean {
    const before = this.connections.length;
    this.connections = this.connections.filter(item => item.id !== id);
    if (this.connections.length !== before) this.save();
    return this.connections.length !== before;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const connection = this.connections.find(item => item.id === id);
    if (!connection) return false;
    connection.enabled = enabled;
    if (enabled) connection.exhausted = false;
    this.save();
    return true;
  }

  resetConnection(id: string): boolean {
    const connection = this.connections.find(item => item.id === id);
    if (!connection) return false;
    connection.quotaUsed = 0;
    connection.failureCount = 0;
    connection.cooldownUntil = undefined;
    connection.exhausted = false;
    connection.lastError = undefined;
    connection.resetAt = nextReset(connection.resetInterval);
    this.save();
    return true;
  }

  private refreshReset(connection: ProviderConnection, now = Date.now()): void {
    if (connection.resetAt && connection.resetAt <= now) {
      connection.quotaUsed = 0;
      connection.exhausted = false;
      connection.resetAt = nextReset(connection.resetInterval, now);
    }
  }

  private isReady(connection: ProviderConnection, now = Date.now()): boolean {
    this.refreshReset(connection, now);
    if (!connection.enabled || connection.exhausted) return false;
    if (connection.cooldownUntil && connection.cooldownUntil > now) return false;
    if (connection.quotaLimit !== undefined && connection.quotaLimit > 0 && connection.quotaUsed >= connection.quotaLimit) {
      connection.exhausted = true;
      return false;
    }
    return true;
  }

  acquire(provider: ProviderType): ProviderConnection | null {
    const now = Date.now();
    const ready = this.connections
      .filter(item => item.provider === provider && this.isReady(item, now))
      .sort((a, b) => b.priority - a.priority || a.failureCount - b.failureCount);
    if (ready.length === 0) {
      this.save();
      return null;
    }
    const index = this.roundRobin.get(provider) || 0;
    const selected = ready[index % ready.length];
    this.roundRobin.set(provider, (index + 1) % ready.length);
    selected.lastUsedAt = now;
    this.save();
    return { ...selected };
  }

  /**
   * Returns a ready connection without advancing rotation or counting it as a
   * routed chat request. This is used for low-frequency provider metadata
   * calls such as model catalogue discovery.
   */
  peekUsable(provider: ProviderType): ProviderConnection | null {
    const now = Date.now();
    const selected = this.connections
      .filter(item => item.provider === provider && this.isReady(item, now))
      .sort((a, b) => b.priority - a.priority || a.failureCount - b.failureCount)[0];
    return selected ? { ...selected } : null;
  }

  usableCount(provider: ProviderType): number {
    return this.connections.filter(item => item.provider === provider && this.isReady(item)).length;
  }

  hasConfigured(provider: ProviderType): boolean {
    return this.connections.some(item => item.provider === provider);
  }

  hasUsable(provider: ProviderType): boolean {
    return this.usableCount(provider) > 0;
  }

  recordSuccess(id: string): void {
    const connection = this.connections.find(item => item.id === id);
    if (!connection) return;
    connection.failureCount = Math.max(0, connection.failureCount - 1);
    connection.lastSuccessAt = Date.now();
    connection.lastError = undefined;
    connection.cooldownUntil = undefined;
    this.save();
  }

  recordUsage(id: string, usage?: UniversalUsage): void {
    const connection = this.connections.find(item => item.id === id);
    if (!connection) return;
    if (connection.quotaUnit === 'requests') connection.quotaUsed += 1;
    if (connection.quotaUnit === 'tokens') connection.quotaUsed += usage?.total_tokens || 0;
    if (connection.quotaUnit === 'usd') connection.quotaUsed += usage?.estimated_cost_usd || 0;
    if (connection.quotaLimit !== undefined && connection.quotaLimit > 0 && connection.quotaUsed >= connection.quotaLimit) {
      connection.exhausted = true;
    }
    this.save();
  }

  recordFailure(id: string, statusCode: number, message: string, retryAfterMs?: number): void {
    const connection = this.connections.find(item => item.id === id);
    if (!connection) return;

    // HTTP 413 describes this request, not the health or credit state of the
    // API key. Keep the diagnostic visible but do not cool down a good key.
    if (statusCode === 413) {
      connection.lastError = message.slice(0, 500);
      this.save();
      return;
    }

    connection.failureCount += 1;
    connection.lastError = message.slice(0, 500);
    const quotaFailure = statusCode === 402 || /(?:quota|credits?).{0,30}(?:exhaust|deplet|insufficient|used up)|insufficient.{0,20}(?:quota|credits?)/i.test(message);
    if (quotaFailure) {
      connection.exhausted = true;
    } else if (statusCode === 401 || statusCode === 403) {
      connection.enabled = false;
    } else {
      const exponential = Math.min(30_000 * (2 ** Math.min(connection.failureCount - 1, 4)), 300_000);
      connection.cooldownUntil = Date.now() + Math.max(1_000, retryAfterMs || exponential);
    }
    this.save();
  }

  listPublic(): PublicProviderConnection[] {
    const now = Date.now();
    let dirty = false;
    const result = this.connections.map(connection => {
      const beforeReset = connection.resetAt;
      this.refreshReset(connection, now);
      if (beforeReset !== connection.resetAt) dirty = true;
      const inCooldown = !!(connection.cooldownUntil && connection.cooldownUntil > now);
      const status: PublicProviderConnection['status'] = !connection.enabled
        ? 'disabled'
        : connection.exhausted
          ? 'exhausted'
          : inCooldown
            ? 'cooldown'
            : 'ready';
      const remaining = connection.quotaLimit !== undefined
        ? Math.max(0, connection.quotaLimit - connection.quotaUsed)
        : undefined;
      const usagePercent = connection.quotaLimit
        ? Math.min(100, (connection.quotaUsed / connection.quotaLimit) * 100)
        : undefined;
      const { apiKey: _apiKey, ...safe } = connection;
      return { ...safe, maskedKey: maskKey(connection.apiKey), status, remaining, usagePercent };
    });
    if (dirty) this.save();
    return result;
  }

  getProviderSummary(): Record<string, { configured: boolean; usable: number; total: number; cooldown: number; exhausted: number }> {
    const result: Record<string, { configured: boolean; usable: number; total: number; cooldown: number; exhausted: number }> = {};
    for (const connection of this.listPublic()) {
      const entry = result[connection.provider] || { configured: false, usable: 0, total: 0, cooldown: 0, exhausted: 0 };
      entry.configured = true;
      entry.total += 1;
      if (connection.status === 'ready') entry.usable += 1;
      if (connection.status === 'cooldown') entry.cooldown += 1;
      if (connection.status === 'exhausted') entry.exhausted += 1;
      result[connection.provider] = entry;
    }
    return result;
  }
}
