// Ezlearn.exe：双击启动。没有任何命令行窗口：后台服务隐藏运行，界面在一个独立的应用窗口里打开。
// 窗口关掉后，服务在两分钟内自动退出（服务端心跳逻辑），不留后台进程。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Ezlearn
{
    internal static class Launcher
    {
        static bool noWindow;
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string render = Common.Arg(args, "Render");
            if (render != null) { RenderSplash(render); return 0; }
            noWindow = Common.Arg(args, "NoWindow") != null; // 测试用：只启动后台服务，不打开窗口

            bool created;
            using (var mutex = new Mutex(true, @"Local\EzlearnLauncher", out created))
            {
                if (Common.ServerAlive()) { OpenWindow(); return 0; }
                if (!created)
                {
                    // 另一个启动器正在启动服务：等它起来再开窗口
                    for (int i = 0; i < 60 && !Common.ServerAlive(); i++) Thread.Sleep(500);
                    if (Common.ServerAlive()) OpenWindow();
                    return 0;
                }
                return StartAndOpen();
            }
        }

        static string InstallDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }

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

        static int StartAndOpen()
        {
            var splash = new Splash();
            splash.Show();
            Application.DoEvents();

            string node = ResolveNode();
            if (node == null)
            {
                splash.Close();
                MessageBox.Show("找不到可用的 Node.js（Ezlearn 需要它才能运行）。\n\n可能是电脑上原来的 Node.js 被卸载了。请重新运行 Ezlearn 安装程序，它会自动安装一份内置的 Node.js。",
                    "Ezlearn 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            Directory.CreateDirectory(Common.LogDir);
            string log = Path.Combine(Common.LogDir, "server.log");
            string appDir = Path.Combine(InstallDir, "app");
            var psi = new ProcessStartInfo(node, "\"" + Path.Combine(appDir, "server", "index.js") + "\"")
            {
                WorkingDirectory = appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            psi.EnvironmentVariables["EZLEARN_LAUNCHER"] = "1";
            psi.EnvironmentVariables["EZLEARN_LOG_FILE"] = log;
            psi.EnvironmentVariables.Remove("EZLEARN_HOST");
            psi.EnvironmentVariables.Remove("EZLEARN_PORT");
            psi.EnvironmentVariables.Remove("EZLEARN_DATA_DIR");
            psi.EnvironmentVariables.Remove("EZLEARN_FAKE_LLM");
            psi.EnvironmentVariables.Remove("NODE_OPTIONS");

            Process proc;
            try { proc = Process.Start(psi); }
            catch (Exception e)
            {
                splash.Close();
                MessageBox.Show("启动失败：" + e.Message, "Ezlearn", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            var sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalSeconds < 60)
            {
                Application.DoEvents();
                if (Common.ServerAlive()) break;
                if (proc.HasExited)
                {
                    splash.Close();
                    MessageBox.Show("Ezlearn 后台服务没能启动。\n\n" + Tail(log, 6) + "\n\n运行日志：" + log, "Ezlearn 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                splash.SetProgress((int)Math.Min(95, sw.Elapsed.TotalSeconds * 12));
                Thread.Sleep(150);
            }
            if (!Common.ServerAlive())
            {
                splash.Close();
                MessageBox.Show("Ezlearn 启动超时。请稍后再试，或重新启动电脑。\n\n运行日志：" + log, "Ezlearn", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
            splash.SetProgress(100, "正在打开窗口……");
            Application.DoEvents();
            OpenWindow();
            Thread.Sleep(800);
            splash.Close();
            return 0;
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

        /// <summary>
        /// 用 Edge（或 Chrome）的"应用窗口"模式打开：没有地址栏和标签页，看起来就是一个独立软件。
        /// 使用单独的浏览器配置目录（卸载时一并删除），不影响你平时用的浏览器。
        /// </summary>
        static void OpenWindow()
        {
            if (noWindow) return;
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
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 150);
            BackColor = Color.FromArgb(251, 250, 247);
            Font = new Font("Microsoft YaHei UI", 10F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label { Text = "Ezlearn 通用学习软件", Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold), ForeColor = Color.FromArgb(34, 33, 31), AutoSize = true, Location = new Point(24, 20) };
            status = new Label { Text = "正在启动，请稍候……", ForeColor = Color.FromArgb(109, 106, 99), AutoSize = true, Location = new Point(26, 62) };
            bar = new ProgressBar { Location = new Point(26, 96), Size = new Size(368, 16), Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Continuous };
            Controls.Add(title);
            Controls.Add(status);
            Controls.Add(bar);
        }

        public void SetProgress(int value, string text = null)
        {
            bar.Value = Math.Max(0, Math.Min(100, value));
            if (text != null) status.Text = text;
            Refresh();
        }
    }
}
