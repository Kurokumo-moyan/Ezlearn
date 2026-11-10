// Ezlearn 桌面组件公用代码（启动器 / 安装程序 / 卸载程序）。
// 只用 .NET Framework 4.x 自带的库，用 Windows 自带的 csc.exe 编译（C# 5 语法），不需要额外安装任何开发工具。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Ezlearn
{
    internal static class Common
    {
        public const string AppName = "Ezlearn";
        public const string AppId = "ezlearn";
        public const int Port = 5855;
        public const int MinNodeMajor = 22;
        public const string MarkerFile = "ezlearn-install.json";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Ezlearn";

        static string dataDirOverride;

        /// <summary>
        /// 课程、学习书、书签、设置（交给服务端的数据目录）。
        /// 安装信息里写了 data_dir 时用它（相对路径相对于安装目录，默认 "data"，即和软件放在一起）；
        /// 没写时（0.5.0 及以前的安装）沿用 %APPDATA%\Ezlearn。
        /// </summary>
        public static string DataDir
        {
            get { return dataDirOverride ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName); }
        }

        /// <summary>本机缓存：窗口配置、WebView2 缓存、运行日志。数据跟着安装目录时放在数据目录的 local\ 里。</summary>
        public static string LocalDir
        {
            get { return dataDirOverride != null ? Path.Combine(dataDirOverride, "local") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName); }
        }

        /// <summary>根据安装目录里的安装信息决定数据放在哪里。启动器、卸载程序启动时先调用。</summary>
        public static void InitDataDirs(string installDir)
        {
            dataDirOverride = null;
            var info = ReadInstallInfo(installDir);
            var d = info != null ? JsonGet(info, "data_dir") : null;
            if (string.IsNullOrEmpty(d)) return;
            dataDirOverride = Path.GetFullPath(Path.IsPathRooted(d) ? d : Path.Combine(installDir, d)).TrimEnd('\\');
        }

        /// <summary>数据目录是否在安装目录里面（卸载时保留数据就不能整个删安装目录）。</summary>
        public static bool DataInside(string installDir)
        {
            var root = Path.GetFullPath(installDir).TrimEnd('\\') + "\\";
            return dataDirOverride != null && (dataDirOverride + "\\").StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }

        public static string BrowserProfileDir { get { return Path.Combine(LocalDir, "browser"); } }
        public static string LogDir { get { return Path.Combine(LocalDir, "logs"); } }
        public static string WebViewDataDir { get { return Path.Combine(LocalDir, "webview2"); } }
        /// <summary>启动器与后台服务之间的控制口令（让关窗时能请服务退出）；只有当前用户能读。</summary>
        public static string ControlTokenFile { get { return Path.Combine(LocalDir, "control.token"); } }

        public static string DefaultInstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName); }
        }

        public static string AppUrl { get { return "http://127.0.0.1:" + Port + "/"; } }

        // ---------------- Node.js ----------------

        /// <summary>运行 node -v（不弹窗口），返回 "v24.15.0" 或 null。</summary>
        public static string NodeVersion(string exe)
        {
            try
            {
                if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return null;
                var psi = new ProcessStartInfo(exe, "-v")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(psi))
                {
                    string v = p.StandardOutput.ReadToEnd().Trim();
                    if (!p.WaitForExit(8000)) { try { p.Kill(); } catch { } return null; }
                    return Regex.IsMatch(v, @"^v\d+\.\d+\.\d+") ? v : null;
                }
            }
            catch { return null; }
        }

        public static bool NodeUsable(string version)
        {
            if (version == null) return false;
            var m = Regex.Match(version, @"^v(\d+)\.");
            int major;
            return m.Success && int.TryParse(m.Groups[1].Value, out major) && major >= MinNodeMajor;
        }

        /// <summary>在 PATH 和常见安装位置里找一个版本够新的 node.exe。</summary>
        public static string FindSystemNode(out string version)
        {
            version = null;
            var candidates = new List<string>();
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in path.Split(';'))
            {
                var d = dir.Trim().Trim('"');
                if (d.Length == 0) continue;
                try { candidates.Add(Path.Combine(d, "node.exe")); } catch { }
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            foreach (var c in candidates)
            {
                if (!File.Exists(c)) continue;
                var v = NodeVersion(c);
                if (NodeUsable(v)) { version = v; return Path.GetFullPath(c); }
            }
            return null;
        }

        // ---------------- 进程 ----------------

        /// <summary>结束名为 exeName、命令行里包含 needle 的进程（只针对 Ezlearn 自己的进程，不碰别的 Node / 浏览器）。</summary>
        public static int KillByCommandLine(string exeName, string needle)
        {
            int n = 0;
            try
            {
                using (var s = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = '" + exeName.Replace("'", "") + "'"))
                {
                    foreach (ManagementObject o in s.Get())
                    {
                        var cmd = (o["CommandLine"] as string) ?? "";
                        if (cmd.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        try
                        {
                            var p = Process.GetProcessById(Convert.ToInt32(o["ProcessId"]));
                            p.Kill();
                            p.WaitForExit(5000);
                            n++;
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return n;
        }

        /// <summary>本机 5855 端口上是不是 Ezlearn 在运行。</summary>
        public static bool ServerAlive()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(AppUrl + "healthz");
                req.Timeout = 1500;
                req.Proxy = null;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(res.GetResponseStream()))
                {
                    return r.ReadToEnd().Trim() == "ezlearn";
                }
            }
            catch { return false; }
        }

        // ---------------- 安装信息 ----------------

        public static string JsonEscape(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '\\') sb.Append("\\\\");
                else if (c == '"') sb.Append("\\\"");
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static string JsonGet(string json, string key)
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return null;
            return Regex.Unescape(m.Groups[1].Value);
        }

        public static void WriteInstallInfo(string dir, string version, string nodePath, string nodeMode, string dataDir)
        {
            var json = "{\n  \"app\": \"" + AppId + "\",\n  \"version\": \"" + JsonEscape(version) + "\",\n  \"node\": \"" + JsonEscape(nodePath) +
                       "\",\n  \"node_mode\": \"" + nodeMode + "\",\n" + (string.IsNullOrEmpty(dataDir) ? "" : "  \"data_dir\": \"" + JsonEscape(dataDir) + "\",\n") + "  \"installed_at\": \"" + DateTime.UtcNow.ToString("o") + "\"\n}\n";
            File.WriteAllText(Path.Combine(dir, MarkerFile), json, new UTF8Encoding(false));
        }

        public static string ReadInstallInfo(string dir)
        {
            try { return File.ReadAllText(Path.Combine(dir, MarkerFile), Encoding.UTF8); } catch { return null; }
        }

        // ---------------- 安全删除 ----------------

        static string Norm(string p)
        {
            return Path.GetFullPath(p).TrimEnd('\\').ToLowerInvariant();
        }

        /// <summary>
        /// 只有"确实是 Ezlearn 安装目录"的文件夹才允许整个删除：
        /// 必须有安装标记文件、不能是盘符根目录 / 用户目录 / 系统目录 / 桌面 / 文档。
        /// </summary>
        public static bool IsSafeInstallDir(string dir, out string why)
        {
            why = null;
            try
            {
                var full = Norm(dir);
                if (full.Length <= 3) { why = "不能删除整个磁盘"; return false; }
                var forbidden = new[]
                {
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                };
                foreach (var f in forbidden)
                {
                    if (!string.IsNullOrEmpty(f) && Norm(f) == full) { why = "这是系统或用户文件夹"; return false; }
                }
                var info = ReadInstallInfo(dir);
                if (info == null || JsonGet(info, "app") != AppId) { why = "文件夹里没有 Ezlearn 安装标记"; return false; }
                return true;
            }
            catch (Exception e) { why = e.Message; return false; }
        }

        /// <summary>数据目录只允许删除固定的 %APPDATA%\Ezlearn 与 %LOCALAPPDATA%\Ezlearn。</summary>
        public static bool IsOurDataDir(string dir)
        {
            var full = Norm(dir);
            return full == Norm(DataDir) || full == Norm(LocalDir);
        }

        /// <summary>删除目录里除 keep 子目录以外的全部内容（卸载时保留放在安装目录里的课程数据）。</summary>
        public static int DeleteTreeExcept(string dir, string keep)
        {
            int failed = 0;
            var keepFull = Path.GetFullPath(keep).TrimEnd('\\');
            foreach (var f in Directory.GetFiles(dir)) { try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); } catch { failed++; } }
            foreach (var d in Directory.GetDirectories(dir))
            {
                if (string.Equals(Path.GetFullPath(d).TrimEnd('\\'), keepFull, StringComparison.OrdinalIgnoreCase)) continue;
                failed += DeleteTree(d);
            }
            return failed;
        }

        /// <summary>删除目录；单个文件删不掉（被占用）时重试几次，最后返回删不掉的数量。</summary>
        public static int DeleteTree(string dir)
        {
            if (!Directory.Exists(dir)) return 0;
            int failed = 0;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                failed = 0;
                try
                {
                    foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                    {
                        try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); } catch { failed++; }
                    }
                    var dirs = Directory.GetDirectories(dir, "*", SearchOption.AllDirectories);
                    Array.Sort(dirs, (a, b) => b.Length.CompareTo(a.Length));
                    foreach (var d in dirs) { try { Directory.Delete(d, false); } catch { } }
                    Directory.Delete(dir, false);
                    return 0;
                }
                catch { }
                System.Threading.Thread.Sleep(600);
            }
            return Math.Max(failed, 1);
        }

        // ---------------- 快捷方式 / 注册表 ----------------

        public static void CreateShortcut(string lnkPath, string target, string workDir, string icon, string description)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(lnkPath));
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object lnk = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                var t = lnk.GetType();
                t.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { target });
                t.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { workDir });
                t.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { icon + ",0" });
                t.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, lnk, new object[] { description });
                t.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, lnk, null);
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(lnk);
            }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
        }

        public static string DesktopShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Ezlearn.lnk"); } }
        public static string StartMenuDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Ezlearn"); } }

        public static void Register(string installDir, string version, long sizeKb)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", "Ezlearn 通用学习软件");
                k.SetValue("DisplayVersion", version);
                k.SetValue("Publisher", "Ezlearn");
                k.SetValue("InstallLocation", installDir);
                k.SetValue("DisplayIcon", Path.Combine(installDir, "Ezlearn.exe"));
                k.SetValue("UninstallString", "\"" + Path.Combine(installDir, "Uninstall.exe") + "\"");
                k.SetValue("QuietUninstallString", "\"" + Path.Combine(installDir, "Uninstall.exe") + "\" /S");
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, sizeKb), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        /// <summary>只有系统里登记的正是这个安装目录时才删除登记（避免卸载一份副本时把另一份的登记删掉）。</summary>
        public static void Unregister(string installDir)
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey))
                {
                    var loc = k != null ? k.GetValue("InstallLocation") as string : null;
                    if (loc == null || Norm(loc) != Norm(installDir)) return;
                }
                Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            }
            catch { }
        }

        /// <summary>快捷方式指向的程序路径；读不出来返回 null。</summary>
        public static string ShortcutTarget(string lnkPath)
        {
            if (!File.Exists(lnkPath)) return null;
            try
            {
                var shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                try
                {
                    object lnk = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                    var t = lnk.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.GetProperty, null, lnk, null) as string;
                    System.Runtime.InteropServices.Marshal.FinalReleaseComObject(lnk);
                    return t;
                }
                finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
            }
            catch { return null; }
        }

        /// <summary>快捷方式是否指向这个安装目录里的程序。</summary>
        public static bool ShortcutPointsInto(string lnkPath, string installDir)
        {
            var t = ShortcutTarget(lnkPath);
            return t != null && (Norm(t) + "\\").StartsWith(Norm(installDir) + "\\", StringComparison.Ordinal);
        }

        public static long DirSizeKb(string dir)
        {
            long total = 0;
            try { foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) { try { total += new FileInfo(f).Length; } catch { } } } catch { }
            return total / 1024;
        }

        /// <summary>把窗口画成 PNG（在屏幕外显示一下再截取自身，用于检查界面，不会截到别的窗口）。</summary>
        public static void RenderForm(System.Windows.Forms.Form f, string png)
        {
            f.StartPosition = System.Windows.Forms.FormStartPosition.Manual;
            f.Location = new System.Drawing.Point(-10000, -10000);
            f.ShowInTaskbar = false;
            f.Show();
            for (int i = 0; i < 10; i++) { System.Windows.Forms.Application.DoEvents(); System.Threading.Thread.Sleep(30); }
            using (var bmp = new System.Drawing.Bitmap(f.Width, f.Height))
            {
                f.DrawToBitmap(bmp, new System.Drawing.Rectangle(0, 0, f.Width, f.Height));
                bmp.Save(png, System.Drawing.Imaging.ImageFormat.Png);
            }
            f.Close();
        }

        /// <summary>命令行参数：/Name 或 /Name=value（不区分大小写）。</summary>
        public static string Arg(string[] args, string name)
        {
            foreach (var a in args)
            {
                if (a.Equals("/" + name, StringComparison.OrdinalIgnoreCase)) return "";
                if (a.StartsWith("/" + name + "=", StringComparison.OrdinalIgnoreCase)) return a.Substring(name.Length + 2).Trim('"');
            }
            return null;
        }
    }
}
