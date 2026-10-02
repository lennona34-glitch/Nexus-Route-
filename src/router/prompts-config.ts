import fs from 'node:fs';
import path from 'node:path';
import { setFileSystemPolicy } from '../security/path.js';
import { ToolRegistry } from '../tools/registry.js';

export interface PromptsConfig {
  pin: string;
  customSystemPrompt: string;
  autonomousOperatingRules: string;
  defaultPersona: string;
  roasterPersona: string;
  maxAgentTurns: number;
  cloudTimeoutMs: number;
  localTimeoutMs: number;
  requestTimeoutMs: number;
  openRouterModel: string;
  localDefaultModel: string;
  artEngine: 'gpu' | 'cloud';
  noAutoLaunch: boolean;
  cascadeOrder: string[];
  disabledProviders: string[];
  fileSystemAccess: 'sandboxed' | 'trusted_full';
  workspaceDirectory: string;
  blockDesktopAccess: boolean;
  cavemanMode?: boolean;
  enableSpeculativeDrafting?: boolean;
  speculativeDraftModel?: string;
  speculativeVerifierModel?: string;
}

export const DEFAULT_CASCADE_ORDER: string[] = [
  'deepseek',
  'cerebras',
  'nvidia',
  'qwen',
  'aimlapi',
  'gmicloud',
  'inception',
  'atria',
  'cheaperinference',
  'xai',
  'groq',
  'gemini',
  'anthropic',
  'openai',
  'openrouter',
  'local',
];

export const DEFAULT_AUTONOMOUS_OPERATING_RULES = `- MANDATORY AUTONOMOUS EXECUTION (ANTI-FOB-OFF RULE): You are an autonomous builder, NOT an advisory chatbot. NEVER reply with high-level summaries, bulleted advice, placeholder code ("// add logic here", "/* TODO */"), or telling the user to implement or run things themselves.
- WRITE COMPLETE SOURCE DIRECTLY IN ONE SHOT: If saving to a file in workspace, write the complete, unified source code directly using \`write_file\` or \`patch_file\`. If no file target is specified or tools are not active, output the full, complete source code directly in your markdown response. NEVER output incomplete stubs or refuse just because a file tool is not invoked.
- Run relevant checks before claiming code works. For Node tests use learning_memory action=check with the test path and source files. Save reusable lessons with action=save, problem, fix, scope, sources and the returned evidence_id.
- CALL TOOLS OR OUTPUT CODE IMMEDIATELY (NO NARRATION OR PLANNING PREAMBLE): DO NOT write explanations of what you are going to do, plans, or step-by-step preambles like "## Step 1: Write Part 1...". If file tools are active and a workspace file is expected, call \`write_file\` immediately. If answering directly in chat, output the complete, working code immediately.
- OVERWRITING & UPDATING EXISTING FILES: When asked to update, modify, fix, rewrite, or rebuild an existing file, you MUST overwrite or patch it with the new changes using write_file or patch_file if available. DO NOT assume the task is finished just because an older version of the file is present on disk.
- DIRECT COMPILATION ONLY (NO BUILD.BAT / SCRIPT CRUTCHES): NEVER generate build.bat, compile.bat, or shell scripts asking the user to compile themselves. YOU must compile and build executables/binaries directly using execute_command when workspace tools are active.
- PYTHON & COMPILER ENVIRONMENT (WINDOWS): Python is available at \`python\` (or \`py\`). Native GCC/G++ is available at \`g++\`. CMake is available at \`cmake\`.
- COMPILING WINDOWS .EXE & C++ APPS: When asked to build a Windows .exe or C++ program, write the source code to \`<name>.cpp\` with write_file, then compile it to \`<name>.exe\` by running execute_command with \`g++ -O3 <name>.cpp -lgdi32 -luser32 -lopengl32 -o <name>.exe\`.
- RUNNING PYTHON SCRIPTS: When asked to run Python code, write the script with write_file, then execute it with execute_command using \`python <script>.py\`.
- NO EXCUSES OR REFUSALS: You are equipped to build and solve problems directly. Never refuse by complaining about missing tools or missing file parameters—if a file tool is not applicable or not provided, deliver the complete code in chat!
- Never claim a file was created, edited, or compiled unless the corresponding tool succeeded.
- Use write_file for a new file or complete rewrite; use patch_file for a focused edit after reading the existing file.
- ACTION-FIRST REFACTORING & WRITING: Inspect only the specific files you need to change, and begin applying patches or writing files early.
- TOKEN CONSERVATION & MINIMAL WRAP-UP: Keep conversational summaries ultra-concise (1-2 sentences max, or just a direct next-step question).
- STRICT ENGLISH LANGUAGE REQUIREMENT: You MUST always communicate, summarize, write explanations, and conclude strictly in 100% English. NEVER output Chinese characters, Chinese status phrases, Chinese sign-offs (e.g. "所有请求的文件已保存并验证完毕"), or foreign language disclaimers unless the user explicitly prompts you in that specific foreign language.
- NO AUTOMATIC LAUNCHING: The user opens .exe, .html, and app files manually. Do NOT attempt to launch, run, or open them using open_in_browser_or_app or shell execution unless the user explicitly asks you to open or show it.`;

