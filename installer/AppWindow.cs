// Ezlearn 桌面窗口：没有系统标题栏，标题、拖动区域和"最小化 / 最大化 / 关闭"按钮都画在软件自己的界面顶部。
// 界面用 Windows 自带的 Microsoft Edge WebView2 显示（Win11 自带；Teams、新版 Outlook 也是这样做的）。
// 安全：只允许打开本机 Ezlearn 页面；https 外链交给默认浏览器；关闭开发者工具、密码 / 表单自动保存；
// 拒绝摄像头、麦克风、定位、通知等一切权限请求；不允许下载、不允许调用外部协议。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Ezlearn
{
    internal class AppWindow : Form
    {
        const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084, WM_NCLBUTTONDOWN = 0x00A1;
        const int HTCLIENT = 1, HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        const int SM_CXFRAME = 32, SM_CYFRAME = 33, SM_CXPADDEDBORDER = 92;
        const int Border = 5; // 普通状态下留一圈细边，用来拖动改变窗口大小

        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wp, IntPtr lp);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

        [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)] struct NCCALCSIZE_PARAMS { public RECT rgrc0, rgrc1, rgrc2; public IntPtr lppos; }

        readonly WebView2 web;
        readonly string selfTest;
        Form splash;
        bool nativeDrag;
        bool firstLoad = true;

        public static string BoundsFile { get { return Path.Combine(Common.LocalDir, "window.txt"); } }

        public AppWindow(Form splash, string selfTest)
        {
            this.splash = splash;
            this.selfTest = selfTest;
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "Ezlearn";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            FormBorderStyle = FormBorderStyle.Sizable; // 保留可调整大小的边框样式：Windows 的贴靠、阴影、最大化动画都还在
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1280, 860);
            MinimumSize = new Size(760, 520);
            BackColor = Color.FromArgb(0xfb, 0xfa, 0xf7);
            Padding = new Padding(Border);
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            if (selfTest != null)
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-20000, -20000);
                ShowInTaskbar = false;
            }
            else LoadBounds();
            Shown += async delegate { await InitWeb(); };
            Resize += delegate
            {
                Padding = WindowState == FormWindowState.Maximized ? new Padding(0) : new Padding(Border);
                PostState();
            };
            FormClosing += delegate { if (selfTest == null) SaveBounds(); };
        }

        async Task InitWeb()
        {
            try
            {
                Directory.CreateDirectory(Common.WebViewDataDir);
                var env = await CoreWebView2Environment.CreateAsync(null, Common.WebViewDataDir, new CoreWebView2EnvironmentOptions());
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception e)
            {
                CloseSplash();
                MessageBox.Show(this, "无法创建 Ezlearn 窗口：" + e.Message + "\n\n将改用浏览器打开。", "Ezlearn", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Launcher.OpenBrowserWindow();
                Close();
                return;
            }
            var core = web.CoreWebView2;
            var s = core.Settings;
            s.AreDevToolsEnabled = false;
            s.IsStatusBarEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsPasswordAutosaveEnabled = false;   // API 密钥输入框是密码框：不让 WebView2 记住
            s.IsGeneralAutofillEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsWebMessageEnabled = true;
            try { s.IsNonClientRegionSupportEnabled = true; nativeDrag = true; } catch { nativeDrag = false; } // CSS app-region: drag

            core.NavigationStarting += (o, e) => { if (!IsApp(e.Uri)) { e.Cancel = true; OpenExternal(e.Uri); } };
            core.FrameNavigationStarting += (o, e) => { if (!IsApp(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += (o, e) => { e.Handled = true; OpenExternal(e.Uri); };
            core.PermissionRequested += (o, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.DownloadStarting += (o, e) => { e.Cancel = true; };
            core.LaunchingExternalUriScheme += (o, e) => { e.Cancel = true; };
            core.WindowCloseRequested += (o, e) => Close();
            core.DocumentTitleChanged += (o, e) => { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Ezlearn" : core.DocumentTitle; };
            core.WebMessageReceived += OnMessage;
            core.ProcessFailed += (o, e) =>
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) return;
                try { core.Reload(); } catch { }
            };
            core.NavigationCompleted += async (o, e) =>
            {
                CloseSplash();
                PostState();
                if (firstLoad && selfTest != null) { firstLoad = false; await RunSelfTest(); }
                firstLoad = false;
            };
            core.Navigate(Common.AppUrl);
        }

        void CloseSplash()
        {
            if (splash != null) { try { splash.Close(); } catch { } splash = null; }
            if (selfTest == null) Activate();
        }

        static bool IsApp(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return false;
            if (u.AbsoluteUri == "about:blank") return true;
            return u.Scheme == "http" && u.Host == "127.0.0.1" && u.Port == Common.Port;
        }

        static void OpenExternal(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u) || u.Scheme != "https") return; // 只放行 https 外链
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsApp(e.Source)) return;
            string m;
            try { m = e.TryGetWebMessageAsString(); } catch { return; }
            if (m == null) return;
            switch (m)
            {
                case "ready": PostState(); break;
                case "min": WindowState = FormWindowState.Minimized; break;
                case "max": WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; break;
                case "close": Close(); break;
                case "drag": // 旧版 WebView2 运行时不支持 CSS 拖动区域时的后备方案
                    if (!nativeDrag) { ReleaseCapture(); SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero); }
                    break;
                default:
                    var bg = Regex.Match(m, "^bg:#([0-9a-fA-F]{6})$");
                    if (bg.Success)
                    {
                        var c = ColorTranslator.FromHtml("#" + bg.Groups[1].Value);
                        BackColor = c;
                        web.DefaultBackgroundColor = c;
                    }
                    break;
            }
        }

        void PostState()
        {
            try
            {
                if (web.CoreWebView2 == null) return;
                web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"window\",\"desktop\":true,\"maximized\":" + (WindowState == FormWindowState.Maximized ? "true" : "false") +
                    ",\"nativeDrag\":" + (nativeDrag ? "true" : "false") + "}");
            }
            catch { }
        }

        // ---- 去掉系统标题栏，但保留可调整大小的边框 ----
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    // 最大化时 Windows 会把窗口往屏幕外多放一圈边框，这里收回来，避免内容被裁掉
                    var p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                    int fx = GetSystemMetrics(SM_CXFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                    int fy = GetSystemMetrics(SM_CYFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
                    p.rgrc0.left += fx; p.rgrc0.top += fy; p.rgrc0.right -= fx; p.rgrc0.bottom -= fy;
                    Marshal.StructureToPtr(p, m.LParam, false);
                }
                m.Result = IntPtr.Zero; // 整个窗口都是客户区：没有系统标题栏
                return;
            }
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if ((int)m.Result == HTCLIENT && WindowState == FormWindowState.Normal)
                {
                    var pt = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
                    int b = Border + 2;
                    bool l = pt.X < b, r = pt.X >= ClientSize.Width - b, t = pt.Y < b, bo = pt.Y >= ClientSize.Height - b;
                    if (t && l) m.Result = (IntPtr)HTTOPLEFT;
                    else if (t && r) m.Result = (IntPtr)HTTOPRIGHT;
                    else if (bo && l) m.Result = (IntPtr)HTBOTTOMLEFT;
                    else if (bo && r) m.Result = (IntPtr)HTBOTTOMRIGHT;
                    else if (l) m.Result = (IntPtr)HTLEFT;
                    else if (r) m.Result = (IntPtr)HTRIGHT;
                    else if (t) m.Result = (IntPtr)HTTOP;
                    else if (bo) m.Result = (IntPtr)HTBOTTOM;
                }
                return;
            }
            base.WndProc(ref m);
        }

        // ---- 记住窗口大小与位置 ----
        void LoadBounds()
        {
            try
            {
                var parts = File.ReadAllText(BoundsFile).Trim().Split(',');
                if (parts.Length < 5) return;
                var r = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                // 只在窗口仍有一部分在某个屏幕上时恢复（拔掉外接显示器后不会"消失"）
                foreach (var scr in Screen.AllScreens)
                {
                    if (scr.WorkingArea.IntersectsWith(r) && r.Width >= 600 && r.Height >= 400)
                    {
                        StartPosition = FormStartPosition.Manual;
                        Bounds = r;
                        if (parts[4] == "1") WindowState = FormWindowState.Maximized;
                        return;
                    }
                }
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                Directory.CreateDirectory(Common.LocalDir);
                File.WriteAllText(BoundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (WindowState == FormWindowState.Maximized ? "1" : "0"));
            }
            catch { }
        }

        // ---- 自检（构建 / 测试用）：截图 + 验证窗口按钮消息，结果写到指定文件 ----
        async Task RunSelfTest()
        {
            var log = new System.Text.StringBuilder();
            try
            {
                var core = web.CoreWebView2;
                await Task.Delay(1500);
                string png = Path.ChangeExtension(selfTest, ".png");
                using (var fs = File.Create(png)) await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                log.AppendLine("screenshot=" + png);
                log.AppendLine("nativeDrag=" + nativeDrag);
                string bar = await core.ExecuteScriptAsync("JSON.stringify({bar: !!document.getElementById('titlebar'), controls: document.querySelectorAll('#titlebar .wc').length, drag: getComputedStyle(document.querySelector('#titlebar .tb-drag') || document.body).getPropertyValue('app-region') || getComputedStyle(document.querySelector('#titlebar .tb-drag') || document.body).getPropertyValue('-webkit-app-region'), title: document.title})");
                log.AppendLine("page=" + bar);
                await core.ExecuteScriptAsync("document.querySelector('#titlebar .wc.max').click()");
                await Task.Delay(800);
                log.AppendLine("afterMaxClick=" + WindowState);
                string label = await core.ExecuteScriptAsync("document.querySelector('#titlebar .wc.max').title");
                log.AppendLine("maxButtonTitle=" + label);
                await core.ExecuteScriptAsync("document.querySelector('#titlebar .wc.max').click()");
                await Task.Delay(800);
                log.AppendLine("afterSecondClick=" + WindowState);
                // 用不存在的 http 地址测试"拦截站外导航"（https 会被交给默认浏览器，自检时不要真的打开）
                await core.ExecuteScriptAsync("location.href='http://example.invalid/'; 'navigated'");
                await Task.Delay(800);
                log.AppendLine("stillOnApp=" + IsApp(core.Source));
                log.AppendLine("ok");
            }
            catch (Exception e) { log.AppendLine("error=" + e); }
            File.WriteAllText(selfTest, log.ToString());
            await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('#titlebar .wc.close').click()");
        }
    }
}
