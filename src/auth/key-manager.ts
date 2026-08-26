import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultStoragePath = path.join(__dirname, '../../config/virtual_keys.json');

export interface VirtualKey {
  id: string; // SHA-256 hash of the raw secret key
  keyMasked: string; // e.g. nr-live-••••••••12ab
  name: string;
  createdAt: number;
  rateLimitRpm: number;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  totalSpentUsd: number;
  lastResetDate: string; // YYYY-MM-DD
  allowedModels: string[];
  enabled: boolean;
}

export interface GeneratedKeyResult extends VirtualKey {
  rawKey: string; // Raw secret shown ONLY once upon generation
}

export class KeyManager {
  private keys = new Map<string, VirtualKey>();
  private requestCounts = new Map<string, { count: number; windowStart: number }>();
  private storagePath: string;

  constructor(storagePath?: string) {
    this.storagePath = storagePath || defaultStoragePath;
    this.loadKeys();
  }

  private hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw.trim()).digest('hex');
  }

  private getTodayDateString(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private loadKeys() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const list = JSON.parse(raw) as Array<VirtualKey & { keyHash?: string }>;
        for (const k of list) {
          // Backward compatibility for legacy unhashed keys
          if (!k.keyMasked && k.id && k.id.startsWith('nr-')) {
            const legacyRaw = k.id;
            const hash = this.hashToken(legacyRaw);
            k.id = hash;
            k.keyMasked = `nr-live-••••••••${legacyRaw.slice(-4)}`;
          }
          this.keys.set(k.id, k);
        }
      }
    } catch {
      // ignore read error
    }
  }

  private saveKeys() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.keys.values());
      fs.writeFileSync(this.storagePath, JSON.stringify(list, null, 2), 'utf8');
    } catch {
      // ignore write error
    }
  }

  generateKey(name: string, options?: { rateLimitRpm?: number; dailyBudgetUsd?: number; allowedModels?: string[] }): GeneratedKeyResult {
    const randomHex = crypto.randomBytes(16).toString('hex');
    const rawKey = `nr-live-${randomHex}`;
    const keyHash = this.hashToken(rawKey);
    const keyMasked = `nr-live-••••••••${rawKey.slice(-4)}`;

    const newKey: VirtualKey = {
      id: keyHash,
      keyMasked,
      name: name.trim() || 'Untitled App',
      createdAt: Date.now(),
      rateLimitRpm: options?.rateLimitRpm || 60,
      dailyBudgetUsd: options?.dailyBudgetUsd || 10.0,
      spentTodayUsd: 0,
      totalSpentUsd: 0,
      lastResetDate: this.getTodayDateString(),
      allowedModels: options?.allowedModels || ['*'],
      enabled: true,
    };

    this.keys.set(keyHash, newKey);
    this.saveKeys();

    return {
      ...newKey,
      rawKey,
    };
  }

  validateKey(token: string, requestedModel: string): { valid: boolean; error?: string; statusCode?: number; keyObj?: VirtualKey } {
    if (!token) {
      if (this.keys.size === 0) {
        return { valid: true }; // Open direct local development mode when no client keys exist
      }
      return {
        valid: false,
        error: 'Authentication required. Please provide a valid Virtual API Key in the Authorization header.',
        statusCode: 401,
      };
    }

    const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
    const tokenHash = this.hashToken(cleanToken);

    // Look up by hash (or fallback to legacy id)
    const keyObj = this.keys.get(tokenHash) || this.keys.get(cleanToken);
    if (!keyObj) {
      return { valid: false, error: 'Invalid or unrecognized NexusRoute Virtual Key.', statusCode: 401 };
    }

    if (!keyObj.enabled) {
      return { valid: false, error: 'This Virtual API Key has been revoked or disabled.', statusCode: 403 };
    }

    // Reset daily spend if date changed
    const today = this.getTodayDateString();
    if (keyObj.lastResetDate !== today) {
      keyObj.spentTodayUsd = 0;
      keyObj.lastResetDate = today;
      this.saveKeys();
    }

    // Check Daily Budget
    if (keyObj.dailyBudgetUsd > 0 && keyObj.spentTodayUsd >= keyObj.dailyBudgetUsd) {
      return {
        valid: false,
        error: `Daily spend limit of $${keyObj.dailyBudgetUsd.toFixed(2)} exceeded for key "${keyObj.name}".`,
        statusCode: 402,
      };
    }

    // Check Model Access
    if (!keyObj.allowedModels.includes('*') && !keyObj.allowedModels.includes(requestedModel)) {
      return {
        valid: false,
        error: `Model "${requestedModel}" is not authorized for this Virtual Key.`,
        statusCode: 403,
      };
    }

    // Check Rate Limiting (Sliding Minute Window)
    const now = Date.now();
    let rateData = this.requestCounts.get(tokenHash);
    if (!rateData || now - rateData.windowStart > 60000) {
      rateData = { count: 1, windowStart: now };
      this.requestCounts.set(tokenHash, rateData);
    } else {
      rateData.count++;
      if (rateData.count > keyObj.rateLimitRpm) {
        return {
          valid: false,
          error: `Rate limit of ${keyObj.rateLimitRpm} RPM exceeded for key "${keyObj.name}". Please slow down.`,
          statusCode: 429,
        };
      }
    }

    return { valid: true, keyObj };
  }

  recordUsage(tokenOrKeyId: string, costUsd: number) {
    if (!tokenOrKeyId || costUsd <= 0) return;
    const cleanToken = tokenOrKeyId.replace(/^Bearer\s+/i, '').trim();
    const tokenHash = this.hashToken(cleanToken);

    const keyObj = this.keys.get(tokenHash) || this.keys.get(cleanToken);
    if (!keyObj) return;

    keyObj.spentTodayUsd = Number((keyObj.spentTodayUsd + costUsd).toFixed(6));
    keyObj.totalSpentUsd = Number((keyObj.totalSpentUsd + costUsd).toFixed(6));
    this.saveKeys();
  }

  listKeys(): VirtualKey[] {
    return Array.from(this.keys.values());
  }

  revokeKey(id: string): boolean {
    const keyObj = this.keys.get(id);
    if (!keyObj) return false;
    keyObj.enabled = false;
    this.saveKeys();
    return true;
  }

  deleteKey(id: string): boolean {
    const res = this.keys.delete(id);
    this.saveKeys();
    return res;
  }
}
