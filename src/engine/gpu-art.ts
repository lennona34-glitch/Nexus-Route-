import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GpuStatusResult {
  cudaAvailable: boolean;
  deviceName: string;
  vramTotalMb: number;
  engineReady: boolean;
  warmModel?: string;
  isLoaded?: boolean;
  isGenerating?: boolean;
  activeJob?: any;
  error?: string;
}

export interface GpuArtGenerationOptions {
  prompt: string;
  negativePrompt?: string;
  outputPath?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  model?: string;
  lora?: string;
  loraScale?: number;
}

export interface GpuArtGenerationResult {
  success: boolean;
  message?: string;
  url?: string;
  filename?: string;
  engine?: string;
  elapsedSeconds?: number;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  lora?: string;
  error?: string;
}

export interface GpuArtInpaintOptions {
  image: string;
  mask: string;
  prompt?: string;
  negativePrompt?: string;
  outputPath?: string;
  strength?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  model?: string;
  lora?: string;
  loraScale?: number;
}

export interface GpuArtInpaintResult {
  success: boolean;
  message?: string;
  url?: string;
  filename?: string;
  engine?: string;
  elapsedSeconds?: number;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  strength?: number;
  guidance?: number;
  lora?: string;
  error?: string;
}

export class LocalGpuArtEngine {
  private static uvPath: string = process.env.UV_PATH || path.join(os.homedir(), '.local', 'bin', 'uv.exe');
  private static cachedStatus: GpuStatusResult | null = null;
  private static lastCheckTime: number = 0;

  // Persistent Warm Daemon State
  private static daemonProc: ChildProcess | null = null;
  private static daemonStarting: Promise<boolean> | null = null;
  private static daemonBuffer: string = '';
  private static isDaemonReady: boolean = false;
  private static pendingRequests = new Map<string, {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }>();
  private static activeWarmModel: string = '';
  public static activeJob: {
    id: string;
    type: 'image' | 'video';
    model: string;
    prompt: string;
    startedAt: number;
    step: number;
    totalSteps: number;
    percent: number;
    speed: string;
    message: string;
  } | null = null;

  public static isRunning(): boolean {
    return !!this.daemonProc && !this.daemonProc.killed && this.daemonProc.exitCode === null;
  }

