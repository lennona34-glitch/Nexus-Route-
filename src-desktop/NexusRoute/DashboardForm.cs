using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace NexusRoute;

public sealed class DashboardForm : Form
{
    private readonly Label _lblTitle;
    private readonly Label _lblSubtitle;
    private readonly Label _lblHeaderBadge;
    private readonly Label _lblStatus;
    private readonly Label _lblUrl;
    private readonly Label _lblEngine;
    private readonly Button _btnOpenStudio;
    private readonly Button _btnOpenFolder;
    private readonly Button _btnPrompts;
    private readonly Button _btnRestart;
    private readonly Button _btnCopyLog;
    private readonly Button _btnClearLog;
    private readonly CheckBox _chkAutoScroll;
    private readonly RichTextBox _txtLogs;
    private readonly CheckBox _chkMinimizeToTray;
    private readonly Button _btnHide;
    private readonly Button _btnExit;
    private bool _forceClose = false;
    public DateTime LastHiddenTime { get; private set; } = DateTime.MinValue;

    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_MINIMIZE = 0xF020;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public DashboardForm(bool startMinimized = false)
    {
        Text = Program.DashboardTitle;
        Size = new Size(1100, 750);
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(11, 15, 25); // Slate 950
        ForeColor = Color.FromArgb(241, 245, 249);
        Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

        try
        {
            Icon = Program.NexusIcon;
        }
        catch { }

        // ==========================================================
        // 1. Header Banner Panel (Fully Dynamic Height & Layout)
        // ==========================================================
        var headerPanel = new Panel
        {
            Dock = DockStyle.Top,
            Height = 96,
            BackColor = Color.FromArgb(15, 23, 42), // Slate 900
            Padding = new Padding(24, 14, 24, 14)
        };
        headerPanel.Paint += (_, e) =>
        {
            using var borderPen = new Pen(Color.FromArgb(30, 41, 59), 1f);
            e.Graphics.DrawLine(borderPen, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
        };

        _lblTitle = new Label
        {
            Text = "\u26A1 NexusRoute AI Studio",
            Font = new Font("Segoe UI", 16f, FontStyle.Bold),
            ForeColor = Color.White,
            AutoSize = true,
            Location = new Point(24, 14),
            UseMnemonic = false
        };

        _lblSubtitle = new Label
        {
            Text = "v1.3.0  •  Multi-Model AI Gateway  •  Zero-Cloud Fallbacks  •  Port 3000 Active",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
            ForeColor = Color.FromArgb(148, 163, 184), // Slate 400
            AutoSize = true,
            UseMnemonic = false
        };

        _lblHeaderBadge = new Label
        {
            Text = "\uD83D\uDFE2  GATEWAY ONLINE",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(52, 211, 153), // Emerald 400
            BackColor = Color.FromArgb(6, 78, 59), // Dark emerald
            Padding = new Padding(14, 7, 14, 7),
            AutoSize = true,
            UseMnemonic = false
        };

        void LayoutHeader()
        {
            _lblTitle.Location = new Point(24, 14);
            _lblSubtitle.Location = new Point(26, _lblTitle.Bottom + 6);

            int desiredHeight = Math.Max(92, _lblSubtitle.Bottom + 16);
            if (headerPanel.Height != desiredHeight)
            {
                headerPanel.Height = desiredHeight;
            }

            int badgeX = headerPanel.Width - _lblHeaderBadge.PreferredWidth - 24;
            int badgeY = Math.Max(14, (headerPanel.Height - _lblHeaderBadge.PreferredHeight) / 2);
            _lblHeaderBadge.Location = new Point(badgeX, badgeY);
        }

        headerPanel.Resize += (_, _) => LayoutHeader();
        headerPanel.Layout += (_, _) => LayoutHeader();
        _lblTitle.SizeChanged += (_, _) => LayoutHeader();
        _lblSubtitle.SizeChanged += (_, _) => LayoutHeader();
        _lblHeaderBadge.SizeChanged += (_, _) => LayoutHeader();

        headerPanel.Controls.Add(_lblTitle);
        headerPanel.Controls.Add(_lblSubtitle);
        headerPanel.Controls.Add(_lblHeaderBadge);

        // ==========================================================
        // 2. Gateway Status & Quick Actions Card Panel
        // ==========================================================
        var cardPanel = new Panel
        {
            Dock = DockStyle.Top,
            Height = 125,
            BackColor = Color.FromArgb(19, 28, 46),
            Padding = new Padding(24, 12, 24, 12)
        };
        cardPanel.Paint += (_, e) =>
        {
            using var borderPen = new Pen(Color.FromArgb(30, 41, 59), 1f);
            e.Graphics.DrawLine(borderPen, 0, cardPanel.Height - 1, cardPanel.Width, cardPanel.Height - 1);
        };

        _lblStatus = new Label
        {
            Text = "\uD83D\uDFE2 AI Gateway: Online & Listening",
            Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(52, 211, 153),
            AutoSize = true,
            Location = new Point(24, 14),
            UseMnemonic = false
        };

        _lblUrl = new Label
        {
            Text = $"\uD83C\uDF10 http://localhost:{Program.GatewayPort}",
            Font = new Font("Segoe UI", 10f, FontStyle.Underline),
            ForeColor = Color.FromArgb(96, 165, 250), // Sky 400
            Cursor = Cursors.Hand,
            AutoSize = true,
            Location = new Point(280, 14),
            UseMnemonic = false
        };
        _lblUrl.Click += (_, _) => Program.OpenBrowser($"http://localhost:{Program.GatewayPort}");

        _lblEngine = new Label
        {
            Text = "\u26A1 Local Engine: Embedded Ollama / CUDA Ready (Port 11434)",
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
            ForeColor = Color.FromArgb(148, 163, 184),
            AutoSize = true,
            UseMnemonic = false
        };

        // Action Buttons Row (FlowLayoutPanel with AutoSize to fit labels completely)
        var actionsFlow = new FlowLayoutPanel
        {
            BackColor = Color.Transparent,
            WrapContents = true,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(0),
            Margin = new Padding(0)
        };

        _btnOpenStudio = CreateStyledButton("\uD83C\uDF10 Open Studio", Color.FromArgb(79, 70, 229), Color.White, isPrimary: true);
        _btnOpenStudio.Click += (_, _) => Program.OpenBrowser($"http://localhost:{Program.GatewayPort}");

        _btnOpenFolder = CreateStyledButton("\uD83D\uDCC1 Workspace", Color.FromArgb(30, 41, 59), Color.FromArgb(241, 245, 249));
        _btnOpenFolder.Click += (_, _) =>
        {
            string wsDir = Path.Combine(Program.AppDir, "workspace");
            if (!Directory.Exists(wsDir)) Directory.CreateDirectory(wsDir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{wsDir}\"") { UseShellExecute = true });
        };

        _btnPrompts = CreateStyledButton("\u2699\uFE0F Prompts & Rules", Color.FromArgb(30, 41, 59), Color.FromArgb(241, 245, 249));
        _btnPrompts.Click += (_, _) => Program.OpenBrowser($"http://localhost:{Program.GatewayPort}#promptsModal");

        _btnRestart = CreateStyledButton("\uD83D\uDD04 Restart Gateway", Color.FromArgb(30, 41, 59), Color.FromArgb(248, 113, 113));
        _btnRestart.Click += async (_, _) =>
        {
            _btnRestart.Enabled = false;
            UpdateStatus("\uD83D\uDFE1 AI Gateway: Restarting...", false);
            await Program.RestartGatewayAsync();
            _btnRestart.Enabled = true;
        };

        actionsFlow.Controls.Add(_btnOpenStudio);
        actionsFlow.Controls.Add(_btnOpenFolder);
        actionsFlow.Controls.Add(_btnPrompts);
        actionsFlow.Controls.Add(_btnRestart);

        void LayoutCardPanel()
        {
            _lblStatus.Location = new Point(24, 14);
            _lblUrl.Location = new Point(_lblStatus.Right + 14, 14);

            int engineX = cardPanel.Width - _lblEngine.PreferredWidth - 24;
            int minEngineX = _lblUrl.Right + 20;
            if (engineX >= minEngineX)
            {
                _lblEngine.Location = new Point(engineX, 14);
                _lblEngine.Visible = true;
            }
            else
            {
                _lblEngine.Visible = false;
            }

            int actionsTop = Math.Max(_lblStatus.Bottom, _lblUrl.Bottom) + 12;
            actionsFlow.Location = new Point(24, actionsTop);
            actionsFlow.MaximumSize = new Size(Math.Max(300, cardPanel.Width - 48), 0);

            int desiredHeight = Math.Max(120, actionsFlow.Bottom + 14);
            if (cardPanel.Height != desiredHeight)
            {
                cardPanel.Height = desiredHeight;
            }
        }

        _lblStatus.TextChanged += (_, _) => LayoutCardPanel();
        cardPanel.Resize += (_, _) => LayoutCardPanel();
        cardPanel.Layout += (_, _) => LayoutCardPanel();
        actionsFlow.SizeChanged += (_, _) => LayoutCardPanel();

        cardPanel.Controls.Add(_lblStatus);
        cardPanel.Controls.Add(_lblUrl);
        cardPanel.Controls.Add(_lblEngine);
        cardPanel.Controls.Add(actionsFlow);

        // ==========================================================
        // 3. Live Server Console Body & Header
        // ==========================================================
        _txtLogs = new RichTextBox
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(3, 7, 18), // Deep black
            ForeColor = Color.FromArgb(125, 211, 252), // Cyber sky blue
            Font = GetMonospaceFont(),
            ReadOnly = true,
            BorderStyle = BorderStyle.None,
            WordWrap = false,
            ScrollBars = RichTextBoxScrollBars.Both
        };

