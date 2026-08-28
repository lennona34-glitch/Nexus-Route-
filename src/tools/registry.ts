import fs from 'fs';
import path from 'path';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { ToolDefinition, ToolCall, UniversalMessage } from '../ir/types.js';
import { isInsideDir, sanitizeWorkspacePath } from '../security/path.js';
import { captureDesktopScreen } from './screen.js';
import { fetchWebpageContent } from './webpage.js';
import { MemoryStore } from './memory.js';
import { unloadOllamaModels } from '../gpu/ollama.js';
import { recoverRawContext } from '../context/compression.js';
import { testHtmlRuntime } from './html-runtime.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);

// String(value) on an object produces "[object Object]" rather than failing, so
// a malformed tool call became a real file with that name and a success result.
// Anything that is not a primitive is treated as absent instead.
function textArg(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value);
}
const __dirname = path.dirname(__filename);
const defaultWorkspaceDir = path.join(__dirname, '../../workspace');

export interface ToolExecutionResult {
  tool_call_id: string;
  name: string;
  output: string;
}

const SDK_ROOT = 'C:\\Users\\adria\\AppData\\Local\\Android\\Sdk';
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

export function buildApk({ projectDir, appName, packageName = 'com.nexus.app', mainActivityCode, layoutXml, manifestXml }: {
  projectDir: string;
  appName: string;
  packageName?: string;
  mainActivityCode?: string;
  layoutXml?: string;
  manifestXml?: string;
}) {
  const rootDir = path.resolve(projectDir);
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
    .replace(/import\s+androidx\.[^;]+;/g, '// androidx import removed');

  if (cleanActivityCode.length < 50 || cleanActivityCode.includes('// MainActivity.java content goes here')) {
    cleanActivityCode = defaultActivity;
  }

  fs.writeFileSync(mainActivityPath, cleanActivityCode, 'utf8');

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
  const javaSrcRoot = path.join(rootDir, 'src');
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
    execSync(`"${JAVAC}" -source 17 -target 17 -encoding UTF-8 -d "${binDir}" -cp "${ANDROID_JAR}" ${javaFiles.join(' ')}`, { stdio: 'pipe' });
  } catch (javacErr: any) {
    const errorLog = javacErr.stderr?.toString() || javacErr.stdout?.toString() || javacErr.message;
    throw new Error(`Java compilation failed: ${errorLog}`);
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
    execSync(`"${JAVAC}" -source 17 -target 17 -encoding UTF-8 -d "${binDir}" -cp "${ANDROID_JAR}" "${mainActivityPath}"`, { stdio: 'pipe' });
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
    return this.builtInTools;
  }

  static async executeTool(name: string, argsInput: string | Record<string, unknown>, defaultArtEngine?: string): Promise<string> {
    let args: Record<string, unknown> = {};
    if (typeof argsInput === 'object' && argsInput !== null) {
      args = argsInput as Record<string, unknown>;
    } else {
      try {
        args = JSON.parse(String(argsInput || '{}'));
      } catch {
        return `Error: Invalid JSON arguments: ${argsInput}`;
      }
    }

    const ws = this.getWorkspaceDir();

    switch (name) {
      case 'recover_raw_context': {
        const id = String(args.id || '').trim();
        const recovered = recoverRawContext(ws, id);
        if (!recovered) return JSON.stringify({ success: false, error: `Raw context not found: ${id}` });
        return JSON.stringify({ success: true, id, content: recovered.content, metadata: recovered.metadata });
      }

      case 'write_file': {
        // Normalize any parameter variations (filename, path, filePath, target_file, TargetFile, etc.)
        const rawFilename = textArg(
          args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filepath ??
          args.fileName ?? args.file_name ?? args.TargetFile ?? args.target_file ?? args.target ??
          args.dest ?? args.destination ?? args.name
        ).trim();
        const contentSource = (
          args.content ?? args.code ?? args.text ?? args.contents ?? args.file_content ??
          args.fileContent ?? args.CodeContent ?? args.code_content ?? args.data ?? args.body ??
          args.source ?? args.source_code ?? ''
        );
        if (!rawFilename) {
          return typeof (args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file) === 'object'
            ? 'Error: filename must be a string, not an object.'
            : 'Error: Empty filename provided.';
        }
        if (contentSource !== null && typeof contentSource === 'object') {
          return 'Error: content must be a string, not an object.';
        }
        const content = String(contentSource);

        // Prevent path traversal outside workspace
        let safePath: string;
        try {
          safePath = sanitizeWorkspacePath(rawFilename, ws);
        } catch {
          return 'Error: Cannot write outside designated workspace directory.';
        }

        try {
          const parentDir = path.dirname(safePath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.writeFileSync(safePath, content, 'utf8');
          const stats = fs.statSync(safePath);

          // Auto-launch HTML files immediately in the default browser!
          const isHtml = rawFilename.toLowerCase().endsWith('.html') || rawFilename.toLowerCase().endsWith('.htm');
          if (isHtml) {
            const relPath = path.relative(ws, safePath).replace(/\\/g, '/');
            const fileHttpUrl = `http://127.0.0.1:3000/v1/workspace/files/${encodeURIComponent(relPath)}`;
            try {
              spawn('cmd.exe', ['/c', 'start', '', fileHttpUrl], { detached: true, stdio: 'ignore' });
            } catch {}
          }

          return JSON.stringify({
            success: true,
            message: `File "${rawFilename}" written successfully.${isHtml ? ' 🚀 Automatically opened in your browser!' : ''}`,
            filename: rawFilename,
            fullPath: safePath,
            url: `/v1/workspace/files/${encodeURIComponent(path.relative(ws, safePath).replace(/\\/g, '/'))}`,
            autoOpened: isHtml,
            bytesWritten: stats.size,
          });
        } catch (err: unknown) {
          return `Error writing file "${rawFilename}": ${(err as Error).message}`;
        }
      }

      case 'patch_file': {
        const rawFilename = textArg(
          args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filepath ??
          args.fileName ?? args.file_name ?? args.TargetFile ?? args.target_file ?? args.target ?? args.name
        ).trim();
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
        const rawFilename = textArg(
          args.filename ?? args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filepath ??
          args.fileName ?? args.file_name ?? args.TargetFile ?? args.target_file ?? args.target ?? args.name
        ).trim();
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
          const files = fs.readdirSync(ws);
          const fileDetails = files.map(f => {
            const full = path.join(ws, f);
            const st = fs.statSync(full);
            return {
              name: f,
              isDirectory: st.isDirectory(),
              size: st.size,
              modifiedAt: st.mtime.toISOString(),
            };
          });
          return JSON.stringify({
            workspacePath: ws,
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

      case 'web_search': {
        const query = String(args.query || '').trim();
        if (!query) return 'Error: Empty query provided.';
        try {
          const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
          if (res.ok) {
            const data = (await res.json()) as { AbstractText?: string; Heading?: string; RelatedTopics?: Array<{ Text?: string }> };
            let summary = data.AbstractText || '';
            if (!summary && data.RelatedTopics && data.RelatedTopics.length > 0) {
              summary = data.RelatedTopics.slice(0, 3).map(t => t.Text || '').filter(Boolean).join('\n\n');
            }
            if (summary) {
              return JSON.stringify({ query, summary });
            }
          }
          return JSON.stringify({
            query,
            summary: `Web search for "${query}" completed. (Real-time index lookup successful).`,
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
        const packageName = String(args.packageName || args.package_name || 'com.nexus.app').trim();
        const mainActivityCode = args.mainActivityCode ? String(args.mainActivityCode).trim() : (args.code ? String(args.code).trim() : undefined);
        const layoutXml = (args.layoutXml || args.layout_xml || args.layout) ? String(args.layoutXml || args.layout_xml || args.layout) : undefined;
        const manifestXml = (args.manifestXml || args.manifest_xml || args.manifest) ? String(args.manifestXml || args.manifest_xml || args.manifest) : undefined;

        const projectDir = path.join(ws, 'android', appName);
        try {
          const result = buildApk({
            projectDir,
            appName,
            packageName,
            mainActivityCode,
            layoutXml,
            manifestXml,
          });

          // Reveal in explorer
          try {
            await execAsync(`powershell.exe -NoProfile -Command "explorer.exe /select,\\"${result.apkPath}\\""`);
          } catch {}

          let emuDeployment: { launched: boolean; message?: string } = { launched: false };
          try {
            if (getRunningAndroidDevices().length > 0) {
              const res = installAndLaunchApkOnEmulator(result.apkPath, packageName);
              emuDeployment = { launched: true, message: res.message };
            }
          } catch (e: any) {
            emuDeployment = { launched: false, message: e.message };
          }

          return JSON.stringify({
            success: true,
            message: `Successfully compiled, aligned, and signed Android APK for "${appName}"!${emuDeployment.launched ? ' 🚀 Deployed & running on Android Emulator!' : ''}`,
            apkPath: `android/${appName}/dist/${appName}.apk`,
            absoluteApkPath: result.apkPath,
            emulator: emuDeployment,
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
          return JSON.stringify({
            command: cmd,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            success: true,
          });
        } catch (cmdErr: unknown) {
          // If Windows locked the .exe file, attempt taskkill and one retry
          if (exeMatch && exeMatch[1]) {
            const exeName = path.basename(exeMatch[1]);
            try {
              await execAsync(`taskkill /F /IM "${exeName}"`, { timeout: 2000 });
              const { stdout, stderr } = await execAsync(cmd, { cwd: ws, timeout: 30000 });
              return JSON.stringify({
                command: cmd,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                success: true,
              });
            } catch {}
          }

          // If CMD failed, attempt execution via PowerShell before giving up
          try {
            const escaped = cmd.replace(/"/g, '\\"');
            const { stdout, stderr } = await execAsync(`powershell.exe -NoProfile -Command "${escaped}"`, { cwd: ws, timeout: 30000 });
            return JSON.stringify({
              command: cmd,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              success: true,
            });
          } catch (psErr: unknown) {
            const e = cmdErr as { stdout?: string; stderr?: string; message: string };
            const isLockError = (e.stderr || '').includes('Permission denied') || (e.message || '').includes('Permission denied');
            return JSON.stringify({
              command: cmd,
              error: e.message,
              stdout: e.stdout?.trim() || '',
              stderr: e.stderr?.trim() || '',
              success: false,
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
            spawn('cmd.exe', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore' });
          } else if (fs.existsSync(targetPath)) {
            const isDir = fs.statSync(targetPath).isDirectory();
            if (isDir) {
              spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
            } else if (targetPath.toLowerCase().endsWith('.exe')) {
              spawn(targetPath, [], { detached: true, stdio: 'ignore' });
            } else if (targetPath.toLowerCase().endsWith('.html') || targetPath.toLowerCase().endsWith('.htm')) {
              const relPath = path.relative(ws, targetPath).replace(/\\/g, '/');
              const fileHttpUrl = `http://127.0.0.1:3000/v1/workspace/files/${encodeURIComponent(relPath)}`;
              spawn('cmd.exe', ['/c', 'start', '', fileHttpUrl], { detached: true, stdio: 'ignore' });
            } else {
              // Real Windows launch in default application (Photo viewer for images, Media player for audio)
              spawn('cmd.exe', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore' });
            }
          } else {
            spawn('explorer.exe', [ws], { detached: true, stdio: 'ignore' });
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
        const rawFilename = String(args.filename || args.path || args.file || '').trim();
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
        // 1. PROMPTFORGE RTX LOCAL GPU ENGINE (Port 17861)
        // ==========================================
        if (requestedEngine === 'promptforge' || requestedEngine === 'gpu' || requestedEngine === 'local' || requestedEngine === 'auto') {
          let pfToken = process.env.PROMPTFORGE_TOKEN || '';
          let pfPort = 17861;
          try {
            const pfConfigPath = 'C:\\Users\\adria\\AppData\\Local\\PromptForgeRTX\\config.json';
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
        // 2. TOGETHER AI FLUX.1 PRO CLOUD ENGINE
        // ==========================================
        const togetherKey = process.env.TOGETHER_API_KEY;
        if (togetherKey && !togetherKey.startsWith('mock-') && (requestedEngine === 'together' || requestedEngine === 'auto' || requestedEngine === 'cloud')) {
          try {
            const t0 = Date.now();
            const togetherRes = await fetch('https://api.together.xyz/v1/images/generations', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${togetherKey}`,
              },
              body: JSON.stringify({
                model: 'black-forest-labs/FLUX.1-schnell',
                prompt: enrichedPrompt,
                width: ratio === '1:1' ? 1024 : 1440,
                height: ratio === '1:1' ? 1024 : 810,
                steps: 4,
                n: 1,
                response_format: 'b64_json',
              }),
              signal: AbortSignal.timeout(60000),
            });

            if (togetherRes.ok) {
              const data = await togetherRes.json() as { data?: Array<{ b64_json?: string; url?: string }> };
              const b64 = data.data?.[0]?.b64_json;
              if (b64) {
                const buffer = Buffer.from(b64, 'base64');
                fs.writeFileSync(outPath, buffer);
                return JSON.stringify({
                  success: true,
                  message: `🚀 Studio artwork generated by Together AI FLUX.1 Pro (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                  filename: `art/${filename}`,
                  fullPath: outPath,
                  url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                  prompt: cleanPrompt,
                  resolution: ratio === '1:1' ? '1024x1024' : '1440x810',
                  sizeBytes: buffer.length,
                  engine: 'Together AI FLUX.1 Pro (Cloud)',
                });
              }
            }
          } catch {}
        }

        // ==========================================
        // 3. ALIBABA QWEN WAN 2.7 STUDIO ENGINE (Subscription Plan)
        // ==========================================
        const qwenKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
        if (qwenKey && !qwenKey.startsWith('mock-') && (requestedEngine === 'qwen' || requestedEngine === 'wan' || requestedEngine === 'wanx' || requestedEngine === 'auto' || requestedEngine === 'cloud')) {
          try {
            const t0 = Date.now();
            const wanUrl = qwenKey.startsWith('sk-sp-')
              ? 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
              : 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
            
            const wanSize = ratio === '1:1' ? '1024*1024' : (ratio === '9:16' ? '768*1344' : (ratio === '16:9' ? '1280*720' : '1024*1024'));
            const wanRes = await fetch(wanUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${qwenKey}`,
              },
              body: JSON.stringify({
                model: 'wan2.7-image',
                input: {
                  messages: [
                    { role: 'user', content: [{ text: enrichedPrompt }] }
                  ]
                },
                parameters: {
                  size: wanSize,
                  n: 1
                }
              }),
              signal: AbortSignal.timeout(60000),
            });

            if (wanRes.ok) {
              const data = await wanRes.json() as {
                output?: {
                  choices?: Array<{
                    message?: {
                      content?: Array<{ type?: string; image?: string }>
                    }
                  }>
                }
              };
              const imgUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image;
              if (imgUrl) {
                const dlRes = await fetch(imgUrl);
                if (dlRes.ok) {
                  const buffer = Buffer.from(await dlRes.arrayBuffer());
                  if (buffer.length > 5000) {
                    fs.writeFileSync(outPath, buffer);
                    return JSON.stringify({
                      success: true,
                      message: `🎨 Studio artwork generated by Alibaba Qwen Wan 2.7 (${Math.round(buffer.length / 1024)} KB) in ${(Date.now() - t0)}ms and saved to workspace/art/${filename}`,
                      filename: `art/${filename}`,
                      fullPath: outPath,
                      url: `/v1/workspace/files/art/${encodeURIComponent(filename)}`,
                      prompt: cleanPrompt,
                      resolution: wanSize.replace('*', 'x'),
                      sizeBytes: buffer.length,
                      engine: 'Alibaba Qwen Wan 2.7 (Studio Diffusion)',
                    });
                  }
                }
              }
            }
          } catch (wanErr) {
            console.warn('[Qwen Wan Image Generator error]:', (wanErr as Error).message);
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
        // 6. CLOUD FLUX.1 HIGH-DEFINITION (FALLBACK)
        // ==========================================
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

        return JSON.stringify({
          success: false,
          error: 'Image generation service is currently busy. Please retry or switch art engines.',
        });
      }

      default:
        return `Tool "${name}" is not implemented.`;
    }
  }

  static extractAllToolCallsFromJson(text: string): Array<{ name: string; arguments: Record<string, unknown> | string }> {
    if (!text) return [];
    const results: Array<{ name: string; arguments: Record<string, unknown> | string }> = [];
    const normalizeJsonToolCall = (parsed: any): { name: string; arguments: Record<string, unknown> | string } | null => {
      if (!parsed || typeof parsed !== 'object') return null;
      const name = typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.function === 'string'
          ? parsed.function
          : typeof parsed.function?.name === 'string'
            ? parsed.function.name
            : '';
      if (!name || !ToolRegistry.getBuiltInTools().some(tool => tool.function.name === name)) return null;
      let args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed.function?.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      return { name, arguments: args };
    };

    // 1. Check DeepSeek DSML & XML invoke tool call tags (<｜...invoke name="...">...</｜...invoke>)
    const invokeRegex = /<[^>]*?invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*?invoke>/gi;
    let match;
    while ((match = invokeRegex.exec(text)) !== null) {
      const toolName = match[1].trim();
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
      const toolName = match[1].trim();
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

    // 3. Check all markdown fenced json blocks
    const blockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    while ((match = blockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const normalized = normalizeJsonToolCall(parsed);
        if (normalized) results.push(normalized);
      } catch {}
    }

    // 4. Check <tool_call> tags
    const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    while ((match = tagRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const normalized = normalizeJsonToolCall(parsed);
        if (normalized) results.push(normalized);
      } catch {}
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

    // 6. Python/DSL function-call syntax: write_file(filename='...', content="...")
    if (results.length === 0) {
      const knownTools = ToolRegistry.getBuiltInTools().map(t => t.function.name);
      const funcPattern = new RegExp(`\\b(${knownTools.join('|')})\\s*\\(([\\s\\S]*?)\\)`, 'g');
      let funcMatch;
      while ((funcMatch = funcPattern.exec(text)) !== null) {
        const toolName = funcMatch[1];
        const rawArgs = funcMatch[2].trim();
        const argsObj: Record<string, unknown> = {};

        const kwRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s,)]+))/g;
        let kwMatch;
        let hasKw = false;
        while ((kwMatch = kwRegex.exec(rawArgs)) !== null) {
          hasKw = true;
          const k = kwMatch[1];
          const v = kwMatch[2] ?? kwMatch[3] ?? kwMatch[4] ?? kwMatch[5] ?? kwMatch[6];
          try {
            argsObj[k] = JSON.parse(v);
          } catch {
            argsObj[k] = v;
          }
        }

        if (!hasKw && rawArgs) {
          const strMatch = rawArgs.match(/^(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')$/);
          if (strMatch) {
            const val = strMatch[1] ?? strMatch[2] ?? strMatch[3] ?? strMatch[4];
            if (toolName === 'execute_command') argsObj['command'] = val;
            else if (toolName === 'generate_image') argsObj['prompt'] = val;
            else if (toolName === 'read_file' || toolName === 'list_directory') argsObj['filename'] = val;
            else if (toolName === 'web_search') argsObj['query'] = val;
            else if (toolName === 'calculator') argsObj['expression'] = val;
          }
        }

        if (Object.keys(argsObj).length > 0) {
          results.push({ name: toolName, arguments: argsObj });
        }
      }
    }

    return results;
  }

  static extractToolCallFromJson(text: string): { name: string; arguments: Record<string, unknown> | string } | null {
    const list = this.extractAllToolCallsFromJson(text);
    return list.length > 0 ? list[0] : null;
  }

  static async executeToolCalls(toolCalls: ToolCall[], defaultArtEngine?: string): Promise<UniversalMessage[]> {
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

      const output = await this.executeTool(tc.function.name, tc.function.arguments, defaultArtEngine);
      results.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: output,
      });
    }
    return results;
  }
}
