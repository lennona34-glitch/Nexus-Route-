import { ProviderType } from '../ir/types.js';

export interface SecretKeyRecord {
  provider: ProviderType;
  key: string;
  label?: string;
  active: boolean;
  priority?: number; // Higher priority attempted first
  created_at: number;
  last_used_at?: number;
  failure_count: number;
  last_failure_at?: number;
  cooldown_until?: number;
}

export class VaultManager {
  private keys: SecretKeyRecord[] = [];
  private roundRobinIndices = new Map<ProviderType, number>();

  constructor() {
    this.hydrateFromEnvironment();
  }

  /**
   * Initializes vault with known environment keys
   */
  public hydrateFromEnvironment(): void {
    const envMappings: Array<{ provider: ProviderType; envKey: string; label: string }> = [
      { provider: 'openai', envKey: 'OPENAI_API_KEY', label: 'Env: OPENAI_API_KEY' },
      { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', label: 'Env: ANTHROPIC_API_KEY' },
      { provider: 'gemini', envKey: 'GEMINI_API_KEY', label: 'Env: GEMINI_API_KEY' },
      { provider: 'gemini', envKey: 'GOOGLE_API_KEY', label: 'Env: GOOGLE_API_KEY' },
      { provider: 'groq', envKey: 'GROQ_API_KEY', label: 'Env: GROQ_API_KEY' },
      { provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', label: 'Env: DEEPSEEK_API_KEY' },
      { provider: 'xai', envKey: 'XAI_API_KEY', label: 'Env: XAI_API_KEY' },
      { provider: 'github', envKey: 'GITHUB_TOKEN', label: 'Env: GITHUB_TOKEN' },
      { provider: 'github', envKey: 'GH_TOKEN', label: 'Env: GH_TOKEN' },
      { provider: 'together', envKey: 'TOGETHER_API_KEY', label: 'Env: TOGETHER_API_KEY' },
      { provider: 'huggingface', envKey: 'HUGGINGFACE_API_KEY', label: 'Env: HUGGINGFACE_API_KEY' },
      { provider: 'huggingface', envKey: 'HF_TOKEN', label: 'Env: HF_TOKEN' },
      { provider: 'local', envKey: 'LOCAL_AI_API_KEY', label: 'Env: LOCAL_AI_API_KEY' },
    ];

    for (const mapping of envMappings) {
      const val = process.env[mapping.envKey];
      if (val && val.trim().length > 0) {
        this.addKey(mapping.provider, val.trim(), mapping.label, 10);
      }
    }
  }

  /**
   * Add a key to the vault
   */
  public addKey(provider: ProviderType, key: string, label?: string, priority: number = 10): void {
    const existing = this.keys.find(k => k.provider === provider && k.key === key);
    if (!existing) {
      this.keys.push({
        provider,
        key,
        label: label || `Key-${key.substring(0, 4)}...`,
        active: true,
        priority,
        created_at: Date.now(),
        failure_count: 0
      });
    } else {
      existing.active = true;
      existing.priority = priority;
    }
  }

  /**
   * Remove a key by value or label
   */
  public removeKey(provider: ProviderType, key: string): boolean {
    const idx = this.keys.findIndex(k => k.provider === provider && k.key === key);
    if (idx !== -1) {
      this.keys.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Acquire active key for provider using round-robin / healthy priority selection
   */
  public getActiveKey(provider: ProviderType): string | undefined {
    const now = Date.now();
    const available = this.keys.filter(k => {
      if (k.provider !== provider || !k.active) return false;
      if (k.cooldown_until && k.cooldown_until > now) return false;
      return true;
    });

    if (available.length === 0) {
      // Return any active key ignoring cooldown as last resort
      const lastResort = this.keys.find(k => k.provider === provider && k.active);
      return lastResort?.key;
    }

    // Sort by priority descending, then failure count ascending
    available.sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.failure_count - b.failure_count);

    const currentIndex = this.roundRobinIndices.get(provider) || 0;
    const selected = available[currentIndex % available.length];
    this.roundRobinIndices.set(provider, (currentIndex + 1) % available.length);

    selected.last_used_at = now;
    return selected.key;
  }

  /**
   * Get all active keys for provider
   */
  public getKeysForProvider(provider: ProviderType): string[] {
    return this.keys.filter(k => k.provider === provider && k.active).map(k => k.key);
  }

  /**
   * Record failure on a key (implements exponential key-level backoff)
   */
  public recordKeyFailure(provider: ProviderType, key: string, errorStatus?: number): void {
    const rec = this.keys.find(k => k.provider === provider && k.key === key);
    if (!rec) return;

    rec.failure_count++;
    rec.last_failure_at = Date.now();

    // If 401 Unauthorized or 403 Forbidden, deactivate permanently until manually re-enabled
    if (errorStatus === 401 || errorStatus === 403) {
      rec.active = false;
      console.warn(`[Vault] Key for ${provider} marked inactive due to auth error ${errorStatus}`);
    } else if (errorStatus === 429) {
      // Rate limited: cooldown for 60s
      rec.cooldown_until = Date.now() + 60_000;
    } else {
      // General error: brief 10s cooldown
      rec.cooldown_until = Date.now() + 10_000;
    }
  }

  /**
   * Record successful use of a key
   */
  public recordKeySuccess(provider: ProviderType, key: string): void {
    const rec = this.keys.find(k => k.provider === provider && k.key === key);
    if (rec) {
      rec.failure_count = Math.max(0, rec.failure_count - 1);
      rec.cooldown_until = undefined;
    }
  }

  /**
   * Safe status report (masks secret keys)
   */
  public getVaultStatus(): Array<{
    provider: ProviderType;
    label: string;
    active: boolean;
    masked_key: string;
    priority: number;
    failure_count: number;
    in_cooldown: boolean;
  }> {
    const now = Date.now();
    return this.keys.map(k => ({
      provider: k.provider,
      label: k.label || 'API Key',
      active: k.active,
      masked_key: k.key.length > 8 ? `${k.key.substring(0, 4)}...${k.key.substring(k.key.length - 4)}` : '****',
      priority: k.priority || 10,
      failure_count: k.failure_count,
      in_cooldown: !!(k.cooldown_until && k.cooldown_until > now)
    }));
  }
}

export const GlobalVault = new VaultManager();
