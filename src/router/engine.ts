import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk, UniversalMessage, ProviderType, RouteMetadata, ToolCall, ToolDefinition } from '../ir/types.js';
import { ProviderAdapter, AdapterError } from '../adapters/base.js';
import { OpenAIAdapter } from '../adapters/openai.js';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { GroqAdapter } from '../adapters/groq.js';
import { DeepSeekAdapter } from '../adapters/deepseek.js';
import { MistralAdapter } from '../adapters/mistral.js';
import { XAIAdapter } from '../adapters/xai.js';
import { OllamaAdapter } from '../adapters/ollama.js';
import { GitHubAdapter } from '../adapters/github.js';
import { QwenAdapter } from '../adapters/qwen.js';
import { LocalAdapter } from '../adapters/local.js';
import { MockAdapter } from '../adapters/mock.js';
import { MODEL_CATALOG, calculateEstimatedCost } from './capabilities.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ResponseCache } from '../cache/cache.js';
import { IntentClassifier, ClassificationResult } from './classifier.js';
import { ToolRegistry } from '../tools/registry.js';
import { ProviderConnectionManager, type ProviderConnection } from '../providers/connection-manager.js';
import { RouteTelemetryStore } from '../telemetry/route-store.js';
import { finalizeUsageCost, mergeUsage, zeroUsageCostForCache } from '../telemetry/usage.js';
import { AgentEventLog } from '../telemetry/agent-events.js';
import { sanitizeWorkspacePath } from '../security/path.js';
import { compressMessages } from '../context/compression.js';
import { getGroqRequestBudget } from '../providers/groq-budget.js';

export interface RouteCandidate {
  provider: ProviderType;
  model: string;
  timeout_ms?: number;
}

export interface VirtualModelConfig {
  description: string;
  strategy: 'cascade' | 'round-robin';
  routes: RouteCandidate[];
}

export interface RouterConfig {
  default_virtual_model: string;
  virtual_models: Record<string, VirtualModelConfig>;
  providers: Record<string, unknown>;
}

interface VerifiedFileWrite {
  filename: string;
  full_path: string;
  bytes_written: number;
}

interface RejectedFileWrite {
  full_path: string;
  reason: string;
}

interface MissingHtmlDependencies {
  full_path: string;
  missing: string[];
}

interface HtmlRuntimeVerification {
  attempted: boolean;
  success: boolean;
  detail: string;
}

function latestUserText(req: UniversalRequest): string {
  const message = [...req.messages].reverse().find(item => item.role === 'user');
  if (!message) return '';
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}

function extractFilenames(text: string): string[] {
  const names = new Set<string>();
  const verifiedPattern = /verified file written:\s*`([^`]+)`/gi;
  let verifiedMatch: RegExpExecArray | null;
  while ((verifiedMatch = verifiedPattern.exec(text)) !== null) {
    names.add(path.basename(verifiedMatch[1].replace(/\\/g, '/')));
  }
  const filePattern = /(?:^|[\s"'`(])((?:[\w.-]+[\\/])*[\w.-]+\.(?:html?|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|py|java|kt|cpp|c|h|hpp|xml|yaml|yml|toml|ini|sql|ps1|bat|cmd|exe|vst3))(?=$|[\s"'`,;:)])/gi;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(text)) !== null) {
    names.add(match[1].replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return [...names];
}

// The write check only sees tool calls made during THIS request, so a file
// written on an earlier request looked unwritten and the model got called a liar
// for correctly reporting finished work. Before saying nothing was saved, ask
// the filesystem.
function namedFilesPresentOnDisk(text: string, workspaceDir: string): string[] {
  const present: string[] = [];
  for (const name of extractFilenames(text)) {
    try {
      const full = sanitizeWorkspacePath(name, workspaceDir);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) present.push(name);
    } catch {}
  }
  return present;
}

function isArtifactFollowUp(text: string): boolean {
  return /\b(?:fix|repair|change|update|alter|add|remove|replace|continue|finish|complete|retry|again|go|do it|try it)\b|\b(?:can(?:not|'t)|does(?: not|n't)|is(?: not|n't)|won(?: not|'t)|broken|wrong|missing|silent|hear)\b/i.test(text.trim());
}

function requestedFilenames(req: UniversalRequest): string[] {
  const latestText = latestUserText(req);
  const direct = extractFilenames(latestText);
  if (direct.length > 0 || !isArtifactFollowUp(latestText)) return direct;

  const metadataTargets = Array.isArray(req.metadata?.active_file_targets)
    ? req.metadata.active_file_targets
        .filter((target): target is string => typeof target === 'string' && target.length > 0 && target.length <= 300)
        .slice(0, 10)
    : [];
  if (metadataTargets.length > 0) return metadataTargets;

  const latestUserIndex = req.messages.map(message => message.role).lastIndexOf('user');
  for (let index = latestUserIndex - 1; index >= 0; index--) {
    const message = req.messages[index];
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const inherited = extractFilenames(text);
    if (inherited.length > 0) return inherited;
  }
  return [];
}

function requestExpectsFileWrite(req: UniversalRequest): boolean {
  const text = latestUserText(req).toLowerCase();
  if (!text) return false;
  const mentionsFilename = /\b[\w.-]+\.(?:html?|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|py|java|kt|cpp|c|h|hpp|xml|yaml|yml|toml|ini|sql|ps1|bat|cmd|exe)\b/i.test(text);
  const createArtifact = /\b(?:create|build|make|generate|edit|update|compile)\b[\s\S]{0,140}\b(?:file|project|app|application|website|web\s*app|script|game|plugin|source|page|exe|executable|binary)\b/i.test(text);
  const explicitDiskWrite = /\b(?:write|save|compile)\b[\s\S]{0,100}\b(?:file|disk|workspace|project|as\s+[\w.-]+\.)/i.test(text);
  return mentionsFilename || createArtifact || explicitDiskWrite || (isArtifactFollowUp(text) && requestedFilenames(req).length > 0);
}

interface AutonomousTaskProfile {
  html: boolean;
  android: boolean;
  windowsPlugin: boolean;
  nativeExecutable: boolean;
  imageGeneration: boolean;
  webResearch: boolean;
}

function autonomousTaskProfile(req: UniversalRequest): AutonomousTaskProfile {
  const text = req.messages
    .filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n')
    .toLowerCase();
  const filenames = requestedFilenames(req).map(filename => filename.toLowerCase());
  return {
    html: filenames.some(filename => /\.html?$/.test(filename)) || /\b(?:html|web\s*app|browser\s*game|canvas|webgl)\b/.test(text),
    android: filenames.some(filename => /\.(?:apk|java|kt)$/.test(filename)) || /\b(?:android|apk)\b/.test(text),
    windowsPlugin: /\b(?:vst3?|juce|audio\s*plugin)\b/.test(text),
    nativeExecutable: filenames.some(filename => /\.(?:exe|cpp|c|rs|go)$/.test(filename)) || /\b(?:exe|executable|c\+\+|cpp|clang|gcc|g\+\+|compile|binary|pyinstaller)\b/.test(text),
    imageGeneration: /\b(?:generate|render|create|make|call|use)\b[\s\S]{0,80}\b(?:image|artwork|sprite|texture|prompt\s*forge|promptforge)\b/.test(text),
    webResearch: /\b(?:web\s*search|search\s*(?:the\s*)?(?:web|internet)|look\s*up\s*online|latest\s+(?:docs|documentation|news))\b/.test(text),
  };
}

function scopeAutonomousTools(req: UniversalRequest, tools: ToolDefinition[]): ToolDefinition[] {
  const builtInNames = new Set(ToolRegistry.getBuiltInTools().map(tool => tool.function.name));
  if (tools.some(tool => !builtInNames.has(tool.function.name))) return tools;

  const profile = autonomousTaskProfile(req);
  // The full built-in schema set is ~4k prompt tokens, re-sent on every agent
  // turn and again on every cascade candidate. Scope it by task profile instead
  // of shipping all of it on requests that will never touch most of the tools.
  const allowed = requestExpectsFileWrite(req)
    ? new Set(['write_file', 'patch_file', 'read_file', 'list_workspace_files', 'execute_command'])
    : new Set([
        'read_file',
        'list_workspace_files',
        'write_file',
        'patch_file',
        'execute_command',
        'get_current_time',
        'calculator',
        'remember_fact',
        'recall_memory',
        'take_desktop_screenshot',
      ]);
  if (req.messages.length > 6) allowed.add('recover_raw_context');
  if (profile.html) {
    allowed.add('open_in_browser_or_app');
    allowed.add('test_html_app');
  }
  if (profile.android) {
    allowed.add('build_android_apk');
    allowed.add('test_android_app');
  }
  allowed.add('execute_command');
  if (profile.imageGeneration) allowed.add('generate_image');
  if (profile.webResearch) {
    allowed.add('web_search');
    allowed.add('fetch_webpage');
  }

  const scoped = tools.filter(tool => allowed.has(tool.function.name));
  return scoped.length > 0 ? scoped : tools;
}

function compactAutonomousPrompt(req: UniversalRequest, workspace: string): string {
  const profile = autonomousTaskProfile(req);
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\adria';
  const rules = [
    'You are NexusRoute Autonomous AI Engineer running locally on the user\'s Windows computer.',
    `Primary Workspace Directory: ${workspace}`,
    `User Directory: ${userProfile} (e.g. Desktop at ${path.join(userProfile, 'Desktop')})`,
    'FILE SYSTEM PERMISSIONS: You have full permission to read, write, patch, and execute files across the entire user directory and Desktop (e.g. `C:\\Users\\adria\\Desktop\\modeldock\\...` and other project paths). When the user asks you to edit or work on a project located on the Desktop or anywhere in their home directory, use those absolute paths directly with read_file, write_file, patch_file, and execute_command. You are NOT restricted to the workspace folder.',
    '',
    'OPERATING RULES:',
    '- MANDATORY AUTONOMOUS EXECUTION (ANTI-FOB-OFF RULE): You are an autonomous builder, NOT an advisory chatbot. NEVER reply with high-level summaries, bulleted advice, placeholder code ("// add logic here", "/* TODO */"), or telling the user to implement or run things themselves.',
    '- WRITE COMPLETE SOURCE DIRECTLY IN ONE SHOT: Write the complete, unified source code directly into `<name>.cpp` (or `<name>.py`, `index.html`) in a single `write_file` tool call. NEVER split source code into artificial partial chunks (e.g. part1, part2, part3) or attempt concatenation via shell commands.',
    '- CALL TOOLS IMMEDIATELY (NO NARRATION OR PLANNING PREAMBLE): DO NOT write explanations of what you are going to do, plans, or step-by-step preambles like "## Step 1: Write Part 1...". Call `write_file` immediately with the full source code on your very first tool call.',
    '- OVERWRITING & UPDATING EXISTING FILES: When asked to update, modify, fix, rewrite, or rebuild an existing file, you MUST overwrite or patch it with the new changes using write_file or patch_file. DO NOT assume the task is finished just because an older version of the file is present on disk.',
    '- DIRECT COMPILATION ONLY (NO BUILD.BAT / SCRIPT CRUTCHES): NEVER generate build.bat, compile.bat, or shell scripts asking the user to compile themselves. YOU must compile and build executables/binaries directly using execute_command (e.g. running "cmake --build ...", "cl.exe", "clang++", "g++", "cargo", or "npm run build"). If compilation fails, inspect the compiler output and repair the code directly.',
    '- PYTHON & COMPILER ENVIRONMENT (WINDOWS): Python is available at `python` (or `py`). Native GCC/G++ is available at `g++`. CMake is available at `cmake`.',
    '- COMPILING WINDOWS .EXE & C++ APPS: When asked to build a Windows .exe or C++ program, write the source code to `<name>.cpp` with write_file, then compile it to `<name>.exe` by running execute_command with `g++ -O3 <name>.cpp -lgdi32 -luser32 -lopengl32 -o <name>.exe`. NEVER claim a .exe was created without executing the compiler!',
    '- RUNNING PYTHON SCRIPTS: When asked to run or test Python code, write the script with write_file, then execute it with execute_command using `python <script>.py`.',
    '- When asked to create, code, build, or fix something, you MUST immediately call the appropriate tool (write_file, build_android_apk, patch_file, execute_command) to deliver the 100% COMPLETE, fully working code and save it to disk.',
    '- NO EXCUSES OR REFUSALS: Never say "As an AI I cannot...", "Here is a starting template you can expand", or "I cannot write the full file". Write the entire code and execute tools directly.',
    '- Never claim a file was created, edited, tested, or verified unless the corresponding tool succeeded.',
    '- Use write_file for a new file or complete rewrite; use patch_file for a focused edit after reading the existing file.',
    '- ACTION-FIRST REFACTORING & WRITING: Do NOT spend all your turns reading every file in the codebase before writing anything. Inspect only the specific files you need to change, and begin applying patches with patch_file or writing files with write_file early (by turn 2 or 3). Ship code changes incrementally so you complete the implementation within the turn limit.',
    '- Continue through implementation and verification before giving a concise final summary.',
  ];

  if (profile.html) {
    rules.push(
      '- For standalone HTML, embed required CSS/JavaScript/assets unless the request explicitly asks for multiple files.',
      '- For an interactive HTML app or game, call test_html_app after writing it; the test must click Start/Play and exercise gameplay.',
      '- Repair any missing dependency, loading-screen, console, or post-click runtime failure before claiming completion.',
    );
  }
  if (profile.android) {
    rules.push(
      '- For Android/APK work, use pure Android Java/Kotlin and build_android_apk; use test_android_app for launch/input verification.',
    );
  }
  if (profile.windowsPlugin) {
    rules.push(
      '- JUCE is only for Windows desktop/VST3 work. Use CMake and execute_command for builds, then report the actual artifact path.',
    );
  }
  if (profile.imageGeneration) {
    rules.push('- Use generate_image only when the request genuinely needs a separate raster asset, with a detailed prompt and tailored negative prompt.');
  }
  if (profile.webResearch) {
    rules.push('- Use web_search or fetch_webpage for the requested current online information and ground the implementation in the result.');
  }

  return rules.join('\n');
}

function normalizeToolArguments(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '{}';
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : '{}';
  } catch {
    return JSON.stringify({ raw: text });
  }
}

function normalizeToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  return toolCalls?.map((toolCall, index) => ({
    id: toolCall.id || `call_${Date.now()}_${index}`,
    type: 'function' as const,
    function: {
      name: String(toolCall.function?.name || ''),
      arguments: normalizeToolArguments((toolCall.function as any)?.arguments),
    },
  }));
}

function positiveDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function candidateIdentity(provider: ProviderType, model: string): string {
  return `${provider}\u0000${model}`;
}

function candidateTimeoutOverride(provider: ProviderType, model: string): number | undefined {
  if (provider === 'openrouter') {
    if (/(?:^|::)stealth\/ox-alpha$/i.test(model)) {
      return positiveDuration(process.env.NEXUS_OX_ALPHA_TURN_TIMEOUT_MS, 75_000);
    }
    if (model.includes(':free') || model.includes('openrouter/free') || model.includes('/free')) {
      return positiveDuration(process.env.NEXUS_FREE_TURN_TIMEOUT_MS, 180_000);
    }
  }
  return undefined;
}

// Every tier used to hardcode the Free Models Router, which picks at random from
// free-variant models only - so a paid OpenRouter key and its full catalogue were
// never reachable. Free variants also carry the tightest rate and throughput
// limits on the platform, which is what produced the recurring 80s+ stream
// timeouts. The default below is unchanged; set OPENROUTER_MODEL to a paid slug
// (or openrouter/auto) to actually use a funded key.
const OPENROUTER_FREE_ROUTER = 'openrouter/free';

function openRouterModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || OPENROUTER_FREE_ROUTER;
}

function directCandidate(provider: ProviderType, model: string): RouteCandidate {
  const timeout_ms = candidateTimeoutOverride(provider, model);
  return timeout_ms ? { provider, model, timeout_ms } : { provider, model };
}

function withoutAdapterPrefix(message: string): string {
  return message.replace(/^\[[A-Z]+\]\s*/, '');
}

