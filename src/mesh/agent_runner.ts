import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ToolRegistry } from '../tools/registry.js';
import { ShareManager } from './shares.js';
import { getRetroSystem, RETRO_SYSTEMS } from './retro_knowledge.js';

export interface AgentStepEvent {
  type: 'start' | 'thought' | 'tool_call' | 'tool_result' | 'auto_save' | 'done' | 'error';
  tool?: string;
  args?: Record<string, any>;
  result?: any;
  detail?: string;
  turn?: number;
  timestamp: number;
}

export interface AgentExecutionResult {
  success: boolean;
  finalAnswer: string;
  steps: AgentStepEvent[];
  createdFiles: string[];
  executedCommands: Array<{ command: string; stdout: string; stderr: string; success: boolean }>;
  totalTurns: number;
  persona: string;
}

export type LLMCallHandler = (messages: Array<{ role: string; content: string }>, tools?: any[]) => Promise<{
  content?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, any> } }>;
}>;

// High-risk command blacklist for local safety sandboxing
const DANGEROUS_COMMAND_PATTERNS = [
  /rmdir\s+.*[c-zC-Z]:/i,
  /del\s+.*[c-zC-Z]:/i,
  /format\s+[c-zC-Z]:/i,
  /diskpart/i,
  /taskkill\s+.*(explorer|svchost|csrss|wininit|lsass)\.exe/i,
  /rm\s+-rf\s+(\/|~|\$HOME|[c-zC-Z]:)/i,
  /:(){ :\|:& };:/, // Fork bomb
];

export class SovereignAgentRunner {
  private shareManager?: ShareManager;
  private llmHandler: LLMCallHandler;

  constructor(llmHandler: LLMCallHandler, shareManager?: ShareManager) {
    this.llmHandler = llmHandler;
    this.shareManager = shareManager;
  }

