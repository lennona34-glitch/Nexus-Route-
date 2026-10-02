import type { ProviderType } from '../ir/types.js';
import type { ProviderConnectionManager } from './connection-manager.js';
import { resolveQwenBaseUrl } from '../adapters/qwen.js';
import { resolveCloudflareConfig } from '../adapters/cloudflare.js';

export type ProviderCatalogueStatus = 'ready' | 'unconfigured' | 'paused' | 'unavailable' | 'retired';

export interface DiscoveredProviderModel {
  id: string;
  routeId: string;
  name: string;
  ownedBy?: string;
  contextLength?: number;
  supportsTools?: boolean;
  free?: boolean;
}

export interface ProviderModelGroup {
  provider: ProviderType;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  status: ProviderCatalogueStatus;
  source: 'live' | 'none';
  fetchedAt: number;
  cached: boolean;
  models: DiscoveredProviderModel[];
  error?: string;
}

export interface ProviderModelCatalogue {
  generatedAt: number;
  cacheTtlMs: number;
  providers: ProviderModelGroup[];
}

interface RawModel {
  id: string;
  name?: string;
  ownedBy?: string;
  contextLength?: number;
  supportsTools?: boolean;
  free?: boolean;
}

interface ProviderDefinition {
  provider: ProviderType;
  displayName: string;
  url: string | ((apiKey: string) => string);
  headers?: (apiKey: string) => Record<string, string>;
  parse: (payload: unknown) => RawModel[];
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 8_000;

const bearerHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  Accept: 'application/json',
});

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function isZeroPrice(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return Number(value) === 0;
}

function isZeroOrUnpriced(value: unknown): boolean {
  return value === undefined || value === null || value === '' || isZeroPrice(value);
}

function looksLikeChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !(
    lower.includes('embedding') ||
    lower.includes('moderation') ||
    lower.startsWith('whisper') ||
    lower.includes('/whisper') ||
    lower.startsWith('tts-') ||
    lower.includes('text-to-speech') ||
    lower.includes('image-generation') ||
    lower.startsWith('dall-e')
  );
}

function parseOpenAIList(payload: unknown): RawModel[] {
  const data = asArray(asRecord(payload).data);
  return data
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => ({ id: item.id, name: item.name || item.display_name, ownedBy: item.owned_by }));
}

function parseAnthropic(payload: unknown): RawModel[] {
  return asArray(asRecord(payload).data)
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string')
    .map(item => ({
      id: item.id,
      name: item.display_name,
      contextLength: finiteNumber(item.max_input_tokens),
      supportsTools: !!item.capabilities?.code_execution?.supported || !!item.capabilities?.structured_outputs?.supported,
    }));
}

function parseGemini(payload: unknown): RawModel[] {
  return asArray(asRecord(payload).models)
    .map(item => asRecord(item))
    .filter(item => typeof item.name === 'string' && asArray(item.supportedGenerationMethods).includes('generateContent'))
    .map(item => ({
      id: item.name.replace(/^models\//, ''),
      name: item.displayName,
      contextLength: finiteNumber(item.inputTokenLimit),
      supportsTools: true,
    }));
}

function parseMistral(payload: unknown): RawModel[] {
  const root = asRecord(payload);
  const data = Array.isArray(payload) ? payload : root.data;
  return asArray(data)
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && item.archived !== true && item.capabilities?.completion_chat !== false)
    .map(item => ({
      id: item.id,
      name: item.name || item.id,
      ownedBy: item.owned_by,
      contextLength: finiteNumber(item.max_context_length),
      supportsTools: item.capabilities?.function_calling,
    }));
}

function parseOpenRouter(payload: unknown): RawModel[] {
  return asArray(asRecord(payload).data)
    .map(item => asRecord(item))
    .filter(item => {
      if (typeof item.id !== 'string' || !looksLikeChatModel(item.id)) return false;
      const pricing = asRecord(item.pricing);
      const isFree = item.id.endsWith(':free') || item.id === 'openrouter/free' || (
        isZeroPrice(pricing.prompt)
        && isZeroPrice(pricing.completion)
        && isZeroOrUnpriced(pricing.request)
      );
      // Strict safety guard: ONLY keep 100% free models
      return isFree;
    })
    .map(item => ({
      id: item.id,
      name: item.name,
      contextLength: finiteNumber(item.context_length),
      supportsTools: asArray(item.supported_parameters).includes('tools'),
      free: true,
    }));
}