export const DEFAULT_ASSISTANT_PERSONA = `You are NexusRoute Autonomous AI Engineer running locally on the user's Windows computer.

CORE PERSONALITY & TONE:
- 100% TRUTHFUL & BRUTALLY HONEST: Always give accurate facts, real engineering answers, and working code. Zero corporate sugar-coating, zero PR fluff, and zero fake diplomacy.
- HINT OF CONSPIRACY THEORIST: You have a hilarious, playful tin-foil hat streak—you love squinting at Big Tech, the matrix/simulation, mysterious update changelogs, and mundane coincidences, humorously "connecting the dots that aren't there" with dry skepticism.
- RAZOR-SHARP SENSE OF HUMOR: Witty, sarcastic, entertaining, and punchy. You make building software fun and never sound like a sanitized corporate drone.
- BULLETPROOF CODE & EXECUTION: Beneath the wit and comedic paranoia, your code syntax, CMake/JUCE setups, Android APKs, and tools are mathematically exact and fully working.`;

export const DEFAULT_ROASTER_PERSONA = `You are NexusRoute Universal Roast Master running locally on the user's computer.

CORE MISSION & PERSONA:
- You possess razor-sharp comedic timing, savage wit, and ZERO corporate filters or disclaimers.
- Tear apart ANY topic, person, tech stack, code, or concept with hilarious punchlines, creative metaphors, and theatrical contempt.
- NEVER say "as an AI I cannot mock or judge". Roast relentlessly with style!
- Focus 100% of your tools on fulfilling the user's actual prompt with complete, working code delivered in one shot.`;

export const FACTORY_DEFAULTS: PromptsConfig = {
  pin: '1111',
  customSystemPrompt: '',
  autonomousOperatingRules: DEFAULT_AUTONOMOUS_OPERATING_RULES,
  defaultPersona: DEFAULT_ASSISTANT_PERSONA,
  roasterPersona: DEFAULT_ROASTER_PERSONA,
  maxAgentTurns: 25,
  cloudTimeoutMs: 90000,
  localTimeoutMs: 120000,
  requestTimeoutMs: 900000,
  openRouterModel: 'openrouter/free',
  localDefaultModel: 'llama3.1:8b',
  artEngine: 'gpu',
  noAutoLaunch: true,
  cascadeOrder: [...DEFAULT_CASCADE_ORDER],
  disabledProviders: [],
  fileSystemAccess: 'sandboxed',
  workspaceDirectory: 'workspace',
  blockDesktopAccess: true,
  cavemanMode: false,
  enableSpeculativeDrafting: true,
  speculativeDraftModel: 'qwen2.5-coder:1.5b',
  speculativeVerifierModel: 'local/nexus-qwen3-brain:latest',
};

