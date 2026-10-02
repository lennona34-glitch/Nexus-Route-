using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace NexusRoute;

internal static class Program
{
    public const string DashboardTitle = "NexusRoute AI Studio";
    private const string MutexId = @"Global\NexusRoute_SingleInstance_App";
    private static Mutex? _singleInstanceMutex;
    private static JobObject? _jobObject;
    private static Process? _gatewayProcess;
    private static NotifyIcon? _trayIcon;
    private static DashboardForm? _dashboardForm;
    private static string _appDir = "";
    private static int _gatewayPort = 3000;
    private static bool _startMinimized = false;
    private static bool _headless = false;
    private static volatile bool _isAppRunning = true;
    private static volatile bool _isGatewayOnline = false;
    private static readonly HttpClient _httpClient = new() { Timeout = TimeSpan.FromSeconds(2) };
    private static Icon? _cachedIcon;

    public static int GatewayPort => _gatewayPort;
    public static string AppDir => _appDir;
    public static Icon NexusIcon => _cachedIcon ??= CreateNexusIcon();

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            ApplicationConfiguration.Initialize();

            // 1. Parse CLI arguments first
            for (int i = 0; i < args.Length; i++)
            {
                var arg = args[i].ToLowerInvariant();
                if (arg is "--tray" or "-t")
                {
                    _startMinimized = true;
                }
                else if (arg is "--headless" or "-h")
                {
                    _headless = true;
                    _startMinimized = true;
                }
                else if (arg is "--port" or "-p" && i + 1 < args.Length && int.TryParse(args[i + 1], out int p))
                {
                    _gatewayPort = p;
                    i++;
                }
            }

            // 2. Resolve Application Base Directory
            _appDir = ResolveAppDirectory();
            Log($"NexusRoute launcher started. Port: {_gatewayPort}, Headless: {_headless}, TrayOnly: {_startMinimized}, AppDir: {_appDir}");

            // 3. Single Instance Check (per port)
            string mutexName = $@"Local\NexusRoute_Port_{_gatewayPort}";
            bool isFirstInstance = false;
            try
            {
                _singleInstanceMutex = new Mutex(true, mutexName, out isFirstInstance);
            }
            catch (AbandonedMutexException)
            {
                isFirstInstance = true;
            }

            if (!isFirstInstance)
            {
                var current = Process.GetCurrentProcess();
                var otherProcs = Array.FindAll(Process.GetProcessesByName("NexusRoute"), p => p.Id != current.Id);
                if (otherProcs.Length == 0)
                {
                    Log("Stale mutex detected without running process. Reclaiming instance ownership.");
                    isFirstInstance = true;
                }
            }

            if (!isFirstInstance)
            {
                if (args.Length > 0 && args[0].Equals("--stop", StringComparison.OrdinalIgnoreCase))
                {
                    Log("Stop command received. Stopping instances...");
                    StopExistingInstances();
                    return;
                }

                Log($"Existing instance already detected on port {_gatewayPort}. Activating dashboard & opening studio in browser...");

                IntPtr hWnd = FindWindow(null, DashboardTitle);
                if (hWnd != IntPtr.Zero)
                {
                    ShowWindow(hWnd, SW_RESTORE);
                    SetForegroundWindow(hWnd);
                }

                OpenBrowser($"http://localhost:{_gatewayPort}");
                return;
            }

            // 4. Initialize Job Object for Zero-Zombie Process Guarantee
            try
            {
                _jobObject = new JobObject();
            }
            catch (Exception ex)
            {
                Log($"JobObject creation warning: {ex.Message}");
            }