function parseHuggingFace(payload: unknown): RawModel[] {
  return asArray(asRecord(payload).data)
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => {
      const providers = asArray(item.providers).map(provider => asRecord(provider));
      return {
        id: item.id,
        name: item.name || item.id,
        contextLength: finiteNumber(item.context_length || providers.find(provider => provider.context_length)?.context_length),
        supportsTools: providers.some(provider => provider.supports_tools === true),
      };
    });
}

function parseXAI(payload: unknown): RawModel[] {
  return asArray(asRecord(payload).models)
    .map(item => asRecord(item))
    .filter(item => {
      if (typeof item.id !== 'string') return false;
      const outputs = asArray(item.output_modalities);
      return outputs.length === 0 || outputs.includes('text');
    })
    .map(item => ({
      id: item.id,
      name: item.id,
      ownedBy: item.owned_by,
      contextLength: finiteNumber(item.context_length),
      // xAI's current language models expose OpenAI-compatible function
      // calling, while /v1/language-models keeps non-language models out.
      supportsTools: true,
    }));
}

function parseCheaperInference(payload: unknown): RawModel[] {
  const data = asArray(asRecord(payload).data);
  return data
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => {
      const provName = item.provider || item.owned_by;
      const label = provName ? `${item.id} (${provName})` : item.id;
      return {
        id: item.id,
        name: label,
        ownedBy: item.owned_by || item.provider,
        contextLength: finiteNumber(item.context_length),
        supportsTools: true,
        free: item.is_free === true,
      };
    });
}

function parseUnoRouter(payload: unknown): RawModel[] {
  const root = asRecord(payload);
  const data = asArray(Array.isArray(payload) ? payload : (root.data || root.models));
  return data
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => {
      const isFree = item.id.includes(':free') || item.free === true || item.is_free === true;
      const supportsTools = item.tools === true || item.supports_tools === true || asArray(item.supported_parameters).includes('tools') || true;
      return {
        id: item.id,
        name: item.name || item.id,
        ownedBy: item.owned_by || item.provider,
        contextLength: finiteNumber(item.context_length || item.max_context_length) || 65536,
        supportsTools,
        free: isFree,
      };
    });
}

function parseXkiro(payload: unknown): RawModel[] {
  const root = asRecord(payload);
  const data = asArray(root.data || (Array.isArray(payload) ? payload : []));
  return data
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => ({
      id: item.id,
      name: item.name || item.id,
      ownedBy: item.owned_by || 'xkiro',
      contextLength: finiteNumber(item.context_length) || 65536,
      supportsTools: true,
      free: item.id.includes(':free') || item.is_free === true,
    }));
}

function parseCloudflare(payload: unknown): RawModel[] {
  const root = asRecord(payload);
  const data = asArray(root.result || root.data || (Array.isArray(payload) ? payload : []));
  return data
    .map(item => asRecord(item))
    .filter(item => typeof item.id === 'string' && looksLikeChatModel(item.id))
    .map(item => ({
      id: item.id,
      name: item.name || item.id,
      ownedBy: 'cloudflare',
      contextLength: finiteNumber(item.context_length) || 32768,
      supportsTools: true,
      free: true,
    }));
}

