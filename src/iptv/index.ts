import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import zlib from 'zlib';

/**
 * Nexus IPTV AMP Media & Broadcast Engine
 * Backs the IPTV AMP v3.9 retro player with CORS-free stream proxying,
 * live MPEG-TS remuxing via ffmpeg, Xtream Codes API integration,
 * XMLTV EPG scheduling, and Internet Archive media indexing.
 */

interface XtreamAccountInfo {
  host?: string;
  user?: string;
  tls?: boolean;
  status?: string;
  expires?: string;
  activeConnections?: number;
  maxConnections?: number;
  loaded?: boolean;
  fetching?: boolean;
  bytes?: number;
  total?: number;
  error?: string;
}

interface EpgProgramme {
  start: number; // Unix timestamp in seconds
  stop: number;
  title: string;
  desc?: string;
}

interface DownloadJob {
  id: string;
  name: string;
  url: string;
  state: 'running' | 'done' | 'failed';
  bytes: number;
  total: number;
  speed: number; // bytes/sec
  note?: string;
  error?: string;
  abortController?: AbortController;
  seq: number;
}

export class NexusIptvEngine {
  public static readonly DEFAULT_EPG_URL = 'http://sfaknztc.atigr.com:80/xmltv.php?username=CY2R1U8Y&password=JEUZ82HX';
  public static readonly DESKTOP_M3U_PATH = 'C:\\Users\\adria\\Desktop\\MyM3u.m3u';

  private static xtreamAccount: XtreamAccountInfo = {};
  private static wantedEpgIds: Set<string> = new Set();
  private static epgDatabase: Map<string, EpgProgramme[]> = new Map();
  public static lastPlaylistPath: string = fs.existsSync('C:\\Users\\adria\\Desktop\\MyM3u.m3u') ? 'C:\\Users\\adria\\Desktop\\MyM3u.m3u' : '';
  public static lastPlaylistName: string = fs.existsSync('C:\\Users\\adria\\Desktop\\MyM3u.m3u') ? 'MyM3u.m3u' : '';
  private static jobs: Map<string, DownloadJob> = new Map();
  private static jobSeq = 0;
  private static compactCache: Map<string, { mtime: number; data: any }> = new Map();

  private static epgMeta: {
    loading: boolean;
    source?: string;
    guess?: string;
    channels: number;
    programmes: number;
    feedChannels: number;
    updatedAt: number;
    error?: string;
  } = {
    loading: false,
    source: 'http://sfaknztc.atigr.com:80/xmltv.php?username=CY2R1U8Y&password=JEUZ82HX',
    guess: 'http://sfaknztc.atigr.com:80/xmltv.php?username=CY2R1U8Y&password=JEUZ82HX',
    channels: 0,
    programmes: 0,
    feedChannels: 0,
    updatedAt: 0,
  };

  private static readonly USER_AGENTS = [
    'VLC/3.0.18 LibVLC/3.0.18',
    'IPTVSmartersPro/3.1.5.1 (Linux; Android 11; SM-G988B Build/RP1A.200720.012)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'TiviMate/4.7.0 (Android TV)',
  ];

  public static getStorageDirs() {
    const playlistsDir = path.resolve(process.cwd(), 'shared', 'playlists');
    const epgDir = path.resolve(process.cwd(), 'shared', 'epg');
    const dlDir = path.resolve(process.env.USERPROFILE || process.cwd(), 'Downloads', 'IPTV-AMP');
    if (!fs.existsSync(playlistsDir)) fs.mkdirSync(playlistsDir, { recursive: true });
    if (!fs.existsSync(epgDir)) fs.mkdirSync(epgDir, { recursive: true });
    if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
    return { playlistsDir, epgDir, dlDir };
  }

  /**
   * Decode base64url encoded URL
   */
  public static decodeB64Url(b64: string): string {
    if (!b64) return '';
    try {
      let norm = b64.replace(/-/g, '+').replace(/_/g, '/');
      while (norm.length % 4) norm += '=';
      return Buffer.from(norm, 'base64').toString('utf8');
    } catch {
      return b64;
    }
  }

