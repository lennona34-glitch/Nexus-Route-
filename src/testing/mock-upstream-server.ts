import http from 'node:http';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export type ChaosHangup = 'none' | 'before_headers' | 'after_headers' | 'mid_stream';
export type ChaosCorrupt = 'none' | 'bad_json' | 'malformed_sse';

export interface MockChaosConfig {
  defaultStatus: number;
  delayMs: number;
  hangup: ChaosHangup;
  corrupt: ChaosCorrupt;
  retryAfterSeconds?: number;
  contextExceeded?: boolean;
  failNTimesThenSucceed?: number;
  customErrorMessage?: string;
}

export interface RecordedRequest {
  id: string;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  timestamp: number;
}

export const DEFAULT_CHAOS_CONFIG: MockChaosConfig = {
  defaultStatus: 200,
  delayMs: 0,
  hangup: 'none',
  corrupt: 'none',
};

export class MockUpstreamServer {
  private server: http.Server | null = null;
  private port: number;
  private address: string = '127.0.0.1';
  private chaos: MockChaosConfig = { ...DEFAULT_CHAOS_CONFIG };
  private requestLog: RecordedRequest[] = [];
  private activeSockets = new Set<import('node:net').Socket>();
  private failureCounter = 0;
  private verbose = false;

  constructor(options: { port?: number; verbose?: boolean } = {}) {
    this.port = options.port ?? 0;
    this.verbose = options.verbose ?? false;
  }

  get url(): string {
    if (!this.server || !this.server.listening) {
      throw new Error('MockUpstreamServer is not running. Call start() first.');
    }
    const addr = this.server.address() as AddressInfo;
    return `http://${this.address}:${addr.port}`;
  }

  setChaos(config: Partial<MockChaosConfig>): void {
    this.chaos = { ...this.chaos, ...config };
  }

  reset(): void {
    this.chaos = { ...DEFAULT_CHAOS_CONFIG };
    this.requestLog = [];
    this.failureCounter = 0;
  }

  getRequests(): RecordedRequest[] {
    return [...this.requestLog];
  }

