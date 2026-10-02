import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

export interface LocalModelInfo {
  name: string;
  modified_at: string;
  size: number;
  sizeFormatted: string;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface EngineStatus {
  running: boolean;
  embedded: boolean;
  host: string;
  port: number;
  version?: string;
  modelsPath: string;
  modelsCount: number;
  models: LocalModelInfo[];
  gpuDetected: boolean;
  gpuName?: string;
  error?: string;
}

export class EmbeddedLocalEngine {
  private static childProcess: ChildProcess | null = null;
  private static host = '127.0.0.1';
  private static port = 11434;
  private static isManaged = false;
  private static modelsDir: string = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');

  static getBinaryPath(): string | null {
    const localBin = path.join(process.cwd(), 'bin', 'engine', 'ollama.exe');
    if (fs.existsSync(localBin)) return localBin;

    const appDataBin = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(appDataBin)) return appDataBin;

    const progFilesBin = 'C:\\Program Files\\Ollama\\ollama.exe';
    if (fs.existsSync(progFilesBin)) return progFilesBin;

    return null;
  }

  static getModelsDirectory(): string {
    if (!fs.existsSync(this.modelsDir)) {
      try { fs.mkdirSync(this.modelsDir, { recursive: true }); } catch {}
    }
    return this.modelsDir;
  }