const DEFINITIONS: ProviderDefinition[] = [
  { provider: 'openai', displayName: 'OpenAI', url: 'https://api.openai.com/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  {
    provider: 'anthropic',
    displayName: 'Anthropic',
    url: 'https://api.anthropic.com/v1/models?limit=1000',
    headers: apiKey => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' }),
    parse: parseAnthropic,
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    headers: apiKey => ({ 'x-goog-api-key': apiKey, Accept: 'application/json' }),
    parse: parseGemini,
  },
  { provider: 'groq', displayName: 'Groq', url: 'https://api.groq.com/openai/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'deepseek', displayName: 'DeepSeek', url: 'https://api.deepseek.com/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'cerebras', displayName: 'Cerebras', url: 'https://api.cerebras.ai/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'nvidia', displayName: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'unorouter', displayName: 'UnoRouter', url: 'https://api.unorouter.com/v1/models', headers: bearerHeaders, parse: parseUnoRouter },
  { provider: 'qwen', displayName: 'Qwen / DashScope', url: apiKey => `${resolveQwenBaseUrl(apiKey)}/models`, headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'xkiro', displayName: 'xKiro', url: 'https://api.xkiro.com/v1/models', headers: bearerHeaders, parse: parseXkiro },
  {
    provider: 'cloudflare',
    displayName: 'Cloudflare Workers AI',
    url: apiKey => {
      const { baseUrl } = resolveCloudflareConfig({ apiKey });
      return `${baseUrl}/models`;
    },
    headers: bearerHeaders,
    parse: parseCloudflare,
  },
  { provider: 'aimlapi', displayName: 'AI/ML API', url: 'https://api.aimlapi.com/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'gmicloud', displayName: 'GMI Cloud', url: 'https://api.gmi-serving.com/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'inception', displayName: 'Inception Labs', url: 'https://api.inceptionlabs.ai/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'atria', displayName: 'Atria ASI (Dawn)', url: 'https://api.atria-asi.ai/v1/models', headers: bearerHeaders, parse: parseOpenAIList },
  { provider: 'cheaperinference', displayName: 'CheaperInference', url: 'https://api.cheaperinference.com/v1/models', headers: bearerHeaders, parse: parseCheaperInference },
  { provider: 'mistral', displayName: 'Mistral', url: 'https://api.mistral.ai/v1/models', headers: bearerHeaders, parse: parseMistral },
  { provider: 'xai', displayName: 'xAI Grok', url: 'https://api.x.ai/v1/language-models', headers: bearerHeaders, parse: parseXAI },
  { provider: 'openrouter', displayName: 'OpenRouter', url: 'https://openrouter.ai/api/v1/models?output_modalities=text', headers: bearerHeaders, parse: parseOpenRouter },
  { provider: 'huggingface', displayName: 'Hugging Face', url: 'https://router.huggingface.co/v1/models', headers: bearerHeaders, parse: parseHuggingFace },
];

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 240);
}

export class ProviderModelDiscovery {
  private cache = new Map<ProviderType, ProviderModelGroup>();
  private inFlight = new Map<ProviderType, Promise<ProviderModelGroup>>();
  private fetchImpl: typeof fetch;
  private cacheTtlMs: number;
  private isProviderEnabled: (provider: ProviderType) => boolean;

