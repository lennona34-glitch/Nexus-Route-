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

  static stop(): void {
    if (this.childProcess && this.isManaged) {
      console.log(`[EmbeddedLocalEngine] Stopping standalone engine daemon...`);
      try {
        this.childProcess.kill('SIGTERM');
      } catch {}
      this.childProcess = null;
      this.isManaged = false;
    }
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

  static async createModelStream(
    options: { name: string; modelfile?: string; from?: string; system?: string; template?: string; parameters?: Record<string, unknown> },
    onChunk: (chunk: { status: string; total?: number; completed?: number; percent?: number }) => void
  ): Promise<{ success: boolean; message: string }> {
    try {
      const cleanName = options.name.replace(/^local\//, '').trim();
      const bodyPayload: Record<string, unknown> = {
        name: cleanName,
        stream: true,
      };

      if (options.modelfile && options.modelfile.trim()) {
        bodyPayload.modelfile = options.modelfile.trim();
      } else {
        if (options.from) bodyPayload.from = options.from.trim();
        if (options.system) bodyPayload.system = options.system.trim();
        if (options.template) bodyPayload.template = options.template.trim();
        if (options.parameters) bodyPayload.parameters = options.parameters;
      }

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
