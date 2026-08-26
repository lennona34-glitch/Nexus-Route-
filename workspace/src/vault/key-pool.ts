export interface PooledKey {
  id: string;
  provider: string;
  apiKey: string;
  weight: number;
  active: boolean;
  rateLimitedUntil: number; // timestamp in ms
  failureCount: number;
  successCount: number;
  lastUsed: number;
  cooldownMs: number;
}

export interface KeyPoolStats {
  provider: string;
  totalKeys: number;
  healthyKeys: number;
  quarantinedKeys: number;
  keys: Array<{
    id: string;
    maskedKey: string;
    status: 'healthy' | 'rate_limited' | 'disabled';
    failureCount: number;
    successCount: number;
    cooldownRemainingSec: number;
  }>;
}

export class MultiKeyPool {
  private keys: Map<string, PooledKey[]> = new Map();
  private roundRobinIndices: Map<string, number> = new Map();
  private defaultCooldownMs: number;

  constructor(defaultCooldownMs = 60_000) {
    this.defaultCooldownMs = defaultCooldownMs;
  }

  /**
   * Register one or multiple API keys for a given provider
   */
  addKey(provider: string, apiKey: string, weight = 1, cooldownMs = this.defaultCooldownMs): PooledKey {
    const cleanProvider = provider.toLowerCase();
    const providerKeys = this.keys.get(cleanProvider) || [];

    // Avoid duplicate keys
    const existing = providerKeys.find(k => k.apiKey === apiKey);
    if (existing) {
      existing.weight = weight;
      existing.cooldownMs = cooldownMs;
      return existing;
    }

    const keyObj: PooledKey = {
      id: `${cleanProvider}-key-${providerKeys.length + 1}-${Math.random().toString(36).substring(2, 6)}`,
      provider: cleanProvider,
      apiKey,
      weight,
      active: true,
      rateLimitedUntil: 0,
      failureCount: 0,
      successCount: 0,
      lastUsed: 0,
      cooldownMs,
    };

    providerKeys.push(keyObj);
    this.keys.set(cleanProvider, providerKeys);
    return keyObj;
  }

  /**
   * Populate keys from comma-separated string or array
   */
  loadKeys(provider: string, keysInput: string | string[]): void {
    const list = Array.isArray(keysInput)
      ? keysInput
      : keysInput.split(',').map(s => s.trim()).filter(Boolean);

    for (const k of list) {
      this.addKey(provider, k);
    }
  }

  /**
   * Acquire the next healthy key for a provider using round-robin rotation
   */
  acquireKey(provider: string): PooledKey | null {
    const cleanProvider = provider.toLowerCase();
    const list = this.keys.get(cleanProvider);
    if (!list || list.length === 0) {
      return null;
    }

    const now = Date.now();
    // Filter available keys (not inactive and not currently in 429 rate-limit cooldown)
    const available = list.filter(k => k.active && k.rateLimitedUntil <= now);

    if (available.length === 0) {
      // If all keys are rate-limited, find the one that expires soonest
      const leastWaitKey = [...list].filter(k => k.active).sort((a, b) => a.rateLimitedUntil - b.rateLimitedUntil)[0];
      return leastWaitKey || null;
    }

    let idx = this.roundRobinIndices.get(cleanProvider) || 0;
    idx = idx % available.length;
    const selected = available[idx];
    this.roundRobinIndices.set(cleanProvider, (idx + 1) % available.length);

    selected.lastUsed = now;
    return selected;
  }

  /**
   * Report a 429 or failure on an API key, triggering immediate quarantine
   */
  reportRateLimited(provider: string, apiKey: string, retryAfterSeconds?: number): void {
    const cleanProvider = provider.toLowerCase();
    const list = this.keys.get(cleanProvider);
    if (!list) return;

    const key = list.find(k => k.apiKey === apiKey);
    if (!key) return;

    key.failureCount++;
    const cooldown = retryAfterSeconds
      ? retryAfterSeconds * 1000
      : Math.min(key.cooldownMs * Math.pow(1.5, Math.min(key.failureCount - 1, 4)), 300_000); // Exponential backoff up to 5 mins

    key.rateLimitedUntil = Date.now() + cooldown;
  }

  /**
   * Report a successful execution
   */
  reportSuccess(provider: string, apiKey: string): void {
    const cleanProvider = provider.toLowerCase();
    const list = this.keys.get(cleanProvider);
    if (!list) return;

    const key = list.find(k => k.apiKey === apiKey);
    if (key) {
      key.successCount++;
      key.failureCount = Math.max(0, key.failureCount - 1);
    }
  }

  /**
   * Inspect status of key pools
   */
  getStats(provider?: string): KeyPoolStats[] {
    const now = Date.now();
    const providers = provider ? [provider.toLowerCase()] : Array.from(this.keys.keys());

    return providers.map(p => {
      const list = this.keys.get(p) || [];
      const healthy = list.filter(k => k.active && k.rateLimitedUntil <= now).length;
      const quarantined = list.length - healthy;

      return {
        provider: p,
        totalKeys: list.length,
        healthyKeys: healthy,
        quarantinedKeys: quarantined,
        keys: list.map(k => ({
          id: k.id,
          maskedKey: maskKey(k.apiKey),
          status: !k.active ? 'disabled' : (k.rateLimitedUntil > now ? 'rate_limited' : 'healthy'),
          failureCount: k.failureCount,
          successCount: k.successCount,
          cooldownRemainingSec: Math.max(0, Math.ceil((k.rateLimitedUntil - now) / 1000)),
        })),
      };
    });
  }

  /**
   * Check if any keys are configured for provider
   */
  hasKeys(provider: string): boolean {
    const list = this.keys.get(provider.toLowerCase());
    return !!(list && list.length > 0);
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