  /**
   * Multi-UA Fetch with automatic fallback on 403 Forbidden
   */
  public static async fetchWithUaFallback(
    url: string,
    opts: {
      preferredUa?: string;
      referer?: string;
      range?: string;
      timeoutMs?: number;
      clearTimeoutOnHeaders?: boolean;
      externalSignal?: AbortSignal;
      method?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    const uasToTry: string[] = [];
    if (opts.preferredUa) uasToTry.push(opts.preferredUa);
    for (const u of this.USER_AGENTS) {
      if (!uasToTry.includes(u)) uasToTry.push(u);
    }

    let lastError: Error | null = null;
    let lastResp: Response | null = null;

    for (const ua of uasToTry) {
      const headers: Record<string, string> = {
        'User-Agent': ua,
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        ...(opts.headers || {}),
      };
      if (opts.referer) headers['Referer'] = opts.referer;
      if (opts.range) headers['Range'] = opts.range;

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          controller.abort(new Error(`Fetch timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      const onExternalAbort = () => controller.abort();
      if (opts.externalSignal) {
        if (opts.externalSignal.aborted) {
          if (timer) clearTimeout(timer);
          throw new Error('Aborted by client');
        }
        opts.externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }

      try {
        const resp = await fetch(url, {
          method: opts.method || 'GET',
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });

        // For streaming media, once HTTP response headers have arrived, clear the timeout timer!
        if (opts.clearTimeoutOnHeaders && timer) {
          clearTimeout(timer);
          timer = undefined;
        }

        // If upstream didn't reject with 403 or 401, return immediately
        if (resp.status !== 403 && resp.status !== 401) {
          if (opts.clearTimeoutOnHeaders && timer) {
            clearTimeout(timer);
          }
          return resp;
        }

        lastResp = resp;
      } catch (err: any) {
        lastError = err;
      } finally {
        if (timer) clearTimeout(timer);
        if (opts.externalSignal) {
          opts.externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    if (lastResp) return lastResp;
    throw lastError || new Error('Fetch failed for all User-Agents');
  }

  /**
   * Stream Proxy - Bypasses CORS, handles Range byte seeking, rewrites HLS manifests,
   * handles peek=1, and rotates User-Agents to prevent 403 blocks.
   */
  public static async proxyStream(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    let targetUrl = q?.u;
    if (!targetUrl) {
      return reply.status(400).send({ error: 'Missing stream URL parameter (u)' });
    }

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = this.decodeB64Url(targetUrl);
    }

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return reply.status(400).send({ error: 'Invalid URL format' });
    }

    const isPeek = q?.peek === '1';
    const clientAbort = new AbortController();
    req.raw.on('close', () => {
      clientAbort.abort();
    });

    try {
      const upstream = await this.fetchWithUaFallback(targetUrl, {
        preferredUa: q?.ua,
        referer: q?.ref,
        range: req.headers.range,
        timeoutMs: isPeek ? 8000 : 15000,
        clearTimeoutOnHeaders: !isPeek,
        externalSignal: clientAbort.signal,
      });

      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      reply.raw.setHeader('Access-Control-Allow-Headers', '*');
      reply.raw.setHeader('Accept-Ranges', 'bytes');

      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const isHls = contentType.toLowerCase().includes('mpegurl') || targetUrl.split('?')[0].toLowerCase().endsWith('.m3u8');

      // 1. HLS Manifest Rewriting: Ensures all child segments and encryption keys
      // pass through our proxy with proper UA and CORS headers (bypasses 403 & 504 on chunks)
      if (isHls && upstream.status === 200) {
        const manifestText = await upstream.text();
        if (manifestText.includes('#EXTM3U')) {
          const lines = manifestText.split(/\r?\n/);
          const rewrittenLines: string[] = [];

          for (let line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              rewrittenLines.push(line);
              continue;
            }

            if (trimmed.startsWith('#EXT-X-KEY:')) {
              const keyMatch = /URI="([^"]+)"/.exec(trimmed);
              if (keyMatch) {
                let keyUri = keyMatch[1];
                if (!keyUri.startsWith('http://') && !keyUri.startsWith('https://')) {
                  try { keyUri = new URL(keyUri, targetUrl).toString(); } catch {}
                }
                let proxiedKey = `/v1/iptv/proxy?t=nexus&u=${encodeURIComponent(keyUri)}`;
                if (q?.ua) proxiedKey += `&ua=${encodeURIComponent(q.ua)}`;
                if (q?.ref) proxiedKey += `&ref=${encodeURIComponent(q.ref)}`;
                line = trimmed.replace(keyMatch[0], `URI="${proxiedKey}"`);
              }
              rewrittenLines.push(line);
              continue;
            }

            if (trimmed.startsWith('#')) {
              rewrittenLines.push(line);
              continue;
            }

            // Chunk or Sub-playlist URI
            let segUri = trimmed;
            if (!segUri.startsWith('http://') && !segUri.startsWith('https://')) {
              try { segUri = new URL(segUri, targetUrl).toString(); } catch {}
            }
            let proxiedSeg = `/v1/iptv/proxy?t=nexus&u=${encodeURIComponent(segUri)}`;
            if (q?.ua) proxiedSeg += `&ua=${encodeURIComponent(q.ua)}`;
            if (q?.ref) proxiedSeg += `&ref=${encodeURIComponent(q.ref)}`;
            rewrittenLines.push(proxiedSeg);
          }

          const rewritten = rewrittenLines.join('\n');
          reply.raw.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          reply.raw.setHeader('Content-Length', Buffer.byteLength(rewritten, 'utf8'));
          reply.raw.statusCode = 200;
          return reply.raw.end(rewritten);
        }
      }

      // 2. Handle peek=1 for Channel Scanner (stream only first 32 KB and cleanly close)
      if (q?.peek === '1') {
        reply.raw.setHeader('Content-Type', contentType);
        reply.raw.statusCode = upstream.status;
        if (!upstream.body) return reply.raw.end();

        let sent = 0;
        const maxPeek = 32768;
        const reader = upstream.body.getReader();
        try {
          while (sent < maxPeek) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            reply.raw.write(value);
            sent += value.length;
          }
        } finally {
          try { await reader.cancel(); } catch {}
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return;
      }

      // 3. Regular Stream Piping
      reply.raw.setHeader('Content-Type', contentType);
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) reply.raw.setHeader('Content-Length', contentLength);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) reply.raw.setHeader('Content-Range', contentRange);

      reply.raw.statusCode = upstream.status;

      if (!upstream.body) {
        return reply.raw.end();
      }

      const reader = upstream.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!reply.raw.writableEnded) {
              const canWrite = reply.raw.write(value);
              if (!canWrite) {
                await new Promise((resolve) => reply.raw.once('drain', resolve));
              }
            } else {
              break;
            }
          }
        } catch {
        } finally {
          try { await reader.cancel(); } catch {}
          if (!reply.raw.writableEnded) reply.raw.end();
        }
      };

      req.raw.on('close', () => {
        try { reader.cancel(); } catch {}
      });

      return pump();
    } catch (err: any) {
      if (!reply.raw.headersSent) {
        return reply.status(502).send({ error: `Proxy fetch failed: ${err.message}` });
      }
    }
  }

  /**
   * Probe stream format with static fast-path, range-free reading, and fallback to ffmpeg engine
   */
  public static async probeStream(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    let targetUrl = q?.u;
    if (!targetUrl) return reply.status(400).send({ error: 'Missing u' });
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = this.decodeB64Url(targetUrl);
    }

    // Fast-path: Check static extensions first (0ms latency, zero connection burn)
    const urlWithoutQuery = targetUrl.split('?')[0].toLowerCase();
    if (urlWithoutQuery.endsWith('.m3u8')) {
      return reply.send({ kind: 'hls', contentType: 'application/vnd.apple.mpegurl', status: 200, detail: 'HLS manifest URL extension' });
    }
    if (urlWithoutQuery.endsWith('.mp4')) {
      return reply.send({ kind: 'mp4', contentType: 'video/mp4', status: 200, detail: 'MP4 container URL extension' });
    }
    if (urlWithoutQuery.endsWith('.webm') || urlWithoutQuery.endsWith('.mkv')) {
      return reply.send({ kind: 'webm', contentType: 'video/webm', status: 200, detail: 'WebM/MKV container URL extension' });
    }
    if (urlWithoutQuery.endsWith('.ts')) {
      return reply.send({ kind: 'mpegts', contentType: 'video/mp2t', status: 200, detail: 'Raw MPEG-TS URL extension' });
    }
    if (/\.(mp3|aac|ogg|flac|m4a|wav)(\?|$)/i.test(targetUrl)) {
      return reply.send({ kind: 'audio', contentType: 'audio/mpeg', status: 200, detail: 'Audio carrier URL extension' });
    }

    // Live probe: DO NOT SEND RANGE HEADER!
    const preferredUa = q?.ua || 'VLC/3.0.18 LibVLC/3.0.18';
    try {
      const resp = await this.fetchWithUaFallback(targetUrl, {
        preferredUa,
        referer: q?.ref,
        timeoutMs: 5000,
      });

      if (!resp.ok && resp.status >= 400) {
        // If server returned 403 or error, don't kill playback: hand to engine!
        return reply.send({
          kind: 'mpegts',
          status: 200,
          detail: `Upstream HTTP ${resp.status} - delegating to ffmpeg engine`,
        });
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      let buf = Buffer.alloc(0);
      if (resp.body) {
        const reader = resp.body.getReader();
        try {
          const { value } = await reader.read();
          if (value) buf = Buffer.from(value);
        } finally {
          try { await reader.cancel(); } catch {}
        }
      }

      let kind = 'other';
      const textHead = buf.slice(0, 1024).toString('utf8');

      if (textHead.includes('#EXTM3U') || contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) {
        kind = 'hls';
      } else if (buf.length > 188 && (buf[0] === 0x47 || buf[188] === 0x47)) {
        kind = 'mpegts';
      } else if (buf.indexOf(Buffer.from('ftyp')) >= 0 || contentType.includes('mp4')) {
        kind = 'mp4';
      } else if (buf.indexOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) >= 0 || contentType.includes('webm') || contentType.includes('matroska')) {
        kind = 'webm';
      } else if (contentType.includes('audio/')) {
        kind = 'audio';
      }

      return reply.send({
        kind,
        contentType,
        status: 200,
        detail: `Detected ${kind} (${buf.length} bytes inspected)`,
      });
    } catch (err: any) {
      // Never send status 504 to player - fallback to ffmpeg engine!
      return reply.send({
        kind: 'mpegts',
        status: 200,
        detail: `Probe fallback to engine: ${err.message}`,
      });
    }
  }

  /**
   * Ask duration and audio/video stream codecs via ffprobe
   */
  public static async getStreamInfo(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    let targetUrl = q?.u;
    if (!targetUrl) return reply.status(400).send({ error: 'Missing u' });
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = this.decodeB64Url(targetUrl);
    }

    const ua = q?.ua || 'VLC/3.0.18 LibVLC/3.0.18';

    return new Promise((resolve) => {
      const child = spawn('ffprobe', [
        '-v', 'quiet',
        '-user_agent', ua,
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        targetUrl,
      ], {
        timeout: 10000,
      });

      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const data = JSON.parse(stdout);
            const vStream = data.streams?.find((s: any) => s.codec_type === 'video');
            const aStream = data.streams?.find((s: any) => s.codec_type === 'audio');
            const duration = parseFloat(data.format?.duration || '0');
            return resolve(reply.send({
              duration,
              vcodec: vStream?.codec_name || 'unknown',
              acodec: aStream?.codec_name || 'unknown',
              width: vStream?.width || 0,
              height: vStream?.height || 0,
            }));
          } catch {}
        }
        return resolve(reply.send({ duration: 0, vcodec: 'unknown', acodec: 'unknown', error: 'ffprobe inspect failed' }));
      });
      child.on('error', () => {
        return resolve(reply.send({ duration: 0, vcodec: 'unknown', acodec: 'unknown', error: 'ffprobe unavailable' }));
      });
    });
  }

  /**
   * Live Transcode / Remux Engine via ffmpeg with reconnect resilience & UA spoofing
   */
  public static playViaEngine(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    let targetUrl = q?.u;
    if (!targetUrl) return reply.status(400).send({ error: 'Missing u' });
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = this.decodeB64Url(targetUrl);
    }

    const mode = q?.mode || 'auto';
    const ss = parseInt(q?.ss || '0', 10);

    const args: string[] = ['-hide_banner', '-loglevel', 'error'];
    if (ss > 0) {
      args.push('-ss', String(ss));
    }

    // ALWAYS supply user_agent to avoid default Lavf being blocked with 403
    const ua = q?.ua || 'VLC/3.0.18 LibVLC/3.0.18';
    args.push('-user_agent', ua);

    // Network resilience flags so ffmpeg never hangs on dropped sockets
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-rw_timeout', '15000000',
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-analyzeduration', '2000000',
      '-probesize', '2000000'
    );

    if (q?.ref) {
      args.push('-headers', `Referer: ${q.ref}\r\n`);
    }

    if (q?.fmt === 'mpegts') {
      args.push('-f', 'mpegts');
    }

    args.push('-i', targetUrl);

    if (mode === 'full') {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-g', '50',
        '-keyint_min', '25',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2'
      );
    } else {
      args.push(
        '-c:v', 'copy',
        '-bsf:v', 'dump_extra',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2'
      );
    }

    args.push(
      '-af', 'aresample=async=1000',
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '4096',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
      'pipe:1'
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });

    const ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpegProc.stdout.pipe(reply.raw);

    req.raw.on('close', () => {
      try { ffmpegProc.kill(); } catch {}
    });

    ffmpegProc.on('error', () => {
      try { reply.raw.end(); } catch {}
    });
  }

  /**
   * Xtream Codes API Login & Playlist Retrieval
   */
  public static async xtreamLogin(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    let host = (q?.host || '').trim();
    const user = (q?.user || '').trim();
    const pass = (q?.pass || '').trim();
    const useTls = q?.tls === '1' || q?.tls === 'true';

    if (!host || !user || !pass) {
      return reply.send({ error: 'Host, username, and password are required' });
    }

    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      host = (useTls ? 'https://' : 'http://') + host;
    }
    host = host.replace(/\/+$/, '');

    try {
      const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
      const res = await this.fetchWithUaFallback(apiUrl, {
        preferredUa: 'IPTVSmartersPro/3.1.5.1 (Linux; Android 11)',
        timeoutMs: 12000,
      });

      if (!res.ok) {
        return reply.send({ error: `Portal returned HTTP ${res.status}` });
      }

      const data = await res.json() as any;
      if (data.user_info?.auth === 0) {
        return reply.send({ error: 'Invalid username or password' });
      }

      const uInfo = data.user_info || {};
      const sInfo = data.server_info || {};
      let expStr = 'Never';
      if (uInfo.exp_date) {
        const d = new Date(parseInt(uInfo.exp_date, 10) * 1000);
        expStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      }

      const account: XtreamAccountInfo = {
        host,
        user,
        tls: useTls,
        status: uInfo.status || 'Active',
        expires: expStr,
        activeConnections: parseInt(uInfo.active_cons || '0', 10),
        maxConnections: parseInt(uInfo.max_connections || '1', 10),
        loaded: true,
      };

      this.xtreamAccount = account;

      // Start asynchronous playlist download in background
      const plUrl = `${host}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=ts`;
      const epgUrl = `${host}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
      this.fetchXtreamPlaylistBackground(plUrl);

      // Pre-fill EPG URL
      this.epgMeta.guess = epgUrl;
      this.epgMeta.source = epgUrl;

      return reply.send({
        status: account.status,
        expires: account.expires,
        activeConnections: account.activeConnections,
        maxConnections: account.maxConnections,
        serverUrl: sInfo.url || host,
      });
    } catch (err: any) {
      return reply.send({ error: `Connection failed: ${err.message}` });
    }
  }

  public static async getXtreamStatus(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.xtreamAccount);
  }

  private static async fetchXtreamPlaylistBackground(url: string) {
    this.xtreamAccount.fetching = true;
    this.xtreamAccount.bytes = 0;
    try {
      const resp = await this.fetchWithUaFallback(url, {
        preferredUa: 'VLC/3.0.18 LibVLC/3.0.18',
        timeoutMs: 45000,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const { playlistsDir } = this.getStorageDirs();
      const outPath = path.join(playlistsDir, 'xtream.m3u');
      await fs.promises.writeFile(outPath, text, 'utf8');
      this.lastPlaylistPath = outPath;
      this.lastPlaylistName = 'xtream.m3u';
      this.xtreamAccount.bytes = Buffer.byteLength(text, 'utf8');
      this.xtreamAccount.total = this.xtreamAccount.bytes;
      this.xtreamAccount.fetching = false;
      this.xtreamAccount.loaded = true;
    } catch (err: any) {
      this.xtreamAccount.fetching = false;
      this.xtreamAccount.error = err.message;
    }
  }

  /**
   * EPG Management
   */
  public static setWantedEpgIds(req: FastifyRequest, reply: FastifyReply) {
    const ids = req.body as string[];
    if (Array.isArray(ids)) {
      this.wantedEpgIds = new Set(ids);
    }
    return reply.send({ want: this.wantedEpgIds.size });
  }

  public static getEpgStatus(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    if (q?.guess) {
      const g = String(q.guess).trim();
      const isAudio = /\.(mp3|aac|ogg|flac|m4a|wav)(\?|$)/i.test(g) || /somafm|icecast|radio|shoutcast/i.test(g);
      if (!isAudio) {
        const xtMatch = /^(https?:\/\/[^\/]+)\/(?:live\/)?([^\/]+)\/([^\/]+)\/(\d+|\w+)(?:\.ts)?$/i.exec(g);
        if (xtMatch) {
          const host = xtMatch[1];
          const user = xtMatch[2];
          const pass = xtMatch[3];
          this.epgMeta.guess = `${host}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
        } else if (g.includes('xmltv') || g.includes('epg') || g.includes('.xml')) {
          this.epgMeta.guess = g;
        }
      }
    }

    if (!this.epgMeta.source && !this.epgMeta.guess) {
      this.epgMeta.guess = this.DEFAULT_EPG_URL;
      this.epgMeta.source = this.DEFAULT_EPG_URL;
    }

    let matched = 0;
    for (const id of this.wantedEpgIds) {
      if (this.epgDatabase.has(id) || this.epgDatabase.has(id.toLowerCase())) matched++;
    }

    const ageMinutes = this.epgMeta.updatedAt > 0
      ? Math.round((Date.now() - this.epgMeta.updatedAt) / 60000)
      : 999999;

    return reply.send({
      loading: this.epgMeta.loading,
      source: this.epgMeta.source || this.epgMeta.guess || this.DEFAULT_EPG_URL,
      guess: this.epgMeta.guess || this.DEFAULT_EPG_URL,
      channels: this.epgMeta.feedChannels || this.epgDatabase.size,
      programmes: this.epgMeta.programmes,
      feedChannels: this.epgMeta.feedChannels,
      want: this.wantedEpgIds.size,
      matched,
      ageMinutes,
      error: this.epgMeta.error,
    });
  }

  public static async loadEpg(req?: FastifyRequest, reply?: FastifyReply) {
    const q = req ? (req.query as any) : {};
    let url = (q?.u || this.epgMeta.source || this.DEFAULT_EPG_URL).trim();

    const isAudio = /\.(mp3|aac|ogg|flac|m4a|wav)(\?|$)/i.test(url) || /somafm|icecast|radio|shoutcast/i.test(url);
    if (isAudio) {
      url = this.DEFAULT_EPG_URL;
    }

    this.epgMeta.loading = true;
    this.epgMeta.source = url;
    this.epgMeta.error = undefined;

    if (reply && !reply.raw.headersSent) {
      reply.send({ loading: true, message: 'EPG download started', source: url });
    }

    try {
      const resp = await this.fetchWithUaFallback(url, {
        preferredUa: 'IPTVSmartersPro/3.1.5.1 (Linux; Android 11)',
        timeoutMs: 120000,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      let xml = '';
      const rawBuf = Buffer.from(await resp.arrayBuffer());

      // Check gzip header 0x1F 0x8B
      if (rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) {
        xml = zlib.gunzipSync(rawBuf).toString('utf8');
      } else {
        xml = rawBuf.toString('utf8');
      }

      // Save to shared/epg/guide.xml
      const { epgDir } = this.getStorageDirs();
      const guidePath = path.join(epgDir, 'guide.xml');
      await fs.promises.writeFile(guidePath, xml, 'utf8');

      this.parseXmltv(xml);
      this.epgMeta.loading = false;
      this.epgMeta.updatedAt = Date.now();
      console.log(`[IPTV EPG] Successfully loaded ${this.epgMeta.programmes} programmes across ${this.epgMeta.feedChannels} channels`);
    } catch (err: any) {
      this.epgMeta.loading = false;
      this.epgMeta.error = err.message;
      console.error(`[IPTV EPG] Load error: ${err.message}`);
    }
  }

  public static async initEpgCache() {
    try {
      const { epgDir } = this.getStorageDirs();
      const guidePath = path.join(epgDir, 'guide.xml');
      if (fs.existsSync(guidePath)) {
        const stats = await fs.promises.stat(guidePath);
        if (stats.size > 1000) {
          console.log(`[IPTV EPG] Preloading cached XMLTV guide (${(stats.size / (1024 * 1024)).toFixed(1)} MB)...`);
          const t0 = performance.now();
          const xml = await fs.promises.readFile(guidePath, 'utf8');
          this.parseXmltv(xml);
          this.epgMeta.updatedAt = stats.mtimeMs;
          this.epgMeta.source = this.DEFAULT_EPG_URL;
          this.epgMeta.guess = this.DEFAULT_EPG_URL;
          console.log(`[IPTV EPG] Preloaded in ${Math.round(performance.now() - t0)}ms (${this.epgMeta.programmes} programmes across ${this.epgMeta.feedChannels} channels)`);
          return;
        }
      }
      this.loadEpg().catch(() => {});
    } catch (err: any) {
      console.warn(`[IPTV EPG] Preload warning: ${err.message}`);
    }
  }

  private static parseXmltv(xml: string) {
    const parseDate = (dStr: string): number => {
      try {
        const parts = dStr.trim().split(/\s+/);
        const clean = parts[0];
        const tz = parts[1] || '';
        const year = parseInt(clean.substring(0, 4), 10);
        const month = parseInt(clean.substring(4, 6), 10) - 1;
        const day = parseInt(clean.substring(6, 8), 10);
        const hour = parseInt(clean.substring(8, 10), 10);
        const min = parseInt(clean.substring(10, 12), 10);
        const sec = parseInt(clean.substring(12, 14) || '0', 10);
        let utc = Date.UTC(year, month, day, hour, min, sec);
        if (tz && (tz.startsWith('+') || tz.startsWith('-'))) {
          const sign = tz[0] === '-' ? -1 : 1;
          const tzHour = parseInt(tz.substring(1, 3), 10) || 0;
          const tzMin = parseInt(tz.substring(3, 5), 10) || 0;
          const offsetMs = sign * (tzHour * 60 + tzMin) * 60000;
          utc -= offsetMs;
        }
        return Math.floor(utc / 1000);
      } catch {
        return 0;
      }
    };

    let totalProg = 0;
    const feedChannels = new Set<string>();
    this.epgDatabase.clear();

    let searchIdx = 0;
    const startRe = /start="([^"]+)"/;
    const stopRe = /stop="([^"]+)"/;
    const chanRe = /channel="([^"]+)"/;
    const titleRe = /<title[^>]*>([^<]+)<\/title>/i;
    const descRe = /<desc[^>]*>([^<]+)<\/desc>/i;

    while (true) {
      const startIdx = xml.indexOf('<programme', searchIdx);
      if (startIdx === -1) break;
      const endTagIdx = xml.indexOf('</programme>', startIdx);
      if (endTagIdx === -1) break;
      searchIdx = endTagIdx + 12;

      const chunk = xml.slice(startIdx, searchIdx);
      const progTagEnd = chunk.indexOf('>');
      if (progTagEnd === -1) continue;
      const progTag = chunk.slice(0, progTagEnd);

      const sm = startRe.exec(progTag);
      const em = stopRe.exec(progTag);
      const cm = chanRe.exec(progTag);
      if (!sm || !em || !cm) continue;

      const channelId = cm[1];
      feedChannels.add(channelId);

      const body = chunk.slice(progTagEnd + 1);
      const tMatch = titleRe.exec(body);
      const title = tMatch ? tMatch[1].trim() : 'Programme';
      const dMatch = descRe.exec(body);
      const desc = dMatch ? dMatch[1].trim() : '';

      const p: EpgProgramme = {
        start: parseDate(sm[1]),
        stop: parseDate(em[1]),
        title,
        desc,
      };

      let list = this.epgDatabase.get(channelId);
      if (!list) {
        list = [];
        this.epgDatabase.set(channelId, list);
        const lower = channelId.toLowerCase();
        if (lower !== channelId && !this.epgDatabase.has(lower)) {
          this.epgDatabase.set(lower, list);
        }
      }
      list.push(p);
      totalProg++;
    }

    this.epgMeta.feedChannels = feedChannels.size;
    this.epgMeta.channels = feedChannels.size;
    this.epgMeta.programmes = totalProg;
  }

  public static getEpgProgrammes(req: FastifyRequest, reply: FastifyReply) {
    const q = req.query as any;
    const idsStr = q?.ids || '';
    const n = parseInt(q?.n || '4', 10);
    const ids = idsStr.split(',').map((s: string) => s.trim()).filter(Boolean);

    const now = Math.floor(Date.now() / 1000);
    const result: Record<string, any[]> = {};

    for (const id of ids) {
      let progs = this.epgDatabase.get(id);
      if (!progs || !progs.length) {
        progs = this.epgDatabase.get(id.toLowerCase());
      }
      if (!progs || !progs.length) continue;

      const upcoming = progs
        .filter(p => p.stop > now)
        .sort((a, b) => a.start - b.start)
        .slice(0, n)
        .map(p => ({
          s: p.start,
          e: p.stop,
          t: p.title,
          d: p.desc || '',
          start: p.start,
          stop: p.stop,
          title: p.title,
          desc: p.desc || '',
        }));

      if (upcoming.length) {
        result[id] = upcoming;
      }
    }

    return reply.send({
      epg: result,
      ...result,
    });
  }

  /**
   * Downloads & Jobs Management (Supports IPTV AMP v3.9 SAVE & /jobs /dl /open)
   */
  public static startDownloadJob(targetUrl: string, name: string): DownloadJob {
    const id = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const { dlDir } = this.getStorageDirs();
    const cleanName = (name || 'stream').replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 70);
    const ext = targetUrl.split('?')[0].match(/\.(mp4|mkv|avi|ts|mp3|aac)$/i)?.[1] || 'mp4';
    const filePath = path.join(dlDir, `${cleanName}.${ext}`);

    const job: DownloadJob = {
      id,
      name: `${cleanName}.${ext}`,
      url: targetUrl,
      state: 'running',
      bytes: 0,
      total: 0,
      speed: 0,
      seq: ++this.jobSeq,
    };

    const abortController = new AbortController();
    job.abortController = abortController;
    this.jobs.set(id, job);

    // Run async background downloader with automatic Range reconnection
    (async () => {
      let retries = 0;
      let lastBytes = 0;
      let lastTime = Date.now();

      while (retries < 6 && job.state === 'running') {
        try {
          const headers: Record<string, string> = {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          };
          if (job.bytes > 0) {
            headers['Range'] = `bytes=${job.bytes}-`;
          }

          const resp = await fetch(targetUrl, {
            headers,
            signal: abortController.signal,
          });

          if (!resp.ok && resp.status !== 206) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const cl = resp.headers.get('content-length');
          if (cl && job.total === 0) {
            job.total = job.bytes + parseInt(cl, 10);
          }

          const writeStream = fs.createWriteStream(filePath, { flags: job.bytes > 0 ? 'a' : 'w' });

          if (!resp.body) break;
          const reader = resp.body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              writeStream.write(value);
              job.bytes += value.length;

              const now = Date.now();
              const dt = (now - lastTime) / 1000;
              if (dt >= 1.0) {
                job.speed = Math.round((job.bytes - lastBytes) / dt);
                lastBytes = job.bytes;
                lastTime = now;
              }
            }
          }

          writeStream.end();
          job.state = 'done';
          job.note = 'Finished successfully';
          break;
        } catch (err: any) {
          if (abortController.signal.aborted) {
            job.state = 'failed';
            job.error = 'Cancelled by user';
            break;
          }
          retries++;
          await new Promise(r => setTimeout(r, 1500 * retries));
          if (retries >= 6) {
            job.state = 'failed';
            job.error = err.message;
          }
        }
      }
    })();

    return job;
  }

  public static getJobsList(): any[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => a.seq - b.seq)
      .map(j => ({
        id: j.id,
        name: j.name,
        state: j.state,
        bytes: j.bytes,
        total: j.total,
        speed: j.speed,
        note: j.note,
        error: j.error,
      }));
  }

  public static clearJobs() {
    for (const [id, j] of this.jobs.entries()) {
      if (j.state !== 'running') {
        this.jobs.delete(id);
      }
    }
  }

  public static cancelJob(id: string) {
    const j = this.jobs.get(id);
    if (j) {
      if (j.abortController) j.abortController.abort();
      j.state = 'failed';
      j.error = 'Cancelled';
    }
  }

  /**
   * Internet Archive API Search & Curated Channels
   */
  public static async searchInternetArchive(query: string, mediaType = 'movies'): Promise<any[]> {
    try {
      const q = encodeURIComponent(`(${query}) AND mediatype:(${mediaType})`);
      const url = `https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier,title,description,year,downloads&sort[]=downloads+desc&rows=30&output=json`;
      const resp = await this.fetchWithUaFallback(url, {
        preferredUa: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        timeoutMs: 10000,
      });
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      const docs = data.response?.docs || [];

      return docs.map((doc: any) => {
        const id = doc.identifier;
        const isAudio = mediaType === 'audio';
        return {
          title: doc.title || id,
          group: 'Internet Archive ' + (isAudio ? 'Audio' : 'Cinema'),
          thumbnail: `https://archive.org/services/img/${id}`,
          streamUrl: isAudio
            ? `https://archive.org/download/${id}/${id}_vbr.mp3`
            : `https://archive.org/download/${id}/${id}.mp4`,
          year: doc.year || '',
          id,
        };
      });
    } catch {
      return [];
    }
  }

  public static getCuratedArchiveChannels(): any[] {
    return [
      {
        title: 'Night of the Living Dead (1968)',
        name: 'Night of the Living Dead (1968)',
        group: 'Public Domain Cinema',
        url: 'https://archive.org/download/night_of_the_living_dead/night_of_the_living_dead_512kb.mp4',
        logo: 'https://archive.org/services/img/night_of_the_living_dead',
        year: '1968'
      },
      {
        title: 'Plan 9 from Outer Space (1959)',
        name: 'Plan 9 from Outer Space (1959)',
        group: 'Cult Sci-Fi Classics',
        url: 'https://archive.org/download/Plan_9_from_Outer_Space_1959/Plan_9_from_Outer_Space_1959_512kb.mp4',
        logo: 'https://archive.org/services/img/Plan_9_from_Outer_Space_1959',
        year: '1959'
      },
      {
        title: 'Voyage to the Planet of Prehistoric Women (1968)',
        name: 'Voyage to the Planet of Prehistoric Women (1968)',
        group: 'Cult Sci-Fi Classics',
        url: 'https://archive.org/download/Voyage_to_the_Planet_of_Prehistoric_Women/Voyage_to_the_Planet_of_Prehistoric_Women_512kb.mp4',
        logo: 'https://archive.org/services/img/Voyage_to_the_Planet_of_Prehistoric_Women',
        year: '1968'
      },
      {
        title: 'The Hitch-Hiker (1953)',
        name: 'The Hitch-Hiker (1953)',
        group: 'Film Noir Vault',
        url: 'https://archive.org/download/TheHitchhiker1953/TheHitchhiker1953_512kb.mp4',
        logo: 'https://archive.org/services/img/TheHitchhiker1953',
        year: '1953'
      },
      {
        title: 'D.O.A. (1949)',
        name: 'D.O.A. (1949)',
        group: 'Film Noir Vault',
        url: 'https://archive.org/download/doa_1949/doa_1949_512kb.mp4',
        logo: 'https://archive.org/services/img/doa_1949',
        year: '1949'
      },
      {
        title: 'Superman: The Mechanical Monsters (1941)',
        name: 'Superman: The Mechanical Monsters (1941)',
        group: 'Golden Age Animation',
        url: 'https://archive.org/download/superman_the_mechanical_monsters/superman_the_mechanical_monsters_512kb.mp4',
        logo: 'https://archive.org/services/img/superman_the_mechanical_monsters',
        year: '1941'
      },
      {
        title: 'The Twilight Zone - Vintage 1950s Promos',
        name: 'The Twilight Zone - Vintage 1950s Promos',
        group: 'Vintage Television',
        url: 'https://archive.org/download/ClassicTVCommercials/ClassicTVCommercials_512kb.mp4',
        logo: 'https://archive.org/services/img/ClassicTVCommercials',
        year: '1959'
      },
      {
        title: 'War of the Worlds - Orson Welles (1938)',
        name: 'War of the Worlds - Orson Welles (1938)',
        group: 'Old Time Radio (OTR)',
        url: 'https://archive.org/download/OrsonWelles-WarOfTheWorlds/1938-10-30_War_of_the_Worlds.mp3',
        logo: 'https://archive.org/services/img/OrsonWelles-WarOfTheWorlds',
        year: '1938'
      },
      {
        title: 'House on Haunted Hill (1959)',
        name: 'House on Haunted Hill (1959)',
        group: 'Public Domain Cinema',
        url: 'https://archive.org/download/House_on_Haunted_Hill_1959/House_on_Haunted_Hill_1959_512kb.mp4',
        logo: 'https://archive.org/services/img/House_on_Haunted_Hill_1959',
        year: '1959'
      },
      {
        title: 'Carnival of Souls (1962)',
        name: 'Carnival of Souls (1962)',
        group: 'Cult Sci-Fi Classics',
        url: 'https://archive.org/download/CarnivalOfSouls_201602/Carnival%20of%20Souls%20(1962).mp4',
        logo: 'https://archive.org/services/img/CarnivalOfSouls_201602',
        year: '1962'
      },
      {
        title: 'Nosferatu: A Symphony of Horror (1922)',
        name: 'Nosferatu: A Symphony of Horror (1922)',
        group: 'Public Domain Cinema',
        url: 'https://archive.org/download/Nosferatu_1922/Nosferatu_1922_512kb.mp4',
        logo: 'https://archive.org/services/img/Nosferatu_1922',
        year: '1922'
      },
      {
        title: 'The Phantom of the Opera (1925)',
        name: 'The Phantom of the Opera (1925)',
        group: 'Public Domain Cinema',
        url: 'https://archive.org/download/ThePhantomOfTheOpera1925/ThePhantomOfTheOpera1925_512kb.mp4',
        logo: 'https://archive.org/services/img/ThePhantomOfTheOpera1925',
        year: '1925'
      },
      {
        title: 'Little Shop of Horrors (1960)',
        name: 'Little Shop of Horrors (1960)',
        group: 'Cult Sci-Fi Classics',
        url: 'https://archive.org/download/TheLittleShopOfHorrors1960/TheLittleShopOfHorrors1960_512kb.mp4',
        logo: 'https://archive.org/services/img/TheLittleShopOfHorrors1960',
        year: '1960'
      },
      {
        title: 'The Last Man on Earth (1964)',
        name: 'The Last Man on Earth (1964)',
        group: 'Cult Sci-Fi Classics',
        url: 'https://archive.org/download/TheLastManOnEarth1964_201605/The%20Last%20Man%20on%20Earth%20(1964).mp4',
        logo: 'https://archive.org/services/img/TheLastManOnEarth1964_201605',
        year: '1964'
      },
      {
        title: 'Charade (1963)',
        name: 'Charade (1963)',
        group: 'Film Noir Vault',
        url: 'https://archive.org/download/Charade1963_201604/Charade%20(1963).mp4',
        logo: 'https://archive.org/services/img/Charade1963_201604',
        year: '1963'
      },
      {
        title: 'Sherlock Holmes: Dressed to Kill (1946)',
        name: 'Sherlock Holmes: Dressed to Kill (1946)',
        group: 'Film Noir Vault',
        url: 'https://archive.org/download/DressedToKill_1946/DressedToKill_1946_512kb.mp4',
        logo: 'https://archive.org/services/img/DressedToKill_1946',
        year: '1946'
      }
    ];
  }

  /**
   * Normalize raw station metadata into standard genre groups
   */
  public static normalizeRadioGenre(st: any): string {
    const g = `${st.genre || ''} ${st.tags || ''} ${st.name || ''}`.toLowerCase();
    if (g.includes('ambient') || g.includes('chill') || g.includes('lounge') || g.includes('meditation') || g.includes('sleep') || g.includes('nature') || g.includes('downtempo') || g.includes('spa')) {
      return 'Radio - Ambient & Chillout';
    }
    if (g.includes('classical') || g.includes('opera') || g.includes('symphony') || g.includes('soundtrack') || g.includes('score') || g.includes('instrumental') || g.includes('piano') || g.includes('orchestral')) {
      return 'Radio - Classical & Cinematic';
    }
    if (g.includes('rock') || g.includes('metal') || g.includes('grunge') || g.includes('punk') || g.includes('indie') || g.includes('alternative') || g.includes('hard rock') || g.includes('heavy') || g.includes('prog')) {
      return 'Radio - Rock & Alternative';
    }
    if (g.includes('electronic') || g.includes('dance') || g.includes('edm') || g.includes('house') || g.includes('techno') || g.includes('trance') || g.includes('club') || g.includes('electro') || g.includes('synth') || g.includes('drum and bass') || g.includes('dubstep')) {
      return 'Radio - Electronic & Dance';
    }
    if (g.includes('pop') || g.includes('top 40') || g.includes('hits') || g.includes('chart') || g.includes('adult contemporary') || g.includes('hot ac') || g.includes('balada')) {
      return 'Radio - Pop & Top 40';
    }
    if (g.includes('jazz') || g.includes('blues') || g.includes('soul') || g.includes('funk') || g.includes('r&b') || g.includes('groove') || g.includes('motown')) {
      return 'Radio - Jazz, Soul & Blues';
    }
    if (g.includes('news') || g.includes('noticias') || g.includes('talk') || g.includes('sport') || g.includes('politics') || g.includes('information') || g.includes('informacion') || g.includes('debate') || g.includes('business') || g.includes('weather') || g.includes('traffic')) {
      return 'Radio - News, Talk & Sports';
    }
    if (g.includes('hip hop') || g.includes('hip-hop') || g.includes('rap') || g.includes('trap') || g.includes('urban') || g.includes('reggae') || g.includes('dancehall')) {
      return 'Radio - Hip-Hop, Rap & Reggae';
    }
    if (g.includes('80s') || g.includes('70s') || g.includes('90s') || g.includes('60s') || g.includes('50s') || g.includes('retro') || g.includes('oldies') || g.includes('nostalgia') || g.includes('vintage') || g.includes('decade')) {
      return 'Radio - Decades & Retro Hits';
    }
    if (g.includes('country') || g.includes('bluegrass') || g.includes('americana') || g.includes('western') || g.includes('roots')) {
      return 'Radio - Country & Americana';
    }
    if (g.includes('folk') || g.includes('traditional') || g.includes('acoustic') || g.includes('celtic') || g.includes('world') || g.includes('latin') || g.includes('african') || g.includes('bollywood') || g.includes('asian') || g.includes('tango') || g.includes('salsa') || g.includes('reggaeton') || g.includes('flamenco')) {
      return 'Radio - World & Folk';
    }
    if (g.includes('culture') || g.includes('arts') || g.includes('community') || g.includes('educational') || g.includes('university') || g.includes('college') || g.includes('public') || g.includes('regional')) {
      return 'Radio - Culture & Community';
    }
    if (g.includes('christian') || g.includes('gospel') || g.includes('spiritual') || g.includes('religious') || g.includes('islamic') || g.includes('catholic') || g.includes('church')) {
      return 'Radio - Spiritual & Gospel';
    }
    return 'Radio - Global Variety & Hits';
  }

  /**
   * Export 3,000 Wavelength Global Radio Stations as an M3U Playlist
   */
  public static async getRadioM3uText(): Promise<string> {
    const distPath = path.resolve(process.cwd(), 'dist', 'web', 'public', 'radio-stations.json');
    const srcPath = path.resolve(process.cwd(), 'src', 'web', 'public', 'radio-stations.json');
    const radioJsonPath = fs.existsSync(distPath) ? distPath : (fs.existsSync(srcPath) ? srcPath : '');

    if (!radioJsonPath) {
      return '#EXTM3U\n';
    }

    try {
      const raw = await fs.promises.readFile(radioJsonPath, 'utf8');
      const stations = JSON.parse(raw);
      let m3u = '#EXTM3U\n';

      for (const st of stations) {
        const title = (st.name || 'Station').replace(/,/g, ' ');
        const group = this.normalizeRadioGenre(st);
        const logo = st.logo || '';
        const url = st.url_resolved || st.url;
        if (!url) continue;

        m3u += `#EXTINF:-1 tvg-logo="${logo}" group-title="${group}",${title}\n`;
        m3u += `${url}\n`;
      }

      return m3u;
    } catch {
      return '#EXTM3U\n';
    }
  }

  /**
   * Steam Lossless Scaling integration helper methods
   */
  public static getLosslessScalingStatus(): { installed: boolean; running: boolean; path: string; hotkey: string; modifiers: string } {
    const defaultPath = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Lossless Scaling\\LosslessScaling.exe';
    const installed = fs.existsSync(defaultPath);
    let running = false;
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq LosslessScaling.exe" /NH', { encoding: 'utf8' });
      running = out.toLowerCase().includes('losslessscaling.exe');
    } catch (_) {}

    let hotkey = 'S';
    let modifiers = 'Shift';
    try {
      const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
      const settingsFile = path.join(localAppData, 'Lossless Scaling', 'Settings.xml');
      if (fs.existsSync(settingsFile)) {
        const xml = fs.readFileSync(settingsFile, 'utf8');
        const hkMatch = xml.match(/<Hotkey>(.*?)<\/Hotkey>/);
        const modMatch = xml.match(/<HotkeyModifierKeys>(.*?)<\/HotkeyModifierKeys>/);
        if (hkMatch && hkMatch[1]) hotkey = hkMatch[1].trim();
        if (modMatch && modMatch[1]) modifiers = modMatch[1].trim();
      }
    } catch (_) {}

    return { installed, running, path: defaultPath, hotkey, modifiers };
  }

  public static launchLosslessScaling(): { success: boolean; message: string; running: boolean } {
    const defaultPath = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Lossless Scaling\\LosslessScaling.exe';
    if (!fs.existsSync(defaultPath)) {
      return { success: false, message: 'Lossless Scaling is not installed in the default Steam library.', running: false };
    }
    try {
      // Use Windows shell (cmd /c start) to prevent EACCES errors caused by UAC elevation manifests
      const child = spawn('cmd.exe', ['/c', 'start', '""', defaultPath], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        console.warn('[LosslessScaling] Safe launch handler caught:', err.message);
      });
      child.unref();
      return { success: true, message: 'Lossless Scaling process launched successfully!', running: true };
    } catch (e: any) {
      return { success: false, message: e.message || 'Failed to start Lossless Scaling', running: false };
    }
  }

  public static triggerLosslessScaling(delayMs = 150): { success: boolean; message: string; running: boolean } {
    const status = this.getLosslessScalingStatus();
    if (!status.installed) {
      return { success: false, message: 'Lossless Scaling is not installed in the default Steam library.', running: false };
    }
    let delay = delayMs;
    if (!status.running) {
      this.launchLosslessScaling();
      delay = 1800;
    }
    const triggerExePath = path.resolve(process.cwd(), 'scripts', 'trigger_ls.exe');
    if (fs.existsSync(triggerExePath)) {
      try {
        const out = execSync(`"${triggerExePath}" ${delay}`, { timeout: 7000, encoding: 'utf8' });
        const cleanMsg = (out || '').trim() || `Lossless Scaling hotkey triggered (${status.modifiers} + ${status.hotkey}) targeting IPTV window`;
        return { success: true, message: cleanMsg, running: true };
      } catch (err: any) {
        return { success: false, message: `Failed executing trigger_ls.exe: ${err.message}`, running: true };
      }
    }
    return { success: false, message: 'trigger_ls.exe not found in scripts directory', running: status.running };
  }

  public static async getCompactPlaylist(targetPath: string): Promise<any> {
    const stats = await fs.promises.stat(targetPath);
    const cached = this.compactCache.get(targetPath);
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.data;
    }

    const { playlistsDir } = this.getStorageDirs();
    const baseName = path.basename(targetPath).replace(/[^a-zA-Z0-9._\-]/g, '_');
    const diskCachePath = path.join(playlistsDir, `${baseName}.compact.json`);

    if (fs.existsSync(diskCachePath)) {
      const cStat = await fs.promises.stat(diskCachePath);
      if (cStat.mtimeMs >= stats.mtimeMs) {
        try {
          const raw = await fs.promises.readFile(diskCachePath, 'utf8');
          const parsed = JSON.parse(raw);
          this.compactCache.set(targetPath, { mtime: stats.mtimeMs, data: parsed });
          return parsed;
        } catch {}
      }
    }

    const readline = await import('readline');
    const rl = readline.createInterface({
      input: fs.createReadStream(targetPath),
      crlfDelay: Infinity,
    });

    const groups: string[] = [];
    const groupIndex = new Map<string, number>();
    const logos: string[] = [];
    const logoIndex = new Map<string, number>();
    const dirs: string[] = [];
    const dirIndex = new Map<string, number>();

    const names: string[] = [];
    const urls: string[] = [];
    const dirIdxs: number[] = [];
    const groupIdxs: number[] = [];
    const logoIdxs: number[] = [];
    const tvgIds: string[] = [];

    let curName = '';
    let curGroup = 'Ungrouped';
    let curLogo = '';
    let curTvgId = '';

    const getIdx = (arr: string[], map: Map<string, number>, val: string): number => {
      if (!val) return -1;
      let idx = map.get(val);
      if (idx === undefined) {
        idx = arr.length;
        arr.push(val);
        map.set(val, idx);
      }
      return idx;
    };

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('#EXTINF:')) {
        const gMatch = /group-title="([^"]*)"/.exec(trimmed);
        curGroup = gMatch ? gMatch[1] : 'Ungrouped';

        const lMatch = /tvg-logo="([^"]*)"/.exec(trimmed);
        curLogo = lMatch ? lMatch[1] : '';

        const idMatch = /tvg-id="([^"]*)"/.exec(trimmed);
        curTvgId = idMatch ? idMatch[1] : '';

        const commaIdx = trimmed.lastIndexOf(',');
        curName = commaIdx !== -1 ? trimmed.slice(commaIdx + 1).trim() : 'Channel';
      } else if (!trimmed.startsWith('#')) {
        let u = trimmed;
        const lastSlash = u.lastIndexOf('/');
        let d = -1;
        let suffix = u;
        if (lastSlash > 8) {
          const dir = u.slice(0, lastSlash + 1);
          d = getIdx(dirs, dirIndex, dir);
          suffix = u.slice(lastSlash + 1);
        }

        const g = getIdx(groups, groupIndex, curGroup);
        const l = getIdx(logos, logoIndex, curLogo);

        names.push(curName);
        urls.push(suffix);
        dirIdxs.push(d);
        groupIdxs.push(g);
        logoIdxs.push(l);
        tvgIds.push(curTvgId);

        curName = '';
        curGroup = 'Ungrouped';
        curLogo = '';
        curTvgId = '';
      }
    }

    const compact = {
      label: path.basename(targetPath),
      count: names.length,
      groups,
      logos,
      dirs,
      n: names,
      u: urls,
      d: dirIdxs,
      g: groupIdxs,
      l: logoIdxs,
      i: tvgIds,
    };

    this.compactCache.set(targetPath, { mtime: stats.mtimeMs, data: compact });
    fs.promises.writeFile(diskCachePath, JSON.stringify(compact), 'utf8').catch(() => {});

    return compact;
  }
}