        var logHeader = new Panel
        {
            Dock = DockStyle.Top,
            Height = 44,
            BackColor = Color.FromArgb(15, 23, 42),
            Padding = new Padding(24, 6, 24, 6)
        };

        var lblLogTitle = new Label
        {
            Text = "\uD83D\uDCCB Real-Time Server Activity & Engine Log:",
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = Color.FromArgb(226, 232, 240),
            AutoSize = true,
            UseMnemonic = false
        };

        var logToolbar = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft,
            BackColor = Color.Transparent,
            WrapContents = false,
            Margin = new Padding(0),
            Padding = new Padding(0)
        };

        _chkAutoScroll = new CheckBox
        {
            Text = "Auto-scroll",
            Checked = true,
            ForeColor = Color.FromArgb(148, 163, 184),
            Font = new Font("Segoe UI", 9f),
            AutoSize = true,
            Margin = new Padding(12, 6, 4, 0),
            UseMnemonic = false
        };

        _btnClearLog = CreateMiniButton("\uD83E\uDDF9 Clear");
        _btnClearLog.Click += (_, _) => _txtLogs.Clear();

        _btnCopyLog = CreateMiniButton("\uD83D\uDCCB Copy All");
        _btnCopyLog.Click += (_, _) =>
        {
            if (!string.IsNullOrEmpty(_txtLogs.Text))
            {
                Clipboard.SetText(_txtLogs.Text);
                _btnCopyLog.Text = "\u2714 Copied!";
                var t = new System.Windows.Forms.Timer { Interval = 1500 };
                t.Tick += (_, _) => { _btnCopyLog.Text = "\uD83D\uDCCB Copy All"; t.Stop(); t.Dispose(); };
                t.Start();
            }
        };

        logToolbar.Controls.Add(_chkAutoScroll);
        logToolbar.Controls.Add(_btnClearLog);
        logToolbar.Controls.Add(_btnCopyLog);

        void LayoutLogHeader()
        {
            lblLogTitle.Location = new Point(24, Math.Max(4, (logHeader.Height - lblLogTitle.PreferredHeight) / 2));
            int minHeight = Math.Max(42, logToolbar.PreferredSize.Height + 8);
            if (logHeader.Height != minHeight)
            {
                logHeader.Height = minHeight;
            }
        }

        logHeader.Resize += (_, _) => LayoutLogHeader();
        logHeader.Layout += (_, _) => LayoutLogHeader();

        logHeader.Controls.Add(lblLogTitle);
        logHeader.Controls.Add(logToolbar);

        var logBorderPanel = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(1),
            BackColor = Color.FromArgb(30, 41, 59) // 1px border
        };
        logBorderPanel.Controls.Add(_txtLogs);

        var logContainer = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24, 0, 24, 8),
            BackColor = Color.FromArgb(15, 23, 42)
        };
        logContainer.Controls.Add(logBorderPanel);

        // ==========================================================
        // 4. Bottom Options & Utility Bar (Fully Responsive)
        // ==========================================================
        var bottomPanel = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 56,
            BackColor = Color.FromArgb(15, 23, 42),
            Padding = new Padding(24, 8, 24, 8)
        };
        bottomPanel.Paint += (_, e) =>
        {
            using var borderPen = new Pen(Color.FromArgb(30, 41, 59), 1f);
            e.Graphics.DrawLine(borderPen, 0, 0, bottomPanel.Width, 0);
        };

        _chkMinimizeToTray = new CheckBox
        {
            Text = "Minimize to system tray when closed (keeps gateway running)",
            Checked = true,
            AutoSize = true,
            ForeColor = Color.FromArgb(148, 163, 184),
            Font = new Font("Segoe UI", 9.5f),
            UseMnemonic = false
        };

        var bottomActions = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.RightToLeft,
            BackColor = Color.Transparent,
            WrapContents = false,
            Padding = new Padding(0),
            Margin = new Padding(0)
        };

        _btnExit = CreateStyledButton("\u2715 Exit App", Color.FromArgb(30, 41, 59), Color.FromArgb(248, 113, 113));
        _btnExit.Click += (_, _) =>
        {
            var res = MessageBox.Show(
                "Are you sure you want to exit NexusRoute?\n\nThis will stop the background AI Gateway on port 3000.",
                "Exit NexusRoute",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (res == DialogResult.Yes)
            {
                Program.ExitApplication();
            }
        };

        _btnHide = CreateStyledButton("\u2B07\uFE0F Hide to Tray", Color.FromArgb(30, 41, 59), Color.FromArgb(241, 245, 249));
        _btnHide.Click += (_, _) =>
        {
            HideToTray();
        };

        bottomActions.Controls.Add(_btnExit);
        bottomActions.Controls.Add(_btnHide);

        void LayoutBottomPanel()
        {
            int minHeight = Math.Max(54, bottomActions.PreferredSize.Height + 14);
            if (bottomPanel.Height != minHeight)
            {
                bottomPanel.Height = minHeight;
            }

            int availableWidth = bottomPanel.Width - bottomActions.PreferredSize.Width - 48;
            if (availableWidth > 80)
            {
                _chkMinimizeToTray.MaximumSize = new Size(availableWidth, 0);
            }
            _chkMinimizeToTray.Location = new Point(24, Math.Max(4, (bottomPanel.Height - _chkMinimizeToTray.PreferredSize.Height) / 2));
        }

        bottomPanel.Resize += (_, _) => LayoutBottomPanel();
        bottomPanel.Layout += (_, _) => LayoutBottomPanel();

        bottomPanel.Controls.Add(_chkMinimizeToTray);
        bottomPanel.Controls.Add(bottomActions);

        // ==========================================================
        // 5. Assemble Controls in Proper Reverse-Z Dock Order
        // ==========================================================
        Controls.Add(logContainer);
        Controls.Add(logHeader);
        Controls.Add(bottomPanel);
        Controls.Add(cardPanel);
        Controls.Add(headerPanel);

        if (startMinimized)
        {
            WindowState = FormWindowState.Minimized;
            ShowInTaskbar = false;
        }

        Load += (s, e) =>
        {
            LayoutHeader();
            LayoutCardPanel();
            LayoutLogHeader();
            LayoutBottomPanel();

            if (startMinimized)
            {
                BeginInvoke(new Action(() =>
                {
                    HideToTray();
                }));
            }
        };

        Resize += (_, _) =>
        {
            if (_chkMinimizeToTray.Checked && WindowState == FormWindowState.Minimized)
            {
                HideToTray();
            }
        };

        FormClosing += (s, e) =>
        {
            if (!_forceClose && e.CloseReason == CloseReason.UserClosing && _chkMinimizeToTray.Checked)
            {
                e.Cancel = true;
                HideToTray();
            }
        };
    }

    public void HideToTray()
    {
        LastHiddenTime = DateTime.UtcNow;
        Hide();
        ShowInTaskbar = false;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_SYSCOMMAND && (m.WParam.ToInt32() & 0xFFF0) == SC_MINIMIZE)
        {
            if (_chkMinimizeToTray.Checked)
            {
                HideToTray();
                return;
            }
        }
        base.WndProc(ref m);
    }

    public void ForceClose()
    {
        _forceClose = true;
        Close();
    }

    private static Font GetMonospaceFont()
    {
        try
        {
            var testFont = new Font("Cascadia Mono", 9.5f, FontStyle.Regular);
            if (testFont.Name == "Cascadia Mono") return testFont;
        }
        catch { }

        try
        {
            var testFont = new Font("Consolas", 9.5f, FontStyle.Regular);
            if (testFont.Name == "Consolas") return testFont;
        }
        catch { }

        return new Font(FontFamily.GenericMonospace, 9.5f, FontStyle.Regular);
    }

    private static Button CreateStyledButton(string text, Color backColor, Color foreColor, bool isPrimary = false)
    {
        var btn = new Button
        {
            Text = text,
            Font = new Font("Segoe UI", isPrimary ? 10f : 9.5f, isPrimary ? FontStyle.Bold : FontStyle.Regular),
            BackColor = backColor,
            ForeColor = foreColor,
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(16, 7, 16, 7),
            Margin = new Padding(0, 0, 10, 0),
            UseMnemonic = false
        };

        if (isPrimary)
        {
            btn.FlatAppearance.BorderSize = 0;
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(67, 56, 202);
            btn.FlatAppearance.MouseDownBackColor = Color.FromArgb(55, 48, 163);
        }
        else
        {
            btn.FlatAppearance.BorderSize = 1;
            btn.FlatAppearance.BorderColor = Color.FromArgb(51, 65, 85);
            btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(51, 65, 85);
            btn.FlatAppearance.MouseDownBackColor = Color.FromArgb(71, 85, 105);
        }

        return btn;
    }

    private static Button CreateMiniButton(string text)
    {
        var btn = new Button
        {
            Text = text,
            Font = new Font("Segoe UI", 9f, FontStyle.Regular),
            BackColor = Color.FromArgb(30, 41, 59),
            ForeColor = Color.FromArgb(203, 213, 225),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Padding = new Padding(12, 4, 12, 4),
            Margin = new Padding(6, 2, 0, 2),
            UseMnemonic = false
        };
        btn.FlatAppearance.BorderSize = 1;
        btn.FlatAppearance.BorderColor = Color.FromArgb(51, 65, 85);
        btn.FlatAppearance.MouseOverBackColor = Color.FromArgb(51, 65, 85);
        return btn;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            // Windows 11 Dark Mode Titlebar
            int darkMode = 1;
            DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref darkMode, sizeof(int));

            // Windows 11 Rounded Corners Preference
            int roundCorners = 2 /* DWMWCP_ROUND */;
            DwmSetWindowAttribute(Handle, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, ref roundCorners, sizeof(int));

            // Caption Color matching Slate 900
            int captionColor = 0x001E170F; // BGR format for #0F172A
            DwmSetWindowAttribute(Handle, 35 /* DWMWA_CAPTION_COLOR */, ref captionColor, sizeof(int));
        }
        catch { }
    }

    public void UpdateStatus(string statusText, bool isOnline)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => UpdateStatus(statusText, isOnline)));
            return;
        }

        _lblStatus.Text = statusText;
        _lblStatus.ForeColor = isOnline ? Color.FromArgb(52, 211, 153) : Color.FromArgb(248, 113, 113);

        if (isOnline)
        {
            _lblHeaderBadge.Text = "\uD83D\uDFE2  GATEWAY ONLINE";
            _lblHeaderBadge.ForeColor = Color.FromArgb(52, 211, 153);
            _lblHeaderBadge.BackColor = Color.FromArgb(6, 78, 59);
        }
        else
        {
            _lblHeaderBadge.Text = "\uD83D\uDD34  GATEWAY OFFLINE";
            _lblHeaderBadge.ForeColor = Color.FromArgb(248, 113, 113);
            _lblHeaderBadge.BackColor = Color.FromArgb(69, 10, 10);
        }
    }

    public void AppendLog(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;

        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => AppendLog(text)));
            return;
        }

        try
        {
            if (_txtLogs.Lines.Length > 3000)
            {
                _txtLogs.Text = _txtLogs.Text.Substring(_txtLogs.Text.Length / 2);
            }

            _txtLogs.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}\r\n");

            if (_chkAutoScroll.Checked)
            {
                _txtLogs.SelectionStart = _txtLogs.Text.Length;
                _txtLogs.ScrollToCaret();
            }
        }
        catch { }
    }
}