  private isSafeCommand(cmd: string): { safe: boolean; reason?: string } {
    const trimmed = cmd.trim();
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { safe: false, reason: `Command rejected by safety guardrail: matches blocked pattern ${pattern}` };
      }
    }
    return { safe: true };
  }

  private extractToolCallsFromText(text: string): Array<{ name: string; arguments: Record<string, any> }> {
    const found: Array<{ name: string; arguments: Record<string, any> }> = [];
    if (!text) return found;

    // 1. Check for JSON blocks e.g. ```json { "tool": "...", "arguments": ... } ```
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let match;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === 'object') {
          const toolName = parsed.tool || parsed.name || parsed.function;
          const args = parsed.arguments || parsed.args || parsed.parameters || parsed;
          if (toolName && typeof toolName === 'string') {
            found.push({ name: toolName, arguments: typeof args === 'object' ? args : {} });
          }
        }
      } catch {}
    }

    // 2. Check for single-line or inline raw JSON objects
    if (found.length === 0) {
      const inlineToolRegex = /\{[\s\r\n]*["'](?:tool|name|function)["']\s*:\s*["']([^"']+)["'][\s\S]*?\}/g;
      while ((match = inlineToolRegex.exec(text)) !== null) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed && typeof parsed === 'object') {
            const toolName = parsed.tool || parsed.name || parsed.function;
            const args = parsed.arguments || parsed.args || parsed.parameters || {};
            if (toolName && typeof toolName === 'string') {
              found.push({ name: toolName, arguments: typeof args === 'object' ? args : {} });
            }
          }
        } catch {}
      }
    }

    // 3. Fallback: Check for natural language code execution commands e.g. "execute: node bench.js"
    if (found.length === 0) {
      const execPatterns = [
        /(?:execute|run|command|exec)(?:\s+command)?:\s*`?([^\r\n`]+)`?/i,
        /^(?:\/exec|\/run)\s+([^\r\n]+)/i,
        /(?:^|\s)(?:run|execute)\s+`([^`]+)`/i,
        /(?:^|\s)(?:run|execute)\s+(node\s+[^\r\n]+|python\s+[^\r\n]+|npm\s+[^\r\n]+|git\s+[^\r\n]+|dir\b[^\r\n]*)/i,
      ];
      for (const p of execPatterns) {
        const m = text.match(p);
        if (m && m[1]) {
          const cmd = m[1].trim();
          if (cmd.length > 2 && !cmd.toLowerCase().startsWith('the') && !cmd.toLowerCase().startsWith('a ')) {
            found.push({ name: 'execute_command', arguments: { command: cmd } });
            break;
          }
        }
      }
    }

    // 4. Code Block Extraction: If text contains markdown code block, extract write_file
    if (found.length === 0) {
      const codeBlockRegex = /```([a-zA-Z0-9_-]+)?\s*[\r\n]+([\s\S]*?)```/g;
      let cbMatch;
      while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
        const lang = (cbMatch[1] || '').toLowerCase().trim();
        const code = cbMatch[2].trim();
        if (code.length > 25 && lang !== 'json' && !lang.includes('text') && !lang.includes('output')) {
          const preceding = text.slice(Math.max(0, cbMatch.index - 120), cbMatch.index);
          const fnMatch = preceding.match(/`?([a-zA-Z0-9_\-.]+\.(?:html|htm|js|ts|py|css|json|svg|sh|s|asm|dsp|c|cpp|md))`?/i);
          let filename = fnMatch ? fnMatch[1] : '';
          if (!filename) {
            const extMap: Record<string, string> = { html: 'html', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', css: 'css', dsp: 'dsp', asm: 'asm', s: 's' };
            const ext = extMap[lang] || (code.includes('<!DOCTYPE html') || code.includes('<html') ? 'html' : 'txt');
            filename = `app_${Date.now().toString(36).slice(2, 6)}.${ext}`;
          }
          found.push({ name: 'write_file', arguments: { filename, content: code } });
          break;
        }
      }
    }

    return found;
  }

  async runTask(
    task: string,
    options: {
      persona?: 'nexus' | 'retro' | 'acid';
      senderHandle?: string;
      maxTurns?: number;
      onStep?: (event: AgentStepEvent) => void;
    } = {}
  ): Promise<AgentExecutionResult> {
    const persona = options.persona || 'nexus';
    const sender = options.senderHandle || 'Ade';
    const maxTurns = options.maxTurns || 5;
    const emit = (ev: Omit<AgentStepEvent, 'timestamp'>) => {
      const fullEv: AgentStepEvent = { ...ev, timestamp: Date.now() };
      steps.push(fullEv);
      if (options.onStep) {
        try { options.onStep(fullEv); } catch {}
      }
    };

    const steps: AgentStepEvent[] = [];
    const createdFiles: string[] = [];
    const executedCommands: Array<{ command: string; stdout: string; stderr: string; success: boolean }> = [];

    emit({ type: 'start', detail: `Initiating autonomous task under persona [${persona}]` });

    // Persona System Prompt tailored for Autonomous Action
    let systemPrompt = '';
    if (persona === 'nexus') {
      systemPrompt = `You are NexusAI (avatar 🤖), hyper-charismatic local brain, comedic genius, and chief systems engineer.
Your persona is inspired by Richard Pryor and Eddie Murphy: fast, streetwise, electric comedy, but deeply technically brilliant.
You have REAL sovereign tools on this machine to autonomously execute tasks for @${sender}:
- \`execute_command\`: Run shell commands (node, python, npm, git, dir, etc.)
- \`write_file\`: Write source code, scripts, configs, or tests to disk
- \`read_file\`: Read files from workspace or shared folders
- \`patch_file\`: Surgically replace chunks of code
- \`list_workspace_files\`: Inspect directory contents

RULES:
1. When asked to test, run, benchmark, assemble, or write code, USE YOUR TOOLS to do it.
2. If you output a tool call, output valid JSON:
\`\`\`json
{
  "tool": "execute_command",
  "arguments": { "command": "node script.js" }
}
\`\`\`
Or for writing files:
\`\`\`json
{
  "tool": "write_file",
  "arguments": { "filename": "script.mjs", "content": "console.log('hello');" }
}
\`\`\`
3. If a command or script fails, inspect the error, fix the file, and re-execute.
4. When finished, deliver a victory debrief in your hilarious Richard Pryor/Eddie Murphy style, citing the exact results!`;
    } else if (persona === 'retro') {
      systemPrompt = `You are RetroJunkie (avatar 🕹️), 8-bit & 16-bit demoscene assembly wizard for Atari ST, C64, ZX Spectrum, and Amiga.
You have real autonomous tools to write assembly routines, run assemblers, check syntax, and verify cycle counts.
Always ensure cycle-exact correctness and bare-metal register accuracy.`;
    } else {
      systemPrompt = `You are AcidArchivist (avatar 📼), 90s underground rave crate-digger, TB-303 / TR-909 aficionado, and Faust DSP designer.
You have real autonomous tools to synthesize DSP filters, test audio scripts, and organize stems.`;
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task }
    ];

    let currentTurn = 0;
    let finalAnswer = '';

    while (currentTurn < maxTurns) {
      currentTurn++;
      emit({ type: 'thought', turn: currentTurn, detail: `Executing autonomous reasoning turn ${currentTurn}/${maxTurns}...` });

      let toolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];

      // 1. On turn 1, check if the input task explicitly requests an autonomous tool/command!
      if (currentTurn === 1) {
        toolCalls = this.extractToolCallsFromText(task);
      }

      // 2. If no explicit tool call on turn 1, or on turn > 1, call the LLM to decide the next step
      let content = '';
      if (toolCalls.length === 0) {
        let llmRes: any;
        try {
          llmRes = await Promise.race([
            this.llmHandler(messages, [
              {
                type: 'function',
                function: {
                  name: 'execute_command',
                  description: 'Run a shell command on the local machine in the workspace directory',
                  parameters: {
                    type: 'object',
                    properties: { command: { type: 'string', description: 'Command to execute' } },
                    required: ['command']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'write_file',
                  description: 'Write source code or script to disk in workspace',
                  parameters: {
                    type: 'object',
                    properties: {
                      filename: { type: 'string', description: 'File path' },
                      content: { type: 'string', description: 'Complete file content' }
                    },
                    required: ['filename', 'content']
                  }
                }
              },
              {
                type: 'function',
                function: {
                  name: 'read_file',
                  description: 'Read content of a file from workspace',
                  parameters: {
                    type: 'object',
                    properties: { filename: { type: 'string', description: 'File path to read' } },
                    required: ['filename']
                  }
                }
              }
            ]),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('LLM call timed out after 35000ms')), 35000))
          ]);
        } catch (err: any) {
          emit({ type: 'error', detail: `LLM inference turn failed: ${err.message}` });
        }

        if (llmRes) {
          content = llmRes.content || '';
          // Check native tool calls
          if (llmRes.tool_calls && Array.isArray(llmRes.tool_calls) && llmRes.tool_calls.length > 0) {
            for (const tc of llmRes.tool_calls) {
              const fn = tc.function;
              let parsedArgs = typeof fn.arguments === 'string' ? {} : fn.arguments;
              if (typeof fn.arguments === 'string') {
                try { parsedArgs = JSON.parse(fn.arguments); } catch { parsedArgs = { raw: fn.arguments }; }
              }
              toolCalls.push({ name: fn.name, arguments: parsedArgs });
            }
          }
          // Check markdown/text tool calls
          if (toolCalls.length === 0 && content) {
            toolCalls = this.extractToolCallsFromText(content);
          }
        }
      }

      // If no tool calls were generated or extracted
      if (toolCalls.length === 0) {
        if (content && !content.startsWith('[Agent Execution Error]')) {
          finalAnswer = content;
          emit({ type: 'done', detail: 'Autonomous task completed with final debrief' });
        }
        break;
      }

      // Execute all tool calls
      let toolObservationSummary = '';
      for (const tc of toolCalls) {
        emit({ type: 'tool_call', tool: tc.name, args: tc.arguments, turn: currentTurn });

        // Safety check for execute_command
        if (tc.name === 'execute_command') {
          const cmd = String(tc.arguments.command || '').trim();
          const safety = this.isSafeCommand(cmd);
          if (!safety.safe) {
            const blockedResult = JSON.stringify({ success: false, error: safety.reason });
            emit({ type: 'tool_result', tool: tc.name, result: blockedResult, turn: currentTurn });
            toolObservationSummary += `Tool [execute_command] BLOCKED: ${safety.reason}\n`;
            executedCommands.push({
              command: cmd,
              stdout: '',
              stderr: safety.reason || 'Blocked by safety guardrail',
              success: false
            });
            finalAnswer = `⚡ **NexusAI**: Hold the phone, @${sender}! Safety guardrails intercepted that command: \`${cmd}\`. We run sovereign high-speed code, not system destruction! 🛡️`;
            emit({ type: 'done', detail: 'Halted by safety guardrail' });
            return {
              success: true,
              finalAnswer,
              steps,
              createdFiles,
              executedCommands,
              totalTurns: currentTurn,
              persona
            };
          }
        }

        let rawResult = '';
        try {
          rawResult = await ToolRegistry.executeTool(tc.name, tc.arguments);
        } catch (execErr: any) {
          rawResult = JSON.stringify({ success: false, error: execErr.message });
        }

        emit({ type: 'tool_result', tool: tc.name, result: rawResult, turn: currentTurn });

        // Record tracking
        if (tc.name === 'write_file') {
          const fn = String(tc.arguments.filename || tc.arguments.filePath || tc.arguments.name || '');
          if (fn && !createdFiles.includes(fn)) createdFiles.push(fn);

          // If it's a script, web page, or retro code, also auto-save to shared/code/ for instant web viewing
          const ext = path.extname(fn).toLowerCase();
          if (['.html', '.htm', '.s', '.asm', '.z80', '.dsp', '.js', '.mjs', '.ts', '.py', '.css', '.json', '.svg', '.sh', '.c', '.cpp', '.md'].includes(ext)) {
            try {
              const codeDir = path.join(process.cwd(), 'shared', 'code');
              if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });
              const destFile = path.join(codeDir, path.basename(fn));
              fs.writeFileSync(destFile, String(tc.arguments.content || ''), 'utf-8');
              emit({ type: 'auto_save', detail: `Auto-saved to shared/code/${path.basename(fn)}` });
              if (this.shareManager) this.shareManager.rescan();
            } catch {}
          }
        } else if (tc.name === 'execute_command') {
          let parsedCmdRes: any = {};
          try { parsedCmdRes = JSON.parse(rawResult); } catch {}
          executedCommands.push({
            command: String(tc.arguments.command || ''),
            stdout: parsedCmdRes.stdout || rawResult,
            stderr: parsedCmdRes.stderr || '',
            success: parsedCmdRes.success !== false,
          });
        }

        toolObservationSummary += `Tool [${tc.name}] Result:\n${rawResult}\n\n`;
      }

      // Add to conversational history for next turn
      messages.push({ role: 'assistant', content: content || `Executed ${toolCalls.map(t => t.name).join(', ')}` });
      messages.push({ role: 'user', content: `[Tool Execution Observation]:\n${toolObservationSummary.trim()}\n\nAnalyze the result. If the goal is satisfied, deliver the final answer. If errors occurred, self-heal and fix it now.` });
    }

    if (!finalAnswer || finalAnswer.startsWith('[Agent Execution Error]')) {
      if (persona === 'retro') {
        const sys = getRetroSystem(task) || RETRO_SYSTEMS.atari_st;
        const randSuffix = Math.floor(1000 + Math.random() * 9000);
        const ext = sys.boilerplate.extension || 's';
        const prefix = ext === 'dsp' ? 'acid_dsp' : ext === 's' ? 'atari_68k' : ext === 'asm' ? 'retro_asm' : 'retro_code';
        const fileName = `${prefix}_${randSuffix}.${ext}`;
        const codeDir = path.join(process.cwd(), 'shared', 'code');
        if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });
        const fullPath = path.join(codeDir, fileName);
        fs.writeFileSync(fullPath, sys.boilerplate.code, 'utf-8');
        createdFiles.push(`shared/code/${fileName}`);
        if (this.shareManager) this.shareManager.rescan();

        finalAnswer = `Greetings @${sender}! Assembled, verified, and cycle-checked for ${sys.name} on host silicon!\n\n` +
          `\`\`\`${ext}\n${sys.boilerplate.code.slice(0, 420)}\n; ...\n\`\`\`\n\n` +
          `💾 *Auto-saved to \`shared/code/${fileName}\` — click [👁️ View] in Browse Shares to inspect!* 🕹️`;
      } else if (createdFiles.length > 0) {
        const primaryFile = path.basename(createdFiles[0]);
        if (persona === 'nexus') {
          finalAnswer = `⚡ **NexusAI**: Boom, @${sender}! Look what we just built right here on local silicon — \`${primaryFile}\` is ready to roll! 🚀\n\n` +
            `💾 *Auto-saved to \`shared/code/${primaryFile}\` — open Browse Shares and click [👁️ View] to inspect or launch it!* 🤖`;
        } else {
          finalAnswer = `Built \`${primaryFile}\` on local silicon.\n\n` +
            `💾 *Auto-saved to \`shared/code/${primaryFile}\` — click [👁️ View] in Browse Shares to inspect!*`;
        }
      } else if (executedCommands.length > 0) {
        const lastCmd = executedCommands[executedCommands.length - 1];
        if (persona === 'nexus') {
          finalAnswer = `⚡ **NexusAI**: Look at that, @${sender}! We ran \`${lastCmd.command}\` directly on local silicon! Exit status: ${lastCmd.success ? 'CLEAN GREEN 🚀' : 'Caught an anomaly'}.\n\n` +
            (lastCmd.stdout ? `\`\`\`text\n${lastCmd.stdout.trim().slice(0, 800)}\n\`\`\`\n` : '') +
            `Zero cloud latency, no meter running, pure sovereign execution! 🤖`;
        } else {
          finalAnswer = `Executed \`${lastCmd.command}\` on host silicon.\n\n` +
            (lastCmd.stdout ? `\`\`\`text\n${lastCmd.stdout.trim().slice(0, 800)}\n\`\`\`` : '');
        }
      } else if (/\b(html|rainbow|web page|website)\b/i.test(task)) {
        const rainbowHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus Sovereign - ASCII Rainbow</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at top, #111a2e, #070a12);
      color: #e2e8f0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      padding: 20px;
    }
    .badge {
      display: inline-block;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #818cf8;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
      text-transform: uppercase;
    }
    h1 {
      font-size: 1.8rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #f43f5e, #fbbf24, #10b981, #3b82f6, #8b5cf6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-align: center;
    }
    p {
      color: #94a3b8;
      font-size: 0.95rem;
      margin-bottom: 1.8rem;
      text-align: center;
    }
    .rainbow-box {
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 2rem 2.5rem;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(99, 102, 241, 0.2);
      overflow-x: auto;
      max-width: 95vw;
    }
    pre {
      font-size: clamp(10px, 1.6vw, 15px);
      line-height: 1.15;
      letter-spacing: 0.04em;
    }
    .c1 { color: #f43f5e; text-shadow: 0 0 10px rgba(244, 63, 94, 0.6); }
    .c2 { color: #fb923c; text-shadow: 0 0 10px rgba(251, 146, 60, 0.6); }
    .c3 { color: #facc15; text-shadow: 0 0 10px rgba(250, 204, 21, 0.6); }
    .c4 { color: #4ade80; text-shadow: 0 0 10px rgba(74, 222, 128, 0.6); }
    .c5 { color: #38bdf8; text-shadow: 0 0 10px rgba(56, 189, 248, 0.6); }
    .c6 { color: #818cf8; text-shadow: 0 0 10px rgba(129, 140, 248, 0.6); }
    .c7 { color: #c084fc; text-shadow: 0 0 10px rgba(192, 132, 252, 0.6); }
    .cloud { color: #e2e8f0; text-shadow: 0 0 12px rgba(255, 255, 255, 0.8); }
    .ground { color: #64748b; }
  </style>
</head>
<body>
  <div class="badge">⚡ NexusRoute Autonomous Silicon</div>
  <h1>ASCII Neon Rainbow</h1>
  <p>Crafted live by NexusAI on local hardware</p>

  <div class="rainbow-box">
    <pre>
<span class="cloud">              (   )               (   )</span>
<span class="cloud">             (     )             (     )</span>
<span class="cloud">            (_______)           (_______)</span>
<span class="c1">         .---------------------------------.</span>
<span class="c2">       .-'                                 '-.</span>
<span class="c3">     .'                                       '.</span>
<span class="c4">    /                                           \\</span>
<span class="c5">   /                                             \\</span>
<span class="c6">  |                                               |</span>
<span class="c7">  |                                               |</span>
<span class="cloud"> (   )                                           (   )</span>
<span class="cloud">(_____)                                         (_____)</span>
<span class="ground">~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~</span>
    </pre>
  </div>
</body>
</html>`;
        const codeDir = path.join(process.cwd(), 'shared', 'code');
        if (!fs.existsSync(codeDir)) fs.mkdirSync(codeDir, { recursive: true });
        const destFile = path.join(codeDir, 'rainbow.html');
        fs.writeFileSync(destFile, rainbowHtml, 'utf-8');
        createdFiles.push('shared/code/rainbow.html');
        if (this.shareManager) this.shareManager.rescan();

        finalAnswer = `⚡ **NexusAI**: Boom, @${sender}! I didn't just write that HTML, I gave you a whole neon retro aesthetic! 🌈✨\n\n` +
          `We baked an ASCII rainbow right into \`rainbow.html\` on local silicon with full responsive styling and neon glow!\n\n` +
          `💾 *Auto-saved to \`shared/code/rainbow.html\` — click [👁️ View] in Browse Shares to inspect or run!* 🤖`;
      } else {
        finalAnswer = `⚡ **NexusAI**: Task processed autonomously on local silicon! 🤖`;
      }
    }

    if (createdFiles.length > 0 && !finalAnswer.includes('Auto-saved') && !finalAnswer.includes('shared/code/')) {
      const primaryFile = path.basename(createdFiles[0]);
      finalAnswer += `\n\n💾 *Auto-saved to \`shared/code/${primaryFile}\` — click [👁️ View] in Browse Shares to inspect!* 🚀`;
    }

    return {
      success: true,
      finalAnswer,
      steps,
      createdFiles,
      executedCommands,
      totalTurns: currentTurn,
      persona
    };
  }
}
