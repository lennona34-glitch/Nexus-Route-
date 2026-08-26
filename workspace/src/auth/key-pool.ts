export interface KeyEntry {
  key: string;
  provider: string;
  weight?: number;
  label?: string;
  active: boolean;
  consecutiveFailures: number;
  lastUsedAt?: number;
  cooldownUntil?: number;
  totalRequests: number;
  totalTokens: number;
}

export class KeyPool {
  private pools: Map<string, KeyEntry[]> = new Map();
  private defaultCooldownMs: number = 60_000; // 1 minute cooldown on 429

  constructor() {
    this.initFromEnvironment();
  }

  /**
   * Initializes multi-key pools from environment variables.
   * Supports comma-separated keys (e.g. GEMINI_API_KEYS="key1,key2,key3" or GROQ_API_KEYS="k1,k2")
   */
  public initFromEnvironment(): void {
    const providerEnvMap: Record<string, string[]> = {
      gemini: ['GEMINI_API_KEYS', 'GEMINI_API_KEY'],
      openai: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEYS', 'ANTHROPIC_API_KEY'],
      deepseek: ['DEEPSEEK_API_KEYS', 'DEEPSEEK_API_KEY'],
      groq: ['GROQ_API_KEYS', 'GROQ_API_KEY'],
      openrouter: ['OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'],
      github: ['GITHUB_TOKEN', 'GITHUB_TOKENS', 'GH_TOKEN'],
    };

    for (const [provider, envVars] of Object.entries(providerEnvMap)) {
      const keys: string[] = [];
      for (const envVar of envVars) {
        const val = process.env[envVar];
        if (val) {
          const split = val.split(',').map((k) => k.trim()).filter(Boolean);
          keys.push(...split);
        }
      }

      // De-duplicate
      const uniqueKeys = Array.from(new Set(keys));
      for (const key of uniqueKeys) {
        this.addKey(provider, key);
      }
    }
  }

  public addKey(provider: string, key: string, label?: string, weight: number = 1): void {
    const normProvider = provider.toLowerCase();
    if (!this.pools.has(normProvider)) {
      this.pools.set(normProvider, []);
    }

    const pool = this.pools.get(normProvider)!;
    if (!pool.some((k) => k.key === key)) {
      pool.push({
        key,
        provider: normProvider,
        weight,
        label: label || `${normProvider}-key-${pool.length + 1}`,
        active: true,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalTokens: 0,
      });
    }
  }

  /**
   * Selects an active key for a provider using least-recently-used + cooldown verification.
   */
  public getKey(provider: string): string | null {
    const normProvider = provider.toLowerCase();
    const pool = this.pools.get(normProvider);
    if (!pool || pool.length === 0) {
      return null;
    }

    const now = Date.now();
    // Filter available keys (not in cooldown)
    const available = pool.filter((k) => k.active && (!k.cooldownUntil || k.cooldownUntil <= now));

    if (available.length === 0) {
      // All keys cooling down; return the one that will recover earliest
      const earliest = [...pool].sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0))[0];
      return earliest ? earliest.key : null;
    }

    // Pick least recently used among available
    available.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    const chosen = available[0];
    chosen.lastUsedAt = now;
    chosen.totalRequests++;
    return chosen.key;
  }

  /**
   * Reports a failure (429 rate limit or 401 unauthorized).
   * 429 triggers an automatic backoff/cooldown rotation.
   */
  public reportFailure(provider: string, key: string, statusCode: number): void {
    const normProvider = provider.toLowerCase();
    const pool = this.pools.get(normProvider);
    if (!pool) return;

    const entry = pool.find((k) => k.key === key);
    if (!entry) return;

    entry.consecutiveFailures++;

    if (statusCode === 429) {
      // Exponential backoff cooldown (1m, 2m, 4m...)
      const mult = Math.min(Math.pow(2, entry.consecutiveFailures - 1), 16);
      entry.cooldownUntil = Date.now() + this.defaultCooldownMs * mult;
    } else if (statusCode === 401 || statusCode === 403) {
      // Invalid key - deactivate
      entry.active = false;
    }
  }

  /**
   * Reports a successful request to reset failure counts.
   */
  public reportSuccess(provider: string, key: string, tokensUsed: number = 0): void {
    const normProvider = provider.toLowerCase();
    const pool = this.pools.get(normProvider);
    if (!pool) return;

    const entry = pool.find((k) => k.key === key);
    if (entry) {
      entry.consecutiveFailures = 0;
      entry.cooldownUntil = undefined;
      entry.totalTokens += tokensUsed;
    }
  }

  public getStatus(): Record<string, { totalKeys: number; activeKeys: number; coolingDown: number }> {
    const now = Date.now();
    const result: Record<string, { totalKeys: number; activeKeys: number; coolingDown: number }> = {};

    for (const [provider, pool] of this.pools.entries()) {
      const active = pool.filter((k) => k.active).length;
      const cooling = pool.filter((k) => k.active && k.cooldownUntil && k.cooldownUntil > now).length;
      result[provider] = {
        totalKeys: pool.length,
        activeKeys: active,
        coolingDown: cooling,
      };
    }
    return result;
  }
}

export const globalKeyPool = new KeyPool();
