import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PageState {
  rafCount: number;
  errors: string[];
  canvasCount: number;
  visibleCanvasCount: number;
  startControlVisible: boolean;
  bodyText: string;
}

export interface HtmlRuntimeTestOptions {
  url: string;
  workspaceDir: string;
  startSelector?: string;
  waitAfterClickMs?: number;
}

export interface HtmlRuntimeTestResult {
  success: boolean;
  pageLoaded: boolean;
  clickedStart: boolean;
  clickTarget?: string;
  startInteraction: string;
  interactionVerified: boolean;
  screenshotChanged: boolean;
  animationFramesAfterClick: number;
  consoleErrors: string[];
  runtimeErrors: string[];
  screenshotPath?: string;
  absoluteScreenshotPath?: string;
  previewUrl?: string;
  before: PageState;
  after: PageState;
  guidance?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function findChromeExecutable(): string | null {
  const candidates = [
    process.env.NEXUS_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter((candidate): candidate is string => !!candidate);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

async function findFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForDebugTarget(port: number, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(750) });
      if (response.ok) {
        const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('Headless browser did not expose a debugging target in time.');
}

class CdpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private eventWaiters = new Map<string, Array<(params: any) => void>>();
  private eventHandlers: Array<(message: CdpMessage) => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(String(event.data)));
    socket.addEventListener('close', () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Headless browser connection closed.'));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to the headless browser.')), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to the headless browser.'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  private handleMessage(raw: string) {
    let message: CdpMessage;
    try { message = JSON.parse(raw) as CdpMessage; } catch { return; }
    if (message.id) {
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message || 'Browser command failed.'));
      else call.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.eventHandlers) handler(message);
      const waiters = this.eventWaiters.get(message.method) || [];
      this.eventWaiters.delete(message.method);
      waiters.forEach(resolve => resolve(message.params));
    }
  }

  onEvent(handler: (message: CdpMessage) => void) {
    this.eventHandlers.push(handler);
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<any> {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await response;
  }

  waitFor(method: string, timeoutMs = 8_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Browser event timed out: ${method}`)), timeoutMs);
      const wrapped = (params: any) => {
        clearTimeout(timer);
        resolve(params);
      };
      const current = this.eventWaiters.get(method) || [];
      current.push(wrapped);
      this.eventWaiters.set(method, current);
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

function cleanBrowserError(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function isSafeTemporaryProfile(profileDir: string): boolean {
  const resolved = path.resolve(profileDir);
  return path.dirname(resolved).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()
    && path.basename(resolved).startsWith('nexus-html-runtime-');
}

export async function testHtmlRuntime(options: HtmlRuntimeTestOptions): Promise<HtmlRuntimeTestResult> {
  const chromePath = findChromeExecutable();
  if (!chromePath) throw new Error('Chrome or Microsoft Edge was not found for HTML runtime testing.');

  const port = await findFreeLoopbackPort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-html-runtime-'));
  let browser: ChildProcess | undefined;
  let client: CdpClient | undefined;
  const consoleErrors: string[] = [];
  const runtimeErrors: string[] = [];

  try {
    browser = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=1280,900',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    const websocketUrl = await waitForDebugTarget(port);
    client = await CdpClient.connect(websocketUrl);
    client.onEvent(message => {
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params?.exceptionDetails;
        runtimeErrors.push(cleanBrowserError(detail?.exception?.description || detail?.text || 'Uncaught runtime exception'));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push(cleanBrowserError((message.params.args || []).map((arg: any) => arg.value ?? arg.description).join(' ')));
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        const entryUrl = String(message.params.entry.url || '');
        if (!/\/favicon\.ico(?:[?#]|$)/i.test(entryUrl)) {
          consoleErrors.push(cleanBrowserError(message.params.entry.text));
        }
      }
    });

    await Promise.all([
      client.call('Page.enable'),
      client.call('Runtime.enable'),
      client.call('Log.enable'),
    ]);
    await client.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const state = window.__nexusRuntime = { rafCount: 0, errors: [] };
        const nativeRaf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = callback => nativeRaf(timestamp => {
          state.rafCount++;
          return callback(timestamp);
        });
        addEventListener('error', event => state.errors.push(String(event.error?.stack || event.message || 'window error')));
        addEventListener('unhandledrejection', event => state.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
      })();`,
    });

    const loaded = client.waitFor('Page.loadEventFired', 10_000).then(() => true).catch(() => false);
    await client.call('Page.navigate', { url: options.url }, 10_000);
    const pageLoaded = await loaded;
    await delay(1_000);

    const readState = async (): Promise<PageState> => {
      const response = await client!.call('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const visible = element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
          };
          const starts = [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"],[id*="start" i],[class*="start" i],[id*="play" i],[class*="play" i]')]
            .filter(element => visible(element) && /start|play|begin|launch|insert coin|continue|mission/i.test(String(element.textContent || element.value || element.id || element.className)));
          const canvases = [...document.querySelectorAll('canvas')];
          return {
            rafCount: Number(window.__nexusRuntime?.rafCount || 0),
            errors: [...(window.__nexusRuntime?.errors || [])].map(String),
            canvasCount: canvases.length,
            visibleCanvasCount: canvases.filter(visible).length,
            startControlVisible: starts.length > 0,
            bodyText: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500)
          };
        })()`,
      });
      return response.result.value as PageState;
    };

    const capture = async () => {
      const result = await client!.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 10_000);
      return Buffer.from(String(result.data || ''), 'base64');
    };

    const before = await readState();
    const beforeImage = await capture();
    const selectorLiteral = JSON.stringify(options.startSelector || '');
    const candidate = await client.call('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const requested = ${selectorLiteral};
        const visible = element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const elements = requested
          ? [document.querySelector(requested)].filter(Boolean)
          : [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"],[id*="start" i],[class*="start" i],[id*="play" i],[class*="play" i]')];
        const element = elements.find(item => visible(item) && (requested || /start|play|begin|launch|insert coin|continue|mission/i.test(String(item.textContent || item.value || item.id || item.className))));
        if (!element) return { found: false };
        const rect = element.getBoundingClientRect();
        return {
          found: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          target: element.id ? '#' + element.id : String(element.textContent || element.value || element.tagName).trim().slice(0, 100)
        };
      })()`,
    });
    const click = candidate.result.value as { found: boolean; x?: number; y?: number; target?: string };
    let startInteraction = 'keyboard:Enter';
    if (click.found && Number.isFinite(click.x) && Number.isFinite(click.y)) {
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: click.x, y: click.y });
      await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: click.x, y: click.y, button: 'left', clickCount: 1 });
      await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: click.x, y: click.y, button: 'left', clickCount: 1 });
      startInteraction = `mouse:${click.target || 'start-control'}`;
    } else {
      // Canvas games often draw "Press Enter" rather than exposing a DOM
      // button. A real CDP key event exercises that start path.
      await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await delay(250);
    }
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await delay(250);
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });

    const waitAfterClickMs = Math.max(250, Math.min(5_000, Number(options.waitAfterClickMs) || 1_500));
    await delay(waitAfterClickMs);
    const after = await readState();
    const afterImage = await capture();
    const screenshotChanged = crypto.createHash('sha256').update(beforeImage).digest('hex')
      !== crypto.createHash('sha256').update(afterImage).digest('hex');
    const animationFramesAfterClick = Math.max(0, after.rafCount - before.rafCount);
    const allRuntimeErrors = [...new Set([...runtimeErrors, ...after.errors].filter(Boolean))];
    const allConsoleErrors = [...new Set(consoleErrors.filter(Boolean))];
    const interactionVerified = click.found
      ? (!after.startControlVisible || screenshotChanged || animationFramesAfterClick > 2)
      : (after.canvasCount > 0 && screenshotChanged && animationFramesAfterClick > 2);

    const screenshotDir = path.join(options.workspaceDir, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotName = `html_runtime_${Date.now()}.png`;
    const absoluteScreenshotPath = path.join(screenshotDir, screenshotName);
    fs.writeFileSync(absoluteScreenshotPath, afterImage);
    const screenshotPath = `screenshots/${screenshotName}`;
    const success = pageLoaded && allRuntimeErrors.length === 0 && allConsoleErrors.length === 0 && interactionVerified;

    return {
      success,
      pageLoaded,
      clickedStart: !!click.found,
      clickTarget: click.target,
      startInteraction,
      interactionVerified,
      screenshotChanged,
      animationFramesAfterClick,
      consoleErrors: allConsoleErrors,
      runtimeErrors: allRuntimeErrors,
      screenshotPath,
      absoluteScreenshotPath,
      previewUrl: `/v1/workspace/files/${screenshotPath}`,
      before,
      after,
      guidance: success
        ? 'The page loaded and continued running after the start interaction.'
        : click.found
          ? 'The start control was clicked, but runtime evidence or browser errors indicate the game needs repair.'
          : interactionVerified
            ? 'No DOM Start/Play control was exposed; the canvas game started through a real Enter key event and responded to gameplay input.'
            : 'No visible start/play control was found and the Enter-key fallback produced no gameplay evidence. Supply start_selector if the control uses unusual markup.',
    };
  } finally {
    client?.close();
    if (browser && !browser.killed) browser.kill();
    await delay(100);
    if (isSafeTemporaryProfile(profileDir)) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
  }
}
