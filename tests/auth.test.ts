import { describe, it, expect, beforeEach } from 'vitest';
import { KeyManager } from '../src/auth/key-manager.js';
import path from 'path';
import fs from 'fs';

describe('KeyManager & Multi-Tenancy (Hashed Storage)', () => {
  const testStorage = path.join(process.cwd(), 'scratch/test_virtual_keys.json');

  beforeEach(() => {
    if (fs.existsSync(testStorage)) {
      try { fs.unlinkSync(testStorage); } catch {}
    }
  });

  it('should generate, hash, and validate a virtual key', () => {
    const km = new KeyManager(testStorage);

    const key = km.generateKey('Test App', { dailyBudgetUsd: 5.0, rateLimitRpm: 10 });
    expect(key.rawKey).toBeDefined();
    expect(key.rawKey.startsWith('nr-live-')).toBe(true);
    expect(key.keyMasked).toBeDefined();
    expect(key.id).not.toBe(key.rawKey); // Stored as SHA-256 hash, not plaintext

    const validation = km.validateKey(`Bearer ${key.rawKey}`, 'auto');
    expect(validation.valid).toBe(true);
    expect(validation.keyObj?.name).toBe('Test App');

    // Stored list should never return rawKey
    const listed = km.listKeys();
    expect(listed.length).toBe(1);
    expect(listed[0].rawKey).toBeUndefined();
    expect(listed[0].keyMasked).toBeDefined();
  });

  it('should reject invalid keys', () => {
    const km = new KeyManager(testStorage);
    km.generateKey('Valid App');

    const validation = km.validateKey('Bearer nr-live-invalid123', 'auto');
    expect(validation.valid).toBe(false);
    expect(validation.statusCode).toBe(401);
  });

  it('should enforce rate limits per minute', () => {
    const km = new KeyManager(testStorage);
    const key = km.generateKey('RateLimited App', { rateLimitRpm: 2 });

    const v1 = km.validateKey(key.rawKey, 'auto');
    expect(v1.valid).toBe(true);

    const v2 = km.validateKey(key.rawKey, 'auto');
    expect(v2.valid).toBe(true);

    const v3 = km.validateKey(key.rawKey, 'auto');
    expect(v3.valid).toBe(false);
    expect(v3.statusCode).toBe(429);
  });

  it('should track daily spend and enforce budget caps', () => {
    const km = new KeyManager(testStorage);
    const key = km.generateKey('Budgeted App', { dailyBudgetUsd: 0.05 });

    km.recordUsage(key.rawKey, 0.03);
    expect(km.validateKey(key.rawKey, 'auto').valid).toBe(true);

    km.recordUsage(key.rawKey, 0.03); // Total 0.06 > 0.05
    const v = km.validateKey(key.rawKey, 'auto');
    expect(v.valid).toBe(false);
    expect(v.statusCode).toBe(402);
  });
});
