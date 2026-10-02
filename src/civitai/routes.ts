import type { FastifyInstance } from 'fastify';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { CivitaiService } from './civitai-service.js';

export function registerCivitaiRoutes(app: FastifyInstance, civitaiService: CivitaiService) {
  // 1. Get Models from CivitAI with rich filters
  app.get<{
    Querystring: {
      q?: string;
      tag?: string;
      type?: string;
      sort?: string;
      period?: string;
      baseModel?: string;
      nsfw?: string;
      page?: string;
      limit?: string;
    };
  }>('/v1/civitai/models', async (req, reply) => {
    try {
      const data = await civitaiService.listModels({
        query: req.query.q,
        tag: req.query.tag,
        type: req.query.type,
        sort: req.query.sort,
        period: req.query.period,
        baseModel: req.query.baseModel,
        nsfw: req.query.nsfw === 'true',
        page: req.query.page ? parseInt(req.query.page, 10) : 1,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 24,
      });
      return reply.send({ success: true, ...data });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 2. Get Model Details by ID
  app.get<{ Params: { id: string } }>('/v1/civitai/models/:id', async (req, reply) => {
    try {
      const data = await civitaiService.getModel(req.params.id);
      return reply.send({ success: true, model: data });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 3. List Installed CivitAI Models & LoRAs
  app.get('/v1/civitai/installed', async (_req, reply) => {
    try {
      const installed = civitaiService.listInstalledModels();
      return reply.send({ success: true, count: installed.length, models: installed });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Start Streaming Model / LoRA Download
  app.post<{
    Body: {
      modelId: number;
      versionId: number;
      fileId?: number;
      modelName: string;
      type: string;
      baseModel?: string;
      trainedWords?: string[];
      previewUrl?: string;
    };
  }>('/v1/civitai/download', async (req, reply) => {
    try {
      const result = await civitaiService.startDownload(req.body);
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Active Downloads Status
  app.get('/v1/civitai/download/status', async (_req, reply) => {
    const downloads = civitaiService.getActiveDownloads();
    return reply.send({ success: true, downloads });
  });

  // 6. Cancel Active Download
  app.post<{ Body: { taskId?: string; id?: string } }>('/v1/civitai/download/cancel', async (req, reply) => {
    const targetId = req.body?.taskId || req.body?.id || '';
    const ok = civitaiService.cancelDownload(targetId);
    return reply.send({ success: ok });
  });

  // 7. Delete Installed Model
  app.post<{ Body: { filename: string } }>('/v1/civitai/delete', async (req, reply) => {
    const ok = civitaiService.deleteModel(req.body?.filename);
    return reply.send({ success: ok });
  });

  // 8. VPN & CivitAI Region Check
  app.get('/v1/civitai/vpn/status', async (_req, reply) => {
    try {
      const status = await civitaiService.checkVpnStatus();
      return reply.send({ success: true, ...status });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 8b. Get Current VPN / Proxy Config
  app.get('/v1/civitai/vpn/config', async (_req, reply) => {
    try {
      civitaiService.loadConfig();
      return reply.send({ success: true, config: civitaiService.getPublicConfig() });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 9. Save VPN / SOCKS5 / HTTP Proxy Config
  app.post<{
    Body: {
      enabled: boolean;
      type: 'socks5' | 'http';
      host: string;
      port: number;
      username?: string;
      password?: string;
      civitaiApiKey?: string;
    };
  }>('/v1/civitai/vpn/config', async (req, reply) => {
    try {
      const saved = civitaiService.saveConfig(req.body);
      return reply.send({ success: true, config: saved });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 10. Test VPN / SOCKS5 Proxy Connection
  app.post<{
    Body: {
      enabled: boolean;
      type: 'socks5' | 'http';
      host: string;
      port: number;
      username?: string;
      password?: string;
    };
  }>('/v1/civitai/vpn/test', async (req, reply) => {
    try {
      const type = req.body?.type || 'socks5';
      const host = req.body?.host?.trim();
      const port = Number(req.body?.port) || 1080;
      const username = req.body?.username?.trim();
      let password = req.body?.password?.trim();

      if (!password || password.includes('•') || password === '••••••••') {
        const saved = civitaiService.loadConfig();
        if (saved.password && (!username || username === saved.username)) {
          password = saved.password;
        }
      }

      if (!host) {
        return reply.status(400).send({ success: false, error: 'Proxy host is required.' });
      }

      if (type === 'socks5' && (!username || !password)) {
        return reply.status(400).send({
          success: false,
          error: 'NordVPN SOCKS5 requires Service Credentials. Please enter your username and password (found in Nord Account > Services > NordVPN > Manual Setup, NOT your Nord email).'
        });
      }

      const testResult = await civitaiService.checkVpnStatus({
        enabled: true,
        type,
        host,
        port,
        username,
        password,
      });
      return reply.send({ success: true, ...testResult });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 11. Open Models Folder in Explorer
  app.route({
    method: ['GET', 'POST'],
    url: '/v1/civitai/open-folder',
    handler: async (_req, reply) => {
      try {
        const modelsDir = path.resolve(process.cwd(), 'models');
        if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
        const normPath = path.normalize(modelsDir);
        if (process.platform === 'win32') {
          spawn('explorer.exe', [normPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [normPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [normPath], { detached: true, stdio: 'ignore' }).unref();
        }
        return reply.send({ success: true, path: normPath });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    },
  });
}