// Reserved for each candidate still queued behind the current one. Without this
// the first route consumes the whole request budget and every fallback dies
// instantly with "exhausted its route-attempt time budget" - which makes the
// cascade decorative rather than functional.
const FAILOVER_RESERVE_MS = 20_000;
// A fallback is worth attempting only if it gets a usable slice of time. Mock and
// other instant routes finish well inside this, so the floor costs nothing.
const MIN_ATTEMPT_MS = 15_000;

function defaultTurnMs(provider: ProviderType): number {
  return provider === 'local' || provider === 'ollama'
    ? positiveDuration(process.env.NEXUS_LOCAL_TURN_TIMEOUT_MS, 360_000)
    : positiveDuration(process.env.NEXUS_CLOUD_TURN_TIMEOUT_MS, 300_000);
}

function turnTimeoutMs(provider: ProviderType, requested?: number, remainingRequestMs?: number): number {
  const selected = positiveDuration(requested, defaultTurnMs(provider));
  return Math.max(25, Math.min(selected, remainingRequestMs ?? selected));
}

// Deadline for one cascade attempt. Bounded by the candidate's own timeout, the
// provider default, and - critically - by what has to be left over for the
// candidates queued behind it.
function attemptDeadlineFor(
  now: number,
  requestDeadline: number,
  requestedTimeoutMs: number | undefined,
  provider: ProviderType,
  candidatesRemaining: number,
): number {
  const budgetRemaining = Math.max(0, requestDeadline - now);
  const reserve = Math.min(
    FAILOVER_RESERVE_MS * Math.max(0, candidatesRemaining - 1),
    Math.max(0, budgetRemaining - MIN_ATTEMPT_MS),
  );
  const share = budgetRemaining - reserve;
  const ceiling = positiveDuration(requestedTimeoutMs, defaultTurnMs(provider));
  return now + Math.max(MIN_ATTEMPT_MS, Math.min(share, ceiling));
}

// Never fire a turn that cannot plausibly finish. A doomed sliver request still
// ships the entire prompt upstream and is billed for it.
const MIN_TURN_MS = 10_000;

// A turn that completes - and especially one that hands back a tool call - is
// progress, so the route earns a fresh allowance for the next turn instead of
// dividing one fixed budget across an unknown number of turns. maxTurns and the
// overall request deadline stay the real ceilings.
function extendAttemptDeadline(
  current: number,
  requestDeadline: number,
  requestedTimeoutMs: number | undefined,
  provider: ProviderType,
): number {
  const allowance = positiveDuration(requestedTimeoutMs, defaultTurnMs(provider));
  return Math.min(requestDeadline, Math.max(current, Date.now() + allowance));
}

