// Ezlearn.exe：双击启动的桌面程序。
// - 没有命令行窗口：后台服务隐藏运行，输出写日志文件；
// - 界面是一个没有系统标题栏的桌面窗口（AppWindow，WebView2），标题和窗口按钮在软件界面顶部；
// - 同一时间只开一个窗口：再次双击会把已有窗口调到前面；
// - 关掉窗口时请后台服务退出（有任务在跑就等它做完再退）。
// 测试参数：/Render=png（启动画面截图）  /NoWindow（只启动服务）  /SelfTest=结果.txt（离屏打开窗口自检）
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Ezlearn
{
    internal static class Launcher
    {
        const string ShowEventName = @"Local\EzlearnShowWindow";

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string render = Common.Arg(args, "Render");
            if (render != null) { RenderSplash(render); return 0; }
            bool noWindow = Common.Arg(args, "NoWindow") != null;
            string selfTest = Common.Arg(args, "SelfTest");

            bool created;
            using (var mutex = new Mutex(true, @"Local\EzlearnLauncher", out created))
            {
                if (!created && selfTest == null)
                {
                    // 已经有一个 Ezlearn 窗口：让它显示到最前面
                    try { using (var ev = EventWaitHandle.OpenExisting(ShowEventName)) ev.Set(); } catch { }
                    return 0;
                }

                Splash splash = null;
                if (!Common.ServerAlive())
                {
                    splash = selfTest == null ? new Splash() : null;
                    if (splash != null) { splash.Show(); Application.DoEvents(); }
                    int rc = StartServer(splash);
                    if (rc != 0) { if (splash != null) splash.Close(); return rc; }
                }
                if (noWindow) { if (splash != null) splash.Close(); return 0; }

                if (!WebViewAvailable())
                {
                    // 电脑上没有 WebView2 运行时（极少见，Win11 自带）：退回到 Edge / Chrome 的应用窗口
                    if (splash != null) { splash.SetProgress(100, "正在打开窗口……"); Thread.Sleep(500); splash.Close(); }
                    OpenBrowserWindow();
                    return 0;
                }
                if (splash != null) splash.SetProgress(100, "正在打开窗口……");

                using (var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName))
                {
                    var win = new AppWindow(splash, selfTest);
                    var watcher = new Thread(() =>
                    {
                        while (true)
                        {
                            showEvent.WaitOne();
                            try
                            {
                                win.BeginInvoke((Action)(() =>
                                {
                                    if (win.WindowState == FormWindowState.Minimized) win.WindowState = FormWindowState.Normal;
                                    win.Activate();
                                }));
                            }
                            catch { return; }
                        }
                    }) { IsBackground = true };
                    watcher.Start();
                    Application.Run(win);
                }
                RequestShutdownIfIdle();
                return 0;
            }
        }

        static string InstallDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }

        static bool WebViewAvailable()
        {
            try { return !string.IsNullOrEmpty(Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString()); }
            catch { return false; }
        }

        static string ResolveNode()
        {
            var info = Common.ReadInstallInfo(InstallDir);
            string node = info != null ? Common.JsonGet(info, "node") : null;
            if (!string.IsNullOrEmpty(node) && !Path.IsPathRooted(node)) node = Path.Combine(InstallDir, node);
            if (!string.IsNullOrEmpty(node) && Common.NodeUsable(Common.NodeVersion(node))) return node;
            var bundled = Path.Combine(InstallDir, "runtime", "node.exe");
            if (Common.NodeUsable(Common.NodeVersion(bundled))) return bundled;
            string v;
            return Common.FindSystemNode(out v);
        }

        static void Fail(Splash splash, string msg, MessageBoxIcon icon)
        {
            if (splash != null) splash.Close();
            MessageBox.Show(msg, "Ezlearn", MessageBoxButtons.OK, icon);
        }

        static int StartServer(Splash splash)
        {
            string node = ResolveNode();
            if (node == null)
            {
                Fail(splash, "找不到可用的 Node.js（Ezlearn 需要它才能运行）。\n\n可能是电脑上原来的 Node.js 被卸载了。请重新运行 Ezlearn 安装程序，它会自动安装一份内置的 Node.js。", MessageBoxIcon.Error);
                return 1;
            }

            Directory.CreateDirectory(Common.LogDir);
            string log = Path.Combine(Common.LogDir, "server.log");
            string appDir = Path.Combine(InstallDir, "app");

            // 控制口令：关窗时凭它请服务退出。每次启动重新生成，保存在当前用户自己的目录里。
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            string control = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            try { File.WriteAllText(Common.ControlTokenFile, control); } catch { }

            var psi = new ProcessStartInfo(node, "\"" + Path.Combine(appDir, "server", "index.js") + "\"")
            {
                WorkingDirectory = appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            psi.EnvironmentVariables["EZLEARN_LAUNCHER"] = "1";
            psi.EnvironmentVariables["EZLEARN_LOG_FILE"] = log;
            psi.EnvironmentVariables["EZLEARN_CONTROL_TOKEN"] = control;
            foreach (var k in new[] { "EZLEARN_HOST", "EZLEARN_PORT", "EZLEARN_DATA_DIR", "EZLEARN_FAKE_LLM", "EZLEARN_ALLOW_REMOTE", "NODE_OPTIONS" })
                psi.EnvironmentVariables.Remove(k);

            Process proc;
            try { proc = Process.Start(psi); }
            catch (Exception e) { Fail(splash, "启动失败：" + e.Message, MessageBoxIcon.Error); return 1; }

            var sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalSeconds < 60)
            {
                Application.DoEvents();
                if (Common.ServerAlive()) return 0;
                if (proc.HasExited)
                {
                    Fail(splash, "Ezlearn 后台服务没能启动。\n\n" + Tail(log, 6) + "\n\n运行日志：" + log, MessageBoxIcon.Error);
                    return 1;
                }
                if (splash != null) splash.SetProgress((int)Math.Min(90, sw.Elapsed.TotalSeconds * 12));
                Thread.Sleep(150);
            }
            Fail(splash, "Ezlearn 启动超时。请稍后再试，或重新启动电脑。\n\n运行日志：" + log, MessageBoxIcon.Warning);
            return 1;
        }

        /// <summary>窗口关掉后请服务退出；有任务在运行时服务会拒绝，等任务做完、没有窗口心跳后再自己退出。</summary>
        static void RequestShutdownIfIdle()
        {
            try
            {
                string token = File.ReadAllText(Common.ControlTokenFile).Trim();
                var req = (HttpWebRequest)WebRequest.Create(Common.AppUrl + "control/shutdown");
                req.Method = "POST";
                req.Proxy = null;
                req.Timeout = 3000;
                req.Headers["X-Ezlearn-Control"] = token;
                req.ContentLength = 0;
                using (req.GetResponse()) { }
            }
            catch { /* 有任务在跑（409）或服务已经退出：都不需要处理 */ }
        }

        static string Tail(string file, int lines)
        {
            try
            {
                var all = File.ReadAllLines(file);
                int start = Math.Max(0, all.Length - lines);
                return string.Join("\n", all, start, all.Length - start);
            }
            catch { return ""; }
        }

        static string AppPath(string exe)
        {
            foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                try
                {
                    using (var k = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                    {
                        var v = k != null ? k.GetValue("") as string : null;
                        if (!string.IsNullOrEmpty(v) && File.Exists(v.Trim('"'))) return v.Trim('"');
                    }
                }
                catch { }
            }
            return null;
        }

        /// <summary>后备方案：用 Edge（或 Chrome）的"应用窗口"打开（独立配置目录，不影响你平时的浏览器）。</summary>
        public static void OpenBrowserWindow()
        {
            string browser = AppPath("msedge.exe");
            if (browser == null)
            {
                var guess = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
                if (File.Exists(guess)) browser = guess;
            }
            if (browser == null) browser = AppPath("chrome.exe");
            if (browser != null)
            {
                try
                {
                    Directory.CreateDirectory(Common.BrowserProfileDir);
                    var a = "--app=" + Common.AppUrl + " --user-data-dir=\"" + Common.BrowserProfileDir + "\" --no-first-run --no-default-browser-check --window-size=1280,860";
                    Process.Start(new ProcessStartInfo(browser, a) { UseShellExecute = false });
                    return;
                }
                catch { }
            }
            try { Process.Start(new ProcessStartInfo(Common.AppUrl) { UseShellExecute = true }); }
            catch (Exception e) { MessageBox.Show("请手动在浏览器打开 " + Common.AppUrl + "\n\n" + e.Message, "Ezlearn"); }
        }

        static void RenderSplash(string png)
        {
            using (var s = new Splash())
            {
                s.Shown += delegate { s.SetProgress(40); };
                Common.RenderForm(s, png);
            }
        }
    }

    internal class Splash : Form
    {
        readonly ProgressBar bar;
        readonly Label status;

        public Splash()
        {
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi; // 高分屏下按比例放大，字不发虚
            Text = "Ezlearn";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 140);
            BackColor = Color.FromArgb(251, 250, 247);
            Font = new Font("Microsoft YaHei UI", 10F);
            ShowInTaskbar = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label { Text = "Ezlearn 通用学习软件", Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold), ForeColor = Color.FromArgb(34, 33, 31), AutoSize = true, Location = new Point(24, 22) };
            status = new Label { Text = "正在启动，请稍候……", ForeColor = Color.FromArgb(109, 106, 99), AutoSize = true, Location = new Point(26, 62) };
            bar = new ProgressBar { Location = new Point(26, 96), Size = new Size(368, 14), Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Continuous };
            Controls.Add(title);
            Controls.Add(status);
            Controls.Add(bar);
            Paint += (o, e) => { using (var pen = new Pen(Color.FromArgb(227, 223, 214))) e.Graphics.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1); };
        }

        public void SetProgress(int value, string text = null)
        {
            bar.Value = Math.Max(0, Math.Min(100, value));
            if (text != null) status.Text = text;
            Refresh();
        }
    }
}
