// Ezlearn 卸载程序：删除软件本体、内置 Node.js、快捷方式、系统应用列表登记、内置浏览器配置与日志；
// 勾选后还会删除全部课程数据（%APPDATA%\Ezlearn）。电脑上原有的、不是 Ezlearn 装的 Node.js 不会被动。
// 卸载程序先把自己复制到临时目录再运行，这样才能把安装目录整个删掉；结束后临时副本也会自行删除。
// 命令行：/S 静默  /KeepData 保留课程数据  /Render=预览图.png
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Ezlearn
{
    internal static class UninstallProgram
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string self = Application.ExecutablePath;
            string from = Common.Arg(args, "From");
            bool silent = Common.Arg(args, "S") != null;
            bool keepData = Common.Arg(args, "KeepData") != null;
            string render = Common.Arg(args, "Render");

            if (render != null)
            {
                using (var f = new UninstallForm(Path.GetDirectoryName(self), false)) f.RenderTo(render);
                return 0;
            }

            if (from == null)
            {
                // 第一步：从安装目录里被启动 → 复制到临时目录重新运行
                string dir = Path.GetDirectoryName(self);
                string why;
                if (!Common.IsSafeInstallDir(dir, out why))
                {
                    if (!silent) MessageBox.Show("这里不是 Ezlearn 的安装目录（" + why + "），卸载已取消。", "卸载 Ezlearn", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 2;
                }
                string tmp = Path.Combine(Path.GetTempPath(), "ezlearn-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(self, tmp, true);
                // 原卸载程序马上退出（否则它自己这个文件被占用，安装目录删不干净）；临时副本会等它退出后再开始删
                var a = "/From=\"" + dir + "\" /ParentPid=" + Process.GetCurrentProcess().Id + (silent ? " /S" : "") + (keepData ? " /KeepData" : "");
                Process.Start(new ProcessStartInfo(tmp, a) { UseShellExecute = false });
                return 0;
            }

            string ppid = Common.Arg(args, "ParentPid");
            int parent;
            if (ppid != null && int.TryParse(ppid, out parent))
            {
                try { Process.GetProcessById(parent).WaitForExit(15000); } catch { /* 已经退出 */ }
            }

            int code;
            if (silent)
            {
                var r = Uninstaller.Run(from, !keepData, s => { });
                code = r.Count == 0 ? 0 : 3;
                // 静默卸载没有界面：结果写到临时目录，方便排查
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "ezlearn-uninstall-result.txt"), code == 0 ? "ok" : "left:\r\n" + string.Join("\r\n", r)); } catch { }
            }
            else
            {
                var form = new UninstallForm(from, true);
                Application.Run(form);
                code = form.ExitCode;
            }
            SelfDelete(self);
            return code;
        }

        /// <summary>临时副本退出后删除自己（用隐藏的 cmd，不弹窗口）。</summary>
        static void SelfDelete(string self)
        {
            if (!Path.GetFileName(self).StartsWith("ezlearn-uninstall-", StringComparison.OrdinalIgnoreCase)) return;
            if (!self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
            }
            catch { }
        }
    }

    internal static class Uninstaller
    {
        /// <summary>执行卸载，返回没能删除的项目（空 = 全部删除）。</summary>
        public static List<string> Run(string installDir, bool deleteData, Action<string> report)
        {
            var left = new List<string>();
            string why;
            if (!Common.IsSafeInstallDir(installDir, out why)) { left.Add(installDir + "（" + why + "，未删除）"); return left; }

            report("正在关闭 Ezlearn……");
            Common.KillByCommandLine("Ezlearn.exe", installDir);
            Common.KillByCommandLine("node.exe", Path.Combine(installDir, "app", "server", "index.js"));
            Common.KillByCommandLine("msedgewebview2.exe", Common.WebViewDataDir);
            Common.KillByCommandLine("msedge.exe", Common.BrowserProfileDir);
            Common.KillByCommandLine("chrome.exe", Common.BrowserProfileDir);
            Thread.Sleep(800);

            report("正在删除快捷方式……");
            try { if (File.Exists(Common.DesktopShortcut)) File.Delete(Common.DesktopShortcut); } catch { left.Add(Common.DesktopShortcut); }
            try { if (Directory.Exists(Common.StartMenuDir)) Directory.Delete(Common.StartMenuDir, true); } catch { left.Add(Common.StartMenuDir); }

            report("正在从系统应用列表中移除……");
            Common.Unregister();

            report("正在删除程序文件（含内置 Node.js）……");
            if (Common.DeleteTree(installDir) > 0) left.Add(installDir);

            report("正在删除浏览器窗口配置和日志……");
            if (Common.IsOurDataDir(Common.LocalDir) && Common.DeleteTree(Common.LocalDir) > 0) left.Add(Common.LocalDir);

            if (deleteData)
            {
                report("正在删除课程数据……");
                if (Common.IsOurDataDir(Common.DataDir) && Common.DeleteTree(Common.DataDir) > 0) left.Add(Common.DataDir);
            }
            report(left.Count == 0 ? "卸载完成" : "卸载完成，但有几项没能删除");
            return left;
        }
    }

    internal class UninstallForm : Form
    {
        readonly string installDir;
        readonly CheckBox dataBox;
        readonly Label status;
        readonly Button goBtn, cancelBtn;
        bool finished;
        public int ExitCode = 1;

        public UninstallForm(string dir, bool interactive)
        {
            installDir = dir;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi; // 高分屏下按比例放大，字不发虚
            Text = "卸载 Ezlearn";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(600, 380);
            BackColor = Color.FromArgb(251, 250, 247);
            Font = new Font("Microsoft YaHei UI", 9.5F);

            var info = Common.ReadInstallInfo(dir) ?? "";
            bool systemNode = Common.JsonGet(info, "node_mode") == "system";

            var title = new Label { Text = "卸载 Ezlearn 通用学习软件", Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold), AutoSize = true, Location = new Point(24, 18) };
            var what = new Label
            {
                Text = "将删除：\n" +
                       "  • 程序文件：" + dir + "\n" +
                       (systemNode ? "" : "  • 随 Ezlearn 安装的内置 Node.js\n") +
                       "  • 桌面和开始菜单的快捷方式、系统应用列表里的登记\n" +
                       "  • Ezlearn 窗口的浏览器配置和运行日志（" + Common.LocalDir + "）" +
                       (systemNode ? "\n你电脑上原有的 Node.js 不是 Ezlearn 安装的，不会被删除。" : ""),
                AutoSize = false, Location = new Point(26, 56), Size = new Size(550, 124),
            };
            dataBox = new CheckBox
            {
                Text = "同时删除我的全部课程、学习书、书签和设置（" + Common.DataDir + "）\n删除后无法恢复。想保留就取消勾选，以后重新安装还能接着用。",
                Checked = true, AutoSize = false, Location = new Point(26, 186), Size = new Size(550, 70), ForeColor = Color.FromArgb(180, 52, 58),
            };
            status = new Label { Text = "", AutoSize = false, Location = new Point(26, 262), Size = new Size(550, 56), ForeColor = Color.FromArgb(109, 106, 99) };
            goBtn = new Button { Text = "卸载", Location = new Point(392, 330), Size = new Size(90, 32) };
            cancelBtn = new Button { Text = "取消", Location = new Point(488, 330), Size = new Size(90, 32) };
            goBtn.Click += delegate { if (finished) Close(); else Go(); };
            cancelBtn.Click += delegate { ExitCode = 1; Close(); };
            CancelButton = cancelBtn;
            Controls.AddRange(new Control[] { title, what, dataBox, status, goBtn, cancelBtn });
        }

        void Go()
        {
            bool deleteData = dataBox.Checked;
            if (deleteData && MessageBox.Show(this, "确定要永久删除全部课程和学习书吗？此操作无法恢复。", "确认删除课程数据", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            goBtn.Enabled = false; cancelBtn.Enabled = false; dataBox.Enabled = false;
            var t = new Thread(() =>
            {
                var left = Uninstaller.Run(installDir, deleteData, s => BeginInvoke((Action)(() => status.Text = s)));
                BeginInvoke((Action)(() =>
                {
                    finished = true;
                    ExitCode = left.Count == 0 ? 0 : 3;
                    status.Text = left.Count == 0
                        ? "Ezlearn 已完全卸载。" + (deleteData ? "" : "课程数据保留在 " + Common.DataDir + "。")
                        : "已卸载，但下面几项正在被占用、没能删除，重启电脑后可以手动删除：\n" + string.Join("\n", left);
                    goBtn.Text = "完成"; goBtn.Enabled = true;
                }));
            }) { IsBackground = true };
            t.Start();
        }

        public void RenderTo(string png)
        {
            Common.RenderForm(this, png);
        }
    }
}
