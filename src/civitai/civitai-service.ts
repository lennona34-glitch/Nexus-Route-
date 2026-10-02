import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { createTunnelAgent, type ProxyConfig } from './proxy-agent.js';

export interface CivitaiVpnConfig extends ProxyConfig {
  civitaiApiKey?: string;
}

export interface CivitaiDownloadTask {
  id: string;
  taskId: string;
  modelId: number;
  versionId: number;
  modelName: string;
  filename: string;
  type: string;
  baseModel?: string;
  trainedWords?: string[];
  previewUrl?: string;
  destPath: string;
  totalBytes: number;
  downloadedBytes: number;
  percent: number;
  progress: number;
  speed: string;
  speedMBps: number;
  status: 'pending' | 'downloading' | 'completed' | 'canceled' | 'error';
  error?: string;
  startedAt: number;
  abortController?: AbortController;
}

export interface CivitaiInstalledModel {
  filename: string;
  type: 'lora' | 'checkpoint' | 'other';
  sizeBytes: number;
  sizeMB: number;
  modifiedAt: number;
  fullPath: string;
  metadata?: {
    modelId?: number;
    versionId?: number;
    modelName?: string;
    baseModel?: string;
    trainedWords?: string[];
    previewUrl?: string;
  };
}

export class CivitaiService {
  private configPath: string;
  private config: CivitaiVpnConfig;
  private activeDownloads: Map<string, CivitaiDownloadTask> = new Map();
  private baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
    this.configPath = path.resolve(baseDir, 'config', 'civitai_vpn.json');
    this.config = this.loadConfig();
    this.ensureDirs();
  }

  private ensureDirs() {
    const dirs = [
      path.resolve(this.baseDir, 'models'),
      path.resolve(this.baseDir, 'models', 'loras'),
      path.resolve(this.baseDir, 'models', 'checkpoints'),
      path.resolve(this.baseDir, 'models', 'civitai'),
      path.resolve(this.baseDir, 'config'),
    ];
    for (const d of dirs) {
      if (!fs.existsSync(d)) {
        try { fs.mkdirSync(d, { recursive: true }); } catch {}
      }
    }
  }

  public loadConfig(): CivitaiVpnConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(raw);
        return this.config;
      }
    } catch (e) {
      console.warn('[CivitaiService] Could not load civitai_vpn.json:', e);
    }
    this.config = {
      enabled: false,
      type: 'socks5',
      host: 'amsterdam.nl.socks.nordhold.net',
      port: 1080,
      username: '',
      password: '',
      civitaiApiKey: '',
    };
    return this.config;
  }

  public saveConfig(newConfig: Partial<CivitaiVpnConfig>): CivitaiVpnConfig {
    const copy = { ...newConfig };
    if (!copy.password || copy.password.includes('•') || copy.password === '••••••••') {
      delete copy.password;
    }
    this.config = { ...this.config, ...copy };
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) {
      console.error('[CivitaiService] Could not save civitai_vpn.json:', e);
    }
    return this.getPublicConfig();
  }

  public getPublicConfig(): CivitaiVpnConfig {
    return {
      ...this.config,
      password: this.config.password ? '••••••••' : '',
    };
  }

  public getAgent(customProxy?: ProxyConfig, isHttps: boolean = true): any {
    const proxy = customProxy || this.config;
    return createTunnelAgent(proxy, isHttps);
  }

  private requestBuffer(
    targetUrl: string,
    agent?: any,
    customHeaders: Record<string, string> = {}
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const effectiveAgent = agent !== undefined ? agent : this.getAgent(undefined, isHttps);

      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        ...customHeaders,
      };

      if (this.config.civitaiApiKey && parsed.hostname.includes('civitai.com')) {
        headers['Authorization'] = `Bearer ${this.config.civitaiApiKey}`;
      }

      const req = lib.request(
        targetUrl,
        {
          agent: effectiveAgent,
          headers,
          method: 'GET',
          timeout: 20000,
        },
        (res) => {
          // Handle redirects (e.g. 301, 302, 307, 308)
          if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, targetUrl).toString();
            return this.requestBuffer(redirectUrl, effectiveAgent, customHeaders).then(resolve).catch(reject);
          }

          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 200,
              headers: res.headers,
              data: Buffer.concat(chunks),
            });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Request timed out after 20s'));
      });
      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  /**
   * Diagnostic check: Tests IP, ISP, location, and tests CivitAI API accessibility.
   */
  public async checkVpnStatus(overrideProxy?: ProxyConfig): Promise<{
    ip: string;
    isp: string;
    country: string;
    city: string;
    isNordVpn: boolean;
    civitaiAccessible: boolean;
    civitaiOk: boolean;
    civitaiStatusCode: number;
    proxyActive: boolean;
    proxyType?: string;
    proxyHost?: string;
    proxyConfig?: CivitaiVpnConfig;
    message?: string;
  }> {
    const proxy = overrideProxy || this.config;
    const httpsAgent = this.getAgent(proxy, true);

    let ipInfo = {
      ip: 'Unknown',
      isp: 'Unknown',
      country: 'Unknown',
      city: 'Unknown',
      isNordVpn: false,
    };

    // 1. IP Lookup via HTTPS through the proxy tunnel
    try {
      const ipRes = await this.requestBuffer('https://ipwho.is/', httpsAgent);
      if (ipRes.statusCode === 200) {
        const parsed = JSON.parse(ipRes.data.toString('utf8'));
        ipInfo = {
          ip: parsed.ip || 'Unknown',
          isp: parsed.connection?.isp || parsed.connection?.org || parsed.isp || 'Unknown',
          country: parsed.country || 'Unknown',
          city: parsed.city || 'Unknown',
          isNordVpn: /nord|tefincom|datacamp|packethub|m247/i.test(`${parsed.connection?.isp} ${parsed.connection?.org} ${parsed.connection?.asn} ${parsed.isp}`),
        };
      }
    } catch (e: any) {
      // Fallback ipify
      try {
        const ipifyRes = await this.requestBuffer('https://api.ipify.org?format=json', httpsAgent);
        if (ipifyRes.statusCode === 200) {
          const parsed = JSON.parse(ipifyRes.data.toString('utf8'));
          ipInfo.ip = parsed.ip;
        }
      } catch {}
    }

    // 2. CivitAI Access Test
    let civitaiAccessible = false;
    let civitaiStatusCode = 0;
    let message = '';

    try {
      const civRes = await this.requestBuffer('https://civitai.com/api/v1/models?limit=1', httpsAgent);
      civitaiStatusCode = civRes.statusCode;
      if (civRes.statusCode === 200) {
        civitaiAccessible = true;
        message = 'CivitAI is fully accessible!';
      } else if (civRes.statusCode === 451) {
        civitaiAccessible = false;
        message = 'CivitAI is blocked in your current region (HTTP 451 Legal Restrictions). Enable NordVPN to unblock.';
      } else {
        message = `CivitAI returned status code ${civRes.statusCode}`;
      }
    } catch (err: any) {
      civitaiAccessible = false;
      message = `CivitAI connection error: ${err.message}`;
    }

    return {
      ...ipInfo,
      civitaiAccessible,
      civitaiOk: civitaiAccessible,
      civitaiStatusCode,
      proxyActive: proxy.enabled,
      proxyType: proxy.type,
      proxyHost: proxy.host,
      proxyConfig: this.getPublicConfig(),
      message,
    };
  }

  /**
   * Browse CivitAI models with rich filters.
   */
  public async listModels(params: {
    query?: string;
    tag?: string;
    type?: string; // Checkpoint, LORA, TextualInversion, etc.
    sort?: string; // Highest Rated, Most Downloaded, Newest
    period?: string; // AllTime, Year, Month, Week, Day
    baseModel?: string; // SDXL 1.0, Pony, Flux.1 D, SD 1.5
    nsfw?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    items: any[];
    metadata: any;
    blocked?: boolean;
    error?: string;
  }> {
    const agent = this.getAgent();
    const queryParams = new URLSearchParams();

    queryParams.set('limit', String(params.limit || 24));
    if (params.query) {
      queryParams.set('query', params.query.trim());
    } else if (params.page) {
      queryParams.set('page', String(params.page));
    }
    if (params.tag) queryParams.set('tag', params.tag.trim());
    if (params.type && params.type !== 'all') queryParams.set('types', params.type);
    if (params.sort) queryParams.set('sort', params.sort);
    if (params.period) queryParams.set('period', params.period);
    if (params.nsfw !== undefined) queryParams.set('nsfw', String(params.nsfw));

    const targetUrl = `https://civitai.com/api/v1/models?${queryParams.toString()}`;

    try {
      const res = await this.requestBuffer(targetUrl, agent);
      if (res.statusCode === 451) {
        return {
          items: [],
          metadata: { totalItems: 0 },
          blocked: true,
          error: 'CivitAI is blocked on your current IP (HTTP 451). Connect to NordVPN (Netherlands, US, Switzerland) or configure the SOCKS5 proxy to browse.',
        };
      }
      if (res.statusCode !== 200) {
        return {
          items: [],
          metadata: { totalItems: 0 },
          error: `CivitAI returned status ${res.statusCode}: ${res.data.toString('utf8').slice(0, 200)}`,
        };
      }

      const json = JSON.parse(res.data.toString('utf8'));
      let items = Array.isArray(json.items) ? json.items : [];

      // Filter by baseModel if specified
      if (params.baseModel && params.baseModel !== 'all') {
        const bmFilter = params.baseModel.toLowerCase();
        items = items.filter((m: any) =>
          m.modelVersions?.some((v: any) => (v.baseModel || '').toLowerCase().includes(bmFilter))
        );
      }

      return {
        items,
        metadata: json.metadata || { totalItems: items.length },
      };
    } catch (err: any) {
      return {
        items: [],
        metadata: { totalItems: 0 },
        error: `Failed to query CivitAI: ${err.message}`,
      };
    }
  }

  /**
   * Fetch specific model details.
   */
  public async getModel(modelId: number | string): Promise<any> {
    const agent = this.getAgent();
    const res = await this.requestBuffer(`https://civitai.com/api/v1/models/${modelId}`, agent);
    if (res.statusCode === 451) {
      throw new Error('CivitAI blocked in your region (HTTP 451). Please connect NordVPN.');
    }
    if (res.statusCode !== 200) {
      throw new Error(`CivitAI HTTP ${res.statusCode}`);
    }
    return JSON.parse(res.data.toString('utf8'));
  }

  /**
   * Start streaming download of a model or LoRA.
   */
  public async startDownload(params: {
    modelId: number;
    versionId: number;
    fileId?: number;
    modelName: string;
    type: string; // LORA, Checkpoint
    baseModel?: string;
    trainedWords?: string[];
    previewUrl?: string;
  }): Promise<{ taskId: string; message: string }> {
    const taskId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const isLora = /lora/i.test(params.type);
    const destDir = isLora
      ? path.resolve(this.baseDir, 'models', 'loras')
      : path.resolve(this.baseDir, 'models', 'checkpoints');

    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    // Fetch version details to get exact primary filename and download URL
    const agent = this.getAgent();
    const versionRes = await this.requestBuffer(`https://civitai.com/api/v1/model-versions/${params.versionId}`, agent);
    let downloadUrl = `https://civitai.com/api/download/models/${params.versionId}`;
    let filename = `${params.modelName.replace(/[^a-zA-Z0-9_\-\.]/g, '_')}.safetensors`;
    let trainedWords = params.trainedWords || [];

    if (versionRes.statusCode === 200) {
      try {
        const vData = JSON.parse(versionRes.data.toString('utf8'));
        if (vData.downloadUrl) downloadUrl = vData.downloadUrl;
        if (Array.isArray(vData.trainedWords) && vData.trainedWords.length > 0) {
          trainedWords = vData.trainedWords;
        }
        const fileObj = vData.files?.find((f: any) => f.primary) || vData.files?.[0];
        if (fileObj?.name) filename = fileObj.name;
        if (fileObj?.downloadUrl) downloadUrl = fileObj.downloadUrl;
      } catch {}
    }

    const destPath = path.join(destDir, filename);

    const task: CivitaiDownloadTask = {
      id: taskId,
      taskId: taskId,
      modelId: params.modelId,
      versionId: params.versionId,
      modelName: params.modelName,
      filename,
      type: isLora ? 'lora' : 'checkpoint',
      baseModel: params.baseModel,
      trainedWords,
      previewUrl: params.previewUrl,
      destPath,
      totalBytes: 0,
      downloadedBytes: 0,
      percent: 0,
      progress: 0,
      speed: '0 MB/s',
      speedMBps: 0,
      status: 'pending',
      startedAt: Date.now(),
    };

    this.activeDownloads.set(taskId, task);

    // Launch streaming download asynchronously
    this.executeStreamingDownload(task, downloadUrl).catch((err) => {
      task.status = 'error';
      task.error = err.message;
    });

    return { taskId, message: `Downloading ${filename} to ${isLora ? 'models/loras/' : 'models/checkpoints/'}` };
  }

  private async executeStreamingDownload(task: CivitaiDownloadTask, downloadUrl: string): Promise<void> {
    const agent = this.getAgent();

    return new Promise((resolve, reject) => {
      task.status = 'downloading';

      const parsed = new URL(downloadUrl);
      if (this.config.civitaiApiKey && !parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', this.config.civitaiApiKey);
      }

      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      };

      let activeFileStream: fs.WriteStream | null = null;
      let activePartPath: string | null = null;
      let redirectCount = 0;

      const followAndDownload = (urlToFetch: string) => {
        if (redirectCount++ > 8) {
          task.status = 'error';
          task.error = 'Too many redirects from download server';
          return reject(new Error(task.error));
        }

        const u = new URL(urlToFetch);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;

        const req = lib.request(
          urlToFetch,
          {
            agent: isHttps ? agent : undefined,
            headers,
            method: 'GET',
          },
          (res) => {
            // Handle CivitAI redirects to Cloudflare R2 / AWS S3
            if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
              res.resume(); // CRITICAL: consume incoming stream so socket doesn't fire ECONNRESET
              const redirectUrl = new URL(res.headers.location, urlToFetch).toString();

              if (redirectUrl.includes('/login') || redirectUrl.includes('login?')) {
                task.status = 'error';
                task.error = 'CivitAI requires an API Key for this model. Add your free CivitAI API Key in NordVPN & Settings.';
                return reject(new Error(task.error));
              }

              return followAndDownload(redirectUrl);
            }

            const contentType = res.headers['content-type'] || '';
            if (contentType.includes('text/html')) {
              task.status = 'error';
              task.error = 'CivitAI returned an HTML page instead of model weights. An API Key is required for this model.';
              return reject(new Error(task.error));
            }

            if (res.statusCode === 451) {
              task.status = 'error';
              task.error = 'CivitAI blocked download in this region (HTTP 451). Connect NordVPN.';
              return reject(new Error(task.error));
            }

            if (res.statusCode && res.statusCode >= 400) {
              task.status = 'error';
              task.error = `HTTP ${res.statusCode} from download server`;
              return reject(new Error(task.error));
            }

            // Extract content-disposition filename if present
            const cd = res.headers['content-disposition'];
            if (cd && cd.includes('filename=')) {
              const m = cd.match(/filename="?([^";]+)"?/);
              if (m && m[1]) {
                task.filename = m[1].trim();
                task.destPath = path.join(path.dirname(task.destPath), task.filename);
              }
            }

            task.totalBytes = parseInt(res.headers['content-length'] || '0', 10);

            // Compute unique .part file in the target directory
            activePartPath = path.resolve(path.dirname(task.destPath), `.${task.filename}.${task.id}.part`);
            const fileStream = fs.createWriteStream(activePartPath);
            activeFileStream = fileStream;

            let lastBytes = 0;
            let lastTime = Date.now();

            res.on('data', (chunk: Buffer) => {
              if (task.status === 'canceled') {
                req.destroy();
                fileStream.close();
                if (activePartPath) {
                  try { fs.unlinkSync(activePartPath); } catch {}
                }
                return;
              }

              task.downloadedBytes += chunk.length;
              if (task.totalBytes > 0) {
                const p = Math.round((task.downloadedBytes / task.totalBytes) * 1000) / 10;
                task.percent = Math.min(100, p);
                task.progress = task.percent;
              }

              const now = Date.now();
              if (now - lastTime >= 1000) {
                const diffBytes = task.downloadedBytes - lastBytes;
                const mbps = (diffBytes / (1024 * 1024)) / ((now - lastTime) / 1000);
                task.speedMBps = parseFloat(mbps.toFixed(2));
                task.speed = `${task.speedMBps.toFixed(1)} MB/s`;
                lastBytes = task.downloadedBytes;
                lastTime = now;
              }
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
              fileStream.close(() => {
                if (task.status === 'canceled') {
                  if (activePartPath) {
                    try { fs.unlinkSync(activePartPath); } catch {}
                  }
                  return resolve();
                }

                // Rename .part -> final file atomically
                try {
                  if (activePartPath && fs.existsSync(activePartPath)) {
                    if (fs.existsSync(task.destPath)) fs.unlinkSync(task.destPath);
                    fs.renameSync(activePartPath, task.destPath);
                  }

                  // Write CivitAI Sidecar metadata (.civitai.info)
                  const infoPath = `${task.destPath}.civitai.info`;
                  const metaPayload = {
                    modelId: task.modelId,
                    versionId: task.versionId,
                    modelName: task.modelName,
                    filename: task.filename,
                    type: task.type,
                    baseModel: task.baseModel,
                    trainedWords: task.trainedWords,
                    previewUrl: task.previewUrl,
                    downloadedAt: new Date().toISOString(),
                    sizeBytes: task.downloadedBytes,
                  };
                  fs.writeFileSync(infoPath, JSON.stringify(metaPayload, null, 2), 'utf8');

                  task.status = 'completed';
                  task.percent = 100;
                  task.progress = 100;
                  task.speed = 'Done';
                  task.speedMBps = 0;
                  resolve();
                } catch (e: any) {
                  task.status = 'error';
                  task.error = `Failed to save file: ${e.message}`;
                  reject(e);
                }
              });
            });

            fileStream.on('error', (err) => {
              task.status = 'error';
              task.error = err.message;
              if (activePartPath) {
                try { fs.unlinkSync(activePartPath); } catch {}
              }
              reject(err);
            });
          }
        );

        req.on('error', (err) => {
          // If already completed or redirecting, ignore spurious errors
          if (task.status === 'completed' || task.status === 'canceled') return;
          task.status = 'error';
          task.error = err.message;
          if (activeFileStream && activePartPath) {
            try { activeFileStream.close(); } catch {}
            try { fs.unlinkSync(activePartPath); } catch {}
          }
          reject(err);
        });

        req.end();
      };

      followAndDownload(parsed.toString());
    });
  }

  public getActiveDownloads(): CivitaiDownloadTask[] {
    return Array.from(this.activeDownloads.values());
  }

  public cancelDownload(idOrTaskId: string): boolean {
    for (const [id, task] of this.activeDownloads.entries()) {
      if (id === idOrTaskId || task.taskId === idOrTaskId || task.id === idOrTaskId) {
        task.status = 'canceled';
        return true;
      }
    }
    return false;
  }

  /**
   * Scans local model directories for installed CivitAI models and LoRAs.
   */
  public listInstalledModels(): CivitaiInstalledModel[] {
    const results: CivitaiInstalledModel[] = [];
    const scanDirs: Array<{ dir: string; type: 'lora' | 'checkpoint' | 'other' }> = [
      { dir: path.resolve(this.baseDir, 'models', 'loras'), type: 'lora' },
      { dir: path.resolve(this.baseDir, 'models', 'checkpoints'), type: 'checkpoint' },
      { dir: path.resolve(this.baseDir, 'models', 'civitai'), type: 'other' },
      { dir: path.resolve(this.baseDir, 'models'), type: 'other' },
    ];

    const seenPaths = new Set<string>();

    for (const { dir, type } of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.endsWith('.safetensors') || f.endsWith('.pt') || f.endsWith('.bin')) {
            const fullPath = path.join(dir, f);
            if (seenPaths.has(fullPath)) continue;
            seenPaths.add(fullPath);

            const stat = fs.statSync(fullPath);
            let metadata: any = undefined;

            // Check for sidecar JSON (.safetensors.civitai.info or .civitai.info)
            const sidecar1 = `${fullPath}.civitai.info`;
            const sidecar2 = `${fullPath.replace(/\.[^.]+$/, '')}.civitai.info`;
            const sidecar = fs.existsSync(sidecar1) ? sidecar1 : (fs.existsSync(sidecar2) ? sidecar2 : null);
            if (sidecar) {
              try {
                metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
              } catch {}
            }

            results.push({
              filename: f,
              type: metadata?.type ? (metadata.type.toLowerCase().includes('lora') ? 'lora' : 'checkpoint') : type,
              sizeBytes: stat.size,
              sizeMB: Math.round((stat.size / (1024 * 1024)) * 10) / 10,
              modifiedAt: stat.mtimeMs,
              fullPath,
              metadata,
            });
          }
        }
      } catch {}
    }

    return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  public deleteModel(filename: string): boolean {
    const installed = this.listInstalledModels();
    const target = installed.find((m) => m.filename.toLowerCase() === filename.toLowerCase());
    if (target && fs.existsSync(target.fullPath)) {
      try {
        fs.unlinkSync(target.fullPath);
        const sidecar = `${target.fullPath}.civitai.info`;
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        return true;
      } catch (e) {
        console.error('[CivitaiService] Error deleting file:', e);
        return false;
      }
    }
    return false;
  }
}