  async start(port?: number): Promise<string> {
    if (port !== undefined) {
      this.port = port;
    }

    if (this.server && this.server.listening) {
      return this.url;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => this.activeSockets.delete(socket));
      });

      this.server.on('error', (err) => {
        if (this.verbose) console.error('[MockUpstream] Server error:', err);
        reject(err);
      });

      this.server.listen(this.port, this.address, () => {
        const addr = this.server!.address() as AddressInfo;
        if (this.verbose) {
          console.log(`[MockUpstream] Listening on http://${this.address}:${addr.port}`);
        }
        resolve(`http://${this.address}:${addr.port}`);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ _raw: raw });
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const body = await this.parseBody(req);

    const recorded: RecordedRequest = {
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method: req.method || 'GET',
      path: pathname,
      headers: req.headers,
      body,
      timestamp: Date.now(),
    };
    this.requestLog.push(recorded);

    // Mock Control endpoints for direct testing inspection
    if (pathname === '/mock-control/chaos' && req.method === 'POST') {
      this.setChaos(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', chaos: this.chaos }));
      return;
    }

    if (pathname === '/mock-control/history' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.requestLog));
      return;
    }

    if (pathname === '/mock-control/history' && req.method === 'DELETE') {
      this.requestLog = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'cleared' }));
      return;
    }

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mock: true }));
      return;
    }

    // Determine request-level chaos overrides from headers
    const statusHeader = req.headers['x-mock-status'];
    const hangupHeader = req.headers['x-mock-hangup'] as ChaosHangup | undefined;
    const corruptHeader = req.headers['x-mock-corrupt'] as ChaosCorrupt | undefined;
    const delayHeader = req.headers['x-mock-delay'];
    const retryAfterHeader = req.headers['x-mock-retry-after'];
    const failTimesHeader = req.headers['x-mock-fail-times'];

    const targetStatus = statusHeader ? Number(statusHeader) : this.chaos.defaultStatus;
    const hangup = hangupHeader || this.chaos.hangup;
    const corrupt = corruptHeader || this.chaos.corrupt;
    const delayMs = delayHeader ? Number(delayHeader) : this.chaos.delayMs;
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : this.chaos.retryAfterSeconds;
    const failTimes = failTimesHeader ? Number(failTimesHeader) : (this.chaos.failNTimesThenSucceed ?? 0);

    // 1. Immediate socket hangup before headers
    if (hangup === 'before_headers') {
      req.socket.destroy();
      return;
    }

    // 2. Artificial latency simulation
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // 3. Fail N times then succeed logic
    if (failTimes > 0 && this.failureCounter < failTimes) {
      this.failureCounter++;
      const failStatus = targetStatus >= 400 ? targetStatus : 503;
      res.writeHead(failStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Temporary simulated upstream failure (${this.failureCounter}/${failTimes})`,
          type: 'upstream_transient_error',
          code: failStatus,
        },
      }));
      return;
    }

    // 4. Corrupt Non-JSON response
    if (corrupt === 'bad_json') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('<<<BAD_CORRUPT_NOT_JSON_BODY>>>');
      return;
    }

    // 5. Explicit error status simulation (e.g. 500, 502, 503, 429, 401, 400)
    if (targetStatus >= 400 && !(failTimes > 0 && this.failureCounter >= failTimes)) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (retryAfter) {
        headers['retry-after'] = String(retryAfter);
      }
      res.writeHead(targetStatus, headers);

      let errorMessage = this.chaos.customErrorMessage || `Upstream simulated HTTP ${targetStatus} error`;
      let errorCode: string | number = targetStatus;

      if (targetStatus === 429) {
        errorMessage = 'Rate limit exceeded: quota depleted or RPM exceeded';
        errorCode = 'rate_limit_exceeded';
      } else if (targetStatus === 400 && this.chaos.contextExceeded) {
        errorMessage = 'context_length_exceeded: maximum context length is 4096 tokens, but your request has 9999 tokens';
        errorCode = 'context_window_exceeded';
      } else if (targetStatus === 401) {
        errorMessage = 'Incorrect API key provided or unauthorized';
        errorCode = 'invalid_api_key';
      }

      res.end(JSON.stringify({
        error: {
          message: errorMessage,
          type: targetStatus >= 500 ? 'server_error' : 'invalid_request_error',
          code: errorCode,
        },
      }));
      return;
    }

    // 6. Socket hangup immediately after sending status headers
    if (hangup === 'after_headers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders?.();
      req.socket.destroy();
      return;
    }

    // Models endpoint
    if (pathname === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-gpt-4o', object: 'model', owned_by: 'mock-upstream' },
          { id: 'mock-claude-3-5-sonnet', object: 'model', owned_by: 'mock-upstream' },
          { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
          { id: 'claude-3-5-sonnet-20241022', object: 'model', owned_by: 'anthropic' },
        ],
      }));
      return;
    }

    // OpenAI Chat Completions Endpoint
    if (pathname.endsWith('/chat/completions') && req.method === 'POST') {
      const isStream = body.stream === true;
      const model = body.model || 'mock-gpt-4o';
      const userText = Array.isArray(body.messages)
        ? body.messages[body.messages.length - 1]?.content || 'Hello'
        : 'Hello';

      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-mock-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `Mock upstream received prompt: "${typeof userText === 'string' ? userText.slice(0, 100) : 'input'}"`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 18, completion_tokens: 28, total_tokens: 46 },
        }));
        return;
      }

      // Streaming SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const chunks = [
        `Mock `,
        `streaming `,
        `reply `,
        `to: "${typeof userText === 'string' ? userText.slice(0, 40) : 'prompt'}"`,
      ];

      for (let i = 0; i < chunks.length; i++) {
        // Chaos: Mid-stream socket destruction
        if (hangup === 'mid_stream' && i === 2) {
          req.socket.destroy();
          return;
        }

        // Chaos: Malformed SSE line
        if (corrupt === 'malformed_sse' && i === 1) {
          res.write('data: {"choices":[{"delta":{"content": "corrupt"}\n\n'); // missing closing bracket
        } else {
          const sseData = {
            id: `chatcmpl-mock-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: chunks[i] },
                finish_reason: i === chunks.length - 1 ? 'stop' : null,
              },
            ],
            usage: i === chunks.length - 1 ? { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } : undefined,
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }

        // Slight gap between chunks
        await new Promise((r) => setTimeout(r, 20));
      }

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Anthropic Messages Endpoint
    if (pathname.endsWith('/messages') && req.method === 'POST') {
      const isStream = body.stream === true;
      const model = body.model || 'claude-3-5-sonnet-20241022';

      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `msg_mock_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [
            {
              type: 'text',
              text: 'Mock Anthropic upstream response verified.',
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 25, output_tokens: 45 },
        }));
        return;
      }

      // Anthropic SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: `msg_mock_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      })}\n\n`);

      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`);

      if (hangup === 'mid_stream') {
        req.socket.destroy();
        return;
      }

      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Anthropic streaming content chunk from mock upstream.' },
      })}\n\n`);

      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 30 },
      })}\n\n`);

      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }

    // Default 404 for unmapped endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Not found: ${pathname}`, type: 'invalid_request_error' } }));
  }
}

// Standalone execution runner
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_PORT || 4040);
  const mockServer = new MockUpstreamServer({ port, verbose: true });
  mockServer.start().then((url) => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║        NEXUSROUTE MOCK UPSTREAM EXTERNAL API SERVER              ║
╠══════════════════════════════════════════════════════════════════╣
║  Running on: ${url.padEnd(51)}║
║                                                                  ║
║  Supported Protocols:                                            ║
║    - OpenAI Chat:      POST /v1/chat/completions (Stream + JSON) ║
║    - Anthropic Native: POST /v1/messages         (Stream + JSON) ║
║    - Models Catalog:   GET  /v1/models                           ║
║    - Chaos Control:    POST /mock-control/chaos                  ║
║                                                                  ║
║  To route NexusRoute traffic to this mock server:                ║
║    $env:OPENAI_BASE_URL = "${url}/v1"                     ║
║    $env:ANTHROPIC_BASE_URL = "${url}/v1"                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
  }).catch((err) => {
    console.error('Failed to start mock upstream server:', err);
    process.exit(1);
  });
}
