// Ezlearn 安装程序：一个文件包含软件本体 + 内置 Node.js。
// - 先检查电脑上有没有可用的 Node.js（22 或更高）：有就直接用，没有就把内置的装到软件目录的 runtime\ 里；
// - 只装到当前用户目录，不需要管理员权限，不改系统设置；
// - 创建开始菜单 / 桌面快捷方式，并登记到"设置 → 应用"，可以从那里卸载。
// /Update：软件内“立即更新”用——不再询问，自动装到 /D 指定的原目录（沿用原来的桌面快捷方式和数据目录），装完重新打开。
// 命令行（测试 / 批量部署用）：/S 静默  /D=目录  /Data=数据目录  /NoShortcuts  /NoRegister  /NoLaunch  /BundledNode  /Render=预览图.png
// 数据目录默认是安装目录里的 data\（不占系统盘）；升级时沿用原来的设置。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace Ezlearn
{
    internal static class SetupProgram
    {
        public const string Version = "__VERSION__";
        public const string BundledNodeVersion = "__NODE_VERSION__";

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var opts = new SetupOptions
            {
                InstallDir = Common.Arg(args, "D") ?? Common.DefaultInstallDir,
                Shortcuts = Common.Arg(args, "NoShortcuts") == null,
                Register = Common.Arg(args, "NoRegister") == null,
                Launch = Common.Arg(args, "NoLaunch") == null,
                ForceBundled = Common.Arg(args, "BundledNode") != null,
                DataDir = Common.Arg(args, "Data"),
            };
            string render = Common.Arg(args, "Render");
            if (render != null)
            {
                using (var f = new SetupForm(opts)) { f.RenderTo(render); }
                return 0;
            }
            if (Common.Arg(args, "S") != null)
            {
                try
                {
                    opts.Launch = false;
                    Installer.Run(opts, (p, s) => Console.WriteLine(p + "% " + s));
                    return 0;
                }
                catch (Exception e)
                {
                    try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "ezlearn-setup-error.txt"), e.ToString()); } catch { }
                    return 1;
                }
            }
            Application.Run(new SetupForm(opts, Common.Arg(args, "Update") != null));
            return 0;
        }
    }

    internal class SetupOptions
    {
        public string InstallDir;
        public bool Shortcuts = true;
        public bool Register = true;
        public bool Launch = true;
        public bool ForceBundled;
        public string SystemNode;          // 检测到的系统 Node.js（为空表示没有可用的）
        public string SystemNodeVersion;
        public string DataDir;             // 为空：新安装用 "data"，升级沿用原来的
    }

    internal static class Installer
    {
        /// <summary>安装目录一律以 \Ezlearn 结尾，避免把文件散落在用户选的文件夹里、卸载时误删别的东西。</summary>
        public static string NormalizeDir(string dir)
        {
            var full = Path.GetFullPath(dir.Trim().Trim('"')).TrimEnd('\\');
            if (!full.EndsWith("\\" + Common.AppName, StringComparison.OrdinalIgnoreCase)) full = Path.Combine(full, Common.AppName);
            return full;
        }

        public static void DetectNode(SetupOptions o)
        {
            string v;
            o.SystemNode = Common.FindSystemNode(out v);
            o.SystemNodeVersion = v;
        }

        public static void Run(SetupOptions o, Action<int, string> report)
        {
            string dir = NormalizeDir(o.InstallDir);
            if (o.SystemNode == null && !o.ForceBundled) DetectNode(o);
            bool useSystem = !o.ForceBundled && o.SystemNode != null;

            report(2, "正在检查旧版本……");
            // 数据目录：命令行指定的 > 旧安装记录的 > 新安装默认放在软件旁边的 data\
            var oldInfo = Common.ReadInstallInfo(dir);
            string dataDir = !string.IsNullOrEmpty(o.DataDir) ? o.DataDir
                : oldInfo != null ? (Common.JsonGet(oldInfo, "data_dir") ?? "")
                : "data";
            // 升级：先停掉正在运行的旧版本（只停这个目录里的 Ezlearn）
            Common.InitDataDirs(dir);
            Common.KillByCommandLine("Ezlearn.exe", dir);
            Common.KillByCommandLine("node.exe", Path.Combine(dir, "app", "server", "index.js"));
            Common.KillByCommandLine("msedgewebview2.exe", Common.WebViewDataDir);
            if (Directory.Exists(dir))
            {
                string why;
                bool ours = Common.IsSafeInstallDir(dir, out why);
                if (!ours && Directory.EnumerateFileSystemEntries(dir).GetEnumerator().MoveNext())
                    throw new InvalidOperationException("目标文件夹已存在且不是 Ezlearn 的安装目录，为避免覆盖你的文件，请换一个位置：\n" + dir);
                if (ours)
                {
                    foreach (var sub in new[] { "app", "runtime" }) // 只换程序文件，data\ 不动
                    {
                        var p = Path.Combine(dir, sub);
                        if (Directory.Exists(p) && Common.DeleteTree(p) > 0) throw new IOException("旧版本文件被占用，删不掉：" + p + "\n请关闭 Ezlearn 窗口后重试。");
                    }
                }
            }
            Directory.CreateDirectory(dir);

            report(5, "正在解压文件……");
            var asm = Assembly.GetExecutingAssembly();
            using (var stream = asm.GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new InvalidOperationException("安装包损坏：缺少 payload");
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    int total = zip.Entries.Count, i = 0;
                    string root = dir + "\\";
                    foreach (var e in zip.Entries)
                    {
                        i++;
                        var name = e.FullName.Replace('/', '\\');
                        if (useSystem && name.StartsWith("runtime\\", StringComparison.OrdinalIgnoreCase)) continue;
                        var target = Path.GetFullPath(Path.Combine(dir, name));
                        // 防止压缩包里的 ..\ 路径写到安装目录以外
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包里有非法路径：" + e.FullName);
                        if (name.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        e.ExtractToFile(target, true);
                        if (i % 40 == 0 || i == total) report(5 + (int)(80.0 * i / total), "正在解压文件（" + i + "/" + total + "）……");
                    }
                }
            }

            string nodePath = useSystem ? o.SystemNode : "runtime\\node.exe";
            Common.WriteInstallInfo(dir, SetupProgram.Version, nodePath, useSystem ? "system" : "bundled", dataDir);

            if (o.Shortcuts)
            {
                report(90, "正在创建快捷方式……");
                var exe = Path.Combine(dir, "Ezlearn.exe");
                Common.CreateShortcut(Path.Combine(Common.StartMenuDir, "Ezlearn.lnk"), exe, dir, exe, "Ezlearn 通用学习软件");
                Common.CreateShortcut(Path.Combine(Common.StartMenuDir, "卸载 Ezlearn.lnk"), Path.Combine(dir, "Uninstall.exe"), dir, Path.Combine(dir, "Uninstall.exe"), "卸载 Ezlearn");
                Common.CreateShortcut(Common.DesktopShortcut, exe, dir, exe, "Ezlearn 通用学习软件");
            }
            if (o.Register)
            {
                report(95, "正在登记到系统的应用列表……");
                Common.Register(dir, SetupProgram.Version, Common.DirSizeKb(dir));
            }
            report(100, "安装完成");
        }
    }

    internal class SetupForm : Form
    {
        readonly SetupOptions opts;
        readonly TextBox dirBox;
        readonly Label nodeLabel;
        readonly CheckBox desktopBox, launchBox;
        readonly ProgressBar bar;
        readonly Label status;
        readonly Button installBtn, cancelBtn, browseBtn;
        bool done;
        readonly bool update;

        public SetupForm(SetupOptions o, bool updateMode = false)
        {
            opts = o;
            update = updateMode;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi; // 高分屏下按比例放大，字不发虚
            Text = "安装 Ezlearn " + SetupProgram.Version;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(580, 400);
            BackColor = Color.FromArgb(251, 250, 247);
            Font = new Font("Microsoft YaHei UI", 9.5F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            var title = new Label { Text = "Ezlearn 通用学习软件", Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold), AutoSize = true, Location = new Point(24, 18) };
            var sub = new Label { Text = "把课程资料变成零基础可读、可追溯、带交互演示的学习书。", ForeColor = Color.FromArgb(109, 106, 99), AutoSize = true, Location = new Point(26, 56) };
            var dirLabel = new Label { Text = "安装位置：", AutoSize = true, Location = new Point(26, 96) };
            dirBox = new TextBox { Text = o.InstallDir, Location = new Point(26, 120), Size = new Size(430, 26) };
            browseBtn = new Button { Text = "更改……", Location = new Point(466, 118), Size = new Size(88, 30) };
            browseBtn.Click += delegate
            {
                using (var d = new FolderBrowserDialog { Description = "选择安装位置（会在里面建一个 Ezlearn 文件夹）" })
                {
                    if (d.ShowDialog(this) == DialogResult.OK) dirBox.Text = Installer.NormalizeDir(d.SelectedPath);
                }
            };
            nodeLabel = new Label { Text = "正在检查电脑上的 Node.js……", AutoSize = false, Location = new Point(26, 160), Size = new Size(528, 44), ForeColor = Color.FromArgb(47, 93, 138) };
            desktopBox = new CheckBox { Text = "在桌面创建快捷方式", Checked = o.Shortcuts, AutoSize = true, Location = new Point(26, 212) };
            launchBox = new CheckBox { Text = "安装完成后打开 Ezlearn", Checked = o.Launch, AutoSize = true, Location = new Point(26, 240) };
            var note = new Label { Text = "只安装给当前用户，不需要管理员权限。课程数据保存在安装位置里的 data 文件夹。", ForeColor = Color.FromArgb(109, 106, 99), AutoSize = true, Location = new Point(26, 272) };
            bar = new ProgressBar { Location = new Point(26, 304), Size = new Size(528, 18), Minimum = 0, Maximum = 100 };
            status = new Label { Text = "", AutoSize = true, Location = new Point(26, 328), ForeColor = Color.FromArgb(109, 106, 99) };
            installBtn = new Button { Text = "安装", Location = new Point(368, 352), Size = new Size(90, 32) };
            cancelBtn = new Button { Text = "取消", Location = new Point(464, 352), Size = new Size(90, 32) };
            installBtn.Click += delegate { if (done) Close(); else StartInstall(); };
            cancelBtn.Click += delegate { Close(); };
            AcceptButton = installBtn;
            CancelButton = cancelBtn;
            Controls.AddRange(new Control[] { title, sub, dirLabel, dirBox, browseBtn, nodeLabel, desktopBox, launchBox, note, bar, status, installBtn, cancelBtn });
            if (update)
            {
                Text = "更新 Ezlearn 到 " + SetupProgram.Version;
                sub.Text = "正在更新到新版本，课程数据和设置都会保留。完成后会自动重新打开。";
                dirBox.Text = Installer.NormalizeDir(o.InstallDir);
                dirBox.ReadOnly = true;
                browseBtn.Enabled = false;
                desktopBox.Checked = File.Exists(Common.DesktopShortcut);
                desktopBox.Enabled = false;
                launchBox.Checked = true;
                launchBox.Enabled = false;
            }

            Load += delegate
            {
                installBtn.Enabled = false;
                var t = new Thread(() =>
                {
                    Installer.DetectNode(opts);
                    BeginInvoke((Action)ShowNodeStatus);
                }) { IsBackground = true };
                t.Start();
            };
        }

        void ShowNodeStatus()
        {
            if (opts.SystemNode != null && !opts.ForceBundled)
                nodeLabel.Text = "检测到电脑上已有可用的 Node.js " + opts.SystemNodeVersion + "，将直接使用它，不再重复安装。\n（" + opts.SystemNode + "）";
            else
                nodeLabel.Text = "电脑上没有可用的 Node.js（需要 " + Common.MinNodeMajor + " 或更高版本）。\n将把内置的 Node.js " + SetupProgram.BundledNodeVersion + " 安装到软件目录里，卸载时一起删除。";
            installBtn.Enabled = true;
            if (update && !done) StartInstall();
        }

        void StartInstall()
        {
            opts.InstallDir = dirBox.Text;
            opts.Shortcuts = true; // 开始菜单总是创建；桌面快捷方式按勾选
            bool desktop = desktopBox.Checked;
            installBtn.Enabled = false;
            browseBtn.Enabled = false;
            dirBox.Enabled = false;
            cancelBtn.Enabled = false;
            var t = new Thread(() =>
            {
                try
                {
                    Installer.Run(opts, (p, s) => BeginInvoke((Action)(() => { bar.Value = p; status.Text = s; })));
                    if (!desktop) { try { File.Delete(Common.DesktopShortcut); } catch { } }
                    BeginInvoke((Action)Finished);
                }
                catch (Exception e)
                {
                    BeginInvoke((Action)(() =>
                    {
                        status.Text = "安装失败";
                        MessageBox.Show(this, e.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        installBtn.Enabled = true; browseBtn.Enabled = true; dirBox.Enabled = true; cancelBtn.Enabled = true;
                    }));
                }
            }) { IsBackground = true };
            t.Start();
        }

        void Finished()
        {
            done = true;
            status.Text = "安装完成。以后从桌面或开始菜单的 Ezlearn 图标打开。";
            installBtn.Text = "完成";
            installBtn.Enabled = true;
            cancelBtn.Visible = false;
            if (launchBox.Checked)
            {
                try { Process.Start(new ProcessStartInfo(Path.Combine(Installer.NormalizeDir(opts.InstallDir), "Ezlearn.exe")) { UseShellExecute = true }); } catch { }
                Close();
            }
        }

        public void RenderTo(string png)
        {
            Shown += delegate { opts.SystemNodeVersion = "v24.15.0"; opts.SystemNode = null; ShowNodeStatus(); };
            Common.RenderForm(this, png);
        }
    }
}
