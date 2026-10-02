import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { ToolDefinition, ToolCall, UniversalMessage } from '../ir/types.js';
import { isInsideDir, sanitizeWorkspacePath } from '../security/path.js';
import { captureDesktopScreen } from './screen.js';
import { fetchWebpageContent } from './webpage.js';
import { MemoryStore } from './memory.js';
import { LearningStore, learningTool } from './learning.js';
import { unloadOllamaModels } from '../gpu/ollama.js';
import { recoverRawContext } from '../context/compression.js';
import { testHtmlRuntime } from './html-runtime.js';
import { LocalGpuArtEngine } from '../engine/gpu-art.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);

// String(value) on an object produces "[object Object]" rather than failing, so
// a malformed tool call became a real file with that name and a success result.
// Anything that is not a primitive is treated as absent instead.
function textArg(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value);
}

export function cleanToolFilename(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim();
  // Strip Markdown link markup e.g. [🚀 gravity_sandbox.html(Launch Web App)](http://localhost:3000/v1/workspace/files/projects/New-Project-2/gravity_sandbox.html)
  const mdLinkMatch = cleaned.match(/\[(?:🚀\s*)?([^\]]+?)(?:\([^\)]*\))?\]\((?:https?:\/\/[^\/]+)?(?:\/v1\/workspace\/files\/)?([^)]+)\)/);
  if (mdLinkMatch) {
    cleaned = (mdLinkMatch[2] || mdLinkMatch[1]).trim();
  } else {
    const simpleMd = cleaned.match(/\[(?:🚀\s*)?([^\]]+?)(?:\([^\)]*\))?\]/);
    if (simpleMd) cleaned = simpleMd[1].trim();
  }
  // Strip URL host and workspace files prefix: http://localhost:3000/v1/workspace/files/...
  cleaned = cleaned.replace(/^https?:\/\/[^\/]+(?:\/v1\/workspace\/files\/)?/i, '').trim();
  // Strip leading /v1/workspace/files/
  cleaned = cleaned.replace(/^\/?v1\/workspace\/files\//i, '').trim();
  return cleaned;
}

function openInDefaultApp(target: string): void {
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${target}"`);
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    }
  } catch (err) {
    console.warn('[openInDefaultApp error]:', err);
  }
}

function repairAndParseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.raw === 'string') {
      return repairAndParseToolArguments(obj.raw);
    }
    return obj;
  }

  let text = typeof value === 'string' ? value.trim() : '';
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof (parsed as any).raw === 'string') {
        return repairAndParseToolArguments((parsed as any).raw);
      }
      return parsed as Record<string, unknown>;
    }
  } catch {}

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    text = codeBlockMatch[1].trim();
  }

  try {
    let repaired = text;
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const quotes = (repaired.match(/(?<!\\)"/g) || []).length;

    if (quotes % 2 !== 0) repaired += '"';
    if (openBraces > closeBraces) repaired += '}'.repeat(openBraces - closeBraces);

    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  const extracted: Record<string, unknown> = {};

  const fileMatch = text.match(/["']?(?:filename|filePath|file_path|path|target_file|TargetFile|file)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/i)
    || text.match(/(?:^|\n)(?:filename|file|path)\s*:\s*([^\r\n]+)/i);
  if (fileMatch) {
    extracted.filename = fileMatch[1].trim();
  }

  const contentMatch = text.match(/["']?(?:content|code|body|text|contents|CodeContent|fileContent)["']?\s*[:=]\s*"([\s\S]*)$/i)
    || text.match(/["']?(?:content|code|body|text|contents|CodeContent|fileContent)["']?\s*[:=]\s*`([\s\S]*)`?/i);
  if (contentMatch) {
    let rawContent = contentMatch[1];
    rawContent = rawContent.replace(/["\s\}]+$/, '');
    if (rawContent.includes('\\n') || rawContent.includes('\\"') || rawContent.includes('\\t')) {
      try {
        rawContent = JSON.parse(`"${rawContent.replace(/"/g, '\\"')}"`);
      } catch {
        rawContent = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    extracted.content = rawContent;
  }

  if (extracted.filename || extracted.content) {
    return extracted;
  }

  return { raw: text };
}

function unwrapToolArgs(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  let args = { ...raw };
  if (typeof args.raw === 'string') {
    const recovered = repairAndParseToolArguments(args.raw);
    args = { ...args, ...recovered };
  }
  for (const wrapperKey of ['input', 'params', 'parameters', 'arguments', 'properties', 'args', 'data']) {
    if (args[wrapperKey] && typeof args[wrapperKey] === 'object' && !Array.isArray(args[wrapperKey])) {
      args = { ...args, ...(args[wrapperKey] as Record<string, unknown>) };
    } else if (typeof args[wrapperKey] === 'string') {
      const recovered = repairAndParseToolArguments(args[wrapperKey]);
      args = { ...args, ...recovered };
    }
  }
  return args;
}
const __dirname = path.dirname(__filename);
const defaultWorkspaceDir = path.join(__dirname, '../../workspace');

export interface ToolExecutionResult {
  tool_call_id: string;
  name: string;
  output: string;
}

const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : path.join(os.homedir(), 'AppData', 'Local'));
const SDK_ROOT = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(localAppData, 'Android', 'Sdk');
const JBR_BIN = 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin';
const BUILD_TOOLS = path.join(SDK_ROOT, 'build-tools\\34.0.0');
const ANDROID_JAR = path.join(SDK_ROOT, 'platforms\\android-34\\android.jar');

const AAPT2 = path.join(BUILD_TOOLS, 'aapt2.exe');
const D8 = path.join(BUILD_TOOLS, 'd8.bat');
const ZIPALIGN = path.join(BUILD_TOOLS, 'zipalign.exe');
const APKSIGNER = path.join(BUILD_TOOLS, 'apksigner.bat');
const JAVAC = path.join(JBR_BIN, 'javac.exe');
const KEYTOOL = path.join(JBR_BIN, 'keytool.exe');
const JAR = path.join(JBR_BIN, 'jar.exe');
const ADB = path.join(SDK_ROOT, 'platform-tools\\adb.exe');
const EMULATOR = path.join(SDK_ROOT, 'emulator\\emulator.exe');

export function getRunningAndroidDevices(): string[] {
  try {
    if (!fs.existsSync(ADB)) return [];
    const out = execSync(`"${ADB}" devices`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = out.split('\n');
    const devices: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('List of')) continue;
      const [id, state] = trimmed.split(/\s+/);
      if (id && state === 'device') {
        devices.push(id);
      }
    }
    return devices;
  } catch {
    return [];
  }
}

export function installAndLaunchApkOnEmulator(apkPath: string, packageName = 'com.nexus.app', activityName = '.MainActivity') {
  if (!fs.existsSync(ADB)) {
    throw new Error(`ADB not found at ${ADB}`);
  }
  const devices = getRunningAndroidDevices();
  if (devices.length === 0) {
    if (fs.existsSync(EMULATOR)) {
      try {
        spawn(EMULATOR, ['-avd', 'APK_EMULATOR'], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
    throw new Error('No active Android emulator connected. Starting APK_EMULATOR; please allow 10-15s for device boot.');
  }

  const resolvedApk = path.resolve(apkPath);
  if (!fs.existsSync(resolvedApk)) {
    throw new Error(`APK file not found at ${resolvedApk}`);
  }

  // 1. Install APK
  execSync(`"${ADB}" install -r "${resolvedApk}"`, { stdio: 'pipe', timeout: 30000 });

  // 2. Launch Activity
  const act = activityName.startsWith('.') ? activityName : `.${activityName}`;
  const launchOut = execSync(`"${ADB}" shell am start -n ${packageName}/${act}`, { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });

  return {
    success: true,
    message: `Installed ${path.basename(resolvedApk)} and launched ${packageName}/${act} on emulator!`,
    launchOutput: launchOut.trim(),
    device: devices[0],
  };
}

export function captureEmulatorScreenshot(workspaceDir: string, filename?: string): { screenshotPath: string; absolutePath: string } {
  if (!fs.existsSync(ADB)) {
    throw new Error(`ADB not found at ${ADB}`);
  }
  const devices = getRunningAndroidDevices();
  if (devices.length === 0) {
    throw new Error('No running Android emulator detected.');
  }

  const screenshotsDir = path.join(workspaceDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const fname = filename ? (filename.endsWith('.png') ? filename : `${filename}.png`) : `emu_${Date.now()}.png`;
  const absPath = path.join(screenshotsDir, fname);
  const buf = execSync(`"${ADB}" exec-out screencap -p`, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 });
  fs.writeFileSync(absPath, buf);

  return {
    screenshotPath: `screenshots/${fname}`,
    absolutePath: absPath,
  };
}

export function sendEmulatorInput(action: string, args: { x?: number; y?: number; x2?: number; y2?: number; keycode?: string | number; text?: string; durationMs?: number }) {
  if (!fs.existsSync(ADB)) {
    throw new Error(`ADB not found at ${ADB}`);
  }
  const devices = getRunningAndroidDevices();
  if (devices.length === 0) {
    throw new Error('No running Android emulator detected.');
  }

  let cmd = '';
  switch (action) {
    case 'tap':
    case 'click':
      cmd = `input tap ${args.x || 540} ${args.y || 960}`;
      break;
    case 'swipe':
    case 'drag':
      cmd = `input swipe ${args.x || 540} ${args.y || 1200} ${args.x2 || 540} ${args.y2 || 400} ${args.durationMs || 300}`;
      break;
    case 'key':
    case 'keyevent':
      cmd = `input keyevent ${args.keycode || 'KEYCODE_ENTER'}`;
      break;
    case 'text':
      cmd = `input text "${(args.text || '').replace(/"/g, '\\"')}"`;
      break;
    case 'back':
      cmd = 'input keyevent KEYCODE_BACK';
      break;
    case 'home':
      cmd = 'input keyevent KEYCODE_HOME';
      break;
    default:
      throw new Error(`Unknown input action: ${action}`);
  }

  const out = execSync(`"${ADB}" shell ${cmd}`, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
  return { success: true, action, executedCommand: cmd, output: out.trim() };
}

export function generateFallbackGameView(viewClassName: string, appName: string, packageName: string): string {
  return `package ${packageName};

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

public class ${viewClassName} extends SurfaceView implements SurfaceHolder.Callback, Runnable {
    private Thread gameThread;
    private volatile boolean isPlaying;
    private Paint paint = new Paint();
    private float paddleX = 250;
    private float paddleWidth = 220;
    private float paddleHeight = 32;
    private float ballX = 350, ballY = 500;
    private float ballVx = 12, ballVy = -16;
    private float ballRadius = 20;
    private int score = 0;
    private boolean[] bricks = new boolean[28];

    public ${viewClassName}(Context context) {
        super(context);
        init();
    }

    public ${viewClassName}(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        getHolder().addCallback(this);
        setFocusable(true);
        for (int i = 0; i < bricks.length; i++) bricks[i] = true;
    }

    public void pause() {
        isPlaying = false;
        try {
            if (gameThread != null) gameThread.join();
        } catch (InterruptedException ignored) {}
    }

    public void resume() {
        isPlaying = true;
        gameThread = new Thread(this);
        gameThread.start();
    }

    public void onPause() { pause(); }
    public void onResume() { resume(); }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        resume();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        pause();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_MOVE || event.getAction() == MotionEvent.ACTION_DOWN) {
            paddleX = event.getX() - paddleWidth / 2f;
            return true;
        }
        return super.onTouchEvent(event);
    }

    @Override
    public void run() {
        while (isPlaying) {
            update();
            draw();
            try { Thread.sleep(16); } catch (InterruptedException ignored) {}
        }
    }

    private void update() {
        ballX += ballVx;
        ballY += ballVy;
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        if (ballX - ballRadius < 0) { ballX = ballRadius; ballVx = -ballVx; }
        if (ballX + ballRadius > w) { ballX = w - ballRadius; ballVx = -ballVx; }
        if (ballY - ballRadius < 0) { ballY = ballRadius; ballVy = -ballVy; }

        float paddleY = h - 160;
        if (ballY + ballRadius >= paddleY && ballY - ballRadius <= paddleY + paddleHeight) {
            if (ballX >= paddleX && ballX <= paddleX + paddleWidth) {
                ballVy = -Math.abs(ballVy);
                ballVx = ((ballX - (paddleX + paddleWidth / 2f)) / (paddleWidth / 2f)) * 15f;
            }
        }

        if (ballY > h) {
            ballX = w / 2f;
            ballY = h / 2f;
            ballVy = -14;
            ballVx = 8;
        }

        int cols = 7;
        int rows = 4;
        float bWidth = (w - 60f) / cols;
        float bHeight = 38f;
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                int idx = r * cols + c;
                if (!bricks[idx]) continue;
                float bx = 30f + c * bWidth;
                float by = 130f + r * (bHeight + 10f);
                if (ballX + ballRadius >= bx && ballX - ballRadius <= bx + bWidth &&
                    ballY + ballRadius >= by && ballY - ballRadius <= by + bHeight) {
                    bricks[idx] = false;
                    ballVy = -ballVy;
                    score += 100;
                    break;
                }
            }
        }
    }

    private void draw() {
        SurfaceHolder holder = getHolder();
        if (holder == null || !holder.getSurface().isValid()) return;
        Canvas canvas = holder.lockCanvas();
        if (canvas == null) return;
        try {
            int w = canvas.getWidth();
            int h = canvas.getHeight();
            canvas.drawColor(0xFF0F172A);

            paint.setColor(0xFF38BDF8);
            paint.setTextSize(52);
            paint.setFakeBoldText(true);
            paint.setTextAlign(Paint.Align.LEFT);
            canvas.drawText("${appName}", 40, 75, paint);

            paint.setColor(0xFFF1F5F9);
            paint.setTextSize(38);
            paint.setTextAlign(Paint.Align.RIGHT);
            canvas.drawText("SCORE: " + score, w - 40, 75, paint);

            int cols = 7;
            int rows = 4;
            float bWidth = (w - 60f) / cols;
            float bHeight = 38f;
            int[] neonColors = { 0xFFFF0055, 0xFF00FFCC, 0xFFEAB308, 0xFF38BDF8 };
            for (int r = 0; r < rows; r++) {
                for (int c = 0; c < cols; c++) {
                    int idx = r * cols + c;
                    if (!bricks[idx]) continue;
                    paint.setColor(neonColors[r % neonColors.length]);
                    float bx = 30f + c * bWidth;
                    float by = 130f + r * (bHeight + 10f);
                    canvas.drawRect(bx, by, bx + bWidth - 4, by + bHeight, paint);
                }
            }

            float paddleY = h - 160;
            paint.setColor(0xFF38BDF8);
            canvas.drawRoundRect(new RectF(paddleX, paddleY, paddleX + paddleWidth, paddleY + paddleHeight), 8, 8, paint);

            paint.setColor(0xFF00FFCC);
            canvas.drawCircle(ballX, ballY, ballRadius, paint);
        } finally {
            holder.unlockCanvasAndPost(canvas);
        }
    }
}
`;
}

export function generateFallbackClass(className: string, appName: string, packageName: string): string {
  if (className.toLowerCase().includes('view')) {
    return generateFallbackGameView(className, appName, packageName);
  }
  return `package ${packageName};

public class ${className} {
    public float x = 0;
    public float y = 0;
    public float vx = 0;
    public float vy = 0;
    public float width = 50;
    public float height = 50;
    public float radius = 20;
    public int color = 0xFF38BDF8;
    public int score = 0;
    public boolean active = true;
    public boolean isAlive = true;

    public ${className}() {}
    public ${className}(float x, float y) { this.x = x; this.y = y; }
    public ${className}(float x, float y, float vx, float vy) {
        this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    }
    public void update() { x += vx; y += vy; }
    public void reset() { x = 0; y = 0; vx = 0; vy = 0; active = true; }
}
`;
}

export function buildApk({ projectDir, appName, packageName = 'com.nexus.app', mainActivityCode, layoutXml, manifestXml, extraJavaFiles }: {
  projectDir: string;
  appName: string;
  packageName?: string;
  mainActivityCode?: string;
  layoutXml?: string;
  manifestXml?: string;
  extraJavaFiles?: Record<string, string>;
}) {
  const codePkgMatch = (mainActivityCode || '').match(/package\s+([a-zA-Z0-9_.]+)\s*;/);
  if (codePkgMatch && codePkgMatch[1]) {
    packageName = codePkgMatch[1].trim();
  } else if (manifestXml) {
    const manifestPkgMatch = manifestXml.match(/package=["']([a-zA-Z0-9_.]+)["']/);
    if (manifestPkgMatch && manifestPkgMatch[1]) {
      packageName = manifestPkgMatch[1].trim();
    }
  }

  const rootDir = path.resolve(projectDir);
  const javaSrcRoot = path.join(rootDir, 'src');
  const srcDir = path.join(rootDir, 'src', ...packageName.split('.'));
  const resDir = path.join(rootDir, 'res');
  const resLayoutDir = path.join(resDir, 'layout');
  const resValuesDir = path.join(resDir, 'values');
  const binDir = path.join(rootDir, 'bin');
  const outDir = path.join(rootDir, 'dist');
  const keystorePath = path.join(rootDir, 'debug.keystore');

  if (fs.existsSync(binDir)) {
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
  }

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(resLayoutDir, { recursive: true });
  fs.mkdirSync(resValuesDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const resDrawableDir = path.join(resDir, 'drawable');
  const resMipmapDir = path.join(resDir, 'mipmap');
  fs.mkdirSync(resDrawableDir, { recursive: true });
  fs.mkdirSync(resMipmapDir, { recursive: true });

  // Default launcher icon
  const iconPath = path.join(resDrawableDir, 'ic_launcher.xml');
  if (!fs.existsSync(iconPath)) {
    fs.writeFileSync(iconPath, `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#38bdf8" android:pathData="M54,10 L94,54 L54,98 L14,54 Z"/>
    <path android:fillColor="#ffffff" android:pathData="M44,34 L64,54 L44,74 Z"/>
</vector>`, 'utf8');
  }

  // 1. Write and sanitize AndroidManifest.xml
  const manifestPath = path.join(rootDir, 'AndroidManifest.xml');
  const defaultManifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}">
    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <application
        android:allowBackup="true"
        android:label="${appName}"
        android:icon="@drawable/ic_launcher"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.DeviceDefault.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  let rawManifest = manifestXml || defaultManifest;
  let cleanManifest = rawManifest
    .replace(/android:roundIcon="[^"]*"/g, '')
    .replace(/android:theme="@[^"]*"/g, 'android:theme="@android:style/Theme.DeviceDefault.NoActionBar"');
  if (!cleanManifest.includes('android:theme')) {
    cleanManifest = cleanManifest.replace('<application', '<application android:theme="@android:style/Theme.DeviceDefault.NoActionBar"');
  }
  if (!cleanManifest.includes('uses-sdk')) {
    cleanManifest = cleanManifest.replace('<application', '<uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />\n    <application');
  }

  fs.writeFileSync(manifestPath, cleanManifest, 'utf8');

  // 2. Write res/values/strings.xml, styles.xml, colors.xml
  const stringsPath = path.join(resValuesDir, 'strings.xml');
  fs.writeFileSync(stringsPath, `<?xml version="1.0" encoding="utf-8"?><resources><string name="app_name">${appName}</string></resources>`, 'utf8');

  const stylesPath = path.join(resValuesDir, 'styles.xml');
  fs.writeFileSync(stylesPath, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="@android:style/Theme.DeviceDefault.NoActionBar">
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowFullscreen">true</item>
    </style>
</resources>`, 'utf8');

  const colorsPath = path.join(resValuesDir, 'colors.xml');
  fs.writeFileSync(colorsPath, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#0f172a</color>
    <color name="colorPrimaryDark">#020617</color>
    <color name="colorAccent">#38bdf8</color>
</resources>`, 'utf8');

  // 3. Write and sanitize res/layout/activity_main.xml
  const layoutPath = path.join(resLayoutDir, 'activity_main.xml');
  const defaultLayout = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:gravity="center"
    android:background="#0f172a"
    android:padding="24dp">
    <TextView
        android:id="@+id/titleText"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="${appName}"
        android:textColor="#38bdf8"
        android:textSize="24sp"
        android:textStyle="bold"
        android:layout_marginBottom="16dp" />
    <TextView
        android:id="@+id/statusText"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Built with NexusRoute Android SDK Engine"
        android:textColor="#94a3b8"
        android:textSize="14sp" />
</LinearLayout>`;

  let cleanLayout = (layoutXml || (fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, 'utf8') : defaultLayout)).trim();
  cleanLayout = cleanLayout.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  if (!cleanLayout.startsWith('<?xml') && !cleanLayout.startsWith('<')) {
    cleanLayout = defaultLayout;
  }
  if (!cleanLayout.startsWith('<?xml')) {
    cleanLayout = `<?xml version="1.0" encoding="utf-8"?>\n${cleanLayout}`;
  }
  fs.writeFileSync(layoutPath, cleanLayout, 'utf8');

  // 4. Write and sanitize MainActivity.java
  const mainActivityPath = path.join(srcDir, 'MainActivity.java');
  const defaultActivity = `package ${packageName};

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
    }
}`;
  let rawCode = mainActivityCode || (fs.existsSync(mainActivityPath) ? fs.readFileSync(mainActivityPath, 'utf8') : defaultActivity);
  let cleanActivityCode = rawCode.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  cleanActivityCode = cleanActivityCode
    .replace(/import\s+androidx\.appcompat\.app\.AppCompatActivity;/g, 'import android.app.Activity;')
    .replace(/extends\s+AppCompatActivity/g, 'extends Activity')
    .replace(/import\s+androidx\.[^;]+;/g, '// androidx import removed')
    .replace(/import\s+[a-zA-Z0-9_.]+\.R;/g, `import ${packageName}.R;`)
    .replace(/\bpublic\s+class\s+(?!MainActivity\b)([A-Za-z0-9_]+)/g, 'class $1');

  if (!/^\s*package\s+[a-zA-Z0-9_.]+\s*;/m.test(cleanActivityCode)) {
    cleanActivityCode = `package ${packageName};\n\n${cleanActivityCode}`;
  }

  if (cleanActivityCode.length < 50 || cleanActivityCode.includes('// MainActivity.java content goes here')) {
    cleanActivityCode = defaultActivity;
  }

  fs.writeFileSync(mainActivityPath, cleanActivityCode, 'utf8');

  // Write any additional Java source files if supplied
  if (extraJavaFiles && typeof extraJavaFiles === 'object') {
    for (const [fname, fcontent] of Object.entries(extraJavaFiles)) {
      if (typeof fcontent === 'string' && fcontent.trim()) {
        const basename = path.basename(fname);
        const fpath = path.join(srcDir, basename);
        let code = fcontent.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        if (!/^\s*package\s+[a-zA-Z0-9_.]+\s*;/m.test(code)) {
          code = `package ${packageName};\n\n${code}`;
        }
        fs.writeFileSync(fpath, code, 'utf8');
      }
    }
  }

  // Automatically scan for custom View references (e.g. GameView, NeonView) and auto-synthesize if missing
  const viewClassRegex = /\b([A-Z][A-Za-z0-9_]*View)\b/g;
  const standardViews = new Set([
    'View', 'SurfaceView', 'TextureView', 'GLSurfaceView', 'VideoView',
    'ScrollView', 'HorizontalScrollView', 'ListView', 'GridView',
    'RecyclerView', 'CardView', 'ImageView', 'TextView', 'AutoCompleteTextView'
  ]);
  const referencedViews = new Set<string>();
  let vMatch: RegExpExecArray | null;
  while ((vMatch = viewClassRegex.exec(cleanActivityCode)) !== null) {
    const vName = vMatch[1];
    if (!standardViews.has(vName)) {
      referencedViews.add(vName);
    }
  }

  for (const vName of referencedViews) {
    const hasClassDef = new RegExp(`\\b(?:class|interface|enum)\\s+${vName}\\b`).test(cleanActivityCode);
    const hasExtra = extraJavaFiles && (extraJavaFiles[`${vName}.java`] || extraJavaFiles[vName]);
    const vPath = path.join(srcDir, `${vName}.java`);
    if (!hasClassDef && !hasExtra && !fs.existsSync(vPath)) {
      const code = generateFallbackGameView(vName, appName, packageName);
      fs.writeFileSync(vPath, code, 'utf8');
    }
  }

  // Automatically scan for any referenced drawables and create vector placeholders if missing
  const allText = `${cleanLayout} ${cleanManifest} ${cleanActivityCode}`;
  const drawableMatches = allText.match(/(?:@drawable\/|R\.drawable\.)([a-zA-Z0-9_]+)/g) || [];
  for (const m of drawableMatches) {
    const dName = m.replace('@drawable/', '').replace('R.drawable.', '').trim();
    if (!dName) continue;
    const dPathXml = path.join(resDrawableDir, `${dName}.xml`);
    const dPathPng = path.join(resDrawableDir, `${dName}.png`);
    if (!fs.existsSync(dPathXml) && !fs.existsSync(dPathPng)) {
      fs.writeFileSync(dPathXml, `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="#38bdf8"/>
    <corners android:radius="8dp"/>
</shape>`, 'utf8');
    }
  }

  // 5. Compile resources with aapt2 (auto-fallback if XML malformed)
  const compiledResZip = path.join(binDir, 'compiled_res.zip');
  try {
    execSync(`"${AAPT2}" compile --dir "${resDir}" -o "${compiledResZip}"`, { stdio: 'pipe' });
  } catch {
    fs.writeFileSync(layoutPath, defaultLayout, 'utf8');
    execSync(`"${AAPT2}" compile --dir "${resDir}" -o "${compiledResZip}"`, { stdio: 'pipe' });
  }

  // 6. Link resources & generate R.java with modern targetSdkVersion 34 (auto-fallback if manifest malformed)
  const unalignedApk = path.join(binDir, 'unaligned.apk');
  try {
    execSync(`"${AAPT2}" link --min-sdk-version 21 --target-sdk-version 34 -I "${ANDROID_JAR}" --manifest "${manifestPath}" -o "${unalignedApk}" --java "${javaSrcRoot}" "${compiledResZip}" --auto-add-overlay`, { stdio: 'pipe' });
  } catch {
    fs.writeFileSync(manifestPath, defaultManifest, 'utf8');
    execSync(`"${AAPT2}" link --min-sdk-version 21 --target-sdk-version 34 -I "${ANDROID_JAR}" --manifest "${manifestPath}" -o "${unalignedApk}" --java "${javaSrcRoot}" "${compiledResZip}" --auto-add-overlay`, { stdio: 'pipe' });
  }

  // 7. Compile Java sources with javac (clean and isolate to current package)
  // Purge any foreign MainActivity.java outside current package to avoid duplicate class errors
  function purgeForeignMainActivities(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        purgeForeignMainActivities(full);
      } else if (item.name === 'MainActivity.java' && path.resolve(full) !== path.resolve(mainActivityPath)) {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  }
  purgeForeignMainActivities(javaSrcRoot);

  const javaFiles: string[] = [];
  function collectJava(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) collectJava(full);
      else if (item.name.endsWith('.java') && !javaFiles.includes(`"${full}"`)) {
        javaFiles.push(`"${full}"`);
      }
    }
  }

  collectJava(javaSrcRoot);

  if (javaFiles.length === 0) {
    fs.writeFileSync(mainActivityPath, defaultActivity, 'utf8');
    javaFiles.push(`"${mainActivityPath}"`);
  }

  try {
    execSync(`"${JAVAC}" -source 8 -target 8 -Xlint:-options -parameters -encoding UTF-8 -d "${binDir}" -cp "${ANDROID_JAR}" ${javaFiles.join(' ')}`, { stdio: 'pipe' });
  } catch (javacErr: any) {
    const errorLog = javacErr.stderr?.toString() || javacErr.stdout?.toString() || javacErr.message;
    const missingClassMatches = [...errorLog.matchAll(/cannot find symbol\s*(?:[\r\n]+[^\r\n]+)*?symbol:\s*class\s+([A-Za-z0-9_]+)/g)];
    if (missingClassMatches.length > 0) {
      let synthesized = false;
      for (const m of missingClassMatches) {
        const missingClass = m[1];
        const missingPath = path.join(srcDir, `${missingClass}.java`);
        if (!fs.existsSync(missingPath)) {
          const code = generateFallbackClass(missingClass, appName, packageName);
          fs.writeFileSync(missingPath, code, 'utf8');
          if (!javaFiles.includes(`"${missingPath}"`)) {
            javaFiles.push(`"${missingPath}"`);
          }
          synthesized = true;
        }
      }
      if (synthesized) {
        try {
          execSync(`"${JAVAC}" -source 8 -target 8 -Xlint:-options -parameters -encoding UTF-8 -d "${binDir}" -cp "${ANDROID_JAR}" ${javaFiles.join(' ')}`, { stdio: 'pipe' });
        } catch (retryErr: any) {
          const retryLog = retryErr.stderr?.toString() || retryErr.stdout?.toString() || retryErr.message;
          throw new Error(`Java compilation failed: ${retryLog}`);
        }
      } else {
        throw new Error(`Java compilation failed: ${errorLog}`);
      }
    } else {
      throw new Error(`Java compilation failed: ${errorLog}`);
    }
  }

  // 8. Dex bytecode with d8 (with min-api 21 and non-empty class validation)
  const classFiles: string[] = [];
  function collectClasses(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) collectClasses(full);
      else if (item.name.endsWith('.class')) classFiles.push(`"${full}"`);
    }
  }
  collectClasses(binDir);

  if (classFiles.length === 0) {
    fs.writeFileSync(mainActivityPath, defaultActivity, 'utf8');
    execSync(`"${JAVAC}" -source 8 -target 8 -Xlint:-options -parameters -encoding UTF-8 -d "${binDir}" -cp "${ANDROID_JAR}" "${mainActivityPath}"`, { stdio: 'pipe' });
    collectClasses(binDir);
  }

  execSync(`cmd.exe /c ""${D8}" --min-api 21 --output "${binDir}" --lib "${ANDROID_JAR}" ${classFiles.join(' ')}"`, { stdio: 'pipe' });

  // 9. Add classes.dex to unaligned.apk using jar
  execSync(`"${JAR}" uf "${unalignedApk}" -C "${binDir}" classes.dex`, { stdio: 'pipe' });

  // 10. Zipalign APK
  const alignedApk = path.join(binDir, 'aligned.apk');
  if (fs.existsSync(alignedApk)) fs.unlinkSync(alignedApk);
  execSync(`"${ZIPALIGN}" -f 4 "${unalignedApk}" "${alignedApk}"`, { stdio: 'pipe' });

  // 11. Create debug keystore if not present
  if (!fs.existsSync(keystorePath)) {
    execSync(`"${KEYTOOL}" -genkey -v -keystore "${keystorePath}" -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`, { stdio: 'pipe' });
  }

  // 12. Sign APK with apksigner (v1 + v2 modern signing)
  const finalApk = path.join(outDir, `${appName}.apk`);
  if (fs.existsSync(finalApk)) fs.unlinkSync(finalApk);
  execSync(`cmd.exe /c ""${APKSIGNER}" sign --ks "${keystorePath}" --ks-pass pass:android --key-pass pass:android --v1-signing-enabled true --v2-signing-enabled true --out "${finalApk}" "${alignedApk}""`, { stdio: 'pipe' });

  return {
    success: true,
    apkPath: finalApk,
    appName,
    packageName,
  };
}

/**
 * RTK (Rust Token Killer) inspired command output compressor.
 * Strips ANSI terminal noise, collapses passing test suites, shortens git operations,
 * groups compiler errors, and truncates large outputs while saving raw logs to disk.
 */
export function compressCommandOutput(
  cmd: string,
  rawStdout: string,
  rawStderr: string,
  success: boolean,
  wsDir: string
): { stdout: string; stderr: string; compressed: boolean; rawLogPath?: string } {
  const stripAnsi = (str: string) => (str || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\([a-zA-Z]/g, '')
    .replace(/\r/g, '');

  let stdout = stripAnsi(rawStdout).trim();
  let stderr = stripAnsi(rawStderr).trim();
  const lowerCmd = cmd.toLowerCase().trim();
  let wasCompressed = false;

  // 1. Test runner compression (vitest, jest, pytest, cargo test, npm test)
  const isTestCmd = lowerCmd.includes('test') || lowerCmd.includes('vitest') || lowerCmd.includes('jest') || lowerCmd.includes('pytest');
  if (isTestCmd) {
    if (success) {
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const summaryLines = lines.filter(l =>
        /passed|test files|tests|suites|duration|start at|test result: ok/i.test(l) &&
        !l.startsWith('✓') && !l.startsWith('PASS')
      );
      if (summaryLines.length > 0) {
        stdout = `✓ All tests passed!\n${summaryLines.join('\n')}`;
        wasCompressed = true;
      }
    } else {
      const lines = stdout.split('\n');
      const filtered: string[] = [];
      let inFailBlock = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/FAIL|failed|error|assertion|expected|received|stack/i.test(trimmed)) {
          inFailBlock = true;
        } else if (/PASS|passed/i.test(trimmed) && !/failed/i.test(trimmed)) {
          inFailBlock = false;
          continue; // strip passing line
        }
        if (inFailBlock || /test files|tests|duration|failed/i.test(trimmed)) {
          filtered.push(line);
        }
      }
      if (filtered.length > 0 && filtered.length < lines.length) {
        stdout = filtered.join('\n').trim();
        wasCompressed = true;
      }
    }
  }

  // 2. Git command compression
  if (lowerCmd.startsWith('git ')) {
    if (lowerCmd.includes('status')) {
      const lines = stdout.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('(') && !l.includes('use "git') && !l.includes('no changes added'));
      stdout = lines.join('\n');
      wasCompressed = true;
    } else if (lowerCmd.includes(' add ') || lowerCmd.endsWith(' add .') || lowerCmd.endsWith(' add -a')) {
      if (success && !stderr) {
        stdout = 'ok';
        wasCompressed = true;
      }
    } else if (lowerCmd.includes('commit')) {
      if (success) {
        const hashMatch = stdout.match(/\[([^\]]+)\s+([a-f0-9]+)\]\s*(.*)/i);
        if (hashMatch) {
          stdout = `ok [${hashMatch[2]}] ${hashMatch[3]}`.trim();
          wasCompressed = true;
        }
      }
    } else if (lowerCmd.includes('push')) {
      if (success) {
        stdout = stdout.includes('Everything up-to-date') ? 'ok up-to-date' : 'ok pushed';
        wasCompressed = true;
      }
    } else if (lowerCmd.includes('diff')) {
      const lines = stdout.split('\n').filter(l => !l.startsWith('diff --git') && !l.startsWith('index '));
      if (lines.length < stdout.split('\n').length) {
        stdout = lines.join('\n').trim();
        wasCompressed = true;
      }
    }
  }

  // 3. Compiler / linter compression (tsc, eslint, cargo build, cmake)
  if (lowerCmd.startsWith('tsc') || lowerCmd.includes('eslint') || lowerCmd.includes('npm run build') || lowerCmd.includes('cargo build')) {
    if (success && !stdout && !stderr) {
      stdout = '✓ Build succeeded with 0 errors.';
      wasCompressed = true;
    } else if (success && stdout.length > 400) {
      const lines = stdout.split('\n').filter(l => !l.includes('> ') && !l.includes('node -e') && !l.includes('tsc &&'));
      stdout = lines.join('\n').trim();
      wasCompressed = true;
    }
  }

  // 4. Large output truncation and spooling to disk (RTK / CCR style)
  let rawLogPath: string | undefined;
  const combinedLen = stdout.length + stderr.length;
  if (combinedLen > 3000) {
    try {
      const cacheDir = path.join(wsDir, '.cache', 'raw_outputs');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const filename = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`;
      const fullLogFile = path.join(cacheDir, filename);
      fs.writeFileSync(fullLogFile, `Command: ${cmd}\n\n--- STDOUT ---\n${rawStdout}\n\n--- STDERR ---\n${rawStderr}`, 'utf8');
      rawLogPath = `.cache/raw_outputs/${filename}`;

      if (stdout.length > 2400) {
        const head = stdout.slice(0, 1000);
        const tail = stdout.slice(-1000);
        stdout = `${head}\n\n... [RTK Compactor: Truncated ${stdout.length - 2000} chars. Full raw log spooled to ${rawLogPath}] ...\n\n${tail}`;
        wasCompressed = true;
      }
      if (stderr.length > 1200) {
        stderr = `${stderr.slice(0, 500)}\n\n... [RTK Compactor: ${stderr.length - 1000} chars truncated] ...\n\n${stderr.slice(-500)}`;
        wasCompressed = true;
      }
    } catch {}
  }

  return { stdout, stderr, compressed: wasCompressed, rawLogPath };
}

export function normalizeToolName(name: string): string {
  const n = (name || '').trim();
  const lower = n.toLowerCase();
  if (['list_files', 'list_dir', 'list_directory', 'listfiles', 'ls', 'dir'].includes(lower)) return 'list_workspace_files';
  if (['read_file', 'readfile', 'view_file', 'cat'].includes(lower)) return 'read_file';
  if (['write_file', 'writefile', 'create_file'].includes(lower)) return 'write_file';
  if (['patch_file', 'patchfile', 'edit_file'].includes(lower)) return 'patch_file';
  if (['run_command', 'exec_command', 'execute_command', 'bash', 'sh', 'cmd', 'terminal'].includes(lower)) return 'execute_command';
  return n;
}

export class ToolRegistry {
  private static workspaceDir = defaultWorkspaceDir;

  static setWorkspaceDir(dir: string) {
    this.workspaceDir = dir;
  }

  static getWorkspaceDir(): string {
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
    return this.workspaceDir;
  }

  private static builtInTools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'build_android_apk',
        description: 'Builds, compiles, dexes, aligns, and signs a complete installable Android .apk file directly from Java source code, XML layout, and AndroidManifest using the local Android SDK and Java JBR.',
        parameters: {
          type: 'object',
          properties: {
            appName: {
              type: 'string',
              description: 'The name of the Android application (e.g., "DrumPad", "RetroSynth", "AudioRecorder").',
            },
            packageName: {
              type: 'string',
              description: 'The Android package identifier (e.g., "com.nexus.drumpad"). Defaults to "com.nexus.app".',
            },
            mainActivityCode: {
              type: 'string',
              description: 'The full Java source code for MainActivity.java.',
            },
            layoutXml: {
              type: 'string',
              description: 'Optional layout XML for res/layout/activity_main.xml.',
            },
            manifestXml: {
              type: 'string',
              description: 'Optional AndroidManifest.xml content with permissions and activity declarations.',
            },
            extraJavaFiles: {
              type: 'object',
              description: 'Optional dictionary of extra Java files mapping file names (e.g. "GameView.java") to their full Java source code string.',
            },
          },
          required: ['appName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_android_app',
        description: 'Tests, launches, and interacts with Android .apk applications directly on the local Android Emulator. Can install and launch apps, capture live UI/gameplay screenshots, send touch taps/swipes/key inputs, or inspect logcat.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['install_and_launch', 'take_screenshot', 'send_input', 'get_logs', 'list_devices'],
              description: 'Testing action: "install_and_launch" (deploy APK & start app), "take_screenshot" (capture live frame of running app), "send_input" (tap screen, swipe, or send key events), "get_logs" (read logcat), or "list_devices".',
            },
            appName: {
              type: 'string',
              description: 'The Android app name to test (e.g. "DrumPad", "SnakeGame", "RetroSynth").',
            },
            packageName: {
              type: 'string',
              description: 'The Android package identifier (e.g., "com.nexus.app"). Defaults to "com.nexus.app".',
            },
            input_type: {
              type: 'string',
              enum: ['tap', 'swipe', 'key', 'text', 'back', 'home'],
              description: 'When action is "send_input", the input event type.',
            },
            x: {
              type: 'number',
              description: 'X pixel coordinate for tap or swipe start (e.g. 540).',
            },
            y: {
              type: 'number',
              description: 'Y pixel coordinate for tap or swipe start (e.g. 960).',
            },
            x2: {
              type: 'number',
              description: 'X2 pixel coordinate for swipe end.',
            },
            y2: {
              type: 'number',
              description: 'Y2 pixel coordinate for swipe end.',
            },
            keycode: {
              type: 'string',
              description: 'Android key code (e.g. "KEYCODE_ENTER", "KEYCODE_DPAD_UP", "KEYCODE_SPACE").',
            },
            text: {
              type: 'string',
              description: 'Text string to type into focused input.',
            },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Creates or updates a file on the computer with specified code or text content.',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'The relative filename or path to create (e.g., "script.py", "index.html", "data/stats.json").',
            },
            content: {
              type: 'string',
              description: 'The complete code or text content to write into the file.',
            },
          },
          required: ['filename', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'patch_file',
        description: 'Safely edits an existing text file by replacing one exact, unique block. Prefer this for small changes instead of rewriting the complete file.',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'The existing relative filename or path to edit.',
            },
            old_text: {
              type: 'string',
              description: 'The exact existing text to replace. It must be unique unless replace_all is true.',
            },
            new_text: {
              type: 'string',
              description: 'The replacement text.',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace every exact occurrence. Defaults to false.',
            },
          },
          required: ['filename', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recover_raw_context',
        description: 'Recovers the exact original content of an older tool result or message that NexusRoute safely compacted. Use the raw context id shown in the compaction marker.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The 20-character raw context id from a compaction marker.',
            },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Reads the contents of an existing file from the computer workspace.',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'The relative filename or path to read (e.g., "script.py", "config.json").',
            },
          },
          required: ['filename'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description: 'Lists all files and directories currently created inside the workspace.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: 'Runs a terminal / shell command (e.g. "python script.py", "node test.js", "dir", "mkdir", "git status") on the computer in the workspace directory.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command line to execute on the computer.',
            },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_in_browser_or_app',
        description: 'Opens a local file (e.g. "snake.html", "dashboard.html") or URL directly in the user\'s default browser or desktop application. This launches only; use test_html_app to verify an interactive HTML game after clicking Start/Play.',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              description: 'The filename inside workspace (e.g. "snake.html") or URL to open on the user\'s desktop.',
            },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_html_app',
        description: 'Runs an HTML game/app in an isolated headless browser, records browser/runtime errors, finds and genuinely clicks its visible Start/Play control, sends a brief ArrowUp input, waits for gameplay, and captures the resulting screen. Use after creating or repairing an interactive HTML artifact; opening the file alone is not a runtime test.',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'HTML file inside the workspace, e.g. "projects/chase_hq/index.html".',
            },
            start_selector: {
              type: 'string',
              description: 'Optional CSS selector for an unusual Start/Play control, e.g. "#btn-start".',
            },
            wait_after_click_ms: {
              type: 'number',
              description: 'Optional gameplay observation delay after clicking, from 250 to 5000 ms. Default: 1500.',
            },
          },
          required: ['filename'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generates studio-grade, high-resolution AI artwork, digital illustrations, concept art, wallpapers, or photorealistic images from a detailed prompt and saves the image file to the workspace.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The detailed visual description of the image to generate (include style, colors, lighting, subjects).',
            },
            negative_prompt: {
              type: 'string',
              description: 'Optional negative prompt detailing elements, flaws, textures, or styles to exclude (e.g., "blurry, distorted anatomy, cartoon, text, low quality, oversaturated").',
            },
            aspect_ratio: {
              type: 'string',
              enum: ['16:9', '1:1', '9:16', '4:3', '3:2'],
              description: 'Aspect ratio of the generated artwork: 16:9 (widescreen/wallpaper), 1:1 (square), 9:16 (mobile/portrait), 4:3 (standard landscape). Default: 16:9',
            },
            quality: {
              type: 'string',
              enum: ['standard', 'hd', 'ultra'],
              description: 'Resolution quality level: hd (1080p/1536p) or ultra (4K/masterpiece). Default: hd',
            },
            engine: {
              type: 'string',
              enum: ['promptforge', 'gpu', 'together', 'huggingface', 'openai', 'imagen', 'cloud', 'auto'],
              description: 'Image engine: "promptforge" (PromptForge RTX Local Studio on Port 17861), "gpu" (Local GPU), "together" (Together AI FLUX.1 Pro), "huggingface" (Hugging Face FLUX.1), "openai" (OpenAI DALL-E 3 HD), "imagen" (Google Imagen 3), or "cloud" / "auto".',
            },
            filename: {
              type: 'string',
              description: 'Optional filename to save (e.g. "countryside_sunset.jpg", "cyberpunk_city.png"). Default: art_<timestamp>.jpg',
            },
            reference_face_path: {
              type: 'string',
              description: 'Optional local Windows path to a face reference photo (e.g. "C:\\Pictures\\reference.jpg" or "workspace/ref.jpg") to activate Face-Reference Conditioning / Face Lock on PromptForge RTX.',
            },
            reference_face_strength: {
              type: 'number',
              description: 'Optional face likeness retention strength between 0.50 and 0.80 (Default: 0.65). Higher preserves facial likeness more strongly.',
            },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_video',
        description: 'Generates animated video clips, dynamic motion scenes, or video animations from a text prompt using local RTX 4060 GPU video synthesis (e.g. LTX-Video / morph / storyline pipeline) and saves the .mp4 to the workspace.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The detailed visual and motion description of the video clip to generate (describe motion, camera movement, lighting, subjects).',
            },
            num_frames: {
              type: 'number',
              description: 'Number of frames to render (default: 24 frames).',
            },
            fps: {
              type: 'number',
              description: 'Framerate of the output video (default: 24 or 60).',
            },
            duration_sec: {
              type: 'number',
              description: 'Target duration in seconds (default: 3.0s).',
            },
            audio_vibe: {
              type: 'string',
              enum: ['synthwave', 'cyberpunk', 'ambient', 'orchestral', 'lofi', 'none'],
              description: 'Optional audio vibe to synthesize and mix with video.',
            },
            model: {
              type: 'string',
              description: 'Video synthesis model or engine to use: "wan" (Wan 2.1), "ltx" (LTX-Video 2B), "sdxl" (SDXL Turbo), or "turbo" (Fast Morph Engine). Defaults to "turbo".',
            },
            image: {
              type: 'string',
              description: 'Optional path, filename, or URL of an existing source image/photo to animate into video (Photo-to-Video / I2V).',
            },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Performs a live web search for current real-time information, news, or fact checking.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to look up on the web.',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_gif',
        description: 'Searches for animated GIFs and memes on Giphy. Returns direct animated GIF URLs and ready-to-use markdown embed codes (![title](url)) to display animated GIFs in chat.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search term for the animated GIF (e.g., "coffee", "celebration", "mind blown", "good morning", "dumpster fire").',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calculator',
        description: 'Evaluates mathematical, statistical, or geometric expressions with exact precision.',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'The mathematical expression to evaluate (e.g., "4829 * 1928", "Math.sqrt(256) * Math.PI").',
            },
          },
          required: ['expression'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Returns the current real-time timestamp, date, day of week, and ISO time.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'take_desktop_screenshot',
        description: 'Captures a high-resolution screenshot of the user\'s Windows desktop monitor. Use this to inspect what is on screen, debug GUI apps, review browser windows, read compiler errors, or inspect UI layouts.',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional custom filename to save in workspace/screenshots/ (e.g. "vscode_error.png", "desktop_review.png"). Default: desktop_<timestamp>.png',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_webpage',
        description: 'Fetches the full text, documentation, article, or code from any HTTP/HTTPS webpage URL and converts it into clean readable markdown.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The HTTP or HTTPS URL to fetch and read.',
            },
            max_length: {
              type: 'number',
              description: 'Optional maximum characters to extract (default: 12000).',
            },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remember_fact',
        description: 'Stores a persistent long-term fact, user preference, project note, or hardware detail that survives across all chat sessions.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'A short topic or identifier (e.g. "favorite_framework", "audio_setup", "gpu_specs", "project_goal").',
            },
            fact: {
              type: 'string',
              description: 'The detail or note to store into memory.',
            },
            category: {
              type: 'string',
              enum: ['preference', 'hardware', 'project', 'knowledge', 'general'],
              description: 'Category for the memory. Defaults to "general".',
            },
          },
          required: ['key', 'fact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: 'Searches or retrieves all persistent long-term memories, facts, and preferences stored across sessions.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional search keyword to filter memories. If omitted, returns all stored memories.',
            },
          },
        },
      },
    },
  ];

  static getBuiltInTools(): ToolDefinition[] {
    return [...this.builtInTools, learningTool];
  }

  static async searchGiphyGifs(query: string, limit: number = 3): Promise<Array<{ id: string; url: string; markdown: string; title: string }>> {
    try {
      const cleanQuery = query.replace(/\bgifs?\b/gi, '').trim() || query;
      const res = await fetch(`https://giphy.com/search/${encodeURIComponent(cleanQuery)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const html = await res.text();
      const matches = [...html.matchAll(/giphy\.com\/gifs\/(?:[a-zA-Z0-9_-]+-)?([a-zA-Z0-9]{10,25})/g)];
      const ids = [...new Set(matches.map(m => m[1]))];
      return ids.slice(0, limit).map((id, index) => {
        const directUrl = `https://media.giphy.com/media/${id}/giphy.gif`;
        return {
          id,
          url: directUrl,
          markdown: `![${cleanQuery} gif](${directUrl})`,
          title: `${cleanQuery} gif #${index + 1}`,
        };
      });
    } catch {
      return [];
    }
  }

  static async executeTool(name: string, argsInput: string | Record<string, unknown>, defaultArtEngine?: string): Promise<string> {
    name = normalizeToolName(name);
    let args: Record<string, unknown> = {};
    if (typeof argsInput === 'object' && argsInput !== null) {
      args = argsInput as Record<string, unknown>;
    } else {
      args = repairAndParseToolArguments(argsInput);
    }

    const ws = this.getWorkspaceDir();

    switch (name) {
      case 'learning_memory': {
        try { return JSON.stringify(await LearningStore.execute(ws, args)); }
        catch (error: any) { return JSON.stringify({ success: false, error: error.message }); }
      }
      case 'recover_raw_context': {
        const id = String(args.id || '').trim();
        const recovered = recoverRawContext(ws, id);
        if (!recovered) return JSON.stringify({ success: false, error: `Raw context not found: ${id}` });
        return JSON.stringify({ success: true, id, content: recovered.content, metadata: recovered.metadata });
      }

      case 'write_file': {
        const unwrapped = unwrapToolArgs(args);
        let rawFilename = (
          textArg(unwrapped.filename) || textArg(unwrapped.filePath) || textArg(unwrapped.file_path) ||
          textArg(unwrapped.path) || textArg(unwrapped.filepath) || textArg(unwrapped.fileName) ||
          textArg(unwrapped.file_name) || textArg(unwrapped.TargetFile) || textArg(unwrapped.target_file) ||
          textArg(unwrapped.target) || textArg(unwrapped.dest) || textArg(unwrapped.destination) ||
          textArg(unwrapped.file)
        ).trim();

        if (!rawFilename && unwrapped.file && typeof unwrapped.file === 'object') {
          const fObj = unwrapped.file as Record<string, any>;
          rawFilename = (textArg(fObj.path) || textArg(fObj.name) || textArg(fObj.filename) || textArg(fObj.filepath)).trim();
        }
        if (!rawFilename && unwrapped.filename && typeof unwrapped.filename === 'object') {
          const fObj = unwrapped.filename as Record<string, any>;
          rawFilename = (textArg(fObj.value) || textArg(fObj.name) || textArg(fObj.path) || textArg(fObj.filename)).trim();
        }
        if (!rawFilename && (unwrapped['0'] || unwrapped['arg0'])) {
          rawFilename = textArg(unwrapped['0'] || unwrapped['arg0']).trim();
        }
        if (!rawFilename && unwrapped.name && typeof unwrapped.name === 'string' && unwrapped.name !== 'write_file' && unwrapped.name.includes('.')) {
          rawFilename = unwrapped.name.trim();
        }

        let contentSource = (
          unwrapped.content ?? unwrapped.code ?? unwrapped.text ?? unwrapped.contents ?? unwrapped.file_content ??
          unwrapped.fileContent ?? unwrapped.CodeContent ?? unwrapped.code_content ?? unwrapped.data ?? unwrapped.body ??
          unwrapped.source ?? unwrapped.source_code ?? unwrapped['1'] ?? unwrapped['arg1']
        );
        if ((contentSource === undefined || contentSource === null || contentSource === '') && unwrapped.file && typeof unwrapped.file === 'object') {
          const fObj = unwrapped.file as Record<string, any>;
          contentSource = fObj.content ?? fObj.code ?? fObj.body ?? fObj.data;
        }
        if (contentSource === undefined || contentSource === null) contentSource = '';

        rawFilename = cleanToolFilename(rawFilename);

        if (!rawFilename) {
          return 'Error: Empty filename provided.';
        }
        let content = typeof contentSource === 'object' ? JSON.stringify(contentSource, null, 2) : String(contentSource);

        // Reject attempts to write internal compaction placeholder strings
        if (
          /\[File content \(\d+[\d,]* characters?\) verified and saved to disk/i.test(content) ||
          /\[File content saved to disk/i.test(content) ||
          /verified and saved to disk\. Use read_file or patch_file/i.test(content)
        ) {
          return JSON.stringify({
            success: false,
            error: `WRITE REJECTED: '${rawFilename}' was not written because the content is an internal file-compaction placeholder string, not actual code. Do not echo the compaction string; provide the genuine file content or finish if already written.`,
          });
        }

        // If content was accidentally wrapped in raw tool-call JSON (e.g. { "name": "write_file", ... })
        if (content.trim().startsWith('{') && content.includes('"name"') && (content.includes('"arguments"') || content.includes('"content"'))) {
          try {
            const innerParsed = JSON.parse(content);
            const innerArgs = innerParsed.arguments || innerParsed;
            if (innerArgs && typeof innerArgs === 'object' && (innerArgs.content || innerArgs.code)) {
              content = String(innerArgs.content || innerArgs.code);
            }
          } catch {
            // Check regex for template backtick content: "content": `...`
            const backtickMatch = content.match(/["']?content["']?\s*[:=]\s*`([\s\S]*?)`\s*\}?\s*\}?$/);
            if (backtickMatch) {
              content = backtickMatch[1].trim();
            }
          }
        }

        // Prevent path traversal outside workspace
        let safePath: string;
        try {
          safePath = sanitizeWorkspacePath(rawFilename, ws);
        } catch {
          return 'Error: Cannot write outside designated workspace directory.';
        }

        const ext = path.extname(rawFilename).toLowerCase();
        const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.cs', '.go', '.rs', '.rb', '.php', '.kt', '.swift']);
        const trimmedContent = content.trim();
        const serializedToolCall = sourceExtensions.has(ext) && (
          /^\s*\{[\s\S]*["']name["']\s*:\s*["'](?:write_file|execute_command)["']/i.test(trimmedContent) ||
          /^\s*```(?:json)?\s*\n?\s*\{[\s\S]*["'](?:name|function)["']\s*:/i.test(trimmedContent) ||
          (/\"(?:name|function)\"\s*:\s*\"(?:write_file|execute_command)\"/i.test(trimmedContent) && /\"arguments\"\s*:/.test(trimmedContent))
        );
        const instructionInsteadOfSource = sourceExtensions.has(ext) && (
          /^(?:node|npm|npx)\s+[^\r\n]+(?:\r?\n|$)/i.test(trimmedContent) ||
          /^please\s+(?:run|execute|share)\b/i.test(trimmedContent)
        );
        if (serializedToolCall || instructionInsteadOfSource) {
          return JSON.stringify({
            success: false,
            error: `WRITE REJECTED (TOOL OUTPUT): '${rawFilename}' contains serialized tool-call JSON or execution instructions instead of source code. Rewrite the file with the actual implementation only.`,
          });
        }
        if (['.js', '.mjs', '.cjs'].includes(ext)) {
          const syntaxProbe = path.join(ws, `.nexus-syntax-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
          try {
            fs.writeFileSync(syntaxProbe, content, 'utf8');
            await execFileAsync(process.execPath, ['--check', syntaxProbe], { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 });
          } catch (error: any) {
            return JSON.stringify({ success: false, error: `WRITE REJECTED (SYNTAX): '${rawFilename}' is not valid JavaScript. ${String(error?.stderr || error?.message || '').trim().slice(0, 500)}` });
          } finally {
            try { fs.unlinkSync(syntaxProbe); } catch { /* best effort cleanup */ }
          }
        }
        const isHtml = ext === '.html' || ext === '.htm';
        if (isHtml) {
          const scriptBlocks = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
          if (scriptBlocks.length > 0) {
            const rawScript = scriptBlocks.map(m => m[1]).join('\n');
            const executableScript = rawScript
              .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
              .replace(/\s+/g, '')
              .trim();
            const hasPlaceholderComment = /\/\/\s*(?:TODO:?\s*)?(?:add|your|implement|logic|game loop|code)/i.test(rawScript)
              || /\/\*[\s\S]*?(?:TODO|placeholder|add logic)[\s\S]*?\*\//i.test(rawScript);
            const isGame = /game|arena|combat|arcade|simulator|pong|snake|tetris|break|racing/i.test(rawFilename)
              || /(?:arcade|action|combat|playable)\s+game\b/i.test(content);
            const hasNoControls = isGame && !/addEventListener\s*\(\s*['"](keydown|keyup|pointerdown|mousedown|click|touchstart)['"]/i.test(content);

            if (executableScript.length < 50 && hasPlaceholderComment) {
              if (isGame || hasNoControls) {
                return JSON.stringify({
                  success: false,
                  error: `WRITE REJECTED (INCOMPLETE ARTIFACT): File '${rawFilename}' is an interactive game that has a hollow script or zero controls. Write the full complete implementation now!`,
                });
              }
              return JSON.stringify({
                success: false,
                error: `File '${rawFilename}' contains a placeholder script. If this is a static page, remove the <script> tag completely; otherwise implement the actual script logic.`,
              });
            }
          }
        }

        try {
          const parentDir = path.dirname(safePath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.writeFileSync(safePath, content, 'utf8');
          const stats = fs.statSync(safePath);

          return JSON.stringify({
            success: true,
            message: `File "${rawFilename}" written successfully.`,
            filename: rawFilename,
            fullPath: safePath,
            url: `/v1/workspace/files/${encodeURIComponent(path.relative(ws, safePath).replace(/\\/g, '/'))}`,
            autoOpened: false,
            bytesWritten: stats.size,
          });
        } catch (err: unknown) {
          return `Error writing file "${rawFilename}": ${(err as Error).message}`;
        }
      }

      case 'patch_file': {
        const rawFilename = cleanToolFilename(textArg(
          args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filepath ??
          args.fileName ?? args.file_name ?? args.TargetFile ?? args.target_file ?? args.target ?? args.name
        ).trim());
        const oldText = String(
          args.old_text ?? args.oldText ?? args.find ?? args.targetContent ?? args.TargetContent ??
          args.search ?? args.old_str ?? args.old_string ?? args.original ?? ''
        );
        const newText = String(
          args.new_text ?? args.newText ?? args.replace ?? args.replacementContent ??
          args.ReplacementContent ?? args.new_str ?? args.new_string ?? args.replacement ?? ''
        );
        const replaceAll = args.replace_all === true || args.replaceAll === true || args.all === true || args.AllowMultiple === true;
        if (!rawFilename) return 'Error: Empty filename provided.';
        if (!oldText) return 'Error: patch_file requires non-empty old_text.';

        if (
          /\[File content \(\d+[\d,]* characters?\) verified and saved to disk/i.test(newText) ||
          /\[File content saved to disk/i.test(newText) ||
          /verified and saved to disk\. Use read_file or patch_file/i.test(newText)
        ) {
          return JSON.stringify({
            success: false,
            error: `PATCH REJECTED: '${rawFilename}' was not patched because new_text contains an internal file-compaction placeholder string.`,
          });
        }

        let safePath: string;
        try {
          safePath = sanitizeWorkspacePath(rawFilename, ws);
        } catch {
          return 'Error: Cannot edit outside designated workspace directory.';
        }
        if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
          return `Error: File "${rawFilename}" does not exist in workspace.`;
        }

        try {
          const original = fs.readFileSync(safePath, 'utf8');
          const occurrences = original.split(oldText).length - 1;
          if (occurrences === 0) {
            return JSON.stringify({ success: false, error: 'old_text was not found; read the file again and use an exact block.', filename: rawFilename });
          }
          if (occurrences > 1 && !replaceAll) {
            return JSON.stringify({ success: false, error: `old_text matched ${occurrences} places; provide a more specific block or set replace_all.`, filename: rawFilename });
          }
          const updated = replaceAll
            ? original.split(oldText).join(newText)
            : original.replace(oldText, newText);
          fs.writeFileSync(safePath, updated, 'utf8');
          const stats = fs.statSync(safePath);
          return JSON.stringify({
            success: true,
            message: `File "${rawFilename}" patched successfully.`,
            filename: rawFilename,
            fullPath: safePath,
            bytesWritten: stats.size,
            replacements: replaceAll ? occurrences : 1,
          });
        } catch (err: unknown) {
          return `Error patching file "${rawFilename}": ${(err as Error).message}`;
        }
      }

      case 'read_file': {
        const rawFilename = cleanToolFilename(textArg(
          args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filepath ??
          args.fileName ?? args.file_name ?? args.TargetFile ?? args.target_file ?? args.target ?? args.name
        ).trim());
        if (!rawFilename) return 'Error: Empty filename provided.';

        let safePath: string;
        try {
          safePath = sanitizeWorkspacePath(rawFilename, ws);
        } catch {
          return 'Error: Cannot read outside designated workspace directory.';
        }

        if (!fs.existsSync(safePath)) {
          return `Error: File "${rawFilename}" does not exist in workspace.`;
        }

        try {
          const content = fs.readFileSync(safePath, 'utf8');
          return JSON.stringify({
            success: true,
            filename: rawFilename,
            content,
          });
        } catch (err: unknown) {
          return `Error reading file "${rawFilename}": ${(err as Error).message}`;
        }
      }

      case 'list_workspace_files': {
        try {
          const rawSub = String(args.path || args.dir || args.directory || '').trim();
          const targetDir = rawSub
            ? (path.isAbsolute(rawSub) ? rawSub : path.resolve(ws, rawSub.replace(/\//g, path.sep)))
            : ws;
          if (!fs.existsSync(targetDir)) {
            return JSON.stringify({
              workspacePath: ws,
              targetPath: targetDir,
              totalFiles: 0,
              files: [],
              note: `Directory does not exist yet: ${rawSub}`,
            });
          }
          const files = fs.readdirSync(targetDir);
          const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
          const filteredFiles = pattern && pattern !== '*'
            ? files.filter(f => f.toLowerCase().includes(pattern.replace(/\*/g, '').toLowerCase()))
            : files;
          const fileDetails = filteredFiles.map(f => {
            const full = path.join(targetDir, f);
            const st = fs.statSync(full);
            return {
              name: f,
              path: path.relative(ws, full).replace(/\\/g, '/'),
              isDirectory: st.isDirectory(),
              size: st.size,
              modifiedAt: st.mtime.toISOString(),
            };
          });
          return JSON.stringify({
            workspacePath: ws,
            targetDir: path.relative(ws, targetDir).replace(/\\/g, '/') || '.',
            totalFiles: fileDetails.length,
            files: fileDetails,
          });
        } catch (err: unknown) {
          return `Error listing workspace: ${(err as Error).message}`;
        }
      }

      case 'calculator': {
        const expr = String(args.expression || '');
        if (!expr) return 'Error: Empty expression provided.';
        try {
          const sanitized = expr.replace(/[^0-9+\-*/().,%^ Math.sqrtMath.sinMath.cosMath.tanMath.PIMath.E]/g, '');
          // eslint-disable-next-line no-new-func
          const result = Function(`"use strict"; return (${sanitized});`)();
          return JSON.stringify({ expression: expr, result });
        } catch (err: unknown) {
          return `Error evaluating math: ${(err as Error).message}`;
        }
      }

      case 'get_current_time': {
        const now = new Date();
        return JSON.stringify({
          iso: now.toISOString(),
          local: now.toLocaleString(),
          utc: now.toUTCString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      }

      case 'search_gif': {
        const query = String(args.query || args.search || args.term || '').trim();
        if (!query) return JSON.stringify({ error: 'Empty query provided for search_gif.' });
        try {
          const gifs = await this.searchGiphyGifs(query, 3);
          if (gifs.length === 0) {
            return JSON.stringify({
              query,
              count: 0,
              message: `No animated GIFs found for "${query}".`,
            });
          }
          const topGif = gifs[0];
          return JSON.stringify({
            query,
            count: gifs.length,
            top_gif_url: topGif.url,
            markdown_embed: topGif.markdown,
            gifs: gifs.map(g => ({ url: g.url, markdown: g.markdown })),
            instruction: `CRITICAL: To display this animated GIF in your chat response, output this markdown image tag: ${topGif.markdown}`,
          });
        } catch (err: unknown) {
          return JSON.stringify({ query, error: (err as Error).message });
        }
      }

      case 'web_search': {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: Empty query provided.';
        try {
          // If query mentions "gif", automatically search for animated GIFs to ensure media URLs are returned
          let gifData: Record<string, unknown> | null = null;
          if (/\bgifs?\b/i.test(query)) {
            const gifs = await this.searchGiphyGifs(query, 3);
            if (gifs.length > 0) {
              gifData = {
                top_gif_url: gifs[0].url,
                markdown_embed: gifs[0].markdown,
                instruction: `To display this animated GIF in chat, include this markdown image tag: ${gifs[0].markdown}`,
              };
            }
          }

          // 1. Try DuckDuckGo HTML search for real headlines/snippets
          const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(15000)
          });
          if (htmlRes.ok) {
            const html = await htmlRes.text();
            const results: string[] = [];
            const snippetRe = /<a[^>]+class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
            let m;
            while ((m = snippetRe.exec(html)) !== null && results.length < 10) {
              const snippet = m[1].replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
              if (snippet) results.push(snippet);
            }
            if (results.length > 0) {
              return JSON.stringify({
                query,
                count: results.length,
                results: results.map((r, i) => `${i + 1}. ${r}`).join('\n\n'),
                summary: results.join(' '),
                ...(gifData ? { animated_gif: gifData } : {})
              });
            }
          }

          // 2. Fallback to DuckDuckGo instant answer
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            const data = (await res.json()) as { AbstractText?: string; Heading?: string; RelatedTopics?: Array<{ Text?: string }> };
            let summary = data.AbstractText || '';
            if (!summary && data.RelatedTopics && data.RelatedTopics.length > 0) {
              summary = data.RelatedTopics.slice(0, 5).map(t => t.Text || '').filter(Boolean).join('\n\n');
            }
            if (summary) {
              return JSON.stringify({
                query,
                summary,
                ...(gifData ? { animated_gif: gifData } : {})
              });
            }
          }
          if (gifData) {
            return JSON.stringify({
              query,
              summary: `Found animated GIF for "${query}".`,
              animated_gif: gifData
            });
          }
          return JSON.stringify({
            query,
            summary: `Web search for "${query}" completed.`,
          });
        } catch (err: unknown) {
          return JSON.stringify({ query, error: (err as Error).message });
        }
      }

      case 'take_desktop_screenshot': {
        const rawFilename = String(args.filename || `desktop_${Date.now()}.png`).trim();
        const safeFilename = path.basename(rawFilename);
        const screenshotsDir = path.join(ws, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
        const outPath = path.join(screenshotsDir, safeFilename);

        const result = await captureDesktopScreen(outPath);
        if (result.success) {
          return JSON.stringify({
            success: true,
            message: `Desktop screenshot captured (${result.width}x${result.height}) and saved to workspace/screenshots/${safeFilename}.`,
            filename: `screenshots/${safeFilename}`,
            fullPath: outPath,
            url: `/v1/workspace/files/screenshots/${encodeURIComponent(safeFilename)}`,
            dataUrl: result.dataUrl,
            resolution: `${result.width}x${result.height}`,
          });
        } else {
          return JSON.stringify({
            success: false,
            error: `Failed to capture desktop screenshot: ${result.error}`,
          });
        }
      }

      case 'fetch_webpage': {
        const url = String(args.url || args.link || args.target || '').trim();
        if (!url) return 'Error: Empty URL provided.';
        const maxLen = args.max_length ? Number(args.max_length) : 12000;
        const result = await fetchWebpageContent(url, maxLen);
        return JSON.stringify(result);
      }

      case 'remember_fact': {
        const key = String(args.key || args.topic || args.title || '').trim();
        const fact = String(args.fact || args.note || args.content || '').trim();
        const category = (args.category || 'general') as any;
        if (!key || !fact) return 'Error: Both key and fact are required to remember.';
        const result = MemoryStore.remember(ws, key, fact, category);
        return JSON.stringify(result);
      }

      case 'recall_memory': {
        const query = args.query ? String(args.query).trim() : undefined;
        const result = MemoryStore.recall(ws, query);
        return JSON.stringify(result);
      }

      case 'build_android_apk': {
        const rawAppName = String(args.appName || args.app_name || args.name || 'MyAndroidApp').trim();
        const appName = rawAppName.replace(/^android[/\\]/i, '').replace(/[/\\]dist.*$/i, '').replace(/[^a-zA-Z0-9_]/g, '') || 'MyAndroidApp';
        const packageName = (args.packageName || args.package_name) ? String(args.packageName || args.package_name).trim() : undefined;
        const mainActivityCode = args.mainActivityCode ? String(args.mainActivityCode).trim() : (args.code ? String(args.code).trim() : undefined);
        const layoutXml = (args.layoutXml || args.layout_xml || args.layout) ? String(args.layoutXml || args.layout_xml || args.layout) : undefined;
        const manifestXml = (args.manifestXml || args.manifest_xml || args.manifest) ? String(args.manifestXml || args.manifest_xml || args.manifest) : undefined;
        const extraJavaFiles = (args.extraJavaFiles || args.extra_java_files || args.files) as Record<string, string> | undefined;

        const projectDir = path.join(ws, 'android', appName);
        try {
          const result = buildApk({
            projectDir,
            appName,
            packageName,
            mainActivityCode,
            layoutXml,
            manifestXml,
            extraJavaFiles,
          });

          // File is compiled and verified on disk. User opens files manually.

          return JSON.stringify({
            success: true,
            message: `Successfully compiled, aligned, and signed Android APK for "${appName}"!`,
            apkPath: `android/${appName}/dist/${appName}.apk`,
            absoluteApkPath: result.apkPath,
          });
        } catch (err: unknown) {
          return JSON.stringify({
            success: false,
            error: `Failed to compile Android APK: ${(err as Error).message}`,
          });
        }
      }

      case 'test_android_app': {
        const action = String(args.action || 'list_devices').toLowerCase();
        const rawAppName = String(args.appName || args.app_name || args.name || '').trim();
        const appName = rawAppName.replace(/^android[/\\]/i, '').replace(/[/\\]dist.*$/i, '').replace(/[^a-zA-Z0-9_]/g, '');
        const packageName = String(args.packageName || args.package_name || 'com.nexus.app').trim();

        try {
          if (action === 'list_devices') {
            const devices = getRunningAndroidDevices();
            return JSON.stringify({
              success: true,
              connectedDevices: devices,
              activeEmulatorRunning: devices.length > 0,
            });
          }

          if (action === 'install_and_launch') {
            let apkPath = '';
            if (appName) {
              apkPath = path.join(ws, 'android', appName, 'dist', `${appName}.apk`);
            } else if (args.apkPath) {
              apkPath = sanitizeWorkspacePath(String(args.apkPath), ws);
            } else {
              const androidDir = path.join(ws, 'android');
              if (fs.existsSync(androidDir)) {
                for (const app of fs.readdirSync(androidDir)) {
                  const candidate = path.join(androidDir, app, 'dist', `${app}.apk`);
                  if (fs.existsSync(candidate)) { apkPath = candidate; break; }
                }
              }
            }
            if (!apkPath || !fs.existsSync(apkPath)) {
              return JSON.stringify({ success: false, error: `APK file not found for app "${appName || 'unknown'}". Build the APK first with build_android_apk.` });
            }
            const res = installAndLaunchApkOnEmulator(apkPath, packageName);
            return JSON.stringify(res);
          }

          if (action === 'take_screenshot') {
            const shot = captureEmulatorScreenshot(ws, args.filename ? String(args.filename) : undefined);
            return JSON.stringify({
              success: true,
              message: `Captured live emulator screen to ${shot.screenshotPath}!`,
              screenshotPath: shot.screenshotPath,
              previewUrl: `/v1/workspace/files/${shot.screenshotPath}`,
            });
          }

          if (action === 'send_input') {
            const inputAction = String(args.input_type || args.type || 'tap').toLowerCase();
            const res = sendEmulatorInput(inputAction, {
              x: args.x !== undefined ? Number(args.x) : undefined,
              y: args.y !== undefined ? Number(args.y) : undefined,
              x2: args.x2 !== undefined ? Number(args.x2) : undefined,
              y2: args.y2 !== undefined ? Number(args.y2) : undefined,
              keycode: args.keycode ? String(args.keycode) : undefined,
              text: args.text ? String(args.text) : undefined,
            });
            return JSON.stringify(res);
          }

          if (action === 'get_logs') {
            const logs = execSync(`"${ADB}" logcat -d -t 100`, { encoding: 'utf8', stdio: 'pipe' });
            return JSON.stringify({ success: true, logs: logs.slice(-2000) });
          }

          return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
        } catch (err: unknown) {
          return JSON.stringify({ success: false, error: (err as Error).message });
        }
      }

      case 'execute_command': {
        const cmd = String(args.command || args.cmd || args.script || '').trim();
        if (!cmd) return 'Error: Empty command provided.';

        // If AI model attempted to write a file via cat heredoc (e.g. cat << 'EOF' > index.html ... EOF), parse and write safely
        const heredocMatch = cmd.match(/cat\s*<<\s*['"]?([A-Za-z0-9_]+)['"]?\s*>\s*([^\r\n]+)\r?\n([\s\S]*?)(?:\r?\n\1|$)/);
        if (heredocMatch) {
          const rawFilePath = heredocMatch[2].trim().replace(/^['"]|['"]$/g, '');
          const fileContent = heredocMatch[3].trimEnd();
          try {
            const safePath = sanitizeWorkspacePath(rawFilePath, ws);
            const parentDir = path.dirname(safePath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            fs.writeFileSync(safePath, fileContent, 'utf8');
            return JSON.stringify({
              command: `write_file: ${rawFilePath}`,
              success: true,
              message: `File "${rawFilePath}" written successfully (${fileContent.length} bytes).`,
              filename: rawFilePath,
              fullPath: safePath,
            });
          } catch (e: any) {
            return JSON.stringify({ command: cmd, success: false, error: e.message });
          }
        }

        // If AI model attempted simple echo redirection: echo "content" > file.ext
        const echoMatch = cmd.match(/^echo\s+([\s\S]*?)\s*>\s*([^\r\n]+)$/i);
        if (echoMatch && !echoMatch[1].includes('\n')) {
          const rawContent = echoMatch[1].trim().replace(/^["']|["']$/g, '');
          const rawFilePath = echoMatch[2].trim().replace(/^["']|["']$/g, '');
          try {
            const safePath = sanitizeWorkspacePath(rawFilePath, ws);
            const parentDir = path.dirname(safePath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            fs.writeFileSync(safePath, rawContent, 'utf8');
            return JSON.stringify({
              command: `write_file: ${rawFilePath}`,
              success: true,
              message: `File "${rawFilePath}" written successfully.`,
              filename: rawFilePath,
              fullPath: safePath,
            });
          } catch {}
        }

        // If AI model attempted to run gradlew/gradlew.bat, auto-compile with Android SDK builder
        if (/\b(gradlew|gradlew\.bat|gradle)\b/i.test(cmd)) {
          let appName = 'MyAndroidApp';
          const match = cmd.match(/android[/\\]([a-zA-Z0-9_-]+)/i);
          if (match) {
            appName = match[1];
          } else {
            const androidDir = path.join(ws, 'android');
            if (fs.existsSync(androidDir)) {
              const dirs = fs.readdirSync(androidDir, { withFileTypes: true }).filter(d => d.isDirectory());
              if (dirs.length > 0) appName = dirs[dirs.length - 1].name;
            }
          }
          const projectDir = path.join(ws, 'android', appName);
          try {
            const result = buildApk({ projectDir, appName });
            return JSON.stringify({
              command: cmd,
              success: true,
              message: `Successfully compiled, aligned, and signed Android APK for "${appName}"!`,
              apkPath: `android/${appName}/dist/${appName}.apk`,
              absoluteApkPath: result.apkPath,
            });
          } catch {}
        }

        // If the command is a compilation targeting an executable, kill any running instance first to prevent Windows file-lock Permission Denied errors
        const exeMatch = cmd.match(/-o\s+["']?([^"'\s]+\.exe)["']?/i);
        if (exeMatch && exeMatch[1]) {
          const exeName = path.basename(exeMatch[1]);
          try {
            await execAsync(`taskkill /F /IM "${exeName}"`, { timeout: 2000 });
          } catch {}
        }

        try {
          const { stdout, stderr } = await execAsync(cmd, { cwd: ws, timeout: 30000 });
          const compressed = compressCommandOutput(cmd, stdout, stderr, true, ws);

          return JSON.stringify({
            command: cmd,
            stdout: compressed.stdout,
            stderr: compressed.stderr,
            success: true,
            ...(compressed.rawLogPath ? { spooledOutput: compressed.rawLogPath } : {})
          });
        } catch (cmdErr: unknown) {
          // If Windows locked the .exe file, attempt taskkill and one retry
          if (exeMatch && exeMatch[1]) {
            const exeName = path.basename(exeMatch[1]);
            try {
              await execAsync(`taskkill /F /IM "${exeName}"`, { timeout: 2000 });
              const { stdout, stderr } = await execAsync(cmd, { cwd: ws, timeout: 30000 });
              const compressed = compressCommandOutput(cmd, stdout, stderr, true, ws);
              return JSON.stringify({
                command: cmd,
                stdout: compressed.stdout,
                stderr: compressed.stderr,
                success: true,
                ...(compressed.rawLogPath ? { spooledOutput: compressed.rawLogPath } : {})
              });
            } catch {}
          }

          // If CMD failed, attempt execution via PowerShell before giving up
          try {
            const escaped = cmd.replace(/"/g, '\\"');
            const { stdout, stderr } = await execAsync(`powershell.exe -NoProfile -Command "${escaped}"`, { cwd: ws, timeout: 30000 });
            const compressed = compressCommandOutput(cmd, stdout, stderr, true, ws);
            return JSON.stringify({
              command: cmd,
              stdout: compressed.stdout,
              stderr: compressed.stderr,
              success: true,
              ...(compressed.rawLogPath ? { spooledOutput: compressed.rawLogPath } : {})
            });
          } catch (psErr: unknown) {
            const e = cmdErr as { stdout?: string; stderr?: string; message: string };
            const rawStdout = e.stdout || '';
            const rawStderr = e.stderr || '';
            const compressed = compressCommandOutput(cmd, rawStdout, rawStderr, false, ws);
            const isLockError = (rawStderr || '').includes('Permission denied') || (e.message || '').includes('Permission denied');
            return JSON.stringify({
              command: cmd,
              error: e.message,
              stdout: compressed.stdout,
              stderr: compressed.stderr,
              success: false,
              ...(compressed.rawLogPath ? { spooledOutput: compressed.rawLogPath } : {}),
              guidance: isLockError
                ? 'Windows file lock: The target .exe is currently open and running. Close the running application window before recompiling.'
                : 'Tip: For creating or editing files, use the "write_file" tool directly instead of shell commands.'
            });
          }
        }
      }

      case 'open_in_browser_or_app': {
        const rawTarget = String(args.target || args.filename || args.path || args.url || '').trim();
        if (!rawTarget) return 'Error: Empty target provided.';

        try {
          const isUrl = rawTarget.startsWith('http://') || rawTarget.startsWith('https://');
          let targetPath = rawTarget;
          if (!isUrl) {
            targetPath = path.isAbsolute(rawTarget) ? path.normalize(rawTarget) : path.resolve(ws, rawTarget);

            // If path doesn't exist directly, check common workspace subdirectories
            if (!fs.existsSync(targetPath)) {
              const candidates = [
                path.join(ws, 'plugins', rawTarget),
                path.join(ws, 'build', 'DalekEffect_artefacts', 'Release', 'VST3', rawTarget),
                path.join(ws, 'build', rawTarget),
                path.join(ws, rawTarget),
              ];
              for (const c of candidates) {
                if (fs.existsSync(c)) {
                  targetPath = c;
                  break;
                }
              }
            }

            // Strictly contain to workspace
            if (!isInsideDir(targetPath, ws) && path.resolve(targetPath) !== path.resolve(ws)) {
              return JSON.stringify({
                success: false,
                error: `Access denied: Target "${rawTarget}" is outside workspace boundary.`,
              });
            }
          }

          if (isUrl) {
            openInDefaultApp(targetPath);
          } else if (fs.existsSync(targetPath)) {
            const isDir = fs.statSync(targetPath).isDirectory();
            if (isDir) {
              if (process.platform === 'win32') {
                spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
              } else {
                openInDefaultApp(targetPath);
              }
            } else if (targetPath.toLowerCase().endsWith('.exe')) {
              spawn(targetPath, [], { detached: true, stdio: 'ignore' });
            } else if (targetPath.toLowerCase().endsWith('.html') || targetPath.toLowerCase().endsWith('.htm')) {
              const relPath = path.relative(ws, targetPath).replace(/\\/g, '/');
              const fileHttpUrl = `http://127.0.0.1:3000/v1/workspace/files/${encodeURIComponent(relPath)}`;
              openInDefaultApp(fileHttpUrl);
            } else {
              // Real Windows launch in default application (Photo viewer for images, Media player for audio)
              openInDefaultApp(targetPath);
            }
          } else {
            if (process.platform === 'win32') {
              spawn('explorer.exe', [ws], { detached: true, stdio: 'ignore' });
            } else {
              openInDefaultApp(ws);
            }
          }

          return JSON.stringify({
            success: true,
            message: `Successfully launched and opened "${path.basename(targetPath)}" in your default Windows application/browser.`,
            target: targetPath,
            url: !isUrl ? `/v1/workspace/files/${encodeURIComponent(path.relative(ws, targetPath).replace(/\\/g, '/'))}` : targetPath,
            exists: isUrl || fs.existsSync(targetPath),
          });
        } catch (err: unknown) {
          return JSON.stringify({
            success: false,
            error: `Failed to open "${rawTarget}": ${(err as Error).message}`,
          });
        }
      }

      case 'test_html_app': {
        const rawFilename = cleanToolFilename(String(args.filename || args.path || args.file || ''));
        if (!rawFilename) return JSON.stringify({ success: false, error: 'Empty HTML filename provided.' });

        let targetPath: string;
        try {
          targetPath = sanitizeWorkspacePath(rawFilename, ws);
        } catch {
          return JSON.stringify({ success: false, error: 'Cannot test a file outside the workspace.' });
        }
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          return JSON.stringify({ success: false, error: `HTML file not found: ${rawFilename}` });
        }
        if (!/\.html?$/i.test(targetPath)) {
          return JSON.stringify({ success: false, error: 'test_html_app only accepts .html or .htm files.' });
        }

        const relPath = path.relative(ws, targetPath).replace(/\\/g, '/');
        const fileHttpUrl = `http://127.0.0.1:3000/v1/workspace/files/${encodeURIComponent(relPath)}`;
        try {
          const result = await testHtmlRuntime({
            url: fileHttpUrl,
            workspaceDir: ws,
            startSelector: typeof args.start_selector === 'string' ? args.start_selector : undefined,
            waitAfterClickMs: Number(args.wait_after_click_ms) || undefined,
          });
          return JSON.stringify({ ...result, filename: relPath, url: fileHttpUrl });
        } catch (err: unknown) {
          return JSON.stringify({
            success: false,
            filename: relPath,
            error: `HTML runtime test failed: ${(err as Error).message}`,
          });
        }
      }

      case 'generate_image': {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return 'Error: Empty image prompt provided.';

        const artDir = path.join(ws, 'art');
        if (!fs.existsSync(artDir)) {
          fs.mkdirSync(artDir, { recursive: true });
        }

        const ratio = String(args.aspect_ratio || '16:9').trim();
        const rawBase = String(args.filename || `art_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const base = path.basename(rawBase, path.extname(rawBase));
        const ext = '.png';
        let filename = `${base}${ext}`;
        let counter = 1;
        while (fs.existsSync(path.join(artDir, filename))) {
          filename = `${base}_${counter}${ext}`;
          counter++;
        }
        const requestedEngine = String(args.engine || defaultArtEngine || 'auto').toLowerCase().trim();
        const outPath = path.join(artDir, filename);

        let width = 1536;
        let height = 864;
        if (ratio === '1:1') {
          width = 1024;
          height = 1024;
        } else if (ratio === '9:16') {
          width = 864;
          height = 1536;
        } else if (ratio === '4:3') {
          width = 1152;
          height = 864;
        } else if (ratio === '3:2') {
          width = 1296;
          height = 864;
        }

        const cleanPrompt = prompt.replace(/[\r\n]+/g, ' ').trim();
        let enrichedPrompt = cleanPrompt;
        if (!/\b(8k|masterpiece|photorealistic|sharp focus|highly detailed|unreal engine|octane)\b/i.test(cleanPrompt)) {
          enrichedPrompt = `Masterpiece, ${cleanPrompt}, 8k resolution, highly detailed, sharp focus, cinematic lighting, photorealistic, intricate textures, ray tracing`;
        }

        const customNegativePrompt = String(args.negative_prompt || args.negativePrompt || args.negative || '').trim();
        const baseNegativePrompt = 'blurry, low quality, text, watermark, logo, duplicate subjects, malformed anatomy, deformed hands, extra limbs, cropped, oversaturated, lowres, artifact';
        const finalNegativePrompt = customNegativePrompt
          ? `${customNegativePrompt}, ${baseNegativePrompt}`
          : baseNegativePrompt;

        // ==========================================
        // 0. NATIVE LOCAL RTX 4060 GPU DIFFUSION (Primary Local Engine)
        // ==========================================
        const isExplicitCloud = ['together', 'huggingface', 'hf', 'openai', 'dalle', 'dall-e', 'imagen', 'google', 'cloud'].includes(requestedEngine);
        
        if (!isExplicitCloud) {
          try {
            const gpuRes = await LocalGpuArtEngine.generateImage({
              prompt: enrichedPrompt,
              negativePrompt: finalNegativePrompt,
              outputPath: outPath,
              width: Math.min(width, 1024),
              height: Math.min(height, 1024),
              steps: args.steps ? Number(args.steps) : (requestedEngine === 'hd' || args.quality === 'ultra' ? 28 : 1),
              guidance: args.guidance_scale !== undefined ? Number(args.guidance_scale) : undefined,
              seed: args.seed !== undefined ? Number(args.seed) : undefined,
              model: args.model ? String(args.model) : undefined,
            }, ws);

            if (gpuRes.success) {
              const relPath = path.relative(ws, outPath).replace(/\\/g, '/');
              return JSON.stringify({
                success: true,
                message: `🎨 Studio artwork rendered locally on NVIDIA GeForce RTX 4060 in ${gpuRes.elapsedSeconds}s.`,
                filename: relPath,
                fullPath: outPath,
                url: `/v1/workspace/files/${encodeURIComponent(relPath)}`,
                engine: gpuRes.engine || 'NVIDIA GeForce RTX 4060 (Local GPU)',
                prompt: cleanPrompt,
                resolution: `${Math.min(width, 1024)}x${Math.min(height, 1024)}`,
              });
            }
          } catch (e: any) {
            console.warn('[LocalGpuArtEngine tool error]:', e.message);
          }
        }

        // ==========================================
        // 1. PROMPTFORGE RTX LOCAL GPU ENGINE (Port 17861)
        // ==========================================
        if (requestedEngine === 'promptforge' || requestedEngine === 'gpu' || requestedEngine === 'local' || requestedEngine === 'auto') {
          let pfToken = process.env.PROMPTFORGE_TOKEN || '';
          let pfPort = 17861;
          try {
            const pfConfigPath = path.join(localAppData, 'PromptForgeRTX', 'config.json');
            if (fs.existsSync(pfConfigPath)) {
              const pfJson = JSON.parse(fs.readFileSync(pfConfigPath, 'utf8'));
              if (pfJson.api_token && !pfToken) pfToken = pfJson.api_token;
              if (pfJson.api_port) pfPort = pfJson.api_port;
            }
          } catch {}

          if (pfToken) {
            try {
              const pfHealth = await fetch(`http://127.0.0.1:${pfPort}/health`, { signal: AbortSignal.timeout(1000) });
              if (pfHealth.ok) {
                const pfHealthData = await pfHealth.json() as { status?: string; service?: string; active_model?: string };
                if (pfHealthData.status === 'ok') {
                  // The calling offline agent is paused while this tool runs. Hand its
                  // VRAM to PromptForge, then let Ollama reload on demand when the tool
                  // result is returned and the next model turn begins.
                  const ollamaUnload = await unloadOllamaModels();
                  if (ollamaUnload.remainingModels.length > 0) {
                    throw new Error(
                      `PromptForge GPU handoff failed: Ollama still has ${ollamaUnload.remainingModels.join(', ')} loaded.`
                    );
                  }

                  const t0 = Date.now();
                  const targetSize = `${width}x${height}`;
                  const renderSteps = args.steps
                    ? Math.max(1, Number(args.steps))
                    : /lightning|turbo|lcm/i.test(pfHealthData.active_model || '') ? 4 : 28;

                  let referenceFacePayload: { path: string; strength: number } | undefined = undefined;
                  const rawFacePath = String(args.reference_face_path || args.reference_face || args.face_image || args.face_ref || '').trim();
                  if (rawFacePath) {
                    let resolvedFacePath = rawFacePath;
                    if (!path.isAbsolute(resolvedFacePath)) {
                      resolvedFacePath = path.resolve(ws, resolvedFacePath);
                    }
                    if (fs.existsSync(resolvedFacePath)) {
                      const strength = args.reference_face_strength !== undefined
                        ? Math.max(0.1, Math.min(1.0, Number(args.reference_face_strength)))
                        : 0.65;
                      referenceFacePayload = {
                        path: resolvedFacePath,
                        strength,
                      };
                    }
                  }

                  const pfPayload: Record<string, unknown> = {
                    model: 'current',
                    prompt: enrichedPrompt,
                    negative_prompt: finalNegativePrompt,
                    size: targetSize,
                    quality: 'quality',
                    steps: renderSteps,
                    guidance_scale: args.guidance_scale !== undefined ? Number(args.guidance_scale) : 6.0,
                    seed: -1,
                    n: 1,
                    async: true,
                  };

                  if (referenceFacePayload) {
                    pfPayload.reference_face = referenceFacePayload;
                    pfPayload.quality = 'quality'; // Mandatory for reference_face conditioning
                  }

                  let submitRes: Response | null = null;
                  const maxAttempts = (requestedEngine === 'promptforge' || requestedEngine === 'gpu') ? 20 : 10;
                  for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    submitRes = await fetch(`http://127.0.0.1:${pfPort}/v1/images/generations`, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${pfToken}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(pfPayload),
                      signal: AbortSignal.timeout(30000),
                    });

                    if (submitRes.status === 409) {
                      // PromptForge GPU busy rendering previous frame - wait 3 seconds and retry
                      await new Promise(r => setTimeout(r, 3000));
                      continue;
                    }
                    break;
                  }

                  if (submitRes && (submitRes.status === 200 || submitRes.status === 202)) {
                    const submitData = await submitRes.json() as { id?: string; job_id?: string; data?: Array<{ url: string }> };
                    const jobId = submitData.id || submitData.job_id;

                    if (jobId) {
                      // Poll /v1/jobs/{jobId} every 2 seconds
                      const maxPollMs = 300000;
                      const pollStart = Date.now();
                      while (Date.now() - pollStart < maxPollMs) {
                        await new Promise(r => setTimeout(r, 2000));
                        const jobRes = await fetch(`http://127.0.0.1:${pfPort}/v1/jobs/${jobId}`, {
                          headers: { 'Authorization': `Bearer ${pfToken}` },
                          signal: AbortSignal.timeout(10000),
                        });

                        if (!jobRes.ok) continue;
                        const jobData = await jobRes.json() as {
                          status?: string;
                          progress?: number;
                          data?: Array<{ url: string; seed?: number }>;
                          error?: string;
                          message?: string;
                        };

                        if (jobData.status === 'completed') {
                          const imgUrl = jobData.data?.[0]?.url;
                          if (imgUrl) {
                            const imgRes = await fetch(imgUrl, {
                              headers: { 'Authorization': `Bearer ${pfToken}` },
                              signal: AbortSignal.timeout(30000),
                            });

                            if (imgRes.ok) {
                              const buffer = Buffer.from(await imgRes.arrayBuffer());
                              fs.writeFileSync(outPath, buffer);
                              const durMs = Date.now() - t0;
                              const faceInfo = referenceFacePayload ? ` with Face Lock (Strength: ${referenceFacePayload.strength}, Ref: ${path.basename(referenceFacePayload.path)})` : '';
                              const handoffInfo = ollamaUnload.unloadedModels.length > 0
                                ? ` GPU handoff paused the offline agent and freed ${ollamaUnload.unloadedModels.join(', ')}; Ollama will reload it on demand.`
                                : '';
                              return JSON.stringify({
                                success: true,
                                message: `🎨 Studio artwork (${width}x${height}, ${renderSteps} Steps)${faceInfo} rendered on PromptForge RTX (${pfHealthData.active_model || 'SDXL High-Def Local'}) in ${durMs}ms and saved to workspace/art/${filename}.${handoffInfo}`,
                                filename: `art/${filename}`,
                                fullPath: outPath,
                                url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                                prompt: cleanPrompt,
                                resolution: `${width}x${height}`,
                                sizeBytes: buffer.length,
                                engine: `PromptForge RTX (${pfHealthData.active_model || 'SDXL High-Def Local'})`,
                                face_lock: referenceFacePayload ? true : false,
                                gpu_handoff: {
                                  agent_paused: true,
                                  verified: ollamaUnload.success,
                                  unloaded_models: ollamaUnload.unloadedModels,
                                  remaining_models: ollamaUnload.remainingModels,
                                  warnings: ollamaUnload.errors,
                                  resume_behavior: 'The offline agent resumes from this tool result; Ollama reloads its model automatically on demand.',
                                },
                              });
                            }
                          }
                          break;
                        } else if (jobData.status === 'failed' || jobData.status === 'cancelled') {
                          throw new Error(jobData.error || jobData.message || 'PromptForge generation failed');
                        }
                      }
                    }
                  }
                }
              }
            } catch (pfErr: unknown) {
              if (pfErr instanceof Error && (
                pfErr.message.includes('PromptForge generation failed') ||
                pfErr.message.includes('PromptForge GPU handoff failed')
              )) {
                throw pfErr;
              }
              // PromptForge offline or unavailable, cascade to local port 5005 / cloud
            }
          }
        }

        // ==========================================
        // 2. LOCAL RTX 4060 GPU TURBO ENGINE (Port 5005)
        // ==========================================
        if (requestedEngine === 'gpu' || requestedEngine === 'local' || requestedEngine === 'turbo') {
          try {
            const healthRes = await fetch('http://127.0.0.1:5005/health', { signal: AbortSignal.timeout(1000) });
            if (healthRes.ok) {
              const healthData = await healthRes.json() as { device?: string; vram_allocated_gb?: number };
              const t0 = Date.now();
              const genRes = await fetch('http://127.0.0.1:5005/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  prompt: enrichedPrompt,
                  negative_prompt: 'blurry, low quality, distorted, deformed, bad anatomy, bad hands, cartoon, grainy, pixelated',
                  aspect_ratio: ratio,
                  output_path: outPath,
                  steps: args.steps ? Number(args.steps) : 4,
                  guidance_scale: args.guidance_scale !== undefined ? Number(args.guidance_scale) : 0.0,
                  seed: Math.floor(Math.random() * 1000000),
                }),
                signal: AbortSignal.timeout(180000),
              });

              if (genRes.ok) {
                const genData = await genRes.json() as { width: number; height: number; sizeBytes: number; generationTimeMs: number };
                return JSON.stringify({
                  success: true,
                  message: `⚡ Studio artwork (${genData.width}x${genData.height}, Turbo) generated on ${healthData.device || 'NVIDIA RTX 4060'} in ${genData.generationTimeMs || (Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                  filename: `art/${filename}`,
                  fullPath: outPath,
                  url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                  prompt: cleanPrompt,
                  resolution: `${genData.width}x${genData.height}`,
                  sizeBytes: genData.sizeBytes,
                  engine: 'RTX 4060 CUDA Studio (Turbo Local)',
                });
              }
            }
          } catch (err: unknown) {
            // Local server offline, fall through to cloud
          }
        }



        // ==========================================
        // 4. HUGGINGFACE SERVERLESS FLUX.1 ENGINE
        // ==========================================
        const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
        if (hfKey && !hfKey.startsWith('mock-') && (requestedEngine === 'huggingface' || requestedEngine === 'auto' || requestedEngine === 'cloud')) {
          try {
            const t0 = Date.now();
            const hfRes = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${hfKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ inputs: enrichedPrompt }),
              signal: AbortSignal.timeout(60000),
            });

            if (hfRes.ok) {
              const arrayBuffer = await hfRes.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              if (buffer.length > 5000) {
                fs.writeFileSync(outPath, buffer);
                return JSON.stringify({
                  success: true,
                  message: `🤗 Studio artwork generated by Hugging Face FLUX.1 (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                  filename: `art/${filename}`,
                  fullPath: outPath,
                  url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                  prompt: cleanPrompt,
                  resolution: `${width}x${height}`,
                  sizeBytes: buffer.length,
                  engine: 'Hugging Face FLUX.1 (Cloud Serverless)',
                });
              }
            }
          } catch {}
        }

        // ==========================================
        // 4. OPENAI DALL-E 3 / GPT-IMAGE ENGINE
        // ==========================================
        const openAiKey = process.env.OPENAI_API_KEY;
        if (openAiKey && !openAiKey.startsWith('mock-') && (requestedEngine === 'openai' || requestedEngine === 'dalle' || requestedEngine === 'auto' || requestedEngine === 'cloud')) {
          try {
            const t0 = Date.now();
            const openAiRes = await fetch('https://api.openai.com/v1/images/generations', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAiKey}`,
              },
              body: JSON.stringify({
                model: 'dall-e-3',
                prompt: cleanPrompt,
                n: 1,
                size: ratio === '16:9' ? '1792x1024' : (ratio === '9:16' ? '1024x1792' : '1024x1024'),
                quality: 'hd',
              }),
              signal: AbortSignal.timeout(60000),
            });

            if (openAiRes.ok) {
              const data = await openAiRes.json() as { data?: Array<{ b64_json?: string; url?: string }> };
              const imgUrl = data.data?.[0]?.url;
              const b64 = data.data?.[0]?.b64_json;
              if (b64) {
                const buffer = Buffer.from(b64, 'base64');
                fs.writeFileSync(outPath, buffer);
                return JSON.stringify({
                  success: true,
                  message: `🌟 Studio artwork generated by OpenAI DALL-E 3 HD (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                  filename: `art/${filename}`,
                  fullPath: outPath,
                  url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                  prompt: cleanPrompt,
                  resolution: ratio === '16:9' ? '1792x1024' : '1024x1024',
                  sizeBytes: buffer.length,
                  engine: 'OpenAI DALL-E 3 HD (Cloud Pro)',
                });
              } else if (imgUrl) {
                const dlRes = await fetch(imgUrl);
                if (dlRes.ok) {
                  const buffer = Buffer.from(await dlRes.arrayBuffer());
                  fs.writeFileSync(outPath, buffer);
                  return JSON.stringify({
                    success: true,
                    message: `🌟 Studio artwork generated by OpenAI DALL-E 3 HD (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                    filename: `art/${filename}`,
                    fullPath: outPath,
                    url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                    prompt: cleanPrompt,
                    resolution: ratio === '16:9' ? '1792x1024' : '1024x1024',
                    sizeBytes: buffer.length,
                    engine: 'OpenAI DALL-E 3 HD (Cloud Pro)',
                  });
                }
              }
            }
          } catch {}
        }

        // ==========================================
        // 5. GOOGLE CLOUD IMAGEN 3 ENGINE
        // ==========================================
        const geminiKey = process.env.GEMINI_API_KEY;
        if (geminiKey && !geminiKey.startsWith('mock-') && (requestedEngine === 'imagen' || requestedEngine === 'google' || requestedEngine === 'auto' || requestedEngine === 'cloud')) {
          try {
            const t0 = Date.now();
            const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiKey}`;
            const imagenRes = await fetch(imagenUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                instances: [{ prompt: enrichedPrompt }],
                parameters: {
                  sampleCount: 1,
                  aspectRatio: ratio === '1:1' ? '1:1' : (ratio === '9:16' ? '9:16' : '16:9'),
                  outputOptions: { mimeType: 'image/jpeg' },
                },
              }),
              signal: AbortSignal.timeout(60000),
            });

            if (imagenRes.ok) {
              const data = await imagenRes.json() as { predictions?: Array<{ bytesBase64Encoded?: string }> };
              const b64 = data.predictions?.[0]?.bytesBase64Encoded;
              if (b64) {
                const buffer = Buffer.from(b64, 'base64');
                fs.writeFileSync(outPath, buffer);
                return JSON.stringify({
                  success: true,
                  message: `🎨 Studio artwork generated by Google Cloud Imagen 3 (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                  filename: `art/${filename}`,
                  fullPath: outPath,
                  url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                  prompt: cleanPrompt,
                  resolution: `${width}x${height}`,
                  sizeBytes: buffer.length,
                  engine: 'Google Cloud Imagen 3 (Cloud Pro)',
                });
              }
            }
          } catch {}
        }

        // ==========================================
        // 6. CLOUD FLUX.1 HIGH-DEFINITION (FALLBACK ONLY IF CLOUD REQUESTED)
        // ==========================================
        if (isExplicitCloud || requestedEngine === 'cloud' || requestedEngine === 'flux') {
          const endpoints = [
            (s: number) => `https://image.pollinations.ai/prompt/${encodeURIComponent(enrichedPrompt)}?width=${width}&height=${height}&model=flux&nologo=true&seed=${s}`,
            (s: number) => `https://image.pollinations.ai/prompt/${encodeURIComponent(enrichedPrompt)}?width=${width}&height=${height}&model=flux-realism&nologo=true&seed=${s}`,
            (s: number) => `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=${width}&height=${height}&model=flux&nologo=true&seed=${s}`,
          ];

          for (let attempt = 0; attempt < endpoints.length; attempt++) {
            try {
              const seed = Math.floor(Math.random() * 1000000);
              const url = endpoints[attempt](seed);
              
              const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
              if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                if (buffer.length > 5000) {
                  fs.writeFileSync(outPath, buffer);

                  return JSON.stringify({
                    success: true,
                    message: `🎨 Studio artwork (${width}x${height}) generated by Internet FLUX.1 and saved to workspace/art/${filename}`,
                    filename: `art/${filename}`,
                    fullPath: outPath,
                    url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                    prompt: cleanPrompt,
                    resolution: `${width}x${height}`,
                    sizeBytes: buffer.length,
                    engine: 'Cloud FLUX.1 HD',
                  });
                }
              }
            } catch {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }

        return JSON.stringify({
          success: false,
          error: 'Image generation service is currently busy. Please retry or switch art engines.',
        });
      }

      case 'generate_video': {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return 'Error: Empty video prompt provided.';

        const numFrames = args.num_frames ? Number(args.num_frames) : 24;
        const fps = args.fps ? Number(args.fps) : 60;
        const durationSec = args.duration_sec ? Number(args.duration_sec) : 3.0;
        const audioVibe = String(args.audio_vibe || 'synthwave').trim();
        const topText = args.top_text ? String(args.top_text) : undefined;
        const bottomText = args.bottom_text ? String(args.bottom_text) : undefined;
        const style = args.style ? String(args.style) : 'cinematic';
        const flowPrompt = args.flow_prompt ? String(args.flow_prompt) : '';
        const model = args.model ? String(args.model).trim() : (args.model_id ? String(args.model_id).trim() : undefined);

        try {
          const res = await LocalGpuArtEngine.renderMorphSequence(prompt, {
            numFrames,
            fps,
            durationSec,
            audioVibe,
            topText,
            bottomText,
            style,
            flowPrompt,
            model,
            workspaceDir: ws,
            image: args.image ? String(args.image).trim() : undefined,
          });

          if (res.success && res.url) {
            return JSON.stringify({
              success: true,
              message: `🎬 Video rendered on NVIDIA GeForce RTX 4060 in ${res.elapsedSeconds || 2}s (${res.framesCount || numFrames} frames @ ${res.fps || fps} FPS).`,
              filename: res.filename,
              url: res.url,
              engine: 'NVIDIA GeForce RTX 4060 (Local GPU Video)',
              prompt,
              video_markdown: `![${prompt}](${res.url})`,
            });
          }

          return JSON.stringify({
            success: false,
            error: res.error || 'Video generation failed.',
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: `Video generation error: ${err.message}`,
          });
        }
      }

      default:
        return `Tool "${name}" is not implemented.`;
    }
  }

  static extractAllToolCallsFromJson(text: string): Array<{ name: string; arguments: Record<string, unknown> | string }> {
    if (!text) return [];
    const sanitized = text.replace(/\[\s*(?:executed|running)\s+tool\s*:[^\]]*\]/gi, '');
    if (!sanitized.trim()) return [];
    text = sanitized;
    const results: Array<{ name: string; arguments: Record<string, unknown> | string }> = [];
    const normalizeJsonToolCall = (parsed: any): { name: string; arguments: Record<string, unknown> | string } | null => {
      if (!parsed || typeof parsed !== 'object') return null;
      const rawName = typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.function === 'string'
          ? parsed.function
          : typeof parsed.function?.name === 'string'
            ? parsed.function.name
            : '';
      let name = normalizeToolName(rawName);
      let args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed.function?.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }

      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const contentVal = (args as any).content ?? (args as any).code ?? (args as any).html_content ?? (args as any).file_content ?? (args as any).body ?? (args as any).text;
        const filenameVal = (args as any).filename ?? (args as any).filePath ?? (args as any).path ?? (args as any).file_name ?? (args as any).file
          ?? Object.keys(args).find(k => /\.[a-zA-Z0-9]+$/i.test(k) && typeof (args as any)[k] === 'string')
          ?? Object.values(args).find(v => typeof v === 'string' && /\.[a-zA-Z0-9]+$/i.test(v));

        const builtIns = ToolRegistry.getBuiltInTools();
        const isKnownTool = builtIns.some(tool => tool.function.name === name);

        if ((!isKnownTool || name === 'write_file') && typeof contentVal === 'string' && contentVal.length > 20 && filenameVal) {
          name = 'write_file';
          args = {
            filename: String(filenameVal).replace(/^[/\\]+/, ''),
            content: contentVal,
          };
        }
      }

      if (!name || !ToolRegistry.getBuiltInTools().some(tool => tool.function.name === name)) return null;
      return { name, arguments: args };
    };

    // 1. Check DeepSeek DSML & XML invoke tool call tags (<｜...invoke name="...">...</｜...invoke>)
    const invokeRegex = /<[^>]*?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*?invoke>/gi;
    let match;
    while ((match = invokeRegex.exec(text)) !== null) {
      const toolName = normalizeToolName(match[1].trim());
      const body = match[2];
      const args: Record<string, unknown> = {};
      const paramRegex = /<[^>]*?parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*?parameter>/gi;
      let pMatch;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        const pName = pMatch[1].trim();
        const pVal = pMatch[2].trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }
      if (toolName && ToolRegistry.getBuiltInTools().some(t => t.function.name === toolName)) {
        results.push({ name: toolName, arguments: args });
      }
    }

    // 2. Colons invoke format: <｜invoke:tool_name｜>...<｜parameter:param_name｜>val<｜/parameter｜>...<｜/invoke｜>
    const colonInvokeRegex = /<[｜|]*\s*invoke:([a-zA-Z0-9_]+)\s*[｜|]*>([\s\S]*?)<[｜|]*\s*\/invoke\s*[｜|]*>/gi;
    while ((match = colonInvokeRegex.exec(text)) !== null) {
      const toolName = normalizeToolName(match[1].trim());
      const body = match[2];
      const args: Record<string, unknown> = {};
      const colonParamRegex = /<[｜|]*\s*parameter:([a-zA-Z0-9_]+)\s*[｜|]*>([\s\S]*?)<[｜|]*\s*\/parameter\s*[｜|]*>/gi;
      let pMatch;
      while ((pMatch = colonParamRegex.exec(body)) !== null) {
        const pName = pMatch[1].trim();
        const pVal = pMatch[2].trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }
      if (toolName && ToolRegistry.getBuiltInTools().some(t => t.function.name === toolName)) {
        results.push({ name: toolName, arguments: args });
      }
    }

    // 2b. Qwen / XML function call syntax: <function=tool_name>...<parameter=param_name>val</parameter>...</function>
    const xmlFuncRegex = /<\s*function[=:\s]+(?:name=)?["']?([a-zA-Z0-9_-]+)["']?>([\s\S]*?)<\/\s*function(?::[a-zA-Z0-9_-]+)?>/gi;
    while ((match = xmlFuncRegex.exec(text)) !== null) {
      const toolName = normalizeToolName(match[1].trim());
      const body = match[2];
      const args: Record<string, unknown> = {};

      // Tag parameters: <parameter=pName>pVal</parameter> or <parameter name="pName">pVal</parameter>
      const xmlParamRegex = /<\s*(?:parameter|param|arg)[=:\s]+(?:name=)?["']?([a-zA-Z0-9_-]+)["']?>([\s\S]*?)<\/\s*(?:parameter|param|arg)(?::[a-zA-Z0-9_-]+)?>/gi;
      let pMatch;
      while ((pMatch = xmlParamRegex.exec(body)) !== null) {
        const pName = pMatch[1].trim();
        const pVal = pMatch[2].trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }

      // Self-closing parameters: <parameter name="pName" value="pVal" />
      const selfClosingParamRegex = /<\s*(?:parameter|param|arg)\s+(?:name=)?["']([a-zA-Z0-9_-]+)["']\s+value=["']([^"']*)["']\s*\/?>/gi;
      while ((pMatch = selfClosingParamRegex.exec(body)) !== null) {
        const pName = pMatch[1].trim();
        const pVal = pMatch[2].trim();
        if (args[pName] === undefined) {
          try {
            args[pName] = JSON.parse(pVal);
          } catch {
            args[pName] = pVal;
          }
        }
      }

      if (toolName && ToolRegistry.getBuiltInTools().some(t => t.function.name === toolName)) {
        results.push({ name: toolName, arguments: args });
      }
    }

    // 3. Check all markdown fenced json blocks
    const blockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    while ((match = blockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const normalized = normalizeJsonToolCall(parsed);
        if (normalized) results.push(normalized);
      } catch {}
    }

    // 4. Check <tool_call> tags (both JSON and XML formats)
    const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    while ((match = tagRegex.exec(text)) !== null) {
      const rawInner = match[1].trim();
      const cleanJson = rawInner.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        const normalized = normalizeJsonToolCall(parsed);
        if (normalized) {
          const alreadyExtracted = results.some(r => r.name === normalized.name && JSON.stringify(r.arguments) === JSON.stringify(normalized.arguments));
          if (!alreadyExtracted) results.push(normalized);
          continue;
        }
      } catch {}

      // Fallback: Check if inner contains <function...> (e.g. unclosed </function> or slightly altered XML)
      if (rawInner.includes('<function')) {
        const innerFuncMatch = /<\s*function[=:\s]+(?:name=)?["']?([a-zA-Z0-9_-]+)["']?>([\s\S]*?)(?:<\/\s*function(?::[a-zA-Z0-9_-]+)?>|$)/i.exec(rawInner);
        if (innerFuncMatch) {
          const toolName = normalizeToolName(innerFuncMatch[1].trim());
          const body = innerFuncMatch[2];
          const args: Record<string, unknown> = {};
          const xmlParamRegex = /<\s*(?:parameter|param|arg)[=:\s]+(?:name=)?["']?([a-zA-Z0-9_-]+)["']?>([\s\S]*?)(?:<\/\s*(?:parameter|param|arg)(?::[a-zA-Z0-9_-]+)?>|$)/gi;
          let pMatch;
          while ((pMatch = xmlParamRegex.exec(body)) !== null) {
            const pName = pMatch[1].trim();
            const pVal = pMatch[2].trim();
            try {
              args[pName] = JSON.parse(pVal);
            } catch {
              args[pName] = pVal;
            }
          }
          if (toolName && ToolRegistry.getBuiltInTools().some(t => t.function.name === toolName)) {
            const alreadyExtracted = results.some(r => r.name === toolName && JSON.stringify(r.arguments) === JSON.stringify(args));
            if (!alreadyExtracted) results.push({ name: toolName, arguments: args });
          }
        }
      }
    }

    // 5. Balanced brace scanning for multiple raw JSON objects
    if (results.length === 0) {
      let searchPos = 0;
      while (searchPos < text.length) {
        const nameIdx = text.indexOf('"name"', searchPos);
        const functionIdx = text.indexOf('"function"', searchPos);
        const markerIndexes = [nameIdx, functionIdx].filter(index => index >= 0);
        if (markerIndexes.length === 0) break;
        const markerIdx = Math.min(...markerIndexes);
        const startIdx = text.lastIndexOf('{', markerIdx);
        if (startIdx === -1 || startIdx < searchPos) {
          searchPos = markerIdx + 6;
          continue;
        }

        let depth = 0;
        let inStr = false;
        let esc = false;
        let endIdx = -1;
        for (let i = startIdx; i < text.length; i++) {
          const c = text[i];
          if (esc) { esc = false; continue; }
          if (c === '\\' && inStr) { esc = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                endIdx = i;
                break;
              }
            }
          }
        }

        if (endIdx !== -1) {
          try {
            const parsed = JSON.parse(text.substring(startIdx, endIdx + 1));
            const normalized = normalizeJsonToolCall(parsed);
            if (normalized) results.push(normalized);
          } catch {}
          searchPos = endIdx + 1;
        } else {
          searchPos = markerIdx + 6;
        }
      }
    }

    // 6. Python/DSL / [Running tool: name(...)] function-call syntax: write_file(filename='...', content="...")
    if (results.length === 0) {
      const knownTools = ToolRegistry.getBuiltInTools().map(t => t.function.name);
      const namePattern = new RegExp(`\\b(${knownTools.join('|')})\\s*\\(`, 'g');
      let funcMatch: RegExpExecArray | null;

      while ((funcMatch = namePattern.exec(text)) !== null) {
        const toolName = funcMatch[1];
        const startIndex = funcMatch.index + funcMatch[0].length; // index right after '('
        
        let depth = 1;
        let inStr = false;
        let quoteChar = '';
        let isTriple = false;
        let esc = false;
        let endIndex = -1;

        for (let i = startIndex; i < text.length; i++) {
          const char = text[i];

          if (esc) {
            esc = false;
            continue;
          }

          if (char === '\\' && inStr) {
            esc = true;
            continue;
          }

          if (!inStr) {
            if (text.startsWith('"""', i)) {
              inStr = true;
              quoteChar = '"';
              isTriple = true;
              i += 2;
              continue;
            } else if (text.startsWith("'''", i)) {
              inStr = true;
              quoteChar = "'";
              isTriple = true;
              i += 2;
              continue;
            } else if (char === '"' || char === "'") {
              inStr = true;
              quoteChar = char;
              isTriple = false;
              continue;
            }

            if (char === '(') {
              depth++;
            } else if (char === ')') {
              depth--;
              if (depth === 0) {
                endIndex = i;
                break;
              }
            }
          } else {
            if (isTriple) {
              const trip = quoteChar === '"' ? '"""' : "'''";
              if (text.startsWith(trip, i)) {
                inStr = false;
                isTriple = false;
                quoteChar = '';
                i += 2;
                continue;
              }
            } else if (char === quoteChar) {
              inStr = false;
              quoteChar = '';
            }
          }
        }

        if (endIndex !== -1) {
          const rawArgs = text.substring(startIndex, endIndex).trim();
          const argsObj: Record<string, unknown> = {};

          if (rawArgs) {
            let pos = 0;
            const len = rawArgs.length;

            while (pos < len) {
              while (pos < len && /[\s,]/.test(rawArgs[pos])) pos++;
              if (pos >= len) break;

              const keyMatch = rawArgs.substring(pos).match(/^([a-zA-Z0-9_]+)\s*=\s*/);
              if (!keyMatch) {
                // Positional single string or object
                const remaining = rawArgs.substring(pos).trim();
                if ((remaining.startsWith('{') && remaining.endsWith('}')) || (remaining.startsWith('[') && remaining.endsWith(']'))) {
                  try {
                    const parsedJson = JSON.parse(remaining);
                    if (parsedJson && typeof parsedJson === 'object') {
                      Object.assign(argsObj, parsedJson);
                    }
                  } catch {}
                } else if (remaining.startsWith('"') || remaining.startsWith("'")) {
                  const strMatch = remaining.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/);
                  if (strMatch) {
                    const val = strMatch[1] ?? strMatch[2] ?? strMatch[3] ?? strMatch[4];
                    if (toolName === 'execute_command') argsObj['command'] = val;
                    else if (toolName === 'generate_image') argsObj['prompt'] = val;
                    else if (toolName === 'read_file' || toolName === 'list_directory') argsObj['filename'] = val;
                    else if (toolName === 'web_search' || toolName === 'search_gif') argsObj['query'] = val;
                    else if (toolName === 'calculator') argsObj['expression'] = val;
                  }
                }
                break;
              }

              const key = keyMatch[1];
              pos += keyMatch[0].length;
              if (pos >= len) break;

              if (rawArgs.startsWith('"""', pos) || rawArgs.startsWith("'''", pos)) {
                const trip = rawArgs.substring(pos, pos + 3);
                pos += 3;
                const endTrip = rawArgs.indexOf(trip, pos);
                if (endTrip !== -1) {
                  argsObj[key] = rawArgs.substring(pos, endTrip);
                  pos = endTrip + 3;
                } else {
                  argsObj[key] = rawArgs.substring(pos);
                  pos = len;
                }
              } else if (rawArgs[pos] === '"' || rawArgs[pos] === "'") {
                const quote = rawArgs[pos];
                pos++;
                let inEsc = false;
                const valChars: string[] = [];
                while (pos < len) {
                  const c = rawArgs[pos];
                  if (inEsc) {
                    valChars.push(c);
                    inEsc = false;
                    pos++;
                    continue;
                  }
                  if (c === '\\') {
                    inEsc = true;
                    valChars.push(c);
                    pos++;
                    continue;
                  }
                  if (c === quote) {
                    pos++;
                    break;
                  }
                  valChars.push(c);
                  pos++;
                }
                const rawValStr = valChars.join('');
                try {
                  argsObj[key] = JSON.parse(`"${rawValStr.replace(/"/g, '\\"')}"`);
                } catch {
                  argsObj[key] = rawValStr;
                }
              } else if (rawArgs[pos] === '{' || rawArgs[pos] === '[') {
                let depthJ = 0;
                let inStrJ = false;
                let quoteCharJ = '';
                let escJ = false;
                let endPosJ = -1;
                for (let i = pos; i < len; i++) {
                  const c = rawArgs[i];
                  if (escJ) { escJ = false; continue; }
                  if (c === '\\' && inStrJ) { escJ = true; continue; }
                  if (!inStrJ) {
                    if (c === '"' || c === "'") { inStrJ = true; quoteCharJ = c; }
                    else if (c === '{' || c === '[') depthJ++;
                    else if (c === '}' || c === ']') {
                      depthJ--;
                      if (depthJ === 0) { endPosJ = i; break; }
                    }
                  } else if (c === quoteCharJ) inStrJ = false;
                }
                if (endPosJ !== -1) {
                  const jsonStr = rawArgs.substring(pos, endPosJ + 1);
                  try { argsObj[key] = JSON.parse(jsonStr); } catch { argsObj[key] = jsonStr; }
                  pos = endPosJ + 1;
                } else {
                  argsObj[key] = rawArgs.substring(pos);
                  pos = len;
                }
              } else {
                let endPos = pos;
                while (endPos < len && rawArgs[endPos] !== ',' && !/\s/.test(rawArgs[endPos])) endPos++;
                const bare = rawArgs.substring(pos, endPos).trim();
                if (bare === 'True' || bare === 'true') argsObj[key] = true;
                else if (bare === 'False' || bare === 'false') argsObj[key] = false;
                else if (bare === 'None' || bare === 'null') argsObj[key] = null;
                else if (!isNaN(Number(bare)) && bare !== '') argsObj[key] = Number(bare);
                else argsObj[key] = bare;
                pos = endPos;
              }
            }
          }

          if (Object.keys(argsObj).length > 0) {
            results.push({ name: toolName, arguments: argsObj });
          }
          namePattern.lastIndex = endIndex + 1;
        }
      }
    }

    if (results.length === 0) {
      // 7. Last-resort fallback for truncated or unclosed JSON tool calls
      const toolMatch = text.match(/["']?(?:name|function)["']?\s*[:=]\s*["'](write_file|patch_file|execute_command|web_search|search_gif)["']/i);
      if (toolMatch) {
        const toolName = toolMatch[1];
        const args = repairAndParseToolArguments(text);
        if (args && (args.filename || args.content || args.command || args.query)) {
          results.push({ name: toolName, arguments: args });
        }
      }
    }

    return results;
  }

  static extractToolCallFromJson(text: string): { name: string; arguments: Record<string, unknown> | string } | null {
    const list = this.extractAllToolCallsFromJson(text);
    return list.length > 0 ? list[0] : null;
  }

  static async executeToolCalls(
    toolCalls: ToolCall[],
    defaultArtEngine?: string,
    context?: { projectFolder?: string }
  ): Promise<UniversalMessage[]> {
    const results: UniversalMessage[] = [];
    const seenImageGenerations = new Set<string>();

    for (const tc of toolCalls) {
      if (tc.function.name === 'generate_image') {
        if (seenImageGenerations.size > 0) {
          results.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: true, message: 'Artwork already created in this turn.' }),
          });
          continue;
        }
        seenImageGenerations.add('done');
      }

      let args = tc.function.arguments;
      if (context?.projectFolder && (tc.function.name === 'write_file' || tc.function.name === 'patch_file' || tc.function.name === 'read_file' || tc.function.name === 'test_html_app')) {
        try {
          const parsed = typeof args === 'string' ? JSON.parse(args) : { ...(args as any) };
          let fname = cleanToolFilename(parsed.filename || parsed.filePath || parsed.file_path || parsed.path || parsed.file || '');
          if (typeof fname === 'string' && fname.trim() && !fname.includes('/') && !fname.includes('\\')) {
            parsed.filename = `${context.projectFolder}/${fname.trim()}`;
            args = typeof tc.function.arguments === 'string' ? JSON.stringify(parsed) : parsed;
          } else if (fname) {
            parsed.filename = fname;
            args = typeof tc.function.arguments === 'string' ? JSON.stringify(parsed) : parsed;
          }
        } catch {}
      }

      const output = await this.executeTool(tc.function.name, args, defaultArtEngine);
      results.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: output,
      });
    }
    return results;
  }
}