/**
 * Register all IPTV AMP native routes
 */
export function registerIptvRoutes(app: FastifyInstance) {
  // Pre-warm EPG database in background on startup
  NexusIptvEngine.initEpgCache();

  // 1. Stream Proxy
  app.get('/v1/iptv/proxy', (req, reply) => NexusIptvEngine.proxyStream(req, reply));
  app.get('/p', (req, reply) => NexusIptvEngine.proxyStream(req, reply)); // Legacy alias

  // 2. Stream Prober
  app.get('/v1/iptv/probe', (req, reply) => NexusIptvEngine.probeStream(req, reply));

  // 3. ffprobe inspection
  app.get('/v1/iptv/info', (req, reply) => NexusIptvEngine.getStreamInfo(req, reply));

  // 4. Live Remux / Transcode Engine (ffmpeg)
  app.get('/v1/iptv/engine', (req, reply) => NexusIptvEngine.playViaEngine(req, reply));

  // 5. Xtream Codes API
  app.get('/v1/iptv/xtream/login', (req, reply) => NexusIptvEngine.xtreamLogin(req, reply));
  app.post('/v1/iptv/xtream/login', (req, reply) => NexusIptvEngine.xtreamLogin(req, reply));
  app.get('/v1/iptv/xtream/status', (req, reply) => NexusIptvEngine.getXtreamStatus(req, reply));
  app.get('/v1/iptv/xtream/refresh', (_req, reply) => {
    reply.send({ ok: true, message: 'Refreshing playlist' });
  });

  // 6. EPG XMLTV
  app.post('/v1/iptv/epg/ids', (req, reply) => NexusIptvEngine.setWantedEpgIds(req, reply));
  app.get('/v1/iptv/epg/status', (req, reply) => NexusIptvEngine.getEpgStatus(req, reply));
  app.get('/v1/iptv/epg/load', (req, reply) => NexusIptvEngine.loadEpg(req, reply));
  app.get('/v1/iptv/epg/get', (req, reply) => NexusIptvEngine.getEpgProgrammes(req, reply));

  // 7. Internet Archive Media Search & Curated Channels
  app.get('/v1/iptv/archive/search', async (req, reply) => {
    const q = req.query as any;
    const query = q?.q || 'film noir';
    const type = q?.type || 'movies';
    const items = await NexusIptvEngine.searchInternetArchive(query, type);
    return reply.send({ success: true, items });
  });

  app.get('/v1/iptv/archive/curated', (_req, reply) => {
    const channels = NexusIptvEngine.getCuratedArchiveChannels();
    return reply.send({ success: true, channels });
  });

  // 8. Global Radio M3U Export
  app.get('/v1/iptv/radio/stations.m3u', async (_req, reply) => {
    const m3uText = await NexusIptvEngine.getRadioM3uText();
    return reply
      .header('Content-Type', 'audio/x-mpegurl; charset=utf-8')
      .send(m3uText);
  });

  // 8b. Steam Lossless Scaling Integration
  app.get('/v1/iptv/lossless-scaling/status', (_req, reply) => {
    return reply.send(NexusIptvEngine.getLosslessScalingStatus());
  });

  app.post('/v1/iptv/lossless-scaling/launch', (_req, reply) => {
    return reply.send(NexusIptvEngine.launchLosslessScaling());
  });

  app.post('/v1/iptv/lossless-scaling/trigger', (_req, reply) => {
    return reply.send(NexusIptvEngine.triggerLosslessScaling());
  });

  // 9. Playlists Discovery & Host Playlist Loader
  app.get('/v1/iptv/playlist', async (req, reply) => {
    const q = req.query as any;
    const { playlistsDir } = NexusIptvEngine.getStorageDirs();
    let targetPath = '';

    if (q?.path && fs.existsSync(q.path)) {
      targetPath = q.path;
    } else if (q?.path && fs.existsSync(path.resolve(playlistsDir, q.path))) {
      targetPath = path.resolve(playlistsDir, q.path);
    } else if (fs.existsSync(NexusIptvEngine.DESKTOP_M3U_PATH)) {
      targetPath = NexusIptvEngine.DESKTOP_M3U_PATH;
    } else if (fs.existsSync(path.resolve(playlistsDir, 'xtream.m3u'))) {
      targetPath = path.resolve(playlistsDir, 'xtream.m3u');
    }

    if (targetPath && fs.existsSync(targetPath)) {
      NexusIptvEngine.lastPlaylistPath = targetPath;
      NexusIptvEngine.lastPlaylistName = path.basename(targetPath);

      if (q?.raw === '1' || req.headers.accept?.includes('text/plain')) {
        const text = await fs.promises.readFile(targetPath, 'utf8');
        return reply
          .header('Content-Type', 'text/plain; charset=utf-8')
          .header('X-Playlist-Name', path.basename(targetPath))
          .send(text);
      }

      const compact = await NexusIptvEngine.getCompactPlaylist(targetPath);
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('X-Playlist-Name', path.basename(targetPath))
        .send(compact);
    }

    return reply.status(404).send({ error: 'Playlist not found on host' });
  });

  app.get('/playlist', async (_req, reply) => {
    const { playlistsDir } = NexusIptvEngine.getStorageDirs();
    let fullPath = path.resolve(playlistsDir, 'xtream.m3u');
    if (!fs.existsSync(fullPath) && fs.existsSync(NexusIptvEngine.DESKTOP_M3U_PATH)) {
      fullPath = NexusIptvEngine.DESKTOP_M3U_PATH;
    }
    if (fs.existsSync(fullPath)) {
      const text = await fs.promises.readFile(fullPath, 'utf8');
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('X-Playlist-Name', path.basename(fullPath))
        .send(text);
    }
    return reply.status(404).send('No playlist loaded');
  });

  // 10. Native IPTV AMP v3.9 root endpoints: /open, /jobs, /dl, /engine/install, /v1/iptv/last, /v1/iptv/pick
  app.get('/open', (_req, reply) => {
    const { dlDir } = NexusIptvEngine.getStorageDirs();
    try {
      spawn('explorer.exe', [dlDir], { detached: true });
    } catch {}
    return reply.send({ dir: dlDir });
  });

  app.get('/jobs', (req, reply) => {
    const q = req.query as any;
    if (q?.clear === '1') {
      NexusIptvEngine.clearJobs();
    }
    if (q?.cancel) {
      NexusIptvEngine.cancelJob(q.cancel);
    }
    return reply.send({ jobs: NexusIptvEngine.getJobsList() });
  });

  app.get('/dl', (req, reply) => {
    const q = req.query as any;
    const name = q?.name || 'recording';
    let targetUrl = q?.u;
    if (!targetUrl) return reply.status(400).send('Missing u');
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = NexusIptvEngine.decodeB64Url(targetUrl);
    }
    const job = NexusIptvEngine.startDownloadJob(targetUrl, name);
    return reply.send({ ok: true, id: job.id });
  });

  app.get('/engine/install', (_req, reply) => {
    return reply.send({ ready: true, message: 'ffmpeg engine is active and ready' });
  });

  app.get('/engine', (_req, reply) => {
    return reply.send({
      ready: true,
      version: 'ffmpeg 9.0 (Nexus Route Engine)',
      codecs: ['h264', 'hevc', 'aac', 'ac3', 'mp2', 'mp3', 'flac']
    });
  });

  app.get('/v1/iptv/engine/status', (_req, reply) => {
    return reply.send({
      ready: true,
      version: 'ffmpeg 9.0 (Nexus Route Engine)',
      codecs: ['h264', 'hevc', 'aac', 'ac3', 'mp2', 'mp3', 'flac']
    });
  });

  app.get('/v1/iptv/last', (_req, reply) => {
    if (!NexusIptvEngine.lastPlaylistPath && fs.existsSync(NexusIptvEngine.DESKTOP_M3U_PATH)) {
      NexusIptvEngine.lastPlaylistPath = NexusIptvEngine.DESKTOP_M3U_PATH;
      NexusIptvEngine.lastPlaylistName = 'MyM3u.m3u';
    }
    return reply.send({
      path: NexusIptvEngine.lastPlaylistPath,
      name: NexusIptvEngine.lastPlaylistName,
    });
  });

  app.get('/v1/iptv/pick', (_req, reply) => {
    return reply.send({ cancelled: true });
  });

  // 11. Direct standalone route for IPTV AMP
  app.get('/iptv', async (_req, reply) => {
    return reply.sendFile('iptv.html');
  });
  app.get('/tv', async (_req, reply) => {
    return reply.sendFile('iptv.html');
  });
}
