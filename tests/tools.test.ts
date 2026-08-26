import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { IntentClassifier } from '../src/router/classifier.js';
import { UniversalRequest } from '../src/ir/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('ToolRegistry', () => {
  it('exposes a post-click HTML runtime test tool', () => {
    const tool = ToolRegistry.getBuiltInTools().find(item => item.function.name === 'test_html_app');
    expect(tool).toBeDefined();
    expect(tool?.function.description).toContain('clicks');
    expect(tool?.function.parameters.required).toContain('filename');
  });

  it('should execute calculator tool accurately', async () => {
    const resStr = await ToolRegistry.executeTool('calculator', JSON.stringify({ expression: '4829 * 1928' }));
    const res = JSON.parse(resStr);
    expect(res.result).toBe(9310312);
  });

  it('should execute get_current_time tool', async () => {
    const resStr = await ToolRegistry.executeTool('get_current_time', '{}');
    const res = JSON.parse(resStr);
    expect(res.iso).toBeDefined();
    expect(res.timezone).toBeDefined();
  });

  it('should parse DeepSeek DSML and XML invoke tool calls correctly', () => {
    const dsmlText = `I will read the source code:
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="path" string="true">android/StarWarsShooter/src/com/nexus/starwars/MainActivity.java</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(dsmlText);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('read_file');
    expect((parsed[0].arguments as any).path).toBe('android/StarWarsShooter/src/com/nexus/starwars/MainActivity.java');
  });

  it('should parse local-model function/arguments JSON aliases', () => {
    const parsed = ToolRegistry.extractAllToolCallsFromJson(
      '{"function":"write_file","arguments":{"filename":"projects/example.txt","content":"hello"}}'
    );
    expect(parsed).toEqual([{ name: 'write_file', arguments: { filename: 'projects/example.txt', content: 'hello' } }]);
  });

  it('should patch one exact block without rewriting the whole file', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-patch-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    fs.writeFileSync(path.join(testWorkspace, 'game.html'), '<button>Audio off</button>\n<script>const enabled=false;</script>', 'utf8');
    try {
      const result = JSON.parse(await ToolRegistry.executeTool('patch_file', JSON.stringify({
        filename: 'game.html',
        old_text: 'const enabled=false;',
        new_text: 'const enabled=true;',
      })));
      expect(result.success).toBe(true);
      expect(result.replacements).toBe(1);
      expect(fs.readFileSync(path.join(testWorkspace, 'game.html'), 'utf8')).toContain('const enabled=true;');
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });
});

describe('IntentClassifier', () => {
  it('should classify greetings as TRIVIAL with fast tier', () => {
    const req: UniversalRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const res = IntentClassifier.classify(req);
    expect(res.category).toBe('TRIVIAL');
    expect(res.recommendedTier).toBe('fast');
  });

  it('should classify code requests as CODE_DEV with coding tier', () => {
    const req: UniversalRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Write a TypeScript function to debounce an API call' }],
    };
    const res = IntentClassifier.classify(req);
    expect(res.category).toBe('CODE_DEV');
    expect(res.recommendedTier).toBe('coding');
  });

  it('should classify math/reasoning requests as REASONING tier', () => {
    const req: UniversalRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Solve this equation step by step and prove the theorem' }],
    };
    const res = IntentClassifier.classify(req);
    expect(res.category).toBe('REASONING');
    expect(res.recommendedTier).toBe('reasoning');
  });
});