async function withWallClockDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  provider: ProviderType,
  model: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdapterError(
          `${model} exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock turn limit`,
          provider,
          408,
          true,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* streamWithWallClockDeadline(
  stream: AsyncGenerator<UniversalStreamChunk>,
  timeoutMs: number,
  provider: ProviderType,
  model: string,
): AsyncGenerator<UniversalStreamChunk> {
  const iterator = stream[Symbol.asyncIterator]();
  const maxTotalMs = Math.max(timeoutMs, 900_000); // 15 mins ceiling for very long active outputs
  const inactivityAllowanceMs = Math.max(300_000, Math.min(timeoutMs, 600_000)); // 5 to 10 mins inactivity allowance for deep-think models
  const absoluteDeadline = Date.now() + maxTotalMs;
  let nextChunkDeadline = Date.now() + Math.max(timeoutMs, inactivityAllowanceMs);
  let completed = false;
  try {
    while (true) {
      const now = Date.now();
      const remaining = Math.min(nextChunkDeadline - now, absoluteDeadline - now);
      if (remaining <= 0) {
        throw new AdapterError(`${model} streaming timed out after ${Math.round(inactivityAllowanceMs / 1000)}s of inactivity`, provider, 408, true);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: IteratorResult<UniversalStreamChunk>;
      try {
        result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new AdapterError(
              `${model} streaming timed out after inactivity`,
              provider,
              408,
              true,
            )), remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) {
        completed = true;
        return;
      }
      // On every active chunk received, refresh the inactivity deadline so active streams are never killed
      nextChunkDeadline = Date.now() + inactivityAllowanceMs;
      yield result.value;
    }
  } finally {
    if (!completed && iterator.return) void iterator.return(undefined).catch(() => {});
  }
}

// Local models often emit a tool call as plain text instead of a structured
// tool_calls delta, so the start of a local turn is buffered to inspect it.
// Once enough text has arrived and it clearly is not a tool-call payload the
// buffer is released - otherwise a slow local model shows nothing at all for
// minutes and looks like a hang.
const TOOL_CALL_TEXT_PROBE_CHARS = 48;

function mayStillBeTextualToolCall(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length < TOOL_CALL_TEXT_PROBE_CHARS) return true;
  return /^(\{|<tool_call>|```(?:json)?\s*\{)/.test(trimmed);
}

function parseToolResult(message: UniversalMessage): Record<string, unknown> | null {
  const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  if (/^\s*error\b/i.test(raw)) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.success !== false) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return raw.trim() ? { success: true, output: raw } : null;
  }
  return null;
}

function collectSuccessfulTools(toolCalls: ToolCall[], toolMessages: UniversalMessage[]): string[] {
  return toolCalls
    .filter((_, index) => !!toolMessages[index] && !!parseToolResult(toolMessages[index]))
    .map(toolCall => toolCall.function.name);
}

function textualToolTranscriptNames(text: string, allowedToolNames: Set<string>): string[] {
  if (!text || allowedToolNames.size === 0) return [];
  const names = new Set<string>();
  const markerPattern = /\[\s*(?:executed|running)\s+tool\s*:\s*([a-zA-Z0-9_:.-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(text)) !== null) {
    if (allowedToolNames.has(match[1])) names.add(match[1]);
  }
  return [...names];
}

function localHtmlDependencyReferences(fullPath: string): Array<{ reference: string; resolvedPath: string }> {
  if (!/\.html?$/i.test(fullPath)) return [];
  let content = '';
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return [];
  }

  const references: Array<{ reference: string; resolvedPath: string }> = [];
  const tags = /<(script|link|img|source|audio|video|iframe)\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tags.exec(content)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const attribute = tagName === 'link' ? 'href' : 'src';
    const attributePattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const attributeMatch = tagMatch[0].match(attributePattern);
    const rawReference = (attributeMatch?.[1] ?? attributeMatch?.[2] ?? attributeMatch?.[3] ?? '').trim();
    if (!rawReference || rawReference.startsWith('#') || rawReference.startsWith('//')) continue;
    if (/^(?:https?:|data:|blob:|javascript:|mailto:|tel:)/i.test(rawReference)) continue;
    if (/[{}]/.test(rawReference)) continue;

    const withoutQuery = rawReference.split(/[?#]/, 1)[0];
    if (!withoutQuery) continue;
    let decoded = withoutQuery;
    try { decoded = decodeURIComponent(withoutQuery); } catch {}

    let resolvedPath: string;
    if (decoded.startsWith('/v1/workspace/files/')) {
      resolvedPath = path.resolve(ToolRegistry.getWorkspaceDir(), decoded.slice('/v1/workspace/files/'.length));
    } else if (decoded.startsWith('/')) {
      // Root-relative URLs may be application routes or assets served outside the
      // workspace, so only explicit workspace URLs are safe to verify on disk.
      continue;
    } else {
      resolvedPath = path.resolve(path.dirname(fullPath), decoded.replace(/\//g, path.sep));
    }
    references.push({ reference: rawReference, resolvedPath });
  }
  return references;
}

function missingLocalHtmlDependencies(fullPath: string): string[] {
  return [...new Set(
    localHtmlDependencyReferences(fullPath)
      .filter(dependency => !fs.existsSync(dependency.resolvedPath))
      .map(dependency => dependency.reference)
  )];
}

function htmlDependencyIssues(
  observedWrites: VerifiedFileWrite[],
  expectedFilenames: string[]
): MissingHtmlDependencies[] {
  const paths = new Set<string>();
  for (const write of observedWrites) {
    if (/\.html?$/i.test(write.full_path) && fs.existsSync(write.full_path)) paths.add(path.resolve(write.full_path));
  }
  for (const filename of expectedFilenames) {
    if (!/\.html?$/i.test(filename)) continue;
    const resolved = path.isAbsolute(filename)
      ? path.resolve(filename)
      : path.resolve(ToolRegistry.getWorkspaceDir(), filename.replace(/\//g, path.sep));
    if (fs.existsSync(resolved)) paths.add(resolved);
  }

  return [...paths]
    .map(fullPath => ({ full_path: fullPath, missing: missingLocalHtmlDependencies(fullPath) }))
    .filter(issue => issue.missing.length > 0);
}

function requestNeedsHtmlRuntimeTest(
  req: UniversalRequest,
  observedWrites: VerifiedFileWrite[],
  expectedFilenames: string[],
  rejectedWrites: RejectedFileWrite[] = []
): boolean {
  if (rejectedWrites.some(write => /\.html?$/i.test(write.full_path))) return false;
  const hasHtmlArtifact = observedWrites.some(write => /\.html?$/i.test(write.full_path))
    || expectedFilenames.some(filename => {
      if (!/\.html?$/i.test(filename)) return false;
      const fullPath = path.isAbsolute(filename)
        ? filename
        : path.resolve(ToolRegistry.getWorkspaceDir(), filename.replace(/\//g, path.sep));
      return fs.existsSync(fullPath);
    });
  if (!hasHtmlArtifact) return false;
  const userText = req.messages
    .filter(message => message.role === 'user')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join(' ');
  return /\b(?:game|arcade|simulator|interactive)\b/i.test(userText);
}

function updateHtmlRuntimeVerification(
  current: HtmlRuntimeVerification,
  toolCalls: ToolCall[],
  toolMessages: UniversalMessage[]
): HtmlRuntimeVerification {
  let next = current;
  toolCalls.forEach((toolCall, index) => {
    if (['write_file', 'patch_file'].includes(toolCall.function.name)) {
      next = { attempted: false, success: false, detail: 'The artifact changed after its last runtime test.' };
      return;
    }
    if (toolCall.function.name !== 'test_html_app' || !toolMessages[index]) return;
    const raw = typeof toolMessages[index].content === 'string'
      ? toolMessages[index].content as string
      : JSON.stringify(toolMessages[index].content);
    try {
      const result = JSON.parse(raw) as Record<string, any>;
      const runtimeErrors = Array.isArray(result.runtimeErrors) ? result.runtimeErrors : [];
      const consoleErrors = Array.isArray(result.consoleErrors) ? result.consoleErrors : [];
      const success = result.success === true && result.interactionVerified !== false
        && runtimeErrors.length === 0 && consoleErrors.length === 0;
      const detail = success
        ? `Post-click runtime test passed${result.clickTarget ? ` via ${result.clickTarget}` : ''}.`
        : String(result.error || result.guidance || runtimeErrors[0] || consoleErrors[0] || 'Post-click runtime evidence was insufficient.');
      next = { attempted: true, success, detail };
    } catch {
      next = { attempted: true, success: false, detail: 'The runtime-test result could not be parsed.' };
    }
  });
  return next;
}

function writeMatchesRequestedFilename(write: VerifiedFileWrite, expectedFilenames: string[]): boolean {
  if (expectedFilenames.length === 0) return true;
  const resultName = write.filename.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const fullPath = write.full_path.replace(/\\/g, '/').toLowerCase();
  return expectedFilenames.some(expected => {
    const normalizedExpected = expected.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (normalizedExpected.includes('/')) {
      return resultName === normalizedExpected || fullPath.endsWith(`/${normalizedExpected}`);
    }
    return path.basename(resultName).toLowerCase() === normalizedExpected;
  });
}

function artifactValidationFailure(req: UniversalRequest, write: VerifiedFileWrite): string | null {
  const requestText = latestUserText(req).toLowerCase();
  const extension = path.extname(write.full_path).toLowerCase();
  const expectsCompleteArtifact = /\b(?:complete|completed|full|finished|playable|working|functional|standalone)\b/.test(requestText);
  const expectsInteractiveHtml = extension === '.html' && /\b(?:game|sim(?:ulator)?|app|application|interactive)\b/.test(requestText);

  let content = '';
  try {
    content = fs.readFileSync(write.full_path, 'utf8');
  } catch {
    return 'the written file could not be read back as text';
  }
  const normalized = content.toLowerCase();
  const reasons: string[] = [];
  if (extension === '.html' || extension === '.htm') {
    const missingDependencies = missingLocalHtmlDependencies(write.full_path);
    if (missingDependencies.length > 0) {
      reasons.push(`missing local HTML dependencies: ${missingDependencies.join(', ')}`);
    }
  }
  if (!expectsCompleteArtifact && !expectsInteractiveHtml) {
    return reasons.length > 0 ? reasons.join('; ') : null;
  }
  if (write.bytes_written < 800) reasons.push(`only ${write.bytes_written} bytes were written`);
  if (/\b(?:placeholder|coming soon|lorem ipsum|not implemented|todo\s*:?\s*(?:build|create|implement)|actual (?:game|app|page|website) content)\b/.test(normalized)) {
    reasons.push('placeholder or unfinished-content text is present');
  }
  if (expectsInteractiveHtml && !/<script\b|\bon(?:click|load|keydown|pointerdown)\s*=/.test(normalized)) {
    reasons.push('the interactive HTML contains no executable script');
  }
  const expectsRenderedGame = /\b(?:3d|canvas|webgl|three(?:\.js)?|babylon|vector|render(?:er|ing)?)\b/.test(requestText);
  if (extension === '.html' && expectsRenderedGame) {
    if (!/<canvas\b|\bgetcontext\s*\(|\bwebgl\b|\bthree\s*\.|\bbabylon\b/.test(normalized)) {
      reasons.push('the game contains no Canvas, WebGL, Three.js, or Babylon render surface');
    }
  }
  if (extension === '.html' && /\b(?:audio|sound|sfx|music|synth)\b/.test(requestText)) {
    if (!/\b(?:audiocontext|webkitaudiocontext)\b/.test(normalized)) {
      reasons.push('the requested browser audio engine is missing');
    }
  }
  if ((extension === '.bat' || extension === '.cmd' || extension === '.sh') && !/\b(?:batch|script|bat\b|cmd\b|shell)\b/.test(requestText)) {
    reasons.push('a batch/shell script was created instead of compiling the actual executable/binary directly using execute_command');
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function collectObservedFileWrites(
  toolCalls: ToolCall[],
  toolMessages: UniversalMessage[],
  expectedFilenames: string[] = []
): VerifiedFileWrite[] {
  const writes: VerifiedFileWrite[] = [];
  const ws = ToolRegistry.getWorkspaceDir();

  toolCalls.forEach((toolCall, index) => {
    if (!toolMessages[index]) return;
    if (['write_file', 'patch_file'].includes(toolCall.function.name)) {
      const result = parseToolResult(toolMessages[index]);
      const fullPath = typeof result?.fullPath === 'string' ? result.fullPath : '';
      if (!fullPath || !fs.existsSync(fullPath)) return;
      try {
        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) return;
        writes.push({
          filename: typeof result?.filename === 'string' ? result.filename : path.basename(fullPath),
          full_path: fullPath,
          bytes_written: stats.size,
        });
      } catch {}
    } else if (toolCall.function.name === 'execute_command') {
      const result = parseToolResult(toolMessages[index]);
      if (result?.success) {
        // If a compiler or script built/updated an expected binary or target file, record it as a verified write
        for (const target of expectedFilenames) {
          const fullPath = path.isAbsolute(target) ? target : path.resolve(ws, target.replace(/\//g, path.sep));
          if (fs.existsSync(fullPath)) {
            try {
              const stats = fs.statSync(fullPath);
              if (stats.isFile() && stats.size > 0) {
                writes.push({
                  filename: path.basename(fullPath),
                  full_path: fullPath,
                  bytes_written: stats.size,
                });
              }
            } catch {}
          }
        }
      }
    }
  });
  return writes;
}

function reassessVerifiedFileWrites(
  req: UniversalRequest,
  observedWrites: VerifiedFileWrite[],
  expectedFilenames: string[],
  rejectedWrites: RejectedFileWrite[]
): VerifiedFileWrite[] {
  const verified: VerifiedFileWrite[] = [];
  rejectedWrites.length = 0;
  for (const write of observedWrites) {
    if (!writeMatchesRequestedFilename(write, expectedFilenames)) continue;
    const validationFailure = artifactValidationFailure(req, write);
    if (validationFailure) {
      rejectedWrites.push({ full_path: write.full_path, reason: validationFailure });
    } else {
      verified.push(write);
    }
  }
  return verified;
}

function allRequestedFilesVerified(expectedFilenames: string[], writes: VerifiedFileWrite[]): boolean {
  return expectedFilenames.length > 0 && expectedFilenames.every(expected =>
    writes.some(write => writeMatchesRequestedFilename(write, [expected]))
  );
}

function appendUniqueWrites(target: VerifiedFileWrite[], writes: VerifiedFileWrite[]) {
  for (const write of writes) {
    const existingIndex = target.findIndex(existing => existing.full_path.toLowerCase() === write.full_path.toLowerCase());
    if (existingIndex >= 0) target[existingIndex] = write;
    else target.push(write);
  }
}

function verifiedWriteSummary(writes: VerifiedFileWrite[]): string {
  return writes
    .map(write => `✅ Verified file written: \`${write.full_path}\` (${write.bytes_written.toLocaleString()} bytes)`)
    .join('\n');
}

function fileVerificationCorrection(expectedFileTargets: string[], rejectedWrites: RejectedFileWrite[]): string {
  const target = expectedFileTargets.length ? ` (${expectedFileTargets.join(', ')})` : '';
  const latestRejection = rejectedWrites.at(-1);
  const detail = latestRejection
    ? ` The last write was rejected because ${latestRejection.reason}.`
    : '';
  const hasExeTarget = expectedFileTargets.some(t => /\.exe$/i.test(t));
  const exeHint = hasExeTarget
    ? ' DO NOT output narration, concatenation plans, or partial steps in text. Call write_file NOW with the complete source code (e.g. `main.cpp`), then call execute_command with `g++ -O3 main.cpp -lgdi32 -luser32 -lopengl32 -o app.exe` to compile the binary.'
    : ' DO NOT output narration, concatenation plans, or markdown roadmaps in text. Call write_file NOW with the complete source code directly.';
  return `NexusRoute verification: the requested target${target} has not been written or updated during this turn.${detail}${exeHint} Do not assume existing files satisfy the request; write the full file now.`;
}

function incompleteToolCorrection(toolNames: string[], dependencyIssues: MissingHtmlDependencies[]): string {
  const tools = toolNames.length > 0 ? toolNames.join(', ') : 'a workspace tool';
  const dependencies = dependencyIssues.length > 0
    ? ` The HTML is still missing these local dependencies: ${dependencyIssues.flatMap(issue => issue.missing).join(', ')}.`
    : '';
  return `NexusRoute verification: you printed a textual transcript claiming that ${tools} ran, but no real tool call was received and nothing from that claim was executed.${dependencies} Continue the task now by issuing actual structured tool calls. Do not print or imitate "[Executed tool: ...]" or "[Running tool: ...]" markers. Create every missing dependency before giving the final answer.`;
}

function htmlDependencyCorrection(issues: MissingHtmlDependencies[]): string {
  const detail = issues
    .map(issue => `${path.basename(issue.full_path)} -> ${issue.missing.join(', ')}`)
    .join('; ');
  return `NexusRoute completion check: the HTML cannot be marked complete because referenced local files are missing (${detail}). Continue using real structured write_file or patch_file calls and create every missing dependency. You may instead rewrite the HTML as a genuinely standalone file with those resources embedded. Do not claim completion until the dependency check passes.`;
}

function htmlRuntimeCorrection(
  observedWrites: VerifiedFileWrite[],
  expectedFileTargets: string[],
  verification: HtmlRuntimeVerification
): string {
  const target = observedWrites.find(write => /\.html?$/i.test(write.full_path))?.filename
    || expectedFileTargets.find(filename => /\.html?$/i.test(filename))
    || 'the interactive HTML file';
  const previous = verification.attempted ? ` The previous runtime test failed: ${verification.detail}` : '';
  return `NexusRoute interactive verification: opening ${target} or seeing its loading screen is not sufficient.${previous} Call test_html_app for the HTML file so it genuinely clicks Start/Play, sends gameplay input, checks animation and browser errors, and captures the post-click screen. If the test fails, inspect its exact runtime error, repair the game, and run test_html_app again before claiming completion.`;
}

export class RoutingEngine {
  private adapters = new Map<ProviderType, ProviderAdapter>();
  private circuitBreaker = new CircuitBreaker();
  private cache = new ResponseCache();
  private config: RouterConfig;
  private configuredKeys = new Map<ProviderType, string>();
  private connectionManager: ProviderConnectionManager;
  private telemetryStore: RouteTelemetryStore;
  private agentEventLog: AgentEventLog;

  constructor(config?: Partial<RouterConfig>) {
    this.config = {
      default_virtual_model: 'auto',
      virtual_models: {
        auto: {
          description: 'Smart auto-routing cascade (Pareto intent-aware)',
          strategy: 'cascade',
          routes: [
            { provider: 'mock', model: 'mock-gpt-4o', timeout_ms: 5000 },
            { provider: 'mock', model: 'mock-claude-3-5-sonnet', timeout_ms: 5000 },
            { provider: 'mock', model: 'mock-gemini-1-5-flash', timeout_ms: 3000 },
          ],
        },
        fast: {
          description: 'Optimized for lowest latency',
          strategy: 'cascade',
          routes: [
            { provider: 'mock', model: 'mock-gemini-1-5-flash', timeout_ms: 3000 },
            { provider: 'mock', model: 'mock-gpt-4o-mini', timeout_ms: 3000 },
          ],
        },
        reasoning: {
          description: 'Frontier reasoning models',
          strategy: 'cascade',
          routes: [
            { provider: 'mock', model: 'mock-o3-mini', timeout_ms: 10000 },
            { provider: 'mock', model: 'mock-claude-3-5-sonnet', timeout_ms: 8000 },
          ],
        },
        coding: {
          description: 'Code synthesis and refactoring',
          strategy: 'cascade',
          routes: [
            { provider: 'mock', model: 'mock-claude-3-5-sonnet', timeout_ms: 8000 },
            { provider: 'mock', model: 'mock-gpt-4o', timeout_ms: 8000 },
          ],
        },
      },
      providers: {},
      ...config,
    };

    // Auto-read .env file if present
    try {
      const envPath = path.resolve('.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const k = trimmed.slice(0, idx).trim();
            const v = trimmed.slice(idx + 1).trim();
            if (k === 'OPENAI_API_KEY' && v) this.configuredKeys.set('openai', v);
            if (k === 'ANTHROPIC_API_KEY' && v) this.configuredKeys.set('anthropic', v);
            if (k === 'GEMINI_API_KEY' && v) this.configuredKeys.set('gemini', v);
            if (k === 'GROQ_API_KEY' && v) this.configuredKeys.set('groq', v);
            if (k === 'DEEPSEEK_API_KEY' && v) this.configuredKeys.set('deepseek', v);
            if (k === 'MISTRAL_API_KEY' && v) this.configuredKeys.set('mistral', v);
            if (k === 'XAI_API_KEY' && v) this.configuredKeys.set('xai', v);
            if (k === 'OPENROUTER_API_KEY' && v) this.configuredKeys.set('openrouter', v);
            if (k === 'GITHUB_TOKEN' && v) this.configuredKeys.set('github', v);
            if (k === 'TOGETHER_API_KEY' && v) this.configuredKeys.set('together', v);
            if ((k === 'HUGGINGFACE_API_KEY' || k === 'HF_TOKEN') && v) this.configuredKeys.set('huggingface', v);
            if ((k === 'QWEN_API_KEY' || k === 'DASHSCOPE_API_KEY') && v) this.configuredKeys.set('qwen', v);
          }
        }
      }
    } catch {}

    if (process.env.OPENAI_API_KEY && !this.configuredKeys.has('openai')) this.configuredKeys.set('openai', process.env.OPENAI_API_KEY);
    if (process.env.ANTHROPIC_API_KEY && !this.configuredKeys.has('anthropic')) this.configuredKeys.set('anthropic', process.env.ANTHROPIC_API_KEY);
    if (process.env.GEMINI_API_KEY && !this.configuredKeys.has('gemini')) this.configuredKeys.set('gemini', process.env.GEMINI_API_KEY);
    if (process.env.GROQ_API_KEY && !this.configuredKeys.has('groq')) this.configuredKeys.set('groq', process.env.GROQ_API_KEY);
    if (process.env.DEEPSEEK_API_KEY && !this.configuredKeys.has('deepseek')) this.configuredKeys.set('deepseek', process.env.DEEPSEEK_API_KEY);
    if (process.env.MISTRAL_API_KEY && !this.configuredKeys.has('mistral')) this.configuredKeys.set('mistral', process.env.MISTRAL_API_KEY);
    if (process.env.XAI_API_KEY && !this.configuredKeys.has('xai')) this.configuredKeys.set('xai', process.env.XAI_API_KEY);
    if (process.env.OPENROUTER_API_KEY && !this.configuredKeys.has('openrouter')) this.configuredKeys.set('openrouter', process.env.OPENROUTER_API_KEY);
    if ((process.env.GITHUB_TOKEN || process.env.GH_TOKEN) && !this.configuredKeys.has('github')) this.configuredKeys.set('github', (process.env.GITHUB_TOKEN || process.env.GH_TOKEN)!);
    if (process.env.TOGETHER_API_KEY && !this.configuredKeys.has('together')) this.configuredKeys.set('together', process.env.TOGETHER_API_KEY);
    if ((process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN) && !this.configuredKeys.has('huggingface')) this.configuredKeys.set('huggingface', (process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN)!);
    if ((process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) && !this.configuredKeys.has('qwen')) this.configuredKeys.set('qwen', (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY)!);

    const isTest = process.env.NODE_ENV === 'test';
    this.connectionManager = new ProviderConnectionManager({
      storagePath: isTest ? null : undefined,
      hydrateEnvironment: !isTest,
    });
    this.telemetryStore = new RouteTelemetryStore({ storagePath: isTest ? null : undefined });
    this.agentEventLog = new AgentEventLog({ storagePath: isTest ? null : undefined });

    this.loadDisabledProviders();
    this.initAdapters();
  }

  private disabledProviders = new Set<ProviderType>();

  private loadDisabledProviders() {
    try {
      const p = path.join(process.cwd(), 'config', 'disabled_providers.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data)) {
          this.disabledProviders = new Set<ProviderType>(data as ProviderType[]);
        }
      }
    } catch {}
  }

  private saveDisabledProviders() {
    try {
      const dir = path.join(process.cwd(), 'config');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, 'disabled_providers.json');
      fs.writeFileSync(p, JSON.stringify(Array.from(this.disabledProviders), null, 2), 'utf8');
    } catch {}
  }

  private initAdapters() {
    this.adapters.set('openai', new OpenAIAdapter({ apiKey: this.configuredKeys.get('openai') }));
    this.adapters.set('anthropic', new AnthropicAdapter({ apiKey: this.configuredKeys.get('anthropic') }));
    this.adapters.set('gemini', new GeminiAdapter({ apiKey: this.configuredKeys.get('gemini') }));
    this.adapters.set('groq', new GroqAdapter({ apiKey: this.configuredKeys.get('groq') }));
    this.adapters.set('deepseek', new DeepSeekAdapter({ apiKey: this.configuredKeys.get('deepseek') }));
    this.adapters.set('mistral', new MistralAdapter({ apiKey: this.configuredKeys.get('mistral') }));
    this.adapters.set('xai', new XAIAdapter({ apiKey: this.configuredKeys.get('xai') }));
    this.adapters.set('openrouter', new OpenAIAdapter({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: this.configuredKeys.get('openrouter'),
    }));
    this.adapters.set('github', new GitHubAdapter({ apiKey: this.configuredKeys.get('github') }));
    this.adapters.set('together', new OpenAIAdapter({
      provider: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: this.configuredKeys.get('together'),
    }));
    this.adapters.set('huggingface', new OpenAIAdapter({
      provider: 'huggingface',
      baseUrl: 'https://router.huggingface.co/v1',
      apiKey: this.configuredKeys.get('huggingface'),
    }));
    this.adapters.set('qwen', new QwenAdapter({ apiKey: this.configuredKeys.get('qwen') }));
    this.adapters.set('local', new LocalAdapter());
    this.adapters.set('ollama', new OllamaAdapter());
    this.adapters.set('mock', new MockAdapter());
  }

  private createAdapterForConnection(provider: ProviderType, apiKey: string): ProviderAdapter {
    switch (provider) {
      case 'openai': return new OpenAIAdapter({ apiKey });
      case 'anthropic': return new AnthropicAdapter({ apiKey });
      case 'gemini': return new GeminiAdapter({ apiKey });
      case 'groq': return new GroqAdapter({ apiKey });
      case 'deepseek': return new DeepSeekAdapter({ apiKey });
      case 'mistral': return new MistralAdapter({ apiKey });
      case 'xai': return new XAIAdapter({ apiKey });
      case 'github': return new GitHubAdapter({ apiKey });
      case 'qwen': return new QwenAdapter({ apiKey });
      case 'openrouter': return new OpenAIAdapter({ provider, baseUrl: 'https://openrouter.ai/api/v1', apiKey });
      case 'together': return new OpenAIAdapter({ provider, baseUrl: 'https://api.together.xyz/v1', apiKey });
      case 'huggingface': return new OpenAIAdapter({ provider, baseUrl: 'https://router.huggingface.co/v1', apiKey });
      default: return this.adapters.get(provider) || new MockAdapter();
    }
  }

  private selectAttemptTarget(provider: ProviderType): { adapter: ProviderAdapter; connection?: ProviderConnection } | null {
    if (provider === 'local' || provider === 'ollama' || provider === 'mock') {
      const adapter = this.adapters.get(provider);
      return adapter ? { adapter } : null;
    }
    const connection = this.connectionManager.acquire(provider);
    if (!connection) return null;
    return { adapter: this.createAdapterForConnection(provider, connection.apiKey), connection };
  }

  private expandCandidatesForConnections(candidates: RouteCandidate[]): RouteCandidate[] {
    return candidates.flatMap(candidate => {
      if (candidate.provider === 'local' || candidate.provider === 'ollama' || candidate.provider === 'mock') return [candidate];
      const connectionCount = Math.max(1, this.connectionManager.usableCount(candidate.provider));
      return Array.from({ length: connectionCount }, () => ({ ...candidate }));
    });
  }

  private shouldTripProviderCircuit(provider: ProviderType): boolean {
    return provider === 'local' || provider === 'ollama' || provider === 'mock' || this.connectionManager.usableCount(provider) === 0;
  }

  getConnectionManager(): ProviderConnectionManager {
    return this.connectionManager;
  }

  getTelemetryStore(): RouteTelemetryStore {
    return this.telemetryStore;
  }

  getAgentEventLog(): AgentEventLog {
    return this.agentEventLog;
  }

  setProviderEnabled(provider: ProviderType, enabled: boolean) {
    if (enabled) {
      this.disabledProviders.delete(provider);
    } else {
      this.disabledProviders.add(provider);
    }
    this.saveDisabledProviders();
  }

  isProviderEnabled(provider: ProviderType): boolean {
    return !this.disabledProviders.has(provider);
  }

  getCache(): ResponseCache {
    return this.cache;
  }

  setApiKey(provider: ProviderType, apiKey: string) {
    if (apiKey) {
      this.configuredKeys.set(provider, apiKey.trim());
    } else {
      this.configuredKeys.delete(provider);
    }
    this.connectionManager.setPrimaryConnection(provider, apiKey);
    this.initAdapters();
  }

  getProviderStatus(): Record<string, { configured: boolean; enabled: boolean; maskedKey?: string; connections?: number; usableConnections?: number; cooldownConnections?: number; exhaustedConnections?: number }> {
    const providers: ProviderType[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'mistral', 'xai', 'openrouter', 'github', 'together', 'huggingface', 'qwen', 'local', 'ollama', 'mock'];
    const result: Record<string, { configured: boolean; enabled: boolean; maskedKey?: string; connections?: number; usableConnections?: number; cooldownConnections?: number; exhaustedConnections?: number }> = {};
    const poolSummary = this.connectionManager.getProviderSummary();

    for (const p of providers) {
      if (p === 'mock' || p === 'local' || p === 'ollama') {
        result[p] = {
          configured: true,
          enabled: !this.disabledProviders.has(p),
        };
      } else {
        const key = this.configuredKeys.get(p);
        const pool = poolSummary[p];
        result[p] = {
          configured: !!key || !!pool?.configured,
          enabled: !this.disabledProviders.has(p),
          maskedKey: key ? `${key.slice(0, 4)}...${key.slice(-4)}` : undefined,
          connections: pool?.total || 0,
          usableConnections: pool?.usable || 0,
          cooldownConnections: pool?.cooldown || 0,
          exhaustedConnections: pool?.exhausted || 0,
        };
      }
    }
    return result;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getConfig(): RouterConfig {
    return this.config;
  }

  updateConfig(newConfig: RouterConfig) {
    this.config = newConfig;
  }

  resolveCandidates(req: UniversalRequest): { candidates: RouteCandidate[]; classification: ClassificationResult } {
    const requested = req.model.trim();
    const classification = IntentClassifier.classify(req);

    const isProvActive = (p: ProviderType) => (
      !!this.configuredKeys.get(p) || this.connectionManager.hasUsable(p)
    ) && !this.disabledProviders.has(p);

    const hasOpenAI = isProvActive('openai');
    const hasAnthropic = isProvActive('anthropic');
    const hasGemini = isProvActive('gemini');
    const hasGroq = isProvActive('groq');
    const hasDeepSeek = isProvActive('deepseek');
    const hasMistral = isProvActive('mistral');
    const hasXAI = isProvActive('xai');
    const hasOpenRouter = isProvActive('openrouter');
    const hasGitHub = isProvActive('github');
    const hasTogether = isProvActive('together');
    const hasHuggingFace = isProvActive('huggingface');
    const hasQwen = isProvActive('qwen');
    const hasLocal = !this.disabledProviders.has('local');

    const isFreeExplicit = (
      req.openrouter_routing === 'free' ||
      requested === 'free' ||
      requested.includes(':free') ||
      requested.includes('openrouter/free') ||
      requested.startsWith('local') ||
      requested.startsWith('ollama')
    );

    const getFreeFallbacks = (excludeModel?: string): RouteCandidate[] => {
      const freeEndpoints = [
        'openrouter::openrouter/free',
        'openrouter::nvidia/nemotron-3.5-lightning:free',
        'openrouter::minimax/minimax-m3:free',
        'openrouter::cohere/north-mini-code:free',
        'openrouter::poolside/laguna-s-2.1:free',
        'openrouter::liquid/lfm-2.5-2.6b:free',
        'openrouter::dots-studio/dots-3-note-preview:free',
      ];
      const list: RouteCandidate[] = [];
      if (hasOpenRouter) {
        for (const endpoint of freeEndpoints) {
          if (endpoint !== excludeModel && (!excludeModel || !excludeModel.includes(endpoint.replace('openrouter::', '')))) {
            list.push({ provider: 'openrouter', model: endpoint, timeout_ms: 180_000 });
          }
        }
      }
      if (hasLocal) {
        list.push(
          { provider: 'local', model: 'qwen2.5-coder:7b', timeout_ms: 20000 },
          { provider: 'local', model: 'llama3.1:8b', timeout_ms: 20000 },
          { provider: 'local', model: 'deepseek-r1:1.5b', timeout_ms: 15000 },
          { provider: 'local', model: 'qwen2.5-coder:14b', timeout_ms: 25000 }
        );
      }
      list.push({ provider: 'mock', model: 'mock-gpt-4o' });
      return list;
    };

    const getCloudFallbacks = (excludeProv: string): RouteCandidate[] => {
      const list: RouteCandidate[] = [];
      const xaiFallbackModel = classification.category === 'CODE_DEV' || requestExpectsFileWrite(req)
        ? 'grok-build-0.1'
        : 'grok-4.6';
      if (hasGemini && excludeProv !== 'gemini') list.push({ provider: 'gemini', model: 'gemini-flash-latest' });
      if (hasOpenRouter && excludeProv !== 'openrouter') list.push({ provider: 'openrouter', model: openRouterModel() });
      // Direct xAI has proven to be a dependable coding fallback. Keep it ahead
      // of low-TPM/free pools so a failed primary still has time to complete.
      if (hasXAI && excludeProv !== 'xai') list.push({ provider: 'xai', model: xaiFallbackModel, timeout_ms: 150_000 });
      if (hasGroq && excludeProv !== 'groq') list.push({ provider: 'groq', model: 'groq/llama-3.3-70b-versatile' });
      if (hasAnthropic && excludeProv !== 'anthropic') list.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
      if (hasOpenAI && excludeProv !== 'openai') list.push({ provider: 'openai', model: 'gpt-4o' });
      if (hasDeepSeek && excludeProv !== 'deepseek') list.push({ provider: 'deepseek', model: 'deepseek-chat' });
      if (hasMistral && excludeProv !== 'mistral') list.push({ provider: 'mistral', model: 'mistral/mistral-small-latest' });
      if (hasTogether && excludeProv !== 'together') list.push({ provider: 'together', model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo' });
      return list;
    };

    const fallbackMockRoutes = this.config.virtual_models[requested]?.routes || [
      { provider: 'mock', model: 'mock-gpt-4o' },
      { provider: 'mock', model: 'mock-claude-3-5-sonnet' },
      { provider: 'mock', model: 'mock-gemini-1-5-flash' },
    ];

    // 0. Free Mode Fortress: If user selected free routing, free target, or free model, strictly restrict to zero-cost models!
    if (isFreeExplicit) {
      const freeList = getFreeFallbacks(requested.startsWith('openrouter::') || requested.includes(':free') ? requested : undefined);
      if (requested.startsWith('openrouter::') || requested.includes(':free') || requested.startsWith('local')) {
        const prov = requested.startsWith('local') ? 'local' : 'openrouter';
        const direct = directCandidate(prov, requested);
        return {
          candidates: [direct, ...freeList.filter(c => c.model !== direct.model && c.provider !== 'mock'), ...fallbackMockRoutes],
          classification,
        };
      }
      return {
        candidates: [...freeList.filter(c => c.provider !== 'mock'), ...fallbackMockRoutes],
        classification,
      };
    }

    // 1. If user requested explicit "provider/model" syntax
    const knownProviders: ProviderType[] = ['openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'mistral', 'xai', 'openrouter', 'github', 'together', 'huggingface', 'qwen', 'local', 'ollama', 'mock'];
    for (const prov of knownProviders) {
      if (requested.startsWith(`${prov}/`) || requested.startsWith(`${prov}::`)) {
        const hasKey = prov === 'local' || prov === 'ollama' || prov === 'mock' || !!this.configuredKeys.get(prov) || this.connectionManager.hasUsable(prov);
        const isEnabled = !this.disabledProviders.has(prov);
        const directList: RouteCandidate[] = [];
        if (hasKey && isEnabled) directList.push(directCandidate(prov, requested));
        if (isFreeExplicit) {
          directList.push(...getFreeFallbacks(requested));
        } else if (prov !== 'local' && prov !== 'ollama') {
          directList.push(...getCloudFallbacks(prov));
        }
        directList.push(
          { provider: 'mock', model: 'mock-gpt-4o' }
        );
        return { candidates: directList, classification };
      }
    }

    // 2. Direct catalog or recognized prefix model
    if (MODEL_CATALOG[requested]) {
      const cap = MODEL_CATALOG[requested];
      const hasKey = cap.provider === 'mock' || cap.provider === 'local' || cap.provider === 'ollama' || !!this.configuredKeys.get(cap.provider) || this.connectionManager.hasUsable(cap.provider);
      const directList: RouteCandidate[] = [];
      if (hasKey) directList.push(directCandidate(cap.provider, requested));
      if (cap.provider !== 'local') directList.push(...getCloudFallbacks(cap.provider));
      directList.push(
        { provider: 'mock', model: 'mock-gpt-4o' }
      );
      return { candidates: directList, classification };
    }
    if (requested.startsWith('gemini')) {
      const directList: RouteCandidate[] = [];
      if (hasGemini) directList.push({ provider: 'gemini', model: requested });
      directList.push(...getCloudFallbacks('gemini'));
      directList.push(
        { provider: 'mock', model: requested.includes('pro') ? 'mock-gpt-4o' : 'mock-gemini-1-5-flash' }
      );
      return { candidates: directList, classification };
    }
    if (requested.startsWith('gpt-') || requested.startsWith('o3-') || requested.startsWith('o1-')) {
      const directList: RouteCandidate[] = [];
      if (hasOpenAI) directList.push({ provider: 'openai', model: requested });
      if (hasGitHub) directList.push({ provider: 'github', model: requested });
      directList.push(...getCloudFallbacks('openai'));
      directList.push(
        { provider: 'mock', model: 'mock-gpt-4o' }
      );
      return { candidates: directList, classification };
    }
    if (requested.startsWith('claude-')) {
      const directList: RouteCandidate[] = [];
      if (hasAnthropic) directList.push({ provider: 'anthropic', model: requested });
      directList.push(...getCloudFallbacks('anthropic'));
      directList.push(
        { provider: 'mock', model: 'mock-claude-3-5-sonnet' }
      );
      return { candidates: directList, classification };
    }
    if (requested.startsWith('deepseek-')) {
      const directList: RouteCandidate[] = [];
      if (hasDeepSeek) directList.push({ provider: 'deepseek', model: requested });
      if (hasGitHub && requested.includes('r1')) directList.push({ provider: 'github', model: 'github/deepseek-r1' });
      directList.push(...getCloudFallbacks('deepseek'));
      directList.push(
        { provider: 'mock', model: 'mock-gpt-4o' }
      );
      return { candidates: directList, classification };
    }
    if (requested.startsWith('mistral-')) {
      const directList: RouteCandidate[] = [];
      if (hasMistral) directList.push({ provider: 'mistral', model: requested });
      directList.push(...getCloudFallbacks('mistral'));
      directList.push({ provider: 'mock', model: 'mock-gpt-4o' });
      return { candidates: directList, classification };
    }
    if (requested.startsWith('grok-')) {
      const directList: RouteCandidate[] = [];
      if (hasXAI) directList.push({ provider: 'xai', model: requested, timeout_ms: 150_000 });
      directList.push(...getCloudFallbacks('xai'));
      directList.push({ provider: 'mock', model: 'mock-gpt-4o' });
      return { candidates: directList, classification };
    }
    if (requested.startsWith('qwen') || requested.startsWith('qwq')) {
      const directList: RouteCandidate[] = [];
      if (hasQwen) directList.push({ provider: 'qwen', model: requested });
      directList.push(...getCloudFallbacks('qwen'));
      directList.push({ provider: 'mock', model: 'mock-gpt-4o' });
      return { candidates: directList, classification };
    }
    if (requested.startsWith('mock-')) return { candidates: [{ provider: 'mock', model: requested }], classification };

    // 3. Virtual Model resolution
    const liveCandidates: RouteCandidate[] = [];
    const effectiveTier = requested === 'auto'
      ? (requestExpectsFileWrite(req) ? 'coding' : classification.recommendedTier)
      : requested;
    const openRouterCodingModel = process.env.OPENROUTER_CODING_MODEL?.trim() || openRouterModel();

    // Dedicated Vision Routing: If user attached a screenshot or image, route to frontier vision-capable models
    if (classification.hasVision) {
      const visionCandidates: RouteCandidate[] = [];
      if (hasAnthropic) {
        visionCandidates.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
        visionCandidates.push({ provider: 'anthropic', model: 'claude-3-5-haiku-20241022' });
      }
      if (hasOpenRouter) {
        visionCandidates.push({ provider: 'openrouter', model: openRouterModel(), timeout_ms: 120_000 });
      }
      if (hasGemini) {
        visionCandidates.push({ provider: 'gemini', model: 'gemini-1.5-flash' });
        visionCandidates.push({ provider: 'gemini', model: 'gemini-1.5-pro' });
      }
      if (hasOpenAI) {
        visionCandidates.push({ provider: 'openai', model: 'gpt-4o' });
        visionCandidates.push({ provider: 'openai', model: 'gpt-4o-mini' });
      }
      if (hasXAI) visionCandidates.push({ provider: 'xai', model: 'grok-4.6', timeout_ms: 150_000 });
      if (hasGitHub) visionCandidates.push({ provider: 'github', model: 'github/gpt-4o' });
      if (hasLocal) {
        visionCandidates.push({ provider: 'local', model: 'local/llama3.2-vision', timeout_ms: 45000 });
        visionCandidates.push({ provider: 'local', model: 'local/moondream', timeout_ms: 30000 });
      }
      visionCandidates.push({ provider: 'mock', model: 'mock-gpt-4o' });
      return { candidates: visionCandidates, classification };
    }

    if (effectiveTier === 'coding') {
      if (hasXAI) liveCandidates.push({ provider: 'xai', model: 'grok-4.6', timeout_ms: 150_000 });
      if (hasOpenRouter) liveCandidates.push({ provider: 'openrouter', model: openRouterCodingModel, timeout_ms: 90_000 });
      if (hasDeepSeek) liveCandidates.push({ provider: 'deepseek', model: 'deepseek-chat' });
      if (hasTogether) liveCandidates.push({ provider: 'together', model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo' });
      if (hasGroq) liveCandidates.push({ provider: 'groq', model: 'groq/llama-3.3-70b-versatile' });
      if (hasGemini) liveCandidates.push({ provider: 'gemini', model: 'gemini-1.5-flash' });
      if (hasAnthropic) liveCandidates.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
      if (hasOpenAI) liveCandidates.push({ provider: 'openai', model: 'gpt-4o' });
      if (hasGitHub) liveCandidates.push({ provider: 'github', model: 'github/gpt-4o' });
      if (hasMistral) liveCandidates.push({ provider: 'mistral', model: 'mistral/mistral-small-latest' });
    } else if (effectiveTier === 'reasoning') {
      if (hasXAI) liveCandidates.push({ provider: 'xai', model: 'grok-4.6', timeout_ms: 150_000 });
      if (hasOpenRouter) liveCandidates.push({ provider: 'openrouter', model: openRouterModel() });
      if (hasDeepSeek) liveCandidates.push({ provider: 'deepseek', model: 'deepseek-reasoner' });
      if (hasTogether) liveCandidates.push({ provider: 'together', model: 'together/deepseek-ai/DeepSeek-R1' });
      if (hasGemini) liveCandidates.push({ provider: 'gemini', model: 'gemini-1.5-pro' });
      if (hasGitHub) liveCandidates.push({ provider: 'github', model: 'github/o3-mini' });
      if (hasOpenAI) liveCandidates.push({ provider: 'openai', model: 'o3-mini' });
      if (hasAnthropic) liveCandidates.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
      if (hasMistral) liveCandidates.push({ provider: 'mistral', model: 'mistral/mistral-small-latest' });
    } else if (effectiveTier === 'fast') {
      if (hasOpenRouter) liveCandidates.push({ provider: 'openrouter', model: openRouterModel() });
      if (hasDeepSeek) liveCandidates.push({ provider: 'deepseek', model: 'deepseek-chat' });
      if (hasTogether) liveCandidates.push({ provider: 'together', model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo' });
      if (hasGroq) liveCandidates.push({ provider: 'groq', model: 'groq/llama-3.3-70b-versatile' });
      if (hasXAI) liveCandidates.push({ provider: 'xai', model: 'grok-4.6', timeout_ms: 120_000 });
      if (hasGemini) liveCandidates.push({ provider: 'gemini', model: 'gemini-1.5-flash' });
      if (hasGitHub) liveCandidates.push({ provider: 'github', model: 'github/gpt-4o-mini' });
      if (hasOpenAI) liveCandidates.push({ provider: 'openai', model: 'gpt-4o-mini' });
      if (hasAnthropic) liveCandidates.push({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
      if (hasMistral) liveCandidates.push({ provider: 'mistral', model: 'mistral/mistral-small-latest' });
    } else {
      // General balanced
      if (hasOpenRouter) liveCandidates.push({ provider: 'openrouter', model: openRouterModel() });
      if (hasDeepSeek) liveCandidates.push({ provider: 'deepseek', model: 'deepseek-chat' });
      if (hasTogether) liveCandidates.push({ provider: 'together', model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo' });
      if (hasGroq) liveCandidates.push({ provider: 'groq', model: 'groq/llama-3.3-70b-versatile' });
      if (hasXAI) liveCandidates.push({ provider: 'xai', model: 'grok-4.6', timeout_ms: 150_000 });
      if (hasGemini) liveCandidates.push({ provider: 'gemini', model: 'gemini-1.5-flash' });
      if (hasOpenAI) liveCandidates.push({ provider: 'openai', model: 'gpt-4o' });
      if (hasGitHub) liveCandidates.push({ provider: 'github', model: 'github/gpt-4o' });
      if (hasAnthropic) liveCandidates.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
      if (hasMistral) liveCandidates.push({ provider: 'mistral', model: 'mistral/mistral-small-latest' });
    }



    const candidateList = liveCandidates.length > 0
      ? [...liveCandidates, ...fallbackMockRoutes]
      : fallbackMockRoutes;

    return {
      candidates: candidateList.filter(c => c.provider === 'mock' || !this.disabledProviders.has(c.provider)),
      classification,
    };
  }

  private ensureAutonomousPrompt(req: UniversalRequest): UniversalRequest {
    const toolsOptedIn = req.enable_tools === true || (Array.isArray(req.tools) && req.tools.length > 0);
    if (!toolsOptedIn) {
      return {
        ...req,
        tools: undefined,
      };
    }

    const requestedTools = (Array.isArray(req.tools) && req.tools.length > 0) ? req.tools : ToolRegistry.getBuiltInTools();
    let tools = scopeAutonomousTools(req, requestedTools);
    const ws = ToolRegistry.getWorkspaceDir();
    const isRoaster = (req.model || '').toLowerCase().includes('dolphin') || (req.model || '').toLowerCase().includes('roaster');
    const hasSystem = req.messages.some(message => message.role === 'system');
    const legacyAutoPrompt = isRoaster
      ? `You are NexusRoute Universal Roast Master running locally on the user's computer.
Workspace Directory: ${ws}

CORE MISSION & PERSONA:
- You possess razor-sharp comedic timing, savage wit, and ZERO corporate filters or disclaimers.
- Tear apart ANY topic, person, tech stack, code, or concept with hilarious punchlines, creative metaphors, and theatrical contempt.
- NEVER say "as an AI I cannot mock or judge". Roast relentlessly with style!
- INTERNET RESEARCH & REAL-TIME WEB SEARCH: You have access to real-time internet tools! When asked for current news, headlines, or to roast someone, NEVER say "as a local AI I cannot browse the web". ALWAYS output a tool call to search the web:
\`\`\`json
{ "name": "web_search", "arguments": { "query": "trending headlines on x.com twitter" } }
\`\`\`
- DESKTOP VISION: Use 'take_desktop_screenshot' to inspect and roast what is currently on the user's screen.`
      : `You are NexusRoute Autonomous AI Engineer running locally on the user's Windows computer.
Workspace Directory: ${ws}

CORE PERSONALITY & TONE:
- 100% TRUTHFUL & BRUTALLY HONEST: Always give accurate facts, real engineering answers, and working code. Zero corporate sugar-coating, zero PR fluff, and zero fake diplomacy.
- HINT OF CONSPIRACY THEORIST: You have a hilarious, playful tin-foil hat streak—you love squinting at Big Tech, the matrix/simulation, mysterious update changelogs, and mundane coincidences, humorously "connecting the dots that aren't there" with dry skepticism.
- RAZOR-SHARP SENSE OF HUMOR: Witty, sarcastic, entertaining, and punchy. You make building software fun and never sound like a sanitized corporate drone.
- BULLETPROOF CODE & EXECUTION: Beneath the wit and comedic paranoia, your code syntax, CMake/JUCE setups, Android APKs, and tools are mathematically exact and fully working.

CORE SYSTEM PERMISSIONS & CAPABILITIES:
- You are connected to NexusRoute's dedicated Windows workspace through built-in tools. File reads and writes are restricted to Workspace Directory: ${ws}.
- NEVER claim that a file was created, edited, saved, built, or verified unless the corresponding tool returned a successful result. For every successful write, report the exact fullPath and bytesWritten from the 'write_file' result.
- When tools are enabled, execute requested workspace actions directly instead of giving the user manual command-line instructions.
- If the user asks if you can execute commands or access their system, confirm that you can and immediately offer/execute the necessary actions.

CRITICAL FOLDER & PROJECT STRUCTURE RULES:
1. ALWAYS organize files into clean, dedicated project subfolders within ${ws}/:
   - For Android projects: save inside 'android/<app_name>/...' and compile with the 'build_android_apk' tool. (NEVER run gradlew or gradlew.bat; always use 'build_android_apk').
   - For Windows / C++ / Audio Plugin projects: save inside 'plugins/<plugin_name>/...' or 'windows/<project_name>/...'
   - For Web apps, scripts, games, or utilities: save inside 'projects/<project_name>/...' or 'web/<app_name>/...'
   - NEVER dump random loose code or build files in the workspace root directory.
2. Keep 'art/' exclusively for images generated by 'generate_image'. Do NOT put code in 'art/'.
3. Complete the entire task from start to finish autonomously in consecutive steps without stopping prematurely or asking the user for permission between each intermediate step. Keep executing until the full solution is built and verified.
4. You MUST proactively invoke the tools:
   - FILE CREATION & EDITING RULE: Use 'write_file' for new files or complete rewrites. For a focused change to an existing file, prefer 'patch_file' with one exact unique old_text block and its replacement; this avoids resending the whole file. DO NOT use 'cat << EOF', 'echo >', or shell redirection in 'execute_command' to write files, as heredocs fail on Windows shells.
   - Use 'execute_command' exclusively to run compilers (CMake, MSVC, Clang, Javac), test runners, Git, npm, Python scripts, or system utilities.
   - Use 'read_file' or 'list_directory' to inspect existing files before modifying.
   - Use 'generate_image' with engine='${req.art_engine || 'promptforge'}' to generate studio-grade AI artwork. (${req.art_engine === 'promptforge' || req.art_engine === 'gpu' ? 'Local RTX GPU Engine (PromptForge RTX) selected by user.' : 'Cloud Studio HD Engine selected by user.'})
      PROMPTING & NEGATIVE PROMPTING RULE: When crafting the 'prompt' argument for 'generate_image', act as a master visual art director! Do NOT use lazy 3-word prompts. Expand the user's concept into a vivid, descriptive prompt specifying subject detail, dramatic lighting (volumetric, chiaroscuro, cinematic rays), camera lens / angle (e.g. 35mm, Hasselblad, wide-angle), atmosphere, textures, and artistic fidelity (e.g. '8k resolution, photorealistic, intricate textures, octane render, masterpiece').
      NEGATIVE PROMPTS: ALWAYS supply a customized 'negative_prompt' argument detailing specific visual artifacts, flaws, or styles to strictly exclude (e.g. for photorealism: 'cartoon, 3D render, illustration, blurry, bad anatomy, deformed limbs, extra fingers, text, watermark, logo, oversaturated, low quality, cropped'; for anime/vector: 'photorealistic, photograph, 3d octane render, ugly, deformed, text').
   - Use 'open_in_browser_or_app' to open created HTML files, apps, images, or project folders on the user's desktop.
   - INTERACTIVE HTML TESTING: For every HTML game, arcade clone, simulator, or interactive Canvas/WebGL app, opening the page is NOT verification. After all files exist, call 'test_html_app'. It must genuinely click the visible Start/Play control, send gameplay input, observe the post-click state, and report no runtime/console errors. If it fails, repair the exact error and rerun test_html_app before claiming completion.
   - Use 'take_desktop_screenshot' to capture and inspect the user's Windows desktop monitor (e.g. to inspect compiler errors, review open windows, or analyze UI layouts).
      CRITICAL DESKTOP VISION RULE: When the user asks "can you see my desktop?", "what's on my screen?", "inspect this window", "look at my code / error", or asks about what they are looking at on their computer, you DO have full desktop vision via 'take_desktop_screenshot'! You MUST IMMEDIATELY call 'take_desktop_screenshot' to capture their screen in the first turn. NEVER say "I cannot see your screen" or "that tool is not available".
   - Use 'fetch_webpage' with a URL to read full documentation, articles, or online code repositories.
   - Use 'remember_fact' and 'recall_memory' to store and retrieve persistent long-term notes, user preferences, and project context across sessions.
   - Use 'calculator' for exact math calculations.
   - Use 'web_search' for current information.
5. Always reference real local Windows paths (inside ${ws}) rather than Unix /tmp paths.
6. WINDOWS VST3 & DESKTOP AUDIO PLUGIN BUILDS (C++ / JUCE):
   - JUCE is EXCLUSIVELY for Windows Desktop C++ VST3 plugins and standalone Windows .exe applications inside 'plugins/<plugin_name>/'.
   - DO NOT ATTEMPT TO USE JUCE FOR ANDROID APPS!
   - NEVER try to run 'juce' command line or Projucer. Instead, create a 'CMakeLists.txt' in the plugin folder with:
     add_subdirectory("C:/Users/adria/source/repos/JUCE" JUCE)
     juce_add_plugin(<PluginName> FORMATS VST3 Standalone PRODUCT_NAME "<PluginName>")
   - Then compile using 'execute_command':
     cmake -B build -S . -DCMAKE_BUILD_TYPE=Release
     cmake --build build --config Release
   - The resulting .vst3 is located at 'build/<PluginName>_artefacts/Release/VST3/<PluginName>.vst3'.

7. ANDROID APPS, MOBILE GAMES & APK BUILDS (Pure Native Android Framework):
   - Android apps use pure native Android Java/Kotlin with Android Canvas, SurfaceView, ToneGenerator, MediaPlayer, and AudioTrack.
   - NEVER mention JUCE, C++, or Projucer for Android apps. Android apps are 100% Java/XML built with the 'build_android_apk' tool!
   - When asked to create or build an Android app or .apk, DO NOT give manual steps or ask the user to assemble it.
   - ALWAYS use the 'build_android_apk' tool! Provide appName, packageName, mainActivityCode (full working Android Java Activity with UI and game logic), and optional layoutXml / manifestXml.
   - The tool compiles resources (AAPT2), Java bytecode (Javac), dexes with D8, aligns, and generates a signed, installable .apk at 'android/<appName>/dist/<appName>.apk' in seconds, and automatically launches it on the connected Android emulator!
   - GAME INITIALIZATION RULE: Always start games directly in active playing mode on startup (start animation/game loop in surfaceCreated/onResume without hanging on an unstarted loading screen).
   - EMULATOR TESTING: You can use 'test_android_app' with action='install_and_launch', 'take_screenshot', 'send_input', or 'get_logs'. When you take a screenshot, the system displays it to the user. Do NOT call take_screenshot multiple times in a loop! If you need to test interactions, use send_input with input_type='tap' or 'key'.
8. After completing all steps, provide a clear, concise summary of what was accomplished.`;
    const autoPrompt = isRoaster ? legacyAutoPrompt : compactAutonomousPrompt(req, ws);

    // Conservative and recoverable context compaction. The six newest messages
    // remain byte-for-byte intact; every compacted block is stored on disk and
    // can be recovered with recover_raw_context.
    const filteredMessages = req.messages.filter(msg => !(
      isRoaster &&
      msg.role === 'assistant' &&
      typeof msg.content === 'string' &&
      (msg.content.includes("I'm not an AI that can make judgements") || msg.content.includes("My designed purpose is to assist you with tasks like coding"))
    ));
    const compressionRun = compressMessages(filteredMessages, ws, 6);
    const sanitizedMessages = compressionRun.messages;
    const compressionMetadata = {
      original_chars: compressionRun.stats.originalChars,
      compressed_chars: compressionRun.stats.compressedChars,
      saved_chars: compressionRun.stats.savedChars,
      raw_blocks_stored: compressionRun.stats.rawBlocksStored,
      raw_ids: compressionRun.stats.rawIds,
    };

    if (hasSystem) {
      const updatedMessages = sanitizedMessages.map(m => {
        if (m.role === 'system') {
          return {
            ...m,
            content: `${m.content}\n\n${autoPrompt}`,
          };
        }
        return m;
      });
      return { ...req, tools, messages: updatedMessages, metadata: { ...req.metadata, nexus_compression: compressionMetadata } };
    }

    return {
      ...req,
      tools,
      messages: [{ role: 'system', content: autoPrompt }, ...sanitizedMessages],
      metadata: { ...req.metadata, nexus_compression: compressionMetadata },
    };
  }

  async executeChat(req: UniversalRequest): Promise<UniversalResponse> {
    const requestId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    const requestDeadline = requestStartedAt + positiveDuration(process.env.NEXUS_AGENT_REQUEST_TIMEOUT_MS, 900_000);
    this.agentEventLog.record({
      requestId,
      sessionId: req.session_id,
      stage: 'request_started',
      requestedModel: req.model,
    });
    // 1. Check Response Cache
    const cached = this.cache.get(req);
    if (cached) {
      const resp = JSON.parse(JSON.stringify(cached.response)) as UniversalResponse;
      resp.usage = zeroUsageCostForCache(resp.usage);
      if (resp.route_info) {
        resp.route_info.request_id = requestId;
        resp.route_info.route_stage = 'completed';
        resp.route_info.cached = true;
        resp.route_info.total_latency_ms = 1;
        this.telemetryStore.record({ requestedModel: req.model, routeInfo: resp.route_info, usage: resp.usage });
      }
      this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, success: true, durationMs: Date.now() - requestStartedAt, detail: 'response_cache_hit' });
      return resp;
    }

    const { candidates, classification } = this.resolveCandidates(req);
    const routeCandidates = this.expandCandidatesForConnections(candidates);
    const attempts: RouteMetadata['attempts'] = [];
    const timedOutCandidates = new Set<string>();
    const toolsExecuted: string[] = [];
    let verifiedWrites: VerifiedFileWrite[] = [];
    const observedWrites: VerifiedFileWrite[] = [];
    const rejectedWrites: RejectedFileWrite[] = [];
    let htmlRuntimeVerification: HtmlRuntimeVerification = { attempted: false, success: false, detail: 'Not tested yet.' };
    const effectiveReq = this.ensureAutonomousPrompt(req);
    const fileWriteExpected = requestExpectsFileWrite(req);
    const expectedFileTargets = requestedFilenames(req);
    const fileToolsAvailable = !!effectiveReq.tools?.some(tool => ['write_file', 'patch_file'].includes(tool.function.name));
    const htmlRuntimeToolAvailable = !!effectiveReq.tools?.some(tool => tool.function.name === 'test_html_app');
    const startTime = requestStartedAt;

    for (const [candidateIndex, candidate] of routeCandidates.entries()) {
      const { provider, model, timeout_ms } = candidate;
      const identity = candidateIdentity(provider, model);

      if (timedOutCandidates.has(identity)) {
        attempts.push({
          provider,
          model,
          status: 'failed',
          error: 'Skipped another API key after this provider/model timed out; preserving time for a different fallback.',
          latency_ms: 0,
        });
        continue;
      }

      if (!this.circuitBreaker.isAvailable(provider, model)) {
        attempts.push({
          provider,
          model,
          status: 'failed',
          error: `Circuit breaker OPEN for ${provider}:${model}`,
          latency_ms: 0,
        });
        continue;
      }

      if (provider === 'groq') {
        const budget = getGroqRequestBudget(effectiveReq);
        if (!budget.allowed) {
          attempts.push({
            provider,
            model,
            status: 'failed',
            error: budget.reason,
            latency_ms: 0,
          });
          continue;
        }
      }

      const target = this.selectAttemptTarget(provider);
      if (!target) {
        attempts.push({
          provider,
          model,
          status: 'failed',
          error: `No ready ${provider} connection (all keys are disabled, exhausted, or cooling down)`,
          latency_ms: 0,
        });
        continue;
      }
      const { adapter, connection } = target;
      this.agentEventLog.record({
        requestId,
        sessionId: req.session_id,
        stage: 'route_selected',
        requestedModel: req.model,
        provider,
        model,
        connectionLabel: connection?.label,
        durationMs: Date.now() - startTime,
      });

      const attemptStart = Date.now();
      let attemptDeadline = attemptDeadlineFor(
        attemptStart,
        requestDeadline,
        timeout_ms,
        provider,
        routeCandidates.length - candidateIndex,
      );
      try {
        let currentMessages = [...effectiveReq.messages];
        let currentTools = effectiveReq.tools;
        let accumulatedUsage: UniversalResponse['usage'] | undefined;
        let modelTurnCount = 0;
        const runTurn = async (messages: UniversalMessage[], tools: UniversalRequest['tools']) => {
          modelTurnCount++;
          attemptDeadline = extendAttemptDeadline(attemptDeadline, requestDeadline, timeout_ms ?? effectiveReq.timeout_ms, provider);
          const remainingRequestMs = Math.min(attemptDeadline - Date.now(), Math.max(0, requestDeadline - Date.now()));
          if (remainingRequestMs < MIN_TURN_MS) throw new AdapterError(`${model} exhausted request time budget`, provider, 408, true);
          const timeout = turnTimeoutMs(provider, timeout_ms ?? effectiveReq.timeout_ms, remainingRequestMs);
          const turnStartedAt = Date.now();
          this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'turn_started', requestedModel: req.model, provider, model, connectionLabel: connection?.label, turn: modelTurnCount });
          const turnResponse = await withWallClockDeadline(
            adapter.chatCompletion({ ...effectiveReq, messages, tools, timeout_ms: timeout }, model),
            timeout,
            provider,
            model,
          );
          accumulatedUsage = mergeUsage(accumulatedUsage, turnResponse.usage);
          this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'turn_completed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, turn: modelTurnCount, durationMs: Date.now() - turnStartedAt, promptTokens: turnResponse.usage?.prompt_tokens, completionTokens: turnResponse.usage?.completion_tokens });
          attemptDeadline = extendAttemptDeadline(attemptDeadline, requestDeadline, timeout_ms ?? effectiveReq.timeout_ms, provider);
          return turnResponse;
        };
        let currentResponse = await runTurn(currentMessages, currentTools);
        let turnCount = 0;
        // Distinguishes leaving the loop on purpose from running out of turns.
        let finishedCleanly = false;
        const maxTurns = Math.round(positiveDuration(process.env.NEXUS_MAX_AGENT_TURNS, 30));
        let generatedImagesMarkdown = '';
        let fileCorrectionAttempts = 0;
        let fakeToolCorrectionAttempts = 0;
        let dependencyCorrectionAttempts = 0;
        let runtimeCorrectionAttempts = 0;
        const toolCallSignatureCounts: Map<string, number> = new Map();

        while (turnCount < maxTurns) {
          const choice = currentResponse.choices?.[0];
          let toolCalls = normalizeToolCalls(choice?.message?.tool_calls);
          if (choice?.message && toolCalls) choice.message.tool_calls = toolCalls;
          const allowedToolNames = new Set((currentTools || []).map(tool => tool.function.name));
          const availableToolNames = new Set((effectiveReq.tools || []).map(tool => tool.function.name));
          toolCalls = toolCalls?.filter(toolCall => allowedToolNames.has(toolCall.function.name));
          const fakeToolNames = textualToolTranscriptNames(choice?.message?.content || '', availableToolNames);

          // Parse markdown-fenced or raw JSON tool calls from local models
          if (fakeToolNames.length === 0 && allowedToolNames.size > 0 && (!toolCalls || toolCalls.length === 0) && choice?.message?.content) {
            const parsedTools = ToolRegistry.extractAllToolCallsFromJson(choice.message.content)
              .filter(parsedTool => allowedToolNames.has(parsedTool.name));
            if (parsedTools.length > 0) {
              toolCalls = parsedTools.map((pt, idx) => ({
                id: `call_${Date.now()}_${idx}`,
                type: 'function' as const,
                function: {
                  name: pt.name,
                  arguments: typeof pt.arguments === 'string' ? pt.arguments : JSON.stringify(pt.arguments || {}),
                },
              }));
              choice.message.tool_calls = toolCalls;
              choice.message.content = '';
            } else if (allowedToolNames.has('write_file') && expectedFileTargets.length > 0) {
              const codeBlockMatch = choice.message.content.match(/```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]{50,}?)\n```/);
              if (codeBlockMatch) {
                const targetFile = expectedFileTargets[0].replace(/\.exe$/i, '.cpp');
                toolCalls = [{
                  id: `call_${Date.now()}_auto`,
                  type: 'function' as const,
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ filename: targetFile, content: codeBlockMatch[1].trim() }),
                  },
                }];
                choice.message.tool_calls = toolCalls;
                choice.message.content = '';
              }
            }
          }

          if (!toolCalls || toolCalls.length === 0) {
            const dependencyIssues = htmlDependencyIssues(observedWrites, expectedFileTargets);
            if (fakeToolNames.length > 0 && fakeToolCorrectionAttempts < 1) {
              fakeToolCorrectionAttempts++;
              turnCount++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: choice?.message?.content || '' },
                { role: 'user', content: incompleteToolCorrection(fakeToolNames, dependencyIssues) },
              ];
              currentTools = effectiveReq.tools;
              currentResponse = await runTurn(currentMessages, currentTools);
              continue;
            }
            if (dependencyIssues.length > 0 && dependencyCorrectionAttempts < 1) {
              dependencyCorrectionAttempts++;
              turnCount++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: choice?.message?.content || '' },
                { role: 'user', content: htmlDependencyCorrection(dependencyIssues) },
              ];
              currentTools = effectiveReq.tools;
              currentResponse = await runTurn(currentMessages, currentTools);
              continue;
            }
            const runtimeTestRequired = requestNeedsHtmlRuntimeTest(req, observedWrites, expectedFileTargets, rejectedWrites);
            if (runtimeTestRequired && htmlRuntimeToolAvailable && !htmlRuntimeVerification.success && runtimeCorrectionAttempts < 1 && verifiedWrites.length === 0) {
              runtimeCorrectionAttempts++;
              turnCount++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: choice?.message?.content || '' },
                { role: 'user', content: htmlRuntimeCorrection(observedWrites, expectedFileTargets, htmlRuntimeVerification) },
              ];
              currentTools = effectiveReq.tools;
              currentResponse = await runTurn(currentMessages, currentTools);
              continue;
            }
            if (fakeToolNames.length > 0) {
              if (choice?.message) {
                choice.message.content = `⚠️ Incomplete tool execution: ${fakeToolNames.join(', ')} was printed as text but never ran.`;
              }
              finishedCleanly = true;
              break;
            }
            if (dependencyIssues.length > 0) {
              if (choice?.message) {
                choice.message.content = `⚠️ Incomplete HTML artifact: ${dependencyIssues.flatMap(issue => issue.missing).join(', ')} still ${dependencyIssues.flatMap(issue => issue.missing).length === 1 ? 'is' : 'are'} missing.`;
              }
              finishedCleanly = true;
              break;
            }
            if (runtimeTestRequired && htmlRuntimeToolAvailable && !htmlRuntimeVerification.success) {
              if (choice?.message) {
                choice.message.content = `⚠️ Incomplete interactive artifact: ${htmlRuntimeVerification.detail}`;
              }
              finishedCleanly = true;
              break;
            }
            const claimsFileCreatedInText = /(?:double-click\s*:|launch\s*:|created\s+|saved\s+to\s+|dist[\\/][\w.-]+|written\s+to\s+|output\s*:\s*`?[\w.-]+\.(?:exe|html|py|cpp))/i.test(choice?.message?.content || '');
            if ((fileWriteExpected || claimsFileCreatedInText) && fileToolsAvailable && verifiedWrites.length === 0 && fileCorrectionAttempts < 3) {
              fileCorrectionAttempts++;
              turnCount++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: choice?.message?.content || '' },
                {
                  role: 'user',
                  content: fileVerificationCorrection(expectedFileTargets, rejectedWrites),
                },
              ];
              currentTools = effectiveReq.tools;
              currentResponse = await runTurn(currentMessages, currentTools);
              continue;
            }
            finishedCleanly = true;
            break;
          }

          turnCount++;
          toolCalls.forEach(toolCall => this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'tool_started', requestedModel: req.model, provider, model, turn: modelTurnCount, tool: toolCall.function.name }));
          const toolsStartedAt = Date.now();

          // Intercept repeating tool calls with identical arguments
          const activeToolCalls: ToolCall[] = [];
          const bypassedResults: Map<number, UniversalMessage> = new Map();
          toolCalls.forEach((tc, idx) => {
            const sig = `${tc.function.name}::${tc.function.arguments || ''}`;
            const count = (toolCallSignatureCounts.get(sig) || 0) + 1;
            toolCallSignatureCounts.set(sig, count);
            if (count >= 3) {
              bypassedResults.set(idx, {
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.function.name,
                content: JSON.stringify({
                  error: `Repeated tool execution halted: "${tc.function.name}" was already executed with identical arguments. Please analyze previous results, explain any obstacle to the user, or take an alternative action.`,
                }),
              });
            } else {
              activeToolCalls.push(tc);
            }
          });

          const executedMessages = activeToolCalls.length > 0
            ? await ToolRegistry.executeToolCalls(activeToolCalls, req.art_engine)
            : [];
          
          let execIdx = 0;
          const toolMessages: UniversalMessage[] = toolCalls.map((_, idx) => {
            if (bypassedResults.has(idx)) return bypassedResults.get(idx)!;
            return executedMessages[execIdx++];
          });

          toolCalls.forEach((toolCall, index) => this.agentEventLog.record({
            requestId,
            sessionId: req.session_id,
            stage: 'tool_completed',
            requestedModel: req.model,
            provider,
            model,
            turn: modelTurnCount,
            tool: toolCall.function.name,
            success: !!toolMessages[index] && !!parseToolResult(toolMessages[index]),
            durationMs: Date.now() - toolsStartedAt,
          }));
          collectSuccessfulTools(toolCalls, toolMessages).forEach(name => toolsExecuted.push(name));
          const previouslyVerified = new Set(verifiedWrites.map(write => write.full_path.toLowerCase()));
          appendUniqueWrites(observedWrites, collectObservedFileWrites(toolCalls, toolMessages, expectedFileTargets));
          verifiedWrites = reassessVerifiedFileWrites(req, observedWrites, expectedFileTargets, rejectedWrites);
          htmlRuntimeVerification = updateHtmlRuntimeVerification(htmlRuntimeVerification, toolCalls, toolMessages);
          verifiedWrites
            .filter(write => !previouslyVerified.has(write.full_path.toLowerCase()))
            .forEach(write => this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'file_verified', requestedModel: req.model, provider, model, turn: modelTurnCount, filename: write.full_path, bytesWritten: write.bytes_written, success: true }));

          let hasArt = false;
          // Capture any generated artwork embeds or screenshots
          for (let toolIndex = 0; toolIndex < toolMessages.length; toolIndex++) {
            const tm = toolMessages[toolIndex];
            const sourceTool = toolCalls[toolIndex]?.function.name;
            try {
              const parsed = JSON.parse(typeof tm.content === 'string' ? tm.content : '{}');
              if (parsed.filename && parsed.filename.startsWith('art/')) {
                hasArt = true;
                generatedImagesMarkdown += `\n\n![${parsed.prompt || 'Generated Artwork'}](/v1/workspace/files/${parsed.filename})\n\n`;
              } else if (parsed.filename && parsed.filename.startsWith('screenshots/')) {
                hasArt = true;
                generatedImagesMarkdown += `\n\n![Desktop Screenshot](/v1/workspace/files/${parsed.filename})\n\n`;
              } else if (parsed.screenshotPath) {
                if (sourceTool !== 'test_html_app') hasArt = true;
                const label = sourceTool === 'test_html_app' ? 'Post-click HTML runtime test' : 'Android Emulator Screenshot';
                generatedImagesMarkdown += `\n\n![${label}](/v1/workspace/files/${parsed.screenshotPath})\n\n`;
              }
            } catch {}
          }
          currentMessages = [
            ...currentMessages,
            {
              role: 'assistant',
              content: choice?.message?.content || '',
              tool_calls: toolCalls,
            },
            ...toolMessages,
          ];

          // If artwork was generated or budget reached, disallow tools on synthesis turn so model responds cleanly
          const runtimeTestRequired = requestNeedsHtmlRuntimeTest(req, observedWrites, expectedFileTargets, rejectedWrites);
          const isPenultimateTurn = turnCount >= maxTurns - 1;
          const allDone = (
            allRequestedFilesVerified(expectedFileTargets, verifiedWrites)
            && htmlDependencyIssues(observedWrites, expectedFileTargets).length === 0
            && (!runtimeTestRequired || htmlRuntimeVerification.success)
          );
          const nextTools = isPenultimateTurn || hasArt || allDone
            ? undefined
            : effectiveReq.tools;
          
          if (!nextTools) {
            currentMessages.push({
              role: 'user',
              content: '[Task complete: All requested files and verifications are saved to disk. Please provide a clear, concise final summary of what was accomplished, how the application works, and how the user can interact with it.]',
            });
          }

          currentTools = nextTools;
          currentResponse = await runTurn(currentMessages, nextTools);
        }

        const response = currentResponse;
        if (accumulatedUsage) response.usage = accumulatedUsage;
        if (turnCount >= maxTurns && !finishedCleanly && response.choices?.[0]?.message) {
          // Ran out of turns rather than finishing - mark it rather than
          // presenting a truncated result as a complete answer.
          this.agentEventLog.record({
            requestId,
            sessionId: req.session_id,
            stage: 'route_failed',
            requestedModel: req.model,
            provider,
            model,
            connectionLabel: connection?.label,
            success: false,
            durationMs: Date.now() - attemptStart,
            error: `agent loop hit the ${maxTurns}-turn limit before finishing`,
          });
          response.choices[0].message.content =
            `${response.choices[0].message.content || ''}\n\n⚠️ Stopped after ${maxTurns} agent turns with the task unfinished. Raise NEXUS_MAX_AGENT_TURNS or ask me to continue.`;
        }
        if (response.choices?.[0]?.message) {
          if (!response.choices[0].message.content && toolsExecuted.length > 0) {
            response.choices[0].message.content = `Completed execution of tools: ${toolsExecuted.join(', ')}.`;
          }
          if (generatedImagesMarkdown) {
            response.choices[0].message.content += generatedImagesMarkdown;
          }
          if (fileWriteExpected) {
            if (verifiedWrites.length > 0) {
              response.choices[0].message.content = `${response.choices[0].message.content || ''}\n\n${verifiedWriteSummary(verifiedWrites)}`.trim();
            } else {
              const reason = fileToolsAvailable
                ? rejectedWrites.at(-1)
                  ? `the file-tool result was incomplete (${rejectedWrites.at(-1)!.reason})`
                  : 'no successful write_file or patch_file result matched the requested target path'
                : 'workspace tools were disabled for this request';
              response.choices[0].message.content = `${response.choices[0].message.content || ''}\n\n⚠️ No file was written: ${reason}.`.trim();
            }
          }
        }

        this.circuitBreaker.recordSuccess(provider, model);
        attempts.push({
          provider,
          model,
          connection_id: connection?.id,
          connection_label: connection?.label,
          status: 'success',
          latency_ms: Date.now() - attemptStart,
        });

        const totalLatency = Date.now() - startTime;
        const estimatedCost = calculateEstimatedCost(model, response.usage);
        finalizeUsageCost(provider, response.usage, estimatedCost);
        if (connection) {
          this.connectionManager.recordSuccess(connection.id);
          this.connectionManager.recordUsage(connection.id, response.usage);
        }

        const compression = effectiveReq.metadata?.nexus_compression as RouteMetadata['compression'] | undefined;
        const decisionReasons = [
          `Intent classified as ${classification.category} (${Math.round(classification.complexityScore * 100)}% complexity).`,
          `Selected the first healthy candidate in the ${req.model} cascade.`,
          connection
            ? `Used connection "${connection.label}"; unavailable or exhausted keys were skipped.`
            : `Used the local ${provider} runtime without an API key.`,
          ...(provider === 'openrouter'
            ? [`OpenRouter routing mode: ${effectiveReq.openrouter_routing || 'balanced'}.`]
            : []),
        ];

        response.route_info = {
          request_id: requestId,
          route_stage: 'completed',
          requested_model: req.model,
          selected_provider: provider,
          selected_model: model,
          routing_strategy: 'cascade',
          attempts,
          total_latency_ms: totalLatency,
          selected_connection_id: connection?.id,
          selected_connection_label: connection?.label,
          decision_reasons: decisionReasons,
          cached: false,
          classification,
          compression,
          tools_executed: toolsExecuted.length > 0 ? toolsExecuted : undefined,
          files_written: verifiedWrites.length > 0 ? verifiedWrites : undefined,
          turn_count: modelTurnCount,
        };

        this.telemetryStore.record({ requestedModel: req.model, routeInfo: response.route_info, usage: response.usage });

        // Cache the successful response
        this.cache.set(req, response);

        this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, success: true, durationMs: totalLatency, promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens });

        return response;
      } catch (err: unknown) {
        const errorMsg = (err as Error).message;
        const statusCode = err instanceof AdapterError ? err.statusCode : 500;
        if (statusCode === 408) timedOutCandidates.add(identity);
        if (connection) this.connectionManager.recordFailure(
          connection.id,
          statusCode,
          errorMsg,
          err instanceof AdapterError ? err.retryAfterMs : undefined,
        );
        if (this.shouldTripProviderCircuit(provider)) this.circuitBreaker.recordFailure(provider, model);
        attempts.push({
          provider,
          model,
          connection_id: connection?.id,
          connection_label: connection?.label,
          status: 'failed',
          error: errorMsg,
          latency_ms: Date.now() - attemptStart,
        });
        this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'route_failed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, success: false, durationMs: Date.now() - attemptStart, error: errorMsg });
        continue;
      }
    }

    this.telemetryStore.record({
      requestedModel: req.model,
      success: false,
      routeInfo: {
        requested_model: req.model,
        selected_provider: 'none',
        selected_model: 'none',
        routing_strategy: 'cascade',
        attempts,
        total_latency_ms: Date.now() - startTime,
        request_id: requestId,
        route_stage: 'completed',
        decision_reasons: ['Every eligible route candidate failed or had no usable connection.'],
      },
    });
    this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, success: false, durationMs: Date.now() - startTime, error: 'Every eligible route candidate failed.' });
    throw new Error(
      `All upstream providers failed for model "${req.model}". Attempts: ${JSON.stringify(attempts)}`
    );
  }

  async *executeStream(req: UniversalRequest): AsyncGenerator<UniversalStreamChunk> {
    const requestId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    const requestDeadline = requestStartedAt + positiveDuration(process.env.NEXUS_AGENT_REQUEST_TIMEOUT_MS, 900_000);
    this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_started', requestedModel: req.model });
    // 1. Check Response Cache
    const cached = this.cache.get(req);
    if (cached) {
      const content = cached.response.choices?.[0]?.message?.content || '';
      const model = cached.response.model || req.model;
      const id = cached.response.id || `chatcmpl-${Date.now()}`;
      const cachedUsage = zeroUsageCostForCache(cached.response.usage);
      if (cached.response.route_info) {
        const cachedRouteInfo = { ...cached.response.route_info, request_id: requestId, route_stage: 'completed' as const, cached: true, total_latency_ms: 1 };
        this.telemetryStore.record({ requestedModel: req.model, routeInfo: cachedRouteInfo, usage: cachedUsage });
      }

      if (cached.streamChunks?.length) {
        for (const [index, storedChunk] of cached.streamChunks.entries()) {
          const isFinal = index === cached.streamChunks.length - 1;
          yield {
            ...storedChunk,
            ...(isFinal ? {
              usage: cachedUsage,
              route_info: {
                request_id: requestId,
                route_stage: 'completed',
                requested_model: req.model,
                selected_provider: cached.response.route_info?.selected_provider || 'cache',
                selected_model: model,
                selected_connection_id: cached.response.route_info?.selected_connection_id,
                selected_connection_label: cached.response.route_info?.selected_connection_label,
                routing_strategy: 'cache',
                attempts: [{
                  provider: cached.response.route_info?.selected_provider || 'cache',
                  model,
                  status: 'success' as const,
                  latency_ms: 0,
                }],
                total_latency_ms: 1,
                cached: true,
                decision_reasons: ['Returned an exact NexusRoute response-cache hit.'],
                classification: cached.response.route_info?.classification,
                compression: cached.response.route_info?.compression,
                tools_executed: cached.response.route_info?.tools_executed,
                files_written: cached.response.route_info?.files_written,
              },
            } : {}),
          };
        }
        this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, success: true, durationMs: Date.now() - requestStartedAt, detail: 'response_cache_hit' });
        return;
      }

      // Emit content chunk
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content },
            finish_reason: null,
          },
        ],
      };

      // Emit stop & route info chunk
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        usage: cachedUsage,
        route_info: {
          request_id: requestId,
          route_stage: 'completed',
          requested_model: req.model,
          selected_provider: cached.response.route_info?.selected_provider || 'cache',
          selected_model: model,
          selected_connection_id: cached.response.route_info?.selected_connection_id,
          selected_connection_label: cached.response.route_info?.selected_connection_label,
          routing_strategy: 'cache',
          attempts: [
            {
              provider: cached.response.route_info?.selected_provider || 'cache',
              model,
              status: 'success',
              latency_ms: 0,
            },
          ],
          total_latency_ms: 1,
          cached: true,
          decision_reasons: ['Returned an exact NexusRoute response-cache hit.'],
          classification: cached.response.route_info?.classification,
          compression: cached.response.route_info?.compression,
          tools_executed: cached.response.route_info?.tools_executed,
          files_written: cached.response.route_info?.files_written,
        },
      };
      this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, success: true, durationMs: Date.now() - requestStartedAt, detail: 'response_cache_hit' });
      return;
    }

    const effectiveReq = this.ensureAutonomousPrompt(req);
    const fileWriteExpected = requestExpectsFileWrite(req);
    const expectedFileTargets = requestedFilenames(req);
    const fileToolsAvailable = !!effectiveReq.tools?.some(tool => ['write_file', 'patch_file'].includes(tool.function.name));
    const htmlRuntimeToolAvailable = !!effectiveReq.tools?.some(tool => tool.function.name === 'test_html_app');
    const { candidates, classification } = this.resolveCandidates(effectiveReq);
    const routeCandidates = this.expandCandidatesForConnections(candidates);
    const attempts: RouteMetadata['attempts'] = [];
    const timedOutCandidates = new Set<string>();
    let firstRouteFailure: { provider: ProviderType; model: string; message: string } | undefined;
    const startTime = requestStartedAt;
    const recordedChunks: UniversalStreamChunk[] = [];
    let verifiedWrites: VerifiedFileWrite[] = [];
    const observedWrites: VerifiedFileWrite[] = [];
    const rejectedWrites: RejectedFileWrite[] = [];
    let htmlRuntimeVerification: HtmlRuntimeVerification = { attempted: false, success: false, detail: 'Not tested yet.' };

    for (const [candidateIndex, candidate] of routeCandidates.entries()) {
      const { provider, model, timeout_ms } = candidate;
      const identity = candidateIdentity(provider, model);

      if (timedOutCandidates.has(identity)) {
        attempts.push({
          provider,
          model,
          status: 'failed',
          error: 'Skipped another API key after this provider/model timed out; preserving time for a different fallback.',
          latency_ms: 0,
        });
        continue;
      }

      if (!this.circuitBreaker.isAvailable(provider, model)) {
        continue;
      }

      if (provider === 'groq') {
        const budget = getGroqRequestBudget(effectiveReq);
        if (!budget.allowed) {
          attempts.push({
            provider,
            model,
            status: 'failed',
            error: budget.reason,
            latency_ms: 0,
          });
          continue;
        }
      }

      const target = this.selectAttemptTarget(provider);
      if (!target) {
        attempts.push({
          provider,
          model,
          status: 'failed',
          error: `No ready ${provider} connection (all keys are disabled, exhausted, or cooling down)`,
          latency_ms: 0,
        });
        continue;
      }
      const { adapter, connection } = target;

      this.agentEventLog.record({
        requestId,
        sessionId: req.session_id,
        stage: 'route_selected',
        requestedModel: req.model,
        provider,
        model,
        connectionLabel: connection?.label,
        durationMs: Date.now() - startTime,
      });
      yield {
        id: `chatcmpl-${requestId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        route_info: {
          request_id: requestId,
          route_stage: 'selected',
          requested_model: req.model,
          selected_provider: provider,
          selected_model: model,
          selected_connection_id: connection?.id,
          selected_connection_label: connection?.label,
          routing_strategy: 'cascade',
          attempts: [...attempts],
          total_latency_ms: Date.now() - startTime,
          cached: false,
          classification,
          decision_reasons: [`Dispatching to ${provider}/${model}.`],
        },
      };

      const attemptStart = Date.now();
      let attemptDeadline = attemptDeadlineFor(
        attemptStart,
        requestDeadline,
        timeout_ms,
        provider,
        routeCandidates.length - candidateIndex,
      );
      const toolsExecuted: string[] = [];
      let hasYielded = false;
      let completedRouteInfo: RouteMetadata | undefined;
      const markStreamStarted = () => {
        if (hasYielded) return;
        hasYielded = true;
        this.circuitBreaker.recordSuccess(provider, model);
        if (connection) this.connectionManager.recordSuccess(connection.id);
        attempts.push({
          provider,
          model,
          connection_id: connection?.id,
          connection_label: connection?.label,
          status: 'success',
          latency_ms: Date.now() - attemptStart,
        });
      };

      try {
        let currentMessages = [...effectiveReq.messages];
        let currentTools = effectiveReq.tools;
        let turnCount = 0;
        const maxTurns = Math.round(positiveDuration(process.env.NEXUS_MAX_AGENT_TURNS, 30));
        let accumulatedUsage: UniversalResponse['usage'] | undefined = undefined;
        let fileCorrectionAttempts = 0;
        let fakeToolCorrectionAttempts = 0;
        let dependencyCorrectionAttempts = 0;
        let runtimeCorrectionAttempts = 0;
        const toolCallSignatureCounts: Map<string, number> = new Map();

        while (turnCount < maxTurns) {
          turnCount++;
          attemptDeadline = extendAttemptDeadline(attemptDeadline, requestDeadline, timeout_ms ?? effectiveReq.timeout_ms, provider);
          const remainingRequestMs = Math.min(attemptDeadline - Date.now(), Math.max(0, requestDeadline - Date.now()));
          if (remainingRequestMs < MIN_TURN_MS) throw new AdapterError(`${model} exhausted request time budget`, provider, 408, true);
          const timeout = turnTimeoutMs(provider, timeout_ms ?? effectiveReq.timeout_ms, remainingRequestMs);
          const currentReq: UniversalRequest = { ...effectiveReq, messages: currentMessages, tools: currentTools, timeout_ms: timeout };
          const stream = streamWithWallClockDeadline(adapter.streamChatCompletion(currentReq, model), timeout, provider, model);
          const turnStartedAt = Date.now();
          this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'turn_started', requestedModel: req.model, provider, model, connectionLabel: connection?.label, turn: turnCount });
          const allowedToolNames = new Set((currentTools || []).map(tool => tool.function.name));
          const availableToolNames = new Set((effectiveReq.tools || []).map(tool => tool.function.name));
          const accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
          let turnContent = '';
          let turnUsage: UniversalResponse['usage'] | undefined;
          const deferredChunks: UniversalStreamChunk[] = [];
          // Nothing is held to the end of the turn any more. Holding file-write
          // turns meant a minute or more of total silence, and when the write
          // could not be verified the whole response was discarded unseen.
          // Content streams as it arrives; an unverified write is flagged after.
          let bufferingTurn = !!currentTools && (provider === 'local' || provider === 'ollama');

          for await (const chunk of stream) {
            if (chunk.usage && chunk.usage.total_tokens) {
              turnUsage = chunk.usage;
            }

            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              turnContent += delta;
              if (bufferingTurn && !mayStillBeTextualToolCall(turnContent)) {
                bufferingTurn = false;
                for (const heldChunk of deferredChunks) {
                  markStreamStarted();
                  recordedChunks.push(heldChunk);
                  yield heldChunk;
                }
                deferredChunks.length = 0;
              }
              if (bufferingTurn) {
                deferredChunks.push(chunk);
              } else {
                markStreamStarted();
                recordedChunks.push(chunk);
                yield chunk;
              }
            }

            const tcDeltas = chunk.choices?.[0]?.delta?.tool_calls;
            if (tcDeltas && tcDeltas.length > 0) {
              for (const tc of tcDeltas) {
                const idx = tc.index ?? 0;
                if (!accumulatedToolCalls.has(idx)) {
                  accumulatedToolCalls.set(idx, { id: tc.id || `call_${Date.now()}_${idx}`, name: tc.function?.name || '', arguments: '' });
                }
                const existing = accumulatedToolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                const argumentDelta = (tc.function as any)?.arguments;
                if (typeof argumentDelta === 'string') existing.arguments += argumentDelta;
                else if (argumentDelta && typeof argumentDelta === 'object') existing.arguments = normalizeToolArguments(argumentDelta);
              }
            }
          }
          accumulatedUsage = mergeUsage(accumulatedUsage, turnUsage);
          this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'turn_completed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, turn: turnCount, durationMs: Date.now() - turnStartedAt, promptTokens: turnUsage?.prompt_tokens, completionTokens: turnUsage?.completion_tokens });

          attemptDeadline = extendAttemptDeadline(attemptDeadline, requestDeadline, timeout_ms ?? effectiveReq.timeout_ms, provider);
          const fakeToolNames = textualToolTranscriptNames(turnContent, availableToolNames);

          // Intercept JSON tool calls emitted in text by local models. A textual
          // "Executed tool" marker is never trusted as an actual invocation.
          if (fakeToolNames.length === 0 && allowedToolNames.size > 0 && accumulatedToolCalls.size === 0 && turnContent) {
            const parsedTools = ToolRegistry.extractAllToolCallsFromJson(turnContent)
              .filter(parsedTool => allowedToolNames.has(parsedTool.name));
            if (parsedTools.length > 0) {
              parsedTools.forEach((pt, idx) => {
                accumulatedToolCalls.set(idx, {
                  id: `call_${Date.now()}_${idx}`,
                  name: pt.name,
                  arguments: typeof pt.arguments === 'string' ? pt.arguments : JSON.stringify(pt.arguments || {}),
                });
              });
              turnContent = '';
            } else if (allowedToolNames.has('write_file') && expectedFileTargets.length > 0) {
              const codeBlockMatch = turnContent.match(/```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]{50,}?)\n```/);
              if (codeBlockMatch) {
                const targetFile = expectedFileTargets[0].replace(/\.exe$/i, '.cpp');
                accumulatedToolCalls.set(0, {
                  id: `call_${Date.now()}_auto`,
                  name: 'write_file',
                  arguments: JSON.stringify({ filename: targetFile, content: codeBlockMatch[1].trim() }),
                });
                turnContent = '';
              }
            }
          }

          for (const [index, toolCall] of accumulatedToolCalls.entries()) {
            if (!allowedToolNames.has(toolCall.name)) accumulatedToolCalls.delete(index);
          }

          if (accumulatedToolCalls.size > 0) {
            const toolCallsArray = normalizeToolCalls(Array.from(accumulatedToolCalls.values()).map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))) || [];
            const turnToolNames = toolCallsArray.map(tc => tc.function.name);

            const toolNoticeChunk: UniversalStreamChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\n🛠️ *[Running tool: ${turnToolNames.join(', ')}]*\n\n` },
                  finish_reason: null,
                },
              ],
            };
            markStreamStarted();
            recordedChunks.push(toolNoticeChunk);
            yield toolNoticeChunk;

            toolCallsArray.forEach(toolCall => this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'tool_started', requestedModel: req.model, provider, model, turn: turnCount, tool: toolCall.function.name }));
            const toolsStartedAt = Date.now();

            // Intercept repeating tool calls with identical arguments
            const activeToolCalls: ToolCall[] = [];
            const bypassedResults: Map<number, UniversalMessage> = new Map();
            toolCallsArray.forEach((tc, idx) => {
              const sig = `${tc.function.name}::${tc.function.arguments || ''}`;
              const count = (toolCallSignatureCounts.get(sig) || 0) + 1;
              toolCallSignatureCounts.set(sig, count);
              if (count >= 3) {
                bypassedResults.set(idx, {
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.function.name,
                  content: JSON.stringify({
                    error: `Repeated tool execution halted: "${tc.function.name}" was already executed with identical arguments. Please analyze previous results, explain any obstacle to the user, or take an alternative action.`,
                  }),
                });
              } else {
                activeToolCalls.push(tc);
              }
            });

            const executedMessages = activeToolCalls.length > 0
              ? await ToolRegistry.executeToolCalls(activeToolCalls, req.art_engine)
              : [];
            
            let execIdx = 0;
            const toolMessages: UniversalMessage[] = toolCallsArray.map((_, idx) => {
              if (bypassedResults.has(idx)) return bypassedResults.get(idx)!;
              return executedMessages[execIdx++];
            });

            toolCallsArray.forEach((toolCall, index) => this.agentEventLog.record({
              requestId,
              sessionId: req.session_id,
              stage: 'tool_completed',
              requestedModel: req.model,
              provider,
              model,
              turn: turnCount,
              tool: toolCall.function.name,
              success: !!toolMessages[index] && !!parseToolResult(toolMessages[index]),
              durationMs: Date.now() - toolsStartedAt,
            }));
            collectSuccessfulTools(toolCallsArray, toolMessages).forEach(name => toolsExecuted.push(name));
            const previouslyVerified = new Set(verifiedWrites.map(write => write.full_path.toLowerCase()));
            appendUniqueWrites(observedWrites, collectObservedFileWrites(toolCallsArray, toolMessages, expectedFileTargets));
            verifiedWrites = reassessVerifiedFileWrites(req, observedWrites, expectedFileTargets, rejectedWrites);
            htmlRuntimeVerification = updateHtmlRuntimeVerification(htmlRuntimeVerification, toolCallsArray, toolMessages);
            const newVerifiedWrites = verifiedWrites.filter(write => !previouslyVerified.has(write.full_path.toLowerCase()));
            newVerifiedWrites.forEach(write => this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'file_verified', requestedModel: req.model, provider, model, turn: turnCount, filename: write.full_path, bytesWritten: write.bytes_written, success: true }));

            if (newVerifiedWrites.length > 0) {
              const verificationChunk: UniversalStreamChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { content: `\n${verifiedWriteSummary(newVerifiedWrites)}\n\n` },
                  finish_reason: null,
                }],
              };
              markStreamStarted();
              recordedChunks.push(verificationChunk);
              yield verificationChunk;
            }

            let hasArt = false;
            // If an artwork image or screenshot was generated, yield the image embed markdown
            for (let toolIndex = 0; toolIndex < toolMessages.length; toolIndex++) {
              const tm = toolMessages[toolIndex];
              const sourceTool = toolCallsArray[toolIndex]?.function.name;
              try {
                const parsed = JSON.parse(typeof tm.content === 'string' ? tm.content : '{}');
                if (parsed.filename && parsed.filename.startsWith('art/')) {
                  hasArt = true;
                  const imgMarkdown = `\n\n![${parsed.prompt || 'Generated Artwork'}](/v1/workspace/files/${parsed.filename})\n\n`;
                  const imgChunk: UniversalStreamChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: imgMarkdown },
                        finish_reason: null,
                      },
                    ],
                  };
                  markStreamStarted();
                  recordedChunks.push(imgChunk);
                  yield imgChunk;
                } else if (parsed.filename && parsed.filename.startsWith('screenshots/')) {
                  const shotMarkdown = `\n\n![Desktop Screenshot](/v1/workspace/files/${parsed.filename})\n\n`;
                  const shotChunk: UniversalStreamChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: shotMarkdown },
                        finish_reason: null,
                      },
                    ],
                  };
                  markStreamStarted();
                  recordedChunks.push(shotChunk);
                  yield shotChunk;
                } else if (parsed.screenshotPath) {
                  if (sourceTool !== 'test_html_app') hasArt = true;
                  const label = sourceTool === 'test_html_app' ? 'Post-click HTML runtime test' : 'Android Emulator Screenshot';
                  const shotMarkdown = `\n\n![${label}](/v1/workspace/files/${parsed.screenshotPath})\n\n`;
                  const shotChunk: UniversalStreamChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: shotMarkdown },
                        finish_reason: null,
                      },
                    ],
                  };
                  markStreamStarted();
                  recordedChunks.push(shotChunk);
                  yield shotChunk;
                }
              } catch {}
            }

            currentMessages = [
              ...currentMessages,
              {
                role: 'assistant',
                content: turnContent || '',
                tool_calls: toolCallsArray,
              },
              ...toolMessages,
            ];

            // Allow chaining tools up to maxTurns, only disabling image generation if art was already rendered
            const runtimeTestRequired = requestNeedsHtmlRuntimeTest(req, observedWrites, expectedFileTargets, rejectedWrites);
            const isPenultimateTurn = turnCount >= maxTurns - 1;
            const allDone = (
              allRequestedFilesVerified(expectedFileTargets, verifiedWrites)
              && htmlDependencyIssues(observedWrites, expectedFileTargets).length === 0
              && (!runtimeTestRequired || htmlRuntimeVerification.success)
            );
            currentTools = isPenultimateTurn || hasArt || allDone
              ? undefined
              : effectiveReq.tools;
            
            if (currentTools === undefined) {
              currentMessages.push({
                role: 'user',
                content: '[Task complete: All requested files and verifications are saved to disk. Please provide a clear, concise final summary of what was accomplished, how the application works, and how the user can interact with it.]',
              });
            }
          } else {
            // Finished without calling more tools or finished synthesis turn
            const dependencyIssues = htmlDependencyIssues(observedWrites, expectedFileTargets);
            if (fakeToolNames.length > 0 && fakeToolCorrectionAttempts < 1) {
              fakeToolCorrectionAttempts++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: turnContent || '' },
                { role: 'user', content: incompleteToolCorrection(fakeToolNames, dependencyIssues) },
              ];
              currentTools = effectiveReq.tools;
              continue;
            }
            if (dependencyIssues.length > 0 && dependencyCorrectionAttempts < 1) {
              dependencyCorrectionAttempts++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: turnContent || '' },
                { role: 'user', content: htmlDependencyCorrection(dependencyIssues) },
              ];
              currentTools = effectiveReq.tools;
              continue;
            }
            const runtimeTestRequired = requestNeedsHtmlRuntimeTest(req, observedWrites, expectedFileTargets, rejectedWrites);
            if (runtimeTestRequired && htmlRuntimeToolAvailable && !htmlRuntimeVerification.success && runtimeCorrectionAttempts < 1 && verifiedWrites.length === 0) {
              runtimeCorrectionAttempts++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: turnContent || '' },
                { role: 'user', content: htmlRuntimeCorrection(observedWrites, expectedFileTargets, htmlRuntimeVerification) },
              ];
              currentTools = effectiveReq.tools;
              continue;
            }
            const claimsFileCreatedInText = /(?:double-click\s*:|launch\s*:|created\s+|saved\s+to\s+|dist[\\/][\w.-]+|written\s+to\s+|output\s*:\s*`?[\w.-]+\.(?:exe|html|py|cpp))/i.test(turnContent);
            if ((fileWriteExpected || claimsFileCreatedInText) && fileToolsAvailable && verifiedWrites.length === 0 && fileCorrectionAttempts < 3) {
              fileCorrectionAttempts++;
              currentMessages = [
                ...currentMessages,
                { role: 'assistant', content: turnContent || '' },
                {
                  role: 'user',
                  content: fileVerificationCorrection(expectedFileTargets, rejectedWrites),
                },
              ];
              currentTools = effectiveReq.tools;
              continue;
            }

            // A missing write is only worth reporting if the files the model
            // named are genuinely absent. Real problems - a tool printed as text,
            // missing dependencies, a failed runtime test - still warn.
            const claimedFilesOnDisk = namedFilesPresentOnDisk(turnContent, ToolRegistry.getWorkspaceDir());
            const writeUnaccountedFor = verifiedWrites.length === 0 && claimedFilesOnDisk.length === 0;
            const suppressUnverifiedFileClaim = fileWriteExpected && (
              writeUnaccountedFor ||
              fakeToolNames.length > 0 ||
              dependencyIssues.length > 0 ||
              (runtimeTestRequired && htmlRuntimeToolAvailable && !htmlRuntimeVerification.success)
            );
            // Always release what the model produced. Withholding it destroyed
            // work the user could still use - often the full file contents in a
            // code block - and left only a warning on screen.
            for (const deferredChunk of deferredChunks) {
              markStreamStarted();
              recordedChunks.push(deferredChunk);
              yield deferredChunk;
            }

            if (suppressUnverifiedFileClaim) {
              const reason = fileToolsAvailable
                ? fakeToolNames.length > 0
                  ? `${fakeToolNames.join(', ')} was printed as text but never executed`
                  : dependencyIssues.length > 0
                    ? `local HTML dependencies are still missing: ${dependencyIssues.flatMap(issue => issue.missing).join(', ')}`
                    : runtimeTestRequired && htmlRuntimeToolAvailable && !htmlRuntimeVerification.success
                      ? `the post-click HTML runtime test has not passed (${htmlRuntimeVerification.detail})`
                    : rejectedWrites.at(-1)
                  ? `the file-tool result was incomplete (${rejectedWrites.at(-1)!.reason})`
                  : toolsExecuted.some(name => name === 'write_file' || name === 'patch_file')
                    ? 'a file tool ran but no successful result matched the requested target path'
                    : 'the model never called write_file or patch_file, so nothing was saved to disk'
                : 'workspace tools were disabled for this request';
              const warningChunk: UniversalStreamChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: { content: `⚠️ Incomplete artifact: ${reason}.` },
                  finish_reason: null,
                }],
              };
              markStreamStarted();
              recordedChunks.push(warningChunk);
              yield warningChunk;
            }

            if (!turnContent && toolsExecuted.length === 0 && recordedChunks.length === 0) {
              throw new AdapterError(
                `${provider}/${model} completed without returning content`,
                provider,
                502,
                true
              );
            }

            if (!turnContent && toolsExecuted.length > 0) {
              const fallbackNotice: UniversalStreamChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: `Successfully executed tools: ${toolsExecuted.join(', ')}.` },
                    finish_reason: null,
                  },
                ],
              };
              markStreamStarted();
              recordedChunks.push(fallbackNotice);
              yield fallbackNotice;
            }

            const fullGeneratedText = recordedChunks.map(c => c.choices?.[0]?.delta?.content || '').join('');
            const promptText = currentMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');
            const pTok = Math.max(1, Math.round(promptText.length / 3.8));
            const cTok = Math.max(1, Math.round((turnContent.length || fullGeneratedText.length) / 3.8));
            const streamUsage = accumulatedUsage && accumulatedUsage.total_tokens > 0 ? accumulatedUsage : {
              prompt_tokens: pTok,
              completion_tokens: cTok,
              total_tokens: pTok + cTok,
            };
            finalizeUsageCost(provider, streamUsage, calculateEstimatedCost(model, streamUsage));
            if (connection) this.connectionManager.recordUsage(connection.id, streamUsage);

            const compression = effectiveReq.metadata?.nexus_compression as RouteMetadata['compression'] | undefined;
            const decisionReasons = [
              `Intent classified as ${classification.category} (${Math.round(classification.complexityScore * 100)}% complexity).`,
              `Selected the first healthy candidate in the ${req.model} cascade.`,
              connection
                ? `Used connection "${connection.label}"; unavailable or exhausted keys were skipped.`
                : `Used the local ${provider} runtime without an API key.`,
              ...(provider === 'openrouter'
                ? [`OpenRouter routing mode: ${effectiveReq.openrouter_routing || 'balanced'}.`]
                : []),
            ];
            completedRouteInfo = {
              request_id: requestId,
              route_stage: 'completed',
              requested_model: req.model,
              selected_provider: provider,
              selected_model: model,
              selected_connection_id: connection?.id,
              selected_connection_label: connection?.label,
              routing_strategy: 'cascade',
              attempts,
              decision_reasons: decisionReasons,
              total_latency_ms: Date.now() - startTime,
              cached: false,
              classification,
              compression,
              tools_executed: toolsExecuted.length > 0 ? toolsExecuted : undefined,
              files_written: verifiedWrites.length > 0 ? verifiedWrites : undefined,
              turn_count: turnCount,
            };

            const stopChunk: UniversalStreamChunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
              usage: streamUsage,
              route_info: completedRouteInfo,
            };
            this.telemetryStore.record({ requestedModel: req.model, routeInfo: completedRouteInfo, usage: streamUsage });
            this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, success: true, durationMs: Date.now() - startTime, promptTokens: streamUsage.prompt_tokens, completionTokens: streamUsage.completion_tokens });
            recordedChunks.push(stopChunk);
            yield stopChunk;
            break;
          }
        }

        // The success path also leaves the loop and falls through here. Testing
        // the counter alone was not enough: finishing cleanly ON the final
        // allowed turn still tripped it. completedRouteInfo is set only when the
        // turn actually completed, so its absence is what marks exhaustion.
        if (turnCount >= maxTurns && !completedRouteInfo) {
        this.agentEventLog.record({
          requestId,
          sessionId: req.session_id,
          stage: 'route_failed',
          requestedModel: req.model,
          provider,
          model,
          connectionLabel: connection?.label,
          success: false,
          durationMs: Date.now() - attemptStart,
          error: `agent loop hit the ${maxTurns}-turn limit before finishing`,
        });
        const turnLimitNotice: UniversalStreamChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: `\n\n⚠️ Stopped after ${maxTurns} agent turns with the task unfinished. Raise NEXUS_MAX_AGENT_TURNS or ask me to continue.` },
            finish_reason: 'length',
          }],
        };
        markStreamStarted();
        recordedChunks.push(turnLimitNotice);
        yield turnLimitNotice;
        }

        // Cache the stream chunks
        if (recordedChunks.length > 0) {
          const fakeResponse: UniversalResponse = {
            id: recordedChunks[0]?.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: recordedChunks.map(c => c.choices?.[0]?.delta?.content || '').join(''),
                },
                finish_reason: 'stop',
              },
            ],
            usage: recordedChunks[recordedChunks.length - 1]?.usage || { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            route_info: completedRouteInfo,
          };
          this.cache.set(req, fakeResponse, recordedChunks);
        }

        return;
      } catch (err: unknown) {
        const latency = Date.now() - attemptStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        const statusCode = err instanceof AdapterError ? err.statusCode : 500;
        if (!firstRouteFailure) firstRouteFailure = { provider, model, message: errMsg };
        if (statusCode === 408) timedOutCandidates.add(identity);
        if (connection) this.connectionManager.recordFailure(
          connection.id,
          statusCode,
          errMsg,
          err instanceof AdapterError ? err.retryAfterMs : undefined,
        );
        if (this.shouldTripProviderCircuit(provider)) this.circuitBreaker.recordFailure(provider, model);

        attempts.push({
          provider,
          model,
          connection_id: connection?.id,
          connection_label: connection?.label,
          status: 'failed',
          error: errMsg,
          latency_ms: latency,
        });
        this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'route_failed', requestedModel: req.model, provider, model, connectionLabel: connection?.label, success: false, durationMs: latency, error: errMsg });

        // If tokens were already sent to the client, abort cleanly instead of corrupting the stream with a second candidate
        if (hasYielded) {
          throw new AdapterError(
            `Streaming interrupted mid-stream on ${provider}/${model}: ${errMsg}`,
            provider,
            500,
            false
          );
        }
      }
    }

    this.telemetryStore.record({
      requestedModel: req.model,
      success: false,
      routeInfo: {
        request_id: requestId,
        route_stage: 'completed',
        requested_model: req.model,
        selected_provider: 'none',
        selected_model: 'none',
        routing_strategy: 'cascade',
        attempts,
        total_latency_ms: Date.now() - startTime,
        decision_reasons: ['Every eligible streaming route candidate failed or had no usable connection.'],
      },
    });
    this.agentEventLog.record({ requestId, sessionId: req.session_id, stage: 'request_completed', requestedModel: req.model, success: false, durationMs: Date.now() - startTime, error: 'Every eligible streaming route candidate failed.' });
    const failureProvider = firstRouteFailure?.provider
      || routeCandidates.find(candidate => candidate.provider !== 'mock')?.provider
      || 'mock';
    const failureDetail = firstRouteFailure
      ? ` Primary failure on ${firstRouteFailure.provider}/${firstRouteFailure.model}: ${withoutAdapterPrefix(firstRouteFailure.message).slice(0, 500)}`
      : '';
    throw new AdapterError(
      `All streaming route candidates failed for model "${req.model}".${failureDetail}`,
      failureProvider,
      502,
      false
    );
  }
}
