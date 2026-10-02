import { describe, it, expect } from 'vitest';
import { ToolRegistry, cleanToolFilename } from '../src/tools/registry.js';
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

  it('should parse Qwen XML <function=...> and <parameter=...> syntax', () => {
    const qwenText = `
<tool_call>
<function=list_files>
<parameter=path>
projects/New-Project-2
</parameter>
<parameter=pattern>
*
</parameter>
</function>
</tool_call>
`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(qwenText);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('list_workspace_files');
    expect((parsed[0].arguments as any).path).toBe('projects/New-Project-2');
    expect((parsed[0].arguments as any).pattern).toBe('*');
  });

  it('should parse multiple Qwen XML tool calls in a single turn', () => {
    const multiToolText = `
<tool_call>
<function=list_files>
<parameter=path>projects/New-Project-2</parameter>
</function>
</tool_call>
<tool_call>
<function=execute_command>
<parameter=command>
python -c "import scipy; print('scipy ok')"
python -c "import tkinter; print('tkinter ok')"
</parameter>
</function>
</tool_call>
`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(multiToolText);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe('list_workspace_files');
    expect((parsed[0].arguments as any).path).toBe('projects/New-Project-2');
    expect(parsed[1].name).toBe('execute_command');
    expect((parsed[1].arguments as any).command).toContain("import scipy; print('scipy ok')");
  });

  it('should parse standalone XML <function=...> tags without <tool_call> wrapper', () => {
    const standaloneXml = `
Let me read the file:
<function=read_file>
<parameter=path>projects/New-Project-2/README.md</parameter>
</function>
`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(standaloneXml);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('read_file');
    expect((parsed[0].arguments as any).path).toBe('projects/New-Project-2/README.md');
  });

  it('should parse user XML tool call for cd projects/New-Project-2 && python test_dsp.py', () => {
    const rawXml = `<tool_call>
<function=execute_command>
<parameter=command>
cd projects/New-Project-2 && python test_dsp.py
</parameter>
</function>
</tool_call>`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(rawXml);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('execute_command');
    expect((parsed[0].arguments as any).command).toBe('cd projects/New-Project-2 && python test_dsp.py');
  });

  it('should parse XML self-closing parameter attributes and JSON types', () => {
    const xmlWithAttributes = `
<function name="execute_command">
<parameter name="command" value="npm test" />
</function>
`;
    const parsed = ToolRegistry.extractAllToolCallsFromJson(xmlWithAttributes);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('execute_command');
    expect((parsed[0].arguments as any).command).toBe('npm test');
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

  it('allows writing a clean static HTML file without requiring script tags or audio synthesis', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-html-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const staticHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Hello</title>
  <style>
    body { display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #111; color: white; }
    h1 { font-size: 8rem; font-family: system-ui; }
  </style>
</head>
<body>
  <h1>HELLO</h1>
</body>
</html>`;

      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({
        filename: 'hello.html',
        content: staticHtml,
      }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(true);
      expect(result.autoOpened).toBe(false);
      expect(fs.existsSync(path.join(testWorkspace, 'hello.html'))).toBe(true);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects static HTML with placeholder script comments and advises removing script tag', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-static-hollow-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const placeholderHtml = `<!DOCTYPE html>
<html>
<head><title>Static Page</title></head>
<body>
  <h1>HELLO</h1>
  <script>
    // Add your javascript logic here
  </script>
</body>
</html>`;
      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({
        filename: 'hello.html',
        content: placeholderHtml,
      }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(false);
      expect(result.error).toContain('remove the <script> tag completely');
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects an interactive game that has a hollow script or zero controls', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hollow-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const hollowGame = `<!DOCTYPE html>
<html>
<head><title>Space Arcade</title></head>
<body>
  <h1>Space Arcade Game</h1>
  <script>
    // TODO: implement game loop
  </script>
</body>
</html>`;

      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({
        filename: 'space_arcade_game.html',
        content: hollowGame,
      }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(false);
      expect(result.error).toContain('WRITE REJECTED');
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects serialized tool-call JSON when writing source code', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tool-json-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({
        filename: 'boolCheck.js',
        content: '{"name":"write_file","arguments":{"filename":"boolCheck.js","content":"export const ok = true;"}} trailing tool text',
      }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(false);
      expect(result.error).toContain('TOOL OUTPUT');
      expect(fs.existsSync(path.join(testWorkspace, 'boolCheck.js'))).toBe(false);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects command instructions masquerading as source code', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tool-instruction-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({ filename: 'check.js', content: 'node check.test.js\nPlease share the output.' }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(false);
      expect(result.error).toContain('TOOL OUTPUT');
      expect(fs.existsSync(path.join(testWorkspace, 'check.js'))).toBe(false);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects JavaScript that fails the Node syntax check', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-syntax-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const resultStr = await ToolRegistry.executeTool('write_file', JSON.stringify({ filename: 'broken.js', content: 'function {' }));
      const result = JSON.parse(resultStr);
      expect(result.success).toBe(false);
      expect(result.error).toContain('SYNTAX');
      expect(fs.existsSync(path.join(testWorkspace, 'broken.js'))).toBe(false);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should clean markdown links and HTTP workspace URLs from raw filenames', () => {
    expect(cleanToolFilename('[🚀 gravity_sandbox.html(Launch Web App)](http://localhost:3000/v1/workspace/files/projects/New-Project-2/gravity_sandbox.html)'))
      .toBe('projects/New-Project-2/gravity_sandbox.html');
    expect(cleanToolFilename('[🚀 gravity_sandbox.html(Launch Web App)](http://localhost:3000/v1/workspace/files/gravity_sandbox.html)'))
      .toBe('gravity_sandbox.html');
    expect(cleanToolFilename('http://localhost:3000/v1/workspace/files/projects/New-Project-2/gravity_sandbox.html'))
      .toBe('projects/New-Project-2/gravity_sandbox.html');
    expect(cleanToolFilename('/v1/workspace/files/index.html'))
      .toBe('index.html');
    expect(cleanToolFilename('gravity_sandbox.html'))
      .toBe('gravity_sandbox.html');
  });

  it('should execute write_file cleanly when filename contains a markdown link', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mdlink-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const messages = await ToolRegistry.executeToolCalls(
        [{
          id: 'call_md_write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              filename: '[🚀 test_app.html(Launch Web App)](http://localhost:3000/v1/workspace/files/test_app.html)',
              content: '<!DOCTYPE html><html><body><canvas id="c"></canvas><script>console.log("ok");</script></body></html>',
            }),
          },
        }],
        undefined,
        { projectFolder: 'projects/New-Project-2' }
      );
      const parsed = JSON.parse(messages[0].content as string);
      expect(parsed.success).toBe(true);
      expect(parsed.filename).toBe('projects/New-Project-2/test_app.html');
      expect(fs.existsSync(path.join(testWorkspace, 'projects', 'New-Project-2', 'test_app.html'))).toBe(true);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should reject write_file when content is an internal compaction placeholder', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-compact-guard-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      const result = await ToolRegistry.executeTool('write_file', JSON.stringify({
        filename: 'gravity_sandbox.html',
        content: '[File content (112 characters) verified and saved to disk. Use read_file or patch_file if inspecting/modifying.]',
      }));
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('WRITE REJECTED');
      expect(parsed.error).toContain('internal file-compaction placeholder string');
      expect(fs.existsSync(path.join(testWorkspace, 'gravity_sandbox.html'))).toBe(false);
    } finally {
      ToolRegistry.setWorkspaceDir(originalWorkspace);
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('should reject patch_file when new_text is an internal compaction placeholder', async () => {
    const originalWorkspace = ToolRegistry.getWorkspaceDir();
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-compact-patch-'));
    ToolRegistry.setWorkspaceDir(testWorkspace);
    try {
      fs.writeFileSync(path.join(testWorkspace, 'game.html'), '<html><body>placeholder</body></html>', 'utf8');
      const result = await ToolRegistry.executeTool('patch_file', JSON.stringify({
        filename: 'game.html',
        old_text: 'placeholder',
        new_text: '[File content (1,234 characters) verified and saved to disk. Use read_file or patch_file if inspecting/modifying.]',
      }));
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('PATCH REJECTED');
      expect(parsed.error).toContain('internal file-compaction placeholder string');
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