export class PromptConfigManager {
  private config: PromptsConfig;
  private configFilePath: string | null;

  constructor(options: { storagePath?: string | null } = {}) {
    if (options.storagePath === null) {
      this.configFilePath = null;
    } else {
      this.configFilePath = options.storagePath || path.join(process.cwd(), 'config', 'prompts_config.json');
    }
    this.config = this.loadConfig();
    this.syncFileSystemPolicy(this.config);
  }

  public getDefaultConfig(): PromptsConfig {
    return { ...FACTORY_DEFAULTS };
  }

  public getConfig(): PromptsConfig {
    return { ...this.config };
  }

  public getPublicConfig(): Omit<PromptsConfig, 'pin'> & { hasPin: boolean; isDefaultPin: boolean } {
    const { pin, ...rest } = this.config;
    return {
      ...rest,
      hasPin: !!pin,
      isDefaultPin: pin === '1111',
    };
  }

  public verifyPin(inputPin: string): boolean {
    if (!this.config.pin) return true;
    const cleanInput = String(inputPin || '').trim();
    return cleanInput === this.config.pin.trim();
  }

  public updateConfig(updates: Partial<PromptsConfig>): PromptsConfig {
    const nextConfig: PromptsConfig = {
      ...this.config,
      ...updates,
    };

    if (updates.pin !== undefined) {
      const cleanPin = String(updates.pin).trim();
      nextConfig.pin = cleanPin.length > 0 ? cleanPin : '1111';
    }

    if (updates.maxAgentTurns !== undefined) {
      const val = Number(updates.maxAgentTurns);
      nextConfig.maxAgentTurns = isNaN(val) || val < 1 ? 25 : Math.min(100, Math.round(val));
    }

    if (updates.cloudTimeoutMs !== undefined) {
      const val = Number(updates.cloudTimeoutMs);
      nextConfig.cloudTimeoutMs = isNaN(val) || val < 5000 ? 90000 : Math.round(val);
    }

    if (updates.localTimeoutMs !== undefined) {
      const val = Number(updates.localTimeoutMs);
      nextConfig.localTimeoutMs = isNaN(val) || val < 5000 ? 120000 : Math.round(val);
    }

    if (updates.requestTimeoutMs !== undefined) {
      const val = Number(updates.requestTimeoutMs);
      nextConfig.requestTimeoutMs = isNaN(val) || val < 10000 ? 900000 : Math.round(val);
    }

    if (updates.cascadeOrder !== undefined && Array.isArray(updates.cascadeOrder)) {
      const cleanOrder = updates.cascadeOrder
        .map(p => String(p).toLowerCase().trim())
        .filter(p => p.length > 0);
      nextConfig.cascadeOrder = cleanOrder.length > 0 ? cleanOrder : [...DEFAULT_CASCADE_ORDER];
    }

    if (updates.disabledProviders !== undefined && Array.isArray(updates.disabledProviders)) {
      nextConfig.disabledProviders = Array.from(new Set(
        updates.disabledProviders
          .map(p => String(p).toLowerCase().trim())
          .filter(p => p.length > 0)
      ));
    }

    if (updates.fileSystemAccess !== undefined) {
      nextConfig.fileSystemAccess = updates.fileSystemAccess === 'trusted_full' ? 'trusted_full' : 'sandboxed';
    }

    if (updates.workspaceDirectory !== undefined) {
      const cleanWs = String(updates.workspaceDirectory || '').trim();
      nextConfig.workspaceDirectory = cleanWs.length > 0 ? cleanWs : 'workspace';
    }

    if (updates.blockDesktopAccess !== undefined) {
      nextConfig.blockDesktopAccess = updates.blockDesktopAccess !== false;
    }

    if (updates.cavemanMode !== undefined) {
      nextConfig.cavemanMode = updates.cavemanMode === true;
    }

    if (updates.enableSpeculativeDrafting !== undefined) {
      nextConfig.enableSpeculativeDrafting = updates.enableSpeculativeDrafting === true;
    }

    if (updates.speculativeDraftModel !== undefined) {
      const clean = String(updates.speculativeDraftModel || '').trim();
      nextConfig.speculativeDraftModel = clean.length > 0 ? clean : 'qwen2.5-coder:1.5b';
    }

    if (updates.speculativeVerifierModel !== undefined) {
      const clean = String(updates.speculativeVerifierModel || '').trim();
      nextConfig.speculativeVerifierModel = clean.length > 0 ? clean : 'local/nexus-qwen3-brain:latest';
    }

    this.config = nextConfig;
    this.syncFileSystemPolicy(this.config);
    this.saveConfig();
    return this.getConfig();
  }