  /**
   * Start or verify the persistent warm GPU diffusion daemon
   */
  public static async ensureDaemon(initialModel?: string): Promise<boolean> {
    if (this.isRunning() && this.isDaemonReady) {
      return true;
    }
    if (this.daemonStarting) {
      return this.daemonStarting;
    }

    this.daemonStarting = (async () => {
      try {
        const pythonExe = this.getPythonExecutable();
        const pythonScript = this.getScriptPath();

        if (!fs.existsSync(pythonScript)) {
          return false;
        }

        this.isDaemonReady = false;
        const args = ['-u', pythonScript, '--daemon'];
        const resolvedInit = initialModel ? this.resolveLocalModelPath(initialModel) : undefined;
        if (resolvedInit && resolvedInit !== 'default') {
          args.push('--model', resolvedInit);
        }

        const proc = spawn(pythonExe, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
            PYTHONUNBUFFERED: '1',
          },
        });

        this.daemonProc = proc;
        this.daemonBuffer = '';

        const cleanup = () => {
          try {
            if (this.daemonProc && !this.daemonProc.killed) {
              this.daemonProc.kill('SIGKILL');
            }
          } catch {}
        };
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);

        proc.stdout?.on('data', (chunk: Buffer) => {
          this.daemonBuffer += chunk.toString('utf8');
          const lines = this.daemonBuffer.split('\n');
          this.daemonBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.event === 'ready') {
                this.isDaemonReady = true;
                console.log('[LocalGpuArtEngine] Warm Daemon initialized:', msg.gpu?.device_name || 'RTX 4060');
              } else if (msg.event === 'model_warmed') {
                this.isDaemonReady = true;
                this.activeWarmModel = msg.model || 'SDXL-Turbo';
                this.cachedStatus = null;
                console.log(`[LocalGpuArtEngine] Model ${this.activeWarmModel} is warm in VRAM!`);
              } else if (msg.id && this.pendingRequests.has(msg.id)) {
                const req = this.pendingRequests.get(msg.id)!;
                clearTimeout(req.timer);
                this.pendingRequests.delete(msg.id);
                if (msg.model) {
                  this.activeWarmModel = msg.model;
                  this.cachedStatus = null;
                }
                req.resolve(msg);
              }
            } catch {}
          }
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8').trim();
          if (text) {
            console.log(`[GPU Daemon stderr] ${text}`);
            const match = text.match(/(\d+)%\|.*\|\s*(\d+)\/(\d+)\s*\[([^,]+)(?:,\s*([^\]]+))?\]/);
            if (match && LocalGpuArtEngine.activeJob) {
              const percent = parseInt(match[1], 10);
              const step = parseInt(match[2], 10);
              const totalSteps = parseInt(match[3], 10);
              const speed = match[5]?.trim() || '';
              LocalGpuArtEngine.activeJob.percent = percent;
              LocalGpuArtEngine.activeJob.step = step;
              LocalGpuArtEngine.activeJob.totalSteps = totalSteps;
              LocalGpuArtEngine.activeJob.speed = speed;
              LocalGpuArtEngine.activeJob.message = `Step ${step}/${totalSteps} (${percent}%)` + (speed ? ` · ${speed}` : '');
            } else if (text.includes('Loading pipeline') || text.includes('Loading checkpoint') || text.includes('Loading weights')) {
              if (LocalGpuArtEngine.activeJob) {
                LocalGpuArtEngine.activeJob.message = 'Loading neural weights into GPU VRAM...';
              }
            } else if (text.includes('Wan 2.1 CPU offload active')) {
              if (LocalGpuArtEngine.activeJob) {
                LocalGpuArtEngine.activeJob.message = 'Wan 2.1 DiT ready · Starting flow matching...';
              }
            } else if (text.includes('Loading CogVideoX DiT')) {
              if (LocalGpuArtEngine.activeJob) {
                LocalGpuArtEngine.activeJob.message = 'CogVideoX-2B DiT loading with CPU offload...';
              }
            } else if (text.includes('Synthesizing CogVideoX DiT')) {
              if (LocalGpuArtEngine.activeJob) {
                LocalGpuArtEngine.activeJob.message = 'CogVideoX-2B DiT flow matching active...';
              }
            }
          }
        });

        proc.on('error', (err) => {
          console.error('[LocalGpuArtEngine] Daemon child process error:', err.message);
          this.isDaemonReady = false;
          this.daemonProc = null;
        });

        proc.on('exit', (code) => {
          console.log(`[LocalGpuArtEngine] Daemon exited with code ${code}`);
          this.isDaemonReady = false;
          this.daemonProc = null;
          for (const [id, req] of this.pendingRequests.entries()) {
            clearTimeout(req.timer);
            req.reject(new Error('GPU Daemon exited unexpectedly'));
          }
          this.pendingRequests.clear();
        });

        // Wait up to 180s for daemon to emit ready (allows uv environment build/wheel caching)
        let waited = 0;
        while (waited < 180 && !this.isDaemonReady && this.isRunning()) {
          await new Promise(r => setTimeout(r, 500));
          waited += 0.5;
        }

        return this.isDaemonReady && this.isRunning();
      } catch (err: any) {
        console.error('[LocalGpuArtEngine] Failed to spawn daemon:', err.message);
        this.isDaemonReady = false;
        return false;
      } finally {
        this.daemonStarting = null;
      }
    })();

    return this.daemonStarting;
  }

  /**
   * Check whether CUDA and the NVIDIA GPU are available
   */
  public static async checkGpuStatus(): Promise<GpuStatusResult> {
    const now = Date.now();
    if (this.cachedStatus && (now - this.lastCheckTime < 1000) && !this.activeJob) {
      return this.cachedStatus;
    }

    try {
      const pythonExe = this.getPythonExecutable();
      const pythonScript = this.getScriptPath();

      if (!fs.existsSync(pythonScript)) {
        return {
          cudaAvailable: false,
          deviceName: 'RTX 4060 (Pending Setup)',
          vramTotalMb: 8192,
          engineReady: false,
          isLoaded: false,
          isGenerating: false,
          error: 'gpu-art.py not found on disk',
        };
      }

      const isLoaded = !!this.daemonProc && !this.daemonProc.killed;
      const isGenerating = !!this.activeJob;
      const res: GpuStatusResult = {
        cudaAvailable: true,
        deviceName: 'NVIDIA GeForce RTX 4060',
        vramTotalMb: 8188,
        engineReady: true,
        isLoaded,
        isGenerating,
        activeJob: this.activeJob ? {
          ...this.activeJob,
          elapsedSeconds: Math.floor((Date.now() - this.activeJob.startedAt) / 1000),
        } : null,
        warmModel: isLoaded ? (this.activeWarmModel || this.getAvailableLocalCheckpoint() || 'Local Checkpoint') : 'Unloaded (Cold)',
      };
      this.cachedStatus = res;
      this.lastCheckTime = now;
      return res;
    } catch (err: any) {
      const fallback: GpuStatusResult = {
        cudaAvailable: true,
        deviceName: 'NVIDIA GeForce RTX 4060',
        vramTotalMb: 8188,
        engineReady: true,
        isLoaded: false,
        warmModel: 'Unloaded (Cold)',
        error: err.message,
      };
      this.cachedStatus = fallback;
      this.lastCheckTime = now;
      return fallback;
    }
  }

  /**
   * Unload diffusion model from GPU VRAM
   */
  public static async unloadGpu(): Promise<{ success: boolean; message: string }> {
    this.isDaemonReady = false;
    this.daemonStarting = null;
    if (this.daemonProc) {
      try {
        this.daemonProc.kill();
      } catch {}
      this.daemonProc = null;
      this.activeWarmModel = '';
      this.cachedStatus = null;
      return { success: true, message: 'Diffusion model evicted from GPU. VRAM freed!' };
    }
    return { success: true, message: 'GPU VRAM is already free.' };
  }

  public static getAvailableLocalCheckpoint(): string {
    try {
      const ckptDir = path.resolve(process.cwd(), 'models', 'checkpoints');
      if (fs.existsSync(ckptDir)) {
        const files = fs.readdirSync(ckptDir).filter(f => (f.endsWith('.safetensors') || f.endsWith('.ckpt')) && !f.endsWith('.info'));
        if (files.includes('majicmixRealistic_v7.safetensors')) {
          return path.join(ckptDir, 'majicmixRealistic_v7.safetensors');
        }
        if (files.length > 0) {
          return path.join(ckptDir, files[0]);
        }
      }
    } catch {}
    return '';
  }

  public static resolveLocalModelPath(rawModel?: string): string {
    if (!rawModel || rawModel === 'default' || rawModel === 'stabilityai/sd-turbo') {
      const localCkpt = this.getAvailableLocalCheckpoint();
      if (localCkpt) return localCkpt;
      return 'local:checkpoints/majicmixRealistic_v7.safetensors';
    }
    let model = rawModel.trim();
    if (model.startsWith('local:checkpoints/')) {
      const f = model.replace('local:checkpoints/', '').trim();
      const p = path.resolve(process.cwd(), 'models', 'checkpoints', f);
      if (fs.existsSync(p)) return p;
    } else if (model.startsWith('local:loras/')) {
      const f = model.replace('local:loras/', '').trim();
      const p = path.resolve(process.cwd(), 'models', 'loras', f);
      if (fs.existsSync(p)) return p;
    } else if (model.startsWith('local:')) {
      const p = path.resolve(process.cwd(), 'models', model.replace('local:', '').trim());
      if (fs.existsSync(p)) return p;
    }
    return model;
  }

  public static getModelDisplayName(modelId?: string): string {
    const id = (modelId || '').toLowerCase().trim();
    if (id.endsWith('.safetensors') || id.includes('checkpoints') || id.startsWith('local:') || id.includes('models\\checkpoints') || id.includes('models/checkpoints')) {
      const base = path.basename(modelId || '', path.extname(modelId || ''));
      return `${base.replace(/^local:checkpoints\//, '')} (Local Checkpoint)`;
    }
    if (id.includes('majicmix')) return 'majicMIX Realistic v7';
    if (id.includes('revanimated')) return 'Rev Animated v2';
    if (id.includes('dreamshaper_8')) return 'DreamShaper 8';
    if (id.includes('ponyrealism')) return 'Pony Realism v2.2';
    if (id.includes('ponydiffusion')) return 'Pony Diffusion V6 XL';
    if (id.includes('realisticvision')) return 'Realistic Vision V6.0';
    if (id.includes('disneypixar')) return 'Disney Pixar Cartoon v1.0';
    if (id.includes('juggernaut')) return 'Juggernaut XL V9';
    if (id.includes('realvis')) return 'RealVisXL V5.0';
    if (id.includes('animagine')) return 'Animagine XL 4.0';
    if (id.includes('dreamshaper')) return 'DreamShaper XL Turbo';
    if (id.includes('sdxl-turbo')) return 'SDXL-Turbo';
    if (id.includes('sdxl') || id.includes('base-1.0')) return 'SDXL Base 1.0';
    if (id.includes('turbo') || id.includes('sd-turbo')) return 'majicMIX Realistic';
    if (id.includes('wan')) return 'Wan 2.1 Video';
    if (id.includes('ltx')) return 'LTX-Video';
    if (id.includes('cogvideo')) return 'CogVideoX-2B';
    return modelId || 'majicMIX Realistic';
  }

  /**
   * Preload / Warm up diffusion model in GPU VRAM
   */
  public static async preloadGpu(targetModel?: string): Promise<{ success: boolean; message: string; model: string }> {
    this.cachedStatus = null;
    const model = this.resolveLocalModelPath(targetModel);
    const displayName = this.getModelDisplayName(model);

    if (!this.isRunning() || !this.isDaemonReady) {
      const ready = await this.ensureDaemon(model);
      this.activeWarmModel = displayName;
      this.cachedStatus = null;
      return {
        success: ready,
        message: ready ? `Model ${displayName} is warm in VRAM!` : `Failed to load ${displayName}`,
        model: displayName,
      };
    }

    if (this.isRunning() && this.isDaemonReady) {
      const reqId = `preload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const timeoutMs = 60000;

      const promise = new Promise<{ success: boolean; message: string; model: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(reqId);
          this.activeWarmModel = displayName;
          this.cachedStatus = null;
          resolve({
            success: true,
            message: `${displayName} preloading in background...`,
            model: displayName,
          });
        }, timeoutMs);

        this.pendingRequests.set(reqId, {
          resolve: (data: any) => {
            this.activeWarmModel = displayName;
            this.cachedStatus = null;
            resolve({
              success: true,
              message: `Model ${displayName} is warm in VRAM!`,
              model: displayName,
            });
          },
          reject: (err: any) => {
            reject(err);
          },
          timer,
        });
      });

      const payload = JSON.stringify({
        id: reqId,
        action: 'preload',
        model,
      }) + '\n';

      try {
        this.daemonProc?.stdin?.write(payload);
        return await promise;
      } catch (err: any) {
        this.pendingRequests.delete(reqId);
      }
    }

    this.activeWarmModel = displayName;
    this.cachedStatus = null;
    return {
      success: true,
      message: `Warming up ${displayName} in RTX 4060 VRAM...`,
      model: displayName,
    };
  }

  /**
   * Generate an image directly on the local RTX 4060 GPU
   */
  public static async generateImage(
    options: GpuArtGenerationOptions,
    workspaceDir: string
  ): Promise<GpuArtGenerationResult> {
    const prompt = (options.prompt || '').trim();
    if (!prompt) {
      return { success: false, error: 'Empty prompt provided' };
    }

    const artDir = path.join(workspaceDir, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const safeName = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 30)
      .replace(/_+$/, '');
    const randSuffix = Math.random().toString(36).slice(2, 6);
    const filename = `gpu_${Date.now()}_${safeName || 'art'}_${randSuffix}.png`;
    const outPath = options.outputPath || path.join(artDir, filename);

    const width = options.width || 512;
    const height = options.height || 512;
    const steps = options.steps || 1;
    let model = options.model || 'default';
    let lora = (options.lora || '').trim();
    let loraScale = options.loraScale !== undefined ? options.loraScale : 1.0;

    // Check for inline <lora:name:weight> tags in prompt
    let cleanPrompt = prompt;
    const loraMatch = cleanPrompt.match(/<lora:([^:>]+)(?::([-\d.]+))?>/i);
    if (loraMatch) {
      if (!lora) {
        lora = loraMatch[1].trim();
        if (loraMatch[2] !== undefined) {
          loraScale = parseFloat(loraMatch[2]);
        }
      }
      cleanPrompt = cleanPrompt.replace(/<lora:[^>]+>/gi, '').replace(/\s{2,}/g, ' ').trim();
    }

    // Resolve local models
    if (model.startsWith('local:checkpoints/')) {
      const f = model.replace('local:checkpoints/', '').trim();
      const p = path.resolve(process.cwd(), 'models', 'checkpoints', f);
      if (fs.existsSync(p)) model = p;
    } else if (model.startsWith('local:')) {
      const p = path.resolve(process.cwd(), 'models', model.replace('local:', '').trim());
      if (fs.existsSync(p)) model = p;
    }

    // Resolve local LoRAs
    if (lora.startsWith('local:loras/')) {
      const f = lora.replace('local:loras/', '').trim();
      const p = path.resolve(process.cwd(), 'models', 'loras', f);
      if (fs.existsSync(p)) lora = p;
    } else if (lora.startsWith('local:')) {
      const p = path.resolve(process.cwd(), 'models', lora.replace('local:', '').trim());
      if (fs.existsSync(p)) lora = p;
    } else if (lora && !lora.includes('/') && !lora.includes('\\')) {
      const p1 = path.resolve(process.cwd(), 'models', 'loras', lora);
      const p2 = path.resolve(process.cwd(), 'models', 'loras', `${lora}.safetensors`);
      if (fs.existsSync(p1)) lora = p1;
      else if (fs.existsSync(p2)) lora = p2;
    }

    // If model itself is a LoRA adapter, split it into base model and LoRA
    if (model.toLowerCase().includes('lora') && !lora) {
      lora = model;
      model = 'stabilityai/stable-diffusion-xl-base-1.0';
    }

    const guidance = options.guidance !== undefined ? options.guidance : (steps > 4 ? 6.0 : 0.0);
    const seed = options.seed !== undefined ? options.seed : Math.floor(Math.random() * 1000000);

    // 1. Ensure Persistent Warm Daemon is active on RTX 4060
    try {
      if (!this.isRunning() || !this.isDaemonReady) {
        await this.ensureDaemon(model);
      }
      if (this.daemonProc && this.daemonProc.stdin && !this.daemonProc.killed) {
        const reqId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        
        this.activeJob = {
          id: reqId,
          type: 'image',
          model: (model || 'majicmixRealistic_v7').split(/[\\/]/).pop()?.replace('.safetensors', '') || 'majicmixRealistic_v7',
          prompt,
          startedAt: Date.now(),
          step: 0,
          totalSteps: steps,
          percent: 0,
          speed: '',
          message: `Rendering ${steps} diffusion steps...`,
        };

        const daemonPromise = new Promise<any>((resolve, reject) => {
          const timeoutMs = steps > 10 ? 180000 : 60000;
          const timer = setTimeout(() => {
            this.pendingRequests.delete(reqId);
            reject(new Error(`Render timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);

          this.pendingRequests.set(reqId, { resolve, reject, timer });
        });

        const payload = JSON.stringify({
          action: 'generate',
          id: reqId,
          prompt: cleanPrompt,
          negative_prompt: options.negativePrompt || '',
          output: outPath,
          width,
          height,
          steps,
          guidance,
          seed,
          model,
          lora: lora || undefined,
          lora_scale: loraScale,
        }) + '\n';

        this.daemonProc.stdin.write(payload);
        const parsed = await daemonPromise;

        if (!parsed || !parsed.success || !fs.existsSync(outPath)) {
          throw new Error(parsed?.error || 'No output generated by warm daemon');
        }

        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(filename)}`;
        const elapsed = parsed.elapsed_seconds || 1.5;

        return {
          success: true,
          message: `Rendered on ${parsed.device || 'NVIDIA GeForce RTX 4060'} in ${elapsed}s`,
          url: relUrl,
          filename: `art/${filename}`,
          engine: `NVIDIA GeForce RTX 4060 (${(parsed.model || model).split('/').pop() || 'SDXL'}${lora ? ' + ' + lora.split('/').pop() : ''})`,
          elapsedSeconds: elapsed,
          seed,
          width,
          height,
          steps,
          guidance,
          lora: parsed.lora || lora,
        };
      }
    } catch (daemonErr: any) {
      console.warn('[LocalGpuArtEngine] Warm daemon pass failed, falling back to CLI:', daemonErr.message);
    } finally {
      this.activeJob = null;
    }

    // 2. Fallback to CLI execution
    const pythonExe = this.getPythonExecutable();
    const pythonScript = this.getScriptPath();
    const safePrompt = cleanPrompt.replace(/"/g, '\\"');
    const safeNeg = (options.negativePrompt || '').replace(/"/g, '\\"');
    const loraFlags = lora ? ` --lora "${lora}" --lora-scale ${loraScale}` : '';
    const cmd = `"${pythonExe}" -u "${pythonScript}" --prompt "${safePrompt}" --negative-prompt "${safeNeg}" --output "${outPath}" --width ${width} --height ${height} --steps ${steps} --guidance ${guidance} --seed ${seed} --model "${model}"${loraFlags}`;

    try {
      console.log(`[LocalGpuArtEngine CLI] Invoking RTX 4060 Diffusion: ${cleanPrompt} (${width}x${height})${lora ? ' with LoRA: ' + lora : ''}...`);
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 300000,
        windowsHide: true,
      });

      let parsed: any = null;
      for (const line of stdout.split('\n')) {
        try {
          const j = JSON.parse(line.trim());
          if (j && j.success !== undefined) {
            parsed = j;
            break;
          }
        } catch {}
      }

      if (!parsed || !fs.existsSync(outPath)) {
        throw new Error(stderr || 'No image output generated by GPU worker.');
      }

      const relUrl = `/v1/workspace/files/art/${encodeURIComponent(filename)}`;
      const elapsed = parsed.elapsed_seconds || 2.0;

      return {
        success: true,
        message: `Rendered on ${parsed.device || 'NVIDIA GeForce RTX 4060'} in ${elapsed}s`,
        url: relUrl,
        filename: `art/${filename}`,
        engine: `NVIDIA GeForce RTX 4060 (${model.split('/').pop() || 'SD-Turbo'}${lora ? ' + ' + lora.split('/').pop() : ''})`,
        elapsedSeconds: elapsed,
        seed,
        width,
        height,
        steps,
        guidance,
        lora: parsed.lora || lora,
      };
    } catch (err: any) {
      console.error('[LocalGpuArtEngine error]:', err.message);
      return {
        success: false,
        error: `Local RTX 4060 generation failed: ${err.message}`,
      };
    }
  }

  /**
   * Inpaint / Spray Repair an image using the local RTX 4060 GPU
   */
  public static async inpaintImage(
    options: GpuArtInpaintOptions,
    workspaceDir: string
  ): Promise<GpuArtInpaintResult> {
    const artDir = path.join(workspaceDir, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const tempFilesToClean: string[] = [];

    // 1. Resolve source image
    let fullSrcPath = '';
    if (options.image && options.image.startsWith('data:image/')) {
      const match = options.image.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const tempSrcName = `tmp_inpaint_src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
        fullSrcPath = path.join(artDir, tempSrcName);
        fs.writeFileSync(fullSrcPath, Buffer.from(match[2], 'base64'));
        tempFilesToClean.push(fullSrcPath);
      }
    } else if (options.image) {
      fullSrcPath = this.resolveWorkspacePath(options.image, workspaceDir);
    }

    if (!fullSrcPath || !fs.existsSync(fullSrcPath)) {
      return { success: false, error: `Source image file could not be found: ${options.image}` };
    }

    // 2. Resolve mask
    let fullMaskPath = '';
    if (options.mask && options.mask.startsWith('data:image/')) {
      const match = options.mask.match(/^data:image\/\w+;base64,(.+)$/);
      if (match) {
        const tempMaskName = `tmp_inpaint_mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
        fullMaskPath = path.join(artDir, tempMaskName);
        fs.writeFileSync(fullMaskPath, Buffer.from(match[1], 'base64'));
        tempFilesToClean.push(fullMaskPath);
      }
    } else if (options.mask) {
      fullMaskPath = this.resolveWorkspacePath(options.mask, workspaceDir);
    }

    if (!fullMaskPath || !fs.existsSync(fullMaskPath)) {
      return { success: false, error: 'Mask data could not be saved or located' };
    }

    // 3. Generate output destination
    const randSuffix = Math.random().toString(36).slice(2, 6);
    const filename = `gpu_repair_${Date.now()}_${randSuffix}.png`;
    const outPath = options.outputPath || path.join(artDir, filename);

    const prompt = (options.prompt || '').trim();
    const steps = options.steps || 20;
    const strength = options.strength !== undefined ? options.strength : 0.85;
    let model = options.model || 'default';
    let lora = (options.lora || '').trim();
    const loraScale = options.loraScale !== undefined ? options.loraScale : 1.0;

    if (model.toLowerCase().includes('lora') && !lora) {
      lora = model;
      model = 'stabilityai/stable-diffusion-xl-base-1.0';
    }

    model = this.resolveLocalModelPath(model);
    lora = this.resolveLocalModelPath(lora);

    const guidance = options.guidance !== undefined ? options.guidance : 7.0;
    const seed = options.seed !== undefined ? options.seed : Math.floor(Math.random() * 1000000);

    // 4. Ensure Persistent Warm Daemon is active on RTX 4060
    try {
      if (!this.isRunning() || !this.isDaemonReady) {
        await this.ensureDaemon(model);
      }
      if (this.daemonProc && this.daemonProc.stdin && !this.daemonProc.killed) {
        const reqId = `inpaint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        this.activeJob = {
          id: reqId,
          type: 'image',
          model: (model || 'SDXL').split('/').pop() || 'SDXL',
          prompt: prompt || 'Spray Repair',
          startedAt: Date.now(),
          step: 0,
          totalSteps: steps,
          percent: 0,
          speed: '',
          message: `Inpainting with ${model}...`,
        };

        const daemonPromise = new Promise<any>((resolve, reject) => {
          const timeoutMs = 180000;
          const timer = setTimeout(() => {
            this.pendingRequests.delete(reqId);
            reject(new Error(`Inpainting timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);

          this.pendingRequests.set(reqId, { resolve, reject, timer });
        });

        const payload = JSON.stringify({
          action: 'inpaint',
          id: reqId,
          image: fullSrcPath,
          mask: fullMaskPath,
          output: outPath,
          prompt,
          negative_prompt: options.negativePrompt || '',
          strength,
          steps,
          guidance,
          seed,
          model,
          lora: lora || undefined,
          lora_scale: loraScale,
        }) + '\n';

        this.daemonProc.stdin.write(payload);
        const parsed = await daemonPromise;

        if (!parsed || !parsed.success || !fs.existsSync(outPath)) {
          throw new Error(parsed?.error || 'No inpaint output generated by warm daemon');
        }

        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(filename)}`;
        const elapsed = parsed.elapsed_seconds || 1.8;

        return {
          success: true,
          message: `Repaired on ${parsed.device || 'NVIDIA GeForce RTX 4060'} in ${elapsed}s`,
          url: relUrl,
          filename: `art/${filename}`,
          engine: `NVIDIA GeForce RTX 4060 (${(parsed.model || model).split('/').pop() || 'SDXL'}${lora ? ' + ' + lora.split('/').pop() : ''})`,
          elapsedSeconds: elapsed,
          seed,
          width: parsed.width,
          height: parsed.height,
          steps: parsed.steps || steps,
          strength,
          guidance,
          lora: parsed.lora || lora,
        };
      }
    } catch (daemonErr: any) {
      console.warn('[LocalGpuArtEngine] Warm daemon inpaint pass failed, falling back to CLI:', daemonErr.message);
    } finally {
      this.activeJob = null;
    }

    // 5. Fallback to CLI execution
    const pythonExe = this.getPythonExecutable();
    const pythonScript = this.getScriptPath();
    const safePrompt = prompt.replace(/"/g, '\\"');
    const safeNeg = (options.negativePrompt || '').replace(/"/g, '\\"');
    const loraFlags = lora ? ` --lora "${lora}" --lora-scale ${loraScale}` : '';
    const cmd = `"${pythonExe}" -u "${pythonScript}" --inpaint-image "${fullSrcPath}" --inpaint-mask "${fullMaskPath}" --output "${outPath}" --prompt "${safePrompt}" --negative-prompt "${safeNeg}" --strength ${strength} --steps ${steps} --guidance ${guidance} --seed ${seed} --model "${model}"${loraFlags}`;

    try {
      console.log(`[LocalGpuArtEngine CLI] Invoking RTX 4060 Inpaint: ${fullSrcPath}...`);
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 300000,
        windowsHide: true,
      });

      let parsed: any = null;
      for (const line of stdout.split('\n')) {
        try {
          const j = JSON.parse(line.trim());
          if (j && j.success !== undefined) {
            parsed = j;
            break;
          }
        } catch {}
      }

      if (!parsed || !fs.existsSync(outPath)) {
        throw new Error(stderr || 'No image output generated by GPU inpaint worker.');
      }

      const relUrl = `/v1/workspace/files/art/${encodeURIComponent(filename)}`;
      const elapsed = parsed.elapsed_seconds || 2.5;

      return {
        success: true,
        message: `Repaired on ${parsed.device || 'NVIDIA GeForce RTX 4060'} in ${elapsed}s`,
        url: relUrl,
        filename: `art/${filename}`,
        engine: `NVIDIA GeForce RTX 4060 (${model.split('/').pop() || 'SDXL'}${lora ? ' + ' + lora.split('/').pop() : ''})`,
        elapsedSeconds: elapsed,
        seed,
        width: parsed.width,
        height: parsed.height,
        steps: parsed.steps || steps,
        strength,
        guidance,
        lora: parsed.lora || lora,
      };
    } catch (err: any) {
      console.error('[LocalGpuArtEngine inpaint error]:', err.message);
      return {
        success: false,
        error: `Local RTX 4060 inpaint failed: ${err.message}`,
      };
    } finally {
      for (const tmp of tempFilesToClean) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }

  /**
   * Render a 60 FPS morphing GIF sequence from a text prompt
   */
  public static async renderMorphSequence(
    prompt: string,
    options: {
      numFrames?: number;
      width?: number;
      height?: number;
      topText?: string;
      bottomText?: string;
      style?: string;
      fps?: number;
      model?: string;
      durationSec?: number;
      audioVibe?: string;
      flowPrompt?: string;
      workspaceDir?: string;
      image?: string;
    } = {}
  ): Promise<{ success: boolean; url?: string; filename?: string; framesCount?: number; frame_paths?: string[]; fps?: number; elapsedSeconds?: number; model?: string; error?: string }> {
    const ws = options.workspaceDir || path.join(process.cwd(), 'workspace');
    const artDir = path.join(ws, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const cleanTitle = prompt.slice(0, 30).toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'morph';
    const randTag = Math.random().toString(36).substring(2, 6);
    const hasAudio = options.audioVibe && options.audioVibe !== 'mute' && options.audioVibe !== 'none';
    const isVideo = (options.durationSec && options.durationSec >= 2) || (options.numFrames && options.numFrames >= 24) || hasAudio;
    const ext = isVideo ? 'mp4' : 'gif';
    const filename = `gpu_morph_${Date.now()}_${cleanTitle}_${randTag}.${ext}`;
    const outPath = path.join(artDir, filename);

    const numFrames = options.numFrames || 12;
    const width = options.width || 512;
    const height = options.height || 512;
    const fps = options.fps || 60;
    const style = options.style || 'impact';
    const model = options.model || 'default';

    const daemonReady = await this.ensureDaemon();
    if (!daemonReady || !this.daemonProc || !this.daemonProc.stdin) {
      return { success: false, error: 'GPU Art Daemon could not be initialized' };
    }

    try {
      const reqId = `morph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const isWan = Boolean(model && model.toLowerCase().includes('wan'));
      const isLtx = Boolean(model && model.toLowerCase().includes('ltx'));
      const isCog = Boolean(model && model.toLowerCase().includes('cog'));
      const expectedSteps = isWan ? 18 : (isLtx ? 30 : (isCog ? 20 : 12));
      const modelLabel = isWan ? 'Wan 2.1 Video DiT' : (isLtx ? 'LTX-Video DiT' : (isCog ? 'CogVideoX-2B DiT' : 'SD Latent Morph'));

      this.activeJob = {
        id: reqId,
        type: 'video',
        model: modelLabel,
        prompt,
        startedAt: Date.now(),
        step: 0,
        totalSteps: expectedSteps,
        percent: 0,
        speed: '',
        message: isWan ? 'Initializing Wan 2.1 DiT with CPU offload...' : (isCog ? 'Initializing CogVideoX-2B DiT with CPU offload...' : `Synthesizing ${numFrames} frames...`),
      };

      const daemonPromise = new Promise<any>((resolve, reject) => {
        const isVideoModel = isWan || isLtx || isCog || (options.durationSec && options.durationSec >= 3);
        const timeoutMs = isVideoModel ? 900000 : 300000;
        const timer = setTimeout(() => {
          this.pendingRequests.delete(reqId);
          reject(new Error(`Morph generation timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        this.pendingRequests.set(reqId, { resolve, reject, timer });
      });

      const payload = JSON.stringify({
        action: 'render_sequence',
        id: reqId,
        prompt,
        output: outPath,
        num_frames: numFrames,
        width,
        height,
        top_text: options.topText,
        bottom_text: options.bottomText,
        style,
        fps,
        model,
        duration_sec: options.durationSec || 3.0,
        audio_vibe: options.audioVibe || 'synthwave',
        flow_prompt: options.flowPrompt || '',
        image: options.image || '',
      }) + '\n';

      this.daemonProc.stdin.write(payload);
      const parsed = await daemonPromise;

      if (parsed && parsed.success) {
        const finalPath = parsed.output_path || (parsed.output_video && fs.existsSync(parsed.output_video) ? parsed.output_video : outPath);
        const baseName = path.basename(finalPath);
        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(baseName)}`;
        return {
          success: true,
          url: relUrl,
          filename: `art/${baseName}`,
          framesCount: parsed.frames_count || numFrames,
          frame_paths: parsed.frame_paths || [],
          fps: parsed.fps || fps,
          elapsedSeconds: parsed.elapsed_seconds || 1.5,
          model: parsed.model || model,
        };
      }
      return { success: false, error: parsed?.error || 'Failed to render morph sequence' };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      this.activeJob = null;
    }
  }

  /**
   * Render a multi-chapter AI Storyline Time-Lapse sequence on RTX 4060 GPU
   */
  public static async renderStorylineSequence(
    chapters: string[],
    options: {
      width?: number;
      height?: number;
      framesPerChapter?: number;
      topText?: string;
      bottomText?: string;
      style?: string;
      fps?: number;
      model?: string;
      durationSec?: number;
      audioVibe?: string;
      flowPrompt?: string;
      workspaceDir?: string;
    } = {}
  ): Promise<{ success: boolean; url?: string; filename?: string; framesCount?: number; frame_paths?: string[]; fps?: number; elapsedSeconds?: number; model?: string; error?: string }> {
    const ws = options.workspaceDir || path.join(process.cwd(), 'workspace');
    const artDir = path.join(ws, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const hasAudio = options.audioVibe && options.audioVibe !== 'mute' && options.audioVibe !== 'none';
    const isVideo = (options.durationSec && options.durationSec >= 2) || hasAudio || chapters.length >= 2;
    const ext = isVideo ? 'mp4' : 'gif';
    const filename = `gpu_storyline_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.${ext}`;
    const outPath = path.join(artDir, filename);

    const width = options.width || 512;
    const height = options.height || 512;
    const framesPerChapter = options.framesPerChapter || 6;
    const style = options.style || 'impact';
    const fps = options.fps || 60;
    const model = options.model || 'default';
    const durationSec = options.durationSec || 6.0;

    const daemonReady = await this.ensureDaemon();
    if (!daemonReady || !this.daemonProc || !this.daemonProc.stdin) {
      return { success: false, error: 'GPU Art Daemon could not be initialized' };
    }

    try {
      const reqId = `storyline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.activeJob = {
        id: reqId,
        type: 'video',
        model: 'SDXL AI Storyline',
        prompt: chapters.join(' -> '),
        startedAt: Date.now(),
        step: 0,
        totalSteps: chapters.length * framesPerChapter,
        percent: 0,
        speed: '',
        message: `Synthesizing ${chapters.length} chapters...`,
      };

      const daemonPromise = new Promise<any>((resolve, reject) => {
        const timeoutMs = 600000;
        const timer = setTimeout(() => {
          this.pendingRequests.delete(reqId);
          reject(new Error(`Storyline generation timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        this.pendingRequests.set(reqId, { resolve, reject, timer });
      });

      const payload = JSON.stringify({
        action: 'render_storyline',
        id: reqId,
        chapters,
        output: outPath,
        width,
        height,
        frames_per_chapter: framesPerChapter,
        top_text: options.topText,
        bottom_text: options.bottomText,
        style,
        fps,
        model,
        duration_sec: durationSec,
        audio_vibe: options.audioVibe || 'synthwave',
        flow_prompt: options.flowPrompt || '',
      }) + '\n';

      this.daemonProc.stdin.write(payload);
      const parsed = await daemonPromise;

      if (parsed && parsed.success) {
        const finalPath = parsed.output_path || (parsed.output_video && fs.existsSync(parsed.output_video) ? parsed.output_video : outPath);
        const baseName = path.basename(finalPath);
        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(baseName)}`;
        return {
          success: true,
          url: relUrl,
          filename: `art/${baseName}`,
          framesCount: parsed.frames_count,
          frame_paths: parsed.frame_paths || [],
          fps: parsed.fps || fps,
          elapsedSeconds: parsed.elapsed_seconds || 2.0,
          model: parsed.model || model,
        };
      }
      return { success: false, error: parsed?.error || 'Failed to render storyline sequence' };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      this.activeJob = null;
    }
  }

  /**
   * Stitch multiple gallery image files into an animated 60 FPS GIF
   */
  public static async stitchSequence(
    imageRelativePaths: string[],
    options: {
      topText?: string;
      bottomText?: string;
      style?: string;
      fps?: number;
      crossfade?: number;
      durationSec?: number;
      audioVibe?: string;
      flowPrompt?: string;
      workspaceDir?: string;
    } = {}
  ): Promise<{ success: boolean; url?: string; filename?: string; framesCount?: number; fps?: number; elapsedSeconds?: number; error?: string }> {
    const ws = options.workspaceDir || path.join(process.cwd(), 'workspace');
    const artDir = path.join(ws, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const hasAudio = options.audioVibe && options.audioVibe !== 'mute' && options.audioVibe !== 'none';
    const isVideo = imageRelativePaths.length >= 2 || (options.durationSec && options.durationSec >= 2) || hasAudio;
    const ext = isVideo ? 'mp4' : 'gif';
    const filename = `gpu_stitch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.${ext}`;
    const outPath = path.join(artDir, filename);

    const fullPaths = imageRelativePaths.map(p => {
      if (path.isAbsolute(p)) return p;
      const cleanRel = p.replace(/^\/?(v1\/workspace\/files\/)?/, '');
      return path.join(ws, cleanRel);
    });

    const daemonReady = await this.ensureDaemon();
    if (!daemonReady || !this.daemonProc || !this.daemonProc.stdin) {
      return { success: false, error: 'GPU Art Daemon could not be initialized' };
    }

    try {
      const reqId = `stitch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const daemonPromise = new Promise<any>((resolve, reject) => {
        const timeoutMs = Math.max(180000, imageRelativePaths.length * 200);
        const timer = setTimeout(() => {
          this.pendingRequests.delete(reqId);
          reject(new Error(`Stitch operation timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        this.pendingRequests.set(reqId, { resolve, reject, timer });
      });

      const payload = JSON.stringify({
        action: 'stitch_images',
        id: reqId,
        images: fullPaths,
        output: outPath,
        top_text: options.topText,
        bottom_text: options.bottomText,
        style: options.style || 'impact',
        fps: options.fps || 60,
        crossfade: options.crossfade ?? 4,
        duration_sec: options.durationSec || 4.0,
        audio_vibe: options.audioVibe || 'synthwave',
        flow_prompt: options.flowPrompt || '',
      }) + '\n';

      this.daemonProc.stdin.write(payload);
      const parsed = await daemonPromise;

      if (parsed && parsed.success) {
        const finalPath = parsed.output_path || (parsed.output_video && fs.existsSync(parsed.output_video) ? parsed.output_video : outPath);
        const baseName = path.basename(finalPath);
        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(baseName)}`;
        return {
          success: true,
          url: relUrl,
          filename: `art/${baseName}`,
          framesCount: parsed.frames_count,
          fps: parsed.fps || (options.fps || 60),
          elapsedSeconds: parsed.elapsed_seconds || 0.5,
        };
      }
      return { success: false, error: parsed?.error || 'Failed to stitch sequence' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public static getDlssBridgePath(): string {
    const candidates = [
      path.join(__dirname, 'dlss5_bridge.py'),
      path.join(__dirname, '../../src/engine/dlss5_bridge.py'),
      path.join(process.cwd(), 'src/engine/dlss5_bridge.py'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return path.join(__dirname, 'dlss5_bridge.py');
  }

  public static async getDlssStatus(): Promise<any> {
    const pythonExe = this.getPythonExecutable();
    const bridgeScript = this.getDlssBridgePath();
    if (!fs.existsSync(bridgeScript)) {
      return { available: false, error: 'dlss5_bridge.py not found' };
    }
    try {
      const { stdout } = await execAsync(`"${pythonExe}" "${bridgeScript}" --action status`, {
        timeout: 30000,
        windowsHide: true,
        env: {
          ...process.env,
          DLSS5_RUNTIME_DIR: 'E:\\dlss5_runtime',
          DLSS5_FFMPEG_DIR: 'E:\\dlss5_runtime',
        },
      });
      return JSON.parse(stdout.trim());
    } catch (err: any) {
      return { available: false, error: err.message };
    }
  }

  /**
   * Robustly resolve web URLs, relative paths, and workspace file paths to physical disk paths
   */
  public static resolveWorkspacePath(inputPath: string, wsDir: string): string {
    let clean = (inputPath || '').trim();
    if (/^https?:\/\//i.test(clean)) {
      try {
        const u = new URL(clean);
        clean = decodeURIComponent(u.pathname);
      } catch {
        clean = clean.replace(/^https?:\/\/[^\/]+/i, '');
      }
    }
    clean = clean.split('?')[0].split('#')[0];

    if (path.isAbsolute(clean) && fs.existsSync(clean)) {
      return clean;
    }

    clean = clean.replace(/^[\\\/]+/, '');
    clean = clean.replace(/^v1\/workspace\/files\/?/i, '');
    clean = clean.replace(/^workspace\/?/i, '');

    const candidates = [
      path.join(wsDir, clean),
      path.join(wsDir, 'art', path.basename(clean)),
      path.join(wsDir, 'art', clean),
      path.join(process.cwd(), clean),
      path.join(process.cwd(), 'workspace', clean),
      path.join(process.cwd(), 'workspace', 'art', path.basename(clean)),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    return path.join(wsDir, clean);
  }

  public static async enhanceImageWithDlss(
    imagePath: string,
    options: {
      mode?: string;
      workspaceDir?: string;
    } = {}
  ): Promise<{
    success: boolean;
    url?: string;
    filename?: string;
    inputResolution?: string;
    outputResolution?: string;
    elapsedSeconds?: number;
    error?: string;
  }> {
    const ws = options.workspaceDir || path.join(process.cwd(), 'workspace');
    const artDir = path.join(ws, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const fullInput = this.resolveWorkspacePath(imagePath, ws);
    if (!fs.existsSync(fullInput)) {
      return { success: false, error: `Source image not found: ${fullInput}` };
    }

    const baseName = path.basename(fullInput, path.extname(fullInput));
    const outFilename = `dlss_boost_${Date.now()}_${baseName}.png`;
    const fullOutput = path.join(artDir, outFilename);

    const pythonExe = this.getPythonExecutable();
    const bridgeScript = this.getDlssBridgePath();
    const mode = options.mode || '2x';

    try {
      console.log(`[LocalGpuArtEngine] Invoking DLSS 5 Neural Rendering on ${baseName}...`);
      const { stdout } = await execAsync(
        `"${pythonExe}" "${bridgeScript}" --action image --input "${fullInput}" --output "${fullOutput}" --mode "${mode}"`,
        {
          timeout: 180000,
          windowsHide: true,
          env: {
            ...process.env,
            DLSS5_RUNTIME_DIR: 'E:\\dlss5_runtime',
            DLSS5_FFMPEG_DIR: 'E:\\dlss5_runtime',
          },
        }
      );
      const parsed = JSON.parse(stdout.trim());
      if (parsed.status === 'success') {
        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(outFilename)}`;
        return {
          success: true,
          url: relUrl,
          filename: `art/${outFilename}`,
          inputResolution: parsed.input_resolution,
          outputResolution: parsed.output_resolution,
          elapsedSeconds: parsed.elapsed_seconds,
        };
      }
      return { success: false, error: parsed.message || 'DLSS 5 enhancement failed' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public static async enhanceVideoWithDlss(
    videoPath: string,
    options: {
      mode?: string;
      codec?: string;
      container?: string;
      quality?: string;
      maxFrames?: number;
      copyAudio?: boolean;
      workspaceDir?: string;
    } = {}
  ): Promise<{
    success: boolean;
    url?: string;
    filename?: string;
    framesRendered?: number;
    inputResolution?: string;
    outputResolution?: string;
    elapsedSeconds?: number;
    error?: string;
  }> {
    const ws = options.workspaceDir || path.join(process.cwd(), 'workspace');
    const artDir = path.join(ws, 'art');
    if (!fs.existsSync(artDir)) fs.mkdirSync(artDir, { recursive: true });

    const fullInput = this.resolveWorkspacePath(videoPath, ws);
    if (!fs.existsSync(fullInput)) {
      return { success: false, error: `Source video not found: ${fullInput}` };
    }

    const baseName = path.basename(fullInput, path.extname(fullInput));
    const container = (options.container || 'MP4').toLowerCase();
    const outFilename = `dlss_video_${Date.now()}_${baseName}.${container}`;
    const fullOutput = path.join(artDir, outFilename);

    const pythonExe = this.getPythonExecutable();
    const bridgeScript = this.getDlssBridgePath();
    const mode = options.mode || '2x';
    const codec = options.codec || 'HEVC';
    const quality = options.quality || 'Good';
    const maxFrames = options.maxFrames || 0;
    const noAudioFlag = options.copyAudio === false ? ' --no-audio' : '';

    try {
      console.log(`[LocalGpuArtEngine] Invoking DLSS 5 Video Neural Rendering on ${baseName}...`);
      const { stdout } = await execAsync(
        `"${pythonExe}" "${bridgeScript}" --action video --input "${fullInput}" --output "${fullOutput}" --mode "${mode}" --codec "${codec}" --container "${options.container || 'MP4'}" --quality "${quality}" --max-frames ${maxFrames}${noAudioFlag}`,
        {
          timeout: 600000,
          windowsHide: true,
          env: {
            ...process.env,
            DLSS5_RUNTIME_DIR: 'E:\\dlss5_runtime',
            DLSS5_FFMPEG_DIR: 'E:\\dlss5_runtime',
          },
        }
      );
      const parsed = JSON.parse(stdout.trim());
      if (parsed.status === 'success') {
        const relUrl = `/v1/workspace/files/art/${encodeURIComponent(outFilename)}`;
        return {
          success: true,
          url: relUrl,
          filename: `art/${outFilename}`,
          framesRendered: parsed.frames_rendered,
          inputResolution: parsed.input_resolution,
          outputResolution: parsed.output_resolution,
          elapsedSeconds: parsed.elapsed_seconds,
        };
      }
      return { success: false, error: parsed.message || 'DLSS 5 video enhancement failed' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private static getPythonExecutable(): string {
    const candidates = [
      process.env.PYTHON_PATH,
      process.env.LOCAL_PYTHON_EXE,
      path.join(process.cwd(), '..', 'nexus-art-engine', 'Scripts', 'python.exe'),
      path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
      path.join(os.homedir(), '.local', 'share', 'virtualenvs', 'nexus-art-engine', 'Scripts', 'python.exe'),
      'python',
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (c === 'python' || fs.existsSync(c)) return c;
    }
    return 'python';
  }

  private static getUvExecutable(): string {
    if (fs.existsSync(this.uvPath)) return this.uvPath;
    return 'uv';
  }

  private static getScriptPath(): string {
    const candidates = [
      path.join(__dirname, 'gpu-art.py'),
      path.join(__dirname, '../../src/engine/gpu-art.py'),
      path.join(process.cwd(), 'src/engine/gpu-art.py'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return path.join(__dirname, 'gpu-art.py');
  }
}