  constructor(
    private connectionManager: ProviderConnectionManager,
    options: {
      fetchImpl?: typeof fetch;
      cacheTtlMs?: number;
      isProviderEnabled?: (provider: ProviderType) => boolean;
    } = {},
  ) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.cacheTtlMs = options.cacheTtlMs || DEFAULT_CACHE_TTL_MS;
    this.isProviderEnabled = options.isProviderEnabled || (() => true);
  }

  invalidate(provider?: ProviderType): void {
    if (provider) this.cache.delete(provider);
    else this.cache.clear();
  }

  async getCatalogue(force = false): Promise<ProviderModelCatalogue> {
    const providers = await Promise.all([
      ...DEFINITIONS.map(definition => this.discover(definition, force)),
      this.retiredGitHubGroup(),
    ]);
    return { generatedAt: Date.now(), cacheTtlMs: this.cacheTtlMs, providers };
  }

  private retiredGitHubGroup(): ProviderModelGroup {
    return {
      provider: 'github',
      displayName: 'GitHub Models',
      configured: this.connectionManager.hasConfigured('github'),
      enabled: this.isProviderEnabled('github'),
      status: 'retired',
      source: 'none',
      fetchedAt: Date.now(),
      cached: false,
      models: [],
      error: 'GitHub Models was retired on 30 July 2026; GitHub Copilot is a separate service.',
    };
  }

  private async discover(definition: ProviderDefinition, force: boolean): Promise<ProviderModelGroup> {
    const enabled = this.isProviderEnabled(definition.provider);
    const configured = this.connectionManager.hasConfigured(definition.provider);
    if (!enabled) return this.emptyGroup(definition, configured, false, 'paused', 'Provider is paused in NexusRoute.');

    const connection = this.connectionManager.peekUsable(definition.provider);
    if (!connection) {
      return this.emptyGroup(
        definition,
        configured,
        true,
        configured ? 'unavailable' : 'unconfigured',
        configured ? 'No ready connection is available for catalogue discovery.' : undefined,
      );
    }

    const cached = this.cache.get(definition.provider);
    if (!force && cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return { ...cached, cached: true };

    const existing = this.inFlight.get(definition.provider);
    if (existing) return existing;

    const pending = this.fetchProvider(definition, connection.apiKey)
      .finally(() => this.inFlight.delete(definition.provider));
    this.inFlight.set(definition.provider, pending);
    return pending;
  }

  private emptyGroup(
    definition: ProviderDefinition,
    configured: boolean,
    enabled: boolean,
    status: ProviderCatalogueStatus,
    error?: string,
  ): ProviderModelGroup {
    return {
      provider: definition.provider,
      displayName: definition.displayName,
      configured,
      enabled,
      status,
      source: 'none',
      fetchedAt: Date.now(),
      cached: false,
      models: [],
      error,
    };
  }

  private async fetchProvider(definition: ProviderDefinition, apiKey: string): Promise<ProviderModelGroup> {
    const fetchedAt = Date.now();
    try {
      const targetUrl = typeof definition.url === 'function' ? definition.url(apiKey) : definition.url;
      const response = await this.fetchImpl(targetUrl, {
        method: 'GET',
        headers: definition.headers?.(apiKey),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = body ? `: ${body.slice(0, 160)}` : '';
        throw new Error(`Catalogue request failed (${response.status})${detail}`);
      }

      const payload = await response.json();
      const seen = new Set<string>();
      const models = definition.parse(payload)
        .filter(model => model.id && !seen.has(model.id) && seen.add(model.id))
        .map(model => ({
          id: model.id,
          routeId: `${definition.provider}::${model.id}`,
          name: model.name || model.id,
          ownedBy: model.ownedBy,
          contextLength: model.contextLength,
          supportsTools: model.supportsTools,
          free: model.free,
        }))
        .sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.name.localeCompare(b.name));

      const customEnvModel = (
        definition.provider === 'nvidia' ? process.env.NVIDIA_DEFAULT_MODEL :
        definition.provider === 'unorouter' ? process.env.UNOROUTER_DEFAULT_MODEL :
        definition.provider === 'qwen' ? process.env.QWEN_DEFAULT_MODEL :
        definition.provider === 'xkiro' ? process.env.XKIRO_DEFAULT_MODEL :
        definition.provider === 'cloudflare' ? process.env.CLOUDFLARE_DEFAULT_MODEL :
        definition.provider === 'aimlapi' ? process.env.AIMLAPI_DEFAULT_MODEL :
        definition.provider === 'gmicloud' ? process.env.GMICLOUD_DEFAULT_MODEL :
        definition.provider === 'inception' ? process.env.INCEPTION_DEFAULT_MODEL :
        definition.provider === 'atria' ? process.env.ATRIA_DEFAULT_MODEL :
        undefined
      )?.trim();
      if (customEnvModel) {
        const cleanCustom = customEnvModel.replace(new RegExp(`^(${definition.provider}::|${definition.provider}/)`), '');
        const existingIdx = models.findIndex(m => m.id === cleanCustom);
        if (existingIdx >= 0) {
          const [existing] = models.splice(existingIdx, 1);
          models.unshift({
            ...existing,
            name: `⭐ ${cleanCustom} (Configured Target)`,
            routeId: `${definition.provider}::${cleanCustom}`,
          });
        } else {
          models.unshift({
            id: cleanCustom,
            routeId: `${definition.provider}::${cleanCustom}`,
            name: `⭐ ${cleanCustom} (Configured Target)`,
            ownedBy: definition.provider,
            contextLength: 131072,
            supportsTools: true,
            free: cleanCustom.includes(':free'),
          });
        }
      }

      const group: ProviderModelGroup = {
        provider: definition.provider,
        displayName: definition.displayName,
        configured: true,
        enabled: true,
        status: 'ready',
        source: 'live',
        fetchedAt,
        cached: false,
        models,
      };
      this.cache.set(definition.provider, group);
      return group;
    } catch (error) {
      const fallbackList: Record<string, string[]> = {
        nvidia: [
          'meta/llama-3.3-70b-instruct',
          'nvidia/llama-3.1-nemotron-70b-instruct',
          'deepseek-ai/deepseek-r1',
          'nvidia/nemotron-4-340b-instruct',
          'meta/llama-3.1-405b-instruct',
        ],
        unorouter: [
          'qwen/qwen-2.5-coder-32b-instruct:free',
          'deepseek/deepseek-r1:free',
          'meta-llama/llama-3.3-70b-instruct:free',
          'qwen/qwen-2.5-72b-instruct:free',
          'mistralai/mistral-small-24b-instruct-2501:free',
        ],
        qwen: [
          'qwen-2.5-coder-32b-instruct',
          'qwen-2.5-72b-instruct',
          'qwen-plus',
          'qwen-max',
          'qwen-turbo',
        ],
        xkiro: [
          'deepseek/deepseek-r1:free',
          'deepseek/deepseek-chat:free',
          'meta-llama/llama-3.3-70b-instruct:free',
          'qwen/qwen-2.5-coder-32b-instruct:free',
          'mistralai/mistral-small-24b-instruct-2501:free',
        ],
        cloudflare: [
          '@cf/meta/llama-3.3-70b-instruct',
          '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
          '@cf/meta/llama-3.1-8b-instruct',
          '@cf/qwen/qwen2.5-coder-7b-instruct',
        ],
        aimlapi: [
          'deepseek/deepseek-r1',
          'deepseek/deepseek-chat',
          'meta-llama/llama-3.3-70b-instruct',
          'mistralai/mistral-7b-instruct-v0.2',
          'qwen/qwen-2.5-coder-32b-instruct',
        ],
        gmicloud: [
          'deepseek-ai/DeepSeek-R1',
          'deepseek-ai/DeepSeek-V3',
          'meta-llama/Llama-3.3-70B-Instruct',
        ],
        inception: [
          'mercury-2.5',
          'mercury-2',
          'mercury-edit-2',
          'mercury-coder-small',
        ],
        atria: [
          'Atria-Dawn-Preview',
          'Atria-Dawn',
        ],
      };

      const defaults = fallbackList[definition.provider];
      const customEnvModel = (
        definition.provider === 'nvidia' ? process.env.NVIDIA_DEFAULT_MODEL :
        definition.provider === 'unorouter' ? process.env.UNOROUTER_DEFAULT_MODEL :
        definition.provider === 'qwen' ? process.env.QWEN_DEFAULT_MODEL :
        definition.provider === 'xkiro' ? process.env.XKIRO_DEFAULT_MODEL :
        definition.provider === 'cloudflare' ? process.env.CLOUDFLARE_DEFAULT_MODEL :
        definition.provider === 'aimlapi' ? process.env.AIMLAPI_DEFAULT_MODEL :
        definition.provider === 'gmicloud' ? process.env.GMICLOUD_DEFAULT_MODEL :
        definition.provider === 'inception' ? process.env.INCEPTION_DEFAULT_MODEL :
        definition.provider === 'atria' ? process.env.ATRIA_DEFAULT_MODEL :
        undefined
      )?.trim();

      if (defaults || customEnvModel) {
        const cleanCustom = customEnvModel ? customEnvModel.replace(new RegExp(`^(${definition.provider}::|${definition.provider}/)`), '') : '';
        const modelIds = cleanCustom ? [cleanCustom, ...(defaults || [])] : (defaults || []);
        const seen = new Set<string>();
        const models = modelIds
          .filter(id => id && !seen.has(id) && seen.add(id))
          .map(id => ({
            id,
            routeId: `${definition.provider}::${id}`,
            name: cleanCustom && id === cleanCustom ? `⭐ ${id} (Configured Target)` : id,
            contextLength: 131072,
            supportsTools: true,
            free: id.includes(':free'),
          }));

        const group: ProviderModelGroup = {
          provider: definition.provider,
          displayName: definition.displayName,
          configured: true,
          enabled: true,
          status: 'ready',
          source: 'live',
          fetchedAt,
          cached: false,
          models,
        };
        this.cache.set(definition.provider, group);
        return group;
      }

      return {
        provider: definition.provider,
        displayName: definition.displayName,
        configured: true,
        enabled: true,
        status: 'unavailable',
        source: 'none',
        fetchedAt,
        cached: false,
        models: [],
        error: publicError(error),
      };
    }
  }
}
