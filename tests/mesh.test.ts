import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ShareManager } from '../src/mesh/shares.js';
import { MeshHub } from '../src/mesh/hub.js';
import { SecurityError } from '../src/security/path.js';

describe('Nexus Mesh - ShareManager & Security', () => {
  let tempDir: string;
  let shareManager: ShareManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mesh-test-'));
    // Setup nested files
    const subDir = path.join(tempDir, 'models');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'wan2.1-t2v.safetensors'), 'dummy-model-content');
    fs.writeFileSync(path.join(tempDir, 'retro_game.dsk'), 'dummy-dsk-content');
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_KEY=12345');
    fs.writeFileSync(path.join(tempDir, 'id_rsa'), 'private-key');

    shareManager = new ShareManager([tempDir]);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { }
  });

  it('scans directories and ignores sensitive files (.env, id_rsa)', () => {
    const tree = shareManager.getTree();
    expect(tree.length).toBe(1);
    const root = tree[0];

    // Find children
    const childNames = root.children?.map(c => c.name) || [];
    expect(childNames).toContain('models');
    expect(childNames).toContain('retro_game.dsk');
    expect(childNames).not.toContain('.env');
    expect(childNames).not.toContain('id_rsa');

    // Check stats
    const stats = shareManager.getStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it('searches files across shared folders', () => {
    const results = shareManager.search('dsk', 'peer1', 'RetroGamer');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('retro_game.dsk');
    expect(results[0].peerHandle).toBe('RetroGamer');
    expect(results[0].category).toBe('retro');

    const modelResults = shareManager.search('wan2.1');
    expect(modelResults.length).toBe(1);
    expect(modelResults[0].name).toBe('wan2.1-t2v.safetensors');
    expect(modelResults[0].category).toBe('models');
  });

  it('safely resolves allowed files and blocks directory traversal', () => {
    const resolved = shareManager.resolveSafeFile('retro_game.dsk');
    expect(fs.existsSync(resolved.absolutePath)).toBe(true);
    expect(resolved.size).toBe('dummy-dsk-content'.length);

    // Traversal attack
    expect(() => {
      shareManager.resolveSafeFile('../../../Windows/System32/calc.exe');
    }).toThrow(SecurityError);

    // Blocked file attack
    expect(() => {
      shareManager.resolveSafeFile('.env');
    }).toThrow(SecurityError);
  });
});

describe('Nexus Mesh - Hub & Peer Messaging', () => {
  let tempDir: string;
  let shareManager: ShareManager;
  let hub: MeshHub;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hub-test-'));
    shareManager = new ShareManager([tempDir]);
    hub = new MeshHub(shareManager, {
      hubName: 'Test Hub',
      handle: 'HostCommander',
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { }
  });

  it('registers host and accepts guest peers', () => {
    const peers = hub.getPeers();
    expect(peers.length).toBe(1);
    expect(peers[0].handle).toBe('HostCommander');
    expect(peers[0].isHost).toBe(true);

    const guest = hub.registerPeer({
      handle: 'CyberPunk42',
      filesCount: 15,
      totalBytes: 5000000,
    });

    const updatedPeers = hub.getPeers();
    expect(updatedPeers.length).toBe(2);
    expect(updatedPeers.some(p => p.handle === 'CyberPunk42')).toBe(true);
  });

  it('handles chat messages and triggers @nexus AI', async () => {
    let aiCalled = false;
    hub.setAiHandlers(async (prompt) => {
      aiCalled = true;
      return `AI response to: ${prompt}`;
    });

    const userMsg = hub.postMessage('host', 'Hello @nexus, give us some wisdom!');
    expect(userMsg.text).toContain('Hello @nexus');

    // Wait a tick for async AI trigger
    await new Promise(r => setTimeout(r, 50));

    expect(aiCalled).toBe(true);
    const messages = hub.getMessages();
    const aiMessage = messages.find(m => m.isAi);
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.text).toContain('AI response to:');
  });

  it('fans out search queries across the mesh', () => {
    let searchBroadcast: any = null;
    hub.subscribe((event, payload) => {
      if (event === 'search_query') {
        searchBroadcast = payload;
      }
    });

    hub.searchAcrossMesh('synth', 'peer-1');
    expect(searchBroadcast).toBeDefined();
    expect(searchBroadcast.query).toBe('synth');
  });
});

describe('Nexus Mesh - Server HTTP Endpoints', () => {
  it('GET /v1/mesh/status returns 200 with config and peer list', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({ method: 'GET', url: '/v1/mesh/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.config).toBeDefined();
    expect(Array.isArray(body.peers)).toBe(true);
    expect(body.stats).toBeDefined();
  });

  it('POST /v1/mesh/chat posts a message and returns success', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mesh/chat',
      payload: {
        peerId: 'host',
        text: 'Hello from automated endpoint test!',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message.text).toBe('Hello from automated endpoint test!');
  });

  it('GET /v1/mesh/shares/tree returns hierarchical file tree', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({ method: 'GET', url: '/v1/mesh/shares/tree' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.tree)).toBe(true);
  });

  it('POST /v1/mesh/register and GET /v1/mesh/peers manages peer list', async () => {
    const { app } = await import('../src/server.js');
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/mesh/register',
      payload: {
        peerId: 'test_peer_123',
        handle: 'RetroLover',
        avatar: '🕹️',
      },
    });
    expect(regRes.statusCode).toBe(200);
    expect(regRes.json().success).toBe(true);

    const peersRes = await app.inject({ method: 'GET', url: '/v1/mesh/peers' });
    expect(peersRes.statusCode).toBe(200);
    const peers = peersRes.json().peers;
    expect(peers.some((p: any) => p.id === 'test_peer_123')).toBe(true);

    const hbRes = await app.inject({
      method: 'POST',
      url: '/v1/mesh/heartbeat',
      payload: { peerId: 'test_peer_123' },
    });
    expect(hbRes.statusCode).toBe(200);
    expect(hbRes.json().success).toBe(true);
  });

  it('GET /v1/mesh/messages returns chat history', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({ method: 'GET', url: '/v1/mesh/messages' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('POST /v1/mesh/config updates room settings', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mesh/config',
      payload: {
        roomTitle: 'Synthwave Sanctuary',
        motd: 'Keep the dream alive.',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const statusRes = await app.inject({ method: 'GET', url: '/v1/mesh/status' });
    expect(statusRes.json().config.roomTitle).toBe('Synthwave Sanctuary');
  });

  it('GET /v1/mesh/shares/search searches shares correctly', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({ method: 'GET', url: '/v1/mesh/shares/search?q=test' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(Array.isArray(res.json().results)).toBe(true);
  });

  it('GET /v1/mesh/shares/download protects against directory traversal', async () => {
    const { app } = await import('../src/server.js');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/mesh/shares/download?path=../../Windows/System32/calc.exe',
    });
    // Should be rejected by Desktop Shield / path traversal guard
    expect(res.statusCode).toBe(403);
  });
});