            // 5. Attach to already running gateway or spawn child process
            bool alreadyRunning = false;
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
                var checkResponse = _httpClient.GetAsync($"http://127.0.0.1:{_gatewayPort}/health", cts.Token).GetAwaiter().GetResult();
                if (checkResponse.IsSuccessStatusCode)
                {
                    alreadyRunning = true;
                    _isGatewayOnline = true;
                    Log($"AI Gateway is already responding on port {_gatewayPort}. Attached to running instance.");
                }
            }
            catch { }

            if (!alreadyRunning)
            {
                StartGatewayProcess();
            }

            // 6. If Headless, wait directly on gateway process
            if (_headless)
            {
                Log("Running headless service mode.");
                AppDomain.CurrentDomain.ProcessExit += (_, _) => OnApplicationExit(null, EventArgs.Empty);
                _gatewayProcess?.WaitForExit();
                return;
            }

            // 7. GUI Mode (Tray + Dashboard Form)
            Application.ApplicationExit += OnApplicationExit;
            InitializeTrayIcon();

            _dashboardForm = new DashboardForm(_startMinimized);

            if (alreadyRunning)
            {
                _dashboardForm.AppendLog($"[NexusServer] Attached to running AI Gateway on port {_gatewayPort}.");
                _dashboardForm.UpdateStatus($"🟢 AI Gateway: Online (Port {_gatewayPort})", true);
            }

            // Start continuous background health monitor & initial check
            StartHealthMonitor();

            Application.Run(_dashboardForm);
        }
        catch (Exception ex)
        {
            Log($"[FATAL CRASH] {ex}");
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), $"[{DateTime.Now}] {ex}\r\n");
            }
            catch { }
            MessageBox.Show($"NexusRoute encountered an unexpected error:\n\n{ex.Message}\n\nCheck logs/launcher.log for details.", "NexusRoute Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    public static void ShowDashboard()
    {
        if (_dashboardForm != null && !_dashboardForm.IsDisposed)
        {
            if ((DateTime.UtcNow - _dashboardForm.LastHiddenTime).TotalMilliseconds < 450)
            {
                // Debounce cooldown: prevent stray clicks or notification releases right after hiding from bouncing the window back
                return;
            }
        }

        if (_dashboardForm == null || _dashboardForm.IsDisposed)
        {
            _dashboardForm = new DashboardForm(false);
        }

        _dashboardForm.ShowInTaskbar = true;
        _dashboardForm.Show();
        _dashboardForm.WindowState = FormWindowState.Normal;
        _dashboardForm.BringToFront();
        _dashboardForm.Activate();
    }

    public static void ShowTrayBalloon(string title, string text, ToolTipIcon icon)
    {
        try
        {
            _trayIcon?.ShowBalloonTip(3000, title, text, icon);
        }
        catch { }
    }

    public static void ExitApplication()
    {
        _dashboardForm?.ForceClose();
        Application.Exit();
    }

    private static void Log(string message)
    {
        try
        {
            string dir = !string.IsNullOrEmpty(_appDir) && Directory.Exists(_appDir) ? _appDir : AppDomain.CurrentDomain.BaseDirectory;
            string logsDir = Path.Combine(dir, "logs");
            if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);
            File.AppendAllText(Path.Combine(logsDir, "launcher.log"), $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}\r\n");
        }
        catch { }
    }

    private static string ResolveAppDirectory()
    {
        string? current = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        for (int i = 0; i < 6 && !string.IsNullOrEmpty(current); i++)
        {
            if (File.Exists(Path.Combine(current, "dist", "server.bundle.mjs")) ||
                File.Exists(Path.Combine(current, "dist", "server.bundle.cjs")) ||
                File.Exists(Path.Combine(current, "dist", "server.js")) ||
                File.Exists(Path.Combine(current, "package.json")))
            {
                return current;
            }
            current = Directory.GetParent(current)?.FullName;
        }
        return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
    }

    private static void StartGatewayProcess()
    {
        try
        {
            // Determine entry file
            string bundleMjs = Path.Combine(_appDir, "dist", "server.bundle.mjs");
            string bundleCjs = Path.Combine(_appDir, "dist", "server.bundle.cjs");
            string distFile = Path.Combine(_appDir, "dist", "server.js");
            string tsEntry = Path.Combine(_appDir, "src", "server.ts");

            string nodeExe = FindNodeExecutable();
            string scriptToRun = File.Exists(bundleMjs) ? bundleMjs :
                                 File.Exists(bundleCjs) ? bundleCjs :
                                 File.Exists(distFile) ? distFile :
                                 tsEntry;

            bool isTs = scriptToRun.EndsWith(".ts", StringComparison.OrdinalIgnoreCase);

            var psi = new ProcessStartInfo
            {
                FileName = isTs ? FindTsxExecutable(nodeExe) : nodeExe,
                Arguments = isTs ? $"\"{scriptToRun}\"" : $"\"{scriptToRun}\"",
                WorkingDirectory = _appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8
            };

            psi.Environment["PORT"] = _gatewayPort.ToString();
            psi.Environment["NODE_ENV"] = "production";

            Log($"Starting gateway process: {psi.FileName} {psi.Arguments} (CWD: {_appDir})");
            _gatewayProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _gatewayProcess.OutputDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    Debug.WriteLine($"[NexusServer] {e.Data}");
                    Log($"[NexusServer] {e.Data}");
                    _dashboardForm?.AppendLog(e.Data);
                }
            };
            _gatewayProcess.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    Debug.WriteLine($"[NexusServer ERR] {e.Data}");
                    Log($"[NexusServer ERR] {e.Data}");
                    _dashboardForm?.AppendLog($"[ERR] {e.Data}");
                }
            };

            _gatewayProcess.Exited += async (_, _) =>
            {
                Debug.WriteLine("[NexusServer] Gateway process exited.");
                Log("[NexusServer] Gateway process exited.");
                _dashboardForm?.AppendLog("[NexusServer] Gateway process exited.");

                // Check if endpoint is still responding (e.g. background service or daemon)
                bool stillResponding = false;
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1000));
                    var res = await _httpClient.GetAsync($"http://127.0.0.1:{_gatewayPort}/health", cts.Token);
                    stillResponding = res.IsSuccessStatusCode;
                }
                catch { }

                if (!stillResponding)
                {
                    _isGatewayOnline = false;
                    _dashboardForm?.UpdateStatus("🔴 AI Gateway: Offline", false);
                    if (_trayIcon != null)
                    {
                        _trayIcon.Text = $"NexusRoute Gateway (Port {_gatewayPort}) - Offline";
                    }
                }
            };

            _gatewayProcess.Start();
            _gatewayProcess.BeginOutputReadLine();
            _gatewayProcess.BeginErrorReadLine();

            // Bind to Windows Job Object immediately
            _jobObject?.AddProcess(_gatewayProcess);
        }
        catch (Exception ex)
        {
            Log($"Failed to launch NexusRoute backend: {ex}");
            MessageBox.Show($"Failed to launch NexusRoute backend:\n\n{ex.Message}", "NexusRoute Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string FindNodeExecutable()
    {
        // 1. Check local bundled node in bin\node\node.exe or bin\node.exe
        string localNode1 = Path.Combine(_appDir, "bin", "node", "node.exe");
        if (File.Exists(localNode1)) return localNode1;

        string localNode2 = Path.Combine(_appDir, "bin", "node.exe");
        if (File.Exists(localNode2)) return localNode2;

        // 2. Fall back to system node on PATH
        return "node";
    }

    private static string FindTsxExecutable(string nodeExe)
    {
        string localTsx = Path.Combine(_appDir, "node_modules", ".bin", "tsx.cmd");
        if (File.Exists(localTsx)) return localTsx;

        string npxExe = "npx.cmd";
        return npxExe;
    }

    private static void InitializeTrayIcon()
    {
        _trayIcon = new NotifyIcon
        {
            Icon = NexusIcon,
            Text = $"NexusRoute Gateway (Port {_gatewayPort})",
            Visible = true
        };

        var menu = new ContextMenuStrip();

        var openStudioItem = new ToolStripMenuItem("🌐 Open Nexus Studio", null, (_, _) =>
        {
            OpenBrowser($"http://localhost:{_gatewayPort}");
        }) { Font = new Font(menu.Font, FontStyle.Bold) };

        var showDashboardItem = new ToolStripMenuItem("🖥️ Show Control Dashboard", null, (_, _) =>
        {
            ShowDashboard();
        });

        var openWorkspaceItem = new ToolStripMenuItem("📁 Open Workspace Folder", null, (_, _) =>
        {
            string wsDir = Path.Combine(_appDir, "workspace");
            if (!Directory.Exists(wsDir)) Directory.CreateDirectory(wsDir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{wsDir}\"") { UseShellExecute = true });
        });

        var studioSettingsItem = new ToolStripMenuItem("⚙️ System Prompts & Rules Studio", null, (_, _) =>
        {
            OpenBrowser($"http://localhost:{_gatewayPort}#promptsModal");
        });

        var restartItem = new ToolStripMenuItem("🔄 Restart Gateway", null, async (_, _) =>
        {
            await RestartGatewayAsync();
        });

        var statusItem = new ToolStripMenuItem("📊 Gateway & GPU Status", null, async (_, _) =>
        {
            await ShowStatusBalloonAsync();
        });

        var exitItem = new ToolStripMenuItem("❌ Exit NexusRoute", null, (_, _) =>
        {
            _dashboardForm?.ForceClose();
            Application.Exit();
        });

        menu.Items.Add(openStudioItem);
        menu.Items.Add(showDashboardItem);
        menu.Items.Add(openWorkspaceItem);
        menu.Items.Add(studioSettingsItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(restartItem);
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _trayIcon.ContextMenuStrip = menu;
        _trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
            {
                ShowDashboard();
            }
        };
        _trayIcon.DoubleClick += (_, _) =>
        {
            ShowDashboard();
            OpenBrowser($"http://localhost:{_gatewayPort}");
        };
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool DestroyIcon(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private const int SW_RESTORE = 9;

    private static Icon CreateNexusIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using var brush = new LinearGradientBrush(new Rectangle(0, 0, 32, 32), Color.FromArgb(79, 70, 229), Color.FromArgb(147, 51, 234), 45f);
            g.FillEllipse(brush, 2, 2, 28, 28);

            using var pen = new Pen(Color.FromArgb(165, 180, 252), 1.5f);
            g.DrawEllipse(pen, 3, 3, 26, 26);

            using var textBrush = new SolidBrush(Color.White);
            using var font = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel);
            var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString("⚡", font, textBrush, new RectangleF(0, 0, 32, 32), sf);
        }

        IntPtr hIcon = bitmap.GetHicon();
        try
        {
            using var tempIcon = Icon.FromHandle(hIcon);
            return (Icon)tempIcon.Clone();
        }
        finally
        {
            DestroyIcon(hIcon);
        }
    }


    private static void StartHealthMonitor()
    {
        Task.Run(async () =>
        {
            await Task.Delay(800);
            bool initialBrowserOpened = false;

            while (_isAppRunning)
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(2000));
                    var response = await _httpClient.GetAsync($"http://127.0.0.1:{_gatewayPort}/health", cts.Token);
                    bool online = response.IsSuccessStatusCode;

                    if (online)
                    {
                        if (!_isGatewayOnline)
                        {
                            _isGatewayOnline = true;
                            _dashboardForm?.UpdateStatus($"🟢 AI Gateway: Online (Port {_gatewayPort})", true);
                            if (_trayIcon != null)
                            {
                                _trayIcon.Text = $"NexusRoute Gateway (Port {_gatewayPort}) - Active";
                                _trayIcon.ShowBalloonTip(3000, "⚡ NexusRoute Online", $"Router is live on http://localhost:{_gatewayPort}", ToolTipIcon.Info);
                            }
                        }

                        if (!initialBrowserOpened && !_startMinimized)
                        {
                            initialBrowserOpened = true;
                            OpenBrowser($"http://localhost:{_gatewayPort}");
                        }
                    }
                    else
                    {
                        if (_isGatewayOnline)
                        {
                            _isGatewayOnline = false;
                            _dashboardForm?.UpdateStatus("🔴 AI Gateway: Offline", false);
                            if (_trayIcon != null)
                            {
                                _trayIcon.Text = $"NexusRoute Gateway (Port {_gatewayPort}) - Offline";
                            }
                        }
                    }
                }
                catch
                {
                    if (_isGatewayOnline)
                    {
                        _isGatewayOnline = false;
                        _dashboardForm?.UpdateStatus("🔴 AI Gateway: Offline", false);
                        if (_trayIcon != null)
                        {
                            _trayIcon.Text = $"NexusRoute Gateway (Port {_gatewayPort}) - Offline";
                        }
                    }
                }

                await Task.Delay(2500);
            }
        });
    }

    private static async Task<bool> WaitForGatewayReadyAsync(TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < timeout)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
                var response = await _httpClient.GetAsync($"http://127.0.0.1:{_gatewayPort}/health", cts.Token);
                if (response.IsSuccessStatusCode) return true;
            }
            catch { }
            await Task.Delay(500);
        }
        return false;
    }

    public static async Task RestartGatewayAsync()
    {
        if (_trayIcon != null)
        {
            _trayIcon.Text = "NexusRoute Gateway - Restarting...";
            _trayIcon.ShowBalloonTip(1500, "Restarting Gateway", "Recycling background service...", ToolTipIcon.Info);
        }

        _dashboardForm?.AppendLog("[NexusServer] Restarting AI Gateway...");

        try
        {
            if (_gatewayProcess != null && !_gatewayProcess.HasExited)
            {
                _gatewayProcess.Kill(true);
                await _gatewayProcess.WaitForExitAsync();
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Error killing gateway on restart: {ex.Message}");
        }
        _gatewayProcess = null;

        // Clean up port in case of orphaned listener
        KillProcessOnPort(_gatewayPort);
        await Task.Delay(500);

        StartGatewayProcess();

        bool ready = await WaitForGatewayReadyAsync(TimeSpan.FromSeconds(15));
        if (ready)
        {
            _isGatewayOnline = true;
            _dashboardForm?.UpdateStatus($"🟢 AI Gateway: Online (Port {_gatewayPort})", true);
            if (_trayIcon != null)
            {
                _trayIcon.Text = $"NexusRoute Gateway (Port {_gatewayPort}) - Active";
                _trayIcon.ShowBalloonTip(2000, "Gateway Restarted", $"Listening on http://localhost:{_gatewayPort}", ToolTipIcon.Info);
            }
        }
        else
        {
            _isGatewayOnline = false;
            _dashboardForm?.UpdateStatus("🔴 AI Gateway: Restart Failed", false);
        }
    }

    private static void KillProcessOnPort(int port)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c for /f \"tokens=5\" %a in ('netstat -aon ^| findstr \":{port} \" ^| findstr \"LISTENING\"') do taskkill /f /pid %a",
                CreateNoWindow = true,
                UseShellExecute = false
            };
            using var p = Process.Start(psi);
            p?.WaitForExit(2000);
        }
        catch (Exception ex)
        {
            Log($"KillProcessOnPort error: {ex.Message}");
        }
    }

    private static async Task ShowStatusBalloonAsync()
    {
        if (_trayIcon == null) return;

        bool isLive = false;
        string infoText = "Gateway checking...";
        try
        {
            var res = await _httpClient.GetAsync($"http://127.0.0.1:{_gatewayPort}/v1/models");
            if (res.IsSuccessStatusCode)
            {
                isLive = true;
                infoText = $"Port: {_gatewayPort}\nEngine: Online (All Cascades Ready)\nStatus: Ready";
            }
        }
        catch (Exception ex)
        {
            infoText = $"Status: Offline ({ex.Message})";
        }

        _trayIcon.ShowBalloonTip(3500, isLive ? "🟢 NexusRoute Online" : "🔴 NexusRoute Offline", infoText, isLive ? ToolTipIcon.Info : ToolTipIcon.Warning);
    }

    public static void OpenBrowser(string url)
    {
        try
        {
            Log($"[OpenBrowser] Launching: {url}");
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c start \"\" \"{url}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log($"[OpenBrowser] cmd start error: {ex.Message}");
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex2)
            {
                Log($"[OpenBrowser] fallback error: {ex2.Message}");
            }
        }
    }

    private static void StopExistingInstances()
    {
        try
        {
            var current = Process.GetCurrentProcess();
            foreach (var proc in Process.GetProcessesByName("NexusRoute"))
            {
                if (proc.Id != current.Id)
                {
                    proc.Kill();
                }
            }
        }
        catch { }
    }

    private static void OnApplicationExit(object? sender, EventArgs e)
    {
        _isAppRunning = false;
        try
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
                _trayIcon = null;
            }

            if (_dashboardForm != null && !_dashboardForm.IsDisposed)
            {
                _dashboardForm.Dispose();
                _dashboardForm = null;
            }

            if (_gatewayProcess != null && !_gatewayProcess.HasExited)
            {
                _gatewayProcess.Kill(true);
            }

            _jobObject?.Dispose();
            _jobObject = null;

            _singleInstanceMutex?.ReleaseMutex();
            _singleInstanceMutex?.Dispose();
            _singleInstanceMutex = null;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Cleanup error: {ex.Message}");
        }
    }
}
