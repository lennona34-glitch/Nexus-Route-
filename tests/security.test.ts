import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { isInsideDir, sanitizeWorkspacePath } from '../src/security/path.js';
import { validatePublicHttpUrl } from '../src/security/ssrf.js';
import { AdminAuthService } from '../src/security/auth.js';
import { ResponseCache } from '../src/cache/cache.js';
import { UniversalRequest, UniversalResponse } from '../src/ir/types.js';

describe('Security Utilities & Defense-in-Depth', () => {
  describe('Path Canonicalization & Workspace Containment (isInsideDir & sanitizeWorkspacePath)', () => {
    const parentDir = path.resolve('C:/workspace/root');

    it('should permit files inside the workspace root', () => {
      const target = path.resolve(parentDir, 'projects/app/main.js');
      expect(isInsideDir(target, parentDir)).toBe(true);
    });

    it('should reject directory traversal with ../ sequence', () => {
      const target = path.resolve(parentDir, '../outside/secret.txt');
      expect(isInsideDir(target, parentDir)).toBe(false);
    });

    it('should reject sibling prefix attacks (e.g. root_evil)', () => {
      const sibling = path.resolve('C:/workspace/root_evil/hack.js');
      expect(isInsideDir(sibling, parentDir)).toBe(false);
    });

    it('should sanitize safe relative paths correctly', () => {
      const safe = sanitizeWorkspacePath('art/flower.png', parentDir);
      expect(safe).toBe(path.join(parentDir, 'art/flower.png'));
    });

    it('should throw an error on malicious traversal in sanitizeWorkspacePath', () => {
      expect(() => sanitizeWorkspacePath('../../windows/system32/cmd.exe', parentDir)).toThrow();
    });

    it('should block Desktop targets by default in sandboxed mode', () => {
      const userProfile = process.env.USERPROFILE || os.homedir();
      const desktopTarget = path.resolve(userProfile, 'Desktop', 'rogue_file.txt');
      expect(() => sanitizeWorkspacePath(desktopTarget, parentDir, { fullAccess: false, blockDesktop: true })).toThrow(/Writing to Desktop is prohibited/);
    });

    it('should block paths outside workspace in sandboxed mode', () => {
      const userProfile = process.env.USERPROFILE || os.homedir();
      const outsideTarget = path.resolve(userProfile, 'Documents', 'other.txt');
      expect(() => sanitizeWorkspacePath(outsideTarget, parentDir, { fullAccess: false })).toThrow(/resolves outside designated workspace/);
    });

    it('should permit user directory in trusted mode while still shielding Desktop if blockDesktop is true', () => {
      const userProfile = process.env.USERPROFILE || os.homedir();
      const userDoc = path.resolve(userProfile, 'Documents', 'project.txt');
      const desktopTarget = path.resolve(userProfile, 'Desktop', 'app.txt');

      // Allowed in trusted mode
      const sanitized = sanitizeWorkspacePath(userDoc, parentDir, { fullAccess: true, blockDesktop: true });
      expect(sanitized).toBe(userDoc);

      // Desktop still blocked because blockDesktop is true
      expect(() => sanitizeWorkspacePath(desktopTarget, parentDir, { fullAccess: true, blockDesktop: true })).toThrow(/Writing to Desktop is prohibited/);
    });

    it('should permit Desktop only when fullAccess is true and blockDesktop is false', () => {
      const userProfile = process.env.USERPROFILE || os.homedir();
      const desktopTarget = path.resolve(userProfile, 'Desktop', 'allowed.txt');
      const sanitized = sanitizeWorkspacePath(desktopTarget, parentDir, { fullAccess: true, blockDesktop: false });
      expect(sanitized).toBe(desktopTarget);
    });

    it('should always reject Windows system directory even in trusted mode', () => {
      const winTarget = 'C:\\Windows\\System32\\bad.dll';
      expect(() => sanitizeWorkspacePath(winTarget, parentDir, { fullAccess: true, blockDesktop: false })).toThrow(/system directory/);
    });
  });

  describe('SSRF Protection (validatePublicHttpUrl)', () => {
    it('should allow valid public HTTPS and HTTP URLs', () => {
      expect(validatePublicHttpUrl('https://images.unsplash.com/photo-123.jpg').valid).toBe(true);
      expect(validatePublicHttpUrl('http://cdn.example.com/art.png').valid).toBe(true);
    });

    it('should reject localhost and loopback IP addresses', () => {
      expect(validatePublicHttpUrl('http://localhost:8080/admin').valid).toBe(false);
      expect(validatePublicHttpUrl('http://127.0.0.1:5005/secret').valid).toBe(false);
      expect(validatePublicHttpUrl('http://127.0.0.2/api').valid).toBe(false);
    });

    it('should reject private RFC 1918 networks', () => {
      expect(validatePublicHttpUrl('http://10.0.0.1/status').valid).toBe(false);
      expect(validatePublicHttpUrl('http://172.16.0.5:8000/internal').valid).toBe(false);
      expect(validatePublicHttpUrl('http://192.168.1.1/router').valid).toBe(false);
    });

    it('should reject AWS / Cloud metadata endpoints', () => {
      expect(validatePublicHttpUrl('http://169.254.169.254/latest/meta-data/').valid).toBe(false);
    });

    it('should reject non-HTTP protocols (file, ftp, javascript, gopher)', () => {
      expect(validatePublicHttpUrl('file:///etc/passwd').valid).toBe(false);
      expect(validatePublicHttpUrl('ftp://example.com/file').valid).toBe(false);
      expect(validatePublicHttpUrl('javascript:alert(1)').valid).toBe(false);
    });
  });

  describe('Admin Authentication Service (AdminAuthService)', () => {
    it('should validate bearer tokens in constant time', () => {
      const auth = new AdminAuthService('data/.test_admin_secret');
      const key = auth.getAdminKey();
      expect(key.length).toBeGreaterThan(16);

      expect(auth.validate(`Bearer ${key}`)).toBe(true);
      expect(auth.validate(key)).toBe(true);
      expect(auth.validate('Bearer invalid-token')).toBe(false);
      expect(auth.validate('')).toBe(false);
    });
  });

  describe('Semantic Caching Safety (Tool Bypass & Parameter Hashing)', () => {
    it('should strictly bypass caching for requests bearing tools or enable_tools', () => {
      const cache = new ResponseCache();
      const toolReq: UniversalRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Generate a file for me' }],
        enable_tools: true,
        tools: [
          {
            type: 'function',
            function: { name: 'write_file', description: 'Write file' },
          },
        ],
      };

      const dummyResp: UniversalResponse = {
        id: '1',
        object: 'chat.completion',
        created: 1,
        model: 'mock-gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      cache.set(toolReq, dummyResp);
      expect(cache.get(toolReq)).toBeNull(); // Must never cache tool executions
    });

    it('should generate distinct cache entries for different parameters (top_p, max_tokens, art_engine)', () => {
      const cache = new ResponseCache({ enabled: true });
      const reqA: UniversalRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        top_p: 0.9,
      };
      const reqB: UniversalRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        top_p: 0.5,
      };
      const reqC: UniversalRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        art_engine: 'gpu',
      };

      const respA: UniversalResponse = {
        id: '1',
        object: 'chat.completion',
        created: 1,
        model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      cache.set(reqA, respA);
      expect(cache.get(reqA)?.response.choices[0].message.content).toBe('A');
      expect(cache.get(reqB)).toBeNull();
      expect(cache.get(reqC)).toBeNull();
    });
  });
});
