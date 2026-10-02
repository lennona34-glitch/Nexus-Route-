import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { compressCommandOutput } from '../src/tools/registry.js';
import { validateAndNormalizeRequest } from '../src/ir/validator.js';
import { RoutingEngine } from '../src/router/engine.js';
import { FACTORY_DEFAULTS } from '../src/router/prompts-config.js';

describe('Token Optimization & Compression Suite', () => {
  const tmpWs = path.join(process.cwd(), 'workspace', 'test_token_compression');

  beforeEach(() => {
    if (!fs.existsSync(tmpWs)) {
      fs.mkdirSync(tmpWs, { recursive: true });
    }
  });

  describe('RTK Command Output Compression (compressCommandOutput)', () => {
    it('strips ANSI color codes and escapes from command output', () => {
      const raw = '\x1b[32mPASS\x1b[0m \x1b[1mtests/sample.test.ts\x1b[22m\r\nAll done!';
      const res = compressCommandOutput('node test.js', raw, '', true, tmpWs);
      expect(res.stdout).not.toContain('\x1b[');
      expect(res.stdout).toContain('PASS tests/sample.test.ts');
    });

    it('collapses passing vitest/jest test suites into a single summary line', () => {
      const vitestOutput = `
✓ tests/a.test.ts (2)
✓ tests/b.test.ts (5)
Test Files  2 passed (2)
     Tests  7 passed (7)
  Duration  1.2s
`;
      const res = compressCommandOutput('npx vitest run', vitestOutput, '', true, tmpWs);
      expect(res.compressed).toBe(true);
      expect(res.stdout).toContain('✓ All tests passed!');
      expect(res.stdout).toContain('7 passed');
      expect(res.stdout).not.toContain('✓ tests/a.test.ts');
    });

    it('preserves error details and failed assertions in test outputs', () => {
      const vitestFailOutput = `
✓ tests/a.test.ts (1)
FAIL tests/b.test.ts (1)
AssertionError: expected 400 to be 200
  at tests/b.test.ts:15:10
Test Files  1 failed | 1 passed (2)
`;
      const res = compressCommandOutput('npx vitest run', vitestFailOutput, '', false, tmpWs);
      expect(res.stdout).toContain('FAIL tests/b.test.ts');
      expect(res.stdout).toContain('AssertionError: expected 400 to be 200');
    });

    it('condenses git status and git commit commands', () => {
      const gitStatusOut = "On branch main\nYour branch is up to date.\n(use \"git add <file>...\" to update what will be committed)\n\tmodified:   src/app.ts\nno changes added to commit";
      const resStatus = compressCommandOutput('git status', gitStatusOut, '', true, tmpWs);
      expect(resStatus.compressed).toBe(true);
      expect(resStatus.stdout).not.toContain('use "git add');
      expect(resStatus.stdout).toContain('modified:   src/app.ts');

      const gitCommitOut = "[main 3a8b1c2] Fix token overhead\n 2 files changed, 10 insertions(+)";
      const resCommit = compressCommandOutput('git commit -m "Fix token overhead"', gitCommitOut, '', true, tmpWs);
      expect(resCommit.compressed).toBe(true);
      expect(resCommit.stdout).toBe('ok [3a8b1c2] Fix token overhead');

      const resAdd = compressCommandOutput('git add .', '', '', true, tmpWs);
      expect(resAdd.compressed).toBe(true);
      expect(resAdd.stdout).toBe('ok');
    });

    it('compacts clean build commands', () => {
      const resBuild = compressCommandOutput('tsc', '', '', true, tmpWs);
      expect(resBuild.compressed).toBe(true);
      expect(resBuild.stdout).toBe('✓ Build succeeded with 0 errors.');
    });

    it('spools large outputs to disk when exceeding buffer limits', () => {
      const largeOutput = 'A'.repeat(4000);
      const res = compressCommandOutput('cat large.txt', largeOutput, '', true, tmpWs);
      expect(res.compressed).toBe(true);
      expect(res.rawLogPath).toBeDefined();
      expect(res.stdout).toContain('... [RTK Compactor:');
      if (res.rawLogPath) {
        const fullLog = path.join(tmpWs, res.rawLogPath);
        expect(fs.existsSync(fullLog)).toBe(true);
        const diskContent = fs.readFileSync(fullLog, 'utf8');
        expect(diskContent).toContain(largeOutput);
      }
    });
  });

  describe('IR Validator Extensions', () => {
    it('normalizes valid reasoning_effort and caveman_mode', () => {
      const req = validateAndNormalizeRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'low',
        caveman_mode: true,
      });
      expect(req.reasoning_effort).toBe('low');
      expect(req.caveman_mode).toBe(true);
    });

    it('rejects invalid reasoning_effort values and defaults to undefined', () => {
      const req = validateAndNormalizeRequest({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'ultra-mega',
      });
      expect(req.reasoning_effort).toBeUndefined();
    });
  });

  describe('Prompt Integration & Autonomous Rules', () => {
    it('injects the Ponytail Senior Dev Decision Ladder by default', () => {
      const engine = new RoutingEngine({
        default_virtual_model: 'auto',
        virtual_models: {
          auto: {
            description: 'test',
            strategy: 'cascade',
            routes: [{ provider: 'mock', model: 'mock-model' }],
          },
        },
        providers: {},
      });

      const prepared = (engine as any).ensureAutonomousPrompt({
        model: 'auto',
        enable_tools: true,
        messages: [{ role: 'user', content: 'build a calculator' }],
      });

      const systemMsg = prepared.messages.find((m: any) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('PONYTAIL RULE');
      expect(systemMsg.content).toContain('Avoid premature abstractions');
      expect(systemMsg.content).toContain('Zero hallucinated dependencies');
    });

    it('injects Caveman Terse Mode when enabled in request', () => {
      const engine = new RoutingEngine({
        default_virtual_model: 'auto',
        virtual_models: {
          auto: {
            description: 'test',
            strategy: 'cascade',
            routes: [{ provider: 'mock', model: 'mock-model' }],
          },
        },
        providers: {},
      });

      const normal = (engine as any).ensureAutonomousPrompt({
        model: 'auto',
        enable_tools: true,
        messages: [{ role: 'user', content: 'hello' }],
        caveman_mode: false,
      });
      const normalSys = normal.messages.find((m: any) => m.role === 'system')?.content || '';
      expect(normalSys).not.toContain('CAVEMAN TERSE MODE');

      const terse = (engine as any).ensureAutonomousPrompt({
        model: 'auto',
        enable_tools: true,
        messages: [{ role: 'user', content: 'hello' }],
        caveman_mode: true,
      });
      const terseSys = terse.messages.find((m: any) => m.role === 'system')?.content || '';
      expect(terseSys).toContain('CAVEMAN TERSE MODE');
      expect(terseSys).toContain('Brain big, mouth small');
    });
  });
});
