export interface KeyEntry {
  key: string;
  label?: string;
  addedAt: number;
  lastUsedAt?: number;
  errorCount: number;
  quarantinedUntil?: number; // timestamp in ms until quarantine expires
  quarantineReason?: string;
  isActive: boolean;
}

export interface ProviderKeyPool {
  provider: string;
  keys: KeyEntry[];
  currentIndex: number;
}

export class VaultManager {
  private pools: Map<string, ProviderKeyPool> = new Map();
  private gbpRate: number = 0.79; // Default USD -> GBP

  constructor() {
    this.initFromEnv();
  }

  private initFromEnv(): void {
    const envMappings: Record<string, string | undefined> = {
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      groq: process.env.GROQ_API_KEY,
      together: process.env.TOGETHER_API_KEY,
      mistral: process.env.MISTRAL_API_KEY,
      xai: process.env.XAI_API_KEY,
      local: 'local'
    };

    for (const [provider, keyStr] of Object.entries(envMappings)) {
      if (keyStr) {
        const keys = keyStr.split(',').map(k => k.trim()).filter(Boolean);
        for (const k of keys) {
          this.addKey(provider, k, 'env');
        }
      }
    }
  }

  public setGbpRate(rate: number): void {
    if (rate > 0) this.gbpRate = rate;
  }

  public getGbpRate(): number {
    return this.gbpRate;
  }

  public addKey(provider: string, key: string, label: string = 'manual'): boolean {
    if (!key || !key.trim()) return false;
    const cleanKey = key.trim();

    let pool = this.pools.get(provider);
    if (!pool) {
      pool = { provider, keys: [], currentIndex: 0 };
      this.pools.set(provider, pool);
    }

    if (pool.keys.some(k => k.key === cleanKey)) {
      return false; // Already exists
    }

    pool.keys.push({
      key: cleanKey,
      label,
      addedAt: Date.now(),
      errorCount: 0,
      isActive: true
    });
    return true;
  }

  public setKeysForProvider(provider: string, keys: string[]): void {
    const pool = { provider, keys: [], currentIndex: 0 } as ProviderKeyPool;
    for (const raw of keys) {
      const clean = raw.trim();
      if (clean) {
        pool.keys.push({
          key: clean,
          label: 'vault',
          addedAt: Date.now(),
          errorCount: 0,
          isActive: true
        });
      }
    }
    this.pools.set(provider, pool);
  }

  public removeKey(provider: string, key: string): boolean {
    const pool = this.pools.get(provider);
    if (!pool) return false;
    const initialLen = pool.keys.length;
    pool.keys = pool.keys.filter(k => k.key !== key.trim());
    return pool.keys.length < initialLen;
  }

  /**
   * Retrieves next available healthy (non-quarantined) API key with round-robin rotation.
   */
  public getActiveKey(provider: string): string | null {
    const pool = this.pools.get(provider);
    if (!pool || pool.keys.length === 0) {
      return null;
    }

    const now = Date.now();
    const available = pool.keys.filter(k => {
      if (!k.isActive) return false;
      if (k.quarantinedUntil && k.quarantinedUntil > now) return false;
      // Auto-lift expired quarantine
      if (k.quarantinedUntil && k.quarantinedUntil <= now) {
        k.quarantinedUntil = undefined;
        k.quarantineReason = undefined;
      }
      return true;
    });

    if (available.length === 0) {
      return null;
    }

    pool.currentIndex = (pool.currentIndex + 1) % available.length;
    const chosen = available[pool.currentIndex];
    chosen.lastUsedAt = now;
    return chosen.key;
  }

  /**
   * Quarantines a key on 429 (Rate Limit) or 401/403 (Auth/Revoked) error.
   */
  public reportKeyError(provider: string, key: string, status: number, errorMsg?: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;

    const entry = pool.keys.find(k => k.key === key);
    if (!entry) return;

    entry.errorCount++;

    if (status === 429) {
      // 429 Rate limited: Quarantine for 60 seconds (or exponential)
      const duration = Math.min(60000 * Math.pow(2, Math.min(entry.errorCount - 1, 4)), 300000);
      entry.quarantinedUntil = Date.now() + duration;
      entry.quarantineReason = `Rate Limited (HTTP 429) - Cooldown ${Math.round(duration / 1000)}s: ${errorMsg || 'Quota exceeded'}`;
      console.warn(`[Vault] Key for ${provider} quarantined until ${new Date(entry.quarantinedUntil).toISOString()}: ${entry.quarantineReason}`);
    } else if (status === 401 || status === 403) {
      // 401/403 Invalid / Revoked key: Deactivate permanently until manually restored
      entry.isActive = false;
      entry.quarantineReason = `Auth Failure (HTTP ${status}): ${errorMsg || 'Invalid API Key'}`;
      console.error(`[Vault] Key for ${provider} deactivated due to auth failure: ${entry.quarantineReason}`);
    }
  }

  public reportKeySuccess(provider: string, key: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;
    const entry = pool.keys.find(k => k.key === key);
    if (entry) {
      entry.errorCount = 0;
      entry.quarantinedUntil = undefined;
      entry.quarantineReason = undefined;
    }
  }

  public getPoolStatus(): Record<string, { total: number; healthy: number; quarantined: number; keys: any[] }> {
    const now = Date.now();
    const result: Record<string, any> = {};

    for (const [provider, pool] of this.pools.entries()) {
      let healthy = 0;
      let quarantined = 0;
      const sanitizedKeys = pool.keys.map(k => {
        const isQuarantined = !!(k.quarantinedUntil && k.quarantinedUntil > now);
        if (k.isActive && !isQuarantined) healthy++;
        if (isQuarantined) quarantined++;

        // Mask key for safety (show first 6 and last 4)
        const masked = k.key.length > 10 
          ? `${k.key.slice(0, 6)}...${k.key.slice(-4)}`
          : '••••••••';

        return {
          id: masked,
          label: k.label,
          isActive: k.isActive,
          isQuarantined,
          quarantinedUntil: k.quarantinedUntil,
          quarantineReason: k.quarantineReason,
          errorCount: k.errorCount,
          lastUsedAt: k.lastUsedAt
        };
      });

      result[provider] = {
        total: pool.keys.length,
        healthy,
        quarantined,
        keys: sanitizedKeys
      };
    }

    return result;
  }
}

export const GlobalVault = new VaultManager();
