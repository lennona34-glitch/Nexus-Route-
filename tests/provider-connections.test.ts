import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProviderConnectionManager } from '../src/providers/connection-manager.js';

const tempDirs: string[] = [];

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusroute-connections-'));
  tempDirs.push(dir);
  return new ProviderConnectionManager({ storagePath: path.join(dir, 'connections.json'), hydrateEnvironment: false });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('provider connection pools', () => {
  it('rotates healthy keys and skips a rate-limited connection', () => {
    const pool = manager();
    const first = pool.addConnection('gemini', 'first-test-key-12345', { label: 'Main' });
    const second = pool.addConnection('gemini', 'second-test-key-67890', { label: 'Spare' });

    expect(pool.acquire('gemini')?.id).toBe(first.id);
    pool.recordFailure(first.id, 429, 'Rate limited', 60_000);
    expect(pool.acquire('gemini')?.id).toBe(second.id);

    const publicConnections = pool.listPublic();
    expect(publicConnections.find(item => item.id === first.id)?.status).toBe('cooldown');
    expect(JSON.stringify(publicConnections)).not.toContain('first-test-key-12345');
  });

  it('tracks a declared quota and makes reset recoverable', () => {
    const pool = manager();
    const connection = pool.addConnection('groq', 'quota-test-key-12345', {
      quotaLimit: 2,
      quotaUnit: 'requests',
      resetInterval: 'manual',
    });

    pool.recordUsage(connection.id);
    pool.recordUsage(connection.id);
    expect(pool.hasUsable('groq')).toBe(false);
    expect(pool.listPublic()[0].status).toBe('exhausted');

    expect(pool.resetConnection(connection.id)).toBe(true);
    expect(pool.listPublic()[0].status).toBe('ready');
    expect(pool.listPublic()[0].quotaUsed).toBe(0);
  });

  it('does not duplicate environment secrets into the JSON store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusroute-env-secret-'));
    tempDirs.push(dir);
    const storagePath = path.join(dir, 'connections.json');
    const pool = new ProviderConnectionManager({ storagePath, hydrateEnvironment: false });

    pool.addConnection('gemini', 'env-only-secret-12345', {
      source: 'environment',
      label: 'GEMINI_API_KEY',
    });

    expect(fs.readFileSync(storagePath, 'utf8')).not.toContain('env-only-secret-12345');
    expect(pool.listPublic()).toHaveLength(1);
  });

  it('rotates and cools down independent xAI connections', () => {
    const pool = manager();
    const first = pool.addConnection('xai', 'first-xai-key-12345');
    const second = pool.addConnection('xai', 'second-xai-key-67890');

    expect(pool.acquire('xai')?.id).toBe(first.id);
    pool.recordFailure(first.id, 503, 'Temporary xAI outage');
    expect(pool.acquire('xai')?.id).toBe(second.id);
    expect(pool.listPublic().find(item => item.id === first.id)?.status).toBe('cooldown');
  });
});