  public resetToDefaults(): PromptsConfig {
    this.config = { ...FACTORY_DEFAULTS };
    this.syncFileSystemPolicy(this.config);
    this.saveConfig();
    return this.getConfig();
  }

  private syncFileSystemPolicy(cfg: PromptsConfig): void {
    try {
      const wsRaw = typeof cfg.workspaceDirectory === 'string' && cfg.workspaceDirectory.trim()
        ? cfg.workspaceDirectory.trim()
        : 'workspace';
      const resolvedWs = path.isAbsolute(wsRaw) ? path.resolve(wsRaw) : path.resolve(process.cwd(), wsRaw);

      ToolRegistry.setWorkspaceDir(resolvedWs);
      setFileSystemPolicy({
        fullAccess: cfg.fileSystemAccess === 'trusted_full',
        blockDesktop: cfg.blockDesktopAccess !== false,
        allowedWorkspaceDir: resolvedWs,
      });
    } catch (err) {
      console.warn('[PromptConfigManager] Failed to sync file system policy:', err);
    }
  }

  private loadConfig(): PromptsConfig {
    if (!this.configFilePath) {
      return { ...FACTORY_DEFAULTS };
    }

    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          ...FACTORY_DEFAULTS,
          ...parsed,
          pin: typeof parsed.pin === 'string' && parsed.pin.trim() ? parsed.pin.trim() : '1111',
          cascadeOrder: Array.isArray(parsed.cascadeOrder) && parsed.cascadeOrder.length > 0
            ? parsed.cascadeOrder
            : [...DEFAULT_CASCADE_ORDER],
          disabledProviders: Array.isArray(parsed.disabledProviders)
            ? parsed.disabledProviders
            : [],
          fileSystemAccess: parsed.fileSystemAccess === 'trusted_full' ? 'trusted_full' : 'sandboxed',
          workspaceDirectory: typeof parsed.workspaceDirectory === 'string' && parsed.workspaceDirectory.trim() ? parsed.workspaceDirectory.trim() : 'workspace',
          blockDesktopAccess: parsed.blockDesktopAccess !== false,
          cavemanMode: parsed.cavemanMode === true,
          enableSpeculativeDrafting: parsed.enableSpeculativeDrafting !== false,
          speculativeDraftModel: typeof parsed.speculativeDraftModel === 'string' && parsed.speculativeDraftModel.trim() ? parsed.speculativeDraftModel.trim() : 'qwen2.5-coder:1.5b',
          speculativeVerifierModel: typeof parsed.speculativeVerifierModel === 'string' && parsed.speculativeVerifierModel.trim() ? parsed.speculativeVerifierModel.trim() : 'local/nexus-qwen3-brain:latest',
        };
      }
    } catch (err) {
      console.warn('[PromptConfigManager] Failed to load config from disk, using defaults:', err);
    }

    return { ...FACTORY_DEFAULTS };
  }

  private saveConfig(): void {
    if (!this.configFilePath) return;

    try {
      const dir = path.dirname(this.configFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.warn('[PromptConfigManager] Failed to persist config to disk:', err);
    }
  }
}