  static async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/api/version`, {
        signal: AbortSignal.timeout(1200),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static async start(): Promise<boolean> {
    // 1. Check if already running on target port
    if (await this.isRunning()) {
      console.log(`[EmbeddedLocalEngine] Local AI engine already active on http://${this.host}:${this.port}`);
      return true;
    }

    const bin = this.getBinaryPath();
    if (!bin) {
      console.warn(`[EmbeddedLocalEngine] No portable engine binary found in bin/engine or system paths.`);
      return false;
    }

    this.cleanOrphanedLlamaServers();

    const modelsPath = this.getModelsDirectory();
    console.log(`[EmbeddedLocalEngine] Launching standalone engine daemon from ${bin}...`);
    console.log(`[EmbeddedLocalEngine] Using persistent models store at: ${modelsPath}`);

    const env = {
      ...process.env,
      OLLAMA_HOST: `${this.host}:${this.port}`,
      OLLAMA_MODELS: modelsPath,
      OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '2',
      OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS || '2',
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '15m',
      CUDA_VISIBLE_DEVICES: '0',
    };

    try {
      this.childProcess = spawn(bin, ['serve'], {
        env,
        stdio: 'ignore',
        detached: false,
        windowsHide: true,
      });

      this.isManaged = true;

      this.childProcess.on('error', (err) => {
        console.error(`[EmbeddedLocalEngine] Engine process error:`, err.message);
      });

      this.childProcess.on('exit', (code, signal) => {
        console.log(`[EmbeddedLocalEngine] Engine process exited with code ${code}, signal ${signal}`);
        this.childProcess = null;
        this.isManaged = false;
      });

      // Poll until ready (up to 15 seconds)
      const startT = Date.now();
      while (Date.now() - startT < 15000) {
        await new Promise(r => setTimeout(r, 600));
        if (await this.isRunning()) {
          console.log(`[EmbeddedLocalEngine] 🚀 Standalone Local AI Engine is ready on http://${this.host}:${this.port}!`);
          return true;
        }
      }

      console.warn(`[EmbeddedLocalEngine] Engine daemon started but did not respond to healthcheck within 15s.`);
      return false;
    } catch (err: any) {
      console.error(`[EmbeddedLocalEngine] Failed to launch engine:`, err.message);
      return false;
    }
  }

  static cleanOrphanedLlamaServers(): void {
    if (process.platform === 'win32') {
      try {
        spawn('powershell', [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" | ForEach-Object {
            $p = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue
            if (-not $p -or $p.ProcessName -ne 'ollama') {
              Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
          }`
        ], { stdio: 'ignore', windowsHide: true });
      } catch {}
    }
  }

  static stop(): void {
    if (this.childProcess && this.isManaged) {
      console.log(`[EmbeddedLocalEngine] Stopping standalone engine daemon...`);
      const pid = this.childProcess.pid;
      try {
        if (process.platform === 'win32' && pid) {
          spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], { stdio: 'ignore', windowsHide: true });
        } else {
          this.childProcess.kill('SIGTERM');
        }
      } catch {}
      this.childProcess = null;
      this.isManaged = false;
    }
    this.cleanOrphanedLlamaServers();
  }

  static formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  static async listModels(): Promise<LocalModelInfo[]> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/api/tags`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { models?: Array<any> };
      const raw = data.models || [];
      return raw.map(m => ({
        name: m.name || m.model,
        modified_at: m.modified_at,
        size: m.size || 0,
        sizeFormatted: this.formatBytes(m.size || 0),
        digest: m.digest || '',
        details: m.details,
      }));
    } catch {
      return [];
    }
  }

  static async getStatus(): Promise<EngineStatus> {
    const running = await this.isRunning();
    let version: string | undefined;
    let models: LocalModelInfo[] = [];

    if (running) {
      try {
        const vRes = await fetch(`http://${this.host}:${this.port}/api/version`, { signal: AbortSignal.timeout(1500) });
        if (vRes.ok) {
          const vData = await vRes.json() as { version?: string };
          version = vData.version;
        }
      } catch {}
      models = await this.listModels();
    }

    const binPath = this.getBinaryPath();
    const isEmbedded = !!(binPath && binPath.includes('bin\\engine'));

    return {
      running,
      embedded: isEmbedded,
      host: this.host,
      port: this.port,
      version: version || (running ? 'Active' : undefined),
      modelsPath: this.getModelsDirectory(),
      modelsCount: models.length,
      models,
      gpuDetected: true,
      gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU (8GB VRAM)',
    };
  }

  static async deleteModel(modelName: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        return { success: true, message: `Successfully deleted local model "${modelName}".` };
      }
      const errText = await res.text();
      return { success: false, message: `Failed to delete model: ${errText}` };
    } catch (err: any) {
      return { success: false, message: `Error deleting model: ${err.message}` };
    }
  }

  static async pullModelStream(
    modelName: string,
    onChunk: (chunk: { status: string; digest?: string; total?: number; completed?: number; percent?: number }) => void
  ): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `Failed to start model pull: ${err}` };
      }

      if (!res.body) {
        return { success: false, message: `No stream received from engine daemon.` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              return { success: false, message: parsed.error };
            }
            let percent: number | undefined;
            if (parsed.total && parsed.completed) {
              percent = Math.min(100, Math.round((parsed.completed / parsed.total) * 100));
            }
            onChunk({
              status: parsed.status || 'downloading',
              digest: parsed.digest,
              total: parsed.total,
              completed: parsed.completed,
              percent,
            });
          } catch {}
        }
      }

      return { success: true, message: `Successfully downloaded and installed "${modelName}"!` };
    } catch (err: any) {
      return { success: false, message: `Error during model pull: ${err.message}` };
    }
  }

  static async showModel(modelName: string): Promise<{ success: boolean; modelfile?: string; system?: string; parameters?: string; template?: string; details?: any; error?: string }> {
    try {
      const cleanName = modelName.replace(/^local\//, '');
      const res = await fetch(`http://${this.host}:${this.port}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName }),
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { success: false, error: errText || `Failed to fetch model info: HTTP ${res.status}` };
      }

      const data = await res.json() as any;
      return {
        success: true,
        modelfile: data.modelfile || '',
        system: data.system || '',
        parameters: data.parameters || '',
        template: data.template || '',
        details: data.details,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  static parseModelfile(modelfileContent: string): {
    from?: string;
    system?: string;
    template?: string;
    parameters: Record<string, unknown>;
  } {
    const result: {
      from?: string;
      system?: string;
      template?: string;
      parameters: Record<string, unknown>;
    } = {
      parameters: {},
    };

    const lines = modelfileContent.split(/\r?\n/);
    let inSystemBlock = false;
    let systemBuffer: string[] = [];
    let inTemplateBlock = false;
    let templateBuffer: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (inSystemBlock) {
        if (line.includes('"""') || line.includes("'''")) {
          const quote = line.includes('"""') ? '"""' : "'''";
          const part = line.slice(0, line.indexOf(quote));
          if (part) systemBuffer.push(part);
          inSystemBlock = false;
          result.system = systemBuffer.join('\n').trim();
        } else {
          systemBuffer.push(line);
        }
        continue;
      }

      if (inTemplateBlock) {
        if (line.includes('"""') || line.includes("'''")) {
          const quote = line.includes('"""') ? '"""' : "'''";
          const part = line.slice(0, line.indexOf(quote));
          if (part) templateBuffer.push(part);
          inTemplateBlock = false;
          result.template = templateBuffer.join('\n').trim();
        } else {
          templateBuffer.push(line);
        }
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const fromMatch = trimmed.match(/^FROM\s+(.+)$/i);
      if (fromMatch) {
        result.from = fromMatch[1].trim().replace(/^["']|["']$/g, '');
        continue;
      }

      const systemTripleMatch = trimmed.match(/^SYSTEM\s+("""|''')([\s\S]*)$/i);
      if (systemTripleMatch) {
        const quote = systemTripleMatch[1];
        const rest = systemTripleMatch[2];
        if (rest.includes(quote)) {
          result.system = rest.slice(0, rest.indexOf(quote)).trim();
        } else {
          inSystemBlock = true;
          systemBuffer = [rest];
        }
        continue;
      }

      const systemSingleMatch = trimmed.match(/^SYSTEM\s+(.+)$/i);
      if (systemSingleMatch) {
        result.system = systemSingleMatch[1].trim().replace(/^["']|["']$/g, '');
        continue;
      }

      const templateTripleMatch = trimmed.match(/^TEMPLATE\s+("""|''')([\s\S]*)$/i);
      if (templateTripleMatch) {
        const quote = templateTripleMatch[1];
        const rest = templateTripleMatch[2];
        if (rest.includes(quote)) {
          result.template = rest.slice(0, rest.indexOf(quote)).trim();
        } else {
          inTemplateBlock = true;
          templateBuffer = [rest];
        }
        continue;
      }

      const templateSingleMatch = trimmed.match(/^TEMPLATE\s+(.+)$/i);
      if (templateSingleMatch) {
        result.template = templateSingleMatch[1].trim().replace(/^["']|["']$/g, '');
        continue;
      }

      const paramMatch = trimmed.match(/^PARAMETER\s+([a-zA-Z0-9_-]+)\s+(.+)$/i);
      if (paramMatch) {
        const paramKey = paramMatch[1].trim();
        const rawVal = paramMatch[2].trim().replace(/^["']|["']$/g, '');
        let parsedVal: unknown = rawVal;
        if (/^-?\d+$/.test(rawVal)) {
          parsedVal = parseInt(rawVal, 10);
        } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
          parsedVal = parseFloat(rawVal);
        } else if (rawVal.toLowerCase() === 'true') {
          parsedVal = true;
        } else if (rawVal.toLowerCase() === 'false') {
          parsedVal = false;
        }

        if (paramKey === 'stop') {
          if (!Array.isArray(result.parameters['stop'])) {
            result.parameters['stop'] = [];
          }
          (result.parameters['stop'] as string[]).push(rawVal);
        } else {
          result.parameters[paramKey] = parsedVal;
        }
        continue;
      }
    }

    if (inSystemBlock && systemBuffer.length > 0) {
      result.system = systemBuffer.join('\n').trim();
    }
    if (inTemplateBlock && templateBuffer.length > 0) {
      result.template = templateBuffer.join('\n').trim();
    }

    return result;
  }

  static sanitizeModelName(raw: string): string {
    if (!raw) return '';
    let clean = raw.trim()
      .replace(/[\s\t\r\n]+/g, '-')
      .replace(/[^a-zA-Z0-9_.:/-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^[:.-]+/, '')
      .replace(/[:.-]+$/, '');

    const colonParts = clean.split(':');
    if (colonParts.length > 2) {
      clean = colonParts.slice(0, -1).join('-') + ':' + colonParts[colonParts.length - 1];
    }
    return clean;
  }

  static async createModelFromGgufFile(
    cleanName: string,
    ggufPath: string,
    options: { system?: string; template?: string; parameters?: Record<string, unknown> },
    onChunk: (chunk: { status: string; total?: number; completed?: number; percent?: number }) => void
  ): Promise<{ success: boolean; message: string }> {
    const binPath = this.getBinaryPath();
    if (!binPath || !fs.existsSync(binPath)) {
      return { success: false, message: `Engine binary not found at ${binPath}` };
    }

    const tmpDir = path.join(process.cwd(), 'workspace', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpModelfile = path.join(tmpDir, `Modelfile_${Date.now()}`);

    try {
      let mfContent = `FROM "${ggufPath.replace(/\\/g, '/')}"\n`;
      const system = (options.system || '').trim();
      if (system) {
        mfContent += `SYSTEM """${system}"""\n`;
      }
      const template = (options.template || '').trim();
      if (template) {
        mfContent += `TEMPLATE """${template}"""\n`;
      }
      if (options.parameters) {
        for (const [k, v] of Object.entries(options.parameters)) {
          if (Array.isArray(v)) {
            for (const item of v) mfContent += `PARAMETER ${k} "${item}"\n`;
          } else {
            mfContent += `PARAMETER ${k} ${v}\n`;
          }
        }
      }
      fs.writeFileSync(tmpModelfile, mfContent, 'utf-8');

      return new Promise((resolve) => {
        const proc = spawn(binPath, ['create', cleanName, '-f', tmpModelfile], {
          env: { ...process.env, OLLAMA_HOST: `${this.host}:${this.port}` },
        });

        let stderr = '';
        const handleData = (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              onChunk({ status: trimmed });
            }
          }
        };

        proc.stdout.on('data', handleData);
        proc.stderr.on('data', handleData);

        proc.on('close', (code) => {
          try {
            if (fs.existsSync(tmpModelfile)) fs.unlinkSync(tmpModelfile);
          } catch {}

          if (code === 0) {
            resolve({ success: true, message: `Successfully built and registered model "${cleanName}" from local GGUF!` });
          } else {
            resolve({ success: false, message: `GGUF build failed: ${stderr.slice(-300)}` });
          }
        });

        proc.on('error', (err) => {
          try {
            if (fs.existsSync(tmpModelfile)) fs.unlinkSync(tmpModelfile);
          } catch {}
          resolve({ success: false, message: `Failed to spawn engine CLI: ${err.message}` });
        });
      });
    } catch (err: any) {
      try {
        if (fs.existsSync(tmpModelfile)) fs.unlinkSync(tmpModelfile);
      } catch {}
      return { success: false, message: `Error creating model from GGUF: ${err.message}` };
    }
  }

  static async createModelStream(
    options: { name: string; modelfile?: string; from?: string; system?: string; template?: string; parameters?: Record<string, unknown> },
    onChunk: (chunk: { status: string; total?: number; completed?: number; percent?: number }) => void
  ): Promise<{ success: boolean; message: string }> {
    try {
      let cleanName = (options.name || '').replace(/^local\//, '').trim();
      cleanName = this.sanitizeModelName(cleanName);
      if (!cleanName) {
        return { success: false, message: 'Target model name is required and must contain alphanumeric characters (e.g. "my-custom-model").' };
      }

      let parsedMf: { from?: string; system?: string; template?: string; parameters: Record<string, unknown> } = { parameters: {} };
      if (options.modelfile && options.modelfile.trim()) {
        parsedMf = this.parseModelfile(options.modelfile.trim());
      }

      const rawFrom = (options.from || parsedMf.from || '').trim();
      let cleanFrom = rawFrom.replace(/^local\//, '').trim();
      if (!cleanFrom) {
        return { success: false, message: 'Base model (FROM) is required to build a model.' };
      }

      if (cleanFrom.includes('custom-weights.gguf') || cleanFrom.includes('path/to') || cleanFrom.includes('path\\to')) {
        return { success: false, message: 'Please provide a valid, existing .gguf file path or choose an installed model instead of the example placeholder.' };
      }

      const effectiveSystem = (options.system !== undefined && options.system !== '' ? options.system : parsedMf.system || '').trim();
      let effectiveTemplate = (options.template !== undefined && options.template !== '' ? options.template : parsedMf.template || '').trim();
      if (!effectiveTemplate && cleanFrom.toLowerCase().includes('starcoder')) {
        effectiveTemplate = '{{- if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ if .Prompt }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n{{ end }}<|im_start|>assistant\n{{ .Response }}<|im_end|>';
      }

      const effectiveParameters: Record<string, unknown> = {
        ...parsedMf.parameters,
        ...(options.parameters || {}),
      };

      if (!effectiveParameters.stop) {
        effectiveParameters.stop = ['<|im_start|>', '<|im_end|>', '<|end_of_text|>'];
      } else if (Array.isArray(effectiveParameters.stop)) {
        if (!effectiveParameters.stop.includes('<|end_of_text|>')) {
          effectiveParameters.stop.push('<|end_of_text|>');
        }
      }
      if (effectiveParameters.repeat_penalty === undefined) {
        effectiveParameters.repeat_penalty = 1.15;
      }

      const isFilePath = cleanFrom.endsWith('.gguf') || cleanFrom.endsWith('.bin') || cleanFrom.includes('\\') || (cleanFrom.includes('/') && !cleanFrom.includes(':') && !cleanFrom.startsWith('hf.co/'));

      if (isFilePath) {
        if (!fs.existsSync(cleanFrom)) {
          return { success: false, message: `Base GGUF file not found: "${cleanFrom}". Please verify the file path exists on your computer or choose an installed model from the dropdown.` };
        }
        return this.createModelFromGgufFile(cleanName, cleanFrom, {
          system: effectiveSystem,
          template: effectiveTemplate,
          parameters: effectiveParameters,
        }, onChunk);
      }

      const bodyPayload: Record<string, unknown> = {
        name: cleanName,
        from: cleanFrom,
        stream: true,
      };

      if (effectiveSystem) bodyPayload.system = effectiveSystem;
      if (effectiveTemplate) bodyPayload.template = effectiveTemplate;
      if (Object.keys(effectiveParameters).length > 0) bodyPayload.parameters = effectiveParameters;
      if (options.modelfile && options.modelfile.trim()) bodyPayload.modelfile = options.modelfile.trim();

      const res = await fetch(`http://${this.host}:${this.port}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `Failed to build model: ${err}` };
      }

      if (!res.body) {
        return { success: false, message: `No response stream received from engine daemon.` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              return { success: false, message: parsed.error };
            }
            let percent: number | undefined;
            if (parsed.total && parsed.completed) {
              percent = Math.min(100, Math.round((parsed.completed / parsed.total) * 100));
            }
            onChunk({
              status: parsed.status || 'building layer',
              total: parsed.total,
              completed: parsed.completed,
              percent,
            });
          } catch {}
        }
      }

      return { success: true, message: `Successfully built and registered model "${cleanName}"!` };
    } catch (err: any) {
      return { success: false, message: `Error during model creation: ${err.message}` };
    }
  }
}
